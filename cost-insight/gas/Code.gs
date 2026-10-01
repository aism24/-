/**
 * コストインサイト(原価管理・生産進捗分析) - GAS API バックエンド
 *
 * 管理用スプレッドシート「コストインサイト」にコンテナバインドで設置する(拡張機能 → Apps Script)。
 * 生産損益分析(production-profit)と実行予算まとめ(jikko-yosan)を1本にまとめる新アプリ用。
 *
 * ■ 第1段階(このファイル): データの読み取り
 *   - 生産重量: 生産管理ダッシュボードの公開API(getData)を読み取りのみで呼ぶ
 *   - 工数   : 日報全期間集計の公開API(getMasterData・getAllDailyReportRows)を読み取りのみで呼ぶ
 *   → 日付×工場×工事No単位の[重量t, 工数h]に集約し、スプレッドシートと同じフォルダの
 *     _cache_production.json に保存する(毎朝6時台のトリガーと action=refresh で作り直す)。
 *     集約の仕方は production-profit/gas/Code.gs の aggregateSources_ と同じ(同じ結果になることを確認済み)。
 *   - 実行予算(仕入・労務費)の受け取り(会社PCの.batからのPOST)は第2段階で追加する。
 *
 * ■ シート(値の読み方)
 *   工事マスタ    : 工事No | 工事名 | 契約総重量(t) | 契約金額(円) | トン単価 | 完了 | 年度 | 労務費の締め
 *                   (A・B列は日報アプリからIMPORTRANGE、C〜H列は「工事データ」からのVLOOKUP式。GASは読むだけ)
 *   工事データ    : 工事No | 契約総重量(t) | 契約金額(円) | 完了 | 年度 | 労務費の締め(第2段階からGASが書く)
 *   基本設定      : 項目 | 値 (項目名で読む: 共通扱い工事No・目標利益率(%))
 *   会社カレンダー: A〜B列 日付 | 出勤・休日、D列以降に従業員名簿(見出し 社員番号・工場・氏名・部署・状況)
 *                   名簿は「在職中」の人数を工場別に数えて返すだけ(氏名は返さない)
 *
 * ■ API(パスワードなし)
 *   GET ?action=getData : { status, data:{ cache, settings } }(キャッシュが無ければ集計してから返す)
 *   GET ?action=refresh : 集計し直してから同じ形で返す
 */

const PM_API_URL = 'https://script.google.com/macros/s/AKfycbya0wgwbTuBN1laM8tWFGTJhJw--pTAOBAYVyrsOoXbrOXZgs9q3ZsErTSQZwJFT2c2/exec';
const DR_API_URL = 'https://script.google.com/macros/s/AKfycbyiocXgXi_YEMUUq5BJPe7CUi2V-LJIBvLwceextYV-82hEArRKRaHQ5peVj5oMfTsW/exec';
const CACHE_FILE_NAME = '_cache_production.json';
// 集計対象の工場。これ以外(「中止」「高馬」など)の加工先・所属のデータは集計から除外する
const SITE_ORDER = ['本社', '夢前', '鳥取'];

const SHEETS = { MASTER: '工事マスタ', BASIC: '基本設定', CALENDAR: '会社カレンダー' };
// 基本設定の項目名 → 返すときの名前と既定値
const BASIC_KEYS = [
  ['共通扱い工事No', 'commonWorkNos', ''],
  ['目標利益率(%)', 'targetProfitRate', null],
];

// ========== エントリーポイント ==========

function doGet(e) {
  try {
    const action = (e && e.parameter && e.parameter.action) || 'getData';
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

// キャッシュのJSON文字列はJSON.parseし直さずにそのまま埋め込む(数MBになりうるため)。
function dataResponse_(forceRefresh) {
  let cacheText = forceRefresh ? null : loadCacheText_();
  if (cacheText === null) cacheText = refreshLocked_(!forceRefresh);
  const settingsText = JSON.stringify(readSettings_());
  return ContentService.createTextOutput('{"status":"success","data":{"cache":' + cacheText + ',"settings":' + settingsText + '}}')
    .setMimeType(ContentService.MimeType.JSON);
}

/* 設置の確認用。エディタで実行すると、権限の承認のあと、読み取った件数をログに出す。 */
function checkSetup() {
  const s = readSettings_();
  const cache = JSON.parse(refreshLocked_(false));
  const bySite = {};
  let minD = '', maxD = '';
  cache.rec.forEach(function (r) {
    const b = bySite[r[1]] || (bySite[r[1]] = { weight: 0, hours: 0 });
    b.weight += r[3]; b.hours += r[4];
    if (!minD || r[0] < minD) minD = r[0];
    if (!maxD || r[0] > maxD) maxD = r[0];
  });
  Logger.log('保存先フォルダ: ' + folder_().getName());
  Logger.log('集計: ' + cache.rec.length + '行 / 期間 ' + minD + '〜' + maxD + ' / 工事 ' + Object.keys(cache.works).length + '件');
  Object.keys(bySite).forEach(function (k) {
    Logger.log('  ' + k + ': 生産重量 ' + round_(bySite[k].weight, 1) + 't / 工数 ' + round_(bySite[k].hours, 1) + 'h');
  });
  (cache.warnings || []).forEach(function (w) { Logger.log('注意: ' + w); });
  Logger.log('工事マスタ: ' + Object.keys(s.works).length + '件 / 会社カレンダー: ' + Object.keys(s.calendar).length + '日');
  Logger.log('在職中の人数: ' + JSON.stringify(s.headcount));
  Logger.log('基本設定: 共通扱い工事No=' + s.commonWorkNos + ' / 目標利益率=' + s.targetProfitRate);
}

// ========== 集計(生産重量・工数) ==========

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

/* reuseIfExists: 待っている間に別の要求が集計を済ませていたら、それを使う(同時アクセスで何度も集計しない) */
function refreshLocked_(reuseIfExists) {
  const lock = LockService.getScriptLock();
  lock.waitLock(5 * 60 * 1000);
  try {
    if (reuseIfExists) {
      const done = loadCacheText_();
      if (done !== null) return done;
    }
    const text = JSON.stringify(aggregateSources_(fetchSources_()));
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
   production-profit と同じ処理。リグレッションテストでNodeから直接呼ぶ)。 */
function aggregateSources_(src) {
  const pm = src.pm || {}, drMaster = src.drMaster || {}, drRows = src.drRows || [];
  const map = {};
  const works = {};
  const warnings = (pm.warnings || []).slice();

  const excluded = {};
  const isTarget = function (site) {
    if (SITE_ORDER.indexOf(site) >= 0) return true;
    excluded[site] = true;
    return false;
  };
  function cell(ymd, site, workNo) {
    const key = ymd + '\t' + site + '\t' + workNo;
    return map[key] || (map[key] = [ymd, site, workNo, 0, 0]);
  }

  (pm.works || []).forEach(function (w) {
    const wn = String(w.workNo);
    const info = works[wn] || (works[wn] = { name: w.workName || '', totalWeight: 0 });
    Object.keys(w.bySite || {}).forEach(function (site) {
      const st = String(site).trim(); // 前後の空白を除いた名前で保存する(画面側は完全一致で工場を判定するため)
      if (!isTarget(st)) return;
      const byDate = w.bySite[site].weightByDate || {};
      Object.keys(byDate).forEach(function (ymd) {
        const wt = Number(byDate[ymd]) || 0;
        cell(ymd, st, wn)[3] += wt;
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
    if (!hours || !r.workDate || !r.factory || !isTarget(String(r.factory).trim())) return;
    const ymd = String(r.workDate).replace(/\//g, '-');
    const c = constructionNo[String(r.constructionId)];
    if (!c) unknownIds++;
    const wn = c ? c.no : '';
    if (wn && !works[wn]) works[wn] = { name: c.name, totalWeight: 0 };
    else if (wn && !works[wn].name) works[wn].name = c.name;
    cell(ymd, String(r.factory).trim(), wn)[4] += hours;
  });
  const exNames = Object.keys(excluded).filter(function (x) { return x; }).sort();
  if (exNames.length) warnings.push('集計対象外の工場のデータを除外しました: ' + exNames.join('、'));
  if (unknownIds) warnings.push('工事マスタに無い工事IDの日報が' + unknownIds + '件あり、共通として集計しました');

  const rec = Object.keys(map).sort().map(function (k) {
    const c = map[k];
    return [c[0], c[1], c[2], round_(c[3], 3), round_(c[4], 2)];
  });
  Object.keys(works).forEach(function (wn) { works[wn].totalWeight = round_(works[wn].totalWeight, 3); });

  return {
    generatedAt: new Date().toISOString(),
    sites: SITE_ORDER.slice(),
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
  // 数MBのJSONを毎回JSON.parseすると遅いため、形だけ確かめる(壊れていれば作り直す)
  return /^\s*\{[\s\S]*\}\s*$/.test(text) ? text : null;
}

function saveCacheText_(text) {
  const folder = folder_();
  const it = folder.getFilesByName(CACHE_FILE_NAME);
  if (it.hasNext()) it.next().setContent(text);
  else folder.createFile(CACHE_FILE_NAME, text, MimeType.PLAIN_TEXT);
}

// ========== シートの読み取り ==========

function sheet_(name) {
  const sh = SpreadsheetApp.getActive().getSheetByName(name);
  if (!sh) throw new Error('シート「' + name + '」が見つかりません');
  return sh;
}

function numOrNull_(v) {
  // 「10,000,000」「¥10,000,000」「10,000,000円」などの表示形式でも数値として読む
  const s = String(v === null || v === undefined ? '' : v).replace(/[,¥￥円\s]/g, '').trim();
  if (s === '' || isNaN(Number(s))) return null;
  return Number(s);
}

function readSettings_() {
  const s = { works: {} };
  const basicSh = sheet_(SHEETS.BASIC);
  const basic = {};
  if (basicSh.getLastRow() >= 2) {
    basicSh.getRange(2, 1, basicSh.getLastRow() - 1, 2).getDisplayValues().forEach(function (r) {
      basic[String(r[0]).trim()] = String(r[1]).trim();
    });
  }
  BASIC_KEYS.forEach(function (k) {
    const raw = basic[k[0]];
    s[k[1]] = (raw === undefined || raw === '') ? k[2] : (k[1] === 'targetProfitRate' ? numOrNull_(raw) : raw);
  });
  s.works = readWorks_(sheet_(SHEETS.MASTER));
  const calSh = sheet_(SHEETS.CALENDAR);
  s.calendar = readCalendar_(calSh);
  s.headcount = readHeadcount_(calSh);
  return s;
}

/* 工事マスタ(A〜H列)を { 工事No: { name, totalWeight, contract, done, year, laborCutoff } } で返す。
   数値の列は表示形式で丸められた文字ではなく実際の値で読む。 */
function readWorks_(sh) {
  const works = {};
  const last = sh.getLastRow();
  if (last < 2) return works;
  const rg = sh.getRange(2, 1, last - 1, 8);
  const disp = rg.getDisplayValues(), vals = rg.getValues();
  const num = function (i, c) { return typeof vals[i][c] === 'number' ? vals[i][c] : numOrNull_(disp[i][c]); };
  disp.forEach(function (r, i) {
    const no = String(r[0]).trim();
    if (!no) return;
    works[no] = {
      name: String(r[1]).trim(), totalWeight: num(i, 2), contract: num(i, 3),
      done: String(r[5]).trim() === '完了', year: String(r[6]).trim(), laborCutoff: String(r[7]).trim(),
    };
  });
  return works;
}

/* 会社カレンダー(日付 | 出勤・休日)を { 'YYYY-MM-DD': 1(出勤) / 0(休日) } で返す。
   日付のセルの右隣が「出勤」「休日」の組を探すので、列の位置が変わっても読める。 */
function readCalendar_(sh) {
  const last = sh.getLastRow(), width = sh.getLastColumn();
  const cal = {};
  if (last < 1 || width < 2) return cal;
  const vals = sh.getRange(1, 1, last, width).getValues();
  const tz = Session.getScriptTimeZone();
  vals.forEach(function (r) {
    for (let c = 0; c + 1 < r.length; c++) {
      const kind = String(r[c + 1]).trim();
      if (!(r[c] instanceof Date) || (kind !== '出勤' && kind !== '休日')) continue;
      cal[Utilities.formatDate(r[c], tz, 'yyyy-MM-dd')] = kind === '出勤' ? 1 : 0;
      break;
    }
  });
  return cal;
}

/* 従業員名簿(見出し「社員番号」「工場」「状況」の列)から、状況が「在職中」の人数を工場別に数える。
   { '本社': 人数, ... } を返す(氏名などは返さない)。見出しが見つからなければ null。 */
function readHeadcount_(sh) {
  const last = sh.getLastRow(), width = sh.getLastColumn();
  if (last < 2 || width < 1) return null;
  const vals = sh.getRange(1, 1, last, width).getValues();
  let hr = -1, cSite = -1, cStat = -1;
  for (let r = 0; r < Math.min(vals.length, 5) && hr < 0; r++) {
    const row = vals[r].map(function (v) { return String(v).trim(); });
    const st = row.indexOf('状況'), si = row.lastIndexOf('工場', st);
    if (st >= 0 && si >= 0 && row.indexOf('社員番号') >= 0) { hr = r; cSite = si; cStat = st; }
  }
  if (hr < 0) return null;
  const count = {};
  for (let r = hr + 1; r < vals.length; r++) {
    const site = String(vals[r][cSite]).trim();
    if (!site || String(vals[r][cStat]).trim() !== '在職中') continue;
    count[site] = (count[site] || 0) + 1;
  }
  return count;
}
