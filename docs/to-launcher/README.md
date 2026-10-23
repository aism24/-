# to-launcher.js(「← アプリ一覧へ」ボタン)


各アプリのアプリ名の左に、アプリランチャー(https://app-launcher-ashy.vercel.app/)へ戻るボタンを付ける共通部品。2026-10-19、PR #760(コミット 96e4414)で17アプリに追加し、Vercelプロジェクトのある15アプリを本番デプロイした。

- **正本**: `docs/to-launcher/to-launcher.js`。**Vercelはフォルダ単位で配信する(Root Directory)ため、各アプリのフォルダに同じファイルをコピーして使う**(`<アプリ>/to-launcher.js`)。正本を直したら全フォルダへ再コピーし、`index.html` の `?v=` も上げて、対象アプリを(「デプロイして」の指示で)再デプロイする。
- **組み込み**: 各 `index.html` の `</body>` 直前に1行: `<script src="to-launcher.js?v=20261019" data-target="CSSセレクタ" data-mode="in|before|beforePrev"></script>`。`in`=その要素の先頭、`before`=その要素の直前、`beforePrev`=直前の兄弟がロゴ(img/svg/小さいdiv)ならその前。ボタンはJSが後から差し込む(ホームに戻るたびに入れ直す)。
- **見た目**: 背景色(7秒周期)と文字色(3秒周期)が別のリズムで変化し、縁が脈動して光る。背景の明暗をスクリプトが自動判定し、暗い=明るいボタン+濃い文字+金色の光、明るい=暗いボタン+明るい文字+濃い赤・ピンクの光。画面内の他のボタンの色相から40°以上離れた色だけを使う。コントラスト比は全コマで6.7以上(実測)。「視覚効果を減らす」設定では動きを止める。印刷では非表示。
- **ランチャーのURLを変えるとき**: 正本の `LAUNCHER_URL` を直し、全フォルダへ再コピーして**全アプリを再デプロイ**する(ランチャー側のURLを変えるだけでは反映されない)。
- **対象アプリと設定**(フォルダ: data-target / data-mode): company-ai: h1 / in、cost-insight: header h1 / in、daily-report: .appTitle / in、dxf-launcher: .header-block img / before、excel-drawing-link-tool: .masthead-brand h1 / in、huguai: .home-title / in(ホーム画面のみ)、jissun-master-jidokinyu: h1 / beforePrev、jissun-open: h1 / beforePrev、pdf-diff-app: #app-name / in、production-management: .app-header h1 / beforePrev、shipping-list-link: .hdr h1 / in(2026-10-23〜ユーザー指示で一時的に非表示。index.html の script 行をコメントにしているだけで、外せば復活)、tdf-dim-count: header h1 / in、tdf-master-web: header h1 / beforePrev、tori-robo: .hdr-center h1 / in、unso-check: .header-title / in。kozai-toriai(.app-header h1 / beforePrev)・weld-heat-management(#mode-select-screen .home-title / in)にもコードは入れたが、Vercelプロジェクトが無く、ユーザーが「必要ない」と指示したため本番デプロイしていない。
- **新しいアプリに付けるとき**: そのフォルダに to-launcher.js をコピー → 上の1行を入れる → ローカルのブラウザで、幅1280と390でボタンが1個・位置・コントラストを実測 → 他の設定と同様、main反映まで進め、本番は「デプロイして」の指示で。HTMLがCRLFのときは、Pythonのテキストモードで編集しない(全行が差分になる。バイナリで編集する)。
- **既知の点(未調整)**: 本番の画面での見た目は未確認(HTMLにscriptの読み込みがあり、to-launcher.jsが200で返ることまで確認)。tori-robo はスマホ幅(390px)でタイトルの右端が切れて見える。daily-report は390pxでボタンが左端に付きタイトルが2行になる。dxf-launcher はタイトル枠が狭くタイトルが2行になる。huguai・unso-check・weld-heat-management・daily-report は、最初の画面のタイトルだけにボタンが付く(他の画面にも付けるかは未決定)。
- **関連**: 2026-10-19の本番デプロイで、jissun-master-jidokinyu・unso-check・tdf-master-web(Vercelプロジェクト名「-tdf-master-web」)・production-management の4プロジェクトは、1回目が作成直後に CANCELED になった。原因は Settings → Build and Deployment → Ignored Build Step が常にスキップになる設定だったこと(ユーザーが「Automatic」に直し、`forceNew`=1 で再デプロイして READY)。デプロイが CANCELED になったら、まずここを確認する。

