/**
 * コストインサイト(生産・原価の進捗管理) - GAS API バックエンド
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
 *
 * ■ 第2段階: 実行予算の受け取り(会社サーバーの 実行予算更新.bat → pc/update.js からの POST)
 *   本文(text/plain): {"secret":"…","data": data.json の中身}(旧 実行予算まとめ と同じ形)。
 *   - 秘密キー: スクリプトプロパティ SECRET(PC側 設定.json の「秘密キー」と同じ値。リポジトリには書かない)
 *   - 受け取った工事ごとの値(key=ファイル名)を _cache_budget.json(同フォルダ)に保存する。
 *     読み取りエラーの工事は前回の値を引き継ぎ status:'error'、今回届かなかった工事は前回の値のまま missing:true。
 *   - 前回値(比較の基準): 受信時、保存済みの値が前日以前のものなら、それを baseline:{day, at, rows} に繰り上げる
 *     (同じ日の再受信では基準を変えない)。画面の「実行予算抽出」が、前回から変わったセルを黄色で示すのに使う。
 *   - 工事データ(工事No単位)の B 契約総重量・C 契約金額・F 労務費の締め を書く(値が変わった行だけ。無い工事Noは末尾に追加)。
 *     D 完了・E 年度には触らない。F は「2026.10」が 2026.1 にならないよう文字列(書式 @)で書く。
 *     対象外: 元ファイルなし・読み取りエラー・一覧に未登録・契約総重量と契約金額がどちらも0/空欄の工事。
 *     同じ工事Noのファイルが複数あれば保存日時の新しい方。
 *
 * ■ 第3段階: 生産重量の履歴(_history_production.json。工事マスタA列の工事だけ、削除せず全期間を残す)
 *   生産管理ダッシュボードは「本日から13か月前まで」しか返さないため、コストインサイト側で履歴を持つ。
 *   - 毎朝の集計: 生産管理APIの範囲内の日付は、その日のAPIに出てくる工事だけ最新値で置き換える。
 *     範囲より前の日付・APIに出てこない工事(枠の入れ替えで外れた工事)・「完了」の工事は履歴のまま(上書きしない)。
 *   - importHistory()(エディタから手動で実行): Excelマスタ一覧(生産管理ダッシュボードの索引)のC列の工事のうち、
 *     工事マスタA列にあり、まだ取り込んでいない工事か未完了の工事のマスターファイルを全期間読み、履歴を置き換える。
 *     元ファイルは読み取りのみ(Excelは読み取り用の一時コピーをこのフォルダに作り、読んだらすぐゴミ箱へ)。
 *     サービス「Drive API」の追加が必要。約5分で区切り、続きは同じ関数をもう一度実行する。
 *   - 生産管理ダッシュボードのコード・Excelマスタ一覧・元のExcelファイルには一切書き込まない。
 *
 * ■ シート(値の読み方)
 *   工事マスタ    : 工事No | 工事名 | 契約総重量(t) | 契約金額(円) | トン単価 | 完了 | 年度 | 労務費の締め
 *                   (A・B列は日報アプリからIMPORTRANGE、C〜H列は「工事データ」からのVLOOKUP式。GASは読むだけ)
 *   工事データ    : 工事No | 契約総重量(t) | 契約金額(円) | 完了 | 年度 | 労務費の締め(第2段階からGASが書く)
 *   基本設定      : 項目 | 値 (項目名で読む: 共通扱い工事No・目標利益率(対売比率)・月額概算固定費(鉄構部)。後ろの2つは画面の「設定」から書き換える)
 *   会社カレンダー: A〜B列 日付 | 出勤・休日、D列以降に従業員名簿(見出し 社員番号・工場・氏名・部署・状況)
 *                   名簿は「在職中」の人数を工場別に数えて返すだけ(氏名は返さない)
 *
 * ■ API(パスワードなし)
 *   GET ?action=getData : { status, data:{ cache, settings, budget } }(キャッシュが無ければ集計してから返す。
 *                         budget は _cache_budget.json の中身(まだ受信していなければ null))
 *   GET ?action=refresh : 集計し直してから同じ形で返す
 *   GET ?action=master  : { status, data:{ works:[{no, name}] } }(工事マスタの工事No・工事名だけ。PC側の工事の対応付け用)
 *   GET ?action=budget  : { status, data:{ today:{ at, rows:[key…] } } }(実行予算の最終受信時刻。PC側の保存確認用)
 *   POST(秘密キー必須) : 実行予算の受け取り(上の第2段階)
 *   POST {action:'settings', changes:[{no, done?:true/false, year?:'R8'/''}], basic?:{targetProfitRate?, otherFixedMonthly?}}(秘密キー不要。画面の「完了・年度の設定」から誰でも保存できる)
 *     工事データの D 完了('完了'/空欄)・E 年度 を工事No単位で書く(送られてきた項目だけ)。工事データに無い工事Noは末尾に追加する。
 *     同じ工事Noの行が複数あれば上の行に書き、応答の dup で知らせる。最後に保存した内容が正。
 */

const PM_API_URL = 'https://script.google.com/macros/s/AKfycbya0wgwbTuBN1laM8tWFGTJhJw--pTAOBAYVyrsOoXbrOXZgs9q3ZsErTSQZwJFT2c2/exec';
const DR_API_URL = 'https://script.google.com/macros/s/AKfycbyiocXgXi_YEMUUq5BJPe7CUi2V-LJIBvLwceextYV-82hEArRKRaHQ5peVj5oMfTsW/exec';
const CACHE_FILE_NAME = '_cache_production.json';
const BUDGET_FILE_NAME = '_cache_budget.json';
const HISTORY_FILE_NAME = '_history_production.json';
// 生産管理ダッシュボードの索引「Excelマスタ一覧」(読み取りのみ)。C 工事番号 / D ファイル名 / E URL
const INDEX_SHEET_ID = '14Wgpkny7wIboiRKLyp7wZ8hxzUVevKmXdVJGIpV7A3c';
const IMPORT_TIME_LIMIT_MS = 5 * 60 * 1000; // GASの6分制限の手前で区切る
const TEMP_COPY_PREFIX = '_一時コピー_読み取り用_';
const TZ = 'Asia/Tokyo';
// 集計対象の工場。これ以外(「中止」「高馬」など)の加工先・所属のデータは集計から除外する
const SITE_ORDER = ['本社', '夢前', '鳥取'];

const SHEETS = { MASTER: '工事マスタ', WORKDATA: '工事データ', BASIC: '基本設定', CALENDAR: '会社カレンダー' };
// 基本設定の項目名 → 返すときの名前と既定値
const BASIC_KEYS = [
  ['共通扱い工事No', 'commonWorkNos', ''],
  ['目標利益率', 'targetProfitRate', null], // シートの項目名は「目標利益率(%)」「目標利益率（対売比率）」など、この文字で始まっていればよい
  ['月額概算固定費', 'otherFixedMonthly', null, '月額その他固定費'], // 「月額概算固定費（鉄構部）」(旧名「月額その他固定費(円)」でも読む)
];

// ========== エントリーポイント ==========

function doGet(e) {
  try {
    const action = (e && e.parameter && e.parameter.action) || 'getData';
    if (action === 'getData') return dataResponse_(false);
    if (action === 'refresh') return dataResponse_(true);
    if (action === 'master') return json_({ status: 'success', data: { works: readMasterList_() } });
    if (action === 'budget') return json_({ status: 'success', data: { today: budgetSummary_() } });
    return json_({ status: 'error', message: '不明なaction: ' + action });
  } catch (err) {
    return json_({ status: 'error', message: String(err && err.message || err) });
  }
}

function doPost(e) {
  const lock = LockService.getScriptLock();
  let locked = false;
  try {
    const body = JSON.parse((e && e.postData && e.postData.contents) || '{}');
    if (body.action === 'settings') {
      lock.waitLock(30000);
      locked = true;
      const data = saveWorkSettings_(body.changes || []);
      if (body.basic) data.basic = saveBasicSettings_(body.basic);
      return json_({ status: 'success', data: data });
    }
    const secret = PropertiesService.getScriptProperties().getProperty('SECRET');
    if (!secret || body.secret !== secret) return json_({ status: 'error', message: '秘密キーが違います' });
    const rows = normalizeBudgetRows(body.data);
    if (!rows.length) return json_({ status: 'error', message: 'データが空です' });

    lock.waitLock(30000);
    locked = true;
    const next = mergeBudget(loadBudget_(), rows, Utilities.formatDate(new Date(), TZ, "yyyy-MM-dd'T'HH:mm:ssXXX"));
    saveFileText_(BUDGET_FILE_NAME, JSON.stringify(next));
    let works;
    try {
      works = syncWorkData_(next.rows);
    } catch (err) {
      works = { error: String(err && err.message || err) };
    }
    Logger.log('工事データへの反映: ' + JSON.stringify(works));
    return json_({ status: 'success', data: { rows: Object.keys(next.rows).length, works: works } });
  } catch (err) {
    return json_({ status: 'error', message: String(err && err.message || err) });
  } finally {
    if (locked) try { lock.releaseLock(); } catch (ignore) {}
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
  const budgetText = loadBudgetText_() || 'null';
  return ContentService.createTextOutput('{"status":"success","data":{"cache":' + cacheText + ',"settings":' + settingsText + ',"budget":' + budgetText + '}}')
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
  Logger.log('工事データ: ' + (SpreadsheetApp.getActive().getSheetByName(SHEETS.WORKDATA) ? 'あり' : '見つかりません'));
  Logger.log('秘密キー(SECRET): ' + (PropertiesService.getScriptProperties().getProperty('SECRET') ? '設定済み' : '未設定 ← スクリプトプロパティに設定してください'));
  const b = budgetSummary_();
  Logger.log('実行予算: ' + (b ? b.rows.length + '件(最終受信 ' + b.at + ')' : 'まだ受信していません'));
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
    // 所要時間を記録する(取得=3つのAPI待ち / 履歴 / 集計)。キャッシュの timing と実行ログに残し、遅い所を特定できるようにする
    const t0 = Date.now();
    const src = fetchSources_();
    const t1 = Date.now();
    src.history = updateHistoryFromPm_(src.pm);
    const t2 = Date.now();
    const agg = aggregateSources_(src);
    const t3 = Date.now();
    agg.timing = { fetchMs: t1 - t0, historyMs: t2 - t1, aggregateMs: t3 - t2 };
    const text = JSON.stringify(agg);
    saveCacheText_(text);
    Logger.log('集計の所要時間: 取得 ' + (t1 - t0) + 'ms / 履歴 ' + (t2 - t1) + 'ms / 集計 ' + (t3 - t2) + 'ms / 保存 ' + (Date.now() - t3) + 'ms / 合計 ' + (Date.now() - t0) + 'ms(キャッシュ ' + text.length + '文字)');
    return text;
  } finally {
    lock.releaseLock();
  }
}

/* エディタから手動で実行する: 3つのAPIを1つずつ呼んで、それぞれの所要時間・応答の大きさ・結果をログに出す(遅い所の特定用。保存はしない)。 */
function diagnoseRefresh() {
  const dr = function (action) {
    return { url: DR_API_URL, method: 'post', contentType: 'application/json',
      payload: JSON.stringify({ action: action, params: {} }), muteHttpExceptions: true, followRedirects: true };
  };
  const list = [
    ['生産管理ダッシュボード getData', { url: PM_API_URL + '?action=getData', method: 'get', muteHttpExceptions: true, followRedirects: true }],
    ['日報 getMasterData', dr('getMasterData')],
    ['日報 getAllDailyReportRows', dr('getAllDailyReportRows')],
  ];
  list.forEach(function (it) {
    const t = Date.now();
    const res = UrlFetchApp.fetch(it[1].url, it[1]);
    const text = res.getContentText();
    let st = '';
    try { st = JSON.parse(text).status; } catch (e) { st = '(JSONではない)'; }
    Logger.log(it[0] + ': ' + (Date.now() - t) + 'ms / HTTP ' + res.getResponseCode() + ' / ' + text.length + '文字 / status=' + st);
  });
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

  (applyHistoryToPmWorks(pm.works || [], src.history)).forEach(function (w) {
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
    // マスターファイルから全期間を取り込み済みの工事No(画面の注意書きの表示に使う)
    historyImported: Object.keys((src.history && src.history.works) || {}).filter(function (no) { return src.history.works[no].imported; }).sort(),
  };
}

function round_(v, d) { const f = Math.pow(10, d); return Math.round(v * f) / f; }

// ========== 生産重量の履歴(純粋関数。Nodeでテストする) ==========
// history = { v:1, works:{ 工事No: { byDate:{ 'yyyy-MM-dd': { 工場: 重量t } }, imported:'取込日時'|'' , files:[ファイル名] } } }

// 生産管理APIの範囲の始まり(カレンダーと重量の日付のうち早い方)
function pmWindowStart(pm) {
  let min = '';
  Object.keys((pm && pm.calendar) || {}).forEach(function (k) { if (!min || k < min) min = k; });
  ((pm && pm.works) || []).forEach(function (w) {
    Object.keys(w.bySite || {}).forEach(function (site) {
      Object.keys(w.bySite[site].weightByDate || {}).forEach(function (k) { if (!min || k < min) min = k; });
    });
  });
  return min;
}

// 毎朝の生産管理APIの値を履歴に反映した新しい履歴を返す(元の history は変えない)。
// masterNos: 工事マスタA列の工事No → true、doneNos: 「完了」の工事No → true
function mergeHistory(history, pm, masterNos, doneNos) {
  const next = { v: 1, works: {} };
  const old = (history && history.works) || {};
  Object.keys(old).forEach(function (no) { next.works[no] = JSON.parse(JSON.stringify(old[no])); });
  const from = pmWindowStart(pm);
  if (!from) return next;
  const touched = {}; // 今回APIの値を入れた 工事No|日付|工場(同じ工事がAPIに複数回出ても足し合わせる)
  ((pm && pm.works) || []).forEach(function (w) {
    const no = String(w.workNo).trim();
    if (!masterNos[no] || doneNos[no]) return; // 工事マスタに無い工事・完了の工事は上書きしない
    const h = next.works[no] || (next.works[no] = { byDate: {}, imported: '', files: [] });
    // APIが値を返した「日付×工場」だけAPIの値で置き換える。APIが返さない日付(APIに未反映の期間)は履歴のまま残す
    // (範囲内の履歴を先に全削除すると、マスターから取り込んだ値がAPIに無いだけで消える。25-14で約1,051t消えた)
    Object.keys(w.bySite || {}).forEach(function (site) {
      const st = String(site).trim();
      const byDate = w.bySite[site].weightByDate || {};
      Object.keys(byDate).forEach(function (k) {
        if (k < from) return;
        const wt = Number(byDate[k]) || 0;
        if (!wt) return;
        const d = h.byDate[k] || (h.byDate[k] = {});
        const tk = no + '|' + k + '|' + st;
        d[st] = touched[tk] ? (d[st] || 0) + wt : wt;
        touched[tk] = true; // 丸めない(集計結果を生産管理の値と完全に一致させるため)
      });
    });
  });
  return next;
}

// 生産管理APIの works のうち、履歴のある工事は履歴の重量(全期間)に差し替える。
// 履歴だけにある工事(APIの範囲から外れた工事)も加える。履歴の無い工事はAPIの値のまま。
function applyHistoryToPmWorks(pmWorks, history) {
  const hw = (history && history.works) || {};
  const out = [];
  const seen = {};
  pmWorks.forEach(function (w) {
    const no = String(w.workNo).trim();
    if (!hw[no]) { out.push(w); return; }
    if (seen[no]) return;
    seen[no] = true;
    out.push(historyToPmWork_(no, hw[no], w.workName));
  });
  Object.keys(hw).forEach(function (no) {
    if (!seen[no]) out.push(historyToPmWork_(no, hw[no], ''));
  });
  return out;
}

function historyToPmWork_(no, h, name) {
  const bySite = {};
  Object.keys(h.byDate || {}).forEach(function (k) {
    const d = h.byDate[k];
    Object.keys(d).forEach(function (site) {
      const s = bySite[site] || (bySite[site] = { weightByDate: {} });
      s.weightByDate[k] = (s.weightByDate[k] || 0) + (Number(d[site]) || 0);
    });
  });
  return { workNo: no, workName: name || '', bySite: bySite };
}

// マスターファイル(1シート目)の値から { 'yyyy-MM-dd': { 工場: 重量 } } を作る(生産管理ダッシュボードと同じ読み方:
// 見出し「部位」「加工先」「加工」「重量」、部位・加工先・加工日がある行だけ。期間の絞り込みはしない)。
// toYmd: Date → 'yyyy-MM-dd'(JST)
function byDateFromValues(values, toYmd) {
  const byDate = {};
  if (!values || values.length < 2) return byDate;
  const header = values[0].map(function (h) { return String(h === null || h === undefined ? '' : h).trim(); });
  const col = { part: header.indexOf('部位'), site: header.indexOf('加工先'), date: header.indexOf('加工'), weight: header.indexOf('重量') };
  if (col.part < 0 || col.site < 0 || col.date < 0) return byDate;
  for (let i = 1; i < values.length; i++) {
    const r = values[i];
    const site = String(r[col.site] || '').trim(), part = String(r[col.part] || '').trim(), dv = r[col.date];
    if (!site || !part || !(dv instanceof Date) || isNaN(dv.getTime())) continue;
    const wt = col.weight >= 0 ? (Number(r[col.weight]) || 0) : 0;
    if (!wt) continue;
    const k = toYmd(dv);
    const d = byDate[k] || (byDate[k] = {});
    d[site] = (d[site] || 0) + wt;
  }
  return byDate;
}

function mergeByDate(a, b) {
  const out = JSON.parse(JSON.stringify(a || {}));
  Object.keys(b || {}).forEach(function (k) {
    const d = out[k] || (out[k] = {});
    Object.keys(b[k]).forEach(function (site) { d[site] = (d[site] || 0) + b[k][site]; });
  });
  return out;
}

// Excelマスタ一覧の行(A〜E列の値)から、工事Noごとのファイル一覧を作る(工事番号が空・00-00・URLが無い行は除く)。
// マスタNo(B列)が S で始まればGoogleスプレッドシート、それ以外はExcel(生産管理ダッシュボードと同じ判定)。
function indexFilesByWork(rows) {
  const out = {};
  rows.forEach(function (row) {
    const no = String(row[2] || '').trim(), name = String(row[3] || '').trim(), url = String(row[4] || '').trim();
    if (!no || no === '00-00' || !name || !url) return;
    const m = /\/d\/([-\w]{25,})/.exec(url) || /[?&]id=([-\w]{25,})/.exec(url);
    if (!m) return;
    (out[no] || (out[no] = [])).push({ masterNo: String(row[1] || '').trim(), name: name, id: m[1], sheet: /^s/i.test(String(row[1] || '').trim()) });
  });
  return out;
}

// ========== 生産重量の履歴(GAS側) ==========

function loadHistory_() {
  const it = folder_().getFilesByName(HISTORY_FILE_NAME);
  if (!it.hasNext()) return { v: 1, works: {} };
  try { return JSON.parse(it.next().getBlob().getDataAsString('UTF-8')); } catch (e) { return { v: 1, works: {} }; }
}

function saveHistory_(h) {
  h.savedAt = new Date().toISOString();
  saveFileText_(HISTORY_FILE_NAME, JSON.stringify(h));
}

// 工事マスタA列の工事No と 「完了」の工事No
function masterAndDone_() {
  const works = readWorks_(sheet_(SHEETS.MASTER));
  const masterNos = {}, doneNos = {};
  Object.keys(works).forEach(function (no) { masterNos[no] = true; if (works[no].done) doneNos[no] = true; });
  return { masterNos: masterNos, doneNos: doneNos };
}

// 毎朝の集計で呼ぶ。生産管理APIの値を履歴に反映して保存し、反映後の履歴を返す
function updateHistoryFromPm_(pm) {
  const md = masterAndDone_();
  const next = mergeHistory(loadHistory_(), pm, md.masterNos, md.doneNos);
  saveHistory_(next);
  return next;
}

/* 履歴に記録したファイルの更新日時(h.mtimes: {ファイルID: ミリ秒})が、今のドライブ上の更新日時(updated)と全ファイルで一致するか。
   一致すれば、そのファイルは前回から編集されていないので読み直さない(純粋関数。Nodeでテストする)。記録が無ければ false */
function historyUpToDate_(h, fileList, updated) {
  if (!h || !h.imported || !h.mtimes) return false;
  return fileList.every(function (f) { return updated[f.id] !== undefined && h.mtimes[f.id] === updated[f.id]; });
}

function fileUpdatedMs_(id) {
  try { return DriveApp.getFileById(id).getLastUpdated().getTime(); } catch (e) { return undefined; }
}

/* エディタから手動で実行する: マスターファイルから全期間の生産重量を履歴に取り込む(差分)。
   対象: Excelマスタ一覧C列の工事のうち、工事マスタA列にある工事。
   ファイルの更新日時を工事ごとに履歴へ記録し、前回から更新日時が変わっていないファイルは読み直さない(編集されたファイルだけ読む)。
   更新日時の記録がまだ無い工事: 完了の工事は従来どおり読み直さず(今の更新日時を記録だけ)、完了でない工事は1回読んで記録する。
   約5分で区切る。「続きがあります」とログに出たら、もう一度実行する(読み終えた工事は更新日時が一致するので飛ばす)。 */
function importHistory() {
  importHistory_(false);
}

/* エディタから手動で実行する: 更新日時に関わらず、すべての工事を読み直す(履歴を作り直したいとき)。約5分で区切り、続きはもう一度実行する。 */
function importHistoryAll() {
  importHistory_(true);
}

function importHistory_(force) {
  const t0 = Date.now();
  const props = PropertiesService.getScriptProperties();
  let runStart = props.getProperty('IMPORT_RUN_START');
  if (force && !runStart) { runStart = new Date().toISOString(); props.setProperty('IMPORT_RUN_START', runStart); }

  const md = masterAndDone_();
  const idxSh = SpreadsheetApp.openById(INDEX_SHEET_ID).getSheets()[0];
  const last = idxSh.getLastRow();
  const files = indexFilesByWork(last >= 2 ? idxSh.getRange(2, 1, last - 1, 5).getValues() : []);
  const history = loadHistory_();
  const nos = Object.keys(files).filter(function (no) { return md.masterNos[no]; }).sort();
  const done = [], skipped = [], failed = [];
  let remaining = 0;

  for (let i = 0; i < nos.length; i++) {
    const no = nos[i], h = history.works[no];
    if (Date.now() - t0 > IMPORT_TIME_LIMIT_MS) { remaining = nos.length - i; break; }
    const updated = {};
    files[no].forEach(function (f) { updated[f.id] = fileUpdatedMs_(f.id); });
    if (force) {
      if (h && h.imported && h.imported >= runStart) { skipped.push(no); continue; } // この実行(続きの実行を含む)で読み終えた工事
    } else if (historyUpToDate_(h, files[no], updated)) { skipped.push(no); continue; } // 更新日時が前回と同じ=編集されていない
    else if (h && h.imported && !h.mtimes && md.doneNos[no]) { // 更新日時の記録が無い完了の工事: 従来どおり読み直さず、今の更新日時を記録だけする
      h.mtimes = updated; saveHistory_(history); skipped.push(no); continue;
    }
    try {
      let byDate = {};
      files[no].forEach(function (f) { byDate = mergeByDate(byDate, readMasterFileByDate_(f)); });
      const nh = history.works[no] || (history.works[no] = { byDate: {}, imported: '', files: [] });
      nh.byDate = byDate;
      nh.imported = new Date().toISOString();
      nh.files = files[no].map(function (f) { return f.name; });
      nh.mtimes = updated; // 読む前に測った更新日時(読んでいる間に編集されたら、次回また読み直す)
      saveHistory_(history); // 1工事ごとに保存(途中で止まっても取り込んだ分は残る)
      done.push(no + '(' + nh.files.length + 'ファイル・' + round_(sumByDate_(byDate), 1) + 't)');
    } catch (err) {
      failed.push(no + ': ' + (err && err.message || err));
    }
  }
  Logger.log('取り込み: ' + (done.join('、') || 'なし'));
  Logger.log('更新日時が前回と同じなど、読み直さなかった工事: ' + (skipped.join('、') || 'なし'));
  if (failed.length) Logger.log('読み取れなかった工事: ' + failed.join(' / '));
  if (remaining) {
    Logger.log('続きがあります(残り ' + remaining + ' 工事)。もう一度 importHistory を実行してください。');
    return;
  }
  props.deleteProperty('IMPORT_RUN_START');
  refreshLocked_(false); // 画面用の集計を作り直す
  Logger.log('すべて終わりました。画面用の集計も作り直しました。');
}

function sumByDate_(byDate) {
  let t = 0;
  Object.keys(byDate).forEach(function (k) { Object.keys(byDate[k]).forEach(function (s) { t += byDate[k][s]; }); });
  return t;
}

// 1つのマスターファイルを読み取りのみで読む。Excelは読み取り用の一時コピー(スプレッドシート形式)を
// このフォルダに作って読み、読み終えたらすぐゴミ箱へ移す(元ファイルは開かず、変更もしない)。
function readMasterFileByDate_(f) {
  const toYmd = function (d) { return Utilities.formatDate(d, TZ, 'yyyy-MM-dd'); };
  if (f.sheet) return byDateFromValues(SpreadsheetApp.openById(f.id).getSheets()[0].getDataRange().getValues(), toYmd);
  const blob = DriveApp.getFileById(f.id).getBlob();
  const tmp = Drive.Files.create({ name: TEMP_COPY_PREFIX + f.name, mimeType: MimeType.GOOGLE_SHEETS, parents: [folder_().getId()] }, blob);
  try {
    return byDateFromValues(SpreadsheetApp.openById(tmp.id).getSheets()[0].getDataRange().getValues(), toYmd);
  } finally {
    try { DriveApp.getFileById(tmp.id).setTrashed(true); } catch (ignore) {}
  }
}

// ========== 実行予算の受け取り(純粋関数。Nodeでテストする) ==========

// data.json の中身から1工事ずつの配列を取り出す({rows:[…]}。配列そのものも受ける)
function normalizeBudgetRows(data) {
  if (!data) return [];
  const list = Array.isArray(data) ? data : Array.isArray(data.rows) ? data.rows : [];
  return list.filter(function (r) { return r && typeof r === 'object' && r.key; });
}

// 保存済み { version, at, rows:{key:row}, baseline? } に今回の受信を重ねる
//   at: 'yyyy-MM-ddTHH:mm:ss+09:00'(日本時間)。保存済みの日付が前日以前なら、保存済みの内容を baseline(比較の基準)に繰り上げる
function mergeBudget(state, incoming, at) {
  const day = String(at).slice(0, 10);
  const prevDay = state && state.at ? String(state.at).slice(0, 10) : '';
  let baseline = (state && state.baseline) || null;
  if (state && state.rows && prevDay && prevDay < day) baseline = { day: prevDay, at: state.at, rows: state.rows };
  const prevRows = (state && state.rows) || {};
  const rows = {};
  incoming.forEach(function (r) {
    const old = prevRows[r.key];
    let row = r;
    if (r.status === 'error' && old) {
      row = JSON.parse(JSON.stringify(old));
      row.status = 'error';
      row.error = r.error || '';
      row.locked = !!r.locked;
    }
    delete row.missing;
    rows[r.key] = row;
  });
  Object.keys(prevRows).forEach(function (k) {
    if (rows[k]) return;
    const row = JSON.parse(JSON.stringify(prevRows[k]));
    row.missing = true;
    row.locked = false;
    rows[k] = row;
  });
  return { version: 1, at: at, day: day, baseline: baseline, rows: rows };
}

// 工事データの既存値(A〜F列の表示文字、2行目から)と受信値から、書き換える行と追加する行を決める
//   existing: [[工事No, 重量, 金額, 完了, 年度, 労務費の締め], …]
//   戻り値: { updates:[{row, weight, amount, cutoff}], appends:[{no, weight, amount, cutoff}] }
//   weight・amount は数値か ''、cutoff は '2026.6' のような文字か ''
function computeWorkDataUpdates(existing, rows) {
  const want = {};
  Object.keys(rows).forEach(function (k) {
    const r = rows[k];
    if (!r || r.missing || r.status === 'error' || r.matchedBy === '一覧に未登録' || !r.no) return;
    const w = numOrNull_(r.weight), a = numOrNull_(r.amount);
    if (!w && !a) return;
    const prev = want[r.no];
    if (prev && String(prev.saved || '') >= String(r.saved || '')) return;
    want[r.no] = { saved: r.saved, weight: w === null ? '' : round_(w, 3), amount: a === null ? '' : a, cutoff: String(r.laborCutoff || '') };
  });
  const updates = [], seen = {};
  existing.forEach(function (v, i) {
    const no = String(v[0] === null || v[0] === undefined ? '' : v[0]).trim();
    if (!no || seen[no] || !want[no]) return;
    seen[no] = true;
    const nv = want[no];
    if (!sameNum_(v[1], nv.weight, 0.0005) || !sameNum_(v[2], nv.amount, 0.5) || String(v[5] || '').trim() !== nv.cutoff)
      updates.push({ row: i + 2, weight: nv.weight, amount: nv.amount, cutoff: nv.cutoff });
  });
  const appends = Object.keys(want).filter(function (no) { return !seen[no]; })
    .sort(function (x, y) { return x.localeCompare(y, 'ja', { numeric: true }); })
    .map(function (no) { const nv = want[no]; return { no: no, weight: nv.weight, amount: nv.amount, cutoff: nv.cutoff }; });
  return { updates: updates, appends: appends };
}

// 工事データへの完了・年度の書き込み内容を決める
//   colA: A列の値(2行目から順)、changes: [{no, done?:true/false, year?:'R8'/''}]
//   戻り値: { writes:[{row, col:4|5, value}], appends:[{no, done, year}], updated:[no], dup:[no] }
function computeSettingsWrites(colA, changes) {
  const rowOf = {}, dupOf = {};
  colA.forEach(function (v, i) {
    const no = String(v === null || v === undefined ? '' : v).trim();
    if (!no) return;
    if (rowOf[no]) dupOf[no] = true;
    else rowOf[no] = i + 2;
  });
  const res = { writes: [], appends: [], updated: [], dup: [] };
  const appendOf = {};
  (Array.isArray(changes) ? changes : []).forEach(function (c) {
    const no = String(c && c.no || '').trim();
    if (!no) return;
    let done = null, year = null;
    if (typeof c.done === 'boolean') done = c.done ? '完了' : '';
    if (typeof c.year === 'string') {
      year = c.year.trim();
      if (year && !/^R\d{1,3}$/.test(year)) throw new Error('年度の形式が違います: ' + year);
    }
    if (done === null && year === null) return;
    const row = rowOf[no];
    if (row) {
      if (done !== null) res.writes.push({ row: row, col: 4, value: done });
      if (year !== null) res.writes.push({ row: row, col: 5, value: year });
      if (dupOf[no]) res.dup.push(no);
    } else {
      const a = appendOf[no] || (appendOf[no] = { no: no, done: '', year: '' });
      if (done !== null) a.done = done;
      if (year !== null) a.year = year;
    }
    if (res.updated.indexOf(no) < 0) res.updated.push(no);
  });
  res.appends = Object.keys(appendOf).map(function (no) { return appendOf[no]; });
  return res;
}

function sameNum_(cur, nv, tol) {
  const c = numOrNull_(cur);
  if (nv === '' || nv === null) return c === null;
  return c !== null && Math.abs(c - nv) < tol;
}

// ========== キャッシュファイル ==========

// 1回の実行の中では同じフォルダなので、最初の1回だけDriveに問い合わせる
let folderMemo_ = null;
function folder_() {
  if (!folderMemo_) folderMemo_ = DriveApp.getFileById(SpreadsheetApp.getActive().getId()).getParents().next();
  return folderMemo_;
}

function loadCacheText_() {
  const it = folder_().getFilesByName(CACHE_FILE_NAME);
  if (!it.hasNext()) return null;
  const text = it.next().getBlob().getDataAsString();
  // 数MBのJSONを毎回JSON.parseすると遅いため、形だけ確かめる(壊れていれば作り直す)
  return /^\s*\{[\s\S]*\}\s*$/.test(text) ? text : null;
}

function saveCacheText_(text) {
  saveFileText_(CACHE_FILE_NAME, text);
}

function saveFileText_(name, text) {
  const folder = folder_();
  const it = folder.getFilesByName(name);
  if (it.hasNext()) it.next().setContent(text);
  else folder.createFile(name, text, MimeType.PLAIN_TEXT);
}

function loadBudgetText_() {
  const it = folder_().getFilesByName(BUDGET_FILE_NAME);
  if (!it.hasNext()) return null;
  const text = it.next().getBlob().getDataAsString('UTF-8');
  return /^\s*\{[\s\S]*\}\s*$/.test(text) ? text : null;
}

function loadBudget_() {
  const text = loadBudgetText_();
  return text ? JSON.parse(text) : null;
}

function budgetSummary_() {
  const b = loadBudget_();
  return b ? { at: b.at, rows: Object.keys(b.rows || {}) } : null;
}

// 画面からの目標利益率(%)・月額その他固定費(円)の保存(基本設定 B列。項目名は前方一致、無ければ末尾に追加)
function saveBasicSettings_(basic) {
  const sh = sheet_(SHEETS.BASIC);
  const labels = { targetProfitRate: '目標利益率（対売比率）', otherFixedMonthly: '月額概算固定費（鉄構部）' };
  const prefixes = { targetProfitRate: ['目標利益率'], otherFixedMonthly: ['月額概算固定費', '月額その他固定費'] };
  const done = {};
  Object.keys(labels).forEach(function (key) {
    if (!(key in basic)) return;
    const v = numOrNull_(basic[key]);
    if (v === null || v < 0) throw new Error(labels[key] + 'は0以上の数値で入力してください');
    const last = sh.getLastRow();
    const colA = last >= 2 ? sh.getRange(2, 1, last - 1, 1).getDisplayValues() : [];
    let row = 0;
    for (let i = 0; i < colA.length; i++) if (prefixes[key].some(function (n) { return String(colA[i][0]).trim().indexOf(n) === 0; })) { row = i + 2; break; }
    if (!row) { row = Math.max(last, 1) + 1; sh.getRange(row, 1).setValue(labels[key]); }
    sh.getRange(row, 2).setValue(v);
    done[key] = v;
  });
  return done;
}

// 画面からの完了・年度の保存(工事データ D・E 列)
function saveWorkSettings_(changes) {
  const sh = sheet_(SHEETS.WORKDATA);
  const last = sh.getLastRow();
  const colA = last >= 2 ? sh.getRange(2, 1, last - 1, 1).getDisplayValues().map(function (r) { return r[0]; }) : [];
  const plan = computeSettingsWrites(colA, changes);
  plan.writes.forEach(function (w) { sh.getRange(w.row, w.col).setValue(w.value); });
  if (plan.appends.length) {
    let end = colA.length;
    while (end > 0 && !String(colA[end - 1]).trim()) end--;
    sh.getRange(end + 2, 1, plan.appends.length, 5).setValues(plan.appends.map(function (a) { return [a.no, '', '', a.done, a.year]; }));
  }
  return { updated: plan.updated, appended: plan.appends.map(function (a) { return a.no; }), dup: plan.dup };
}

// 工事データ シートの B・C・F 列を受信値に合わせる(D 完了・E 年度には触らない)
function syncWorkData_(rows) {
  const sh = sheet_(SHEETS.WORKDATA);
  const last = sh.getLastRow();
  // 重量・金額は表示形式で丸められないよう実際の値、締めは表示文字(2026.10 を 2026.1 と読まないため)で読む
  const existing = [];
  if (last >= 2) {
    const rg = sh.getRange(2, 1, last - 1, 6), vals = rg.getValues(), disp = rg.getDisplayValues();
    vals.forEach(function (v, i) { existing.push([disp[i][0], v[1], v[2], v[3], v[4], disp[i][5]]); });
  }
  const plan = computeWorkDataUpdates(existing, rows);
  plan.updates.forEach(function (u) {
    sh.getRange(u.row, 2, 1, 2).setValues([[u.weight, u.amount]]);
    sh.getRange(u.row, 6).setNumberFormat('@').setValue(u.cutoff);
  });
  if (plan.appends.length) {
    // 末尾(A列に値がある最後の行の次)に追加する
    let end = existing.length;
    while (end > 0 && !String(existing[end - 1][0]).trim()) end--;
    const start = end + 2;
    sh.getRange(start, 6, plan.appends.length, 1).setNumberFormat('@');
    sh.getRange(start, 1, plan.appends.length, 6).setValues(plan.appends.map(function (a) {
      return [a.no, a.weight, a.amount, '', '', a.cutoff];
    }));
  }
  return { updated: plan.updates.map(function (u) { return existing[u.row - 2][0]; }), appended: plan.appends.map(function (a) { return a.no; }) };
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
    let raw = basic[k[0]];
    const names = [k[0]].concat(k[3] ? [k[3]] : []);
    if (raw === undefined) Object.keys(basic).some(function (name) { if (names.some(function (n) { return name.indexOf(n) === 0; })) { raw = basic[name]; return true; } return false; });
    const isNum = k[1] === 'targetProfitRate' || k[1] === 'otherFixedMonthly';
    s[k[1]] = (raw === undefined || raw === '') ? k[2] : (isNum ? numOrNull_(raw) : raw);
  });
  s.works = readWorks_(sheet_(SHEETS.MASTER));
  const calSh = sheet_(SHEETS.CALENDAR);
  const calVals = calSh.getLastRow() >= 1 && calSh.getLastColumn() >= 1 ? calSh.getRange(1, 1, calSh.getLastRow(), calSh.getLastColumn()).getValues() : []; // 同じ範囲を2回読まない
  s.calendar = readCalendar_(calVals);
  s.headcount = readHeadcount_(calVals);
  return s;
}

/* 工事マスタの工事No・工事名だけ(PC側の工事の対応付け用。金額などは返さない) */
function readMasterList_() {
  const sh = sheet_(SHEETS.MASTER);
  const last = sh.getLastRow();
  if (last < 2) return [];
  return sh.getRange(2, 1, last - 1, 2).getDisplayValues()
    .map(function (r) { return { no: String(r[0]).trim(), name: String(r[1]).trim() }; })
    .filter(function (w) { return w.no; });
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
function readCalendar_(vals) {
  const cal = {};
  if (vals.length < 1 || vals[0].length < 2) return cal;
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
function readHeadcount_(vals) {
  if (vals.length < 2 || vals[0].length < 1) return null;
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
