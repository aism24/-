"""
Vercel Python Serverless Function: 表/文章/図面の3モードのPDF比較を1本の関数で
サーバー側実行する(python/配下のオリジナルコードをそのまま呼び出す)。

以前はモードごとに api/table_diff.py・text_diff.py・image_diff.py の3関数に
分けていたが、Vercelは関数ごとに依存パッケージ一式(約300MB)を同梱するため、
1デプロイでFunctions Storage(Hobby上限10GB)を約1GB消費していた。1本に統合して
同梱を1回分にしている(2026-09-24)。

リクエスト: POST /api/diff?mode=table|text|image
            JSON { oldPdfBase64, newPdfBase64, oldPage?, newPage? }
レスポンス: JSON { oldBoxesCount, newBoxesCount, oldPngBase64, newPngBase64 }
エラー時は { error } をステータス400/500で返す(メッセージはそのままフロントへ表示)。
"""

import base64
import io
import json
import sys
from http.server import BaseHTTPRequestHandler
from pathlib import Path
from urllib.parse import parse_qs, urlparse

sys.path.insert(0, str(Path(__file__).parent.parent / "python"))

import fitz  # PyMuPDF


def _png_base64(img):
    buf = io.BytesIO()
    img.save(buf, format="PNG")
    return base64.b64encode(buf.getvalue()).decode("ascii")


def _open_pages(old_pdf_bytes, new_pdf_bytes, old_page, new_page):
    doc_old = fitz.open(stream=old_pdf_bytes, filetype="pdf")
    doc_new = fitz.open(stream=new_pdf_bytes, filetype="pdf")
    return doc_old[old_page], doc_new[new_page]


def _result(old_count, new_count, img_old, img_new):
    return {
        "oldBoxesCount": old_count,
        "newBoxesCount": new_count,
        "oldPngBase64": _png_base64(img_old),
        "newPngBase64": _png_base64(img_new),
    }


def run_table_diff(page_old, page_new):
    from pdf_table_diff import RED, GREEN, diff_boxes, draw_highlights, extract_rows, render_page

    old_boxes, new_boxes = diff_boxes(extract_rows(page_old), extract_rows(page_new))
    img_old = draw_highlights(render_page(page_old), old_boxes, RED)
    img_new = draw_highlights(render_page(page_new), new_boxes, GREEN)
    return _result(len(old_boxes), len(new_boxes), img_old, img_new)


def run_text_diff(page_old, page_new):
    from pdf_text_diff import COLOR_NEW, COLOR_OLD, diff_chars, draw_fill, extract_chars, render_page

    old_boxes, new_boxes = diff_chars(extract_chars(page_old), extract_chars(page_new))
    img_old = draw_fill(render_page(page_old), old_boxes, COLOR_OLD)
    img_new = draw_fill(render_page(page_new), new_boxes, COLOR_NEW)
    return _result(len(old_boxes), len(new_boxes), img_old, img_new)


def run_image_diff(page_old, page_new):
    # pdf_image_diff.pyは新旧ページの画像サイズが一致することを前提とする
    # (ズレていると detect_diff_boxes が例外を送出し、そのメッセージをフロントへ返す)。
    from pdf_image_diff import COLOR_NEW, COLOR_OLD, detect_diff_boxes, draw_highlights, render_page

    img_old = render_page(page_old)
    img_new = render_page(page_new)
    boxes = detect_diff_boxes(img_old, img_new)
    hi_old = draw_highlights(img_old, boxes, COLOR_OLD)
    hi_new = draw_highlights(img_new, boxes, COLOR_NEW)
    return _result(len(boxes), len(boxes), hi_old, hi_new)


RUNNERS = {"table": run_table_diff, "text": run_text_diff, "image": run_image_diff}


def run_diff(mode, old_pdf_bytes, new_pdf_bytes, old_page=0, new_page=0):
    page_old, page_new = _open_pages(old_pdf_bytes, new_pdf_bytes, old_page, new_page)
    return RUNNERS[mode](page_old, page_new)


class handler(BaseHTTPRequestHandler):
    def _send_json(self, status, payload):
        body = json.dumps(payload).encode("utf-8")
        self.send_response(status)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def do_POST(self):
        mode = parse_qs(urlparse(self.path).query).get("mode", [""])[0]
        if mode not in RUNNERS:
            self._send_json(400, {"error": f"不明なmodeです: {mode!r}(table/text/imageのいずれか)"})
            return
        try:
            length = int(self.headers.get("Content-Length", 0))
            payload = json.loads(self.rfile.read(length))

            old_bytes = base64.b64decode(payload["oldPdfBase64"])
            new_bytes = base64.b64decode(payload["newPdfBase64"])
            old_page = int(payload.get("oldPage", 0))
            new_page = int(payload.get("newPage", 0))

            self._send_json(200, run_diff(mode, old_bytes, new_bytes, old_page, new_page))
        except Exception as e:
            self._send_json(500, {"error": str(e)})
