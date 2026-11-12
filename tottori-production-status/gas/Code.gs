/**
 * 「鳥取工場 生産状況周知」のGAS APIバックエンド。
 *
 * スプレッドシート「鳥取工場生産状況周知」の「拡張機能 → Apps Script」に貼り付けて使うコンテナバインド型スクリプト。
 * 画面(index.html / app.js)は Vercel・GitHub で配信する静的ページで、このGASは JSON API だけを提供する。
 *
 * ■ 流れ(2026-11-11 ユーザー指定)
 *   画面で加工結果PDFを読み込む → 画面が「鳥取工場 加工予定表」(週間予定表)と「MM.DD結果重量」の表を読み取って送る(doPost schedule)
 *   → 予定表に出てくる工事の案件マスターだけを読む(更新日時が前回と同じなら読み直さない)→ 一覧を作って返す。
 *   生産遅れ  : 予定表で予定日が今週の月曜より前(2か月以内)なのに、案件マスターに加工日(「加工」列)が無い製品。遅れ日数は営業日
 *   前日出来高: 加工日が前の営業日の製品(読み込んだ工事のもの)
 *   加工結果の確認: 結果重量の表の製品に加工日が無ければ、その工事のファイルだけ読み直して再確認し、残ったもの(製品名・行番号)を返す
 *   「前の営業日」「営業日」は索引スプレッドシートの会社カレンダー(I列=日付、J列=出勤/休日)で決める。
 *   何日の結果を出すかは、PDFの「鳥取工場MM.DD結果重量」の日付で決める(2026-11-11 ユーザー指定)。
 *   その日 = 前日出来高の日、その次の営業日 = 基準日(遅れの数え終わり)。
 *   いつ読み込んでも、そのPDFの日の結果・遅れになる(遅れの判定は、加工日が結果の日以前のものだけを「加工済み」とみなす)。
 *
 * ■ 読むもの(書き込みはしない)
 *   索引スプレッドシート「Excelマスタ一覧」。IDは「情報」シートの「索引スプレッドシート」にURLかIDを貼る(公開リポジトリにIDを書かないため)。
 *   A〜E列=案件マスターの一覧、G・H列=工事番号→工事名(略称の選択肢)、I・J列=会社カレンダー。
 *   案件マスターは列の見出し(加工先・製品マーク・図番・重量・加工・部位・本数)で列を探す。
 *   Excelは一時的にスプレッドシートへ変換して読み、読み終えたらすぐ削除する。元のExcelには触れない。
 *
 * ■ 速さのための決まり(2026-11-11 見直し)
 *   1回のリクエストの中では、各シート・索引・スクリプトのプロパティを1回だけ読み(cx_ に控える)、書き込みはまとめて行う。
 *   読む案件マスターは、予定表の件名(略称)と同じファイル名のファイル、無ければ略称の工事番号のファイルだけ。
 *
 * セットアップ手順は README.md を参照。
 */

const CODE_VERSION = '2026-11-12d';
const LATE_WINDOW_MONTHS = 2; // 遅れリストに出す予定日の範囲(今日から何か月前まで)
const TIMEZONE = 'Asia/Tokyo';
const TARGET_SITE_DEFAULT = '鳥取';
const IGNORE_WORK_NO = '00-00';
const PARSE_VERSION = 5; // 取込データの形を変えたら上げる(対象ファイルを読み直す)。v5: 使っていない備考①の列を削除
const TIME_BUDGET_MS = 240 * 1000; // 1回の実行で案件マスターを読む時間の上限(6分制限の手前)
const TEMP_PREFIX = '_鳥取周知_一時変換_';

const SHEET_INFO = '情報';
const SHEET_YESTERDAY = '前日出来高';
const SHEET_LATE = '遅れリスト';
const SHEET_DATA = '取込データ';
const SHEET_STATE = '状態';
const SHEET_LOG = '利用記録';
const SHEET_PDFLOG = '記録'; // 加工結果PDFの取込記録(見出し「日時」「取込ファイル名」はユーザーが用意)
const SHEET_PLAN = '予定表';
const SHEET_ABBR = '略称'; // 週間予定表の件名(略称。例: ITM)→ 工事番号(例: 26-16)
const SHEET_RESULT = '加工結果'; // PDFの「MM.DD結果重量」の表(加工済みのはずの製品)

const INFO_INDEX = '索引スプレッドシート';
const INFO_SITE = '対象拠点';
const INFO_BASE = '基準日';
const INFO_PREV = '前の営業日';
const INFO_UPDATED = '最終更新';
const INFO_PENDING = '未取込の案件';
const INFO_WARN = '注意';
const INFO_PLAN = '予定表の概要';

const HEAD_YESTERDAY = ['物件名', '製品名', '図番', '重量(t)', '生産日', '部位', '数量', '工事番号', '予定日']; // 予定日: 予定表の日(画面の備考「m/d予定分対応」に使う)
const HEAD_LATE = ['物件名', '製品名', '図番', '重量(t)', '生産予定日', '遅れ日数(営業日)', '部位', '数量', '工事番号'];
const HEAD_ABBR = ['略称', '工事番号'];
const HEAD_RESULT = ['物件名', '製品名', '加工日', '読込日時', 'ファイル名'];
const HEAD_DATA = ['ファイルID', '工事番号', '工事名', '製品名', '図番', '重量(t)', '生産日', '部位', '本数', '行番号'];
const D = { ID: 0, NO: 1, NAME: 2, MARK: 3, DW: 4, W: 5, DONE: 6, PART: 7, QTY: 8, ROW: 9 }; // 取込データの列
const HEAD_STATE = ['ファイルID', '工事番号', 'ファイル名', '元ファイル更新日時', '取込日時', '鳥取の行数', '形式', 'エラー'];
const HEAD_LOG = ['日時', '種別', '内容'];
const HEAD_PLAN = ['物件名', '製品名', '図番', '予定日', '数量', '重量(t)', '読込日時', 'ファイル名']; // 物件名+製品名ごとに1行(新しく読み込んだ予定日で上書き)
const PART_ORDER = ['柱', '大梁', '小梁']; // 一覧の並び: 物件名 → 部位(柱→大梁→小梁→その他)→ 案件マスターの行の順

// ========== 1回のリクエストの中で読んだものを控える ==========

let C_ = null;
function begin_() { C_ = { ss: SpreadsheetApp.getActiveSpreadsheet(), sheets: {} }; return C_; }
function cx_() { return C_ || begin_(); }
function sheet_(name) {
  const c = cx_();
  if (!(name in c.sheets)) c.sheets[name] = c.ss.getSheetByName(name);
  return c.sheets[name];
}

// 「情報」シート(A列=項目、B列=値)は1回で読み、書き込みは infoFlush_ でまとめて1回
function info_() {
  const c = cx_();
  if (!c.info) {
    const sh = sheet_(SHEET_INFO);
    if (!sh) throw new Error('「' + SHEET_INFO + '」シートがありません。Apps Scriptエディタで setupSheets を実行してください。');
    const last = sh.getLastRow();
    const rows = last ? sh.getRange(1, 1, last, 2).getValues() : [];
    const pos = {};
    rows.forEach(function (r, i) { const k = String(r[0]).trim(); if (k && !(k in pos)) pos[k] = i; });
    c.info = { sh: sh, rows: rows, pos: pos, dirty: false, added: [] };
  }
  return c.info;
}
function infoGet_(key) { const i = info_(); return key in i.pos ? i.rows[i.pos[key]][1] : ''; }
function infoSet_(key, value) {
  const i = info_();
  if (!(key in i.pos)) { i.pos[key] = i.rows.length; i.rows.push([key, '']); i.added.push(key); }
  i.rows[i.pos[key]][1] = value;
  i.dirty = true;
}
// A:B を文字の書式にしてから、まとめて1回で書く(日付の文字列が日付型に変わらないように。先頭の ' は外す)
function infoFlush_() {
  const i = info_();
  if (!i.dirty || !i.rows.length) return;
  const vals = i.rows.map(function (r) { return [r[0], typeof r[1] === 'string' && r[1].charAt(0) === "'" ? r[1].slice(1) : (isDate_(r[1]) ? dateToKeyJst_(r[1]) : String(r[1] == null ? '' : r[1]))]; });
  const range = i.sh.getRange(1, 1, vals.length, 2);
  range.setNumberFormat('@');
  range.setValues(vals);
  i.dirty = false; i.added = [];
}

// スクリプトのプロパティも1回で読み、書き込みはまとめて1回
function props_() {
  const c = cx_();
  if (!c.props) c.props = { all: PropertiesService.getScriptProperties().getProperties(), set: {} };
  return c.props;
}
function propGet_(k) { return props_().all[k] == null ? null : props_().all[k]; }
function propSet_(k, v) { const p = props_(); if (p.all[k] !== v) { p.all[k] = v; p.set[k] = v; } }
function propFlush_() {
  const p = props_();
  if (Object.keys(p.set).length) { try { PropertiesService.getScriptProperties().setProperties(p.set, false); } catch (e) { /* 控えられなくても続ける */ } p.set = {}; }
}
function flushAll_() { infoFlush_(); propFlush_(); }

// 索引スプレッドシートのA:J(2行目から)
function indexRows_() {
  const c = cx_();
  if (!c.index) {
    const id = extractId_(infoGet_(INFO_INDEX));
    if (!id) throw new Error('「' + SHEET_INFO + '」シートの「' + INFO_INDEX + '」が空です。索引スプレッドシート「Excelマスタ一覧」のURLを貼ってください。');
    const sh = SpreadsheetApp.openById(id).getSheets()[0];
    const last = sh.getLastRow();
    c.index = last < 2 ? [] : sh.getRange(2, 1, last - 1, 10).getValues();
  }
  return c.index;
}

function planRows_() {
  const c = cx_();
  if (!c.plan) {
    const sh = sheet_(SHEET_PLAN);
    c.plan = sh ? readTableRows_(sh, HEAD_PLAN.length).map(function (r) { return [String(r[0]), String(r[1]), String(r[2]), normalizeKey_(r[3]), qty_(r[4]), Number(r[5]) || 0, String(r[6]), String(r[7])]; }) : [];
  }
  return c.plan;
}

// 画面で選んだ略称の対応(略称シート)
function userAbbr_() {
  const c = cx_();
  if (!c.abbr) {
    const sh = sheet_(SHEET_ABBR), map = {};
    if (sh) readTableRows_(sh, HEAD_ABBR.length).forEach(function (r) { const a = String(r[0]).trim(), no = String(r[1]).trim(); if (a && no) map[a] = no; });
    c.abbr = map;
  }
  return c.abbr;
}
// 使う対応 = ファイル名が略称と同じで自動で結び付いたもの + 画面で選んだもの(画面で選んだものを優先)
function effectiveAbbr_() {
  let auto = {};
  try { auto = JSON.parse(propGet_('AUTOABBR') || '{}'); } catch (e) { auto = {}; }
  return Object.assign({}, auto, userAbbr_());
}

// 取込データ(対象ファイルの鳥取の行)。日付は'yyyy-MM-dd'にそろえる
function dataRows_() {
  const c = cx_();
  if (!c.data) {
    c.data = readTableRows_(sheet_(SHEET_DATA), HEAD_DATA.length).filter(function (r) { return String(r[D.ID] || ''); }).map(function (r) {
      return [String(r[D.ID]), String(r[D.NO]), String(r[D.NAME]), String(r[D.MARK]), String(r[D.DW]), Number(r[D.W]) || 0, normalizeKey_(r[D.DONE]), String(r[D.PART] == null ? '' : r[D.PART]), qty_(r[D.QTY]), Number(r[D.ROW]) || ''];
    });
  }
  return c.data;
}

// ========== エントリーポイント ==========

function doGet(e) {
  begin_();
  const action = (e && e.parameter && e.parameter.action) || 'getData';
  try {
    if (action === 'ping') return json_({ status: 'success', version: CODE_VERSION });
    return json_({ status: 'success', version: CODE_VERSION, data: getData_() });
  } catch (err) {
    return json_({ status: 'error', version: CODE_VERSION, message: String(err && err.message || err) });
  }
}

// 週間予定表の読み込み(action=schedule)・略称の保存(action=mapNames)・利用記録(action=log。画面には何も出さない)
function doPost(e) {
  begin_();
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

function json_(obj) {
  return ContentService.createTextOutput(JSON.stringify(obj)).setMimeType(ContentService.MimeType.JSON);
}

// 週間予定表の行を「予定表」シートへ保存し(物件名+製品名が同じ行は新しい予定日で上書き)、
// 予定表に出てくる工事の案件マスターを読んで一覧を作り、加工結果を確かめて返す
function saveSchedule_(body) {
  const items = (body.items || []).filter(function (x) { return x && x.mark && normalizeKey_(x.date); });
  if (!items.length) throw new Error('予定表の行がありません');
  const lock = LockService.getScriptLock();
  if (!lock.tryLock(150000)) throw new Error('他の更新が終わらないため、受け付けられませんでした。1〜2分後にもう一度送ってください。');
  try {
    const ss = cx_().ss;
    const now = Utilities.formatDate(new Date(), TIMEZONE, 'yyyy-MM-dd HH:mm:ss'); // 秒まで(「最後に読み込んだ予定表」を見分けるため)
    const fileName = String(body.fileName || '').slice(0, 100);
    const map = {}, keys = [];
    planRows_().forEach(function (r) { const k = r[0] + '\t' + r[1]; if (!map[k]) keys.push(k); map[k] = r; });
    items.forEach(function (x) {
      const k = String(x.name || '') + '\t' + String(x.mark);
      if (!map[k]) keys.push(k);
      map[k] = [String(x.name || ''), String(x.mark), String(x.drawing || ''), normalizeKey_(x.date), qty_(x.qty), Number(x.weight) || 0, now, fileName];
    });
    const plan = keys.map(function (k) { return map[k]; });
    writeTable_(sheet_(SHEET_PLAN) || ensureSheet_(ss, SHEET_PLAN, HEAD_PLAN, false), HEAD_PLAN, plan, [0, 1, 2, 3, 6, 7]);
    cx_().plan = plan;
    // 加工結果の表(あれば)を保存する。このPDFに結果の表があるときだけ確かめる(前回のPDFの結果で、何度もポップアップを出さない)
    const results = (body.results || []).filter(function (x) { return x && x.mark; }).map(function (x) { return { name: String(x.name || ''), mark: String(x.mark), date: normalizeKey_(x.date) }; });
    if (results.length) { writeTable_(sheet_(SHEET_RESULT) || ensureSheet_(ss, SHEET_RESULT, HEAD_RESULT, true), HEAD_RESULT, results.map(function (x) { return [x.name, x.mark, x.date, now, fileName]; }), [0, 1, 2, 3, 4]); cx_().results = results; }
    writePdfRecord_(ss, now, fileName);
    // PDFの「MM.DD結果重量」の日付を控える(この日の結果を出す。結果の表が無いPDFなら今日を基準にする)
    propSet_('PDF_PREV', normalizeKey_(body.resultDate) || '');
    const r = refreshAndCheck_(results);
    return { status: 'success', version: CODE_VERSION, saved: items.length, resultCheck: r.check, data: toPayload_(r.built) };
  } finally {
    flushAll_();
    lock.releaseLock();
  }
}

// 略称 → 工事番号 の対応を保存して(同じ略称は上書き、空なら削除)、一覧を作り直して返す
function saveAbbr_(body) {
  const map = body.map || {};
  const lock = LockService.getScriptLock();
  if (!lock.tryLock(150000)) throw new Error('他の更新が終わらないため、保存できませんでした。1〜2分後にもう一度保存してください。');
  try {
    const cur = Object.assign({}, userAbbr_());
    Object.keys(map).forEach(function (k) {
      const a = String(k).trim(), no = String(map[k] || '').trim();
      if (!a) return;
      if (no) cur[a] = no; else delete cur[a];
    });
    writeTable_(sheet_(SHEET_ABBR) || ensureSheet_(cx_().ss, SHEET_ABBR, HEAD_ABBR, false), HEAD_ABBR, Object.keys(cur).sort().map(function (a) { return [a, cur[a]]; }), [0, 1]);
    cx_().abbr = cur;
    const r = refreshAndCheck_(readResults_()); // 略称が変わると読むファイルも変わる
    return { status: 'success', version: CODE_VERSION, resultCheck: r.check, data: toPayload_(r.built) };
  } finally {
    flushAll_();
    lock.releaseLock();
  }
}

// 加工結果の表に出てくる物件名(略称)。targetFiles_ に渡す形([略称])
function resultNames_() {
  const seen = {};
  return readResults_().filter(function (x) { if (!x.name || seen[x.name]) return false; seen[x.name] = true; return true; }).map(function (x) { return [x.name]; });
}

function readResults_() {
  const c = cx_();
  if (!c.results) {
    const sh = sheet_(SHEET_RESULT);
    c.results = sh ? readTableRows_(sh, HEAD_RESULT.length).map(function (r) { return { name: String(r[0]), mark: String(r[1]), date: normalizeKey_(r[2]) }; }).filter(function (x) { return x.mark; }) : [];
  }
  return c.results;
}

// 対象ファイルを読んで一覧を作り(予定表が変わったので必ず作り直す)、加工結果を確かめる(2026-11-11 ユーザー指定)
// 結果の製品に加工日が無いもの(製品名・行番号)を返す → 画面が「マスターデータに日付が入ってません」を出す。
// 元のファイルを直接読み、更新日時が変わったものは runRefresh_ で読み直しているので、ここで更に読み直すことはしない
// (以前は無ければ更新日時に関係なく読み直していたが、見つからない製品があると毎回 変換2回+作り直し が空振りしていた。2026-11-12)
function refreshAndCheck_(results) {
  const built = runRefresh_({ rebuild: true }).built;
  if (!results.length) return { built: built, check: null };
  const miss = findMissingDates_(dataRows_(), results, effectiveAbbr_());
  return { built: built, check: { date: results[0].date, checked: results.length, missing: miss.map(function (m) { return { name: m.name, mark: m.mark, row: m.row, file: m.file }; }) } };
}

// 加工結果の製品のうち、マスターに加工日が入っていないもの(見つからないものも含む)
function findMissingDates_(allRows, results, abbr) {
  const byWorkMark = {}, byMark = {};
  allRows.forEach(function (r, i) {
    (byWorkMark[r[D.NO] + '\t' + r[D.MARK]] = byWorkMark[r[D.NO] + '\t' + r[D.MARK]] || []).push(i);
    (byMark[r[D.MARK]] = byMark[r[D.MARK]] || []).push(i);
  });
  const out = [];
  results.forEach(function (x) {
    const no = abbr[x.name];
    const cands = no ? (byWorkMark[no + '\t' + x.mark] || []) : (byMark[x.mark] || []);
    if (cands.some(function (j) { return allRows[j][D.DONE]; })) return;
    const m = cands.length ? allRows[cands[0]] : null;
    out.push({ name: x.name, mark: x.mark, row: m ? m[D.ROW] : '', file: m ? m[D.NAME] : '', fileId: m ? m[D.ID] : '' });
  });
  return out;
}

// 予定表の件名(略称)ごとに読むファイルを選ぶ: ① ファイル名(拡張子なし)が略称と同じファイル ② 無ければ略称の工事番号のファイル
// ①で結び付いた略称は、画面で選ばなくても使えるように自動の対応として控える(AUTOABBR)
function targetFiles_(fileIndex, planRows, abbr) {
  const names = {};
  planRows.forEach(function (p) { if (p[0]) names[p[0]] = true; });
  const byBase = {}, byNo = {};
  fileIndex.forEach(function (f) { (byBase[workName_(f)] = byBase[workName_(f)] || []).push(f); (byNo[f.workNo] = byNo[f.workNo] || []).push(f); });
  const auto = {}, picked = {}, out = [];
  Object.keys(names).sort().forEach(function (n) {
    let fs = byBase[n] || [];
    if (fs.length) { if (!abbr[n]) auto[n] = fs[0].workNo; }
    else if (abbr[n]) fs = byNo[abbr[n]] || [];
    fs.forEach(function (f) { if (!picked[f.fileId]) { picked[f.fileId] = true; out.push(f); } });
  });
  propSet_('AUTOABBR', JSON.stringify(auto));
  return out;
}

// 索引のG・H列(工事番号→工事名)。画面の「略称の対応」の選択肢。見出しの行(工事番号|工事名)は除く
function saveWorkList_(rows) {
  const seen = {}, list = [];
  rows.forEach(function (row) {
    const no = String(row[6] || '').trim(), name = String(row[7] || '').trim();
    if (no && no !== '工事番号' && !seen[no]) { seen[no] = true; list.push([no, name]); }
  });
  list.sort(function (a, b) { return a[0] < b[0] ? 1 : a[0] > b[0] ? -1 : 0; }); // 新しい工事番号を上に
  propSet_('WORKLIST', JSON.stringify(list));
  return list;
}

// ========== Apps Scriptエディタから手動で実行する関数 ==========

// 最初に1回実行する: シートと見出しを作る。既存のシート・値は消さない。以前の自動更新(毎朝・1時間ごと)の予約は消す
function setupSheets() {
  const ss = begin_().ss;
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
    if (!(k in info_().pos)) infoSet_(k, k === INFO_SITE ? TARGET_SITE_DEFAULT : '');
  });
  infoFlush_();
  info.setColumnWidth(1, 160);
  info.setColumnWidth(2, 480);
  // 何も無い初期の「シート1」は、空のときだけ消す
  const blank = ss.getSheetByName('シート1');
  if (blank && ss.getSheets().length > 1 && blank.getLastRow() === 0) ss.deleteSheet(blank);
  removeAutoTriggers_();
  Logger.log('シートを準備しました。「情報」シートの「' + INFO_INDEX + '」に、索引スプレッドシート「Excelマスタ一覧」のURLを貼ってください。');
}

// 一覧は加工結果PDFを読み込んだときに作るので、自動更新(毎朝・1時間ごと)は使わない(2026-11-11)。予約が残っていれば消す
function removeAutoTriggers_() {
  ScriptApp.getProjectTriggers().forEach(function (t) {
    const fn = t.getHandlerFunction();
    if (fn === 'dailyRefresh' || fn === 'hourlyRefresh') ScriptApp.deleteTrigger(t);
  });
}
// 読み切れなかった案件の続き(1分後の予約から動く)
function continueRefresh() { begin_(); runRefreshLocked_(true); }

function runRefreshLocked_(wait) {
  const lock = LockService.getScriptLock();
  if (wait) lock.waitLock(300000); else if (!lock.tryLock(3000)) return { status: 'busy' };
  try {
    const r = runRefresh_({});
    return { status: 'success', pending: r.pending, built: r.built };
  } finally {
    flushAll_();
    lock.releaseLock();
  }
}

// ========== 更新の本体 ==========

// 対象ファイル(予定表に出てくる工事)のうち、変わったものだけ読み直して一覧を作る。
// opts.force: 更新日時に関係なく読み直すファイルID({id: true})。opts.rebuild: 変更が無くても一覧を作り直す
function runRefresh_(opts) {
  opts = opts || {};
  const force = opts.force || {};
  const started = Date.now();
  const ss = cx_().ss;
  const site = String(infoGet_(INFO_SITE) || TARGET_SITE_DEFAULT).trim();
  const rows = indexRows_();
  // 読むファイル: 予定表に出てくる工事 + 加工結果の表に出てくる工事(予定表に無い工事を加工した日もあるため。2026-11-12 ユーザー指定)
  const fileIndex = targetFiles_(readFileIndex_(rows), planRows_().concat(resultNames_()), userAbbr_());
  const calendar = readCalendar_(rows);
  const stateSh = sheet_(SHEET_STATE);
  const state = readState_(stateSh);

  const warnings = [];
  let folder = null;
  const parsed = {}; // 今回読み直した案件: fileId -> 行(null=失敗で前回の取込データを残す)
  // 取込が古い順(未取込が先)に、時間の許す範囲で読む。更新日時が前回と同じなら読まない
  const order = fileIndex.slice().sort(function (a, b) { return (state[a.fileId] ? state[a.fileId].importedAt : 0) - (state[b.fileId] ? state[b.fileId].importedAt : 0); });
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
    let got = [], error = '';
    try {
      folder = folder || getOwnFolder_(ss);
      got = readMasterRows_(entry, file, folder, site);
    } catch (err) {
      error = String(err && err.message || err);
      warnings.push('「' + entry.fileName + '」(' + entry.workNo + ')の読み込みに失敗しました: ' + error);
      got = st ? null : []; // 失敗時は前回の取込データを残す
    }
    parsed[entry.fileId] = got ? got.map(function (r) { return [entry.fileId, entry.workNo, '', r.mark, r.drawing, r.weight, r.done || '', r.part, r.qty, r.row]; }) : null;
    state[entry.fileId] = { fileId: entry.fileId, workNo: entry.workNo, fileName: entry.fileName, mtime: mtime, importedAt: Date.now(), count: got ? got.length : (st ? st.count : 0), version: PARSE_VERSION, error: error };
  });

  const live = {};
  fileIndex.forEach(function (e) { live[e.fileId] = e; });
  const removed = Object.keys(state).filter(function (id) { return !live[id]; }); // 対象から外れた・索引から消えたファイル
  removed.forEach(function (id) { delete state[id]; });
  const namesSig = JSON.stringify(fileIndex.map(function (e) { return e.fileId + '=' + workName_(e); }));
  const namesChanged = propGet_('WORKNAMES_SIG') !== namesSig;

  const dates = baseDates_(calendar);
  const today = dates.base;
  const now = Utilities.formatDate(new Date(), TIMEZONE, 'yyyy-MM-dd HH:mm');
  const prevWarn = splitWarn_(infoGet_(INFO_WARN)).filter(function (w) { return w.indexOf('読み込みに失敗') >= 0 || w.indexOf('開けませんでした') >= 0 || w.indexOf('読み切れなかった') >= 0; });
  // 何も変わっていない(ファイル・名前・日付・前回の未取込/失敗なし)ときは、取込データを読み書きせずに返す
  if (!opts.rebuild && !changed && !pending && !removed.length && !namesChanged && !(Number(infoGet_(INFO_PENDING)) || 0) && !prevWarn.length && !warnings.length && normalizeKey_(infoGet_(INFO_BASE)) === today) {
    infoSet_(INFO_UPDATED, "'" + now);
    scheduleContinue_(false);
    return { pending: 0, changed: 0, built: readBuiltFromSheets_() };
  }

  let allRows = dataRows_();
  if (changed || removed.length || namesChanged) {
    const byFile = {};
    allRows.forEach(function (r) { if (live[r[D.ID]]) (byFile[r[D.ID]] = byFile[r[D.ID]] || []).push(r); }); // 対象外のファイルの行は捨てる
    Object.keys(parsed).forEach(function (id) { if (parsed[id]) byFile[id] = parsed[id]; });
    allRows = [];
    Object.keys(byFile).forEach(function (id) { byFile[id].forEach(function (r) { r[D.NAME] = workName_(live[id]); allRows.push(r); }); }); // 工事名は索引の最新のファイル名で付け直す
    writeTable_(sheet_(SHEET_DATA), HEAD_DATA, allRows, [D.ID, D.NO, D.NAME, D.MARK, D.DW, D.DONE, D.PART]);
    cx_().data = allRows;
    writeState_(stateSh, state);
    propSet_('WORKNAMES_SIG', namesSig);
  }

  saveWorkList_(rows);
  const built = buildLists_(allRows, calendar, today, planRows_(), effectiveAbbr_(), dates.prev);
  if (pending > 0) warnings.push('時間内に読み切れなかった案件が' + pending + '件あります。1分後に自動で続きを読みます。');
  built.warnings = warnings.concat(built.warnings);
  built.pending = pending;
  built.updatedAt = now;
  writeOutputs_(built);
  scheduleContinue_(pending > 0);
  return { pending: pending, changed: changed, built: built };
}

// 画面からの取得(今の画面は使わないが、確認用に残す)。日付が変わっていたら、取込データから一覧だけ作り直す
function getData_() {
  const usePdf = !!propGet_('PDF_PREV'); // PDFの日付が基準なら、一覧は取込時のままでよい
  if (!usePdf && normalizeKey_(infoGet_(INFO_BASE)) !== todayKey_() && String(infoGet_(INFO_UPDATED) || '')) {
    const lock = LockService.getScriptLock();
    if (lock.tryLock(20000)) {
      try {
        const rows = indexRows_();
        const calendar = readCalendar_(rows);
        const dates = baseDates_(calendar);
        const built = buildLists_(dataRows_(), calendar, dates.base, planRows_(), effectiveAbbr_(), dates.prev);
        built.warnings = splitWarn_(infoGet_(INFO_WARN)).filter(function (w) { return w.indexOf('読み込みに失敗') >= 0 || w.indexOf('開けませんでした') >= 0 || w.indexOf('読み切れなかった') >= 0; }).concat(built.warnings);
        built.pending = Number(infoGet_(INFO_PENDING)) || 0;
        built.updatedAt = String(infoGet_(INFO_UPDATED) || '');
        writeOutputs_(built);
        return toPayload_(built);
      } finally {
        flushAll_();
        lock.releaseLock();
      }
    }
  }
  return toPayload_(readBuiltFromSheets_());
}

// ========== 一覧づくり(純粋な計算。テストで直接呼ぶ) ==========

// allRows: 取込データの行(列は D を参照。日付は'yyyy-MM-dd')
// planRows: 予定表の行 [物件名, 製品名, 図番, 予定日, 数量, 重量, 読込日時, ファイル名]
// calendar: {'yyyy-MM-dd': true(出勤)/false(休日)}  today: 'yyyy-MM-dd'  abbr: {略称: 工事番号}
// prevKey: 前日出来高の日(PDFの結果の日)。省略時は today の前の営業日
// 前日出来高 = 加工日が前の営業日の行。
// 生産遅れ  = 予定表で予定日が今週の月曜より前(2か月以内)なのに、案件マスターに加工日が無い(または前の営業日より後の)製品
//             (今週の予定は遅れにしない=「先週の漏れ」を遅れとする。備考①は加工予定日とは限らないため使わない。2026-11-11 ユーザー指定)
function buildLists_(allRows, calendar, today, planRows, abbr, prevKey) {
  abbr = abbr || {};
  const prev = prevKey ? { key: prevKey, warning: '' } : prevBusinessDay_(calendar, today);
  const lateFrom = lateCutoff_(today);
  const lateBefore = weekStart_(today);
  const yesterday = [], late = [];
  // 工事番号 → 略称(表示用。同じ工事番号に略称が複数あれば、名前順で最初のもの)
  const rev = {};
  Object.keys(abbr).sort().forEach(function (a) { if (!rev[abbr[a]]) rev[abbr[a]] = a; });
  // 予定表の予定日(前日出来高の備考用。2026-11-12 ユーザー指定): 工事番号+製品名、無ければ 略称+製品名 で引く
  const planByNo = {}, planByName = {};
  (planRows || []).forEach(function (p) {
    const d = normalizeKey_(p[3]);
    if (!d) return;
    planByName[p[0] + '\t' + p[1]] = d;
    if (abbr[p[0]]) planByNo[abbr[p[0]] + '\t' + p[1]] = d;
  });
  const byWorkMark = {}, byMark = {};
  allRows.forEach(function (r, i) {
    const done = r[D.DONE], no = r[D.NO];
    if (done && done === prev.key) {
      const name = rev[no] || r[D.NAME];
      yesterday.push([name, r[D.MARK], r[D.DW], r[D.W], done, r[D.PART] || '', r[D.QTY], no, planByNo[no + '\t' + r[D.MARK]] || planByName[name + '\t' + r[D.MARK]] || '', i]);
    }
    (byWorkMark[no + '\t' + r[D.MARK]] = byWorkMark[no + '\t' + r[D.MARK]] || []).push(i);
    (byMark[r[D.MARK]] = byMark[r[D.MARK]] || []).push(i);
  });
  // 予定表の製品ごとの加工日(結果の日まで)。画面がPDFの予定表で、マスタでは完了なのに青くない行を薄い青で塗るのに使う(2026-11-12 ユーザー指定)
  // 案件マスターの行の探し方は遅れの判定と同じ(略称→工事番号+製品名。略称が未設定なら製品名(+図番)で1件に決まるときだけ)
  const planDone = {};
  planRows.forEach(function (p) {
    const no = abbr[p[0]];
    let cands;
    if (no) cands = byWorkMark[no + '\t' + p[1]] || [];
    else {
      cands = byMark[p[1]] || [];
      if (cands.length > 1) cands = cands.filter(function (j) { return allRows[j][D.DW] === p[2]; });
      if (cands.length > 1) cands = [];
    }
    let done = '';
    cands.forEach(function (j) { const x = allRows[j][D.DONE]; if (x && x <= prev.key && x > done) done = x; });
    if (done) planDone[p[0] + '\t' + p[1]] = done;
  });
  const lateDays = {}; // 予定日 -> 遅れ日数(同じ予定日は1回だけ数える)
  let missingCal = '', notFound = 0;
  const unmapped = {};
  planRows.forEach(function (p) {
    const plan = p[3];
    if (!plan || plan >= lateBefore || plan < lateFrom) return;
    // 案件マスターの行を探す: 略称→工事番号+製品名。略称が未設定なら、製品名(+図番)で1件に決まるときだけ
    const no = abbr[p[0]];
    let cands;
    if (no) cands = byWorkMark[no + '\t' + p[1]] || [];
    else {
      unmapped[p[0]] = true;
      cands = byMark[p[1]] || [];
      if (cands.length > 1) cands = cands.filter(function (j) { return allRows[j][D.DW] === p[2]; });
      if (cands.length > 1) cands = [];
    }
    if (!cands.length) notFound++;
    if (cands.some(function (j) { return allRows[j][D.DONE] && allRows[j][D.DONE] <= prev.key; })) return; // 加工済み(結果の日までに加工したもの。後日読み込んでも、そのPDFの日の遅れになる)
    const m = cands.length ? allRows[cands[0]] : null;
    if (!(plan in lateDays)) {
      const c = businessDaysAfter_(calendar, plan, today);
      lateDays[plan] = c.days;
      if (c.missing && (!missingCal || c.missing < missingCal)) missingCal = c.missing;
    }
    late.push([p[0], p[1], m ? m[D.DW] : p[2], m ? m[D.W] : (Number(p[5]) || 0), plan, lateDays[plan], m ? (m[D.PART] || '') : '', m ? m[D.QTY] : qty_(p[4]), no || (m ? m[D.NO] : ''), m ? cands[0] : allRows.length]);
  });
  // 並び(見本のPDFと同じ): 物件名 → 部位(柱→大梁→小梁→その他)→ 案件マスターの行の順
  const byText = function (a, b) { return a < b ? -1 : a > b ? 1 : 0; };
  const rank = function (p) { const i = PART_ORDER.indexOf(p); return i < 0 ? PART_ORDER.length : i; };
  const order = function (pi, ii) { return function (a, b) { return byText(a[0], b[0]) || (rank(a[pi]) - rank(b[pi])) || (a[ii] - b[ii]); }; };
  stableSort_(yesterday, order(5, 9));
  stableSort_(late, order(6, 9));
  const warnings = prev.warning ? [prev.warning] : [];
  if (missingCal) warnings.push('会社カレンダー(索引スプレッドシートのI・J列)に ' + missingCal.replace(/-/g, '/') + ' などがありません。遅れ日数(営業日)は、カレンダーに無い日を土日休みとみなして数えました。');
  const um = Object.keys(unmapped);
  if (um.length) warnings.push('略称「' + um.join('」「') + '」の工事番号が未設定です。画面の「略称の対応」で選んでください。');
  if (notFound) warnings.push('予定表の製品のうち ' + notFound + ' 件が案件マスター(鳥取)に見つかりませんでした。加工済みか判定できないため、遅れとして表示しています。');
  return {
    baseDate: today,
    prevDate: prev.key,
    yesterday: yesterday.map(function (r) { return r.slice(0, 9); }),
    late: late.map(function (r) { return r.slice(0, 9); }),
    warnings: warnings,
    plan: planCoverage_(planSummary_(planRows), planRows, calendar, lateBefore, prev.key),
    planDone: planDone,
  };
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

// 基準日と前日出来高の日。最後に読み込んだPDFの「MM.DD結果重量」の日付があれば、
// その日 = 前日出来高の日、次の営業日 = 基準日(2026-11-11 ユーザー指定)。無ければ今日とその前の営業日。
function baseDates_(calendar) {
  const prev = normalizeKey_(propGet_('PDF_PREV') || '');
  if (prev) return { base: nextBusinessDay_(calendar, prev), prev: prev };
  return { base: todayKey_(), prev: '' };
}

// 次の営業日(カレンダーに無い日は土日を休みとみなす)
function nextBusinessDay_(calendar, key) {
  let d = keyToUtc_(key);
  for (let i = 0; i < 60; i++) {
    d += 86400000;
    const k = utcToKey_(d);
    if (Object.prototype.hasOwnProperty.call(calendar, k) ? calendar[k] : (new Date(d).getUTCDay() % 6 !== 0)) return k;
  }
  return utcToKey_(keyToUtc_(key) + 86400000);
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

// 案件マスターの1シート目から、対象拠点の行を返す
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
  const need = [col.site, col.mark, col.drawing, col.weight, col.done, col.part, col.qty].filter(function (c) { return c >= 0; });
  const width = Math.max.apply(null, need) + 1;
  return parseMasterRows_(header, sheet.getRange(2, 1, lastRow - 1, width).getValues(), site);
}

function findColumns_(header) {
  const h = header.map(function (x) { return String(x == null ? '' : x).trim(); });
  const col = { site: h.indexOf('加工先'), mark: h.indexOf('製品マーク'), drawing: h.indexOf('図番'), weight: h.indexOf('重量'), done: h.indexOf('加工'), part: h.indexOf('部位'), qty: h.indexOf('本数') };
  if (col.site < 0 || col.done < 0) throw new Error('見出しに「加工先」または「加工」がありません');
  return col;
}

// header: 見出し行、values: 2行目以降の値。純粋な計算(テストで直接呼ぶ)
function parseMasterRows_(header, values, site) {
  const col = findColumns_(header);
  const out = [];
  for (let i = 0; i < values.length; i++) {
    const row = values[i];
    if (String(row[col.site] == null ? '' : row[col.site]).trim() !== site) continue;
    out.push({
      mark: col.mark >= 0 ? String(row[col.mark] == null ? '' : row[col.mark]).trim() : '',
      part: col.part >= 0 ? String(row[col.part] == null ? '' : row[col.part]).trim() : '',
      qty: col.qty >= 0 && row[col.qty] !== '' && !isNaN(Number(row[col.qty])) ? Number(row[col.qty]) : '',
      drawing: col.drawing >= 0 ? String(row[col.drawing] == null ? '' : row[col.drawing]).trim() : '',
      weight: col.weight >= 0 ? (Number(row[col.weight]) || 0) : 0,
      done: isDate_(row[col.done]) ? dateToKeyJst_(row[col.done]) : '',
      row: i + 2, // マスターの行番号(1行目が見出し)
    });
  }
  return out;
}

// ========== 索引スプレッドシート ==========

// A:E列。工事番号が空・"00-00"の行は除く。マスタNo(B列)が"S"始まりならスプレッドシート、それ以外はExcel(生産管理ダッシュボードと同じ決まり)
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

// 工事名: 索引D列のファイル名から拡張子を除いたもの(例: 「OSR.xlsx」→「OSR」)
function workName_(entry) { return String(entry.fileName || '').replace(/\.(xlsx|xlsm|xls)$/i, ''); }

// ========== このスプレッドシートの読み書き ==========

function ensureSheet_(ss, name, head, hidden) {
  let sh = ss.getSheetByName(name);
  if (!sh) sh = ss.insertSheet(name);
  if (sh.getLastRow() === 0) {
    sh.getRange(1, 1, 1, head.length).setValues([head]).setFontWeight('bold').setBackground('#e8eef7');
    sh.setFrozenRows(1);
  }
  if (hidden) sh.hideSheet();
  if (C_) C_.sheets[name] = sh;
  return sh;
}

function splitWarn_(v) { return String(v || '').split('\n').map(function (s) { return s.trim(); }).filter(Boolean); }

function readTableRows_(sh, width) {
  const last = sh.getLastRow();
  if (last < 2) return [];
  return sh.getRange(2, 1, last - 1, width).getValues();
}

// 見出し+行をまとめて1回で書く。textCols: 文字のまま書く列(0始まり。図番「2-1」や日付の文字列が日付型に変わるのを防ぐ)
// 前より行・列が減ったときは、はみ出した分だけ消す
function writeTable_(sh, head, rows, textCols) {
  const lastRow = sh.getLastRow(), lastCol = sh.getLastColumn();
  const n = rows.length + 1, w = head.length;
  if (lastRow > n) sh.getRange(n + 1, 1, lastRow - n, Math.max(lastCol, w)).clearContent();
  if (lastCol > w) sh.getRange(1, w + 1, Math.min(lastRow, n) || 1, lastCol - w).clearContent();
  const tc = {};
  (textCols || []).forEach(function (c) { tc[c] = true; });
  const fmtRow = head.map(function (h, c) { return tc[c] ? '@' : 'General'; });
  const fmts = [head.map(function () { return '@'; })];
  for (let i = 0; i < rows.length; i++) fmts.push(fmtRow);
  const range = sh.getRange(1, 1, n, w);
  range.setNumberFormats(fmts);
  range.setValues([head].concat(rows));
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

// 一覧と「情報」シートの値を書く(情報シートは flushAll_ でまとめて1回)
function writeOutputs_(built) {
  writeTable_(sheet_(SHEET_YESTERDAY), HEAD_YESTERDAY, built.yesterday, [0, 1, 2, 4, 5, 7, 8]);
  writeTable_(sheet_(SHEET_LATE), HEAD_LATE, built.late, [0, 1, 2, 4, 6, 8]);
  infoSet_(INFO_BASE, "'" + built.baseDate);
  infoSet_(INFO_PREV, "'" + built.prevDate);
  infoSet_(INFO_UPDATED, "'" + built.updatedAt);
  infoSet_(INFO_PENDING, built.pending || 0);
  infoSet_(INFO_WARN, built.warnings.join('\n'));
  infoSet_(INFO_PLAN, "'" + JSON.stringify(built.plan || null));
}

// 保存済みの一覧(シート)を、buildLists_ と同じ形で読む
function readBuiltFromSheets_() {
  const y = readTableRows_(sheet_(SHEET_YESTERDAY), HEAD_YESTERDAY.length).map(function (r) { return [String(r[0]), String(r[1]), String(r[2]), Number(r[3]) || 0, normalizeKey_(r[4]), String(r[5]), qty_(r[6]), String(r[7]), normalizeKey_(r[8])]; });
  const l = readTableRows_(sheet_(SHEET_LATE), HEAD_LATE.length).map(function (r) { return [String(r[0]), String(r[1]), String(r[2]), Number(r[3]) || 0, normalizeKey_(r[4]), Number(r[5]) || 0, String(r[6]), qty_(r[7]), String(r[8])]; });
  let plan = null;
  try { plan = JSON.parse(String(infoGet_(INFO_PLAN) || 'null')); } catch (e) { plan = null; }
  return {
    baseDate: normalizeKey_(infoGet_(INFO_BASE)),
    prevDate: normalizeKey_(infoGet_(INFO_PREV)),
    updatedAt: String(infoGet_(INFO_UPDATED) || ''),
    pending: Number(infoGet_(INFO_PENDING)) || 0,
    warnings: splitWarn_(infoGet_(INFO_WARN)),
    yesterday: y,
    late: l,
    plan: plan || planSummary_(planRows_()),
  };
}

// 画面へ返す形。略称の対応・工事番号の一覧(略称の選択肢)・未設定の略称を添える
function toPayload_(b) {
  const abbr = effectiveAbbr_();
  let workList = [];
  try { workList = JSON.parse(propGet_('WORKLIST') || '[]'); } catch (e) { workList = []; }
  const unknown = {};
  planRows_().concat(resultNames_()).forEach(function (p) { if (p[0] && !abbr[p[0]]) unknown[p[0]] = true; }); // 加工結果の表だけに出てくる略称も選んでもらう
  return { abbr: abbr, workList: workList, unknown: Object.keys(unknown).sort(), plan: b.plan || null, lateBefore: b.baseDate ? weekStart_(b.baseDate) : '', baseDate: b.baseDate, prevDate: b.prevDate, lateFrom: b.baseDate ? lateCutoff_(b.baseDate) : '', updatedAt: b.updatedAt, pending: b.pending || 0, warnings: b.warnings || [], yesterday: b.yesterday, late: b.late, planDone: b.planDone || {} };
}

function getOwnFolder_(ss) {
  const parents = DriveApp.getFileById(ss.getId()).getParents();
  return parents.hasNext() ? parents.next() : DriveApp.getRootFolder();
}

// 読み切れなかった案件があれば1分後に続きを読む。無ければ続きの予約を消す
function scheduleContinue_(need) {
  // 予約の一覧を見るのは、続きが要るときと、前に予約したときだけ(取込のたびに見に行かない。2026-11-12)
  if (!need && propGet_('CONTINUE_SET') !== '1') return;
  propSet_('CONTINUE_SET', need ? '1' : '');
  let has = false;
  ScriptApp.getProjectTriggers().forEach(function (t) {
    if (t.getHandlerFunction() !== 'continueRefresh') return;
    if (need && !has) { has = true; return; }
    ScriptApp.deleteTrigger(t);
  });
  if (need && !has) ScriptApp.newTrigger('continueRefresh').timeBased().after(60 * 1000).create();
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
  const ss = cx_().ss;
  const sh = ss.getSheetByName(SHEET_LOG) || ensureSheet_(ss, SHEET_LOG, HEAD_LOG, true);
  sh.insertRowBefore(2);
  sh.getRange(2, 1, 1, 3).setValues([[Utilities.formatDate(new Date(), TIMEZONE, 'yyyy-MM-dd HH:mm:ss'), kind.slice(0, 50), detail.slice(0, 200)]]);
}
