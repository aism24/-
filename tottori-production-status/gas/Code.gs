/**
 * 「鳥取工場 生産状況周知」のGAS APIバックエンド。
 *
 * 新しいスプレッドシート「鳥取工場生産状況周知」の「拡張機能 → Apps Script」に貼り付けて使う
 * コンテナバインド型スクリプトです。画面(index.html / app.js)は Vercel・GitHub で配信する静的ページで、
 * このGASは JSON API と、案件マスターの読み取り・一覧の作成だけを行います。
 *
 * ■ 作るもの(鳥取の行だけ)
 *   前日出来高 : 案件マスターの「加工」列の日付が「前の営業日」の行
 *   遅れリスト : 「備考①」列に日付があり(=生産予定日)、その日付が今日より前で、「加工」列に日付が無い行
 *               遅れ日数 = 今日 − 生産予定日(暦日)
 *   「前の営業日」は、索引スプレッドシートの会社カレンダー(I列=日付、J列=出勤/休日)で決める。
 *
 * ■ 読むもの(書き込みは一切しない)
 *   索引スプレッドシート「Excelマスタ一覧」(生産管理ダッシュボードと同じもの)。IDは「情報」シートの
 *   「索引スプレッドシート」の行に、URLかIDを貼る(公開リポジトリにIDを書かないため)。
 *   A〜E列=案件マスターの一覧、G・H列=工事番号→工事名、I・J列=会社カレンダー。
 *   案件マスターは列の見出し(加工先・製品マーク・図番・重量・備考①・加工)で列を探す。
 *   Excelは一時的にスプレッドシートへ変換して読み、読み終えたらすぐ削除する。元のExcelには触れない。
 *   元ファイルの更新日時が前回と同じなら読み直さない(「状態」シートで管理)。
 *
 * ■ シート(setupSheets で作る)
 *   情報(項目名・値)/ 前日出来高 / 遅れリスト / 取込データ(非表示)/ 状態(非表示)/ 利用記録(非表示)
 *
 * セットアップ手順は README.md を参照してください。
 */

const CODE_VERSION = '2026-11-11a';
const TIMEZONE = 'Asia/Tokyo';
const TARGET_SITE_DEFAULT = '鳥取';
const IGNORE_WORK_NO = '00-00';
const PARSE_VERSION = 1; // 取込データの形を変えたら上げる(全ファイルを読み直す)
const TIME_BUDGET_MS = 240 * 1000; // 1回の実行で案件マスターを読む時間の上限(6分制限の手前)
const TEMP_PREFIX = '_鳥取周知_一時変換_';

const SHEET_INFO = '情報';
const SHEET_YESTERDAY = '前日出来高';
const SHEET_LATE = '遅れリスト';
const SHEET_DATA = '取込データ';
const SHEET_STATE = '状態';
const SHEET_LOG = '利用記録';

const INFO_INDEX = '索引スプレッドシート';
const INFO_SITE = '対象拠点';
const INFO_BASE = '基準日';
const INFO_PREV = '前の営業日';
const INFO_UPDATED = '最終更新';
const INFO_PENDING = '未取込の案件';
const INFO_WARN = '注意';

const HEAD_YESTERDAY = ['工事名', '製品名', '図番', '重量(t)', '生産日'];
const HEAD_LATE = ['工事名', '製品名', '図番', '重量(t)', '生産予定日', '遅れ日数'];
const HEAD_DATA = ['ファイルID', '工事番号', '工事名', '製品名', '図番', '重量(t)', '生産予定日', '生産日'];
const HEAD_STATE = ['ファイルID', '工事番号', 'ファイル名', '元ファイル更新日時', '取込日時', '鳥取の行数', '形式', 'エラー'];
const HEAD_LOG = ['日時', '種別', '内容'];

// ========== エントリーポイント ==========

function doGet(e) {
  const action = (e && e.parameter && e.parameter.action) || 'getData';
  try {
    if (action === 'ping') return json_({ status: 'success', version: CODE_VERSION });
    if (action === 'refresh') return json_(userRefresh_());
    return json_({ status: 'success', version: CODE_VERSION, data: getData_() });
  } catch (err) {
    return json_({ status: 'error', version: CODE_VERSION, message: String(err && err.message || err) });
  }
}

// 利用記録(画面には何も出さない。失敗しても画面側は無視する)
function doPost(e) {
  try {
    let body = {};
    try { body = JSON.parse((e && e.postData && e.postData.contents) || '{}'); } catch (x) { body = {}; }
    if (body.action === 'log') writeLog_(String(body.kind || ''), String(body.detail || ''));
  } catch (err) {
    // 記録の失敗は無視する
  }
  return json_({ status: 'success' });
}

function json_(obj) {
  return ContentService.createTextOutput(JSON.stringify(obj)).setMimeType(ContentService.MimeType.JSON);
}

// ========== Apps Scriptエディタから手動で実行する関数 ==========

// 最初に1回実行する: シートと見出しを作り、毎朝の自動更新を設定する。既存のシート・値は消さない。
function setupSheets() {
  const ss = SpreadsheetApp.getActiveSpreadsheet();
  ensureSheet_(ss, SHEET_INFO, ['項目', '値'], false);
  ensureSheet_(ss, SHEET_YESTERDAY, HEAD_YESTERDAY, false);
  ensureSheet_(ss, SHEET_LATE, HEAD_LATE, false);
  ensureSheet_(ss, SHEET_DATA, HEAD_DATA, true);
  ensureSheet_(ss, SHEET_STATE, HEAD_STATE, true);
  ensureSheet_(ss, SHEET_LOG, HEAD_LOG, true);
  const info = ss.getSheetByName(SHEET_INFO);
  [INFO_INDEX, INFO_SITE, INFO_BASE, INFO_PREV, INFO_UPDATED, INFO_PENDING, INFO_WARN].forEach(function (k) {
    if (findInfoRow_(info, k) < 0) info.appendRow([k, k === INFO_SITE ? TARGET_SITE_DEFAULT : '']);
  });
  info.setColumnWidth(1, 160);
  info.setColumnWidth(2, 480);
  // 何も無い初期の「シート1」は、空のときだけ消す
  const blank = ss.getSheetByName('シート1');
  if (blank && ss.getSheets().length > 1 && blank.getLastRow() === 0) ss.deleteSheet(blank);
  createDailyTrigger();
  Logger.log('シートを準備しました。「情報」シートの「' + INFO_INDEX + '」の値に、索引スプレッドシート「Excelマスタ一覧」のURLを貼ってから、refreshNow を実行してください。');
}

// 毎朝6時ごろに自動更新する(生産管理ダッシュボードの5時台の更新とは別に動く)。
function createDailyTrigger() {
  ScriptApp.getProjectTriggers().forEach(function (t) {
    if (t.getHandlerFunction() === 'dailyRefresh') ScriptApp.deleteTrigger(t);
  });
  ScriptApp.newTrigger('dailyRefresh').timeBased().atHour(6).nearMinute(0).everyDays(1).inTimezone(TIMEZONE).create();
}

// 手動で今すぐ更新する(初回の取り込みにも使う)。読み切れなかった案件は1分後に自動で続きを読む。
function refreshNow() {
  const r = runRefreshLocked_(true);
  Logger.log(JSON.stringify({ status: r.status, pending: r.pending, yesterday: r.data && r.data.yesterday.length, late: r.data && r.data.late.length, warnings: r.data && r.data.warnings }));
}

function dailyRefresh() { runRefreshLocked_(true); }
function continueRefresh() { runRefreshLocked_(true); }

// ========== 更新の本体 ==========

function userRefresh_() {
  const lock = LockService.getScriptLock();
  if (!lock.tryLock(3000)) return { status: 'busy', message: '他の人がデータを更新中です。少し待ってからもう一度押してください。' };
  try {
    const r = runRefresh_();
    return { status: 'success', version: CODE_VERSION, pending: r.pending, data: r.data };
  } finally {
    lock.releaseLock();
  }
}

function runRefreshLocked_(wait) {
  const lock = LockService.getScriptLock();
  if (wait) lock.waitLock(300000); else if (!lock.tryLock(3000)) return { status: 'busy' };
  try {
    const r = runRefresh_();
    return { status: 'success', pending: r.pending, data: r.data };
  } finally {
    lock.releaseLock();
  }
}

// 変わった案件マスターだけ読み直し、一覧を作り直してシートへ書く。
function runRefresh_() {
  const started = Date.now();
  const ss = SpreadsheetApp.getActiveSpreadsheet();
  const info = ss.getSheetByName(SHEET_INFO);
  if (!info) throw new Error('「' + SHEET_INFO + '」シートがありません。Apps Scriptエディタで setupSheets を実行してください。');
  const indexId = extractId_(readInfo_(info, INFO_INDEX));
  if (!indexId) throw new Error('「' + SHEET_INFO + '」シートの「' + INFO_INDEX + '」が空です。索引スプレッドシート「Excelマスタ一覧」のURLを貼ってください。');
  const site = String(readInfo_(info, INFO_SITE) || TARGET_SITE_DEFAULT).trim();

  const indexRows = readIndexRows_(indexId);
  const fileIndex = readFileIndex_(indexRows);
  const workNames = readWorkNameMap_(indexRows);
  const calendar = readCalendar_(indexRows);

  const stateSh = ss.getSheetByName(SHEET_STATE);
  const dataSh = ss.getSheetByName(SHEET_DATA);
  const state = readState_(stateSh); // fileId -> {mtime, importedAt, ...}
  const dataByFile = readDataByFile_(dataSh); // fileId -> rows(配列)

  const warnings = [];
  const folder = getOwnFolder_(ss);
  // 取込が古い順(未取込が先)に、時間の許す範囲で読む
  const order = fileIndex.slice().sort(function (a, b) {
    const sa = state[a.fileId], sb = state[b.fileId];
    return (sa ? sa.importedAt : 0) - (sb ? sb.importedAt : 0);
  });
  let pending = 0;
  order.forEach(function (entry) {
    const st = state[entry.fileId];
    let file;
    try {
      file = DriveApp.getFileById(entry.fileId);
    } catch (err) {
      warnings.push('「' + entry.fileName + '」(' + entry.workNo + ')を開けませんでした: ' + err.message);
      return;
    }
    const mtime = String(file.getLastUpdated().getTime());
    if (st && st.mtime === mtime && st.version === PARSE_VERSION && !st.error && st.workNo === entry.workNo) return; // 変更なし
    if (Date.now() - started > TIME_BUDGET_MS) { pending++; return; }
    let rows = [], error = '';
    try {
      rows = readMasterRows_(entry, file, folder, site);
    } catch (err) {
      error = String(err && err.message || err);
      warnings.push('「' + entry.fileName + '」(' + entry.workNo + ')の読み込みに失敗しました: ' + error);
      if (st && dataByFile[entry.fileId]) rows = null; // 失敗時は前回の取込データを残す
    }
    if (rows) dataByFile[entry.fileId] = rows.map(function (r) {
      return [entry.fileId, entry.workNo, '', r.mark, r.drawing, r.weight, r.plan || '', r.done || ''];
    });
    state[entry.fileId] = { fileId: entry.fileId, workNo: entry.workNo, fileName: entry.fileName, mtime: mtime, importedAt: Date.now(), count: rows ? rows.length : (st ? st.count : 0), version: PARSE_VERSION, error: error };
  });

  // 索引から消えた案件の取込データは捨てる
  const live = {};
  fileIndex.forEach(function (e) { live[e.fileId] = e; });
  Object.keys(dataByFile).forEach(function (id) { if (!live[id]) delete dataByFile[id]; });
  Object.keys(state).forEach(function (id) { if (!live[id]) delete state[id]; });

  // 工事名は毎回、索引の最新の対応表で付け直す
  const allRows = [];
  Object.keys(dataByFile).forEach(function (id) {
    dataByFile[id].forEach(function (r) {
      r[2] = workNames[r[1]] || (live[id] ? stripExt_(live[id].fileName) : '');
      allRows.push(r);
    });
  });
  writeTable_(dataSh, HEAD_DATA, allRows, [0, 1, 2, 3, 4, 6, 7]);
  writeState_(stateSh, state);

  const today = todayKey_();
  const built = buildLists_(allRows, calendar, today);
  if (pending > 0) warnings.push('時間内に読み切れなかった案件が' + pending + '件あります。1分後に自動で続きを読みます。');
  built.warnings = warnings.concat(built.warnings);
  built.pending = pending;
  built.updatedAt = Utilities.formatDate(new Date(), TIMEZONE, 'yyyy-MM-dd HH:mm');
  writeOutputs_(ss, info, built);
  scheduleContinue_(pending > 0);
  return { pending: pending, data: toPayload_(built) };
}

// 画面からの取得。日付が変わっていたら(朝の自動更新の前など)、取込データから一覧だけ作り直す。
function getData_() {
  const ss = SpreadsheetApp.getActiveSpreadsheet();
  const info = ss.getSheetByName(SHEET_INFO);
  if (!info) throw new Error('「' + SHEET_INFO + '」シートがありません。setupSheets を実行してください。');
  if (!String(readInfo_(info, INFO_UPDATED) || '')) throw new Error('まだ案件マスターを取り込んでいません。Apps Scriptエディタで refreshNow を実行してください。');
  const base = readInfo_(info, INFO_BASE);
  const today = todayKey_();
  if (normalizeKey_(base) !== today) {
    const lock = LockService.getScriptLock();
    if (lock.tryLock(20000)) {
      try {
        if (normalizeKey_(readInfo_(info, INFO_BASE)) !== today) {
          const indexId = extractId_(readInfo_(info, INFO_INDEX));
          if (!indexId) throw new Error('「' + SHEET_INFO + '」シートの「' + INFO_INDEX + '」が空です。');
          const calendar = readCalendar_(readIndexRows_(indexId));
          const allRows = readTableRows_(ss.getSheetByName(SHEET_DATA), HEAD_DATA.length);
          const built = buildLists_(allRows, calendar, today);
          built.warnings = splitWarn_(readInfo_(info, INFO_WARN)).filter(function (w) { return w.indexOf('会社カレンダー') < 0; }).concat(built.warnings);
          built.pending = Number(readInfo_(info, INFO_PENDING)) || 0;
          built.updatedAt = String(readInfo_(info, INFO_UPDATED) || '');
          writeOutputs_(ss, info, built);
          return toPayload_(built);
        }
      } finally {
        lock.releaseLock();
      }
    }
  }
  return readPayloadFromSheets_(ss, info);
}

// ========== 一覧づくり(純粋な計算。テストで直接呼ぶ) ==========

// allRows: 取込データの行 [ファイルID, 工事番号, 工事名, 製品名, 図番, 重量, 生産予定日, 生産日](日付は'yyyy-MM-dd'の文字列)
// calendar: {'yyyy-MM-dd': true(出勤)/false(休日)}  today: 'yyyy-MM-dd'
function buildLists_(allRows, calendar, today) {
  const prev = prevBusinessDay_(calendar, today);
  const yesterday = [], late = [];
  allRows.forEach(function (r) {
    const plan = normalizeKey_(r[6]), done = normalizeKey_(r[7]);
    const weight = Number(r[5]) || 0;
    if (done && done === prev.key) yesterday.push([r[2], r[3], r[4], weight, done, r[1]]);
    if (plan && !done && plan < today) late.push([r[2], r[3], r[4], weight, plan, daysBetween_(plan, today), r[1]]);
  });
  const byText = function (a, b) { return a < b ? -1 : a > b ? 1 : 0; };
  // 前日出来高: 工事番号 → 図番 → 製品名
  yesterday.sort(function (a, b) { return byText(a[5], b[5]) || byText(a[2], b[2]) || byText(a[1], b[1]); });
  // 遅れリスト: 遅れ日数の大きい順 → 工事番号 → 図番 → 製品名
  late.sort(function (a, b) { return (b[5] - a[5]) || byText(a[6], b[6]) || byText(a[2], b[2]) || byText(a[1], b[1]); });
  return {
    baseDate: today,
    prevDate: prev.key,
    yesterday: yesterday.map(function (r) { return r.slice(0, 5); }),
    late: late.map(function (r) { return r.slice(0, 6); }),
    warnings: prev.warning ? [prev.warning] : [],
  };
}

// 前の営業日: 今日より前で、会社カレンダーが「出勤」の最も近い日。
// カレンダーに無い日に当たったら、土日を休みとみなして続け、注意を出す。
function prevBusinessDay_(calendar, today) {
  let d = keyToUtc_(today);
  let missing = '';
  for (let i = 0; i < 60; i++) {
    d -= 86400000;
    const key = utcToKey_(d);
    if (Object.prototype.hasOwnProperty.call(calendar, key)) {
      if (calendar[key]) return { key: key, warning: missing ? calendarWarn_(missing) : '' };
    } else {
      if (!missing) missing = key;
      const wd = new Date(d).getUTCDay();
      if (wd !== 0 && wd !== 6) return { key: key, warning: calendarWarn_(missing) };
    }
  }
  return { key: '', warning: '前の営業日が見つかりませんでした(会社カレンダーを確認してください)。' };
}

function calendarWarn_(key) {
  return '会社カレンダー(索引スプレッドシートのI・J列)に ' + key.replace(/-/g, '/') + ' がありません。土日を休みとみなして前の営業日を決めました。カレンダーを延ばしてください。';
}

function daysBetween_(fromKey, toKey) { return Math.round((keyToUtc_(toKey) - keyToUtc_(fromKey)) / 86400000); }
function keyToUtc_(key) { const p = key.split('-'); return Date.UTC(Number(p[0]), Number(p[1]) - 1, Number(p[2])); }
function utcToKey_(ms) { const d = new Date(ms); return d.getUTCFullYear() + '-' + pad2_(d.getUTCMonth() + 1) + '-' + pad2_(d.getUTCDate()); }
function pad2_(n) { return n < 10 ? '0' + n : String(n); }

// Date(日本時間)→'yyyy-MM-dd'。Utilities を使わない(行ごとに呼ぶため)。
function dateToKeyJst_(d) {
  const t = new Date(d.getTime() + 9 * 3600000);
  return t.getUTCFullYear() + '-' + pad2_(t.getUTCMonth() + 1) + '-' + pad2_(t.getUTCDate());
}
function isDate_(v) { return v instanceof Date && !isNaN(v.getTime()); }
function todayKey_() { return dateToKeyJst_(new Date()); }
// シートから読んだ値(Date か 'yyyy-MM-dd')を'yyyy-MM-dd'にそろえる。
function normalizeKey_(v) {
  if (isDate_(v)) return dateToKeyJst_(v);
  const s = String(v == null ? '' : v).trim();
  const m = s.match(/^(\d{4})[-\/](\d{1,2})[-\/](\d{1,2})/);
  return m ? m[1] + '-' + pad2_(Number(m[2])) + '-' + pad2_(Number(m[3])) : '';
}

// ========== 案件マスターの読み取り ==========

// 案件マスターの1シート目から、対象拠点の行で「備考①」か「加工」に日付がある行だけを返す。
function readMasterRows_(entry, file, folder, site) {
  if (entry.sourceType === 'sheet') {
    return parseMasterValues_(SpreadsheetApp.openById(entry.fileId).getSheets()[0], site);
  }
  // Excel: 一時的にスプレッドシートへ変換して読み、すぐ削除する(元のExcelには触れない)
  const created = Drive.Files.create({ name: TEMP_PREFIX + entry.workNo, mimeType: MimeType.GOOGLE_SHEETS, parents: [folder.getId()] }, file.getBlob());
  try {
    return parseMasterValues_(SpreadsheetApp.openById(created.id).getSheets()[0], site);
  } finally {
    try { Drive.Files.remove(created.id); } catch (e) { try { DriveApp.getFileById(created.id).setTrashed(true); } catch (e2) { /* 消せなくても続ける */ } }
  }
}

function parseMasterValues_(sheet, site) {
  const lastRow = sheet.getLastRow(), lastCol = sheet.getLastColumn();
  if (lastRow < 2 || lastCol < 1) return [];
  const header = sheet.getRange(1, 1, 1, lastCol).getValues()[0];
  const col = findColumns_(header);
  const need = [col.site, col.mark, col.drawing, col.weight, col.plan, col.done].filter(function (c) { return c >= 0; });
  const width = Math.max.apply(null, need) + 1;
  return parseMasterRows_(header, sheet.getRange(2, 1, lastRow - 1, width).getValues(), site);
}

function findColumns_(header) {
  const h = header.map(function (x) { return String(x == null ? '' : x).trim(); });
  const col = { site: h.indexOf('加工先'), mark: h.indexOf('製品マーク'), drawing: h.indexOf('図番'), weight: h.indexOf('重量'), plan: h.indexOf('備考①'), done: h.indexOf('加工') };
  if (col.site < 0 || col.done < 0) throw new Error('見出しに「加工先」または「加工」がありません');
  return col;
}

// header: 見出し行、values: 2行目以降の値。純粋な計算(テストで直接呼ぶ)。
function parseMasterRows_(header, values, site) {
  const col = findColumns_(header);
  const out = [];
  for (let i = 0; i < values.length; i++) {
    const row = values[i];
    if (String(row[col.site] == null ? '' : row[col.site]).trim() !== site) continue;
    const plan = col.plan >= 0 && isDate_(row[col.plan]) ? dateToKeyJst_(row[col.plan]) : '';
    const done = isDate_(row[col.done]) ? dateToKeyJst_(row[col.done]) : '';
    if (!plan && !done) continue;
    out.push({
      mark: col.mark >= 0 ? String(row[col.mark] == null ? '' : row[col.mark]).trim() : '',
      drawing: col.drawing >= 0 ? String(row[col.drawing] == null ? '' : row[col.drawing]).trim() : '',
      weight: col.weight >= 0 ? (Number(row[col.weight]) || 0) : 0,
      plan: plan,
      done: done,
    });
  }
  return out;
}

// ========== 索引スプレッドシート ==========

function readIndexRows_(indexId) {
  const sh = SpreadsheetApp.openById(indexId).getSheets()[0];
  const lastRow = sh.getLastRow();
  if (lastRow < 2) return [];
  return sh.getRange(2, 1, lastRow - 1, 10).getValues(); // A:J
}

// A:E列。工事番号が空・"00-00"の行は除く。マスタNo(B列)が"S"始まりならスプレッドシート、それ以外はExcel。
// (生産管理ダッシュボードの Code.gs と同じ決まり)
function readFileIndex_(rows) {
  const list = [], seen = {};
  rows.forEach(function (row) {
    const workNo = String(row[2] || '').trim();
    const fileName = String(row[3] || '').trim();
    const fileId = extractId_(row[4]);
    if (!workNo || !fileName || !fileId || workNo === IGNORE_WORK_NO || seen[fileId]) return;
    seen[fileId] = true;
    list.push({ workNo: workNo, fileName: fileName, fileId: fileId, sourceType: /^s/i.test(String(row[1] || '').trim()) ? 'sheet' : 'excel' });
  });
  return list;
}

function readWorkNameMap_(rows) {
  const map = {};
  rows.forEach(function (row) {
    const no = String(row[6] || '').trim(), name = String(row[7] || '').trim();
    if (no) map[no] = name;
  });
  return map;
}

function readCalendar_(rows) {
  const cal = {};
  rows.forEach(function (row) {
    const key = normalizeKey_(row[8]);
    if (key) cal[key] = String(row[9] || '').trim() === '出勤';
  });
  return cal;
}

// URL・ID のどちらでもIDを取り出す
function extractId_(v) {
  const s = String(v == null ? '' : v).trim();
  const m = s.match(/\/d\/([a-zA-Z0-9_-]{20,})/) || s.match(/[?&]id=([a-zA-Z0-9_-]{20,})/) || s.match(/^([a-zA-Z0-9_-]{20,})$/);
  return m ? m[1] : '';
}

function stripExt_(name) { return String(name || '').replace(/\.(xlsx|xlsm|xls)$/i, ''); }

// ========== このスプレッドシートの読み書き ==========

function ensureSheet_(ss, name, head, hidden) {
  let sh = ss.getSheetByName(name);
  if (!sh) sh = ss.insertSheet(name);
  if (sh.getLastRow() === 0) {
    sh.getRange(1, 1, 1, head.length).setValues([head]).setFontWeight('bold').setBackground('#e8eef7');
    sh.setFrozenRows(1);
  }
  if (hidden) sh.hideSheet();
  return sh;
}

function findInfoRow_(info, key) {
  const last = info.getLastRow();
  if (last < 1) return -1;
  const keys = info.getRange(1, 1, last, 1).getValues();
  for (let i = 0; i < keys.length; i++) if (String(keys[i][0]).trim() === key) return i + 1;
  return -1;
}

function readInfo_(info, key) {
  const r = findInfoRow_(info, key);
  return r < 0 ? '' : info.getRange(r, 2).getValue();
}

function writeInfo_(info, key, value) {
  let r = findInfoRow_(info, key);
  if (r < 0) { info.appendRow([key, '']); r = info.getLastRow(); }
  info.getRange(r, 2).setValue(value);
}

function splitWarn_(v) { return String(v || '').split('\n').map(function (s) { return s.trim(); }).filter(Boolean); }

function readTableRows_(sh, width) {
  const last = sh.getLastRow();
  if (last < 2) return [];
  return sh.getRange(2, 1, last - 1, width).getValues();
}

// textCols: 文字のまま書く列(0始まり)。図番「2-1」や日付の文字列が、シートの自動変換で日付型に変わるのを防ぐ。
function writeTable_(sh, head, rows, textCols) {
  const last = sh.getLastRow();
  if (last > 1) sh.getRange(2, 1, last - 1, Math.max(sh.getLastColumn(), head.length)).clearContent();
  sh.getRange(1, 1, 1, head.length).setValues([head]);
  if (!rows.length) return;
  (textCols || []).forEach(function (c) { sh.getRange(2, c + 1, rows.length, 1).setNumberFormat('@'); });
  sh.getRange(2, 1, rows.length, head.length).setValues(rows);
}

function readDataByFile_(sh) {
  const map = {};
  readTableRows_(sh, HEAD_DATA.length).forEach(function (r) {
    const id = String(r[0] || '');
    if (!id) return;
    // 日付は文字列でそろえる(シートが日付に変換していても戻す)
    (map[id] = map[id] || []).push([id, String(r[1]), String(r[2]), String(r[3]), String(r[4]), Number(r[5]) || 0, normalizeKey_(r[6]), normalizeKey_(r[7])]);
  });
  return map;
}

function readState_(sh) {
  const map = {};
  readTableRows_(sh, HEAD_STATE.length).forEach(function (r) {
    const id = String(r[0] || '');
    if (!id) return;
    const ver = String(r[6] || '').match(/v(\d+)/);
    map[id] = { fileId: id, workNo: String(r[1]), fileName: String(r[2]), mtime: String(r[3]), importedAt: isDate_(r[4]) ? r[4].getTime() : 0, count: Number(r[5]) || 0, version: ver ? Number(ver[1]) : 0, error: String(r[7] || '') };
  });
  return map;
}

function writeState_(sh, state) {
  const rows = Object.keys(state).map(function (id) {
    const s = state[id];
    return [s.fileId, s.workNo, s.fileName, s.mtime, s.importedAt ? new Date(s.importedAt) : '', s.count, 'v' + s.version, s.error || ''];
  });
  writeTable_(sh, HEAD_STATE, rows, [0, 1, 2, 3, 6, 7]);
}

function writeOutputs_(ss, info, built) {
  // 工事名・製品名・図番・日付は文字のまま書く
  writeTable_(ss.getSheetByName(SHEET_YESTERDAY), HEAD_YESTERDAY, built.yesterday, [0, 1, 2, 4]);
  writeTable_(ss.getSheetByName(SHEET_LATE), HEAD_LATE, built.late, [0, 1, 2, 4]);
  writeInfo_(info, INFO_BASE, "'" + built.baseDate);
  writeInfo_(info, INFO_PREV, "'" + built.prevDate);
  writeInfo_(info, INFO_UPDATED, "'" + built.updatedAt);
  writeInfo_(info, INFO_PENDING, built.pending || 0);
  writeInfo_(info, INFO_WARN, built.warnings.join('\n'));
}

function readPayloadFromSheets_(ss, info) {
  const y = readTableRows_(ss.getSheetByName(SHEET_YESTERDAY), HEAD_YESTERDAY.length).map(function (r) { return [String(r[0]), String(r[1]), String(r[2]), Number(r[3]) || 0, normalizeKey_(r[4])]; });
  const l = readTableRows_(ss.getSheetByName(SHEET_LATE), HEAD_LATE.length).map(function (r) { return [String(r[0]), String(r[1]), String(r[2]), Number(r[3]) || 0, normalizeKey_(r[4]), Number(r[5]) || 0]; });
  return toPayload_({
    baseDate: normalizeKey_(readInfo_(info, INFO_BASE)),
    prevDate: normalizeKey_(readInfo_(info, INFO_PREV)),
    updatedAt: String(readInfo_(info, INFO_UPDATED) || ''),
    pending: Number(readInfo_(info, INFO_PENDING)) || 0,
    warnings: splitWarn_(readInfo_(info, INFO_WARN)),
    yesterday: y,
    late: l,
  });
}

function toPayload_(b) {
  return { site: TARGET_SITE_DEFAULT, baseDate: b.baseDate, prevDate: b.prevDate, updatedAt: b.updatedAt, pending: b.pending || 0, warnings: b.warnings || [], yesterday: b.yesterday, late: b.late };
}

function getOwnFolder_(ss) {
  const parents = DriveApp.getFileById(ss.getId()).getParents();
  return parents.hasNext() ? parents.next() : DriveApp.getRootFolder();
}

// 読み切れなかった案件があれば1分後に続きを読む。無ければ続きの予約を消す。
function scheduleContinue_(need) {
  ScriptApp.getProjectTriggers().forEach(function (t) {
    if (t.getHandlerFunction() === 'continueRefresh') ScriptApp.deleteTrigger(t);
  });
  if (need) ScriptApp.newTrigger('continueRefresh').timeBased().after(60 * 1000).create();
}

function writeLog_(kind, detail) {
  const ss = SpreadsheetApp.getActiveSpreadsheet();
  const sh = ss.getSheetByName(SHEET_LOG) || ensureSheet_(ss, SHEET_LOG, HEAD_LOG, true);
  sh.insertRowBefore(2);
  sh.getRange(2, 1, 1, 3).setValues([[Utilities.formatDate(new Date(), TIMEZONE, 'yyyy-MM-dd HH:mm:ss'), kind.slice(0, 50), detail.slice(0, 200)]]);
}
