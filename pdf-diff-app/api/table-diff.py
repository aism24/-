"""
Vercel Python Serverless Function: 「表」モードのPDF比較をブラウザではなく
サーバー側でPythonのオリジナルコード(python/pdf_table_diff.py)そのまま実行する。

JS(pdf.js)への移植では文字幅推定・行クラスタリング等で本家Pythonと
細かい差異が生じることが分かったため、精度を最優先する「表」モードは
このAPI経由でオリジナルのPythonロジックをそのまま使う。

リクエスト: POST JSON { oldPdfBase64, newPdfBase64, page? }
レスポンス: JSON { oldBoxesCount, newBoxesCount, pngBase64 }
"""

import base64
import io
import json
import sys
from http.server import BaseHTTPRequestHandler
from pathlib import Path

sys.path.insert(0, str(Path(__file__).parent.parent / "python"))

import fitz  # PyMuPDF
from pdf_table_diff import (
    RED,
    GREEN,
    compose_side_by_side,
    diff_boxes,
    draw_highlights,
    extract_rows,
    render_page,
)


def run_table_diff(old_pdf_bytes, new_pdf_bytes, page_no=0):
    doc_old = fitz.open(stream=old_pdf_bytes, filetype="pdf")
    doc_new = fitz.open(stream=new_pdf_bytes, filetype="pdf")
    page_old = doc_old[page_no]
    page_new = doc_new[page_no]

    rows_old = extract_rows(page_old)
    rows_new = extract_rows(page_new)
    old_boxes, new_boxes = diff_boxes(rows_old, rows_new)

    img_old = render_page(page_old)
    img_new = render_page(page_new)
    img_old = draw_highlights(img_old, old_boxes, RED)
    img_new = draw_highlights(img_new, new_boxes, GREEN)
    canvas = compose_side_by_side(img_old, img_new)

    png_buf = io.BytesIO()
    canvas.save(png_buf, format="PNG")

    return {
        "oldBoxesCount": len(old_boxes),
        "newBoxesCount": len(new_boxes),
        "pngBase64": base64.b64encode(png_buf.getvalue()).decode("ascii"),
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
            page_no = int(payload.get("page", 0))

            result = run_table_diff(old_bytes, new_bytes, page_no)
            self._send_json(200, result)
        except Exception as e:
            self._send_json(500, {"error": str(e)})
