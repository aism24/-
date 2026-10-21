# 統合・運用停止フォルダ、GAS高速化方針、vercel.json方式の詳細

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

