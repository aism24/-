# アプリ説明書(spl-sheet-web)の作り方

画面左上の「📖 アプリ説明書」で表示する説明書(全14ページ)の元。見た目は tdf-dim-count の手順書(`docs/manual-draft`)と同じ。

- `shoot.py` … 本物の画面(`spl-sheet-web/`)を Chrome(Playwright)で操作して `shots/*.png` を撮り、赤枠の位置を `rects.json` に書く。
  ファイルを選ぶ画面はブラウザの外なので、選ぶ所だけ `data/` の撮影用データを返す。GAS は本物を使う(利用記録に「アプリを開いた」が1行入る。Excelダウンロードは押さない)。
- `make_manual.py` … `shots/` と `rects.json` から PDF(`SPLシート作成_アプリ説明書_ドラフト.pdf`)を作る。文面・ページ構成は冒頭の `pages`。ダイアログは枠の周りだけ切り出す。
  フォントは Windows のメイリオ、改行は budoux(文節の途中で改行しない)。

## 作り直す手順(Windows・Python に playwright・reportlab・budoux・pymupdf)
1. `data/` を用意する(**リポジトリに入れない**): 入力データーの .xlsm の写し(撮影時は 26-14、「違い」の例のため写しの SPL!G5 を 530→520)、
   `data/N/`・`data/S/` に N棟・S棟の継手基準図(.tdf)、`data/list.json` = `{"excel": ファイル名, "N": [...], "S": [...]}`。
2. `python -I -X utf8 shoot.py` → `python -I -X utf8 make_manual.py`
3. PDFを画像にして `spl-sheet-web/manual/p-N.jpg` に置く(130dpi・JPEG 85):
   `python -I -c "import fitz; d=fitz.open('SPLシート作成_アプリ説明書_ドラフト.pdf'); [p.get_pixmap(dpi=130).pil_save(f'../../spl-sheet-web/manual/p-{i+1}.jpg', quality=85) for i,p in enumerate(d)]"`
4. ページ数が変わったら `spl-sheet-web/app.js` の `MANUAL_PAGES` を、画像を差し替えたら `showManualPage` の `?v=` を直す。

`shots/`・`crops/`・`rects.json`・`data/`・PDF はリポジトリに入れない(画面に工事のデータが写るため。公開してよいのは添削済みの `manual/p-N.jpg` だけ)。
