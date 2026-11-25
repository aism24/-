/**
 * 「大組図から短管リスト作成」(jissun-tankan-list)の GAS。
 *
 * スプレッドシート「製品別金物一覧アプリ」の Apps Script(金物リスト tdf-kanamono-list の Code.gs が入っているプロジェクト)に、
 * 2つ目のファイル「Tankan」として足して使う。ウェブアプリの入口(doGet・doPost)は1プロジェクトに1つなので、
 * 金物リストの Code.gs の doGet・doPost が、action が「tankan」で始まる依頼だけをこのファイルへ回す。
 * 同じプロジェクトの中では名前が共有されるため、ここの関数・定数はすべて tankan / TANKAN で始める。
 *
 * 図面(TDF)の読み取り・Excel の作成はブラウザだけで行う。ここが担うのは次だけ:
 *   GET  tankanPing      版を返す
 *   GET  tankanSettings  設定シート(工事番号・工事名、サーバー名とパス)… 金物リストと共用。読むだけ
 *   GET  tankanOrders    注文書(切板手配書)キャッシュ … ドライブ「切板CSV工事別まとめ」の <工事番号>.csv
 *   POST tankanSave      Excel ダウンロードの記録と、その中身のシートの追加
 *   POST tankanUsage     利用記録(アプリを開いた日時。画面には出さない)
 *
 * シート(金物リストのシートとぶつからないよう「短管_」で始める):
 *   設定            1行目の見出し「工事番号」「工事名」「サーバー」「ファイルパス」で列を探す(金物リストと共用。書かない)
 *   短管_記録        ダウンロードのたびに1行
 *   短管_利用記録     アプリを開いた日時
 *   短管_yyyyMMdd_HHmmss_工事番号 … ダウンロードした表の中身(短管のシートだけ、新しい10枚を残す)
 *
 * 初回: このファイルを足して保存 → 関数 tankanSetupSpreadsheet を1回実行
 *       → デプロイを管理 → 金物リストの今のデプロイを編集して「新バージョン」(URL は変わらない)
 */
const TANKAN = {
  VERSION: 'tankan-20261125b',
  ORDERS_FOLDER_ID: '1Pp68pZl9gki8WfOLmrV1L0UG6-hPjyER',   // ドライブ「切板CSV工事別まとめ」
  SHEET_SETTING: '設定',
  SHEET_RECORD: '短管_記録',
  SHEET_USAGE: '短管_利用記録',
  DETAIL_PREFIX: '短管_',
  DETAIL_RE: /^短管_\d{8}_\d{6}_/,
  MAX_DETAIL_SHEETS: 10,
  TZ: 'Asia/Tokyo',
  RECORD_HEAD: ['日時', '工事番号', '工事名', '節', '階', '柱の数', '板の枚数', '要確認', 'Excelの名前', 'シート名'],
  DETAIL_HEAD: ['階', '番号', '柱符号', '図面番号', 'サイズ', 'コラム長さ', '仕上がり', '板マーク', '重量', '状態'],
};

// 金物リストの doGet・doPost から呼ぶ: この action は短管リストのものか
function tankanIsAction(action) {
  return /^tankan/.test(String(action || ''));
}

function tankanDoGet(e) {
  try {
    const p = (e && e.parameter) || {};
    if (p.action === 'tankanPing') return tankanOk_({ version: TANKAN.VERSION });
    // アプリを開いたときはこれ1回(設定シートを1回読んで両方返す)
    if (p.action === 'tankanSettings') return tankanOk_(tankanGetSettings_());
    if (p.action === 'tankanOrders') return tankanOk_(tankanGetOrders_(p.koji));
    return tankanErr_('不明なaction: ' + p.action);
  } catch (err) {
    return tankanErr_(String(err && err.message || err));
  }
}

// body は金物リストの doPost が JSON.parse 済みのもの
function tankanDoPost(body) {
  try {
    if (body.action === 'tankanSave') return tankanOk_(tankanWithLock_(() => tankanOnSave_(body)));
    if (body.action === 'tankanUsage') return tankanOk_(tankanWithLock_(() => tankanLogUsage_()));
    return tankanErr_('不明なaction: ' + body.action);
  } catch (err) {
    return tankanErr_(String(err && err.message || err));
  }
}

// 記録の書き込みは1つずつ(同時に保存されても行やシートが混ざらないように)
function tankanWithLock_(fn) {
  const lock = LockService.getScriptLock();
  lock.waitLock(30000);
  try {
    return fn();
  } finally {
    lock.releaseLock();
  }
}

function tankanSheet_(name) {
  const sh = SpreadsheetApp.getActiveSpreadsheet().getSheetByName(name);
  if (!sh) throw new Error('シートが見つかりません: ' + name);
  return sh;
}

// ---------- 設定(金物リストと共用。読むだけ) ----------
// { servers: [[サーバー名, パス], ...], koji: [[工事番号, 工事名], ...] }
function tankanGetSettings_() {
  const values = tankanSheet_(TANKAN.SHEET_SETTING).getDataRange().getDisplayValues();
  const head = (values[0] || []).map(v => String(v).trim());
  const col = (name, def) => { const i = head.indexOf(name); return i >= 0 ? i : def; };
  const kc = col('工事番号', 0), nc = col('工事名', 1), sc = col('サーバー', 4), pc = col('ファイルパス', 5);
  const rows = values.slice(1);
  return {
    servers: rows.map(r => [String(r[sc] || '').trim(), String(r[pc] || '').trim()]).filter(r => r[0] && r[1]),
    koji: rows.map(r => [String(r[kc] || '').trim(), String(r[nc] || '').trim()]).filter(r => r[0]),
  };
}

function tankanKojiName_(kojiNo) {
  const hit = tankanGetSettings_().koji.find(r => r[0] === String(kojiNo || '').trim());
  return hit ? hit[1] : '';
}

// ---------- 注文書(切板手配書)キャッシュ ----------
// PC の「切板CSVキャッシュ作成.bat」がドライブへコピーした <工事番号>.csv(UTF-8 BOM)を返す。
// { koji, name, updated, csv }。ファイルが無ければ csv は空(アプリは重量を図面からの計算値で入れる)
function tankanGetOrders_(kojiNo) {
  const koji = String(kojiNo || '').trim();
  if (!/^\d{2}-\d{2}$/.test(koji)) throw new Error('工事番号の形が違います: ' + koji);
  const it = DriveApp.getFolderById(TANKAN.ORDERS_FOLDER_ID).getFilesByName(koji + '.csv');
  if (!it.hasNext()) return { koji: koji, name: '', updated: '', csv: '' };
  const f = it.next();
  return {
    koji: koji, name: f.getName(),
    updated: Utilities.formatDate(f.getLastUpdated(), TANKAN.TZ, 'yyyy/MM/dd HH:mm'),
    csv: f.getBlob().getDataAsString('UTF-8').replace(/^﻿/, ''),
  };
}

// ---------- ダウンロードの記録 ----------
// body: { kojiNo, setsu, floors, columns, plates, needCheck, excelName, rows:[[階, 番号, 柱符号, …, 状態], ...] }
function tankanOnSave_(body) {
  const now = new Date();
  const kojiNo = String(body.kojiNo || '');
  const rows = Array.isArray(body.rows) ? body.rows : [];
  const name = TANKAN.DETAIL_PREFIX + Utilities.formatDate(now, TANKAN.TZ, 'yyyyMMdd_HHmmss') + '_' + (kojiNo || '工事番号なし');
  const sheetName = tankanAddDetailSheet_(name, rows);
  tankanSheet_(TANKAN.SHEET_RECORD).appendRow([
    Utilities.formatDate(now, TANKAN.TZ, 'yyyy/MM/dd HH:mm:ss'), kojiNo, tankanKojiName_(kojiNo),
    String(body.setsu || ''), String(body.floors || ''), Number(body.columns) || 0, Number(body.plates) || 0,
    Number(body.needCheck) || 0, String(body.excelName || ''), sheetName,
  ]);
  return { sheet: sheetName };
}

function tankanAddDetailSheet_(name, rows) {
  const ss = SpreadsheetApp.getActiveSpreadsheet();
  const head = TANKAN.DETAIL_HEAD;
  let nm = name, k = 2;
  while (ss.getSheetByName(nm)) nm = name + '_' + (k++);
  const sh = ss.insertSheet(nm, ss.getSheets().length);
  const values = [head].concat(rows.map(r => head.map((_, i) => (r && r[i] != null) ? r[i] : '')));
  sh.getRange(1, 1, values.length, head.length).setValues(values);
  sh.getRange(1, 1, 1, head.length).setFontWeight('bold').setBackground('#d9e1f2');
  sh.setFrozenRows(1);
  // 要確認の行は黄色
  const st = head.length - 1;
  values.forEach((r, i) => { if (i > 0 && r[st] && r[st] !== 'OK') sh.getRange(i + 1, 1, 1, head.length).setBackground('#fff2a8'); });

  // 短管のシートだけ、新しい10枚を残す(名前の日時が古いものから消す。金物リストのシートには触らない)
  const details = ss.getSheets().filter(s => TANKAN.DETAIL_RE.test(s.getName()))
    .sort((a, b) => a.getName() < b.getName() ? -1 : 1);
  while (details.length > TANKAN.MAX_DETAIL_SHEETS) ss.deleteSheet(details.shift());
  return nm;
}

// ---------- 利用記録 ----------
function tankanLogUsage_() {
  const sh = tankanSheet_(TANKAN.SHEET_USAGE);
  sh.insertRowBefore(2);
  sh.getRange(2, 1, 1, 2).setValues([[Utilities.formatDate(new Date(), TANKAN.TZ, 'yyyy/MM/dd HH:mm:ss'), 'アプリを開いた']]);
  return true;
}

// ---------- 共通 ----------
function tankanJson_(payload) {
  return ContentService.createTextOutput(JSON.stringify(payload)).setMimeType(ContentService.MimeType.JSON);
}
function tankanOk_(data) { return tankanJson_({ status: 'success', data: data }); }
function tankanErr_(message) { return tankanJson_({ status: 'error', message: message }); }

// 初回に1回だけ手で実行する(Apps Script エディタで tankanSetupSpreadsheet を選んで ▶実行)。
// 短管_記録・短管_利用記録の見出しを作る(データの行には触らない)。設定シート・金物リストのシートは触らない。
function tankanSetupSpreadsheet() {
  const ss = SpreadsheetApp.getActiveSpreadsheet();
  let rec = ss.getSheetByName(TANKAN.SHEET_RECORD);
  if (!rec) rec = ss.insertSheet(TANKAN.SHEET_RECORD);
  rec.getRange(1, 1, 1, TANKAN.RECORD_HEAD.length).setValues([TANKAN.RECORD_HEAD]).setFontWeight('bold').setBackground('#d9e1f2');
  rec.setFrozenRows(1);

  let use = ss.getSheetByName(TANKAN.SHEET_USAGE);
  if (!use) use = ss.insertSheet(TANKAN.SHEET_USAGE);
  use.getRange(1, 1, 1, 2).setValues([['日時', '内容']]).setFontWeight('bold').setBackground('#d9e1f2');
  use.setFrozenRows(1);
  use.setColumnWidth(1, 160);

  tankanSheet_(TANKAN.SHEET_SETTING); // 無ければエラーで知らせる
  DriveApp.getFolderById(TANKAN.ORDERS_FOLDER_ID).getName(); // フォルダが開けるか確かめる(権限の承認もここで出る)
}
