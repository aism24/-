# -*- coding: utf-8 -*-
"""
文章主体PDF(契約書・規程類など)の新旧比較ツール。

pdf_table_diff.py(表・グリッド構造用)、pdf_image_diff.py(図面・帳票のピクセル差分用)
とは別アプローチ:
表と違い「同じ行位置=同じ内容」という前提が使えないため(1文字の増減で
以降の行がすべてズレる)、ページ内の文字を1つの文字列として抽出し、
difflibで文書全体を比較する。日本語は分かち書きが無いため、単語単位ではなく
1文字単位でSequenceMatcherにかけることで、文中の一部分だけの変更でも
ピンポイントに検出できる。

表示: 削除された文字(旧側)を赤の半透明フィル、追加された文字(新側)を
緑の半透明フィルで塗りつぶす。

前提: 新旧PDFの用紙サイズ・レイアウトが概ね揃っていること
      (段組みが大きく変わる等、抽出した文字の読み順自体が入れ替わるケースは
      想定していない)。

使い方:
    python pdf_text_diff.py
    python pdf_text_diff.py --old 旧.pdf --new 新.pdf --out 出力先/ファイル名
"""

import argparse
import difflib
import io

import fitz
from PIL import Image, ImageDraw, ImageFont

ZOOM = 3.0
ROW_Y_TOLERANCE = 3.0    # 同じ行とみなすy座標の許容誤差(pt)
GROUP_Y_TOLERANCE = 2.0  # ハイライト連結時に「同じ行」とみなすy座標許容誤差(pt)

COLOR_OLD = (220, 30, 30)  # 旧側(削除)の色: 赤
COLOR_NEW = (30, 150, 60)  # 新側(追加)の色: 緑
FILL_ALPHA = 90            # 半透明フィルの不透明度(0-255)


def extract_chars(page):
    """ページ内の全文字を座標付きで抽出し、読み順(上→下、行内は左→右)に並べて返す。

    戻り値: [ (x0, y0, x1, y1, char), ... ]
    座標は page.rotation_matrix 適用後(=レンダリング画像と同じ向き)。
    """
    d = page.get_text("rawdict")
    M = page.rotation_matrix
    items = []
    for block in d["blocks"]:
        if block.get("type") != 0:  # 画像ブロックなどは除外
            continue
        for line in block["lines"]:
            for span in line["spans"]:
                for ch in span["chars"]:
                    r = fitz.Rect(ch["bbox"]) * M
                    items.append((r.y0, r.x0, r.x1, r.y1, ch["c"]))

    items.sort(key=lambda t: (t[0], t[1]))

    # 行クラスタリング(pdf_table_diff.pyのextract_rowsと同じ考え方)
    rows, cur, cur_y = [], [], None
    for it in items:
        y0 = it[0]
        if cur_y is None or abs(y0 - cur_y) <= ROW_Y_TOLERANCE:
            cur.append(it)
            cur_y = cur_y if cur_y is not None else y0
        else:
            rows.append(cur)
            cur = [it]
            cur_y = y0
    if cur:
        rows.append(cur)

    result = []
    for row in rows:
        row_sorted = sorted(row, key=lambda t: t[1])
        for (y0, x0, x1, y1, c) in row_sorted:
            result.append((x0, y0, x1, y1, c))
    return result


def group_consecutive(chars, indices):
    """連続したindex(かつ同じ行)をグループ化する。"""
    groups = []
    cur = []
    for idx in indices:
        if cur and idx == cur[-1] + 1 and abs(chars[idx][1] - chars[cur[-1]][1]) <= GROUP_Y_TOLERANCE:
            cur.append(idx)
        else:
            if cur:
                groups.append(cur)
            cur = [idx]
    if cur:
        groups.append(cur)
    return groups


def diff_chars(old_chars, new_chars):
    """文字列全体をdifflibで比較し、旧側・新側それぞれのハイライト対象box一覧を返す。

    戻り値: (old_boxes, new_boxes) 各要素は (x0, y0, x1, y1)
    """
    old_text = "".join(c[4] for c in old_chars)
    new_text = "".join(c[4] for c in new_chars)

    sm = difflib.SequenceMatcher(None, old_text, new_text, autojunk=False)

    old_idx, new_idx = [], []
    for tag, i1, i2, j1, j2 in sm.get_opcodes():
        if tag == "equal":
            continue
        if tag in ("delete", "replace"):
            old_idx.extend(range(i1, i2))
        if tag in ("insert", "replace"):
            new_idx.extend(range(j1, j2))

    def to_boxes(chars, idx_list):
        boxes = []
        for group in group_consecutive(chars, idx_list):
            xs0 = [chars[i][0] for i in group]
            ys0 = [chars[i][1] for i in group]
            xs1 = [chars[i][2] for i in group]
            ys1 = [chars[i][3] for i in group]
            boxes.append((min(xs0), min(ys0), max(xs1), max(ys1)))
        return boxes

    return to_boxes(old_chars, old_idx), to_boxes(new_chars, new_idx)


def render_page(page):
    pix = page.get_pixmap(matrix=fitz.Matrix(ZOOM, ZOOM), alpha=False)
    return Image.frombytes("RGB", (pix.width, pix.height), pix.samples)


def draw_fill(img, boxes, color, pad=1):
    """変更範囲の文字bboxを半透明フィルで塗りつぶす。"""
    draw = ImageDraw.Draw(img, "RGBA")
    for (x0, y0, x1, y1) in boxes:
        X0, Y0 = x0 * ZOOM - pad, y0 * ZOOM - pad
        X1, Y1 = x1 * ZOOM + pad, y1 * ZOOM + pad
        draw.rectangle([X0, Y0, X1, Y1], fill=(*color, FILL_ALPHA))
    return img


def compose_side_by_side(img_old, img_new, n_old, n_new):
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
    legend = f"削除{n_old}箇所(赤色塗り)   追加{n_new}箇所(緑色塗り)"
    draw.text((20, 44), legend, fill=(60, 60, 60), font=font_small)

    canvas.paste(img_old, (0, header_h))
    canvas.paste(img_new, (img_old.width + gap, header_h))
    return canvas


def save_as_pdf(img, pdf_path):
    buf = io.BytesIO()
    img.save(buf, format="PNG")
    doc = fitz.open()
    page = doc.new_page(width=img.width, height=img.height)
    page.insert_image(page.rect, stream=buf.getvalue())
    doc.save(pdf_path)


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--old", default="旧.pdf")
    ap.add_argument("--new", default="新.pdf")
    ap.add_argument("--out", default="diff_text_side_by_side")
    ap.add_argument("--page", type=int, default=0)
    args = ap.parse_args()

    doc_old = fitz.open(args.old)
    doc_new = fitz.open(args.new)
    page_old = doc_old[args.page]
    page_new = doc_new[args.page]

    chars_old = extract_chars(page_old)
    chars_new = extract_chars(page_new)

    old_boxes, new_boxes = diff_chars(chars_old, chars_new)
    print(f"削除(旧側): {len(old_boxes)}箇所 / 追加(新側): {len(new_boxes)}箇所")

    img_old = render_page(page_old)
    img_new = render_page(page_new)
    draw_fill(img_old, old_boxes, COLOR_OLD)
    draw_fill(img_new, new_boxes, COLOR_NEW)

    composed = compose_side_by_side(img_old, img_new, len(old_boxes), len(new_boxes))

    png_path = args.out + ".png"
    pdf_path = args.out + ".pdf"
    composed.save(png_path)
    save_as_pdf(composed, pdf_path)
    print(f"出力: {png_path}")
    print(f"出力: {pdf_path}")


if __name__ == "__main__":
    main()
