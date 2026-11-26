# 大組図(TDF)から短管リストの中身を作る(ブラウザの Pyodide でも、PC の Python でも動く)。
# ローカルの Python 版(extract2.py・check.py・verify.py・draw_all.py の板の絵)と同じ決まり。正解Excelは使わない。
#   run(files, orders_csv, setsu=None) → dict(JSON にできる形)
#     files      {ファイル名: パス}  選んだ大組図 TDF(2C-01　….tdf と 2C-01A　….tdf)
#     orders_csv 注文書キャッシュ <工事番号>.csv の中身(先頭3列 = ファイル名・置き場所・ファイル更新日時、その後に手配書CSVの列)
#     setsu      手配書CSVの「節」列と同じ書き方(例 "2節")。省略時は図番の頭の数字から(2C → 2節)
import os, re, sys, csv, io, json, math, collections, unicodedata
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import tdf_binary as tb
import plate

FNAME = re.compile(r"^((?:[0-9A-Za-z]+-)?[0-9A-Za-z]+)-(\d+)(A?)(?:[　 _(（]|\.tdf$)", re.I)   # 2C-01　261002.tdf / 2C-01A　261002.tdf / 日付の無い 3C-01.tdf(3節)
# 頭に工区が付いた形 WA1-1C-01　260717.tdf(26-16。断面図は A付きの別ファイルでなく同じファイルの中)も読む。図番の頭は「WA1-1C」
TOL = 1.0   # 重量の許容差(kg)。手配書のグロスは整数に丸められているため


def _num(s):
    return re.fullmatch(r"\d+(\.\d+)?", s) is not None


class _Loader:
    def __init__(self, files):
        self.files, self.mem = files, {}

    def load(self, name):
        if name not in self.mem:
            self.mem[name] = tb.load(self.files[name])
        return self.mem[name]

    def texts(self, name):
        t = self.load(name)
        out = []
        for r in t.texts:
            s = t.resolve_text(r)
            if s and abs(r.x) < 1e8 and abs(r.y) < 1e8:
                # テーパーの「□-900～800x36」(26-16)は 26-12 と同じ「□-900-800x900-800x36」の書き方にそろえる
                s = re.sub(r"^□-(\d+)～(\d+)x(\d+)$", r"□-\1-\2x\1-\2x\3", s.strip())
                out.append((s.strip(), r.x, r.y, round(t.resolve_rot(r), 2), r.h))
        # 印の付いた文字(26-16 WA2 の切板符号 M900-50H 等)は、板マークの形のものだけ足す(ほかの文字は今までどおり読まない)
        for s, x, y, rot, h in getattr(t, "flagged_texts", []):
            if DIA.fullmatch(s.strip()):
                out.append((s.strip(), x, y, round(rot, 2), h))
        return out


def _index(files):
    """{図番の頭}, {番号: 立面のファイル名}, {番号: 断面(A付き)のファイル名}, 読まなかったTDF。
    頭に工区が付いて頭が複数ある(26-16 B工区の EB1-1C・EB2-1C・EB3-1C を一緒に選んだ)ときは、節(1C)が同じものを全部読み、
    番号がぶつからないよう鍵を「EB1-1C-01」の形にする(2026-11-26 ユーザー指示)。頭が1つのときは今までどおり「01」"""
    full, sec, heads, skipped = {}, {}, collections.Counter(), []
    for name in files:
        m = FNAME.match(name)
        if not m or not name.lower().endswith(".tdf"):
            if name.lower().endswith(".tdf"):
                skipped.append(name)
            continue
        heads[m.group(1)] += 1
        (sec if m.group(3) else full)[(m.group(1), m.group(2))] = name
    if not heads:
        raise ValueError("大組図のファイル名(例 2C-01　261002.tdf・3C-01.tdf)が見つかりません")
    zh = collections.Counter()
    for h, c in heads.items():
        zh[h.split("-")[-1]] += c
    z1 = zh.most_common(1)[0][0]                      # 節の頭(例 1C)
    use = sorted(h for h in heads if h.split("-")[-1] == z1)
    skipped += sorted(n for (h, no), n in list(full.items()) + list(sec.items()) if h not in use)
    if len(use) == 1:
        z = use[0]
        return z, {no: n for (h, no), n in full.items() if h == z}, {no: n for (h, no), n in sec.items() if h == z}, skipped
    return "・".join(use), {f"{h}-{no}": n for (h, no), n in full.items() if h in use}, {f"{h}-{no}": n for (h, no), n in sec.items() if h in use}, skipped


def _key(full, dwg):
    """図番(例 2C-01・EB1-1C-01)から full・sec の鍵。頭が複数のときは図番そのもの、1つのときは番号"""
    return dwg if dwg in full else dwg.split("-")[-1]


DIA = re.compile(r"O?[A-Z]*DY\w*|[A-Z]+D\d+[A-Z]?|M\d{3,4}-\d{1,3}[A-Z]?|[A-Z]*DF\d+[A-Z]?")   # ダイアの板マーク: ODY○○H(26-12)・GD5H/GD6(26-16 WA1)・M900-50H/M800-50(26-16 WA2)


def _isdia(m):
    """手配書の符号がダイアの板マークか"""
    return bool(m) and ("DY" in m or re.fullmatch(r"[A-Z]+D\d+[A-Z]?|M\d{3,4}-\d{1,3}[A-Z]?|[A-Z]*DF\d+[A-Z]?", m) is not None)   # ADF1(26-14 心斎橋)


def _dymark(s):
    """板マーク(ODY○○H・GD5H 等)。前に記号の書き損じが付いたもの(「-<ODY98H」「C<ODY108H」。3節 3C-23・3C-15)も読む"""
    if DIA.fullmatch(s):
        return s
    m = re.fullmatch(r"<([A-Z]*DF\d+[A-Z]?)>", s)   # 「<ADF1>」(26-14 心斎橋。山かっこで囲んで書く)
    if m:
        return m.group(1)
    m = re.fullmatch(r".*[^0-9A-Za-z](O[A-Z]*DY\d+[A-Z]?)", s)
    return m.group(1) if m else None


def _orders(orders_csv):
    rows = list(csv.reader(io.StringIO(orders_csv.lstrip("﻿")))) if orders_csv else []
    return (rows[0] if rows else []), rows[1:]


# 材質の印(図面の凡例): 囲み(○/◇)+中の文字(+左の「T」) → 材質。表に無い印・読めない印は None(Excelは空欄・黄色)
MATERIAL = {("○", "P", False): "BCP325", ("◇", "P", False): "BCP385",
            ("○", "B", True): "TMCP325B", ("○", "C", True): "TMCP325C",
            ("◇", "B", False): "TMCP385B", ("◇", "C", False): "TMCP385C",
            ("□", "R", False): "BCR295"}   # □R印=BCR295(26-16 の凡例)


# BH(組立H形鋼)の材質の印。大組図の凡例: ○Ｂ印=SN490B・STKN490B、○Ｃ印=SN490C(26-12 2節、ユーザー確認 2026-11-25)
BH_MATERIAL = {("○", "B", False): "SN490B", ("○", "C", False): "SN490C"}


def _mark_shape(t, cx, cy, R=90):
    """印の文字の中心 (cx, cy) を囲む形。○=円 / ◇=斜めの線4本以上 / それ以外は None"""
    circ = [a for a in t.arcs if math.hypot(a.cx - cx, a.cy - cy) < 30 and 30 < a.r < R]
    segs = [(l.x1, l.y1, l.x2, l.y2) for l in t.lines if max(math.hypot(l.x1 - cx, l.y1 - cy), math.hypot(l.x2 - cx, l.y2 - cy)) < R]
    for _, pts in t.polylines:
        if pts and max(math.hypot(x - cx, y - cy) for x, y in pts) < R:
            segs += [(a[0], a[1], b[0], b[1]) for a, b in zip(pts, pts[1:])]
    diag = [s for s in segs if abs(s[2] - s[0]) > 10 and abs(s[3] - s[1]) > 10 and 0.5 < abs((s[3] - s[1]) / (s[2] - s[0])) < 2]
    if circ and not diag:
        return "○"
    if len(diag) >= 4 and not circ:
        return "◇"
    if not circ and not diag:
        # □(四角で囲んだ印。26-16 の凡例「BCR295 □R印」)。角は中心から少し遠いので広めに見る
        sq = [(l.x1, l.y1, l.x2, l.y2) for l in t.lines if max(math.hypot(l.x1 - cx, l.y1 - cy), math.hypot(l.x2 - cx, l.y2 - cy)) < 140
              and 60 < math.hypot(l.x2 - l.x1, l.y2 - l.y1) < 200]
        hz = [s for s in sq if abs(s[3] - s[1]) < 1]; vt = [s for s in sq if abs(s[2] - s[0]) < 1]
        if len(hz) >= 2 and len(vt) >= 2 and min(s[1] for s in hz) < cy < max(s[1] for s in hz) and min(s[0] for s in vt) < cx < max(s[0] for s in vt):
            return "□"
    return None


COMPASS = ["北", "北北東", "北東", "東北東", "東", "東南東", "南東", "南南東", "南", "南南西", "南西", "西南西", "西", "西北西", "北西", "北北西"]


def north_tip(t, T):
    """方位記号の北の向き(度、図面の右=0・反時計回り)。2本の線の付け根と開いた側のうち、「N」の字に近い方を北(矢の先)とする。
    26-12 は付け根が「N」のすぐ横(先端)で、北=開いた向きの反対(約206.5°)。読めなければ None。
    「北・南・東・西」の字で囲んだ方位記号があればそれを先に使う(26-14 心斎橋 N1C-15: KEY PLAN の近くの別の「N」の字と線で逆向きに読んでいた)"""
    k = _north_kanji(t, T)
    if k is not None:
        return k
    for s, x, y, *_ in T:
        if s not in ("N", "Ｎ"):
            continue
        n = _north(t, [(s, x, y)], want_vertex=True)
        if n:
            ang, (vx, vy), (ex, ey) = n
            return ang if math.hypot(ex - x, ey - y) < math.hypot(vx - x, vy - y) else (ang + 180) % 360
    return _north_kanji(t, T)


def _north_kanji(t, T):
    """「北」「南」「東」「西」の字で囲んだ丸の方位記号(26-16): 丸の中の三角の先(丸の中心からいちばん遠い、2本の線が会う点)が北。
    先の向きが「北」の字の向きと45°以内のときだけ使う。戻り値は度(図面の右=0・反時計回り)、読めなければ None"""
    for s, x, y, *_ in T:
        if s != "北":
            continue
        circ = [a for a in t.arcs if 150 < a.r < 400 and math.hypot(a.cx - x, a.cy - y) < 900]
        if not circ:
            continue
        c = min(circ, key=lambda a: math.hypot(a.cx - x, a.cy - y))
        cx, cy, R = c.cx, c.cy, max(a.r for a in circ if math.hypot(a.cx - c.cx, a.cy - c.cy) < 2)
        ends = collections.Counter()
        for l in t.lines:
            if max(math.hypot(l.x1 - cx, l.y1 - cy), math.hypot(l.x2 - cx, l.y2 - cy)) < 2 * R:
                ends[(round(l.x1), round(l.y1))] += 1; ends[(round(l.x2), round(l.y2))] += 1
        tips = [p for p, k in ends.items() if k >= 2]
        if not tips:
            continue
        px, py = max(tips, key=lambda p: math.hypot(p[0] - cx, p[1] - cy))
        if math.hypot(px - cx, py - cy) < R * 0.8:
            continue
        ang = math.degrees(math.atan2(py - cy, px - cx)) % 360
        want = math.degrees(math.atan2(y - cy, x - cx)) % 360
        if abs((ang - want + 180) % 360 - 180) < 45:
            return ang
    return None


def _north(t, T, want_vertex=False):
    """KEY PLAN の方位記号: 「N」の近くで、同じ点から出る2本の線(開き 15〜45°)。その真ん中の向き(度、図面の右=0・反時計回り)。
    方位記号の先端が上下どちらでも、シームは「向かい合う2方向」なので結果は同じ。
    want_vertex: (向き, 付け根の点, 開いた側の2点の真ん中) を返す(北の向きを決める north_tip 用)"""
    for s, x, y, *_ in T:
        if s not in ("N", "Ｎ"):
            continue
        ls = [l for l in t.lines if math.hypot((l.x1 + l.x2) / 2 - x, (l.y1 + l.y2) / 2 - y) < 700 and 100 < math.hypot(l.x2 - l.x1, l.y2 - l.y1) < 600]
        for i, a in enumerate(ls):
            for b in ls[i + 1:]:
                for pa, qa in (((a.x1, a.y1), (a.x2, a.y2)), ((a.x2, a.y2), (a.x1, a.y1))):
                    for pb, qb in (((b.x1, b.y1), (b.x2, b.y2)), ((b.x2, b.y2), (b.x1, b.y1))):
                        if math.hypot(pa[0] - pb[0], pa[1] - pb[1]) > 2:
                            continue
                        aa = math.degrees(math.atan2(qa[1] - pa[1], qa[0] - pa[0]))
                        ab = math.degrees(math.atan2(qb[1] - pb[1], qb[0] - pb[0]))
                        d = (ab - aa + 180) % 360 - 180
                        la, lb = math.hypot(qa[0] - pa[0], qa[1] - pa[1]), math.hypot(qb[0] - pb[0], qb[1] - pb[1])
                        # 同じ長さで、先が線で閉じていない(図中の旗のような閉じた三角は別物)
                        closed = any(min(math.hypot(l.x1 - qa[0], l.y1 - qa[1]) + math.hypot(l.x2 - qb[0], l.y2 - qb[1]),
                                         math.hypot(l.x2 - qa[0], l.y2 - qa[1]) + math.hypot(l.x1 - qb[0], l.y1 - qb[1])) < 4 for l in ls)
                        if 15 < abs(d) < 45 and abs(la - lb) < 0.05 * max(la, lb) and not closed:
                            if want_vertex:
                                return (aa + d / 2) % 360, pa, ((qa[0] + qb[0]) / 2, (qa[1] + qb[1]) / 2)
                            return (aa + d / 2) % 360
    return None


def seam_of(L, f):
    """大組図の「シーム方向」の上にある柱の平面図で、塗りつぶし三角(シームの印)が柱の左右か上下かを見て、方位の名前にする。
    戻り値 例 "南南西・北北東"(シームが2つ。南寄りを先に)/ "東面"(シームが1つ=三角が片側だけ)。読めなければ None。
    「シーム方向(柱頭)」「シーム方向(柱脚)」の2つがある図面(26-16)は柱脚を使う(2026-11-26 ユーザー指示)"""
    T = L.texts(f)
    sm = [a for a in T if a[0] == "シーム方向"]
    if not sm:
        return None
    t = L.load(f)
    foot = [a for a in sm if any(unicodedata.normalize("NFKC", b[0]) == "(柱脚)" and abs(b[1] - a[1]) < 300 and -300 < b[2] - a[2] < 0 for b in T)]
    x0, y0 = (foot or sm)[0][1], (foot or sm)[0][2]
    key = lambda x, y: (round(x), round(y))

    def triangles(box):   # 3本の線で閉じた三角(辺 80〜220)の重心。線の向きはそろっていなくてもよい(26-16 は辺100の白抜きの三角)
        ls = [l for l in t.lines if box(l.x1, l.y1) and box(l.x2, l.y2)]
        edges = {frozenset((key(l.x1, l.y1), key(l.x2, l.y2))) for l in ls if 80 < math.hypot(l.x2 - l.x1, l.y2 - l.y1) < 220}
        nb = collections.defaultdict(set)
        for e in edges:
            if len(e) == 2:
                p, q = tuple(e); nb[p].add(q); nb[q].add(p)
        out = set()
        for p in nb:
            for q in nb[p]:
                for r in nb[q] & nb[p]:
                    out.add(key((p[0] + q[0] + r[0]) / 3, (p[1] + q[1] + r[1]) / 3))
        return out
    box = lambda x, y: -1000 < x - x0 < 1000 and -100 < y - y0 < 1200
    tri = triangles(box)
    ar = [a for a in t.arcs if box(a.cx, a.cy)]
    if not tri or not ar:
        # 柱の平面図が「シーム方向」の下にあり、シームの印がひし形(26-14 心斎橋)。ひし形の側の「○面」
        return _seam_rhombus(t, T, x0, y0)
    cx, cy = sum(a.cx for a in ar) / len(ar), sum(a.cy for a in ar) / len(ar)
    hz = [abs(x - cx) > abs(y - cy) for x, y in tri]
    if not (all(hz) or not any(hz)):
        return None
    n = _north_kanji(t, T)   # 「北」の字の丸い方位記号(26-16・26-14)。あれば先に使う
    if n is None:
        n = _north(t, T)
    if n is None:
        return None
    # シームの数: 三角が柱の両側にあれば2つ。片側しか見つからないときは、少し広い範囲で、同じ軸の上の柱をはさんだ反対側の三角を探す
    # (26-12 2C-02・26-16 EB の柱脚は上の三角が狭い範囲の外にあった。狭い範囲の円弧から出す中心はずれるので使わない)。
    # それでも無ければシームは1つで「○○面」(26-16 WA1・WA2 の柱脚。2026-11-26 ユーザー指示)
    side = lambda x, y: (0 if x > cx else 180) if hz[0] else (90 if y > cy else 270)
    sides = {side(x, y) for x, y in tri}
    if len(sides) == 1:
        wide = triangles(lambda x, y: -1100 < x - x0 < 1100 and -100 < y - y0 < 1800)
        x1, y1 = next(iter(tri))
        if hz[0]:
            other = [p for p in wide if abs(p[1] - y1) < 60 and 600 < abs(p[0] - x1) < 1500 and (p[0] - cx) * (x1 - cx) < 0]
        else:
            other = [p for p in wide if abs(p[0] - x1) < 60 and 600 < abs(p[1] - y1) < 1500 and (p[1] - cy) * (y1 - cy) < 0]
        if not other:
            bearing = (n - next(iter(sides))) % 360
            return COMPASS[round(bearing / 22.5) % 16] + "面"
    names = []
    for a in ((0, 180) if hz[0] else (90, 270)):   # 図面の右・左 / 上・下
        bearing = (n - a) % 360                     # 北から時計回り
        names.append((bearing, COMPASS[round(bearing / 22.5) % 16]))
    names.sort(key=lambda v: not (90 < v[0] < 270))  # 南寄りを先に(提出済みExcelの書き方)
    return "・".join(v[1] for v in names)


def _seam_rhombus(t, T, x0, y0):
    """「シーム方向」の上か下の柱の平面図で、斜めの短い線4本で閉じたひし形(シームの印)が柱のどちら側かを「○面」で返す(26-14 心斎橋)。
    ひし形が2つ以上・読めなければ None"""
    box = lambda x, y: -1200 < x - x0 < 1000 and -1600 < y - y0 < 1300   # 平面図は「シーム方向」の下(N1C-1)のことも上(□-450 の N1C-5)のこともある
    key = lambda x, y: (round(x), round(y))
    ls = [l for l in t.lines if box(l.x1, l.y1) and box(l.x2, l.y2) and 40 < math.hypot(l.x2 - l.x1, l.y2 - l.y1) < 220
          and abs(l.x2 - l.x1) > 10 and abs(l.y2 - l.y1) > 10]
    nb = collections.defaultdict(set)
    for l in ls:
        p, q = key(l.x1, l.y1), key(l.x2, l.y2); nb[p].add(q); nb[q].add(p)
    cents = set()
    for p in nb:   # p-q-r-s-p の4本で閉じた形
        for q in nb[p]:
            for r in nb[q] - {p}:
                for s_ in (nb[r] & nb[p]) - {q}:
                    cents.add(key((p[0] + q[0] + r[0] + s_[0]) / 4, (p[1] + q[1] + r[1] + s_[1]) / 4))
    ar = [a for a in t.arcs if box(a.cx, a.cy) and a.r < 200]
    if len(cents) != 1 or not ar:
        return None
    cx, cy = sum(a.cx for a in ar) / len(ar), sum(a.cy for a in ar) / len(ar)
    x, y = next(iter(cents))
    side = (0 if x > cx else 180) if abs(x - cx) > abs(y - cy) else (90 if y > cy else 270)
    n = _north_kanji(t, T)
    if n is None:
        n = _north(t, T)
    if n is None:
        return None
    return COMPASS[round(((n - side) % 360) / 22.5) % 16] + "面"


def material_of(L, f, T, size_rec, table=None):
    """柱サイズの文字の左にある材質の印を読む。戻り値 (材質 or None, 印の説明)。table はBH用の表(省略時は角形の表)"""
    table = table or MATERIAL
    s, sx, sy = size_rec[0], size_rec[1], size_rec[2]
    mk = sorted([a for a in T if 1 <= len(a[0]) <= 2 and -200 < a[1] - sx < 0 and abs(a[2] - sy) < 30], key=lambda a: sx - a[1])
    if not mk:
        return None, "印なし"
    ch, mx, my, h = unicodedata.normalize("NFKC", mk[0][0]), mk[0][1], mk[0][2], mk[0][4] or 90
    shape = _mark_shape(L.load(f), mx + h * 0.12, my + h / 2)
    tee = any(unicodedata.normalize("NFKC", a[0]) == "T" and -400 < a[1] - mx < -60 and abs(a[2] - my) < 40 for a in T)
    desc = ("T" if tee else "") + (shape or "?") + ch
    return table.get((shape, ch, tee)), desc


def _chain_col(T, fx, lx=None, letters=None):
    """柱の左の仕上がり寸法の連なり(縦書きの数字が一番多い列)。(文字の高さ=区間の真ん中, 寸法) の下→上。
    階ラベルの左に数字が無い図面(26-16: 階ラベル「2FL」が連なりより左)は、断面記号の列から右で、
    隣り合う断面記号(板マークのあるもの)の高さの差に近い数字がいちばん多い列を使う"""
    num = [a for a in T if _num(a[0]) and abs(a[3] - 1.57) < 0.05 and fx - 1500 < a[1] < fx - 400]
    if letters:   # 断面記号(板マークのあるもの)の高さの範囲の数字だけ(26-14 心斎橋: 左上の注記の「7」を拾わない)
        _ly = [y for y, s in letters]
        num = [a for a in num if min(_ly) - 2000 < a[2] < max(_ly) + 2000]
    if not num and lx is not None and letters and len(letters) > 1:
        ys = sorted(y for y, s in letters)
        gaps = [(a, b, b - a) for a, b in zip(ys, ys[1:])]
        # 断面記号の列が階ラベルより右(26-14 心斎橋)なら、連なりは階ラベルと断面記号の列の間(右にある梁の端の寸法 800・210 を拾わない)
        cand = [a for a in T if _num(a[0]) and abs(a[3] - 1.57) < 0.05 and (fx < a[1] < lx if lx > fx else lx < a[1] < fx + 3000)]
        score = collections.Counter()
        for a in cand:
            v = float(a[0])
            if any(lo - 200 < a[2] < hi + 200 and abs(v - g) < 0.1 * g + 50 for lo, hi, g in gaps):
                score[round((a[1] - fx) / 30)] += 1
        if score:
            best = max(score, key=lambda k: (score[k], -k)) * 30
            num = [a for a in cand if abs(a[1] - fx - best) < 30]
    if not num:
        return []
    xs = collections.Counter(round(a[1] - fx) for a in num)
    cx = max(xs, key=lambda k: xs[k])
    return sorted((a[2], float(a[0])) for a in num if abs(a[1] - fx - cx) < 30)


def _beam_zones(t, T, fx):
    """梁の範囲(下面, 上面)。梁 = 立面図の「H-」「BH-」「SH-」等のサイズ表記。表記のすぐ上の横線を下面、せい(最初の数字)を足して上面。
    BH柱の図面では、柱そのもののBH表記(いちばん多いBH表記)は除く"""
    hl = [l for l in t.lines if abs(l.y1 - l.y2) < 1 and abs(l.x2 - l.x1) > 150]
    bh = collections.Counter(s for s, x, y, r, h in T if re.fullmatch(r"BH-\d+x\d+x\d+x\d+", s))
    colsz = {bh.most_common(1)[0][0]} if bh and not any(s.startswith("□-") for s, *_ in T) else set()
    zones = []
    for s, x, y, r, h in T:
        m = re.match(r"[A-Z]*H-(\d+)(?:-\d+)?x", s)
        if not m or not (fx - 500 < x < fx + 16000) or h > 100 or s in colsz:
            continue
        above = [l.y1 for l in hl if 0 < l.y1 - y < 400 and min(l.x1, l.x2) - 50 <= x <= max(l.x1, l.x2) + 50]
        if above:
            yb = min(above)
            zones.append((yb, yb + int(m.group(1))))
    return zones


def _has_plate(t, T, fx, lo, hi):
    """区間の中に材質の○印付きのプレート(○PL-22 等)の取り付けがあるか(1C-01 1階: D断面のダイアに PL-22。ユーザー説明 2026-11-25)"""
    for s, x, y, r, h in T:
        if re.fullmatch(r"PL-\d+", s) and fx - 500 < x < fx + 16000 and lo + 30 < y < hi - 30:
            if any(-200 < c.cx - x < 0 and -40 < c.cy - y - (h or 90) / 2 < 40 and 25 < c.r < 80 for c in t.arcs):
                return True
    return False


def _gap_chain(T, chain_all, zone, fx, lx):
    """隣り合うダイアの間ごとの仕上がり寸法 [(高さ, 寸法)](下→上)。連なりの列の数字がダイアの間に1つずつ無いとき(26-14 心斎橋 N1C-15:
    連なりの列は 1006 とまとめて書き、806・200 は隣の列)に使う。ダイアの間ごとに、まず連なりの列、無ければ階ラベルと断面記号の列の間の
    縦書きの数字から、記号の間隔に近いものを選ぶ。どこか1つでも見つからなければ None"""
    lo_x, hi_x = (fx, lx) if lx > fx else (lx, fx + 3000)
    other = [(a[2], float(a[0]), a[1]) for a in T if _num(a[0]) and abs(a[3] - 1.57) < 0.05 and lo_x < a[1] < hi_x]
    out = []
    for (y0, _a), (y1, _b) in zip(zone, zone[1:]):
        g = y1 - y0
        c = [(cy, v) for cy, v in chain_all if y0 - 40 < cy < y1 + 40 and abs(v - g) < 0.1 * g + 50]
        if not c:
            c = [(cy, v) for cy, v, x in sorted(other, key=lambda o: abs(o[2] - fx)) if y0 - 40 < cy < y1 + 40 and abs(v - g) < 0.1 * g + 50]
        if not c:
            return None
        out.append(min(c, key=lambda c_: abs(c_[1] - g)))
    return out


def _beam_depths(T, fx, lo, hi):
    """区間(lo〜hi)の近くに表記のある梁のせい(H-340・HY-1000 等)"""
    return [int(m.group(1)) for s, x, y, r, h in T for m in [re.match(r"[A-Z]*HY?-(\d+)(?:-\d+)?x", s)]
            if m and fx - 500 < x < fx + 16000 and h <= 100 and lo - 1000 < y < hi + 1000]


def _split_parts(nz, chain_all, bz, t, T, fx, TOL=60, lx=None):
    """1つの階のダイア(下→上、内ダイアを除く)を短管ごとに分ける。区間(隣り合うダイアの間)に梁がかかる、または○PLの取り付けがあれば
    取り合いあり。取り合いの無い区間(長管)で分ける。短管は必ず上下のダイアがセット(区間1つ以上)。
    寸法の連なりと区間の数が合わないとき・取り合いが1つも無いときは、分けずにそのまま(従来どおり)"""
    if len(nz) < 3:
        return [nz]
    yl, yu = nz[0][0], nz[-1][0]
    # 区間の寸法(文字は区間の真ん中): いちばん下と上のダイアの間にあるものだけ(柱の端の区間を拾わない。1節 1C-01 2階)
    ch = [(i, c) for i, c in enumerate(chain_all) if yl - 80 < c[0] < yu + 30]
    if not ch:
        return [nz]
    if len(ch) == len(nz) - 1:
        idx = list(range(len(nz)))          # ダイア k = 区間の境目 k
    else:
        # 数が合わない(記号の無いダイアがある 1C-23 等): 区間の境目(寸法の連なりから)に、高さの近いダイアを当てる
        bnds = [ch[0][1][0] - ch[0][1][1] / 2] + [cy + v / 2 for _, (cy, v) in ch]
        idx = []
        for y, _s in nz:
            k = min(range(len(bnds)), key=lambda j: abs(bnds[j] - y))
            if abs(bnds[k] - y) > 300 or (idx and k <= idx[-1]):
                idx = None
                break
            idx.append(k)
        if idx is None:   # ダイアの間ごとの寸法を取り直す(26-14 心斎橋 N1C-15)
            gc = _gap_chain(T, chain_all, nz, fx, lx) if lx is not None else None
            if not gc:
                return [nz]
            ch, idx = list(enumerate(gc)), list(range(len(nz)))
    cov = []
    for i, (cy, v) in ch:
        lo, hi = cy - v / 2, cy + v / 2
        ok = any(z0 - TOL <= lo and hi <= z1 + TOL for z0, z1 in bz) or \
            all(any(z0 - TOL <= p <= z1 + TOL for z0, z1 in bz) for p in [lo + (hi - lo) * k / 10 for k in range(1, 10)])
        if not ok and 0 < i < len(chain_all) - 1 and v < 1500:   # 柱の上下の端(次の節との継手)の区間は除く
            ok = _has_plate(t, T, fx, lo, hi)
        cov.append(ok)
    # 梁のせい+6 にちょうど合う区間(続けて並ぶ区間の合計も)は取り合いあり(26-14 心斎橋: 梁の表記が梁の下に離れて書かれ、梁の範囲が取れない。
    #   346=H-340+6、1006=HY-1000+6(806+200)、806=HY-800+6)。断面記号の列が階ラベルより右の図面(26-14 の書き方)だけ
    #   (26-12 1節 1C-10 2階の長管 594 が別の梁 588+6 と同じ値になり、短管にしてしまうため)
    for a_ in (range(len(ch)) if lx is not None and lx > fx else []):
        for b_ in range(a_, len(ch)):
            lo = ch[a_][1][0] - ch[a_][1][1] / 2
            tot = sum(c[1] for _, c in ch[a_:b_ + 1]); hi = lo + tot
            if any(abs(tot - d - 6) <= 1 for d in _beam_depths(T, fx, lo, hi)):
                for k in range(a_, b_ + 1):
                    cov[k] = True
    runs, cur = [], []
    for k, c in enumerate(cov):
        if c:
            cur.append(k)
        elif cur:
            runs.append(cur); cur = []
    if cur:
        runs.append(cur)
    parts = []
    for r in runs:   # 区間 r[0]〜r[-1] = 境目 r[0]〜r[-1]+1。両端にダイア(板マーク)のあるものだけ短管
        if r[0] in idx and r[-1] + 1 in idx:
            parts.append([z for z, k in zip(nz, idx) if r[0] <= k <= r[-1] + 1])
    if not parts:
        return [nz]
    # どの短管にも入らなかったダイア(柱の上端など)は、いちばん近い短管に足す(図面のダイアは全部どれかの短管に入る。
    # ユーザー指示 2026-11-25: 1C-01・1C-25 の上端のL断面、1C-25 1階のD断面。提出済みExcelはここが漏れている)
    pos = {id(z): i for i, z in enumerate(nz)}
    while True:
        inn = {id(z) for p in parts for z in p}
        lone = [z for z in nz if id(z) not in inn]
        if not lone:
            break
        z = lone[0]
        p = min(parts, key=lambda p: min(abs(z[0] - p[0][0]), abs(z[0] - p[-1][0])))
        a, b = min(pos[id(p[0])], pos[id(z)]), max(pos[id(p[-1])], pos[id(z)])
        parts[parts.index(p)] = nz[a:b + 1]
    return parts


def extract(L, Z, full, sec, order_rows, progress=None):
    """extract2.py と同じ。戻り値 (blocks, log)"""
    res, log = [], []
    TMAP = {}   # 板厚の補い(断面図で板厚が読めない板): 注文書キャッシュの板厚
    PDIM = {}   # 板の短い辺(注文書キャッシュの縦横)。テーパーの柱を見分けるのに使う
    for _r in order_rows:
        if len(_r) > 15 and _isdia(_r[12]):
            try: TMAP.setdefault(_r[12], int(float(_r[15])))
            except ValueError: pass
        if len(_r) > 17 and _isdia(_r[12]):
            try: PDIM.setdefault(_r[12], min(float(_r[16]), float(_r[17])))
            except ValueError: pass
    for k_, key in enumerate(sorted(full)):
        f = full[key]
        no = key.split("-")[-1]
        head = key.rsplit("-", 1)[0] if "-" in key else Z   # 頭が複数のとき鍵は「EB1-1C-01」
        dwg = f"{head}-{no}"
        if progress: progress("図面を読んでいます", k_, len(full), f)
        T = L.texts(f)
        TA = L.texts(sec[key]) if key in sec else T
        ZH = head.split("-")[-1]   # 柱符号の頭(「WA1-1C」の図面でも「1C」)
        syms = sorted({s for s, x, y, r, h in T if re.fullmatch(ZH + r"(?:-[A-Z])?[A-Z0-9]+", s) and h >= 110})
        if not syms and re.match(r"[A-Z]+\d+C$", ZH):   # 図番の頭「N1C」・柱符号「1CN1NA」(26-14 心斎橋 N棟)
            syms = sorted({s for s, x, y, r, h in T if re.fullmatch(ZH.lstrip("ABCDEFGHIJKLMNOPQRSTUVWXYZ") + r"[A-Z0-9]+[上下]?", s) and h >= 110})   # 「1CN5ND上」(1節の中で分けた柱)
        if any("-" in s for s in syms):   # 「1C-X17Y5」の形(製品名)があれば、横の「1C2」(符号)は使わない(26-16)
            syms = [s for s in syms if "-" in s]
        qty = [s for s, x, y, r, h in T if re.fullmatch(r"[0-9０-９]+台", s) and h >= 110]
        fl_all = [(s, x, y) for s, x, y, r, h in T if re.fullmatch(r"C\dFL", s) and h >= 110]
        if not fl_all:   # 「2FL」「1FL」の形(26-16。文字の高さ105)
            fl_all = [(s, x, y) for s, x, y, r, h in T if re.fullmatch(r"\d+FL", s) and h >= 100]
        if not fl_all:   # 文字の高さ90(26-14 心斎橋)。いちばん左の列だけ使う(断面図の中の「2FL」を使わない)
            fl_all = [(s, x, y) for s, x, y, r, h in T if re.fullmatch(r"\d+FL", s) and h >= 85]
        if not fl_all:
            log.append(f"{dwg}: 階ラベル無し"); continue
        fx = min(x for s, x, y in fl_all)
        fls = sorted([(y, s) for s, x, y in fl_all if abs(x - fx) < 500])
        _fy0, _fy1 = min(y for y, s in fls) - 2500, max(y for y, s in fls) + 2500   # 表題欄の文字(26-14 心斎橋の「H」「B」)を断面記号にしない
        lx = [round(x) for s, x, y, r, h in T if re.fullmatch(r"[A-Z]", s) and fx - 700 < x <= fx and _fy0 < y < _fy1]
        if not lx:   # 断面記号の列が階ラベルより右(26-14 心斎橋: 階ラベルの右 約1900)。断面図の「○ SEC」にある記号だけ
            _sp = [(b[1], b[2]) for b in TA if b[0] == "SEC"]
            _sl = {a[0] for a in TA if re.fullmatch(r"[A-Z]", a[0]) and any(abs(a[2] - sy) < 5 and 0 < sx - a[1] < 400 for sx, sy in _sp)}
            lx = [round(x) for s, x, y, r, h in T if re.fullmatch(r"[A-Z]", s) and s in _sl and fx < x < fx + 2500 and abs(r) < 0.05 and _fy0 < y < _fy1]
        if not lx:
            log.append(f"{dwg}: 断面記号無し"); continue
        lx = max(set(lx), key=lx.count)
        _lt = {}
        for s, x, y, r, h in T:  # 断面記号: 柱の左の列(少し横にずれて書かれたものも拾う。同じ記号が2つあれば列に近い方)
            if re.fullmatch(r"[A-Z][0-9]?", s) and lx - 600 < x < lx + 500 and (s not in _lt or abs(x - lx) < _lt[s][0]):   # 右に寄せて書かれた記号も(1C-26 H)。「E1」「K1」の形も(1節 1C-23)
                _lt[s] = (abs(x - lx), y)
        letters = sorted([(v[1], k) for k, v in _lt.items()])
        secmark = {}
        secs = []
        for s_, x, y, r, h in TA:
            if s_ == "SEC":
                lab = [a for a in TA if re.fullmatch(r"[A-Z][0-9]?", a[0]) and abs(a[2] - y) < 5 and 0 < x - a[1] < 400]   # 「E1」「K1」の形も(1節 1C-23)
                if lab:
                    secs.append((lab[0][0], x, y))
        pairs_ = []
        for s_, x, y, r, h in TA:
            s_ = _dymark(s_)
            if not s_:
                continue
            pl = [a for a in TA if re.fullmatch(r"PL-\d+", a[0]) and 0 < a[2] - y < 200 and abs(a[1] - x) < 300]
            t_ = int(min(pl, key=lambda a: a[2] - y)[0][3:]) if pl else None
            for Lb, sx, sy in secs:
                # 板マークは断面記号より上(26-16 EB2-1C-01 断面B は 77 上に書かれている。以前の下限 100 では結べず、ダイアが1枚抜けた)
                if 0 < y - sy < 2700 and -1700 < x - sx < 1700:
                    pairs_.append((math.hypot((x - sx) - 800, (y - sy) - 500), (round(x), round(y)), Lb, s_, t_))
        used = set()
        for d_, key, Lb, s_, t_ in sorted(pairs_):  # 近い組から順に、板マークと断面記号を1対1で結ぶ
            if key in used or Lb in secmark:
                continue
            used.add(key); secmark[Lb] = (s_, t_, d_, key)
        # 結べなかった断面記号: 隣が先に取った板マークを、その隣が別の余った板マークに付け替えられるなら付け替える(3節 3C-02 F・G)
        edges = collections.defaultdict(list)
        for d_, key, Lb, s_, t_ in sorted(pairs_):
            edges[Lb].append((d_, key, s_, t_))
        owner = {v[3]: k for k, v in secmark.items()}
        def _aug(Lb, seen):
            for d_, key, s_, t_ in edges[Lb]:
                if key in seen:
                    continue
                seen.add(key)
                if key not in owner or _aug(owner[key], seen):
                    owner[key] = Lb; secmark[Lb] = (s_, t_, d_, key)
                    return True
            return False
        if len(used) < len({p[1] for p in pairs_}):   # 余った板マークがあるときだけ
            for Lb in sorted({p[2] for p in pairs_} - set(secmark)):
                _aug(Lb, set())
        used = set(owner)
        # 2回目: まだ結べていない板マークと断面記号だけ、上下に離れた所(2700〜3600)まで探す(大きい断面図。1節 1C-26 ODY34H・1C-15 ODY11H)
        pairs2 = []
        for s_, x, y, r, h in TA:
            s_ = _dymark(s_)
            if not s_ or (round(x), round(y)) in used:
                continue
            pl = [a for a in TA if re.fullmatch(r"PL-\d+", a[0]) and 0 < a[2] - y < 200 and abs(a[1] - x) < 300]
            t_ = int(min(pl, key=lambda a: a[2] - y)[0][3:]) if pl else None
            for Lb, sx, sy in secs:
                if Lb not in secmark and 2700 <= y - sy < 3600 and -1700 < x - sx < 1700:
                    pairs2.append((math.hypot((x - sx) - 800, (y - sy) - 500), (round(x), round(y)), Lb, s_, t_))
        for d_, key, Lb, s_, t_ in sorted(pairs2):
            if key in used or Lb in secmark:
                continue
            used.add(key); secmark[Lb] = (s_, t_, d_, key)
        secmark = {k: v[:2] for k, v in secmark.items()}
        if not secmark and secs and not any(_dymark(a[0]) for a in TA):
            # 断面図はあるのに板マークが1つも書かれていない図面(26-16 WA2-1C-03 261124版)。読み込み後の案内で知らせる(2026-11-26 ユーザー指示)
            log.append(f"{dwg}: 板マークが無い")
            continue
        [TMAP.setdefault(m, t_) for m, t_ in secmark.values() if t_]
        view = [a for a in T if fx - 2000 < a[1] < fx + 12000]
        # 板マークの付いた断面記号を高さ順に並べ、間隔が1500以上空いたところで階を分ける
        ml = [(y, s_) for y, s_ in letters if s_ in secmark]
        groups = []
        for it in ml:
            if groups and it[0] - groups[-1][-1][0] < 1500: groups[-1].append(it)
            else: groups.append([it])
        # 階のダイアの組を、取り合い(梁・○PL)のある区間だけの短管に分ける(取り合いの無い区間=長管をはさめば「-上」「-下」)
        bz, chain_all = _beam_zones(L.load(f), T, fx), _chain_col(T, fx, lx, [z for z in letters if z[1] in secmark])
        work = []
        for zone0 in groups:
            nz = [z for z in zone0 if not secmark[z[1]][0].startswith('OUDY')]  # 内ダイア(OUDY)は短管を区切らない
            if len(nz) < 2:
                continue
            parts = _split_parts(nz, chain_all, bz, L.load(f), T, fx, lx=lx)
            # 3つ以上に分かれた階(26-14 心斎橋 N1C-15: 2FL の上の小梁・2FL・下の小梁): 柱符号に「-上」等を付けず、
            #   階の基準(FL)にいちばん近い短管を「2F」、それより上を「2F上」、下を「2F下」に分ける(2026-11-26 ユーザー指示)
            flx = {}
            if len(parts) >= 3:
                fy0, fl0 = min(fls, key=lambda f_: abs(f_[0] - zone0[-1][0]))
                dist = [0 if p[0][0] - 1 <= fy0 <= p[-1][0] + 1 else min(abs(fy0 - p[0][0]), abs(fy0 - p[-1][0])) for p in parts]
                mi = dist.index(min(dist))
                base = fl0[:-1] if fl0.endswith("FL") else fl0
                flx = {pi: (fl0 if pi == mi else base + ("上" if pi > mi else "下")) for pi in range(len(parts))}
            for pi, part in enumerate(parts):
                suf = "" if len(parts) == 1 or flx else ("上" if pi == len(parts) - 1 else ("下" if pi == 0 else "中"))
                work.append((part, [z for z in zone0 if part[0][0] - 1 <= z[0] <= part[-1][0] + 1], suf, flx.get(pi)))
        for zone, allz, suf, flo in work:
            fy, fl = min(fls, key=lambda f_: abs(f_[0] - zone[-1][0]))
            fl = flo or fl
            (yl, sl), (yu, su) = zone[0], zone[-1]
            lo, lo_t = secmark[sl]; up, up_t = secmark[su]
            lo_t = lo_t or TMAP.get(lo); up_t = up_t or TMAP.get(up)
            mid = (yl + yu) / 2
            cands = sorted({float(a[0]) for a in view if _num(a[0]) and abs(a[3] - 1.57) < 0.05 and abs(a[2] - mid) < 300})
            fin = din = None
            if up_t and lo_t:
                pairs = [(a, b) for a in cands for b in cands if abs(a - b - up_t - lo_t) < 0.6]
                if pairs:
                    fin, din = max(pairs)
                elif cands:  # D内々が書かれていない階: 仕上がりの連なりの列の数字(無ければ梁のせい+6、それも無ければ一番大きい数字)から板厚を引く
                    one = [c for c in chain_all if yl < c[0] < yu]   # 柱の全長(11093)を仕上がりにしない(3節 3C-10 等の7階)
                    # 梁のせい+6 にちょうど合う数字(26-14 心斎橋 N1C-12: 連なりが取れず、梁の横の 1420 を拾っていた。正しくは 1006=梁1000+6)
                    bfit = [c for c in cands if any(abs(c - d - 6) <= 1 for d in _beam_depths(T, fx, yl - 1500, yu + 1500))] if lx > fx else []   # 26-14 の書き方の図面だけ
                    fin = one[0][1] if len(one) == 1 else (max(bfit) if bfit else max(cands)); din = fin - up_t - lo_t
            if suf and len(zone) == 2 and up_t and lo_t:   # 上下に分けた短管(板2枚): 仕上がりはその区間の寸法(1節 1C-13 下=594)
                one = [c for c in chain_all if yl - 200 < c[0] < yu + 200]
                if len(one) == 1:
                    fin = one[0][1]; din = fin - up_t - lo_t
            size = [a for a in view if a[0].startswith("□-") and abs(a[2] - mid) < 1800] or [a for a in view if a[0].startswith("BH-") and abs(a[2] - mid) < 1800]
            size_rec = min(size, key=lambda a: abs(a[2] - mid)) if size else None
            size = size_rec[0].replace("x", "*") if size else None
            # 上下の板の大きさが違い、その差に合うテーパーの表記(□-1000～900 なら差100)が近くにあれば、テーパーの柱(2026-11-26 ユーザー指摘、26-16 EB1-1C-03 等)。
            #   いちばん近い表記は上の板より上にある次の節の□-900 のことがあり、板が 1060角(□-1000 用)なのに□-900 の直線の柱にしていた
            if size and re.fullmatch(r"□-\d+\*\d+\*[\d.]+", size) and PDIM.get(lo) and PDIM.get(up) and PDIM[lo] - PDIM[up] > 1:
                tps = [a for a in view if abs(a[2] - mid) < 1800 and re.fullmatch(r"□-(\d+)-(\d+)x\d+-\d+x[\d.]+", a[0])
                       and abs(int(a[0][2:].split("-")[0]) - int(a[0][2:].split("-")[1].split("x")[0]) - (PDIM[lo] - PDIM[up])) < 1]
                if tps:
                    size_rec = min(tps, key=lambda a: abs(a[2] - mid))
                    size = size_rec[0].replace("x", "*")
            mat, mat_mark = material_of(L, f, T, size_rec) if size_rec and size.startswith("□") else (None, "")
            # BH柱: 柱のサイズ表記の列(立面の中央)にある、その階より下で一番近いBH表記を使う
            colbh = [a for a in view if re.fullmatch(r"BH-\d+x\d+x\d+x\d+", a[0]) and fx + 4500 < a[1] < fx + 7500 and a[2] < mid]
            bh = max(colbh, key=lambda a: a[2])[0].replace("x", "*") if colbh else None
            if not [a for a in view if a[0].startswith("□-") and abs(a[2] - mid) < 1800] and bh:
                size = bh
                rec = max(colbh, key=lambda a: a[2])
                mat, mat_mark = material_of(L, f, T, rec, BH_MATERIAL)   # BHも左の印(○Ｂ=SN490B)
            if (size or "").startswith("BH-") and not mat:
                # BH柱で印が読めないとき(選んだ表記に印が無い・1階はBHをサイズ探しで見つけた): 柱と同じサイズの表記のうち、
                # 印のあるものを高さの近い順に見る(梁のBH表記は使わない。1節 1C-14・1C-24)
                for a in sorted([a for a in T if a[0].replace("x", "*") == size], key=lambda a: abs(a[2] - mid)):
                    m2 = material_of(L, f, T, a, BH_MATERIAL)
                    if m2[0]:
                        mat, mat_mark = m2
                        break
            Ln = None if din is None else (din - 10 if (size or '').startswith('□') else din)
            # 板が3枚以上の階: 仕上がりの寸法の連なり(下から)を区間に分け、区間ごとのサイズと長さを出す
            pls = [(secmark[s][0], secmark[s][1] or TMAP.get(secmark[s][0])) for y, s in zone]  # 下→上
            segs = [(size, Ln)]
            chainv = [fin]
            if len(pls) > 2:
                # 仕上がりの連なりの列(数字のいちばん多い列)だけを使う(隣の列の「200」等を拾わない。1節 1階)
                chain = [c for c in chain_all if yl - 200 < c[0] < yu + 200]
                if len(chain) != len(pls) - 1:   # 上のダイアの外の区間まで拾ったとき(1節 1C-24・1C-25 2階)は、ダイアの間だけで取り直す
                    chain = [c for c in chain_all if yl - 80 < c[0] < yu]   # 区間の真ん中は必ず上のダイアの記号より下(1C-25 K)
                if len(chain) != len(pls) - 1:   # ダイアの間ごとの数字を隣の列からも探す(26-14 心斎橋 N1C-15 の 806・200)
                    chain = _gap_chain(T, chain_all, zone, fx, lx) or chain
                if len(chain) == len(pls) - 1 and all(t for m_, t in pls):
                    n = len(chain)
                    def inner(i):  # 区間 i の上下の板の内々
                        return chain[i][1] - pls[i][1] - pls[i + 1][1]
                    mains = [i for i in range(n) if any(_num(a[0]) and abs(float(a[0]) - inner(i)) < 0.6 and abs(a[2] - chain[i][0]) < 40 for a in view)]
                    # D内々の書き込みが無いとき: 区間2つなら長い方(梁の取り合い。差が1割以内なら上。1節 1階・1C-01 2階・2節 BH柱の正解)、
                    # 3つ以上は上から2番目の区間
                    if not mains and n == 2:   # 区間2つ: 梁のせい+6 にちょうど合う区間(その梁の取り合い)が主区間(1節 1C-02 1階 356=H-350+6 等)
                        fit = [i for i in range(n) if any(abs(chain[i][1] - (z1 - z0) - 6) <= 1 and abs(z0 - (chain[i][0] - chain[i][1] / 2)) < 300 for z0, z1 in bz)]
                        if len(fit) == 1:
                            mains = fit
                    m = mains[0] if mains else ((1 if chain[1][1] >= chain[0][1] * 0.9 else 0) if n == 2 else max(0, n - 2))
                    segs = []
                    for i, (cy_, v) in enumerate(chain):
                        gap = inner(i) if i == m else (v - pls[i][1] if i < m else v - pls[i + 1][1])
                        # 柱のサイズ表記の列(階のサイズ表記と同じ横位置)のものだけ(別の部材の□表記を拾わない。1節 1C-03 2階)
                        sz = [a for a in view if a[0].startswith("□-") and abs(a[2] - cy_) < 1000 and (size_rec is None or abs(a[1] - size_rec[1]) < 1000)] or \
                            ([] if (size or "").startswith("□") else [a for a in view if a[0].startswith("BH-") and abs(a[2] - cy_) < 600])
                        # 角形の柱で区間の近くにサイズが無ければ階のサイズ(梁のBH表記を柱のサイズにしない。1節 1C-21)
                        sz = min(sz, key=lambda a: abs(a[2] - cy_))[0].replace("x", "*") if sz else size
                        segs.append((sz, gap - 10 if (sz or "").startswith("□") else gap))
                    # テーパーのある階: D内々の区間がテーパー、下は大きい側・上は小さい側の角形
                    tp = [sz for sz, l_ in segs if sz and re.fullmatch(r"□-\d+-\d+\*\d+-\d+\*\d+", sz)]
                    tp = tp or [a[0].replace("x", "*") for a in view if re.fullmatch(r"□-\d+-\d+x\d+-\d+x\d+", a[0]) and yl - 300 < a[2] < yu + 1000]
                    if tp:
                        A, B, t_ = re.fullmatch(r"□-(\d+)-(\d+)\*\d+-\d+\*(\d+)", tp[0]).groups()
                        segs = [(tp[0] if i == m else (f"□-{A}*{A}*{t_}" if i < m else f"□-{B}*{B}*{t_}"),
                                 (inner(i) if i == m else (chain[i][1] - pls[i][1] if i < m else chain[i][1] - pls[i + 1][1])) - 10)
                                for i in range(n)]
                    if not (size or "").startswith("□") and bh:
                        segs = [(bh, l_ if (s_ or "").startswith("□") is False else l_ + 10) for s_, l_ in segs]
                    chainv = [v for y_, v in chain]
                    fin = sum(v for y_, v in chain)
                else:
                    segs = None
            res.append(dict(dwg=dwg, L=Ln, syms=[s + "-" + suf for s in syms] if suf else syms, qty=qty, fl=fl, fin=fin, din=din, size=size, mat=mat, mat_mark=mat_mark,
                            chain=chainv, plates=[(secmark[s][0], secmark[s][1] or TMAP.get(secmark[s][0])) for y, s in allz][::-1], segs=segs,
                            secs=sl + su, plate_secs=[s for y, s in allz][::-1], cands=cands, mid=round(mid), up=up, up_t=up_t, lo=lo, lo_t=lo_t))
    return res, log


def _drawing(Z, full, sec, dwg):
    """図番(例 2C-01)の TDF。板の外形は A付きの断面図を優先(ローカル版の config.drawing(section=True))"""
    k = _key(full, dwg)
    return sec.get(k) or full.get(k)


def check(L, Z, full, sec, blocks, progress=None):
    """check.py と同じ(正解Excelとの照合は除く): 板ごとに断面図で外形を測る"""
    rows, seen = [], set()
    for k_, b in enumerate(blocks):
        if progress: progress("板の外形を測っています", k_, len(blocks), b["dwg"])
        if (b.get("size") or "").startswith("BH"):
            continue
        for m, t in b["plates"]:
            if (m, b["dwg"]) in seen: continue
            seen.add((m, b["dwg"]))
            r = plate.measure(L.load(_drawing(Z, full, sec, b["dwg"])), m, 650)
            dim = plate.summary(r) if r else None
            # 柱の外寸以下に測れたもの(柱の線をたどった。26-14 心斎橋の形の違う板 ADF4 等が 700)は測れなかったものとする
            cols = [int(x) for s_ in [b.get("size") or ""] + [g[0] or "" for g in (b.get("segs") or [])] for m2 in re.findall(r"□-(\d+)(?:-(\d+))?", s_) for x in m2 if x]   # テーパー「□-1000-900」は両方
            if dim and cols and not m.startswith("OUDY") and min(dim) <= min(cols) + 1:   # 内ダイアは柱より小さいので除く。テーパーは細い側と比べる
                dim = None
            rows.append(dict(mark=m, dwg=b["dwg"], fl=b["fl"], sym=b["syms"][0] if b["syms"] else "", t_dwg=t, dim=dim))
    return rows


def verify(blocks, checks, header, order_rows, setsu):
    """verify.py と同じ。戻り値 (板マークごとの結果, この節の柱ダイアの手配書の行)"""
    rows = [[r[0]] + r[3:] for r in order_rows
            if len(r) > 18 and r[12] and re.sub(r"【.*?】", "", r[9].replace(" ", "")) == setsu and ("ダイア" in r[10] or "DPL" in r[10].upper())]
    # 節の「1節【夢前】」は「1節」、工種「柱_通しDPL」もダイア(26-16)
    order = collections.defaultdict(lambda: dict(n=0, t=set(), ab=set(), gross=set(), net=set(), files=[]))
    for r in rows:
        try:
            m, o = r[10], order[r[10]]
            o["n"] += int(float(r[16])); o["t"].add(float(r[13])); o["ab"].add(tuple(sorted([float(r[14]), float(r[15])])))
            o["gross"].add(float(r[20])); o["net"].add(float(r[18])); o["files"].append(f"{r[0][:9]}×{r[16]}")
        except (ValueError, IndexError):
            pass
    use = collections.Counter()
    for b in blocks:
        q = sum(int(unicodedata.normalize("NFKC", s)[:-1]) for s in b["qty"]) if b["qty"] else 1
        for m, t in b["plates"]:
            use[m] += q
    meas = {}
    for c in checks:
        meas.setdefault(c["mark"], c)
    res = {}
    for m in sorted(set(use) | set(order)):
        c, o = meas.get(m), order.get(m)
        t_d = c and c["t_dwg"]; dim = c and c["dim"]
        calc = round(t_d * dim[0] * dim[1] * 7.85e-6, 1) if (t_d and dim) else None   # ①図面から計算(外接長方形=グロス)
        ng = []
        if not o: ng.append("手配書に無い")
        # 手配書にあるが図面で使っていない板は問題にしない(大組図が未完成・別フォルダの図面・中止の板がありうる。ユーザー指示 2026-11-25)。
        # 図面にあるのに手配が無い・枚数が違うものは問題として出す
        unused = bool(o) and not use.get(m)
        if o and c and not unused:
            if len(o["t"]) > 1 or (t_d and t_d not in o["t"]): ng.append(f"板厚 図面{t_d}/手配{sorted(o['t'])}")
            if dim and not any(abs(dim[0] - a) <= 1 and abs(dim[1] - b) <= 1 for a, b in o["ab"]): ng.append(f"寸法 図面{dim}/手配{sorted(o['ab'])}")
            # 手配の方が多い=ほかの図面の分(問題なし)。足りないときだけ問題(ユーザー指示 2026-11-26: 26-16 は WA1・WB2工区をまとめて手配)
            if use[m] > o["n"]: ng.append(f"枚数が足りない 図面{use[m]}/手配{o['n']}")
            if len(o["gross"]) > 1: ng.append(f"手配書のグロスが注文ごとに違う{sorted(o['gross'])}")
            elif calc is not None and abs(calc - next(iter(o["gross"]))) > TOL: ng.append(f"重量 計算{calc}/手配{next(iter(o['gross']))}")
        res[m] = dict(t_dwg=t_d, dim=dim, calc=calc, use=use.get(m, 0),
                      t_csv=sorted(o["t"]) if o else None, ab=sorted(o["ab"]) if o else None, n=o["n"] if o else 0,
                      gross=sorted(o["gross"]) if o else None, net=sorted(o["net"]) if o else None, files=o["files"] if o else [],
                      ok=not ng, ng=ng, unused=unused, extra=(o["n"] - use[m]) if (o and use.get(m) and o["n"] > use[m]) else 0, weight=(next(iter(o["gross"])) if (o and not ng) else calc))   # ③問題なければ手配書のグロス
    return res, dict(header=["ファイル名"] + header[3:], rows=rows)


def _side(size, below):  # 板に接する角形の外寸
    m = re.fullmatch(r"□-(\d+)-(\d+)\*.*", size or "")
    if m: return int(m.group(1) if below else m.group(2))
    m = re.fullmatch(r"□-(\d+)\*.*", size or "")
    return int(m.group(1)) if m else None


def odd_plates(L, Z, full, sec, b, DIM):
    """draw_all.py の「PL形状注意」と同じ: 正方形でない板(手配書の縦≠横)と、その線画(SVG)。下→上の順"""
    plates, segs = b["plates"][::-1], b["segs"]
    odd = []
    for k, (m, t) in enumerate(plates):
        if m in DIM and DIM[m][0] != DIM[m][1] and m not in [o["mark"] for o in odd]:
            seg = segs[min(k, len(segs) - 1)] if k < len(segs) else segs[-1]
            col = _side(seg[0], k < len(segs))
            svg = None
            if col:
                r = plate.measure(L.load(_drawing(Z, full, sec, b["dwg"])), m, col)
                if r:
                    plate.write_svg(r, None); svg = r["svg"]
            odd.append(dict(mark=m, col=col, svg=svg))
    return odd


def bh_dia(b, DIM):
    """BH柱の板: 手配書の板の外形とBHの寸法から出寸法(フランジの先・フランジの外面)を出し、「ダイア出寸法注意」の絵(SVG)を作る。下→上の順"""
    m = re.fullmatch(r"BH-(\d+)\*(\d+)\*(\d+)\*(\d+)", b.get("size") or "")
    if not m:
        return []
    H, B, tw, tf = (int(v) for v in m.groups())
    out = []
    for mk, t in b["plates"][::-1]:
        if mk in DIM and mk not in [o["mark"] for o in out]:
            w, l = sorted(DIM[mk])
            ox, oy = (w - B) / 2, (l - H) / 2
            out.append(dict(mark=mk, ox=ox, oy=oy, svg=_bh_svg(w, l, H, B, tw, tf, ox, oy)))
    return out


def _bh_svg(w, l, H, B, tw, tf, ox, oy):
    """板(横 w・縦 l)の中にBH(フランジ幅 B が横、せい H が縦)。上に横の出寸法、左に縦の出寸法(提出済みExcelの絵と同じ向き)"""
    M = 300
    vx0, vx1, vy0, vy1 = -w / 2 - M, w / 2 + 80, -l / 2 - 80, l / 2 + M
    W, Hh = vx1 - vx0, vy1 - vy0
    P = lambda x, y: (x - vx0, vy1 - y)
    fmt = lambda v: f"{v:.1f}".rstrip("0").rstrip(".")
    o = [f'<svg xmlns="http://www.w3.org/2000/svg" width="{W/10:.1f}mm" height="{Hh/10:.1f}mm" viewBox="0 0 {W:.1f} {Hh:.1f}">',
         f'<rect x="0" y="0" width="{W:.1f}" height="{Hh:.1f}" fill="white"/>',
         '<g stroke="black" stroke-width="6" fill="none">']
    def rect(x0, y0, x1, y1):
        (a, b), (c, d) = P(x0, y1), P(x1, y0)
        o.append(f'<rect x="{a:.1f}" y="{b:.1f}" width="{c-a:.1f}" height="{d-b:.1f}"/>')
    def line(x0, y0, x1, y1, sw=6):
        (a, b), (c, d) = P(x0, y0), P(x1, y1)
        o.append(f'<line x1="{a:.1f}" y1="{b:.1f}" x2="{c:.1f}" y2="{d:.1f}" stroke-width="{sw}"/>')
    rect(-w / 2, -l / 2, w / 2, l / 2)                       # 板
    rect(-B / 2, H / 2 - tf, B / 2, H / 2)                   # 上のフランジ
    rect(-B / 2, -H / 2, B / 2, -H / 2 + tf)                 # 下のフランジ
    rect(-tw / 2, -H / 2 + tf, tw / 2, H / 2 - tf)           # ウェブ
    line(-B / 2, -H / 2, B / 2, H / 2, 3); line(-B / 2, H / 2, B / 2, -H / 2, 3)   # 柱の印(×)
    line(-w / 2 + 40, 0, w / 2 - 40, 0, 3)                   # 中心線
    o.append('</g>')
    fs = 120
    def dim(x0, y0, x1, y1, txt, vert):
        (a, b), (c, d) = P(x0, y0), P(x1, y1)
        s = f'<line x1="{a:.1f}" y1="{b:.1f}" x2="{c:.1f}" y2="{d:.1f}" stroke="black" stroke-width="3"/>'
        for e, f in ((a, b), (c, d)):
            s += (f'<line x1="{e-25:.1f}" y1="{f:.1f}" x2="{e+25:.1f}" y2="{f:.1f}" stroke="black" stroke-width="3"/>' if vert else
                  f'<line x1="{e:.1f}" y1="{f-25:.1f}" x2="{e:.1f}" y2="{f+25:.1f}" stroke="black" stroke-width="3"/>')
        if vert:
            s += f'<text transform="translate({a-20:.1f},{(b+d)/2:.1f}) rotate(-90)" font-size="{fs}" font-family="MS Gothic" text-anchor="middle">{txt}</text>'
        else:
            s += f'<text x="{(a+c)/2:.1f}" y="{b-18:.1f}" font-size="{fs}" font-family="MS Gothic" text-anchor="middle">{txt}</text>'
        o.append(s)
    yd = l / 2 + 90
    dim(-w / 2, yd, -B / 2, yd, fmt(ox), False)
    dim(B / 2, yd, w / 2, yd, fmt(ox), False)
    xd = -w / 2 - 90
    dim(xd, H / 2, xd, l / 2, fmt(oy), True)
    dim(xd, -l / 2, xd, -H / 2, fmt(oy), True)
    ox_, oy_ = P(-w / 2 - 150, -l / 2 - 20)
    L = 220
    o.append(f'<g stroke="black" stroke-width="4" fill="none"><polyline points="{ox_:.1f},{oy_-L:.1f} {ox_:.1f},{oy_:.1f} {ox_+L:.1f},{oy_:.1f}"/>'
             f'<polyline points="{ox_-18:.1f},{oy_-L+35:.1f} {ox_:.1f},{oy_-L:.1f} {ox_+18:.1f},{oy_-L+35:.1f}"/>'
             f'<polyline points="{ox_+L-35:.1f},{oy_-18:.1f} {ox_+L:.1f},{oy_:.1f} {ox_+L-35:.1f},{oy_+18:.1f}"/></g>')
    o.append(f'<text x="{ox_-60:.1f}" y="{oy_-L+60:.1f}" font-size="{fs}" font-family="MS Gothic">X</text>')
    o.append(f'<text x="{ox_+L+10:.1f}" y="{oy_+25:.1f}" font-size="{fs}" font-family="MS Gothic">Y</text>')
    o.append('</svg>')
    return "\n".join(o)


def group_floors(blocks):
    """階ごとに、値(サイズ・長さ・板・仕上がり)がまったく同じ柱を1つの表にまとめる(提出済みExcelと同じまとめ方)。
    表の並びは、最初の柱の図番の順"""
    floors = collections.OrderedDict()
    for b in sorted(blocks, key=lambda b: (b["fl"], b["dwg"])):
        # 寸法の連なり(chain)は比べない: 長さ・板が同じなら同じ表(1節 1C-18・1C-21 は連なりの書き方だけ違う。正解は1つの表)
        key = json.dumps([b["segs"], b["plates"], b["fin"], b["size"], b.get("mat")], ensure_ascii=False)
        fl = floors.setdefault(b["fl"], collections.OrderedDict())
        g = fl.setdefault(key, dict(block=b, members=[]))
        for s in b["syms"]:
            g["members"].append(dict(sym=s, dwg=b["dwg"]))
    return {fl: list(gs.values()) for fl, gs in floors.items()}


def koji_of(T):
    """図面の表題欄の工事名(Excel の工事名をアプリの工事名と選べるようにする。2026-11-26 ユーザー指示)。読めなければ None
    ① 「…工事」で終わる大きな文字(26-12「合同会社桜島開発（仮称）OSAKA SAKURAJIMA RESORT新築工事」)
    ② 1文字ずつ書いた見出し「工」「事」の右下の大きな文字(26-16 阪和の表題欄「ITMO1 DC1-1」)"""
    c = [s for s, x, y, r, h in T if h >= 100 and len(s) >= 6 and s.endswith("工事") and "工事名" not in s]
    if c:
        return max(c, key=len)
    for s0, kx, ky, r0, h0 in T:
        if s0 != "工" or not any(s == "事" and 0 < x - kx < 200 and abs(y - ky) < 5 for s, x, y, r, h in T):
            continue
        v = [(s, x, y, h) for s, x, y, r, h in T if h >= 120 and len(s) >= 3 and 0 < x - kx < 3000 and -600 < y - ky < 0]
        if v:
            return min(v, key=lambda a: (-a[3], ky - a[2]))[0]
    return None


def _grid(T):
    """立面図の見出しの通り芯(大きい文字の CY○・CX○ が3つ並んだ真ん中 = この柱の通り)。読めなければ None"""
    out = {}
    for p in ("CY", "CX"):
        g = sorted((x, s) for s, x, y, r, h in T if re.fullmatch(p + r"\d+", s) and h >= 110)
        out[p] = g[1][1][2:] if len(g) == 3 else None
    return out


def cautions(L, full, blocks, ver):
    """読み込み後の案内に出す注意(図面の書き間違いの可能性)。戻り値 [(見出し, 本文)]"""
    out = []
    # 柱符号: 同じ符号が別の図面にある(3節 3C-08 と 3C-11 が両方 3CY4CX2)。通り芯と合わない図面は書き間違いの候補
    where = collections.defaultdict(set)
    for b in blocks:
        for s in b["syms"]:
            where[re.sub(r"-[上下中]$", "", s)].add(b["dwg"])   # 「-上」「-下」だけ外す(「1C-X17Y5」の形の符号は そのまま。26-16)
    for sym, dwgs in sorted(where.items()):
        if len(dwgs) < 2:
            continue
        lines = [f"柱符号 {sym} が {len(dwgs)} 枚の図面({'・'.join(sorted(dwgs))})に書かれています。同じ柱が2本あるのか、どれかの図面の符号の書き間違いかを確認してください。"]
        m = re.search(r"Y(\d+)C?X(\d+)", sym)
        for d in sorted(dwgs):
            no = _key(full, d)
            g = _grid(L.texts(full[no])) if no in full else {}
            if m and g.get("CY") and g.get("CX") and (g["CY"], g["CX"]) != m.groups():
                fix = sym[:m.start(1)] + g["CY"] + sym[m.end(1):m.start(2)] + g["CX"] + sym[m.end(2):]
                lines.append(f"  {d}: 見出しの通り芯は CY{g['CY']}・CX{g['CX']} です。符号は {fix} の書き間違いかもしれません。")
        lines.append("  (Excel は図面に書かれた符号のまま作っています。同じ表に「2台」とまとまっていることがあります)")
        out.append(("図面間違いの可能性(柱符号)", "\n".join(lines)))
    # 切板マーク: 手配書で同じ板(板厚・縦横)の2つのマークが、図面では片方が多く・片方が同じ枚数だけ少ない(3節 ODY99H と ODY45H)
    cnt = {m: v for m, v in ver.items() if v.get("n") and v.get("use") and v["use"] != v["n"] and v.get("t_csv") and v.get("ab")}
    for a, va in sorted(cnt.items()):
        for b_, vb in sorted(cnt.items()):
            d = va["use"] - va["n"]
            if a == b_ or d <= 0 or vb["n"] - vb["use"] != d or va["t_csv"] != vb["t_csv"] or va["ab"] != vb["ab"]:
                continue
            t_, (x_, y_) = va["t_csv"][0], va["ab"][0]
            lines = [f"{a}(図面 {va['use']}枚/手配 {va['n']}枚)と {b_}(図面 {vb['use']}枚/手配 {vb['n']}枚)は、手配書では同じ板(PL-{t_:g} {x_:g}×{y_:g})です。",
                     f"図面の {a} のうち {d} 枚は、{b_} の書き間違いかもしれません。A付きの断面図の板マークを確認してください。",
                     f"  {a} を使っている所:"]
            for bl in sorted(blocks, key=lambda x: (x["dwg"], x["fl"])):
                secs = bl.get("plate_secs") or [""] * len(bl["plates"])
                hit = [sc for (m_, t__), sc in zip(bl["plates"], secs) if m_ == a]
                if hit:
                    mix = any(m_ == b_ for m_, t__ in bl["plates"])
                    lines.append(f"    {bl['dwg']} {bl['fl']} {'・'.join(bl['syms'])} 断面 {'・'.join(hit)}" + (f"  ← 同じ柱に {b_} もあり。特に確認を" if mix else ""))
            lines.append("  (重量は手配書で同じ板なので変わりません)")
            out.append(("切板マーク記入間違いの可能性", "\n".join(lines)))
    return out


def run(files, orders_csv, setsu=None, progress=None):
    """progress(段階, 何番目, 全体の数, 図番) … 進み具合を画面に出すため(省略可)"""
    Z, full, sec, skipped = _index(files)
    zh = Z.split("-")[-1]   # 「WA1-1C」→「1C」
    _ms = re.search(r"(\d+)C$", zh)   # 「1C」→1節、「N1C」(26-14 心斎橋 N棟)→1節
    setsu = setsu or (_ms.group(1) + "節" if _ms else "")
    header, order_rows = _orders(orders_csv)
    L = _Loader(files)
    blocks, log = extract(L, Z, full, sec, order_rows, progress)
    checks = check(L, Z, full, sec, blocks, progress)
    ver, plate_rows = verify(blocks, checks, header, order_rows, setsu)
    DIM = {}
    for r in order_rows:
        if len(r) > 17 and _isdia(r[12]):
            try: DIM.setdefault(r[12], (float(r[16]), float(r[17])))
            except ValueError: pass
    floors = group_floors(blocks)
    allg = [g for gs in floors.values() for g in gs]
    for k_, g in enumerate(allg):
        if progress: progress("板の絵を作っています", k_, len(allg), g["block"]["dwg"])
        isbh = (g["block"].get("size") or "").startswith("BH")
        g["odd"] = odd_plates(L, Z, full, sec, g["block"], DIM) if g["block"]["segs"] and not isbh else []
        g["bhdia"] = bh_dia(g["block"], DIM) if isbh else []
    seam, ndir = {}, {}   # 図番 → シーム方向・北の向き(大組図ごと)
    for g in allg:
        for mb in g["members"]:
            d = mb["dwg"]
            if d not in seam:
                no = _key(full, d)
                try:
                    seam[d] = seam_of(L, full[no]) if no in full else None
                except Exception:
                    seam[d] = None
                try:
                    ndir[d] = north_tip(L.load(full[no]), L.texts(full[no])) if no in full else None
                except Exception:
                    ndir[d] = None
    # 階ごとの北の向き(Excel の O1:O2 の方位記号。2026-11-26 ユーザー指示)。その階の大組図でいちばん多い向き
    north = {}
    for fl, gs in floors.items():
        c = collections.Counter(round(ndir[m["dwg"]], 1) for g in gs for m in g["members"] if ndir.get(m["dwg"]) is not None)
        north[fl] = c.most_common(1)[0][0] if c else None
    bh = sorted({(b["fl"], s) for b in blocks if (b.get("size") or "").startswith("BH") for s in b["syms"]})
    # 材質の印を読めなかった柱(□のみ)
    mat_ng = [f"{b['fl']} {s}: 印「{b.get('mat_mark') or '?'}」" for b in sorted(blocks, key=lambda b: (b["fl"], b["dwg"]))
              if (b.get("size") or "").startswith(("□", "BH")) and not b.get("mat") for s in b["syms"]]
    try:
        caution = cautions(L, full, blocks, ver)
    except Exception as e:   # 注意の作成に失敗しても、表とExcelは出す
        caution = [("注意の確認ができませんでした", str(e))]
    nomark = [s.split(":")[0] for s in log if s.endswith(": 板マークが無い")]
    if nomark:   # 板マークが書かれていない図面は短管を作れない(2026-11-26 ユーザー指示: その旨を記載する)
        caution.insert(0, ("板マークが書かれていない図面", "\n".join(
            [f"{d}: 断面図に板マーク(切板の符号)が見つかりません。この図面の短管は Excel に入っていません。" for d in nomark] +
            ["  (ダイアフラムの無い部材(柱脚だけの柱など)なら問題ありません。板マークの書き漏れなら、記入してから読み込み直してください)"])))
    if skipped:   # 選んだのに読まなかったTDF(別の節の図面・大組図のファイル名の形でないもの)。黙って外さない(2026-11-26 ユーザー指示)
        caution.insert(0, ("読まなかったファイル", "\n".join(
            [f"次の {len(skipped)} 個のTDFは、図番の頭が {Z} と違う(別の節)か、大組図のファイル名の形でないため読んでいません。"] +
            [f"  {n}" for n in skipped])))
    kc = collections.Counter()   # 図面の表題欄の工事名(図面でいちばん多いもの)
    for f in full.values():
        try:
            k = koji_of(L.texts(f))
        except Exception:
            k = None
        if k:
            kc[k] += 1
    koji_dwg = kc.most_common(1)[0][0] if kc else None
    return dict(koji_dwg=koji_dwg, seam=seam, north=north, mat_ng=mat_ng, cautions=caution, zuban=Z, setsu=setsu, files=dict(full=full, sec=sec), log=log, blocks=blocks, checks=checks,
                verify=ver, plate_rows=plate_rows, floors=floors, bh=[f"{fl} {s}" for fl, s in bh],
                orders=len(order_rows))


def run_json(files_json, orders_csv, setsu="", progress=None):
    """Pyodide から呼ぶ入口(引数・戻り値とも JSON の文字)。progress は JavaScript の関数"""
    return json.dumps(run(json.loads(files_json), orders_csv, setsu or None, progress), ensure_ascii=False)
