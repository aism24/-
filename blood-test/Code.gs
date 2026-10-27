// 血液検査記録: スプレッドシートにバインドしたGAS(記録の書き込み・読み出し)
var CODE_VERSION = '2026-10-27-1';
var SHEET_RECORD = '記録';
var HEADERS = ['検査日', '医療機関', '項目名', '値', '単位', '基準下限', '基準上限', '判定', '元ファイル', '登録日時'];

function doGet(e) {
  return json_({ ok: true, version: CODE_VERSION });
}

function doPost(e) {
  try {
    var req = JSON.parse(e.postData.contents);
    if (req.action === 'ping') return json_({ ok: true, version: CODE_VERSION });
    if (req.action === 'append') return json_(append_(req.rows || []));
    if (req.action === 'list') return json_({ ok: true, rows: list_() });
    return json_({ ok: false, error: 'unknown action: ' + req.action });
  } catch (err) {
    return json_({ ok: false, error: String(err) });
  }
}

function json_(obj) {
  return ContentService.createTextOutput(JSON.stringify(obj)).setMimeType(ContentService.MimeType.JSON);
}

function sheet_() {
  var ss = SpreadsheetApp.getActiveSpreadsheet();
  var sh = ss.getSheetByName(SHEET_RECORD) || ss.insertSheet(SHEET_RECORD);
  if (sh.getLastRow() === 0) {
    sh.getRange(1, 1, 1, HEADERS.length).setValues([HEADERS]).setFontWeight('bold');
    sh.setFrozenRows(1);
    sh.getRange('A:B').setNumberFormat('@');
  }
  return sh;
}

function key_(date, place, item) {
  return [date, place, item].join('|');
}

// rows: [{検査日, 医療機関, 項目名, 値, 単位, 基準下限, 基準上限, 判定, 元ファイル}]
// 同じ 検査日+医療機関+項目名 が既にあれば追加せず skipped に数える
function append_(rows) {
  var lock = LockService.getScriptLock();
  lock.waitLock(30000);
  try {
    var sh = sheet_();
    var last = sh.getLastRow();
    var seen = {};
    if (last > 1) {
      sh.getRange(2, 1, last - 1, 3).getValues().forEach(function (r) {
        seen[key_(r[0], r[1], r[2])] = true;
      });
    }
    var now = Utilities.formatDate(new Date(), 'Asia/Tokyo', 'yyyy-MM-dd HH:mm:ss');
    var out = [];
    var skipped = 0;
    rows.forEach(function (r) {
      var k = key_(r['検査日'], r['医療機関'], r['項目名']);
      if (seen[k]) { skipped++; return; }
      seen[k] = true;
      out.push(HEADERS.slice(0, 9).map(function (h) { return r[h] === undefined ? '' : r[h]; }).concat([now]));
    });
    if (out.length) sh.getRange(last + 1, 1, out.length, HEADERS.length).setValues(out);
    return { ok: true, added: out.length, skipped: skipped };
  } finally {
    lock.releaseLock();
  }
}

function list_() {
  var sh = sheet_();
  var last = sh.getLastRow();
  if (last < 2) return [];
  return sh.getRange(2, 1, last - 1, HEADERS.length).getValues().map(function (r) {
    var o = {};
    HEADERS.forEach(function (h, i) { o[h] = r[i]; });
    return o;
  });
}

// 「情報」シートのA列の項目名で値を探す(APIKEY・モデル等。アプリ側の読み取り機能で使う)
function info_(name) {
  var sh = SpreadsheetApp.getActiveSpreadsheet().getSheetByName('情報');
  var vals = sh.getDataRange().getValues();
  for (var i = 0; i < vals.length; i++) {
    if (String(vals[i][0]).trim() === name) {
      if (!vals[i][1]) throw new Error('情報シートの' + name + 'が空です');
      return String(vals[i][1]).trim();
    }
  }
  throw new Error('情報シートに' + name + 'がありません');
}
