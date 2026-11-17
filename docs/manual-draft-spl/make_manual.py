# アプリ説明書PDF(spl-sheet-web)の作成スクリプト。tdf-dim-count の手順書(docs/manual-draft)と同じ見た目。
# 画面は shoot.py で撮った shots/*.png、赤枠の位置は rects.json(画面の座標。撮影は1.5倍)。
# 使い方: python -I make_manual.py
import json, os
import budoux
from reportlab.pdfgen import canvas
from reportlab.lib.pagesizes import A4, landscape
from reportlab.pdfbase import pdfmetrics
from reportlab.pdfbase.ttfonts import TTFont
from reportlab.lib.utils import ImageReader
from reportlab.lib.colors import HexColor, white

pdfmetrics.registerFont(TTFont('J', 'C:/Windows/Fonts/meiryo.ttc', subfontIndex=0))
pdfmetrics.registerFont(TTFont('JB', 'C:/Windows/Fonts/meiryob.ttc', subfontIndex=0))
HERE = os.path.dirname(os.path.abspath(__file__))
LOGO = os.path.join(HERE, '..', 'manual-draft', 'logo.png')
RECTS = json.load(open(os.path.join(HERE, 'rects.json'), encoding='utf-8-sig'))
SCALE = 1.5  # 撮影の倍率(画面の座標 → 画像の画素)
W, H = landscape(A4)
INK = HexColor('#222222'); GRAY = HexColor('#555555'); RED = HexColor('#d0021b')
BAND = HexColor('#fff3b0')
parser = budoux.load_default_japanese_parser()

# 1ページ = 1ステップ。marks: (画像の番号, rects.json のキー, 赤丸の数字)
pages = [
    dict(part='A', title='工事名を選び、Excelを取り込む', shots=['01_start'],
         marks=[(0, 'koji', '①'), (0, 'excel', '②')],
         body=['①「工事名」をリストから選びます。前回選んだ工事が、最初から選ばれています。',
               '②「Excelを選ぶ」を押して、その工事の入力データー(.xlsm)を選びます。Excelを画面にドラッグ&ドロップしても取り込めます。',
               '※ Excelの工事番号(ﾃﾞｰﾀシートの E1・F1)が選んだ工事と違うときは、どちらで進めるか確認が出ます。']),
    dict(part='A', title='取り込めたことを確かめる', shots=['02_excel'],
         marks=[(0, 'done', '①'), (0, 'server', '②')],
         body=['① 選んだ工事名と、取り込んだExcelの名前・SPLシートの行数が表示されます。',
               '② 次に、図面のあるサーバーのボタンを押します(次のページ)。',
               '工事やExcelを選び直すときは、右上の「リセット」を押します。']),
    dict(part='B', title='サーバーのボタンを押す(初回だけ「①進行中工事」を選ぶ)', shots=[('03_root', 'box')],
         marks=[(0, 'box', '①'), (0, 'go', '②')],
         body=['そのサーバーを初めて使うときだけ、① の案内が出ます。',
               '②「「①進行中工事」を選ぶ」を押し、開いた画面でサーバーの「①進行中工事」フォルダを選びます。',
               '※ 工事フォルダや「01.一般図」など、図面のあるフォルダではありません。間違えると、選び直すよう案内が出ます。',
               '次からは、このページの操作はありません(サーバーのボタンを押すと、すぐ図面を選べます)。']),
    dict(part='B', title='図面(TDF)ファイルを選ぶ', shots=[('04_tdf', 'box')],
         marks=[(0, 'go', '①')],
         body=['①「TDFファイルを選ぶ」を押し、実際の継手.tdfファイルを複数選択して「開く」で実行',
               '※フォルダが複数にある場合は「別のフォルダの図面を追加」で追加可能']),
    dict(part='B', title='選んだ図面を確かめる', shots=[('05_confirm1', 'box')],
         marks=[(0, 'ok', '①'), (0, 'add', '②'), (0, 'back', '③')],
         body=['選んだ図面がフォルダごとに表示されます。',
               '①「この図面で抽出する」… この図面で照合を始めます。',
               '②「別のフォルダの図面を追加」… N棟・S棟のように、別のフォルダの図面も一緒に使うときに押します(次のページ)。',
               '③「選び直す」… 選んだ図面を全部外して、選び直します。']),
    dict(part='B', title='別のフォルダの図面を追加する(N棟・S棟など)', shots=[('06_add', 'box'), ('07_confirm2', 'box')],
         marks=[(0, 'go', '①'), (1, 'ok', '②')],
         body=['①「TDFファイルを選ぶ」を押し、追加する図面のあるフォルダ(例: 01.一般図\\02.S棟)まで移って選びます。',
               '② 確認の画面に、フォルダごとの図面が並びます。そろったら「この図面で抽出する」を押します。',
               '※ 同じ図番の図面を2回選んだときは、注意が出ます。']),
    dict(part='C', title='最新図との食い違いを確かめる', shots=[('08_diff', 'box')],
         marks=[(0, 'box', '①')],
         body=['照合が終わると、① の一覧が出ます。',
               '・違い … Excelの値と最新図の値が違う継手(元の行 = 取り込んだExcelの行番号)',
               '・図面にだけある … Excelに無い継手。図面の値で行を追加しました',
               '・同じ名前の継手が別の図番にもある行 … Excelの値と前後の行から組んだ相手',
               'この一覧は、表の上の「違いの一覧」でいつでも出せます。']),
    dict(part='C', title='表の見方', shots=['09_table'],
         marks=[(0, 'chips', '①'), (0, 'rownew', '②'), (0, 'rowdiff', '③'), (0, 'origrow', '④'), (0, 'link', '⑤'), (0, 'only', '⑥')],
         body=['① 全部の行数と、一致・違い・新規・手入力の数。',
               '② 緑の行 = 図面にだけある継手(新規)。③ 黄色の行 = 最新図と違う(違うセルに「≠図 最新図の値」)。灰色の行 = 図面に無い行(手入力。そのまま残します)。',
               '④ 元の行 = 取り込んだExcelの行番号(新規の行は空)。',
               '⑤ 図番・継手名をクリックすると、実寸法師でその図面が開きます。',
               '⑥「違い・新規だけ表示」のチェックボックスをクリックしてチェックを入れると、違い(黄色)と新規(緑)の行だけが表示されます。もう一度クリックしてチェックを外すと、全部の行に戻ります。']),
    dict(part='C', title='違い・新規の行だけを見る', shots=['10_only'],
         marks=[(0, 'only', '①')],
         body=['①「違い・新規だけ表示」にチェックを入れると、確かめる必要のある行だけになります。',
               'チェックを外すと、全部の行に戻ります。']),
    dict(part='C', title='値を直す', shots=['11_edit'],
         marks=[(0, 'cell', '①')],
         body=['① 直したいセルをダブルクリックすると入力欄になります。Enter(または Tab)で確定、Esc でやめます。',
               '板厚・幅・長さ・枚数は数字だけ入れられます。板厚は「※」も入れられます。',
               '図番・継手名は図面から入るので、ここでは変えられません。']),
    dict(part='C', title='図面の値にする', shots=['12_select'],
         marks=[(0, 'check', '①'), (0, 'applysel', '②'), (0, 'applyall', '③')],
         body=['① 行の左のチェックを入れて、②「選んだ行を図面の値にする」を押すと、その行を最新図の値にします。',
               '③「違いを全部図面の値にする」は、違う行を全部まとめて最新図の値にします(確認が出ます)。',
               '※ 丁番・ボルトの列は変えません。']),
    dict(part='C', title='Excelをダウンロードする', shots=['09_table'],
         marks=[(0, 'save', '①')],
         body=['① 右上の「Excelダウンロード」を押すと、表の内容でSPLシートを書き直したExcelが「ダウンロード」フォルダに保存されます。',
               '・ファイル名: 元の名前_SPL作成_日時.xlsm(取り込んだExcelは変わりません)',
               '・マクロ・ほかのシートはそのまま。図番・継手名に図面へのリンクが付きます。',
               '・W列に「元の行」(取り込んだExcelの行番号)が入ります。手入力の行も残ります。']),
    dict(part='C', title='最初からやり直す(リセット)', shots=['14_reset'],
         marks=[(0, 'reset', '①'), (0, 'box', '②')],
         body=['①「リセット」を押すと ② の確認が出て、取り込んだExcelと図面を外して最初の画面に戻ります。',
               '覚えたサーバーの「①進行中工事」はそのまま、工事名は前回選んだものになります。',
               '※ 表で直した内容は、ダウンロードしていなければ消えます。']),
]
PARTS = {
    'A': ('① Excelを取り込む', '工事名を選び、入力データーのExcelを取り込みます', HexColor('#e8f0fe'), HexColor('#4f46c8')),
    'B': ('② 図面を選ぶ', 'サーバーを押して、継手基準図(TDF)を選びます', HexColor('#e6f4ea'), HexColor('#1e8449')),
    'C': ('③ 照合して保存する', '最新図との違いを確かめ、Excelをダウンロードします', HexColor('#fdecea'), HexColor('#c0392b')),
}
for i, p in enumerate(pages, 1):
    p['step'] = 'STEP %d' % i


def wrap(text, font, size, width):
    """文節の途中で改行しないように折り返す"""
    lines, cur = [], ''
    for ch in parser.parse(text):
        if pdfmetrics.stringWidth(cur + ch, font, size) <= width:
            cur += ch
        elif not cur:
            cur = ch
        else:
            lines.append(cur)
            cur = ch.lstrip()
    if cur:
        lines.append(cur)
    return lines


from PIL import Image
CROP_DIR = os.path.join(HERE, 'crops'); os.makedirs(CROP_DIR, exist_ok=True)


def load_shot(spec):
    """'名前' なら画面全体、('名前', 'box') ならダイアログの枠の周りだけを切り出す。
    戻り値: (画像のパス, 赤枠の座標をずらす量 dx, dy(画面の座標))"""
    name, crop = (spec, None) if isinstance(spec, str) else spec
    path = os.path.join(HERE, 'shots', name + '.png')
    if not crop:
        return path, 0, 0
    r = RECTS[name][crop]; m = 14
    x0, y0 = max(0, r['x'] - m), max(0, r['y'] - m)
    x1, y1 = r['x'] + r['width'] + m, r['y'] + r['height'] + m
    out = os.path.join(CROP_DIR, name + '.png')
    Image.open(path).crop(tuple(round(v * SCALE) for v in (x0, y0, x1, y1))).save(out)
    return out, x0, y0


placed = []  # このページで置いた赤丸の位置(重ならないようにする)


def mark(c, x0, ytop, s, r, num, dx=0, dy=0):
    """画像(左上 x0,ytop・倍率 s)の上に、画面の座標 r の赤枠と赤丸の番号を描く"""
    pad = 3
    x = x0 + (r['x'] - dx - pad) * SCALE * s
    y = ytop - (r['y'] - dy + r['height'] + pad) * SCALE * s
    w = (r['width'] + pad * 2) * SCALE * s
    h = (r['height'] + pad * 2) * SCALE * s
    c.setStrokeColor(RED); c.setLineWidth(2.2); c.roundRect(x, y, w, h, 3, fill=0, stroke=1)
    rad = 10
    cx, cy = max(x0 + rad, x - rad + 2), y + h + rad - 2
    if any(abs(cx - px) < rad * 2.2 and abs(cy - py) < rad * 2.2 for px, py in placed):
        cx = x + w + rad - 2  # 左上が他の番号と重なるときは右上に置く
    placed.append((cx, cy))
    c.setFillColor(RED); c.circle(cx, cy, rad, fill=1, stroke=0)
    c.setFillColor(white); c.setFont('JB', 13); c.drawCentredString(cx, cy - 4.5, num.translate(str.maketrans('①②③④⑤⑥⑦⑧⑨', '123456789')))


c = canvas.Canvas(os.path.join(HERE, 'SPLシート作成_アプリ説明書_ドラフト.pdf'), pagesize=(W, H))
c.setTitle('継手基準図からSPLシート作成 アプリ説明書(ドラフト)')

# ---- 表紙
c.setFillColor(BAND); c.rect(0, H - 110, W, 110, fill=1, stroke=0)
lw = 190; c.drawImage(LOGO, W - 30 - lw, H - 110 + (110 - lw * 400 / 1192) / 2, lw, lw * 400 / 1192, mask='auto')
c.setFillColor(INK); c.setFont('JB', 32); c.drawString(40, H - 60, '継手基準図からSPLシート作成')
c.setFillColor(HexColor('#444444')); c.setFont('J', 20); c.drawString(40, H - 92, 'アプリ説明書')
c.setFillColor(INK); c.setFont('J', 15)
c.drawString(40, H - 142, '入力データー(○○).xlsm の「SPL」シートを、継手基準図(TDF)の最新図と照合して作り直すアプリです。')
c.setFont('J', 13); c.setFillColor(GRAY)
c.drawString(40, H - 166, '違う所は色で分かり、図面の値に入れ替えたり手で直したりして、Excelをダウンロードします。')
keys = ['A', 'B', 'C']; gapx = 30; bw = (W - 80 - gapx * 2) / 3; top = H - 190; bh = top - 40
for i, k in enumerate(keys):
    t, d, bg, fg = PARTS[k]; x = 40 + i * (bw + gapx)
    c.setFillColor(bg); c.roundRect(x, 40, bw, bh, 10, fill=1, stroke=0)
    c.setFillColor(fg); c.roundRect(x, top - 40, bw, 40, 10, fill=1, stroke=0); c.rect(x, top - 40, bw, 15, fill=1, stroke=0)
    c.setFillColor(white); c.setFont('JB', 17); c.drawString(x + 14, top - 27, t)
    c.setFillColor(GRAY); c.setFont('J', 10)
    yy = top - 58
    for ln in wrap(d, 'J', 10, bw - 28): c.drawString(x + 14, yy, ln); yy -= 14
    yy -= 14
    for p in [p for p in pages if p['part'] == k]:
        c.setFillColor(fg); c.roundRect(x + 14, yy - 6, 56, 20, 5, fill=1, stroke=0)
        c.setFillColor(white); c.setFont('J', 10); c.drawCentredString(x + 42, yy, p['step'])
        c.setFillColor(INK); c.setFont('J', 11)
        tl = wrap(p['title'], 'J', 11, bw - 98)
        for j, ln in enumerate(tl): c.drawString(x + 78, yy - j * 14, ln)
        yy -= 26 + (len(tl) - 1) * 14
    if i < 2:
        c.setFillColor(fg); c.setFont('J', 22); c.drawCentredString(x + bw + gapx / 2, 40 + bh / 2, '▶')
c.setFont('J', 10); c.setFillColor(GRAY); c.drawRightString(W - 30, 18, '1'); c.showPage()

# ---- 各ステップ
for n, p in enumerate(pages, start=2):
    t, d, bg, fg = PARTS[p['part']]
    c.setFillColor(BAND); c.rect(0, H - 56, W, 56, fill=1, stroke=0)
    c.setFillColor(fg); c.setFont('J', 12); c.drawString(30, H - 21, t)
    c.setFillColor(INK); c.setFont('JB', 21); c.drawString(30, H - 46, p['step'] + '  ' + p['title'])
    y = H - 80
    for tx in p['body']:
        c.setFillColor(RED if tx.startswith('※') else INK); c.setFont('J', 12.5)
        for j, ln in enumerate(wrap(tx, 'J', 12.5, W - 60 - (14 if j else 0))):
            c.drawString(30 + (14 if j and tx[0] in '①②③④⑤⑥⑦⑧⑨・' else 0), y, ln); y -= 18
        y -= 3
    top = y - 4; bottom = 32; avail = top - bottom
    loaded = [load_shot(sp) for sp in p['shots']]
    ims = [ImageReader(lp[0]) for lp in loaded]
    sizes = [im.getSize() for im in ims]; gap = 16
    placed.clear()
    s = min(avail / max(h for w, h in sizes), (W - 60 - gap * (len(ims) - 1)) / sum(w for w, h in sizes))
    tw = sum(w * s for w, h in sizes) + gap * (len(ims) - 1); x = (W - tw) / 2
    pos = []
    for im, (w, h) in zip(ims, sizes):
        c.drawImage(im, x, top - h * s, w * s, h * s)
        c.setStrokeColor(HexColor('#999999')); c.setLineWidth(0.8); c.rect(x, top - h * s, w * s, h * s, fill=0)
        pos.append(x); x += w * s + gap
    for (k, key, num) in p['marks']:
        sp = p['shots'][k]; name = sp if isinstance(sp, str) else sp[0]
        r = RECTS[name].get(key)
        if r: mark(c, pos[k], top, s, r, num, loaded[k][1], loaded[k][2])
    c.setFillColor(GRAY); c.setFont('J', 10); c.drawRightString(W - 30, 18, str(n)); c.showPage()
c.save()
print('ページ数', len(pages) + 1)
