/**
 * 車番連絡FAX取込 - GAS(スプレッドシート「車番連絡自動化」にコンテナバインド)
 *
 * シート:
 *   取込一覧 … FAX1台=1行の記録(列は見出し名で読み書きする。列の追加・並べ替えに強い)
 *   車両運転手情報 … 手配業者 / 運送業者 / 車種 / 車番 / 氏名 / 携帯番号 / 備考。1行=車と運転手の1組(同じ車に別の運転手、同じ運転手が別の車は、別の行)。
 *                  車番が空欄の行=車の組み合わせが無い運転手、氏名・携帯番号が空欄の行=運転手の組み合わせが無い車。
 *   (旧)車両情報・運転手携帯番号 … 2026-10-22に「車両運転手情報」へ統合。移行用の関数(previewMergedSheet・createMergedSheet)だけが読む
 *   情報 … A列=項目名、B列=値。「Geminiモデル名」「タイムゾーン」「APIKEY」。
 *          工事番号と工事名のリスト(見出し「工事番号」「工事名」の列)も、この見出しを探して読む。
 *
 * Geminiのモデル名とAPIキーは「情報」シートのセルから読む(コード修正・再デプロイ不要)。
 * APIキーはこのGAS内でだけ使い、画面には返さない。
 */

// 貼り替え・デプロイの確認用。ping と init がこの値を返す(画面上部にも表示)。コードを変えたら更新する。
var CODE_VERSION = '20261022b';

var SHEET_IMPORT = '取込一覧';
var SHEET_VEHICLE = '車両情報';
var SHEET_DRIVER = '運転手携帯番号';
var SHEET_INFO = '情報';

// 取込一覧の必須の見出し。FAXの送り主は「手配業者」に記録する(見出し「業者」の列が残っていれば、同じ値を入れる)。
var IMPORT_HEADERS = ['タイムスタンプ', 'ファイル名', '工事番号', '現場名', '手配業者', '積日', '卸日', '行先', '着時間', '運送業者', '車種', '車番', '氏名', '携帯番号'];
var VEHICLE_HEADERS = ['手配業者', '運送業者', '車種', '車番'];
var DRIVER_HEADERS = ['運送業者', '氏名', '携帯番号'];
var DRIVER_OPTIONAL = ['車種']; // 運転手の車種(複数は「4t/10t/15t」)。列があれば読み書きする。setupSheets が無ければ列を足す
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
  var map = headerMap_(sh, []);
  cols.forEach(function (c) {
    if (map[c]) return;
    var col = sh.getLastColumn() + 1;
    sh.getRange(1, col).setValue(c).setFontWeight('bold');
    map[c] = col;
  });
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
  var lastCol = sh.getLastColumn();
  return headerMapOf_(lastCol > 0 ? sh.getRange(1, 1, 1, lastCol).getValues()[0] : [], required, sh.getName());
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
function writeRow_(sh, headers, rowNo, obj) {
  var map = headerMap_(sh, headers);
  var r = rowNo || (sh.getLastRow() + 1);
  Object.keys(obj).forEach(function (h) {
    if (!map[h]) return;
    var cell = sh.getRange(r, map[h]);
    if (TEXT_COLS.indexOf(h) >= 0) cell.setNumberFormat('@');
    else if (DATE_COLS.indexOf(h) >= 0) cell.setNumberFormat('yyyy/MM/dd');
    else if (h === 'タイムスタンプ') cell.setNumberFormat('yyyy/MM/dd HH:mm:ss');
    var v = obj[h];
    if (DATE_COLS.indexOf(h) >= 0) v = parseDate_(v);
    cell.setValue(v);
  });
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
  '{"業者":"","FAX日付":"","区分":"","メモ":"","明細":[{"積日":"","卸日":"","行先":"","着時間":"","運送業者":"","車種":"","車番":"","氏名":"","携帯番号":"","備考":"","取消線":false}]}',
  'ルール:',
  '- 業者: このFAXを送ってきた会社(発信元)。次の名前のうち、発信元に当たるものを、その名前だけで答える: {{senders}}。どれにも当たらないときだけ、発信元の会社名を書かれたとおりに書く(「御中」「様」が付いている側は宛先なので業者ではありません)。',
  '- FAX日付: FAXの日付(本文の日付、または余白の受信印の日付)をyyyy-mm-ddで。読めなければ空文字。',
  '- 区分: 「新規」「変更」「追加」「取消」のどれか。「再」「訂正」「変更」の印や文言があれば「変更」、「追加」「増車」なら「追加」、「取消」「キャンセル」なら「取消」。何も無ければ「新規」。',
  '- メモ: FAXに書かれた連絡の文言(例: 「変更すみません。宜しくお願い致します。」)。印字の定型のあいさつ(「いつもお世話になっております」「ご確認を宜しくお願い致します」など)は含めない。手書きや追記の文字があれば含める。無ければ空文字。',
  '- 備考: その行の「備考」「特記」「荷種」「入場予定時間」など、上の項目に当てはまらない欄に書かれた文字。欄名が「備考」以外のときは「欄名:内容」の形(例: 「特記:午前着希望」「荷種:鉄骨」)で、複数あれば「 / 」でつなぐ。書かれていなければ空文字。',
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

// ---------- 記録(取込一覧への追記+車両情報・運転手情報の更新) ----------

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

// ---------- 車両運転手情報(車と運転手の組み合わせ)の読み書き ----------
// 画面の照合(logic.js)は、「車両」と「運転手」の2つの一覧を前提にしている。そのため、車両運転手情報の行から、車番ごと・運転手ごとに1件の一覧を作って返す(pairsToVehicles_ / pairsToDrivers_)。
// 車・運転手を登録・更新する操作(op: vehicle / driver)は、車両運転手情報の行に対する操作に読み替える(applyOp_)。FAXの1行ごとの「車と運転手の組み合わせ」は、記録のあとで ensurePairs_ が追加する。

/** 運転手の同一判定: 両方に携帯番号があれば番号で、無ければ氏名(運送業者の書き方の違いは同じ会社とみなす) */
function sameDriver_(a, b) {
  var pa = mgPhone_(a.携帯番号), pb = mgPhone_(b.携帯番号);
  if (pa && pb) return pa === pb;
  var na = mgCompact_(a.氏名), nb = mgCompact_(b.氏名);
  if (!na || !nb || na !== nb) return false;
  var ca = mgCompanyKey_(a.運送業者), cb = mgCompanyKey_(b.運送業者);
  return !ca || !cb || ca === cb || ca.indexOf(cb) >= 0 || cb.indexOf(ca) >= 0;
}
function hasDriver_(r) { return !!(mgCompact_(r.氏名) || mgPhone_(r.携帯番号)); }

function pairsToVehicles_(pairs) {
  var seen = {}, out = [];
  pairs.forEach(function (r) {
    var k = mgPlateKey_(r.車番);
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
    out.push({ _row: r._row, 運送業者: r.運送業者, 氏名: r.氏名, 携帯番号: r.携帯番号, 車種: '' });
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
      var key = mgPlateKey_(cur.車番);
      mergedRowsNow_().forEach(function (r) { if (mgPlateKey_(r.車番) === key) mergedWrite_(r._row, pick_(op.data, PAIR_VEHICLE_FIELDS)); });
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

/** 取込一覧への記録は済んでいるので、組み合わせの追加に失敗しても、記録は取り消さない(失敗は結果に入れて、画面で知らせる) */
function safePairs_(rowsData) {
  try { var r = ensurePairs_(rowsData); r.ok = true; return r; }
  catch (e) { return { ok: false, error: String(e && e.message || e) }; }
}

/** 記録した行(取込一覧に追加した行)ごとに、「車と運転手の組み合わせ」が車両運転手情報に無ければ追加する。
 *  行は、noPair(「登録しない」「今回だけこの値」を選んだ行)・車番なし・運転手なしのものを除く。
 *  ① 同じ車番・同じ運転手の行が既にあれば何もしない ② 同じ車番で運転手が空欄の行があれば、そこに運転手を入れる
 *  ③ 同じ運転手で車番が空欄の行があれば、そこに車を入れる ④ どれも無ければ新しい行を追加する(手配業者・運送業者・車種は、同じ車番の行があればその値、無ければFAXの値)。
 *  ②と③が両方あるとき(車も運転手も新規登録した直後)は、②に運転手を入れて、③の行は消す。 */
function ensurePairs_(rowsData) {
  var pairs = mergedRowsNow_(), toDelete = [], added = 0, filled = 0;
  rowsData.forEach(function (r) {
    if (r.noPair) return;
    var pk = mgPlateKey_(r.車番);
    var drv = { 運送業者: r.運送業者, 氏名: r.氏名, 携帯番号: r.携帯番号 };
    if (!pk || !hasDriver_(drv)) return;
    var plateRows = pairs.filter(function (x) { return mgPlateKey_(x.車番) === pk && x._deleted !== true; });
    if (plateRows.some(function (x) { return sameDriver_(x, drv); })) return; // ① 既にある
    // 既に登録されている同じ運転手の氏名・携帯番号の表記を、そのまま使う
    var known = null;
    pairs.some(function (x) { if (x._deleted !== true && hasDriver_(x) && sameDriver_(x, drv)) { known = x; return true; } return false; });
    var name = known ? known.氏名 : mgCompact_(r.氏名), phone = known ? (known.携帯番号 || (mgPhone_(r.携帯番号) ? mgFmtPhone_(r.携帯番号) : '')) : (mgPhone_(r.携帯番号) ? mgFmtPhone_(r.携帯番号) : '');
    var blankDriver = plateRows.filter(function (x) { return !hasDriver_(x); })[0];
    var driverOnly = pairs.filter(function (x) { return x._deleted !== true && !mgPlateKey_(x.車番) && hasDriver_(x) && sameDriver_(x, drv); })[0];
    if (blankDriver) { // ②
      var o2 = { 氏名: name, 携帯番号: phone }; if (driverOnly && driverOnly.備考 && !blankDriver.備考) o2.備考 = driverOnly.備考;
      mergedWrite_(blankDriver._row, o2); blankDriver.氏名 = name; blankDriver.携帯番号 = phone; filled++;
      if (driverOnly) { driverOnly._deleted = true; toDelete.push(driverOnly._row); }
      return;
    }
    if (driverOnly) { // ③
      var base = plateRows[0];
      var o3 = { 手配業者: base ? base.手配業者 : mgNfkc_(r.業者 || r.手配業者 || '').trim(), 運送業者: base ? base.運送業者 : mgNfkc_(r.運送業者).trim(), 車種: base ? base.車種 : mgFmtType_(r.車種), 車番: base ? base.車番 : mgCompact_(r.車番) };
      mergedWrite_(driverOnly._row, o3); Object.keys(o3).forEach(function (k) { driverOnly[k] = o3[k]; }); filled++;
      return;
    }
    var b = plateRows[0]; // ④
    var nr = { 手配業者: b ? b.手配業者 : mgNfkc_(r.業者 || r.手配業者 || '').trim(), 運送業者: b ? b.運送業者 : mgNfkc_(r.運送業者).trim(), 車種: b ? b.車種 : mgFmtType_(r.車種), 車番: b ? b.車番 : mgCompact_(r.車番), 氏名: name, 携帯番号: phone, 備考: '' };
    var rowNo = mergedWrite_(null, nr); nr._row = rowNo; pairs.push(nr); added++;
  });
  toDelete.sort(function (a, b) { return b - a; }).forEach(function (n) { sheet_(SHEET_MERGED).deleteRow(n); }); // 下の行から消す(行番号がずれないように)
  return { added: added, filled: filled, removed: toDelete.length };
}

function masterSave_(body) {
  applyOp_({ kind: body.kind, mode: body.mode, row: body.row, before: body.before, data: body.data });
  return { ok: true };
}


// ---------- 「車両運転手情報」シートへの移行(1回だけ実行。成功したら、この節は消してよい) ----------
// 車両情報と運転手携帯番号を合体した表。1行=「車」と「運転手」の1つの組み合わせ。同じ車に別の運転手、同じ運転手が別の車、のどちらも別の行になる。
// 元データ: ①取込一覧の記録(車番・氏名・携帯番号の組み合わせ。「変更前」「中止」の行は除く) ②車両情報(組み合わせの無い車は、氏名・携帯番号を空欄の行にする) ③運転手携帯番号(組み合わせの無い運転手は、車番を空欄の行にする。複数の車種に乗る運転手は、備考に「10t/高TR」の形で書く)
// 手順: Apps Script のエディタで、previewMergedSheet(書かずに件数だけ確認)→ createMergedSheet(書き込み)を実行する。結果は「実行ログ」に出る。
// 車両情報・運転手携帯番号・取込一覧は、この関数では一切書き換えない。新しいシートに記録が既にあるときは、何も書かずに止まる(上書きしない)。
var SHEET_MERGED = '車両運転手情報';
var MERGED_HEADERS = ['手配業者', '運送業者', '車種', '車番', '氏名', '携帯番号', '備考'];

function mgNfkc_(s) {
  var t = String(s == null ? '' : s);
  if (typeof t.normalize === 'function') return t.normalize('NFKC');
  return t.replace(/[！-～]/g, function (c) { return String.fromCharCode(c.charCodeAt(0) - 0xFEE0); }).replace(/　/g, ' ').replace(/㈱/g, '(株)').replace(/㈲/g, '(有)');
}
function mgCompact_(s) { return mgNfkc_(s).replace(/[\s　]+/g, ''); }
function mgPlateKey_(s) { return mgCompact_(s).replace(/[-‐-―−ー・.]/g, '').toLowerCase(); }
function mgCompanyKey_(s) { return mgCompact_(s).replace(/\(株\)|\(有\)|\(合\)|\(同\)|株式会社|有限会社|合同会社/g, '').replace(/[()・]/g, '').toLowerCase(); }
function mgPhone_(s) { return mgNfkc_(s).replace(/\D/g, ''); }
function mgFmtPhone_(s) {
  var d = mgPhone_(s);
  if (d.length === 11) return d.replace(/(\d{3})(\d{4})(\d{4})/, '$1-$2-$3');
  if (d.length === 10) return /^0[36]/.test(d) ? d.replace(/(\d{2})(\d{4})(\d{4})/, '$1-$2-$3') : d.replace(/(\d{3})(\d{3})(\d{4})/, '$1-$2-$3');
  return mgNfkc_(s).replace(/[\s　]+/g, ' ').trim();
}
function mgFmtType_(s) { return mgNfkc_(s).replace(/[\s　]+/g, '').replace(/(\d)T/g, '$1t'); }
function mgTypeRank_(t) {
  var m = /(\d+(?:\.\d+)?)t/i.exec(mgCompact_(t));
  if (m) return +m[1];
  return /TR/i.test(mgCompact_(t)) ? 1000 : 2000;
}
/** 「4t/10t/15t」のように複数書かれた車種を、重複を除いて小さい順に並べた配列にする */
function mgTypeList_(s) {
  var seen = {}, out = [];
  String(s == null ? '' : s).split(/[\/／、,，]+/).forEach(function (t) {
    var f = mgFmtType_(t), k = f.toLowerCase();
    if (!f || seen[k]) return;
    seen[k] = true; out.push(f);
  });
  return out.sort(function (a, b) { return mgTypeRank_(a) - mgTypeRank_(b) || (a < b ? -1 : a > b ? 1 : 0); });
}
function mgSenderRank_(t) { var k = mgCompanyKey_(t); return k.indexOf(mgCompanyKey_('大上')) >= 0 ? 0 : (k.indexOf(mgCompanyKey_('ナミツー')) >= 0 ? 1 : 2); }
function mgCmp_(a, b) { return a < b ? -1 : (a > b ? 1 : 0); }

/** 3つのシートから、新しいシートに入れる行を作る(書き込みはしない)。戻り値 {rows, summary} */
function buildMerged_() {
  var vehicles = readAll_(SHEET_VEHICLE, VEHICLE_HEADERS).rows;
  var drivers = readAll_(SHEET_DRIVER, DRIVER_HEADERS, DRIVER_OPTIONAL).rows;
  var imports = readAll_(SHEET_IMPORT, ['手配業者', '運送業者', '車種', '車番', '氏名', '携帯番号'], ['追加変更']).rows;

  // 車両情報: 車番ごと(同じ車番が2行あれば、先の行を使う)
  var vByPlate = {};
  vehicles.forEach(function (v) { var k = mgPlateKey_(v.車番); if (k && !vByPlate[k]) vByPlate[k] = v; });
  // 運転手携帯番号: 携帯番号ごと・氏名ごと(氏名で探すときは、運送業者の書き方の違い=一方が他方に含まれる、を同じ会社とみなす。例: 「(有)大上運送 明石事業所」と「大上運送」)
  var dByPhone = {}, dByName = {};
  drivers.forEach(function (d) {
    var p = mgPhone_(d.携帯番号), n = mgCompact_(d.氏名);
    if (p && !dByPhone[p]) dByPhone[p] = d;
    if (n) (dByName[n] = dByName[n] || []).push(d);
  });
  function sameCo_(a, b) { var x = mgCompanyKey_(a), y = mgCompanyKey_(b); return !!x && !!y && (x === y || x.indexOf(y) >= 0 || y.indexOf(x) >= 0); }
  function findDriver_(phone, co, name) {
    if (phone && dByPhone[phone]) return dByPhone[phone];
    var l = name ? (dByName[name] || []) : [];
    for (var i = 0; i < l.length; i++) if (sameCo_(l[i].運送業者, co)) return l[i];
    return null;
  }

  var out = [], seenPair = {}, usedPlate = {}, usedDriver = {};
  function driverNote_(d) { var l = d ? mgTypeList_(d.車種) : []; return l.length > 1 ? l.join('/') : ''; }
  function driverIdOf_(phone, co, name) { return phone ? 'p' + phone : (mgCompact_(name) ? 'n' + mgCompanyKey_(co) + '|' + mgCompact_(name) : ''); }

  // ① 取込一覧(シートの上から=古い記録から順に)。車番のある行だけ
  var used = 0;
  imports.forEach(function (r) {
    if (INACTIVE_LABELS.indexOf(r.追加変更) >= 0) return;
    var pk = mgPlateKey_(r.車番);
    if (!pk) return;
    used++;
    var phone = mgPhone_(r.携帯番号), name = mgCompact_(r.氏名);
    var d = findDriver_(phone, r.運送業者, name);
    if (d) { if (!phone) phone = mgPhone_(d.携帯番号); if (!name) name = mgCompact_(d.氏名); }
    var did = driverIdOf_(phone, d ? d.運送業者 : r.運送業者, name);
    var key = pk + '|' + did;
    if (seenPair[key]) return;
    seenPair[key] = true;
    var v = vByPlate[pk];
    out.push({
      手配業者: v ? mgNfkc_(v.手配業者).trim() : mgNfkc_(r.手配業者).trim(),
      運送業者: v ? mgNfkc_(v.運送業者).trim() : mgNfkc_(r.運送業者).trim(),
      車種: v ? mgFmtType_(v.車種) : mgFmtType_(r.車種),
      車番: mgCompact_(v ? v.車番 : r.車番),
      氏名: d ? mgCompact_(d.氏名) : name,
      携帯番号: phone ? mgFmtPhone_(phone) : '',
      備考: driverNote_(d)
    });
    usedPlate[pk] = true;
    if (did) usedDriver[did] = true;
  });
  var paired = out.length;

  // ② 組み合わせの無い車(氏名・携帯番号は空欄)
  var vehOnly = 0;
  Object.keys(vByPlate).forEach(function (pk) {
    if (usedPlate[pk]) return;
    var v = vByPlate[pk];
    out.push({ 手配業者: mgNfkc_(v.手配業者).trim(), 運送業者: mgNfkc_(v.運送業者).trim(), 車種: mgFmtType_(v.車種), 車番: mgCompact_(v.車番), 氏名: '', 携帯番号: '', 備考: '' });
    vehOnly++;
  });

  // ③ 組み合わせの無い運転手(車番は空欄。車種が1つならその車種、複数なら空欄にして備考に書く)
  var drvOnly = 0;
  drivers.forEach(function (d) {
    var phone = mgPhone_(d.携帯番号), name = mgCompact_(d.氏名);
    if (!name && !phone) return;
    var did = driverIdOf_(phone, d.運送業者, name);
    if (usedDriver[did] || (phone && usedDriver['p' + phone]) || usedDriver['n' + mgCompanyKey_(d.運送業者) + '|' + name]) return;
    usedDriver[did] = true;
    var tl = mgTypeList_(d.車種);
    out.push({ 手配業者: '', 運送業者: mgNfkc_(d.運送業者).trim(), 車種: tl.length === 1 ? tl[0] : '', 車番: '', 氏名: name, 携帯番号: phone ? mgFmtPhone_(phone) : '', 備考: driverNote_(d) });
    drvOnly++;
  });

  out.sort(function (a, b) {
    return mgSenderRank_(a.手配業者) - mgSenderRank_(b.手配業者) || mgCmp_(mgCompanyKey_(a.運送業者), mgCompanyKey_(b.運送業者)) ||
      mgTypeRank_(a.車種) - mgTypeRank_(b.車種) || mgCmp_(a.車番, b.車番) || mgCmp_(a.氏名, b.氏名);
  });

  // 内訳(「同じ車に別の運転手」「同じ運転手が別の車」の数)
  var perPlate = {}, perDriver = {};
  out.forEach(function (r) {
    var pk = mgPlateKey_(r.車番), did = driverIdOf_(mgPhone_(r.携帯番号), r.運送業者, r.氏名);
    if (pk && did) { perPlate[pk] = (perPlate[pk] || 0) + 1; perDriver[did] = (perDriver[did] || 0) + 1; }
  });
  function over1(o) { return Object.keys(o).filter(function (k) { return o[k] > 1; }).length; }
  var summary = {
    元_車両情報: vehicles.length, 元_運転手携帯番号: drivers.length, 元_取込一覧の記録のうち車番のある行: used,
    新シートに入れる行数: out.length, 車と運転手の組み合わせ: paired, 運転手が未登録の車: vehOnly, 車が未登録の運転手: drvOnly,
    同じ車に複数の運転手がいる車の数: over1(perPlate), 複数の車に乗る運転手の数: over1(perDriver)
  };
  return { rows: out, summary: summary };
}

/** 書き込まずに、新しいシートに入れる件数を確認する(実行ログに出る) */
function previewMergedSheet() {
  var m = buildMerged_();
  Logger.log(JSON.stringify(m.summary));
  return JSON.stringify(m.summary);
}

/** 「車両運転手情報」シートに記録する。見出し行は必要(無いときは作る)。記録が既にあるときは、何も書かずに止まる */
function createMergedSheet() {
  var ss = ss_();
  var sh = ss.getSheetByName(SHEET_MERGED) || ss.insertSheet(SHEET_MERGED);
  if (sh.getLastRow() < 1) { sh.getRange(1, 1, 1, MERGED_HEADERS.length).setValues([MERGED_HEADERS]).setFontWeight('bold'); sh.setFrozenRows(1); }
  var map = headerMapOf_(sh.getRange(1, 1, 1, Math.max(sh.getLastColumn(), 1)).getValues()[0], MERGED_HEADERS, SHEET_MERGED);
  var dataRows = 0;
  if (sh.getLastRow() > 1) {
    var cols = sh.getRange(2, 1, sh.getLastRow() - 1, Math.max(sh.getLastColumn(), 1)).getValues();
    cols.forEach(function (r) { if (r.some(function (v) { return String(v).trim() !== ''; })) dataRows++; });
  }
  if (dataRows > 0) throw new Error('シート「' + SHEET_MERGED + '」には、既に' + dataRows + '行の記録があります。上書きしないため、何も書きませんでした(やり直すときは、見出し行以外を消してから実行してください)。');
  var m = buildMerged_();
  var width = sh.getLastColumn(), n = m.rows.length;
  if (!n) throw new Error('入れる行がありません。');
  if (sh.getMaxRows() < n + 1) sh.insertRowsAfter(sh.getMaxRows(), n + 1 - sh.getMaxRows());
  var values = m.rows.map(function (r) {
    var line = []; for (var i = 0; i < width; i++) line.push('');
    MERGED_HEADERS.forEach(function (h) { line[map[h] - 1] = r[h]; });
    return line;
  });
  var rng = sh.getRange(2, 1, n, width);
  rng.setNumberFormat('@'); // 携帯番号の先頭の0・車番の文字を、そのまま文字として保存する
  rng.setValues(values);
  Logger.log(JSON.stringify(m.summary));
  return 'OK: ' + n + '行を「' + SHEET_MERGED + '」に記録しました。' + JSON.stringify(m.summary);
}
