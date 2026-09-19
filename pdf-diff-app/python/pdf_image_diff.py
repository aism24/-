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
from scipy import ndimage

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
        mask = ndimage.binary_dilation(mask, iterations=DILATE_ITER)

    labeled, num = ndimage.label(mask)
    boxes = []
    if num == 0:
        return boxes

    slices = ndimage.find_objects(labeled)
    for label_id, sl in enumerate(slices, start=1):
        if sl is None:
            continue
        blob_pixels = int((labeled[sl] == label_id).sum())
        if blob_pixels < MIN_BLOB_PIXELS:
            continue
        y0, y1 = sl[0].start, sl[0].stop
        x0, x1 = sl[1].start, sl[1].stop
        boxes.append((x0, y0, x1, y1))

    return boxes


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
