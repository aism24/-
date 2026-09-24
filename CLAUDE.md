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
   Usage画面(Functions Storage)の現在値を教えてもらう。
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

※既存分はHobbyの30日保持により、最初のデプロイ(2026-09-19)から30日後の10月19日頃から順次減っていく見込み。

### 現在のGit連携状態(変更したらここを更新する)

| Vercelプロジェクト | 対象フォルダ | Git連携 | 備考 |
|---|---|---|---|
| pdf-diff-pythonapp (https://pdf-diff-pythonapp.vercel.app/) | pdf-diff-app | 解除(2026-09-24、関数統合版を本番デプロイ後に再解除) | |
| daily-report (https://all-daily-report.vercel.app/) | daily-report | 解除(2026-09-24) | `daily-report/vercel.json` で `git.deploymentEnabled=false`。Ignored Build Step=`git diff HEAD^ HEAD --quiet -- .` |

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
