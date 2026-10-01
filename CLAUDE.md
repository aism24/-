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
| sonekibunki (https://sonekibunki.vercel.app/) | production-profit | 解除(2026-09-29、#416〜#424を本番デプロイ後にユーザーが解除。`list_projects` 0件を確認。`vercel.json` の `git.deploymentEnabled=false` は残置) | 静的サイト(関数なし)。本番反映は `create_deployment` で行う。GitHub Pages版は廃止(index.htmlでVercel版へ転送) |

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
| 上記以外のアプリ | 未登録(ユーザーがアプリごとに指示する。指示されたらこの表に追記する) | - |

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

## 不要フォルダ(残置)(2026-09-24〜)

- `open_jissun/`: **不要フォルダ**(ユーザー判断)。実際の「実寸法師を開く」は
  `jissun-open`(Vercel)→ jissun:// → 社内共有フォルダのHTML で運用しており、
  このフォルダ(GitHub Pages版)は使わない。容量影響がほぼ無いため削除せず残しているだけ。
  新規の作業・Vercel化・ランチャー登録の対象にしないこと。
  (ただし `gas/Code.gs` は稼働中GASのソースの可能性があるため、参照用としては有効)
