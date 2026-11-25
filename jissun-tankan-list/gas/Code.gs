/**
 * 「大組図から短管リスト作成」(jissun-tankan-list)の GAS JSON API。
 *
 * スプレッドシート「製品別金物一覧アプリ」には金物リスト(tdf-kanamono-list)の GAS がすでに入っていて、
 * ウェブアプリの入口(doGet・doPost)は1つのプロジェクトに1つしか置けない。そのため、これは
 * 独立した Apps Script プロジェクト(script.google.com で新規作成)として置き、スプレッドシートを ID で開く。
 *
 * 図面(TDF)の読み取り・Excel の作成はブラウザだけで行う。GAS が担うのは次だけ:
 *   - 設定シートの読み出し(工事番号・工事名、サーバー名とパス)… 金物リストと共用。読むだけで書かない
 *   - 注文書(切板手配書)キャッシュの読み出し … ドライブ「切板CSV工事別まとめ」の <工事番号>.csv
 *   - Excel ダウンロードの記録と、その中身のシートの追加
 *   - 利用記録(アプリを開いた日時)
 *
 * シート(金物リストのシートとぶつからないよう、短管リストのものは「短管_」で始める):
 *   設定            1行目の見出し「工事番号」「工事名」「サーバー」「ファイルパス」で列を探す(金物リストと共用)
 *   短管_記録        ダウンロードのたびに1行
 *   短管_利用記録     アプリを開いた日時
 *   短管_yyyyMMdd_HHmmss_工事番号 … ダウンロードした表の中身(新しい10枚だけ残す)
 *
 * スクリプトプロパティ(プロジェクトの設定 → スクリプト プロパティ。公開リポジトリには書かない):
 *   SPREADSHEET_ID    スプレッドシート「製品別金物一覧アプリ」の ID
 *   ORDERS_FOLDER_ID  ドライブ「切板CSV工事別まとめ」フォルダの ID
 *
 * 初回: スクリプトプロパティを入れる → 関数 setupSpreadsheet を1回実行 → デプロイ(ウェブアプリ・実行=自分・アクセス=全員)
 */
const CODE_VERSION = 'tankan-20261125a';
const SHEET_SETTING = '設定';
const SHEET_RECORD = '短管_記録';
const SHEET_USAGE = '短管_利用記録';
const DETAIL_PREFIX = '短管_';
const DETAIL_RE = /^短管_\d{8}_\d{6}_/;
const MAX_DETAIL_SHEETS = 10;
const TZ = 'Asia/Tokyo';

const RECORD_HEAD = ['日時', '工事番号', '工事名', '節', '階', '柱の数', '板の枚数', '要確認', 'Excelの名前', 'シート名'];
const DETAIL_HEAD = ['階', '番号', '柱符号', '図面番号', 'サイズ', 'コラム長さ', '仕上がり', '板マーク', '重量', '状態'];

function doGet(e) {
  try {
    const p = (e && e.parameter) || {};
    const action = p.action || 'ping';
    if (action === 'ping') return ok_({ version: CODE_VERSION });
    // アプリを開いたときはこれ1回(設定シートを1回読んで両方返す)
    if (action === 'getSettings') return ok_(getSettings());
    if (action === 'getOrders') return ok_(getOrders(p.koji));
    return errRes_('不明なaction: ' + action);
  } catch (err) {
    return errRes_(err.message);
  }
}

function doPost(e) {
  try {
    const body = JSON.parse(e.postData.contents);
    if (body.action === 'onSave') return ok_(withLock_(() => onSave_(body)));
    if (body.action === 'logUsageStart') return ok_(withLock_(() => logUsageStart_()));
    return errRes_('不明なaction: ' + body.action);
  } catch (err) {
    return errRes_(err.message);
  }
}

// 記録の書き込みは1つずつ(同時に保存されても行やシートが混ざらないように)
function withLock_(fn) {
  const lock = LockService.getScriptLock();
  lock.waitLock(30000);
  try {
    return fn();
  } finally {
    lock.releaseLock();
  }
}

// ---------- スプレッドシート・プロパティ ----------

function prop_(name) {
  const v = PropertiesService.getScriptProperties().getProperty(name);
  if (!v) throw new Error('スクリプトプロパティ「' + name + '」が空です');
  return v;
}

let ss_ = null;
function ss() {
  if (!ss_) ss_ = SpreadsheetApp.openById(prop_('SPREADSHEET_ID'));
  return ss_;
}

function sheet_(name) {
  const sh = ss().getSheetByName(name);
  if (!sh) throw new Error('シートが見つかりません: ' + name);
  return sh;
}

// ---------- 設定(金物リストと共用。読むだけ) ----------

// 設定シートの全体と、1行目の見出しから探した列の位置(見つからなければ既定の列)
function settingTable_() {
  const values = sheet_(SHEET_SETTING).getDataRange().getDisplayValues();
  const head = (values[0] || []).map(v => String(v).trim());
  const col = (name, def) => { const i = head.indexOf(name); return i >= 0 ? i : def; };
  return {
    rows: values.slice(1),
    koji: col('工事番号', 0), kojiName: col('工事名', 1),
    server: col('サーバー', 2), path: col('ファイルパス', 3),
  };
}

// { servers: [[サーバー名, パス], ...], koji: [[工事番号, 工事名], ...] }
function getSettings() {
  const t = settingTable_();
  return {
    servers: t.rows.map(r => [String(r[t.server] || '').trim(), String(r[t.path] || '').trim()]).filter(r => r[0] && r[1]),
    koji: t.rows.map(r => [String(r[t.koji] || '').trim(), String(r[t.kojiName] || '').trim()]).filter(r => r[0]),
  };
}

function kojiName_(kojiNo) {
  const hit = getSettings().koji.find(r => r[0] === String(kojiNo || '').trim());
  return hit ? hit[1] : '';
}

// ---------- 注文書(切板手配書)キャッシュ ----------
// PC の「切板CSVキャッシュ作成.bat」がドライブへコピーした <工事番号>.csv(UTF-8 BOM)を返す。
// { koji, name, updated, csv }。ファイルが無ければ csv は空(アプリは重量を図面からの計算値で入れる)
function getOrders(kojiNo) {
  const koji = String(kojiNo || '').trim();
  if (!/^\d{2}-\d{2}$/.test(koji)) throw new Error('工事番号の形が違います: ' + koji);
  const folder = DriveApp.getFolderById(prop_('ORDERS_FOLDER_ID'));
  const it = folder.getFilesByName(koji + '.csv');
  if (!it.hasNext()) return { koji: koji, name: '', updated: '', csv: '' };
  const f = it.next();
  return {
    koji: koji, name: f.getName(),
    updated: Utilities.formatDate(f.getLastUpdated(), TZ, 'yyyy/MM/dd HH:mm'),
    csv: f.getBlob().getDataAsString('UTF-8').replace(/^﻿/, ''),
  };
}

// ---------- ダウンロードの記録 ----------
// body: { kojiNo, setsu, floors, columns, plates, needCheck, excelName, rows:[[階, 番号, 柱符号, …, 状態], ...] }
function onSave_(body) {
  const now = new Date();
  const kojiNo = String(body.kojiNo || '');
  const rows = Array.isArray(body.rows) ? body.rows : [];

  const name = DETAIL_PREFIX + Utilities.formatDate(now, TZ, 'yyyyMMdd_HHmmss') + '_' + (kojiNo || '工事番号なし');
  const sheetName = addDetailSheet_(name, rows);

  sheet_(SHEET_RECORD).appendRow([
    Utilities.formatDate(now, TZ, 'yyyy/MM/dd HH:mm:ss'), kojiNo, kojiName_(kojiNo),
    String(body.setsu || ''), String(body.floors || ''), Number(body.columns) || 0, Number(body.plates) || 0,
    Number(body.needCheck) || 0, String(body.excelName || ''), sheetName,
  ]);
  return { sheet: sheetName };
}

function addDetailSheet_(name, rows) {
  const book = ss();
  let nm = name, k = 2;
  while (book.getSheetByName(nm)) nm = name + '_' + (k++);
  const sh = book.insertSheet(nm, book.getSheets().length);
  const values = [DETAIL_HEAD].concat(rows.map(r => DETAIL_HEAD.map((_, i) => (r && r[i] != null) ? r[i] : '')));
  sh.getRange(1, 1, values.length, DETAIL_HEAD.length).setValues(values);
  sh.getRange(1, 1, 1, DETAIL_HEAD.length).setFontWeight('bold').setBackground('#d9e1f2');
  sh.setFrozenRows(1);
  // 要確認の行は黄色
  const st = DETAIL_HEAD.length - 1;
  values.forEach((r, i) => { if (i > 0 && r[st] && r[st] !== 'OK') sh.getRange(i + 1, 1, 1, DETAIL_HEAD.length).setBackground('#fff2a8'); });

  // 短管リストのシートだけ、新しい10枚を残す(名前の日時が古いものから消す。金物リストのシートには触らない)
  const details = book.getSheets().filter(s => DETAIL_RE.test(s.getName()))
    .sort((a, b) => a.getName() < b.getName() ? -1 : 1);
  while (details.length > MAX_DETAIL_SHEETS) book.deleteSheet(details.shift());
  return nm;
}

// ---------- 利用記録 ----------
function logUsageStart_() {
  const sh = sheet_(SHEET_USAGE);
  sh.insertRowBefore(2);
  sh.getRange(2, 1, 1, 2).setValues([[Utilities.formatDate(new Date(), TZ, 'yyyy/MM/dd HH:mm:ss'), 'アプリを開いた']]);
  return true;
}

// ---------- 共通 ----------
function jsonResponse_(payload) {
  return ContentService.createTextOutput(JSON.stringify(payload)).setMimeType(ContentService.MimeType.JSON);
}
function ok_(data) { return jsonResponse_({ status: 'success', data: data }); }
function errRes_(message) { return jsonResponse_({ status: 'error', message: message }); }

// 初回に1回だけ手で実行する(Apps Script エディタで setupSpreadsheet を選んで ▶実行)。
// 短管_記録・短管_利用記録の見出しを作る(データの行には触らない)。設定シート・金物リストのシートは触らない。
function setupSpreadsheet() {
  const book = ss();
  let rec = book.getSheetByName(SHEET_RECORD);
  if (!rec) rec = book.insertSheet(SHEET_RECORD);
  rec.getRange(1, 1, 1, RECORD_HEAD.length).setValues([RECORD_HEAD]).setFontWeight('bold').setBackground('#d9e1f2');
  rec.setFrozenRows(1);

  let use = book.getSheetByName(SHEET_USAGE);
  if (!use) use = book.insertSheet(SHEET_USAGE);
  use.getRange(1, 1, 1, 2).setValues([['日時', '内容']]).setFontWeight('bold').setBackground('#d9e1f2');
  use.setFrozenRows(1);
  use.setColumnWidth(1, 160);

  sheet_(SHEET_SETTING); // 無ければエラーで知らせる
  DriveApp.getFolderById(prop_('ORDERS_FOLDER_ID')); // フォルダが開けるか確かめる
}
