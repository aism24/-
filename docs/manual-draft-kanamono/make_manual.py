# 金物リストのアプリ説明書PDF(spl-sheet-web・tdf-dim-count の手順書と同じ見た目)。
# 画面は shoot.js で撮った shots/*.png、赤枠の位置は rects.json(画面の座標。撮影は1.5倍)。
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
pages = [
    dict(part='A', title='工場と工事名を選んで「開始」を押す', shots=[('02_selected', 'box')],
         marks=[(0, 'factory', '①'), (0, 'koji', '②'), (0, 'start', '③')],
         body=['①「作成する工場」のボタン(本社・夢前・鳥取)を押します。',
               '②「工事番号・工事名」をリストから選びます。前回選んだ工場と工事が、最初から選ばれています。',
               '③「開始」を押します。工場と工事の両方を選ぶと、押せるようになります。']),
    dict(part='A', title='説明書を開く', shots=[('02_selected', 'box'), ('04_started', ['change', 'excel'])],
         marks=[(0, 'manual', '①'), (1, 'manual', '②')],
         body=['①「金物リストアプリ説明書」を押すと、この説明書が開きます。「次へ →」「← 前へ」(キーボードの → ←)でページを送り、「閉じる」(Esc)で閉じます。',
               '②「開始」を押すと、説明書のボタンは画面右上の「工場・工事の変更」の右に移ります。作業の途中でも、ここからいつでも開けます。']),
    dict(part='B', title='サーバーを選ぶ(初回だけ「①進行中工事」を選ぶ)', rows=True, shots=[('04_started', ['server', 'files']), ('05_root', 'box')],
         marks=[(0, 'server', '①'), (1, 'ok', '②')],
         body=['① 図面のあるサーバーのボタン(「① 本社サーバー」または「① 鳥取サーバー」)を押します。',
               '② そのサーバーを初めて使うときだけ、案内が出ます。「OK」を押し、開いた画面でサーバーの「①進行中工事」フォルダを選びます。',
               '※ 工事のフォルダや、図面のあるフォルダではありません。別のサーバーのフォルダを選ぶと、選び直すよう案内が出ます。',
               '次からは、ボタンを押すだけで進めます(選んだフォルダをブラウザが覚えています)。']),
    dict(part='B', title='図面(TDF)を選ぶ', shots=[('06_server', ['server', 'files', 'repick'])],
         marks=[(0, 'server', '①'), (0, 'files', '②'), (0, 'repick', '③')],
         body=['① 選んだサーバーのボタンが青くなります(もう一方のサーバーは、リセットするまで押せません)。',
               '②「② ファイル選択」を押し、図面(.tdf)を選んで「開く」を押します。図面はまとめて何枚でも選べます。何度でも押せるので、別のフォルダの図面も続けて追加できます。',
               '図面を画面にドラッグ&ドロップしても取り込めます。',
               '③ 覚えている「①進行中工事」が違うときは、ここを押して選び直します。']),
    dict(part='B', title='読み込みの終わりに出るお知らせ', shots=[('07_notice', 'box')],
         marks=[(0, 'ok', '①')],
         body=['図面を読む間は、進み具合が表示されます(初回だけ、長さを読む準備に数秒かかります)。',
               '読み終わると、お知らせが出ることがあります。読んだら ①「OK」を押します。',
               '・吊りピース・ネット受けピースは、対象外のため金物リストに入れていません。',
               '・サヤ管は、図面から読めたときは金物リストに入れます。',
               '・取り込めなかった図面があるときは、図面の名前と理由が出ます。断面だけの補助図面(a付など)は抽出できません。',
               '※ 先に取り込んだ図面と工事名が違う図面は、取り込みません。']),
    dict(part='C', title='金物リストの見方', shots=['08_list'],
         marks=[(0, 'tdflist', '①'), (0, 'rm', '②'), (0, 'pval', '③'), (0, 'items', '④'), (0, 'sub', '⑤'), (0, 'wcols', '⑥')],
         body=['① 取り込んだ図面の一覧です。②「外す」を押すと、その図面を金物リストから外します。',
               '③ 製品(図面番号・製品名・サイズ・長さ・台数)です。図面番号・製品名を押すと、実寸法師でその図面が開きます。',
               '④ その製品の金物(サイズ・切板名・枚数・備考)です。太字の行はGPL(切板)です。⑤ 小計は、その製品の金物の枚数(本数)の合計です。',
               '⑥ 単重は1枚(1本)の重さ、重量は単重×枚数です。小計の行には、その製品の重量の合計が出ます。',
               '・支給品・スリーブなど、重さの決まらない金物は空欄です。']),
    dict(part='C', title='注文書と照合する', shots=[('08_list', ['order', 'short'])],
         marks=[(0, 'order', '①'), (0, 'short', '②')],
         body=['① 選んだ工事の注文書を読んで、切板の枚数を照合します。ここに注文書の工事名と更新日時が出ます。',
               '② 取り込んだ図面全体で使う枚数が、注文書の手配総数より多い切板は、枚数が赤になります。',
               '・注文書に無い切板と、切板名の無い金物は照合しません。',
               '※ 注文書を読めないときは、ここに赤い字で理由が出ます。そのときも形鋼などの重量は出ますが、枚数の照合はしません。']),
    dict(part='C', title='枚数・備考を直す', shots=['09_edit'],
         marks=[(0, 'qty', '①'), (0, 'note', '②'), (0, 'sub', '③')],
         body=['① 枚数(本数)の欄に数字を入れて直します。図面から読んだ数と違うときは、欄がピンク色になります。',
               '② 備考の欄も、自由に書き換えられます。',
               '③ 小計・重量・注文書との照合と、一番下の総まとめもすぐに変わります。直した内容は、そのままExcelに出ます。',
               '※ 直した内容は、Excelをダウンロードしないと残りません。']),
    dict(part='C', title='総まとめを見る', shots=['10_summary'],
         marks=[(0, 'title', '①'), (0, 'cat', '②'), (0, 'newcols', '③'), (0, 'short', '④')],
         body=['① 金物リストの一番下に、取り込んだ図面全ての総まとめが出ます。',
               '② GPL・他・鋼材に分けて、サイズ・切板名・備考が同じ金物の枚数(本数)を合計しています。',
               '③ 注文番号・単重・重量・手配総数(その工事の注文書の合計)・残数(手配総数 − 使う枚数)です。',
               '④ 足りない(注文書より多く使う)ときは、残数が「-3」のようにマイナスの赤字になります。']),
    dict(part='C', title='Excelをダウンロードする', shots=['08_list'],
         marks=[(0, 'excel', '①')],
         body=['①「Excelダウンロード」を押すと、画面の金物リスト(直した枚数・備考と総まとめ)をExcelにして、「ダウンロード」フォルダに保存します。',
               '・ファイルの名前: 図面が1枚のときは「図面番号_金物リスト.xlsx」、2枚以上のときは「工事番号_日時_金物リスト.xlsx」',
               '・Excelにも、画面と同じ単重・重量と、総まとめの注文番号・手配総数・残数が出ます(不足はマイナスの赤字)。']),
    dict(part='C', title='ダウンロード後の注意', shots=[('12_link', 'box')],
         marks=[(0, 'ok', '①')],
         body=['Excelをダウンロードすると、この案内が出ます。',
               '・Excelの図番・製品名には、実寸法師へのリンクが付いています。押すと実寸法師で図面が開きます。',
               '※ 注意1: 開くのは図面の原本です。書き換えて保存しないよう注意してください。',
               '※ 注意2: あとで図面が差し替わると、リンクが切れて開けなくなります。',
               '① 読んだら「閉じる」を押します。']),
    dict(part='C', title='工場・工事の変更とリセット', rows=True, shots=[('08_list', ['change', 'excel']), ('13_reset', 'box')],
         marks=[(0, 'change', '①'), (0, 'reset', '②'), (1, 'cancel', '③'), (1, 'ok', '④')],
         body=['①「工場・工事の変更」… 最初の画面が出て、工場・工事を選び直せます(「キャンセル」で元の画面に戻ります)。',
               '②「リセット」… 確認が出ます。③「やめる」で元に戻り、④「すべて消す」で取り込んだ図面・直した内容・選んだサーバーを全部消して、サーバーを選ぶところに戻ります。',
               '※ 直した内容は、Excelをダウンロードしていなければ消えます。']),
]
PARTS = {
    'A': ('① 始める', '工場と工事名を選んで、アプリを始めます', HexColor('#e8f0fe'), HexColor('#4f46c8')),
    'B': ('② 図面を取り込む', 'サーバーを選び、図面(TDF)を取り込みます', HexColor('#e6f4ea'), HexColor('#1e8449')),
    'C': ('③ 確かめてExcelに出す', '金物リストを確かめて直し、Excelをダウンロードします', HexColor('#fdecea'), HexColor('#c0392b')),
}
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


c = canvas.Canvas(os.path.join(HERE, '金物リスト_アプリ説明書_ドラフト.pdf'), pagesize=(W, H))
c.setTitle('製品別金物リスト アプリ説明書(ドラフト)')
# ---- 表紙
c.setFillColor(BAND); c.rect(0, H - 110, W, 110, fill=1, stroke=0)
lw = 190; c.drawImage(LOGO, W - 30 - lw, H - 110 + (110 - lw * 400 / 1192) / 2, lw, lw * 400 / 1192, mask='auto')
c.setFillColor(INK); text(c, 40, H - 60, '製品別金物リスト(tdf)', 32, bold=True)
c.setFillColor(HexColor('#444444')); text(c, 40, H - 92, '金物リストアプリ説明書', 20)
c.setFillColor(INK)
text(c, 40, H - 142, '実寸法師の詳細図(.tdf)から、製品ごとの金物(切板・形鋼・管・スリーブ)を拾い出して表示するアプリです。', 15)
c.setFillColor(GRAY); text(c, 40, H - 166, '枚数(本数)と備考を確かめて直し、決めた様式のExcelをダウンロードします。', 13)
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
