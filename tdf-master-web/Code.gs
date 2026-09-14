// ============================================================
// TDF製品情報抽出アプリ - GAS バックエンド
// ============================================================
//
// 【セットアップ手順】
// 1. このスクリプトは「TDF＿マスタ作成」スプレッドシートに紐付いた
//    コンテナバインド型で使用する
// 2. スクリプトエディタで「setupSpreadsheet」を一度実行してシートを初期化
//    (記録・設定・利用記録の3シート。既存の記録・設定シートはそのまま使う)
// 3. GASをウェブアプリとしてデプロイ（アクセス権：全員）
//
// 抽出ロジック本体(.tdfバイナリの解析)はすべてブラウザ側でPyodideを使い
// 実行される(Index.html内の<script type="text/python-src">)。
// このCode.gsはスプレッドシートへの記録・重量表/工事番号一覧の読み書き・
// 利用ログのみを担当する(DXF版アプリと同じ役割分担)。
// ============================================================

const SPREADSHEET_ID = SpreadsheetApp.getActiveSpreadsheet().getId();

// ------------------------------------------------------------
// ウェブアプリ エントリポイント
// ------------------------------------------------------------
function doGet() {
  return HtmlService.createHtmlOutputFromFile('Index')
    .setTitle('TDF製品情報抽出アプリ')
    .setSandboxMode(HtmlService.SandboxMode.IFRAME)
    .setXFrameOptionsMode(HtmlService.XFrameOptionsMode.ALLOWALL);
}

// ------------------------------------------------------------
// 利用記録：起動時に呼び出し（開始日時・梁種別を記録）
// 戻り値: 書き込んだ行番号（終了時に利用時間を書き込むために使用）
// ------------------------------------------------------------
function logUsageStart(beamType) {
  try {
    const ss    = SpreadsheetApp.openById(SPREADSHEET_ID);
    const sheet = ss.getSheetByName('利用記録');
    if (!sheet) return { success: false, error: '利用記録シートが見つかりません' };
    const now     = new Date();
    const nextRow = sheet.getLastRow() + 1;
    sheet.getRange(nextRow, 1, 1, 2).setValues([[now, beamType || '']]);
    return { success: true, row: nextRow };
  } catch (e) {
    return { success: false, error: e.message };
  }
}

// ------------------------------------------------------------
// 利用記録：終了時に呼び出し（利用時間を書き込む）
// ------------------------------------------------------------
function logUsageEnd(row, startMs, endMs) {
  try {
    const ss    = SpreadsheetApp.openById(SPREADSHEET_ID);
    const sheet = ss.getSheetByName('利用記録');
    if (!sheet) return;
    const minutes = Math.round((endMs - startMs) / 60000);
    const label   = minutes < 1 ? '1分未満' : minutes + '分';
    sheet.getRange(row, 3).setValue(label);
  } catch (e) {
    // 終了記録の失敗は無視
  }
}

// ------------------------------------------------------------
// Excelダウンロード時の処理（クライアントから呼び出し）
// kojiNo      : 工事番号（画面で入力したもの）
// productCount: 製品数（データ行数）
// rows        : [ヘッダー行, ...データ行] の2次元配列
// ------------------------------------------------------------
function onExcelDownload(kojiNo, productCount, rows) {
  try {
    const ss = SpreadsheetApp.openById(SPREADSHEET_ID);

    // 記録シートに追記（A=タイムスタンプ, B=工事番号, C=工事名(式), D=製品数, E=シート名, F=図番頭）
    const recSheet = ss.getSheetByName('記録');
    let recRow = null;
    if (recSheet) {
      recRow = recSheet.getLastRow() + 1;
      const kojiFormula = `=IFERROR(INDEX('設定'!E:E,MATCH(B${recRow},'設定'!D:D,0)),"")`;
      recSheet.getRange(recRow, 1, 1, 4).setValues([[new Date(), kojiNo, kojiFormula, productCount]]);
    }

    // データシートを最右端に追加（最大10件）
    const dataSheetName = _addDataSheet(ss, rows);

    // E列にデータシート名、F列に図番頭を記録
    if (recSheet && recRow) {
      if (dataSheetName) recSheet.getRange(recRow, 5).setValue(dataSheetName);
      // rows[0]はヘッダー行。rows[1]が先頭データ行、その「図番」列(index=2)から図番頭を取る
      const zubanHead = (rows && rows.length > 1 && rows[1][2])
        ? String(rows[1][2]).split('-')[0] : '';
      if (zubanHead) recSheet.getRange(recRow, 6).setValue(zubanHead);
    }

    return { success: true };
  } catch (e) {
    return { success: false, error: e.message };
  }
}

// ------------------------------------------------------------
// データシート追加（最大10件、超えたら古いシートから削除）
// 最右端（末尾）に挿入する
// ------------------------------------------------------------
function _addDataSheet(ss, rows) {
  const DATE_PAT = /^\d{8}_\d{6}$/;
  const dataSheets = ss.getSheets().filter(s => DATE_PAT.test(s.getName()));

  while (dataSheets.length >= 10) {
    ss.deleteSheet(dataSheets.shift());
  }

  const sheetName = Utilities.formatDate(new Date(), 'Asia/Tokyo', 'yyyyMMdd_HHmmss');
  const newSheet  = ss.insertSheet(sheetName, ss.getSheets().length);

  if (rows && rows.length > 0) {
    newSheet.getRange(1, 1, rows.length, rows[0].length).setValues(rows);
    newSheet.getRange(1, 1, 1, rows[0].length)
      .setFontWeight('bold')
      .setBackground('#d9e1f2');
    newSheet.setFrozenRows(1);
  }
  return sheetName;
}

// ------------------------------------------------------------
// 設定シートの重量表を初期化（必要であればボタン等から呼び出し）
// weightData: [[サイズ, 重量], ...]
// ------------------------------------------------------------
function initWeightTable(weightData) {
  try {
    const ss    = SpreadsheetApp.openById(SPREADSHEET_ID);
    const sheet = ss.getSheetByName('設定');
    if (!sheet) return { success: false, error: '設定シートが見つかりません' };

    const lastRow = sheet.getLastRow();
    if (lastRow >= 2) {
      sheet.getRange(2, 1, lastRow - 1, 2).clearContent();
    }
    if (weightData && weightData.length > 0) {
      sheet.getRange(2, 1, weightData.length, 2).setValues(weightData);
    }
    return { success: true };
  } catch (e) {
    return { success: false, error: e.message };
  }
}

// ------------------------------------------------------------
// 設定シートの重量表（A:B列）を返す（アプリ起動時に呼び出し）
// [[サイズ, 重量(kg/m)], ...]
// ------------------------------------------------------------
function getWeightTable() {
  const ss    = SpreadsheetApp.openById(SPREADSHEET_ID);
  const sheet = ss.getSheetByName('設定');
  if (!sheet || sheet.getLastRow() < 2) return [];
  return sheet.getRange(2, 1, sheet.getLastRow() - 1, 2).getValues()
    .filter(([size]) => size !== '');
}

// ------------------------------------------------------------
// 設定シートの工事番号・工事名一覧（D:E列）を返す（画面の入力補助用）
// [[工事番号, 工事名], ...]
// ------------------------------------------------------------
function getKojiList() {
  const ss    = SpreadsheetApp.openById(SPREADSHEET_ID);
  const sheet = ss.getSheetByName('設定');
  if (!sheet || sheet.getLastRow() < 2) return [];
  return sheet.getRange(2, 4, sheet.getLastRow() - 1, 2).getValues()
    .filter(([no]) => no !== '');
}

// ------------------------------------------------------------
// スプレッドシートの初期セットアップ（一度だけ手動実行）
// ------------------------------------------------------------
function setupSpreadsheet() {
  const ss = SpreadsheetApp.openById(SPREADSHEET_ID);

  // 記録シート（A〜F列）
  let recSheet = ss.getSheetByName('記録');
  if (!recSheet) recSheet = ss.insertSheet('記録');
  if (recSheet.getLastRow() === 0) {
    recSheet.getRange('A1:F1').setValues([['タイムスタンプ', '工事番号', '工事名', '製品数', 'シート名', '図番頭']]);
    recSheet.getRange('A1:F1').setFontWeight('bold').setBackground('#d9e1f2');
    recSheet.setFrozenRows(1);
  }

  // 設定シート
  let setSheet = ss.getSheetByName('設定');
  if (!setSheet) setSheet = ss.insertSheet('設定');
  if (setSheet.getLastRow() === 0) {
    setSheet.getRange('A1:E1').setValues([['サイズ', '重量(kg/m)', '', '工事番号', '工事名']]);
    setSheet.getRange('A1:E1').setFontWeight('bold').setBackground('#d9e1f2');
    setSheet.setFrozenRows(1);
  }

  // 利用記録シート
  let logSheet = ss.getSheetByName('利用記録');
  if (!logSheet) logSheet = ss.insertSheet('利用記録');
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
