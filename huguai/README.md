# huguai（社内不具合アプリ Vercel版）

画面（静的サイト）はVercel、データ処理はGAS（`gas/Code.gs`をWebアプリ化したJSON API）。
- `config.js` の `GAS_API_URL` にGASの `/exec` URLを設定する。
- データ: 「社内不具合アプリVercel版」スプレッドシート（情報・記録シート）。PDF保存時に「記録」シートへ追記。
- Gemini: モデル `gemini-3.5-flash-lite` 固定。APIキーはGASのスクリプトプロパティ `GEMINI_API_KEY`。
- Vercel: Root Directory=`huguai`、Framework=Other。`vercel.json`で自動デプロイ停止（公開は `create_deployment`）。
