/**
 * 生産損益分析 - GAS API バックエンド
 *
 * 新規の管理用スプレッドシート(「生産損益分析」)にコンテナバインドで設置する。
 * 既存の2アプリ(生産管理ダッシュボード・日報全期間集計)のコード・デプロイには一切
 * 手を加えず、それぞれの公開済みJSON APIを UrlFetchApp で「読み取りのみ」呼び出して
 * 集計する(日報のアーカイブ横断マージ等のロジックを二重に持たないため)。
 *
 * ■ 集計結果(キャッシュ)
 *   スプレッドシートと同じフォルダの _cache_analysis.json に保存する。
 *   { generatedAt, sites:[...], works:{工事No:{name,totalWeight}}, rec:[[日付,工場,工事No,重量t,工数h]], warnings:[...] }
 *   工事Noは生の値のまま保存し、「共通」扱いの判定は画面側(設定の共通扱い工事No)で行う
 *   (設定変更で再集計が不要になるように)。日報の工事IDが工事マスタに無い工数は工事Noを空にする。
 *   毎日早朝のトリガー(dailyRefresh)と、画面の「今すぐ更新」で作り直す。
 *
 * ■ 設定シート(画面の「設定」タブから保存。初回に自動作成)
 *   基本設定 : 項目 | 値
 *   工事単価 : 工事No | 工事名 | 契約総重量(t) | 契約金額(円) | (E列以降は自由。例: トン単価の計算式)
 *              保存時はA〜D列だけを工事No単位で更新・追記し、行の削除やE列以降の書き換えはしない
 *   費用設定 : 工場 | 人件費単価(円/人工) | 月固定費(円) | 変動費単価(円/t)
 *
 * ■ パスワード(スクリプトプロパティ。リポジトリには書かない)
 *   VIEW_PASSWORD : 閲覧用(全API)
 *   EDIT_PASSWORD : 設定の保存用
 */

const PM_API_URL = 'https://script.google.com/macros/s/AKfycbya0wgwbTuBN1laM8tWFGTJhJw--pTAOBAYVyrsOoXbrOXZgs9q3ZsErTSQZwJFT2c2/exec';
const DR_API_URL = 'https://script.google.com/macros/s/AKfycbyiocXgXi_YEMUUq5BJPe7CUi2V-LJIBvLwceextYV-82hEArRKRaHQ5peVj5oMfTsW/exec';
const CACHE_FILE_NAME = '_cache_analysis.json';
const SITE_ORDER = ['本社', '夢前', '鳥取'];

const SHEETS = {
  BASIC: '基本設定',
  WORKS: '工事単価',
  COSTS: '費用設定',
};
const BASIC_KEYS = [
  ['人件費率', 'rates.labor', 30],
  ['変動費率', 'rates.variable', 40],
  ['固定費率', 'rates.fixed', 15],
  ['利益率', 'rates.profit', 15],
  ['共通扱い工事No', 'commonWorkNos', '00-00'],
];

// ========== エントリーポイント ==========

function doGet() {
  return json_({ status: 'success', data: { app: '生産損益分析', message: 'POSTで呼び出してください' } });
}

function doPost(e) {
  try {
    const body = JSON.parse(e.postData.contents || '{}');
    const action = body.action;
    if (action === 'saveSettings') {
      checkPassword_('EDIT_PASSWORD', body.editPw);
      saveSettings_(body.settings || {});
      return json_({ status: 'success', data: { settings: readSettings_() } });
    }
    checkPassword_('VIEW_PASSWORD', body.pw);
    if (action === 'checkEdit') {
      checkPassword_('EDIT_PASSWORD', body.editPw);
      return json_({ status: 'success', data: { ok: true } });
    }
    if (action === 'getData') return dataResponse_(false);
    if (action === 'refresh') return dataResponse_(true);
    return json_({ status: 'error', message: '不明なaction: ' + action });
  } catch (err) {
    return json_({ status: 'error', message: String(err && err.message || err) });
  }
}

function json_(obj) {
  return ContentService.createTextOutput(JSON.stringify(obj)).setMimeType(ContentService.MimeType.JSON);
}

function checkPassword_(propName, given) {
  const expected = PropertiesService.getScriptProperties().getProperty(propName);
  if (!expected) throw new Error('スクリプトプロパティ ' + propName + ' が未設定です');
  if (String(given || '') !== expected) throw new Error('パスワードが違います');
}

// キャッシュのJSON文字列はJSON.parseし直さずにそのまま埋め込む(数MBになりうるため)。
function dataResponse_(forceRefresh) {
  let cacheText = forceRefresh ? null : loadCacheText_();
  if (cacheText === null) cacheText = refreshLocked_();
  const settingsText = JSON.stringify(readSettings_());
  return ContentService.createTextOutput('{"status":"success","data":{"cache":' + cacheText + ',"settings":' + settingsText + '}}')
    .setMimeType(ContentService.MimeType.JSON);
}

// ========== 集計 ==========

/* 毎日早朝のトリガーから呼ぶ(setupTrigger()で登録)。 */
function dailyRefresh() {
  refreshLocked_();
}

function setupTrigger() {
  ScriptApp.getProjectTriggers().forEach(function (t) {
    if (t.getHandlerFunction() === 'dailyRefresh') ScriptApp.deleteTrigger(t);
  });
  // 生産管理ダッシュボードの早朝更新の後に動くよう6時台にする
  ScriptApp.newTrigger('dailyRefresh').timeBased().everyDays(1).atHour(6).create();
}

function refreshLocked_() {
  const lock = LockService.getScriptLock();
  lock.waitLock(5 * 60 * 1000);
  try {
    const cache = aggregateSources_(fetchSources_());
    const text = JSON.stringify(cache);
    saveCacheText_(text);
    return text;
  } finally {
    lock.releaseLock();
  }
}

function fetchSources_() {
  const post = function (action) {
    return { url: DR_API_URL, method: 'post', contentType: 'application/json',
      payload: JSON.stringify({ action: action, params: {} }), muteHttpExceptions: true, followRedirects: true };
  };
  const responses = UrlFetchApp.fetchAll([
    { url: PM_API_URL + '?action=getData', method: 'get', muteHttpExceptions: true, followRedirects: true },
    post('getMasterData'),
    post('getAllDailyReportRows'),
  ]);
  const names = ['生産管理ダッシュボード', '日報(マスタ)', '日報(全期間)'];
  const parsed = responses.map(function (res, i) {
    let body;
    try { body = JSON.parse(res.getContentText()); } catch (e) {
      throw new Error(names[i] + 'のAPI応答を読めませんでした(HTTP ' + res.getResponseCode() + ')');
    }
    if (body.status !== 'success') throw new Error(names[i] + 'のAPIエラー: ' + body.message);
    return body.data;
  });
  return { pm: parsed[0], drMaster: parsed[1], drRows: parsed[2] };
}

/* 取得した3つのデータを、日付×工場×工事No単位の[重量, 工数]に集約する(純粋関数。
   リグレッションテストでNodeから直接呼ぶ)。 */
function aggregateSources_(src) {
  const pm = src.pm || {}, drMaster = src.drMaster || {}, drRows = src.drRows || [];
  const map = {};
  const works = {};
  const siteSet = {};
  const warnings = (pm.warnings || []).slice();

  function cell(ymd, site, workNo) {
    const key = ymd + '\t' + site + '\t' + workNo;
    siteSet[site] = true;
    return map[key] || (map[key] = [ymd, site, workNo, 0, 0]);
  }

  (pm.works || []).forEach(function (w) {
    const wn = String(w.workNo);
    const info = works[wn] || (works[wn] = { name: w.workName || '', totalWeight: 0 });
    Object.keys(w.bySite || {}).forEach(function (site) {
      const byDate = w.bySite[site].weightByDate || {};
      Object.keys(byDate).forEach(function (ymd) {
        const wt = Number(byDate[ymd]) || 0;
        cell(ymd, site, wn)[3] += wt;
        info.totalWeight += wt;
      });
    });
  });

  const constructionNo = {};
  (drMaster.constructions || []).forEach(function (c) {
    constructionNo[String(c.id)] = { no: String(c.no || '').trim(), name: c.name || '' };
  });
  let unknownIds = 0;
  drRows.forEach(function (r) {
    const hours = Number(r.hours) || 0;
    if (!hours || !r.workDate || !r.factory) return;
    const ymd = String(r.workDate).replace(/\//g, '-');
    const c = constructionNo[String(r.constructionId)];
    if (!c) unknownIds++;
    const wn = c ? c.no : '';
    if (wn && !works[wn]) works[wn] = { name: c.name, totalWeight: 0 };
    else if (wn && !works[wn].name) works[wn].name = c.name;
    cell(ymd, String(r.factory).trim(), wn)[4] += hours;
  });
  if (unknownIds) warnings.push('工事マスタに無い工事IDの日報が' + unknownIds + '件あり、共通として集計しました');

  const rec = Object.keys(map).sort().map(function (k) {
    const c = map[k];
    return [c[0], c[1], c[2], round_(c[3], 3), round_(c[4], 2)];
  });
  Object.keys(works).forEach(function (wn) { works[wn].totalWeight = round_(works[wn].totalWeight, 3); });
  const sites = SITE_ORDER.filter(function (s) { return siteSet[s]; })
    .concat(Object.keys(siteSet).filter(function (s) { return SITE_ORDER.indexOf(s) < 0; }).sort());

  return {
    generatedAt: new Date().toISOString(),
    pmGeneratedAt: pm.generatedAt || null,
    sites: sites,
    works: works,
    rec: rec,
    warnings: warnings,
  };
}

function round_(v, d) { const f = Math.pow(10, d); return Math.round(v * f) / f; }

// ========== キャッシュファイル ==========

function folder_() {
  return DriveApp.getFileById(SpreadsheetApp.getActive().getId()).getParents().next();
}

function loadCacheText_() {
  const it = folder_().getFilesByName(CACHE_FILE_NAME);
  if (!it.hasNext()) return null;
  const text = it.next().getBlob().getDataAsString();
  try { JSON.parse(text); } catch (e) { return null; }
  return text;
}

function saveCacheText_(text) {
  const folder = folder_();
  const it = folder.getFilesByName(CACHE_FILE_NAME);
  if (it.hasNext()) it.next().setContent(text);
  else folder.createFile(CACHE_FILE_NAME, text, MimeType.PLAIN_TEXT);
}

// ========== 設定シート ==========

function sheet_(name, header) {
  const ss = SpreadsheetApp.getActive();
  let sh = ss.getSheetByName(name);
  if (!sh) {
    sh = ss.insertSheet(name);
    sh.getRange(1, 1, 1, header.length).setValues([header]).setFontWeight('bold');
    sh.setFrozenRows(1);
  }
  return sh;
}

function rows_(sh) {
  const last = sh.getLastRow();
  if (last < 2) return [];
  return sh.getRange(2, 1, last - 1, sh.getLastColumn()).getDisplayValues();
}

function numOrNull_(v) {
  // 「10,000,000」「¥10,000,000」「10,000,000円」などの表示形式でも数値として読む
  const s = String(v === null || v === undefined ? '' : v).replace(/[,¥￥円\s]/g, '').trim();
  if (s === '' || isNaN(Number(s))) return null;
  return Number(s);
}

function readSettings_() {
  const s = { rates: {}, commonWorkNos: '00-00', works: {}, costs: {} };
  const basic = {};
  rows_(sheet_(SHEETS.BASIC, ['項目', '値'])).forEach(function (r) { basic[r[0]] = r[1]; });
  BASIC_KEYS.forEach(function (k) {
    const raw = basic[k[0]];
    const val = (raw === undefined || raw === '') ? k[2] : (typeof k[2] === 'number' ? (numOrNull_(raw) === null ? k[2] : numOrNull_(raw)) : String(raw));
    const path = k[1].split('.');
    if (path.length === 2) s[path[0]][path[1]] = val; else s[path[0]] = val;
  });
  rows_(sheet_(SHEETS.WORKS, ['工事No', '工事名', '契約総重量(t)', '契約金額(円)'])).forEach(function (r) {
    if (!r[0]) return;
    s.works[String(r[0]).trim()] = { name: r[1], totalWeight: numOrNull_(r[2]), contract: numOrNull_(r[3]) };
  });
  rows_(sheet_(SHEETS.COSTS, ['工場', '人件費単価(円/人工)', '月固定費(円)', '変動費単価(円/t)'])).forEach(function (r) {
    if (!r[0]) return;
    s.costs[String(r[0]).trim()] = { laborRate: numOrNull_(r[1]), fixedMonthly: numOrNull_(r[2]), variablePerTon: numOrNull_(r[3]) };
  });
  return s;
}

/* シートの内容を丸ごと書き換える。工事No・月度は「25-12」「2026-10」のような文字列が
   日付に自動変換されないよう、書き込み前にA列を書式なしテキスト(@)にする。 */
function writeRows_(sh, rows, width) {
  const last = sh.getLastRow();
  if (last >= 2) sh.getRange(2, 1, last - 1, Math.max(width, sh.getLastColumn())).clearContent();
  if (!rows.length) return;
  sh.getRange(2, 1, rows.length, 1).setNumberFormat('@');
  sh.getRange(2, 1, rows.length, width).setValues(rows);
}

/* 「工事単価」シートのA〜D列を、既存の行を残したまま工事No単位で更新する(純粋関数)。
   - 既存行: 工事Noがworksにあれば契約総重量・契約金額を更新(工事名は空欄のときだけ補う)
   - worksにあってシートに無い工事: 契約総重量か契約金額が入っているものだけ末尾に追記
   - worksに無い既存行・空行はそのまま(行の削除はしない。E列以降はそもそも触らない) */
function mergeWorkRows_(existing, works) {
  const seen = {};
  const rows = existing.map(function (r) {
    const wn = String(r[0] === null || r[0] === undefined ? '' : r[0]).trim();
    if (!wn || !works[wn]) return r.slice(0, 4);
    seen[wn] = true;
    const w = works[wn];
    return [r[0], r[1] !== '' && r[1] !== null && r[1] !== undefined ? r[1] : blank_(w.name),
      blank_(numOrNull_(w.totalWeight)), blank_(numOrNull_(w.contract))];
  });
  Object.keys(works).sort().forEach(function (wn) {
    const w = works[wn];
    if (seen[wn] || !w || (numOrNull_(w.totalWeight) === null && numOrNull_(w.contract) === null)) return;
    rows.push([wn, blank_(w.name), blank_(numOrNull_(w.totalWeight)), blank_(numOrNull_(w.contract))]);
  });
  return rows;
}

function blank_(v) { return v === null || v === undefined ? '' : v; }

function saveSettings_(s) {
  const lock = LockService.getScriptLock();
  lock.waitLock(30 * 1000);
  try {
    writeRows_(sheet_(SHEETS.BASIC, ['項目', '値']), BASIC_KEYS.map(function (k) {
      const path = k[1].split('.');
      const v = path.length === 2 ? (s[path[0]] || {})[path[1]] : s[path[0]];
      return [k[0], blank_(v === undefined ? k[2] : v)];
    }), 2);
    const wsh = sheet_(SHEETS.WORKS, ['工事No', '工事名', '契約総重量(t)', '契約金額(円)']);
    const wLast = wsh.getLastRow();
    const existing = wLast >= 2 ? wsh.getRange(2, 1, wLast - 1, 4).getValues() : [];
    const merged = mergeWorkRows_(existing, s.works || {});
    if (merged.length) {
      wsh.getRange(2, 1, merged.length, 1).setNumberFormat('@');
      wsh.getRange(2, 1, merged.length, 4).setValues(merged);
    }
    const costs = s.costs || {};
    writeRows_(sheet_(SHEETS.COSTS, ['工場', '人件費単価(円/人工)', '月固定費(円)', '変動費単価(円/t)']), Object.keys(costs)
      .map(function (site) { const c = costs[site]; return [site, blank_(numOrNull_(c.laborRate)), blank_(numOrNull_(c.fixedMonthly)), blank_(numOrNull_(c.variablePerTon))]; }), 4);
  } finally {
    lock.releaseLock();
  }
}
