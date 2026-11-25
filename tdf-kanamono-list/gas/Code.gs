/**
 * 製品別金物リスト(tdf-kanamono-list)のGAS。スプレッドシート「製品別金物一覧アプリ」に貼り付けて使う(コンテナバインド)。
 * シート:
 *   設定  A=工事番号 B=工事名(1行目は見出し) / E=サーバー F=ファイルパス(各サーバーの「①進行中工事」)
 *   記録  A=日時 B=工事名 C=工場 D=シート名。新しい記録は2行目に入れる(新しいものが上)
 *         工事を選んで開始したとき: A〜C。Excelをダウンロードしたとき: A〜D(D=データシートの名前)
 *   MMdd_追番(例 1119_1) ダウンロードしたExcelと同じ内容。新しい10枚だけ残す(古いものから消す)
 * 注文書  GET orders&koji=26-16 … ドライブ「切板CSV工事別まとめ」の <工事番号>.csv を符号ごとに合計して返す(2026-11-25)。
 *         初回はドライブを読む許可が要る(Apps Script で checkOrders を1回実行して承認)
 * 利用記録は利用者に分からないようにする(アプリ側は結果を表示しない)。
 * デプロイ: ウェブアプリ / 次のユーザーとして実行=自分 / アクセスできるユーザー=全員
 */
const CODE_VERSION = '2026-11-26a';
const ORDERS_FOLDER_ID = '1Pp68pZl9gki8WfOLmrV1L0UG6-hPjyER';   // ドライブ「切板CSV工事別まとめ」(短管リストと同じフォルダ)
const SHEET_SETTING = '設定';
const SHEET_RECORD = '記録';
const MAX_DATA_SHEETS = 10;
const DATA_RE = /^\d{4}_\d+$/;
const TZ = 'Asia/Tokyo';

function json_(o) {
  return ContentService.createTextOutput(JSON.stringify(o)).setMimeType(ContentService.MimeType.JSON);
}

function doGet(e) {
  const action = (e && e.parameter && e.parameter.action) || 'ping';
  try {
    if (action === 'settings') return json_(Object.assign({ status: 'success' }, readSettings_()));
    if (action === 'orders') return json_(Object.assign({ status: 'success', version: CODE_VERSION }, readOrders_(e.parameter.koji)));
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
      if (body.action === 'start') { addRecord_(body.koji, body.factory, ''); return json_({ status: 'success' }); }
      if (body.action === 'download') {
        const name = addDataSheet_(body.rows || []);
        addRecord_(body.koji, body.factory, name);
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

// 設定シート → {koji:[{no,name}], servers:[{name,path}]}
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

// 記録シートの2行目に1行入れる(既存の行は下へずれる)
function addRecord_(koji, factory, sheetName) {
  const ss = SpreadsheetApp.getActiveSpreadsheet();
  let sh = ss.getSheetByName(SHEET_RECORD);
  if (!sh) { sh = ss.insertSheet(SHEET_RECORD); sh.getRange(1, 1, 1, 4).setValues([['日時', '工事名', '工場', 'シート名']]); }
  const had = sh.getLastRow() >= 2;
  sh.insertRowBefore(2);
  // 挿入した行が見出しの書式を引き継がないよう、直前の最新行(今は3行目)の書式に揃える
  if (had) sh.getRange(3, 1, 1, 4).copyTo(sh.getRange(2, 1, 1, 4), SpreadsheetApp.CopyPasteType.PASTE_FORMAT, false);
  else sh.getRange(2, 1, 1, 4).setFontWeight('normal').setBackground(null);
  sh.getRange(2, 1, 1, 4).setValues([[new Date(), koji || '', factory || '', sheetName || '']]);
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
    sh.getRange(1, 1, 1, 1).setFontWeight('bold').setFontSize(14);
    sh.setColumnWidths(1, 4, 150);
  }
  return name;
}

// 注文書(切板の手配書)を符号ごとに合計する → {koji, name, updated, marks:{符号:{n:数量の合計, w:ネット重量(1枚当り), nos:[注文番号の末尾]}}}
// 注文番号 = 工事名の先頭「＜16-2-172＞」(無ければファイル名の先頭の「数字-数字-数字」。「16-2-172TLPLATE.CSV」「11-2-915.CSV」)。末尾 = 最後の「-」より後ろ(172)
// ファイルが無ければ marks は空(アプリは形鋼の重量だけ入れ、照合はしない)
function readOrders_(kojiNo) {
  const koji = String(kojiNo || '').trim();
  if (!/^\d{2}-\d{2}$/.test(koji)) throw new Error('工事番号の形が違います: ' + koji);
  const it = DriveApp.getFolderById(ORDERS_FOLDER_ID).getFilesByName(koji + '.csv');
  if (!it.hasNext()) return { koji: koji, name: '', updated: '', marks: {} };
  const f = it.next();
  const rows = Utilities.parseCsv(readCsvText_(f).replace(/^\uFEFF/, ''));
  const head = rows[0] || [], col = function (h) { return head.indexOf(h); };
  const iMark = col('符号'), iN = col('数量'), iNet = col('ネット重量(kg)') + 1, iName = col('工事名'), iFile = col('ファイル名');
  if (iMark < 0 || iN < 0 || iNet < 1) throw new Error(koji + '.csv の見出し(符号・数量・ネット重量)が見つかりません');
  const marks = {};
  for (let r = 1; r < rows.length; r++) {
    const v = rows[r], mk = String(v[iMark] || '').normalize('NFKC').trim();
    if (!mk) continue;
    const o = marks[mk] || (marks[mk] = { n: 0, w: null, nos: [] });
    o.n += parseFloat(v[iN]) || 0;
    const w = parseFloat(v[iNet]); if (o.w === null && w > 0) o.w = w;
    const nm = String(v[iName] || '').normalize('NFKC'), m = /<([^>]+)>/.exec(nm);
    // ファイル名の「TLPLATE」が無いもの(26-11 の「11-2-915.CSV」)で「915.CSV」になっていた(2026-11-26)→ 数字と「-」の並びだけを取る
    const no = m ? m[1] : ((/\d+(?:-\d+)+/.exec(String(v[iFile] || '')) || [])[0] || '');
    const last = no.split('-').pop().trim();
    if (last && o.nos.indexOf(last) < 0) o.nos.push(last);
  }
  Object.keys(marks).forEach(function (k) { marks[k].nos.sort(function (a, b) { return (parseFloat(a) - parseFloat(b)) || (a < b ? -1 : 1); }); });
  return { koji: koji, name: f.getName(), updated: Utilities.formatDate(f.getLastUpdated(), TZ, 'yyyy/MM/dd HH:mm'), marks: marks };
}

// CSV の中身を読む。DriveApp で「アクセスが拒否されました」になる場合(2026-11-25、会社アカウントの GAS から個人アカウント所有の CSV)に備え、
// だめなら Drive API(UrlFetchApp)で読む
function readCsvText_(f) {
  let e1;
  try { return f.getBlob().getDataAsString('UTF-8'); } catch (e) { e1 = e; }
  const r = UrlFetchApp.fetch('https://www.googleapis.com/drive/v3/files/' + f.getId() + '?alt=media&supportsAllDrives=true',
    { headers: { Authorization: 'Bearer ' + ScriptApp.getOAuthToken() }, muteHttpExceptions: true });
  if (r.getResponseCode() === 200) return r.getContentText('UTF-8');
  throw new Error(f.getName() + ' を読めません(DriveApp: ' + (e1 && e1.message) + ' / Drive API: ' + r.getResponseCode() + ' ' + r.getContentText().slice(0, 200) + ')');
}

// Apps Script のエディタで1回実行: ドライブを読む許可の承認と、注文書が読めるかの確認(26-16 の符号の数をログに出す)
function checkOrders() {
  const o = readOrders_('26-16');
  Logger.log(o.name + ' ' + o.updated + ' 符号 ' + Object.keys(o.marks).length + '件');
}

// 読めないときの診断(Apps Script のエディタで実行し、実行ログを見せてください)。ファイルは変えない
function diagnoseOrders() {
  const log = function (k, v) { Logger.log(k + ': ' + v); };
  const step = function (k, fn) { try { log(k, 'OK ' + fn()); } catch (e) { log(k, 'NG ' + e.message); } };
  step('実行しているアカウント', function () { return Session.getEffectiveUser().getEmail(); });
  let f = null;
  step('フォルダ', function () { const d = DriveApp.getFolderById(ORDERS_FOLDER_ID); return d.getName(); });
  step('26-16.csv を探す', function () { const it = DriveApp.getFolderById(ORDERS_FOLDER_ID).getFilesByName('26-16.csv'); f = it.next(); return f.getId() + ' ' + f.getSize() + 'バイト'; });
  if (!f) return;
  step('持ち主', function () { const o = f.getOwner(); return o ? o.getEmail() : '(不明)'; });
  step('DriveApp で中身を読む', function () { return f.getBlob().getDataAsString('UTF-8').length + '文字'; });
  step('DriveApp.getFileById で読む', function () { return DriveApp.getFileById(f.getId()).getBlob().getBytes().length + 'バイト'; });
  step('Drive API で読む', function () {
    const r = UrlFetchApp.fetch('https://www.googleapis.com/drive/v3/files/' + f.getId() + '?alt=media&supportsAllDrives=true', { headers: { Authorization: 'Bearer ' + ScriptApp.getOAuthToken() }, muteHttpExceptions: true });
    if (r.getResponseCode() !== 200) throw new Error(r.getResponseCode() + ' ' + r.getContentText().slice(0, 300));
    return r.getContentText('UTF-8').length + '文字';
  });
}
