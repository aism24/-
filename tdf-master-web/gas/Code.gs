/**
 * 「TDF製品情報抽出アプリ」のGAS JSON APIバックエンド。
 *
 * このスクリプトは、データストアとなる「TDF＿マスタ作成」スプレッドシートの
 * 「拡張機能→Apps Script」から作成するコンテナバインド型スクリプトとして使う前提です。
 * SpreadsheetApp.getActiveSpreadsheet()で自分自身のスプレッドシートを参照するため、
 * SPREADSHEET_IDの設定は不要です。
 *
 * このアプリ本体(index.html / app.js、GitHub Pagesで配信)は、.tdfバイナリの解析処理
 * そのものはPyodide(ブラウザ内Python実行)で完全にクライアントサイドで完結します。
 * GASが担うのは「記録シートへのログ追記」「重量表・工事番号一覧の読み書き」
 * 「利用ログ」という付随機能のみです。GAS側が不調でも、抽出・Excel出力といった
 * アプリ本来の機能は止まりません(app.js側で必ずcatchしています)。
 *
 * セットアップ手順:
 *   1. 「TDF＿マスタ作成」スプレッドシートを開き、「拡張機能→Apps Script」を開く。
 *   2. このファイルの内容をまるごとコピー&ペーストして保存。
 *   3. 右上の「デプロイ→新しいデプロイ」→種類「ウェブアプリ」を選択。
 *        次のユーザーとして実行: 「自分」
 *        アクセスできるユーザー: 「全員」(フロントエンドから匿名でアクセスするため必須)
 *   4. 発行された /exec で終わるURLを、app.js の GAS_API_URL に反映してpush。
 */

const SHEET_RECORD = "記録";
const SHEET_SETTING = "設定";
const SHEET_USAGE = "利用記録";

// ---------- API本体 ----------

// Excelダウンロード時の処理(クライアントから呼び出し)
// kojiNo      : 工事番号(画面で入力したもの)
// productCount: 製品数(データ行数)
// rows        : [ヘッダー行, ...データ行] の2次元配列
function onExcelDownload(kojiNo, productCount, rows) {
  const ss = SpreadsheetApp.getActiveSpreadsheet();

  // 記録シートに追記(A=タイムスタンプ, B=工事番号, C=工事名(式), D=製品数, E=シート名, F=図番頭)
  const recSheet = sheet_(SHEET_RECORD);
  const recRow = recSheet.getLastRow() + 1;
  const kojiFormula = `=IFERROR(INDEX('${SHEET_SETTING}'!E:E,MATCH(B${recRow},'${SHEET_SETTING}'!D:D,0)),"")`;
  recSheet.getRange(recRow, 1, 1, 4).setValues([[new Date(), kojiNo, kojiFormula, productCount]]);

  // データシートを最右端に追加(最大10件)
  const dataSheetName = addDataSheet_(ss, rows);
  if (dataSheetName) recSheet.getRange(recRow, 5).setValue(dataSheetName);

  // rows[0]はヘッダー行。rows[1]が先頭データ行、その「図番」列(index=2)から図番頭を取る
  const zubanHead = (rows && rows.length > 1 && rows[1][2])
    ? String(rows[1][2]).split('-')[0] : '';
  if (zubanHead) recSheet.getRange(recRow, 6).setValue(zubanHead);

  return { success: true };
}

// データシート追加(最大10件、超えたら古いシートから削除)。最右端(末尾)に挿入する。
function addDataSheet_(ss, rows) {
  const DATE_PAT = /^\d{8}_\d{6}$/;
  const dataSheets = ss.getSheets().filter(s => DATE_PAT.test(s.getName()));

  while (dataSheets.length >= 10) {
    ss.deleteSheet(dataSheets.shift());
  }

  const sheetName = Utilities.formatDate(new Date(), 'Asia/Tokyo', 'yyyyMMdd_HHmmss');
  const newSheet = ss.insertSheet(sheetName, ss.getSheets().length);

  if (rows && rows.length > 0) {
    newSheet.getRange(1, 1, rows.length, rows[0].length).setValues(rows);
    newSheet.getRange(1, 1, 1, rows[0].length)
      .setFontWeight('bold')
      .setBackground('#d9e1f2');
    newSheet.setFrozenRows(1);
  }
  return sheetName;
}

// 設定シートの重量表(A:B列)を返す(アプリ起動時に呼び出し)
// [[サイズ, 重量(kg/m)], ...]
function getWeightTable() {
  const sheet = sheet_(SHEET_SETTING);
  if (sheet.getLastRow() < 2) return [];
  return sheet.getRange(2, 1, sheet.getLastRow() - 1, 2).getValues()
    .filter(([size]) => size !== '');
}

// 設定シートの工事番号・工事名一覧(D:E列)を返す(画面の入力補助用)
// [[工事番号, 工事名], ...]
function getKojiList() {
  const sheet = sheet_(SHEET_SETTING);
  if (sheet.getLastRow() < 2) return [];
  return sheet.getRange(2, 4, sheet.getLastRow() - 1, 2).getValues()
    .filter(([no]) => no !== '');
}

// 利用記録: 起動時に呼び出し(開始日時・梁種別を記録)
// 戻り値: { row } (終了時に利用時間を書き込むために使用)
function logUsageStart(beamType) {
  const sheet = sheet_(SHEET_USAGE);
  const now = new Date();
  const nextRow = sheet.getLastRow() + 1;
  sheet.getRange(nextRow, 1, 1, 2).setValues([[now, beamType || '']]);
  return { row: nextRow };
}

// 利用記録: 終了時に呼び出し(利用時間を書き込む)
function logUsageEnd(row, startMs, endMs) {
  const sheet = sheet_(SHEET_USAGE);
  const minutes = Math.round((endMs - startMs) / 60000);
  const label = minutes < 1 ? '1分未満' : minutes + '分';
  sheet.getRange(row, 3).setValue(label);
  return {};
}

// 設定シートの重量表を初期化する手動ユーティリティ(必要であればApps Scriptエディタから
// 直接実行する。doGet/doPost経由のAPIとしては公開していない)。
// weightData: [[サイズ, 重量], ...]
function initWeightTable(weightData) {
  const sheet = sheet_(SHEET_SETTING);
  const lastRow = sheet.getLastRow();
  if (lastRow >= 2) {
    sheet.getRange(2, 1, lastRow - 1, 2).clearContent();
  }
  if (weightData && weightData.length > 0) {
    sheet.getRange(2, 1, weightData.length, 2).setValues(weightData);
  }
}

// ---------- JSON API共通 ----------

function jsonResponse_(payload) {
  return ContentService.createTextOutput(JSON.stringify(payload)).setMimeType(ContentService.MimeType.JSON);
}
function ok_(data) { return jsonResponse_({ status: "success", data: data }); }
function errRes_(message) { return jsonResponse_({ status: "error", message: message }); }

function doGet(e) {
  try {
    const p = e.parameter;
    if (p.action === "getWeightTable") return ok_(getWeightTable());
    if (p.action === "getKojiList") return ok_(getKojiList());
    return errRes_("不明なaction: " + p.action);
  } catch (err) {
    return errRes_(err.message);
  }
}

function doPost(e) {
  try {
    const body = JSON.parse(e.postData.contents);
    if (body.action === "onExcelDownload") return ok_(onExcelDownload(body.kojiNo, body.productCount, body.rows));
    if (body.action === "logUsageStart") return ok_(logUsageStart(body.beamType));
    if (body.action === "logUsageEnd") return ok_(logUsageEnd(body.row, body.startMs, body.endMs));
    return errRes_("不明なaction: " + body.action);
  } catch (err) {
    return errRes_(err.message);
  }
}

// ---------- 共通ヘルパー ----------

function sheet_(name) {
  const sh = SpreadsheetApp.getActiveSpreadsheet().getSheetByName(name);
  if (!sh) throw new Error("シートが見つかりません: " + name);
  return sh;
}

// スプレッドシートの初期セットアップ(一度だけ手動実行。Apps Scriptエディタの
// 関数選択でsetupSpreadsheetを選び、▶実行ボタンを押す)。
function setupSpreadsheet() {
  const ss = SpreadsheetApp.getActiveSpreadsheet();

  let recSheet = ss.getSheetByName(SHEET_RECORD);
  if (!recSheet) recSheet = ss.insertSheet(SHEET_RECORD);
  if (recSheet.getLastRow() === 0) {
    recSheet.getRange('A1:F1').setValues([['タイムスタンプ', '工事番号', '工事名', '製品数', 'シート名', '図番頭']]);
    recSheet.getRange('A1:F1').setFontWeight('bold').setBackground('#d9e1f2');
    recSheet.setFrozenRows(1);
  }

  let setSheet = ss.getSheetByName(SHEET_SETTING);
  if (!setSheet) setSheet = ss.insertSheet(SHEET_SETTING);
  if (setSheet.getLastRow() === 0) {
    setSheet.getRange('A1:E1').setValues([['サイズ', '重量(kg/m)', '', '工事番号', '工事名']]);
    setSheet.getRange('A1:E1').setFontWeight('bold').setBackground('#d9e1f2');
    setSheet.setFrozenRows(1);
  }

  let logSheet = ss.getSheetByName(SHEET_USAGE);
  if (!logSheet) logSheet = ss.insertSheet(SHEET_USAGE);
  if (logSheet.getLastRow() === 0) {
    logSheet.getRange('A1:C1').setValues([['使用開始日時', '梁種別', '利用時間']]);
    logSheet.getRange('A1:C1').setFontWeight('bold').setBackground('#d9e1f2');
    logSheet.setFrozenRows(1);
    logSheet.setColumnWidth(1, 160);
    logSheet.setColumnWidth(2, 120);
    logSheet.setColumnWidth(3, 100);
  }

  Logger.log('setupSpreadsheet 完了');
}

// 記録・設定シートの見出し行が想定通りか確認する(Apps Scriptエディタから手動で
// 実行する想定の関数。doGet/doPostからは呼ばない。ズレがあればログに出すだけで、
// 自動修正はしない)。
function checkSetup() {
  sheet_(SHEET_RECORD);
  sheet_(SHEET_SETTING);
  sheet_(SHEET_USAGE);
  Logger.log('記録・設定・利用記録の3シートが存在することを確認しました。');
}
