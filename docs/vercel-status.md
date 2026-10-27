# Vercel運用の詳細・Git連携状態・Functions Storage記録

CLAUDE.md から分離(2026-10-21)。恒久ルールは CLAUDE.md、ここは詳細と履歴。状態表を更新したら日付を書く。

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
| company-ai (Vercelプロジェクト名「company-ai」) | company-ai | 解除(2026-10-08、ユーザーが誤って連携→解除。`list_projects` 0件を確認。連携中の約16分間〜数時間に、company-ai自身のコミット#662・#668・#676・#678で自動デプロイが発生) | `company-ai/vercel.json` の `git.deploymentEnabled=false` で自動デプロイ停止(2026-10-21確認)。連携なしでの `create_deployment` は、2026-10-19の15プロジェクト一括デプロイ(コミット96e4414。ボタン追加の反映)で成功済み。本番反映は「デプロイして」の指示時のみ。引き継ぎ書はDriveの保存先フォルダ(上の表) |
| tdf-dim-count (https://tdf-dim-count.vercel.app/) | tdf-dim-count | 解除(2026-10-14、ユーザーがVercelでプロジェクトを新規作成=Root Directory `tdf-dim-count`。作成時に自動で本番デプロイ1回(dpl_G84HA3B、コミットb9d10fd=PR #711)→直後にユーザーが連携を解除。`list_projects` 0件を確認。同日、連携なしのまま `create_deployment` で2回目(dpl_quJeD8U、コミットe748bcb=PR #713。連携なしでもデプロイできることを確認)と3回目(dpl_6cPiPf3、コミットcddd081=PR #716。利用記録のGAS URL設定)を本番デプロイ。4回目(dpl_5dvBaEK、コミットd2a41e5=PR #719。手順書ビューア・説明文ヘッダー)を「デプロイして」の指示で本番デプロイ=連携なし。10/14のデプロイは計4回) | アプリ名「実寸データより長さと本数集計」。静的サイト(関数なし)。Excelダウンロード時に、GAS(`tdf-dim-count/gas/Code.gs`、スプレッドシート「tdf-dim-count」にコンテナバインド)へファイル名・レイヤ・総本数を送り、シート「記録」の2行目に追記(2026-10-14、`app.js` の `GAS_URL` に設定)。`tdf-dim-count/vercel.json` の `git.deploymentEnabled=false` で自動デプロイ停止。本番反映は「デプロイして」の指示時のみ `create_deployment`(連携は不要)。TDF(OLE原本14MB含む)のレイヤ選択で、斜め寸法の手配長さ・本数を集計しExcel出力。解析のやり方は `docs/know-how.md`。ヘッダー右の「操作・準備説明書」ボタンで手順書(全8ページ)を表示(画像 `tdf-dim-count/manual/p-1〜8.jpg`、元PDFは `docs/manual-draft/`。ページ数を変えたら `index.html` のスクリプトの `N` も直す) |
| jissun-open (https://jissun-open.vercel.app/) | jissun-open | 連携なし(`list_projects` 0件を確認、2026-10-16) | アプリ名「実寸法師を開く」(アプリランチャーapp009)。静的サイト(関数なし)。開くと `jissun://` で社内共有フォルダのHTMLを開かせる入口。開かれた日時をGAS(`jissun-open/gas/Code.gs`、スプレッドシート「実寸法師を開く_Vercel記録」にバインド)でシート「記録」のA2に追記(常にA2が最新)。`vercel.json` の `git.deploymentEnabled=false` で自動デプロイ停止。本番反映は「デプロイして」の指示時のみ `create_deployment`(project=jissun-open、teamIdは渡さない)。**2026-10-16、Ignored Build Stepに `-- ./jissun-open` のコマンドが入っていて1回目がCANCELED→ユーザーが「Automatic」に変更→forceNew=1で2回目がREADY(10/16は計2回)**。引き継ぎ書はDriveの保存先フォルダ(上の表) |
| huguai (Vercelプロジェクト名「tori-huguai」。https://tori-huguai.vercel.app/) | huguai | 解除(2026-10-15、ユーザーがVercelでプロジェクトを作成し、本番デプロイ1回(dpl_CPJjCRe、コミット1d00b81=PR #726)→直後にユーザーが連携を解除。`list_projects`(repoUrl=aism24/-)0件を確認。ユーザーの手動デプロイでClaudeの `create_deployment` ではない。2026-10-16、「デプロイして」の指示で `create_deployment` により、2回目(dpl_6BNecPu、コミット17bf6db=PR #730、PDF固定幅1280px)、3回目(dpl_HuWZsmy、コミット1d9b8cb=PR #733月リストの並び・#734年度連動)、4回目(dpl_BjEauQ4、コミット19063ad=PR #735取得中の表示・#736今月に戻す・#737見出しの年表記)を、連携なしで本番デプロイ、いずれもREADY。10/16のデプロイは計3回) | アプリ名「社内不具合アプリNew」(社内不具合記録アプリ(鳥取)のVercel版)。静的サイト(関数なし)。`huguai/vercel.json` の `git.deploymentEnabled=false` で自動デプロイ停止。GAS(`huguai/gas/Code.gs`、スプレッドシート「社内不具合アプリVercel版」にバインド)がデータ処理。本番反映は「デプロイして」の指示時のみ `create_deployment`(teamIdは渡さない=403。project=tori-huguai)。2026-10-15時点でClaudeのVercelツールは `get_project` 等がteam指定で403、`web_fetch_vercel_url` も403(本番ページの中身は未確認)。引き継ぎ書はDriveの保存先フォルダ(上の表)にある |
| truck-fax (https://truck-fax.vercel.app/) | truck-fax | 解除(2026-10-26、ユーザーがVercelでプロジェクトを作成=Root Directory `truck-fax`、Framework=Other し、作成時のデプロイ1回のあとGit連携を解除。`list_projects`(repoUrl=aism24/-)は0件を確認) | アプリ名「車番連絡 取込」(スプレッドシート「車番連絡自動化」)。`truck-fax/vercel.json` の `git.deploymentEnabled=false` で自動デプロイ停止済み。本番デプロイは作成時の1回(main=7d74911、READY。画面の版 `app.js?v=20261026g`。2026-10-26に追加変更依頼ボタンを反映=bc0df71・`app.js?v=20261026r`、続けて連動と注記を反映=dd2bf78・`app.js?v=20261026u`。`https://truck-fax.vercel.app/` は認証なしで200)。以降の反映は、ユーザーの「デプロイして」で `create_deployment`(teamIdは渡さない)。GAS(`truck-fax/gas/Code.gs`。コンテナバインド。Webアプリは「全員」)は、貼り替え→「新バージョン」で反映する(`CODE_VERSION` で確認)。引き継ぎ書はDriveの保存先フォルダ(上の表) |

**運用の原則**: 全アプリのGit連携を解除したままにする。連携が無ければpush・マージでデプロイは起きず、ユーザーが「デプロイして」と指示したアプリだけを `create_deployment` で1つずつデプロイする(連携は不要。Vercelプロジェクトの新規作成と連携の付け外しだけがユーザー操作)。連携が1件でも残っていたら、push・マージ前にユーザーへ解除を依頼する。

**最新の確認**: 2026-10-28、`list_projects`(repoUrl=aism24/-)は0件(全アプリ未連携。truck-fax の12回目デプロイの前後)。

**`vercel.json` の `git.deploymentEnabled=false` が無いフォルダ**(2026-10-19時点。2026-10-21に production-management・unso-check へ追加済み): pdf-diff-app(functionsの設定だけ)・tdf-master-web・jissun-master-jidokinyu・kozai-toriai・weld-heat-management。連携は0件なので今は自動デプロイされないが、これらのVercelプロジェクトを `aism24/-` に連携し直す前に、必ずそのフォルダへ置くこと(特に pdf-diff-app は1デプロイごとにFunctions Storageを消費する)。

### 連携・デプロイの経緯(履歴)
- 2026-09-24: ユーザーが全プロジェクトの連携を解除(0件確認)。PR #306(関数を`api/diff.py`1本に統合・scipy除去)を本番デプロイ(1件のみ、3モードとも正解値一致を本番APIで確認)し、再解除して0件を確認。
- 2026-09-27〜29: sonekibunki(production-profit)を新規作成・連携(この間 `list_projects` は同1件が正常)。9/29に解除し0件。
- 2026-10-05〜08: app-launcher・cost-insight・tori-robo・shipping-list-link の連携を順次解除し0件。10/8、cost-insightは連携なしの `create_deployment` で本番デプロイできた(dpl_EthcYT7、コミット5c49df9)。
- 2026-10-14: tdf-dim-count(新規)も作成直後に連携を解除し0件。
- 2026-10-19: 15プロジェクト(pdf-diff-pythonapp・daily-report・jissun-open・tori-huguai・shipping-list-link・tdf-dim-count・excel-drawing-link-tool・dxf-launcher・company-ai・cost-insight・-tori-robo・jissun-master-jidokinyu・unso-check・-tdf-master-web・production-management)を、ユーザーの「デプロイして」で `create_deployment` により本番デプロイ(ボタン追加の反映。コミット96e4414)。連携は0件のまま。直近24時間のデプロイ回数は計20回(上限100)。

【反省・厳守】2026-09-24、daily-reportの修正時にpdf-diff-pythonappの連携が残っているのを
確認しながら「Skip deploymentsが有効だから大丈夫」と自己判断してpush・マージし、
pdf-diff-pythonappのデプロイが2回(ブランチpushのPreview+mainマージのProduction)発生した。
**Skip deploymentsは当てにならない。対象以外の連携中プロジェクトが1件でもあれば、
push・マージは一切せず、先にユーザーへ解除を依頼すること。**(ブランチへのpushだけでも
Previewデプロイが発生する)

【Ignored Build Stepの注意】コマンドはRoot Directory内で実行される。
`git diff HEAD^ HEAD --quiet -- ./<フォルダ名>` と書くと存在しないパスを指して常にスキップ
(CANCELED)になるため、`-- .` と書く。
- 2026-10-21: 全コード点検の修正を、ユーザーの「デプロイして」で `create_deployment` により本番デプロイ(連携なし。コミット ba10f76。app-launcher=dpl_3VoDeMW・tori-huguai=dpl_CuY7Xyc・company-ai=dpl_EAXkrPp、いずれもREADY。本番HTMLの `?v=` がmainと一致を確認)。デプロイ前の直近24時間は0回、今回3回。連携は0件のまま。
- 2026-10-21(2回目): 全コード点検の修正(jissun-open=PR #843・#844、tdf-dim-count=PR #846・#847)を、ユーザーの「デプロイして」で `create_deployment` により本番デプロイ(連携なし。コミット d3e6b1a。jissun-open=dpl_JCpuBZ5、tdf-dim-count=dpl_JA1mtpf、いずれもREADY。本番の index.html・core.js・app.js がmainと一致を確認)。デプロイ前の直近24時間は3回、今回2回。連携は0件のまま。
- 2026-10-23: tdf-dim-count の「② ブロック分け製品名で仕訳け」(PR #913〜#915)と利用記録の2段階化(起動でA列、ダウンロードで同じ行のB:E。PR #916。GASは貼り替え済み=CODE_VERSION 2026-10-23-open-log)を、ユーザーの「デプロイして」で `create_deployment` により本番デプロイ(連携なし。コミット 8a5cfa0、dpl_FCMi4Tj、READY。本番の index.html・core.js・app.js がmainと一致を確認)。デプロイ前の直近24時間は5回、今回1回。連携は0件のまま。
- 2026-10-26: tdf-dim-count の起動画面(集計方法の選択・ボタン上下・ホバー、②の条件表示「リスト化条件＝レイヤの完全一致」、更新履歴ボタンとポップアップ。PR #919〜#921。GASは貼り替え済み=CODE_VERSION 2026-10-26-history、シート「更新履歴」A:Cを返す)を、ユーザーの「デプロイして」で `create_deployment` により本番デプロイ(連携なし。コミット 3c5d0b2、dpl_F3XTNzA、READY。本番の index.html・core.js・app.js がmainと一致を確認)。デプロイ前の直近24時間は0回、今回1回。連携は0件のまま。
- 2026-10-26(2回目): tdf-dim-count のコード整理(PR #924。デッドコード削除・重複統合・読み込み失敗時の表示・xlsx の defer など。集計結果は変更なし。GASは貼り替え済み=CODE_VERSION 2026-10-26-optimize、バージョン4)を、ユーザーの「デプロイして」で `create_deployment` により本番デプロイ(連携なし。コミット 5c9f1fd、dpl_46PR5JQ、READY。本番の index.html・app.js・core.js・to-launcher.js がmainと一致、app.js?v=r36 を確認)。デプロイ前の直近24時間は1回、今回1回。連携は0件のまま。
- 2026-10-21(3回目): shipping-list-link の全コード点検の修正(PR #850。加工予定表の重複をNGに数える・実データ入りの sample/links.json 削除)を、ユーザーの「デプロイして」で `create_deployment` により本番デプロイ(連携なし。コミット 0a7fbed。dpl_21YCTjE、READY)。本番の index.html・app.js・core.js がmainと一致、sample/links.json は404、api/links は200(29,027件)を確認。デプロイ前の直近24時間は5回、今回1回。連携は0件のまま。
- 2026-10-21(4回目): tori-robo の全コード点検の修正(PR #852・#853。「最新のデータを読み込む」のあと開き直すと古いデータに戻る不具合の修正ほか)を、ユーザーの「デプロイして」で `create_deployment` により本番デプロイ(連携なし。project=-tori-robo、コミット 1f333e5。dpl_G7vc7xL、READY)。本番の index.html・app.js・style.css がmainと一致(app.js?v=sp54)、api/data は200を確認。デプロイ前の直近24時間は6回、今回1回。連携は0件のまま。
- 2026-10-21(5回目): production-management の全コード点検の修正(PR #856。平均生産重量が締め期間の初日に0.0で赤になる・当日分が平均に混ざる不具合の修正、README更新、vercel.json 追加)を、ユーザーの「デプロイして」で `create_deployment` により本番デプロイ(連携なし。コミット ccac2a5。dpl_7ZFNWvY、READY)。本番 https://masamiz-production-management.vercel.app/ の index.html・app.js・style.css・manual.html がmainと一致(app.js?v=20261021a)を確認。デプロイ前の直近24時間は7回、今回1回。連携は0件のまま。
- 2026-10-23: unso-check の全コード点検の修正(PR #861・#862。0行の取込みで以後の取込みが止まる不具合・同じ内容の再取込み警告が出ない不具合の修正ほか)を、ユーザーの「デプロイして」で `create_deployment` により本番デプロイ(連携なし。コミット cdd1540。dpl_D5GFE56kDV5QTj8Qntm6fkXKsPeA、READY)。本番の index.html・app.js・style.css・to-launcher.js が main と一致することを確認。GASはユーザーが v29 で反映し、ping が 2026-10-22-unso2 を返すことを確認。直近24時間のデプロイ回数は今回の1回。
- 2026-10-23(2回目): cost-insight の全コード点検の修正(PR #870・#871。目標利益率0%・%表示の読み取り、年度の選択肢、使われない画面と Chart.js の削除、説明の更新)を、ユーザーの「デプロイして」で `create_deployment` により本番デプロイ(連携なし。コミット f2d136e。cost-insight は 0eccbb0 から変更なし。dpl_Fx14u5tT7NUYed56hpaSwNcwqJC7、READY)。本番の画面ファイル12個が main と一致することを確認。GASはユーザーが v13 で反映し、ping が 2026-10-23-ci2 を返すことを確認。直近24時間のデプロイ回数は今回を含め2回。
- 2026-10-23(3回目): daily-report の点検の修正(PR #876。起動時データを「毎日更新分(live。no-store)」と「アーカイブ分(版付きURLで1年キャッシュ)」に分けて取得、①の届出検索の高速化、起動直後の描画の後回し)を、ユーザーの「デプロイして」で `create_deployment` により本番デプロイ(連携なし。コミット a80aa01。dpl_88VGBK5ubsGdVZM7qeWUwDApWuSi、READY)。本番の画面ファイル6個が main と一致することを確認。GASはユーザーが v74 で反映し、ping が 2026-10-23-dr1 を返すことを確認。本番実測(米国東部から): kind=live 12.6〜12.8秒(no-store)、kind=archive 初回5.9秒→CDN HIT 0.17〜0.41秒。直近24時間のデプロイ回数は今回を含め3回。
- 2026-10-23(4回目): shipping-list-link の修正(PR #879。元PDFの保存・記録に失敗しても画面に「(元PDFの保存・記録に失敗しました)」を出さない)を、ユーザーの「デプロイして」で `create_deployment` により本番デプロイ(連携なし。コミット 00be090。dpl_HoD1wNeJLJiYWBob4S9obkkbecPS、READY)。本番の index.html・app.js・core.js・to-launcher.js が main と一致。**デプロイ後、中継 api/links が502(GASの取得が8秒×2回で時間切れ)。デプロイでCDNの保存が消えたため、画面はGAS直接に切り替わりマスタ表示まで約13〜14秒**(GAS直接は手元から2〜3秒。api/links.js は今回変更なし)。直近24時間のデプロイ回数は今回を含め4回。
- 2026-10-23(5回目): shipping-list-link の修正(PR #882 マスタをPCのブラウザに保存して開くのを速く・ボタンは変わったExcelだけ読み直す・説明書ボタンの位置・「← アプリ一覧へ」一時非表示 / PR #884 会社ロゴ5回クリックでそのPCだけ表示)を、ユーザーの「デプロイして」で `create_deployment` により本番デプロイ(連携なし。コミット 54ced87。dpl_GuCzmXPyYtGM8ePxxQ7gAkSzzd26、READY)。本番の index.html・app.js・core.js・to-launcher.js が main と一致(app.js?v=20261023b・core.js?v=20261023a)。api/links は200(1回目2.0秒、2回目0.19秒=CDN)。本番を開くとポップアップが閉じるまで1回目1.3秒・2回目0.8秒(保存分)。直近24時間のデプロイ回数は全アプリ合計5回。Git連携は0件。GAS は CODE_VERSION 20261023a(ping で確認)。
- 2026-10-26: huguai の利用記録(起動日時+PDFダウンロードを同じ行のB:C。PR #927)を、ユーザーの「デプロイして」で `create_deployment` により本番デプロイ(連携なし。コミット af98cb8。tori-huguai=dpl_2t1XyyHDuC8cN1AQyXrrWdw2h3Vp、READY。本番HTMLの `app.js?v=20261025a` がmainと一致を確認)。直近24時間のデプロイ回数は今回を含め3回。連携は0件のまま。
- 2026-10-26(2回目): tori-robo の利用記録(アプリ起動日時をA列、ダウンロードの日時・期間をB:C。PR #931)を、ユーザーの「デプロイして」で `create_deployment` により本番デプロイ(連携なし。project=-tori-robo、コミット 2a482a3。dpl_HSsHacaShmyjkU77Ho1R83JYThbQ、READY)。本番の index.html・app.js・style.css がmainと一致(app.js?v=sp55)、api/data は200を確認。デプロイ前の直近24時間は3回、今回1回で計4回。連携は0件のまま。GASはバージョン16(ping=2026-10-26-log-start)。
- 2026-10-26(3回目): truck-fax を、ユーザーがVercelでプロジェクトを新規作成して初回デプロイ(main=7d74911。Hobbyの直近24時間のデプロイは truck-fax の1回)し、そのままGit連携を解除。`get_project`・`list_deployments` でREADY(production 1件)、`https://truck-fax.vercel.app/` が200で `app.js?v=20261026g` を返すことを確認。GASは20261026a(変更なし)。
- 2026-10-26(4回目): truck-fax の「追加変更依頼」ボタン(AIに変更指示。PR #943)を、ユーザーの「デプロイして」で `create_deployment` により本番デプロイ(連携なし。project=truck-fax=prj_pPozF4l8zEvgiL1X1SbXJHwGwOA6。コミット bc0df71。dpl_2cLRhmhtv5DMxwEgMxm9U1bu7YYp=READY、alias `truck-fax.vercel.app`)。デプロイ前の直近24時間は5回(Hobby上限100)、今回で6回。`https://truck-fax.vercel.app/` が `reqBtn` と `app.js?v=20261026r` を返すことを確認。公開GASは `CODE_VERSION` 20261026b(コードは20261026c。差は権限承認用の `sendTestMail` だけで画面の動作は同じ)。`list_projects`(repoUrl=aism24/-)は0件を確認。
- 2026-10-26(5回目): truck-fax の「取込一覧 ⇔ 車両・運転手情報の連動」と追加変更依頼の注記(PR #946)を、ユーザーの「デプロイして」で `create_deployment` により本番デプロイ(連携なし。project=truck-fax。コミット dd2bf78。dpl_DP4MfjRm5dCBY6TyX3NqJBNXV3wk=READY、alias `truck-fax.vercel.app`)。デプロイ前の直近24時間は6回(Hobby上限100)、今回で7回。`https://truck-fax.vercel.app/` が `reqBtn` と `app.js?v=20261026u` を返すことを確認。公開GASは `CODE_VERSION` 20261026d(コードと同じ)。`list_projects`(repoUrl=aism24/-)は0件を確認。
- 2026-10-27(6回目): truck-fax の「取込一覧で変更前の下に変更後を並べ、変わった項目に紫の矢印」(PR #948・#949・#951)を、ユーザーの「デプロイして」で `create_deployment` により本番デプロイ(連携なし。project=truck-fax。コミット 79ac166。dpl_6MxMTbxYcEGXNYKn5BBw5hyivw9B=READY。直近24時間は7回→今回で8回。本番の index.html が app.js?v=20261027c であることを確認)。
- 2026-10-27(7回目): truck-fax の「原本を閉じたとき、開いていた行が取込一覧の一番上に来る」(PR #953)を、ユーザーの「デプロイして」で `create_deployment` により本番デプロイ(連携なし。project=truck-fax。コミット 1e37b28。dpl_5eA1YyqLqxvqT6b21pASo8z969RF=READY。直近24時間は7回→今回で8回。本番の index.html が app.js?v=20261027d であることを確認)。
- 2026-10-27: app-launcher の最下行ホバーのちらつき修正(PR #950 scrollbar-gutter、PR #954 下余白320px+overflow-anchor:none。最下行のパネルでページが伸びて自動スクロール→ボタンがマウスから外れる繰り返しを防止。style.css?v=32)を、ユーザーの「デプロイして」で `create_deployment` により本番デプロイ(連携なし。コミット 4f0c8dc。app-launcher=dpl_8uWdZqJ、READY。本番 https://app-launcher-ashy.vercel.app/ の `?v=32` と下余白を確認。デプロイ前の直近24時間(app-launcher)は0回、今回1回。`list_projects` 0件)。
- 2026-10-27(8回目): truck-fax の「AIに変更指示」ダイアログの見た目(タイトル1.5倍・ピンク太字・中央、薄いピンク背景、説明文を1行・中央揃え、内容欄に書き方の例をプレースホルダー表示。PR #959〜#962。app.js?v=20261027h・style.css?v=20261027g)を、ユーザーの「デプロイして」で `create_deployment` により本番デプロイ(連携なし。コミット b8e5ac4。dpl_GYQ7qWy、READY。本番 https://truck-fax.vercel.app/ の `?v=` と例文を確認。デプロイ前の直近24時間(truck-fax)は5回、今回6回目。`list_projects` 0件)。
- 2026-10-28(9回目): truck-fax の「読み取り内容をExcelでダウンロード」ボタン(PDF取込の読み取り結果を、記録できるときだけ押せ、押すとExcelをダウンロードして記録して閉じる。PR #966・#967。app.js?v=20261027j)を、ユーザーの「デプロイして」で `create_deployment` により本番デプロイ(連携なし。project=truck-fax。コミット 6e3e741。dpl_7x8w3U4CTVi8diHs92A17oA7No2R=READY、alias `truck-fax.vercel.app`)。デプロイ前の直近24時間(truck-fax)は6回、今回7回目(Hobby上限100)。`https://truck-fax.vercel.app/` が200で `app.js?v=20261027j` を返し、app.js に新しい処理(syncReadExcelBtn)が入っていることを確認。公開GASは `CODE_VERSION` 20261027e(輸送回数の自動集計。PR #965。コードと同じ)。`list_projects`(repoUrl=aism24/-)は0件を確認。
- 2026-10-28(10回目): truck-fax の「FAX単位の削除(変更前・変更後の相手の行は空欄に戻る。確認ポップアップは1.5倍)・取込一覧の見出しフィルタ(現場名・手配業者・運送業者・氏名)とリセット・戻す/閉じるボタンの黄色・削除ボタンの金色の点滅・原本の100%=全体表示・車両・運転手情報の見出し固定」(PR #970・#972〜#977・#979。app.js?v=20261028h・style.css?v=20261028f・viewer.js?v=20261028a)を、ユーザーの「デプロイして」で `create_deployment` により本番デプロイ(連携なし。project=truck-fax。コミット 61209a6。dpl_6uqFxmvhDbKdprtYLYjwD3jG9aQi=READY、alias `truck-fax.vercel.app`)。デプロイ前の直近24時間(truck-fax)は7回、今回8回目(Hobby上限100)。`https://truck-fax.vercel.app/` が200で上の3つの版を返し、app.js に新しい処理(resetTargets・openFilterPop・colFiltered)が入っていることを確認。公開GASは `CODE_VERSION` 20261028b(FAX削除 `deleteFax` を含む。ユーザーがバージョン26として貼り替え済み。コードと同じ)。`list_projects`(repoUrl=aism24/-)は0件を確認。
- 2026-10-28(11回目): truck-fax の「起動・再読み込みの高速化(index.htmlでGASを先出し要求・記録後の取込一覧の裏読み・ダウンロードの使い回し・GASキャッシュ)とデッドコード整理」(PR #981・#982。app.js?v=20261028i・logic.js?v=20261028a)を、ユーザーの「デプロイして」で `create_deployment` により本番デプロイ(連携なし。project=truck-fax。コミット a1c282a。dpl_BBRCFPqAz4jK1LfFaQV9RRsjfCWG=READY、alias `truck-fax.vercel.app`)。デプロイ前の直近24時間(truck-fax)は8回、今回9回目(Hobby上限100)。`https://truck-fax.vercel.app/` が200で `app.js?v=20261028i` と `__early` を返し、app.js に新しい処理(takeEarly・loadAllImports)が入っていることを確認。本番を実ブラウザで6回開いた「データ読み込み中」の時間は中央値1970ms(最小1801・最大2511。init・listImportsは各1回)。デプロイ前の同じ測り方は4.3〜5.2秒。公開GASは `CODE_VERSION` 20261028c(バージョン27。コードと同じ)。`list_projects`(repoUrl=aism24/-)は0件を確認。
- 2026-10-28(12回目): truck-fax の「会社ロゴを5回クリックすると会社名の右側に「← アプリ一覧へ」を表示(to-launcher.js に after モードを追加。PR #986)」と「追加変更依頼の『既存ボタンの削除』に復活できる旨の注記(PR #987)」(app.js?v=20261028j・style.css?v=20261028g・to-launcher.js?v=20261028a)を、ユーザーの「デプロイして」で `create_deployment` により本番デプロイ(連携なし。project=truck-fax。コミット efc6f87。dpl_Ba5h81aFfYDx2GjLSGWnbfmeZoGZ=READY、alias `truck-fax.vercel.app`)。デプロイ前の直近24時間(truck-fax)は8回、今回9回目(Hobby上限100)。`https://truck-fax.vercel.app/` が200で `app.js?v=20261028j`・`style.css?v=20261028g` と `truck-fax:toLauncher` を返し、app.js に REQ_KIND_LABEL、to-launcher.js(200)に after モードが入っていることを確認。公開GASは `CODE_VERSION` 20261028c(変更なし。GASの貼り替えは不要)。`list_projects`(repoUrl=aism24/-)は0件を確認。
- 2026-10-27: shipping-list-link の修正(PR #990 Excel取り込み / #991〜#995 詳細図PDFの画像読み取り(Gemini)・セルの薄い青の着色・図面番号欄にもリンク・読み取りを1回で確定する高速化・ドロップ枠アニメを4枚に)を、ユーザーの「デプロイして」で `create_deployment` により本番デプロイ(連携なし。コミット 25fc8ba。dpl_2iApzGe5K2mSaNTN7CZ8KE49wm8r、READY)。本番の index.html・app.js・core.js・xlsx-link.js・drawing-read.js・vendor/jszip.min.js が main と一致(app.js?v=20261027c・drawing-read.js?v=20261027d)。api/links は200(1回目2.1秒、2回目0.22秒=CDN)。直近24時間のデプロイ回数は、デプロイ前10回(全アプリ合計)、今回1回。Git連携は0件。GAS は CODE_VERSION 20261027b(バージョン11。`?action=ocrcheck` が ok)。
