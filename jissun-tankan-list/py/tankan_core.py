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

FNAME = re.compile(r"^([0-9A-Za-z]+)-(\d+)(A?)[　 _]")   # 2C-01　261002.tdf / 2C-01A　261002.tdf
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
                out.append((s.strip(), r.x, r.y, round(t.resolve_rot(r), 2), r.h))
        return out


def _index(files):
    """{図番の頭}, {番号: 立面のファイル名}, {番号: 断面(A付き)のファイル名}"""
    full, sec, heads = {}, {}, collections.Counter()
    for name in files:
        m = FNAME.match(name)
        if not m or not name.lower().endswith(".tdf"):
            continue
        heads[m.group(1)] += 1
        (sec if m.group(3) else full)[(m.group(1), m.group(2))] = name
    if not heads:
        raise ValueError("大組図のファイル名(例 2C-01　261002.tdf)が見つかりません")
    z = heads.most_common(1)[0][0]
    return z, {no: n for (h, no), n in full.items() if h == z}, {no: n for (h, no), n in sec.items() if h == z}


def _orders(orders_csv):
    rows = list(csv.reader(io.StringIO(orders_csv.lstrip("﻿")))) if orders_csv else []
    return (rows[0] if rows else []), rows[1:]


# 材質の印(図面の凡例): 囲み(○/◇)+中の文字(+左の「T」) → 材質。表に無い印・読めない印は None(Excelは空欄・黄色)
MATERIAL = {("○", "P", False): "BCP325", ("◇", "P", False): "BCP385",
            ("○", "B", True): "TMCP325B", ("○", "C", True): "TMCP325C",
            ("◇", "B", False): "TMCP385B", ("◇", "C", False): "TMCP385C"}


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
    return None


COMPASS = ["北", "北北東", "北東", "東北東", "東", "東南東", "南東", "南南東", "南", "南南西", "南西", "西南西", "西", "西北西", "北西", "北北西"]


def _north(t, T):
    """KEY PLAN の方位記号: 「N」の近くで、同じ点から出る2本の線(開き 15〜45°)。その真ん中の向き(度、図面の右=0・反時計回り)。
    方位記号の先端が上下どちらでも、シームは「向かい合う2方向」なので結果は同じ"""
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
                            return (aa + d / 2) % 360
    return None


def seam_of(L, f):
    """大組図の「シーム方向」の上にある柱の平面図で、塗りつぶし三角(シームの印)が柱の左右か上下かを見て、方位の名前にする。
    戻り値 例 "南南西・北北東"(南寄りを先に)。読めなければ None"""
    T = L.texts(f)
    sm = [a for a in T if a[0] == "シーム方向"]
    if not sm:
        return None
    t = L.load(f)
    x0, y0 = sm[0][1], sm[0][2]
    box = lambda x, y: -1000 < x - x0 < 1000 and -100 < y - y0 < 1200
    ls = [l for l in t.lines if box(l.x1, l.y1) and box(l.x2, l.y2)]
    key = lambda x, y: (round(x), round(y))
    start = collections.defaultdict(list)
    for l in ls:
        start[key(l.x1, l.y1)].append(l)
    tri = set()
    for a in ls:   # 3本の線で閉じた三角(辺 120〜220)
        for b in start[key(a.x2, a.y2)]:
            for c in start[key(b.x2, b.y2)]:
                if c is a or b is a or key(c.x2, c.y2) != key(a.x1, a.y1):
                    continue
                if all(120 < math.hypot(l.x2 - l.x1, l.y2 - l.y1) < 220 for l in (a, b, c)):
                    tri.add(key((a.x1 + b.x1 + c.x1) / 3, (a.y1 + b.y1 + c.y1) / 3))
    ar = [a for a in t.arcs if box(a.cx, a.cy)]
    if not tri or not ar:
        return None
    cx, cy = sum(a.cx for a in ar) / len(ar), sum(a.cy for a in ar) / len(ar)
    hz = [abs(x - cx) > abs(y - cy) for x, y in tri]
    if not (all(hz) or not any(hz)):
        return None
    n = _north(t, T)
    if n is None:
        return None
    names = []
    for a in ((0, 180) if hz[0] else (90, 270)):   # 図面の右・左 / 上・下
        bearing = (n - a) % 360                     # 北から時計回り
        names.append((bearing, COMPASS[round(bearing / 22.5) % 16]))
    names.sort(key=lambda v: not (90 < v[0] < 270))  # 南寄りを先に(提出済みExcelの書き方)
    return "・".join(v[1] for v in names)


def material_of(L, f, T, size_rec):
    """柱サイズの文字の左にある材質の印を読む。戻り値 (材質 or None, 印の説明)"""
    s, sx, sy = size_rec[0], size_rec[1], size_rec[2]
    mk = sorted([a for a in T if 1 <= len(a[0]) <= 2 and -200 < a[1] - sx < 0 and abs(a[2] - sy) < 30], key=lambda a: sx - a[1])
    if not mk:
        return None, "印なし"
    ch, mx, my, h = unicodedata.normalize("NFKC", mk[0][0]), mk[0][1], mk[0][2], mk[0][4] or 90
    shape = _mark_shape(L.load(f), mx + h * 0.12, my + h / 2)
    tee = any(unicodedata.normalize("NFKC", a[0]) == "T" and -400 < a[1] - mx < -60 and abs(a[2] - my) < 40 for a in T)
    desc = ("T" if tee else "") + (shape or "?") + ch
    return MATERIAL.get((shape, ch, tee)), desc


def extract(L, Z, full, sec, order_rows, progress=None):
    """extract2.py と同じ。戻り値 (blocks, log)"""
    res, log = [], []
    TMAP = {}   # 板厚の補い(断面図で板厚が読めない板): 注文書キャッシュの板厚
    for _r in order_rows:
        if len(_r) > 15 and "DY" in _r[12]:
            try: TMAP.setdefault(_r[12], int(float(_r[15])))
            except ValueError: pass
    for k_, no in enumerate(sorted(full)):
        f = full[no]
        if progress: progress("図面を読んでいます", k_, len(full), f)
        T = L.texts(f)
        TA = L.texts(sec[no]) if no in sec else T
        syms = sorted({s for s, x, y, r, h in T if re.fullmatch(Z + r"[A-Z0-9]+", s) and h >= 110})
        qty = [s for s, x, y, r, h in T if re.fullmatch(r"[0-9０-９]+台", s) and h >= 110]
        fl_all = [(s, x, y) for s, x, y, r, h in T if re.fullmatch(r"C\dFL", s) and h >= 110]
        if not fl_all:
            log.append(f"{Z}-{no}: 階ラベル無し"); continue
        fx = min(x for s, x, y in fl_all)
        fls = sorted([(y, s) for s, x, y in fl_all if abs(x - fx) < 500])
        lx = [round(x) for s, x, y, r, h in T if re.fullmatch(r"[A-Z]", s) and fx - 700 < x <= fx]
        if not lx:
            log.append(f"{Z}-{no}: 断面記号無し"); continue
        lx = max(set(lx), key=lx.count)
        _lt = {}
        for s, x, y, r, h in T:  # 断面記号: 柱の左の列(少し横にずれて書かれたものも拾う。同じ記号が2つあれば列に近い方)
            if re.fullmatch(r"[A-Z]", s) and lx - 600 < x < lx + 100 and (s not in _lt or abs(x - lx) < _lt[s][0]):
                _lt[s] = (abs(x - lx), y)
        letters = sorted([(v[1], k) for k, v in _lt.items()])
        secmark = {}
        secs = []
        for s_, x, y, r, h in TA:
            if s_ == "SEC":
                lab = [a for a in TA if re.fullmatch(r"[A-Z]", a[0]) and abs(a[2] - y) < 5 and 0 < x - a[1] < 400]
                if lab:
                    secs.append((lab[0][0], x, y))
        pairs_ = []
        for s_, x, y, r, h in TA:
            if not re.fullmatch(r"O?[A-Z]*DY\w*", s_):
                continue
            pl = [a for a in TA if re.fullmatch(r"PL-\d+", a[0]) and 0 < a[2] - y < 200 and abs(a[1] - x) < 300]
            t_ = int(min(pl, key=lambda a: a[2] - y)[0][3:]) if pl else None
            for Lb, sx, sy in secs:
                if 100 < y - sy < 2700 and -1700 < x - sx < 1700:
                    pairs_.append((math.hypot((x - sx) - 800, (y - sy) - 500), (round(x), round(y)), Lb, s_, t_))
        used = set()
        for d_, key, Lb, s_, t_ in sorted(pairs_):  # 近い組から順に、板マークと断面記号を1対1で結ぶ
            if key in used or Lb in secmark:
                continue
            used.add(key); secmark[Lb] = (s_, t_, d_)
        secmark = {k: v[:2] for k, v in secmark.items()}
        [TMAP.setdefault(m, t_) for m, t_ in secmark.values() if t_]
        view = [a for a in T if fx - 2000 < a[1] < fx + 12000]
        # 板マークの付いた断面記号を高さ順に並べ、間隔が1500以上空いたところで階を分ける
        ml = [(y, s_) for y, s_ in letters if s_ in secmark]
        groups = []
        for it in ml:
            if groups and it[0] - groups[-1][-1][0] < 1500: groups[-1].append(it)
            else: groups.append([it])
        for zone in groups:
            if len(zone) < 2:
                continue
            fy, fl = min(fls, key=lambda f_: abs(f_[0] - zone[-1][0]))
            allz = zone
            zone = [z for z in zone if not secmark[z[1]][0].startswith('OUDY')]  # 内ダイア(OUDY)は短管を区切らない
            if len(zone) < 2:
                continue
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
                elif cands:  # D内々が書かれていない階: 仕上がり(一番大きい数字)から板厚を引く
                    fin = max(cands); din = fin - up_t - lo_t
            size = [a for a in view if a[0].startswith("□-") and abs(a[2] - mid) < 1800] or [a for a in view if a[0].startswith("BH-") and abs(a[2] - mid) < 1800]
            size_rec = min(size, key=lambda a: abs(a[2] - mid)) if size else None
            size = size_rec[0].replace("x", "*") if size else None
            mat, mat_mark = material_of(L, f, T, size_rec) if size_rec and size.startswith("□") else (None, "")
            # BH柱: 柱のサイズ表記の列(立面の中央)にある、その階より下で一番近いBH表記を使う
            colbh = [a for a in view if re.fullmatch(r"BH-\d+x\d+x\d+x\d+", a[0]) and fx + 4500 < a[1] < fx + 7500 and a[2] < mid]
            bh = max(colbh, key=lambda a: a[2])[0].replace("x", "*") if colbh else None
            if not [a for a in view if a[0].startswith("□-") and abs(a[2] - mid) < 1800] and bh:
                size = bh
            Ln = None if din is None else (din - 10 if (size or '').startswith('□') else din)
            # 板が3枚以上の階: 仕上がりの寸法の連なり(下から)を区間に分け、区間ごとのサイズと長さを出す
            pls = [(secmark[s][0], secmark[s][1] or TMAP.get(secmark[s][0])) for y, s in zone]  # 下→上
            segs = [(size, Ln)]
            chainv = [fin]
            if len(pls) > 2:
                chain = sorted([(a[2], float(a[0])) for a in view if _num(a[0]) and abs(a[3] - 1.57) < 0.05
                                and fx - 1500 < a[1] < fx - 400 and yl - 200 < a[2] < yu + 200])
                if len(chain) == len(pls) - 1 and all(t for m_, t in pls):
                    n = len(chain)
                    def inner(i):  # 区間 i の上下の板の内々
                        return chain[i][1] - pls[i][1] - pls[i + 1][1]
                    mains = [i for i in range(n) if any(_num(a[0]) and abs(float(a[0]) - inner(i)) < 0.6 and abs(a[2] - chain[i][0]) < 40 for a in view)]
                    m = mains[0] if mains else max(0, n - 2)  # D内々の書き込みが無いときは上から2番目の区間
                    segs = []
                    for i, (cy_, v) in enumerate(chain):
                        gap = inner(i) if i == m else (v - pls[i][1] if i < m else v - pls[i + 1][1])
                        sz = [a for a in view if a[0].startswith("□-") and abs(a[2] - cy_) < 1000] or [a for a in view if a[0].startswith("BH-") and abs(a[2] - cy_) < 600]
                        sz = min(sz, key=lambda a: abs(a[2] - cy_))[0].replace("x", "*") if sz else None
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
            res.append(dict(dwg=f"{Z}-{no}", L=Ln, syms=syms, qty=qty, fl=fl, fin=fin, din=din, size=size, mat=mat, mat_mark=mat_mark,
                            chain=chainv, plates=[(secmark[s][0], secmark[s][1] or TMAP.get(secmark[s][0])) for y, s in allz][::-1], segs=segs,
                            secs=sl + su, cands=cands, mid=round(mid), up=up, up_t=up_t, lo=lo, lo_t=lo_t))
    return res, log


def _drawing(Z, full, sec, dwg):
    """図番(例 2C-01)の TDF。板の外形は A付きの断面図を優先(ローカル版の config.drawing(section=True))"""
    no = dwg.split("-")[-1]
    return sec.get(no) or full.get(no)


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
            rows.append(dict(mark=m, dwg=b["dwg"], fl=b["fl"], sym=b["syms"][0] if b["syms"] else "", t_dwg=t,
                             dim=plate.summary(r) if r else None))
    return rows


def verify(blocks, checks, header, order_rows, setsu):
    """verify.py と同じ。戻り値 (板マークごとの結果, この節の柱ダイアの手配書の行)"""
    rows = [[r[0]] + r[3:] for r in order_rows
            if len(r) > 18 and r[12] and r[9].replace(" ", "") == setsu and "ダイア" in r[10]]
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
        if not use.get(m): ng.append("図面で使っていない")
        if o and c:
            if len(o["t"]) > 1 or (t_d and t_d not in o["t"]): ng.append(f"板厚 図面{t_d}/手配{sorted(o['t'])}")
            if dim and not any(abs(dim[0] - a) <= 1 and abs(dim[1] - b) <= 1 for a, b in o["ab"]): ng.append(f"寸法 図面{dim}/手配{sorted(o['ab'])}")
            if use[m] != o["n"]: ng.append(f"枚数 図面{use[m]}/手配{o['n']}")
            if len(o["gross"]) > 1: ng.append(f"手配書のグロスが注文ごとに違う{sorted(o['gross'])}")
            elif calc is not None and abs(calc - next(iter(o["gross"]))) > TOL: ng.append(f"重量 計算{calc}/手配{next(iter(o['gross']))}")
        res[m] = dict(t_dwg=t_d, dim=dim, calc=calc, use=use.get(m, 0),
                      t_csv=sorted(o["t"]) if o else None, ab=sorted(o["ab"]) if o else None, n=o["n"] if o else 0,
                      gross=sorted(o["gross"]) if o else None, net=sorted(o["net"]) if o else None, files=o["files"] if o else [],
                      ok=not ng, ng=ng, weight=(next(iter(o["gross"])) if (o and not ng) else calc))   # ③問題なければ手配書のグロス
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


def group_floors(blocks):
    """階ごとに、値(サイズ・長さ・板・仕上がり)がまったく同じ柱を1つの表にまとめる(提出済みExcelと同じまとめ方)。
    表の並びは、最初の柱の図番の順"""
    floors = collections.OrderedDict()
    for b in sorted(blocks, key=lambda b: (b["fl"], b["dwg"])):
        key = json.dumps([b["segs"], b["plates"], b["fin"], b["size"], b.get("chain"), b.get("mat")], ensure_ascii=False)
        fl = floors.setdefault(b["fl"], collections.OrderedDict())
        g = fl.setdefault(key, dict(block=b, members=[]))
        for s in b["syms"]:
            g["members"].append(dict(sym=s, dwg=b["dwg"]))
    return {fl: list(gs.values()) for fl, gs in floors.items()}


def run(files, orders_csv, setsu=None, progress=None):
    """progress(段階, 何番目, 全体の数, 図番) … 進み具合を画面に出すため(省略可)"""
    Z, full, sec = _index(files)
    setsu = setsu or (Z[0] + "節" if Z[:1].isdigit() else "")
    header, order_rows = _orders(orders_csv)
    L = _Loader(files)
    blocks, log = extract(L, Z, full, sec, order_rows, progress)
    checks = check(L, Z, full, sec, blocks, progress)
    ver, plate_rows = verify(blocks, checks, header, order_rows, setsu)
    DIM = {}
    for r in order_rows:
        if len(r) > 17 and "DY" in r[12]:
            try: DIM.setdefault(r[12], (float(r[16]), float(r[17])))
            except ValueError: pass
    floors = group_floors([b for b in blocks if not (b.get("size") or "").startswith("BH")])
    allg = [g for gs in floors.values() for g in gs]
    for k_, g in enumerate(allg):
        if progress: progress("板の絵を作っています", k_, len(allg), g["block"]["dwg"])
        g["odd"] = odd_plates(L, Z, full, sec, g["block"], DIM) if g["block"]["segs"] else []
    seam = {}   # 図番 → シーム方向(大組図ごと)
    for g in allg:
        for mb in g["members"]:
            d = mb["dwg"]
            if d not in seam:
                no = d.split("-")[-1]
                try:
                    seam[d] = seam_of(L, full[no]) if no in full else None
                except Exception:
                    seam[d] = None
    bh = sorted({(b["fl"], s) for b in blocks if (b.get("size") or "").startswith("BH") for s in b["syms"]})
    # 材質の印を読めなかった柱(□のみ)
    mat_ng = [f"{b['fl']} {s}: 印「{b.get('mat_mark') or '?'}」" for b in sorted(blocks, key=lambda b: (b["fl"], b["dwg"]))
              if (b.get("size") or "").startswith("□") and not b.get("mat") for s in b["syms"]]
    return dict(seam=seam, mat_ng=mat_ng, zuban=Z, setsu=setsu, files=dict(full=full, sec=sec), log=log, blocks=blocks, checks=checks,
                verify=ver, plate_rows=plate_rows, floors=floors, bh=[f"{fl} {s}" for fl, s in bh],
                orders=len(order_rows))


def run_json(files_json, orders_csv, setsu="", progress=None):
    """Pyodide から呼ぶ入口(引数・戻り値とも JSON の文字)。progress は JavaScript の関数"""
    return json.dumps(run(json.loads(files_json), orders_csv, setsu or None, progress), ensure_ascii=False)
