"""
Vercel Python Serverless Function: 「図面」モードのPDF比較をサーバー側で
Pythonのオリジナルコード(python/pdf_image_diff.py)そのまま実行する。

リクエスト: POST JSON { oldPdfBase64, newPdfBase64, oldPage?, newPage? }
レスポンス: JSON { oldBoxesCount, newBoxesCount, oldPngBase64, newPngBase64 }

pdf_image_diff.pyは新旧ページの画像サイズが一致することを前提とする
(用紙サイズ・縮尺・位置がズレていると detect_diff_boxes が例外を送出する)。
そのエラーメッセージはそのままJSON応答のerrorに載せてフロントへ返す。
"""

import base64
import io
import json
import sys
from http.server import BaseHTTPRequestHandler
from pathlib import Path

sys.path.insert(0, str(Path(__file__).parent.parent / "python"))

import fitz  # PyMuPDF
from pdf_image_diff import (
    COLOR_NEW,
    COLOR_OLD,
    detect_diff_boxes,
    draw_highlights,
    render_page,
)


def _png_base64(img):
    buf = io.BytesIO()
    img.save(buf, format="PNG")
    return base64.b64encode(buf.getvalue()).decode("ascii")


def run_image_diff(old_pdf_bytes, new_pdf_bytes, old_page=0, new_page=0):
    doc_old = fitz.open(stream=old_pdf_bytes, filetype="pdf")
    doc_new = fitz.open(stream=new_pdf_bytes, filetype="pdf")
    page_old = doc_old[old_page]
    page_new = doc_new[new_page]

    img_old = render_page(page_old)
    img_new = render_page(page_new)
    boxes = detect_diff_boxes(img_old, img_new)

    hi_old = draw_highlights(img_old, boxes, COLOR_OLD)
    hi_new = draw_highlights(img_new, boxes, COLOR_NEW)

    return {
        "oldBoxesCount": len(boxes),
        "newBoxesCount": len(boxes),
        "oldPngBase64": _png_base64(hi_old),
        "newPngBase64": _png_base64(hi_new),
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

            result = run_image_diff(old_bytes, new_bytes, old_page, new_page)
            self._send_json(200, result)
        except Exception as e:
            self._send_json(500, {"error": str(e)})
