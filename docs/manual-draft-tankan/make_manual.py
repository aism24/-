# 短管リストのアプリ説明書PDF(金物リスト docs/manual-draft-kanamono と同じ見た目)。文面・ページ構成は pages_tankan.py。
# 画面は shoot.py で撮った shots/*.png、赤枠の位置は rects.json(画面の座標。撮影は1.5倍)。
# 改行は budoux(文節の途中で改行しない)。使い方: python3 -I make_manual.py [フォント(.ttf)]
import json, os, sys
import budoux
from reportlab.pdfgen import canvas
from reportlab.lib.pagesizes import A4, landscape
from reportlab.pdfbase import pdfmetrics
from reportlab.pdfbase.ttfonts import TTFont
from reportlab.lib.utils import ImageReader
from reportlab.lib.colors import HexColor, white
from PIL import Image

HERE = os.path.dirname(os.path.abspath(__file__))
FONT = sys.argv[1] if len(sys.argv) > 1 else ('C:/Windows/Fonts/meiryo.ttc' if os.name == 'nt' else '/usr/share/fonts/opentype/ipafont-gothic/ipag.ttf')
pdfmetrics.registerFont(TTFont('J', FONT, subfontIndex=0) if FONT.endswith('.ttc') else TTFont('J', FONT))
LOGO = os.path.join(HERE, '..', 'manual-draft', 'logo.png')
RECTS = json.load(open(os.path.join(HERE, 'rects.json'), encoding='utf-8-sig'))
# Excelの見本(shots/14_excel.png = Excelの1枚目を150dpiで画像にしたもの)の上の表だけを切り出し、赤枠の位置(画像の点÷1.5)を足す
_xl = os.path.join(HERE, 'shots', '14_excel.png')
if os.path.exists(_xl):
    Image.open(_xl).crop((110, 80, 1125, 588)).save(os.path.join(HERE, 'shots', '14_excel_top.png'))
    _px = dict(title=(14, 14, 576, 72), notes=(586, 14, 1004, 72), no=(14, 80, 112, 178), size=(124, 80, 688, 152), len=(124, 158, 578, 180),
               fig=(16, 188, 348, 500), plates=(358, 188, 578, 446), total=(358, 452, 578, 502))
    RECTS['14_excel_top'] = {k: dict(x=a / 1.5, y=b / 1.5, width=(c - a) / 1.5, height=(d - b) / 1.5) for k, (a, b, c, d) in _px.items()}
SCALE = 1.5
W, H = landscape(A4)
INK = HexColor('#222222'); GRAY = HexColor('#555555'); RED = HexColor('#d0021b'); BAND = HexColor('#fff3b0')
parser = budoux.load_default_japanese_parser()


def text(c, x, y, s, size, bold=False, center=False, right=False):
    """太字は輪郭を少し太らせて描く(フォントに太字が無くても同じに見えるように)"""
    w = pdfmetrics.stringWidth(s, 'J', size)
    if center: x -= w / 2
    if right: x -= w
    t = c.beginText(x, y); t.setFont('J', size)
    t._textRenderMode = -1; t.setTextRenderMode(2 if bold else 0)   # 描画モードは次の文字にも残るので毎回決める
    if bold: c.setLineWidth(size * 0.035); c.setStrokeColor(c._fillColorObj)
    t.textOut(s); c.drawText(t)


# 1ページ = 1ステップ。shots: 'name'(全体)/ ('name', 'key' または ['key', ...])= その枠のまわりだけ切り出す。marks: (画像の番号, rects のキー, 番号)
import importlib.util
_sp = importlib.util.spec_from_file_location('pages_tankan', os.path.join(HERE, 'pages_tankan.py')); _m = importlib.util.module_from_spec(_sp); _sp.loader.exec_module(_m)
pages = _m.pages
_C = {'A': (HexColor('#e8f0fe'), HexColor('#4f46c8')), 'B': (HexColor('#e6f4ea'), HexColor('#1e8449')), 'C': (HexColor('#fdecea'), HexColor('#c0392b'))}
PARTS = {k: (t, d) + _C[k] for k, (t, d) in _m.PARTS_TEXT.items()}
for i, p in enumerate(pages, 1):
    p['step'] = 'STEP %d' % i


def wrap(s, size, width):
    """文節の途中で改行しないように折り返す"""
    lines, cur = [], ''
    for ch in parser.parse(s):
        if pdfmetrics.stringWidth(cur + ch, 'J', size) <= width: cur += ch
        elif not cur: cur = ch
        else: lines.append(cur); cur = ch.lstrip()
    if cur: lines.append(cur)
    return lines


CROP_DIR = os.path.join(HERE, 'crops'); os.makedirs(CROP_DIR, exist_ok=True)


def load_shot(spec):
    name, crop = (spec, None) if isinstance(spec, str) else spec
    path = os.path.join(HERE, 'shots', name + '.png')
    if not crop: return path, 0, 0
    keys = [crop] if isinstance(crop, str) else crop
    rs = [RECTS[name][k] for k in keys]; m = 14
    x0 = max(0, min(r['x'] for r in rs) - m); y0 = max(0, min(r['y'] for r in rs) - m)
    x1 = max(r['x'] + r['width'] for r in rs) + m; y1 = max(r['y'] + r['height'] for r in rs) + m
    out = os.path.join(CROP_DIR, name + '_' + '_'.join(keys) + '.png')
    Image.open(path).crop(tuple(round(v * SCALE) for v in (x0, y0, x1, y1))).save(out)
    return out, x0, y0


placed = []


def mark(c, x0, ytop, s, r, num, dx=0, dy=0):
    pad = 3
    x = x0 + (r['x'] - dx - pad) * SCALE * s
    y = ytop - (r['y'] - dy + r['height'] + pad) * SCALE * s
    w = (r['width'] + pad * 2) * SCALE * s; h = (r['height'] + pad * 2) * SCALE * s
    c.setStrokeColor(RED); c.setLineWidth(2.2); c.roundRect(x, y, w, h, 3, fill=0, stroke=1)
    rad = 10
    cx, cy = max(x0 + rad, x - rad + 2), y + h + rad - 2
    if any(abs(cx - px) < rad * 2.2 and abs(cy - py) < rad * 2.2 for px, py in placed):
        cx = x + w + rad - 2
    placed.append((cx, cy))
    c.setFillColor(RED); c.circle(cx, cy, rad, fill=1, stroke=0)
    c.setFillColor(white); text(c, cx, cy - 4.5, num.translate(str.maketrans('①②③④⑤⑥⑦⑧⑨', '123456789')), 13, bold=True, center=True)


c = canvas.Canvas(os.path.join(HERE, '短管リスト_アプリ説明書_ドラフト.pdf'), pagesize=(W, H))
c.setTitle('大組図から短管リスト作成 アプリ説明書(ドラフト)')
# ---- 表紙
c.setFillColor(BAND); c.rect(0, H - 110, W, 110, fill=1, stroke=0)
lw = 190; c.drawImage(LOGO, W - 30 - lw, H - 110 + (110 - lw * 400 / 1192) / 2, lw, lw * 400 / 1192, mask='auto')
c.setFillColor(INK); text(c, 40, H - 60, _m.TITLE, 32, bold=True)
c.setFillColor(HexColor('#444444')); text(c, 40, H - 92, _m.SUB, 20)
c.setFillColor(INK)
text(c, 40, H - 142, _m.LEAD, 15)
c.setFillColor(GRAY); text(c, 40, H - 166, _m.LEAD2, 13)
gapx = 30; bw = (W - 80 - gapx * 2) / 3; top = H - 190; bh = top - 40
for i, k in enumerate('ABC'):
    t, d, bg, fg = PARTS[k]; x = 40 + i * (bw + gapx)
    c.setFillColor(bg); c.roundRect(x, 40, bw, bh, 10, fill=1, stroke=0)
    c.setFillColor(fg); c.roundRect(x, top - 40, bw, 40, 10, fill=1, stroke=0); c.rect(x, top - 40, bw, 15, fill=1, stroke=0)
    c.setFillColor(white); text(c, x + 14, top - 27, t, 17, bold=True)
    c.setFillColor(GRAY); yy = top - 58
    for ln in wrap(d, 10, bw - 28): text(c, x + 14, yy, ln, 10); yy -= 14
    yy -= 14
    for p in [p for p in pages if p['part'] == k]:
        c.setFillColor(fg); c.roundRect(x + 14, yy - 6, 56, 20, 5, fill=1, stroke=0)
        c.setFillColor(white); text(c, x + 42, yy, p['step'], 10, center=True)
        c.setFillColor(INK); tl = wrap(p['title'], 11, bw - 98)
        for j, ln in enumerate(tl): text(c, x + 78, yy - j * 14, ln, 11)
        yy -= 26 + (len(tl) - 1) * 14
    if i < 2:
        c.setFillColor(fg); text(c, x + bw + gapx / 2, 40 + bh / 2, '▶', 22, center=True)
c.setFillColor(GRAY); text(c, W - 30, 18, '1', 10, right=True); c.showPage()
# ---- 各ステップ
for n, p in enumerate(pages, start=2):
    t, d, bg, fg = PARTS[p['part']]
    c.setFillColor(BAND); c.rect(0, H - 56, W, 56, fill=1, stroke=0)
    c.setFillColor(fg); text(c, 30, H - 21, t, 12)
    c.setFillColor(INK); text(c, 30, H - 46, p['step'] + '  ' + p['title'], 21, bold=True)
    y = H - 80
    for tx in p['body']:
        c.setFillColor(RED if tx.startswith('※') else INK)
        ind = 14 if tx[0] in '①②③④⑤⑥⑦⑧⑨・※' else 0
        for j, ln in enumerate(wrap(tx, 12.5, W - 60 - ind)):
            text(c, 30 + (ind if j else 0), y, ln, 12.5); y -= 18
        y -= 3
    top = y - 4; bottom = 32; avail = top - bottom
    loaded = [load_shot(sp) for sp in p['shots']]
    ims = [ImageReader(lp[0]) for lp in loaded]
    sizes = [im.getSize() for im in ims]; gap = 16
    placed.clear()
    pos = []
    if p.get('rows'):   # 上下に並べる
        s = min((avail - gap * (len(ims) - 1)) / sum(h for w, h in sizes), (W - 60) / max(w for w, h in sizes))
        yt = top
        for im, (w, h) in zip(ims, sizes):
            x = (W - w * s) / 2
            c.drawImage(im, x, yt - h * s, w * s, h * s)
            c.setStrokeColor(HexColor('#999999')); c.setLineWidth(0.8); c.rect(x, yt - h * s, w * s, h * s, fill=0)
            pos.append((x, yt)); yt -= h * s + gap
    else:
        s = min(avail / max(h for w, h in sizes), (W - 60 - gap * (len(ims) - 1)) / sum(w for w, h in sizes))
        tw = sum(w * s for w, h in sizes) + gap * (len(ims) - 1); x = (W - tw) / 2
        for im, (w, h) in zip(ims, sizes):
            c.drawImage(im, x, top - h * s, w * s, h * s)
            c.setStrokeColor(HexColor('#999999')); c.setLineWidth(0.8); c.rect(x, top - h * s, w * s, h * s, fill=0)
            pos.append((x, top)); x += w * s + gap
    for (k, key, num) in p['marks']:
        sp = p['shots'][k]; name = sp if isinstance(sp, str) else sp[0]
        r = RECTS[name].get(key)
        if r: mark(c, pos[k][0], pos[k][1], s, r, num, loaded[k][1], loaded[k][2])
        else: print('赤枠が無い', name, key)
    c.setFillColor(GRAY); text(c, W - 30, 18, str(n), 10, right=True); c.showPage()
c.save()
print('ページ数', len(pages) + 1)
