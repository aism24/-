# リポジトリ全体の方針

## GitHub Pages経由 → Vercel経由への統一(2026-09-17〜)

このリポジトリ配下の各アプリ(フォルダ単位の静的サイト)は、基本的に**すべて
GitHub Pagesではなく個別のVercelプロジェクトとして配信する**方針。

- 新規にアプリ(フォルダ)を追加する場合も、既存でGitHub Pages経由になっている
  アプリを触る場合も、そのフォルダをRoot Directoryに指定したVercelプロジェクト
  としてデプロイし、スプレッドシートのURL列や各アプリの入口(ランチャー等)は
  そのVercel URLを指すようにする。
- 目的: GitHub PagesのURL(`aism24.github.io`。リポジトリ名を含む)が、OSの外部
  プロトコル起動許可ダイアログや共有リンク・ブラウザのアドレスバー等に表示され
  ないようにするため。
- 個別アプリのURLをVercelに変えるだけでなく、その手前の「入口」(例:
  app-launcherのGAS Webアプリがこれまでapp-launcherのGitHub Pages版へ自動転送
  していたような構成)がGitHub Pagesを経由している場合は、入口側のホスティング
  も合わせてVercelへ移行する。
- Vercelプロジェクト作成手順: Vercelダッシュボードで「Add New... → Project」→
  対象リポジトリを選択 → **Root Directory**に対象フォルダ名を指定 → Framework
  Presetは基本「Other」(ビルド不要な静的サイトのため) → Deploy。
- 【注意】似た名前のVercelプロジェクトが、このリポジトリと無関係な別実装である
  ケースがある(例: `app-launcher-three.vercel.app`は、このリポジトリの
  `app-launcher/`フォルダとは無関係の別アプリだった)。あるVercel URLがこの
  リポジトリのどのフォルダのデプロイかは、名前だけで判断せず、実際に
  fetchしてタイトルやコード内の識別情報を確認してから使うこと。

経緯・詳細な作業ログは、Google Docs「アプリランチャー引き継ぎ書」の最新版を
参照。

## 開発中の確認とVercel連携のタイミング(2026-09-19〜)

Vercelのデプロイ枠(利用制限)を消費しすぎないよう、pushの都度Vercelへ自動デプロイ
させない運用にする。

- **開発・修正作業中**: Vercel側の「このリポジトリとのGit連携(自動デプロイ)」は
  解除しておく。この間にアプリの挙動を確認する場合はVercelにデプロイせず、GitHub上の
  ファイルをそのまま配信するCDN経由のURL
  (`https://cdn.jsdelivr.net/gh/aism24/-@<branch>/<フォルダ>/<ファイル>`、
  例: `.../pdf-diff-app/index.html`)を使って確認する。このURLはpushするたびに
  中身が更新される(jsDelivrのキャッシュにより反映まで数分〜のラグがある場合がある)。
  - 【注意】2026-09-28確認: jsDelivrはHTMLを `text/plain` で返すため、画面ではなくソースが表示される
    (JS/CSSは正しく返る)。HTMLの画面確認は raw.githack.com を使う
    (`https://raw.githack.com/aism24/-/<branch>/<フォルダ>/<ファイル>`。text/htmlで返り、
    相対パスのJS/CSSも読める。無料・Vercel枠を使わない。ブランチ名に「/」を含んでも可)。
- **実装が完了し、正式にアプリを公開する段階**: Vercel側でこのリポジトリとの
  Git連携を(再)設定し、対象フォルダをRoot Directoryとしてデプロイして、
  そのVercel URLをユーザーへ案内する(上記の基本方針通り)。
- **公開後にさらに修正が必要になった場合**: コード編集作業に入る前に、Vercel側の
  Git連携を再度有効化してから作業する(修正が完了して連携を解除するかどうかは
  その都度判断)。

## マージ後の本番反映チェック(Git連携の戻し忘れ防止)(2026-09-24〜)

開発中にVercelのGit連携を解除したまま、公開時に戻し忘れると、mainへマージしても
本番(Vercel URL)が古いまま残る。これに気付けるよう、以下を必ず行う。

- mainへマージしたら、Vercelツール(`list_deployments`等)で対象アプリのVercel
  プロジェクトのデプロイ一覧を確認する(読み取りのみでデプロイ枠は消費しない)。
- 今回のマージコミットのデプロイが存在しない場合は、「Git連携が解除されているため
  本番(Vercel URL)には未反映」とユーザーへ明示的に伝え、公開するなら連携を
  戻す手順(Settings → Git → GitHub → `aism24/-` をConnect → 次のmainマージ or
  Deployments → Create Deployment(main))を案内する。jsDelivrでの確認だけで
  「完了」と報告しないこと。
- 連携を戻す際は Settings → Build and Deployment → Ignored Build Step が
  「Automatic」になっていることも確認する(`exit 0` / Don't build anything が
  残っていると本番に反映されない)。

## Vercelへデプロイする前の確認(他アプリの連携解除忘れ防止)(2026-09-24〜)

Vercelへのデプロイは毎回ではなく、公開するときだけ行う。このリポジトリに連携した
ままのVercelプロジェクトが他にあると、mainへのpush/マージのたびにそのプロジェクト
もデプロイされ、デプロイ枠(Hobby: 1日100回)を消費する。そのため、Vercelへ
デプロイする作業(連携を戻してのマージ等)の**前に**、次の2条件を両方満たして
いることを確認してから実装・マージする。

1. **別のアプリはデプロイできない状態**: 対象以外のVercelプロジェクトがこの
   リポジトリ(`aism24/-`)とGit連携していないこと。
2. **該当アプリはデプロイできる状態**: 対象アプリのVercelプロジェクトだけが
   連携済みで、Ignored Build Step が「Automatic」になっていること。

確認方法:
- Vercelツールの `list_projects` に `repoUrl: "https://github.com/aism24/-"` を
  指定すると、このリポジトリと連携中のプロジェクトだけが返る。結果が
  **対象アプリ1件だけ**なら条件OK。他のプロジェクトが含まれていたら、マージせず
  ユーザーに「◯◯の連携が残っているので先に解除してください」と伝える。
  (0件なら対象アプリも未連携なので、連携を依頼する。)
  ※2026-09-24、pdf-diff-pythonappを再連携した直後にこのフィルタで1件
  (pdf-diff-pythonappのみ)返ることを確認済み(フィルタは正しく機能する)。
- 念のためマージ後に `list_deployments` で直近のデプロイを確認し、対象アプリ以外の
  デプロイが発生していないことを確かめて報告する。
- 公開が終わって開発モードへ戻す(連携を解除する)ときも、上記の方法で0件に
  なったことを確認し、下の状態表を更新する。

### 【厳守】pdf-diff-app(pdf-diff-pythonapp)のGit連携・デプロイ(2026-09-24〜、ユーザー指示)

- pdf-diff-appはPythonのサーバーレス関数を持つため、**1デプロイごとにFunctions Storage
  (Hobby上限10GB、超えるとデプロイ不可)を消費する**。他の静的アプリとは違い、デプロイ回数が
  そのまま容量に効く。**デプロイはできるだけ少なくすること。**
- Git連携中は、ブランチへのpush(Preview)とmainへのマージ(Production)の**両方**でデプロイが
  発生しうる。連携するのは本番反映する時だけにし、反映したら**すぐ解除を依頼**する。
- 連携中は、pdf-diff-app以外の修正(CLAUDE.md等のドキュメントのみの変更を含む)もpush/マージ
  しない(Skip deploymentsは当てにならない)。まとめて、連携解除後に行う。
- 修正は複数をまとめて1回のデプロイで反映する。動作確認のためだけの試しデプロイはしない
  (ロジックはローカルのリグレッションテストで確認してから、本番デプロイは1回で済ませる)。
- 本番デプロイは、連携後に Create Deployment(main)で**1回だけ**行い、`list_deployments`で
  1件だけであることを確認する。

### 【厳守】Functions Storageの管理目標: 7GB以下(2026-09-24〜、ユーザー指示)

上限10GB(超えると何もデプロイできなくなる)の手前、**残り3GB=7GBを管理ライン**とする。
平均的に7GBを超えないよう、pdf-diff-app等(関数を持つアプリ)をデプロイする前に必ず次を行う。

1. **デプロイ前に現在値を確認**: VercelツールではUsageの数値を取得できないため、ユーザーに
   Usage画面(All Projects)のFunctions Storageの現在値を教えてもらう(表示されない場合は下の記録表の最後の値で判断する)。
2. **判定**(1デプロイあたりの増分の目安: pdf-diff-app統合版で約60MB。2026-09-24実測):
   - 現在値+増分が **7GB未満** → デプロイしてよい。
   - **7GB以上になる/既に7GB以上** → デプロイしない。先にユーザーへ古いデプロイの削除
     (プロジェクト → Deployments → 現在の本番以外を削除)を依頼し、7GB未満に戻ったのを
     確認してからデプロイする(削除しても反映に時間がかかる場合がある)。
3. **デプロイ後**: 反映(数時間かかる場合あり)後の数値をユーザーに確認してもらい、下の記録表に追記する。
- 関数を持つアプリを新しく作る・依存パッケージを増やす場合は、1デプロイあたりの増分が
  大きくなるため、事前にユーザーへ影響(見込み増分)を説明して了承を得る。

| 日付 | Functions Storage | 内容 |
|---|---|---|
| 2026-09-24 | 5.74GB → 5.80GB(+約60MB) | pdf-diff-app関数統合版(PR #306)を本番デプロイ |
| 2026-09-28 8:10 | 5.8GB(変化なし) | 9/23以前の古いデプロイを削除した後の値(9/24分の17件は残置)。削除の反映待ちの可能性あり |
| 2026-09-28 16:30頃 | (Functions Storageの項目が表示されない) | 同日8時には「Functions Storage 5.8GB」「Deployment Storage 277.41MB」が別々に表示されていたが、16:30頃はFunctions Storageの行が消え、Deployment Storageは1.39MBに(All Projects)。この時点でpdf-diff-pythonappの9/24分のデプロイ17件は残っており、容量が空いた根拠は無い。原因不明(Vercel側の表示・集計の変化の可能性)のため、再び表示されるまで約5.8GBとみなして管理する |
| 2026-09-29 | 9/28: 2.2GB、9/29: ほぼ0(集計途中の可能性) | Usage → Functions Storage(All Projects・Last 30 Days)のグラフで確認。9/27まで約5.8GBで横ばい→9/28に2.2GB→9/29にほぼ0。9/28朝の古いデプロイ(9/23以前)削除が遅れて反映されたとみられる(削除から反映まで約1日)。pdf-diff-pythonappの9/24分17件は残っているので、9/29の確定値は翌日以降に再確認 |
| 2026-10-01 10:30 | 0 B(確定) | 9/30 8:30頃にpdf-diff-pythonappのデプロイを現在の本番(#306)1件だけに削除(2.2GB分)。9/30 14時・10/1 8時・10/1 10:30(UTCの日付が変わった後)とも0 B。**残した本番1件はFunctions Storageの数値に含まれない(0 B)**。Deployment Storageは同期間に3.53MB→9.49MB→96.87MB→5.28MBと変動したが、上限10GBに対し誤差程度 |
| 2026-10-19 | (未確認。反映後にUsage画面で確認して追記する) | 「← アプリ一覧へ」ボタン追加(PR #760)の反映で pdf-diff-pythonapp を `create_deployment` で本番デプロイ1回(dpl_HpRX9Ur2Q1sQaqbigZww8TcPYJFa)。本番デプロイは9/24分(dpl_Fg1vwxBsjHgHo52sCcH1GwstE1fR)と今回分の2件。9/24分は未削除(削除の判断はユーザー)。増分の見込みは約60MB |

【古いデプロイの削除とFunctions Storageの反映】(2026-09-29確認、2026-10-01更新)
- 古いデプロイを削除すれば、30日の保持期間を待たずにFunctions Storageは減る。Usageは**UTC基準の日単位で集計**されるとみられ、
  削除後に**日本時間9:00(UTCの日付の変わり目)を過ぎると反映**される(9/28・9/30とも8時台に削除 → 直後は変化なし → 9:00以降の集計で減少)。
  ※2回とも9時前の削除のため、9時以降に削除した場合も同じかは未確認。削除直後に見て「消しても減らない」と判断しないこと。
- 現在の本番1件だけ残した状態ではFunctions Storageは0 B(2026-10-01確認)。つまりFunctions Storageを消費するのは「本番以外の古いデプロイ」で、
  pdf-diff-app等を本番デプロイした後に旧本番を削除すれば、ほぼ0に戻せる。
- 削除してよいのは「現在の本番(Production・Current)以外」のデプロイ。本番のデプロイを消すとアプリが表示されなくなる。
  本番以外を消しても、アプリ(本番URL)は正常に動く(2026-09-29、削除後に pdf-diff-pythonapp・sonekibunki・daily-report の本番URLと
  pdf-diff-appの関数 /api/diff の応答を確認済み)。消したデプロイへのロールバック(Instant Rollback)はできなくなる。

※既存分はHobbyの30日保持により、最初のデプロイ(2026-09-19)から30日後の10月19日頃から順次減っていく見込み。

### 現在のGit連携状態(変更したらここを更新する)

| Vercelプロジェクト | 対象フォルダ | Git連携 | 備考 |
|---|---|---|---|
| pdf-diff-pythonapp (https://pdf-diff-pythonapp.vercel.app/) | pdf-diff-app | 解除(2026-09-24、関数統合版を本番デプロイ後に再解除) | |
| daily-report (https://all-daily-report.vercel.app/) | daily-report | 解除(2026-09-24) | `daily-report/vercel.json` で `git.deploymentEnabled=false`。Ignored Build Step=`git diff HEAD^ HEAD --quiet -- .` |
| shipping-list-link (https://shipping-list-link.vercel.app/) | shipping-list-link | 連携は現在解除(2026-10-07、ユーザーが解除し `list_projects` 0件を確認。10/7は一時連携→#640・#641を `create_deployment` で本番デプロイ(10/7計3回)→解除。作成時は連携済みで、10/5までに本番デプロイ5回) | 静的サイト+`api/links.js`(小さいNode関数)。`vercel.json` の `git.deploymentEnabled=false` で自動デプロイ停止。本番反映は「デプロイして」の指示時のみ `create_deployment`(連携を解除した状態でも実行できるかは未確認。連携を戻す場合は先に他アプリの連携が無いことを確認)。引き継ぎ書はDriveの保存先フォルダ(上の表)にある |
| sonekibunki(旧・運用停止。2026-10-09〜。https://sonekibunki.vercel.app/) | production-profit | 解除(2026-09-29、#416〜#424を本番デプロイ後にユーザーが解除。`list_projects` 0件を確認。`vercel.json` の `git.deploymentEnabled=false` は残置) | 静的サイト(関数なし)。本番反映は `create_deployment` で行う。GitHub Pages版は廃止(index.htmlでVercel版へ転送)。**【運用停止】コストインサイトと同じ内容になったため、損益分岐の旧アプリは使わない。フォルダ(production-profit/)はGitHubに削除せず残置。Vercelプロジェクトはユーザーが削除予定。新規の作業・デプロイ・ランチャー登録の対象にしないこと** |
| cost-insight (https://cost-insight.vercel.app/) | cost-insight | 解除(2026-10-06、ユーザーが解除。`list_projects` 0件を確認) | 静的サイト。`cost-insight/vercel.json` の `git.deploymentEnabled=false` で自動デプロイ停止。本番反映は「デプロイして」の指示時のみ `create_deployment`(project=cost-insight)。引き継ぎ書はDriveの保存先フォルダ(上の表) |
| tori-robo (Vercelプロジェクト名「-tori-robo」。https://tori-robo.vercel.app/) | tori-robo | 解除(2026-10-07、10/6にユーザーが一時連携→sp43〜sp50(6回)を `create_deployment` で本番デプロイ→10/7にユーザーが解除。`list_projects` 0件を確認) | `tori-robo/vercel.json` の `git.deploymentEnabled=false` で自動デプロイ停止。本番反映は「デプロイして」の指示時のみ `create_deployment`(teamIdは渡さない=403)。引き継ぎ書はDriveの保存先フォルダ(上の表) |
| app-launcher (https://app-launcher-ashy.vercel.app/) | app-launcher | 解除(2026-10-05〜06にユーザーが解除。`list_projects` 0件を確認)| `app-launcher/vercel.json` の `git.deploymentEnabled=false` で自動デプロイ停止。本番反映は「デプロイして」の指示時のみ `create_deployment`(同一SHAは `forceNew` を付ける。値は数値の `1`。文字列 `"1"` は入力エラー)。Ignored Build Stepに `-- ./app-launcher` のコマンドが入っていると常にスキップされる(原因判明・解消済み)。2026-10-16、お気に入り機能(会社ロゴのON/OFF・上=お気に入り/下=すべて。localStorage `appLauncherFavorites_v1`)を追加し、連携なしのまま `create_deployment` で3回本番デプロイ(dpl_36u1Lmq・dpl_6knoXhP・dpl_14MB4yR、READY、最新コミット8518188、`list_projects` 0件を確認)。同日、`masamiz-production-management.vercel.app` を常にお気に入りに固定(オンオフ不可。`app.js` の `PINNED_HOSTS`)。仕様の詳細は `app-launcher/README.md`。引き継ぎ書(最新v15)はDriveの保存先フォルダ(上の表)にある |
| company-ai (Vercelプロジェクト名「company-ai」) | company-ai | 解除(2026-10-08、ユーザーが誤って連携→解除。`list_projects` 0件を確認。連携中の約16分間〜数時間に、company-ai自身のコミット#662・#668・#676・#678で自動デプロイが発生) | 連携なしでの `create_deployment` は未検証(次の「デプロイして」で確認する)。`vercel.json` の `git.deploymentEnabled=false` があるかは未確認。引き継ぎ書はDriveの保存先フォルダ(上の表) |
| tdf-dim-count (https://tdf-dim-count.vercel.app/) | tdf-dim-count | 解除(2026-10-14、ユーザーがVercelでプロジェクトを新規作成=Root Directory `tdf-dim-count`。作成時に自動で本番デプロイ1回(dpl_G84HA3B、コミットb9d10fd=PR #711)→直後にユーザーが連携を解除。`list_projects` 0件を確認。同日、連携なしのまま `create_deployment` で2回目(dpl_quJeD8U、コミットe748bcb=PR #713。連携なしでもデプロイできることを確認)と3回目(dpl_6cPiPf3、コミットcddd081=PR #716。利用記録のGAS URL設定)を本番デプロイ。4回目(dpl_5dvBaEK、コミットd2a41e5=PR #719。手順書ビューア・説明文ヘッダー)を「デプロイして」の指示で本番デプロイ=連携なし。10/14のデプロイは計4回) | アプリ名「実寸データより長さと本数集計」。静的サイト(関数なし)。Excelダウンロード時に、GAS(`tdf-dim-count/gas/Code.gs`、スプレッドシート「tdf-dim-count」にコンテナバインド)へファイル名・レイヤ・総本数を送り、シート「記録」の2行目に追記(2026-10-14、`app.js` の `GAS_URL` に設定)。`tdf-dim-count/vercel.json` の `git.deploymentEnabled=false` で自動デプロイ停止。本番反映は「デプロイして」の指示時のみ `create_deployment`(連携は不要)。TDF(OLE原本14MB含む)のレイヤ選択で、斜め寸法の手配長さ・本数を集計しExcel出力。解析のやり方は `docs/know-how.md`。ヘッダー右の「操作・準備説明書」ボタンで手順書(全8ページ)を表示(画像 `tdf-dim-count/manual/p-1〜8.jpg`、元PDFは `docs/manual-draft/`。ページ数を変えたら `index.html` のスクリプトの `N` も直す) |
| jissun-open (https://jissun-open.vercel.app/) | jissun-open | 連携なし(`list_projects` 0件を確認、2026-10-16) | アプリ名「実寸法師を開く」(アプリランチャーapp009)。静的サイト(関数なし)。開くと `jissun://` で社内共有フォルダのHTMLを開かせる入口。開かれた日時をGAS(`jissun-open/gas/Code.gs`、スプレッドシート「実寸法師を開く_Vercel記録」にバインド)でシート「記録」のA2に追記(常にA2が最新)。`vercel.json` の `git.deploymentEnabled=false` で自動デプロイ停止。本番反映は「デプロイして」の指示時のみ `create_deployment`(project=jissun-open、teamIdは渡さない)。**2026-10-16、Ignored Build Stepに `-- ./jissun-open` のコマンドが入っていて1回目がCANCELED→ユーザーが「Automatic」に変更→forceNew=1で2回目がREADY(10/16は計2回)**。引き継ぎ書はDriveの保存先フォルダ(上の表) |
| huguai (Vercelプロジェクト名「tori-huguai」。https://tori-huguai.vercel.app/) | huguai | 解除(2026-10-15、ユーザーがVercelでプロジェクトを作成し、本番デプロイ1回(dpl_CPJjCRe、コミット1d00b81=PR #726)→直後にユーザーが連携を解除。`list_projects`(repoUrl=aism24/-)0件を確認。ユーザーの手動デプロイでClaudeの `create_deployment` ではない。2026-10-16、「デプロイして」の指示で `create_deployment` により、2回目(dpl_6BNecPu、コミット17bf6db=PR #730、PDF固定幅1280px)、3回目(dpl_HuWZsmy、コミット1d9b8cb=PR #733月リストの並び・#734年度連動)、4回目(dpl_BjEauQ4、コミット19063ad=PR #735取得中の表示・#736今月に戻す・#737見出しの年表記)を、連携なしで本番デプロイ、いずれもREADY。10/16のデプロイは計3回) | アプリ名「社内不具合アプリNew」(社内不具合記録アプリ(鳥取)のVercel版)。静的サイト(関数なし)。`huguai/vercel.json` の `git.deploymentEnabled=false` で自動デプロイ停止。GAS(`huguai/gas/Code.gs`、スプレッドシート「社内不具合アプリVercel版」にバインド)がデータ処理。本番反映は「デプロイして」の指示時のみ `create_deployment`(teamIdは渡さない=403。project=tori-huguai)。2026-10-15時点でClaudeのVercelツールは `get_project` 等がteam指定で403、`web_fetch_vercel_url` も403(本番ページの中身は未確認)。引き継ぎ書はDriveの保存先フォルダ(上の表)にある |
| truck-fax(Vercelプロジェクトは未作成) | truck-fax | 未連携(プロジェクト自体が無い。2026-10-20) | アプリ名「車番連絡 取込」(スプレッドシート「車番連絡自動化」)。画面の確認はraw.githack(コミット固定のURL)。`truck-fax/vercel.json` の `git.deploymentEnabled=false` で自動デプロイ停止済み。公開するときは、ユーザーがVercelでプロジェクトを作成(Root Directory=truck-fax)→「デプロイして」の指示で `create_deployment`(teamIdは渡さない)。GAS(`truck-fax/gas/Code.gs`。コンテナバインド。Webアプリは「全員」)は、貼り替え→「新バージョン」で反映する(`CODE_VERSION` で確認)。引き継ぎ書はDriveの保存先フォルダ(上の表) |

2026-10-19、15プロジェクト(pdf-diff-pythonapp・daily-report・jissun-open・tori-huguai・shipping-list-link・tdf-dim-count・excel-drawing-link-tool・dxf-launcher・company-ai・cost-insight・-tori-robo・jissun-master-jidokinyu・unso-check・-tdf-master-web・production-management)を、ユーザーの「デプロイして」で `create_deployment` により本番デプロイ(ボタン追加の反映。コミット96e4414)。連携は0件のまま(`list_projects` で確認)。直近24時間のデプロイ回数は計20回(上限100)。**`vercel.json` の `git.deploymentEnabled=false` が無いフォルダ: pdf-diff-app(functionsの設定だけ)・unso-check・production-management・tdf-master-web・jissun-master-jidokinyu・kozai-toriai・weld-heat-management。連携は0件なので今は自動デプロイされないが、これらのVercelプロジェクトを `aism24/-` に連携し直す前に、必ずそのフォルダへ置くこと(特に pdf-diff-app は1デプロイごとにFunctions Storageを消費する)。**
2026-10-14、tdf-dim-count(新規)も作成直後に連携を解除し、`list_projects`(repoUrl=aism24/-)は0件(全アプリ未連携)。
2026-10-08、`list_projects`(repoUrl=aism24/-)は0件(全アプリ未連携)。cost-insightは連携なしのまま `create_deployment` で本番デプロイできた(dpl_EthcYT7、コミット5c49df9)。
**運用の原則**: 全アプリのGit連携を解除したままにする。連携が無ければpush・マージでデプロイは起きず、ユーザーが「デプロイして」と指示したアプリだけを `create_deployment` で1つずつデプロイする(連携は不要。Vercelプロジェクトの新規作成と連携の付け外しだけがユーザー操作)。連携が1件でも残っていたら、これまで通りpush・マージ前にユーザーへ解除を依頼する。

2026-10-07現在、`list_projects`(repoUrl=aism24/-)は0件(全アプリ未連携。cost-insight・tori-robo・app-launcherとも解除済み)。
2026-10-07(午後)、shipping-list-linkも解除済みで0件を再確認。

2026-09-29、sonekibunkiの連携も解除され、`list_projects`(repoUrl=aism24/-)は0件(全アプリ未連携)。公開時は連携を戻してから、指示があったときだけ `create_deployment` で1回デプロイする。

2026-09-27、sonekibunki(production-profit)を新規作成・連携。以降(〜9/28の解除まで) `list_projects`(repoUrl=aism24/-)は sonekibunki の1件が正常(vercel.jsonで自動デプロイ停止済み)。それ以外が返ったらマージしないこと。

2026-09-24、ユーザーが全プロジェクトのGit連携を解除。`list_projects`(repoUrl=aism24/-)の結果が0件であることを確認済み(push/マージしてもデプロイされない状態)。

※2026-09-24、PR #306(関数を`api/diff.py`1本に統合・scipy除去)を本番デプロイ済み(1件のみ、3モードとも正解値一致を本番APIで確認)。その後連携を再解除し0件を確認。

※Functions Storage(Hobby上限10GB)の大半はpdf-diff-pythonapp。(以下は統合前の状況)3つのPython関数それぞれに約300MBのライブラリ
(scipy 143MB・numpy 73MB・PyMuPDF 65MB等)が同梱され、1デプロイ≒1GB消費する。デプロイは必要最小限にすること。

【反省・厳守】2026-09-24、daily-reportの修正時にpdf-diff-pythonappの連携が残っているのを
確認しながら「Skip deploymentsが有効だから大丈夫」と自己判断してpush・マージし、
pdf-diff-pythonappのデプロイが2回(ブランチpushのPreview+mainマージのProduction)発生した。
**Skip deploymentsは当てにならない。対象以外の連携中プロジェクトが1件でもあれば、
push・マージは一切せず、先にユーザーへ解除を依頼すること。**(ブランチへのpushだけでも
Previewデプロイが発生する)

【Ignored Build Stepの注意】コマンドはRoot Directory内で実行される。
`git diff HEAD^ HEAD --quiet -- ./<フォルダ名>` と書くと存在しないパスを指して常にスキップ
(CANCELED)になるため、`-- .` と書く。

## 【絶対条件】引き継ぎ書などは会社アカウントの指定フォルダ(アプリごと)に保存する(個人アカウントのマイドライブに保存しない)(2026-09-29〜、ユーザー指示)

> **【禁止・再確認】(2026-09-30 ユーザー指示。GitHubセッション・ローカルセッションの両方で厳守)**
> **「ユーザーの(個人の)Googleドライブに引き継ぎ書を保存することを禁止する。」**
> 引き継ぎ書をドライブに保存するときは、毎回、保存場所に注意すること。保存の手順は次の通り(1つでも満たせなければ保存しない):
> 1. 下の表で、対象アプリの保存先フォルダ(parentId)を確認する。表に無いアプリは保存せず、ユーザーに保存先を聞く。
> 2. 保存前に `search_files`(`parentId = '<フォルダID>'`)で、そのフォルダに対象アプリの管理用スプレッドシートがあることを確かめる。
> 3. `create_file` には必ず `parentId` を指定する(省略・`root` 指定は禁止)。
> 4. 保存後、返ってきた `parentId` が指定フォルダと一致することを確認し、報告に保存先フォルダを明記する。

- 引き継ぎ書などのGoogleドライブのファイルは、**会社アカウントの、そのアプリ用に指定されたフォルダ**に作って保存する。
  フォルダはアプリごとに分かれている。**下の表のフォルダIDは、そのアプリ専用。別のアプリのファイルを保存しない。**
- Google Driveツールの create_file では、対象アプリのフォルダIDを parentId に必ず指定する。

| アプリ | 保存先フォルダ(会社アカウント) | parentId |
|---|---|---|
| 生産損益分析アプリ(損益分岐。production-profit / sonekibunki) | https://drive.google.com/drive/folders/1Ly54tAkSLk5zFTmohHrj2thy7BNPTaWg | `1Ly54tAkSLk5zFTmohHrj2thy7BNPTaWg` |
| 実行予算まとめアプリ(管理用スプレッドシート「実行予算」も同じフォルダ内。2026-09-29登録) | https://drive.google.com/drive/folders/1EwfXNOal_AdY6MzARgEGV_aKAcf6HjWN | `1EwfXNOal_AdY6MzARgEGV_aKAcf6HjWN` |
| コストインサイト(cost-insight。原価管理・生産進捗分析。管理用スプレッドシート「コストインサイト」も同じフォルダ内。2026-10-01登録) | https://drive.google.com/drive/folders/1iB0Za-pfjZm3jfgyhQ4ktMkhEaCjivbO | `1iB0Za-pfjZm3jfgyhQ4ktMkhEaCjivbO` |
| 梁ロボ(tori-robo。鳥取梁ロボ管理。管理用スプレッドシート「鳥取梁ロボ管理データ」も同じフォルダ内。2026-10-02登録) | https://drive.google.com/drive/folders/1E0FH8FPtfcyyIK-lH0O-JC1I1vRCb5Iw | `1E0FH8FPtfcyyIK-lH0O-JC1I1vRCb5Iw` |
| リンク付き出荷リスト(shipping-list-link。出荷リストPDFの製品名に実寸法師へのハイパーリンクを付与。元PDF・リンク表・記録シート「PDFに図番ハイパーリンク付与」も同じフォルダ内。2026-10-05登録。引き継ぎ書のGoogleドキュメントのタイトルは「リンク付き出荷リスト」) | https://drive.google.com/drive/folders/1vekpzwfn-W0MqRyWWYzWdS4A6jp2bEt3 | `1vekpzwfn-W0MqRyWWYzWdS4A6jp2bEt3` |
| アプリランチャー(app-launcher。アプリ一覧・検索。管理用スプレッドシート「アプリ一Launcher」も同じフォルダ内。引き継ぎ書のGoogleドキュメントのタイトルは「アプリランチャー引き継ぎ書 (vN) 最新版」。2026-10-05登録) | https://drive.google.com/drive/folders/1wjoBjlZ4lzCt7weocczUVRfjZV4axbpX | `1wjoBjlZ4lzCt7weocczUVRfjZV4axbpX` |
| 日報全期間集計(daily-report。管理用スプレッドシート「日報集計アプリ」も同じフォルダ内。引き継ぎ書のタイトルは「日報アプリ引き継ぎ書」。2026-10-06登録) | https://drive.google.com/drive/folders/1RYjLWyC2mxSq8_Jzan-pWnpxrsvcTYgL | `1RYjLWyC2mxSq8_Jzan-pWnpxrsvcTYgL` |
| 社内AI(company-ai。就業規則などへの質問応答。管理用スプレッドシート「社内AI」も同じフォルダ内。引き継ぎ書のGoogleドキュメントのタイトルは「社内AI 引き継ぎ書 (vN) 最新版」。2026-10-07登録) | https://drive.google.com/drive/folders/1cu5MjHLvq4Vw5D4XT74tp43heg6lA3RT | `1cu5MjHLvq4Vw5D4XT74tp43heg6lA3RT` |
| 実寸データより長さと本数集計(tdf-dim-count。TDFのレイヤ別に寸法の長さ・本数を集計。管理用スプレッドシート「tdf-dim-count」(シート「記録」=Excelダウンロード時の利用履歴。GAS経由)も同じフォルダ内。2026-10-14登録。引き継ぎ書のGoogleドキュメントのタイトルは「実寸データより長さと本数集計 引き継ぎ書 (vN) 最新版」(2026-10-14に v1〜v3 を作成。最新は v3)。リポジトリ内のREADME・tests・know-howも記録) | https://drive.google.com/drive/folders/1SHZZBXgv6Z21E-vDi4VldUUuuPsZVn4R | `1SHZZBXgv6Z21E-vDi4VldUUuuPsZVn4R` |
| 社内不具合アプリ（huguai。不具合記録アプリ(鳥取)のVercel版。`huguai/`。管理用スプレッドシート「社内不具合アプリVercel版」「社内不具合アプリHTML」「不具合アプリ結果表示」も同じフォルダ内。2026-10-15登録。引き継ぎ書のGoogleドキュメントのタイトルは「社内不具合アプリ（huguai） 引き継ぎ書 (vN) 最新版」(2026-10-15に v1〜v4、2026-10-16に v5・v6 を作成。最新は v6)) | https://drive.google.com/drive/folders/109FIFxFVC3sQU9S2tx596jMLJzrAkmgD | `109FIFxFVC3sQU9S2tx596jMLJzrAkmgD` |
| 実寸法師を開く(jissun-open。`jissun://` で社内共有フォルダのHTMLを開く入口。管理用スプレッドシートは「00_マスタから実寸法師を開く」(旧open_jissun用データ元)と「実寸法師を開く_Vercel記録」(開かれた日時の記録。シート「記録」)が同じフォルダ内。2026-10-16、ユーザーがフォルダを指定して登録。引き継ぎ書のGoogleドキュメントのタイトルは「実寸法師を開く_引き継ぎ書 (第N版) 最新版」(第3版=2026-10-16が最新。第1・2版は同じフォルダの「実寸法師を開く_引き継ぎ書」)) | https://drive.google.com/drive/folders/1OUOznQizC__sdPOHTe3lbjvfZxSj72IC | `1OUOznQizC__sdPOHTe3lbjvfZxSj72IC` |
| 鳥取運送アプリ(unso-check。運送業者の配車Excelを取り込み、21日始まり・20日締めの締め月ごとに請求チェック・年度集計。管理用スプレッドシート「鳥取運送アプリ」と、サブフォルダ「保存用バックアップ」が同じフォルダ内。2026-10-19、ユーザーが引き継ぎ書を共有して登録。引き継ぎ書のタイトルは「鳥取運送アプリ_引き継ぎ書(更新版N・日付)最新版」(2026-10-19に更新版11を作成。更新版10までは「鳥取運送アプリ_引き継ぎ書」)) | https://drive.google.com/drive/folders/1-Bklp4MLRbf-WL1H1rvdo26wOczl0puB | `1-Bklp4MLRbf-WL1H1rvdo26wOczl0puB` |
| 生産管理ダッシュボード(production-management。3拠点の生産実績を案件マスターExcelから集計。索引スプレッドシート「Excelマスタ一覧」(GASのコンテナバインド元)・キャッシュJSONが同じフォルダ内。2026-10-19、ユーザーが引き継ぎ書を共有して登録。引き継ぎ書のタイトルは「生産管理ダッシュボード_引き継ぎ書(YYYY年M月D日版)」(2026-10-19に作成。旧版も残置)) | https://drive.google.com/drive/folders/1mj4vsEHTkaSjuMrqRC7NMGCYc2JC9EIo | `1mj4vsEHTkaSjuMrqRC7NMGCYc2JC9EIo` |
| PDF比較解析アプリ(pdf-diff-app。新旧PDFの表・文章・図面の差分表示。記録用スプレッドシート「PDF差分解析（表、文章、図面）」と、サブフォルダ「ローカル実行済み正解データ」が同じフォルダ内。2026-10-19、ユーザーが引き継ぎ書を共有して登録。引き継ぎ書のタイトルは「PDF比較解析アプリ 引き継ぎ書(YYYY-MM-DD更新版)」(2026-10-19に更新版を作成。旧版も残置)) | https://drive.google.com/drive/folders/1aTNiacBOpV8Tq_PlR4VTX8yPGscGIbQ1 | `1aTNiacBOpV8Tq_PlR4VTX8yPGscGIbQ1` |
| 車番連絡自動化(truck-fax。運送の車番連絡FAX(PDF)をGeminiで読み取り、取込一覧・車両情報・運転手携帯番号に記録。管理用スプレッドシート「車番連絡自動化」が同じフォルダ内。フォルダ名「10　夢前車番連絡FAX」。2026-10-20、ユーザーが「シートがあるフォルダでよい」と指示して登録。引き継ぎ書のGoogleドキュメントのタイトルは「車番連絡自動化 引き継ぎ書 (vN) 最新版」(2026-10-20に v1 を作成)) | https://drive.google.com/drive/folders/1uHVLxK9NEcLrSGr9zvf9QOn6D3iWIfJr | `1uHVLxK9NEcLrSGr9zvf9QOn6D3iWIfJr` |
| 上記以外のアプリ(dxf-launcher・excel-drawing-link-tool・jissun-master-jidokinyu・tdf-master-web など) | 未登録(ユーザーがアプリごとに指示する。指示されたらこの表に追記する)。2026-10-19、この4アプリの引き継ぎ書は、ユーザーがローカルで管理・差し替えている(ドライブには保存していない。Claudeはテキスト/マークダウンで渡した) | - |

- **【厳守】Driveのファイル名変更・移動(`update_file`)をしたら、個人のマイドライブ直下に混入していないか必ず確認する(2026-10-19、実際に発生)。**
  `update_file` でタイトルだけを変えた複数のファイルで、親フォルダに「個人のマイドライブ直下」が追加される副作用があった(元の会社フォルダにも残るが、個人ドライブに存在する状態になる。引き継ぎ書を個人ドライブへ保存することは禁止)。
  名前を変えたら、そのファイルに `parentId`=元の会社フォルダ を指定した `update_file` を続けて実行して直下から外し、`search_files`(`parentId = 'root'` かつ `mimeType` がドキュメント)で0件になったことを確認してから報告する。
  2026-10-19には、過去の作業で混入していた旧版9冊+日報2冊も同じ方法で元のフォルダへ戻し、直下0件を確認した。新規作成(`create_file`+`parentId`指定)では、この混入は起きなかった。

- **保存先フォルダはユーザーがアプリごとに指示する。** 指示が無いアプリは、推測で決めずにユーザーに聞く。
- **保存前に、そのフォルダが本当に対象アプリのものか確認する。** ほとんどのアプリは、管理用スプレッドシートが同じフォルダ内にある。
  フォルダ内のファイル一覧(search_files で parentId を指定)でスプレッドシート名を見て、引き継ぎ書に書かれている管理用スプレッドシート名
  (例: 生産損益分析アプリは「損益分岐点生産重量」)と合致することを確かめてから保存する。合致しない・見当たらない場合は保存せずユーザーに確認する。

- 指定フォルダは、ユーザーの接続アカウント(Driveコネクタ)で保存できるように共有されている。**コネクタのアカウントのまま、指定フォルダに保存すればよい**
  (所有者欄が masamiz.sumi@gmail.com と表示されても問題ない。チャットに本文を出して済ませたり、アカウントの接続し直しを求めたりしない)。
- **parentId を指定せずに作る(=個人アカウントのマイドライブに保存する)ことは絶対にしない。** 個人アカウントのマイドライブに保存するのは、
  ユーザーが特別に指定したときだけ。
- 引き継ぎ書を更新するときは、そのアプリの指定フォルダ内の最新版(search_files で title に「引き継ぎ書」、modifiedTime の新しいもの)を読んでから、
  それを元に新しい版を同じフォルダに作る(タイトルに日付と「最新版」等を入れる)。

## 【厳守】Vercelへのデプロイはユーザーの「デプロイして」の指示があったときだけ(2026-09-28〜、ユーザー指示)

- 修正→push→mainへマージまでは進めてよいが、`create_deployment` はユーザーが明示的に「デプロイして」と
  言ったときだけ実行する。マージ後は「mainへ反映済み・本番(Vercel)は未反映。デプロイする場合は指示を」と報告する。
- 2026-09-28、sonekibunki(production-profit)で修正のたびに指示なくデプロイし(1日に計7回)、ユーザーから指摘を受けた。
- デプロイしたときは、報告の冒頭に直近24時間のデプロイ回数(上限: Hobby 1日100回)を必ず書く。

## 【厳守】GAS等のコードのURLを案内する前に、GitHub上が最新か確認する(2026-10-02〜、ユーザー指示)

- Code.gs・Index.html 等のGAS関連コードのGitHubのURL(blob形式)をユーザーへ案内する前に、
  push済みの最新コミットがGitHub上のファイルに反映されていることを確認する。
  確認方法の例: `git ls-remote origin <branch>` が手元のHEADと一致 + raw.githubusercontent.com の
  該当ファイルに今回の変更箇所(目印の文字列)が含まれること。ラグがある場合は反映を待ってから案内する。
- 確認した旨(最新コミットのハッシュなど)を案内文に添える。ユーザーに何度も言わせないこと。
- **案内するURLは、コミット固定の blob URL(`https://github.com/<owner>/<repo>/blob/<コミットSHA>/<path>`)にする**(2026-10-20、ユーザー指示「Code.gsがしっかり更新されたことを確認してから送る事。何度やっても古いものしかない」)。
  原因: 通常のファイル表示ページ(blob/main)は最新でも、「Copy raw contents」が取りに行く `raw.githubusercontent.com/.../main/...` は数分間古いままだった(コミット固定なら即時に最新)。
  Code.gs を直したら `CODE_VERSION` を更新し、デプロイ後に公開中のGASの `ping`(版の番号を読むだけ)で版を確認してから「反映できた」と報告する。画面の上部の「GAS版:」でもユーザーが確認できる(truck-fax)。
- アプリの確認用URL(raw.githack.com 等)は、報告のたびに毎回添付する(ユーザー指示 2026-10-02)。
- **【厳守】確認用URL(raw.githack.com)にもラグがある(2026-10-02、ユーザー指示。何度も言わせないこと)。**
  URLを添付する前に、**今回のpushが実際にそのURLへ反映されたことを確認してから**添付する。
  確認方法: index.html に `?v=<目印>` を付けたJS/CSSの版を毎回更新しておき、
  `curl -s "https://raw.githack.com/aism24/-/<branch>/<フォルダ>/index.html" | grep -o 'app.js?v=[a-z0-9]*'`
  が今回の版と一致するまで待つ(raw.githubusercontent.com では最新なのに raw.githack では古い、という状態が
  数分続くことがある。2026-10-02確認)。一致を確認できないうちは「反映待ち」と伝え、
  反映されたと断定しない。報告には、確認した版の目印と確認時刻を添える。

## 【厳守】raw.githack の制限(429)を起こさないための運用(2026-10-08〜、ユーザー指示)

- 2026-10-08、raw.githack.com が429(Something is wrong. That's all we know.)を返し、ユーザー側でも見えなくなった(別アプリでも数時間続いた)。
  原因は、確認用URLへのアクセスが多すぎること(pushごとのコミット指定URLの作成・ポーリング・再試行)とみられる。制限が長引くと、全アプリの確認ができなくなる。
- 守ること:
  1. 反映確認のポーリング(sleepしての繰り返し・ループ)をしない。確認は「マージ後に1回」だけ。待つときは1回目で未反映でも、最低5分あけてから1回だけ再確認する。
  2. 1回のpushごとに新しいコミット指定URLを作って確認しない。小さな修正は複数まとめてから(1作業=1〜2回)確認する。
  3. 反映の事前確認は raw.githubusercontent.com(制限が別)で行う。raw.githack は「ユーザーが画面を見る用」にだけ使い、Claudeからのcurlは最小限にする。
  4. 429が出たら、その時点で raw.githack へのアクセスを止める(再試行しない)。ユーザーに「制限中」と伝え、確認は htmlpreview.github.io(試験用・動作未保証)か、指示があれば Vercelへ「デプロイして」で行う。
  5. 見た目の確認が不要な修正(ロジックのみ・ドキュメントのみ)では、raw.githack にアクセスしない(ローカルのテストとraw.githubusercontentで足りる)。
- jsDelivr・Statically はHTMLを text/plain で返すため、画面確認には使えない(2026-10-08確認)。

## 【ルール】tdf-dim-count(TDF抽出)は、変更のたびに回帰テストを実行する(2026-10-14〜、ユーザー指示)

- `tdf-dim-count/core.js` を変えたら、コミット前に `node tests/tdf-dim-count/run.js` を実行し、正解値が悪化していない(全件OK)ことを確認する。
  正解のTDF(原本14MB・GEN単独・TB見本。gzipで `tests/tdf-dim-count/fixtures/`)と正解値(`expected.json`)は、アプリのフォルダの外にあり、Vercelのデプロイには含まれない。
- 正解値(GEN=592本、TB=16本など)を変えるのは、ユーザーが正解を確認したときだけ(`--update`)。詳細は `tests/tdf-dim-count/README.md`。

## 【ルール】ノウハウ集の参照と更新(2026-10-06〜、ユーザー指示)

- 作業の前に `docs/know-how.md` を読み、使えるやり方があれば流用する。
- 作業完了時、効果があったやり方(Before→Afterの数値つき)と、ユーザーが繰り返した指示・訂正を、
  `docs/know-how.md` に追記する(1項目5行以内。効果なしも「効果なし」と記録)。
- ユーザーの指示から恒久ルールにすべきものは、提案してから `CLAUDE.md` に追記する(勝手に増やさない)。
- **ローカルセッションとも共有する**(2026-10-16〜)。ローカルのPC側のセッション(Excel・Pythonなど)で見つけた、他でも使えるやり方も、同じ `docs/know-how.md` に書く(正はここ。ローカル側は参照だけにして二重に書かない)。長い詳細は `docs/know-how/<題名>.md` に置き、索引の項目からリンクする。
- **リポジトリは公開(public)**。ローカルから書き出すときは、サーバーのパス・IPアドレス・スプレッドシートのID・個人名・個人情報を含めない。一般化したやり方だけを書く。

## 共通部品 to-launcher.js(「← アプリ一覧へ」ボタン)(2026-10-19〜)

各アプリのアプリ名の左に、アプリランチャー(https://app-launcher-ashy.vercel.app/)へ戻るボタンを付ける共通部品。2026-10-19、PR #760(コミット 96e4414)で17アプリに追加し、Vercelプロジェクトのある15アプリを本番デプロイした。

- **正本**: `docs/to-launcher/to-launcher.js`。**Vercelはフォルダ単位で配信する(Root Directory)ため、各アプリのフォルダに同じファイルをコピーして使う**(`<アプリ>/to-launcher.js`)。正本を直したら全フォルダへ再コピーし、`index.html` の `?v=` も上げて、対象アプリを(「デプロイして」の指示で)再デプロイする。
- **組み込み**: 各 `index.html` の `</body>` 直前に1行: `<script src="to-launcher.js?v=20261019" data-target="CSSセレクタ" data-mode="in|before|beforePrev"></script>`。`in`=その要素の先頭、`before`=その要素の直前、`beforePrev`=直前の兄弟がロゴ(img/svg/小さいdiv)ならその前。ボタンはJSが後から差し込む(ホームに戻るたびに入れ直す)。
- **見た目**: 背景色(7秒周期)と文字色(3秒周期)が別のリズムで変化し、縁が脈動して光る。背景の明暗をスクリプトが自動判定し、暗い=明るいボタン+濃い文字+金色の光、明るい=暗いボタン+明るい文字+濃い赤・ピンクの光。画面内の他のボタンの色相から40°以上離れた色だけを使う。コントラスト比は全コマで6.7以上(実測)。「視覚効果を減らす」設定では動きを止める。印刷では非表示。
- **ランチャーのURLを変えるとき**: 正本の `LAUNCHER_URL` を直し、全フォルダへ再コピーして**全アプリを再デプロイ**する(ランチャー側のURLを変えるだけでは反映されない)。
- **対象アプリと設定**(フォルダ: data-target / data-mode): company-ai: h1 / in、cost-insight: header h1 / in、daily-report: .appTitle / in、dxf-launcher: .header-block img / before、excel-drawing-link-tool: .masthead-brand h1 / in、huguai: .home-title / in(ホーム画面のみ)、jissun-master-jidokinyu: h1 / beforePrev、jissun-open: h1 / beforePrev、pdf-diff-app: #app-name / in、production-management: .app-header h1 / beforePrev、shipping-list-link: .hdr h1 / in、tdf-dim-count: header h1 / in、tdf-master-web: header h1 / beforePrev、tori-robo: .hdr-center h1 / in、unso-check: .header-title / in。kozai-toriai(.app-header h1 / beforePrev)・weld-heat-management(#mode-select-screen .home-title / in)にもコードは入れたが、Vercelプロジェクトが無く、ユーザーが「必要ない」と指示したため本番デプロイしていない。
- **新しいアプリに付けるとき**: そのフォルダに to-launcher.js をコピー → 上の1行を入れる → ローカルのブラウザで、幅1280と390でボタンが1個・位置・コントラストを実測 → 他の設定と同様、main反映まで進め、本番は「デプロイして」の指示で。HTMLがCRLFのときは、Pythonのテキストモードで編集しない(全行が差分になる。バイナリで編集する)。
- **既知の点(未調整)**: 本番の画面での見た目は未確認(HTMLにscriptの読み込みがあり、to-launcher.jsが200で返ることまで確認)。tori-robo はスマホ幅(390px)でタイトルの右端が切れて見える。daily-report は390pxでボタンが左端に付きタイトルが2行になる。dxf-launcher はタイトル枠が狭くタイトルが2行になる。huguai・unso-check・weld-heat-management・daily-report は、最初の画面のタイトルだけにボタンが付く(他の画面にも付けるかは未決定)。
- **関連**: 2026-10-19の本番デプロイで、jissun-master-jidokinyu・unso-check・tdf-master-web(Vercelプロジェクト名「-tdf-master-web」)・production-management の4プロジェクトは、1回目が作成直後に CANCELED になった。原因は Settings → Build and Deployment → Ignored Build Step が常にスキップになる設定だったこと(ユーザーが「Automatic」に直し、`forceNew`=1 で再デプロイして READY)。デプロイが CANCELED になったら、まずここを確認する。

## 自動デプロイ停止方式(vercel.json)(2026-09-24〜、daily-reportで検証済み)

Git連携の接続/解除はClaudeのVercelツールではできない(ユーザー操作が必要)。そのため、
連携の付け外しの代わりに、アプリのフォルダ(Root Directory)に次の `vercel.json` を置く方式を使う。

```json
{ "git": { "deploymentEnabled": false } }
```

- 効果: 連携したままでも、ブランチpush・mainマージで自動デプロイされない
  (2026-09-24にdaily-reportで、push・マージともにデプロイが発生しないことを確認済み)。
- 公開するとき: Claudeが Vercelツールの `create_deployment`(target=production、
  gitSource={type:github, org:aism24, repo:"-", ref:main, sha:<マージコミット>})で
  デプロイする(この方式でREADYになることを確認済み)。その後 `list_deployments` で
  READYを確認し、本番URLを実際にfetchして反映を確かめてから報告する。
- 他のアプリをVercel連携する場合も、先にそのフォルダへ同じ `vercel.json` を置いてから
  連携してもらう。

## 旧リポジトリから「-」へ統合したアプリ(2026-10-09〜)

Vercelの「Import Git Repository」で候補が`-`だけになり分かりやすいよう、別リポジトリにあったアプリをこのリポジトリへ履歴ごと取り込んだ。

- `dxf-launcher/`(元: aism24/dxf-launcher、master。実際のURL: https://dxf-tdf-bat.vercel.app/ 。プロジェクト名のdxf-launcher.vercel.appは404)
- `excel-drawing-link-tool/`(元: aism24/excel-drawing-link-tool、main。実際のURL: https://jissun-excel-link-tool.vercel.app/ 。プロジェクト名のexcel-drawing-link-tool.vercel.appは404)
- 2026-10-09、2つとも `aism24/-` に連携(Root Directory=各フォルダ)→`create_deployment`で本番デプロイ(マージコミットa4e9932、READY、ファイルサイズ一致を確認)→ユーザーが連携を解除。`list_projects` 0件を確認。
- 両フォルダに `vercel.json`(`git.deploymentEnabled=false`)を置いた。Vercelプロジェクトの連携先は`aism24/-`+Root Directory=各フォルダに設定済み(連携自体は解除)。
  今後修正して反映する場合は、「デプロイして」で`create_deployment`(連携は不要。cost-insight等と同じ運用)。
- 旧リポジトリ(aism24/dxf-launcher・aism24/excel-drawing-link-tool)は2026-10-09にユーザーがArchiveしたのち**削除済み**(存在しない。コード・履歴は`-`に取り込み済み)。Vercel「Import Git Repository」の候補を`-`だけにするのが目的。

## 不要フォルダ(残置)(2026-09-24〜)

- `production-profit/`(損益分岐の旧アプリ・sonekibunki)と `jikko-yosan/`(実行予算まとめ): **2026-10-09〜運用停止**(ユーザー判断)。
  どちらもコストインサイト(`cost-insight/`)の前身で、コストインサイトに統合済み。追加の変更は予定しない。
  削除はせずGitHubに残置している。新規の作業・デプロイ・ランチャー登録の対象にしないこと(依頼されたら、まずコストインサイト側の対応かを確認する)。

- `open_jissun/`: **不要フォルダ**(ユーザー判断)。実際の「実寸法師を開く」は
  `jissun-open`(Vercel。https://jissun-open.vercel.app/ 、2026-10-16確認)→ jissun:// → 社内共有フォルダのHTML で運用しており、
  このフォルダ(GitHub Pages版)は使わない。容量影響がほぼ無いため削除せず残しているだけ。
  新規の作業・Vercel化・ランチャー登録の対象にしないこと。
  (ただし `gas/Code.gs` は稼働中GASのソースの可能性があるため、参照用としては有効)

## 【方針】GASのJSONを速く配るには、Vercelの中継API+CDNキャッシュを第一候補にする(2026-10-02〜、ユーザー指示)

- ブラウザからGAS(`script.google.com/.../exec`)を直接呼ぶと、Google側の転送(302)の連鎖・ログイン状態の差で、
  遅い(22秒超の例)/エラーになるユーザーが出る。GAS単体の処理は2〜3秒でも、通信側が遅い。
  ドライブにキャッシュJSONを置いても、取りに行く通信は変わらないので解決しない。
- 「キャッシュを使って速くしたい」ときは、悩まずにまずこの構成にする(tori-robo で採用):
  1. アプリのフォルダに `api/data.js`(Node関数)を置き、Vercelのサーバー側でGASを取得(最大3回リトライ)。
  2. 応答に `Cache-Control: public, s-maxage=300, stale-while-revalidate=86400` を付けてCDNに載せる。
  3. 画面は `api/data` を呼び、失敗時だけGAS直接へフォールバック。「最新を読み込む」(refresh)や保存直後はGAS直接。
  4. 画面側にも前回結果をlocalStorageに保存して即表示→裏で更新、を併用する。
- 注意: Vercel関数は動かすのに本番デプロイが必要(deploymentEnabled=falseでも create_deployment は「デプロイして」の指示時のみ)。
  raw.githack の確認用URLには関数が無いため、フォールバックでGAS直接になる(速さの確認は本番デプロイ後)。
  関数が小さいNodeなら Functions Storage への影響はほぼ無い(Python+重いライブラリのpdf-diff-appとは別扱い)。

## 【厳守】GitHubの作業は許可を求めずmainへのマージまで進める。Vercelのデプロイだけは必ず許可が必要(2026-10-15〜、ユーザー指示)

- **GitHub側(ブランチ作成・commit・push・PR作成・mainへのマージ・ブランチ整理)は、ユーザーの許可を待たずに最後まで進める。**
  「マージしてよいですか?」と確認しない。ユーザーに「マージして」と何度も言わせないこと(2026-10-15、ユーザーが明示的に事前許可)。
  - マージは `gh api -X PUT repos/aism24/-/pulls/<番号>/merge -f merge_method=squash`(GitHub GraphQLは使えないのでRESTを使う)。
  - 権限判定(auto mode)で拒否されたら、回避せず、その旨とPR・ブランチのURLだけを報告して止まる。
- **Vercelへのデプロイ(`create_deployment`)は、ユーザーが「デプロイして」と明示的に指示したときだけ。** これは従来どおり厳守で、上のGitHub事前許可には含まれない。
  マージ後は「mainへ反映済み・本番(Vercel)は未反映」と報告する。
- 事前許可の範囲は `aism24/-` の通常のアプリ修正。リポジトリの削除・強制push・他リポジトリへの操作は含まれない。

## 【厳守】ユーザーの共通指示(2026-10-15、ユーザー指示で明文化。以前から有効)

- **完全無料で実装する**(GAS・Googleスプレッドシート・Vercel無料枠の範囲)。アプリはURLで配布し、ユーザーはURLで常に最新版を操作できる状態にする。
- **Gemini APIを使うコード**: モデル名は `gemini-3.5-flash-lite` に固定(定数でハードコード。自動選択・可変にしない。他モデル名は使わない)。ユーザーが明示的に別モデルを指定したときだけ変更する。
  - **【例外・新方式】新規アプリ(2026-10-20〜、車番連絡自動化=`truck-fax/`が最初)は、モデル名もAPIキーも、スプレッドシートの「情報」シート(A列=項目名、B列=値)のセルから読む(ユーザー指示)。** 項目名は `Geminiモデル名`(値の例 `gemini-3.5-flash-lite`)と `APIKEY`。GAS(コンテナバインド)がサーバー側で、固定のセル番地ではなくA列の項目名の行を探して読む。ブラウザ・GitHubには出さない。理由: モデル変更・キー差し替えでコード修正とGAS再デプロイが不要になり、別のユーザーも編集しやすいため。
  - セルが空・行が無いときは、別モデルに黙って切り替えず、「情報シートの◯◯が空です」とエラーにする。初期値は `gemini-3.5-flash-lite`(「情報」シートに入れておく)。
  - 既存のアプリ(company-ai・huguai等)は、今のまま(コード固定/既存方式)を変えない。ユーザーが指示したときだけ、同じ方式へ移す。新規に作るGemini利用アプリは、特に指示が無くてもこの方式にする。
- **回帰テスト**: コードを変えたら、前回値(正解値)が悪化していないか必ず確認する。
- **テストファイル**は作業中だけ作り、使い終わったら削除する(リポジトリに残さない。tdf-dim-count の正解データ・テストは例外で、下記の専用ルールに従う)。
- **GitHubでの作業は、pushとmainへのマージまで完結**させ、アプリを開いて対応できたことを確認してから報告する。マージが権限等で止まったら、ブランチ(またはPR)のURLを案内して、ユーザーにマージの可否を確認する。
- **Code.gs・Index.html等のGAS関連コード**を直したら、案内するURLは GitHub の通常のファイル表示ページ(`https://github.com/<owner>/<repo>/blob/main/<path>`。右上の「Copy raw contents」で全文コピーできる)にする。反映ラグがあるため、差し替わりを確認してから報告する。
- **リポジトリ**: アプリ・コードはすべて既存の `aism24/-` に入れる。新しいリポジトリは作らず、アプリごとに直下へフォルダを作る(例: `huguai/`、`tori-robo/`)。作業開始時に `aism24/-` をセッションへ接続(add_repo)し、このCLAUDE.mdに従う。
- **Vercel**: 最終的にはGitHubで作ったものをVercelにデプロイしてURLを取得する。ただしデプロイは「デプロイして」の指示があったときだけ。push・マージでビルドが走らないよう、各アプリのフォルダに `vercel.json`(`{"git":{"deploymentEnabled":false}}`)を置く。確認はGitHub(raw配信)側を優先する。

## huguai(社内不具合アプリ鳥取のVercel版)のルール(2026-10-15〜)

- 結果分析の「PDFダウンロード」は、**現在の画面表示のまま、A4縦向き1ページに収めて出力する**(`huguai/app.js` の `KekkaBunseki.downloadPdf`)。画面(左右2列)を複製して測った位置・背景・罫線・文字を、pdf-lib で文字入りのまま1ページに描く(画像ではない。文字はコピー可。グラフだけ画像)。縦が長いときはさらに縮小し、複数ページにしない。背景は印刷向けに白にする。日本語フォントは M PLUS 1p(フォントのサブセット埋め込みは文字が欠けるので使わない)。
- **PDFは端末・画面幅によらず、固定幅1280px(`KekkaBunseki.PDF_WIDTH`。PCの横画面相当)で作る**(2026-10-16〜)。携帯・iPad縦で間延びしないよう、複製に残る画面側の min-height / margin-bottom は外してPDF内で測り直し(`alignPdfBlocks_`)、グラフは画面のグラフではなく固定幅で描き直して画像化する(`drawPdfChart_`、表とオプションは `yearChartSpec`)。**画面の表示(幅に合わせてスクロールする方式)は変えない。** 変更したら、PC(1280)・iPad縦(820)・携帯(390)でPDFの文字位置が一致するかを比較する(手順は `docs/know-how.md`)。
- **結果分析・不具合記録の期間の画面仕様**(2026-10-16〜、ユーザー指示。変えるときは相談する):
  - 月のリストは会計年度の順(12月→1月→…→11月)。12月締め(前年11/21〜12/20)が先頭で、「前年」とは書かない(`Records.MONTH_ORDER`。◀▶の順と同じ定義を共有)。
  - 結果分析の年度指定(左)と月指定(右)の年度は連動する。片方を変えたらもう一方も同じ年度にし、右の月は1月締めにして左右を同時に取得する。取得中は、両方が終わるまで読み込み中の表示を出し続ける(`loadYearAndMonth_`。先に終わった側が表示を消すと、右のカードが古いまま見えるため)。◀▶で年度をまたいだときも左をそろえる。
  - ホームボタンの右に「今月に戻す」(`todayBtn`。不具合記録・結果分析の年度/月別だけ表示。工事別分析・ホームでは非表示)。今の会計年度・締め月にする。データが無い年度のときは最新の年度。不具合記録は、開いたときも今月で絞り込む(結果分析は元から今月)。
  - 月ごとの「工事別 不具合件数」の見出しは「年度」ではなく暦の「年」(2025年度12月 → 2024年12月分。`calendarYear_`)。年度単位の表示(年度の選択・年度比率・PDFのファイル名)は「年度」のまま。
  - ヘッダーのボタンが増えたので、狭い画面(760px以下)では折り返す。
- PDFの出力内容は画面表示と揃える。画面の表示仕様を変えたら、PDFも同じ見た目になっているか確認する(別レイアウトを作り直さない)。
- 引き継ぎ書は上の表の保存先フォルダに保存する(個人のマイドライブには保存しない)。

## truck-fax(車番連絡FAX取込)のルール(2026-10-20〜、ユーザー指示)

- **PDFで取り込んだ行は、取込一覧に必ず残す。行の削除・内容の上書きはしない。** 変更=元の記録の「追加変更」を「変更前」にし、今回の内容を「変更後」の行として追加。取消=元の記録の「追加変更」を「中止」にする。台数追加は、新しい行を追加し「追加変更」は空欄。車両台数は、「追加変更」が「中止」「変更前」**以外**の行を数える。
- **車種の大文字「T」は小文字「t」にそろえて記録する**(全角も。取込一覧・車両情報)。現場名(工事名)は対象外(英字を含む名前を変えないため)。
- **手配業者は、FAXの発信元から、候補(情報シートの見出し「手配業者」の列。既定: ナミツー・大上)の名前で記録する。** 運送業者・手配業者の書き方の違いは同じ会社とみなして照合する。既にマスタにある車・運転手は追記しない(2度目の運行)。
- **備考はアプリで入力する。** FAXの備考欄・特記・荷種などの文字と連絡文は、備考の初期値に入れる(記録前に直せる)。積地は記録しない。
- Geminiのモデル名・APIキーは情報シートのセルから読む(上の「共通指示」の例外)。履歴用のシートは作らない。
- 実際のFAXの画像・氏名・電話番号は、リポジトリに入れない(公開リポジトリ)。テストは作業後に削除する。
- 仕様の詳細は `truck-fax/README.md` と、Driveの引き継ぎ書(上の表)。
