"""
PDF画像化ベースの新旧比較ツール(汎用)。

pdf_table_diff.py(表・グリッド構造用、テキスト抽出+行/セル比較)とは別アプローチ:
ページ全体を画像化してピクセル単位で輝度差を計算し、変化があった領域を
矩形で検出してハイライトする。文字・線・図形を区別せず「見た目が変わった
場所」を機械的に検出するだけなので、以下のようなPDFに向く。

- 図面などベクター図形主体でテキストが取れないもの
- 請求書・申請書などの定型フォーム帳票(テキストは取れるが、ラベルと値が
  レイアウト上あちこちに散らばっていて「行」「セル」という構造にならず、
  表方式・文章方式のどちらも使えないもの)

前提: 新旧PDFの用紙サイズ・縮尺・位置(レジストレーション)が揃っていること。
      ズレている場合はこの手法は使えない(誤検出が大量発生する)。

使い方:
    python pdf_image_diff.py
    python pdf_image_diff.py --old 旧.pdf --new 新.pdf --out 出力先/ファイル名
"""

import argparse
import fitz
import numpy as np
from PIL import Image, ImageDraw, ImageFont

ZOOM = 3.0
DIFF_THRESHOLD = 40    # グレースケール輝度差のこの値を超えたら「変化画素」とみなす
DILATE_ITER = 4        # 変化画素を膨張させて近傍をまとめる回数(線の分断・アンチエイリアス対策)
MIN_BLOB_PIXELS = 60   # このピクセル数未満の変化領域はノイズとして無視
PAD = 6                # 検出した矩形に足す余白(画像ピクセル、ZOOM後の座標系)

COLOR_OLD = (230, 30, 30)   # 旧側のハイライト色(赤)
COLOR_NEW = (30, 170, 60)   # 新側のハイライト色(緑)
FILL_ALPHA = 90             # 半透明フィルの不透明度(0-255)


def render_page(page):
    # get_pixmapはpage.rotationを自動的に反映するため、rotation_matrixを
    # 別途掛けると二重回転になり画像の向きが90度ズレる(rotation_matrixは
    # get_text座標をレンダリング画像空間に合わせるためのものであり、
    # get_pixmap自体には使わない)。
    pix = page.get_pixmap(matrix=fitz.Matrix(ZOOM, ZOOM), alpha=False)
    return Image.frombytes("RGB", (pix.width, pix.height), pix.samples)


def detect_diff_boxes(img_old, img_new):
    if img_old.size != img_new.size:
        raise ValueError(
            f"ページサイズが一致しません: old={img_old.size} new={img_new.size} "
            "(用紙サイズ・縮尺・位置がズレていると本手法は使えません)"
        )

    a = np.asarray(img_old.convert("L"), dtype=np.int16)
    b = np.asarray(img_new.convert("L"), dtype=np.int16)
    mask = np.abs(a - b) > DIFF_THRESHOLD

    if DILATE_ITER > 0:
        mask = binary_dilation_cross(mask, DILATE_ITER)

    boxes = []
    for x0, y0, x1, y1, blob_pixels in label_boxes(mask):
        if blob_pixels < MIN_BLOB_PIXELS:
            continue
        boxes.append((x0, y0, x1, y1))

    return boxes


# 以前はscipy.ndimage(binary_dilation/label/find_objects)を使っていたが、scipyは
# Vercel関数の同梱サイズの約半分(143MB)を占めるため、同じ計算をnumpyだけで行う
# (十字の構造要素・4近傍連結・境界外=0のscipy既定動作と、検出矩形が位置・数・
# 順序とも一致することを確認済み。2026-09-24)。


def binary_dilation_cross(mask, iterations):
    # scipy.ndimage.binary_dilation(mask, iterations=n) と同じ(上下左右に1画素ずつ膨張)
    m = mask
    for _ in range(iterations):
        d = m.copy()
        d[1:, :] |= m[:-1, :]
        d[:-1, :] |= m[1:, :]
        d[:, 1:] |= m[:, :-1]
        d[:, :-1] |= m[:, 1:]
        m = d
    return m


def label_boxes(mask):
    """4近傍連結成分ごとの (x0, y0, x1, y1, 画素数) を、scipy.ndimage.labelの
    ラベル番号順(ラスタ走査で最初に現れた順)で返す。x1/y1は範囲の終端(含まない)。
    行ごとの連続区間(ラン)を求め、上下の行で重なるラン同士をUnion-Findで結合する。"""
    h, w = mask.shape
    padded = np.zeros((h, w + 2), dtype=np.int8)
    padded[:, 1:-1] = mask
    d = np.diff(padded, axis=1)
    run_row, run_start = np.nonzero(d == 1)
    _, run_end = np.nonzero(d == -1)
    n = len(run_row)
    if n == 0:
        return []

    parent = list(range(n))

    def find(i):
        root = i
        while parent[root] != root:
            root = parent[root]
        while parent[i] != root:
            parent[i], i = root, parent[i]
        return root

    row_first = np.searchsorted(run_row, np.arange(h + 1)).tolist()
    starts, ends = run_start.tolist(), run_end.tolist()
    for r in range(1, h):
        i, i_end = row_first[r - 1], row_first[r]
        j, j_end = row_first[r], row_first[r + 1]
        while i < i_end and j < j_end:
            if starts[i] < ends[j] and starts[j] < ends[i]:
                ri, rj = find(i), find(j)
                if ri != rj:
                    # 小さい方(ラスタ順で先に現れたラン)を根にする=成分の代表がscipyのラベル順と一致
                    if ri < rj:
                        parent[rj] = ri
                    else:
                        parent[ri] = rj
            if ends[i] < ends[j]:
                i += 1
            else:
                j += 1

    roots = np.array([find(i) for i in range(n)])
    _, comp = np.unique(roots, return_inverse=True)
    k = int(comp.max()) + 1
    x0 = np.full(k, w)
    y0 = np.full(k, h)
    x1 = np.zeros(k, dtype=np.int64)
    y1 = np.zeros(k, dtype=np.int64)
    pixels = np.zeros(k, dtype=np.int64)
    np.minimum.at(x0, comp, run_start)
    np.minimum.at(y0, comp, run_row)
    np.maximum.at(x1, comp, run_end)
    np.maximum.at(y1, comp, run_row + 1)
    np.add.at(pixels, comp, run_end - run_start)
    return list(zip(x0.tolist(), y0.tolist(), x1.tolist(), y1.tolist(), pixels.tolist()))



def pad_box(box, pad, w, h):
    x0, y0, x1, y1 = box
    return (
        max(0, x0 - pad),
        max(0, y0 - pad),
        min(w, x1 + pad),
        min(h, y1 + pad),
    )


def draw_highlights(img, boxes, color):
    out = img.copy()
    draw = ImageDraw.Draw(out, "RGBA")
    w, h = out.size
    for box in boxes:
        x0, y0, x1, y1 = pad_box(box, PAD, w, h)
        draw.rectangle([x0, y0, x1, y1], fill=(*color, FILL_ALPHA))
    return out


def compose_side_by_side(img_old, img_new, n_diff):
    gap = 24
    header_h = 70
    w = img_old.width + img_new.width + gap
    h = header_h + max(img_old.height, img_new.height)

    canvas = Image.new("RGB", (w, h), "white")
    draw = ImageDraw.Draw(canvas)

    try:
        font = ImageFont.truetype("meiryo.ttc", 28)
        font_small = ImageFont.truetype("meiryo.ttc", 20)
    except OSError:
        font = ImageFont.load_default()
        font_small = font

    draw.text((20, 12), "旧", fill=COLOR_OLD, font=font)
    draw.text((img_old.width + gap + 20, 12), "新", fill=COLOR_NEW, font=font)
    legend = f"検出された差分領域: {n_diff}件   赤色塗り=変更前(旧)   緑色塗り=変更後(新)"
    draw.text((20, 44), legend, fill=(60, 60, 60), font=font_small)

    canvas.paste(img_old, (0, header_h))
    canvas.paste(img_new, (img_old.width + gap, header_h))
    return canvas


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--old", default="旧図.pdf")
    ap.add_argument("--new", default="新図.pdf")
    ap.add_argument("--out", default="diff_image_side_by_side")
    ap.add_argument("--page", type=int, default=0)
    args = ap.parse_args()

    doc_old = fitz.open(args.old)
    doc_new = fitz.open(args.new)
    page_old = doc_old[args.page]
    page_new = doc_new[args.page]

    img_old = render_page(page_old)
    img_new = render_page(page_new)

    boxes = detect_diff_boxes(img_old, img_new)
    print(f"検出された差分領域: {len(boxes)}件")

    hi_old = draw_highlights(img_old, boxes, COLOR_OLD)
    hi_new = draw_highlights(img_new, boxes, COLOR_NEW)

    composed = compose_side_by_side(hi_old, hi_new, len(boxes))

    png_path = args.out + ".png"
    pdf_path = args.out + ".pdf"
    composed.save(png_path)
    save_as_pdf(composed, pdf_path)
    print(f"出力: {png_path}")
    print(f"出力: {pdf_path}")


def save_as_pdf(img, pdf_path):
    # Pillow経由のPDF保存はJPEGエンコーダ依存で環境によって失敗するため、
    # PyMuPDFで画像をそのままページに埋め込んでPDF化する。
    import io
    buf = io.BytesIO()
    img.save(buf, format="PNG")
    doc = fitz.open()
    page = doc.new_page(width=img.width, height=img.height)
    page.insert_image(page.rect, stream=buf.getvalue())
    doc.save(pdf_path)


if __name__ == "__main__":
    main()
