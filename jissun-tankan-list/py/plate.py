# (jissun-tankan-list: ローカルの Python 版 plate.py と同じ。write_svg が SVG を文字でも返すようにしただけ)
# 大組図TDFの断面から、指定した板マークのダイアフラム平面の外形を取り、線画(SVG)にする
#  関数として使う: measure(t, mark, colsize) → 結果(外形・中心・寸法)、 write_svg(結果, 出力パス)
#  コマンドとして使う: python plate.py <toolsフォルダ> <tdf> <板マーク> <柱の外寸mm> <出力.svg>
import sys, os, math, struct
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))   # tdf_binary.py は同じフォルダ
import tdf_binary as tb

SNAP = 1.0      # 線の端と端を「つながっている」とみなす距離(mm)
R = 620         # 板の中心から外形を探す範囲(mm)。520 だと 1060 角の板(26-16 □-1000 の ND17H)の外周が範囲外で、柱の線(1000)を測っていた


def arc_angles(t, a):
    """円弧の開始角・終了角(解析モジュールは開始角だけ返すため、生データから読む)"""
    off = a.offset + 48
    try:
        if struct.unpack_from("<i", t.raw, off)[0] == tb._SIZE_ARC_ANGLE:
            return struct.unpack_from("<2d", t.raw, off + 16)
    except struct.error:
        pass
    return None


class _Chord:  # 角の丸み(円弧)も外周の一部としてつなぐ(両端を結ぶ線として扱う)
    __slots__ = ("x1", "y1", "x2", "y2", "length")
    def __init__(s, x1, y1, x2, y2):
        s.x1, s.y1, s.x2, s.y2 = x1, y1, x2, y2; s.length = math.hypot(x2 - x1, y2 - y1)


def _centers(t, mark, lab):
    """板の中心の候補(近い順に最大20)"""
    tries = []
    for lb in lab:   # ①板マークの左上にある中央の大穴
        lx, ly = lb.x, lb.y
        big = [a for a in t.arcs if 140 <= a.r <= 185 and ly < a.cy < ly + 1800 and lx - 1800 < a.cx < lx + 400]
        tries += sorted(big, key=lambda a: math.hypot(a.cx - lx, a.cy - ly))[:6]
    for lb in lab:   # 予備: ②板マークの周り2500以内の大穴 ③中央に穴の無い板は四隅の穴4つの中心
        lx, ly = lb.x, lb.y
        big = [a for a in t.arcs if 140 <= a.r <= 185 and abs(a.cy - ly) < 2500 and abs(a.cx - lx) < 2500]
        tries += sorted(big, key=lambda a: math.hypot(a.cx - lx, a.cy - ly))[:6]
        sm = [a for a in t.arcs if 15 <= a.r <= 130 and abs(a.cy - ly) < 2500 and abs(a.cx - lx) < 2500]
        for a in sm:
            for b in sm:
                if abs(b.r - a.r) < 0.5 and 150 < b.cx - a.cx < 800 and 150 < b.cy - a.cy < 800 and abs((b.cx - a.cx) - (b.cy - a.cy)) < 1:   # 間隔150〜(26-14 □-450 は226)
                    if _corner(sm, a.cx, b.cy, a.r) and _corner(sm, b.cx, a.cy, a.r):
                        tries.append(type("C", (), dict(cx=(a.cx + b.cx) / 2, cy=(a.cy + b.cy) / 2))())
    return sorted(tries, key=lambda a: min(math.hypot(a.cx - lb.x, a.cy - lb.y) for lb in lab))[:20] if tries else tries


def _corner(sm, x, y, r):
    return any(abs(c.cx - x) < 1 and abs(c.cy - y) < 1 and abs(c.r - r) < 0.5 for c in sm)


def _outline(t, mark, cx, cy):
    """中心から右へ伸ばした線が当たる辺から、角ごとに一番左に曲がる線を選んで外周をたどる"""
    inbox = lambda x, y: abs(x - cx) <= R and abs(y - cy) <= R
    cand = [l for l in t.lines if inbox(l.x1, l.y1) and inbox(l.x2, l.y2) and l.length > 1]
    oudy = mark.startswith("OUDY")
    for a_ in t.arcs:
        ang = arc_angles(t, a_)
        if ang and 5 < a_.r < (40 if oudy else 120) and inbox(a_.cx, a_.cy):  # 内ダイアは切欠きの小さな丸みだけ
            p1 = (a_.cx + a_.r * math.cos(ang[0]), a_.cy + a_.r * math.sin(ang[0])); p2 = (a_.cx + a_.r * math.cos(ang[1]), a_.cy + a_.r * math.sin(ang[1]))
            if math.hypot(p1[0] - p2[0], p1[1] - p2[1]) > 1: cand.append(_Chord(*p1, *p2))
    # 外周に使える線(矢印の短い線・中心を通る対角線/中心線は除く)と、端点の索引(1mm升目)
    usable = []
    for i, m in enumerate(cand):
        if m.length < 5 and not isinstance(m, _Chord): continue   # 矢印の短い線は除く(15→5: 26-14 ADF4 の外周に 7.6 の線がある)
        if m.length > 300 and abs((m.x2 - m.x1) * (cy - m.y1) - (m.y2 - m.y1) * (cx - m.x1)) / m.length < 30: continue   # 中心の近くを通る対角線(26-14 □-450 の形の違う板は中心から16ずれる)
        usable.append(i)
    grid = {}
    for i in usable:
        m = cand[i]
        for k, (px, py, qx, qy) in enumerate(((m.x1, m.y1, m.x2, m.y2), (m.x2, m.y2, m.x1, m.y1))):
            grid.setdefault((math.floor(px), math.floor(py)), []).append((i, k, (px, py), (qx, qy)))

    def nexts(v):   # 点 v から出る線(元の並び順を保つ: 同点のときの選び方を変えないため)
        fx, fy = math.floor(v[0]), math.floor(v[1])
        found = [e for i in (-1, 0, 1) for j in (-1, 0, 1) for e in grid.get((fx + i, fy + j), ())]
        return sorted(found, key=lambda e: (e[0], e[1]))

    hits = []
    for l in cand:
        if abs(l.y2 - l.y1) < 1e-6 or not (min(l.y1, l.y2) <= cy <= max(l.y1, l.y2)):
            continue
        xh = l.x1 + (cy - l.y1) * (l.x2 - l.x1) / (l.y2 - l.y1)
        if xh > cx + 200:
            hits.append((xh, l))
    loops = []
    for xh, l in sorted(hits, key=lambda h: h[0] if oudy else -h[0]):  # 外側の線から順に(内ダイアは内側から)
        for sgn in (1, -1):                                             # 左回り優先・右回り優先の両方
            a, b = ((l.x1, l.y1), (l.x2, l.y2)) if l.y2 > l.y1 else ((l.x2, l.y2), (l.x1, l.y1))
            pth = [a, b]; ok = False
            for _ in range(60):
                u, v = pth[-2], pth[-1]
                din = math.atan2(v[1] - u[1], v[0] - u[0])
                nxt = None
                for i, k, p, q in nexts(v):
                    if math.hypot(p[0] - v[0], p[1] - v[1]) < SNAP and math.hypot(q[0] - u[0], q[1] - u[1]) > SNAP:
                        turn = sgn * ((math.atan2(q[1] - v[1], q[0] - v[0]) - din + math.pi) % (2 * math.pi) - math.pi)
                        if abs(turn) > math.radians(160): continue  # ほぼ引き返す線(Uターン)は外周ではない
                        # 同じ向きの線が重なっているとき(26-14 ADF5: 外周の辺に孔の印の短い線が重なる)は長い方
                        d_ = math.hypot(q[0] - v[0], q[1] - v[1])
                        if nxt is None or turn > nxt[0] + 1e-6 or (abs(turn - nxt[0]) <= 1e-6 and d_ > nxt[2]):
                            nxt = (turn, q, d_)
                if nxt is None:
                    break
                q = nxt[1]
                if math.hypot(q[0] - pth[0][0], q[1] - pth[0][1]) < SNAP:
                    ok = True; break
                pth.append(q)
            if ok and len(pth) >= 4:
                xs_ = [p[0] for p in pth]; ys_ = [p[1] for p in pth]
                if min(xs_) < cx < max(xs_) and min(ys_) < cy < max(ys_) and 400 < max(xs_) - min(xs_) < 1240 and 400 < max(ys_) - min(ys_) < 1240:
                    area = abs(sum(pth[i][0] * pth[i - 1][1] - pth[i - 1][0] * pth[i][1] for i in range(len(pth)))) / 2
                    if area > 0.6 * (max(xs_) - min(xs_)) * (max(ys_) - min(ys_)):  # 行き来しただけの輪は外形ではない
                        loops.append((0 if sgn == 1 else 1, len(loops), pth))
    if not loops:
        raise ValueError("板の外形がたどれません")
    path = min(loops)[2]   # 左回りでたどれた輪を優先、無ければ右回り
    out = []                # 一直線上の頂点をまとめる
    for i, p in enumerate(path):
        o_, n_ = path[i - 1], path[(i + 1) % len(path)]
        if abs((p[0] - o_[0]) * (n_[1] - p[1]) - (p[1] - o_[1]) * (n_[0] - p[0])) > 1e-3 * math.hypot(p[0] - o_[0], p[1] - o_[1]) * math.hypot(n_[0] - p[0], n_[1] - p[1]):
            out.append(p)
    return out, cand


def _inside(H, x, y, tol=1.0):
    """外形の内側か(境界上も含む)。外形がへこんでいても正しく判定する(切欠きのある内ダイア等)"""
    n = len(H)
    for i in range(n):   # 境界上
        ax, ay = H[i]; bx, by = H[(i + 1) % n]
        L2 = (bx - ax) ** 2 + (by - ay) ** 2 or 1
        u = max(0, min(1, ((x - ax) * (bx - ax) + (y - ay) * (by - ay)) / L2))
        if math.hypot(ax + u * (bx - ax) - x, ay + u * (by - ay) - y) <= tol: return True
    c = False            # 内側(交差数)
    for i in range(n):
        ax, ay = H[i]; bx, by = H[i - 1]
        if (ay > y) != (by > y) and x < (bx - ax) * (y - ay) / (by - ay) + ax: c = not c
    return c


def measure(t, mark, colsize):
    """板の外形を測る。戻り値 dict(H=外形の頂点, cx, cy, dim=[短辺,長辺], ...) / 測れないときは None"""
    lab = [r for r in t.texts if t.resolve_text(r) in (mark, "<" + mark + ">")]   # 「<ADF1>」(26-14 心斎橋。山かっこで囲んで書く)
    if not lab:   # 印の付いた文字の板マーク(26-16 WA2 の M900-50H 等。tdf_binary.flagged_texts)
        lab = [type("F", (), dict(x=x, y=y))() for s, x, y, rot, h in getattr(t, "flagged_texts", []) if s == mark]
    if not lab:
        return None
    for cen in _centers(t, mark, lab):
        try:
            H, cand = _outline(t, mark, cen.cx, cen.cy)
        except (ValueError, TypeError):
            continue
        if len(H) >= 4:
            return dict(t=t, mark=mark, colsize=colsize, H=H, cand=cand, cx=cen.cx, cy=cen.cy)
    return None


def summary(r):
    H = r["H"]; xs = [p[0] for p in H]; ys = [p[1] for p in H]
    return sorted([round(max(xs) - min(xs), 1), round(max(ys) - min(ys), 1)])


def write_svg(r, out):
    t, mark, H, cand, cx, cy = r["t"], r["mark"], r["H"], r["cand"], r["cx"], r["cy"]
    keep_lines = [l for l in cand if _inside(H, l.x1, l.y1) and _inside(H, l.x2, l.y2) and l.length >= 60]
    keep_arcs = []
    for a in t.arcs:
        if a.r < 300 and _inside(H, a.cx, a.cy) and math.hypot(a.cx - cx, a.cy - cy) < R:
            ang = arc_angles(t, a)
            if ang is None:
                if all(_inside(H, a.cx + dx, a.cy + dy) for dx, dy in ((a.r, 0), (-a.r, 0), (0, a.r), (0, -a.r))):
                    keep_arcs.append((a, None))
            else:
                keep_arcs.append((a, ang))
    xs = [p[0] for p in H]; ys = [p[1] for p in H]
    minx, maxx, miny, maxy = min(xs), max(xs), min(ys), max(ys)
    half = r["colsize"] / 2
    dl = round((cx - half) - minx, 1); dr = round(maxx - (cx + half), 1); dt = round(maxy - (cy + half), 1)
    fmt = lambda v: f"{v:.1f}".rstrip("0").rstrip(".")
    r["text"] = f"{mark}: 中心({cx:.1f},{cy:.1f}) 外形 {maxx-minx:.1f} x {maxy-miny:.1f} 頂点{len(H)} 線{len(keep_lines)} 円弧{len(keep_arcs)} 寸法 左{fmt(dl)} 右{fmt(dr)} 上{fmt(dt)}"
    M = 300  # 寸法と矢印の余白(mm)
    vx0, vx1, vy0, vy1 = minx - M, maxx + 80, miny - 80, maxy + M
    W, Hh = vx1 - vx0, vy1 - vy0
    P = lambda x, y: (x - vx0, vy1 - y)
    o = [f'<svg xmlns="http://www.w3.org/2000/svg" width="{W/10:.1f}mm" height="{Hh/10:.1f}mm" viewBox="0 0 {W:.1f} {Hh:.1f}">',
         f'<rect x="0" y="0" width="{W:.1f}" height="{Hh:.1f}" fill="white"/>',
         '<g stroke="black" stroke-width="6" fill="none" stroke-linecap="round">']
    for l in keep_lines:
        (a, b), (c, d) = P(l.x1, l.y1), P(l.x2, l.y2)
        o.append(f'<line x1="{a:.1f}" y1="{b:.1f}" x2="{c:.1f}" y2="{d:.1f}"/>')
    for a, ang in keep_arcs:
        ax, ay = P(a.cx, a.cy)
        if ang is None or abs(((ang[1] - ang[0]) % (2 * math.pi))) < 1e-6:
            o.append(f'<circle cx="{ax:.1f}" cy="{ay:.1f}" r="{a.r:.1f}"/>')
        else:
            a1, a2 = ang
            sweep = (a2 - a1) % (2 * math.pi)
            p1 = P(a.cx + a.r * math.cos(a1), a.cy + a.r * math.sin(a1))
            p2 = P(a.cx + a.r * math.cos(a2), a.cy + a.r * math.sin(a2))
            o.append(f'<path d="M{p1[0]:.1f},{p1[1]:.1f} A{a.r:.1f},{a.r:.1f} 0 {1 if sweep > math.pi else 0} 0 {p2[0]:.1f},{p2[1]:.1f}"/>')
    for (x1, y1, x2, y2) in ((cx - half + 40, cy, cx + half - 40, cy), (cx, cy - half + 40, cx, cy + half - 40)):   # 中心線(柱の内側だけ)
        (a, b), (c, d) = P(x1, y1), P(x2, y2)
        o.append(f'<line x1="{a:.1f}" y1="{b:.1f}" x2="{c:.1f}" y2="{d:.1f}" stroke-width="3"/>')
    o.append('</g>')
    fs = 120
    def dim_h(xa, xb, y, txt, anchor):
        (a, b), (c, d) = P(xa, y), P(xb, y)
        s = [f'<line x1="{a:.1f}" y1="{b:.1f}" x2="{c:.1f}" y2="{d:.1f}" stroke="black" stroke-width="3"/>']
        for xx in (xa, xb):
            e, f = P(xx, y)
            s.append(f'<line x1="{e:.1f}" y1="{f-25:.1f}" x2="{e:.1f}" y2="{f+25:.1f}" stroke="black" stroke-width="3"/>')
        tx = a if anchor == "start" else c
        s.append(f'<text x="{tx:.1f}" y="{b-18:.1f}" font-size="{fs}" font-family="MS Gothic" text-anchor="{anchor}">{txt}</text>')
        return s
    yd = maxy + 90
    o += dim_h(minx, cx - half, yd, fmt(dl), "start")
    o += dim_h(cx + half, maxx, yd, fmt(dr), "end")
    xd = minx - 90   # 左辺の上の寸法(縦)
    (a, b), (c, d) = P(xd, cy + half), P(xd, maxy)
    o.append(f'<line x1="{a:.1f}" y1="{b:.1f}" x2="{c:.1f}" y2="{d:.1f}" stroke="black" stroke-width="3"/>')
    for yy in (cy + half, maxy):
        e, f = P(xd, yy)
        o.append(f'<line x1="{e-25:.1f}" y1="{f:.1f}" x2="{e+25:.1f}" y2="{f:.1f}" stroke="black" stroke-width="3"/>')
    o.append(f'<text transform="translate({a-20:.1f},{(b+d)/2:.1f}) rotate(-90)" font-size="{fs}" font-family="MS Gothic" text-anchor="middle">{fmt(dt)}</text>')
    ox, oy = P(minx - 150, miny - 20)   # X・Y の矢印(左下)
    L = 220
    o.append(f'<g stroke="black" stroke-width="4" fill="none"><polyline points="{ox:.1f},{oy-L:.1f} {ox:.1f},{oy:.1f} {ox+L:.1f},{oy:.1f}"/>'
             f'<polyline points="{ox-18:.1f},{oy-L+35:.1f} {ox:.1f},{oy-L:.1f} {ox+18:.1f},{oy-L+35:.1f}"/>'
             f'<polyline points="{ox+L-35:.1f},{oy-18:.1f} {ox+L:.1f},{oy:.1f} {ox+L-35:.1f},{oy+18:.1f}"/></g>')
    o.append(f'<text x="{ox-60:.1f}" y="{oy-L+60:.1f}" font-size="{fs}" font-family="MS Gothic">X</text>')
    o.append(f'<text x="{ox+L+10:.1f}" y="{oy+25:.1f}" font-size="{fs}" font-family="MS Gothic">Y</text>')
    o.append('</svg>')
    r["svg"] = "\n".join(o)          # ブラウザ版はファイルに書かず文字で受け取る(out=None)
    if out: open(out, "w", encoding="utf-8").write(r["svg"])
    return r["text"]


if __name__ == "__main__":
    tdf_path, mark, colsize, out = sys.argv[2], sys.argv[3], float(sys.argv[4]), sys.argv[5]
    t = tb.load(tdf_path)
    r = measure(t, mark, colsize)
    if not r:
        sys.exit("板の外形がたどれません" if any(t.resolve_text(x) == mark for x in t.texts) else f"{mark} が図面にありません")
    print(write_svg(r, out))
