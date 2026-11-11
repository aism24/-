/**
 * 「鳥取工場 生産状況周知」のGAS APIバックエンド。
 *
 * 新しいスプレッドシート「鳥取工場生産状況周知」の「拡張機能 → Apps Script」に貼り付けて使う
 * コンテナバインド型スクリプトです。画面(index.html / app.js)は Vercel・GitHub で配信する静的ページで、
 * このGASは JSON API と、案件マスターの読み取り・一覧の作成だけを行います。
 *
 * ■ 作るもの(鳥取の行だけ)
 *   前日出来高 : 案件マスターの「加工」列の日付が「前の営業日」の行
 *   遅れリスト : 「備考①」列に日付があり(=生産予定日)、その日付が今日より前で、「加工」列に日付が無い行。
 *               ただし生産予定日が2か月より前の行は出さない(2か月過ぎたものは出荷まで完了済み。加工日の記入漏れなので。2026-11-11 ユーザー指定)
 *               遅れ日数 = 生産予定日の翌日から今日までの「出勤」日の数(営業日。2026-11-11 ユーザー指定で暦日から変更)
 *   「前の営業日」は、索引スプレッドシートの会社カレンダー(I列=日付、J列=出勤/休日)で決める。
 *
 * ■ 読むもの(書き込みは一切しない)
 *   索引スプレッドシート「Excelマスタ一覧」(生産管理ダッシュボードと同じもの)。IDは「情報」シートの
 *   「索引スプレッドシート」の行に、URLかIDを貼る(公開リポジトリにIDを書かないため)。
 *   A〜E列=案件マスターの一覧(工事名はD列のファイル名から拡張子を除いたもの)、I・J列=会社カレンダー。
 *   案件マスターは列の見出し(加工先・製品マーク・図番・重量・備考①・加工)で列を探す。
 *   Excelは一時的にスプレッドシートへ変換して読み、読み終えたらすぐ削除する。元のExcelには触れない。
 *   元ファイルの更新日時が前回と同じなら読み直さない(「状態」シートで管理)。
 *
 * ■ シート(setupSheets で作る)
 *   情報(項目名・値)/ 前日出来高 / 遅れリスト / 取込データ(非表示)/ 状態(非表示)/ 利用記録(非表示)
 *
 * セットアップ手順は README.md を参照してください。
 */

const CODE_VERSION = '2026-11-11j';
const LATE_WINDOW_MONTHS = 2; // 遅れリストに出す生産予定日の範囲(今日から何か月前まで)
const TIMEZONE = 'Asia/Tokyo';
const TARGET_SITE_DEFAULT = '鳥取';
const IGNORE_WORK_NO = '00-00';
const PARSE_VERSION = 4; // v2: 部位・本数を追加、v3: 日付の無い鳥取の行も持つ(週間予定表との突き合わせ用)、v4: マスターの行番号(2026-11-11) // 取込データの形を変えたら上げる(全ファイルを読み直す)
const TIME_BUDGET_MS = 240 * 1000; // 1回の実行で案件マスターを読む時間の上限(6分制限の手前)
const TEMP_PREFIX = '_鳥取周知_一時変換_';

const SHEET_INFO = '情報';
const SHEET_YESTERDAY = '前日出来高';
const SHEET_LATE = '遅れリスト';
const SHEET_DATA = '取込データ';
const SHEET_STATE = '状態';
const SHEET_LOG = '利用記録';
const SHEET_PDFLOG = '記録'; // 加工結果PDFの取込記録(見出し「日時」「取込ファイル名」はユーザーが用意。2026-11-11)
const SHEET_PLAN = '予定表';
const SHEET_ABBR = '略称'; // 週間予定表の件名(略称。例: ITM)→ 工事番号(例: 26-16)。画面で選んで保存する

const INFO_INDEX = '索引スプレッドシート';
const INFO_SITE = '対象拠点';
const INFO_BASE = '基準日';
const INFO_PREV = '前の営業日';
const INFO_UPDATED = '最終更新';
const INFO_PENDING = '未取込の案件';
const INFO_WARN = '注意';
const INFO_PLAN = '予定表の概要';

const HEAD_YESTERDAY = ['物件名', '製品名', '図番', '重量(t)', '生産日', '部位', '数量', '工事番号'];
const HEAD_LATE = ['物件名', '製品名', '図番', '重量(t)', '生産予定日', '遅れ日数(営業日)', '部位', '数量', '工事番号'];
const HEAD_ABBR = ['略称', '工事番号'];
// 加工結果PDFの「鳥取工場MM.DD結果重量」の表(加工済みのはずの製品)。マスターに加工日が入っているかの確認に使う
const SHEET_RESULT = '加工結果';
const HEAD_RESULT = ['物件名', '製品名', '加工日', '読込日時', 'ファイル名'];
const HEAD_DATA = ['ファイルID', '工事番号', '工事名', '製品名', '図番', '重量(t)', '生産予定日', '生産日', '部位', '本数', '行番号'];
const PART_ORDER = ['柱', '大梁', '小梁']; // 一覧の並び: 物件名 → 部位(柱→大梁→小梁→その他) → 案件マスターの行の順
const HEAD_STATE = ['ファイルID', '工事番号', 'ファイル名', '元ファイル更新日時', '取込日時', '鳥取の行数', '形式', 'エラー'];
const HEAD_LOG = ['日時', '種別', '内容'];
// 週間予定表(加工結果PDFの「鳥取工場 加工予定表」)から読み込んだ予定。物件名+製品名ごとに1行(新しく読み込んだ予定日で上書き)
const HEAD_PLAN = ['物件名', '製品名', '図番', '予定日', '数量', '重量(t)', '読込日時', 'ファイル名'];

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
// 週間予定表の読み込み(action=schedule。画面がPDFから読み取った行を送ってくる)もここで受ける
function doPost(e) {
  let body = {};
  try { body = JSON.parse((e && e.postData && e.postData.contents) || '{}'); } catch (x) { body = {}; }
  if (body.action === 'schedule' || body.action === 'mapNames') {
    try {
      return json_(body.action === 'schedule' ? saveSchedule_(body) : saveAbbr_(body));
    } catch (err) {
      return json_({ status: 'error', version: CODE_VERSION, message: String(err && err.message || err) });
    }
  }
  try {
    if (body.action === 'log') writeLog_(String(body.kind || ''), String(body.detail || ''));
  } catch (err) {
    // 記録の失敗は無視する
  }
  return json_({ status: 'success' });
}

// 週間予定表の行を「予定表」シートへ保存し(物件名+製品名が同じ行は新しい予定日で上書き)、一覧を作り直して返す
function saveSchedule_(body) {
  const items = (body.items || []).filter(function (x) { return x && x.mark && normalizeKey_(x.date); });
  if (!items.length) throw new Error('予定表の行がありません');
  const lock = LockService.getScriptLock();
  if (!lock.tryLock(150000)) throw new Error('他の更新が終わらないため、受け付けられませんでした。1〜2分後にもう一度送ってください。');
  try {
    const ss = SpreadsheetApp.getActiveSpreadsheet();
    const sh = ss.getSheetByName(SHEET_PLAN) || ensureSheet_(ss, SHEET_PLAN, HEAD_PLAN, false);
    const map = {}, keys = [];
    readTableRows_(sh, HEAD_PLAN.length).forEach(function (r) {
      const k = String(r[0]) + '\t' + String(r[1]);
      if (!map[k]) keys.push(k);
      map[k] = [String(r[0]), String(r[1]), String(r[2]), normalizeKey_(r[3]), qty_(r[4]), Number(r[5]) || 0, String(r[6]), String(r[7])];
    });
    const now = Utilities.formatDate(new Date(), TIMEZONE, 'yyyy-MM-dd HH:mm:ss'); // 秒まで(「最後に読み込んだ予定表」を見分けるため)
    const fileName = String(body.fileName || '').slice(0, 100);
    items.forEach(function (x) {
      const k = String(x.name || '') + '\t' + String(x.mark);
      if (!map[k]) keys.push(k);
      map[k] = [String(x.name || ''), String(x.mark), String(x.drawing || ''), normalizeKey_(x.date), qty_(x.qty), Number(x.weight) || 0, now, fileName];
    });
    writeTable_(sh, HEAD_PLAN, keys.map(function (k) { return map[k]; }), [0, 1, 2, 3, 6, 7]);
    // 加工結果の表(あれば)を保存して、マスターに加工日が入っているか確かめる
    const results = (body.results || []).filter(function (x) { return x && x.mark; });
    if (results.length) {
      const rsh = ss.getSheetByName(SHEET_RESULT) || ensureSheet_(ss, SHEET_RESULT, HEAD_RESULT, true);
      writeTable_(rsh, HEAD_RESULT, results.map(function (x) { return [String(x.name || ''), String(x.mark), normalizeKey_(x.date), now, fileName]; }), [0, 1, 2, 3, 4]);
    }
    writePdfRecord_(ss, now, fileName);
    const info = ss.getSheetByName(SHEET_INFO);
    // 予定表に出てくる工事のファイルを読む(更新日時が変わっていなければ読み直さない)
    runRefresh_();
    let built = rebuildFromSheets_(ss, info); // 予定表が変わったので一覧は必ず作り直す(ファイルに変更が無いと runRefresh_ は保存済みの一覧を返すため)
    // このPDFに加工結果の表があるときだけ確かめる(前回のPDFの結果で、何度もポップアップを出さない)
    const check = results.length ? checkResultsWithReread_(ss, info) : { result: null, built: null };
    built = check.built || built;
    return { status: 'success', version: CODE_VERSION, saved: items.length, resultCheck: check.result, data: toPayload_(built) };
  } finally {
    lock.releaseLock();
  }
}

// 予定表の件名(略称)に対応するファイルだけを選ぶ: ① 略称シートの工事番号のファイル ② ファイル名(拡張子なし)が略称と同じファイル
// ②で結び付いた略称は、画面で選ばなくても使えるように自動の対応として控える
function targetFiles_(fileIndex, planRows, abbr) {
  const names = {};
  (planRows || []).forEach(function (p) { if (p[0]) names[p[0]] = true; });
  const auto = {}, picked = {}, out = [];
  fileIndex.forEach(function (f) {
    const base = workName_(f);
    const byAbbr = Object.keys(names).some(function (n) { return abbr[n] && abbr[n] === f.workNo; });
    const byName = !!names[base];
    if (byName && !abbr[base]) auto[base] = f.workNo;
    if ((byAbbr || byName) && !picked[f.fileId]) { picked[f.fileId] = true; out.push(f); }
  });
  try { PropertiesService.getScriptProperties().setProperty('AUTOABBR', JSON.stringify(auto)); } catch (e) { /* 控えられなくても続ける */ }
  return out;
}

// 略称の対応(画面で選んだもの + ファイル名が同じで自動で結び付いたもの)
function effectiveAbbr_(ss) {
  let auto = {};
  try { auto = JSON.parse(PropertiesService.getScriptProperties().getProperty('AUTOABBR') || '{}'); } catch (e) { auto = {}; }
  return Object.assign({}, auto, readAbbr_(ss));
}

// 加工結果(PDFの結果重量の表)とマスターの加工日を照らし合わせる(2026-11-11 ユーザー指定)
// ① 加工日の無い製品があれば、その工事の案件マスターだけを更新日時に関係なく読み直す(作業用データが古い場合)
// ② もう一度照らし合わせる ③ それでも無ければ、画面が「マスターデータに日付が入ってません」(製品名|行数)を出す
function checkResultsWithReread_(ss, info) {
  const sh = ss.getSheetByName(SHEET_RESULT);
  const results = sh ? readTableRows_(sh, HEAD_RESULT.length).map(function (r) { return { name: String(r[0]), mark: String(r[1]), date: normalizeKey_(r[2]) }; }).filter(function (x) { return x.mark; }) : [];
  if (!results.length) return { result: null, built: null };
  const abbr = effectiveAbbr_(ss);
  let allRows = readTableRows_(ss.getSheetByName(SHEET_DATA), HEAD_DATA.length);
  let miss = findMissingDates_(allRows, results, abbr);
  let reread = 0, built = null;
  if (miss.length) {
    // 読み直す工事: 略称の工事番号のファイル、または見つかった行のファイル
    const indexId = extractId_(readInfo_(info, INFO_INDEX));
    const files = indexId ? readFileIndex_(readIndexRows_(indexId)) : [];
    const force = {};
    miss.forEach(function (m) {
      if (m.fileId) force[m.fileId] = true;
      const no = abbr[m.name];
      if (no) files.forEach(function (f) { if (f.workNo === no) force[f.fileId] = true; });
    });
    reread = Object.keys(force).length;
    if (reread) {
      built = toBuilt_(runRefresh_(force));
      allRows = readTableRows_(ss.getSheetByName(SHEET_DATA), HEAD_DATA.length);
      miss = findMissingDates_(allRows, results, abbr);
    }
  }
  return { result: { date: results[0].date, checked: results.length, reread: reread, missing: miss.map(function (m) { return { name: m.name, mark: m.mark, row: m.row, file: m.file }; }) }, built: built };
}

// runRefresh_ の戻り値(画面用の形)を、rebuildFromSheets_ と同じ形として扱う
function toBuilt_(r) { return r && r.data ? r.data : null; }

// 加工結果の製品のうち、マスターに加工日が入っていないもの(見つからないものも含む)
function findMissingDates_(allRows, results, abbr) {
  const byWorkMark = {}, byMark = {};
  allRows.forEach(function (r, i) {
    (byWorkMark[String(r[1]) + '\t' + String(r[3])] = byWorkMark[String(r[1]) + '\t' + String(r[3])] || []).push(i);
    (byMark[String(r[3])] = byMark[String(r[3])] || []).push(i);
  });
  const out = [];
  results.forEach(function (x) {
    const no = abbr[x.name];
    const cands = no ? (byWorkMark[no + '\t' + x.mark] || []) : (byMark[x.mark] || []);
    if (cands.some(function (j) { return normalizeKey_(allRows[j][7]); })) return;
    const m = cands.length ? allRows[cands[0]] : null;
    out.push({ name: x.name, mark: x.mark, row: m ? (Number(m[10]) || '') : '', file: m ? String(m[2]) : '', fileId: m ? String(m[0]) : '' });
  });
  return out;
}

// 略称 → 工事番号 の対応を保存して(同じ略称は上書き)、一覧を作り直して返す
function saveAbbr_(body) {
  const map = body.map || {};
  const lock = LockService.getScriptLock();
  lock.waitLock(120000);
  try {
    const ss = SpreadsheetApp.getActiveSpreadsheet();
    const sh = ss.getSheetByName(SHEET_ABBR) || ensureSheet_(ss, SHEET_ABBR, HEAD_ABBR, false);
    const cur = readAbbr_(ss);
    Object.keys(map).forEach(function (k) {
      const a = String(k).trim(), no = String(map[k] || '').trim();
      if (!a) return;
      if (no) cur[a] = no; else delete cur[a];
    });
    writeTable_(sh, HEAD_ABBR, Object.keys(cur).sort().map(function (a) { return [a, cur[a]]; }), [0, 1]);
    const info = ss.getSheetByName(SHEET_INFO);
    runRefresh_(); // 略称が変わると読むファイルも変わる
    let built = rebuildFromSheets_(ss, info);
    const check = checkResultsWithReread_(ss, info);
    built = check.built || built;
    return { status: 'success', version: CODE_VERSION, resultCheck: check.result, data: toPayload_(built) };
  } finally {
    lock.releaseLock();
  }
}

function readAbbr_(ss) {
  const sh = ss.getSheetByName(SHEET_ABBR);
  const map = {};
  if (!sh) return map;
  readTableRows_(sh, HEAD_ABBR.length).forEach(function (r) { const a = String(r[0]).trim(), no = String(r[1]).trim(); if (a && no) map[a] = no; });
  return map;
}

// 索引のG・H列(工事番号→工事名)。画面の選択肢と表示に使うので、作り直すたびにスクリプトのプロパティへ控えておく
function saveWorkList_(indexRows) {
  const seen = {}, list = [];
  indexRows.forEach(function (row) {
    const no = String(row[6] || '').trim(), name = String(row[7] || '').trim();
    if (no && !seen[no]) { seen[no] = true; list.push([no, name]); }
  });
  list.sort(function (a, b) { return a[0] < b[0] ? 1 : a[0] > b[0] ? -1 : 0; }); // 新しい工事番号を上に
  try { PropertiesService.getScriptProperties().setProperty('WORKLIST', JSON.stringify(list)); } catch (e) { /* 控えられなくても続ける */ }
  return list;
}

// 取込データ・予定表・会社カレンダーから一覧だけ作り直す(案件マスターは読まない)
function rebuildFromSheets_(ss, info) {
  const indexId = extractId_(readInfo_(info, INFO_INDEX));
  if (!indexId) throw new Error('「' + SHEET_INFO + '」シートの「' + INFO_INDEX + '」が空です。');
  const indexRows = readIndexRows_(indexId);
  saveWorkList_(indexRows);
  const calendar = readCalendar_(indexRows);
  const allRows = readTableRows_(ss.getSheetByName(SHEET_DATA), HEAD_DATA.length);
  const built = buildLists_(allRows, calendar, todayKey_(), readPlanRows_(ss), effectiveAbbr_(ss));
  built.warnings = splitWarn_(readInfo_(info, INFO_WARN)).filter(function (w) { return w.indexOf('会社カレンダー') < 0 && w.indexOf('予定表の製品') < 0 && w.indexOf('略称') < 0; }).concat(built.warnings);
  built.pending = Number(readInfo_(info, INFO_PENDING)) || 0;
  built.updatedAt = String(readInfo_(info, INFO_UPDATED) || '');
  writeOutputs_(ss, info, built);
  return built;
}

function readPlanRows_(ss) {
  const sh = ss.getSheetByName(SHEET_PLAN);
  if (!sh) return [];
  return readTableRows_(sh, HEAD_PLAN.length).map(function (r) { return [String(r[0]), String(r[1]), String(r[2]), normalizeKey_(r[3]), qty_(r[4]), Number(r[5]) || 0, String(r[6]), String(r[7])]; });
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
  ensureSheet_(ss, SHEET_PLAN, HEAD_PLAN, false);
  ensureSheet_(ss, SHEET_ABBR, HEAD_ABBR, false);
  ensureSheet_(ss, SHEET_RESULT, HEAD_RESULT, true);
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
// 備考①(予定日)などは担当者がいつでも書き換えるため、毎朝6時ごろに加えて1時間ごとにも確認する
// (更新日時が変わった案件マスターだけ読むので、変更が無ければ数秒で終わる)。画面を開いたときにも確認する(app.js)。
function createDailyTrigger() {
  ScriptApp.getProjectTriggers().forEach(function (t) {
    const fn = t.getHandlerFunction();
    if (fn === 'dailyRefresh' || fn === 'hourlyRefresh') ScriptApp.deleteTrigger(t);
  });
  ScriptApp.newTrigger('dailyRefresh').timeBased().atHour(6).nearMinute(0).everyDays(1).inTimezone(TIMEZONE).create();
  ScriptApp.newTrigger('hourlyRefresh').timeBased().everyHours(1).create();
}

// 手動で今すぐ更新する(初回の取り込みにも使う)。読み切れなかった案件は1分後に自動で続きを読む。
function refreshNow() {
  const r = runRefreshLocked_(true);
  Logger.log(JSON.stringify({ status: r.status, pending: r.pending, yesterday: r.data && r.data.yesterday.length, late: r.data && r.data.late.length, warnings: r.data && r.data.warnings }));
}

function dailyRefresh() { runRefreshLocked_(true); }
function hourlyRefresh() { runRefreshLocked_(false); } // 他の更新中なら今回は見送る
function continueRefresh() { runRefreshLocked_(true); }

// ========== 更新の本体 ==========

function userRefresh_() {
  const lock = LockService.getScriptLock();
  if (!lock.tryLock(3000)) return { status: 'busy', message: '他の人がデータを更新中です。少し待ってからもう一度押してください。' };
  try {
    const r = runRefresh_();
    return { status: 'success', version: CODE_VERSION, pending: r.pending, changed: r.changed, data: r.data };
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
// force: 更新日時に関係なく読み直すファイルID({id: true})。加工結果の確認で、食い違った工事だけ読み直すときに使う
function runRefresh_(force) {
  force = force || {};
  const started = Date.now();
  const ss = SpreadsheetApp.getActiveSpreadsheet();
  const info = ss.getSheetByName(SHEET_INFO);
  if (!info) throw new Error('「' + SHEET_INFO + '」シートがありません。Apps Scriptエディタで setupSheets を実行してください。');
  const indexId = extractId_(readInfo_(info, INFO_INDEX));
  if (!indexId) throw new Error('「' + SHEET_INFO + '」シートの「' + INFO_INDEX + '」が空です。索引スプレッドシート「Excelマスタ一覧」のURLを貼ってください。');
  const site = String(readInfo_(info, INFO_SITE) || TARGET_SITE_DEFAULT).trim();

  const indexRows = readIndexRows_(indexId);
  // 読むのは、予定表に出てくる工事(略称 → 工事番号、またはファイル名が略称と同じ)のファイルだけ(2026-11-11 ユーザー指定。全36件を読むと数分かかるため)
  const fileIndex = targetFiles_(readFileIndex_(indexRows), readPlanRows_(ss), readAbbr_(ss));
  const calendar = readCalendar_(indexRows);

  const stateSh = ss.getSheetByName(SHEET_STATE);
  const dataSh = ss.getSheetByName(SHEET_DATA);
  const state = readState_(stateSh); // fileId -> {mtime, importedAt, ...}

  const warnings = [];
  const folder = getOwnFolder_(ss);
  const parsed = {}; // 今回読み直した案件: fileId -> 行(null=失敗で前回の取込データを残す)
  // 取込が古い順(未取込が先)に、時間の許す範囲で読む。更新日時が前回と同じ案件は読まない。
  const order = fileIndex.slice().sort(function (a, b) {
    const sa = state[a.fileId], sb = state[b.fileId];
    return (sa ? sa.importedAt : 0) - (sb ? sb.importedAt : 0);
  });
  let pending = 0, changed = 0;
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
    if (!force[entry.fileId] && st && st.mtime === mtime && st.version === PARSE_VERSION && !st.error && st.workNo === entry.workNo) return; // 変更なし
    if (Date.now() - started > TIME_BUDGET_MS) { pending++; return; }
    changed++;
    let rows = [], error = '';
    try {
      rows = readMasterRows_(entry, file, folder, site);
    } catch (err) {
      error = String(err && err.message || err);
      warnings.push('「' + entry.fileName + '」(' + entry.workNo + ')の読み込みに失敗しました: ' + error);
      rows = st ? null : []; // 失敗時は前回の取込データを残す
    }
    parsed[entry.fileId] = rows ? rows.map(function (r) {
      return [entry.fileId, entry.workNo, '', r.mark, r.drawing, r.weight, r.plan || '', r.done || '', r.part, r.qty, r.row];
    }) : null;
    state[entry.fileId] = { fileId: entry.fileId, workNo: entry.workNo, fileName: entry.fileName, mtime: mtime, importedAt: Date.now(), count: rows ? rows.length : (st ? st.count : 0), version: PARSE_VERSION, error: error };
  });

  const live = {};
  fileIndex.forEach(function (e) { live[e.fileId] = e; });
  const removed = Object.keys(state).filter(function (id) { return !live[id]; });
  removed.forEach(function (id) { delete state[id]; });
  // 工事名=索引D列のファイル名(拡張子なし。2026-11-11 ユーザー指定)。変わったかは前回と比べて判断する
  const namesSig = JSON.stringify(fileIndex.map(function (e) { return e.fileId + '=' + workName_(e); }));
  const props = PropertiesService.getScriptProperties();
  const namesChanged = props.getProperty('WORKNAMES_SIG') !== namesSig;

  const today = todayKey_();
  const now = Utilities.formatDate(new Date(), TIMEZONE, 'yyyy-MM-dd HH:mm');
  const prevPending = Number(readInfo_(info, INFO_PENDING)) || 0;
  const prevWarn = splitWarn_(readInfo_(info, INFO_WARN)).filter(function (w) { return w.indexOf('読み込みに失敗') >= 0 || w.indexOf('開けませんでした') >= 0 || w.indexOf('読み切れなかった') >= 0; });
  // 何も変わっていない(案件マスター・工事名・日付・前回の未取込/失敗なし)ときは、取込データを読み書きせずに返す
  if (!changed && !pending && !removed.length && !namesChanged && !prevPending && !prevWarn.length && !warnings.length && normalizeKey_(readInfo_(info, INFO_BASE)) === today) {
    writeInfo_(info, INFO_UPDATED, "'" + now);
    scheduleContinue_(false);
    return { pending: 0, changed: 0, data: readPayloadFromSheets_(ss, info) };
  }

  const dataByFile = readDataByFile_(dataSh); // fileId -> rows(配列)
  Object.keys(parsed).forEach(function (id) { if (parsed[id]) dataByFile[id] = parsed[id]; });
  Object.keys(dataByFile).forEach(function (id) { if (!live[id]) delete dataByFile[id]; }); // 索引から消えた案件

  // 工事名は毎回、索引の最新のファイル名(D列)で付け直す
  const allRows = [];
  Object.keys(dataByFile).forEach(function (id) {
    dataByFile[id].forEach(function (r) {
      r[2] = live[id] ? workName_(live[id]) : r[2];
      allRows.push(r);
    });
  });
  if (changed || removed.length || namesChanged) writeTable_(dataSh, HEAD_DATA, allRows, [0, 1, 2, 3, 4, 6, 7, 8]);
  writeState_(stateSh, state);
  props.setProperty('WORKNAMES_SIG', namesSig);

  saveWorkList_(indexRows);
  const built = buildLists_(allRows, calendar, today, readPlanRows_(ss), effectiveAbbr_(ss));
  if (pending > 0) warnings.push('時間内に読み切れなかった案件が' + pending + '件あります。1分後に自動で続きを読みます。');
  built.warnings = warnings.concat(built.warnings);
  built.pending = pending;
  built.updatedAt = now;
  writeOutputs_(ss, info, built);
  scheduleContinue_(pending > 0);
  return { pending: pending, changed: changed, data: toPayload_(built) };
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
          return toPayload_(rebuildFromSheets_(ss, info));
        }
      } finally {
        lock.releaseLock();
      }
    }
  }
  return readPayloadFromSheets_(ss, info);
}

// ========== 一覧づくり(純粋な計算。テストで直接呼ぶ) ==========

// allRows: 取込データの行 [ファイルID, 工事番号, 物件名, 製品名, 図番, 重量, 備考①, 加工日, 部位, 本数](日付は'yyyy-MM-dd')
// planRows: 予定表の行 [物件名, 製品名, 図番, 予定日, 数量, 重量, 読込日時, ファイル名]
// calendar: {'yyyy-MM-dd': true(出勤)/false(休日)}  today: 'yyyy-MM-dd'
// 前日出来高 = 加工日が前の営業日の行。
// 生産遅れ  = 予定表で予定日が今週より前(今週の月曜より前、2か月以内)なのに、案件マスターに加工日が無い製品
//             (今週の予定は遅れにしない。先週までの予定の取り残し=「先週の漏れ」を遅れとする。2026-11-11 ユーザー指定)
//             (備考①は加工予定日とは限らないため使わない。2026-11-11 ユーザー指定)
function buildLists_(allRows, calendar, today, planRows, abbr) {
  abbr = abbr || {};
  const prev = prevBusinessDay_(calendar, today);
  const lateFrom = lateCutoff_(today);
  const lateBefore = weekStart_(today);
  const yesterday = [], late = [];
  // 工事番号 → 略称(表示用。同じ工事番号に略称が複数あれば、名前順で最初のもの)
  const rev = {};
  Object.keys(abbr).sort().forEach(function (a) { if (!rev[abbr[a]]) rev[abbr[a]] = a; });
  const byWorkMark = {}, byMark = {};
  allRows.forEach(function (r, i) {
    const done = normalizeKey_(r[7]), no = String(r[1]);
    if (done && done === prev.key) yesterday.push([rev[no] || r[2], r[3], r[4], Number(r[5]) || 0, done, r[8] || '', qty_(r[9]), no, i]);
    (byWorkMark[no + '\t' + String(r[3])] = byWorkMark[no + '\t' + String(r[3])] || []).push(i);
    (byMark[String(r[3])] = byMark[String(r[3])] || []).push(i);
  });
  const lateDays = {}; // 予定日 -> 遅れ日数(同じ予定日は1回だけ数える)
  let missingCal = '', notFound = 0;
  const unmapped = {};
  (planRows || []).forEach(function (p) {
    const plan = normalizeKey_(p[3]);
    if (!plan || plan >= lateBefore || plan < lateFrom) return;
    // 案件マスターの行を探す: 略称→工事番号+製品名(同じ工事番号の全ファイル)。略称が未設定なら、製品名(+図番)で1件に決まるときだけ
    const no = abbr[p[0]];
    let cands;
    if (no) cands = byWorkMark[no + '\t' + p[1]] || [];
    else {
      unmapped[p[0]] = true;
      cands = byMark[p[1]] || [];
      if (cands.length > 1) cands = cands.filter(function (j) { return String(allRows[j][4]) === String(p[2]); });
      if (cands.length > 1) cands = [];
    }
    if (!cands.length) notFound++;
    if (cands.some(function (j) { return normalizeKey_(allRows[j][7]); })) return; // 加工済み
    const m = cands.length ? allRows[cands[0]] : null;
    if (!(plan in lateDays)) {
      const c = businessDaysAfter_(calendar, plan, today);
      lateDays[plan] = c.days;
      if (c.missing && (!missingCal || c.missing < missingCal)) missingCal = c.missing;
    }
    late.push([p[0], p[1], m ? m[4] : p[2], m ? (Number(m[5]) || 0) : (Number(p[5]) || 0), plan, lateDays[plan], m ? (m[8] || '') : '', m ? qty_(m[9]) : qty_(p[4]), no || (m ? String(m[1]) : ''), m ? cands[0] : allRows.length]);
  });
  // 並び(見本のPDFと同じ、2026-11-11 ユーザー指定): 物件名 → 部位(柱→大梁→小梁→その他)→ 案件マスターの行の順
  const byText = function (a, b) { return a < b ? -1 : a > b ? 1 : 0; };
  const rank = function (p) { const i = PART_ORDER.indexOf(p); return i < 0 ? PART_ORDER.length : i; };
  const order = function (pi, ii) { return function (a, b) { return byText(a[0], b[0]) || (rank(a[pi]) - rank(b[pi])) || (a[ii] - b[ii]); }; };
  stableSort_(yesterday, order(5, 8));
  stableSort_(late, order(6, 9));
  const warnings = prev.warning ? [prev.warning] : [];
  if (missingCal) warnings.push('会社カレンダー(索引スプレッドシートのI・J列)に ' + missingCal.replace(/-/g, '/') + ' などがありません。遅れ日数(営業日)は、カレンダーに無い日を土日休みとみなして数えました。');
  const um = Object.keys(unmapped);
  if (um.length) warnings.push('略称「' + um.join('」「') + '」の工事番号が未設定です。画面の「略称の対応」で選んでください。');
  if (notFound) warnings.push('予定表の製品のうち ' + notFound + ' 件が案件マスター(鳥取)に見つかりませんでした。加工済みか判定できないため、遅れとして表示しています。');
  return {
    baseDate: today,
    prevDate: prev.key,
    yesterday: yesterday.map(function (r) { return r.slice(0, 8); }),
    late: late.map(function (r) { return r.slice(0, 9); }),
    warnings: warnings,
    plan: planCoverage_(planSummary_(planRows), planRows, calendar, lateBefore, prev.key),
  };
}

// 画面の「略称の対応」用: 略称の対応表・工事番号の一覧(索引G・H列)・未設定の略称
function payloadExtras_() {
  const ss = SpreadsheetApp.getActiveSpreadsheet();
  const abbr = effectiveAbbr_(ss);
  let workList = [];
  try { workList = JSON.parse(PropertiesService.getScriptProperties().getProperty('WORKLIST') || '[]'); } catch (e) { workList = []; }
  const unknown = {};
  readPlanRows_(ss).forEach(function (p) { if (p[0] && !abbr[p[0]]) unknown[p[0]] = true; });
  return { abbr: abbr, workList: workList, unknown: Object.keys(unknown).sort() };
}

// 予定表の概要(画面に「読み込んだ予定表」として出す)
function planSummary_(planRows) {
  const rows = planRows || [];
  const last = rows.reduce(function (a, p) { return String(p[6]) > a[0] ? [String(p[6]), String(p[7])] : a; }, ['', '']);
  const latest = rows.filter(function (p) { return String(p[6]) === last[0]; }).map(function (p) { return normalizeKey_(p[3]); }).filter(Boolean).sort();
  return { count: rows.length, loadedAt: last[0], fileName: last[1], from: latest[0] || '', to: latest[latest.length - 1] || '' };
}

// 今週(月曜〜前の営業日)の出勤日のうち、最後に読み込んだ予定表に無い日(=予定通り完了したとみなす日)を添える
// 例: 11/11(水)に 11/2〜11/6 の予定表を読み込んだ → ['2026-11-09', '2026-11-10']
function planCoverage_(sum, planRows, calendar, weekStart, prevKey) {
  if (!sum.count) { sum.missing = []; return sum; }
  const dates = {};
  (planRows || []).forEach(function (p) { if (String(p[6]) === sum.loadedAt) dates[normalizeKey_(p[3])] = true; });
  const missing = [];
  for (let d = keyToUtc_(weekStart); prevKey && d <= keyToUtc_(prevKey); d += 86400000) {
    const k = utcToKey_(d);
    const work = Object.prototype.hasOwnProperty.call(calendar, k) ? calendar[k] : (new Date(d).getUTCDay() % 6 !== 0);
    if (work && !dates[k]) missing.push(k);
  }
  sum.missing = missing;
  return sum;
}

// 今週の月曜日('yyyy-MM-dd')。例: 2026-11-11(水) → 2026-11-09
function weekStart_(today) {
  const t = keyToUtc_(today);
  const wd = new Date(t).getUTCDay(); // 0=日
  return utcToKey_(t - ((wd + 6) % 7) * 86400000);
}

function qty_(v) { return v === '' || v == null || isNaN(Number(v)) ? '' : Number(v); }

// 同じ順位の行は元の順を保つ並べ替え
function stableSort_(arr, cmp) {
  const idx = arr.map(function (v, i) { return [v, i]; });
  idx.sort(function (a, b) { return cmp(a[0], b[0]) || (a[1] - b[1]); });
  idx.forEach(function (x, i) { arr[i] = x[0]; });
  return arr;
}

// 前の営業日: 今日より前で、会社カレンダーが「出勤」の最も近い日。
// カレンダーに無い日に当たったら、土日を休みとみなして続け、注意を出す。
// 遅れリストに出す生産予定日の下限: 今日のちょうど LATE_WINDOW_MONTHS か月前の日(その日を含む)。
// 例: 11/11 → 9/11。その月に同じ日が無ければ月末(4/30 → 2/28)。
function lateCutoff_(today) {
  const p = today.split('-').map(Number);
  let y = p[0], m = p[1] - LATE_WINDOW_MONTHS;
  while (m < 1) { m += 12; y--; }
  const last = new Date(Date.UTC(y, m, 0)).getUTCDate();
  return y + '-' + pad2_(m) + '-' + pad2_(Math.min(p[2], last));
}

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

// 遅れ日数(営業日): 生産予定日の翌日から今日まで(今日を含む)の「出勤」日の数。
// 例: 予定 11/6(金)・今日 11/9(月) → 1。カレンダーに無い日は土日を休みとみなし、その最初の日を missing で返す。
function businessDaysAfter_(calendar, planKey, todayKey) {
  const end = keyToUtc_(todayKey);
  let days = 0, missing = '';
  for (let d = keyToUtc_(planKey) + 86400000; d <= end; d += 86400000) {
    const key = utcToKey_(d);
    if (Object.prototype.hasOwnProperty.call(calendar, key)) {
      if (calendar[key]) days++;
    } else {
      if (!missing) missing = key;
      const wd = new Date(d).getUTCDay();
      if (wd !== 0 && wd !== 6) days++;
    }
  }
  return { days: days, missing: missing };
}
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
  const need = [col.site, col.mark, col.drawing, col.weight, col.plan, col.done, col.part, col.qty].filter(function (c) { return c >= 0; });
  const width = Math.max.apply(null, need) + 1;
  return parseMasterRows_(header, sheet.getRange(2, 1, lastRow - 1, width).getValues(), site);
}

function findColumns_(header) {
  const h = header.map(function (x) { return String(x == null ? '' : x).trim(); });
  const col = { site: h.indexOf('加工先'), mark: h.indexOf('製品マーク'), drawing: h.indexOf('図番'), weight: h.indexOf('重量'), plan: h.indexOf('備考①'), done: h.indexOf('加工'), part: h.indexOf('部位'), qty: h.indexOf('本数') };
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
    out.push({
      mark: col.mark >= 0 ? String(row[col.mark] == null ? '' : row[col.mark]).trim() : '',
      part: col.part >= 0 ? String(row[col.part] == null ? '' : row[col.part]).trim() : '',
      qty: col.qty >= 0 && row[col.qty] !== '' && !isNaN(Number(row[col.qty])) ? Number(row[col.qty]) : '',
      drawing: col.drawing >= 0 ? String(row[col.drawing] == null ? '' : row[col.drawing]).trim() : '',
      weight: col.weight >= 0 ? (Number(row[col.weight]) || 0) : 0,
      plan: plan,
      done: done,
      row: i + 2, // マスターの行番号(1行目が見出し)
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

// 画面・Excelに出す工事名: 索引D列のファイル名から拡張子を除いたもの(例: 「OSR.xlsx」→「OSR」)
function workName_(entry) { return stripExt_(entry.fileName); }

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
    (map[id] = map[id] || []).push([id, String(r[1]), String(r[2]), String(r[3]), String(r[4]), Number(r[5]) || 0, normalizeKey_(r[6]), normalizeKey_(r[7]), String(r[8] == null ? '' : r[8]), r[9] === '' || r[9] == null ? '' : Number(r[9]), Number(r[10]) || '']);
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
  writeTable_(ss.getSheetByName(SHEET_YESTERDAY), HEAD_YESTERDAY, built.yesterday, [0, 1, 2, 4, 5, 7]);
  writeTable_(ss.getSheetByName(SHEET_LATE), HEAD_LATE, built.late, [0, 1, 2, 4, 6, 8]);
  writeInfo_(info, INFO_BASE, "'" + built.baseDate);
  writeInfo_(info, INFO_PREV, "'" + built.prevDate);
  writeInfo_(info, INFO_UPDATED, "'" + built.updatedAt);
  writeInfo_(info, INFO_PENDING, built.pending || 0);
  writeInfo_(info, INFO_WARN, built.warnings.join('\n'));
  writeInfo_(info, INFO_PLAN, "'" + JSON.stringify(built.plan || null));
}

function readPayloadFromSheets_(ss, info) {
  const y = readTableRows_(ss.getSheetByName(SHEET_YESTERDAY), HEAD_YESTERDAY.length).map(function (r) { return [String(r[0]), String(r[1]), String(r[2]), Number(r[3]) || 0, normalizeKey_(r[4]), String(r[5]), qty_(r[6]), String(r[7])]; });
  const l = readTableRows_(ss.getSheetByName(SHEET_LATE), HEAD_LATE.length).map(function (r) { return [String(r[0]), String(r[1]), String(r[2]), Number(r[3]) || 0, normalizeKey_(r[4]), Number(r[5]) || 0, String(r[6]), qty_(r[7]), String(r[8])]; });
  return toPayload_({
    baseDate: normalizeKey_(readInfo_(info, INFO_BASE)),
    prevDate: normalizeKey_(readInfo_(info, INFO_PREV)),
    updatedAt: String(readInfo_(info, INFO_UPDATED) || ''),
    pending: Number(readInfo_(info, INFO_PENDING)) || 0,
    warnings: splitWarn_(readInfo_(info, INFO_WARN)),
    yesterday: y,
    late: l,
    plan: readPlanInfo_(info) || planSummary_(readPlanRows_(ss)),
  });
}

function readPlanInfo_(info) {
  try { return JSON.parse(String(readInfo_(info, INFO_PLAN) || 'null')); } catch (e) { return null; }
}

function toPayload_(b) {
  const ex = payloadExtras_();
  return { abbr: ex.abbr, workList: ex.workList, unknown: ex.unknown, site: TARGET_SITE_DEFAULT, plan: b.plan || null, lateBefore: b.baseDate ? weekStart_(b.baseDate) : '', baseDate: b.baseDate, prevDate: b.prevDate, lateFrom: b.baseDate ? lateCutoff_(b.baseDate) : '', lateMonths: LATE_WINDOW_MONTHS, updatedAt: b.updatedAt, pending: b.pending || 0, warnings: b.warnings || [], yesterday: b.yesterday, late: b.late };
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

// 加工結果PDFを取り込んだら「記録」シートの2行目(新しいものが上)に 日時・取込ファイル名 を入れる。
// 列は1行目の見出しの文字で探す(無ければA列・B列)。シートが無ければ見出しを付けて作る。失敗しても取込は止めない
function writePdfRecord_(ss, when, fileName) {
  try {
    let sh = ss.getSheetByName(SHEET_PDFLOG);
    if (!sh) { sh = ss.insertSheet(SHEET_PDFLOG); sh.getRange(1, 1, 1, 2).setValues([['日時', '取込ファイル名']]); }
    const lastCol = Math.max(sh.getLastColumn(), 2);
    const head = sh.getRange(1, 1, 1, lastCol).getValues()[0].map(function (h) { return String(h || '').trim(); });
    const cDate = head.indexOf('日時') >= 0 ? head.indexOf('日時') + 1 : 1;
    const cFile = head.indexOf('取込ファイル名') >= 0 ? head.indexOf('取込ファイル名') + 1 : 2;
    sh.insertRowBefore(2);
    sh.getRange(2, cDate).setNumberFormat('@').setValue(when);
    sh.getRange(2, cFile).setNumberFormat('@').setValue(fileName);
  } catch (e) {
    // 記録の失敗は無視する
  }
}

function writeLog_(kind, detail) {
  const ss = SpreadsheetApp.getActiveSpreadsheet();
  const sh = ss.getSheetByName(SHEET_LOG) || ensureSheet_(ss, SHEET_LOG, HEAD_LOG, true);
  sh.insertRowBefore(2);
  sh.getRange(2, 1, 1, 3).setValues([[Utilities.formatDate(new Date(), TIMEZONE, 'yyyy-MM-dd HH:mm:ss'), kind.slice(0, 50), detail.slice(0, 200)]]);
}
