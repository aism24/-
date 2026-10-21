/**
 * 社内不具合記録アプリ（鳥取）GAS版
 * このスクリプトは「社内不具合アプリVercel版」スプレッドシート（設定用コンテナ）にバインドする。
 * データ本体は別スプレッドシート（データソース）を ID 経由で読み書きする。
 *
 * 【構成】
 *  - 共通: キャッシュ(データ版数方式)・設定・日付ヘルパー
 *  - データ読込: loadData_()が1リクエスト1回だけ不具合記録シートを読む
 *  - 集計: buildAgg_()が1回の走査で年度/月/工事/明細の集計をまとめて作る
 *  - 生産重量: 6時間キャッシュ+スクリプトプロパティに永続保存(毎朝7〜8時に更新)
 */

/** デプロイ後に doPost の ping で反映を確認するための版表記(コードを変えたら更新する) */
var CODE_VERSION = '2026-10-21-edit-keep';

var CONFIG_SHEET_NAME = '情報';
var DATA_SHEET = '不具合記録';
var INSPECTOR_SHEET = '検査員';
var CLASS_SHEET = '分類';
var PROPERTY_SHEET = '物件名';
var NAME_SHEET = '氏名';
var PRODUCTION_SHEET_NAME = 'QUERY';
var MONTH_ORDER = [12, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11];

/** Geminiのモデル名はコードに固定する(情報シートの値は使わない) */
var GEMINI_MODEL = 'gemini-3.5-flash-lite';

var COLUMNS = [
  '不具合記録ID', '発生日', '選択物件名', '製品名', '部署選択(対象者)', '対象者',
  '梁ロボ', '加工先', '分類選択', '不具合内容、原因', '部署選択(処理者)', '処理者',
  '対策', '検査確認者', 'コメント有無', 'コメント', '状況写真', '製品名写真', '状況写真2'
];

/** 画面の入力・編集に無い列。既存の記録を編集して保存しても、これらの列は書き換えない(元の値を残す) */
var COLUMNS_NOT_ON_FORM = ['部署選択(処理者)', '処理者', '状況写真2'];

/** JSON API: フロント(Vercel)から fetch(POST) で呼ばれる。許可した関数のみ実行 */
var API_FUNCTIONS = {
  getMasterData: getMasterData, saveRecord: saveRecord,
  getRecords: getRecords, getRecordsBootstrap: getRecordsBootstrap,
  getBunsekiByField: getBunsekiByField, getBunsekiByProcessType: getBunsekiByProcessType,
  getFilteredRecords: getFilteredRecords, getKekkaBunsekiContentRecords: getKekkaBunsekiContentRecords,
  getKekkaBunsekiBootstrap: getKekkaBunsekiBootstrap, getKekkaBunsekiYear: getKekkaBunsekiYear,
  getKekkaBunsekiMonth: getKekkaBunsekiMonth, getKekkaBunsekiByProject: getKekkaBunsekiByProject,
  uploadPhoto: uploadPhoto, ocrProductName: ocrProductName, logPdfDownload: logPdfDownload,
  getProductionWeights: getProductionWeights, clearCache: clearCache,
  ping: function () { return { version: CODE_VERSION }; }
};

function doGet() {
  return ContentService.createTextOutput('OK').setMimeType(ContentService.MimeType.TEXT);
}

function doPost(e) {
  var out;
  var t0 = Date.now();
  try {
    var req = JSON.parse(e.postData.contents);
    var fn = API_FUNCTIONS[req.fn];
    if (!fn) throw new Error('未対応の関数: ' + req.fn);
    out = { ok: true, data: fn.apply(null, req.args || []) };
  } catch (err) {
    out = { ok: false, error: String(err && err.message || err) };
  }
  out.ms = Date.now() - t0; // サーバー側の処理時間（画面のコンソールで通信時間と比較できる）
  return ContentService.createTextOutput(JSON.stringify(out)).setMimeType(ContentService.MimeType.JSON);
}

/** PDFダウンロード記録: 「記録」シートに タイムスタンプ・ファイル名 を追記 */
function logPdfDownload(filename) {
  var sheet = SpreadsheetApp.getActiveSpreadsheet().getSheetByName('記録');
  sheet.appendRow([Utilities.formatDate(new Date(), getConfig_().timezone, 'yyyy/MM/dd HH:mm:ss'), filename]);
  return true;
}

/** ===================== キャッシュ(データ版数方式) ===================== */

/*
 * 集計結果などをCacheServiceに最大6時間保存する。キー名にデータ版数を含め、
 * 保存(saveRecord)や clearCache() で版数を更新すると、古いキャッシュは自動的に使われなくなる。
 *  - dataVer  : 不具合記録・集計用   - masterVer: マスタ用(物件追加などで更新)
 * CacheServiceは1件100KBまで・キーは250文字までのため、大きい値は分割し、長いキーはハッシュにする。
 */
var CACHE_TTL = 21600;      // 6時間(CacheServiceの上限)
var CHUNK_CHARS = 25000;    // 日本語は1文字3バイトでも 75KB < 100KB
var _verMemo_ = {};

function ver_(name) {
  if (_verMemo_[name]) return _verMemo_[name];
  var cache = CacheService.getScriptCache();
  var v = cache.get(name);
  if (!v) { v = String(Date.now()); cache.put(name, v, CACHE_TTL); }
  _verMemo_[name] = v;
  return v;
}

function bumpVer_(name) {
  var v = String(Date.now());
  CacheService.getScriptCache().put(name, v, CACHE_TTL);
  _verMemo_[name] = v;
}

function hashStr_(s) {
  var h1 = 5381, h2 = 52711;
  for (var i = 0; i < s.length; i++) {
    var c = s.charCodeAt(i);
    h1 = ((h1 * 33) ^ c) >>> 0;
    h2 = ((h2 * 31) + c) >>> 0;
  }
  return h1.toString(36) + h2.toString(36) + s.length.toString(36);
}

function cacheKey_(prefix, sub) {
  var key = prefix + ':' + sub;
  return key.length > 200 ? prefix + ':h' + hashStr_(sub) : key;
}

/** 値(JSON化できるもの)を保存用のキー/値の組にする。短ければ1件、長ければ分割 */
function packBig_(key, obj) {
  var s = JSON.stringify(obj);
  var pairs = {};
  if (s.length <= CHUNK_CHARS) {
    pairs[key] = 's' + s;
    return pairs;
  }
  var n = Math.ceil(s.length / CHUNK_CHARS);
  for (var i = 0; i < n; i++) pairs[key + '#' + i] = s.substr(i * CHUNK_CHARS, CHUNK_CHARS);
  pairs[key] = 'c' + n;
  return pairs;
}

function cachePutPairs_(pairs) {
  try { CacheService.getScriptCache().putAll(pairs, CACHE_TTL); } catch (e) {}
}

function cachePutBig_(key, obj) {
  cachePutPairs_(packBig_(key, obj));
}

/** 保存済みの値を返す。無い/欠けているときはnull */
function cacheGetBig_(key) {
  var cache = CacheService.getScriptCache();
  var head = cache.get(key);
  if (head === null || head === undefined) return null;
  try {
    if (head.charAt(0) === 's') return JSON.parse(head.substr(1));
    var n = Number(head.substr(1)), keys = [];
    for (var i = 0; i < n; i++) keys.push(key + '#' + i);
    var got = cache.getAll(keys), s = '';
    for (var j = 0; j < n; j++) {
      var part = got[keys[j]];
      if (part === null || part === undefined) return null;
      s += part;
    }
    return JSON.parse(s);
  } catch (e) { return null; }
}

/** 不具合記録に関する結果を、データ版数つきでキャッシュして返す */
function cachedData_(sub, build) {
  var key = cacheKey_('kd:' + ver_('dataVer'), sub);
  var hit = cacheGetBig_(key);
  if (hit !== null) return hit;
  var out = build();
  cachePutBig_(key, out);
  return out;
}

/** 画面の「最新に更新」用: すべてのキャッシュを無効にする(生産重量は残す) */
function clearCache() {
  bumpVer_('dataVer');
  bumpVer_('masterVer');
  _dataMemo_ = null;
  _aggMemo_ = null;
  return true;
}

/** ===================== 設定 ===================== */

var _configCache_ = null;

function getConfig_() {
  if (_configCache_) return _configCache_;
  var cache = CacheService.getScriptCache();
  var hit = cache.get('config_v2');
  if (hit) { _configCache_ = JSON.parse(hit); return _configCache_; }
  var ss = SpreadsheetApp.getActiveSpreadsheet();
  var sheet = ss.getSheetByName(CONFIG_SHEET_NAME);
  var rows = sheet.getDataRange().getValues();
  var map = {};
  rows.forEach(function (r) {
    if (r[0]) map[String(r[0]).trim()] = r[1];
  });
  _configCache_ = {
    sourceSpreadsheetId: map['データソーススプシID'],
    driveFolderId: map['写真保存用DriveフォルダID'],
    timezone: map['タイムゾーン'] || 'Asia/Tokyo',
    productionWeightSpreadsheetId: map['生産重量マスタ'],
    apiKey: map['APIKEY']
  };
  try { cache.put('config_v2', JSON.stringify(_configCache_), 600); } catch (e) {}
  return _configCache_;
}

function getSourceSS_() {
  return SpreadsheetApp.openById(getConfig_().sourceSpreadsheetId);
}

function getProductionSS_() {
  return SpreadsheetApp.openById(getConfig_().productionWeightSpreadsheetId);
}

function sheetToObjects_(sheet) {
  var data = sheet.getDataRange().getValues();
  var headers = data[0];
  return data.slice(1)
    .filter(function (r) { return r.some(function (v) { return v !== '' && v !== null; }); })
    .map(function (row) {
      var obj = {};
      headers.forEach(function (h, i) { obj[h] = row[i]; });
      return obj;
    });
}

/** ===================== 日付ヘルパー ===================== */

/** yyyy-MM-dd。Asia/Tokyoは夏時間なし(UTC+9固定)のため、GASサービスを呼ばず計算する(行数分の呼び出しを省く) */
function formatYmd_(d, tz) {
  if (tz === 'Asia/Tokyo') {
    var t = new Date(d.getTime() + 9 * 60 * 60 * 1000);
    var m = t.getUTCMonth() + 1, day = t.getUTCDate();
    return t.getUTCFullYear() + '-' + (m < 10 ? '0' : '') + m + '-' + (day < 10 ? '0' : '') + day;
  }
  return Utilities.formatDate(d, tz, 'yyyy-MM-dd');
}

/** m/d 形式(例 10/5)。Asia/Tokyoは固定オフセットで計算 */
function formatMd_(d, tz) {
  if (tz === 'Asia/Tokyo') {
    var t = new Date(d.getTime() + 9 * 60 * 60 * 1000);
    return (t.getUTCMonth() + 1) + '/' + t.getUTCDate();
  }
  return Utilities.formatDate(d, tz, 'M/d');
}

/**
 * 締め月ルール: 21日始まり・20日締め（前月21日〜当月20日が対象期間）。
 * 会計年度は11月21日スタート・翌年11月20日決算（例: 2026年度＝2025/11/21〜2026/11/20）のため、
 * 締め月が12月の場合のみ「締め年+1=会計年度」、それ以外は「締め年=会計年度」となる。
 * 日付は日本時間(UTC+9)で判定する(スクリプトのタイムゾーン設定に左右されない)。
 */
function getClosingInfo_(d) {
  var t = new Date(d.getTime() + 9 * 60 * 60 * 1000);
  var y = t.getUTCFullYear();
  var m = t.getUTCMonth() + 1;
  var day = t.getUTCDate();
  var closingMonth, closingYear;
  if (day <= 20) {
    closingMonth = m;
    closingYear = y;
  } else if (m === 12) {
    closingMonth = 1;
    closingYear = y + 1;
  } else {
    closingMonth = m + 1;
    closingYear = y;
  }
  var fiscalYear = (closingMonth === 12) ? closingYear + 1 : closingYear;
  return { fiscalYear: fiscalYear, closingMonth: closingMonth };
}

function rowToObject_(headers, row, tz) {
  var obj = {};
  headers.forEach(function (h, i) {
    var v = row[i];
    obj[h] = (v instanceof Date) ? formatYmd_(v, tz) : v;
  });
  return obj;
}

/** ===================== マスタデータ ===================== */

function getMasterData() {
  var key = cacheKey_('mst:' + ver_('masterVer'), 'all');
  var hit = cacheGetBig_(key);
  if (hit !== null) return hit;
  var data = buildMasterData_();
  cachePutBig_(key, data);
  return data;
}

function buildMasterData_() {
  var ss = getSourceSS_();

  var HIDDEN_INSPECTORS = ['角賢二'];
  var inspectors = sheetToObjects_(ss.getSheetByName(INSPECTOR_SHEET)).map(function (i) { return i['検査員']; })
    .filter(function (name) { return HIDDEN_INSPECTORS.indexOf(name) === -1; });
  var classifications = sheetToObjects_(ss.getSheetByName(CLASS_SHEET));
  var names = sheetToObjects_(ss.getSheetByName(NAME_SHEET));

  var propRows = ss.getSheetByName(PROPERTY_SHEET).getDataRange().getValues();
  var properties = propRows.slice(1).map(function (r) { return r[0]; }).filter(function (v) { return v; }).reverse();

  var departments = [];
  names.forEach(function (n) {
    if (n['部署'] && departments.indexOf(n['部署']) === -1) departments.push(n['部署']);
  });

  return {
    inspectors: inspectors,
    classifications: classifications,
    properties: properties,
    names: names,
    departments: departments
  };
}

/** 分類 -> 加工分類(柱/梁)。マスタ(キャッシュ済み)から作るので分類シートは読み直さない */
function getClassGroupMap_() {
  var map = {};
  getMasterData().classifications.forEach(function (c) { map[c['分類']] = c['加工分類']; });
  return map;
}

function addNewProperty_(ss, name) {
  if (!name) return;
  var sheet = ss.getSheetByName(PROPERTY_SHEET);
  var existing = sheet.getDataRange().getValues().map(function (r) { return String(r[0]); });
  if (existing.indexOf(name) === -1) sheet.appendRow([name]);
}

/** ===================== ID生成 ===================== */

function generateId_(existingIds) {
  var chars = '0123456789abcdef';
  var id;
  do {
    id = '';
    for (var i = 0; i < 8; i++) id += chars.charAt(Math.floor(Math.random() * chars.length));
  } while (existingIds.indexOf(id) !== -1);
  return id;
}

/** ===================== 保存・更新 ===================== */

function mapFormToColumn_(col, f) {
  switch (col) {
    case '不具合記録ID': return f.id || '';
    case '発生日': return f['発生日'] ? new Date(f['発生日'] + 'T00:00:00') : '';
    case '選択物件名': return f['選択物件名'] || '';
    case '製品名': return f['製品名'] || '';
    case '部署選択(対象者)': return f['部署対象者'] || '';
    case '対象者': return f['対象者'] || '';
    case '梁ロボ': return f['梁ロボ'] || '';
    case '加工先': return f['加工先'] || '';
    case '分類選択': return f['分類選択'] || '';
    case '不具合内容、原因': return f['不具合内容'] || '';
    case '部署選択(処理者)': return f['部署処理者'] || '';
    case '処理者': return f['処理者'] || '';
    case '対策': return f['対策'] || '';
    case '検査確認者': return f['検査確認者'] || '';
    case 'コメント有無': return f['コメント有無'] || '';
    case 'コメント': return (f['コメント有無'] === 'あり') ? (f['コメント'] || '') : '';
    case '状況写真': return f['状況写真Url'] || '';
    case '製品名写真': return f['製品名写真Url'] || '';
    case '状況写真2': return '';
    default: return '';
  }
}

/**
 * 保存: ID列だけを読み(全列は読まない)、同時保存で重複しないようロックを取る。
 * 記録の保存が成功してから、新規物件をマスタへ追加する(保存に失敗して物件だけ残るのを防ぐ)。
 */
function saveRecord(formData) {
  var ss = getSourceSS_();
  var sheet = ss.getSheetByName(DATA_SHEET);
  var rowData = COLUMNS.map(function (col) { return mapFormToColumn_(col, formData); });
  var result;

  var lock = LockService.getScriptLock();
  lock.waitLock(20000);
  try {
    var lastRow = sheet.getLastRow();
    var headers = sheet.getRange(1, 1, 1, sheet.getLastColumn()).getValues()[0];
    var idCol = headers.indexOf('不具合記録ID') + 1;
    var ids = lastRow > 1 ? sheet.getRange(2, idCol, lastRow - 1, 1).getValues() : [];

    if (formData.id) {
      var targetRow = -1;
      for (var i = 0; i < ids.length; i++) {
        if (String(ids[i][0]) === String(formData.id)) { targetRow = i + 2; break; }
      }
      if (targetRow === -1) throw new Error('レコードが見つかりません: ' + formData.id);
      rowData[0] = formData.id;
      // 画面にある列だけ書き込む。連続する列ごとにまとめて書き、画面に無い列(処理者・状況写真2)には触れない
      var start = 0;
      while (start < COLUMNS.length) {
        if (COLUMNS_NOT_ON_FORM.indexOf(COLUMNS[start]) !== -1) { start++; continue; }
        var end = start;
        while (end + 1 < COLUMNS.length && COLUMNS_NOT_ON_FORM.indexOf(COLUMNS[end + 1]) === -1) end++;
        sheet.getRange(targetRow, start + 1, 1, end - start + 1).setValues([rowData.slice(start, end + 1)]);
        start = end + 1;
      }
      result = { id: formData.id, isNew: false };
    } else {
      var existingIds = ids.map(function (r) { return String(r[0]); });
      var newId = generateId_(existingIds);
      rowData[0] = newId;
      sheet.appendRow(rowData);
      result = { id: newId, isNew: true };
    }
  } finally {
    lock.releaseLock();
  }

  _dataMemo_ = null;
  _aggMemo_ = null;
  bumpVer_('dataVer');
  if (formData.isNewProperty) {
    addNewProperty_(ss, formData['選択物件名']);
    bumpVer_('masterVer');
  }
  return result;
}

/** ===================== 不具合記録の読込(1リクエスト1回) ===================== */

var _dataMemo_ = null;

function loadData_() {
  if (_dataMemo_) return _dataMemo_;
  var sheet = getSourceSS_().getSheetByName(DATA_SHEET);
  var values = sheet.getDataRange().getValues();
  var headers = values[0];
  _dataMemo_ = {
    headers: headers,
    rows: values.slice(1),
    id: headers.indexOf('不具合記録ID'),
    date: headers.indexOf('発生日'),
    prop: headers.indexOf('選択物件名'),
    proc: headers.indexOf('加工先'),
    cls: headers.indexOf('分類選択'),
    detail: headers.indexOf('不具合内容、原因')
  };
  return _dataMemo_;
}

/** 日付の新しい順に並べる(同日は元の並び順) */
function sortByDateDesc_(rows, dateIdx) {
  return rows.slice().sort(function (a, b) { return b[dateIdx] - a[dateIdx]; });
}

/** ===================== 不具合記録の取得 ===================== */

/**
 * 全記録を年度ごとにまとめた一覧データを作る(キャッシュ用)。
 * years[年度] = { rows: 日付の新しい順の記録, cm: 各記録の締め月 }
 */
function buildRecordsAll_() {
  var d = loadData_();
  var tz = getConfig_().timezone;
  var yearCounts = {}, yearMonthCounts = {}, perYear = {}, undated = 0;
  d.rows.forEach(function (r) {
    if (!r[d.id]) return;
    if (!(r[d.date] instanceof Date)) { undated++; return; }
    var info = getClosingInfo_(r[d.date]);
    yearCounts[info.fiscalYear] = (yearCounts[info.fiscalYear] || 0) + 1;
    var key = info.fiscalYear + '-' + info.closingMonth;
    yearMonthCounts[key] = (yearMonthCounts[key] || 0) + 1;
    if (!perYear[info.fiscalYear]) perYear[info.fiscalYear] = [];
    perYear[info.fiscalYear].push({ r: r, cm: info.closingMonth });
  });
  var years = {};
  Object.keys(perYear).forEach(function (y) {
    var list = perYear[y].slice().sort(function (a, b) { return b.r[d.date] - a.r[d.date]; });
    years[y] = {
      rows: list.map(function (x) { return rowToObject_(d.headers, x.r, tz); }),
      cm: list.map(function (x) { return x.cm; })
    };
  });
  return { sum: { yearCounts: yearCounts, yearMonthCounts: yearMonthCounts, undated: undated }, years: years };
}

/** 一覧データの1項目('sum'または年度)を返す。無ければ全体を作って保存する */
function recordsEntry_(sub) {
  var prefix = 'kr:' + ver_('dataVer');
  var hit = cacheGetBig_(cacheKey_(prefix, String(sub)));
  if (hit !== null) return hit;
  var all = buildRecordsAll_();
  fillRecordsCache_(all);
  return String(sub) === 'sum' ? all.sum : (all.years[sub] || { rows: [], cm: [] });
}

function fillRecordsCache_(all) {
  all = all || buildRecordsAll_();
  var prefix = 'kr:' + ver_('dataVer');
  var pairs = packBig_(cacheKey_(prefix, 'sum'), all.sum);
  Object.keys(all.years).forEach(function (y) {
    var p = packBig_(cacheKey_(prefix, y), all.years[y]);
    for (var k in p) pairs[k] = p[k];
  });
  cachePutPairs_(pairs);
}

function getRecords(year, month) {
  // 年度の指定が無いのは、日付のある記録が1件も無いとき(画面は必ず年度を選んで呼ぶ)
  if (!year) return { rows: [], total: 0 };
  var sum = recordsEntry_('sum');
  if (!sum.yearCounts[Number(year)]) return { rows: [], total: 0 };
  var entry = recordsEntry_(Number(year));
  if (!month) return { rows: entry.rows, total: entry.rows.length };
  var rows = entry.rows.filter(function (x, i) { return entry.cm[i] === Number(month); });
  return { rows: rows, total: rows.length };
}

/** 不具合記録一覧の初回表示専用: 年度サマリーと最新年度分の一覧 */
function getRecordsBootstrap() {
  var sum = recordsEntry_('sum');
  var years = Object.keys(sum.yearCounts).map(Number).sort(function (a, b) { return b - a; });
  var defaultYear = years.length ? years[0] : null;
  var rows = defaultYear !== null ? recordsEntry_(defaultYear).rows : [];
  return {
    summary: { yearCounts: sum.yearCounts, yearMonthCounts: sum.yearMonthCounts },
    year: defaultYear,
    rows: rows,
    total: rows.length,
    undated: sum.undated
  };
}

/** ===================== 結果仕訳け ===================== */

function getBunsekiByField(fieldName) {
  return cachedData_('bf:' + fieldName, function () {
    var d = loadData_();
    var idx = d.headers.indexOf(fieldName);
    var counts = {};
    d.rows.forEach(function (r) {
      if (!r[d.id]) return;
      var v = r[idx] || '(未設定)';
      counts[v] = (counts[v] || 0) + 1;
    });
    return counts;
  });
}

function getBunsekiByProcessType(mode) {
  return cachedData_('bp:' + mode, function () {
    var d = loadData_();
    var rows = d.rows.filter(function (r) { return r[d.id]; });
    var counts = { '柱': 0, '梁': 0 };
    if (mode === '加工先') {
      rows.forEach(function (r) {
        var v = r[d.proc];
        if (counts[v] !== undefined) counts[v]++;
      });
    } else if (mode === '分類') {
      var classMap = getClassGroupMap_();
      rows.forEach(function (r) {
        var group = classMap[r[d.cls]];
        if (counts[group] !== undefined) counts[group]++;
      });
    }
    return counts;
  });
}

function getFilteredRecords(field, value) {
  return cachedData_('fr:' + field + '|' + value, function () {
    var d = loadData_();
    var tz = getConfig_().timezone;
    var rows = d.rows.filter(function (r) { return r[d.id]; });
    if (field === '分類グループ') {
      var classMap = getClassGroupMap_();
      rows = rows.filter(function (r) { return classMap[r[d.cls]] === value; });
    } else {
      var idx = d.headers.indexOf(field);
      rows = rows.filter(function (r) { return (r[idx] || '(未設定)') === value; });
    }
    rows = sortByDateDesc_(rows, d.date);
    return rows.map(function (r) { return rowToObject_(d.headers, r, tz); });
  });
}

/**
 * 結果分析画面の「不具合内容（件数）」テーブル行クリック用: 指定した分類（不具合内容）に
 * 一致し、かつ表示中のスコープ（年度/月/工事/工事+選択締め月）に該当する記録一覧を返す。
 */
function getKekkaBunsekiContentRecords(filter) {
  return cachedData_('cr:' + JSON.stringify(filter), function () {
    var d = loadData_();
    var tz = getConfig_().timezone;
    var rows = d.rows.filter(function (r) { return r[d.id] && (r[d.date] instanceof Date); });
    rows = rows.filter(function (r) {
      var content = r[d.cls] || '(未設定)';
      if (content !== filter.content) return false;
      if (filter.scope === 'year') {
        return getClosingInfo_(r[d.date]).fiscalYear === Number(filter.year);
      }
      if (filter.scope === 'month') {
        var info = getClosingInfo_(r[d.date]);
        return info.fiscalYear === Number(filter.year) && info.closingMonth === Number(filter.month);
      }
      if (filter.scope === 'project') {
        return r[d.prop] === filter.project;
      }
      if (filter.scope === 'projectPeriods') {
        if (r[d.prop] !== filter.project) return false;
        var info2 = getClosingInfo_(r[d.date]);
        var key = info2.fiscalYear + '-' + info2.closingMonth;
        return (filter.periodKeys || []).indexOf(key) !== -1;
      }
      return false;
    });
    rows = sortByDateDesc_(rows, d.date);
    return rows.map(function (r) { return rowToObject_(d.headers, r, tz); });
  });
}

/** ===================== 生産重量 ===================== */

/*
 * 生産重量マスタ（マスタQUERY）の「QUERY」シートを締め月単位（fiscalYear-closingMonth）で
 * 重量合計にまとめる。このスプレッドシートを開くだけで約12秒かかる(QUERY数式の再計算と推測)。
 * 重量の反映は1日1回のため、結果は CacheService(6時間) と スクリプトプロパティ(永続) の2か所に保存し、
 * 毎朝7〜8時のトリガー(warmProductionWeightCache)で更新する(元のマスタQUERYが更新された後に読むため。2時に読むと前日分が入らず値が古くなった)。画面は保存済みの値を即表示する。
 * 列構成: A工事番号 B部位 C加工先 D製品マーク E長さ F本数 G重量 H加工(日付)
 */
var WEIGHT_KEY = 'pw2';
var WEIGHT_FRESH_MS = 26 * 60 * 60 * 1000; // これより古い場合は「更新が必要」として画面が裏で再取得する

/** 保存済みの重量 { t: 保存時刻, map: {'年度-締め月': 重量} } を返す。無ければnull */
function readWeightStore_() {
  var cache = CacheService.getScriptCache();
  var c = cache.get(WEIGHT_KEY);
  if (c) { try { return JSON.parse(c); } catch (e) {} }
  var p = PropertiesService.getScriptProperties().getProperty(WEIGHT_KEY);
  if (p) {
    try {
      var o = JSON.parse(p);
      try { cache.put(WEIGHT_KEY, p, CACHE_TTL); } catch (e2) {}
      return o;
    } catch (e3) {}
  }
  return null;
}

function writeWeightStore_(map) {
  var o = { t: Date.now(), map: map };
  var s = JSON.stringify(o);
  try { CacheService.getScriptCache().put(WEIGHT_KEY, s, CACHE_TTL); } catch (e) {}
  PropertiesService.getScriptProperties().setProperty(WEIGHT_KEY, s);
  return o;
}

/** 重い再計算(約12秒)。QUERYシートを読んで締め月ごとの重量にまとめる */
function computeProductionWeights_() {
  var ss = getProductionSS_();
  var sheet = ss.getSheetByName(PRODUCTION_SHEET_NAME);
  // getDataRange()はA列末尾の見かけ上の使用範囲(書式のみの空セル等)まで含んでしまうことがあるため、
  // A列に実際にデータが入っている最終行だけを対象にする。
  var lastRow = sheet.getRange(sheet.getMaxRows(), 1).getNextDataCell(SpreadsheetApp.Direction.UP).getRow();
  var result = {};
  if (lastRow > 1) {
    var values = sheet.getRange(2, 1, lastRow - 1, 8).getValues();
    for (var i = 0; i < values.length; i++) {
      var row = values[i];
      var dateVal = row[7];
      if (!row[0] || !(dateVal instanceof Date)) continue;
      var weight = Number(row[6]) || 0;
      var info = getClosingInfo_(dateVal);
      var key = info.fiscalYear + '-' + info.closingMonth;
      result[key] = (result[key] || 0) + weight;
    }
  }

  return result;
}

/** 重量を再計算して保存する */
function refreshWeights_() {
  return writeWeightStore_(computeProductionWeights_());
}

/** 画面が起動時に裏で呼ぶ: 新しい保存値があればそのまま返し、古い/無いときだけ再計算する */
function getProductionWeights() {
  var st = readWeightStore_();
  if (st && Date.now() - st.t <= WEIGHT_FRESH_MS) return st.map;
  return refreshWeights_().map;
}

/** 重量を付ける(年度・月の中身だけ。印は付けない) */
function setWeights_(out, kind, st) {
  var map = st ? st.map : {};
  var r1 = function (w) { return st ? Math.round((w || 0) * 10) / 10 : null; };
  if (kind === 'year') {
    out.months.forEach(function (m) { m['生産重量'] = r1(map[out.year + '-' + m.closingMonth]); });
  } else if (kind === 'month') {
    out['生産重量'] = r1(map[out.year + '-' + out.month]);
  }
}

/** 結果分析の出力に重量を付ける。保存値が無ければ重量はnull(画面が後から差し替える) */
function applyWeights_(out, kind) {
  var st = readWeightStore_();
  if (kind === 'bootstrap') {
    if (out.yearData) setWeights_(out.yearData, 'year', st);
    if (out.monthData) setWeights_(out.monthData, 'month', st);
  } else {
    setWeights_(out, kind, st);
  }
  out.weightReady = !!st;
  out.weightStale = !st || (Date.now() - st.t > WEIGHT_FRESH_MS);
  return out;
}

/** 毎朝7〜8時のトリガー: 重量を再計算して保存し、集計・一覧のキャッシュも作り直す */
function warmProductionWeightCache() {
  refreshWeights_();
  warmCaches_();
}

function warmCaches_() {
  var key = cacheKey_('mst:' + ver_('masterVer'), 'all');
  cachePutBig_(key, buildMasterData_());
  fillAnalysisCache_();
  fillRecordsCache_();
}

/**
 * セットアップ用(初回のみApps Scriptエディタから手動実行): 毎朝7〜8時(重量の更新+キャッシュの作り直し)の
 * 時間主導トリガーを登録する。再実行しても重複登録しないよう既存分を削除してから作る。
 */
function setupProductionWeightCacheTrigger() {
  ScriptApp.getProjectTriggers().forEach(function (t) {
    var f = t.getHandlerFunction();
    // warmAnalysisCaches は廃止した旧トリガー(関数は削除済み)。残っていれば一緒に消す
    if (f === 'warmProductionWeightCache' || f === 'warmAnalysisCaches') ScriptApp.deleteTrigger(t);
  });
  ScriptApp.newTrigger('warmProductionWeightCache').timeBased().everyDays(1).atHour(7).create();
}

/** ===================== 結果分析(集計) ===================== */

/** 工事(物件)別の 柱/梁 件数を加算する。キーに接頭辞を付けて予約語(constructor等)と衝突させない */
function addProjectCount_(map, prop, proc) {
  var k = 'p_' + prop;
  if (!map[k]) map[k] = { name: prop, '柱': 0, '梁': 0 };
  if (proc === '柱' || proc === '梁') map[k][proc]++;
}

/** 件数の多い工事順(同数は工事名順)。柱・梁どちらも0件の工事は除く(合計件数の定義と同じ) */
function projectCountsList_(map) {
  return Object.keys(map || {}).map(function (k) {
    var o = map[k];
    return { name: o.name, '柱': o['柱'], '梁': o['梁'], total: o['柱'] + o['梁'] };
  }).filter(function (o) { return o.total > 0; })
    .sort(function (a, b) { return b.total - a.total || (a.name < b.name ? -1 : a.name > b.name ? 1 : 0); });
}

/** 月の明細: 日付の古い順(同日は元の並び順)。並べ替え用の時刻は外して返す */
function detailsList_(list) {
  return (list || []).map(function (d, i) { return { d: d, i: i }; })
    .sort(function (a, b) { return a.d.t - b.d.t || a.i - b.i; })
    .map(function (x) { return { date: x.d.date, project: x.d.project, proc: x.d.proc, content: x.d.content }; });
}

function sortedCounts_(counts, classMap) {
  return Object.keys(counts)
    .map(function (k) {
      var item = { name: k, count: counts[k] };
      if (classMap) item.group = classMap[k] || '';
      return item;
    })
    .sort(function (a, b) { return b.count - a.count; });
}

var _aggMemo_ = null;

/** 集計は1リクエストにつき1回だけ作る(キャッシュミス時の「要求分」と「まとめ保存」で使い回す) */
function buildAgg_() {
  if (!_aggMemo_) _aggMemo_ = computeAgg_();
  return _aggMemo_;
}

/** 全記録を1回走査して、年度/月/工事/明細の集計をまとめて作る(Year・Month・Bootstrap・ByProject共通) */
function computeAgg_() {
  var d = loadData_();
  var tz = getConfig_().timezone;
  var agg = {
    classMap: getClassGroupMap_(),
    yearCounts: {}, yearMonthCounts: {},
    perYearMonth: {}, perYearProc: {},
    perYearContent: {}, perYMContent: {},
    perYearProjects: {}, perYMProjects: {}, perYMDetails: {},
    byProject: {}
  };
  d.rows.forEach(function (r) {
    if (!r[d.id] || !(r[d.date] instanceof Date)) return;
    var info = getClosingInfo_(r[d.date]);
    var y = info.fiscalYear, m = info.closingMonth;
    var ymKey = y + '-' + m;
    var proc = r[d.proc];
    var content = r[d.cls] || '(未設定)';
    var rawProp = r[d.prop];
    var prop = rawProp || '(未設定)';

    agg.yearCounts[y] = (agg.yearCounts[y] || 0) + 1;
    agg.yearMonthCounts[ymKey] = (agg.yearMonthCounts[ymKey] || 0) + 1;

    if (!agg.perYearMonth[y]) agg.perYearMonth[y] = {};
    if (!agg.perYearMonth[y][m]) agg.perYearMonth[y][m] = { '柱': 0, '梁': 0 };
    if (agg.perYearMonth[y][m][proc] !== undefined) agg.perYearMonth[y][m][proc]++;

    if (!agg.perYearProc[y]) agg.perYearProc[y] = { pillarTotal: 0, beamTotal: 0 };
    if (proc === '柱') agg.perYearProc[y].pillarTotal++;
    else if (proc === '梁') agg.perYearProc[y].beamTotal++;

    if (!agg.perYearContent[y]) agg.perYearContent[y] = {};
    agg.perYearContent[y][content] = (agg.perYearContent[y][content] || 0) + 1;
    if (!agg.perYMContent[ymKey]) agg.perYMContent[ymKey] = {};
    agg.perYMContent[ymKey][content] = (agg.perYMContent[ymKey][content] || 0) + 1;

    if (!agg.perYearProjects[y]) agg.perYearProjects[y] = {};
    addProjectCount_(agg.perYearProjects[y], prop, proc);
    if (!agg.perYMProjects[ymKey]) agg.perYMProjects[ymKey] = {};
    addProjectCount_(agg.perYMProjects[ymKey], prop, proc);

    if (!agg.perYMDetails[ymKey]) agg.perYMDetails[ymKey] = [];
    agg.perYMDetails[ymKey].push({ t: r[d.date].getTime(), date: formatMd_(r[d.date], tz), project: prop, proc: proc || '', content: r[d.detail] || '' });

    // 工事別分析(物件名は空欄も含めた元の値で突き合わせる)
    var pk = typeof rawProp + ':' + rawProp;
    var bp = agg.byProject[pk] || (agg.byProject[pk] = { byPeriod: {}, pillarTotal: 0, beamTotal: 0, contentTotal: {} });
    if (!bp.byPeriod[ymKey]) {
      bp.byPeriod[ymKey] = {
        key: ymKey, fiscalYear: y, closingMonth: m,
        sortOrder: y * 12 + MONTH_ORDER.indexOf(m),
        '柱': 0, '梁': 0, '合計': 0, contentCounts: {}
      };
    }
    var per = bp.byPeriod[ymKey];
    if (per[proc] !== undefined) per[proc]++;
    per['合計']++;
    if (proc === '柱') bp.pillarTotal++;
    else if (proc === '梁') bp.beamTotal++;
    per.contentCounts[content] = (per.contentCounts[content] || 0) + 1;
    bp.contentTotal[content] = (bp.contentTotal[content] || 0) + 1;
  });
  return agg;
}

/** 年度の出力(重量は含まない。重量は返す直前にapplyWeights_で付ける) */
function buildYearOut_(agg, year, now) {
  var byMonth = agg.perYearMonth[year] || {};
  var totals = agg.perYearProc[year] || { pillarTotal: 0, beamTotal: 0 };
  var months = MONTH_ORDER.filter(function (m) {
    if (year < now.fiscalYear) return true;
    if (year > now.fiscalYear) return false;
    return MONTH_ORDER.indexOf(m) <= MONTH_ORDER.indexOf(now.closingMonth);
  }).map(function (m) {
    var data = byMonth[m] || { '柱': 0, '梁': 0 };
    var displayYear = (m === 12) ? year - 1 : year;
    return { closingMonth: m, label: displayYear + '/' + m, '柱': data['柱'], '梁': data['梁'], '合計': data['柱'] + data['梁'] };
  });
  return {
    projectCounts: projectCountsList_(agg.perYearProjects[year]),
    year: year,
    months: months,
    pillarTotal: totals.pillarTotal,
    beamTotal: totals.beamTotal,
    total: totals.pillarTotal + totals.beamTotal,
    contentCounts: sortedCounts_(agg.perYearContent[year] || {}, agg.classMap)
  };
}

function buildMonthOut_(agg, year, month) {
  var key = year + '-' + month;
  var counts = (agg.perYearMonth[year] && agg.perYearMonth[year][month]) || { '柱': 0, '梁': 0 };
  var displayYear = (month === 12) ? year - 1 : year;
  return {
    projectCounts: projectCountsList_(agg.perYMProjects[key]),
    details: detailsList_(agg.perYMDetails[key]),
    year: year,
    month: month,
    label: displayYear + '/' + month,
    '柱': counts['柱'],
    '梁': counts['梁'],
    '合計': counts['柱'] + counts['梁'],
    contentCounts: sortedCounts_(agg.perYMContent[key] || {}, agg.classMap)
  };
}

function buildBootstrapOut_(agg, now) {
  var years = Object.keys(agg.yearCounts).map(Number).sort(function (a, b) { return b - a; });
  var defaultYear = (agg.yearCounts[now.fiscalYear] !== undefined) ? now.fiscalYear : (years.length ? years[0] : null);
  var defaultMonth = now.closingMonth;
  return {
    summary: { yearCounts: agg.yearCounts, yearMonthCounts: agg.yearMonthCounts },
    defaultYear: defaultYear,
    defaultMonth: defaultMonth,
    yearData: defaultYear !== null ? buildYearOut_(agg, defaultYear, now) : null,
    monthData: defaultYear !== null ? buildMonthOut_(agg, defaultYear, defaultMonth) : null
  };
}

function buildProjectOut_(agg, projectName) {
  var bp = agg.byProject['string:' + projectName] || { byPeriod: {}, pillarTotal: 0, beamTotal: 0, contentTotal: {} };
  var periods = Object.keys(bp.byPeriod).map(function (k) {
    var p = bp.byPeriod[k];
    var displayYear = (p.closingMonth === 12) ? p.fiscalYear - 1 : p.fiscalYear;
    return {
      key: p.key,
      label: displayYear + '/' + p.closingMonth,
      '柱': p['柱'], '梁': p['梁'], '合計': p['合計'],
      contentCounts: sortedCounts_(p.contentCounts, agg.classMap),
      sortOrder: p.sortOrder
    };
  }).sort(function (a, b) { return a.sortOrder - b.sortOrder; });
  return {
    project: projectName,
    periods: periods,
    pillarTotal: bp.pillarTotal,
    beamTotal: bp.beamTotal,
    total: bp.pillarTotal + bp.beamTotal,
    contentCounts: sortedCounts_(bp.contentTotal, agg.classMap)
  };
}

/** 集計結果のキー。「今」の締め月(結果分析の表示範囲が変わる)も含める */
function analysisPrefix_(now) {
  return 'ka:' + ver_('dataVer') + ':' + now.fiscalYear + '-' + now.closingMonth;
}

var _analysisFilled_ = false;

/** 集計結果を返す。無ければ作って保存し、初回はほかの年度・月・工事の分も先にまとめて保存する */
function analysis_(sub, build) {
  var now = getClosingInfo_(new Date());
  var key = cacheKey_(analysisPrefix_(now), sub);
  var hit = cacheGetBig_(key);
  if (hit !== null) return hit;
  var out = build(buildAgg_(), now);
  cachePutBig_(key, out);
  if (!_analysisFilled_) {
    _analysisFilled_ = true;
    try { fillAnalysisCache_(); } catch (e) {}
  }
  return out;
}

/** 全年度・全月・全工事の集計結果を1回の走査から作り、まとめて保存する */
function fillAnalysisCache_() {
  _analysisFilled_ = true;
  var agg = buildAgg_();
  var now = getClosingInfo_(new Date());
  var prefix = analysisPrefix_(now);
  var pairs = {};
  var put = function (sub, obj) {
    var p = packBig_(cacheKey_(prefix, sub), obj);
    for (var k in p) pairs[k] = p[k];
  };
  put('kb', buildBootstrapOut_(agg, now));
  Object.keys(agg.yearCounts).forEach(function (y) { put('ky:' + y, buildYearOut_(agg, Number(y), now)); });
  Object.keys(agg.yearMonthCounts).forEach(function (ym) {
    var parts = ym.split('-');
    put('km:' + ym, buildMonthOut_(agg, Number(parts[0]), Number(parts[1])));
  });
  Object.keys(agg.byProject).forEach(function (pk) {
    if (pk.indexOf('string:') !== 0) return;
    var name = pk.substr(7);
    put('kp:' + name, buildProjectOut_(agg, name));
  });
  cachePutPairs_(pairs);
}

function getKekkaBunsekiBootstrap() {
  return applyWeights_(analysis_('kb', buildBootstrapOut_), 'bootstrap');
}

function getKekkaBunsekiYear(year) {
  year = Number(year);
  return applyWeights_(analysis_('ky:' + year, function (agg, now) { return buildYearOut_(agg, year, now); }), 'year');
}

function getKekkaBunsekiMonth(year, month) {
  year = Number(year);
  month = Number(month);
  return applyWeights_(analysis_('km:' + year + '-' + month, function (agg) { return buildMonthOut_(agg, year, month); }), 'month');
}

/**
 * 工事別分析用: 指定した物件名（工事）の不具合記録を全期間（締め月単位）で集計する。
 * 生産重量マスタは工事番号キーのため物件名では突合できず、この集計には含めない。
 */
function getKekkaBunsekiByProject(projectName) {
  return analysis_('kp:' + projectName, function (agg) { return buildProjectOut_(agg, projectName); });
}

/** ===================== 写真アップロード ===================== */

function uploadPhoto(base64Data, mimeType, filename) {
  var cfg = getConfig_();
  var folder = DriveApp.getFolderById(cfg.driveFolderId);
  var bytes = Utilities.base64Decode(base64Data);
  var blob = Utilities.newBlob(bytes, mimeType, filename);
  var file = folder.createFile(blob);
  return file.getUrl();
}

/** ===================== Gemini OCR ===================== */

function ocrProductName(base64Data, mimeType) {
  var cfg = getConfig_();
  // 情報シートの項目名「APIKEY」の行から取得(getConfig_)
  var apiKey = cfg.apiKey;
  if (!apiKey) {
    throw new Error('情報シートの APIKEY の行が空です。');
  }

  var url = 'https://generativelanguage.googleapis.com/v1beta/models/' + GEMINI_MODEL + ':generateContent?key=' + apiKey;
  var payload = {
    contents: [{
      parts: [
        { text: '添付画像に記載されている製品名・型番のみを抽出して返答してください。前置きや説明文は不要です。抽出したテキストのみを1行で返してください。読み取れない場合は「読取不可」と返してください。' },
        { inline_data: { mime_type: mimeType, data: base64Data } }
      ]
    }]
  };
  var options = {
    method: 'post',
    contentType: 'application/json',
    payload: JSON.stringify(payload),
    muteHttpExceptions: true
  };

  var res = UrlFetchApp.fetch(url, options);
  var code = res.getResponseCode();
  var body = JSON.parse(res.getContentText());

  if (code !== 200) {
    throw new Error('Gemini APIエラー: ' + (body.error ? body.error.message : res.getContentText()));
  }

  var text = body.candidates && body.candidates[0] && body.candidates[0].content.parts[0].text;
  return (text || '').trim();
}
