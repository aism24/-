# PDF差分解析アプリ

新旧2つのPDFをアップロードし、「表」「文章」「図面」のうちユーザーが指定した
種類で変更箇所を色付けして新旧を並べて表示・PDFダウンロードできるWebアプリ。
ページ種別の自動判定は行わず、ユーザーが明示的に指定した方式で全ページを解析する。

比較処理そのものは、ユーザーのローカル環境で検証済みのオリジナルPythonコード
(`pdf_table_diff.py` / `pdf_text_diff.py` / `pdf_image_diff.py`、Python+PyMuPDF)を
Vercelのサーバーレス関数(`api/*-diff.py`)としてそのまま実行する。フロントエンドは
そのAPIを呼び出すだけで、ロジックの再実装はしていない。API呼び出しが使えない環境
(Vercelを経由しないgithackプレビュー等バックエンドの無い環境)では、`lib/diff-core.js`
内のJS版計算(pdf.js移植、正解のPython版と完全には一致しない簡易版)に自動フォールバック
する。PDFの中身はVercel関数への送信を除き外部に送信されない。

## 構成

```
pdf-diff-app/
  index.html          画面(ヘッダー・種類選択・アップロード・ビューア)
  style.css           スタイル
  app.js              UI制御・GASへのログ送信・PDFダウンロード生成
  lib/diff-core.js    差分解析コアロジック(ページ整合・3方式の差分検出のJS版、Python API利用時のフォールバック用)
  api/table-diff.py   表モードAPI(Vercel Pythonサーバーレス関数、pdf_table_diff.pyを呼び出すだけ)
  api/text-diff.py    文章モードAPI(同、pdf_text_diff.pyを呼び出すだけ)
  api/image-diff.py   図面モードAPI(同、pdf_image_diff.pyを呼び出すだけ)
  python/              ユーザー正解版のオリジナルPythonスクリプト本体・日本語フォント
  requirements.txt     Vercel Python関数の依存パッケージ(PyMuPDF/Pillow/numpy/scipy)
  vercel.json          各API関数にpython/を同梱する設定
  gas/Code.gs          記録シート書き込み用GAS Webアプリ
```

使用ライブラリ(すべてCDN経由、ビルド不要):
- [pdf.js](https://mozilla.github.io/pdf.js/) 3.11.174 — PDF描画・テキスト座標抽出(JSフォールバック用)
- [jsdiff](https://github.com/kpdecker/jsdiff) 9.0.0 — LCSベースの差分検出(JSフォールバック用)
- [jsPDF](https://github.com/parallax/jsPDF) 4.2.1 — 結果を1つのPDFにまとめてダウンロード

## 処理の流れ

1. ユーザーが「表」「文章」「図面」のいずれかを選択(未選択の間は解析ボタンが無効)
2. 新旧PDFをアップロードし、解析を実行
3. 選択した種類に対応するVercel API(`/api/table-diff`等)にページ画像・座標情報を送信し、
   ユーザー正解版のPythonロジックで比較(API不可の環境ではJS版に自動フォールバック)
4. 新旧のページ列を、ページ内容の類似度でLCSベース整列(`alignPages`)。新版でページが
   挿入された場合でも、対応する旧ページが無いページとして正しく「追加」判定される
5. 対応の取れたページ同士を、選択した方式(表=行/セル単位diff、文章=1文字単位diff、
   図面=ピクセル差分+連結領域検出)で比較し、ハイライトを描画
6. 解析完了時に「日時」「分類」をGAS Web App経由でスプレッドシート「記録」シートの
   2行目に記録(追記後にA2:Bを日時降順に並び替え、常に2行目が最新を維持)
7. 結果はブラウザ上で新旧独立してズーム表示、まとめて1つのPDFとしてダウンロード可能

## セットアップ

### 1. GAS Web Appのデプロイ
1. スプレッドシート(`記録`シート、A:日時 B:分類)を開き、拡張機能 > Apps Script
2. `gas/Code.gs`の内容を貼り付けて保存
3. デプロイ > 新しいデプロイ > 種類「ウェブアプリ」(実行:自分、アクセス:全員)
4. 発行された`/exec` URLを`app.js`先頭の`GAS_API_URL`に設定してpush

### 2. Vercelへのデプロイ
Vercelダッシュボードで Add New Project → 対象リポジトリ選択 → **Root Directory**に
`pdf-diff-app`を指定 → Framework Preset「Other」→ Deploy。
以後はこのフォルダへのpushで自動的に最新版がVercel URLに反映される。
CLAUDE.mdの「開発中の確認とVercel連携のタイミング」の方針に従い、開発中はVercel
側のGit連携を解除しておき、完成時に(再)接続してデプロイすること。

## 既知の制約・今後の調整余地

- **JSフォールバック版の精度**: Vercel API(Python正解版)が使えない環境で使われる
  `lib/diff-core.js`のJS計算は、Python版ほどの精度・一致度は保証しない
  (文字位置の推定に誤差があるなど)。あくまでバックエンド無し環境向けの簡易フォールバック。
- **図面方式のページサイズ不一致**: 新旧でページサイズが違う場合は縦横比を保ったまま
  中央寄せで合わせて比較する(引き伸ばしはしない)。位置合わせ(特徴点マッチング)は
  未実装。
- **Vercel Python関数の実測未了**: コールドスタート時間・レスポンスサイズ(画像を
  base64往復するため、ページ数が多いPDFだとペイロードが大きくなる)は、実デプロイ後に
  実測が必要(詳細はGoogle Docs引き継ぎ書を参照)。
- **ページ整合の類似度しきい値**: `PAGE_SIM_THRESHOLD`(0.5)を下回るページは
  「対応なし」として追加/削除扱いになる。内容が近い別ページを誤って対応付ける/
  逆に対応するはずのページを見逃す、といった誤判定が起きた場合はここを調整する。
