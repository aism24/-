/**
 * 「鳥取運送アプリ」(運送業者の配車データ取込み・締め月チェック・年度集計)のGAS APIバックエンド。
 *
 * このスクリプトは、データストアとなるスプレッドシート(「鳥取運送アプリ」)の
 * 「拡張機能→Apps Script」から作成するコンテナバインド型スクリプトとして使う前提です。
 * SpreadsheetApp.getActiveSpreadsheet()で自分自身のスプレッドシートを参照するため、
 * SPREADSHEET_IDの設定は不要です。
 *
 * 初回セットアップ: このファイルを保存後、Apps Scriptエディタ上部の関数選択で
 * 「setupSheets」を選び、▶実行ボタンを押してください(1回だけでよい。シート・見出し・
 * 業者マスタの初期データを自動作成します。既にシートがある場合は何もしません)。
 * 続けて「createBackupTrigger」も1回実行してください(毎月1日、Google Driveへスプレッド
 * シートを丸ごとバックアップする月次トリガーを設定します)。
 *
 * 業務ルールの詳細は「鳥取運送アプリ_引き継ぎ書」を参照。要点:
 *   - 締め月は「21日始まり・20日締め」(前月21日〜当月20日)
 *   - 業者・締め月はアップロードされたExcelファイル名(「YYYYMMDD〆　<業者名>」)から判定する
 *   - 各行の降日が対象締め月からズレている場合は取り込まず、一覧+理由を返す(修正依頼フロー)
 *   - 確定(状態=確定済み)=担当者チェック完了=検収完了=支払完了とみなす
 *   - 未確定(確定待ち)のデータが1件でも残っている間は、新しい取込みができない
 *     (同じ業者+締め月への修正の再アップロードは可)
 *   - 「配車データ」シートは開くたびに自動で並び替わる(締め月→業者→物件名→降日の優先順、
 *     最新が上)。並び替え後、ID列は2行目から行番号に合わせて振り直される。onOpen()参照
 *   - 「締め状態」シートも開くたびに自動で並び替わる(締め月→業者の優先順、最新が上)。onOpen()参照
 *   - 確定済みの(業者+締め月)を丸ごとやり直したい場合は、フロントの隠しコマンド(ロゴ5回タップ)
 *     経由でdeleteConfirmedMonthを呼び、「配車データ」「締め状態」両シートの該当行を削除できる
 *   - 毎月1日、スプレッドシートを丸ごとコピーしてGoogle Driveの「保存用バックアップ」
 *     フォルダへ保存する(backupSpreadsheetToDrive。createBackupTriggerで設定した
 *     月次トリガーから呼ばれる)
 */

const SHEET_HAULING = "配車データ";
const SHEET_STATUS = "締め状態";
const SHEET_COMPANY = "業者マスタ";

const DEFAULT_COMPANIES = ["日本興運", "誠和梱包", "用瀬運送", "川崎クレーン", "鳥取グレーン", "山陰運送"];

const HAULING_HEADERS = [
  "ID", "業者", "締め月", "物件名", "積日", "降日", "ブロック", "節", "積荷", "現場待機",
  "車種", "最大長さ", "総重量", "通常単価", "エキストラ1", "エキストラ2",
  "費用区分", "費用額", "取込日時", "元ファイル名",
];
const STATUS_HEADERS = ["業者", "締め月", "状態", "取込日時", "確定日時"];
const COMPANY_HEADERS = ["業者名"];

// 重複判定(前月分混入チェック)で比較する項目。この並び順のまま比較する。
const DUPLICATE_CHECK_FIELDS = [
  "物件名", "積日", "降日", "ブロック", "節", "積荷", "現場待機", "車種", "最大長さ", "総重量", "通常単価",
];
const DUPLICATE_MATCH_THRESHOLD = 7; // 11項目中7項目以上一致で「同一」と判断する

// 日付・日時のような文字列("2026/08/20"等)は、Sheetsに書き込むとセルが自動的に
// 日付型に変換されてしまう(setValueの既知の挙動)。この変換が起きると文字列としての
// 完全一致比較(締め月フィルタ・重複判定)が壊れるため、該当列は明示的にテキスト書式(@)を
// 適用して自動変換を防ぐ。
const DATE_LIKE_HAULING_COLS = ["締め月", "積日", "降日", "取込日時"];
const DATE_LIKE_STATUS_COLS = ["締め月", "取込日時", "確定日時"];

// ---------- 初回セットアップ(Apps Scriptエディタから手動で1回だけ実行) ----------

function setupSheets() {
  const ss = ss_();
  const haulingSheet = ensureSheet_(ss, SHEET_HAULING, HAULING_HEADERS);
  const statusSheet = ensureSheet_(ss, SHEET_STATUS, STATUS_HEADERS);
  const companySheet = ensureSheet_(ss, SHEET_COMPANY, COMPANY_HEADERS);
  if (companySheet.getLastRow() < 2) {
    companySheet.getRange(2, 1, DEFAULT_COMPANIES.length, 1)
      .setValues(DEFAULT_COMPANIES.map(name => [name]));
  }
  // 既存シートに対しても毎回再適用する(何度実行しても安全)
  forceTextColumns_(haulingSheet, DATE_LIKE_HAULING_COLS);
  forceTextColumns_(statusSheet, DATE_LIKE_STATUS_COLS);
  Logger.log("セットアップ完了");
}

// 動作確認中に日付型として誤って保存されてしまったテスト・過去データを全て削除し、
// 配車データ・締め状態を空の状態に戻す(見出し行は残す)。Apps Scriptエディタから
// 手動で1回だけ実行する想定の関数(doGet/doPostからは呼ばない)。
function resetAllData() {
  [SHEET_HAULING, SHEET_STATUS].forEach(name => {
    const sh = sheet_(name);
    const lastRow = sh.getLastRow();
    if (lastRow > 1) sh.deleteRows(2, lastRow - 1);
  });
  Logger.log("配車データ・締め状態をリセットしました");
}

// スプレッドシートを開くたびにGoogle Sheetsが自動的に呼び出す特殊関数(手動実行は不要)。
// 「配車データ」「締め状態」の両シートを、それぞれ最新の内容が一番上に来るよう自動的に並び替える。
function onOpen() {
  try {
    sortHaulingData();
    sortStatusData();
  } catch (e) {
    // 開いた瞬間にエラーダイアログを出さないよう、失敗してもログに残すだけにする
    Logger.log("onOpenでの自動並び替えに失敗しました: " + e.message);
  }
}

// 「配車データ」「締め状態」シートの並び替えで共通して使う業者の優先順(日本興運→誠和梱包→
// 用瀬運送→鳥取グレーン→川崎クレーン→山陰運送)。
const SORT_COMPANY_ORDER = ["日本興運", "誠和梱包", "用瀬運送", "鳥取グレーン", "川崎クレーン", "山陰運送"];

// 「配車データ」シートを、締め月(新しい順)→業者(下記の指定順)→物件名(降順)→降日(新しい順)の
// 優先順で並び替える。onOpen()から自動的に呼ばれるほか、Apps Scriptエディタから手動実行も
// できる(過去データを一度に並び替え直したい場合等)。
// ヘッダー行(1行目)は対象外。各行は20列すべてをひとかたまりのまま入れ替えるだけなので、
// 値が消えたり列がズレたりすることはない(費用区分・締め状態への影響も無い)。
// 並び替え後、ID列は2行目から順に2,3,4...と行番号に合わせて振り直す(ID=行番号になるため、
// IDから該当行をすぐに特定できる)。IDは「重複しなければ何でもよい」値であり、新規取込み時の
// 採番も既存データの最大値+1で行っているため、この振り直しによる不整合は起きない。
// 【本更新で追記】並び替え・振り直しの結果が読み込んだ内容と完全に同じ場合は書き込みを
// スキップする。スプレッドシートを開くたびにonOpen()経由で呼ばれるため、既に並び替え済みの
// 状態で開き直しただけの場合(実務上最も多いケース)まで毎回全行を書き戻すと、読み込みだけで
// 済むはずの操作が不必要に重くなるため。

function sortHaulingData() {
  withLock_(() => {
    const sh = sheet_(SHEET_HAULING);
    const map = headerMap_(sh);
    const lastRow = sh.getLastRow();
    if (lastRow < 3) return; // データ行が0〜1行なら並び替え不要

    const numCols = HAULING_HEADERS.length;
    const range = sh.getRange(2, 1, lastRow - 1, numCols);
    const original = range.getValues();
    const values = original.map(row => row.slice()); // 書き込み要否の比較用に元の内容を残す

    const idIdx = map["ID"] - 1;
    const closingIdx = map["締め月"] - 1;
    const companyIdx = map["業者"] - 1;
    const arrivalIdx = map["降日"] - 1;
    const projectIdx = map["物件名"] - 1;
    const companyRank = {};
    SORT_COMPANY_ORDER.forEach((name, i) => { companyRank[name] = i; });

    values.sort((a, b) => {
      const closingCmp = cellToYmd_(b[closingIdx]).localeCompare(cellToYmd_(a[closingIdx]));
      if (closingCmp !== 0) return closingCmp;
      const rankA = companyRank[a[companyIdx]] !== undefined ? companyRank[a[companyIdx]] : 999;
      const rankB = companyRank[b[companyIdx]] !== undefined ? companyRank[b[companyIdx]] : 999;
      if (rankA !== rankB) return rankA - rankB;
      const projectCmp = String(b[projectIdx] || "").localeCompare(String(a[projectIdx] || ""), "ja");
      if (projectCmp !== 0) return projectCmp;
      return cellToYmd_(b[arrivalIdx]).localeCompare(cellToYmd_(a[arrivalIdx]));
    });

    // ID列を2行目から順に振り直す(ID=行番号にする)
    values.forEach((row, i) => { row[idIdx] = i + 2; });

    const changed = values.some((row, i) => row.some((cell, j) => cell !== original[i][j]));
    if (changed) range.setValues(values);
  });
}

// 「締め状態」シートを、締め月(新しい順)→業者(SORT_COMPANY_ORDERの指定順)の優先順で
// 並び替える。onOpen()から自動的に呼ばれるほか、Apps Scriptエディタから手動実行もできる。
// ヘッダー行(1行目)は対象外。各行は5列すべてをひとかたまりのまま入れ替えるだけなので、
// 値が消えたり列がズレたりすることはない。ID列は無いため振り直しは行わない。
// sortHaulingData同様、並び替えの結果が読み込んだ内容と完全に同じ場合は書き込みをスキップする。
function sortStatusData() {
  withLock_(() => {
    const sh = sheet_(SHEET_STATUS);
    const map = headerMap_(sh);
    const lastRow = sh.getLastRow();
    if (lastRow < 3) return; // データ行が0〜1行なら並び替え不要

    const numCols = STATUS_HEADERS.length;
    const range = sh.getRange(2, 1, lastRow - 1, numCols);
    const original = range.getValues();
    const values = original.map(row => row.slice());

    const closingIdx = map["締め月"] - 1;
    const companyIdx = map["業者"] - 1;
    const companyRank = {};
    SORT_COMPANY_ORDER.forEach((name, i) => { companyRank[name] = i; });

    values.sort((a, b) => {
      const closingCmp = cellToYmd_(b[closingIdx]).localeCompare(cellToYmd_(a[closingIdx]));
      if (closingCmp !== 0) return closingCmp;
      const rankA = companyRank[a[companyIdx]] !== undefined ? companyRank[a[companyIdx]] : 999;
      const rankB = companyRank[b[companyIdx]] !== undefined ? companyRank[b[companyIdx]] : 999;
      return rankA - rankB;
    });

    const changed = values.some((row, i) => row.some((cell, j) => cell !== original[i][j]));
    if (changed) range.setValues(values);
  });
}

// 配車データの「費用区分」列(Q列)を、「ブロック」列(G列)から現在のclassifyFeeType_で
// 再計算して上書きする。分類ロジックやブロック列の表記ルールを変更した際、既存データに
// 反映するためApps Scriptエディタから手動で1回実行する想定の関数(doGet/doPostからは呼ばない)。
// (末尾に"_"を付けると実行ドロップダウンに出なくなるため、あえて付けていない)
function recalculateFeeTypes() {
  const sh = sheet_(SHEET_HAULING);
  const map = headerMap_(sh);
  const lastRow = sh.getLastRow();
  if (lastRow < 2) return;
  const numRows = lastRow - 1;
  const blocks = sh.getRange(2, map["ブロック"], numRows, 1).getValues();
  const feeTypes = blocks.map(row => [classifyFeeType_(row[0])]);
  sh.getRange(2, map["費用区分"], numRows, 1).setValues(feeTypes);
  Logger.log("費用区分を" + numRows + "行分、再計算しました。");
}

// ---------- 月次バックアップ(毎月1日、Google Driveへスプレッドシートを丸ごとコピー保存) ----------

// バックアップの保存先フォルダ(Google Drive「保存用バックアップ」フォルダ)
const BACKUP_FOLDER_ID = "1-tqGWDV7wg4mQc8PmeNgF3mLvFKKQROc";

// スプレッドシート「鳥取運送アプリ」を丸ごとコピーし、Google Driveの指定フォルダへ
// 「鳥取スプレッドシートYYYY.MM.DD保存」という名前で保存する。createBackupTriggerで設定した
// 毎月1日のトリガーから自動的に呼ばれるほか、Apps Scriptエディタから手動実行してその場で
// バックアップを取ることもできる。
function backupSpreadsheetToDrive() {
  const folder = DriveApp.getFolderById(BACKUP_FOLDER_ID);
  const dateStr = Utilities.formatDate(new Date(), "Asia/Tokyo", "yyyy.MM.dd");
  const fileName = "鳥取スプレッドシート" + dateStr + "保存";
  const copy = DriveApp.getFileById(ss_().getId()).makeCopy(fileName, folder);
  Logger.log("バックアップを作成しました: " + fileName + " (" + copy.getId() + ")");
  return { fileName: fileName, fileId: copy.getId() };
}

// 初回のみApps Scriptエディタから手動で1回実行する。backupSpreadsheetToDriveを毎月1日
// 朝6時(Asia/Tokyo。appsscript.jsonのタイムゾーン設定に従う)に呼ぶトリガーを設定する。
// 毎月1日はどの月にも必ず存在するため、2月等の特別扱いは不要。
// 何度実行しても、既存の同名トリガーを削除してから作り直すので安全。
function createBackupTrigger() {
  ScriptApp.getProjectTriggers().forEach(t => {
    if (t.getHandlerFunction() === "backupSpreadsheetToDrive") ScriptApp.deleteTrigger(t);
  });
  ScriptApp.newTrigger("backupSpreadsheetToDrive").timeBased().onMonthDay(1).atHour(6).create();
  Logger.log("毎月1日6時のバックアップトリガーを作成しました");
}

function ensureSheet_(ss, name, headers) {
  let sh = ss.getSheetByName(name);
  if (sh) return sh;
  sh = ss.insertSheet(name);
  sh.getRange(1, 1, 1, headers.length).setValues([headers]);
  sh.setFrozenRows(1);
  sh.getRange(1, 1, 1, headers.length).setFontWeight("bold");
  return sh;
}

// 指定した列名(見出し名)の全データ行に、プレーンテキスト書式(@)を適用する
function forceTextColumns_(sheet, colNames) {
  const map = headerMap_(sheet);
  const numRows = Math.max(sheet.getMaxRows() - 1, 1);
  colNames.forEach(name => {
    const col = map[name];
    if (!col) return;
    sheet.getRange(2, col, numRows, 1).setNumberFormat("@");
  });
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
    if (p.action === "listCompanies") return ok_(listCompanies());
    if (p.action === "getClosingCheck") return ok_(getClosingCheck(p.company, p.closingMonth));
    if (p.action === "getClosingCheckAll") return ok_(getClosingCheckAll(p.closingMonth));
    if (p.action === "getCheckScreenInit") return ok_(getCheckScreenInit(p.company, p.closingMonth));
    if (p.action === "getYearlySummary") return ok_(getYearlySummary(p.fiscalYearEnd ? Number(p.fiscalYearEnd) : null));
    if (p.action === "getYearlySummaryInit") return ok_(getYearlySummaryInit(p.fiscalYearEnd ? Number(p.fiscalYearEnd) : null));
    if (p.action === "listProjects") return ok_(listProjects());
    if (p.action === "getProjectDetail") return ok_(getProjectDetail(p.projectName));
    return errRes_("不明なaction: " + p.action);
  } catch (err) {
    return errRes_(err.message);
  }
}

function doPost(e) {
  try {
    const body = JSON.parse(e.postData.contents);
    if (body.action === "importHaulingFile") return ok_(importHaulingFile(body));
    if (body.action === "confirmClosing") return ok_(confirmClosing(body.company, body.closingMonth));
    if (body.action === "bulkImportLegacy") return ok_(bulkImportLegacy(body));
    if (body.action === "deleteConfirmedMonth") return ok_(deleteConfirmedMonth(body.companies, body.closingMonth));
    return errRes_("不明なaction: " + body.action);
  } catch (err) {
    return errRes_(err.message);
  }
}

// ---------- 共通ヘルパー ----------

function ss_() { return SpreadsheetApp.getActiveSpreadsheet(); }

function sheet_(name) {
  const sh = ss_().getSheetByName(name);
  if (!sh) throw new Error("シートが見つかりません。setupSheetsを実行してください: " + name);
  return sh;
}

function headerMap_(sheet) {
  const lastCol = sheet.getLastColumn();
  if (lastCol < 1) return {};
  const headers = sheet.getRange(1, 1, 1, lastCol).getValues()[0];
  const map = {};
  headers.forEach((h, i) => {
    const name = String(h || "").trim();
    if (name) map[name] = i + 1;
  });
  return map;
}

function withLock_(fn) {
  const lock = LockService.getScriptLock();
  lock.waitLock(30000);
  try { return fn(); } finally { lock.releaseLock(); }
}

function nowStr_() {
  return Utilities.formatDate(new Date(), "Asia/Tokyo", "yyyy/MM/dd HH:mm:ss");
}

function pad2_(n) { return (n < 10 ? "0" : "") + n; }

function ymd_(y, m, d) { return y + "/" + pad2_(m) + "/" + pad2_(d); }

// "YYYY-MM-DD" または "YYYY/MM/DD" 形式の日付文字列を { y, m, d } に分解する
function splitDateStr_(s) {
  const parts = String(s || "").trim().split(/[-\/]/).map(Number);
  if (parts.length !== 3 || parts.some(isNaN)) throw new Error("日付の形式が不正です: " + s);
  return { y: parts[0], m: parts[1], d: parts[2] };
}

function normalizeDateStr_(s) {
  if (!s) return "";
  const { y, m, d } = splitDateStr_(s);
  return ymd_(y, m, d);
}

// スプレッドシートのセルから読み取った値を "yyyy/MM/dd" 文字列に正規化する。
// setValues()に日付らしい文字列を渡すとセルが自動的に日付型に変換されてしまうことがあるため、
// 実際に読み取った値がDateオブジェクトであっても正しく比較できるようにする(forceTextColumns_で
// 今後の自動変換自体は防止しているが、既存データや想定外の入力に対する保険として残す)。
function cellToYmd_(v) {
  if (v instanceof Date && !isNaN(v)) return Utilities.formatDate(v, "Asia/Tokyo", "yyyy/MM/dd");
  if (!v) return "";
  try { return normalizeDateStr_(v); } catch (e) { return String(v).trim(); }
}

// 「21日始まり・20日締め」ルール: 降日から、その配送が属する締め月(その月20日、または
// 21日以降なら翌月20日)を求める
function closingMonthFromDateStr_(dateStr) {
  const { y, m, d } = splitDateStr_(dateStr);
  if (d <= 20) return ymd_(y, m, 20);
  let y2 = y, m2 = m + 1;
  if (m2 > 12) { m2 = 1; y2 += 1; }
  return ymd_(y2, m2, 20);
}

function shiftClosingMonth_(closingStr, deltaMonths) {
  const { y, m } = splitDateStr_(closingStr);
  let total = (y * 12 + (m - 1)) + deltaMonths;
  const y2 = Math.floor(total / 12);
  const m2 = (total % 12) + 1;
  return ymd_(y2, m2, 20);
}

// ファイル名(例: "20260820〆　山陰運送.xlsm")から締め日・業者を判定する
function parseFileName_(fileName) {
  const name = String(fileName || "");
  const dateMatch = name.match(/(\d{4})(\d{2})(\d{2})/);
  if (!dateMatch) throw new Error("ファイル名から締め日(YYYYMMDD)を読み取れません: " + fileName);
  const closingMonth = ymd_(Number(dateMatch[1]), Number(dateMatch[2]), Number(dateMatch[3]));

  const companies = listCompanies();
  const normalize = s => String(s || "").replace(/﨑/g, "崎");
  const normalizedName = normalize(name);
  const company = companies.find(c => normalizedName.indexOf(normalize(c)) !== -1);
  if (!company) throw new Error("ファイル名から業者名を判定できません(業者マスタに無い名称です): " + fileName);

  return { company: company, closingMonth: closingMonth };
}

function listCompanies() {
  const sh = sheet_(SHEET_COMPANY);
  const lastRow = sh.getLastRow();
  if (lastRow < 2) return [];
  return sh.getRange(2, 1, lastRow - 1, 1).getValues().map(r => String(r[0] || "").trim()).filter(v => v);
}

// ---------- 締め状態 ----------

function statusRows_() {
  const sh = sheet_(SHEET_STATUS);
  const map = headerMap_(sh);
  const lastRow = sh.getLastRow();
  if (lastRow < 2) return [];
  const values = sh.getRange(2, 1, lastRow - 1, STATUS_HEADERS.length).getValues();
  return values.map((row, i) => ({
    sheetRow: i + 2,
    業者: row[map["業者"] - 1],
    締め月: cellToYmd_(row[map["締め月"] - 1]),
    状態: row[map["状態"] - 1],
    取込日時: row[map["取込日時"] - 1],
    確定日時: row[map["確定日時"] - 1],
  }));
}

function findStatusRow_(company, closingMonth) {
  const rows = statusRows_();
  return rows.find(r => r.業者 === company && r.締め月 === closingMonth) || null;
}

function upsertStatus_(company, closingMonth, status, extra) {
  const sh = sheet_(SHEET_STATUS);
  const map = headerMap_(sh);
  const existing = findStatusRow_(company, closingMonth);
  const now = nowStr_();
  if (existing) {
    sh.getRange(existing.sheetRow, map["状態"]).setValue(status);
    if (extra && extra.取込日時) sh.getRange(existing.sheetRow, map["取込日時"]).setValue(now);
    if (extra && extra.確定日時) sh.getRange(existing.sheetRow, map["確定日時"]).setValue(now);
    return;
  }
  const row = new Array(STATUS_HEADERS.length).fill("");
  row[map["業者"] - 1] = company;
  row[map["締め月"] - 1] = closingMonth;
  row[map["状態"] - 1] = status;
  if (extra && extra.取込日時) row[map["取込日時"] - 1] = now;
  if (extra && extra.確定日時) row[map["確定日時"] - 1] = now;
  sh.appendRow(row);
}

function confirmClosing(company, closingMonth) {
  if (!company || !closingMonth) throw new Error("業者・締め月を指定してください");
  return withLock_(() => {
    const existing = findStatusRow_(company, closingMonth);
    if (!existing) throw new Error("取り込み済みのデータがありません: " + company + " " + closingMonth);
    if (existing.状態 === "確定済み") return { ok: true, alreadyConfirmed: true };
    upsertStatus_(company, closingMonth, "確定済み", { 確定日時: true });
    return { ok: true };
  });
}

// 「一意の月を全てやり直したい」場合の管理者向け復旧手段。指定した(業者+締め月)のうち
// 実際に「確定済み」であるものだけを対象に、「配車データ」「締め状態」両シートの該当行を
// 完全に削除する(取り消し不可)。フロント側は確定済みの業者しかボタンとして出さないが、
// 念のためGAS側でも確定済みでない組み合わせは無視して対象から除外する。
function deleteConfirmedMonth(companies, closingMonth) {
  if (!Array.isArray(companies) || companies.length === 0) throw new Error("業者を指定してください");
  if (!closingMonth) throw new Error("締め月を指定してください");
  const normalizedClosing = normalizeDateStr_(closingMonth);

  return withLock_(() => {
    const targets = companies.filter(company => {
      const status = findStatusRow_(company, normalizedClosing);
      return status && status.状態 === "確定済み";
    });
    if (targets.length === 0) throw new Error("指定した業者・締め月に確定済みデータがありません: " + normalizedClosing + "〆");

    // 配車データ: 対象行を除いた行だけをまとめて書き戻す(■24の効率化方針と同じ、
    // deleteRow()を1行ずつ呼ぶより高速)
    const haulingSh = sheet_(SHEET_HAULING);
    const haulingMap = headerMap_(haulingSh);
    const haulingLastRow = haulingSh.getLastRow();
    const haulingCols = HAULING_HEADERS.length;
    const haulingValues = haulingLastRow >= 2 ? haulingSh.getRange(2, 1, haulingLastRow - 1, haulingCols).getValues() : [];
    const hCompanyCol = haulingMap["業者"] - 1;
    const hClosingCol = haulingMap["締め月"] - 1;
    const keptHauling = haulingValues.filter(row =>
      !(targets.indexOf(row[hCompanyCol]) !== -1 && cellToYmd_(row[hClosingCol]) === normalizedClosing)
    );
    if (keptHauling.length > 0) haulingSh.getRange(2, 1, keptHauling.length, haulingCols).setValues(keptHauling);
    if (keptHauling.length < haulingValues.length) {
      haulingSh.getRange(keptHauling.length + 2, 1, haulingValues.length - keptHauling.length, haulingCols).clearContent();
    }

    // 締め状態: 対象行を除いた行だけをまとめて書き戻す
    const statusSh = sheet_(SHEET_STATUS);
    const statusMap = headerMap_(statusSh);
    const statusLastRow = statusSh.getLastRow();
    const statusCols = STATUS_HEADERS.length;
    const statusValues = statusLastRow >= 2 ? statusSh.getRange(2, 1, statusLastRow - 1, statusCols).getValues() : [];
    const sCompanyCol = statusMap["業者"] - 1;
    const sClosingCol = statusMap["締め月"] - 1;
    const keptStatus = statusValues.filter(row =>
      !(targets.indexOf(row[sCompanyCol]) !== -1 && cellToYmd_(row[sClosingCol]) === normalizedClosing)
    );
    if (keptStatus.length > 0) statusSh.getRange(2, 1, keptStatus.length, statusCols).setValues(keptStatus);
    if (keptStatus.length < statusValues.length) {
      statusSh.getRange(keptStatus.length + 2, 1, statusValues.length - keptStatus.length, statusCols).clearContent();
    }

    return {
      deletedCompanies: targets,
      closingMonth: normalizedClosing,
      deletedHaulingRows: haulingValues.length - keptHauling.length,
    };
  });
}

// ---------- 配車データ ----------

// 【高速化】列名→列インデックスの対応(colIdx)を1回だけ計算しておき、行ごとに
// map["列名"]をオブジェクトハッシュで引き直すのをやめ、配列インデックスでの参照に置き換えた。
// forEach+クロージャ生成もfor文に置き換え、全行(3800行超)×全列(20列)ぶんの
// プロパティ組み立てコストを軽減する。フィルタ・整形結果(sheetRow・締め月等の正規化)は
// 変更前と完全に同じになるようにしている。
function haulingRows_() {
  const sh = sheet_(SHEET_HAULING);
  const map = headerMap_(sh);
  const lastRow = sh.getLastRow();
  if (lastRow < 2) return [];
  const values = sh.getRange(2, 1, lastRow - 1, HAULING_HEADERS.length).getValues();
  const colIdx = HAULING_HEADERS.map(h => map[h] - 1);
  const idCol = colIdx[0]; // HAULING_HEADERS[0] === "ID"

  const result = [];
  for (let i = 0; i < values.length; i++) {
    const row = values[i];
    const idVal = row[idCol];
    if (idVal === "" || idVal === null) continue;
    const obj = { sheetRow: result.length + 2 };
    for (let j = 0; j < HAULING_HEADERS.length; j++) {
      obj[HAULING_HEADERS[j]] = row[colIdx[j]];
    }
    obj["締め月"] = cellToYmd_(obj["締め月"]);
    obj["積日"] = cellToYmd_(obj["積日"]);
    obj["降日"] = cellToYmd_(obj["降日"]);
    result.push(obj);
  }
  return result;
}

function nextHaulingId_(sh, idCol) {
  const lastRow = sh.getLastRow();
  if (lastRow < 2) return 1;
  const ids = sh.getRange(2, idCol, lastRow - 1, 1).getValues().map(r => Number(r[0]) || 0);
  return Math.max(0, ...ids) + 1;
}

// ブロック(積地)の文字列から費用区分を自動判定する。実データの表記は「横持ち1」のように
// 「ち」が入るため、番号ごとに完全一致するパターンでのみ判定する:
// 横持ち1=コラム横持、横持ち3=製品等横持、横持ち2・横持ち4=その他横持
// メッキ・横持ちのいずれにも一致しない場合は現場搬入費用として扱う
function classifyFeeType_(block) {
  const b = String(block || "");
  if (b.indexOf("メッキ") !== -1) return "メッキ";
  if (b.indexOf("横持ち1") !== -1) return "コラム横持";
  if (b.indexOf("横持ち3") !== -1) return "製品等横持";
  if (b.indexOf("横持ち2") !== -1 || b.indexOf("横持ち4") !== -1) return "その他横持";
  return "現場搬入費用";
}

function toNum_(v) { return Number(v) || 0; }

// 値が空欄、または数値として0であるかを判定する(数値でない文字列は0とみなさない)
function isBlankOrZero_(v) {
  const s = String(v == null ? "" : v).trim();
  if (s === "") return true;
  const n = Number(s);
  return !isNaN(n) && n === 0;
}

// 重複判定用に1項目分の値を比較可能な文字列に正規化する
function normalizeForCompare_(field, value) {
  if (field === "積日" || field === "降日") return cellToYmd_(value);
  if (field === "総重量" || field === "通常単価") return String(Math.round(toNum_(value) * 100) / 100);
  return String(value == null ? "" : value).trim();
}

// candidateRow(取込み中の行)とexistingRows(前月の確定済みデータ)を比較し、
// DUPLICATE_CHECK_FIELDSのうちDUPLICATE_MATCH_THRESHOLD項目以上一致する行があれば「同一」と判断する
function findDuplicateRow_(candidateRow, existingRows) {
  for (let i = 0; i < existingRows.length; i++) {
    const ex = existingRows[i];
    let matchCount = 0;
    DUPLICATE_CHECK_FIELDS.forEach(field => {
      if (normalizeForCompare_(field, candidateRow[field]) === normalizeForCompare_(field, ex[field])) matchCount += 1;
    });
    if (matchCount >= DUPLICATE_MATCH_THRESHOLD) return ex;
  }
  return null;
}

// 取込み中の行群(newRows)が、既に取り込まれている行群(existingRows)と完全に同一内容かどうかを判定する。
// 行数が異なる、またはDUPLICATE_CHECK_FIELDS(11項目)のいずれか1つでも不一致な行があれば「別内容」と判断する。
// 同じファイルの誤った再アップロード検知用のため、行の並び順まで一致することを前提とする。
function isExactSameBatch_(newRows, existingRows) {
  if (newRows.length === 0 || newRows.length !== existingRows.length) return false;
  for (let i = 0; i < newRows.length; i++) {
    const matches = DUPLICATE_CHECK_FIELDS.every(field =>
      normalizeForCompare_(field, newRows[i][field]) === normalizeForCompare_(field, existingRows[i][field])
    );
    if (!matches) return false;
  }
  return true;
}

/**
 * 業者から受け取ったExcel(配車シート)の取込み。
 * payload: {
 *   fileName: "20260820〆　山陰運送.xlsm",
 *   rows: [{ 物件名, 積日:"YYYY-MM-DD", 降日:"YYYY-MM-DD", ブロック, 節, 積荷, 現場待機,
 *            車種, 最大長さ, 総重量, 通常単価, エキストラ1, エキストラ2 }, ...],
 *   force: true (省略可) — 重複確認ポップアップでユーザーが「OK」を選んだ際、
 *          クライアントがこのフラグを付けて再送することで、重複チェックをスキップして保存する。
 * }
 * 対象外行(前月分・来月分の混入)が1件でもあれば、今回のインポート全体を保存せず、
 * 一覧+理由を返す(担当者が業者に確認し、正しいファイルを再アップロードする運用)。
 */
function importHaulingFile(payload) {
  const fileName = payload.fileName;
  const rowsIn = payload.rows || [];
  const parsed = parseFileName_(fileName);
  const company = parsed.company;
  const targetClosing = parsed.closingMonth;

  const existingStatus = findStatusRow_(company, targetClosing);
  if (existingStatus && existingStatus.状態 === "確定済み") {
    throw new Error("このファイルは既に取り込み済みです(確定済み): " + company + " " + targetClosing + "〆");
  }

  // 未確定(確定作業待ち)のデータが1件でも残っている間は、新しい取込みを一切受け付けない。
  // ・確定を忘れたまま次の業者/次月のファイルを取り込んでしまう事故を防ぐ
  // ・前月分の重複判定(findDuplicateRow_)が常に「確定済み」データのみを参照する状態を保証する
  //   (未確定データが前月分として残っていると、後で修正されるかもしれないデータを基準に
  //   「削除依頼」「降日修正依頼」を判定してしまうため)
  // ただし、今回と同じ(業者+締め月)の再アップロード(内容の修正)はここでは妨げない。
  const pendingOther = statusRows_().find(r =>
    r.状態 === "未確定" && !(r.業者 === company && r.締め月 === targetClosing)
  );
  if (pendingOther) {
    throw new Error(
      "先に " + pendingOther.業者 + " " + pendingOther.締め月 + "〆 を確定してください(20日締めチェック画面)。" +
      "未確定のデータが残っている間は、新しい取込みができません。"
    );
  }

  // 配車データの読み込みは1回にまとめ、前月分の重複チェックと今回分の完全一致チェックの
  // 両方でこの結果を使い回す(以前はそれぞれが個別にhaulingRows_()を呼び、全行読み込みを
  // 重複して行っていたため)。
  const prevClosing = shiftClosingMonth_(targetClosing, -1);
  const allHaulingRows = haulingRows_();
  const confirmedPrevRows = allHaulingRows.filter(r => r.業者 === company && r.締め月 === prevClosing);

  const okRows = [];
  const excludedRows = [];

  rowsIn.forEach((row, idx) => {
    const 物件名 = String(row["物件名"] || "").trim();
    const 降日 = row["降日"];
    if (!物件名 && !降日) return; // 空行はスキップ

    let rowClosing;
    try {
      rowClosing = closingMonthFromDateStr_(降日);
    } catch (e) {
      excludedRows.push({ row: row, reason: "date_invalid", detail: "降日の形式が不正です: " + 降日, rowIndex: idx });
      return;
    }

    if (rowClosing === targetClosing) {
      if (classifyFeeType_(row["ブロック"]) === "現場搬入費用" && isBlankOrZero_(row["最大長さ"]) && isBlankOrZero_(row["総重量"])) {
        excludedRows.push({
          row: row, reason: "yard_zero_error", rowIndex: idx,
          detail: "現場搬入費用に分類されていますが、最大長さ・総重量が両方ゼロです。値を確認のうえ業者に確認してください。",
        });
        return;
      }
      okRows.push(row);
      return;
    }

    if (rowClosing === prevClosing) {
      const dup = findDuplicateRow_(row, confirmedPrevRows);
      if (dup) {
        excludedRows.push({
          row: row, reason: "delete_request", rowIndex: idx,
          detail: "前月(" + prevClosing + "〆)に同一内容が確定済みのため、業者にこの行の削除を依頼してください。",
        });
      } else {
        excludedRows.push({
          row: row, reason: "date_fix_request", rowIndex: idx,
          detail: "降日が前月(" + prevClosing + "〆)分になっていますが前月分に同一データが無いため、正しい降日に修正して再送するよう業者に依頼してください。",
        });
      }
      return;
    }

    const nextClosing = shiftClosingMonth_(targetClosing, 1);
    if (rowClosing === nextClosing) {
      excludedRows.push({
        row: row, reason: "next_month_review", rowIndex: idx,
        detail: "降日が来月(" + nextClosing + "〆)分になっています。担当者が内容を確認して対応を判断してください。",
      });
      return;
    }

    excludedRows.push({
      row: row, reason: "date_mismatch_review", rowIndex: idx,
      detail: "降日(" + 降日 + ")が今回の締め月(" + targetClosing + "〆)からズレています。担当者が内容を確認してください。",
    });
  });

  if (excludedRows.length > 0) {
    return {
      imported: false, company: company, closingMonth: targetClosing,
      importedCount: 0, excludedRows: excludedRows,
    };
  }

  // 未確定の状態へ再アップロードする際、既に取り込まれている内容と完全に一致する場合は、
  // 誤って同じファイルを再選択した可能性が高いため、force指定が無い限り保存せず重複を通知する。
  if (!payload.force && existingStatus && existingStatus.状態 === "未確定") {
    const currentRows = allHaulingRows.filter(r => r.業者 === company && r.締め月 === targetClosing);
    if (isExactSameBatch_(okRows, currentRows)) {
      return {
        imported: false, duplicate: true, company: company, closingMonth: targetClosing,
        importedCount: 0, excludedRows: [],
      };
    }
  }

  return withLock_(() => {
    const sh = sheet_(SHEET_HAULING);
    const map = headerMap_(sh);
    const numCols = HAULING_HEADERS.length;
    const idCol = map["ID"] - 1;
    const companyCol = map["業者"] - 1;
    const closingCol = map["締め月"] - 1;

    // ロック取得後に最新状態を1回だけ読み込み、削除対象を除いた行(kept)とID採番の
    // 両方に使い回す。以前はdeleteRow()を対象行1件ずつ呼んでおり(シートが大きいほど
    // 行のシフトコストが積み重なって遅くなる)、さらにID採番・追記もそれぞれ別に
    // シートへアクセスしていたため、読み書きの回数が対象行数に比例して増えていた。
    const lastRow = sh.getLastRow();
    const values = lastRow >= 2 ? sh.getRange(2, 1, lastRow - 1, numCols).getValues() : [];
    // 未確定の状態への再アップロードは、修正後の正しいファイルとして前回分を置き換える
    const keptRows = values.filter(row => !(row[companyCol] === company && cellToYmd_(row[closingCol]) === targetClosing));

    let nextId = values.reduce((max, row) => Math.max(max, Number(row[idCol]) || 0), 0) + 1;
    const now = nowStr_();
    const outRows = okRows.map(row => {
      const feeType = classifyFeeType_(row["ブロック"]);
      const feeAmount = toNum_(row["通常単価"]) + toNum_(row["エキストラ1"]) + toNum_(row["エキストラ2"]);
      const out = new Array(HAULING_HEADERS.length).fill("");
      out[map["ID"] - 1] = nextId++;
      out[map["業者"] - 1] = company;
      out[map["締め月"] - 1] = targetClosing;
      out[map["物件名"] - 1] = row["物件名"] || "";
      out[map["積日"] - 1] = row["積日"] || "";
      out[map["降日"] - 1] = row["降日"] || "";
      out[map["ブロック"] - 1] = row["ブロック"] || "";
      out[map["節"] - 1] = row["節"] || "";
      out[map["積荷"] - 1] = row["積荷"] || "";
      out[map["現場待機"] - 1] = row["現場待機"] || "";
      out[map["車種"] - 1] = row["車種"] || "";
      out[map["最大長さ"] - 1] = row["最大長さ"] || "";
      out[map["総重量"] - 1] = toNum_(row["総重量"]);
      out[map["通常単価"] - 1] = toNum_(row["通常単価"]);
      out[map["エキストラ1"] - 1] = toNum_(row["エキストラ1"]);
      out[map["エキストラ2"] - 1] = toNum_(row["エキストラ2"]);
      out[map["費用区分"] - 1] = feeType;
      out[map["費用額"] - 1] = feeAmount;
      out[map["取込日時"] - 1] = now;
      out[map["元ファイル名"] - 1] = fileName;
      return out;
    });

    const finalRows = keptRows.concat(outRows);
    if (finalRows.length > 0) {
      sh.getRange(2, 1, finalRows.length, numCols).setValues(finalRows);
    }
    // 置き換え後に行数が減った場合、末尾に残る旧データを消す
    if (finalRows.length < values.length) {
      sh.getRange(finalRows.length + 2, 1, values.length - finalRows.length, numCols).clearContent();
    }
    upsertStatus_(company, targetClosing, "未確定", { 取込日時: true });

    return { imported: true, company: company, closingMonth: targetClosing, importedCount: outRows.length, excludedRows: [] };
  });
}

// ---------- 集計・分析 ----------

// company+closingMonthで既に絞り込み済みの行配列(rows)から、工事名別の費用区分内訳・
// 請求額・消費税・合計を組み立てる、getClosingCheck/getClosingCheckAll共通の内部処理。
function buildClosingCheckResult_(company, closingMonth, rows) {
  const byProject = {};
  rows.forEach(r => {
    const key = r.物件名 || "(物件名なし)";
    if (!byProject[key]) byProject[key] = { 物件名: key, コラム横持: 0, 製品等横持: 0, その他横持: 0, メッキ: 0, 現場搬入費用: 0, 重量: 0 };
    const feeType = classifyFeeType_(r.ブロック);
    byProject[key][feeType] = (byProject[key][feeType] || 0) + toNum_(r.費用額);
    // 重量は現場搬入費用分のみを集計する(横持4種・メッキの重量は含めない)
    if (feeType === "現場搬入費用") byProject[key].重量 += toNum_(r.総重量);
  });
  const projects = Object.keys(byProject).map(k => {
    const p = byProject[k];
    p.請求額 = p.コラム横持 + p.製品等横持 + p.その他横持 + p.メッキ + p.現場搬入費用;
    p.消費税 = Math.round(p.請求額 * 0.1);
    p.合計請求額 = p.請求額 + p.消費税;
    return p;
  });
  const total = projects.reduce((acc, p) => {
    acc.コラム横持 += p.コラム横持; acc.製品等横持 += p.製品等横持; acc.その他横持 += p.その他横持;
    acc.メッキ += p.メッキ; acc.現場搬入費用 += p.現場搬入費用;
    acc.重量 += p.重量; acc.請求額 += p.請求額; acc.消費税 += p.消費税; acc.合計請求額 += p.合計請求額;
    return acc;
  }, { コラム横持: 0, 製品等横持: 0, その他横持: 0, メッキ: 0, 現場搬入費用: 0, 重量: 0, 請求額: 0, 消費税: 0, 合計請求額: 0 });

  const status = findStatusRow_(company, closingMonth);
  return { company: company, closingMonth: closingMonth, status: status ? status.状態 : "未取込", projects: projects, total: total };
}

// 「20日締めチェック」: 業者+締め月を選択すると、工事名別の費用区分内訳・請求額・消費税・合計を返す。
// 費用区分は保存済みの列値を信用せず、「ブロック」列から毎回classifyFeeType_で再判定する
// (過去に別区分で保存された行があっても、常に最新の分類ロジックで正しく仕分けるため)。
function getClosingCheck(company, closingMonth, rowsIn) {
  if (!company || !closingMonth) throw new Error("業者・締め月を指定してください");
  const normalizedClosing = normalizeDateStr_(closingMonth);
  const allRows = rowsIn || haulingRows_();
  const rows = allRows.filter(r => r.業者 === company && r.締め月 === normalizedClosing);
  return buildClosingCheckResult_(company, normalizedClosing, rows);
}

// 「20日締めチェック」の業者「全て」表示: 指定した締め月について、業者マスタの全業者分の
// getClosingCheckの結果(業者ごとの状態・工事名別内訳・業者ごとの合計)をまとめて返す。
// 業者をまたいだ総合計は作らない(業者ごとに完結した表として扱うため)。
// rowsIn省略時は配車データを自身で読み込む(getCheckScreenInit等、呼び出し元が既に
// 読み込み済みの場合はrowsInで渡すことで、配車データの二重読み込みを避けられる)。
// 【高速化】以前は業者数(6社)ぶんgetClosingCheckを呼び出しており、そのたびに全行を
// filterしていた(全行スキャンが業者数に比例して繰り返されていた)。全行を1回だけ走査して
// 業者ごとにグルーピングしてから、業者ごとの集計はグルーピング済みの小さい配列に対して行う
// ように変更し、全行スキャンを1回に集約した。
function getClosingCheckAll(closingMonth, rowsIn) {
  if (!closingMonth) throw new Error("締め月を指定してください");
  const normalizedClosing = normalizeDateStr_(closingMonth);
  const rows = rowsIn || haulingRows_();
  const byCompany = {};
  rows.forEach(r => {
    if (r.締め月 !== normalizedClosing) return;
    if (!byCompany[r.業者]) byCompany[r.業者] = [];
    byCompany[r.業者].push(r);
  });
  const companies = listCompanies().map(company =>
    buildClosingCheckResult_(company, normalizedClosing, byCompany[company] || [])
  );
  return { closingMonth: normalizedClosing, companies: companies };
}

// 締め日文字列("YYYY/MM/DD")が属する会計年度(11月21日始まり、翌年11月20日決算)を返す。
// 12月分の締めは翌年の会計年度に属する(fiscalYearClosingMonths_の逆変換)
function fiscalYearForClosingStr_(closingStr) {
  const { y, m } = splitDateStr_(closingStr);
  return m === 12 ? y + 1 : y;
}

// 配車データの全行から、実際に登録されている締め月の会計年度を重複排除・昇順で返す
// (現在の会計年度は、データが無くても常に含める)
function availableYearsFromRows_(rows) {
  const years = {};
  years[currentFiscalYearEnd_()] = true;
  rows.forEach(r => { if (r.締め月) years[fiscalYearForClosingStr_(r.締め月)] = true; });
  return Object.keys(years).map(Number).sort((a, b) => a - b);
}

// 20日締めチェック画面の初期表示用。配車データの読み込みを1回にまとめ、年ボタンの選択肢・
// 実績のある最新の締め月・初期表示する集計結果までを1回のリクエストで返す
// (以前は年ボタン取得→デフォルト締め月取得→集計取得の3回に分かれており、GAS呼び出しごとの
// オーバーヘッド(スプレッドシートを開く処理等)が重なって表示が遅くなっていたため統合した)。
// preselectCompany・preselectClosingMonthが指定された場合(Excel取込み直後にその業者+締め月へ
// 自動遷移する場合)は、その組み合わせ単体の結果(getClosingCheck)を返す。指定が無い場合は
// これまで通り業者「全て」+最新月の結果(getClosingCheckAll)を返す。
// 【本更新で修正】以前はpreselect指定の有無に関わらず必ず業者「全て」の結果を計算しており、
// preselect指定時はその結果を使わず捨てた上で、フロントが追加でgetClosingCheckを呼び直して
// いた(配車データの二重読み込み+GAS呼び出しがもう1往復発生していた)。preselect指定時は
// 最初から単体の結果だけを計算するようにし、この無駄を無くした。
function getCheckScreenInit(preselectCompany, preselectClosingMonth) {
  const rows = haulingRows_();
  const years = availableYearsFromRows_(rows);
  let latestClosing = null;
  rows.forEach(r => { if (r.締め月 && (!latestClosing || r.締め月 > latestClosing)) latestClosing = r.締め月; });

  let result = null;
  if (preselectCompany && preselectClosingMonth) {
    result = getClosingCheck(preselectCompany, preselectClosingMonth, rows);
  } else if (latestClosing) {
    result = getClosingCheckAll(latestClosing, rows);
  }

  return { years: years, latestClosing: latestClosing, result: result };
}

// 会計年度(11月21日始まり、翌年11月20日決算)内の12回の締め月を、fiscalYearEnd(決算年、
// 例:2026なら2025/12/20〜2026/11/20)の昇順で返す
function fiscalYearClosingMonths_(fiscalYearEnd) {
  const months = [];
  // 12/20(fiscalYearEnd-1年) → 11/20(fiscalYearEnd年)
  months.push(ymd_(fiscalYearEnd - 1, 12, 20));
  for (let m = 1; m <= 11; m++) months.push(ymd_(fiscalYearEnd, m, 20));
  return months;
}

function currentFiscalYearEnd_() {
  const now = new Date();
  const tz = "Asia/Tokyo";
  const y = Number(Utilities.formatDate(now, tz, "yyyy"));
  const m = Number(Utilities.formatDate(now, tz, "M"));
  const d = Number(Utilities.formatDate(now, tz, "d"));
  // 11/21以降は「翌年11月20日決算」の年度に入る
  if (m > 11 || (m === 11 && d >= 21)) return y + 1;
  return y;
}

// 「年度全体集計」: 年度・工事別・業者別の合計、費用区分別の内訳、月別(締め月単位)の内訳を返す。
// 費用区分は保存済みの列値を信用せず、「ブロック」列から毎回classifyFeeType_で再判定する
// (getClosingCheckと同じ方針。過去データも常に最新の分類ロジックで仕分けられる)。
function getYearlySummary(fiscalYearEnd, rowsIn) {
  const fye = fiscalYearEnd || currentFiscalYearEnd_();
  const closingMonths = fiscalYearClosingMonths_(fye);
  const closingSet = {};
  closingMonths.forEach(c => { closingSet[c] = true; });

  const allRows = rowsIn || haulingRows_();
  const rows = allRows.filter(r => closingSet[r.締め月]);

  const emptyFeeBucket_ = () => ({ コラム横持: 0, 製品等横持: 0, その他横持: 0, メッキ: 0, 現場搬入費用: 0, 重量: 0, 合計: 0 });
  const byProject = {};
  const byCompany = {};
  const byMonth = {};
  closingMonths.forEach(c => { byMonth[c] = Object.assign({ 締め月: c }, emptyFeeBucket_()); });

  rows.forEach(r => {
    const amt = toNum_(r.費用額);
    const weight = toNum_(r.総重量);
    const feeType = classifyFeeType_(r.ブロック);

    // 重量は現場搬入費用分のみを集計する(横持4種・メッキの重量は含めない)
    const yardWeight = feeType === "現場搬入費用" ? weight : 0;

    const pKey = r.物件名 || "(物件名なし)";
    if (!byProject[pKey]) byProject[pKey] = Object.assign({ 物件名: pKey }, emptyFeeBucket_());
    byProject[pKey][feeType] += amt;
    byProject[pKey].重量 += yardWeight;
    byProject[pKey].合計 += amt;

    const cKey = r.業者 || "(業者不明)";
    if (!byCompany[cKey]) byCompany[cKey] = Object.assign({ 業者: cKey }, emptyFeeBucket_());
    byCompany[cKey][feeType] += amt;
    byCompany[cKey].重量 += yardWeight;
    byCompany[cKey].合計 += amt;

    byMonth[r.締め月][feeType] += amt;
    byMonth[r.締め月].重量 += yardWeight;
    byMonth[r.締め月].合計 += amt;
  });

  const total = rows.reduce((acc, r) => acc + toNum_(r.費用額), 0);

  return {
    fiscalYearEnd: fye,
    合計請求額: total,
    工事別: Object.keys(byProject).map(k => byProject[k]),
    業者別: Object.keys(byCompany).map(k => byCompany[k]),
    月別: closingMonths.map(c => byMonth[c]),
  };
}

// 年度集計画面の初期表示用。配車データの読み込みを1回にまとめ、年ボタンの選択肢と
// (省略時は今年度の)集計結果を1回のリクエストで返す(以前は年ボタン取得と集計取得が
// 別々のGAS呼び出しになっており、それぞれがスプレッドシートを開き直すオーバーヘッドで
// 表示が遅くなっていたため統合した)。
function getYearlySummaryInit(fiscalYearEnd) {
  const rows = haulingRows_();
  return {
    years: availableYearsFromRows_(rows),
    summary: getYearlySummary(fiscalYearEnd, rows),
  };
}

// 工事別内訳画面の物件ボタン用: 配車データに実際に登録されている物件名(D列)を、その物件の
// 最後の締め月(最新の配送記録)が属する年度ごとに区分けして返す。新しい年度が先頭に来るよう
// 降順で返し、各年度内の物件名はアルファベット順にする。
function listProjects() {
  const latestClosingByProject = {};
  haulingRows_().forEach(r => {
    if (!r.物件名 || !r.締め月) return;
    if (!latestClosingByProject[r.物件名] || r.締め月 > latestClosingByProject[r.物件名]) {
      latestClosingByProject[r.物件名] = r.締め月;
    }
  });
  const byYear = {};
  Object.keys(latestClosingByProject).forEach(name => {
    const year = fiscalYearForClosingStr_(latestClosingByProject[name]);
    if (!byYear[year]) byYear[year] = [];
    byYear[year].push(name);
  });
  return Object.keys(byYear).map(Number).sort((a, b) => b - a).map(year => ({
    year: year,
    names: byYear[year].sort(),
  }));
}

// 工事別内訳: 指定した物件名の配車データを業者ごとに集計する(横持3区分・メッキ・
// 現場搬入費用・重量・合計)。重量はgetClosingCheck/getYearlySummaryと同じ方針で
// 現場搬入費用分のみを対象にする(横持4種・メッキの重量は含めない)。
function getProjectDetail(projectName) {
  if (!projectName) throw new Error("物件名を指定してください");
  const rows = haulingRows_().filter(r => r.物件名 === projectName);
  const emptyFeeBucket_ = () => ({ コラム横持: 0, 製品等横持: 0, その他横持: 0, メッキ: 0, 現場搬入費用: 0, 重量: 0, 合計: 0 });

  const byCompany = {};
  rows.forEach(r => {
    const amt = toNum_(r.費用額);
    const feeType = classifyFeeType_(r.ブロック);
    const yardWeight = feeType === "現場搬入費用" ? toNum_(r.総重量) : 0;
    const cKey = r.業者 || "(業者不明)";
    if (!byCompany[cKey]) byCompany[cKey] = Object.assign({ 業者: cKey }, emptyFeeBucket_());
    byCompany[cKey][feeType] += amt;
    byCompany[cKey].重量 += yardWeight;
    byCompany[cKey].合計 += amt;
  });

  const companies = Object.keys(byCompany).map(k => byCompany[k]);
  const total = companies.reduce((acc, c) => {
    acc.コラム横持 += c.コラム横持; acc.製品等横持 += c.製品等横持; acc.その他横持 += c.その他横持;
    acc.メッキ += c.メッキ; acc.現場搬入費用 += c.現場搬入費用;
    acc.重量 += c.重量; acc.合計 += c.合計;
    return acc;
  }, emptyFeeBucket_());

  return { 物件名: projectName, 業者別: companies, total: total };
}

// ---------- 過去データ移行(運送QUERY2026等からの一括インポート。確定済みとして取り込む) ----------
/**
 * payload: {
 *   company: "山陰運送",
 *   rows: [{ 物件名, 降日:"YYYY-MM-DD", ブロック, 車種, 総重量, 費用区分, 費用額 }, ...]
 * }
 * 過去の運送QUERY2026の各業者タブのデータを、締め月ごとに自動判定して確定済みとして書き込む。
 * (積日・節・積荷・現場待機・最大長さ・通常単価・エキストラは移行元データに無いため空欄になる。
 *  重複判定は、これらの列が空欄の行同士でも11項目中7項目以上一致すれば機能する想定だが、
 *  過去データ同士(移行データ)を対象に重複判定を行うことは無い(移行は1回のみ・確定済み扱いのため)。)
 */
function bulkImportLegacy(payload) {
  const company = payload.company;
  const rowsIn = payload.rows || [];
  if (!company) throw new Error("業者を指定してください");

  return withLock_(() => {
    const sh = sheet_(SHEET_HAULING);
    const map = headerMap_(sh);
    const idCol = map["ID"];
    let nextId = nextHaulingId_(sh, idCol);
    const now = nowStr_();
    const byClosing = {};

    const outRows = rowsIn.map(row => {
      const closingMonth = closingMonthFromDateStr_(row["降日"]);
      byClosing[closingMonth] = true;
      const out = new Array(HAULING_HEADERS.length).fill("");
      out[map["ID"] - 1] = nextId++;
      out[map["業者"] - 1] = company;
      out[map["締め月"] - 1] = closingMonth;
      out[map["物件名"] - 1] = row["物件名"] || "";
      out[map["降日"] - 1] = row["降日"] || "";
      out[map["ブロック"] - 1] = row["ブロック"] || "";
      out[map["車種"] - 1] = row["車種"] || "";
      out[map["総重量"] - 1] = toNum_(row["総重量"]);
      out[map["費用区分"] - 1] = row["費用区分"] || classifyFeeType_(row["ブロック"]);
      out[map["費用額"] - 1] = toNum_(row["費用額"]);
      out[map["取込日時"] - 1] = now;
      out[map["元ファイル名"] - 1] = "(過去データ移行: 運送QUERY2026)";
      return out;
    });

    if (outRows.length > 0) {
      sh.getRange(sh.getLastRow() + 1, 1, outRows.length, HAULING_HEADERS.length).setValues(outRows);
    }
    Object.keys(byClosing).forEach(c => upsertStatus_(company, c, "確定済み", { 取込日時: true, 確定日時: true }));

    return { importedCount: outRows.length, closingMonths: Object.keys(byClosing).sort() };
  });
}
