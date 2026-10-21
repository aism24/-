# アプリ一覧ポータル：GAS × GitHub Pages 分離構成

「アプリ一覧」Webアプリ（GASコンテナーバウンド、スプレッドシート「アプリ一覧Launcher」に紐づく）を、
**フロントエンド（GitHub Pages）** と **バックエンド（GAS API）** に分離した構成です。

## 現在の機能(2026-10-16時点)

本体はVercel版(`index.html`・`app.js`・`style.css`)。本番: https://app-launcher-ashy.vercel.app/
(下の「GitHub Pages」の説明は初期構成の記録で、現在の配信先はVercel。GAS側は変更不要。)

- **一覧**: 分類ごとのカード一覧。ホバー(PC)/2段階タップ(タッチ)で名前・説明を展開。クリックで起動し、「記録」シートへログ追記。
- **検索**: 名前・説明・アイコン文字・分類名で絞り込み(全角半角・大小文字を区別しない、スペース区切りはAND)。検索履歴(最大10件)はlocalStorage(`appLauncherSearchHistory_v1`)。
- **お気に入り**: 各ボタン右上の会社ロゴをオン(赤塗)/オフ(白の外枠)。上の区画に「お気に入り」、余白と区切り線の下に「すべてのアプリ」を表示。
  保存はlocalStorage(`appLauncherFavorites_v1`、アプリID=情報シートA列の配列)。ブラウザ・端末ごとに別々で、サーバーには保存しない。
  **固定のお気に入り**: `app.js` の `PINNED_HOSTS`(URLのホスト名)に入れたアプリは、常にお気に入り(オンオフ不可。localStorageには保存しない)。現在は `masamiz-production-management.vercel.app`。
  お気に入りが0件でも、見出しと「(右上の会社ロゴをオンオフすると追加できます)」の説明を常に表示。
- **一覧のキャッシュ**: localStorage(`appLauncherGroupsCache_v1`)に前回の一覧を保存し、先に表示してから裏で更新。
- `index.html` の `?v=`(style.css・app.js)は、変更のたびに上げる。
- `vercel.json` の `git.deploymentEnabled=false` でpush・マージでは自動デプロイしない。本番反映は「デプロイして」の指示時のみ。

## 既存アプリとの関係(最重要)

**既存のGAS Webアプリ（`doGet`、`Index.html`のテンプレートレンダリング方式）には一切変更を
加えていません。** 既存のデプロイ・既存のURL・既存の挙動はそのまま残ります。

このフォルダの`gas/Code.gs`は、既存の管理用スプレッドシート（「情報」「記録」シートを持つ
コンテナーバウンドのスプレッドシート）に設置されている**既存のCode.gsに、新しい関数を
追記したもの**です（ファイル末尾の「ここから下は「アプリ一覧ポータル」専用の追加分」より
前は、既存のCode.gsと完全に同一の内容です）。追記されているのは以下です。

- `doPost(e)`: 新規のJSON APIエントリポイント（既存の`doGet()`はHTMLを返す処理のまま無改変）
  - `action: "getAppGroups"` … 既存の`getAppGroups()`をそのまま呼び出して返す
  - `action: "logAppOpen"` … 既存の`logAppOpen(appName)`をそのまま呼び出す（「記録」シートへの追記）

## 構成

```
app-launcher/index.html    … フロントエンドのHTML（画面構造のみ）
app-launcher/style.css     … スタイル（既存の見た目をそのまま流用）
app-launcher/app.js        … 画面ロジック + GAS APIとの通信処理（fetchでPOST）
app-launcher/gas/Code.gs   … 既存のCode.gs + 新規追加分（丸ごと貼り替え用）
app-launcher/gas/Index.html … 既存のIndex.html（丸ごと貼り替え用。doGet()が参照するHTML）
```

見た目・機能は、既存のGAS Webアプリ（分類ごとのカード一覧、クリックで別タブオープン＋
「記録」シートへのログ追記）をそのまま移植したものです。新機能の追加は行っていません。

リポジトリ直下の`index.html`は、旧URL（`https://aism24.github.io/-/`）へのアクセスを
`app-launcher/`へ自動転送するよう変更しました（従来は`hot-heart/`への転送でした。
他アプリのコード・デプロイには一切変更を加えていません）。

---

## 1. GAS側のセットアップ

**重要: 既存のデプロイ（今チームが使っているURL）は絶対に変更しないでください。**
新しいコードは**追加デプロイ**として発行します。

1. 管理用スプレッドシート（「アプリ一覧Launcher」）を開き、拡張機能 → Apps Script を開きます。
2. `app-launcher/gas/Code.gs` の内容を、既存の `Code.gs` の中身と**まるごと置き換えます**
   （既存部分は完全に同一の内容なので、置き換えても既存の挙動は変わりません）。
   - `app-launcher/gas/Index.html` の内容も、既存の `Index.html`（HTMLファイル）と**まるごと
     置き換えます**（`doGet()`が引き続き参照するファイルなので、削除しないでください）。
3. 保存後、右上の **「デプロイ」→「新しいデプロイ」** を選択します
   （既存デプロイの「編集」ではなく、必ず「新しいデプロイ」を選んでください）。
4. 種類を **「ウェブアプリ」** にし、以下を指定します。
   - **次のユーザーとして実行**: 「自分」（`USER_DEPLOYING`。GitHub Pagesからの匿名アクセスに
     対応するために必須）
   - **アクセスできるユーザー**: **「全員」**
5. 「デプロイ」をクリックし、発行された新しいウェブアプリのURL
   （`https://script.google.com/macros/s/xxxxx/exec`）をコピーします。
6. 発行されたURLは `app.js` の `GAS_API_URL` に設定済みです(再デプロイするときは、
   既存デプロイを「編集→新バージョン」にすればURLは変わりません)。
   Code.gsを変えたら `CODE_VERSION` を更新し、`{"action":"ping"}` をPOSTして版を確認します。

### 注意点（既存アプリと共通）

- GASのウェブアプリはCORSプリフライト（OPTIONS）に対応していないため、`app.js`からのPOSTは
  `Content-Type: text/plain` で送信し、GAS側で`JSON.parse(e.postData.contents)`として読み取って
  います。`application/json`にするとプリフライトが発生し失敗するので変更しないでください。
- レスポンスは常にHTTP 200で返り、成否は返却JSONの`status`フィールド（`success`/`error`）で
  判定します。

## 2. フロントエンド（Vercel）のセットアップ

1. デプロイURLは `app-launcher/app.js` 先頭の `GAS_API_URL` に設定済みです(変える場合だけ書き換える)。
2. 画面は Vercel(https://app-launcher-ashy.vercel.app/)で配信します。本番反映は「デプロイして」の指示時のみ。
   開発中の画面確認は raw.githack(`https://raw.githack.com/aism24/-/<ブランチ>/app-launcher/index.html`)で行います。
   (旧GitHub Pagesは使いません。冒頭の説明・「既存アプリとの関係」は初期構成の記録です。)

## 3. 動作確認

1. 画面のURLを開き、分類ごとのカード一覧が表示されること。
2. カードをクリックすると、対象アプリが別タブで開くこと。
3. スプレッドシートの「記録」シートに、クリックした日時・アプリ名の行が追記されること。
4. 「情報」シートに新しい行（アプリ）を追加すると、リロード後に一覧へ反映されること。

## トラブルシューティング

- **一覧が読み込めない**: `GAS_API_URL`が正しいか、新規デプロイの「アクセスできる
  ユーザー」が「全員」、「次のユーザーとして実行」が「自分」になっているか確認してください。
- **CORSエラーが出る**: `app.js`のPOSTの`Content-Type`が`text/plain;charset=utf-8`になっているか
  確認してください（`application/json`にするとCORSプリフライトで失敗します）。
- **既存のGAS Webアプリの動作がおかしくなった**: このフォルダの変更は既存の`doGet`や
  `getAppGroups`/`logAppOpen`関数には一切触れていません。もし既存アプリに影響が出た場合は、
  Code.gsの貼り替え時に何か別の変更が混ざっていないか確認してください。
