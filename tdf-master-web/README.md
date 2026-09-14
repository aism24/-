# TDF製品情報抽出アプリ(GAS × Pyodide)

実寸法師(.tdf)の鉄骨図面ファイルから製品マスタ情報を抽出し、Excelダウンロード
とスプレッドシート記録までをブラウザ完結で行うWebアプリ。

## アーキテクチャ

姉妹アプリ「DXF製品情報抽出アプリ」(DXF＿マスタ作成【自社図面】スプレッドシート
に紐づくGASアプリ)と同じ構成を採用している。

- 抽出ロジックは**Pyodide**(ブラウザ内でPythonをそのまま実行するWASM)で動作。
  `Index.html`内の`<script type="text/python-src">`に埋め込まれたPythonコードを
  Pyodideがそのまま実行する(サーバー側でのPython実行やJSへの移植は不要)。
- 埋め込まれている4つのPythonファイルのうち、以下3つは
  [`masamizsumi-dotcom/tdf-master-extract`](https://github.com/masamizsumi-dotcom/tdf-master-extract)
  リポジトリの検証済みコードを**一切変更せず**埋め込んでいる(大梁48ファイル・
  小梁47+9ファイルでの実データ検証結果がそのまま担保される)。
  - `tdf_binary.py` — .tdfバイナリの低レベルパーサー
  - `tdf_master_extractor.py` — 大梁(1G系)抽出ロジック
  - `tdf_master_extractor_multi.py` — 小梁(1B系)抽出ロジック
  - `tdf_app.py` — 上記3つを呼び出し、Excel(openpyxl)書き込みの代わりに
    dictのリストを返すよう置き換えた薄いラッパー(このアプリのための新規コード)
- Excel生成は[SheetJS](https://sheetjs.com/)(ブラウザ内JS、cdnjs経由)。
- GAS(`Code.gs`)は以下のみを担当する(重い処理は一切行わない):
  - 記録シートへの実行ログ追記
  - 日時名のデータシート追加(最大10件、古い順に自動削除)
  - 設定シートの重量表(サイズ→kg/m)・工事番号一覧の読み書き
  - 利用記録(開始・終了時刻)

`scripts/`フォルダの4ファイルは参照用のソース(Index.htmlに埋め込まれている
内容と同一)。ロジックを変更する場合はまずこちらを編集し、Index.htmlへの
埋め込みも忘れず更新すること。

## セットアップ手順

対象スプレッドシート: [TDF＿マスタ作成](https://docs.google.com/spreadsheets/d/1dfTrPnZKZa2bPvDg8Jbjus1FeMT-LNEeB1fjryZSZCc/edit)
(記録・設定シートは作成済み)

1. 上記スプレッドシートを開き、「拡張機能」→「Apps Script」を開く
2. デフォルトの`コード.gs`の中身を削除し、以下の内容を貼り付けて`Code.gs`という
   ファイル名で保存する
   → [Code.gs をGitHubで見る](https://github.com/aism24/-/blob/main/tdf-master-web/Code.gs)
   (右上の「Copy raw contents」でコピーできます)
3. 「+」→「HTML」で`Index`という名前のHTMLファイルを新規作成し、以下の内容を
   貼り付ける
   → [Index.html をGitHubで見る](https://github.com/aism24/-/blob/main/tdf-master-web/Index.html)
4. スクリプトエディタの関数選択で`setupSpreadsheet`を選び、一度だけ実行する
   (記録・設定・利用記録の3シートを初期化。記録・設定シートは既存のものを
   そのまま使うので中身は消えない)
5. 「デプロイ」→「新しいデプロイ」→種類「ウェブアプリ」→アクセスできるユーザー
   「全員」でデプロイし、発行されたURLを控える
6. 発行されたURLを開き、「大梁/小梁」「工事番号」を選択して.tdfファイルを
   選択(複数可)すると抽出が始まる

## 既知の制約・今後の課題

- 大梁(1G系)・小梁(1B系)の判別は現状ユーザーが画面上で手動選択する方式
  (ファイル内容からの自動判別は未実装)
- Excelダウンロード時に「工事番号」は画面で入力した値をそのまま使う
  (TDFファイル自体には工事番号の記載が無いため、DXF版と異なり自動抽出できない)
- 検証用の.tdfサンプルではまだブラウザ実機での動作確認をしていない
  (合成テストデータでの疎通確認のみ)。実ファイルでの検証・
  [`tdf-master-extract`](https://github.com/masamizsumi-dotcom/tdf-master-extract)
  との出力突き合わせが必要
- DXF版にある「図面ビューワー」「重複マークチェック」「マスタExcel差分反映」
  等の高度機能は未実装(今回はコア機能のみ)
