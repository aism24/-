/**
 * 車番連絡FAX取込 - GAS(スプレッドシート「車番連絡自動化」にコンテナバインド)
 *
 * シート:
 *   取込一覧 … FAX1台=1行の記録(列は見出し名で読み書きする。列の追加・並べ替えに強い)
 *   車両情報 … 手配業者 / 運送業者 / 車種 / 車番
 *   運転手携帯番号 … 運送業者 / 氏名 / 携帯番号
 *   情報 … A列=項目名、B列=値。「Geminiモデル名」「タイムゾーン」「APIKEY」。
 *          工事番号と工事名のリスト(見出し「工事番号」「工事名」の列)も、この見出しを探して読む。
 *
 * Geminiのモデル名とAPIキーは「情報」シートのセルから読む(コード修正・再デプロイ不要)。
 * APIキーはこのGAS内でだけ使い、画面には返さない。
 */

// 貼り替え・デプロイの確認用。ping と init がこの値を返す(画面上部にも表示)。コードを変えたら更新する。
var CODE_VERSION = '20261020k';

var SHEET_IMPORT = '取込一覧';
var SHEET_VEHICLE = '車両情報';
var SHEET_DRIVER = '運転手携帯番号';
var SHEET_INFO = '情報';

// 取込一覧の必須の見出し。FAXの送り主は「手配業者」に記録する(見出し「業者」の列が残っていれば、同じ値を入れる)。
var IMPORT_HEADERS = ['タイムスタンプ', 'ファイル名', '工事番号', '現場名', '手配業者', '積日', '卸日', '行先', '着時間', '運送業者', '車種', '車番', '氏名', '携帯番号'];
var VEHICLE_HEADERS = ['手配業者', '運送業者', '車種', '車番'];
var DRIVER_HEADERS = ['運送業者', '氏名', '携帯番号'];
var CHECK_FIELDS = ['手配業者', '積日', '卸日', '行先', '着時間', '運送業者', '車種', '車番', '氏名', '携帯番号', '工事番号', '現場名', '追加変更'];
// 取込一覧の任意の列(あれば読み書きする。無くても動く)。「追加変更」=中止/変更前/変更後、「備考」=アプリで入力したテキスト。
var IMPORT_OPTIONAL = ['追加変更', '備考'];
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
  ensureSheet_(ss, SHEET_VEHICLE, VEHICLE_HEADERS);
  ensureSheet_(ss, SHEET_DRIVER, DRIVER_HEADERS);
  var info = ss.getSheetByName(SHEET_INFO) || ss.insertSheet(SHEET_INFO);
  var defaults = [['Geminiモデル名', 'gemini-3.5-flash-lite'], ['タイムゾーン', 'Asia/Tokyo'], ['APIKEY', '']];
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

function firstEmptyRowInA_(sh) {
  var vals = sh.getRange(1, 1, Math.max(sh.getLastRow(), 1) + 1, 1).getValues();
  for (var i = 0; i < vals.length; i++) if (String(vals[i][0]).trim() === '') return i + 1;
  return vals.length + 1;
}

// ---------- 情報シートの設定 ----------

function getInfo_(key) {
  var sh = SpreadsheetApp.getActiveSpreadsheet().getSheetByName(SHEET_INFO);
  if (!sh || sh.getLastRow() < 1) return '';
  var vals = sh.getRange(1, 1, sh.getLastRow(), 2).getValues();
  for (var i = 0; i < vals.length; i++) if (String(vals[i][0]).trim() === key) return String(vals[i][1]).trim();
  return '';
}

function tz_() { return getInfo_('タイムゾーン') || 'Asia/Tokyo'; }

/** 工事番号と工事名のリスト。「情報」シートの見出し「工事番号」「工事名」を探し、その下を空行まで読む。 */
function readProjects_() {
  var sh = SpreadsheetApp.getActiveSpreadsheet().getSheetByName(SHEET_INFO);
  if (!sh || sh.getLastRow() < 1 || sh.getLastColumn() < 2) return [];
  var top = sh.getRange(1, 1, Math.min(sh.getLastRow(), 6), sh.getLastColumn()).getValues();
  var hr = -1, hc = -1;
  for (var r = 0; r < top.length && hr < 0; r++) {
    for (var c = 0; c < top[r].length - 1; c++) {
      if (String(top[r][c]).trim() === '工事番号' && String(top[r][c + 1]).trim() === '工事名') { hr = r; hc = c; break; }
    }
  }
  if (hr < 0) return [];
  var n = sh.getLastRow() - (hr + 1);
  if (n < 1) return [];
  var vals = sh.getRange(hr + 2, hc + 1, n, 2).getValues();
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
  var sh = SpreadsheetApp.getActiveSpreadsheet().getSheetByName(SHEET_INFO);
  if (!sh || sh.getLastRow() < 1) return DEFAULT_SENDERS.slice();
  var top = sh.getRange(1, 1, Math.min(sh.getLastRow(), 6), Math.max(sh.getLastColumn(), 1)).getValues();
  for (var r = 0; r < top.length; r++) {
    for (var c = 0; c < top[r].length; c++) {
      if (String(top[r][c]).trim() !== '手配業者') continue;
      var n = sh.getLastRow() - (r + 1), out = [];
      if (n > 0) {
        var vals = sh.getRange(r + 2, c + 1, n, 1).getValues();
        for (var i = 0; i < vals.length; i++) { var v = String(vals[i][0]).trim(); if (!v) break; out.push(v); }
      }
      return out.length ? out : DEFAULT_SENDERS.slice();
    }
  }
  return DEFAULT_SENDERS.slice();
}

// ---------- シート読み書き(見出し名ベース) ----------

function sheet_(name) {
  var sh = SpreadsheetApp.getActiveSpreadsheet().getSheetByName(name);
  if (!sh) throw new Error('シート「' + name + '」がありません。setupSheetsを実行してください。');
  return sh;
}

function headerMap_(sh, required) {
  var lastCol = sh.getLastColumn();
  var map = {};
  if (lastCol > 0) {
    sh.getRange(1, 1, 1, lastCol).getValues()[0].forEach(function (h, i) {
      var n = String(h).trim();
      if (n && !map[n]) map[n] = i + 1;
    });
  }
  (required || []).forEach(function (h) {
    if (!map[h]) throw new Error('シート「' + sh.getName() + '」の1行目に見出し「' + h + '」がありません。');
  });
  return map;
}

function cellStr_(v) {
  if (Object.prototype.toString.call(v) === '[object Date]') {
    var withTime = v.getHours() || v.getMinutes() || v.getSeconds();
    return Utilities.formatDate(v, tz_(), withTime ? 'yyyy/MM/dd HH:mm:ss' : 'yyyy/MM/dd');
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

function getInit_() {
  var imp = sheet_(SHEET_IMPORT);
  var impRows = readRows_(imp, ['積日', '行先', '工事番号', '現場名', '車番'], 2, null, ['追加変更']);
  var activeRows = impRows.filter(function (r) { return INACTIVE_LABELS.indexOf(r.追加変更) < 0; });
  return {
    vehicles: readRows_(sheet_(SHEET_VEHICLE), VEHICLE_HEADERS),
    drivers: readRows_(sheet_(SHEET_DRIVER), DRIVER_HEADERS),
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
  '{"業者":"","FAX日付":"","区分":"","メモ":"","明細":[{"積日":"","卸日":"","行先":"","着時間":"","運送業者":"","車種":"","車番":"","氏名":"","携帯番号":"","取消線":false}]}',
  'ルール:',
  '- 業者: このFAXを送ってきた会社(発信元)。次の名前のうち、発信元に当たるものを、その名前だけで答える: {{senders}}。どれにも当たらないときだけ、発信元の会社名を書かれたとおりに書く(「御中」「様」が付いている側は宛先なので業者ではありません)。',
  '- FAX日付: FAXの日付(本文の日付、または余白の受信印の日付)をyyyy-mm-ddで。読めなければ空文字。',
  '- 区分: 「新規」「変更」「追加」「取消」のどれか。「再」「訂正」「変更」の印や文言があれば「変更」、「追加」「増車」なら「追加」、「取消」「キャンセル」なら「取消」。何も無ければ「新規」。',
  '- メモ: FAXに書かれた連絡の文言(例: 「変更すみません。宜しくお願い致します。」)。無ければ空文字。',
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
  return { raw: parseJsonText_(text), model: getInfo_('Geminiモデル名') };
}

function parseJsonText_(text) {
  var t = String(text || '').trim().replace(/^```(?:json)?\s*/i, '').replace(/```\s*$/, '').trim();
  try { return JSON.parse(t); } catch (e) { throw new Error('読み取り結果をJSONとして解釈できませんでした。もう一度お試しください。'); }
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
    try { json = JSON.parse(raw); } catch (e) { json = null; }
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

// ---------- 記録(取込一覧への追記+マスタ更新) ----------

function commit_(body) {
  var rows = body.rows || [];
  if (!rows.length) throw new Error('記録する行がありません。');
  if (rows.length > MAX_ROWS_PER_COMMIT) throw new Error('一度に記録できるのは' + MAX_ROWS_PER_COMMIT + '行までです。');
  var imp = sheet_(SHEET_IMPORT);
  var source = body.filename || '';
  var ops = body.ops || [];
  var opCount = 0;
  ops.forEach(function (op) { applyOp_(op, source); opCount++; });
  var now = new Date();
  rows.forEach(function (r) { writeRow_(imp, IMPORT_HEADERS, null, importObj_(r, now, source, '')); });
  return { added: rows.length, ops: opCount };
}

/** 画面の行({業者, 積日, ...})を、取込一覧の見出し名つきの値にする。 */
function importObj_(r, now, source, label) {
  return {
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

function recText_(o, fields) { return fields.map(function (k) { return o[k]; }).filter(function (v) { return v; }).join(' '); }

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
  var current = {};
  items.forEach(function (it) {
    if (it.mode === 'add') return;
    if (it.mode !== 'mark') throw new Error('不明な操作です(行の削除・上書きはできません): ' + it.mode);
    if (INACTIVE_LABELS.indexOf(it.label) < 0) throw new Error('「追加変更」の値が不正です: ' + it.label);
    if (!hasLabelCol) throw new Error('取込一覧の1行目に見出し「追加変更」がありません。');
    var cur = readRows_(imp, IMPORT_HEADERS, it.row, it.row, IMPORT_OPTIONAL)[0];
    if (!cur) throw new Error('取込一覧の行(' + it.row + ')が見つかりません。画面を再読み込みしてください。');
    var bad = sameRecord_(cur, it.before);
    if (bad) throw new Error('取込一覧の行(' + it.row + ')が他の操作で変更されています(' + bad + ')。画面を再読み込みしてください。');
    current[it.row] = cur;
  });
  var opCount = 0;
  (body.ops || []).forEach(function (op) { applyOp_(op, source); opCount++; });
  var now = new Date();
  var n = { marked: 0, added: 0 };
  // 元の行に印を付ける(行番号は変わらない)
  items.filter(function (it) { return it.mode === 'mark'; }).forEach(function (it) {
    var cur = current[it.row], obj = { '追加変更': it.label };
    if (it.note) obj['備考'] = it.note;
    writeRow_(imp, IMPORT_HEADERS, it.row, obj);
    n.marked++;
  });
  // 新しい行を追加
  items.filter(function (it) { return it.mode === 'add'; }).forEach(function (it) {
    var r = writeRow_(imp, IMPORT_HEADERS, null, importObj_(it.data, now, source, it.label || ''));
    n.added++;
  });
  return { marked: n.marked, added: n.added, ops: opCount };
}

function masterInfo_(kind) {
  if (kind === 'vehicle') return { sheet: sheet_(SHEET_VEHICLE), headers: VEHICLE_HEADERS };
  if (kind === 'driver') return { sheet: sheet_(SHEET_DRIVER), headers: DRIVER_HEADERS };
  throw new Error('不明なマスタ種別: ' + kind);
}

/** op: {kind, mode:'add'|'update'|'delete', row, before, data} */
function applyOp_(op, source) {
  var mi = masterInfo_(op.kind);
  var sh = mi.sheet, headers = mi.headers;
  if (op.mode === 'add') {
    writeRow_(sh, headers, null, op.data);
    return;
  }
  var now = readRows_(sh, headers, op.row, op.row)[0];
  if (!now) throw new Error('マスタの行(' + op.row + ')が見つかりません。画面を再読み込みしてください。');
  headers.forEach(function (h) {
    if (String(now[h]) !== String((op.before || {})[h] == null ? '' : op.before[h])) {
      throw new Error('マスタが他の操作で変更されています(' + h + ')。画面を再読み込みしてください。');
    }
  });
  if (op.mode === 'update') {
    writeRow_(sh, headers, op.row, op.data);
  } else if (op.mode === 'delete') {
    sh.deleteRow(op.row);
  } else {
    throw new Error('不明な操作: ' + op.mode);
  }
}

function masterSave_(body) {
  applyOp_({ kind: body.kind, mode: body.mode, row: body.row, before: body.before, data: body.data }, '手動(画面)');
  return { ok: true };
}


// ---------- 手配業者の表記をそろえる(Apps Scriptのエディタで、関数 normalizeSenders を1回だけ実行) ----------

/** 「取込一覧」と「車両情報」の手配業者を、候補(情報シートの一覧。既定: ナミツー・大上)の名前にそろえる。
 *  候補の名前を含む表記(例: 「(有)大上運送 明石事業所」→「大上」)だけを書き換える。どれにも当たらないものは変えない。 */
function normalizeSenders() {
  var list = readSenders_();
  function canon(v) {
    var t = String(v || '').normalize('NFKC').replace(/[\s\u3000]+/g, '');
    for (var i = 0; i < list.length; i++) {
      var c = String(list[i]).normalize('NFKC').replace(/[\s\u3000]+/g, '');
      if (c && t.indexOf(c) >= 0) return list[i];
    }
    return null;
  }
  var changed = 0;
  [[SHEET_IMPORT, IMPORT_HEADERS], [SHEET_VEHICLE, VEHICLE_HEADERS]].forEach(function (p) {
    var sh = sheet_(p[0]), map = headerMap_(sh, p[1]);
    var n = sh.getLastRow() - 1;
    if (n < 1) return;
    var rng = sh.getRange(2, map['手配業者'], n, 1), vals = rng.getValues();
    vals.forEach(function (row, i) {
      var to = canon(row[0]);
      if (to && String(row[0]) !== to) { row[0] = to; changed++; }
    });
    rng.setValues(vals);
  });
  return '手配業者を ' + changed + ' か所そろえました(候補: ' + list.join('・') + ')';
}

