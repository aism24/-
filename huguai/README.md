# huguai（社内不具合アプリ Vercel版）

画面（静的サイト）はVercel、データ処理はGAS（`gas/Code.gs`をWebアプリ化したJSON API）。
- `config.js` の `GAS_API_URL` にGASの `/exec` URLを設定する。
- データ: 「社内不具合アプリVercel版」スプレッドシート（情報・記録シート）。PDF保存時に「記録」シートへ追記。
- Gemini: モデル `gemini-3.5-flash-lite` 固定。APIキーは情報シートの「APIKEY」行(B5)。
- Vercel: Root Directory=`huguai`、Framework=Other。`vercel.json`で自動デプロイ停止（公開は `create_deployment`）。

## 高速化メモ
- 結果分析の生産重量(約12秒)は、起動時に裏で先読みし、未計算でも画面を先に表示して後から差し替える。
- GASを新規にデプロイしたら、Apps Scriptエディタで `setupProductionWeightCacheTrigger` を1回だけ手動実行する(15分おきにキャッシュを温める)。
- 設定とマスタは10分キャッシュ(物件を追加すると自動で無効化)。シートを直接編集した内容は最大10分で反映。
- ブラウザのコンソールに `[API] 関数名 total=…ms server=…ms` を出力(totalとserverの差が通信オーバーヘッド)。
