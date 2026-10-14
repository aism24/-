/**
 * 社内不具合記録アプリ（鳥取）GAS版
 * このスクリプトは「社内不具合アプリVercel版」スプレッドシート（設定用コンテナ）にバインドする。
 * データ本体は別スプレッドシート（データソース）を ID 経由で読み書きする。
 */

var CONFIG_SHEET_NAME = '情報';
var DATA_SHEET = '不具合記録';
var INSPECTOR_SHEET = '検査員';
var CLASS_SHEET = '分類';
var PROPERTY_SHEET = '物件名';
var NAME_SHEET = '氏名';
var PRODUCTION_SHEET_NAME = 'QUERY';
var MONTH_ORDER = [12, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11];

var COLUMNS = [
  '不具合記録ID', '発生日', '選択物件名', '製品名', '部署選択(対象者)', '対象者',
  '梁ロボ', '加工先', '分類選択', '不具合内容、原因', '部署選択(処理者)', '処理者',
  '対策', '検査確認者', 'コメント有無', 'コメント', '状況写真', '製品名写真', '状況写真2'
];

/** JSON API: フロント(Vercel)から fetch(POST) で呼ばれる。許可した関数のみ実行 */
var API_FUNCTIONS = {
  getMasterData: getMasterData, saveRecord: saveRecord,
  getRecords: getRecords, getRecordsBootstrap: getRecordsBootstrap,
  getBunsekiByField: getBunsekiByField, getBunsekiByProcessType: getBunsekiByProcessType,
  getFilteredRecords: getFilteredRecords, getKekkaBunsekiContentRecords: getKekkaBunsekiContentRecords,
  getKekkaBunsekiBootstrap: getKekkaBunsekiBootstrap, getKekkaBunsekiYear: getKekkaBunsekiYear,
  getKekkaBunsekiMonth: getKekkaBunsekiMonth, getKekkaBunsekiByProject: getKekkaBunsekiByProject,
  uploadPhoto: uploadPhoto, ocrProductName: ocrProductName, logPdfDownload: logPdfDownload
};

function doGet() {
  return ContentService.createTextOutput('OK').setMimeType(ContentService.MimeType.TEXT);
}

function doPost(e) {
  var out;
  try {
    var req = JSON.parse(e.postData.contents);
    var fn = API_FUNCTIONS[req.fn];
    if (!fn) throw new Error('未対応の関数: ' + req.fn);
    out = { ok: true, data: fn.apply(null, req.args || []) };
  } catch (err) {
    out = { ok: false, error: String(err && err.message || err) };
  }
  return ContentService.createTextOutput(JSON.stringify(out)).setMimeType(ContentService.MimeType.JSON);
}

/** PDFダウンロード記録: 「記録」シートに タイムスタンプ・ファイル名 を追記 */
function logPdfDownload(filename) {
  var sheet = SpreadsheetApp.getActiveSpreadsheet().getSheetByName('記録');
  sheet.appendRow([Utilities.formatDate(new Date(), getConfig_().timezone, 'yyyy/MM/dd HH:mm:ss'), filename]);
  return true;
}

var _configCache_ = null;

function getConfig_() {
  if (_configCache_) return _configCache_;
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
    geminiModel: map['Geminiモデル名'],
    timezone: map['タイムゾーン'] || 'Asia/Tokyo',
    productionWeightSpreadsheetId: map['生産重量マスタ']
  };
  return _configCache_;
}

function getSourceSS_() {
  var cfg = getConfig_();
  return SpreadsheetApp.openById(cfg.sourceSpreadsheetId);
}

function getProductionSS_() {
  var cfg = getConfig_();
  return SpreadsheetApp.openById(cfg.productionWeightSpreadsheetId);
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

function rowToObject_(headers, row, tz) {
  var obj = {};
  headers.forEach(function (h, i) {
    var v = row[i];
    obj[h] = (v instanceof Date) ? Utilities.formatDate(v, tz, 'yyyy-MM-dd') : v;
  });
  return obj;
}

/** ===================== マスタデータ ===================== */

function getMasterData() {
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

function saveRecord(formData) {
  var ss = getSourceSS_();
  var sheet = ss.getSheetByName(DATA_SHEET);
  var values = sheet.getDataRange().getValues();
  var headers = values[0];
  var idColIdx = headers.indexOf('不具合記録ID');

  if (formData.isNewProperty) {
    addNewProperty_(ss, formData['選択物件名']);
  }

  var rowData = COLUMNS.map(function (col) { return mapFormToColumn_(col, formData); });

  if (formData.id) {
    var targetRow = -1;
    for (var i = 1; i < values.length; i++) {
      if (String(values[i][idColIdx]) === String(formData.id)) { targetRow = i + 1; break; }
    }
    if (targetRow === -1) throw new Error('レコードが見つかりません: ' + formData.id);
    rowData[0] = formData.id;
    sheet.getRange(targetRow, 1, 1, rowData.length).setValues([rowData]);
    return { id: formData.id, isNew: false };
  } else {
    var existingIds = values.slice(1).map(function (r) { return String(r[idColIdx]); });
    var newId = generateId_(existingIds);
    rowData[0] = newId;
    sheet.appendRow(rowData);
    return { id: newId, isNew: true };
  }
}

/** ===================== 不具合記録の取得 ===================== */

/**
 * 締め月ルール: 21日始まり・20日締め（前月21日〜当月20日が対象期間）。
 * 会計年度は11月21日スタート・翌年11月20日決算（例: 2026年度＝2025/11/21〜2026/11/20）のため、
 * 締め月が12月の場合のみ「締め年+1=会計年度」、それ以外は「締め年=会計年度」となる。
 */
function getClosingInfo_(d) {
  var y = d.getFullYear();
  var m = d.getMonth() + 1;
  var day = d.getDate();
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

function getRecords(year, month) {
  var ss = getSourceSS_();
  var cfg = getConfig_();
  var sheet = ss.getSheetByName(DATA_SHEET);
  var values = sheet.getDataRange().getValues();
  var headers = values[0];
  var idIdx = headers.indexOf('不具合記録ID');
  var dateIdx = headers.indexOf('発生日');

  var rows = values.slice(1).filter(function (r) { return r[idIdx]; });

  var filtered = rows.filter(function (r) {
    var d = r[dateIdx];
    if (!(d instanceof Date)) return false;
    var info = getClosingInfo_(d);
    if (year && info.fiscalYear !== Number(year)) return false;
    if (month && info.closingMonth !== Number(month)) return false;
    return true;
  });

  filtered.sort(function (a, b) { return b[dateIdx] - a[dateIdx]; });

  return {
    rows: filtered.map(function (r) { return rowToObject_(headers, r, cfg.timezone); }),
    total: filtered.length
  };
}

/**
 * 不具合記録一覧の初回表示専用: 年度サマリー(年度/月セレクト用件数)と最新年度分の一覧を
 * 不具合記録シートの1回の読み込みだけでまとめて計算する。
 */
function getRecordsBootstrap() {
  var ss = getSourceSS_();
  var cfg = getConfig_();
  var sheet = ss.getSheetByName(DATA_SHEET);
  var values = sheet.getDataRange().getValues();
  var headers = values[0];
  var idIdx = headers.indexOf('不具合記録ID');
  var dateIdx = headers.indexOf('発生日');

  var rows = values.slice(1).filter(function (r) { return r[idIdx] && (r[dateIdx] instanceof Date); });

  var yearCounts = {};
  var yearMonthCounts = {};
  var perYear = {};
  rows.forEach(function (r) {
    var info = getClosingInfo_(r[dateIdx]);
    yearCounts[info.fiscalYear] = (yearCounts[info.fiscalYear] || 0) + 1;
    var key = info.fiscalYear + '-' + info.closingMonth;
    yearMonthCounts[key] = (yearMonthCounts[key] || 0) + 1;
    if (!perYear[info.fiscalYear]) perYear[info.fiscalYear] = [];
    perYear[info.fiscalYear].push(r);
  });

  var years = Object.keys(yearCounts).map(Number).sort(function (a, b) { return b - a; });
  var defaultYear = years.length ? years[0] : null;
  var defaultRows = (defaultYear !== null) ? (perYear[defaultYear] || []) : [];
  defaultRows.sort(function (a, b) { return b[dateIdx] - a[dateIdx]; });

  return {
    summary: { yearCounts: yearCounts, yearMonthCounts: yearMonthCounts },
    year: defaultYear,
    rows: defaultRows.map(function (r) { return rowToObject_(headers, r, cfg.timezone); }),
    total: defaultRows.length
  };
}

/** ===================== 結果仕訳け ===================== */

function getBunsekiByField(fieldName) {
  var ss = getSourceSS_();
  var sheet = ss.getSheetByName(DATA_SHEET);
  var values = sheet.getDataRange().getValues();
  var headers = values[0];
  var idIdx = headers.indexOf('不具合記録ID');
  var idx = headers.indexOf(fieldName);

  var rows = values.slice(1).filter(function (r) { return r[idIdx]; });
  var counts = {};
  rows.forEach(function (r) {
    var v = r[idx] || '(未設定)';
    counts[v] = (counts[v] || 0) + 1;
  });
  return counts;
}

function getClassGroupMap_(ss) {
  var classData = sheetToObjects_(ss.getSheetByName(CLASS_SHEET));
  var map = {};
  classData.forEach(function (c) { map[c['分類']] = c['加工分類']; });
  return map;
}

function getBunsekiByProcessType(mode) {
  var ss = getSourceSS_();
  var sheet = ss.getSheetByName(DATA_SHEET);
  var values = sheet.getDataRange().getValues();
  var headers = values[0];
  var idIdx = headers.indexOf('不具合記録ID');
  var rows = values.slice(1).filter(function (r) { return r[idIdx]; });

  var counts = { '柱': 0, '梁': 0 };

  if (mode === '加工先') {
    var idx = headers.indexOf('加工先');
    rows.forEach(function (r) {
      var v = r[idx];
      if (counts[v] !== undefined) counts[v]++;
    });
  } else if (mode === '分類') {
    var classIdx = headers.indexOf('分類選択');
    var classMap = getClassGroupMap_(ss);
    rows.forEach(function (r) {
      var group = classMap[r[classIdx]];
      if (counts[group] !== undefined) counts[group]++;
    });
  }
  return counts;
}

/** ===================== 結果分析（年度/月別グラフ） ===================== */

/**
 * 生産重量マスタ（マスタQUERY）の「QUERY」シートを締め月単位（fiscalYear-closingMonth）で
 * 重量合計にまとめる。このスプレッドシートを開くだけで約12秒かかる(QUERY数式の再計算と推測)ため、
 * 30分間キャッシュし、かつ setupProductionWeightCacheTrigger() で仕込む時間主導トリガーが
 * 15分おきに先回りしてこの関数を呼び直しキャッシュを温め続ける。
 * 列構成: A工事番号 B部位 C加工先 D製品マーク E長さ F本数 G重量 H加工(日付)
 */
function getProductionWeightByMonth_() {
  var cache = CacheService.getScriptCache();
  var cached = cache.get('productionWeightByMonth');
  if (cached) return JSON.parse(cached);

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

  cache.put('productionWeightByMonth', JSON.stringify(result), 1800);
  return result;
}

/**
 * 時間主導トリガー用ハンドラ: キャッシュが有効な間は再計算せずすぐ返るだけなので軽い。
 * 期限が近い/切れている場合だけ実際に重い再計算が走り、ユーザーが踏む前に温め直す。
 */
function warmProductionWeightCache() {
  getProductionWeightByMonth_();
}

/**
 * セットアップ用(初回のみApps Scriptエディタから手動実行): warmProductionWeightCacheを
 * 15分おきに実行する時間主導トリガーを登録する。再実行しても重複登録しないよう既存分を削除してから作る。
 */
function setupProductionWeightCacheTrigger() {
  ScriptApp.getProjectTriggers().forEach(function (t) {
    if (t.getHandlerFunction() === 'warmProductionWeightCache') ScriptApp.deleteTrigger(t);
  });
  ScriptApp.newTrigger('warmProductionWeightCache').timeBased().everyMinutes(15).create();
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

/**
 * 工事別分析用: 指定した物件名（工事）の不具合記録を全期間（締め月単位）で集計する。
 * 生産重量マスタは工事番号キーのため物件名では突合できず、この集計には含めない。
 */
function getKekkaBunsekiByProject(projectName) {
  var ss = getSourceSS_();
  var sheet = ss.getSheetByName(DATA_SHEET);
  var values = sheet.getDataRange().getValues();
  var headers = values[0];
  var idIdx = headers.indexOf('不具合記録ID');
  var dateIdx = headers.indexOf('発生日');
  var procIdx = headers.indexOf('加工先');
  var classIdx = headers.indexOf('分類選択');
  var propIdx = headers.indexOf('選択物件名');
  var classMap = getClassGroupMap_(ss);

  var byPeriod = {};
  var pillarTotal = 0, beamTotal = 0;
  var contentCountsTotal = {};

  values.slice(1).forEach(function (r) {
    if (!r[idIdx] || !(r[dateIdx] instanceof Date)) return;
    if (r[propIdx] !== projectName) return;
    var info = getClosingInfo_(r[dateIdx]);
    var key = info.fiscalYear + '-' + info.closingMonth;
    if (!byPeriod[key]) {
      byPeriod[key] = {
        key: key,
        fiscalYear: info.fiscalYear,
        closingMonth: info.closingMonth,
        sortOrder: info.fiscalYear * 12 + MONTH_ORDER.indexOf(info.closingMonth),
        '柱': 0, '梁': 0, '合計': 0,
        contentCounts: {}
      };
    }
    var proc = r[procIdx];
    if (byPeriod[key][proc] !== undefined) byPeriod[key][proc]++;
    byPeriod[key]['合計']++;
    if (proc === '柱') pillarTotal++;
    else if (proc === '梁') beamTotal++;

    var content = r[classIdx] || '(未設定)';
    byPeriod[key].contentCounts[content] = (byPeriod[key].contentCounts[content] || 0) + 1;
    contentCountsTotal[content] = (contentCountsTotal[content] || 0) + 1;
  });

  var periods = Object.keys(byPeriod).map(function (k) {
    var p = byPeriod[k];
    var displayYear = (p.closingMonth === 12) ? p.fiscalYear - 1 : p.fiscalYear;
    return {
      key: p.key,
      label: displayYear + '/' + p.closingMonth,
      '柱': p['柱'], '梁': p['梁'], '合計': p['合計'],
      contentCounts: sortedCounts_(p.contentCounts, classMap),
      sortOrder: p.sortOrder
    };
  }).sort(function (a, b) { return a.sortOrder - b.sortOrder; });

  return {
    project: projectName,
    periods: periods,
    pillarTotal: pillarTotal,
    beamTotal: beamTotal,
    total: pillarTotal + beamTotal,
    contentCounts: sortedCounts_(contentCountsTotal, classMap)
  };
}

function getKekkaBunsekiYear(year) {
  year = Number(year);
  var ss = getSourceSS_();
  var sheet = ss.getSheetByName(DATA_SHEET);
  var values = sheet.getDataRange().getValues();
  var headers = values[0];
  var idIdx = headers.indexOf('不具合記録ID');
  var dateIdx = headers.indexOf('発生日');
  var procIdx = headers.indexOf('加工先');
  var classIdx = headers.indexOf('分類選択');

  var byMonth = {};
  var pillarTotal = 0, beamTotal = 0;
  var contentCounts = {};
  values.slice(1).forEach(function (r) {
    if (!r[idIdx] || !(r[dateIdx] instanceof Date)) return;
    var info = getClosingInfo_(r[dateIdx]);
    if (info.fiscalYear !== year) return;
    var m = info.closingMonth;
    if (!byMonth[m]) byMonth[m] = { '柱': 0, '梁': 0 };
    var proc = r[procIdx];
    if (byMonth[m][proc] !== undefined) byMonth[m][proc]++;
    if (proc === '柱') pillarTotal++;
    else if (proc === '梁') beamTotal++;
    var content = r[classIdx] || '(未設定)';
    contentCounts[content] = (contentCounts[content] || 0) + 1;
  });

  var weightMap = getProductionWeightByMonth_();
  var nowInfo = getClosingInfo_(new Date());

  var months = MONTH_ORDER.filter(function (m) {
    if (year < nowInfo.fiscalYear) return true;
    if (year > nowInfo.fiscalYear) return false;
    return MONTH_ORDER.indexOf(m) <= MONTH_ORDER.indexOf(nowInfo.closingMonth);
  }).map(function (m) {
    var data = byMonth[m] || { '柱': 0, '梁': 0 };
    var displayYear = (m === 12) ? year - 1 : year;
    var weight = weightMap[year + '-' + m] || 0;
    return {
      closingMonth: m,
      label: displayYear + '/' + m,
      '柱': data['柱'],
      '梁': data['梁'],
      '合計': data['柱'] + data['梁'],
      '生産重量': Math.round(weight * 10) / 10
    };
  });

  return {
    year: year,
    months: months,
    pillarTotal: pillarTotal,
    beamTotal: beamTotal,
    total: pillarTotal + beamTotal,
    contentCounts: sortedCounts_(contentCounts, getClassGroupMap_(ss))
  };
}

function getKekkaBunsekiMonth(year, month) {
  year = Number(year);
  month = Number(month);
  var ss = getSourceSS_();
  var sheet = ss.getSheetByName(DATA_SHEET);
  var values = sheet.getDataRange().getValues();
  var headers = values[0];
  var idIdx = headers.indexOf('不具合記録ID');
  var dateIdx = headers.indexOf('発生日');
  var procIdx = headers.indexOf('加工先');
  var classIdx = headers.indexOf('分類選択');

  var counts = { '柱': 0, '梁': 0 };
  var contentCounts = {};
  values.slice(1).forEach(function (r) {
    if (!r[idIdx] || !(r[dateIdx] instanceof Date)) return;
    var info = getClosingInfo_(r[dateIdx]);
    if (info.fiscalYear !== year || info.closingMonth !== month) return;
    var proc = r[procIdx];
    if (counts[proc] !== undefined) counts[proc]++;
    var content = r[classIdx] || '(未設定)';
    contentCounts[content] = (contentCounts[content] || 0) + 1;
  });

  var weightMap = getProductionWeightByMonth_();
  var weight = weightMap[year + '-' + month] || 0;
  var displayYear = (month === 12) ? year - 1 : year;

  return {
    year: year,
    month: month,
    label: displayYear + '/' + month,
    '柱': counts['柱'],
    '梁': counts['梁'],
    '合計': counts['柱'] + counts['梁'],
    '生産重量': Math.round(weight * 10) / 10,
    contentCounts: sortedCounts_(contentCounts, getClassGroupMap_(ss))
  };
}

/**
 * 結果分析の初回表示専用: 年度サマリー(年度/月セレクト用件数)・当日該当年度分・当日該当月分を
 * 不具合記録シートの1回の読み込みだけでまとめて計算する。
 * (個別にgetYearMonthSummary/getKekkaBunsekiYear/Monthを呼ぶと同じシートを何度も読み直してしまうため)
 */
function getKekkaBunsekiBootstrap() {
  var ss = getSourceSS_();
  var sheet = ss.getSheetByName(DATA_SHEET);
  var values = sheet.getDataRange().getValues();
  var headers = values[0];
  var idIdx = headers.indexOf('不具合記録ID');
  var dateIdx = headers.indexOf('発生日');
  var procIdx = headers.indexOf('加工先');
  var classIdx = headers.indexOf('分類選択');
  var classMap = getClassGroupMap_(ss);

  var yearCounts = {};
  var yearMonthCounts = {};
  var perYearMonth = {};
  var perYearProcTotals = {};
  var perYearContentCounts = {};
  var perYearMonthContentCounts = {};

  values.slice(1).forEach(function (r) {
    if (!r[idIdx] || !(r[dateIdx] instanceof Date)) return;
    var info = getClosingInfo_(r[dateIdx]);
    var y = info.fiscalYear, m = info.closingMonth;
    var proc = r[procIdx];
    var content = r[classIdx] || '(未設定)';
    var ymKey = y + '-' + m;

    yearCounts[y] = (yearCounts[y] || 0) + 1;
    yearMonthCounts[ymKey] = (yearMonthCounts[ymKey] || 0) + 1;

    if (!perYearMonth[y]) perYearMonth[y] = {};
    if (!perYearMonth[y][m]) perYearMonth[y][m] = { '柱': 0, '梁': 0 };
    if (perYearMonth[y][m][proc] !== undefined) perYearMonth[y][m][proc]++;

    if (!perYearProcTotals[y]) perYearProcTotals[y] = { pillarTotal: 0, beamTotal: 0 };
    if (proc === '柱') perYearProcTotals[y].pillarTotal++;
    else if (proc === '梁') perYearProcTotals[y].beamTotal++;

    if (!perYearContentCounts[y]) perYearContentCounts[y] = {};
    perYearContentCounts[y][content] = (perYearContentCounts[y][content] || 0) + 1;

    if (!perYearMonthContentCounts[ymKey]) perYearMonthContentCounts[ymKey] = {};
    perYearMonthContentCounts[ymKey][content] = (perYearMonthContentCounts[ymKey][content] || 0) + 1;
  });

  var weightMap = getProductionWeightByMonth_();
  var nowInfo = getClosingInfo_(new Date());

  var years = Object.keys(yearCounts).map(Number).sort(function (a, b) { return b - a; });
  var defaultYear = (yearCounts[nowInfo.fiscalYear] !== undefined) ? nowInfo.fiscalYear : (years.length ? years[0] : null);
  var defaultMonth = nowInfo.closingMonth;

  function buildYearData(year) {
    var byMonth = perYearMonth[year] || {};
    var totals = perYearProcTotals[year] || { pillarTotal: 0, beamTotal: 0 };
    var months = MONTH_ORDER.filter(function (m) {
      if (year < nowInfo.fiscalYear) return true;
      if (year > nowInfo.fiscalYear) return false;
      return MONTH_ORDER.indexOf(m) <= MONTH_ORDER.indexOf(nowInfo.closingMonth);
    }).map(function (m) {
      var data = byMonth[m] || { '柱': 0, '梁': 0 };
      var displayYear = (m === 12) ? year - 1 : year;
      var weight = weightMap[year + '-' + m] || 0;
      return {
        closingMonth: m,
        label: displayYear + '/' + m,
        '柱': data['柱'],
        '梁': data['梁'],
        '合計': data['柱'] + data['梁'],
        '生産重量': Math.round(weight * 10) / 10
      };
    });
    return {
      year: year,
      months: months,
      pillarTotal: totals.pillarTotal,
      beamTotal: totals.beamTotal,
      total: totals.pillarTotal + totals.beamTotal,
      contentCounts: sortedCounts_(perYearContentCounts[year] || {}, classMap)
    };
  }

  function buildMonthData(year, month) {
    var key = year + '-' + month;
    var counts = (perYearMonth[year] && perYearMonth[year][month]) || { '柱': 0, '梁': 0 };
    var weight = weightMap[key] || 0;
    var displayYear = (month === 12) ? year - 1 : year;
    return {
      year: year,
      month: month,
      label: displayYear + '/' + month,
      '柱': counts['柱'],
      '梁': counts['梁'],
      '合計': counts['柱'] + counts['梁'],
      '生産重量': Math.round(weight * 10) / 10,
      contentCounts: sortedCounts_(perYearMonthContentCounts[key] || {}, classMap)
    };
  }

  var result = {
    summary: { yearCounts: yearCounts, yearMonthCounts: yearMonthCounts },
    defaultYear: defaultYear,
    defaultMonth: defaultMonth,
    yearData: defaultYear !== null ? buildYearData(defaultYear) : null,
    monthData: defaultYear !== null ? buildMonthData(defaultYear, defaultMonth) : null
  };
  return result;
}

function getFilteredRecords(field, value) {
  var ss = getSourceSS_();
  var cfg = getConfig_();
  var sheet = ss.getSheetByName(DATA_SHEET);
  var values = sheet.getDataRange().getValues();
  var headers = values[0];
  var idIdx = headers.indexOf('不具合記録ID');
  var rows = values.slice(1).filter(function (r) { return r[idIdx]; });

  if (field === '分類グループ') {
    var classIdx = headers.indexOf('分類選択');
    var classMap = getClassGroupMap_(ss);
    rows = rows.filter(function (r) { return classMap[r[classIdx]] === value; });
  } else {
    var idx = headers.indexOf(field);
    rows = rows.filter(function (r) { return (r[idx] || '(未設定)') === value; });
  }

  var dateIdx = headers.indexOf('発生日');
  rows.sort(function (a, b) { return b[dateIdx] - a[dateIdx]; });

  return rows.map(function (r) { return rowToObject_(headers, r, cfg.timezone); });
}

/**
 * 結果分析画面の「不具合内容（件数）」テーブル行クリック用: 指定した分類（不具合内容）に
 * 一致し、かつ表示中のスコープ（年度/月/工事/工事+選択締め月）に該当する記録一覧を返す。
 */
function getKekkaBunsekiContentRecords(filter) {
  var ss = getSourceSS_();
  var cfg = getConfig_();
  var sheet = ss.getSheetByName(DATA_SHEET);
  var values = sheet.getDataRange().getValues();
  var headers = values[0];
  var idIdx = headers.indexOf('不具合記録ID');
  var dateIdx = headers.indexOf('発生日');
  var classIdx = headers.indexOf('分類選択');
  var propIdx = headers.indexOf('選択物件名');

  var rows = values.slice(1).filter(function (r) { return r[idIdx] && (r[dateIdx] instanceof Date); });

  rows = rows.filter(function (r) {
    var content = r[classIdx] || '(未設定)';
    if (content !== filter.content) return false;

    if (filter.scope === 'year') {
      return getClosingInfo_(r[dateIdx]).fiscalYear === Number(filter.year);
    }
    if (filter.scope === 'month') {
      var info = getClosingInfo_(r[dateIdx]);
      return info.fiscalYear === Number(filter.year) && info.closingMonth === Number(filter.month);
    }
    if (filter.scope === 'project') {
      return r[propIdx] === filter.project;
    }
    if (filter.scope === 'projectPeriods') {
      if (r[propIdx] !== filter.project) return false;
      var info2 = getClosingInfo_(r[dateIdx]);
      var key = info2.fiscalYear + '-' + info2.closingMonth;
      return (filter.periodKeys || []).indexOf(key) !== -1;
    }
    return false;
  });

  rows.sort(function (a, b) { return b[dateIdx] - a[dateIdx]; });

  return rows.map(function (r) { return rowToObject_(headers, r, cfg.timezone); });
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
  var apiKey = PropertiesService.getScriptProperties().getProperty('GEMINI_API_KEY');
  if (!apiKey) {
    throw new Error('GEMINI_API_KEY が設定されていません。スクリプトプロパティを確認してください。');
  }

  var url = 'https://generativelanguage.googleapis.com/v1beta/models/' + cfg.geminiModel + ':generateContent?key=' + apiKey;
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
