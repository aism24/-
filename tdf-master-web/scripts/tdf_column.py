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

import bisect
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
        pos = (cells[0].x, dai.x, dai.y)  # 行の左端X・右端X・高さ(本体を行に割り当てるため)
        if _is_zushi(c):
            labels = _size_code_labels(tdf)
            if a in labels or b not in labels:
                code, mark = a, b
            else:
                code, mark = b, a
            rows.append({"mark": mark, "code": code, "size": None, "zushi": True,
                         "count": _norm(tdf.resolve_text(dai)), "pos": pos})
        elif _is_size(c):
            rows.append({"mark": a, "code": b, "size": c, "zushi": False,
                         "count": _norm(tdf.resolve_text(dai)), "pos": pos})
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


def _size_below_code(tdf: tb.TdfData, code: str) -> str | None:
    """図の中の設計符号のすぐ下(1行下)にあるサイズの文字(1種類のときだけ)。"""
    found = set()
    for r in tdf.texts:
        if r.rot != 0 or _norm(tdf.resolve_text(r)) != code:
            continue
        for q in tdf.texts:
            dy = r.y - q.y
            if q.rot == 0 and 0 < dy <= max(r.h, 1.0) * 2.0 and abs(q.x - r.x) <= r.h * 3.0:
                s = _norm(tdf.resolve_text(q))
                if _is_size(s):
                    found.add(s)
    return found.pop() if len(found) == 1 else None


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


# 継手名は英字で始まる。小文字も入る(26-12 の JCc50-3、26-16 の WB1-3C-01 の
# 上継手 zCJ700 は小文字で始まる)
_JOINT_NAME = re.compile(r"^[A-Za-z][A-Za-z0-9\-]+$")
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
    """継手の長丸: 向きが水平か垂直で、中に継手名(英字で始まる2文字以上)があるもの。

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
    return sorted(vals)  # _in_drawing は並んでいる前提で二分探索する


# ---------------------------------------------------------------------------
# 柱本体(立面図の外形線)
# ---------------------------------------------------------------------------

def _outline_pairs(by_x, widths: list[float], min_body: float = MIN_BODY):
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
                    if cover >= min_body:
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


_HLINES = {}  # 直前に読んだ図面の水平線(高さ順)。線の多い図面(17万本)で毎回全部の線を見ないため


def _hlines(tdf: tb.TdfData, lo: float, hi: float):
    """高さ lo〜hi の水平線の (Y, 左端X, 右端X)。"""
    got = _HLINES.get(id(tdf))
    if got is None or got[0] is not tdf:
        recs = sorted(((ln.y1 + ln.y2) / 2, min(ln.x1, ln.x2), max(ln.x1, ln.x2))
                      for ln in tdf.lines if abs(ln.y1 - ln.y2) <= VERT_TOL)
        got = (tdf, [r[0] for r in recs], recs)
        _HLINES.clear()
        _HLINES[id(tdf)] = got
    _tdf, ys, recs = got
    return recs[bisect.bisect_left(ys, lo):bisect.bisect_right(ys, hi)]


def _spanning_ys(tdf: tb.TdfData, x1: float, x2: float, lo: float, hi: float):
    """X1〜X2の幅を覆う水平線のY(lo〜hiの範囲)。"""
    return [y for y, a, b in _hlines(tdf, lo, hi) if a <= x1 + WIDTH_TOL and b >= x2 - WIDTH_TOL]


def _center_ys(tdf: tb.TdfData, cx: float, lo: float, hi: float):
    """柱の中心を覆う水平線のY(lo〜hiの範囲)。上の方が細い部分の端の板(N4C-9の
    上端の厚さ22の板)は外形の幅を覆わないので、本体の外側ではこれも端の候補にする。"""
    return [y for y, a, b in _hlines(tdf, lo, hi) if a <= cx - 1.0 and b >= cx + 1.0]


def _bodies(tdf: tb.TdfData, widths: list[float], by_x, caps, tf: float | None = None,
            min_body: float = MIN_BODY):
    """柱本体の候補(立面図が2つあれば2つ以上)と、その上下の端の候補のY。

    - 外形線の組: 外形の幅だけ離れた垂直線の組で、内側に板厚の線か中心線があるもの。
      外形線の無い区間で内側に収まる細い組(上の方が細い角形やH形に変わる柱)も足す。
    - 幅の内側か、幅の外へ幅の半分までにある長丸(継手)で区切り、外形線が一番長く
      残る区間を本体とする(継手の先に描かれた隣の部材を除く)。柱の継手の長丸は
      幅の中(N3C-5のCJ2)か、少し横(N3C-11のCJ2は151、N3C-5のCJ5は185)に描かれる。
      柱の途中に取り付く梁の継手は外形から770以上横にあるので区切りにしない。
    - 端の候補: 区間の中の外形線の切れ目と、幅を覆う水平線(ダイアフラム・
      ベースプレート等。外形線の端から200の外側まで)、本体の外側で柱の中心を覆う水平線。
    - 順番: 本体の外形線の長い順。外形線の組が短いものを除くのは _drop_minor(1図面に
      製品が複数あるときは、製品ごとに分けてから除く)。
    戻り値: [dict(x1, x2, ends[Y一覧], cover, main_cover, segs), ...]
    """
    found = []
    for p in _outline_pairs(by_x, widths, min_body):
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
            # 外形線の組と重ならない細い部分の線が長丸をまたぐときは、長丸の位置で
            # 切って使う(上の節の柱の線が細い部分の線と一続きに描かれ、上の継手の
            # 長丸をまたぐことがある: 26-12 の 2C-06 の □-650)。外形線の組をまたぐ
            # 線は従来どおり使わない(継手の先に描かれた隣の部材の線のため)。
            part += [(max(s[0], lo_b), min(s[1], hi_b)) for s in segs
                     if (s[0] < lo_b or s[1] > hi_b) and min(s[1], hi_b) > max(s[0], lo_b)
                     and not _intersect([list(s)], [list(m) for m in p["segs"]])]
            cover = sum(s[1] - s[0] for s in part)
            if not part or cover < min_body:
                continue
            lo, hi = min(s[0] for s in part), max(s[1] for s in part)
            ends = {y for s in part for y in s}
            ends.update(_spanning_ys(tdf, x1, x2, max(lo - END_PLATE_REACH, lo_b), min(hi + END_PLATE_REACH, hi_b)))
            cx = (x1 + x2) / 2
            ends.update(_center_ys(tdf, cx, max(lo - END_PLATE_REACH, lo_b), lo))
            ends.update(_center_ys(tdf, cx, hi, min(hi + END_PLATE_REACH, hi_b)))
            if tf is not None:
                # H形の柱は、端の面の線(左右のフランジの厚さで区切られた水平線)も端の
                # 候補にする。添え板で継ぐ柱は外形線が継手の先まで一続きに描かれ、
                # 端に切れ目ができない(26-16 の EA1-4C-01 の下端 5750)。
                y_lo, y_hi = max(lo - END_PLATE_REACH, lo_b), min(hi + END_PLATE_REACH, hi_b)
                ends.update(y for y, a, b_ in _hlines(tdf, y_lo, y_hi)
                            if abs(a - x1) <= WIDTH_TOL and abs(b_ - (x1 + tf)) <= WIDTH_TOL
                            and _is_flange_end(tdf, x1, x2, y, tf))
            # 外形線の無い区間(細い部分)の中で柱の中心を覆う水平線も端の候補にする
            # (細い部分の上端の板。2C-06 の □-650 の上端)
            main = _intersect([list(s) for s in p["segs"]], [[lo, hi]])
            for lo_n, hi_n in _subtract([[lo, hi]], main):
                ends.update(_center_ys(tdf, cx, lo_n, hi_n))
            cand = {"x1": x1, "x2": x2, "ends": sorted(ends), "cover": cover,
                    "main_cover": p["cover"], "segs": part}
            if best is None or cand["cover"] > best["cover"]:
                best = cand
        if best is not None:
            found.append(best)
    # 本体の長さの順(立面図の片方が取り付く梁の長丸で区切られることがある: S3C-06)
    found.sort(key=lambda b: -b["cover"])
    return found


def _drop_minor(bodies):
    """外形線の組そのものが、一番長い組の半分に満たないものは除く(たまたま外形の幅だけ
    離れた別の線の組が、内側にある本物の柱の線を足して長くなることがある: N3C-8)。"""
    if not bodies:
        return bodies
    top_main = max(b["main_cover"] for b in bodies)
    return [b for b in bodies if b["main_cover"] >= top_main * 0.5]


def _owner_row(body, rows):
    """1図面に製品が複数あるとき、本体を割り当てる製品の行: 本体の上端より下にある行の
    うち、本体の上端の中央から行(左端〜右端)までの横と縦の距離の和が一番小さいもの。
    製品ごとに図がまとまって描かれ、その真下に製品の行が書かれる(26-12 の 1P-09 等。
    1図面に最大5製品)。立面図の線が行より下の断面図まで続くことがある(1P-11)ので、
    下端ではなく上端で比べる。下に行が無ければ None。"""
    top = max(s[1] for s in body["segs"])
    cx = (body["x1"] + body["x2"]) / 2
    best = None
    for row in rows:
        x_lo, x_hi, y = row["pos"]
        if y >= top:
            continue
        d = max(x_lo - cx, 0.0, cx - x_hi) + (top - y)
        if best is None or d < best[0]:
            best = (d, id(row))
    return best[1] if best else None


def _in_drawing(vals, length):
    """長さが寸法の文字(vals。小さい順)に差0.6未満であるか。"""
    i = bisect.bisect_right(vals, length - 0.6)  # length-0.6 より大きい最初の値
    return i < len(vals) and vals[i] < length + 0.6


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


DIM_POINT_R = 30.0     # 寸法の点(小さな丸)の半径の上限
DIM_POINT_TOL = 1.0    # 寸法の点と端の線が一致するとみなす差
DIM_TEXT_DX = 300.0    # 寸法線から寸法の文字までの横の距離


def _dim_chains(tdf: tb.TdfData):
    """縦に並ぶ寸法の点(小さな丸)の連なり。点と点のあいだに、その間隔と同じ値の
    寸法の文字が書かれているかを添える。
    戻り値: [(点のYの一覧, [各区間に寸法の文字があるか]), ...]
    """
    by_x: dict[float, list[float]] = {}
    for a in tdf.arcs:
        if a.a1 is None and a.r < DIM_POINT_R:
            by_x.setdefault(round(a.cx * 2) / 2, []).append(a.cy)
    labels = []
    for r in tdf.texts:
        s = _norm(tdf.resolve_text(r))
        if _NUMERIC.match(s):
            labels.append((r.x, r.y, float(s)))
    chains = []
    for x, ys in by_x.items():
        ys = sorted(ys)
        pts = [ys[0]]
        for y in ys[1:]:
            if y - pts[-1] > DIM_POINT_TOL:
                pts.append(y)
        if len(pts) < 2:
            continue
        ok = []
        for a, b in zip(pts, pts[1:]):
            ok.append(any(abs(tx - x) <= DIM_TEXT_DX and a < ty < b and abs(v - (b - a)) < 0.6
                          for tx, ty, v in labels))
        chains.append((pts, ok))
    return chains


def _on_dim_chain(chains, lo: float, hi: float) -> bool:
    """下端と上端の両方に寸法の点があり、そのあいだの区間がすべて寸法の文字で
    つながっているか(全長が1つの寸法でなく、寸法の合計で書かれている図面)。"""
    for pts, ok in chains:
        i = next((k for k, y in enumerate(pts) if abs(y - lo) <= DIM_POINT_TOL), None)
        j = next((k for k, y in enumerate(pts) if abs(y - hi) <= DIM_POINT_TOL), None)
        if i is not None and j is not None and i < j and all(ok[i:j]):
            return True
    return False


def _flange_thickness(size: str | None) -> float | None:
    """H形のサイズ(H-414x405x18x28・BH-700x400x28x36)のフランジの厚さ(最後の数値)。"""
    nums = re.findall(r"\d+(?:\.\d+)?", _norm(size))
    return float(nums[3]) if len(nums) == 4 and "H" in _norm(size) else None


def _is_flange_end(tdf: tb.TdfData, x1: float, x2: float, y: float, tf: float) -> bool:
    """Yの高さに、H形の端の面の線があるか: 左右のフランジの厚さの分だけの水平線
    (x1〜x1+tf と x2-tf〜x2)。基準の線など、柱を横切る1本の長い線は端としない。"""
    left = right = False
    for _y, lo, hi in _hlines(tdf, y - DIM_POINT_TOL, y + DIM_POINT_TOL):
        left = left or (abs(lo - x1) <= WIDTH_TOL and abs(hi - (x1 + tf)) <= WIDTH_TOL)
        right = right or (abs(lo - (x2 - tf)) <= WIDTH_TOL and abs(hi - x2) <= WIDTH_TOL)
    return left and right


def determine_length_by_chain(tdf: tb.TdfData, body, chains, size: str | None):
    """determine_length で決まらないときの長さ(H形の柱だけ): 上下の端がH形の端の面の
    線(フランジの厚さで区切られた水平線)で、その両方に寸法の点があり、あいだが寸法の
    文字でつながっているもの(寸法の合計。26-12 の 2C-28 の 735+270+425=1430)。
    範囲に外形線の半分以上が入ること。外形線が寸法の引き出し線まで一続きに描かれる
    (2C-28)ので、本体の外形線の長さとは比べない。
    """
    tf = _flange_thickness(size)
    if tf is None:
        return None
    best = None
    ends = [y for y in body["ends"] if _is_flange_end(tdf, body["x1"], body["x2"], y, tf)]
    for i, l in enumerate(ends):
        for h in ends[i + 1:]:
            if not _on_dim_chain(chains, l, h):
                continue
            inside = sum(min(hi, h) - max(lo, l) for lo, hi in body["segs"] if min(hi, h) > max(lo, l))
            if inside < (h - l) * MIN_COVER_SHARE:
                continue
            key = (round(inside, 1), h - l)
            if best is None or key > best[0]:
                best = (key, (round(h - l, 1), l, h))
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
    reach = (x2 - x1) / 2 + WIDTH_TOL
    return any(x1 - reach <= bx <= x2 + reach
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
        if -JOINT_DY <= inward <= (exm.BOLT_REACH if inward_ok else 0.0) and dx <= JOINT_DX:
            d = math.hypot(dx, dy)
            if best is None or d < best[0]:
                best = (d, c[5])
    return best[1] if best else None


def _in_side_member(tdf: tb.TdfData, cap, x1: float, x2: float, bottom: float, top: float) -> bool:
    """水平の長丸が、柱の横に取り付く梁の外形線の内側にあるか: 長丸を上下からはさみ、
    どちらも柱を横切らずに柱の片側にだけある2本の水平線(長丸を覆う)で、柱に近い側の
    端がそろっているもの(梁の上下の線)がある。26-12 の 2P-03 の BJ29MX-3 は間柱の横の小梁
    Sb29M の上下の線のあいだ、26-14 の N3C-9 の NGW100B 等は柱の頭に取り付く梁の線の
    あいだにある。床の高さの線や寸法線は柱を横切るので、これには当たらない。
    2本の線がそれぞれ柱の上端・下端(bottom・top)から板の範囲(200)以内にあるときは、
    上下の梁のあいだに立つ間柱で、長丸は間柱自身の継手なので除かない(26-16 の
    EB2-1P-03 の T1。線は上端の20下と下端の85上)。"""
    ax, ay, bx, by, r = cap[:5]
    if abs(ay - by) > AXIS_TOL:
        return False
    cy = (ay + by) / 2
    lo_x, hi_x = min(ax, bx), max(ax, bx)

    left = hi_x < x1  # 長丸が柱の左にあるか

    def side(lines, join):
        # 柱を横切らず長丸と同じ側にある線。join のときは、同じ高さで途切れが長丸の
        # 半径以内の線をつなぐ(梁の線は破断記号のところで少し途切れて描かれる: 1P-23 の
        # Sb30Ng。つなぐと別の線とつながって端がそろわなくなる図面もあるので両方調べる)
        by_y: dict[float, list[list[float]]] = {}
        for y, a, b in lines:
            if (b <= x1 + WIDTH_TOL) if left else (a >= x2 - WIDTH_TOL):
                by_y.setdefault(round(y * 2) / 2, []).append([a, b])
        segs = [(y, a, b) for y, iv in by_y.items() for a, b in (_merge(iv, r) if join else iv)]
        # 長丸を両端の丸まで覆う線(近くの別の長丸の直線部分を数えないため: EB2-1P-03)
        return [(y, a, b) for y, a, b in segs
                if abs(y - cy) > r + WIDTH_TOL and a <= lo_x - r and b >= hi_x + r]

    for join in (False, True):
        above = side(_hlines(tdf, cy, cy + JOINT_DX), join)
        below = side(_hlines(tdf, cy - JOINT_DX, cy), join)
        # 柱に近い側の端がそろっていること(遠い側は寸法の補助線とつながることがある)
        if any(abs((b1 - b2) if left else (a1 - a2)) <= WIDTH_TOL
               and not (abs(top - y1) <= END_PLATE_REACH and abs(y2 - bottom) <= END_PLATE_REACH)
               for y1, a1, b1 in above for y2, a2, b2 in below):
            return True
    return False


def _joint_on_next_member(caps, by_x, x1: float, x2: float, y_end: float, direction: int) -> str | None:
    """端から700より遠い長丸のうち、端の先に描かれた隣の節の柱の外形線(端から700以内で
    始まる、同じ幅の縦線の組)の高さにあり、外形から横1000以内(_joint_near と同じ)に
    あるもの(26-12 の 2C-23 の下継手 CJ2A は下端の902下、下の節の柱の線の上。2C-28 の
    JCc50A-6 は下端の800下、続く線の横490)。一番近いもの。"""
    def near_lines(x):
        return [iv for k, ivs in by_x.items() if abs(k - x) <= WIDTH_TOL for iv in ivs]

    def on_line(x, cy):
        for lo, hi in near_lines(x):
            if lo <= cy <= hi:
                near_end = hi if direction < 0 else lo
                if (y_end - near_end) * direction <= JOINT_DY:
                    return True
        return False

    best = None
    for c in caps:
        cx, cy = (c[0] + c[2]) / 2, (c[1] + c[3]) / 2
        outward = (cy - y_end) * direction
        if outward <= JOINT_DY or max(x1 - cx, 0.0, cx - x2) > JOINT_DX:
            continue
        if on_line(x1, cy) and on_line(x2, cy) and (best is None or outward < best[0]):
            best = (outward, c[5])
    return best[1] if best else None


# ---------------------------------------------------------------------------
# 1ファイル分
# ---------------------------------------------------------------------------

def extract_column(tdf: tb.TdfData, filename: str | None = None) -> list[dict]:
    drawing_number = ex.find_drawing_number(tdf, filename)
    rows = find_rows(tdf)
    if not rows:
        return []
    by_x = _vertical_lines(tdf)
    caps = _capsules(tdf)
    bolts = exm._bolt_marks(tdf)
    vals = _numeric_values(tdf)
    chains = _dim_chains(tdf)

    found = {}  # 外形の幅ごとの本体の候補(製品ごとに分ける前)
    joint_caps = {}  # 本体ごとの継手の候補(横に取り付く梁の継手を除いた長丸)

    def jcaps(b, got):
        key = (id(b), got[1], got[2])
        if key not in joint_caps:
            joint_caps[key] = [c for c in caps if not _in_side_member(tdf, c, b["x1"], b["x2"], got[1], got[2])]
        return joint_caps[key]

    def measure(size, widths, h_in_drawing, owner):
        tf = _flange_thickness(size)
        if (tuple(widths), tf) not in found:
            got = _bodies(tdf, widths, by_x, caps, tf) if widths else []
            if widths and not got:
                # 柱本体が1つも無いときだけ、外形の幅以上・長さ1000未満の外形線の組も
                # 本体の候補にする(長さ470の間柱: 26-12 の 1P-08)
                got = _bodies(tdf, widths, by_x, caps, tf, min_body=widths[0])
            found[(tuple(widths), tf)] = got
        bodies = found[(tuple(widths), tf)]
        if owner is not None:
            # 1図面に製品が複数あるときは、その製品の行に割り当てた本体だけで求める
            bodies = [b for b in bodies if _owner_row(b, rows) == owner]
        bodies = _drop_minor(bodies)
        length = bottom = top = None
        # 長さは外形線の一番長い立面図で求める。継手の長丸は立面図の片方にだけ
        # 描かれることがある(N1P-1のPJ200W)ので、同じ長さになる立面図から順に探す
        gots = [(b, determine_length(b, vals) or determine_length_by_chain(tdf, b, chains, size)) for b in bodies]
        if h_in_drawing and tf is not None:
            # 図の中のH形の文字からサイズを取った柱は、上下の端のどちらかがH形の端の面の
            # 線のときだけ長さを使う。外形線が寸法の引き出し線や継手の先の部材まで一続きに
            # 描かれ、寸法線の位置を端としてしまうことがある(26-16 の EA1-4C-04 で 5000、
            # 正しくは 3683)ので、確かめられないものは出さない。上下の両方の端の近くに
            # 継手の長丸があるときは、継手の位置で端を確かめられるので使う(26-12 の 2C-14 の
            # 12893: 下端の657下に JCc50-3、上端の360上に JCc50-2)。
            gots = [(b, got) for b, got in gots
                    if got is not None and (_is_flange_end(tdf, b["x1"], b["x2"], got[1], tf)
                                            or _is_flange_end(tdf, b["x1"], b["x2"], got[2], tf)
                                            or (_joint_near(jcaps(b, got), bolts, b["x1"], b["x2"], got[1], -1)
                                                and _joint_near(jcaps(b, got), bolts, b["x1"], b["x2"], got[2], +1)))]
        # 立面図ごとの長さが食い違うときは、長い方の立面図から使う。片方の立面図にしか
        # 描かれていない部分(上が細いH形に変わる柱の上の部分)があると、もう片方では
        # 下の部分の長さしか取れない(26-16 の WB1-3C-01: 全長 7243、Y方向の立面図では
        # □の部分の 4599.9)。同じ長さのものは従来の順番のまま。
        gots.sort(key=lambda bg: -(bg[1][0] if bg[1] is not None else -1.0))
        for b, got in gots:
            if got is None:
                continue
            if length is None:
                length = got[0]
            elif abs(got[0] - length) > 0.6:
                continue
            bottom = bottom or _joint_near(jcaps(b, got), bolts, b["x1"], b["x2"], got[1], -1)
            top = top or _joint_near(jcaps(b, got), bolts, b["x1"], b["x2"], got[2], +1)
        for b, got in gots:
            if got is None or length is None or abs(got[0] - length) > 0.6:
                continue
            bottom = bottom or _joint_on_next_member(caps, by_x, b["x1"], b["x2"], got[1], -1)
            top = top or _joint_on_next_member(caps, by_x, b["x1"], b["x2"], got[2], +1)
        return length, bottom, top

    # 同じサイズの行は結果も同じなので1回だけ求める(1枚に78行ある図面: 26-14 の4階間柱)。
    # 製品が複数の図面は、製品ごとに描かれた図から長さを求める(長さの違う製品が並ぶ:
    # 26-12 の 1P-09 の 1278 と 4220)
    multi = len(rows) >= 2
    measured = {}
    out = []
    for row in rows:
        h_in_drawing = False
        if row["zushi"]:
            size, widths = drawing_box_size(tdf)
            if size is None:
                size = _size_below_code(tdf, row["code"])
                widths = _widths_from_size(size)
                h_in_drawing = size is not None
        else:
            size, widths = row["size"], _widths_from_size(row["size"])
        owner = id(row) if multi else None
        key = (size, tuple(widths), h_in_drawing, owner)
        if key not in measured:
            measured[key] = measure(size, widths, h_in_drawing, owner)
        length, bottom, top = measured[key]
        out.append({
            "図番": drawing_number, "製品マーク": row["mark"], "設計符号": row["code"],
            "サイズ": size, "本数": row["count"],
            "長さ": None if length is None else length / 1000.0, "重量": None,
            "下継手": bottom if length is not None else None,
            "上継手": top if length is not None else None,
        })
    return out


def extract_file(path: str, filename: str | None = None) -> list[dict]:
    """1つの.tdfファイル(柱・間柱の詳細図)を解析して製品情報のリスト(dict)を返す。

    filename は元のファイル名(ブラウザでは /input.tdf に書き込むため別に渡す)。
    省略時は path のファイル名を使う。"""
    return extract_column(tb.load(path), filename or path)
