/**
 * 日報集計アプリ - サーバーサイド
 *
 * このスクリプトは「情報」「記録」シートを持つ管理用スプレッドシートに
 * コンテナーバウンドで設置する想定。DailyReport本体は編集せず
 * SpreadsheetApp.openById() で読み取り専用アクセスする。
 *
 * 「情報」シート:
 *   A1:ファイル名  B1:ファイルID
 *   2行目以降にデータ。A/B列(DailyReportファイル参照)。
 * 「記録」シート:
 *   A1:日時  B1:工場  C1:滞在時間(分)
 *   パスワード入力後、工場選択の時点で1行追記されるログ(ダウンロード時
 *   ではない)。アクセス制御はパスワード方式(Googleアカウントの照合は
 *   しない)のため個人の特定はできず、選択された工場名をB列に記録する。
 *   C列(滞在時間)はブラウザを閉じる際にベストエフォートで追記する。
 *   ブラウザの仕様上必ず書き込めるとは限らないため、空欄のままでもよい
 *   (A列・B列さえ記録されていればよい)。
 */

const DAILY_REPORT_SS_ID_FALLBACK = '1t2-KPP3NEfC-xW4yl5IbcI4dVuGilDnMbGWZN3H_t1U';
const INFO_SHEET_NAME = '情報';
const RECORD_SHEET_NAME = '記録';

const SHEET_NAMES = {
  DAILY_REPORT: 'DailyReport',
  CONSTRUCTION: 'Construction',
  WORKCONTENT: 'Workcontent',
  OPERATOR: 'Operator',
  COMPANY_CALENDAR: 'CompanyCalendar',
  ABSENTEEISM: 'Absenteeism'
};

const LOCATION_ORDER = { '本社': 0, '夢前': 1, '鳥取': 2 };

/* ===================== エントリポイント ===================== */

function doGet(e) {
  return HtmlService.createHtmlOutputFromFile('Index')
    .setTitle('日報集計アプリ')
    .addMetaTag('viewport', 'width=device-width, initial-scale=1')
    .setXFrameOptionsMode(HtmlService.XFrameOptionsMode.ALLOWALL);
}

/* ===================== 「情報」シート(DailyReportファイル参照) ===================== */

function getInfoRows_() {
  const sheet = SpreadsheetApp.getActive().getSheetByName(INFO_SHEET_NAME);
  if (!sheet) return [];
  return sheet.getDataRange().getValues();
}

function getDailyReportSsId_() {
  const rows = getInfoRows_();
  for (let i = 1; i < rows.length; i++) {
    if (rows[i][1]) return String(rows[i][1]); // B列: ファイルID
  }
  return DAILY_REPORT_SS_ID_FALLBACK;
}

/* ===================== 「記録」シート(ログイン・滞在時間ログ) ===================== */

/* パスワード入力後、工場選択の時点でクライアントから呼ばれる。
   追記した行番号を返し、クライアントはこれを覚えておいてブラウザを
   閉じる際にupdateSessionDuration_の行指定に使う。 */
function logFactorySelection(factory) {
  const sheet = SpreadsheetApp.getActive().getSheetByName(RECORD_SHEET_NAME);
  if (!sheet) return null;
  sheet.appendRow([new Date(), factory || '不明', '']);
  return sheet.getLastRow();
}

/* ブラウザを閉じる直前、ベストエフォートでクライアントから呼ばれる。
   間に合わず呼ばれなかった場合はC列は空欄のままになるが、それでよい。 */
function updateSessionDuration(rowNumber, minutes) {
  if (!rowNumber) return;
  const sheet = SpreadsheetApp.getActive().getSheetByName(RECORD_SHEET_NAME);
  if (!sheet) return;
  sheet.getRange(rowNumber, 3).setValue(minutes);
}

/* ===================== マスタ取得(クライアント初期表示用) ===================== */

function getMasterData() {
  const ss = SpreadsheetApp.openById(getDailyReportSsId_());

  const constructionRows = ss.getSheetByName(SHEET_NAMES.CONSTRUCTION).getDataRange().getValues();
  const constructions = [];
  for (let i = 1; i < constructionRows.length; i++) {
    const row = constructionRows[i];
    if (!row[0]) continue;
    constructions.push({ id: row[0], no: row[1], name: row[2], label: row[1] + ' ' + row[2] });
  }

  const workRows = ss.getSheetByName(SHEET_NAMES.WORKCONTENT).getDataRange().getValues();
  const workItems = [];
  for (let i = 1; i < workRows.length; i++) {
    const row = workRows[i];
    if (!row[0]) continue;
    workItems.push({ code: row[0], name: row[1], dept: row[2] });
  }

  const opRows = ss.getSheetByName(SHEET_NAMES.OPERATOR).getDataRange().getValues();
  const operators = [];
  for (let i = 1; i < opRows.length; i++) {
    const row = opRows[i];
    if (!row[0]) continue;
    operators.push({
      no: String(row[0]),
      name: row[1],
      factory: row[3],
      dept: row[4],
      retired: row[8] === '退職済',
      onLeave: row[8] === '休職中'
    });
  }
  operators.sort(function (a, b) {
    const lo = (LOCATION_ORDER[a.factory] === undefined ? 99 : LOCATION_ORDER[a.factory]) -
      (LOCATION_ORDER[b.factory] === undefined ? 99 : LOCATION_ORDER[b.factory]);
    if (lo !== 0) return lo;
    return Number(a.no) - Number(b.no);
  });

  return { constructions: constructions, workItems: workItems, operators: operators };
}

/* ===================== ④日報入力チェック用: CompanyCalendar/Absenteeism ===================== */

/* 日付('yyyy/MM/dd')→'出勤'|'休日' のマップを返す */
function getCompanyCalendarData() {
  const ss = SpreadsheetApp.openById(getDailyReportSsId_());
  const sheet = ss.getSheetByName(SHEET_NAMES.COMPANY_CALENDAR);
  if (!sheet) return {};
  const rows = sheet.getDataRange().getValues();
  const map = {};
  for (let i = 1; i < rows.length; i++) {
    const d = toDate_(rows[i][0]);
    if (!d) continue;
    map[formatDate_(d)] = rows[i][1];
  }
  return map;
}

/* 全種類の申請(有給・半日有給・欠勤・遅早等)を、社員No・自・至('yyyy/MM/dd')・申請項目の配列で返す。
   終日扱い(有給・欠勤)かどうかの判定はクライアント側(fullDayLeaveType)で行う。 */
function getAbsenteeismData() {
  const ss = SpreadsheetApp.openById(getDailyReportSsId_());
  const sheet = ss.getSheetByName(SHEET_NAMES.ABSENTEEISM);
  if (!sheet) return [];
  const rows = sheet.getDataRange().getValues();
  const result = [];
  for (let i = 1; i < rows.length; i++) {
    const r = rows[i];
    const type = String(r[8] || '').trim();
    if (!type) continue;
    const from = toDate_(r[5]);
    const to = toDate_(r[6]) || from;
    if (!from) continue;
    result.push({
      operatorNo: String(r[4]),
      from: formatDate_(from),
      to: formatDate_(to),
      type: type
    });
  }
  return result;
}

/* ===================== 締め日ロジック(21日始まり・20日締め) ===================== */

function closingRange_(year, month) {
  let endY = year, endM = month, endD = 20;
  let startY = year, startM = month - 1, startD = 21;
  if (startM === 0) { startM = 12; startY = year - 1; }
  return {
    start: new Date(startY, startM - 1, startD, 0, 0, 0),
    end: new Date(endY, endM - 1, endD, 23, 59, 59)
  };
}

/* ファイル名に使う期間トークン(range)のみ返す。実際の日付絞り込みはクライアント側で完了済み。 */
function getPeriodInfo_(p) {
  if (p.periodSpec !== 'yes') {
    return { range: 'ALL' };
  }
  if (p.periodMode === 'closing') {
    const r = closingRange_(Number(p.year), Number(p.month));
    return { range: formatDate_(r.start) + '-' + formatDateEnd_(r) };
  }
  return { range: p.from + '_' + p.to };
}

function formatDateEnd_(r) {
  return formatDate_(r.end);
}

/* ===================== DailyReport読み込み ===================== */

function loadDailyReportRows_() {
  const ss = SpreadsheetApp.openById(getDailyReportSsId_());
  const values = ss.getSheetByName(SHEET_NAMES.DAILY_REPORT).getDataRange().getValues();
  const rows = [];
  for (let i = 1; i < values.length; i++) {
    const r = values[i];
    if (!r[0]) continue;
    const factory = r[1], dept = r[2], operatorNo = String(r[4]), workDate = r[5];
    for (let slot = 0; slot < 5; slot++) {
      const off = 6 + slot * 4;
      const constructionId = r[off];
      const hours = r[off + 3];
      if (!constructionId || !hours) continue;
      rows.push({
        operatorNo: operatorNo,
        factory: factory,
        dept: dept,
        workDate: workDate,
        constructionId: constructionId,
        constructionName: r[off + 1],
        workCode: r[off + 2],
        hours: Number(hours) || 0
      });
    }
  }
  return rows;
}

/**
 * クライアント側でのカスケード絞り込み・ライブプレビュー用に、
 * DailyReportの全行(フラット化済み)を返す。作業日は 'yyyy/MM/dd' 文字列にして返す。
 */
function getAllDailyReportRows() {
  return loadDailyReportRows_().map(function (r) {
    return {
      operatorNo: r.operatorNo,
      factory: r.factory,
      dept: r.dept,
      workDate: formatDate_(toDate_(r.workDate)),
      constructionId: r.constructionId,
      workCode: r.workCode,
      hours: r.hours
    };
  });
}

function toDate_(v) {
  if (!v) return null;
  if (v instanceof Date) return new Date(v.getTime());
  const s = String(v).trim();
  const parts = s.split(/[\/\-]/);
  if (parts.length === 3) {
    return new Date(Number(parts[0]), Number(parts[1]) - 1, Number(parts[2]));
  }
  const d = new Date(s);
  return isNaN(d.getTime()) ? null : d;
}

function today_() {
  return Utilities.formatDate(new Date(), 'Asia/Tokyo', 'yyyyMMdd');
}

/* Utilities.formatDateはApps ScriptのAPI境界を毎回超えるため、
   数万件単位のループ内で呼ぶと致命的に遅い(実測: 1万数千件で10~20秒台)。
   appsscript.jsonのtimeZoneがAsia/Tokyoのため、Dateのgetter類だけで
   同じ'yyyy/MM/dd'文字列が組み立てられる(実データ46,493件+境界値で
   Utilities.formatDate版と完全一致することを検証済み)。 */
function formatDate_(d) {
  return d.getFullYear() + '/' + pad2_(d.getMonth() + 1) + '/' + pad2_(d.getDate());
}

function pad2_(n) {
  return (n < 10 ? '0' : '') + n;
}

/* ===================== マスタ参照ヘルパー ===================== */

function getWorkMetaMap_() {
  const ss = SpreadsheetApp.openById(getDailyReportSsId_());
  const rows = ss.getSheetByName(SHEET_NAMES.WORKCONTENT).getDataRange().getValues();
  const map = {};
  for (let i = 1; i < rows.length; i++) {
    if (!rows[i][0]) continue;
    map[rows[i][0]] = { name: rows[i][1], dept: rows[i][2] };
  }
  return map;
}

function getConstructionLabel_(id) {
  const ss = SpreadsheetApp.openById(getDailyReportSsId_());
  const rows = ss.getSheetByName(SHEET_NAMES.CONSTRUCTION).getDataRange().getValues();
  for (let i = 1; i < rows.length; i++) {
    if (rows[i][0] === id) return rows[i][2];
  }
  return id;
}

/* 工事No(並び替え用)と工事名(表示用、工事Noは表示しない)を工事IDから引くマップ */
function getConstructionMap_() {
  const ss = SpreadsheetApp.openById(getDailyReportSsId_());
  const rows = ss.getSheetByName(SHEET_NAMES.CONSTRUCTION).getDataRange().getValues();
  const map = {};
  for (let i = 1; i < rows.length; i++) {
    if (!rows[i][0]) continue;
    map[rows[i][0]] = { no: rows[i][1], name: rows[i][2] };
  }
  return map;
}

function getOperatorLabel_(no) {
  const ss = SpreadsheetApp.openById(getDailyReportSsId_());
  const rows = ss.getSheetByName(SHEET_NAMES.OPERATOR).getDataRange().getValues();
  for (let i = 1; i < rows.length; i++) {
    if (String(rows[i][0]) === String(no)) return rows[i][1];
  }
  return no;
}

/* ===================== 集計1: 工事別 作業内容集計 ===================== */

function generateReport1(params) {
  const t0 = new Date();
  // フィルタ・集計はクライアント側(プレビュー描画時点)で既に済んでおり、
  // その結果をそのまま受け取る。DailyReport全件の再読み込み・再フィルタは行わない。
  const filtered = params.rows || [];
  const periodInfo = getPeriodInfo_(params);

  const workMeta = getWorkMetaMap_();
  const constructionLabel = getConstructionLabel_(params.constructionId);
  const fileTarget = constructionLabel.replace(/[\s　]/g, '');
  const fileName = '工事別集計_' + fileTarget + '_' + periodInfo.range + '_' + today_() + '.xlsx';

  let locs;
  if (params.locSpec === 'yes' && params.locs && params.locs.length) {
    locs = params.locs;
  } else {
    const present = {};
    filtered.forEach(function (r) { present[r.factory] = true; });
    locs = Object.keys(present).sort(function (a, b) {
      return (LOCATION_ORDER[a] === undefined ? 99 : LOCATION_ORDER[a]) -
        (LOCATION_ORDER[b] === undefined ? 99 : LOCATION_ORDER[b]);
    });
  }

  Logger.log('generateReport1: 集計処理(クライアントから受信済みデータの整形) ' + (new Date() - t0) + 'ms');
  const ss = SpreadsheetApp.create('tmp_' + fileName);
  let firstSheet = true;

  locs.forEach(function (loc) {
    const locRows = filtered.filter(function (r) { return r.factory === loc; });
    const sums = {};
    locRows.forEach(function (r) { sums[r.workCode] = (sums[r.workCode] || 0) + r.hours; });
    const codes = Object.keys(sums).sort();
    const factoryCodes = [], officeCodes = [];
    codes.forEach(function (code) {
      const dept = workMeta[code] ? workMeta[code].dept : '';
      if (dept === '工場') factoryCodes.push(code); else officeCodes.push(code);
    });

    const sheet = firstSheet ? ss.getSheets()[0] : ss.insertSheet();
    firstSheet = false;
    sheet.setName(loc);

    const dataRows = [];
    let grand = 0;
    if (factoryCodes.length) {
      let fTotal = 0;
      factoryCodes.forEach(function (code) {
        const v = sums[code]; fTotal += v;
        dataRows.push({ row: [(workMeta[code] && workMeta[code].name) || code, v], style: 'factory' });
      });
      dataRows.push({ row: ['工場 小計', fTotal], style: 'factoryTotal' });
      grand += fTotal;
    }
    if (officeCodes.length) {
      let oTotal = 0;
      officeCodes.forEach(function (code) {
        const v = sums[code]; oTotal += v;
        dataRows.push({ row: [(workMeta[code] && workMeta[code].name) || code, v], style: 'office' });
      });
      dataRows.push({ row: ['事務 小計', oTotal], style: 'officeTotal' });
      grand += oTotal;
    }
    dataRows.push({ row: ['総合計', grand], style: 'grand' });

    sheet.getRange(1, 1, 1, 2).setValues([['作業内容', '合計時間']]);
    sheet.getRange(2, 1, dataRows.length, 2).setValues(dataRows.map(function (d) { return d.row; }));
    styleReport1Sheet_(sheet, dataRows);
  });
  Logger.log('generateReport1: シート作成・書き込み完了 ' + (new Date() - t0) + 'ms');

  return exportAndCleanup_(ss, fileName, t0);
}

/* ===================== 集計2: 個人別 作業内容集計 ===================== */

function generateReport2(params) {
  const t0 = new Date();
  // フィルタ・集計はクライアント側(プレビュー描画時点)で既に済んでおり、
  // その結果をそのまま受け取る。DailyReport全件の再読み込み・再フィルタは行わない。
  const filtered = (params.rows || []).slice();
  filtered.sort(function (a, b) { return toDate_(a.workDate) - toDate_(b.workDate); });
  const periodInfo = getPeriodInfo_(params);

  const opName = getOperatorLabel_(params.operatorNo);
  const fileTarget = opName.replace(/[\s　]/g, '');
  const fileName = '個人集計_' + fileTarget + '_' + periodInfo.range + '_' + today_() + '.xlsx';

  const ss = SpreadsheetApp.create('tmp_' + fileName);
  const sheet = ss.getSheets()[0];
  sheet.setName('明細');

  const workMeta = getWorkMetaMap_();
  const constructionMap = getConstructionMap_();
  const header = ['作業日', '工事', '作業内容', '時間'];
  let total = 0;
  const dataRows = filtered.map(function (r) {
    total += r.hours;
    return [
      formatDate_(toDate_(r.workDate)),
      (constructionMap[r.constructionId] && constructionMap[r.constructionId].name) || r.constructionId,
      (workMeta[r.workCode] && workMeta[r.workCode].name) || r.workCode,
      r.hours
    ];
  });
  dataRows.push(['合計', '', '', total]);

  sheet.getRange(1, 1, 1, 4).setValues([header]);
  if (dataRows.length) sheet.getRange(2, 1, dataRows.length, 4).setValues(dataRows);
  if (dataRows.length) {
    sheet.getRange(1 + dataRows.length, 1, 1, 3).merge();
  }
  styleSimpleTable_(sheet, 4, dataRows.length);
  Logger.log('generateReport2: シート作成・書き込み完了 ' + (new Date() - t0) + 'ms');

  return exportAndCleanup_(ss, fileName, t0);
}

/* ===================== 集計3: 20日〆集計(拠点別・工事×作業内容クロス集計) ===================== */

function generateReport3(params) {
  const t0 = new Date();
  const year = Number(params.year), month = Number(params.month);
  const range = closingRange_(year, month);
  const rangeToken = formatDate_(range.start) + '-' + formatDateEnd_(range);
  const locs = params.locs || [];

  // 期間絞り込みはクライアント側(プレビュー描画時点)で既に済んでおり、
  // その結果をそのまま受け取る。DailyReport全件の再読み込み・再フィルタは行わない。
  const rows = params.rows || [];

  const workMeta = getWorkMetaMap_();
  const constructionMap = getConstructionMap_();
  const fileName = '20日締め集計_' + locs.join('+') + '_' + rangeToken + '_' + today_() + '.xlsx';
  const ss = SpreadsheetApp.create('tmp_' + fileName);
  let firstSheet = true;

  locs.forEach(function (loc) {
    const locRows = rows.filter(function (r) { return r.factory === loc; });

    const byConstruction = {};
    const order = [];
    locRows.forEach(function (r) {
      if (!byConstruction[r.constructionId]) {
        byConstruction[r.constructionId] = {
          name: (constructionMap[r.constructionId] && constructionMap[r.constructionId].name) || r.constructionId,
          codes: {}
        };
        order.push(r.constructionId);
      }
      const c = byConstruction[r.constructionId];
      c.codes[r.workCode] = (c.codes[r.workCode] || 0) + r.hours;
    });
    order.sort(function (a, b) {
      const noA = (constructionMap[a] && constructionMap[a].no) || '';
      const noB = (constructionMap[b] && constructionMap[b].no) || '';
      return String(noA).localeCompare(String(noB), 'ja', { numeric: true });
    });

    const usedCodes = {};
    order.forEach(function (cid) {
      Object.keys(byConstruction[cid].codes).forEach(function (code) { usedCodes[code] = true; });
    });
    const factoryCodes = [], officeCodes = [];
    Object.keys(usedCodes).sort().forEach(function (code) {
      const dept = workMeta[code] ? workMeta[code].dept : '';
      if (dept === '工場') factoryCodes.push(code); else officeCodes.push(code);
    });

    const sheet = firstSheet ? ss.getSheets()[0] : ss.insertSheet();
    firstSheet = false;
    sheet.setName(loc);

    const header1 = ['工事']
      .concat(factoryCodes.map(function () { return '工場'; }))
      .concat(['工場'])
      .concat(officeCodes.map(function () { return '事務'; }))
      .concat(['事務', '総合計']);
    const header2 = ['工事']
      .concat(factoryCodes.map(function (c) { return (workMeta[c] && workMeta[c].name) || c; }))
      .concat(['工場合計'])
      .concat(officeCodes.map(function (c) { return (workMeta[c] && workMeta[c].name) || c; }))
      .concat(['事務合計', '総合計']);
    const totalCols = header2.length;

    const colTotals = {};
    factoryCodes.concat(officeCodes).forEach(function (c) { colTotals[c] = 0; });
    let grandFactoryTotal = 0, grandOfficeTotal = 0;

    const dataRows = order.map(function (cid) {
      const c = byConstruction[cid];
      const row = [c.name];
      let fTotal = 0, oTotal = 0;
      factoryCodes.forEach(function (code) {
        const v = c.codes[code] || 0;
        row.push(v); fTotal += v; colTotals[code] += v;
      });
      row.push(fTotal);
      officeCodes.forEach(function (code) {
        const v = c.codes[code] || 0;
        row.push(v); oTotal += v; colTotals[code] += v;
      });
      row.push(oTotal);
      row.push(fTotal + oTotal);
      grandFactoryTotal += fTotal; grandOfficeTotal += oTotal;
      return row;
    });

    const totalRow = ['合計'];
    factoryCodes.forEach(function (code) { totalRow.push(colTotals[code]); });
    totalRow.push(grandFactoryTotal);
    officeCodes.forEach(function (code) { totalRow.push(colTotals[code]); });
    totalRow.push(grandOfficeTotal);
    totalRow.push(grandFactoryTotal + grandOfficeTotal);
    dataRows.push(totalRow);

    sheet.getRange(1, 1, 1, totalCols).setValues([header1]);
    sheet.getRange(2, 1, 1, totalCols).setValues([header2]);
    if (dataRows.length) sheet.getRange(3, 1, dataRows.length, totalCols).setValues(dataRows);

    styleReport3Sheet_(sheet, factoryCodes.length, officeCodes.length, dataRows.length);
  });
  Logger.log('generateReport3: シート作成・書き込み完了 ' + (new Date() - t0) + 'ms');

  return exportAndCleanup_(ss, fileName, t0);
}

/* ===================== 集計④: 日報入力チェック ===================== */

/* 拠点(本社/夢前/鳥取)ごとに別シート、シート内は部署(事務/工場)ごとに見出し・小計、
   最後に拠点合計行。各行の右端に期間合計列を持つ。 */
function generateReport4(params) {
  const t0 = new Date();
  const dateHeaders = params.dateHeaders || [];
  const rows = params.rows || [];
  const fileName = '日報入力チェック_' + params.rangeToken + '_' + today_() + '.xlsx';
  const n = dateHeaders.length;

  const ss = SpreadsheetApp.create('tmp_' + fileName);
  let firstSheet = true;
  const deptOrder = [{ key: '設計管理', label: '事務' }, { key: '工場', label: '工場' }];

  Object.keys(LOCATION_ORDER).sort(function (a, b) {
    return LOCATION_ORDER[a] - LOCATION_ORDER[b];
  }).forEach(function (loc) {
    const locRows = rows.filter(function (r) { return r.factory === loc; });
    if (locRows.length === 0) return;

    const deptGroups = [];
    deptOrder.forEach(function (d) {
      const dRows = locRows.filter(function (r) { return r.dept === d.key; });
      if (dRows.length === 0) return;
      const subtotalCells = zeroArray4_(n);
      dRows.forEach(function (r) {
        r.cells.forEach(function (c, i) { subtotalCells[i] += (c.value || 0); });
      });
      const subtotalTotal = subtotalCells.reduce(function (s, v) { return s + v; }, 0);
      deptGroups.push({ label: d.label, key: d.key, rows: dRows, subtotalCells: subtotalCells, subtotalTotal: subtotalTotal });
    });
    if (deptGroups.length === 0) return;

    const locCells = zeroArray4_(n);
    deptGroups.forEach(function (g) { g.subtotalCells.forEach(function (v, i) { locCells[i] += v; }); });
    const locTotal = locCells.reduce(function (s, v) { return s + v; }, 0);

    const sheet = firstSheet ? ss.getSheets()[0] : ss.insertSheet();
    firstSheet = false;
    sheet.setName(loc);
    writeReport4Sheet_(sheet, dateHeaders, deptGroups, locCells, locTotal);
  });

  Logger.log('generateReport4: シート作成・書き込み完了 ' + (new Date() - t0) + 'ms');
  return exportAndCleanup_(ss, fileName, t0);
}

function zeroArray4_(n) {
  const a = [];
  for (let i = 0; i < n; i++) a.push(0);
  return a;
}

function writeReport4Sheet_(sheet, dateHeaders, deptGroups, locCells, locTotal) {
  const totalCols = 2 + dateHeaders.length; /* 氏名 + 日付 + 合計 */
  const header1 = [''].concat(dateHeaders.map(function (d) { return d.holiday ? '休日' : '出勤'; })).concat(['']);
  const header2 = ['氏名'].concat(dateHeaders.map(function (d) { return d.shortDate; })).concat(['合計']);
  const header3 = [''].concat(dateHeaders.map(function (d) { return d.weekday; })).concat(['']);
  sheet.getRange(1, 1, 1, totalCols).setValues([header1]);
  sheet.getRange(2, 1, 1, totalCols).setValues([header2]);
  sheet.getRange(3, 1, 1, totalCols).setValues([header3]);
  sheet.getRange(1, 1, 3, 1).merge();
  sheet.getRange(1, totalCols, 3, 1).merge();
  if (dateHeaders.length) sheet.getRange(2, 2, 2, dateHeaders.length).setHorizontalAlignment('center');

  let row = 4;
  const flagged = [];
  const deptHeadRows = [];
  const subtotalRows = [];

  deptGroups.forEach(function (g) {
    sheet.getRange(row, 1, 1, totalCols).merge();
    sheet.getRange(row, 1).setValue(g.label);
    deptHeadRows.push(row);
    row++;

    g.rows.forEach(function (r) {
      const vals = [r.name].concat(r.cells.map(function (c) { return c.text ? c.text : (c.value === null ? '' : c.value); })).concat([r.total || '']);
      sheet.getRange(row, 1, 1, totalCols).setValues([vals]);
      r.cells.forEach(function (c, ci) {
        if (!c.flag) return;
        flagged.push({ row: row, col: 2 + ci, flag: c.flag });
      });
      row++;
    });

    const subVals = [g.label + ' 小計'].concat(g.subtotalCells.map(function (v) { return v || ''; })).concat([g.subtotalTotal || '']);
    sheet.getRange(row, 1, 1, totalCols).setValues([subVals]);
    subtotalRows.push({ row: row, key: g.key });
    row++;
  });

  const locVals = ['拠点 合計'].concat(locCells.map(function (v) { return v || ''; })).concat([locTotal || '']);
  sheet.getRange(row, 1, 1, totalCols).setValues([locVals]);
  const locTotalRow = row;

  const totalRows = row;
  sheet.getRange(1, 1, totalRows, totalCols).setBorder(true, true, true, true, true, true);
  sheet.getRange(1, 1, 3, totalCols).setFontWeight('bold').setBackground('#f5f7fa');
  /* 合計列(右端)のベース色。見出し・小計・拠点合計行は下の処理で上書きされる */
  sheet.getRange(4, totalCols, totalRows - 3, 1).setBackground('#f5f5f5').setFontWeight('bold');

  dateHeaders.forEach(function (d, i) {
    if (d.holiday) sheet.getRange(1, 2 + i, 3, 1).setBackground('#f4cccc');
  });

  flagged.forEach(function (f) {
    const range = sheet.getRange(f.row, f.col, 1, 1);
    if (f.flag === 'missing') range.setBackground('#ff0000');
    else if (f.flag === 'duplicate') range.setBackground('#f9cb9c');
    else if (f.flag === 'long') range.setBackground('#ffff00').setFontColor('#ff0000').setFontWeight('bold');
    else if (f.flag === 'leave') range.setBackground('#fff9c4');
  });

  deptHeadRows.forEach(function (r) {
    sheet.getRange(r, 1, 1, totalCols).setFontWeight('bold').setBackground('#f5f7fa').setFontColor('#555');
  });

  subtotalRows.forEach(function (s) {
    const bg = s.key === '設計管理' ? '#bfe6c9' : '#bfe0f7';
    sheet.getRange(s.row, 1, 1, totalCols).setFontWeight('bold').setBackground(bg);
  });

  sheet.getRange(locTotalRow, 1, 1, totalCols).setFontWeight('bold').setBackground('#eee');

  /* 休日の列は、部署見出し・小計・拠点合計の行でも休日色を優先する。
     直前の行全体への背景設定を上書きする必要があるため、この処理は
     必ず最後に実行する(ブラウザプレビュー側■24と同じ考え方)。 */
  dateHeaders.forEach(function (d, i) {
    if (!d.holiday) return;
    const col = 2 + i;
    deptHeadRows.forEach(function (r) { sheet.getRange(r, col, 1, 1).setBackground('#f4cccc'); });
    subtotalRows.forEach(function (s) { sheet.getRange(s.row, col, 1, 1).setBackground('#f4cccc'); });
    sheet.getRange(locTotalRow, col, 1, 1).setBackground('#f4cccc');
  });

  sheet.autoResizeColumns(1, totalCols);
}

/* ===================== 見た目(罫線・色分け) ===================== */

function styleSimpleTable_(sheet, numCols, dataRowCount) {
  const totalRows = dataRowCount + 1;
  sheet.getRange(1, 1, totalRows, numCols).setBorder(true, true, true, true, true, true);
  sheet.getRange(1, 1, 1, numCols).setFontWeight('bold').setBackground('#f5f7fa');
  if (dataRowCount > 0) {
    sheet.getRange(1 + dataRowCount, 1, 1, numCols).setFontWeight('bold').setBackground('#f7f9fc');
  }
  sheet.autoResizeColumns(1, numCols);
}

function styleReport1Sheet_(sheet, dataRows) {
  const totalRows = 1 + dataRows.length;
  sheet.getRange(1, 1, totalRows, 2).setBorder(true, true, true, true, true, true);
  sheet.getRange(1, 1, 1, 2).setFontWeight('bold').setBackground('#f5f7fa');

  const colors = {
    factory: '#dceefc',
    factoryTotal: '#bfe0f7',
    office: '#e1f5e6',
    officeTotal: '#bfe6c9',
    grand: '#f7f9fc'
  };
  const bold = { factoryTotal: true, officeTotal: true, grand: true };
  dataRows.forEach(function (d, i) {
    const range = sheet.getRange(2 + i, 1, 1, 2);
    range.setBackground(colors[d.style]);
    if (bold[d.style]) range.setFontWeight('bold');
  });
  sheet.autoResizeColumns(1, 2);
}

function styleReport3Sheet_(sheet, factoryCount, officeCount, dataRowCount) {
  const totalCols = 1 + factoryCount + 1 + officeCount + 1 + 1;
  const totalRows = 2 + dataRowCount;

  sheet.getRange(1, 1, totalRows, totalCols).setBorder(true, true, true, true, true, true);
  sheet.getRange(1, 1, 2, 1).merge().setFontWeight('bold').setBackground('#f5f7fa');

  const factoryGroupCols = factoryCount + 1;
  sheet.getRange(1, 2, 1, factoryGroupCols).merge().setFontWeight('bold').setBackground('#dceefc');

  const officeStartCol = 2 + factoryGroupCols;
  const officeGroupCols = officeCount + 1;
  sheet.getRange(1, officeStartCol, 1, officeGroupCols).merge().setFontWeight('bold').setBackground('#e1f5e6');

  const grandCol = officeStartCol + officeGroupCols;
  sheet.getRange(1, grandCol, 2, 1).merge().setFontWeight('bold').setBackground('#eeeeee');

  if (factoryCount > 0) sheet.getRange(2, 2, 1, factoryCount).setBackground('#dceefc');
  sheet.getRange(2, 2 + factoryCount, 1, 1).setBackground('#bfe0f7').setFontWeight('bold');
  if (officeCount > 0) sheet.getRange(2, officeStartCol, 1, officeCount).setBackground('#e1f5e6');
  sheet.getRange(2, officeStartCol + officeCount, 1, 1).setBackground('#bfe6c9').setFontWeight('bold');

  if (dataRowCount > 0) {
    const dataStartRow = 3;
    if (factoryCount > 0) sheet.getRange(dataStartRow, 2, dataRowCount, factoryCount).setBackground('#dceefc');
    sheet.getRange(dataStartRow, 2 + factoryCount, dataRowCount, 1).setBackground('#bfe0f7');
    if (officeCount > 0) sheet.getRange(dataStartRow, officeStartCol, dataRowCount, officeCount).setBackground('#e1f5e6');
    sheet.getRange(dataStartRow, officeStartCol + officeCount, dataRowCount, 1).setBackground('#bfe6c9');
    sheet.getRange(dataStartRow, grandCol, dataRowCount, 1).setBackground('#eeeeee');
    sheet.getRange(dataStartRow + dataRowCount - 1, 1, 1, totalCols).setFontWeight('bold');
  }
  sheet.autoResizeColumns(1, totalCols);
}

/* ===================== Excel書き出し ===================== */

/* t0: 呼び出し元(generateReportN)の開始時刻(任意)。処理時間の内訳をログに残すための計測用。 */
function exportAndCleanup_(ss, fileName, t0) {
  const tExportStart = new Date();
  SpreadsheetApp.flush();
  const id = ss.getId();
  const url = 'https://docs.google.com/spreadsheets/d/' + id + '/export?format=xlsx';
  const token = ScriptApp.getOAuthToken();
  const response = UrlFetchApp.fetch(url, { headers: { Authorization: 'Bearer ' + token } });
  const blob = response.getBlob().setName(fileName);
  const base64 = Utilities.base64Encode(blob.getBytes());
  archiveReportSheets_(ss, fileName);
  DriveApp.getFileById(id).setTrashed(true);
  Logger.log('exportAndCleanup_: flush~export~trash ' + (new Date() - tExportStart) + 'ms' +
    (t0 ? ' / 開始からの合計 ' + (new Date() - t0) + 'ms' : ''));
  return { fileName: fileName, base64: base64, mimeType: blob.getContentType() };
}

/* ===================== ダウンロード内容を管理用スプレッドシートにアーカイブ ===================== */

const ARCHIVE_SHEET_LIMIT = 20;

/* ダウンロードされたExcelと同じ内容(一時スプレッドシートssの全シート)を、
   管理用スプレッドシート(自分自身)の最も右側にコピーして保存する。
   シート数(「情報」「記録」を含む合計)がARCHIVE_SHEET_LIMITを超えたら、
   「情報」「記録」以外で最も古い(左側の)シートから順に削除する。 */
function archiveReportSheets_(ss, fileName) {
  const target = SpreadsheetApp.getActive();
  const baseName = fileName.replace('.xlsx', '');
  ss.getSheets().forEach(function (sheet) {
    const copied = sheet.copyTo(target);
    copied.setName(uniqueSheetName_(target, baseName + '_' + sheet.getName()));
    target.setActiveSheet(copied);
    target.moveActiveSheet(target.getNumSheets());
  });
  pruneOldArchiveSheets_(target);
}

/* シート名の重複(同日に同じ集計を再ダウンロードした場合等)を避けるため、
   既存名と衝突したら末尾に" (2)"のように連番を付ける。100文字制限も考慮する。 */
function uniqueSheetName_(target, baseName) {
  const existing = {};
  target.getSheets().forEach(function (s) { existing[s.getName()] = true; });
  let name = baseName.slice(0, 100);
  let i = 1;
  while (existing[name]) {
    i++;
    const suffix = ' (' + i + ')';
    name = baseName.slice(0, 100 - suffix.length) + suffix;
  }
  return name;
}

function pruneOldArchiveSheets_(target) {
  while (target.getSheets().length > ARCHIVE_SHEET_LIMIT) {
    const victim = target.getSheets().find(function (s) {
      return s.getName() !== INFO_SHEET_NAME && s.getName() !== RECORD_SHEET_NAME;
    });
    if (!victim) break; // 保護対象しか残っていなければ打ち切る(無限ループ防止)
    target.deleteSheet(victim);
  }
}

/* =====================================================================
 * ここから下は「日報全期間集計」(GitHub Pages版)専用の追加分。
 * 2026-08-31のセッションで追加。上記の既存コードは一切変更していない
 * (既存のGAS Webアプリ・google.script.run関数群への影響はゼロ)。
 *
 * 【デプロイについて重要】
 * このdoPost(e)は、既存のGAS Webアプリのデプロイとは【別の新規デプロイ】
 * として公開すること。既存デプロイ(_gas/Index.html用、executeAs:USER_ACCESSING)
 * はそのまま残し、「デプロイを管理」から追加デプロイを作成し、そちらだけ
 * executeAs: USER_DEPLOYING にする(GitHub Pagesからの匿名fetchに対応するため)。
 * 新規デプロイのURLをdaily-report/app.js先頭のGAS_API_URL定数に設定すること。
 *
 * 【「情報」シートの複数ファイル対応】
 * 「情報」シートには現在、以下の3行が登録されている想定:
 *   DailyReport                     (現行。直近数か月分のみ、他と重複しない)
 *   DailyReport_DATA{年}.11.21以降  (アーカイブ。{年}/11/21〜{年+2}/11/20の2年分)
 * アーカイブは年1回追加され、隣接するアーカイブ同士は1年分重複する。
 * 重複区間は開始年が新しい方のアーカイブを優先して採用する。
 * ============================================================== */

/* ファイル名"DailyReport_DATA{年}.11.21以降"から年を機械的に抽出する正規表現。
   「情報」シートへ開始日・終了日の列を追加する方式は取らず、ファイル名から
   都度パースする方式で運用する(ヒアリングで確定)。 */
const ARCHIVE_NAME_RE_ = /^DailyReport_DATA(\d{4})\.11\.21以降$/;

/* 「情報」シートの全行を「現行(current)」と「アーカイブ(archives、開始年の昇順)」に分類する。
   currentが見つからない場合はDAILY_REPORT_SS_ID_FALLBACKにフォールバックする
   (既存のgetDailyReportSsId_と同じ考え方)。 */
function classifyInfoFiles_() {
  const rows = getInfoRows_();
  let current = null;
  const archives = [];
  for (let i = 1; i < rows.length; i++) {
    const name = String(rows[i][0] || '').trim();
    const id = String(rows[i][1] || '').trim();
    if (!name || !id) continue;
    if (name === SHEET_NAMES.DAILY_REPORT) {
      current = { id: id };
      continue;
    }
    const m = name.match(ARCHIVE_NAME_RE_);
    if (m) {
      const startYear = Number(m[1]);
      archives.push({
        id: id,
        startYear: startYear,
        start: new Date(startYear, 10, 21, 0, 0, 0),
        end: new Date(startYear + 2, 10, 20, 23, 59, 59)
      });
    }
  }
  archives.sort(function (a, b) { return a.startYear - b.startYear; });
  if (!current) current = { id: DAILY_REPORT_SS_ID_FALLBACK };
  return { current: current, archives: archives };
}

/* 指定したスプレッドシートIDのDailyReportシートを読み込む(loadDailyReportRows_の
   複数ファイル対応版。既存のloadDailyReportRows_は無改変のため、ここでは
   同じロジックをssId引数付きで別関数として持つ)。
   【重要】workDateはこの時点で'yyyy/MM/dd'の文字列に正規化しておく(Dateオブジェクトの
   ままにしない)。アーカイブ側はloadArchiveRowsCached_でJSONキャッシュに保存されるが、
   JSON.stringifyはDateオブジェクトをISO文字列(例: '2024-11-21T00:00:00.000Z')に
   変換してしまい、キャッシュ読み込み後にtoDate_で正しく再解釈できず日付がNaNになる
   不具合があったため(実データで確認済み)。読み込み時点で文字列化しておけば、
   新規読み込み・キャッシュ経由のどちらでも同じ形式になり、この問題が起きない。 */
function loadDailyReportRowsFromSs_(ssId) {
  const ss = SpreadsheetApp.openById(ssId);
  const values = ss.getSheetByName(SHEET_NAMES.DAILY_REPORT).getDataRange().getValues();
  const rows = [];
  for (let i = 1; i < values.length; i++) {
    const r = values[i];
    if (!r[0]) continue;
    const factory = r[1], dept = r[2], operatorNo = String(r[4]);
    const workDateObj = toDate_(r[5]);
    if (!workDateObj) continue;
    const workDate = formatDate_(workDateObj);
    for (let slot = 0; slot < 5; slot++) {
      const off = 6 + slot * 4;
      const constructionId = r[off];
      const hours = r[off + 3];
      if (!constructionId || !hours) continue;
      rows.push({
        operatorNo: operatorNo,
        factory: factory,
        dept: dept,
        workDate: workDate,
        constructionId: constructionId,
        workCode: r[off + 2],
        hours: Number(hours) || 0
      });
    }
  }
  return rows;
}

/* ===================== アーカイブ読み込みキャッシュ ===================== */
/* アーカイブファイルは月次で追記される程度でほとんど更新されないため、
   最終更新日時をキーにキャッシュし、更新日時が変わっていなければ
   再読み込みをスキップする(production-managementアプリの
   _records_cache.json方式を流用)。キャッシュは管理用スプレッドシートと
   同じDriveフォルダにJSONファイルとして保存する(CacheService/
   PropertiesServiceはサイズ上限が小さく、数万行規模のデータには
   使えないため)。 */

const ARCHIVE_CACHE_FILE_NAME_ = '_daily_report_archive_cache.json';
/* キャッシュの中身の形式が変わった場合に、保存済みの古い形式のキャッシュを
   自動的に無効化するためのバージョン番号。2: workDateを文字列正規化する
   修正を入れた際に、それ以前(バージョン番号なし)に書き込まれた壊れたキャッシュ
   (日付がJSON化でISO文字列になり読み戻せなくなっていたもの)を破棄するために導入。 */
const ARCHIVE_CACHE_VERSION_ = 2;

function getContainerFolder_() {
  return DriveApp.getFileById(SpreadsheetApp.getActive().getId()).getParents().next();
}

function getOrCreateArchiveCacheFile_() {
  const folder = getContainerFolder_();
  const it = folder.getFilesByName(ARCHIVE_CACHE_FILE_NAME_);
  if (it.hasNext()) return it.next();
  return folder.createFile(ARCHIVE_CACHE_FILE_NAME_, '{}', MimeType.PLAIN_TEXT);
}

function readArchiveCache_() {
  try {
    const file = getOrCreateArchiveCacheFile_();
    const text = file.getBlob().getDataAsString();
    const parsed = JSON.parse(text || '{}');
    if (parsed.version !== ARCHIVE_CACHE_VERSION_) return { version: ARCHIVE_CACHE_VERSION_, files: {} };
    return parsed;
  } catch (e) {
    return { version: ARCHIVE_CACHE_VERSION_, files: {} };
  }
}

function writeArchiveCache_(cache) {
  const file = getOrCreateArchiveCacheFile_();
  file.setContent(JSON.stringify(cache));
}

/* アーカイブ1ファイル分のDailyReport行を、最終更新日時ベースのキャッシュ経由で取得する。 */
function loadArchiveRowsCached_(fileId) {
  const cache = readArchiveCache_();
  const modifiedTime = DriveApp.getFileById(fileId).getLastUpdated().getTime();
  const cached = cache.files[fileId];
  if (cached && cached.modifiedTime === modifiedTime) {
    return cached.rows;
  }
  const rows = loadDailyReportRowsFromSs_(fileId);
  cache.files[fileId] = { modifiedTime: modifiedTime, rows: rows };
  writeArchiveCache_(cache);
  return rows;
}

/* ===================== 複数ファイルのマージ・重複排除 ===================== */

/* アーカイブ(開始年の古い順)+現行DailyReportをマージし、重複区間は
   開始年が新しい方のアーカイブを優先する。具体的には、各アーカイブについて
   「次に新しいアーカイブの開始日」より前の行だけを採用する(=新しい方の
   アーカイブの担当区間に入った時点で、古い方は譲る)。現行DailyReportは
   他のファイルと重複しない前提のため無条件に全件採用する。 */
function getMergedDailyReportRows_() {
  const info = classifyInfoFiles_();
  const archives = info.archives; // startYear昇順
  let merged = [];

  for (let i = 0; i < archives.length; i++) {
    const archive = archives[i];
    const nextStart = (i + 1 < archives.length) ? archives[i + 1].start : null;
    const rows = loadArchiveRowsCached_(archive.id);
    rows.forEach(function (r) {
      const d = toDate_(r.workDate);
      if (!d) return;
      if (d < archive.start || d > archive.end) return; // 担当区間外は無視(安全策)
      if (nextStart && d >= nextStart) return; // より新しいアーカイブの担当区間に入ったら譲る
      merged.push(r);
    });
  }

  merged = merged.concat(loadDailyReportRowsFromSs_(info.current.id));
  return merged;
}

/* getAllDailyReportRows()の複数ファイル対応版。既存のgetAllDailyReportRows()は
   無改変のまま残し、新API(doPost)からはこちらを使う。 */
function getAllDailyReportRowsMerged_() {
  return getMergedDailyReportRows_().map(function (r) {
    return {
      operatorNo: r.operatorNo,
      factory: r.factory,
      dept: r.dept,
      workDate: formatDate_(toDate_(r.workDate)),
      constructionId: r.constructionId,
      workCode: r.workCode,
      hours: r.hours
    };
  });
}

/* getMasterData()の複数ファイル対応版フロントエンド向け拡張。既存のgetMasterData()は
   無改変のまま残し、新API(doPost)からはこちらを使う。社員マスタの「Reportcheck」列
   (row[8])は実データ上「在職中」「退職済」「休職中」以外に役職名(「専務」等)が
   入るケースがあることが分かったため、日報入力チェック(④)で「在職中のみ表示する」
   判定に使えるよう、真偽値active(row[8]==='在職中')を追加で持たせる。
   また、日報入力チェックの締め月選択リストの下限を決めるため、現在登録されている
   アーカイブのうち最も開始年が古いもの(earliestArchiveYear)も返す。ハードコードせず
   「情報」シートの実際の登録内容から都度求めることで、将来アーカイブが入れ替わっても
   自動的に選択範囲が追従する。 */
function getMasterDataWithStatus_() {
  const master = getMasterData();
  const ss = SpreadsheetApp.openById(getDailyReportSsId_());
  const opRows = ss.getSheetByName(SHEET_NAMES.OPERATOR).getDataRange().getValues();
  const activeByNo = {};
  for (let i = 1; i < opRows.length; i++) {
    if (!opRows[i][0]) continue;
    activeByNo[String(opRows[i][0])] = opRows[i][8] === '在職中';
  }
  master.operators.forEach(function (o) { o.active = !!activeByNo[o.no]; });

  const info = classifyInfoFiles_();
  let earliestArchiveYear = null;
  info.archives.forEach(function (a) {
    if (earliestArchiveYear === null || a.startYear < earliestArchiveYear) earliestArchiveYear = a.startYear;
  });
  master.earliestArchiveYear = earliestArchiveYear;
  return master;
}

/* ===================== JSON API(GitHub Pages版フロントエンド用) ===================== */
/* CORSプリフライト(OPTIONS)はGASが対応していないため、フロントエンド側は
   必ず Content-Type: text/plain でPOSTすること(hot-heart等、他アプリと同じ方式)。
   GETは使わない(既存のdoGet(e)はHTML(index.html)を返す処理のまま一切変更しないため、
   新APIはdoPostのみで完結させる)。 */

function apiJsonOk_(data) {
  return ContentService
    .createTextOutput(JSON.stringify({ status: 'success', data: data }))
    .setMimeType(ContentService.MimeType.JSON);
}

/* logFactorySelection()(既存・無改変)の呼び出しをLockService.getScriptLock()で
   排他制御する。appendRowは「最終行を調べて次に書く」処理を内部でロックなしに
   行っており、複数人がほぼ同時にログインすると記録シートに空行ができたり
   行がズレたりする不具合が実データで確認されたため追加(ユーザー報告)。
   LockService.getScriptLock()はスクリプトプロジェクト単位でロックするため、
   新API(doPost)経由の同時アクセス同士を正しく直列化できる。既存の
   logFactorySelection()自体は無改変のまま。 */
function logFactorySelectionLocked_(factory) {
  const lock = LockService.getScriptLock();
  lock.waitLock(10000);
  try {
    return logFactorySelection(factory);
  } finally {
    lock.releaseLock();
  }
}

function apiJsonErr_(message) {
  return ContentService
    .createTextOutput(JSON.stringify({ status: 'error', message: message }))
    .setMimeType(ContentService.MimeType.JSON);
}

/**
 * POSTリクエスト用(新規。既存のdoGetとは独立しており、既存の動作には影響しない)。
 * リクエストボディ(JSON文字列)の例: { "action": "getMasterData" }
 */
function doPost(e) {
  try {
    const body = JSON.parse(e.postData.contents);
    const action = body.action;
    const params = body.params || {};

    if (action === 'getMasterData') return apiJsonOk_(getMasterDataWithStatus_());
    if (action === 'getAllDailyReportRows') return apiJsonOk_(getAllDailyReportRowsMerged_());
    if (action === 'getCompanyCalendarData') return apiJsonOk_(getCompanyCalendarData());
    if (action === 'getAbsenteeismData') return apiJsonOk_(getAbsenteeismData());
    if (action === 'generateReport1') return apiJsonOk_(generateReport1(params));
    if (action === 'generateReport2') return apiJsonOk_(generateReport2(params));
    if (action === 'generateReport3') return apiJsonOk_(generateReport3(params));
    if (action === 'generateReport4') return apiJsonOk_(generateReport4(params));
    if (action === 'logFactorySelection') return apiJsonOk_({ row: logFactorySelectionLocked_(params.factory) });
    return apiJsonErr_('不明なaction: ' + action);
  } catch (err) {
    return apiJsonErr_(String(err && err.message || err));
  }
}
