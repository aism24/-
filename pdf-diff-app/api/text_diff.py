"""
Vercel Python Serverless Function: 「文章」モードのPDF比較をサーバー側で
Pythonのオリジナルコード(python/pdf_text_diff.py)そのまま実行する。

リクエスト: POST JSON { oldPdfBase64, newPdfBase64, oldPage?, newPage? }
レスポンス: JSON { oldBoxesCount, newBoxesCount, oldPngBase64, newPngBase64 }
"""

import base64
import io
import json
import sys
from http.server import BaseHTTPRequestHandler
from pathlib import Path

sys.path.insert(0, str(Path(__file__).parent.parent / "python"))

import fitz  # PyMuPDF
from pdf_text_diff import (
    COLOR_NEW,
    COLOR_OLD,
    diff_chars,
    draw_fill,
    extract_chars,
    render_page,
)


def _png_base64(img):
    buf = io.BytesIO()
    img.save(buf, format="PNG")
    return base64.b64encode(buf.getvalue()).decode("ascii")


def run_text_diff(old_pdf_bytes, new_pdf_bytes, old_page=0, new_page=0):
    doc_old = fitz.open(stream=old_pdf_bytes, filetype="pdf")
    doc_new = fitz.open(stream=new_pdf_bytes, filetype="pdf")
    page_old = doc_old[old_page]
    page_new = doc_new[new_page]

    chars_old = extract_chars(page_old)
    chars_new = extract_chars(page_new)
    old_boxes, new_boxes = diff_chars(chars_old, chars_new)

    img_old = draw_fill(render_page(page_old), old_boxes, COLOR_OLD)
    img_new = draw_fill(render_page(page_new), new_boxes, COLOR_NEW)

    return {
        "oldBoxesCount": len(old_boxes),
        "newBoxesCount": len(new_boxes),
        "oldPngBase64": _png_base64(img_old),
        "newPngBase64": _png_base64(img_new),
    }


class handler(BaseHTTPRequestHandler):
    def _send_json(self, status, payload):
        body = json.dumps(payload).encode("utf-8")
        self.send_response(status)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def do_POST(self):
        try:
            length = int(self.headers.get("Content-Length", 0))
            body = self.rfile.read(length)
            payload = json.loads(body)

            old_bytes = base64.b64decode(payload["oldPdfBase64"])
            new_bytes = base64.b64decode(payload["newPdfBase64"])
            old_page = int(payload.get("oldPage", 0))
            new_page = int(payload.get("newPage", 0))

            result = run_text_diff(old_bytes, new_bytes, old_page, new_page)
            self._send_json(200, result)
        except Exception as e:
            self._send_json(500, {"error": str(e)})
