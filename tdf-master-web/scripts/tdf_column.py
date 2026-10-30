"""柱・間柱(製品が縦向き)の詳細図から製品情報を抽出する(柱モード)。

梁の抽出(tdf_app.py)とは別のコード。TDFの読み込み(tdf_binary.py)と、梁のコードの
次の関数は読むだけで使い、変更しない: 図番・サイズの文字・長丸と中の文字の判定
(tdf_master_extractor.py)、ボルトの記号とその範囲 BOLT_REACH(tdf_master_extractor_multi.py)。

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
import tdf_master_extractor_multi as exm

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
                         "count": _norm(tdf.resolve_text(dai))})
        elif _is_size(c):
            rows.append({"mark": a, "code": b, "size": c, "zushi": False,
                         "count": _norm(tdf.resolve_text(dai))})
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
# 区間(Yの範囲 [下, 上] の並び)の計算
# ---------------------------------------------------------------------------

def _merge(iv, gap: float = 0.5):
    """区間をつなぐ(切れ目が gap 以下ならつなぐ)。"""
    out = []
    for lo, hi in sorted(iv):
        if out and lo <= out[-1][1] + gap:
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


# ---------------------------------------------------------------------------
# 図面の線・長丸・ボルト・寸法の文字(1ファイルにつき1回だけ集める)
# ---------------------------------------------------------------------------

def _vertical_lines(tdf: tb.TdfData):
    """垂直線をX座標ごとに集め、Yの区間としてつないだもの。"""
    by_x: dict[float, list[tuple[float, float]]] = {}
    for ln in tdf.lines:
        if abs(ln.x1 - ln.x2) <= VERT_TOL and abs(ln.y1 - ln.y2) >= 20.0:
            x = round((ln.x1 + ln.x2) / 2 * 2) / 2
            by_x.setdefault(x, []).append((min(ln.y1, ln.y2), max(ln.y1, ln.y2)))
    return {x: _merge(iv) for x, iv in by_x.items()}


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


def _numeric_values(tdf: tb.TdfData) -> list[float]:
    vals = []
    for r in tdf.texts:
        s = _norm(tdf.resolve_text(r)).replace(",", "")
        if _NUMERIC.match(s):
            vals.append(float(s))
    return vals


# ---------------------------------------------------------------------------
# 柱本体(立面図の外形線)
# ---------------------------------------------------------------------------

def _outline_pairs(by_x, widths: list[float]):
    """幅が外形と同じだけ離れた垂直線の組。両方の線が重なる区間を持つ。"""
    xs = sorted(by_x)
    pairs = []
    for w in widths:
        for i, x1 in enumerate(xs):
            for x2 in xs[i + 1:]:
                if x2 - x1 > w + WIDTH_TOL:
                    break
                if abs(x2 - x1 - w) <= WIDTH_TOL:
                    segs = _intersect(by_x[x1], by_x[x2])
                    cover = sum(hi - lo for lo, hi in segs)
                    if cover >= MIN_BODY:
                        pairs.append({"x1": x1, "x2": x2, "w": w, "segs": segs, "cover": cover})
    return pairs


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


NESTED_MIN_RATIO = 0.3  # 内側の組の幅は外形の3割以上(板厚の線どうしの組を除く)
NESTED_MIN_RUN = 500.0  # 外形線の無い区間に内側の組が続く長さ
NESTED_GAP = 50.0       # 内側の組の長さを数えるときにつなぐ切れ目


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
    rest = _subtract(_merge(nested), main)
    # 取り付く梁のフランジで25程度切れて描かれる(N4C-9の上のH形)ので、50までの切れ目は
    # つないで長さを数える(足すのは元の線のある区間だけ)
    runs = [r for r in _merge(rest, NESTED_GAP) if r[1] - r[0] >= NESTED_MIN_RUN]
    return _intersect(rest, runs)


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


def _bodies(tdf: tb.TdfData, widths: list[float], by_x, caps):
    """柱本体の候補(立面図が2つあれば2つ以上)と、その上下の端の候補のY。

    - 外形線の組: 外形の幅だけ離れた垂直線の組で、内側に板厚の線か中心線があるもの。
      外形線の無い区間で内側に収まる細い組(上の方が細い角形やH形に変わる柱)も足す。
    - 幅の内側か、幅の外へ幅の半分までにある長丸(継手)で区切り、外形線が一番長く
      残る区間を本体とする(継手の先に描かれた隣の部材を除く)。柱の継手の長丸は
      幅の中(N3C-5のCJ2)か、少し横(N3C-11のCJ2は151、N3C-5のCJ5は185)に描かれる。
      柱の途中に取り付く梁の継手は外形から770以上横にあるので区切りにしない。
    - 端の候補: 区間の中の外形線の切れ目と、幅を覆う水平線(ダイアフラム・
      ベースプレート等。外形線の端から200の外側まで)、本体の外側で柱の中心を覆う水平線。
    - 順番: 外形線の組そのものが一番長い組の半分に満たないものを除き、本体の外形線の
      長い順。
    戻り値: [dict(x1, x2, ends[Y一覧], cover, main_cover, segs), ...]
    """
    found = []
    for p in _outline_pairs(by_x, widths):
        if p["w"] != widths[0] or not _has_inner_lines(by_x, p["x1"], p["x2"], p["segs"]):
            continue
        x1, x2 = p["x1"], p["x2"]
        segs = _merge([list(s) for s in p["segs"]] + _nested_segs(by_x, x1, x2, p["segs"]))
        reach = (x2 - x1) / 2 + WIDTH_TOL
        cuts = sorted((c[1] + c[3]) / 2 for c in caps if x1 - reach <= (c[0] + c[2]) / 2 <= x2 + reach)
        bounds = [-1e18] + cuts + [1e18]
        best = None
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
            cand = {"x1": x1, "x2": x2, "ends": sorted(ends), "cover": cover,
                    "main_cover": p["cover"], "segs": part}
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


def _in_drawing(vals, length):
    return any(abs(v - length) < 0.6 for v in vals)


MIN_COVER_SHARE = 0.5  # 長さの範囲に、本体の外形線の半分以上が入ること


def determine_length(body, vals):
    """柱の長さ: 端の候補2つの差のうち図面に寸法の文字(vals)として書かれているものから、
    その範囲に入る外形線が一番多いもの(同じなら長い方。ベースプレート等の板を含む)。

    範囲に入る外形線が本体の外形線の半分未満なら使わない(部材の詳細図に描かれた外形線
    の大半はその部材自身なので、半分も覆わない寸法は部分の寸法)。以前は「本体の外形線の
    長さの8割以上」としていたが、継手の先や梁の線の向こうに同じ幅の別の部分が描かれると
    外形線が長くなり、正しい長さが外れた(N2P-15のH-100の間柱 1190: 下に幅100の別の
    部分420が描かれ、外形線は1810)。
    戻り値: (長さ, 下端Y, 上端Y)。どれも無ければ None。
    """
    ends = body["ends"]
    segs = body["segs"]
    best = None
    for i, l in enumerate(ends):
        for h in ends[i + 1:]:
            length = round(h - l, 1)
            if not _in_drawing(vals, length):
                continue
            inside = sum(min(hi, h) - max(lo, l) for lo, hi in segs if min(hi, h) > max(lo, l))
            if inside < body["cover"] * MIN_COVER_SHARE:
                continue
            key = (round(inside, 1), length)
            if best is None or key > best[0]:
                best = (key, (length, l, h))
    return best[1] if best else None


# ---------------------------------------------------------------------------
# 継手
# ---------------------------------------------------------------------------

JOINT_DY = 700.0      # 端から長丸の中心までの上下の距離
JOINT_DX = 1000.0     # 柱の外形から長丸の中心までの横の距離


def _bolts_on_member(bolts, x1: float, x2: float, y_end: float, direction: int) -> bool:
    """部材の幅の中、端より内側800以内にボルトの記号があるか(800は梁の継手の条件と
    同じBOLT_REACH。ボルトの記号は短い線2本以上が中点で交わるもの)。

    ボルトで継ぐ間柱は、ボルトが間柱の上の端より内側にある(上端の40下等)。屋上の柱の
    上端の外側(53〜103上)にもボルトの記号があるが、継手のボルトではないので数えない。
    """
    return any(x1 - WIDTH_TOL <= bx <= x2 + WIDTH_TOL
               and 0.0 < (y_end - by) * direction <= exm.BOLT_REACH
               for bx, by in bolts)


def _joint_near(caps, bolts, x1: float, x2: float, y_end: float, direction: int) -> str | None:
    """柱の端(direction=-1 下端、+1 上端)の近くにある継手の長丸。

    長丸は柱の幅の中か、端の横に描かれる(N1C-1のCJ1は幅の中、N1P-1のPJ200W・
    N4C-1のCJ350Kは横)。外形から横1000以内、端から上下700以内で一番近いもの。
    - 端の外側の長丸は使う(柱の継手。上端の上に360、下端の下に600〜670等。
      現場溶接でボルトは描かれない)。
    - 端より内側の長丸は、部材の幅の中で端より内側にボルトがあるときだけ使う
      (間柱の継手 PJ200W・ESPJ200 等は端より100〜304内側にあり、ボルトが間柱の
      上にある)。柱の頭の近くに取り付く梁の継手(NGW60等、端より300〜570内側)は、
      ボルトが梁の先(柱の外)にしか無いので使わない。距離だけでは両者を分けられない
      (ESPJ200の304とNGW60の300)ため、ボルトの位置で分ける(26-14の柱・間柱で確認)。
    """
    inward_ok = _bolts_on_member(bolts, x1, x2, y_end, direction)
    best = None
    for c in caps:
        cx, cy = (c[0] + c[2]) / 2, (c[1] + c[3]) / 2
        dy = abs(cy - y_end)
        dx = max(x1 - cx, 0.0, cx - x2)
        inward = (y_end - cy) * direction  # 端より柱の途中側へ入っている距離
        if -JOINT_DY <= inward <= (JOINT_DY if inward_ok else 0.0) and dx <= JOINT_DX:
            d = math.hypot(dx, dy)
            if best is None or d < best[0]:
                best = (d, c[5])
    return best[1] if best else None


# ---------------------------------------------------------------------------
# 1ファイル分
# ---------------------------------------------------------------------------

def extract_column(tdf: tb.TdfData) -> list[dict]:
    drawing_number = ex.find_drawing_number(tdf)
    rows = find_rows(tdf)
    if not rows:
        return []
    by_x = _vertical_lines(tdf)
    caps = _capsules(tdf)
    bolts = exm._bolt_marks(tdf)
    vals = _numeric_values(tdf)
    out = []
    for row in rows:
        if row["zushi"]:
            size, widths = drawing_box_size(tdf)
        else:
            size, widths = row["size"], _widths_from_size(row["size"])
        bodies = _bodies(tdf, widths, by_x, caps) if widths else []
        length = bottom = top = None
        # 長さは外形線の一番長い立面図で求める。継手の長丸は立面図の片方にだけ
        # 描かれることがある(N1P-1のPJ200W)ので、同じ長さになる立面図から順に探す
        for b in bodies:
            got = determine_length(b, vals)
            if got is None:
                continue
            if length is None:
                length = got[0]
            elif abs(got[0] - length) > 0.6:
                continue
            bottom = bottom or _joint_near(caps, bolts, b["x1"], b["x2"], got[1], -1)
            top = top or _joint_near(caps, bolts, b["x1"], b["x2"], got[2], +1)
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
