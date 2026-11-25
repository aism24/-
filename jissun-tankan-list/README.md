# 大組図から短管リスト作成(jissun-tankan-list)

実寸法師の大組図(.tdf)から、コラム(角形鋼管)柱の「短管リスト」Excelを作る Web アプリ。
前身はローカルの Python 版(社内の共有フォルダ。大組図の読み取り・板の外形の測り方・重量の決まりは同じ)。
2026-11-25 作成開始。**今は骨組みの段階**(ひな形と GAS だけ。画面・抽出はこれから)。

## 構成(予定を含む)
```
jissun-tankan-list/
  template/tankan-template.xlsx  Excelのひな形(書式と表の形だけ。値は {工事名} などの置き換え文字)
  gas/Tankan.gs  金物リストと同じ Apps Script プロジェクトに足す GAS(下記)
  vercel.json    {"git":{"deploymentEnabled":false}}
  (これから) index.html / app.js / style.css / py/(抽出の Python。Pyodide で動かす) / to-launcher.js
```

## 作り(予定)
- 図面(TDF)はブラウザで選び、ブラウザの中で読む(Pyodide で Python 版の抽出をそのまま動かす。tdf-master-web と同じ方式)。BH柱は除外。
- 注文書(切板手配書)は GAS がドライブ「切板CSV工事別まとめ」の `<工事番号>.csv` を返す。
  このCSVは PC の「切板CSVキャッシュ作成.bat」が社内サーバーの手配書CSVをまとめてドライブへコピーしたもの(GAS は社内サーバーに入れないため)。
- Excel はひな形の「階」シートを階ごとに写し、柱ごとに表A(サイズ1つ)・表B(テーパー、サイズ3つ)を写して値を入れる。
  短管の絵は画像で貼る(ローカル版の Excel の図形の代わり。2026-11-25 ユーザー了承)。
- V列=図面番号・W列=A付き図面番号・X列=製品名に、大組図TDFへのリンク(選んだ場所と設定シートのパスをつなぐ。spl-sheet-web と同じ)。
- Excel をダウンロードしたら、スプレッドシートの「短管_記録」に1行と、中身のシート「短管_日時_工事番号」を追加(新しい10枚だけ残す)。

## ひな形(template/tankan-template.xlsx)
- 「階」シート: 1〜2行目=見出し、3〜16行目=表A(サイズ1つの柱)、17〜32行目=表B(テーパーのある柱)。印刷範囲 B:U、V〜X列はリンク用(印刷範囲の外)。
- 「板」シート: 一般的な角形鋼管の単重表(A:B)だけ。アプリが手配書の行を足す。
- 「説明」シート: 置き換え文字の一覧。
- 提出済みの Excel から書式と表の形だけを取り出して作った(実データ・作成者情報は入れていない)。

## GAS(gas/Tankan.gs)とスプレッドシート
スプレッドシート「製品別金物一覧アプリ」の Apps Script(金物リスト tdf-kanamono-list の Code.gs が入っているプロジェクト)に、
2つ目のファイル「Tankan」として足す(2026-11-25 ユーザー指示)。ウェブアプリの入口(doGet・doPost)は1プロジェクトに1つなので、
金物リストの Code.gs の doGet・doPost が、action が `tankan` で始まる依頼だけを Tankan.gs へ回す(Tankan.gs が無くても金物リストは動く)。
同じプロジェクトでは名前が共有されるため、Tankan.gs の関数・定数はすべて `tankan` / `TANKAN` で始める。URL は金物リストと同じ。
1. Apps Script に「Tankan」ファイルを足して `gas/Tankan.gs` を貼り、Code.gs を tdf-kanamono-list/gas/Code.gs の最新に差し替えて保存
2. 関数 `tankanSetupSpreadsheet` を1回実行(「短管_記録」「短管_利用記録」を作る。設定シート・金物リストのシートは触らない)
3. デプロイを管理 → 金物リストの今のデプロイを編集 → 新バージョン(URL は変わらない)。`?action=tankanPing` で版が返る
- `tankanSettings`: 設定シート(見出し「工事番号」「工事名」「サーバー」「ファイルパス」で列を探す。読むだけ)
- `tankanOrders&koji=26-12`: 注文書キャッシュの CSV(UTF-8)と更新日時。ファイルが無ければ csv は空。フォルダ ID は Tankan.gs に書いてある(ユーザー了承)
- `tankanSave`(POST): 「短管_記録」に1行と中身のシート。`tankanUsage`(POST): 利用記録。記録は画面に出さない
