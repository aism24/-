# PDF差分解析アプリ

新旧2つのPDFをアップロードし、「表」「文章」「図面」のうちユーザーが指定した
種類で変更箇所を色付けして新旧を並べて表示・PDFダウンロードできるWebアプリ。
ページ種別の自動判定は行わず、ユーザーが明示的に指定した方式で全ページを解析する。

比較処理そのものは、ユーザーのローカル環境で検証済みのオリジナルPythonコード
(`pdf_table_diff.py` / `pdf_text_diff.py` / `pdf_image_diff.py`、Python+PyMuPDF)を
Vercelのサーバーレス関数(`api/*_diff.py`)としてそのまま実行する。フロントエンドは
そのAPIを呼び出すだけで、ロジックの再実装はしていない。**ブラウザ内(JS)での差分計算は
一切行わない**(以前はAPI呼び出しが使えない環境向けにJS版フォールバックがあったが、
全角スペースの扱いの違い等でPython版と結果がズレる実害バグが確認されたため撤去した)。
そのため、Vercelにデプロイされていない環境(githackプレビュー等)では解析ボタンを押すと
エラーになる。PDFの中身はVercel関数への送信を除き外部に送信されない。

## 構成

```
pdf-diff-app/
  index.html          画面(ヘッダー・種類選択・アップロード・ビューア)
  style.css           スタイル
  app.js              UI制御・GASへのログ送信・PDFダウンロード生成
  lib/diff-core.js    差分解析コアロジック(ページ整合のみ。セル/文字/ピクセル単位の差分検出はPython API専用)
  api/table_diff.py   表モードAPI(Vercel Pythonサーバーレス関数、pdf_table_diff.pyを呼び出すだけ)
  api/text_diff.py    文章モードAPI(同、pdf_text_diff.pyを呼び出すだけ)
  api/image_diff.py   図面モードAPI(同、pdf_image_diff.pyを呼び出すだけ)
  python/              ユーザー正解版のオリジナルPythonスクリプト本体・日本語フォント
  requirements.txt     Vercel Python関数の依存パッケージ(PyMuPDF/Pillow/numpy/scipy)
  vercel.json          各API関数にpython/を同梱する設定
  gas/Code.gs          記録シート書き込み用GAS Webアプリ
```

使用ライブラリ(すべてCDN経由、ビルド不要):
- [pdf.js](https://mozilla.github.io/pdf.js/) 3.11.174 — PDF描画・ページ整合(挿入/削除ページ検出)用のテキスト座標抽出
- [jsdiff](https://github.com/kpdecker/jsdiff) 9.0.0 — ページ整合(`alignPages`)のLCS計算に使用
- [jsPDF](https://github.com/parallax/jsPDF) 4.2.1 — 結果を1つのPDFにまとめてダウンロード

## 処理の流れ

1. ユーザーが「表」「文章」「図面」のいずれかを選択(未選択の間は解析ボタンが無効)
2. 新旧PDFをアップロードし、解析を実行
3. 選択した種類に対応するVercel API(`/api/table_diff`等)にPDFを送信し、
   ユーザー正解版のPythonロジックで比較(Vercel未デプロイの環境ではここでエラーになる)
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

**注意(2026-09-19)**: `api/`配下のPythonファイル名にハイフンを含めると
(例: `table-diff.py`)、Vercelの新しいPythonランタイムがモジュールとして
import出来ず(`table-diff`はPythonの識別子として不正)、
`No python entrypoint found in default locations`でビルドが失敗する。
`api/`配下のファイル名は必ずアンダースコア区切り(`table_diff.py`等)にすること。

## 既知の制約・今後の調整余地

- **Vercel未デプロイの環境では動作しない**: 差分計算はPython API専用のため、
  githackプレビュー等バックエンドの無い環境では解析ボタンを押すとエラーになる。
  挙動確認には必ずVercelへのデプロイが必要。
- **図面方式のページサイズ不一致**: 新旧でページサイズが違う場合は縦横比を保ったまま
  中央寄せで合わせて比較する(引き伸ばしはしない)。位置合わせ(特徴点マッチング)は
  未実装。
- **Vercel Python関数の実測未了**: コールドスタート時間・レスポンスサイズ(画像を
  base64往復するため、ページ数が多いPDFだとペイロードが大きくなる)は、実デプロイ後に
  実測が必要(詳細はGoogle Docs引き継ぎ書を参照)。
- **ページ整合のアルゴリズム**: 類似度を得点としたNeedleman-Wunsch型の大域アライメントDP
  (`lib/diff-core.js`の`alignPages()`、ギャップコストは`GAP_PENALTY`=0.35)で
  新旧ページの対応関係を決める。ページ数が違っても、挿入/削除された1ページを
  正しく飛ばして残りのページ同士を対応付けられることを`test/align-pages.test.js`の
  リグレッションテストで確認済み(`node test/align-pages.test.js`で実行可能)。
- **(既知の不具合・未修正)挿入と削除が同時に起きるケースの誤対応**: 「旧版のある
  ページが削除され、かつ全く無関係な新規ページが別の位置に挿入される」ことが
  同じ差分の中で同時に発生すると、本来delete+insertとして扱うべき2ページを、
  類似度がほぼ0のまま誤って1組のpair(=同一ページが編集されたもの)として対応
  付けてしまうことがある(2026-09-19判明、`test/align-pages.test.js`には未収録)。
  無関係な2ページをpairにするコスト(-GAP_PENALTY)が、delete+insertにする
  コスト(-GAP_PENALTY×2)より小さいことが原因。対策候補: 類似度が一定値を
  下回るpairはpairとして採用せずdelete+insertに強制する下限しきい値を追加する。
