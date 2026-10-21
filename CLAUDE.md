# リポジトリ全体の方針

恒久ルールだけをここに書く。状態表・履歴・アプリ別仕様は `docs/` に分離している(2026-10-21に再構成。旧版はgit履歴)。
作業前に `docs/know-how.md` も読む。

## 1. 最重要ルール(事故につながるもの)

1. **Vercelのデプロイ(`create_deployment`)は、ユーザーが「デプロイして」と明示したときだけ。** マージ後は「mainへ反映済み・本番(Vercel)は未反映」と報告する。デプロイしたときは、報告の冒頭に直近24時間のデプロイ回数(Hobby上限100)を書く。
2. **Git連携は全アプリ解除したままが原則。** push・マージの前に `list_projects`(repoUrl=`https://github.com/aism24/-`)が0件か確認する。1件でも残っていたら、push・マージせずユーザーに解除を依頼する(Skip deploymentsは当てにならない。ブランチpushだけでもPreviewデプロイが走る)。
3. **引き継ぎ書を個人のマイドライブに保存しない。** 手順は下の「引き継ぎ書」節。
4. **リポジトリは公開(public)。** サーバーのパス・IP・個人情報・実データ(FAXの画像など)・APIキーを書かない・入れない。
5. **GitHubの作業は許可を求めず、mainへのマージまで進める**(RESTで `gh api -X PUT repos/aism24/-/pulls/<番号>/merge -f merge_method=squash`)。権限で拒否されたら回避せず、PR・ブランチのURLを報告して止まる。範囲は `aism24/-` の通常のアプリ修正のみ(リポジトリ削除・強制push・他リポジトリは含まない)。

## 2. 共通指示

- 完全無料(GAS・スプレッドシート・Vercel無料枠)。アプリはURLで配布する。
- **Gemini**: モデル名は `gemini-3.5-flash-lite` を定数で固定(他モデル名を使わない。ユーザー指定時のみ変更)。
  **例外(新規アプリ、2026-10-20〜。truck-faxが最初)**: モデル名とAPIキーはスプレッドシートの「情報」シート(A列=項目名、B列=値。項目名 `Geminiモデル名`・`APIKEY`)をGASがA列の項目名で探して読む。セルが空なら別モデルに黙って切り替えず「情報シートの◯◯が空です」とエラー。既存アプリ(company-ai・huguai等)はユーザーが指示するまで変えない。
- コードを変えたら回帰テストで前回値が悪化していないか確認する。テストファイルは作業後に削除する(tdf-dim-countの正解データ・テストは例外)。
- アプリ・コードはすべて `aism24/-` の直下にアプリごとのフォルダで置く(新リポジトリは作らない)。
- 各アプリのフォルダに `vercel.json` `{"git":{"deploymentEnabled":false}}` を置き、push・マージでビルドが走らないようにする。置いていないフォルダ(pdf-diff-app・unso-check・tdf-master-web・jissun-master-jidokinyu・kozai-toriai・weld-heat-management)は、Vercelへ連携し直す前に必ず置く。
- GitHubのPages(`aism24.github.io`)は使わない。公開はVercel(フォルダ=Root Directory。Framework=Other)。名前が似たVercelプロジェクトが別実装のことがあるので、URLは実際にfetchして中身を確認してから使う。
- 作業完了時、効果のあったやり方(Before→After数値つき)とユーザーが繰り返した指示を `docs/know-how.md` に追記(1項目5行以内。ローカルセッションの知見もここが正)。恒久ルール化すべきものは提案してから本ファイルに追記する。

## 3. 開発中の確認とVercel

- 開発中はVercelへデプロイせず、GitHubのraw配信で画面を確認する。HTMLの画面確認は **raw.githack.com**(`https://raw.githack.com/aism24/-/<branch>/<フォルダ>/<ファイル>`)。jsDelivr・StaticallyはHTMLを `text/plain` で返すので画面確認に使えない。
- 本番反映: `create_deployment`(target=production、gitSource={type:github, org:aism24, repo:"-", ref:main, sha:<マージコミット>}。teamIdは渡さない=403。同一SHAの再デプロイは `forceNew: 1`(数値))。その後 `list_deployments` でREADYを確認し、本番URLを実際にfetchして反映を確かめてから報告する。
- デプロイが CANCELED になったら、まず Settings → Build and Deployment → Ignored Build Step を確認する(「Automatic」にする。コマンドは Root Directory 内で実行されるので `-- ./<フォルダ>` ではなく `-- .`)。
- 連携を戻して公開する場合: 事前に他アプリの連携が無いことを確認し、マージ後に `list_deployments` で今回のコミットのデプロイが存在するか確認する(無ければ「連携解除中のため本番未反映」と伝える)。
- **pdf-diff-app(Python関数)は1デプロイごとにFunctions Storage(上限10GB)を消費する。** 管理ラインは7GB。デプロイ前に現在値をユーザーに確認し、増分(約60MB)を足して7GB以上なら先に旧デプロイの削除を依頼する。複数修正をまとめて1回で反映し、試しデプロイはしない。詳細・記録表・削除の反映タイミングは `docs/vercel-status.md`。
- GASのJSONを速く配るときは、Vercelの中継API+CDNキャッシュを第一候補にする(詳細 `docs/misc-policies.md`)。

現在のGit連携状態・各アプリのVercel情報・履歴は **`docs/vercel-status.md`**(状態表を変えたらそこを更新する)。

## 4. GAS等のコードのURL案内・確認用URLの運用

- Code.gs・Index.html等を案内する前に、push済みの最新コミットがGitHub上に反映されていることを確認する(`git ls-remote origin <branch>` が手元のHEADと一致 + raw.githubusercontent.com に変更箇所の目印が含まれる)。
- 案内するURLは**コミット固定のblob URL**(`https://github.com/<owner>/<repo>/blob/<コミットSHA>/<path>`)。`blob/main` は「Copy raw contents」の取得元(raw.../main/)が数分古いままになることがある。確認したコミットのハッシュを案内に添える。Code.gsを直したら `CODE_VERSION` を更新し、デプロイ後に公開GASの `ping` で版を確認してから「反映できた」と報告する。
- アプリの確認用URL(raw.githack)は報告のたびに添付する。ただし反映確認後に添付する: `index.html` のJS/CSSに `?v=<目印>` を付けて毎回更新し、`curl -s ".../index.html" | grep -o 'app.js?v=[a-z0-9]*'` が今回の版と一致してから。一致しなければ「反映待ち」と伝える。報告には確認した目印と時刻を添える。
- **raw.githackの429対策**: ポーリング・sleepループをしない(確認は1回、未反映なら5分以上あけて1回だけ)。pushごとに新しいURLで確認せず、複数修正をまとめる。事前確認は raw.githubusercontent.com で行い、raw.githackはユーザーが画面を見る用にだけ使う。429が出たら即止めて「制限中」と伝える(代替: htmlpreview.github.io=動作未保証、または指示があればVercel)。ロジック・ドキュメントのみの修正ではraw.githackにアクセスしない。

## 5. 引き継ぎ書(Drive)

- 保存先は、会社アカウントの**アプリごとに指定されたフォルダ**。フォルダ表は **`docs/drive-folders.md`**。表に無いアプリは推測せずユーザーに聞く。
- 手順(1つでも満たせなければ保存しない): ① 表で対象アプリのparentIdを確認 → ② 保存前に `search_files`(`parentId = '<ID>'`)で、そのフォルダに対象アプリの管理用スプレッドシートがあることを確認 → ③ `create_file` に必ず `parentId` を指定(省略・`root`は禁止) → ④ 返ってきた `parentId` が指定と一致することを確認し、報告に保存先を明記。
- 更新時は、指定フォルダ内の最新版(title「引き継ぎ書」・modifiedTime最新)を読んでから新しい版を同フォルダに作る。
- `update_file` で名前変更・移動をしたら、個人マイドライブ直下に混入していないか確認する(`parentId = 'root'` で0件)。混入していたら元の会社フォルダを `parentId` に指定した `update_file` で戻す。
- 個人アカウントに古い版が見つかっても問題としない(会社側で削除したファイルが自動バックアップされるため。Claudeは移動・削除しない)。

## 6. アプリ別ルール

- **tdf-dim-count**: `tdf-dim-count/core.js` を変えたらコミット前に `node tests/tdf-dim-count/run.js` を実行し全件OKを確認。正解値(GEN=592本、TB=16本など)を変えるのはユーザーが正解を確認したときだけ(`--update`)。詳細は `tests/tdf-dim-count/README.md`。
- **huguai**: PDFは固定幅1280px・A4縦1ページ、結果分析の期間仕様など → `docs/apps/huguai.md`
- **truck-fax**: 取込一覧は削除しない・手配業者・備考の扱い・車種の表記など → `docs/apps/truck-fax.md`
- **共通ボタン to-launcher.js**(「← アプリ一覧へ」。正本 `docs/to-launcher/to-launcher.js`、各フォルダにコピーして使う) → `docs/to-launcher/README.md`
- **運用停止・不要フォルダ**: `production-profit/`・`jikko-yosan/`(コストインサイト `cost-insight/` に統合済み)・`open_jissun/`(実際は `jissun-open`)は、削除せず残置。新規作業・デプロイ・ランチャー登録の対象にしない(依頼されたらコストインサイト側の対応かを確認)。旧リポジトリから統合した `dxf-launcher/`・`excel-drawing-link-tool/` を含め、詳細は `docs/misc-policies.md`。
