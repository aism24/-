# py/ — 長さを tdf-master-web と同じ方法で求めるための Python(写し)

- `tdf-master-web/index.html` の `<script id="py-…" type="text/python-src">` の中身を、そのままファイルにしたもの(2026-11-20、main d9693a3 時点)。**ここでは編集しない。**
- 金物リストは、TDFを取り込むときにブラウザ内の Python(Pyodide 0.26.4、tdf-master-web と同じ版)で `tdf_app.extract_file()` を動かし、製品ごとの「長さ」だけを使う(製品名で対応させる)。
- tdf-master-web の長さの読み方が直ったら、同じ手順でここを写し直す(取り出し方は docs/apps/tdf-kanamono-list.md)。
