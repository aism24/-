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
