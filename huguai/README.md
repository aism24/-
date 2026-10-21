# huguai（社内不具合アプリ Vercel版）

画面（静的サイト）はVercel、データ処理はGAS（`gas/Code.gs`をWebアプリ化したJSON API）。
- `config.js` の `GAS_API_URL` にGASの `/exec` URLを設定する。
- データ: 「社内不具合アプリVercel版」スプレッドシート（情報・記録シート）。PDF保存時に「記録」シートへ追記。
- Gemini: モデル `gemini-3.5-flash-lite` 固定。APIキーは情報シートの項目名「APIKEY」の行(行位置は問わない。現在はB5)。
- Vercel: Root Directory=`huguai`、Framework=Other。`vercel.json`で自動デプロイ停止（公開は `create_deployment`）。

## 高速化・キャッシュのしくみ
- **データ版数方式のキャッシュ(GAS):** 一覧・仕訳け・結果分析・マスタの結果をCacheService(最大6時間)に保存。保存(記録の登録・編集)のたびに版数が変わり、古いキャッシュは自動で使われなくなる。シートを直接編集した場合は、ホームの「最新データに更新」で反映する。
- **生産重量:** 約12秒かかる集計。CacheService+スクリプトプロパティ(永続)に保存し、毎朝7〜8時に更新(元のマスタQUERYの更新後に読む)。日中は保存済みの値を即表示する(26時間以上古い場合だけ、画面が裏で再計算して差し替える)。
- **トリガー:** GASを貼り替えたら、Apps Scriptエディタで `setupProductionWeightCacheTrigger` を1回だけ手動実行する(毎朝7〜8時に `warmProductionWeightCache` 1本=重量の更新+キャッシュの作り直し。既存のトリガーは自動で削除して作り直す)。
- **画面:** ホームは即表示し、マスタ・結果分析・一覧は裏で先読み。前回の結果(localStorage)を先に表示してから最新に差し替える。PDF用ライブラリはPDFを作るときだけ読み込む。
- **Gemini:** モデル名はコードに固定(`gemini-3.5-flash-lite`)。APIキーは情報シートの項目名「APIKEY」の行(行位置は問わない。現在はB5)。
- ブラウザのコンソールに `[API] 関数名 total=…ms server=…ms` を出力(totalとserverの差が通信オーバーヘッド)。
