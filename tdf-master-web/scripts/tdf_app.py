"""ブラウザ(Pyodide)から呼び出すTDF抽出アプリのラッパー。

tdf_binary.py / tdf_master_extractor.py / tdf_master_extractor_multi.py は
一切変更せず、そのままインポートして使う。このファイルはExcel(openpyxl)への
書き込みを行っていた extract_to_excel_small_beam.py の「1ファイル分の抽出
ロジック」を、dictのリストとして返す形に置き換えただけの薄いラッパーであり、
判定ロジック自体は一切変更していない。

当初は大梁(1G系)・小梁(1B系)を別ロジックとして実装していたが、小梁側の
ロジックですべてのファイルが正しく抽出できることを確認できたため、大梁専用
コードは削除し、この1系統のみで運用している。
"""
from __future__ import annotations

import bisect
import math
import re

import tdf_binary as tb
import tdf_master_extractor as ex
import tdf_master_extractor_multi as exm

_AXIS_TOLERANCE_DEG = 0.1
TIER_Y_GAP_THRESHOLD = 3000.0


def classify_beam_type(main_axis_deg: float | None) -> str | None:
    if main_axis_deg is None:
        return None
    remainder = abs(main_axis_deg) % 90.0
    if remainder <= _AXIS_TOLERANCE_DEG or remainder >= 90.0 - _AXIS_TOLERANCE_DEG:
        return "普通梁"
    return "斜め梁"


# ---------------------------------------------------------------------------
# TDFファイル1件分の抽出ロジック — extract_to_excel_small_beam.py の
# 1ファイル分の処理をそのまま移植
# ---------------------------------------------------------------------------

def _get_rows_small(tdf: tb.TdfData) -> list:
    rows = ex.find_product_rows(tdf)
    existing = {(round(r.x_next, 1), round(r.y, 1)) for r in rows}
    rows = rows + exm.find_product_rows_shared_group(tdf, existing_positions=existing)
    # 「製品マーク|設計符号|本数(N台)」の3項目パターン(サイズ省略)。
    # サイズが元々描かれていない図面(2026-09-16、KIX01現場`N-1 2G-05`)に
    # 対応するため追加(既存の2パターンで拾われたdaiセルとは重複しない
    # ようにマージする)。
    existing = {(round(r.x_next, 1), round(r.y, 1)) for r in rows}
    rows = rows + ex.find_product_rows_no_size(tdf, existing_positions=existing)
    rows = exm.filter_deleted_rows(tdf, rows)
    return rows


def _sort_rows_small(rows: list) -> None:
    prefix_max_y: dict[str, float] = {}
    prefix_min_x: dict[str, float] = {}
    for r in rows:
        p = exm.mark_prefix(r.mark)
        prefix_max_y[p] = max(prefix_max_y.get(p, r.y), r.y)
        prefix_min_x[p] = min(prefix_min_x.get(p, r.x_mark), r.x_mark)

    def key_func(r):
        p = exm.mark_prefix(r.mark)
        return (-prefix_max_y[p], prefix_min_x[p], exm.mark_sort_key(r.mark))

    rows.sort(key=key_func)


def _compute_tier_info_small(rows: list) -> dict:
    if not rows:
        return {}
    sorted_rows = sorted(rows, key=lambda r: -r.y)
    tiers = [[sorted_rows[0]]]
    for r in sorted_rows[1:]:
        if tiers[-1][-1].y - r.y > TIER_Y_GAP_THRESHOLD:
            tiers.append([r])
        else:
            tiers[-1].append(r)

    info = {}
    for i, tier in enumerate(tiers):
        tier_label = f"{i + 1}段"
        if i == 0:
            for r in tier:
                info[id(r)] = (tier_label, None)
            continue
        prev_tier = tiers[i - 1]
        # y_maxは「直上の段の範囲に踏み込まない」ための上限。当初は直上の段
        # 全体(列を問わない)の最小Y(=直上の段の最も下の行)を使っていたが、
        # 無関係な別列がたまたま直上の段で最も小さいYを持つ場合に境界が
        # 狭くなりすぎる不具合があり(EA2-1B-15のEA22-1TB489-9)、一度は
        # 「X範囲が重なる[同じ列とみなせる]行の最小Y」に限定する修正を
        # 行った。しかし今度は逆に、直上の段に同じ列の対応物が存在しない
        # 場合(WB3-1B-03のWB31-1TB441-9/10/14/15/16、直上の段の該当列には
        # 何も無い)に、直上の段全体の最小Y(=最も下の行)にフォールバック
        # すると狭すぎて実際の寸法線が範囲外になることが判明(2026-09-15、
        # ユーザー指摘・スクリーンショットで確認)。「同じ列」判定に頼らず、
        # 直上の段の最も上にある行のY(=段全体の最大Y)を上限とすることで
        # 解消した(直上の段のどの列であっても、その段が実際に始まる位置
        # より下は安全にtierN側の探索範囲とみなせるため)。
        y_max = max(r.y for r in prev_tier)
        for r in tier:
            info[id(r)] = (tier_label, y_max)
    return info



def _flange_thickness(size):
    """サイズ表記の最後の数値をフランジ厚として返す(H-346x174x6x9 なら 9)。"""
    if not size or "x" not in size:
        return None
    nums = re.findall(r"[0-9]+(?:\.[0-9]+)?", size.split("x", 1)[1])
    return float(nums[-1]) if nums else None


def _beam_depth(size):
    """サイズ表記の梁せいを返す(HY-1000x250x19x25 なら 1000)。
    BH-1523.3-1400x… のように梁せいが変わるもの・読めないものは None。"""
    m = re.match(r"^[^-0-9]*-([0-9]+(?:\.[0-9]+)?)x", size or "")
    return float(m.group(1)) if m else None


def _flange_member(tdf, x_min, x_max, y_ref, y_max, tf, depth=None, with_others=False):
    """梁本体の端から端を、フランジの形から求める。

    フランジは「板厚tfだけ離れて向かい合う平行な2本の線」として描かれる
    (寸法線・基準線にはこの性質がない)。2本の端のずれは開先の分としてtf以内まで
    認め、2本を合わせた端から端をそのフランジの長さとする。ずれがtfを超えても、
    一方の端からもう一方の線へ斜めの線(開先の線)が引かれていれば同じフランジとする。

    同じ高さに並ぶフランジの間に隙間があり、隙間の両端の線が梁全体(上下の
    フランジの外側)より外まで伸びている(=梁を横切る板。通しダイアフラム等)
    ときは、板を含めて一続きの梁とみなす。隙間の中に梁せいの中央を横切る線
    (取り付く部材の板)があり、隙間の両端に梁せいの中央を横切る線(梁の端の
    切断線)が無く、隙間の両端で上下のフランジの外側どうしがサイズの梁せい
    (depth)だけ離れているとき(=柱や小梁が取り付く位置でフランジの線が
    途切れている)も一続きとみなす。隙間なく接するものは、接する位置に梁せい
    全体をまたぐ線(取り付く部材の境界)があるときだけつなぐ。重なっているもの
    (継手の先の別の部材)はつながない。他のフランジの内側に収まる線(添え板・重ね描き)は使わない。

    梁本体は x_min..x_max に中点があるフランジから選び、その両端から同じ条件で
    つながるフランジがあれば範囲の外まで伸ばす(1枚の図面に製品が2つあると、
    梁の一部が次の製品マークより先まで描かれるため)。

    梁せいが分かるときは、もう1組のフランジが外側どうしで梁せいだけ離れた位置に
    あるものだけを使う(1組しか無い平行線は板であって梁ではない)。

    端が向きの違う別の候補のフランジの外側の線の上に載っているもの(梁に取り付く
    部材)は梁本体にしない。

    ハンチ等で短いフランジもあるため、最も長いものを梁本体とする。向きは線どうしで
    判定するので、斜めに描かれた梁にもそのまま使える。
    戻り値は (長さ, (左端, 右端), フランジの線の向き[度]) で、端は梁せいの中央の座標。
    見つからなければNone。with_others=True のときは (梁本体, [ほかの候補]) を返す
    (腰折れ梁の判定用。ほかの候補も同じ形)。
    """
    if not tf:
        return None

    def _finish(c):
        return _finish_flange_member(tdf, c, joinable, depth)
    near = []
    for ln in tdf.lines:
        if not (min(ln.y1, ln.y2) > y_ref
                and (y_max is None or max(ln.y1, ln.y2) < y_max)):
            continue
        near.append((math.atan2(ln.y2 - ln.y1, ln.x2 - ln.x1) % math.pi, ln))
    segs = [(t, ln) for t, ln in near if ln.length >= 20]
    long_segs = [(t, ln) for t, ln in segs if ln.length >= 100]

    def end_point(ln, p, ux, uy):
        # 軸方向の位置がpの側の端点
        return (ln.x1, ln.y1) if abs(ln.x1 * ux + ln.y1 * uy - p) <= abs(ln.x2 * ux + ln.y2 * uy - p) else (ln.x2, ln.y2)

    by_end = {}  # 端点(1mm単位に丸めた座標) → (向き, 線, その端点, 反対側の端点)
    for t, s in near:
        for p, o in (((s.x1, s.y1), (s.x2, s.y2)), ((s.x2, s.y2), (s.x1, s.y1))):
            by_end.setdefault((round(p[0]), round(p[1])), []).append((t, p, o))

    def bevel(a, b, pa_end, pb_end, ux, uy):
        # 一方の線の端点から、もう一方の線の上で、その線の端から板厚以内の点へ
        # 斜めの線が引かれているか
        th = math.atan2(uy, ux) % math.pi
        for outer, p_end, inner, q_end in ((a, pa_end, b, pb_end), (b, pb_end, a, pa_end)):
            ex_, ey_ = end_point(outer, p_end, ux, uy)
            di = -inner.x1 * uy + inner.y1 * ux
            pi_ = sorted((inner.x1 * ux + inner.y1 * uy, inner.x2 * ux + inner.y2 * uy))
            pi_ = [max(pi_[0], q_end - tf - 0.6), min(pi_[1], q_end + tf + 0.6)]
            kx, ky = round(ex_), round(ey_)
            for gx in (kx - 1, kx, kx + 1):
                for gy in (ky - 1, ky, ky + 1):
                    for t, (sx, sy), (ox, oy) in by_end.get((gx, gy), ()):
                        d = abs(t - th)
                        d = min(d, math.pi - d)
                        if d < math.radians(1) or abs(d - math.pi / 2) < math.radians(1):
                            continue
                        if math.hypot(sx - ex_, sy - ey_) > 0.6:
                            continue
                        if (abs(-ox * uy + oy * ux - di) <= 0.6
                                and pi_[0] - 0.6 <= ox * ux + oy * uy <= pi_[1] + 0.6):
                            return True
        return False

    # 下の総当たり(以前は全部の組を比べていた)で、比べる相手を先に絞る。
    # 相手は「向きの差が0.05度以内」かつ「向きに直交する方向の距離が板厚±0.6」の線
    # だけなので、
    #  ・向きがまったく同じ線(図面の線のほとんどは水平・垂直): 向きごとに直交方向の
    #    位置で並べておき、位置が板厚±0.6 のものを二分探索で取り出す(位置は相手の線と
    #    同じ式・同じ向きで計算するので、判定と同じ値になる)。
    #  ・向きが少しだけ違う線: 0.05度の範囲(0度と180度の境目をまたぐものも)の向きの
    #    線をすべて候補にする。
    # 候補には下の判定をそのままかけ、比べる順番(i の後ろの線を前から)も以前と同じ
    # にするので、見つかるフランジとその順番は総当たりと同じ(2026-11-09)。
    by_angle: dict[float, list] = {}
    for k, (t, ln) in enumerate(long_segs):
        ux, uy = math.cos(t), math.sin(t)
        by_angle.setdefault(t, []).append((-ln.x1 * uy + ln.y1 * ux, k))
    for v in by_angle.values():
        v.sort()
    offs_by_angle = {t: [o for o, _k in v] for t, v in by_angle.items()}
    angles = sorted(by_angle)
    ang_win = math.radians(0.05) + 1e-9
    near_angles = {}
    for t in angles:
        found = []
        for c in (t, t + math.pi, t - math.pi):
            lo = bisect.bisect_left(angles, c - ang_win)
            hi = bisect.bisect_right(angles, c + ang_win)
            found.extend(angles[lo:hi])
        near_angles[t] = [u for u in found if u != t]

    def pair_candidates(i, ta, da):
        js = set()
        group, offs = by_angle[ta], offs_by_angle[ta]
        for c in (da - tf, da + tf):
            lo = bisect.bisect_left(offs, c - 0.6 - 1e-6)
            hi = bisect.bisect_right(offs, c + 0.6 + 1e-6)
            js.update(k for _o, k in group[lo:hi] if k > i)
        for u in near_angles[ta]:
            js.update(k for _o, k in by_angle[u] if k > i)
        return sorted(js)

    flanges = []  # (向き, 直交方向の位置lo, hi, 軸方向の始点, 終点)
    for i, (ta, a) in enumerate(long_segs):
        ux, uy = math.cos(ta), math.sin(ta)
        pa = sorted((a.x1 * ux + a.y1 * uy, a.x2 * ux + a.y2 * uy))
        da = -a.x1 * uy + a.y1 * ux
        for tb_, b in (long_segs[j] for j in pair_candidates(i, ta, da)):
            d = abs(ta - tb_)
            if min(d, math.pi - d) > math.radians(0.05):
                continue
            db = -b.x1 * uy + b.y1 * ux
            if abs(abs(da - db) - tf) >= 0.6:
                continue
            pb = sorted((b.x1 * ux + b.y1 * uy, b.x2 * ux + b.y2 * uy))
            if ((abs(pa[0] - pb[0]) > tf + 0.6 and not bevel(a, b, pa[0], pb[0], ux, uy))
                    or (abs(pa[1] - pb[1]) > tf + 0.6 and not bevel(a, b, pa[1], pb[1], ux, uy))):
                continue
            flanges.append((ta, min(da, db), max(da, db), min(pa[0], pb[0]), max(pa[1], pb[1])))

    def crossing_line(th, pos, lo, hi):
        # 主軸に直交し、主軸方向の位置がposで、梁全体(lo..hi)より外まで伸びる線があるか
        ux, uy = math.cos(th), math.sin(th)
        for t, ln in segs:
            d = abs(t - th)
            if abs(min(d, math.pi - d) - math.pi / 2) > math.radians(0.05):
                continue
            if abs((ln.x1 + ln.x2) / 2 * ux + (ln.y1 + ln.y2) / 2 * uy - pos) > 0.6:
                continue
            o = sorted((-ln.x1 * uy + ln.y1 * ux, -ln.x2 * uy + ln.y2 * ux))
            if o[0] < lo - 0.6 and o[1] > hi + 0.6:
                return True
        return False

    def mid_lines(th, p0, p1, lo, hi):
        # 主軸に直交し、主軸方向の位置がp0..p1にあり、梁せいの中央を横切る線があるか
        ux, uy = math.cos(th), math.sin(th)
        mid = (lo + hi) / 2
        for t, ln in segs:
            d = abs(t - th)
            if abs(min(d, math.pi - d) - math.pi / 2) > math.radians(0.05):
                continue
            if not p0 <= (ln.x1 + ln.x2) / 2 * ux + (ln.y1 + ln.y2) / 2 * uy <= p1:
                continue
            o = sorted((-ln.x1 * uy + ln.y1 * ux, -ln.x2 * uy + ln.y2 * ux))
            if o[0] < mid < o[1]:
                return True
        return False

    def spanning_line(th, pos, lo, hi):
        # 主軸に直交し、主軸方向の位置がposで、梁せい全体(lo..hi)をまたぐ線があるか
        ux, uy = math.cos(th), math.sin(th)
        for t, ln in segs:
            d = abs(t - th)
            if abs(min(d, math.pi - d) - math.pi / 2) > math.radians(0.05):
                continue
            if abs((ln.x1 + ln.x2) / 2 * ux + (ln.y1 + ln.y2) / 2 * uy - pos) > 0.6:
                continue
            o = sorted((-ln.x1 * uy + ln.y1 * ux, -ln.x2 * uy + ln.y2 * ux))
            if o[0] <= lo + 0.6 and o[1] >= hi - 0.6:
                return True
        return False

    def joinable(th, fs, depth_at, end, s1):
        # 同じ高さのフランジの隙間(end..s1)をはさんで、一続きの梁とみなせるか
        dl, dr = depth_at(end), depth_at(s1)
        if not dl or not dr:
            return False
        lo, hi = min(dl[0], dr[0]), max(dl[1], dr[1])
        if abs(s1 - end) <= 0.6:
            # 隙間なく接するフランジは、接する位置に梁せい全体をまたぐ線(取り付く
            # 部材の境界)があるときだけ一続きとみなす(2026-11-04、26-12 の 2G-08。
            # 下に H350W が取り付く区間でフランジの線が 220・280・6545 に分かれて
            # 描かれ、6545 だけが梁本体になっていた。図面の長さは 7045)。
            return spanning_line(th, end, lo, hi)
        if crossing_line(th, end, lo, hi) and crossing_line(th, s1, lo, hi):
            return True  # 梁を横切る板
        return (depth is not None and abs((hi - lo) - depth) <= 0.6
                and abs((dl[1] - dl[0]) - depth) <= 0.6 and abs((dr[1] - dr[0]) - depth) <= 0.6
                and mid_lines(th, end + 0.6, s1 - 0.6, lo, hi)
                and not mid_lines(th, end - 0.6, end + 0.6, lo, hi)
                and not mid_lines(th, s1 - 0.6, s1 + 0.6, lo, hi))

    cands = []  # (長さ, 向き, その向きのフランジ, 高さ, 始点, 終点)
    by_theta = {}
    for f in flanges:
        by_theta.setdefault(round(f[0], 4), []).append(f)
    for fs in by_theta.values():
        th = fs[0][0]
        ux, uy = math.cos(th), math.sin(th)

        def depth_at(pos):
            near = [f for f in fs if f[3] - 0.6 <= pos <= f[4] + 0.6]
            return (min(f[1] for f in near), max(f[2] for f in near)) if near else None

        levels = {}
        for f in fs:
            levels.setdefault((round(f[1]), round(f[2])), {})[(round(f[3], 1), round(f[4], 1))] = (f[3], f[4])
        for (lv_lo, lv_hi), ivs in levels.items():
            ivs = sorted(ivs.values())
            # 他のフランジの内側に収まる線(添え板・重ね描き)は梁の切れ端として扱わない
            ivs = [(s, e) for s, e in ivs
                   if not any(s2 <= s + 0.6 and e - 0.6 <= e2 and (s2, e2) != (s, e) for s2, e2 in ivs)]
            c_lv = (lv_lo + lv_hi) / 2
            # 梁本体は、中点がこの製品の範囲(x_min..x_max)にある切れ端だけから選ぶ
            ivs = [(s, e) for s, e in ivs if x_min <= (s + e) / 2 * ux - c_lv * uy <= x_max]
            for i, (start, end) in enumerate(ivs):
                for s1, e1 in ivs[i + 1:]:
                    if s1 < end - 0.6 or not joinable(th, fs, depth_at, end, s1):
                        break
                    end = e1
                length = round(end - start, 1)
                # H形鋼のフランジは上下2組ある。もう1組が外側どうしで梁せい(depth)
                # だけ離れた位置に無いものは梁ではない(2026-10-29、N2B-31の
                # 2SB200W-N2。梁の上下のファスナー板[PL-12、tfと同じ12離れた2本線]が
                # 梁を横切る板の条件で一続きになり、4120の縦の梁と誤認された)。
                if depth is not None and not any(
                        (round(f[1]), round(f[2])) != (lv_lo, lv_hi)
                        and f[3] < end - 0.6 and f[4] > start + 0.6
                        and abs(max(f[2], lv_hi) - min(f[1], lv_lo) - depth) <= 0.6
                        for f in fs):
                    continue
                cands.append((length, th, fs, (lv_lo, lv_hi), start, end))

    def outer(c, pos):
        # 候補cの、軸方向の位置posでの梁全体の外側(lo, hi)
        near = [f for f in c[2] if f[3] - 0.6 <= pos <= f[4] + 0.6]
        return (min(f[1] for f in near), max(f[2] for f in near)) if near else None

    def rests_on(c, o):
        # 候補cの端が、向きの違う候補oのフランジの外側の線の上に載っているか
        _l, th_c, _fs, _lv, s_c, e_c = c
        _l2, th_o, _fs2, _lv2, s_o, e_o = o
        d = abs(th_c - th_o)
        if min(d, math.pi - d) < math.radians(1):
            return False
        ux, uy = math.cos(th_c), math.sin(th_c)
        vx, vy = math.cos(th_o), math.sin(th_o)
        for pos in (s_c, e_c):
            lh = outer(c, pos)
            if not lh:
                continue
            m = (lh[0] + lh[1]) / 2
            px, py = pos * ux - m * uy, pos * uy + m * ux
            a = px * vx + py * vy
            if not s_o - 0.6 <= a <= e_o + 0.6:
                continue
            face = outer(o, a)
            d_o = -px * vy + py * vx
            if face and min(abs(d_o - face[0]), abs(d_o - face[1])) <= 0.6:
                return True
        return False

    # 端が別の候補(同じサイズ)のフランジの外側の線の上に載っているものは、梁に
    # 取り付く部材であって梁本体ではない(2026-10-30、NRB-43のRSB150WK-N1。梁[650]の
    # 上に同じH-150の縦の部材[1155]が立っており、長いほうが梁と誤認された)。
    keep = [c for c in cands if not any(rests_on(c, o) for o in cands if o is not c)]
    if not keep:
        return None
    best = max(keep, key=lambda c: c[0])
    if not with_others:
        return _finish(best)
    return _finish(best), [_finish(c) for c in keep if c is not best]


def _finish_flange_member(tdf, c, joinable, depth):
    """_flange_member の候補を、両端を伸ばして (長さ, (左端, 右端), 向き[度]) にする。"""
    # 選んだ梁の両端から、同じ高さの切れ端へ同じ条件でつながるときは、製品の範囲の
    # 外まで伸ばす(1枚の図面に製品が2つあると、梁の一部が次の製品マークより先まで
    # 描かれるため)。
    _length, th, fs, level, start, end = c
    ux, uy = math.cos(th), math.sin(th)

    def depth_at(pos):
        near = [f for f in fs if f[3] - 0.6 <= pos <= f[4] + 0.6]
        return (min(f[1] for f in near), max(f[2] for f in near)) if near else None

    ivs = sorted({(round(f[3], 1), round(f[4], 1)): (f[3], f[4]) for f in fs
                  if (round(f[1]), round(f[2])) == level}.values())
    ivs = [(s, e) for s, e in ivs
           if not any(s2 <= s + 0.6 and e - 0.6 <= e2 and (s2, e2) != (s, e) for s2, e2 in ivs)]
    for s1, e1 in ivs:
        if e1 <= end + 0.6:
            continue
        if s1 < end - 0.6 or not joinable(th, fs, depth_at, end, s1):
            break
        end = e1
    for s0, e0 in reversed(ivs):
        if s0 >= start - 0.6:
            continue
        if e0 > start + 0.6 or not joinable(th, fs, depth_at, e0, start):
            break
        start = s0

    # 端の高さ(梁せいの中央)は、梁自身のフランジと、それと外側どうしで梁せいだけ
    # 離れたもう1組のフランジから求める。同じ位置にある別の図(平面図等)の同じ向きの
    # フランジまで含めると、端が梁の外へずれる(2026-10-30、WA1-1G-05のGJ140Fで
    # 1784、N2B-01の右端で2328。継手のボルトを端で探すために直した)。梁せいが
    # 分からない・組が見つからないとき(テーパー梁、2L等)は従来どおり。
    def own_depth(pos):
        near = [f for f in fs if f[3] - 0.6 <= pos <= f[4] + 0.6]
        bands = {(round(f[1]), round(f[2])): (f[1], f[2]) for f in near}
        mine = bands.get(level)
        if mine is None or depth is None:
            return depth_at(pos)
        pair = [v for k, v in bands.items()
                if k != level and abs(max(v[1], mine[1]) - min(v[0], mine[0]) - depth) <= 0.6]
        if not pair:
            return depth_at(pos)
        return (min(mine[0], pair[0][0]), max(mine[1], pair[0][1]))

    ends = []
    for pos in (start, end):
        lo, hi = own_depth(pos)
        c = (lo + hi) / 2
        ends.append((pos * ux - c * uy, pos * uy + c * ux))
    ends.sort()
    return (round(end - start, 1), (ends[0], ends[1]), math.degrees(th))

BENT_MIN_DEG = 0.05   # 腰折れ梁とみなす左右の梁の向きの差(下限。これ未満は同じ向き)
BENT_MAX_DEG = 10.0   # 同(上限)
BENT_MAX_GAP = 100.0  # 腰折れ梁の左右の梁の端(梁せいの中央)どうしの距離の上限(ダイアフラム等)
BENT_MAX_BRIDGE = 1500.0  # 通しダイアフラムの板をはさむときの、左右の梁の端どうしの距離の上限


def _axis(deg):
    """向き(度)の単位ベクトル。左から右へ向くようにそろえる。"""
    ux, uy = math.cos(math.radians(deg)), math.sin(math.radians(deg))
    return (ux, uy) if ux > 1e-9 or (abs(ux) <= 1e-9 and uy > 0) else (-ux, -uy)


def _diaphragm_bridge(tdf, e_m, e_o, deg, depth):
    """左右の梁の端の間に、梁の上下のフランジをつなぐ板(通しダイアフラム)が描かれていれば
    その長さ(左右の梁の間の長さ)。無ければ None。

    柱を通るダイアフラムの部分は、梁の上下のフランジの高さに、左右の梁の端から端まで
    渡る線として描かれる(2026-11-06、26-16 の WB1-RG-10 の RG-X16Y5。左 6628.7 と
    右 588.1 の間に、410 の線が上下に2本ずつ[PL-36])。左右の梁の端の位置に両端が
    そろう、梁とほぼ同じ向きの線が2本以上あるときだけ、その線の長さを返す。
    """
    if not depth:
        return None
    ux, uy = _axis(deg)
    a, b = sorted((e_m[0] * ux + e_m[1] * uy, e_o[0] * ux + e_o[1] * uy))
    if not BENT_MAX_GAP < b - a <= BENT_MAX_BRIDGE:
        return None
    mid = (-(e_m[0] + e_o[0]) / 2 * uy + (e_m[1] + e_o[1]) / 2 * ux)
    tol = 2.0 + depth * 0.02  # 梁がわずかに傾いていても、水平の板の端がそろうように
    found = []
    for ln in tdf.lines:
        t = math.degrees(math.atan2(ln.y2 - ln.y1, ln.x2 - ln.x1))
        if abs((t - deg + 90.0) % 180.0 - 90.0) > BENT_MAX_DEG:
            continue
        p = sorted((ln.x1 * ux + ln.y1 * uy, ln.x2 * ux + ln.y2 * uy))
        if abs(p[0] - a) > tol or abs(p[1] - b) > tol:
            continue
        if abs(-(ln.x1 + ln.x2) / 2 * uy + (ln.y1 + ln.y2) / 2 * ux - mid) > depth:
            continue
        found.append(round(ln.length, 1))
    if len(found) < 2:
        return None
    return max(set(found), key=found.count)


def _bent_partner(member, others, tdf=None, depth=None):
    """腰折れ梁の、梁本体とつながるもう一方の梁。無ければ None。

    中央付近でダイアフラムをはさんで2つのH形鋼をつなぎ、1本の製品にした梁
    (屋根のように中央から左右に下る形)は、左右で向きのわずかに違う2本の梁として
    描かれる(2026-11-06、26-16 の EB1-RG-05 の RG-X15Y3。左 6541.2・+0.872°、
    右 5141・-0.776°、間 45)。同じサイズのフランジの組から求めたほかの候補のうち、
    向きの差が BENT_MIN_DEG〜BENT_MAX_DEG で、端(梁せいの中央)どうしが
    BENT_MAX_GAP 以内にあり、そこから反対側へ伸びるものを、もう一方の梁とする。
    端どうしがそれより離れていても、間に通しダイアフラムの板が描かれていれば
    (_diaphragm_bridge)、柱を通して1本にした製品として同じに扱う(26-16 の WB1-RG-10)。
    戻り値は (間の長さ, もう一方の梁, 梁本体の外側の端, もう一方の梁の外側の端,
    通しダイアフラムの長さ[無ければ None])。
    """
    _length, (pa, pb), deg = member
    best = None
    for o in others:
        d = abs((o[2] - deg + 90.0) % 180.0 - 90.0)
        if not BENT_MIN_DEG < d <= BENT_MAX_DEG:
            continue
        qa, qb = o[1]
        for e_m, far_m in ((pa, pb), (pb, pa)):
            for e_o, far_o in ((qa, qb), (qb, qa)):
                gap = math.hypot(e_o[0] - e_m[0], e_o[1] - e_m[1])
                bridge = None
                if gap > BENT_MAX_GAP:
                    bridge = _diaphragm_bridge(tdf, e_m, e_o, deg, depth) if tdf is not None else None
                    if bridge is None:
                        continue
                    gap = bridge
                # もう一方の梁は、つなぎ目から梁本体と反対の側へ伸びる
                if math.hypot(far_o[0] - far_m[0], far_o[1] - far_m[1]) <= math.hypot(e_m[0] - far_m[0], e_m[1] - far_m[1]):
                    continue
                if best is None or gap < best[0]:
                    best = (gap, o, far_m, far_o, bridge)
    return best


def _below_dim(tdf, group, tf):
    """梁(同じ向き・同じ区間のフランジの組 group)の下側に書かれた長さの寸法の値。無ければ None。

    梁の長さの寸法は、上フランジ(上FLG)を梁の上側に、下フランジとウェブ(下FLG・WEB)を
    下側に書く。腰折れ梁・柱を通す梁では、下側の寸法を左右の梁の長さに使う(ユーザー指示。
    26-16 の EB1-RG-05 は 6541.2・5141、WB1-RG-10 は 6628.7・588.1。上側は 6541.8・5141.5、
    6628.3・595.1)。組のフランジの線より下にあり、区間の範囲に書かれ、値が組の長さと
    板厚(tf)以内の寸法の文字のうち、梁に一番近いものを使う。
    """
    if not group:
        return None
    ux, uy = _axis(group[0][2])
    th = math.radians(group[0][2])
    lens = [c[0] for c in group]
    offs, projs = [], []
    for ln in tdf.lines:
        if ln.length < 100 or not any(abs(ln.length - L) <= MEMBER_DIM_TOL for L in lens):
            continue
        t = math.atan2(ln.y2 - ln.y1, ln.x2 - ln.x1)
        if abs((math.degrees(t - th) + 90.0) % 180.0 - 90.0) > 0.05:
            continue
        offs.append(-(ln.x1 + ln.x2) / 2 * uy + (ln.y1 + ln.y2) / 2 * ux)
        projs += [ln.x1 * ux + ln.y1 * uy, ln.x2 * ux + ln.y2 * uy]
    if not offs:
        return None
    bottom, lo, hi = min(offs), min(projs), max(projs)
    best = None
    for rec in tdf.texts:
        s = (tdf.resolve_text(rec) or "").strip().replace(",", "")
        if not _NUMERIC_TEXT.match(s):
            continue
        v = float(s)
        if not any(abs(v - L) <= (tf or 0) + 1e-9 for L in lens):
            continue
        q = rec.x * ux + rec.y * uy
        o = -rec.x * uy + rec.y * ux
        if not (lo <= q <= hi and o < bottom):
            continue
        if best is None or o > best[0]:
            best = (o, v)
    return None if best is None else best[1]


def _bent_length(tdf, member, partner, cands, dim_values, tf, bridge=None):
    """腰折れ梁の、左右の梁の長さとつなぎ目の隙間の合計(mm)。

    上下のフランジで長さと端の位置が少しずつ違い、図面にも両方の寸法が書かれる
    (26-16 の EB1-RG-05: 上 6541.2・5141、下 6541.8・5141.5。つなぎ目が屋根形なので
    下側ほど隙間が広い)。左右それぞれ、同じ向き・同じ区間のフランジの組(長さが
    寸法の文字にあるものを優先)の中から、つなぎ目側のフランジの線の端どうしが
    一番近い組み合わせを選び、その長さ(寸法の文字の値)と端どうしの距離を足す
    (EB1-RG-05: 6541.2 + 45 + 5141 = 11727.2。ユーザー指示)。
    梁の下側に長さの寸法が書かれていれば、左右の梁の長さはその値を使う(_below_dim)。
    間に通しダイアフラムの板があるときは、間の長さはその板の長さ(bridge)にする
    (WB1-RG-10: 6628.7 + 410 + 588.1 = 7626.8。ユーザー指示)。
    """
    def same(a, b):
        d = abs((a[2] - b[2] + 90.0) % 180.0 - 90.0)
        if d > 0.05:
            return False
        ux, uy = math.cos(math.radians(a[2])), math.sin(math.radians(a[2]))
        pa = sorted(p[0] * ux + p[1] * uy for p in a[1])
        pb = sorted(p[0] * ux + p[1] * uy for p in b[1])
        return min(pa[1], pb[1]) - max(pa[0], pb[0]) > 0.5 * min(pa[1] - pa[0], pb[1] - pb[0])

    def group(seg):
        g = [c for c in cands if same(c, seg)] or [seg]
        drawn = [(c, _drawn_value(dim_values, c[0])) for c in g]
        return [(c, v) for c, v in drawn if v is not None] or [(c, None) for c in g]

    # つなぎ目の位置(両方の梁の端のうち一番近い2点の中点)
    _g, j1, j2 = min(((math.hypot(a[0] - b[0], a[1] - b[1]), a, b) for a in member[1] for b in partner[1]),
                     key=lambda v: v[0])
    jx, jy = (j1[0] + j2[0]) / 2, (j1[1] + j2[1]) / 2
    reach = 2 * (_g + 2 * (tf or 0)) + 1000  # つなぎ目の近くにある端点だけを見る

    def ends(seg):
        # その組のフランジの線(長さが組の長さに一致する、同じ向きの線)のつなぎ目側の端点
        out = []
        th = math.radians(seg[2])
        for ln in tdf.lines:
            if ln.length < 100 or abs(ln.length - seg[0]) > MEMBER_DIM_TOL:  # 組の長さは0.1単位
                continue
            t = math.atan2(ln.y2 - ln.y1, ln.x2 - ln.x1)
            d = abs((math.degrees(t - th) + 90.0) % 180.0 - 90.0)
            if d > 0.05:
                continue
            for q in ((ln.x1, ln.y1), (ln.x2, ln.y2)):
                if math.hypot(q[0] - jx, q[1] - jy) <= reach:
                    out.append(q)
        return out

    best = None
    for cm, vm in group(member):
        em = ends(cm)
        for cp, vp in group(partner):
            ep = ends(cp)
            gaps = [math.hypot(a[0] - b[0], a[1] - b[1]) for a in em for b in ep]
            if not gaps:
                continue
            gap = min(gaps)
            if best is None or gap < best[0]:
                best = (gap, cm[0] if vm is None else vm, cp[0] if vp is None else vp)
    if best is None:
        gap, seg_m, seg_p = _g, member[0], partner[0]
    else:
        gap, seg_m, seg_p = best
    if bridge is not None:
        gap = bridge
    below_m = _below_dim(tdf, [c for c in cands if same(c, member)] or [member], tf)
    below_p = _below_dim(tdf, [c for c in cands if same(c, partner)] or [partner], tf)
    if below_m is not None:
        seg_m = below_m
    if below_p is not None:
        seg_p = below_p
    return round(seg_m + gap + seg_p, 1)


_NUMERIC_TEXT = re.compile(r"^[0-9]+(?:\.[0-9]+)?$")


def _numeric_texts(tdf):
    """図面に書かれている数値だけの文字(寸法値)の一覧。"""
    vals = []
    for rec in tdf.texts:
        s = (tdf.resolve_text(rec) or "").strip().replace(",", "")
        if _NUMERIC_TEXT.match(s):
            vals.append(float(s))
    return vals


def _dim_sums(tdf):
    """同じ寸法線の上に並ぶ寸法の文字(同じ向き・同じ高さ)の、隣り合う2〜8個の合計の一覧。

    梁の全長の寸法が書かれておらず、部分の寸法だけが並んでいる図面で、長さを
    推測するのに使う(2026-11-04、26-12 の 1B-01 の 1Sb70MA-2。全長 2992.5 の
    寸法が無く、2458+534.5・530+650+1812.5 だけが書かれていた)。
    """
    lines = {}
    for rec in tdf.texts:
        s = (tdf.resolve_text(rec) or "").strip().replace(",", "")
        if not _NUMERIC_TEXT.match(s):
            continue
        rot = tdf.resolve_rot(rec) or 0.0
        c, sn = math.cos(rot), math.sin(rot)
        key = (round(rot, 2), round(-rec.x * sn + rec.y * c))
        lines.setdefault(key, []).append((rec.x * c + rec.y * sn, float(s)))
    sums = set()
    for vals in lines.values():
        vals.sort()
        v = [x for _, x in vals]
        for i in range(len(v)):
            acc = v[i]
            for j in range(i + 1, min(len(v), i + 8)):
                acc += v[j]
                sums.add(round(acc, 1))
    return sums


def _member_length_options(tdf, member, tf, depth):
    """フランジから求めた梁の長さと、両端をウェブの端の線まで伸ばした長さの候補(短い順)。

    _web_member は板厚(tf)までしか伸ばさないが、フランジが端の手前で切られ、ウェブだけが
    先まで描かれていることがある(26-12 の 1B-01。フランジは 2942.5、ウェブの端の線は
    右へ50先で 2992.5)。寸法の合計で長さを推測するときだけ、梁せい(depth)まで探す。
    """
    length, (pa, pb), th_deg = member
    opts = {round(length, 1)}
    if not tf or not depth:
        return sorted(opts)
    th = math.radians(th_deg)
    ux, uy = math.cos(th), math.sin(th)
    m = -pa[0] * uy + pa[1] * ux
    web_lo, web_hi = m - depth / 2 + tf, m + depth / 2 - tf
    a, b = pa[0] * ux + pa[1] * uy, pb[0] * ux + pb[1] * uy
    start, end = min(a, b), max(a, b)

    def web_ends(p, outward):
        found = [0.0]
        for ln in tdf.lines:
            if ln.length < 20:
                continue
            t = math.atan2(ln.y2 - ln.y1, ln.x2 - ln.x1) % math.pi
            d = abs(t - th % math.pi)
            if abs(min(d, math.pi - d) - math.pi / 2) > math.radians(0.05):
                continue
            q = (ln.x1 + ln.x2) / 2 * ux + (ln.y1 + ln.y2) / 2 * uy
            o = sorted((-ln.x1 * uy + ln.y1 * ux, -ln.x2 * uy + ln.y2 * ux))
            if not (o[0] < m < o[1]) or o[0] < web_lo - 0.6 or o[1] > web_hi + 0.6:
                continue
            out = (q - p) * outward
            if 0.6 < out <= depth + 0.6:
                found.append(out)
        return found

    for el in web_ends(start, -1):
        for er in web_ends(end, +1):
            opts.add(round(end - start + el + er, 1))
    return sorted(opts)


def _in_drawing(dim_values, length):
    """長さ(mm)が図面の寸法の文字として実在するか。"""
    return length is not None and any(abs(v - length) < 0.05 for v in dim_values)


MEMBER_DIM_TOL = 0.1  # フランジから求めた長さと寸法の文字の差の許容


def _drawn_value(dim_values, length):
    """フランジから求めた長さに一致する寸法の文字の値(差0.1以内で一番近いもの)。

    寸法の文字は小数1桁に丸めて書かれ、寸法の端がフランジの端とわずかにずれることも
    ある(2026-11-02、26-12 の 2G-13。フランジから 8154.33、寸法の文字は 8154.4)。
    長さには図面に書かれた寸法の値を使う(ユーザー指示)。無ければ None。
    """
    near = [v for v in dim_values if abs(v - length) <= MEMBER_DIM_TOL + 1e-9]
    return min(near, key=lambda v: abs(v - length)) if near else None


def _flange_width(size):
    """サイズ表記のフランジ幅(2番目の数値)を返す(H-300x300x10x15 なら 300)。"""
    m = re.match(r"^[^-0-9]*-[0-9]+(?:\.[0-9]+)?x([0-9]+(?:\.[0-9]+)?)x", size or "")
    return float(m.group(1)) if m else None


BASE_PLATE_MAX_T = 100.0  # ベースプレートの厚さの上限


def _base_plate_thickness(tdf, member, width, dim_values):
    """縦の部材(間柱等)の下端に付くベースプレートの厚さ。無ければ None。

    梁モードで読む間柱も、長さはベースプレートの厚さを含める(柱モードと同じ。
    2026-11-05、26-16 の WA2-1G-05A の 1P300-X22Y4。本体 1454 + PL-16 = 1470。
    図面の全長の寸法 1470 は書かれていない)。下端の真下に、部材の幅より広い板の
    四角(上辺は下端の高さ、下辺は厚さ t だけ下、左右の縦線)があり、t が寸法の
    文字として書かれているときだけ、その t を返す。
    """
    length, (pa, pb), th_deg = member
    if not width or abs(th_deg % 180.0 - 90.0) > 0.1:
        return None
    x0 = (pa[0] + pb[0]) / 2
    y_end = min(pa[1], pb[1])
    tol = 0.6
    horiz = [ln for ln in tdf.lines
             if abs(ln.y1 - ln.y2) < 0.01 and abs(ln.x2 - ln.x1) > width]
    tops = [ln for ln in horiz if abs(ln.y1 - y_end) < tol]
    for top in tops:
        lo, hi = sorted((top.x1, top.x2))
        # 板は部材より広く、部材の中心の左右に同じくらい張り出す
        if not (lo < x0 - width / 2 - tol and hi > x0 + width / 2 + tol):
            continue
        if abs((x0 - lo) - (hi - x0)) > tol:
            continue
        for bot in horiz:
            t = y_end - bot.y1
            if not (tol < t <= BASE_PLATE_MAX_T):
                continue
            blo, bhi = sorted((bot.x1, bot.x2))
            if blo > lo + tol or bhi < hi - tol:
                continue
            sides = 0
            for x_side in (lo, hi):
                if any(abs(ln.x1 - ln.x2) < 0.01 and abs(ln.x1 - x_side) < tol
                       and abs(min(ln.y1, ln.y2) - bot.y1) < tol
                       and abs(max(ln.y1, ln.y2) - y_end) < tol for ln in tdf.lines):
                    sides += 1
            if sides == 2 and _in_drawing(dim_values, t):
                return t
    return None


def _web_member(tdf, member, tf, depth):
    """フランジから求めた梁の両端を、ウェブの端の線まで伸ばしたもの。

    フランジの端が切欠き等でウェブの端より内側に描かれることがある(2026-11-02、
    26-12 の 4G-15。図面の長さは「5618(WEB寸法)」で、フランジは左端で2短く 5616)。
    梁の端から外側へ板厚(tf)以内にある、主軸に直交する線のうち、梁せいの中央を
    横切り、上下のフランジの内側に収まるもの(ウェブの端の線)の一番外側を端とする。
    戻り値は _flange_member と同じ形。梁せい・板厚が分からなければ None。
    """
    if not tf or not depth:
        return None
    _length, (pa, pb), th_deg = member
    th = math.radians(th_deg)
    ux, uy = math.cos(th), math.sin(th)
    m = -pa[0] * uy + pa[1] * ux  # 梁せいの中央(主軸に直交する方向の位置)
    web_lo, web_hi = m - depth / 2 + tf, m + depth / 2 - tf
    a, b = pa[0] * ux + pa[1] * uy, pb[0] * ux + pb[1] * uy
    start, end = min(a, b), max(a, b)

    def web_end(p, outward):
        best = None
        for ln in tdf.lines:
            if ln.length < 20:
                continue
            t = math.atan2(ln.y2 - ln.y1, ln.x2 - ln.x1) % math.pi
            d = abs(t - th % math.pi)
            if abs(min(d, math.pi - d) - math.pi / 2) > math.radians(0.05):
                continue
            q = (ln.x1 + ln.x2) / 2 * ux + (ln.y1 + ln.y2) / 2 * uy
            o = sorted((-ln.x1 * uy + ln.y1 * ux, -ln.x2 * uy + ln.y2 * ux))
            if not (o[0] < m < o[1]) or o[0] < web_lo - 0.6 or o[1] > web_hi + 0.6:
                continue
            out = (q - p) * outward
            if -0.6 <= out <= tf + 0.6 and (best is None or out > best):
                best = out
        return p if best is None else p + best * outward

    start, end = web_end(start, -1), web_end(end, +1)
    ends = sorted(((start * ux - m * uy, start * uy + m * ux), (end * ux - m * uy, end * uy + m * ux)))
    return (round(end - start, 1), (ends[0], ends[1]), th_deg)


def _extract_small_beam(tdf: tb.TdfData, filename: str | None = None) -> list[dict]:
    drawing_number = ex.find_drawing_number(tdf, filename)
    rows = _get_rows_small(tdf)
    if not rows:
        return []

    _sort_rows_small(rows)
    tier_info = _compute_tier_info_small(rows)

    lengths: dict[int, float | None] = {}
    beam_types: dict[int, str | None] = {}
    joints_no_size: dict[int, tuple] = {}
    size_missing_debug: dict[int, dict] = {}
    member_ends: dict[int, tuple] = {}
    joint_axes: dict[int, float] = {}  # 斜め梁の角度(継手の長丸の向きの判定用)
    dim_values = _numeric_texts(tdf)
    dim_sums = None  # 寸法の合計(必要になったときだけ求める)
    length_checks: dict[int, str] = {}  # id(row) -> "推測" / "要確認"
    for row in rows:
        _tier_label, tier_y_max = tier_info.get(id(row), (None, None))
        if row.size_missing:
            # 「マーク|設計符号|本数」3項目パターン専用の行だが、長さ判定
            # 自体は既存4項目パターン向けdetermine_lengthをそのまま流用する
            # (2026-09-16当初はサブ寸法和+直線頻度の専用ロジック
            # `determine_length_no_size`を新設したが、S-1 R1Gシリーズの
            # 検証で、そちらは不要どころか無条件の±5000mm緩和(RELAX_MARGIN)
            # が複数製品の近接する図面で別製品の寸法情報を巻き込む害がある
            # と判明。緩和なしのdetermine_lengthだけでN-1 2G・S-1 R1Gの
            # 大半の長さが正解することを確認済み)。
            length_value, debug = ex.determine_length(tdf, row.x_mark, row.x_next, row.y, y_max=tier_y_max)
            lengths[id(row)] = length_value
            size_missing_debug[id(row)] = debug
            continue
        if len(rows) == 1:
            x_min = row.x_mark - ex.RELAX_MARGIN
            x_max = row.x_next + ex.RELAX_MARGIN
        else:
            x_min = row.x_mark
            x_max = row.x_next
        length_value, debug = ex.determine_length(tdf, x_min, x_max, row.y, y_max=tier_y_max)
        found = _flange_member(tdf, x_min, x_max, row.y, tier_y_max, _flange_thickness(row.size),
                               depth=_beam_depth(row.size), with_others=True)
        member, others = found if found is not None else (None, [])
        bent = (_bent_partner(member, others, tdf, _beam_depth(row.size))
                if member is not None else None)
        # 図面に寸法として書かれていない数値は長さにしない(ユーザー指示。フランジの
        # 形から求めた値が寸法の文字に無ければ、従来の寸法から選ぶ方式の値を使う)
        axis = debug.get("main_axis_deg")
        drawn = _drawn_value(dim_values, member[0]) if member is not None and bent is None else None
        if bent is not None:
            # 腰折れ梁(2026-11-06、ユーザー指示): 全長の寸法が書かれていればその値。
            # 無ければ「長さの記載漏れ」として、左右の梁の長さ(寸法の文字があればその値)と
            # 間の隙間(ダイアフラム)の合計を暫定の長さにし、「推測」の印を付けて
            # 取り込み後のダイアログとセルの色で知らせる。継手は左右の外側の端で探し、
            # 長丸の向きは左右どちらの梁の向きでもよい。
            gap, partner, far_m, far_p, bridge = bent
            total = _bent_length(tdf, member, partner, [member] + others, dim_values,
                                 _flange_thickness(row.size), bridge)
            whole = _drawn_value(dim_values, total)
            if whole is not None:
                length_value = whole
            else:
                length_value = total
                length_checks[id(row)] = "推測"
            member_ends[id(row)] = tuple(sorted((far_m, far_p)))
            axis = member[2]
            joint_axes[id(row)] = [member[2] % 180.0, partner[2] % 180.0]
            lengths[id(row)] = length_value
            beam_types[id(row)] = classify_beam_type(axis)
            continue
        if member is not None and drawn is None:
            # フランジの長さに合う寸法が無ければ、ウェブの端まで伸ばした長さで探す
            web = _web_member(tdf, member, _flange_thickness(row.size), _beam_depth(row.size))
            if web is not None and web[0] != member[0]:
                drawn = _drawn_value(dim_values, web[0])
                if drawn is not None:
                    member = web
        if drawn is not None:
            _member_length, member_ends[id(row)], axis = member
            length_value = drawn
            plate_t = _base_plate_thickness(tdf, member, _flange_width(row.size), dim_values)
            if plate_t is not None:
                # 全長は図面に書かれていない(寸法の合計)ので「推測」の印を付け、
                # 取り込み後のダイアログとセルの色で知らせる(ユーザー指示)
                length_value = drawn + plate_t
                length_checks[id(row)] = "推測"
        elif member is not None:
            # 梁の線の長さに合う寸法の文字が図面に無い(寸法線の不足等)。同じ寸法線の
            # 上の隣り合う寸法の合計が梁の長さに合えば、その合計を長さとし「推測」の
            # 印を付ける。合わなければ従来の寸法から選ぶ方式の値のまま「要確認」の
            # 印を付ける(2026-11-04、ユーザー指示。取り込み後に画面で知らせる)。
            # ただし従来の方式の値が図面の寸法の文字で、梁の線との差が板厚以内なら、
            # 端の切り方の違い等とみなしてその値を残す(26-16 の EA1-RB-02 等の
            # RTB587A。上フランジの寸法 5382.3 が書かれ、梁の線は 5390.5 で、隙間の
            # 寸法との合計 8.2+5382.3 が梁の線に一致してしまう)。
            tf = _flange_thickness(row.size)
            est = None
            if not (length_value is not None and tf and _in_drawing(dim_values, length_value)
                    and abs(length_value - member[0]) <= tf + 1e-9):
                if dim_sums is None:
                    dim_sums = _dim_sums(tdf)
                for cand in _member_length_options(tdf, member, tf, _beam_depth(row.size)):
                    near = [s for s in dim_sums if abs(s - cand) <= MEMBER_DIM_TOL + 1e-9]
                    if near:
                        est = min(near, key=lambda s: abs(s - cand))
                        break
            if est is not None:
                length_value = est
                length_checks[id(row)] = "推測"
            else:
                length_checks[id(row)] = "要確認"
        lengths[id(row)] = length_value
        # 梁の向きは、フランジから求めたときはフランジの線の向きで判定する。寸法線は
        # 斜めの部材でも水平・垂直に引かれることがある(2026-10-29、N2B-36〜39の
        # 間柱2V11。部材は約25〜30°だが寸法線は垂直で、普通梁と判定されていた)
        beam_types[id(row)] = classify_beam_type(axis if length_value is not None else None)
        if beam_types[id(row)] == "斜め梁":
            joint_axes[id(row)] = axis % 180.0

    # 3項目パターンの行同士で同じY(行)を共有するもの(1枚の図面に2製品の
    # 寸法チェーンが連結して描かれているケース)は、隣接製品の確定した長さと
    # 直線が実際に連結しているかで長さ候補を絞り込む(S-1 R1G-07〜10対応。
    # 詳細はtdf_master_extractor._connected_length_candidateのコメント参照)。
    size_missing_rows = [r for r in rows if r.size_missing]
    by_row_y: dict[float, list] = {}
    for r in size_missing_rows:
        by_row_y.setdefault(round(r.y, 1), []).append(r)
    for members in by_row_y.values():
        if len(members) < 2:
            continue
        for row in members:
            candidates = size_missing_debug.get(id(row), {}).get("candidates")
            if not candidates:
                continue
            # 既存のdetermine_length自体が高信頼(一致直線数が多い、または
            # primary_cnt>0)で選んでいる値は、連結判定で上書きしない(僅差の
            # 場合のみ連結判定を試みる安全弁。masamizsumi-dotcom/
            # tdf-master-extractの同種の変更に合わせたもの)。
            ranked = sorted(candidates, key=lambda c: (-c[3], -c[1], -c[2]))
            top_a, top_primary = ranked[0][1], ranked[0][3]
            if top_primary > 0 or top_a > ex._AMBIGUOUS_MATCH_MAX:
                continue
            for other in members:
                if other is row:
                    continue
                sibling_length = lengths.get(id(other))
                if sibling_length is None:
                    continue
                connected = ex._connected_length_candidate(tdf, candidates, sibling_length)
                if connected is not None and connected != lengths.get(id(row)):
                    lengths[id(row)] = connected
                    break

    # 候補値のうち、端点連結した直線チェーンの合計として最も多くの系統
    # (重複して描かれた控え線群)で裏付けられるものを優先する(S-1 R1G-14〜16
    # 対応。詳細はtdf_master_extractor._chain_sum_candidateのコメント参照)。
    #
    # 上記の隣接製品連結判定と違い、こちらは「一致直線数(a)が僅差の場合の
    # み」という事前ゲートを設けていない(S-1 R1G-13の`R1GX2Y2`で、誤った
    # 答えの一致直線数[5本]が正しく動作している`N-1 2G-05`[こちらも一致
    # 直線数5本]と見分けがつかず、このゲートが正しい連結チェーン判定[系統数
    # 8]の実行を妨げていたため撤廃。代わりに`_chain_sum_candidate`側の
    # 採用基準[系統数]自体を引き上げて安全弁とした。
    # masamizsumi-dotcom/tdf-master-extractの同種の変更に合わせたもの)。
    for row in size_missing_rows:
        candidates = size_missing_debug.get(id(row), {}).get("candidates")
        if not candidates:
            continue
        _tier_label, tier_y_max = tier_info.get(id(row), (None, None))
        chain_val = ex._chain_sum_candidate(tdf, row, candidates, tier_y_max)
        if chain_val is not None and chain_val != lengths.get(id(row)):
            lengths[id(row)] = chain_val

    for row in size_missing_rows:
        _tier_label, tier_y_max = tier_info.get(id(row), (None, None))
        length_value = lengths[id(row)]
        debug = size_missing_debug.get(id(row), {})
        beam_types[id(row)] = classify_beam_type(
            debug.get("main_axis_deg") if length_value is not None else None
        )
        endpoints = (
            exm._find_reference_line_endpoints(
                tdf, row.x_mark, row.x_next, row.y, tier_y_max, length_value,
            ) if length_value is not None else None
        )
        left, right, left_jobj, right_jobj = ex.determine_joints_no_size(
            tdf, row.y, length_value, endpoints, y_max=tier_y_max
        ) if length_value is not None else (None, None, None, None)
        joints_no_size[id(row)] = (left, right)
        if length_value is not None:
            row.size = ex.determine_size_no_size(tdf, endpoints, left_jobj, right_jobj)

    # 3項目パターンの行はassign_joints_batch(既存の4項目パターン専用の
    # グルーピングロジック)には一切渡さない。
    member_depths = {id(r): _beam_depth(r.size) for r in rows
                     if id(r) in member_ends and _beam_depth(r.size)}
    joints = exm.assign_joints_batch(
        tdf, [r for r in rows if not r.size_missing], tier_info, lengths, member_ends, joint_axes,
        member_depths,
    )
    joints.update(joints_no_size)

    out = []
    for row in rows:
        tier_label, _y_max = tier_info.get(id(row), (None, None))
        length_value = lengths[id(row)]
        check = length_checks.get(id(row))
        if check != "推測" and not _in_drawing(dim_values, length_value):
            length_value = None  # 寸法の文字に無い数値は出さない(空欄にする)
        left, right = joints.get(id(row), (None, None))
        if length_value is None:
            left = right = None
        # 記録はm単位(内部の判定ロジックはmm前提のまま、出力直前だけ変換)。
        # masamizsumi-dotcom/tdf-master-extract の同種の変更に合わせたもの。
        length_value_m = None if length_value is None else length_value / 1000.0
        out.append({
            "図番": drawing_number, "製品マーク": row.mark, "設計符号": row.design_code,
            "サイズ": row.size, "本数": row.count, "長さ": length_value_m, "重量": row.weight,
            "左継手": left, "右継手": right, "種別": beam_types[id(row)], "製品段": tier_label,
            "長さの確認": check,
        })
    return out


# ---------------------------------------------------------------------------
# JS側から呼び出すエントリポイント
# ---------------------------------------------------------------------------

def extract_file(path: str, filename: str | None = None) -> list[dict]:
    """1つの.tdfファイルを解析して製品情報のリスト(dict)を返す。

    filename は元のファイル名(ブラウザでは /input.tdf に書き込むため別に渡す)。
    省略時は path のファイル名を使う。"""
    tdf = tb.load(path)
    return _extract_small_beam(tdf, filename or path)
