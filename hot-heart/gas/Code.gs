/**
 * 「試合記録」アプリのGAS APIバックエンド。
 * このファイルの内容をまるごとGASプロジェクトの Code.gs に貼り付けて使用してください。
 *
 * フロントエンド（index.html/app.js）はGitHub Pagesで配信し、
 * このスクリプトはJSON専用APIとしてdoGet/doPostのみを提供します。
 */

const SPREADSHEET_ID = "1_TLsBoEotkp768S7xIzcrKpRJkqW1EnXUn6oM4NFpp4";
const DRIVE_FOLDER_ID = "1fTcV4B9C_rpq4LAHPwF4vOBPGr7UgSPg";
const SHEET_NAME = "記録";
const BG_SHEET_NAME = "背景写真";

function jsonResponse_(payload) {
  return ContentService
    .createTextOutput(JSON.stringify(payload))
    .setMimeType(ContentService.MimeType.JSON);
}

function ok_(data) {
  return jsonResponse_({ status: "success", data: data });
}

function errRes_(message) {
  return jsonResponse_({ status: "error", message: message });
}

/**
 * GET リクエスト用
 * 例: {WebアプリURL}?action=getResults&gender=男
 */
function doGet(e) {
  try {
    const action = e.parameter.action;
    if (action === "imageIds") return ok_(getImageIds());
    if (action === "getOpponentList") return ok_(getOpponentList());
    if (action === "getResults") return ok_(getResults(e.parameter.gender));
    if (action === "checkImageDuplicate") return ok_(checkImageDuplicate(e.parameter.fileName));
    return errRes_("不明なaction: " + action);
  } catch (err) {
    return errRes_(err.message);
  }
}

/**
 * POST リクエスト用
 * リクエストボディ(JSON文字列)の例:
 * { "action": "addOpponent", "name": "〇〇高校" }
 *
 * フロントエンド側は Content-Type: text/plain で送信してください。
 * application/json を指定するとブラウザがCORSプリフライト(OPTIONS)を送信しますが、
 * GASはOPTIONSに対応していないため失敗します。
 */
function doPost(e) {
  try {
    const body = JSON.parse(e.postData.contents);
    const action = body.action;
    if (action === "addOpponent") return ok_(addOpponent(body.name));
    if (action === "uploadImageAndSave") return ok_(uploadImageAndSave(body));
    if (action === "replacePhoto") return ok_(replacePhoto(body));
    return errRes_("不明なaction: " + action);
  } catch (err) {
    return errRes_(err.message);
  }
}

function getImageIds() {
  const ss = SpreadsheetApp.openById(SPREADSHEET_ID);
  const bgSheet = ss.getSheetByName(BG_SHEET_NAME);
  if (!bgSheet) return [];
  const lastRow = bgSheet.getLastRow();
  if (lastRow === 0) return [];
  const values = bgSheet.getRange(1, 1, lastRow, 1).getValues();
  return values.map(row => row[0]).filter(id => id !== "");
}

function getOpponentList() {
  const ss = SpreadsheetApp.openById(SPREADSHEET_ID);
  const sheet = ss.getSheetByName(SHEET_NAME);
  const lastRow = sheet.getLastRow();
  if (lastRow < 2) return [];
  const mRange = sheet.getRange(2, 13, Math.min(lastRow, 100) - 1, 2);
  const values = mRange.getValues();
  const list = values
    .filter(row => row[0] !== "")
    .map(row => ({ name: row[0], count: Number(row[1]) || 0 }));
  list.sort((a, b) => b.count - a.count);
  return list.map(item => item.name);
}

function addOpponent(name) {
  const trimmed = String(name || "").trim();
  if (!trimmed) throw new Error("対戦相手名が空です");
  const ss = SpreadsheetApp.openById(SPREADSHEET_ID);
  const sheet = ss.getSheetByName(SHEET_NAME);
  const mValues = sheet.getRange(2, 13, 99, 1).getValues();
  const existing = mValues.map(r => r[0].toString().trim());
  if (existing.includes(trimmed)) return { added: false };
  const emptyIdx = existing.findIndex(v => v === "");
  if (emptyIdx === -1) throw new Error("リストが満杯だぞな");
  sheet.getRange(emptyIdx + 2, 13).setValue(trimmed);
  return { added: true };
}

function checkImageDuplicate(fileName) {
  const folder = DriveApp.getFolderById(DRIVE_FOLDER_ID);
  return folder.getFilesByName(fileName).hasNext();
}

function uploadImageAndSave(payload) {
  const ss = SpreadsheetApp.openById(SPREADSHEET_ID);
  const sheet = ss.getSheetByName(SHEET_NAME);
  const folder = DriveApp.getFolderById(DRIVE_FOLDER_ID);
  const decoded = Utilities.base64Decode(payload.base64);
  const mimeType = (payload.mimeType === "image/heic" || payload.mimeType === "image/heif")
    ? "image/jpeg" : payload.mimeType;
  const blob = Utilities.newBlob(decoded, mimeType, payload.fileName);
  const file = folder.createFile(blob.setName(payload.fileName));
  file.setSharing(DriveApp.Access.ANYONE_WITH_LINK, DriveApp.Permission.VIEW);
  const photoUrl = "https://drive.google.com/file/d/" + file.getId() + "/view";

  const aValues = sheet.getRange(2, 1, sheet.getMaxRows() - 1, 1).getValues();
  let lastDataRow = 0;
  for (let i = 0; i < aValues.length; i++) {
    if (aValues[i][0] !== "" && aValues[i][0] !== null) {
      lastDataRow = i + 1;
    }
  }
  const newId = lastDataRow + 1;
  const writeRow = lastDataRow + 2;

  const score = parseInt(payload.score);
  const concede = parseInt(payload.concede);
  const diff = score - concede;
  let result = "引き分け";
  if (score > concede) result = "勝ち";
  else if (score < concede) result = "負け";

  sheet.getRange(writeRow, 1, 1, 9).setValues([[
    newId, payload.gender, payload.date, payload.opponent,
    score, concede, diff, result, photoUrl
  ]]);

  return { success: true };
}

/**
 * 既存の記録行の写真を差し替える。画像は常に1枚になるよう、
 * 差し替え前の写真ファイルはDriveのゴミ箱に移動する。
 */
function replacePhoto(payload) {
  const id = Number(payload.id);
  const ss = SpreadsheetApp.openById(SPREADSHEET_ID);
  const sheet = ss.getSheetByName(SHEET_NAME);
  const lastRow = sheet.getLastRow();
  if (lastRow < 2) throw new Error("データがありません");

  const ids = sheet.getRange(2, 1, lastRow - 1, 1).getValues();
  let targetRow = -1;
  for (let i = 0; i < ids.length; i++) {
    if (Number(ids[i][0]) === id) { targetRow = i + 2; break; }
  }
  if (targetRow === -1) throw new Error("該当する記録が見つかりません(ID: " + id + ")");

  const oldUrl = sheet.getRange(targetRow, 9).getValue();
  if (oldUrl) {
    const match = String(oldUrl).match(/\/d\/([a-zA-Z0-9_-]+)/);
    if (match) {
      try { DriveApp.getFileById(match[1]).setTrashed(true); } catch (e) { /* 既に削除済み等は無視 */ }
    }
  }

  const folder = DriveApp.getFolderById(DRIVE_FOLDER_ID);
  const decoded = Utilities.base64Decode(payload.base64);
  const mimeType = (payload.mimeType === "image/heic" || payload.mimeType === "image/heif")
    ? "image/jpeg" : payload.mimeType;
  const blob = Utilities.newBlob(decoded, mimeType, payload.fileName);
  const file = folder.createFile(blob.setName(payload.fileName));
  file.setSharing(DriveApp.Access.ANYONE_WITH_LINK, DriveApp.Permission.VIEW);
  const newUrl = "https://drive.google.com/file/d/" + file.getId() + "/view";

  sheet.getRange(targetRow, 9).setValue(newUrl);
  return { success: true, photoUrl: newUrl };
}

function getResults(gender) {
  const ss = SpreadsheetApp.openById(SPREADSHEET_ID);
  const sheet = ss.getSheetByName(SHEET_NAME);
  const lastRow = sheet.getLastRow();
  if (lastRow < 2) return [];
  const range = sheet.getRange(2, 1, lastRow - 1, 9);
  const values = range.getValues();
  const filtered = values
    .filter(row => row[0] !== "" && row[1] === gender)
    .map(row => {
      let dateStr = "-";
      const rawDate = row[2];
      if (rawDate instanceof Date && !isNaN(rawDate)) {
        dateStr = (rawDate.getMonth() + 1) + "月" + rawDate.getDate() + "日";
      } else if (typeof rawDate === "string" && rawDate.trim() !== "") {
        const d = new Date(rawDate);
        if (!isNaN(d)) {
          dateStr = (d.getMonth() + 1) + "月" + d.getDate() + "日";
        } else {
          dateStr = rawDate;
        }
      } else if (typeof rawDate === "number") {
        const d = new Date(Math.round((rawDate - 25569) * 86400 * 1000));
        dateStr = (d.getMonth() + 1) + "月" + d.getDate() + "日";
      }
      return {
        id: row[0],
        gender: row[1],
        date: dateStr,
        opponent: row[3],
        score: row[4],
        concede: row[5],
        diff: row[6],
        result: row[7],
        photoUrl: row[8]
      };
    });
  filtered.reverse();
  return filtered;
}
