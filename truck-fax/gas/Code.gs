/**
 * 車番連絡FAX取込 - GAS(スプレッドシート「車番連絡自動化」にコンテナバインド)
 *
 * シート:
 *   取込一覧 … FAX1台=1行の記録(列は見出し名で読み書きする。列の追加・並べ替えに強い)
 *   車両運転手情報 … 手配業者 / 運送業者 / 車種 / 車番 / 氏名 / 携帯番号 / 備考。1行=車と運転手の1組(同じ車に別の運転手、同じ運転手が別の車は、別の行)。
 *                  車番が空欄の行=車の組み合わせが無い運転手、氏名・携帯番号が空欄の行=運転手の組み合わせが無い車。
 *   情報 … A列=項目名、B列=値。「Geminiモデル名」「タイムゾーン」「APIKEY」。
 *          工事番号と工事名のリスト(見出し「工事番号」「工事名」の列)も、この見出しを探して読む。
 *
 * Geminiのモデル名とAPIキーは「情報」シートのセルから読む(コード修正・再デプロイ不要)。
 * APIキーはこのGAS内でだけ使い、画面には返さない。
 */

// 貼り替え・デプロイの確認用。ping と init がこの値を返す(画面上部にも表示)。コードを変えたら更新する。
var CODE_VERSION = '20261023a';

var SHEET_IMPORT = '取込一覧';
var SHEET_MERGED = '車両運転手情報'; // 1行=車と運転手の1組。シートの列は MERGED_HEADERS(見出し名で読み書きする)
var SHEET_INFO = '情報';
var MERGED_HEADERS = ['手配業者', '運送業者', '車種', '車番', '氏名', '携帯番号', '備考'];

// 取込一覧の必須の見出し。FAXの送り主は「手配業者」に記録する(見出し「業者」の列が残っていれば、同じ値を入れる)。
var IMPORT_HEADERS = ['タイムスタンプ', 'ファイル名', '工事番号', '現場名', '手配業者', '積日', '卸日', '行先', '着時間', '運送業者', '車種', '車番', '氏名', '携帯番号'];
var CHECK_FIELDS = ['手配業者', '積日', '卸日', '行先', '着時間', '運送業者', '車種', '車番', '氏名', '携帯番号', '工事番号', '現場名', '追加変更'];
// 取込一覧の任意の列(あれば読み書きする。無くても動く)。「追加変更」=中止/変更前/変更後、「備考」=アプリで入力したテキスト。
var IMPORT_OPTIONAL = ['追加変更', '備考', 'ファイルURL']; // ファイルURL=取り込んだ原本(PDF・画像)のDriveのURL。画面のファイル名を押すと開く
var INACTIVE_LABELS = ['変更前', '中止']; // これらの行は車両台数に数えない(行は消さない)

var TEXT_COLS = ['着時間', '車種', '車番', '携帯番号', '工事番号'];
var DATE_COLS = ['積日', '卸日'];
var MAX_ROWS_PER_COMMIT = 60;
var PAST_DEST_ROWS = 800;
var DEFAULT_SENDERS = ['ナミツー', '大上']; // 情報シートに見出し「手配業者」の一覧が無いときの既定

// ---------- 初期設定(1回だけ実行) ----------

function setupSheets() {
  var ss = SpreadsheetApp.getActiveSpreadsheet();
  ensureSheet_(ss, SHEET_IMPORT, IMPORT_HEADERS);
  ensureSheet_(ss, SHEET_MERGED, MERGED_HEADERS);
  ensureOptionalCols_(ss.getSheetByName(SHEET_IMPORT), ['ファイルURL']);
  faxFolder_(true); // 原本の保存先フォルダ(初めて実行するとき、Driveの権限の確認が出る)
  var info = ss.getSheetByName(SHEET_INFO) || ss.insertSheet(SHEET_INFO);
  var defaults = [['Geminiモデル名', 'gemini-3.5-flash-lite'], ['タイムゾーン', 'Asia/Tokyo'], ['APIKEY', ''], ['PDF保存先ID', '']];
  var names = info.getRange(1, 1, Math.max(info.getLastRow(), 1), 1).getValues().map(function (r) { return String(r[0]).trim(); });
  defaults.forEach(function (d) {
    if (names.indexOf(d[0]) >= 0) return;
    var r = firstEmptyRowInA_(info);
    info.getRange(r, 1, 1, 2).setValues([d]);
    names[r - 1] = d[0];
  });
  return 'OK';
}

function ensureSheet_(ss, name, headers) {
  HEADER_ROWS_ = {};
  var sh = ss.getSheetByName(name) || ss.insertSheet(name);
  if (sh.getLastRow() === 0) {
    sh.getRange(1, 1, 1, headers.length).setValues([headers]).setFontWeight('bold');
    sh.setFrozenRows(1);
  }
  return sh;
}

/** 任意の列(見出し)が無ければ、見出し行の右端に足す。既存の列・値は変えない。 */
// ---------- 取り込んだ原本(PDF・画像)のDrive保存 ----------
// 保存先: 情報シートの項目「PDF保存先ID」(DriveのフォルダID)のフォルダ。空のときだけ、スプレッドシートと同じフォルダの中の「FAX原本」(無ければ作る)。画面からの表示は、保存先のフォルダとスプレッドシートのフォルダの中のファイルだけ。
var FAX_FOLDER_NAME = 'FAX原本';
var MAX_FAX_BYTES = 12 * 1024 * 1024;
function sheetFolder_() {
  var parents = DriveApp.getFileById(SpreadsheetApp.getActiveSpreadsheet().getId()).getParents();
  return parents.hasNext() ? parents.next() : DriveApp.getRootFolder();
}
function faxFolder_(create) {
  var id = getInfo_('PDF保存先ID');
  if (id) {
    try { return DriveApp.getFolderById(id); }
    catch (ex) { throw new Error('情報シートの「PDF保存先ID」のフォルダを開けません(IDの間違い、または、このスプレッドシートの所有者に権限がありません)。'); }
  }
  var parent = sheetFolder_();
  var it = parent.getFoldersByName(FAX_FOLDER_NAME);
  if (it.hasNext()) return it.next();
  return create ? parent.createFolder(FAX_FOLDER_NAME) : null;
}
/** 原本をDriveに保存して、そのURLを返す。ファイルが無い・取込一覧に「ファイルURL」の列が無いときは、何もせず空文字。 */
function saveFax_(body, now) {
  if (!body.fileBase64) return '';
  if (!headerMap_(sheet_(SHEET_IMPORT), [])['ファイルURL']) return '';
  var bytes = Utilities.base64Decode(body.fileBase64);
  if (bytes.length > MAX_FAX_BYTES) throw new Error('ファイルが大きすぎます。');
  var mime = body.fileMime || 'application/pdf';
  if (['application/pdf', 'image/png', 'image/jpeg'].indexOf(mime) < 0) throw new Error('対応していない形式です: ' + mime);
  var name = Utilities.formatDate(now, tz_(), 'yyyyMMdd_HHmmss') + '_' + String(body.filename || 'fax').replace(/[\\\/:*?"<>|]/g, '_');
  return faxFolder_(true).createFile(Utilities.newBlob(bytes, mime, name)).getUrl();
}
/** 画面でファイル名を押したときに、原本を返す(Base64)。許可するのは、スプレッドシートのフォルダと「FAX原本」の中のファイルだけ。 */
function getFile_(url) {
  var m = /\/d\/([\w-]{20,})|[?&]id=([\w-]{20,})/.exec(String(url || ''));
  if (!m) throw new Error('ファイルのURLが読み取れません。');
  var file = DriveApp.getFileById(m[1] || m[2]);
  var okIds = [sheetFolder_().getId()], fax = faxFolder_(false);
  if (fax) okIds.push(fax.getId());
  var inside = false, parents = file.getParents();
  while (parents.hasNext()) if (okIds.indexOf(parents.next().getId()) >= 0) inside = true;
  if (!inside) throw new Error('このファイルは、車番連絡の原本のフォルダの外にあるため、表示できません。');
  var mime = file.getMimeType();
  if (['application/pdf', 'image/png', 'image/jpeg'].indexOf(mime) < 0) throw new Error('PDF・PNG・JPEGのみ表示できます: ' + mime);
  var bytes = file.getBlob().getBytes();
  if (bytes.length > MAX_FAX_BYTES) throw new Error('ファイルが大きすぎます。');
  return { mime: mime, name: file.getName(), base64: Utilities.base64Encode(bytes) };
}

function ensureOptionalCols_(sh, cols) {
  HEADER_ROWS_ = {};
  var map = headerMap_(sh, []);
  cols.forEach(function (c) {
    if (map[c]) return;
    var col = sh.getLastColumn() + 1;
    sh.getRange(1, col).setValue(c).setFontWeight('bold');
    map[c] = col;
  });
  HEADER_ROWS_ = {}; // 見出しを足したので、読み直させる
}

function firstEmptyRowInA_(sh) {
  var vals = sh.getRange(1, 1, Math.max(sh.getLastRow(), 1) + 1, 1).getValues();
  for (var i = 0; i < vals.length; i++) if (String(vals[i][0]).trim() === '') return i + 1;
  return vals.length + 1;
}

// ---------- 情報シートの設定 ----------

// 情報シートのA・B列は、1回の実行(リクエスト)の中で1回だけ読む。日付セルを文字にするたびに読み直すと、行数に比例して遅くなる(2026-10-21に実測)。
// 工事一覧・手配業者の候補も同じ表から読むので、シートの読み込みは全体で1回(以前は3回)。
var INFO_GRID_ = null;
function infoGrid_() {
  if (INFO_GRID_ === null) {
    var sh = ss_().getSheetByName(SHEET_INFO);
    INFO_GRID_ = !sh || sh.getLastRow() < 1 ? [] : sh.getDataRange().getValues();
  }
  return INFO_GRID_;
}
function infoVals_() {
  return infoGrid_().map(function (r) { return [r.length > 0 ? r[0] : '', r.length > 1 ? r[1] : '']; });
}

function getInfo_(key) {
  var vals = infoVals_();
  for (var i = 0; i < vals.length; i++) if (String(vals[i][0]).trim() === key) return String(vals[i][1]).trim();
  return '';
}

var TZ_CACHE_ = null;
function tz_() {
  if (TZ_CACHE_ === null) TZ_CACHE_ = getInfo_('タイムゾーン') || 'Asia/Tokyo';
  return TZ_CACHE_;
}

/** 工事番号と工事名のリスト。「情報」シートの見出し「工事番号」「工事名」を探し、その下を空行まで読む。 */
function readProjects_() {
  var grid = infoGrid_();
  if (!grid.length || grid[0].length < 2) return [];
  var top = grid.slice(0, 6);
  var hr = -1, hc = -1;
  for (var r = 0; r < top.length && hr < 0; r++) {
    for (var c = 0; c < top[r].length - 1; c++) {
      if (String(top[r][c]).trim() === '工事番号' && String(top[r][c + 1]).trim() === '工事名') { hr = r; hc = c; break; }
    }
  }
  if (hr < 0) return [];
  var vals = grid.slice(hr + 1).map(function (r) { return [r[hc], r[hc + 1]]; });
  if (!vals.length) return [];
  var out = [];
  for (var i = 0; i < vals.length; i++) {
    var no = String(vals[i][0]).trim();
    if (!no) break;
    out.push({ 工事番号: no, 工事名: String(vals[i][1]).trim() });
  }
  return out;
}

/** 手配業者の候補。「情報」シートの見出し「手配業者」の下に、1行1社で書く(例: ナミツー / 大上)。無ければ既定。 */
function readSenders_() {
  var grid = infoGrid_();
  if (!grid.length) return DEFAULT_SENDERS.slice();
  var top = grid.slice(0, 6);
  for (var r = 0; r < top.length; r++) {
    for (var c = 0; c < top[r].length; c++) {
      if (String(top[r][c]).trim() !== '手配業者') continue;
      var out = [];
      for (var i = r + 1; i < grid.length; i++) { var v = String(grid[i][c]).trim(); if (!v) break; out.push(v); }
      return out.length ? out : DEFAULT_SENDERS.slice();
    }
  }
  return DEFAULT_SENDERS.slice();
}

// ---------- シート読み書き(見出し名ベース) ----------

// スプレッドシートは、1回の実行の中で1回だけ取得する(起動時の読み込みを速くするため。2026-10-22)。
var SS_ = null;
function ss_() { if (SS_ === null) SS_ = SpreadsheetApp.getActiveSpreadsheet(); return SS_; }

function sheet_(name) {
  var sh = ss_().getSheetByName(name);
  if (!sh) throw new Error('シート「' + name + '」がありません。setupSheetsを実行してください。');
  return sh;
}

function headerMap_(sh, required) {
  return headerMapOf_(headerRow_(sh), required, sh.getName());
}

/** シートの1行目の値の並び。1回の実行の中では、見出し行は変わらないので、シートごとに1回だけ読む(書き込みのたびに読み直さない。2026-10-22)。見出しを書き換える関数は、HEADER_ROWS_ を空にする。 */
var HEADER_ROWS_ = {};
function headerRow_(sh) {
  var k = sh.getName();
  if (!HEADER_ROWS_[k]) { var lastCol = sh.getLastColumn(); HEADER_ROWS_[k] = lastCol > 0 ? sh.getRange(1, 1, 1, lastCol).getValues()[0] : []; }
  return HEADER_ROWS_[k];
}

/** 1行目の値の並びから {見出し: 列番号(1始まり)} を作る。必須の見出しが無ければエラー。 */
function headerMapOf_(headRow, required, sheetName) {
  var map = {};
  headRow.forEach(function (h, i) {
    var n = String(h).trim();
    if (n && !map[n]) map[n] = i + 1;
  });
  (required || []).forEach(function (h) {
    if (!map[h]) throw new Error('シート「' + sheetName + '」の1行目に見出し「' + h + '」がありません。');
  });
  return map;
}

/** 日付を文字にする。Asia/Tokyo(夏時間なし・UTC+9固定)は、GASのサービスを呼ばずに計算する(Utilities.formatDateと同じ結果。Nodeで照合済み)。 */
function fmtDate_(d, withTime) {
  var tz = tz_();
  if (tz !== 'Asia/Tokyo') return Utilities.formatDate(d, tz, withTime ? 'yyyy/MM/dd HH:mm:ss' : 'yyyy/MM/dd');
  var t = new Date(d.getTime() + 9 * 60 * 60 * 1000);
  function p2(n) { return (n < 10 ? '0' : '') + n; }
  var ymd = t.getUTCFullYear() + '/' + p2(t.getUTCMonth() + 1) + '/' + p2(t.getUTCDate());
  return withTime ? ymd + ' ' + p2(t.getUTCHours()) + ':' + p2(t.getUTCMinutes()) + ':' + p2(t.getUTCSeconds()) : ymd;
}

function cellStr_(v) {
  if (Object.prototype.toString.call(v) === '[object Date]') {
    var withTime = v.getHours() || v.getMinutes() || v.getSeconds();
    return fmtDate_(v, withTime);
  }
  return String(v == null ? '' : v);
}

/** シートを {見出し: 値(文字列)} の配列にする。_row=シートの行番号。optional の列は、あれば読む(無ければ空)。 */
function readRows_(sh, headers, firstRow, lastRow, optional) {
  var map = headerMap_(sh, headers);
  var total = sh.getLastRow();
  var from = Math.max(firstRow || 2, 2), to = Math.min(lastRow || total, total);
  if (to < from) return [];
  var width = sh.getLastColumn();
  var vals = sh.getRange(from, 1, to - from + 1, width).getValues();
  return rowsFromVals_(vals, map, headers, from, optional);
}

/** 値の並び(vals。先頭=シートのfirst行目)を {見出し: 値(文字列)} の配列にする。見出しの列がすべて空の行は除く。 */
function rowsFromVals_(vals, map, headers, from, optional) {
  var out = [];
  for (var i = 0; i < vals.length; i++) {
    var o = { _row: from + i };
    var any = false;
    headers.forEach(function (h) {
      var s = cellStr_(vals[i][map[h] - 1]);
      o[h] = s;
      if (s !== '') any = true;
    });
    (optional || []).forEach(function (h) { o[h] = map[h] ? cellStr_(vals[i][map[h] - 1]) : ''; });
    if (any) out.push(o);
  }
  return out;
}

function parseDate_(s) {
  var m = /^(\d{4})\/(\d{1,2})\/(\d{1,2})$/.exec(String(s || '').trim());
  return m ? new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3])) : String(s || '');
}

/** 1行を書く。row が null なら末尾に追加。obj は {見出し: 値}。 */
/** 列番号(1始まり)→A1表記の列(1→A、27→AA) */
function colLetter_(n) { var t = ''; while (n > 0) { var m = (n - 1) % 26; t = String.fromCharCode(65 + m) + t; n = Math.floor((n - 1) / 26); } return t; }

/** 1行を書く。row が null なら末尾に追加(1回の書き込みで、行全体を書く)。既存の行を更新するときは、渡された項目のセルだけを書く(他のセルは変えない)。
 *  表示形式(文字・日付・日時)は、セルの範囲をまとめて1回で設定する。以前は1セルずつ(1行の追加で約48回のAPI呼び出し)だった。 */
function writeRow_(sh, headers, rowNo, obj) {
  var row = headerRow_(sh), map = headerMapOf_(row, headers, sh.getName());
  var r = rowNo || (sh.getLastRow() + 1);
  var keys = Object.keys(obj).filter(function (h) { return map[h]; });
  var fmt = { text: [], date: [], stamp: [] };
  keys.forEach(function (h) {
    var a1 = colLetter_(map[h]) + r;
    if (TEXT_COLS.indexOf(h) >= 0) fmt.text.push(a1);
    else if (DATE_COLS.indexOf(h) >= 0) fmt.date.push(a1);
    else if (h === 'タイムスタンプ') fmt.stamp.push(a1);
  });
  if (fmt.text.length) sh.getRangeList(fmt.text).setNumberFormat('@');
  if (fmt.date.length) sh.getRangeList(fmt.date).setNumberFormat('yyyy/MM/dd');
  if (fmt.stamp.length) sh.getRangeList(fmt.stamp).setNumberFormat('yyyy/MM/dd HH:mm:ss');
  function val(h) { return DATE_COLS.indexOf(h) >= 0 ? parseDate_(obj[h]) : obj[h]; }
  if (!rowNo) {
    var line = []; for (var i = 0; i < row.length; i++) line.push('');
    keys.forEach(function (h) { line[map[h] - 1] = val(h); });
    sh.getRange(r, 1, 1, row.length).setValues([line]);
  } else {
    keys.forEach(function (h) { sh.getRange(r, map[h]).setValue(val(h)); });
  }
  return r;
}

// ---------- API ----------

function jsonOut_(payload) {
  return ContentService.createTextOutput(JSON.stringify(payload)).setMimeType(ContentService.MimeType.JSON);
}
function ok_(data) { return jsonOut_({ status: 'success', data: data }); }
function err_(message) { return jsonOut_({ status: 'error', message: String(message) }); }

function doGet(e) {
  try {
    var a = e.parameter.action;
    if (a === 'init') return ok_(getInit_());
    if (a === 'getFile') return ok_(getFile_(e.parameter.url));
    if (a === 'listImports') return ok_(listImports_(Number(e.parameter.limit) || 300));
    if (a === 'ping') return ok_({ pong: true, version: CODE_VERSION });
    return err_('不明なaction: ' + a);
  } catch (ex) { return err_(ex.message); }
}

function doPost(e) {
  try {
    var body = JSON.parse(e.postData.contents);
    if (body.action === 'ocr') return ok_(ocr_(body));
    if (body.action === 'commit') return ok_(withLock_(function () { return commit_(body); }));
    if (body.action === 'updateImport') return ok_(withLock_(function () { return updateImport_(body); }));
    if (body.action === 'applyChanges') return ok_(withLock_(function () { return applyChanges_(body); }));
    if (body.action === 'masterSave') return ok_(withLock_(function () { return masterSave_(body); }));
    return err_('不明なaction: ' + body.action);
  } catch (ex) { return err_(ex.message); }
}

function withLock_(fn) {
  var lock = LockService.getScriptLock();
  lock.waitLock(30000);
  try { return fn(); } finally { lock.releaseLock(); }
}

/** シート全体を1回の読み込みで、{見出し: 値} の配列にする(起動時用。読み込みの回数を減らして速くする)。map=見出し→列番号 */
function readAll_(name, headers, optional) {
  var all = sheet_(name).getDataRange().getValues();
  var map = headerMapOf_(all.length ? all[0] : [], headers, name);
  return { map: map, rows: rowsFromVals_(all.slice(1), map, headers, 2, optional) };
}

function getInit_() {
  var imp = readAll_(SHEET_IMPORT, ['積日', '行先', '工事番号', '現場名', '車番'], ['追加変更']);
  var impRows = imp.rows;
  var activeRows = impRows.filter(function (r) { return INACTIVE_LABELS.indexOf(r.追加変更) < 0; });
  var pairs = readAll_(SHEET_MERGED, MERGED_HEADERS).rows;
  try { syncTypeNotes_(pairs); } catch (e) { /* 備考の自動記入に失敗しても、表示は続ける */ }
  return {
    pairs: pairs, // 車両運転手情報の全行(画面の表)
    vehicles: pairsToVehicles_(pairs), // 照合用: 車番ごとに1件(同じ車に複数の運転手がいても1件)
    drivers: pairsToDrivers_(pairs), // 照合用: 運転手ごとに1件(複数の車に乗っても1件)
    projects: readProjects_(),
    importKeys: activeRows.map(function (r) { return { 積日: r.積日, 車番: r.車番 }; }), // 中止・変更前の行は、重複の判定に使わない
    pastDest: impRows.slice(-PAST_DEST_ROWS).map(function (r) { return { 行先: r.行先, 工事番号: r.工事番号, 現場名: r.現場名 }; }),
    version: CODE_VERSION,
    senders: readSenders_(),
    model: getInfo_('Geminiモデル名'),
    keyOk: getInfo_('APIKEY') !== ''
  };
}

function listImports_(limit) {
  var sh = sheet_(SHEET_IMPORT);
  var last = sh.getLastRow();
  var rows = readRows_(sh, IMPORT_HEADERS, Math.max(2, last - limit + 1), last, IMPORT_OPTIONAL);
  return rows.reverse();
}

// ---------- Gemini(FAXのPDF・画像を読み取る) ----------

var OCR_PROMPT_ = [
  'これは運送トラックの車番連絡FAX(配車連絡表)をスキャンしたものです。内容を次のJSONだけで返してください(前置き・説明は不要)。',
  '{"業者":"","FAX日付":"","区分":"","メモ":"","回転":0,"明細":[{"積日":"","卸日":"","行先":"","着時間":"","運送業者":"","車種":"","車番":"","氏名":"","携帯番号":"","備考":"","取消線":false}]}',
  'ルール:',
  '- 業者: このFAXを送ってきた会社(発信元)。次の名前のうち、発信元に当たるものを、その名前だけで答える: {{senders}}。どれにも当たらないときだけ、発信元の会社名を書かれたとおりに書く(「御中」「様」が付いている側は宛先なので業者ではありません)。',
  '- FAX日付: FAXの日付(本文の日付、または余白の受信印の日付)をyyyy-mm-ddで。読めなければ空文字。',
  '- 区分: 「新規」「変更」「追加」「取消」のどれか。「再」「訂正」「変更」の印や文言があれば「変更」、「追加」「増車」なら「追加」、「取消」「キャンセル」なら「取消」。何も無ければ「新規」。',
  '- メモ: FAXに書かれた連絡の文言(例: 「変更すみません。宜しくお願い致します。」)。印字の定型のあいさつ(「いつもお世話になっております」「ご確認を宜しくお願い致します」など)は含めない。手書きや追記の文字があれば含める。無ければ空文字。',
  '- 備考: その行の「備考」「特記」「荷種」「入場予定時間」など、上の項目に当てはまらない欄に書かれた文字。欄名が「備考」以外のときは「欄名:内容」の形(例: 「特記:午前着希望」「荷種:鉄骨」)で、複数あれば「 / 」でつなぐ。書かれていなければ空文字。',
  '- 回転: 書類の文字が正しく読める向きにするには、画像を時計回りに何度回せばよいか。0・90・180・270のどれか(正しい向きならば0。例: 文字が上から下へ縦に並び、右に90度倒れているなら270)。',
  '- 明細: 車両1台=1要素。記入のない空欄の行や、連絡の文言だけの行は含めない。',
  '- 取消線: 文字や行に横線(取消線)が引かれていればtrue、なければfalse。変更後の内容は、通常、取消線の下の行(矢印↓の下)に書かれる。取消線で消された文字は読みにくいが、読める範囲で読む。',
  '- 積日・卸日: yyyy-mm-dd。年が書かれていなければFAX日付の年(今日は{{today}})。「10/ 20 (火)」のように分かれていても1つの日付として読む。',
  '- 変更後の行で、積日・卸日・行先・車種が空欄のときは、他の行から補わず空文字にする。',
  '- 行先: 卸地(降地)。積地ではない。',
  '- 着時間: 卸しの着時間(「8:00着」なら8:00)。書かれていなければ空文字。',
  '- 運送業者: 実際に走る運送会社(「運送会社」「会社名」の欄)。業者(FAXの送り主)とは別の場合があります。',
  '- 車種: 10t、4T平 など書かれたまま。',
  '- 車番: ナンバー(地名・分類番号・かな・番号)をスペースなしでそのまま。',
  '- 氏名: 運転手の氏名(スペースなし)。',
  '- 携帯番号: 数字とハイフンのみ。',
  '- 読み取れない文字は推測せず、その項目を空文字にする。書かれていない情報を作らない。'
].join('\n');

function ocr_(body) {
  if (!body.base64) throw new Error('ファイルの内容がありません。');
  var mime = body.mimeType || 'application/pdf';
  if (['application/pdf', 'image/png', 'image/jpeg'].indexOf(mime) < 0) throw new Error('対応していない形式です(PDF・PNG・JPEGのみ): ' + mime);
  var today = Utilities.formatDate(new Date(), tz_(), 'yyyy-MM-dd');
  var text = callGemini_([
    { text: OCR_PROMPT_.replace('{{today}}', today).replace('{{senders}}', readSenders_().join(' / ')) },
    { inline_data: { mime_type: mime, data: body.base64 } }
  ]);
  return { raw: parseJsonText_(text) };
}

function parseJsonText_(text) {
  var t = String(text || '').trim().replace(/^```(?:json)?\s*/i, '').replace(/```\s*$/, '').trim();
  try { return JSON.parse(t); } catch { throw new Error('読み取り結果をJSONとして解釈できませんでした。もう一度お試しください。'); }
}

function callGemini_(parts) {
  var model = getInfo_('Geminiモデル名');
  if (!model) throw new Error('情報シートの「Geminiモデル名」が空です。');
  var key = getInfo_('APIKEY');
  if (!key) throw new Error('情報シートの「APIKEY」が空です。');
  var url = 'https://generativelanguage.googleapis.com/v1beta/models/' + encodeURIComponent(model) + ':generateContent';
  var payload = {
    contents: [{ role: 'user', parts: parts }],
    generationConfig: { temperature: 0, responseMimeType: 'application/json' }
  };
  var last = '';
  for (var attempt = 1; attempt <= 3; attempt++) {
    var res = UrlFetchApp.fetch(url, {
      method: 'post',
      contentType: 'application/json',
      headers: { 'x-goog-api-key': key },
      payload: JSON.stringify(payload),
      muteHttpExceptions: true
    });
    var code = res.getResponseCode();
    var raw = res.getContentText();
    var json = null;
    try { json = JSON.parse(raw); } catch { /* 本文がJSONでない(エラーページなど) */ }
    if (code === 200 && json) {
      var cand = json.candidates && json.candidates[0];
      var txt = cand && cand.content && cand.content.parts && cand.content.parts.map(function (p) { return p.text || ''; }).join('');
      if (txt) return txt;
      throw new Error('Geminiから読み取り結果が返りませんでした' + (cand && cand.finishReason ? '(' + cand.finishReason + ')' : '') + '。');
    }
    last = 'Gemini APIエラー(HTTP ' + code + '): ' + (json && json.error ? json.error.message : raw.slice(0, 200));
    if (code !== 429 && code < 500) break;
    Utilities.sleep(2000 * attempt);
  }
  throw new Error(last.replace(key, '***'));
}

// ---------- 記録(取込一覧への追記+車両・運転手情報の更新) ----------

function commit_(body) {
  var rows = body.rows || [];
  if (!rows.length) throw new Error('記録する行がありません。');
  if (rows.length > MAX_ROWS_PER_COMMIT) throw new Error('一度に記録できるのは' + MAX_ROWS_PER_COMMIT + '行までです。');
  var imp = sheet_(SHEET_IMPORT);
  var source = body.filename || '';
  var ops = body.ops || [];
  var opCount = 0;
  ops.forEach(function (op) { applyOp_(op); opCount++; });
  var now = new Date(), fileUrl = '', fileWarn = '';
  try { fileUrl = saveFax_(body, now); } catch (ex) { fileWarn = ex.message; } // 原本の保存に失敗しても、記録は止めない
  rows.forEach(function (r) { writeRow_(imp, IMPORT_HEADERS, null, importObj_(r, now, source, '', fileUrl)); });
  var pairInfo = safePairs_(rows);
  return { added: rows.length, ops: opCount, fileUrl: fileUrl, fileWarn: fileWarn, pairs: pairInfo };
}

/** 画面の行({業者, 積日, ...})を、取込一覧の見出し名つきの値にする。 */
function importObj_(r, now, source, label, fileUrl) {
  return {
    'ファイルURL': fileUrl || '',
    '追加変更': label || '', '備考': r.備考 || '',
    'タイムスタンプ': now, 'ファイル名': source,
    '工事番号': r.工事番号 || '', '現場名': r.現場名 || '',
    '手配業者': r.業者 || '', '業者': r.業者 || '',
    '積日': r.積日 || '', '卸日': r.卸日 || '', '行先': r.行先 || '', '着時間': r.着時間 || '',
    '運送業者': r.運送業者 || '', '車種': r.車種 || '', '車番': r.車番 || '', '氏名': r.氏名 || '', '携帯番号': r.携帯番号 || ''
  };
}

// ---------- 変更・追加・取消(一度受領した連絡の続報) ----------

function sameRecord_(cur, before) {
  for (var i = 0; i < CHECK_FIELDS.length; i++) {
    var h = CHECK_FIELDS[i];
    if (String(cur[h]) !== String(before && before[h] != null ? before[h] : '')) return h;
  }
  return '';
}

// 取込一覧の行を、画面から直す(行の削除はできない)。編集できる項目だけを、変更前の値の照合つきで書き換える。
var EDITABLE_IMPORT = ['工事番号', '現場名', '手配業者', '積日', '卸日', '行先', '着時間', '運送業者', '車種', '車番', '氏名', '携帯番号', '追加変更', '備考'];
function updateImport_(body) {
  var imp = sheet_(SHEET_IMPORT);
  var row = Number(body.row);
  var cur = readRows_(imp, IMPORT_HEADERS, row, row, IMPORT_OPTIONAL)[0];
  if (!cur) throw new Error('取込一覧の行(' + body.row + ')が見つかりません。画面を再読み込みしてください。');
  var bad = sameRecord_(cur, body.before);
  if (bad) throw new Error('取込一覧の行(' + row + ')が他の操作で変更されています(' + bad + ')。画面を再読み込みしてください。');
  var data = body.data || {}, obj = {};
  Object.keys(data).forEach(function (k) {
    if (EDITABLE_IMPORT.indexOf(k) < 0) throw new Error('この項目は直せません: ' + k);
    obj[k] = String(data[k] == null ? '' : data[k]).trim();
  });
  if ('車番' in obj && !obj.車番) throw new Error('車番は空にできません。');
  if ('追加変更' in obj && ['', '変更前', '変更後', '中止'].indexOf(obj.追加変更) < 0) throw new Error('「追加変更」の値が不正です: ' + obj.追加変更);
  ['積日', '卸日'].forEach(function (k) { if (obj[k] && !/^\d{4}\/\d{1,2}\/\d{1,2}$/.test(obj[k])) throw new Error(k + 'は 2026/10/20 の形で入力してください。'); });
  writeRow_(imp, IMPORT_HEADERS, row, obj);
  return { ok: true, row: row };
}

/** items: [{mode:'mark', row, label:'変更前'|'中止', before, note}, {mode:'add', data, label}]。
 *  PDFで取り込んだ行は取込一覧に必ず残す: 行の削除・内容の上書きはしない。
 *  mark = 元の行の「追加変更」を 変更前 / 中止 にする(車両台数に数えない行にする)。add = 新しい行を追加(label=変更後 など)。
 *  先に全件の「変更前の値」を検証してから書き込む(他の操作で変わっていたら、何も変えずに止める)。 */
function applyChanges_(body) {
  var items = body.items || [];
  if (!items.length) throw new Error('反映する内容がありません。');
  if (items.length > MAX_ROWS_PER_COMMIT) throw new Error('一度に反映できるのは' + MAX_ROWS_PER_COMMIT + '件までです。');
  var imp = sheet_(SHEET_IMPORT);
  var hasLabelCol = !!headerMap_(imp, [])['追加変更'];
  var source = body.filename || '';
  items.forEach(function (it) {
    if (it.mode === 'add') return;
    if (it.mode !== 'mark') throw new Error('不明な操作です(行の削除・上書きはできません): ' + it.mode);
    if (INACTIVE_LABELS.indexOf(it.label) < 0) throw new Error('「追加変更」の値が不正です: ' + it.label);
    if (!hasLabelCol) throw new Error('取込一覧の1行目に見出し「追加変更」がありません。');
    var cur = readRows_(imp, IMPORT_HEADERS, it.row, it.row, IMPORT_OPTIONAL)[0];
    if (!cur) throw new Error('取込一覧の行(' + it.row + ')が見つかりません。画面を再読み込みしてください。');
    var bad = sameRecord_(cur, it.before);
    if (bad) throw new Error('取込一覧の行(' + it.row + ')が他の操作で変更されています(' + bad + ')。画面を再読み込みしてください。');
  });
  var opCount = 0;
  (body.ops || []).forEach(function (op) { applyOp_(op); opCount++; });
  var now = new Date(), fileUrl = '', fileWarn = '';
  if (items.some(function (it) { return it.mode === 'add'; })) { try { fileUrl = saveFax_(body, now); } catch (ex) { fileWarn = ex.message; } } // 原本の保存に失敗しても、反映は止めない
  var n = { marked: 0, added: 0 };
  // 元の行に印を付ける(行番号は変わらない)
  items.filter(function (it) { return it.mode === 'mark'; }).forEach(function (it) {
    var obj = { '追加変更': it.label };
    if (it.note) obj['備考'] = it.note;
    writeRow_(imp, IMPORT_HEADERS, it.row, obj);
    n.marked++;
  });
  // 新しい行を追加
  items.filter(function (it) { return it.mode === 'add'; }).forEach(function (it) {
    writeRow_(imp, IMPORT_HEADERS, null, importObj_(it.data, now, source, it.label || '', fileUrl));
    n.added++;
  });
  var pairInfo = safePairs_(items.filter(function (it) { return it.mode === 'add' && INACTIVE_LABELS.indexOf(it.label) < 0; }).map(function (it) { return it.data; })); // 「中止」の行は、組み合わせを追加しない
  return { marked: n.marked, added: n.added, ops: opCount, fileUrl: fileUrl, fileWarn: fileWarn, pairs: pairInfo };
}

// ---------- 照合用の正規化(全角・空白・表記の違いをそろえる。画面の logic.js と同じ規則) ----------

function nfkc_(s) {
  var t = String(s == null ? '' : s);
  if (typeof t.normalize === 'function') return t.normalize('NFKC');
  return t.replace(/[\uFF01-\uFF5E]/g, function (c) { return String.fromCharCode(c.charCodeAt(0) - 0xFEE0); }).replace(/\u3000/g, ' ').replace(/\u3231/g, '(株)').replace(/\u3232/g, '(有)');
}
function compact_(s) { return nfkc_(s).replace(/[\s\u3000]+/g, ''); }
function typeKey_(s) { return compact_(s).toLowerCase(); }
/** 車種が同じ(どちらかが空欄のときも同じ扱い。空欄の車種では、別の車と決めつけない) */
function sameType_(a, b) { var x = typeKey_(a), y = typeKey_(b); return !x || !y || x === y; }
function plateKey_(s) { return compact_(s).replace(/[-‐-―−ー・.]/g, '').toLowerCase(); }
function companyKey_(s) { return compact_(s).replace(/\(株\)|\(有\)|\(合\)|\(同\)|株式会社|有限会社|合同会社/g, '').replace(/[()・]/g, '').toLowerCase(); }
function phoneDigits_(s) { return nfkc_(s).replace(/\D/g, ''); }
function fmtPhone_(s) {
  var d = phoneDigits_(s);
  if (d.length === 11) return d.replace(/(\d{3})(\d{4})(\d{4})/, '$1-$2-$3');
  if (d.length === 10) return /^0[36]/.test(d) ? d.replace(/(\d{2})(\d{4})(\d{4})/, '$1-$2-$3') : d.replace(/(\d{3})(\d{3})(\d{4})/, '$1-$2-$3');
  return nfkc_(s).replace(/[\s\u3000]+/g, ' ').trim();
}
function fmtType_(s) { return nfkc_(s).replace(/[\s\u3000]+/g, '').replace(/(\d)T/g, '$1t'); }

// ---------- 車両運転手情報(車と運転手の組み合わせ)の読み書き ----------
// 画面の照合(logic.js)は、「車両」と「運転手」の2つの一覧を前提にしている。そのため、車両運転手情報の行から、車番ごと・運転手ごとに1件の一覧を作って返す(pairsToVehicles_ / pairsToDrivers_)。
// 車・運転手を登録・更新する操作(op: vehicle / driver)は、車両運転手情報の行に対する操作に読み替える(applyOp_)。FAXの1行ごとの「車と運転手の組み合わせ」は、記録のあとで ensurePairs_ が追加する。

/** 運転手の同一判定: 両方に携帯番号があれば番号で、無ければ氏名(運送業者の書き方の違いは同じ会社とみなす) */
function sameDriver_(a, b) {
  var pa = phoneDigits_(a.携帯番号), pb = phoneDigits_(b.携帯番号);
  if (pa && pb) return pa === pb;
  var na = compact_(a.氏名), nb = compact_(b.氏名);
  if (!na || !nb || na !== nb) return false;
  var ca = companyKey_(a.運送業者), cb = companyKey_(b.運送業者);
  return !ca || !cb || ca === cb || ca.indexOf(cb) >= 0 || cb.indexOf(ca) >= 0;
}
function hasDriver_(r) { return !!(compact_(r.氏名) || phoneDigits_(r.携帯番号)); }

function pairsToVehicles_(pairs) {
  var seen = {}, out = [];
  pairs.forEach(function (r) {
    var k = plateKey_(r.車番);
    if (!k || seen[k]) return;
    seen[k] = true;
    out.push({ _row: r._row, 手配業者: r.手配業者, 運送業者: r.運送業者, 車種: r.車種, 車番: r.車番 });
  });
  return out;
}
function pairsToDrivers_(pairs) {
  var out = [];
  pairs.forEach(function (r) {
    if (!hasDriver_(r)) return;
    for (var i = 0; i < out.length; i++) if (sameDriver_(out[i], r)) return; // 運転手の代表の行は、最初の行(更新の照合に使う)
    out.push({ _row: r._row, 運送業者: r.運送業者, 氏名: r.氏名, 携帯番号: r.携帯番号 });
  });
  return out;
}

var PAIR_VEHICLE_FIELDS = ['手配業者', '運送業者', '車種', '車番'];
var PAIR_DRIVER_FIELDS = ['運送業者', '氏名', '携帯番号'];

function mergedRowsNow_() { return readAll_(SHEET_MERGED, MERGED_HEADERS).rows; }
function mergedWrite_(rowNo, obj) { return writeRow_(sheet_(SHEET_MERGED), MERGED_HEADERS, rowNo, obj); }

/** 変更前の値との照合(他の人が先に変えていたら止める) */
function mergedCheckBefore_(now, before, fields, label) {
  fields.forEach(function (f) {
    if (!Object.prototype.hasOwnProperty.call(before || {}, f)) return;
    if (String(now[f]) !== String(before[f] == null ? '' : before[f])) throw new Error(label + 'が他の操作で変更されています(' + f + ')。画面を再読み込みしてください。');
  });
}
function mergedRowAt_(rowNo, label) {
  var now = readRows_(sheet_(SHEET_MERGED), MERGED_HEADERS, rowNo, rowNo)[0];
  if (!now) throw new Error(label + 'の行(' + rowNo + ')が見つかりません。画面を再読み込みしてください。');
  return now;
}
function mergedDefaults_() { var o = {}; MERGED_HEADERS.forEach(function (h) { o[h] = ''; }); return o; }

/** op: {kind:'vehicle'|'driver'|'pair', mode:'add'|'update'|'delete', row, before, data}
 *  vehicle/driver(FAX取込の自動登録・食い違いの更新): 車・運転手を、車両運転手情報の行に読み替える。
 *  pair(「車両・運転手情報」の表の編集・削除): 行そのものを操作する。 */
function applyOp_(op) {
  var kind = op.kind, mode = op.mode;
  if (kind === 'pair') {
    var now = mergedRowAt_(op.row, '車両・運転手情報');
    if (mode === 'update') { mergedCheckBefore_(now, op.before, MERGED_HEADERS, '車両・運転手情報'); mergedWrite_(op.row, op.data); return; }
    if (mode === 'delete') { mergedCheckBefore_(now, op.before, MERGED_HEADERS, '車両・運転手情報'); sheet_(SHEET_MERGED).deleteRow(op.row); return; }
    throw new Error('不明な操作: ' + mode);
  }
  if (kind === 'vehicle') {
    if (mode === 'add') { // 車だけの行(運転手は、記録のあとの組み合わせの追加で入る)
      var v = mergedDefaults_(); PAIR_VEHICLE_FIELDS.forEach(function (f) { v[f] = op.data[f] || ''; });
      mergedWrite_(null, v); return;
    }
    if (mode === 'update') { // その車番のすべての行(別の運転手の行を含む)を更新する
      var cur = mergedRowAt_(op.row, '車両');
      mergedCheckBefore_(cur, op.before, PAIR_VEHICLE_FIELDS, '車両');
      var key = plateKey_(cur.車番);
      mergedRowsNow_().forEach(function (r) { if (plateKey_(r.車番) === key) mergedWrite_(r._row, pick_(op.data, PAIR_VEHICLE_FIELDS)); });
      return;
    }
    throw new Error('不明な操作: ' + mode);
  }
  if (kind === 'driver') {
    if (mode === 'add') { // 運転手だけの行(車は、記録のあとの組み合わせの追加で入る)
      var d = mergedDefaults_(); PAIR_DRIVER_FIELDS.forEach(function (f) { d[f] = op.data[f] || ''; });
      mergedWrite_(null, d); return;
    }
    if (mode === 'update') { // その運転手のすべての行(複数の車に乗る行を含む)を更新する。運転手の「車種」は、車の側の列なので、ここでは扱わない
      var rep = mergedRowAt_(op.row, '運転手');
      mergedCheckBefore_(rep, op.before, PAIR_DRIVER_FIELDS, '運転手');
      mergedRowsNow_().forEach(function (r) { if (sameDriver_(r, rep)) mergedWrite_(r._row, pick_(op.data, PAIR_DRIVER_FIELDS)); });
      return;
    }
    throw new Error('不明な操作: ' + mode);
  }
  throw new Error('不明な種別: ' + kind);
}
function pick_(obj, keys) { var o = {}; keys.forEach(function (k) { if (obj && Object.prototype.hasOwnProperty.call(obj, k)) o[k] = obj[k]; }); return o; }

/** 運送業者の書き方の違いは同じ会社とみなす(一方が他方に含まれていれば同じ。画面の logic.js の sameCo と同じ規則) */
function sameCo_(a, b) { var x = companyKey_(a), y = companyKey_(b); return !!x && !!y && (x === y || x.indexOf(y) >= 0 || y.indexOf(x) >= 0); }
/** 手配業者の書き方を、候補(情報シートの一覧。例: 大上・ナミツー)の名前にそろえる。当てはまらなければ、そのまま */
function canonSender_(v, cands) {
  var k = companyKey_(v);
  for (var i = 0; i < cands.length; i++) { var ck = companyKey_(cands[i]); if (ck && k.indexOf(ck) >= 0) return nfkc_(cands[i]).replace(/[\s\u3000]+/g, ' ').trim(); }
  return nfkc_(v).replace(/[\s\u3000]+/g, ' ').trim();
}
function senderRank_(n) { var k = companyKey_(n); return k.indexOf(companyKey_('大上')) >= 0 ? 0 : (k.indexOf(companyKey_('ナミツー')) >= 0 ? 1 : 2); }

/** 「手配業者は別だが、運送業者・車種・車番・氏名・携帯番号は同じ」(大上が手配していた組み合わせを、ナミツーも手配した)とき、その行の備考に「大上/ナミツー」を書く。
 *  手配業者の列は変えない。備考に他の文字(例: 10t/高TR)があれば残し、後ろに足す。既に両方が書かれていれば何もしない。書いたら true。 */
function addSenderNote_(row, r) {
  var s1 = String(row.手配業者 || '').trim(), s2 = String(r.業者 || r.手配業者 || '').trim();
  if (!s1 || !s2 || sameCo_(s1, s2) || !sameCo_(row.運送業者, r.運送業者)) return false;
  var cands = readSenders_(), a = canonSender_(s1, cands), b = canonSender_(s2, cands);
  if (a === b) return false;
  var note = String(row.備考 || ''), names = {}, other = note;
  names[a] = 1; names[b] = 1;
  cands.forEach(function (c) { var cn = nfkc_(c).trim(); if (cn && note.indexOf(cn) >= 0) { names[cn] = 1; other = other.split(cn).join(''); } });
  other = other.replace(/^[\s\u3000\/／]+|[\s\u3000\/／]+$/g, '').replace(/[\/／]{2,}/g, '/');
  var list = Object.keys(names).sort(function (x, y) { return senderRank_(x) - senderRank_(y) || (x < y ? -1 : x > y ? 1 : 0); }).join('/');
  var next = other ? other + ' ' + list : list;
  if (next === note) return false;
  mergedWrite_(row._row, { 備考: next }); row.備考 = next;
  return true;
}

/** 取込一覧への記録は済んでいるので、組み合わせの追加に失敗しても、記録は取り消さない(失敗は結果に入れて、画面で知らせる) */
function safePairs_(rowsData) {
  try { var r = ensurePairs_(rowsData); r.ok = true; return r; }
  catch (e) { return { ok: false, error: String(e && e.message || e) }; }
}

/** 記録した行(取込一覧に追加した行)ごとに、「車と運転手の組み合わせ」が車両運転手情報に無ければ追加する。
 *  行は、noPair(「登録しない」「今回だけこの値」を選んだ行)・車番なし・運転手なしのものを除く。
 *  ① 同じ車番・同じ運転手の行が既にあれば何もしない ② 同じ車番で運転手が空欄の行があれば、そこに運転手を入れる
 *  ③ 同じ運転手で車番が空欄の行があれば、そこに車を入れる ④ どれも無ければ新しい行を追加する(手配業者・運送業者は、同じ車番の行があればその値、無ければFAXの値。車種はFAXの値)。
 *  ①の「同じ」は、車種も同じこと(同じ車番・同じ運転手でも、車種が違えば別の車として別の行にする。例: 神戸131う3002 を 高TR と 10t で運転)。
 *  ②と③が両方あるとき(車も運転手も新規登録した直後)は、②に運転手を入れて、③の行は消す。 */
function ensurePairs_(rowsData) {
  var pairs = mergedRowsNow_(), toDelete = [], added = 0, filled = 0, noted = 0;
  rowsData.forEach(function (r) {
    if (r.noPair) return;
    var pk = plateKey_(r.車番);
    var drv = { 運送業者: r.運送業者, 氏名: r.氏名, 携帯番号: r.携帯番号 };
    if (!pk || !hasDriver_(drv)) return;
    var plateRows = pairs.filter(function (x) { return plateKey_(x.車番) === pk && x._deleted !== true; });
    var exact = plateRows.filter(function (x) { return hasDriver_(x) && sameDriver_(x, drv) && sameType_(x.車種, r.車種); })[0]; // 同じ車番・同じ運転手でも、車種が違えば別の車(別の行)
    if (exact) { if (addSenderNote_(exact, r)) noted++; return; } // ① 既にある(手配業者だけが違うときは、備考に「大上/ナミツー」を書く)
    // 既に登録されている同じ運転手の氏名・携帯番号の表記を、そのまま使う
    var known = null;
    pairs.some(function (x) { if (x._deleted !== true && hasDriver_(x) && sameDriver_(x, drv)) { known = x; return true; } return false; });
    var name = known ? known.氏名 : compact_(r.氏名), phone = known ? (known.携帯番号 || (phoneDigits_(r.携帯番号) ? fmtPhone_(r.携帯番号) : '')) : (phoneDigits_(r.携帯番号) ? fmtPhone_(r.携帯番号) : '');
    var blankDriver = plateRows.filter(function (x) { return !hasDriver_(x); })[0];
    var driverOnly = pairs.filter(function (x) { return x._deleted !== true && !plateKey_(x.車番) && hasDriver_(x) && sameDriver_(x, drv); })[0];
    if (blankDriver) { // ②
      var o2 = { 氏名: name, 携帯番号: phone }; if (driverOnly && driverOnly.備考 && !blankDriver.備考) o2.備考 = driverOnly.備考;
      mergedWrite_(blankDriver._row, o2); blankDriver.氏名 = name; blankDriver.携帯番号 = phone; filled++;
      if (driverOnly) { driverOnly._deleted = true; toDelete.push(driverOnly._row); }
      return;
    }
    if (driverOnly) { // ③
      var base = plateRows[0];
      var o3 = { 手配業者: base ? base.手配業者 : nfkc_(r.業者 || r.手配業者 || '').trim(), 運送業者: base ? base.運送業者 : nfkc_(r.運送業者).trim(), 車種: base ? base.車種 : fmtType_(r.車種), 車番: base ? base.車番 : compact_(r.車番) };
      mergedWrite_(driverOnly._row, o3); Object.keys(o3).forEach(function (k) { driverOnly[k] = o3[k]; }); filled++;
      return;
    }
    var b = plateRows[0]; // ④
    var nr = { 手配業者: b ? b.手配業者 : nfkc_(r.業者 || r.手配業者 || '').trim(), 運送業者: b ? b.運送業者 : nfkc_(r.運送業者).trim(), 車種: fmtType_(r.車種) || (b ? b.車種 : ''), 車番: b ? b.車番 : compact_(r.車番), 氏名: name, 携帯番号: phone, 備考: '' };
    var rowNo = mergedWrite_(null, nr); nr._row = rowNo; pairs.push(nr); added++;
  });
  syncTypeNotes_(pairs); // 運転手が複数の車種に乗るときの備考(行の削除より前に書く)
  toDelete.sort(function (a, b) { return b - a; }).forEach(function (n) { sheet_(SHEET_MERGED).deleteRow(n); }); // 下の行から消す(行番号がずれないように)
  return { added: added, filled: filled, removed: toDelete.length, noted: noted };
}

/** 車種の並び順(4t→10t→15t→TR→その他)。画面の logic.js の typeRank と同じ */
function typeRank_(t) {
  var m = /(\d+(?:\.\d+)?)t/i.exec(compact_(t));
  if (m) return +m[1];
  return /TR/i.test(compact_(t)) ? 1000 : 2000;
}
/** 同じ運転手が、車種の違う車に乗る(車両運転手情報に、車種違いの行が2つ以上ある)とき、その運転手のどの行の備考にも、車種を「10t/高TR」の形で書く。
 *  備考の他の文字(例: 大上/ナミツー)は残す。前に書いた車種の並び(車種が増えたときの「10t/高TR」など)は、新しい並びに置き換える。変わる行だけ書く。 */
function syncTypeNotes_(pairs) {
  var groups = [];
  pairs.forEach(function (r) {
    if (r._deleted === true || !hasDriver_(r) || !typeKey_(r.車種)) return;
    for (var i = 0; i < groups.length; i++) if (sameDriver_(groups[i].rep, r)) { groups[i].rows.push(r); return; }
    groups.push({ rep: r, rows: [r] });
  });
  groups.forEach(function (g) {
    var seen = {}, types = [];
    g.rows.forEach(function (r) { var k = typeKey_(r.車種); if (!seen[k]) { seen[k] = true; types.push(fmtType_(r.車種)); } });
    if (types.length < 2) return;
    types.sort(function (a, b) { return typeRank_(a) - typeRank_(b) || (a < b ? -1 : a > b ? 1 : 0); });
    var token = types.join('/'), keys = {};
    types.forEach(function (t) { keys[typeKey_(t)] = true; });
    g.rows.forEach(function (r) {
      var rest = String(r.備考 || '').split(/[\s\u3000]+/).filter(function (w) {
        if (!w) return false;
        var parts = w.split(/[\/／]/);
        return !parts.every(function (x) { return keys[typeKey_(x)]; }); // 車種だけの並び(前に書いたもの)は外す
      }).join(' ');
      var next = rest ? token + ' ' + rest : token;
      if (next !== String(r.備考 || '')) { mergedWrite_(r._row, { 備考: next }); r.備考 = next; }
    });
  });
}

function masterSave_(body) {
  applyOp_({ kind: body.kind, mode: body.mode, row: body.row, before: body.before, data: body.data });
  if (body.kind === 'pair') { try { syncTypeNotes_(mergedRowsNow_()); } catch (e) { /* 失敗しても保存は済んでいる */ } }
  return { ok: true };
}
