# -*- coding: utf-8 -*-
"""
PDF表(一覧表)の新旧比較ツール

old.pdf と new.pdf(同一レイアウトの表形式PDF)を行・セル単位で比較し、
変更箇所だけを色付けして左(旧)・右(新)に並べた画像/PDFを出力する。

前提:
- 2つのPDFは同じ表構成(同じ行数・同じ列構成)であること。
- 行の挿入/削除ではなく、セルの値変更を比較する用途向け。

使い方:
    python pdf_table_diff.py
    (このファイルと同じフォルダの old.pdf / new.pdf を比較し、
     diff_side_by_side.png / diff_side_by_side.pdf を書き出す)

    パスを指定する場合:
    python pdf_table_diff.py --old path/to/old.pdf --new path/to/new.pdf --out path/to/output
"""

import argparse
import difflib
from pathlib import Path

import fitz  # PyMuPDF
from PIL import Image, ImageDraw, ImageFont

ZOOM = 4.0  # レンダリング解像度倍率(大きいほど高精細・重い)
ROW_Y_TOLERANCE = 3.0  # 同じ行とみなすy座標の許容誤差(pt)
RED = (230, 30, 30)    # 旧側ハイライト色
GREEN = (0, 150, 60)   # 新側ハイライト色


def extract_rows(page):
    """ページ内の単語を座標付きで抽出し、行単位にクラスタリングして返す。

    戻り値: [ [ (x0, y0, x1, y1, text), ... ], ... ]  (行ごとにx昇順)
    座標は page.rotation_matrix 適用後(=レンダリング画像と同じ向き)。
    """
    words = page.get_text("words")  # (x0, y0, x1, y1, text, block, line, word_no)
    M = page.rotation_matrix
    items = []
    for w in words:
        r = fitz.Rect(w[:4]) * M
        items.append((r.y0, r.x0, r.x1, r.y1, w[4]))
    items.sort(key=lambda t: (t[0], t[1]))

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

    # 各行内をx昇順(左→右のセル順)に並べ替え、(x0,y0,x1,y1,text)の形に整形
    result = []
    for row in rows:
        row_sorted = sorted(row, key=lambda t: t[1])
        result.append([(x0, y0, x1, y1, text) for (y0, x0, x1, y1, text) in row_sorted])
    return result


def diff_boxes(old_rows_all, new_rows_all, skip_header_rows=1):
    """行単位・トークン単位で差分を検出し、旧/新それぞれのハイライト対象box一覧を返す。

    戻り値: (old_boxes, new_boxes)  各要素は (x0, y0, x1, y1)
    """
    old_rows = old_rows_all[skip_header_rows:]
    new_rows = new_rows_all[skip_header_rows:]

    old_sig = [" ".join(w[4] for w in r) for r in old_rows]
    new_sig = [" ".join(w[4] for w in r) for r in new_rows]

    sm = difflib.SequenceMatcher(None, old_sig, new_sig, autojunk=False)

    old_boxes, new_boxes = [], []

    for tag, i1, i2, j1, j2 in sm.get_opcodes():
        if tag == "equal":
            continue

        if tag == "replace" and (i2 - i1) == (j2 - j1):
            # 行数が同じ置換 -> 行を1:1対応させてセル(トークン)単位で比較
            for oi, ni in zip(range(i1, i2), range(j1, j2)):
                orow, nrow = old_rows[oi], new_rows[ni]
                otok = [w[4] for w in orow]
                ntok = [w[4] for w in nrow]
                tsm = difflib.SequenceMatcher(None, otok, ntok, autojunk=False)
                for ttag, a1, a2, b1, b2 in tsm.get_opcodes():
                    if ttag == "equal":
                        continue
                    for k in range(a1, a2):
                        w = orow[k]
                        old_boxes.append((w[0], w[1], w[2], w[3]))
                    for k in range(b1, b2):
                        w = nrow[k]
                        new_boxes.append((w[0], w[1], w[2], w[3]))
        else:
            # 行数が異なる置換・挿入・削除 -> 行まるごとハイライト
            for oi in range(i1, i2):
                for w in old_rows[oi]:
                    old_boxes.append((w[0], w[1], w[2], w[3]))
            for ni in range(j1, j2):
                for w in new_rows[ni]:
                    new_boxes.append((w[0], w[1], w[2], w[3]))

    return old_boxes, new_boxes


def render_page(page, zoom=ZOOM):
    pix = page.get_pixmap(matrix=fitz.Matrix(zoom, zoom), alpha=False)
    return Image.frombytes("RGB", (pix.width, pix.height), pix.samples)


def draw_highlights(img, boxes, color, zoom=ZOOM, pad=2):
    draw = ImageDraw.Draw(img, "RGBA")
    for (x0, y0, x1, y1) in boxes:
        X0, Y0 = x0 * zoom - pad, y0 * zoom - pad
        X1, Y1 = x1 * zoom + pad, y1 * zoom + pad
        draw.rectangle([X0, Y0, X1, Y1], fill=(*color, 90))
    return img


def load_cjk_font(size=48):
    candidates = [
        r"C:\Windows\Fonts\meiryo.ttc",
        r"C:\Windows\Fonts\YuGothM.ttc",
        r"C:\Windows\Fonts\msgothic.ttc",
    ]
    for fp in candidates:
        try:
            return ImageFont.truetype(fp, size)
        except Exception:
            continue
    return ImageFont.load_default()


def compose_side_by_side(img_old, img_new, old_label="旧 (OLD)", new_label="新 (NEW)"):
    w, h = img_old.size
    header_h = 90
    gap = 20
    canvas = Image.new("RGB", (w * 2 + gap, h + header_h), (255, 255, 255))

    draw = ImageDraw.Draw(canvas)
    draw.rectangle([0, 0, w, header_h], fill=(255, 235, 235))
    draw.rectangle([w + gap, 0, w * 2 + gap, header_h], fill=(230, 245, 235))

    font = load_cjk_font(48)
    draw.text((30, 20), f"{old_label} ※赤塗り=変更前の値", fill=(180, 0, 0), font=font)
    draw.text((w + gap + 30, 20), f"{new_label} ※緑塗り=変更後の値", fill=(0, 110, 40), font=font)

    canvas.paste(img_old, (0, header_h))
    canvas.paste(img_new, (w + gap, header_h))
    draw.line([(w + gap // 2, 0), (w + gap // 2, canvas.height)], fill=(120, 120, 120), width=3)
    return canvas


def main():
    here = Path(__file__).parent
    parser = argparse.ArgumentParser(description="PDF表の新旧比較(セル単位ハイライト)")
    parser.add_argument("--old", default=str(here / "old.pdf"))
    parser.add_argument("--new", default=str(here / "new.pdf"))
    parser.add_argument("--out", default=str(here / "diff_side_by_side"),
                         help="出力ファイルの拡張子なしパス(.png/.pdfが付加される)")
    parser.add_argument("--page", type=int, default=0, help="比較するページ番号(0始まり)")
    args = parser.parse_args()

    doc_old = fitz.open(args.old)
    doc_new = fitz.open(args.new)
    page_old = doc_old[args.page]
    page_new = doc_new[args.page]

    rows_old = extract_rows(page_old)
    rows_new = extract_rows(page_new)

    old_boxes, new_boxes = diff_boxes(rows_old, rows_new)
    print(f"差分検出: 旧側 {len(old_boxes)}箇所 / 新側 {len(new_boxes)}箇所")

    img_old = render_page(page_old)
    img_new = render_page(page_new)
    img_old = draw_highlights(img_old, old_boxes, RED)
    img_new = draw_highlights(img_new, new_boxes, GREEN)

    canvas = compose_side_by_side(img_old, img_new)

    out_png = Path(args.out).with_suffix(".png")
    out_pdf = Path(args.out).with_suffix(".pdf")
    canvas.save(out_png)
    canvas.save(out_pdf, "PDF", resolution=200.0)
    print(f"保存しました: {out_png}")
    print(f"保存しました: {out_pdf}")


if __name__ == "__main__":
    main()
