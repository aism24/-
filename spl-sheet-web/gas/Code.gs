/**
 * 「継手基準図からSPLシート作成」(spl-sheet-web)の GAS JSON API。
 *
 * 管理用スプレッドシート「SPLシート作成」の「拡張機能 → Apps Script」に貼るコンテナバインド型。
 * 図面の読み取り・Excelの作成はブラウザだけで行う。GAS が担うのは次だけ:
 *   - 設定シートの読み出し(サーバー名とパス・工事番号と工事名)
 *   - 保存(Excelダウンロード)の記録と、その中身のシート
 *   - 利用記録(アプリを開いた日時)
 * GAS が動かなくても、Excel の作成は止まらない(リンクの場所が分からないだけ)。
 *
 * シート:
 *   設定   1行目の見出し「工事番号」「工事名」「サーバー」「ファイルパス」で列を探す(今は A・B と E・F)
 *   記録   保存のたびに1行(見出しは setupSpreadsheet で作る)
 *   利用記録 アプリを開いた日時
 *   yyyyMMdd_HHmmss_工事番号 … 保存した表の中身(新しい10枚だけ残す)
 *
 * 初回: 関数 setupSpreadsheet を1回実行 → デプロイ(ウェブアプリ・実行=自分・アクセス=全員)
 */
const CODE_VERSION = 'spl-20261117c';
const SHEET_RECORD = '記録';
const SHEET_SETTING = '設定';
const SHEET_USAGE = '利用記録';
const MAX_DETAIL_SHEETS = 10;
const DETAIL_RE = /^\d{8}_\d{6}_/;
const TZ = 'Asia/Tokyo';

const RECORD_HEAD = ['日時', '工事番号', '工事名', '取り込んだExcel', '図番の範囲', '継手数', '一致', '違い', '新規', '手入力', '図面の値にした数', 'シート名'];
const DETAIL_HEAD = ['状態', '図番', '継手名',
  'Fr外 板厚', 'Fr外 幅', 'Fr外 長さ', 'Fr外 枚数',
  'Fr内 板厚', 'Fr内 幅', 'Fr内 長さ', 'Fr内 枚数',
  'Web 板厚', 'Web 幅', 'Web 長さ', 'Web 枚数',
  'フィラー', '丁番', 'SPL', 'ボルト', '最新図との違い'];
const DETAIL_COLS = ['A', 'B', 'E', 'F', 'G', 'H', 'J', 'K', 'L', 'M', 'O', 'P', 'Q', 'R', 'S', 'T', 'U', 'V'];

function doGet(e) {
  try {
    const p = (e && e.parameter) || {};
    if (p.action === 'ping') return ok_({ version: CODE_VERSION });
    // アプリを開いたときはこれ1回(設定シートを1回読んで両方返す。2回呼ぶと4〜5秒かかっていた)
    if (p.action === 'getSettings') return ok_(getSettings());
    if (p.action === 'getServerPaths') return ok_(getServerPaths());
    if (p.action === 'getKojiList') return ok_(getKojiList());
    return errRes_('不明なaction: ' + p.action);
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

// ---------- 設定 ----------

// 設定シートの全体と、1行目の見出しから探した列の位置(見つからなければ既定の列)
function settingTable_() {
  const sh = sheet_(SHEET_SETTING);
  const values = sh.getDataRange().getDisplayValues();
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
  return { servers: serverPathsOf_(t), koji: kojiListOf_(t) };
}

// [[サーバー名, パス], ...](前の版の画面用に残す)
function getServerPaths() { return serverPathsOf_(settingTable_()); }
// [[工事番号, 工事名], ...]
function getKojiList() { return kojiListOf_(settingTable_()); }

function serverPathsOf_(t) {
  return t.rows
    .map(r => [String(r[t.server] || '').trim(), String(r[t.path] || '').trim()])
    .filter(r => r[0] && r[1]);
}
function kojiListOf_(t) {
  return t.rows
    .map(r => [String(r[t.koji] || '').trim(), String(r[t.kojiName] || '').trim()])
    .filter(r => r[0]);
}

function kojiName_(kojiNo) {
  const hit = getKojiList().find(r => r[0] === String(kojiNo || '').trim());
  return hit ? hit[1] : '';
}

// ---------- 保存の記録 ----------
// body: { kojiNo, excelName, zubanRange, counts:{一致,違い,新規,手入力}, applied, rows:[{status, diff:[列], vals:{A..V}, note}] }
function onSave_(body) {
  const ss = SpreadsheetApp.getActiveSpreadsheet();
  const now = new Date();
  const kojiNo = String(body.kojiNo || '');
  const rows = Array.isArray(body.rows) ? body.rows : [];
  const c = body.counts || {};

  const name = Utilities.formatDate(now, TZ, 'yyyyMMdd_HHmmss') + '_' + (kojiNo || '工事番号なし');
  addDetailSheet_(ss, name, rows);

  const rec = sheet_(SHEET_RECORD);
  rec.appendRow([
    Utilities.formatDate(now, TZ, 'yyyy/MM/dd HH:mm:ss'), kojiNo, kojiName_(kojiNo),
    String(body.excelName || ''), String(body.zubanRange || ''), rows.filter(r => r.status !== '手入力').length,
    c['一致'] || 0, c['違い'] || 0, c['新規'] || 0, c['手入力'] || 0, Number(body.applied) || 0, name,
  ]);
  return { sheet: name };
}

function addDetailSheet_(ss, name, rows) {
  let nm = name, k = 2;
  while (ss.getSheetByName(nm)) nm = name + '_' + (k++);
  const sh = ss.insertSheet(nm, ss.getSheets().length);
  const values = [DETAIL_HEAD].concat(rows.map(r => {
    const v = r.vals || {};
    return [r.status || ''].concat(DETAIL_COLS.map(col => v[col] == null ? '' : v[col])).concat([r.note || '']);
  }));
  sh.getRange(1, 1, values.length, DETAIL_HEAD.length).setValues(values);
  sh.getRange(1, 1, 1, DETAIL_HEAD.length).setFontWeight('bold'); // 見出しの色は下の setBackgrounds で塗る
  sh.setFrozenRows(1);

  // 色: 新規の行は薄い緑、手入力の行は薄い灰色、最新図と違うセルは黄色
  const bg = values.map((row, i) => {
    if (i === 0) return DETAIL_HEAD.map(() => '#d9e1f2');
    const r = rows[i - 1];
    const base = r.status === '新規' ? '#d8f5d0' : r.status === '手入力' ? '#eeeeee' : null;
    const diff = r.diff || [];
    return [base].concat(DETAIL_COLS.map(col => diff.indexOf(col) >= 0 ? '#fff2a8' : base)).concat([base]);
  });
  sh.getRange(1, 1, values.length, DETAIL_HEAD.length).setBackgrounds(bg);

  // 新しい10枚だけ残す(名前の日時が古いものから消す)
  const details = ss.getSheets().filter(s => DETAIL_RE.test(s.getName()))
    .sort((a, b) => a.getName() < b.getName() ? -1 : 1);
  while (details.length > MAX_DETAIL_SHEETS) ss.deleteSheet(details.shift());
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

function sheet_(name) {
  const sh = SpreadsheetApp.getActiveSpreadsheet().getSheetByName(name);
  if (!sh) throw new Error('シートが見つかりません: ' + name);
  return sh;
}

// 初回に1回だけ手で実行する(Apps Script エディタで setupSpreadsheet を選んで ▶実行)。
// 記録・利用記録の見出しを揃える(データの行には触らない)。設定シートは触らない。
function setupSpreadsheet() {
  const ss = SpreadsheetApp.getActiveSpreadsheet();
  let rec = ss.getSheetByName(SHEET_RECORD);
  if (!rec) rec = ss.insertSheet(SHEET_RECORD);
  rec.getRange(1, 1, 1, Math.max(rec.getLastColumn(), RECORD_HEAD.length)).clearContent();
  rec.getRange(1, 1, 1, RECORD_HEAD.length).setValues([RECORD_HEAD]).setFontWeight('bold').setBackground('#d9e1f2');
  rec.setFrozenRows(1);

  let use = ss.getSheetByName(SHEET_USAGE);
  if (!use) use = ss.insertSheet(SHEET_USAGE);
  use.getRange(1, 1, 1, 2).setValues([['日時', '内容']]).setFontWeight('bold').setBackground('#d9e1f2');
  use.setFrozenRows(1);
  use.setColumnWidth(1, 160);

  sheet_(SHEET_SETTING); // 無ければエラーで知らせる
}
