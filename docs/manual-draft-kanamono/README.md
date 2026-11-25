# アプリ説明書(tdf-kanamono-list)の作り方

起動画面の「📖 金物リストアプリ説明書」(開始後はヘッダーの「説明書」)で表示する説明書(全13ページ。金物リスト単体の使い方だけ。次の加工予定は載せない=2026-11-26 ユーザー指示)の元。見た目は spl-sheet-web・tdf-dim-count の手順書と同じ。

- `shoot.js` … 本物の画面(`tdf-kanamono-list/`)を Playwright で操作して `shots/*.png` を撮り、赤枠の位置を `rects.json` に書く。
  GAS は撮影用の返事(工事リストは見本の「○○ビル新築工事」など。注文書は test-tdf の模擬データを見本の工事名で返す)にして、利用記録は送らない。
  Excelダウンロード後の注意のポップアップ(12_link)と、リセットの確認(13_reset。「やめる」で閉じる)も撮る。注文書をどこから読んでいるか(サーバーのフォルダ)は説明書に書かない(2026-11-26 ユーザー指示)。フォルダ・ファイルを選ぶ画面はブラウザの外なので、選ぶ所だけ撮影用の図面を返す。図面の工事名は見本の名前に置き換えて写す。
- `make_manual.py` … `shots/` と `rects.json` から PDF(`金物リスト_アプリ説明書_ドラフト.pdf`)を作る。文面・ページ構成は冒頭の `pages`。
  改行は budoux(文節の途中で改行しない)。フォントは Windows ならメイリオ、それ以外は IPAゴシック(引数で変えられる)。

## 作り直す手順(node の playwright、Python の reportlab・budoux・pymupdf・Pillow)
1. 作業用のフォルダ(リポジトリの外)に `shoot.js`・`make_manual.py` を写し、`docs/manual-draft/logo.png` も同じフォルダに写して `make_manual.py` の `LOGO` をそのファイルにする。
2. `node shoot.js <aism24/- の場所>/tdf-kanamono-list <aism24/test-tdf の場所>/kanamono/fixtures <aism24/test-tdf の場所>/kanamono/orders-26-16.json`(撮影に使う図面は EA1-3B-04・EA1-RG-01。注文書の模擬データは NB32 の手配総数が 3 なので、赤(不足)の例が写る)
3. `python3 -I make_manual.py`
4. PDFを画像にして `tdf-kanamono-list/manual/p-N.jpg` に置く(130dpi・JPEG 85):
   `python3 -I -c "import pymupdf; d=pymupdf.open('金物リスト_アプリ説明書_ドラフト.pdf'); [p.get_pixmap(dpi=130).pil_save(f'p-{i+1}.jpg', quality=85) for i,p in enumerate(d)]"`
5. ページ数が変わったら `tdf-kanamono-list/app.js` の `MANUAL_PAGES` を、画像を差し替えたら `MANUAL_V` を直す。

`shots/`・`crops/`・`rects.json`・PDF・図面はリポジトリに入れない(公開してよいのは確認済みの `manual/p-N.jpg` だけ)。
