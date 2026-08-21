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
    if (action === "ghibliStyle") return ok_(ghibliStyle(body));
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

/**
 * 背景写真シートのF/G列(Geminiモデル名・タイムゾーン・APIKEY)を読み込む。
 */
function getConfig_() {
  const ss = SpreadsheetApp.openById(SPREADSHEET_ID);
  const sheet = ss.getSheetByName(BG_SHEET_NAME);
  const config = { geminiModel: "gemini-3.5-flash-lite", timezone: "Asia/Tokyo", apiKey: "" };
  if (!sheet) return config;
  const lastRow = Math.max(sheet.getLastRow(), 1);
  const values = sheet.getRange(1, 6, lastRow, 2).getValues();
  values.forEach(function(row) {
    const label = String(row[0] || "").trim();
    const value = row[1];
    if (label === "Geminiモデル名" && value) config.geminiModel = String(value).trim();
    if (label === "タイムゾーン" && value) config.timezone = String(value).trim();
    if (label === "APIKEY" && value) config.apiKey = String(value).trim();
  });
  return config;
}

/**
 * 写真をジブリ風のアニメイラストに加工する。
 * 1. 元写真をDriveに保存して公開URLを作る
 * 2. Gemini(config.geminiModel)に写真を読ませ、ポーズ・服装・背景を保ったまま
 *    ジブリ風にするための英語の指示文を生成させる(テキストのみ・無料)
 * 3. Pollinations.ai の gptimageモデル(APIキー不要・無料)に指示文と元写真URLを渡し、
 *    元の構図・色を保ったアニメ画像を生成する
 */
function ghibliStyle(payload) {
  const config = getConfig_();
  if (!config.apiKey) throw new Error("背景写真シートにAPIKEYが設定されていません");

  const folder = DriveApp.getFolderById(DRIVE_FOLDER_ID);
  const decoded = Utilities.base64Decode(payload.base64);
  const mimeType = (payload.mimeType === "image/heic" || payload.mimeType === "image/heif")
    ? "image/jpeg" : payload.mimeType;
  const stamp = Utilities.formatDate(new Date(), config.timezone, "yyyyMMdd_HHmmss");

  const srcExt = mimeType === "image/png" ? "png" : "jpg";
  const srcBlob = Utilities.newBlob(decoded, mimeType, "ghibli_src_" + stamp + "." + srcExt);
  const srcFile = folder.createFile(srcBlob);
  srcFile.setSharing(DriveApp.Access.ANYONE_WITH_LINK, DriveApp.Permission.VIEW);
  const srcImageUrl = "https://drive.google.com/uc?export=view&id=" + srcFile.getId();

  const genderChoice = Math.random() < 0.5 ? "男性" : "女性";
  const describePrompt =
    "この画像を画像編集AI向けの英語の指示文にしてください。目的は、人物のポーズ・服の色や種類・髪型・" +
    "背景の要素(地形、天候、光の向きなど)をできる限りそのまま保ちながら、絵柄だけをスタジオジブリ風の" +
    "手描きアニメ塗りに変換することです。写真に写っている人物は、実際の性別に関わらず全員を" + genderChoice +
    "のキャラクターとして描くよう指示文に明記してください(写っている人数分、統一してこの性別で描く)。" +
    "写真から読み取れる具体的な色や物を必ず明記し、" +
    "「変えないでください/keep unchanged」という指示も含めてください。" +
    "出力は指示文の英語テキストのみ。前置きや説明は不要です。";
  const geminiUrl = "https://generativelanguage.googleapis.com/v1beta/models/" +
    config.geminiModel + ":generateContent?key=" + config.apiKey;
  const geminiResp = UrlFetchApp.fetch(geminiUrl, {
    method: "post",
    contentType: "application/json",
    payload: JSON.stringify({
      contents: [{
        parts: [
          { text: describePrompt },
          { inline_data: { mime_type: mimeType, data: payload.base64 } }
        ]
      }]
    }),
    muteHttpExceptions: true
  });
  if (geminiResp.getResponseCode() !== 200) {
    const errJson = JSON.parse(geminiResp.getContentText());
    throw new Error((errJson.error && errJson.error.message) || "Gemini APIエラー");
  }
  const geminiJson = JSON.parse(geminiResp.getContentText());
  const geminiParts = (((geminiJson.candidates || [])[0] || {}).content || {}).parts || [];
  const stylePrompt = geminiParts.map(function(p) { return p.text || ""; }).join("").trim();
  if (!stylePrompt) throw new Error("Geminiから説明文を取得できませんでした");

  let imgBlob = generateStyledImage_(stylePrompt, srcImageUrl);
  const looksGood = verifyMatchesSource_(config, mimeType, payload.base64, imgBlob);
  if (!looksGood) {
    // 元写真を無視した無関係な画像になっていた場合、1回だけ別のseedで再生成する
    const retryBlob = generateStyledImage_(stylePrompt, srcImageUrl);
    if (retryBlob) imgBlob = retryBlob;
  }

  const outMime = imgBlob.getContentType() || "image/jpeg";
  const outExt = outMime.indexOf("png") !== -1 ? "png" : "jpg";
  const outFile = folder.createFile(imgBlob.setName("ghibli_" + stamp + "." + outExt));
  outFile.setSharing(DriveApp.Access.ANYONE_WITH_LINK, DriveApp.Permission.VIEW);
  const outUrl = "https://drive.google.com/file/d/" + outFile.getId() + "/view";

  return {
    photoUrl: outUrl,
    base64: Utilities.base64Encode(imgBlob.getBytes()),
    mimeType: outMime,
    gender: genderChoice
  };
}

/**
 * Pollinations.ai(gptimageモデル)に指示文と元写真URLを渡して画像を生成する。
 * 呼ぶたびに乱数のseedを使うため、同じ入力でも結果は毎回変わる。
 */
function generateStyledImage_(stylePrompt, srcImageUrl) {
  const seed = Math.floor(Math.random() * 1000000);
  const pollinationsUrl = "https://image.pollinations.ai/prompt/" + encodeURIComponent(stylePrompt) +
    "?model=gptimage&image=" + encodeURIComponent(srcImageUrl) + "&nologo=true&seed=" + seed;
  const imgResp = UrlFetchApp.fetch(pollinationsUrl, { muteHttpExceptions: true });
  if (imgResp.getResponseCode() !== 200) {
    throw new Error("画像生成に失敗しました(HTTP " + imgResp.getResponseCode() + ")");
  }
  return imgResp.getBlob();
}

/**
 * Geminiに元写真と生成結果を両方見せて、生成結果が元写真の特徴(服装・髪型・背景など)を
 * ある程度反映しているかを判定させる。判定できない場合は「問題なし」とみなして無駄な
 * リトライをしないようにする。
 */
function verifyMatchesSource_(config, srcMimeType, srcBase64, resultBlob) {
  try {
    const verifyPrompt =
      "1枚目は元の写真、2枚目はそれをアニメ風に加工した画像です。2枚目は1枚目の人物の服装・髪型・" +
      "ポーズ・背景など何らかの特徴を反映していますか？元の写真と全く無関係な画像になっている場合のみ" +
      "「NO」、それ以外は「YES」と、YESかNOの1単語だけで答えてください。";
    const geminiUrl = "https://generativelanguage.googleapis.com/v1beta/models/" +
      config.geminiModel + ":generateContent?key=" + config.apiKey;
    const resp = UrlFetchApp.fetch(geminiUrl, {
      method: "post",
      contentType: "application/json",
      payload: JSON.stringify({
        contents: [{
          parts: [
            { text: verifyPrompt },
            { inline_data: { mime_type: srcMimeType, data: srcBase64 } },
            { inline_data: { mime_type: resultBlob.getContentType() || "image/jpeg", data: Utilities.base64Encode(resultBlob.getBytes()) } }
          ]
        }]
      }),
      muteHttpExceptions: true
    });
    if (resp.getResponseCode() !== 200) return true;
    const json = JSON.parse(resp.getContentText());
    const parts = (((json.candidates || [])[0] || {}).content || {}).parts || [];
    const answer = parts.map(function(p) { return p.text || ""; }).join("").trim().toUpperCase();
    return answer.indexOf("NO") !== 0;
  } catch (e) {
    return true;
  }
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
