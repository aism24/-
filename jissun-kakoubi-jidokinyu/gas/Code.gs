// ============================================================
// 実寸法師 マスタ情報入力 - 起動ランチャー GASバックエンド
// ============================================================
//
// このアプリ専用の新規スプレッドシートにコンテナバインドして使う。
// 「情報」シートに掲載する項目(①実寸法師インストール確認・②実寸法師アプリ本体への
// jissun://リンク)を並べておき、フロントエンド(GitHub Pages)が番号付きボタンとして
// 描画する。項目を増やしたい場合もコードの変更は不要で、「情報」シートに行を
// 追加するだけでよい(表示順は行の並び順)。
//
// 【情報シートの想定列】
// A:ID  B:名前  C:URL  D:説明  (1行目はヘッダー、2行目以降がデータ)
//
// 【記録シートの想定列】
// A:日時  B:名前  (1行目はヘッダー。2行目に最新の記録を挿入していく=新しい順)
//
// 【セットアップ手順】
// 1. 新規スプレッドシートを作成し、「情報」「記録」の2シートを用意する
//    (「情報」シートにヘッダー行 + ①②の2行、「記録」シートにヘッダー行のみでよい)
// 2. スプレッドシート上部の「拡張機能」→「Apps Script」を開く
// 3. このCode.gsの内容をまるごとコピー&ペーストして保存する
// 4. 右上の「デプロイ」→「新しいデプロイ」→種類「ウェブアプリ」を選択し、
//    次のユーザーとして実行:「自分」 / アクセスできるユーザー:「全員」 で発行する
//    (GitHub Pagesからの匿名fetchに対応するため必須)
// 5. 発行されたウェブアプリのURL(https://script.google.com/macros/s/xxxxx/exec)を
//    Claudeとのチャットに貼り付ける(app.js先頭のGAS_API_URLに反映してGitHubへpushする)
// ============================================================

const SHEET_NAME = '情報';
const LOG_SHEET_NAME = '記録';

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

// 「情報」シートを読み、ボタンとして表示する項目一覧を返す(行の並び順を維持)。
function getItems() {
  const sheet = SpreadsheetApp.getActiveSpreadsheet().getSheetByName(SHEET_NAME);
  if (!sheet) return [];

  const rows = sheet.getDataRange().getValues();
  const items = [];
  for (let i = 1; i < rows.length; i++) {
    const [id, name, url, description] = rows[i];
    if (!name || !url) continue;
    items.push({ id: id, name: name, url: url, description: description || '' });
  }
  return items;
}

// ボタン押下時にクライアント側(app.js)から呼び出される。
// 「記録」シートの2行目(ヘッダーの直下)に[日時, 名前]を挿入する。
function logOpen(name) {
  const sheet = SpreadsheetApp.getActiveSpreadsheet().getSheetByName(LOG_SHEET_NAME);
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
