# 手順書(tdf-dim-count)の作り方

アプリ右上の「操作・準備説明書」ボタンで表示する手順書(全8ページ)の元データ。

- `make_manual.py` … PDF(`手順書_ドラフト.pdf`)を作るスクリプト。文面・ページ構成は冒頭の `pages` に書いてある。
- `media/image1〜14.png` … 元のExcel(ユーザー作成)から取り出したスクリーンショット。
- `logo.svg` / `logo.png` … 表紙のロゴ(アプリのヘッダーと同じ。PNGは背景透明)。

## 作り直す手順
1. `python3 -I make_manual.py`(reportlab と PIL、IPAゴシック `/usr/share/fonts/opentype/ipafont-gothic/ipag.ttf` が必要)
2. PDFを画像にして、アプリ用の `tdf-dim-count/manual/` に置く:
   `pdftoppm -jpeg -jpegopt quality=85 -r 130 手順書_ドラフト.pdf ../../tdf-dim-count/manual/p`
3. ページ数が変わったら、`tdf-dim-count/index.html` 末尾のスクリプトの `N` を直す。
4. mainへマージ後、「デプロイして」で本番へ反映(画像も本番に含まれる)。

ロゴPNGを作り直す場合は、アプリのヘッダーのHTML(緑帯+マーク+「株式会社 正光」+青帯)をPlaywrightで `omitBackground` スクリーンショットにする。
