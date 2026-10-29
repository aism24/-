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

import math
import re

import tdf_binary as tb
import tdf_master_extractor as ex
import tdf_master_extractor_multi as exm

HEADERS = [
    "ID", "図番", "製品マーク", "設計符号", "サイズ", "本数",
    "長さ(m)", "重量", "左継手", "右継手", "種別", "製品段",
]

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


def _flange_member(tdf, x_min, x_max, y_ref, y_max, tf):
    """梁本体の端から端を、フランジの形から求める。

    フランジは「板厚tfだけ離れて向かい合う平行な2本の線」として描かれる
    (寸法線・基準線にはこの性質がない)。2本の端のずれは開先の分としてtf以内まで
    認め、2本を合わせた端から端をそのフランジの長さとする。

    同じ高さに並ぶフランジの間に隙間があり、隙間の両端の線が梁全体(上下の
    フランジの外側)より外まで伸びている(=梁を横切る板。通しダイアフラム等)
    ときは、板を含めて一続きの梁とみなす。重なっているもの(継手の先の別の部材)
    はつながない。

    ハンチ等で短いフランジもあるため、最も長いものを梁本体とする。向きは線どうしで
    判定するので、斜めに描かれた梁にもそのまま使える。
    戻り値は (長さ, (左端, 右端)) で、端は梁せいの中央の座標。見つからなければNone。
    """
    if not tf:
        return None
    segs = []
    for ln in tdf.lines:
        if ln.length < 20:
            continue
        if not (x_min <= (ln.x1 + ln.x2) / 2 <= x_max and min(ln.y1, ln.y2) > y_ref
                and (y_max is None or max(ln.y1, ln.y2) < y_max)):
            continue
        segs.append((math.atan2(ln.y2 - ln.y1, ln.x2 - ln.x1) % math.pi, ln))
    long_segs = [(t, ln) for t, ln in segs if ln.length >= 100]
    flanges = []  # (向き, 直交方向の位置lo, hi, 軸方向の始点, 終点)
    for i, (ta, a) in enumerate(long_segs):
        ux, uy = math.cos(ta), math.sin(ta)
        pa = sorted((a.x1 * ux + a.y1 * uy, a.x2 * ux + a.y2 * uy))
        da = -a.x1 * uy + a.y1 * ux
        for tb_, b in long_segs[i + 1:]:
            d = abs(ta - tb_)
            if min(d, math.pi - d) > math.radians(0.05):
                continue
            db = -b.x1 * uy + b.y1 * ux
            if abs(abs(da - db) - tf) >= 0.6:
                continue
            pb = sorted((b.x1 * ux + b.y1 * uy, b.x2 * ux + b.y2 * uy))
            if abs(pa[0] - pb[0]) > tf + 0.6 or abs(pa[1] - pb[1]) > tf + 0.6:
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

    best = None
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
        for ivs in levels.values():
            ivs = sorted(ivs.values())
            for i, (start, end) in enumerate(ivs):
                for s1, e1 in ivs[i + 1:]:
                    if s1 <= end + 0.6:
                        break
                    dl, dr = depth_at(end), depth_at(s1)
                    if not dl or not dr:
                        break
                    lo, hi = min(dl[0], dr[0]), max(dl[1], dr[1])
                    if crossing_line(th, end, lo, hi) and crossing_line(th, s1, lo, hi):
                        end = e1
                    else:
                        break
                length = round(end - start, 1)
                if best is None or length > best[0]:
                    ends = []
                    for pos in (start, end):
                        lo, hi = depth_at(pos)
                        c = (lo + hi) / 2
                        ends.append((pos * ux - c * uy, pos * uy + c * ux))
                    ends.sort()
                    best = (length, (ends[0], ends[1]))
    return best

def _extract_small_beam(tdf: tb.TdfData) -> list[dict]:
    drawing_number = ex.find_drawing_number(tdf)
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
        member = _flange_member(tdf, x_min, x_max, row.y, tier_y_max, _flange_thickness(row.size))
        if member is not None:
            length_value, member_ends[id(row)] = member
        lengths[id(row)] = length_value
        beam_types[id(row)] = classify_beam_type(
            debug.get("main_axis_deg") if length_value is not None else None
        )

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
    joints = exm.assign_joints_batch(
        tdf, [r for r in rows if not r.size_missing], tier_info, lengths, member_ends
    )
    joints.update(joints_no_size)

    out = []
    for row in rows:
        tier_label, _y_max = tier_info.get(id(row), (None, None))
        length_value = lengths[id(row)]
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
        })
    return out


# ---------------------------------------------------------------------------
# JS側から呼び出すエントリポイント
# ---------------------------------------------------------------------------

def extract_file(path: str) -> list[dict]:
    """1つの.tdfファイルを解析して製品情報のリスト(dict)を返す。"""
    tdf = tb.load(path)
    return _extract_small_beam(tdf)
