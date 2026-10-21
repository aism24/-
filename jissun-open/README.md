# 実寸法師を開く（jissun:// 起動専用ページ）

`jissun://...` という独自プロトコルへの直リンクを行う静的1ページです(アプリランチャーの app009)。
起動そのものはGASを使わず、開かれた日時の記録(利用記録)だけをGASで行います(下の「利用記録」)。

## 目的

app-launcherの「実寸法師を開く」(app009)は、以前はスプレッドシートのURL列に
`jissun://...` を直接入れていたため、OSのプロトコル起動許可ダイアログに
app-launcher側のドメイン(当時のGitHub Pages版ではリポジトリ名)が表示されていた。

このページをVercelで公開し、app009のURLを直接の`jissun://...`ではなく
**このページのVercel URL**(https://jissun-open.vercel.app/)にすることで、app-launcherは通常のhttpリンクとして
新規タブでこのページを開く。許可ダイアログにはこのページ自身のドメイン
(vercel.app側)が表示される。

## 構成

```
jissun-open/
  index.html      … <meta refresh>(自動遷移の試み) + 本物の<a href="jissun://...">
                    ボタン(自動遷移がブロックされた場合の確実なフォールバック)
                    + 末尾に利用記録の送信スクリプト(GAS_URL へPOST)
  style.css       … スタイル(他のjissun系アプリと同じ配色)
  to-launcher.js  … 「← アプリ一覧へ」ボタン(正本 docs/to-launcher/to-launcher.js のコピー)
  vercel.json     … {"git":{"deploymentEnabled":false}}(push・マージで自動デプロイしない)
  gas/Code.gs     … 利用記録用のGAS(スプレッドシートにコンテナバインド)
```

起動先の`jissun://`のURLは`index.html`内の2か所(`<meta refresh>`と`<a href>`)に直接埋め込んでいる。
変えるときは2か所とも同じURLにする。

## 公開(Vercel)

- Vercelプロジェクト「jissun-open」(Root Directory=`jissun-open`、Framework Preset=Other、ビルド不要)。
- Git連携はしない。本番反映はユーザーが「デプロイして」と指示したときだけ `create_deployment` で行う
  (運用は リポジトリの `CLAUDE.md` と `docs/vercel-status.md`)。
- Ignored Build Step は「Automatic」にしておく(`-- ./jissun-open` のコマンドが入っていると常にCANCELEDになる)。

## 動作確認

- 実寸法師が関連付けられた端末のブラウザで、app-launcherから「実寸法師を開く」をクリックする。
- 新規タブでこのページが開き、自動的に(または「実寸法師を開く」ボタンを押すと)
  OSの起動許可ダイアログが表示され、そこにVercelのドメインが表示されることを確認する。

## 利用記録(2026-10-16〜)

ページが開かれるたびに(再読み込みを含む)、スプレッドシート「実寸法師を開く_Vercel記録」のシート「記録」へ日時を1行追記する
(`gas/Code.gs`。常にA2が最新で、古いものは下へ移る)。`index.html` 末尾のスクリプトが `GAS_URL` へPOSTする。
`GAS_URL` が空の間は何も送らない。記録に失敗しても実寸法師の起動には影響しない。
セットアップは `gas/Code.gs` 冒頭のコメントを参照。

- GASを直したら `CODE_VERSION` を更新し、Apps Scriptへ貼り替えて「新バージョン」でデプロイする。
  反映は `/exec` をブラウザ(GET)で開き、返ってくる `version` が `CODE_VERSION` と一致するかで確認する。
