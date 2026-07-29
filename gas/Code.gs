/**
 * GitHub Pages（フロントエンド）から呼び出すGAS APIバックエンド。
 * このファイルの内容をまるごとGASプロジェクトの Code.gs に貼り付けて使用してください。
 *
 * データストアとして、このスクリプトに紐づく（またはIDで指定した）
 * スプレッドシートの「Data」シートを使用します。
 */

// 特定のスプレッドシートを使う場合はIDを設定してください。
// 空のままにすると、コンテナバインド（スクリプトエディタをスプレッドシートから開いた場合）の
// アクティブなスプレッドシートを使用します。
const SPREADSHEET_ID = "";
const SHEET_NAME = "Data";

function getSheet_() {
  const ss = SPREADSHEET_ID
    ? SpreadsheetApp.openById(SPREADSHEET_ID)
    : SpreadsheetApp.getActiveSpreadsheet();

  let sheet = ss.getSheetByName(SHEET_NAME);
  if (!sheet) {
    sheet = ss.insertSheet(SHEET_NAME);
    sheet.appendRow(["id", "name", "message", "createdAt"]);
  }
  return sheet;
}

function jsonResponse_(payload) {
  return ContentService
    .createTextOutput(JSON.stringify(payload))
    .setMimeType(ContentService.MimeType.JSON);
}

function listItems_() {
  const sheet = getSheet_();
  const values = sheet.getDataRange().getValues();
  const rows = values.slice(1); // ヘッダー行を除く

  const data = rows
    .filter((row) => row[0])
    .map((row) => ({
      id: row[0],
      name: row[1],
      message: row[2],
      createdAt: row[3],
    }))
    .reverse(); // 新しい投稿を先頭に

  return data;
}

function addItem_(name, message) {
  const sheet = getSheet_();
  const id = Utilities.getUuid();
  const createdAt = new Date().toISOString();
  sheet.appendRow([id, name, message, createdAt]);
  return { id, name, message, createdAt };
}

/**
 * GET リクエスト用
 * 例: {WebアプリURL}?action=list
 */
function doGet(e) {
  try {
    const action = (e.parameter && e.parameter.action) || "list";

    if (action === "list") {
      return jsonResponse_({ status: "success", data: listItems_() });
    }

    return jsonResponse_({ status: "error", message: `不明なaction: ${action}` });
  } catch (err) {
    return jsonResponse_({ status: "error", message: err.message });
  }
}

/**
 * POST リクエスト用
 * リクエストボディ(JSON文字列)の例:
 * { "action": "add", "name": "山田太郎", "message": "こんにちは" }
 *
 * フロントエンド側は Content-Type: text/plain で送信してください。
 * application/json を指定するとブラウザがCORSプリフライト(OPTIONS)を送信しますが、
 * GASはOPTIONSに対応していないため失敗します。
 */
function doPost(e) {
  try {
    const body = JSON.parse(e.postData.contents);
    const action = body.action;

    if (action === "add") {
      const name = String(body.name || "").trim();
      const message = String(body.message || "").trim();

      if (!name || !message) {
        return jsonResponse_({ status: "error", message: "name と message は必須です" });
      }

      const item = addItem_(name, message);
      return jsonResponse_({ status: "success", data: item });
    }

    return jsonResponse_({ status: "error", message: `不明なaction: ${action}` });
  } catch (err) {
    return jsonResponse_({ status: "error", message: err.message });
  }
}
