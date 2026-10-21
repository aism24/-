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
| truck-fax(Vercelプロジェクトは未作成) | truck-fax | 未連携(プロジェクト自体が無い。2026-10-20) | アプリ名「車番連絡 取込」(スプレッドシート「車番連絡自動化」)。画面の確認はraw.githack(コミット固定のURL)。`truck-fax/vercel.json` の `git.deploymentEnabled=false` で自動デプロイ停止済み。公開するときは、ユーザーがVercelでプロジェクトを作成(Root Directory=truck-fax)→「デプロイして」の指示で `create_deployment`(teamIdは渡さない)。GAS(`truck-fax/gas/Code.gs`。コンテナバインド。Webアプリは「全員」)は、貼り替え→「新バージョン」で反映する(`CODE_VERSION` で確認)。引き継ぎ書はDriveの保存先フォルダ(上の表) |

**運用の原則**: 全アプリのGit連携を解除したままにする。連携が無ければpush・マージでデプロイは起きず、ユーザーが「デプロイして」と指示したアプリだけを `create_deployment` で1つずつデプロイする(連携は不要。Vercelプロジェクトの新規作成と連携の付け外しだけがユーザー操作)。連携が1件でも残っていたら、push・マージ前にユーザーへ解除を依頼する。

**最新の確認**: 2026-10-21、`list_projects`(repoUrl=aism24/-)は0件(全アプリ未連携)。

**`vercel.json` の `git.deploymentEnabled=false` が無いフォルダ**(2026-10-19時点): pdf-diff-app(functionsの設定だけ)・unso-check・production-management・tdf-master-web・jissun-master-jidokinyu・kozai-toriai・weld-heat-management。連携は0件なので今は自動デプロイされないが、これらのVercelプロジェクトを `aism24/-` に連携し直す前に、必ずそのフォルダへ置くこと(特に pdf-diff-app は1デプロイごとにFunctions Storageを消費する)。

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
- 2026-10-21(3回目): shipping-list-link の全コード点検の修正(PR #850。加工予定表の重複をNGに数える・実データ入りの sample/links.json 削除)を、ユーザーの「デプロイして」で `create_deployment` により本番デプロイ(連携なし。コミット 0a7fbed。dpl_21YCTjE、READY)。本番の index.html・app.js・core.js がmainと一致、sample/links.json は404、api/links は200(29,027件)を確認。デプロイ前の直近24時間は5回、今回1回。連携は0件のまま。
