/**
 * 「生産管理ダッシュボード」のGAS APIバックエンド。
 *
 * このスクリプトは、案件マスターの索引スプレッドシート(「Excelマスタ一覧」)の
 * 「拡張機能→Apps Script」から作成するコンテナバインド型スクリプトとして使う前提です。
 * SpreadsheetApp.getActiveSpreadsheet()で自分自身の索引スプレッドシートを参照するため、
 * SPREADSHEET_IDの設定は不要です。
 *
 * このアプリ本体(index.html / app.js)はフロントエンド(GitHub Pages)で、GASは
 * JSON APIのみを提供します(グラフ描画・表の組み立てはすべてブラウザ側で行います)。
 *
 * ■ 読み取り専用の原則
 *   各案件のマスターExcelファイルは常に「読み取り専用」で開きます。書き込みは一切行いません。
 *   xlsx→Googleスプレッドシート変換が必要な処理では、索引スプレッドシートと同じフォルダ内に
 *   作業用のスプレッドシートを作成(既存があれば内容を上書き)しますが、元のExcelファイル本体
 *   には一切触れません。索引スプレッドシート自体にも書き込みは行いません。
 *
 * ■ 前提となる索引スプレッドシートの構成(1枚目のシート。手動で用意されている想定):
 *   A列: ドライブ(ms-tottori / mst など。アプリのロジックでは使用しない、参考情報)
 *   B列: マスタNo
 *   C列: 工事番号(空、または"00-00"の行は無視する)
 *   D列: ファイル名
 *   E列: URL(案件マスターExcelファイルへのGoogleドライブ共有リンク)
 *   G列: 工事番号(工事番号→工事名の対応表)
 *   H列: 工事名
 *   I列: Date(会社カレンダー)
 *   J列: Holiday("出勤" or "休日")
 *   K列: 拠点名(本社/夢前/鳥取)
 *   L列: 目標日産量デフォルト(トン)
 *   いずれも1行目が見出し、2行目以降がデータです。
 *
 * ■ 案件マスターExcelファイルの列構成(各行=部材1つ):
 *   ...,部位,加工先,...,本数,重量,製品マーク,...,加工,... (列の並び順はファイルによって多少
 *   ずれるため、見出し行の文字列で列位置を特定する。詳細はMasterParser部分を参照)
 *   「加工」列の日付を基準に日次生産実績として集計する。「製品マーク」は工程表のセルを
 *   クリックした際の日別内訳ポップアップ(工事×部位×製品マーク×重量)にのみ使用する。
 *
 * セットアップ手順は README.md を参照してください。
 */

// ========== 設定 ==========

const IGNORE_WORK_NO = '00-00';
const MAIN_PARTS = ['柱', '大梁', '小梁'];
const OTHER_PART = '他';
const WEIGHT_ROW_KEY = '生産重量';
const CACHE_FILE_NAME = '_cache_dashboard.json';
const RECORDS_CACHE_FILE_NAME = '_records_cache.json';
// records(案件ごとの読み込み結果キャッシュ)の形式を変える際にインクリメントする。
// 保存済みキャッシュのバージョンがこれと違えば、mtimeが同じでも再解析する(古い形式の
// recordsを誤って使い回して、新しく追加したフィールドが欠けたまま表示されるのを防ぐ)。
const RECORDS_CACHE_VERSION = 2;
const WORK_COPY_PREFIX = '_作業用_';
const TIMEZONE = 'Asia/Tokyo';

// ========== エントリーポイント(JSON API) ==========

function doGet(e) {
  try {
    const action = (e && e.parameter && e.parameter.action) || 'getData';
    if (action === 'getData') return ok_(getDashboardData_());
    if (action === 'refresh') return ok_(refreshAndGetData_());
    return errRes_('不明なaction: ' + action);
  } catch (err) {
    return errRes_(err.message);
  }
}

function jsonResponse_(payload) {
  return ContentService.createTextOutput(JSON.stringify(payload)).setMimeType(ContentService.MimeType.JSON);
}
function ok_(data) { return jsonResponse_({ status: 'success', data: data }); }
function errRes_(message) { return jsonResponse_({ status: 'error', message: message }); }

// キャッシュがあればそれを返し、無ければ初回のみ集計する。
function getDashboardData_() {
  const folder = getCacheFolder_();
  const cached = loadCache_(folder);
  if (cached) return cached;
  return refreshAndGetData_(folder);
}

// 手動更新ボタン、および毎日の自動トリガー(dailyRefresh)から呼ばれる本体処理。
// 「現時点のデータを取得」が短時間に連打されたり、自動トリガーと手動更新が重なったりすると、
// ロックが無い場合はrunFullAggregation_が並行して複数走り、_cache_dashboard.json や
// _records_cache.jsonの読み書きが競合して同名ファイルが重複作成されることがある。
// スクリプトロックで直列化し、後発の呼び出しは先発の完了(=キャッシュ更新)を待ってから
// 実行する。
// folder: 呼び出し元(getDashboardData_)が既に取得済みのフォルダがあれば渡してもらい、
// DriveApp.getFileById(...).getParents()の呼び出し(ネットワーク往復)を1回省略する。
// 未指定(dailyRefresh等からの呼び出し)ならここで1回だけ取得する。
function refreshAndGetData_(folder) {
  const lock = LockService.getScriptLock();
  lock.waitLock(120000); // 先行する集計の完了を最大2分待つ
  try {
    const targetFolder = folder || getCacheFolder_();
    const data = runFullAggregation_(targetFolder);
    saveCache_(targetFolder, data);
    return data;
  } finally {
    lock.releaseLock();
  }
}

// 時間主導トリガー用のエントリーポイント。
function dailyRefresh() {
  refreshAndGetData_();
}

// Apps Scriptエディタから手動で1回実行して、毎日早朝の自動更新トリガーを設定する。
function createDailyTrigger() {
  ScriptApp.getProjectTriggers().forEach(function (t) {
    if (t.getHandlerFunction() === 'dailyRefresh') ScriptApp.deleteTrigger(t);
  });
  ScriptApp.newTrigger('dailyRefresh').timeBased().atHour(5).nearMinute(0).everyDays(1).create();
  Logger.log('毎日5:00頃に自動更新するトリガーを設定しました。');
}

// Apps Scriptエディタから手動で実行して、索引スプレッドシートの構成を確認する。
function checkSetup() {
  const rows = readIndexRows_();
  const idx = readFileIndex_(rows);
  const names = readWorkNameMap_(rows);
  const cal = readCalendar_(rows);
  const targets = readTargets_(rows);
  Logger.log('案件マスターファイル: ' + idx.length + '件(00-00は除外済み)');
  Logger.log('工事番号→工事名リスト: ' + Object.keys(names).length + '件');
  Logger.log('カレンダー日数: ' + Object.keys(cal).length + '件');
  Logger.log('目標値: ' + JSON.stringify(targets));
  const folder = getCacheFolder_();
  Logger.log('作業用ファイルの保存先フォルダ: ' + folder.getName() + ' (' + folder.getId() + ')');
}

// ========== 索引スプレッドシートの読み取り ==========

function ss_() { return SpreadsheetApp.getActiveSpreadsheet(); }
function indexSheet_() { return ss_().getSheets()[0]; }

function getCacheFolder_() {
  const file = DriveApp.getFileById(ss_().getId());
  const parents = file.getParents();
  return parents.hasNext() ? parents.next() : DriveApp.getRootFolder();
}

function extractFileIdFromUrl_(url) {
  const m = String(url || '').match(/[?&]id=([a-zA-Z0-9_-]+)/) || String(url || '').match(/\/d\/([a-zA-Z0-9_-]+)/);
  return m ? m[1] : '';
}

// A〜L列をまとめて1回のgetValues()で読み取る(以前はA:E/G:H/I:J/K:Lをそれぞれ個別に
// getRange().getValues()しており、案件一覧・工事名リスト・カレンダー・目標値を読むたびに
// 4回のSpreadsheetApp往復が発生していた。SpreadsheetApp呼び出しはネットワーク往復を伴うため、
// 1回にまとめることでrunFullAggregation_・checkSetup双方の実行のたびに発生していた無駄な
// 往復を減らす)。F列は空き列だが範囲に含めても実害はない。
function readIndexRows_() {
  const sh = indexSheet_();
  const lastRow = sh.getLastRow();
  if (lastRow < 2) return [];
  return sh.getRange(2, 1, lastRow - 1, 12).getValues(); // A:L
}

// A:E列。工事番号が空、または"00-00"の行(テンプレートファイル)は除外する。
// マスタNo(B列)の先頭が"S"ならスプレッドシート、それ以外(数字のみ・"E"始まり等)は
// Excelファイルとして扱う(過去分の無印マスタNoも従来通りExcel扱いになる)。
function readFileIndex_(rows) {
  const list = [];
  rows.forEach(function (row) {
    const workNo = String(row[2] || '').trim();
    const fileName = String(row[3] || '').trim();
    const url = String(row[4] || '').trim();
    if (!workNo || !fileName || !url) return;
    if (workNo === IGNORE_WORK_NO) return;
    const fileId = extractFileIdFromUrl_(url);
    if (!fileId) return;
    const masterNo = row[1];
    const sourceType = /^s/i.test(String(masterNo || '').trim()) ? 'sheet' : 'excel';
    list.push({
      masterNo: masterNo,
      workNo: workNo,
      fileName: fileName,
      fileId: fileId,
      sourceType: sourceType,
    });
  });
  return list;
}

// G:H列。工事番号→工事名の対応表。
function readWorkNameMap_(rows) {
  const map = {};
  rows.forEach(function (row) {
    const no = String(row[6] || '').trim();
    const name = String(row[7] || '').trim();
    if (no) map[no] = name;
  });
  return map;
}

// I:J列。会社カレンダー。{ "yyyy-MM-dd": true(出勤)/false(休日) }
function readCalendar_(rows) {
  const cal = {};
  rows.forEach(function (row) {
    const dateVal = row[8];
    const holiday = String(row[9] || '').trim();
    if (!(dateVal instanceof Date)) return;
    const key = dateToYmdJst_(dateVal);
    cal[key] = (holiday === '出勤');
  });
  return cal;
}

// K:L列。拠点別の目標日産量デフォルト(トン)。
function readTargets_(rows) {
  const targets = {};
  rows.forEach(function (row) {
    const site = String(row[10] || '').trim();
    const val = row[11];
    if (site && val !== '' && val !== null) targets[site] = Number(val) || 0;
  });
  return targets;
}

// ========== Excel→Googleスプレッドシート変換(読み取り専用の元ファイルには触れない) ==========

// 変換結果のスプレッドシートIDと、変換時点の元Excelファイルの最終更新日時を
// スクリプトプロパティに記憶しておく。次回以降、元ファイルの最終更新日時が
// 前回と変わっていなければ(=誰も編集していなければ)ダウンロード・変換処理そのものを
// スキップし、前回変換済みのスプレッドシートをそのまま再利用する。変更があった
// ファイルだけ差し替えるので、多くの案件が未変更の場合は更新がかなり速くなる。
// (Drive API 高度なサービスは v3 を使用。v3では変換用の特別なオプション指定は不要で、
//  メタデータのmimeTypeをGoogleネイティブ形式にしておけばアップロード内容が自動変換される)
// currentMtime/sourceFileは呼び出し側(runFullAggregation_)で1回だけ取得済みのものを渡す
// (この関数の中で改めてDriveApp.getFileByIdを呼び直さない)。
function convertToSheet_(sourceFileId, label, folder, currentMtime, sourceFile) {
  const props = PropertiesService.getScriptProperties();
  const propKey = 'conv_' + sourceFileId;
  const mtimeKey = 'mtime_' + sourceFileId;
  const lastMtime = props.getProperty(mtimeKey);
  const existingId = props.getProperty(propKey);

  if (existingId && lastMtime === currentMtime) {
    try {
      DriveApp.getFileById(existingId); // 作業用ファイルがまだ存在するかだけ確認する(軽量)
      return existingId; // 元ファイルは前回から変更なし。再変換をスキップする。
    } catch (e) {
      // 作業用ファイルが手動で削除されていた場合は、下の再変換にフォールバックする。
    }
  }

  const blob = sourceFile.getBlob();
  if (existingId) {
    try {
      Drive.Files.update({}, existingId, blob);
      props.setProperty(mtimeKey, currentMtime);
      return existingId;
    } catch (e) {
      // 作業用ファイルが手動で削除されている等の場合は、新規作成にフォールバックする。
    }
  }

  const created = Drive.Files.create(
    { name: WORK_COPY_PREFIX + label, mimeType: MimeType.GOOGLE_SHEETS, parents: [folder.getId()] },
    blob
  );
  props.setProperty(propKey, created.id);
  props.setProperty(mtimeKey, currentMtime);
  return created.id;
}

// entry.sourceTypeが'sheet'なら、既にGoogleスプレッドシートなので変換不要でそのまま
// そのIDを使う(getBlob()はGoogleネイティブファイルには使えずエラーになるため)。
// 'excel'(既定)の場合のみ、従来通りExcel→スプレッドシート変換を行う。
function resolveSheetId_(entry, folder, currentMtime, sourceFile) {
  if (entry.sourceType === 'sheet') return entry.fileId;
  return convertToSheet_(entry.fileId, entry.workNo + '_' + entry.fileName, folder, currentMtime, sourceFile);
}

// ========== 案件ごとの集計結果(records)のキャッシュ ==========
// 変換(convertToSheet_)をスキップできても、変換済みシートの中身を読んで集計する処理
// (parseMasterSheet_)は毎回発生していた。特に19行目以降のような「二度と更新されない」
// 案件が増えるほど、これが更新のたびに積み重なるムダなコストになる。
// ここでは案件(fileId)ごとに、最後に読んだ時点のファイル更新日時とその時の集計結果
// (records)を保存しておき、ファイル更新日時が前回と変わっていなければ
// parseMasterSheet_ 自体を丸ごとスキップして、保存済みのrecordsをそのまま使い回す。
function loadRecordsCache_(folder) {
  const files = folder.getFilesByName(RECORDS_CACHE_FILE_NAME);
  if (!files.hasNext()) return {};
  try {
    return JSON.parse(files.next().getBlob().getDataAsString());
  } catch (e) {
    return {};
  }
}

function saveRecordsCache_(folder, cache) {
  const content = JSON.stringify(cache);
  const files = folder.getFilesByName(RECORDS_CACHE_FILE_NAME);
  if (files.hasNext()) {
    files.next().setContent(content);
  } else {
    folder.createFile(RECORDS_CACHE_FILE_NAME, content, MimeType.PLAIN_TEXT);
  }
}

// ========== マスターExcel(変換後)の解析 ==========

function isValidDateCell_(v) {
  return v instanceof Date && !isNaN(v.getTime());
}

// Asia/Tokyo(常にUTC+9固定・夏時間なし)の"yyyy-MM-dd"を、Utilities.formatDateを
// 使わずに求める。マスターExcelの全行ループ内で日付ごとに呼ばれるため、GASサービス
// 呼び出し(Utilities.*)を避けて純粋なJS計算にすることで、数千行規模のファイルを
// 多数処理する集計処理全体を大きく高速化できる(20万件超のランダム日時・日付境界での
// Utilities.formatDate(d,'Asia/Tokyo','yyyy-MM-dd')との一致を検証済み)。
function pad2_(n) { return n < 10 ? '0' + n : String(n); }
function dateToYmdJst_(d) {
  const t = new Date(d.getTime() + 9 * 60 * 60 * 1000);
  return t.getUTCFullYear() + '-' + pad2_(t.getUTCMonth() + 1) + '-' + pad2_(t.getUTCDate());
}

function classifyPart_(part) {
  return MAIN_PARTS.indexOf(part) >= 0 ? part : OTHER_PART;
}

// 変換済みスプレッドシートの1シート目を読み、{site, part, dateKey, qty, weight} の配列を返す。
// 見出し行の文字列で列位置を特定するため、ファイルごとの多少の列ズレを吸収できる。
function parseMasterSheet_(convertedSheetId, calendarMinKey, calendarMaxKey) {
  const ss = SpreadsheetApp.openById(convertedSheetId);
  const sh = ss.getSheets()[0];
  const values = sh.getDataRange().getValues();
  if (values.length < 2) return [];

  const header = values[0].map(function (h) { return String(h || '').trim(); });
  const col = {
    part: header.indexOf('部位'),
    site: header.indexOf('加工先'),
    workDate: header.indexOf('加工'),
    qty: header.indexOf('本数'),
    weight: header.indexOf('重量'),
    mark: header.indexOf('製品マーク'),
  };
  if (col.part < 0 || col.site < 0 || col.workDate < 0) return [];

  const records = [];
  for (let i = 1; i < values.length; i++) {
    const row = values[i];
    const site = String(row[col.site] || '').trim();
    const part = String(row[col.part] || '').trim();
    const dateVal = row[col.workDate];
    if (!site || !part || !isValidDateCell_(dateVal)) continue;

    const dateKey = dateToYmdJst_(dateVal);
    if (dateKey < calendarMinKey || dateKey > calendarMaxKey) continue; // カレンダー範囲外は除外

    records.push({
      site: site,
      part: classifyPart_(part),
      dateKey: dateKey,
      qty: col.qty >= 0 ? (Number(row[col.qty]) || 0) : 0,
      weight: col.weight >= 0 ? (Number(row[col.weight]) || 0) : 0,
      // 1行=1製品=1本の前提(同じ製品マークが複数行に重複することはない)。
      // 工程表のセルクリック時の日別内訳ポップアップ表示にのみ使用する。
      mark: col.mark >= 0 ? String(row[col.mark] || '').trim() : '',
    });
  }
  return records;
}

// ========== 集計本体 ==========

// folder: getDashboardData_/refreshAndGetData_が既に取得済みのフォルダを渡してもらい、
// ここで改めてgetCacheFolder_()を呼び直さない(1リクエストあたりのDrive API往復を減らす)。
function runFullAggregation_(folder) {
  const rows = readIndexRows_();
  const fileIndex = readFileIndex_(rows);
  const workNames = readWorkNameMap_(rows);
  const calendar = readCalendar_(rows);
  const targets = readTargets_(rows);

  const calKeys = Object.keys(calendar).sort();
  const calendarMinKey = calKeys.length ? calKeys[0] : '0000-00-00';
  const calendarMaxKey = calKeys.length ? calKeys[calKeys.length - 1] : '9999-99-99';

  const dailyBySite = {}; // site -> { dateKey: weight }
  const worksMap = {}; // workNo -> { workName, bySite: { site: { byPart: {part: {dateKey:qty}}, weightByDate: {dateKey:weight} } } }
  const warnings = [];
  const nameMismatches = [];
  const recordsCache = loadRecordsCache_(folder);
  const newRecordsCache = {};

  fileIndex.forEach(function (entry) {
    let driveFile;
    try {
      driveFile = DriveApp.getFileById(entry.fileId);
    } catch (err) {
      warnings.push('「' + entry.fileName + '」の読み込みに失敗しました: ' + err.message);
      return;
    }
    const currentMtime = String(driveFile.getLastUpdated().getTime());

    // 使い回しの枠(2〜18行目など)は、工事が切り替わった際に索引シートのD列(ファイル名)を
    // 更新し忘れると気づきにくいため、実際のドライブ上のファイル名と食い違っていないか
    // ここでチェックし、あればフロント側でポップアップ表示する。
    const actualFileName = driveFile.getName();
    if (actualFileName !== entry.fileName) {
      nameMismatches.push({ workNo: entry.workNo, indexFileName: entry.fileName, actualFileName: actualFileName });
    }

    // ファイルの更新日時が前回集計時から変わっていなければ、変換(convertToSheet_)だけで
    // なくparseMasterSheet_自体を丸ごとスキップし、前回のrecordsをそのまま使い回す。
    // 19行目以降のような「二度と更新されない」旧工事の案件は、これで初回以降ずっと
    // 読み込みコストがかからなくなる。
    // cached.vがRECORDS_CACHE_VERSIONと異なる場合(records自体の形式を変更した後、まだ
    // 一度も再解析されていない旧キャッシュ)は、mtimeが同じでも再解析する。そうしないと、
    // 二度と更新されない旧工事のファイルなどで、新しく追加したフィールド(製品マーク等)が
    // 欠けたままの古い形式のrecordsを永遠に使い回してしまう。
    const cached = recordsCache[entry.fileId];
    let records;
    if (cached && cached.mtime === currentMtime && cached.v === RECORDS_CACHE_VERSION) {
      records = cached.records;
    } else {
      try {
        const convertedId = resolveSheetId_(entry, folder, currentMtime, driveFile);
        records = parseMasterSheet_(convertedId, calendarMinKey, calendarMaxKey);
      } catch (err) {
        warnings.push('「' + entry.fileName + '」の読み込みに失敗しました: ' + err.message);
        return;
      }
    }
    newRecordsCache[entry.fileId] = { mtime: currentMtime, v: RECORDS_CACHE_VERSION, records: records };

    if (!worksMap[entry.workNo]) {
      worksMap[entry.workNo] = {
        workName: workNames[entry.workNo] || entry.fileName.replace(/\.xlsx?$/i, ''),
        bySite: {},
      };
    }
    const work = worksMap[entry.workNo];

    records.forEach(function (rec) {
      // 拠点別・日別の合計生産重量(グラフ用)
      if (!dailyBySite[rec.site]) dailyBySite[rec.site] = {};
      dailyBySite[rec.site][rec.dateKey] = (dailyBySite[rec.site][rec.dateKey] || 0) + rec.weight;

      // 工事番号×拠点×部位×日別(工程表用)
      if (!work.bySite[rec.site]) {
        work.bySite[rec.site] = { byPart: {}, weightByDate: {}, itemsByDate: {} };
        MAIN_PARTS.concat([OTHER_PART]).forEach(function (p) { work.bySite[rec.site].byPart[p] = {}; });
      }
      const siteData = work.bySite[rec.site];
      siteData.byPart[rec.part][rec.dateKey] = (siteData.byPart[rec.part][rec.dateKey] || 0) + rec.qty;
      siteData.weightByDate[rec.dateKey] = (siteData.weightByDate[rec.dateKey] || 0) + rec.weight;

      // 工程表のセルクリック時の日別内訳ポップアップ用(工事×拠点×日付ごとの製品明細)。
      // 1行=1製品=1本の前提なので合算はせず、行の出現順のまま保持する。
      if (!siteData.itemsByDate[rec.dateKey]) siteData.itemsByDate[rec.dateKey] = [];
      siteData.itemsByDate[rec.dateKey].push({ part: rec.part, mark: rec.mark, weight: rec.weight });
    });
  });

  // 索引シートから消えた案件のキャッシュは持ち越さない(newRecordsCacheには今回処理した
  // 案件のfileIdしか入っていないため、そのまま保存するだけで自然に整理される)。
  saveRecordsCache_(folder, newRecordsCache);

  const dailyBySiteArray = {};
  Object.keys(dailyBySite).forEach(function (site) {
    dailyBySiteArray[site] = Object.keys(dailyBySite[site]).sort().map(function (d) {
      return { date: d, weight: Math.round(dailyBySite[site][d] * 1000) / 1000 };
    });
  });

  const works = Object.keys(worksMap).sort().map(function (workNo) {
    return { workNo: workNo, workName: worksMap[workNo].workName, bySite: worksMap[workNo].bySite };
  });

  return {
    generatedAt: Utilities.formatDate(new Date(), TIMEZONE, "yyyy-MM-dd'T'HH:mm:ssXXX"),
    calendar: calendar,
    targets: targets,
    dailyBySite: dailyBySiteArray,
    works: works,
    warnings: warnings,
    nameMismatches: nameMismatches,
  };
}

// ========== キャッシュの保存/読み込み(共有フォルダ内、毎回上書き) ==========

function saveCache_(folder, data) {
  const content = JSON.stringify(data);
  const files = folder.getFilesByName(CACHE_FILE_NAME);
  if (files.hasNext()) {
    files.next().setContent(content);
  } else {
    folder.createFile(CACHE_FILE_NAME, content, MimeType.PLAIN_TEXT);
  }
}

function loadCache_(folder) {
  const files = folder.getFilesByName(CACHE_FILE_NAME);
  if (!files.hasNext()) return null;
  try {
    return JSON.parse(files.next().getBlob().getDataAsString());
  } catch (e) {
    return null;
  }
}
