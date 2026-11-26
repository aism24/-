# アプリ説明書(jissun-tankan-list)の作り方

起動画面の「📖 短管リストアプリ説明書」(開始後はヘッダーの「説明書」)で表示する説明書(全10ページ)の元。見た目・作り方は金物リスト(`docs/manual-draft-kanamono`)と同じ。2026-11-26 ユーザーが「今のドラフトのまま組み込んで」と承認。

- `shoot.py` … 本物の画面(`jissun-tankan-list/`)を Playwright(Python・Edge)で操作して `shots/*.png` を撮り、赤枠の位置を `rects.json` に書く。
  GAS は撮影用の返事(工事リストは見本の「26-01 ○○ビル新築工事」など。注文書はキャッシュの CSV を見本の工事番号で返す)にして、利用記録は送らない。
  フォルダ・ファイルを選ぶ画面はブラウザの外なので、選ぶ所だけ撮影用の大組図を返す。Excelダウンロードで `sample.xlsx` を保存する。
- `make_manual.py` … `shots/` と `rects.json` から PDF(`短管リスト_アプリ説明書_ドラフト.pdf`)を作る。文面・ページ構成は `pages_tankan.py`。
  Excelの見本(`shots/14_excel.png`)の上の表を切り出し、赤枠の位置もここで足す。改行は budoux。フォントは Windows ならメイリオ。

## 作り直す手順(Python の playwright・reportlab・budoux・pymupdf・Pillow、Edge、Excel)
1. 作業用のフォルダ(リポジトリの外)に、この3つの .py を写す。`make_manual.py` の `LOGO` は `docs/manual-draft/logo.png` を指すので、写した先でそのファイルを指すよう直す。
2. `jissun-tankan-list/` を作業用のフォルダに写す(説明書ボタン入りの今のアプリのまま)。
3. `python shoot.py <写したアプリ> <大組図のフォルダ> <注文書キャッシュ.csv>`(2026-11-26 は 26-12 の2節の大組図55枚・キャッシュ 26-12.csv で撮影)
4. `sample.xlsx` の1枚目のシートを Excel で PDF にし、150dpi で `shots/14_excel.png` にする(読み取り専用で開く)。
5. `python -I make_manual.py`
6. PDFを画像にして `jissun-tankan-list/manual/p-N.jpg` に置く(130dpi・JPEG 85):
   `python -I -c "import pymupdf; d=pymupdf.open('短管リスト_アプリ説明書_ドラフト.pdf'); [p.get_pixmap(dpi=130).pil_save(f'p-{i+1}.jpg', quality=85) for i,p in enumerate(d)]"`
7. ページ数が変わったら `jissun-tankan-list/app.js` の `MANUAL_PAGES` を、画像を差し替えたら `MANUAL_V` を直す。

`shots/`・`crops/`・`rects.json`・`sample.xlsx`・PDF・大組図・注文書はリポジトリに入れない(公開してよいのは確認済みの `manual/p-N.jpg` だけ)。
