# 引き継ぎ書の保存先(Drive)ルールとフォルダ表

CLAUDE.md から分離(2026-10-21)。要点は CLAUDE.md の「引き継ぎ書」節。


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
| コストインサイト(cost-insight。原価管理・生産進捗分析。管理用スプレッドシート「コストインサイト」も同じフォルダ内。2026-10-01登録。引き継ぎ書のタイトルは「コストインサイト引き継ぎ書 YYYY-MM-DD 統合版 最新版(…)」。2026-10-23に第4版を作成し、最新は第4版(2026-10-23)) | https://drive.google.com/drive/folders/1iB0Za-pfjZm3jfgyhQ4ktMkhEaCjivbO | `1iB0Za-pfjZm3jfgyhQ4ktMkhEaCjivbO` |
| 梁ロボ(tori-robo。鳥取梁ロボ管理。管理用スプレッドシート「鳥取梁ロボ管理データ」も同じフォルダ内。2026-10-02登録) | https://drive.google.com/drive/folders/1E0FH8FPtfcyyIK-lH0O-JC1I1vRCb5Iw | `1E0FH8FPtfcyyIK-lH0O-JC1I1vRCb5Iw` |
| リンク付き出荷リスト(shipping-list-link。出荷リストPDFの製品名に実寸法師へのハイパーリンクを付与。元PDF・リンク表・記録シート「PDFに図番ハイパーリンク付与」も同じフォルダ内。2026-10-05登録。引き継ぎ書のGoogleドキュメントのタイトルは「リンク付き出荷リスト」。最新は「リンク付き出荷リスト引き継ぎ書 (2026-10-23) 最新版」(保存・記録の失敗を画面に出さない修正・本番反映・api/links の502まで)) | https://drive.google.com/drive/folders/1vekpzwfn-W0MqRyWWYzWdS4A6jp2bEt3 | `1vekpzwfn-W0MqRyWWYzWdS4A6jp2bEt3` |
| アプリランチャー(app-launcher。アプリ一覧・検索。管理用スプレッドシート「アプリ一Launcher」も同じフォルダ内。引き継ぎ書のGoogleドキュメントのタイトルは「アプリランチャー引き継ぎ書 (vN) 最新版」。2026-10-05登録) | https://drive.google.com/drive/folders/1wjoBjlZ4lzCt7weocczUVRfjZV4axbpX | `1wjoBjlZ4lzCt7weocczUVRfjZV4axbpX` |
| 日報全期間集計(daily-report。管理用スプレッドシート「日報集計アプリ」も同じフォルダ内。引き継ぎ書のタイトルは「日報アプリ引き継ぎ書」。2026-10-06登録。最新は「日報アプリ引き継ぎ書 (2026-10-23 第6版) 最新版」(起動時データの分割取得・本番反映まで)) | https://drive.google.com/drive/folders/1RYjLWyC2mxSq8_Jzan-pWnpxrsvcTYgL | `1RYjLWyC2mxSq8_Jzan-pWnpxrsvcTYgL` |
| 社内AI(company-ai。就業規則などへの質問応答。管理用スプレッドシート「社内AI」も同じフォルダ内。引き継ぎ書のGoogleドキュメントのタイトルは「社内AI 引き継ぎ書 (vN) 最新版」。2026-10-07登録) | https://drive.google.com/drive/folders/1cu5MjHLvq4Vw5D4XT74tp43heg6lA3RT | `1cu5MjHLvq4Vw5D4XT74tp43heg6lA3RT` |
| 実寸データより長さと本数集計(tdf-dim-count。TDFのレイヤ別に寸法の長さ・本数を集計。管理用スプレッドシート「tdf-dim-count」(シート「記録」=Excelダウンロード時の利用履歴。GAS経由)も同じフォルダ内。2026-10-14登録。引き継ぎ書のGoogleドキュメントのタイトルは「実寸データより長さと本数集計 引き継ぎ書 (vN) 最新版」(2026-10-14に v1〜v3、2026-10-19に v4、2026-10-21に v5 を作成。最新は v5)。リポジトリ内のREADME・tests・know-howも記録) | https://drive.google.com/drive/folders/1SHZZBXgv6Z21E-vDi4VldUUuuPsZVn4R | `1SHZZBXgv6Z21E-vDi4VldUUuuPsZVn4R` |
| 社内不具合アプリ（huguai。不具合記録アプリ(鳥取)のVercel版。`huguai/`。管理用スプレッドシート「社内不具合アプリVercel版」「社内不具合アプリHTML」「不具合アプリ結果表示」も同じフォルダ内。2026-10-15登録。引き継ぎ書のGoogleドキュメントのタイトルは「社内不具合アプリ（huguai） 引き継ぎ書 (vN) 最新版」(2026-10-15に v1〜v4、2026-10-16に v5・v6 を作成。2026-10-21に v9 を作成し、最新は v9)) | https://drive.google.com/drive/folders/109FIFxFVC3sQU9S2tx596jMLJzrAkmgD | `109FIFxFVC3sQU9S2tx596jMLJzrAkmgD` |
| 実寸法師を開く(jissun-open。`jissun://` で社内共有フォルダのHTMLを開く入口。管理用スプレッドシートは「00_マスタから実寸法師を開く」(旧open_jissun用データ元)と「実寸法師を開く_Vercel記録」(開かれた日時の記録。シート「記録」)が同じフォルダ内。2026-10-16、ユーザーがフォルダを指定して登録。引き継ぎ書のGoogleドキュメントのタイトルは「実寸法師を開く_引き継ぎ書 (第N版) 最新版」(第3版=2026-10-16。2026-10-21に第7版を作成し、最新は第7版。第1・2版は同じフォルダの「実寸法師を開く_引き継ぎ書」)) | https://drive.google.com/drive/folders/1OUOznQizC__sdPOHTe3lbjvfZxSj72IC | `1OUOznQizC__sdPOHTe3lbjvfZxSj72IC` |
| 鳥取運送アプリ(unso-check。運送業者の配車Excelを取り込み、21日始まり・20日締めの締め月ごとに請求チェック・年度集計。管理用スプレッドシート「鳥取運送アプリ」と、サブフォルダ「保存用バックアップ」が同じフォルダ内。2026-10-19、ユーザーが引き継ぎ書を共有して登録。引き継ぎ書のタイトルは「鳥取運送アプリ_引き継ぎ書(更新版N・日付)最新版」(2026-10-19に更新版11、2026-10-23に更新版12・13を作成。最新は更新版13。更新版10までは「鳥取運送アプリ_引き継ぎ書」)) | https://drive.google.com/drive/folders/1-Bklp4MLRbf-WL1H1rvdo26wOczl0puB | `1-Bklp4MLRbf-WL1H1rvdo26wOczl0puB` |
| 生産管理ダッシュボード(production-management。3拠点の生産実績を案件マスターExcelから集計。索引スプレッドシート「Excelマスタ一覧」(GASのコンテナバインド元)・キャッシュJSONが同じフォルダ内。2026-10-19、ユーザーが引き継ぎ書を共有して登録。引き継ぎ書のタイトルは「生産管理ダッシュボード_引き継ぎ書(YYYY年M月D日版)」(2026-10-19に作成。旧版も残置)) | https://drive.google.com/drive/folders/1mj4vsEHTkaSjuMrqRC7NMGCYc2JC9EIo | `1mj4vsEHTkaSjuMrqRC7NMGCYc2JC9EIo` |
| PDF比較解析アプリ(pdf-diff-app。新旧PDFの表・文章・図面の差分表示。記録用スプレッドシート「PDF差分解析（表、文章、図面）」と、サブフォルダ「ローカル実行済み正解データ」が同じフォルダ内。2026-10-19、ユーザーが引き継ぎ書を共有して登録。引き継ぎ書のタイトルは「PDF比較解析アプリ 引き継ぎ書(YYYY-MM-DD更新版)」(2026-10-19に更新版を作成。旧版も残置)) | https://drive.google.com/drive/folders/1aTNiacBOpV8Tq_PlR4VTX8yPGscGIbQ1 | `1aTNiacBOpV8Tq_PlR4VTX8yPGscGIbQ1` |
| 車番連絡自動化(truck-fax。運送の車番連絡FAX(PDF)をGeminiで読み取り、取込一覧・車両・運転手情報(シート「車両運転手情報」。1行=車と運転手の1組)に記録。管理用スプレッドシート「車番連絡自動化」が同じフォルダ内。フォルダ名「10　夢前車番連絡FAX」。2026-10-20、ユーザーが「シートがあるフォルダでよい」と指示して登録。引き継ぎ書のGoogleドキュメントのタイトルは「車番連絡自動化 引き継ぎ書 (vN) 最新版」(2026-10-20に v1 を作成。2026-10-23に v8 を作成し、最新は v8)) | https://drive.google.com/drive/folders/1uHVLxK9NEcLrSGr9zvf9QOn6D3iWIfJr | `1uHVLxK9NEcLrSGr9zvf9QOn6D3iWIfJr` |
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
- **個人アカウントに古い引き継ぎ書が見つかっても、問題として扱わない(2026-10-22、ユーザー説明)。** 会社アカウントでファイルを削除すると、削除したファイルが、ユーザーの個人アカウント(masamiz.sumi@gmail.com)のマイドライブ直下に、**自動でバックアップ**される。Claudeが個人アカウントに保存することはありえない。そのため、`search_files` で、所有者が個人アカウント・親が個人のマイドライブ直下の旧版(例: truck-fax の v1〜v3)が見つかったときは、**会社アカウント側で削除されたもの**と判断する(「保存先の指定漏れ」と報告しない)。そのバックアップは、ユーザーが自分で削除する。Claudeは移動・削除・ゴミ箱への移動をしない。
- 引き継ぎ書を更新するときは、そのアプリの指定フォルダ内の最新版(search_files で title に「引き継ぎ書」、modifiedTime の新しいもの)を読んでから、
  それを元に新しい版を同じフォルダに作る(タイトルに日付と「最新版」等を入れる)。

