# 実寸法師を開く（jissun:// 起動専用ページ）

`jissun://...` という独自プロトコルへの直リンクだけを行う、GASを使わない静的1ページです。

## 目的

app-launcherの「実寸法師を開く」(app009)は、これまでスプレッドシートのURL列に
`jissun://...` を直接入れており、app-launcher自身のドメイン(GitHub Pages版なら
`aism24.github.io`)からOSのプロトコル起動許可ダイアログが呼ばれるため、そこに
リポジトリ名が表示されてしまっていた。

このページをVercelにデプロイし、app009のURLを直接の`jissun://...`ではなく
**このページのVercel URL**に差し替えることで、app-launcherは通常のhttpリンクとして
新規タブでこのページを開くようになる。許可ダイアログにはこのページ自身のドメイン
(vercel.app側)が表示され、リポジトリ名は出なくなる。

## 構成

```
jissun-open/
  index.html  … <meta refresh>とJS(自動遷移の試み) + 本物の<a href="jissun://...">
                ボタン(自動遷移がブロックされた場合の確実なフォールバック)
  style.css   … スタイル(他のjissun系アプリと同じ配色)
```

起動先のURLは`index.html`内に直接埋め込んでいる(固定のリンク1本だけのため、
GAS API・スプレッドシートは使わない)。

## デプロイ手順（ユーザー側の作業）

1. Vercelダッシュボードで「Add New... → Project」を選び、このリポジトリを選択する。
2. **Root Directory** に `jissun-open` を指定する(他の`app-launcher`等と同じ要領)。
3. Framework Presetは「Other」のままでOK(ビルド不要の静的サイト)。
4. デプロイ後に発行される `https://xxxxx.vercel.app/` のURLをコピーする。
5. 「情報」スプレッドシートのapp009行のURL列(C列)を、元の`jissun://...`から
   手順4のVercel URLに書き換える。

## 動作確認

- 実際に実寸法師が関連付けられた端末のブラウザで、app-launcherから
  「実寸法師を開く」をクリックする。
- 新規タブでこのページが開き、自動的に(または「実寸法師を開く」ボタンを押すと)
  OSの起動許可ダイアログが表示され、そこにリポジトリ名(aism24.github.io)ではなく
  Vercelのドメインが表示されることを確認する。
