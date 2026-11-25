/**
 * 「大組図から短管リスト作成」(jissun-tankan-list)の GAS。
 * スプレッドシート「短管リスト」の 拡張機能 → Apps Script に貼り付けて使う(コンテナバインド)。
 * 図面(TDF)の読み取り・Excel の作成はブラウザだけで行う。GAS が担うのは次だけ:
 *   GET  ping      版を返す
 *   GET  settings  情報シート(工事番号・工事名、サーバー名とパス)
 *   GET  orders    注文書(切板手配書)キャッシュ … ドライブ「切板CSV工事別まとめ」の <工事番号>.csv
 *   POST start     アプリで開始したとき記録シートに1行(日時・工場)
 *   POST download  Excel をダウンロードしたとき記録シートに1行(日時・工場・シート名)と、同じ内容のデータシート
 *
 * シート:
 *   情報  A=工事番号 B=工事名(1行目は見出し) / E=サーバー F=ファイルパス(各サーバーの「①進行中工事」)
 *   記録  A=日時 B=工場 C=シート名。新しい記録は2行目に入れる(新しいものが上)
 *   MMdd_追番(例 1125_1) ダウンロードした Excel と同じ内容。新しい10枚だけ残す(古いものから消す)
 * 利用記録は利用者に分からないようにする(アプリ側は結果を表示しない)。
 * デプロイ: ウェブアプリ / 次のユーザーとして実行=自分 / アクセスできるユーザー=全員
 */
const CODE_VERSION = 'tankan-20261125c';
const SHEET_SETTING = '情報';
const SHEET_RECORD = '記録';
const RECORD_HEAD = ['日時', '工場', 'シート名'];
const ORDERS_FOLDER_ID = '1Pp68pZl9gki8WfOLmrV1L0UG6-hPjyER';   // ドライブ「切板CSV工事別まとめ」
const MAX_DATA_SHEETS = 10;
const DATA_RE = /^\d{4}_\d+$/;
const TZ = 'Asia/Tokyo';

function json_(o) {
  return ContentService.createTextOutput(JSON.stringify(o)).setMimeType(ContentService.MimeType.JSON);
}

function doGet(e) {
  const p = (e && e.parameter) || {};
  const action = p.action || 'ping';
  try {
    if (action === 'settings') return json_(Object.assign({ status: 'success' }, readSettings_()));
    if (action === 'orders') return json_(Object.assign({ status: 'success' }, readOrders_(p.koji)));
    return json_({ status: 'success', version: CODE_VERSION });
  } catch (err) {
    return json_({ status: 'error', message: String(err && err.message || err) });
  }
}

function doPost(e) {
  try {
    const body = JSON.parse(e.postData.contents || '{}');
    const lock = LockService.getScriptLock();
    lock.waitLock(30000);
    try {
      if (body.action === 'start') { addRecord_(body.factory, ''); return json_({ status: 'success' }); }
      if (body.action === 'download') {
        const name = addDataSheet_(body.rows || []);
        addRecord_(body.factory, name);
        return json_({ status: 'success', sheet: name });
      }
      return json_({ status: 'error', message: '不明なaction: ' + body.action });
    } finally {
      lock.releaseLock();
    }
  } catch (err) {
    return json_({ status: 'error', message: String(err && err.message || err) });
  }
}

// 情報シート → {koji:[{no,name}], servers:[{name,path}]}
function readSettings_() {
  const sh = SpreadsheetApp.getActiveSpreadsheet().getSheetByName(SHEET_SETTING);
  if (!sh) throw new Error('「' + SHEET_SETTING + '」シートがありません');
  const last = sh.getLastRow();
  const koji = [], servers = [];
  if (last >= 2) {
    const v = sh.getRange(2, 1, last - 1, 6).getDisplayValues();
    v.forEach(function (r) {
      if (r[0] && r[1]) koji.push({ no: String(r[0]).trim(), name: String(r[1]).trim() });
      if (r[4] && r[5]) servers.push({ name: String(r[4]).trim(), path: String(r[5]).trim() });
    });
  }
  return { koji: koji, servers: servers };
}

// 注文書キャッシュ: PC の「切板CSVキャッシュ作成.bat」がドライブへコピーした <工事番号>.csv(UTF-8 BOM)。
// {koji, name, updated, csv}。ファイルが無ければ csv は空(アプリは重量を図面からの計算値で入れる)
function readOrders_(kojiNo) {
  const koji = String(kojiNo || '').trim();
  if (!/^\d{2}-\d{2}$/.test(koji)) throw new Error('工事番号の形が違います: ' + koji);
  const it = DriveApp.getFolderById(ORDERS_FOLDER_ID).getFilesByName(koji + '.csv');
  if (!it.hasNext()) return { koji: koji, name: '', updated: '', csv: '' };
  const f = it.next();
  return {
    koji: koji, name: f.getName(),
    updated: Utilities.formatDate(f.getLastUpdated(), TZ, 'yyyy/MM/dd HH:mm'),
    csv: f.getBlob().getDataAsString('UTF-8').replace(/^﻿/, ''),
  };
}

// 記録シートの2行目に1行入れる(既存の行は下へずれる)
function addRecord_(factory, sheetName) {
  const ss = SpreadsheetApp.getActiveSpreadsheet();
  const w = RECORD_HEAD.length;
  let sh = ss.getSheetByName(SHEET_RECORD);
  if (!sh) { sh = ss.insertSheet(SHEET_RECORD); sh.getRange(1, 1, 1, w).setValues([RECORD_HEAD]); }
  const had = sh.getLastRow() >= 2;
  sh.insertRowBefore(2);
  // 挿入した行が見出しの書式を引き継がないよう、直前の最新行(今は3行目)の書式に揃える
  if (had) sh.getRange(3, 1, 1, w).copyTo(sh.getRange(2, 1, 1, w), SpreadsheetApp.CopyPasteType.PASTE_FORMAT, false);
  else sh.getRange(2, 1, 1, w).setFontWeight('normal').setBackground(null);
  sh.getRange(2, 1, 1, w).setValues([[new Date(), factory || '', sheetName || '']]);
  sh.getRange(2, 1).setNumberFormat('yyyy/MM/dd HH:mm:ss');
}

// データシート「MMdd_追番」を最右端に追加。新しい10枚だけ残す。
// 名前に年が無いので、古さは名前でなくシートの並び(左が古い)で判断する
function addDataSheet_(rows) {
  const ss = SpreadsheetApp.getActiveSpreadsheet();
  const dataSheets = ss.getSheets().filter(function (s) { return DATA_RE.test(s.getName()); });
  while (dataSheets.length >= MAX_DATA_SHEETS) ss.deleteSheet(dataSheets.shift());
  const mmdd = Utilities.formatDate(new Date(), TZ, 'MMdd');
  let n = 0;
  ss.getSheets().forEach(function (s) {
    const m = new RegExp('^' + mmdd + '_(\\d+)$').exec(s.getName());
    if (m) n = Math.max(n, parseInt(m[1], 10));
  });
  const props = PropertiesService.getScriptProperties();
  const key = 'seq_' + Utilities.formatDate(new Date(), TZ, 'yyyyMMdd');
  n = Math.max(n, parseInt(props.getProperty(key) || '0', 10)) + 1;
  Object.keys(props.getProperties()).forEach(function (k) { if (/^seq_/.test(k) && k !== key) props.deleteProperty(k); });
  props.setProperty(key, String(n));
  const name = mmdd + '_' + n;
  const sh = ss.insertSheet(name, ss.getSheets().length);
  if (rows.length) {
    const w = Math.max.apply(null, rows.map(function (r) { return r.length; }));
    const vals = rows.map(function (r) { const a = r.slice(); while (a.length < w) a.push(''); return a; });
    sh.getRange(1, 1, vals.length, w).setValues(vals);
    sh.getRange(1, 1, 1, w).setFontWeight('bold');
    sh.setFrozenRows(1);
  }
  return name;
}

// 初回に1回だけ手で実行する(Apps Script エディタで checkSetup を選んで ▶実行)。
// 情報・記録シートがあるか、注文書のフォルダが開けるかを確かめる(シートの中身は変えない)。ドライブの権限の承認もここで出る
function checkSetup() {
  const ss = SpreadsheetApp.getActiveSpreadsheet();
  [SHEET_SETTING, SHEET_RECORD].forEach(function (n) { if (!ss.getSheetByName(n)) throw new Error('「' + n + '」シートがありません'); });
  const folder = DriveApp.getFolderById(ORDERS_FOLDER_ID);
  Logger.log('OK: 情報 ' + readSettings_().koji.length + ' 工事 / 注文書フォルダ「' + folder.getName() + '」');
}
