"""柱・間柱(製品が縦向き)の詳細図から製品情報を抽出する(柱モード)。

梁の抽出(tdf_app.py)とは別のコード。TDFの読み込み(tdf_binary.py)と、製品の行・
長丸を探す既存の関数(tdf_master_extractor.py)は読むだけで使い、変更しない。

決めた仕様(2026-10-30、ユーザー確認):
- 長さは柱の上端から下端まで。ベースプレートの厚さを含める。
- 製品の行のサイズが「図示」のときは、図の中の「□-」のサイズを板厚を除いて出す。
  途中で外形が変わる柱は、下の節から上へ「□-700x700＿350x350」のようにつなぐ。
- 継手は「下継手」「上継手」。柱脚(ベースプレート・アンカーボルト)は出さない。
- 重量は、板厚を除いたサイズでは重量表から計算できないので空欄(JS側の計算が
  サイズで重量表を引くため、自然に空欄になる)。
"""
from __future__ import annotations

import math
import re
import unicodedata

import tdf_binary as tb
import tdf_master_extractor as ex

HEADERS = [
    "ID", "図番", "製品マーク", "設計符号", "サイズ", "本数",
    "長さ(m)", "重量", "下継手", "上継手",
]

SAME_ROW_Y_TOL = 10.0
_BOX_SIZE = re.compile(r"^□\s*[\-‐]?\s*(\d+(?:\.\d+)?)\s*[xX×]\s*(\d+(?:\.\d+)?)(?:\s*[xX×]\s*(\d+(?:\.\d+)?))?")
_DIMS = re.compile(r"[\-‐]\s*(\d+(?:\.\d+)?)\s*[xX×]\s*(\d+(?:\.\d+)?)")
_NUMERIC = re.compile(r"^[0-9]+(?:\.[0-9]+)?$")

VERT_TOL = 0.5        # 垂直とみなすX座標の差
WIDTH_TOL = 1.0       # 外形の幅とみなす誤差
MIN_BODY = 1000.0     # 柱本体とみなす最小の長さ
END_PLATE_REACH = 200.0  # 本体の端からベースプレート等の板の外面までの範囲


def _norm(s: str | None) -> str:
    return unicodedata.normalize("NFKC", s or "").strip()


def _is_zushi(s: str | None) -> bool:
    return _norm(s).replace(" ", "") == "図示"


def _is_size(s: str | None) -> bool:
    t = _norm(s)
    return bool(_BOX_SIZE.match(t)) or ex._looks_like_size(t)


# ---------------------------------------------------------------------------
# 製品の行
# ---------------------------------------------------------------------------

def find_rows(tdf: tb.TdfData) -> list[dict]:
    """「N台」の左に並ぶ3つの文字を製品の行として読む。

    並びは2通り(26-14 の柱詳細図・間柱詳細図で確認):
      間柱: 製品マーク | 設計符号 | サイズ | 本数
      柱  : 設計符号 | 製品マーク | 図示 | 本数
    「図示」の行は、図の中でサイズの文字のすぐ上に書かれている方を設計符号とする
    (どちらにも無ければ並びのとおり)。
    """
    rows = []
    for dai in tdf.texts:
        if dai.rot != 0 or not tb.is_dai_cell(tdf.resolve_text(dai)):
            continue
        cells = sorted(
            [r for r in tdf.texts if r.rot == 0 and abs(r.y - dai.y) < SAME_ROW_Y_TOL
             and r.x < dai.x and tdf.resolve_text(r)],
            key=lambda r: r.x,
        )[-3:]
        if len(cells) < 3:
            continue
        a, b, c = (_norm(tdf.resolve_text(r)) for r in cells)
        if _is_zushi(c):
            labels = _size_code_labels(tdf)
            if a in labels or b not in labels:
                code, mark = a, b
            else:
                code, mark = b, a
            rows.append({"mark": mark, "code": code, "size": None, "zushi": True,
                         "count": _norm(tdf.resolve_text(dai)), "y": dai.y})
        elif _is_size(c):
            rows.append({"mark": a, "code": b, "size": c, "zushi": False,
                         "count": _norm(tdf.resolve_text(dai)), "y": dai.y})
    return rows


def _box_labels(tdf: tb.TdfData):
    out = []
    for r in tdf.texts:
        s = _norm(tdf.resolve_text(r))
        m = _BOX_SIZE.match(s)
        if m:
            out.append((r, m))
    return out


def _size_code_labels(tdf: tb.TdfData) -> set[str]:
    """図の中で「□-」のサイズの文字のすぐ上(1行上)にある文字(設計符号)。"""
    codes = set()
    for r, _m in _box_labels(tdf):
        for q in tdf.texts:
            if q is r:
                continue
            dy = q.y - r.y
            if 0 < dy <= max(r.h, 1.0) * 2.0 and abs(q.x - r.x) <= r.h * 3.0:
                s = _norm(tdf.resolve_text(q))
                if s:
                    codes.add(s)
    return codes


def drawing_box_size(tdf: tb.TdfData) -> tuple[str | None, list[float]]:
    """図の中の「□-」のサイズを板厚を除いてまとめる(下の位置から上へ)。

    戻り値: (サイズの文字, 外形の幅の一覧[線から本体を探すため])
    """
    groups: dict[tuple[float, float], list[float]] = {}
    for r, m in _box_labels(tdf):
        key = (float(m.group(1)), float(m.group(2)))
        groups.setdefault(key, []).append(r.y)
    if not groups:
        return None, []
    order = sorted(groups, key=lambda k: sum(groups[k]) / len(groups[k]))  # 下(Yが小さい)から
    fmt = lambda v: str(int(v)) if v == int(v) else str(v)
    text = "□-" + "＿".join(f"{fmt(a)}x{fmt(b)}" for a, b in order)
    widths = sorted({w for k in order for w in k}, reverse=True)
    return text, widths


def _widths_from_size(size: str | None) -> list[float]:
    m = _BOX_SIZE.match(_norm(size)) or _DIMS.search(_norm(size))
    if not m:
        return []
    return sorted({float(m.group(1)), float(m.group(2))}, reverse=True)


# ---------------------------------------------------------------------------
# 柱本体(立面図の外形線)
# ---------------------------------------------------------------------------

def _vertical_lines(tdf: tb.TdfData):
    by_x: dict[float, list[tuple[float, float]]] = {}
    for ln in tdf.lines:
        if abs(ln.x1 - ln.x2) <= VERT_TOL and abs(ln.y1 - ln.y2) >= 20.0:
            x = round((ln.x1 + ln.x2) / 2 * 2) / 2
            by_x.setdefault(x, []).append((min(ln.y1, ln.y2), max(ln.y1, ln.y2)))
    return by_x


def _merge(iv):
    out = []
    for lo, hi in sorted(iv):
        if out and lo <= out[-1][1] + 0.5:
            out[-1][1] = max(out[-1][1], hi)
        else:
            out.append([lo, hi])
    return out


def _intersect(a, b):
    out, i, j = [], 0, 0
    while i < len(a) and j < len(b):
        lo, hi = max(a[i][0], b[j][0]), min(a[i][1], b[j][1])
        if hi > lo:
            out.append([lo, hi])
        if a[i][1] < b[j][1]:
            i += 1
        else:
            j += 1
    return out


def _outline_pairs(tdf: tb.TdfData, widths: list[float]):
    """幅が外形と同じだけ離れた垂直線の組。両方の線が重なる区間を持つ。"""
    by_x = _vertical_lines(tdf)
    xs = sorted(by_x)
    merged = {x: _merge(by_x[x]) for x in xs}
    pairs = []
    for w in widths:
        for i, x1 in enumerate(xs):
            for x2 in xs[i + 1:]:
                if x2 - x1 > w + WIDTH_TOL:
                    break
                if abs(x2 - x1 - w) <= WIDTH_TOL:
                    segs = _intersect(merged[x1], merged[x2])
                    cover = sum(hi - lo for lo, hi in segs)
                    if cover >= MIN_BODY:
                        pairs.append({"x1": x1, "x2": x2, "w": w, "segs": segs, "cover": cover})
    return pairs


_JOINT_NAME = re.compile(r"^[A-Z][A-Z0-9\-]+$")
_PLATE_NAME = re.compile(r"PL-\d")
AXIS_TOL = 1.0


def _capsule_text(tdf: tb.TdfData, cap) -> str | None:
    for r in tdf.texts:
        if ex._text_enclosed_by_capsule_no_size(tdf, r, cap):
            s = _norm(tdf.resolve_text(r))
            if s:
                return s
    return None


def _capsules(tdf: tb.TdfData):
    """継手の長丸: 向きが水平か垂直で、中に継手名(英大文字で始まる2文字以上)があるもの。

    改訂の雲マークの円弧どうし(N4C-1)や、「N」等の1文字の丸囲みを除く。
    戻り値: [(ax, ay, bx, by, r, 継手名), ...]
    """
    out = []
    for c in ex._find_stadium_capsules_no_size(tdf):
        ax, ay, bx, by, _r = c
        if abs(ax - bx) > AXIS_TOL and abs(ay - by) > AXIS_TOL:
            continue
        name = _capsule_text(tdf, c)
        # 「GPL-22」等の板の名前を囲んだ長丸(N3C-9)は継手ではない
        if name and _JOINT_NAME.match(name) and not _PLATE_NAME.search(name):
            out.append((*c, name))
    return out


INNER_REACH = 60.0   # 外形線の内側に板厚の線を探す範囲
INNER_MIN_RATIO = 0.3


def _has_inner_lines(by_x, x1: float, x2: float, segs) -> bool:
    """外形線の組の内側に、板厚の線(外形から60以内)か中心線があるか。

    寸法線どうしがたまたま外形の幅だけ離れている組(N1C-1の7539/8238)を除くため。
    柱(角形鋼管)は板厚の線、H形の間柱はフランジの板厚の線かウェブの線がある。
    """
    cover = sum(hi - lo for lo, hi in segs)
    cx = (x1 + x2) / 2
    inner = []
    for x, iv in by_x.items():
        if (x1 < x <= x1 + INNER_REACH) or (x2 - INNER_REACH <= x < x2) or abs(x - cx) <= 1.0:
            inner += iv
    got = sum(hi - lo for lo, hi in _intersect(_merge(inner), segs))
    return cover > 0 and got / cover >= INNER_MIN_RATIO


def _spanning_ys(tdf: tb.TdfData, x1: float, x2: float, lo: float, hi: float):
    """X1〜X2の幅を覆う水平線のY(lo〜hiの範囲)。"""
    ys = []
    for ln in tdf.lines:
        if abs(ln.y1 - ln.y2) > VERT_TOL:
            continue
        y = (ln.y1 + ln.y2) / 2
        if lo <= y <= hi and min(ln.x1, ln.x2) <= x1 + WIDTH_TOL and max(ln.x1, ln.x2) >= x2 - WIDTH_TOL:
            ys.append(y)
    return ys


def _body(tdf: tb.TdfData, widths: list[float]):
    """柱本体の候補: 外形線の組と、その上下の端の候補のY。

    - 外形線の組: 外形の幅だけ離れた垂直線の組で、内側に板厚の線か中心線があるもの。
      外形が途中で変わる柱は、内側に収まる細い方の組の線もまとめる。
    - 幅の内側か、幅の外へ幅の半分までにある長丸(継手)で区切り、外形線が一番長く
      残る区間を本体とする(継手の先に描かれた隣の部材を除く)。柱の継手の長丸は
      幅の中(N3C-5のCJ2)か、少し横(N3C-11のCJ2は151、N3C-5のCJ5は185)に描かれる。
      柱の途中に取り付く梁の継手は外形から770以上横にあるので区切りにしない。
    - 端の候補: 区間の中の外形線の切れ目と、幅を覆う水平線(ダイアフラム・
      ベースプレート等。外形線の端から200の外側まで)。
    戻り値: dict(x1, x2, ends[Y一覧], cover, top_cap, bottom_cap) または None
    """
    bodies = _bodies(tdf, widths)
    return bodies[0] if bodies else None


NESTED_MIN_RATIO = 0.3  # 内側の組の幅は外形の3割以上(板厚の線どうしの組を除く)
NESTED_MIN_RUN = 500.0  # 外形線の無い区間に内側の組が続く長さ


def _subtract(a, b):
    """区間の集まり a から b を除いた残り。"""
    out = []
    for lo, hi in a:
        cur = lo
        for blo, bhi in b:
            if bhi <= cur or blo >= hi:
                continue
            if blo > cur:
                out.append([cur, blo])
            cur = max(cur, bhi)
        if cur < hi:
            out.append([cur, hi])
    return out


def _nested_segs(by_x, x1: float, x2: float, main):
    """外形線の無い区間で、外形の内側に収まる縦線の組(幅は問わない)が500以上続く部分。

    柱の上の方が細い角形鋼管(N4C-1の□-350x350)やH形(N4C-5のH-300x300x10x15)に
    変わる柱は、その部分の外形線が内側に描かれる。サイズの文字は□の部分にしか無い
    ことがある(N4C-5)ので、幅をサイズから決めずに内側の組を本体の続きとする。
    外形線のある区間や、継手・ダイアフラムの短いすき間(30〜232)は足さない
    (内側の線がすき間を越えて継手の先の部材までつながることがあるため)。
    """
    xs = sorted(x for x in by_x if x1 - WIDTH_TOL <= x <= x2 + WIDTH_TOL)
    min_w = (x2 - x1) * NESTED_MIN_RATIO
    nested = []
    for i, xa in enumerate(xs):
        for xb in xs[i + 1:]:
            if xb - xa >= min_w:
                nested += _intersect(by_x[xa], by_x[xb])
    # 取り付く梁のフランジで25程度切れて描かれる(N4C-9の上のH形)ので、50までの切れ目は
    # つないで長さを数える(足すのは元の線のある区間だけ)
    runs = [r for r in _merge_gap(_subtract(_merge(nested), main), NESTED_GAP)
            if r[1] - r[0] >= NESTED_MIN_RUN]
    return _intersect(_subtract(_merge(nested), main), runs)


NESTED_GAP = 50.0


def _merge_gap(iv, gap: float):
    out = []
    for lo, hi in sorted(iv):
        if out and lo <= out[-1][1] + gap:
            out[-1][1] = max(out[-1][1], hi)
        else:
            out.append([lo, hi])
    return out


def _center_ys(tdf: tb.TdfData, cx: float, lo: float, hi: float):
    """柱の中心を覆う水平線のY(lo〜hiの範囲)。上の方が細い部分の端の板(N4C-9の
    上端の厚さ22の板)は外形の幅を覆わないので、本体の外側ではこれも端の候補にする。"""
    ys = []
    for ln in tdf.lines:
        if abs(ln.y1 - ln.y2) > VERT_TOL:
            continue
        y = (ln.y1 + ln.y2) / 2
        if lo <= y <= hi and min(ln.x1, ln.x2) <= cx - 1.0 and max(ln.x1, ln.x2) >= cx + 1.0:
            ys.append(y)
    return ys


def _bodies(tdf: tb.TdfData, widths: list[float]):
    """外形線の組ごとの本体の候補(外形線の長い順)。立面図が2つあれば2つ以上返る。"""
    pairs = _outline_pairs(tdf, widths)
    if not pairs:
        return []
    by_x = {x: _merge(iv) for x, iv in _vertical_lines(tdf).items()}
    caps = _capsules(tdf)
    found = []
    for p in pairs:
        best = None
        if p["w"] != widths[0] or not _has_inner_lines(by_x, p["x1"], p["x2"], p["segs"]):
            continue
        x1, x2 = p["x1"], p["x2"]
        segs = [list(s) for s in p["segs"]] + _nested_segs(by_x, x1, x2, p["segs"])
        segs = _merge(segs)
        reach = (x2 - x1) / 2 + WIDTH_TOL
        inside = [c for c in caps if x1 - reach <= (c[0] + c[2]) / 2 <= x2 + reach]
        cuts = sorted((c[1] + c[3]) / 2 for c in inside)
        bounds = [-1e18] + cuts + [1e18]
        for k in range(len(bounds) - 1):
            lo_b, hi_b = bounds[k], bounds[k + 1]
            part = [s for s in segs if s[0] >= lo_b and s[1] <= hi_b]
            cover = sum(s[1] - s[0] for s in part)
            if not part or cover < MIN_BODY:
                continue
            lo, hi = min(s[0] for s in part), max(s[1] for s in part)
            ends = {y for s in part for y in s}
            ends.update(_spanning_ys(tdf, x1, x2, max(lo - END_PLATE_REACH, lo_b), min(hi + END_PLATE_REACH, hi_b)))
            cx = (x1 + x2) / 2
            ends.update(_center_ys(tdf, cx, max(lo - END_PLATE_REACH, lo_b), lo))
            ends.update(_center_ys(tdf, cx, hi, min(hi + END_PLATE_REACH, hi_b)))
            cand = {
                "x1": x1, "x2": x2, "ends": sorted(ends), "cover": cover, "main_cover": p["cover"],
                "bottom_cap": next((c for c in inside if (c[1] + c[3]) / 2 == lo_b), None),
                "top_cap": next((c for c in inside if (c[1] + c[3]) / 2 == hi_b), None),
            }
            if best is None or cand["cover"] > best["cover"]:
                best = cand
        if best is not None:
            found.append(best)
    # 外形線の組そのものが、一番長い組の半分に満たないものは除く(たまたま外形の幅だけ
    # 離れた別の線の組が、内側にある本物の柱の線を足して長くなることがある: N3C-8)。
    # 残りは本体の長さの順(立面図の片方が取り付く梁の長丸で区切られることがある: S3C-06)
    if found:
        top_main = max(b["main_cover"] for b in found)
        found = [b for b in found if b["main_cover"] >= top_main * 0.5]
    found.sort(key=lambda b: -b["cover"])
    return found


def _numeric_values(tdf: tb.TdfData) -> list[float]:
    vals = []
    for r in tdf.texts:
        s = _norm(tdf.resolve_text(r)).replace(",", "")
        if _NUMERIC.match(s):
            vals.append(float(s))
    return vals


def _in_drawing(vals, length):
    return length is not None and any(abs(v - length) < 0.6 for v in vals)


MIN_LENGTH_RATIO = 0.8  # 長さは本体の外形線の長さの8割以上


def determine_length(tdf: tb.TdfData, body):
    """柱の長さ: 端の候補2つの差のうち、図面に寸法の文字として書かれていて、本体の
    外形線の長さの8割以上あるものの中で一番長いもの(ベースプレート等の板を含む)。
    戻り値: (長さ, 下端Y, 上端Y)。どれも書かれていなければ None。
    """
    vals = _numeric_values(tdf)
    ends = body["ends"]
    floor = body["cover"] * MIN_LENGTH_RATIO
    cands = sorted(((round(h - l, 1), l, h) for i, l in enumerate(ends) for h in ends[i + 1:]),
                   key=lambda c: -c[0])
    for c in cands:
        if c[0] >= floor and _in_drawing(vals, c[0]):
            return c
    return None


JOINT_DY = 700.0      # 端から長丸の中心までの上下の距離(外側)
JOINT_DX = 1000.0     # 柱の外形から長丸の中心までの横の距離
JOINT_INSIDE = 250.0  # 端より内側(柱の途中側)に入ってよい距離


def _joint_near(caps, x1: float, x2: float, y_end: float, direction: int) -> str | None:
    """柱の端(direction=-1 下端、+1 上端)の近くにある継手の長丸。

    長丸は柱の幅の中か、端の横に描かれる(N1C-1のCJ1は幅の中、N1P-1のPJ200W・
    N4C-1のCJ350Kは横)。外形から横1000以内で、端の外側へ700以内・内側へ250以内の
    うち一番近いもの。柱の継手の長丸は端の外側にある(上端の上に360、下端の下に
    600〜670等)か、内側でも216まで(N1P-1のPJ200Wが100、N1P-10のESPJ200が216)。
    柱の頭の近くに取り付く梁の継手(NGW60等)は端より300以上内側にある(26-14の柱・
    間柱で確認)。
    """
    best = None
    for c in caps:
        cx, cy = (c[0] + c[2]) / 2, (c[1] + c[3]) / 2
        dy = abs(cy - y_end)
        dx = max(x1 - cx, 0.0, cx - x2)
        inward = (y_end - cy) * direction  # 端より柱の途中側へ入っている距離
        if -JOINT_DY <= inward <= JOINT_INSIDE and dx <= JOINT_DX:
            d = math.hypot(dx, dy)
            if best is None or d < best[0]:
                best = (d, c[5])
    return best[1] if best else None


# ---------------------------------------------------------------------------
# 1ファイル分
# ---------------------------------------------------------------------------

def extract_column(tdf: tb.TdfData, debug: dict | None = None) -> list[dict]:
    drawing_number = ex.find_drawing_number(tdf)
    rows = find_rows(tdf)
    out = []
    for row in rows:
        if row["zushi"]:
            size, widths = drawing_box_size(tdf)
        else:
            size, widths = row["size"], _widths_from_size(row["size"])
        bodies = _bodies(tdf, widths) if widths else []
        caps = _capsules(tdf)
        length = bottom = top = None
        # 長さは外形線の一番長い立面図で求める。継手の長丸は立面図の片方にだけ
        # 描かれることがある(N1P-1のPJ200W)ので、同じ長さになる立面図から順に探す
        for b in bodies:
            got = determine_length(tdf, b)
            if got is None:
                continue
            if length is None:
                length = got[0]
            elif abs(got[0] - length) > 0.6:
                continue
            bottom = bottom or _joint_near(caps, b["x1"], b["x2"], got[1], -1)
            top = top or _joint_near(caps, b["x1"], b["x2"], got[2], +1)
        body = bodies[0] if bodies else None
        if debug is not None:
            debug[row["mark"]] = {"widths": widths, "body": body}
        out.append({
            "図番": drawing_number, "製品マーク": row["mark"], "設計符号": row["code"],
            "サイズ": size, "本数": row["count"],
            "長さ": None if length is None else length / 1000.0, "重量": None,
            "下継手": bottom if length is not None else None,
            "上継手": top if length is not None else None,
        })
    return out


def extract_file(path: str) -> list[dict]:
    """1つの.tdfファイル(柱・間柱の詳細図)を解析して製品情報のリスト(dict)を返す。"""
    return extract_column(tb.load(path))
