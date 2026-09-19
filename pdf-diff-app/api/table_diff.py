"""
Vercel Python Serverless Function: 「表」モードのPDF比較をブラウザではなく
サーバー側でPythonのオリジナルコード(python/pdf_table_diff.py)そのまま実行する。

JS(pdf.js)への移植では文字幅推定・行クラスタリング等で本家Pythonと
細かい差異が生じることが分かったため、精度を最優先する「表」モードは
このAPI経由でオリジナルのPythonロジックをそのまま使う。

リクエスト: POST JSON { oldPdfBase64, newPdfBase64, oldPage?, newPage? }
レスポンス: JSON { oldBoxesCount, newBoxesCount, oldPngBase64, newPngBase64 }

oldPage/newPageを分けているのは、新旧でページの対応関係(挿入/削除ページの
自動検出)がずれることがあり、旧側と新側で参照すべきページ番号が異なりうる
ため(フロント側のページ整合ロジックがそれぞれ独立に決める)。

合成済み(左右並び)の画像はここでは返さない。ダウンロードPDF用の合成は、
既存のJS側composeSideBySide()にこの2枚をそのまま渡せば済むため、
Python側とJS側で同じ合成ロジックを二重に持たないようにしている。
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
    diff_boxes,
    draw_highlights,
    extract_rows,
    render_page,
)


def _png_base64(img):
    buf = io.BytesIO()
    img.save(buf, format="PNG")
    return base64.b64encode(buf.getvalue()).decode("ascii")


def run_table_diff(old_pdf_bytes, new_pdf_bytes, old_page=0, new_page=0):
    doc_old = fitz.open(stream=old_pdf_bytes, filetype="pdf")
    doc_new = fitz.open(stream=new_pdf_bytes, filetype="pdf")
    page_old = doc_old[old_page]
    page_new = doc_new[new_page]

    rows_old = extract_rows(page_old)
    rows_new = extract_rows(page_new)
    old_boxes, new_boxes = diff_boxes(rows_old, rows_new)

    img_old = draw_highlights(render_page(page_old), old_boxes, RED)
    img_new = draw_highlights(render_page(page_new), new_boxes, GREEN)

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

            result = run_table_diff(old_bytes, new_bytes, old_page, new_page)
            self._send_json(200, result)
        except Exception as e:
            self._send_json(500, {"error": str(e)})
