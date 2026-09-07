/**
 * 「実寸法師」(製品マーク検索→実寸法表示アプリ)のGAS APIバックエンド。
 *
 * このスクリプトは、「マスタから実寸法師を開く」スプレッドシートの
 * 「拡張機能→Apps Script」から作成するコンテナバインド型スクリプトとして使う前提です。
 * SpreadsheetApp.getActiveSpreadsheet()で自分自身のスプレッドシートを参照するため、
 * SPREADSHEET_IDの設定は不要です。
 *
 * このアプリ本体(index.html / app.js)はフロントエンド(GitHub Pages)で、GASは
 * JSON APIのみを提供します(検索・表示はすべてブラウザ側で行います)。
 *
 * ■ 読み取り専用の原則
 *   案件ごとのマスターExcelファイルは常に「読み取り専用」で開きます。書き込みは一切行いません。
 *   xlsx→Googleスプレッドシート変換が必要な処理では、このスプレッドシートと同じフォルダ内に
 *   作業用のスプレッドシートを作成(既存があれば内容だけ上書き)しますが、元のExcelファイル
 *   本体には一切触れません。
 *
 * ■ 前提となるフォルダ構成
 *   このスプレッドシートが置かれているGoogleドライブフォルダの直下に、案件ごとの
 *   マスターExcel(.xlsx)が並んでいる前提です(索引シートは不要。フォルダ内の.xlsxを
 *   自動的にすべて列挙します)。ファイル名は「(工事名)_マスタのまま.xlsx」形式を想定し、
 *   末尾の「_マスタのまま」を除いた部分を案件名として表示します。
 *
 * ■ 案件マスターExcelファイルの列構成(各行=部材1つ。1行目が見出し):
 *   ﾏｽﾀｰﾃﾞｰﾀ ID, 建方日, ブロック, 部位, 加工先, 図番, 製品マーク, サイズ, 備考①, 備考②,
 *   長さ, 本数, 重量, 塗装, 形状, ... (以降は工程管理用の列で、このアプリでは使用しない)
 *   列の並び順はファイルによって多少ずれても、見出し文字列で自動判定します。
 *   セルの値は表示されている通りの文字列(getDisplayValues)としてそのまま読み取ります
 *   (日付・数値の書式や、日付になっていないセル("1/0(Sun)"等)もそのまま表示用に扱う)。
 *
 * セットアップ手順は README.md を参照してください。
 */

// ========== 設定 ==========

const XLSX_MIME = 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet';
const MASTER_FILE_SUFFIX_RE = /_?マスタのまま\.xlsx$/i;
const CACHE_FILE_NAME = '_cache_jissunpoushi.json';
const RECORDS_CACHE_FILE_NAME = '_records_cache_jissunpoushi.json';
// records(案件ごとの読み込み結果キャッシュ)の形式を変える際にインクリメントする。
const RECORDS_CACHE_VERSION = 1;
const WORK_COPY_PREFIX = '_作業用_実寸法師_';
const TIMEZONE = 'Asia/Tokyo';

// 案件マスターExcelの列見出し(この文字列で列位置を特定する)。
const HEADERS = {
  erectionDate: '建方日',
  block: 'ブロック',
  part: '部位',
  site: '加工先',
  drawingNo: '図番',
  mark: '製品マーク',
  size: 'サイズ',
  note1: '備考①',
  note2: '備考②',
  length: '長さ',
  qty: '本数',
  weight: '重量',
};

// ========== エントリーポイント(JSON API) ==========

function doGet(e) {
  try {
    const action = (e && e.parameter && e.parameter.action) || 'getData';
    if (action === 'getData') return ok_(getData_());
    if (action === 'refresh') return userRefresh_();
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
function busyRes_(message) { return jsonResponse_({ status: 'busy', message: message }); }

// キャッシュがあればそれを返し、無ければ初回のみ集計する。
function getData_() {
  const folder = dataFolder_();
  const cached = loadCache_(folder);
  if (cached) return cached;
  return refreshAndGetData_(folder);
}

// getData_(初回・キャッシュが無い場合のみ)、および毎日の自動トリガー(dailyRefresh)から
// 呼ばれる本体処理。スクリプトロックで直列化し、後発の呼び出しは先発の完了を待ってから
// 実行する(同時に複数走ってキャッシュファイルの読み書きが競合するのを防ぐ)。
function refreshAndGetData_(folder) {
  const lock = LockService.getScriptLock();
  lock.waitLock(120000);
  try {
    const targetFolder = folder || dataFolder_();
    const data = buildData_(targetFolder);
    saveCache_(targetFolder, data);
    return data;
  } finally {
    lock.releaseLock();
  }
}

// 「最新化」ボタン(action=refresh)専用のエントリーポイント。他の集計が実行中で
// ロックが取れない場合は、待たずにその場で「他の人が更新中」を返す。
function userRefresh_() {
  const lock = LockService.getScriptLock();
  if (!lock.tryLock(3000)) {
    return busyRes_('他の人がデータを更新中です。完了までしばらくお待ちください(通常は数十秒程度で終わります)。');
  }
  try {
    const folder = dataFolder_();
    const data = buildData_(folder);
    saveCache_(folder, data);
    return ok_(data);
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

// Apps Scriptエディタから手動で実行して、フォルダ構成を確認する。
function checkSetup() {
  const folder = dataFolder_();
  Logger.log('データフォルダ: ' + folder.getName() + ' (' + folder.getId() + ')');
  const files = listMasterFiles_(folder);
  Logger.log('案件マスターExcelファイル: ' + files.length + '件');
  files.forEach(function (f) { Logger.log('  - ' + f.project + ' (' + f.fileName + ')'); });
  if (files.length === 0) {
    Logger.log('警告: このスプレッドシートと同じフォルダに.xlsxファイルが見つかりません。');
  }
}

// ========== フォルダ・ファイル一覧 ==========

function ss_() { return SpreadsheetApp.getActiveSpreadsheet(); }

// このスプレッドシートが置かれているフォルダ(=案件マスターExcel・キャッシュの保存先)。
function dataFolder_() {
  const file = DriveApp.getFileById(ss_().getId());
  const parents = file.getParents();
  return parents.hasNext() ? parents.next() : DriveApp.getRootFolder();
}

// フォルダ直下の案件マスターExcel(.xlsx)を列挙する。作業用の変換済みスプレッドシートや
// JSONキャッシュファイルはxlsxではないため自動的に対象外になる。
function listMasterFiles_(folder) {
  const list = [];
  const it = folder.getFilesByType(XLSX_MIME);
  while (it.hasNext()) {
    const f = it.next();
    const fileName = f.getName();
    list.push({
      fileId: f.getId(),
      fileName: fileName,
      project: fileName.replace(MASTER_FILE_SUFFIX_RE, '').replace(/\.xlsx$/i, ''),
    });
  }
  return list;
}

// ========== Excel→Googleスプレッドシート変換(読み取り専用の元ファイルには触れない) ==========

// 変換結果のスプレッドシートIDと、変換時点の元Excelファイルの最終更新日時をスクリプト
// プロパティに記憶しておく。次回以降、元ファイルの最終更新日時が前回と変わっていなければ
// 変換処理そのものをスキップし、前回変換済みのスプレッドシートをそのまま再利用する。
function convertToSheet_(sourceFileId, label, folder, currentMtime, sourceFile) {
  const props = PropertiesService.getScriptProperties();
  const propKey = 'conv_' + sourceFileId;
  const mtimeKey = 'mtime_' + sourceFileId;
  const lastMtime = props.getProperty(mtimeKey);
  const existingId = props.getProperty(propKey);

  if (existingId && lastMtime === currentMtime) {
    try {
      DriveApp.getFileById(existingId); // 作業用ファイルがまだ存在するかだけ確認する(軽量)
      return existingId;
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

// ========== 案件ごとの集計結果(records)のキャッシュ ==========
// ファイル更新日時が前回と変わっていなければ、変換だけでなく解析(parseMasterSheet_)自体を
// 丸ごとスキップし、前回のrecordsをそのまま使い回す。更新されていない案件が増えるほど、
// 更新のたびに積み重なる無駄なコストがかからなくなる。
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

// 見出し行の文字列で列位置を特定するため、ファイルごとの多少の列ズレを吸収できる。
// セルは表示されている通りの文字列(getDisplayValues)として読み取る(日付書式や、
// "1/0(Sun)"のような日付になっていないセルもそのまま表示用の文字列として扱う)。
function parseMasterSheet_(convertedSheetId, project) {
  const ss = SpreadsheetApp.openById(convertedSheetId);
  const sh = ss.getSheets()[0];
  const values = sh.getDataRange().getDisplayValues();
  if (values.length < 2) return [];

  const header = values[0].map(function (h) { return String(h || '').trim(); });
  const col = {};
  Object.keys(HEADERS).forEach(function (key) { col[key] = header.indexOf(HEADERS[key]); });
  if (col.mark < 0) return []; // 製品マーク列が無いファイルは検索対象にできない

  const records = [];
  for (let i = 1; i < values.length; i++) {
    const row = values[i];
    const mark = col.mark >= 0 ? String(row[col.mark] || '').trim() : '';
    if (!mark) continue; // 製品マークが空の行(見出し直下の空行等)は除外

    const rec = { project: project, mark: mark };
    Object.keys(HEADERS).forEach(function (key) {
      if (key === 'mark') return;
      rec[key] = col[key] >= 0 ? String(row[col[key]] || '').trim() : '';
    });
    records.push(rec);
  }
  return records;
}

// ========== 集計本体 ==========

function buildData_(folder) {
  const files = listMasterFiles_(folder);
  const warnings = [];
  const recordsCache = loadRecordsCache_(folder);
  const newRecordsCache = {};
  const allRecords = [];
  const projects = [];

  files.forEach(function (entry) {
    let driveFile;
    try {
      driveFile = DriveApp.getFileById(entry.fileId);
    } catch (err) {
      warnings.push('「' + entry.fileName + '」の読み込みに失敗しました: ' + err.message);
      return;
    }
    const currentMtime = String(driveFile.getLastUpdated().getTime());

    const cached = recordsCache[entry.fileId];
    let records;
    if (cached && cached.mtime === currentMtime && cached.v === RECORDS_CACHE_VERSION) {
      records = cached.records;
    } else {
      try {
        const convertedId = convertToSheet_(entry.fileId, entry.fileName, folder, currentMtime, driveFile);
        records = parseMasterSheet_(convertedId, entry.project);
      } catch (err) {
        warnings.push('「' + entry.fileName + '」の読み込みに失敗しました: ' + err.message);
        return;
      }
    }
    newRecordsCache[entry.fileId] = { mtime: currentMtime, v: RECORDS_CACHE_VERSION, records: records };

    projects.push(entry.project);
    allRecords.push.apply(allRecords, records);
  });

  // フォルダから消えたファイルのキャッシュは持ち越さない(newRecordsCacheには今回処理した
  // ファイルのfileIdしか入っていないため、そのまま保存するだけで自然に整理される)。
  saveRecordsCache_(folder, newRecordsCache);

  return {
    generatedAt: Utilities.formatDate(new Date(), TIMEZONE, "yyyy-MM-dd'T'HH:mm:ssXXX"),
    projects: projects,
    records: allRecords,
    warnings: warnings,
  };
}

// ========== キャッシュの保存/読み込み(同じフォルダ内、毎回上書き) ==========

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
