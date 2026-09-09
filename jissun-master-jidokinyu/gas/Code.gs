// ============================================================
// 実寸法師 マスタ情報入力 - 起動ランチャー GASバックエンド
// ============================================================
//
// このアプリ専用の新規スプレッドシートにコンテナバインドして使う。
// 1枚目のシートに掲載する項目(①実寸法師インストール確認・②実寸法師アプリ本体への
// jissun://リンク)を並べておき、フロントエンド(GitHub Pages)が番号付きボタンとして
// 描画する。項目を増やしたい場合もコードの変更は不要で、1枚目のシートに行を
// 追加するだけでよい(表示順は行の並び順)。
//
// タブの名前(「情報」「記録」等)ではなく、スプレッドシート内の**シートの並び順**で
// 参照する(1番目=ボタン一覧、2番目=記録)。実際に作成されたスプレッドシートの
// タブ名がどうであっても動作するようにするため。
//
// 【1番目のシート(ボタン一覧)の想定列】
// A:ボタン(名前)  B:URL  (1行目はヘッダー、2行目以降がデータ)
//
// 【2番目のシート(記録)の想定列】
// A:日時  B:ボタン(名前)  (1行目はヘッダー。2行目に最新の記録を挿入していく=新しい順、
// 常に2行目が最新・以降のデータは下に伸びていく)
//
// 【セットアップ手順】
// 1. スプレッドシートに、1枚目=ボタン一覧(ボタン/URLの2列)、2枚目=記録(日時/ボタンの
//    2列、ヘッダー行のみでよい)の2シートを用意する
// 2. スプレッドシート上部の「拡張機能」→「Apps Script」を開く
// 3. このCode.gsの内容をまるごとコピー&ペーストして保存する
// 4. 右上の「デプロイ」→「新しいデプロイ」→種類「ウェブアプリ」を選択し、
//    次のユーザーとして実行:「自分」 / アクセスできるユーザー:「全員」 で発行する
//    (GitHub Pagesからの匿名fetchに対応するため必須)
// 5. 発行されたウェブアプリのURL(https://script.google.com/macros/s/xxxxx/exec)を
//    Claudeとのチャットに貼り付ける(app.js先頭のGAS_API_URLに反映してGitHubへpushする)
// ============================================================

// タブ名ではなくシートの並び順(0番目・1番目)で参照する。
function getButtonSheet_() {
  return SpreadsheetApp.getActiveSpreadsheet().getSheets()[0];
}
function getLogSheet_() {
  return SpreadsheetApp.getActiveSpreadsheet().getSheets()[1];
}

function apiJsonOk_(data) {
  return ContentService
    .createTextOutput(JSON.stringify({ status: 'success', data: data }))
    .setMimeType(ContentService.MimeType.JSON);
}

function apiJsonErr_(message) {
  return ContentService
    .createTextOutput(JSON.stringify({ status: 'error', message: message }))
    .setMimeType(ContentService.MimeType.JSON);
}

// 1番目のシート(ボタン一覧)を読み、ボタンとして表示する項目一覧を返す(行の並び順を維持)。
function getItems() {
  const sheet = getButtonSheet_();
  if (!sheet) return [];

  const rows = sheet.getDataRange().getValues();
  const items = [];
  for (let i = 1; i < rows.length; i++) {
    const [name, url] = rows[i];
    if (!name || !url) continue;
    items.push({ name: name, url: url });
  }
  return items;
}

// ボタン押下時にクライアント側(app.js)から呼び出される。
// 記録シートの2行目(ヘッダーの直下)に新しい行を挿入して[日時, ボタン名]を書き込む。
// 既存の記録はすべて1行ずつ下に押し出されるため、常に2行目が最新の記録になる。
function logOpen(name) {
  const sheet = getLogSheet_();
  if (!sheet) return;
  sheet.insertRowBefore(2);
  sheet.getRange(2, 1, 1, 2).setValues([[new Date(), name]]);
}

/**
 * POSTリクエスト用エントリポイント。
 * リクエストボディ(JSON文字列)の例: { "action": "getItems" }
 *
 * CORSプリフライト(OPTIONS)はGASが対応していないため、フロントエンド側は
 * 必ず Content-Type: text/plain でPOSTすること(他アプリ(open_jissun・
 * app-launcher等)と同じ方式)。
 */
function doPost(e) {
  try {
    const body = JSON.parse(e.postData.contents);
    const action = body.action;
    const params = body.params || {};

    if (action === 'getItems') return apiJsonOk_(getItems());
    if (action === 'logOpen') {
      logOpen(params.name);
      return apiJsonOk_({});
    }
    return apiJsonErr_('不明なaction: ' + action);
  } catch (err) {
    return apiJsonErr_(String(err && err.message || err));
  }
}
