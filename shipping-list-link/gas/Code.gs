/**
 * 出荷リスト図番リンク付与アプリ用 GAS(ms-tottori アカウントで実行)
 *  - 毎朝: マスタExcelのハイパーリンクを抜き出し「リンク表(JSON)」をDriveに保存
 *  - doGet : リンク表JSONを返す(?action=links) / 軽い状態確認(?action=info) / 今すぐ再生成(?action=rebuild。Excelに変更がなければ省略、連打は1分で制限、件数が旧の90%未満なら上書きしない)
 *  - doPost: 取り込んだ元PDFを保存フォルダへ保存し、スプレッドシート「記録」の2行目に日時/ページ数/URLを挿入(最新が上)
 *
 * 【初回セットアップ】 ①このコードを貼り付け ②setupDaily を1回実行(権限を承認) ③buildMaster を1回実行
 *  ④デプロイ → ウェブアプリ(実行ユーザー=自分 / アクセス=全員)→ URLを app.js の GAS_URL に設定
 */
var MASTER_FOLDER_ID = '1HuBr3qZnO4N6BA6Zm_aU8BkVM45Q1K5q'; // マスタのままExcel置き場
var SAVE_FOLDER_ID = '1vekpzwfn-W0MqRyWWYzWdS4A6jp2bEt3';   // 取込PDF保存先(記録シートと同じ)
var SHEET_ID = '19l9P9C15wQ0jIcjIc_czZCiyDbnesQbq-Q88ttndMfs';
var SHEET_NAME = '記録';
var LINKS_FILE_NAME = '_リンク表.json';
var COL_ZUBAN = 'F', COL_NAME = 'G'; // 図番列 / 製品名(製品マーク)列

/* ===== 純粋関数(GAS API非依存・Nodeでテスト可能) ===== */
function decodeXml_(s) {
  return String(s).replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'").replace(/&#x([0-9a-fA-F]+);/g, function (m, h) { return String.fromCharCode(parseInt(h, 16)); })
    .replace(/&#(\d+);/g, function (m, d) { return String.fromCharCode(parseInt(d, 10)); }).replace(/&amp;/g, '&');
}
function attrs_(tag) {
  var o = {}, re = /([A-Za-z_:][\w:.\-]*)="([^"]*)"/g, m;
  while ((m = re.exec(tag))) o[m[1]] = decodeXml_(m[2]);
  return o;
}
function parseSharedStrings_(xml) {
  var out = [], re = /<si>([\s\S]*?)<\/si>/g, m;
  while ((m = re.exec(xml || ''))) {
    var t = '', r2 = /<t[^>]*>([\s\S]*?)<\/t>/g, n;
    while ((n = r2.exec(m[1]))) t += n[1];
    out.push(decodeXml_(t));
  }
  return out;
}
function parseRels_(xml) {
  var map = {}, re = /<Relationship\b[^>]*>/g, m;
  while ((m = re.exec(xml || ''))) { var a = attrs_(m[0]); if (a.Id) map[a.Id] = a.Target; }
  return map;
}
/** ブック内の対象シートのパス(例 xl/worksheets/sheet1.xml)を返す。名前に「マスタ」を含む最初のシート */
function findSheetPath_(workbookXml, workbookRelsXml) {
  var rels = parseRels_(workbookRelsXml), re = /<sheet\b[^>]*>/g, m, first = null, hit = null;
  while ((m = re.exec(workbookXml))) {
    var a = attrs_(m[0]), rid = a['r:id'], t = rels[rid];
    if (!t) continue;
    var path = 'xl/' + t.replace(/^\/?(xl\/)?/, '');
    if (!first) first = path;
    if (!hit && String(a.name).normalize('NFKC').indexOf('マスタ') >= 0) hit = path;
  }
  return hit || first;
}
/** シートXMLから { "図番\t製品名": url } を作る。リンクのある図番セルのみ対象 */
function extractLinks_(sheetXml, relsXml, sharedXml) {
  var ss = parseSharedStrings_(sharedXml), rels = parseRels_(relsXml);
  var hl = {}, re = /<hyperlink\b[^>]*>/g, m;
  while ((m = re.exec(sheetXml))) {
    var a = attrs_(m[0]), url = a['r:id'] ? rels[a['r:id']] : null;
    if (url && a.ref && a.ref.indexOf(':') < 0) hl[a.ref] = url;
  }
  var vals = {}, cre = /<c r="([A-Z]+)(\d+)"([^>]*?)(?:\/>|>([\s\S]*?)<\/c>)/g, c;
  while ((c = cre.exec(sheetXml))) {
    var col = c[1];
    if (col !== COL_ZUBAN && col !== COL_NAME) continue;
    var body = c[4] || '', t = (/\bt="(\w+)"/.exec(c[3]) || [])[1], v = /<v>([\s\S]*?)<\/v>/.exec(body), val = '';
    if (t === 's' && v) val = ss[parseInt(v[1], 10)] || '';
    else if (t === 'inlineStr') { var i = /<t[^>]*>([\s\S]*?)<\/t>/.exec(body); val = i ? decodeXml_(i[1]) : ''; }
    else if (v) val = decodeXml_(v[1]);
    vals[col + c[2]] = String(val).trim();
  }
  var links = {};
  Object.keys(hl).forEach(function (ref) {
    var mm = /^([A-Z]+)(\d+)$/.exec(ref);
    if (!mm || mm[1] !== COL_ZUBAN) return;
    var z = vals[ref], n = vals[COL_NAME + mm[2]];
    if (z && n) links[z + '\t' + n] = hl[ref];
  });
  return links;
}
/** 複数Excelの結果を統合。同じキーでリンクが異なる場合は dups に退避(アプリ側で「重複」扱い) */
function mergeLinks_(list) {
  var links = {}, dups = {};
  list.forEach(function (one) {
    Object.keys(one).forEach(function (k) {
      if (!(k in links)) links[k] = one[k];
      else if (links[k] !== one[k]) { dups[k] = dups[k] || [links[k]]; if (dups[k].indexOf(one[k]) < 0) dups[k].push(one[k]); }
    });
  });
  Object.keys(dups).forEach(function (k) { links[k] = dups[k]; });
  return links;
}
/** 件数の安全弁: 旧の90%未満になる再生成は上書きしない(Excelの欠損・読み取り失敗で件数が激減したJSONを公開しないため) */
function shrinkRejected_(oldCount, newCount) {
  return oldCount > 0 && newCount < oldCount * 0.9;
}
function maxModified_(sources) {
  return (sources || []).reduce(function (m, s) { return s.modified > m ? s.modified : m; }, '');
}
function sanitizeName_(s) {
  return String(s || 'shipping').replace(/\.pdf$/i, '').replace(/[\\\/:*?"<>|]/g, '_').slice(0, 80);
}

/* ===== GAS依存部 ===== */
function readXlsxLinks_(blob) {
  var files = {};
  Utilities.unzip(blob.setContentType('application/zip')).forEach(function (b) { files[b.getName()] = b; });
  var get = function (n) { return files[n] ? files[n].getDataAsString('UTF-8') : ''; };
  var path = findSheetPath_(get('xl/workbook.xml'), get('xl/_rels/workbook.xml.rels'));
  if (!path) return {};
  var relPath = path.replace(/([^\/]+)$/, '_rels/$1.rels');
  return extractLinks_(get(path), get(relPath), get('xl/sharedStrings.xml'));
}

/** マスタExcel全件 → リンク表JSONをDriveに保存。force=false のとき、件数が旧の90%未満なら上書きしない。
 *  戻り値: { ok, updated, count, prevCount, excelModified } か { ok:false, rejected:{oldCount,newCount} } */
function masterFiles_() {
  var it = DriveApp.getFolderById(MASTER_FOLDER_ID).getFiles(), out = [];
  while (it.hasNext()) {
    var f = it.next();
    if (/\.xlsx$/i.test(f.getName()) && f.getName().indexOf('~$') !== 0) out.push(f);
  }
  return out;
}
/** マスタExcelの「名前+更新日時」の一覧(並べ替えて連結)。前回の再生成時と同じなら、Excelに変更がない */
function signature_(files) {
  return files.map(function (f) { return f.getName() + '|' + f.getLastUpdated().toISOString(); }).sort().join('\n');
}
function build_(force) {
  var files = masterFiles_(), list = [], sources = [];
  for (var fi = 0; fi < files.length; fi++) {
    var f = files[fi];
    var one = readXlsxLinks_(f.getBlob());
    list.push(one);
    sources.push({ name: f.getName(), count: Object.keys(one).length, modified: f.getLastUpdated().toISOString() });
  }
  var merged = mergeLinks_(list), count = Object.keys(merged).length, props = PropertiesService.getScriptProperties();
  var folder = DriveApp.getFolderById(SAVE_FOLDER_ID), ex = folder.getFilesByName(LINKS_FILE_NAME), exFile = ex.hasNext() ? ex.next() : null;
  var meta = JSON.parse(props.getProperty('meta') || 'null');
  var prevCount = meta ? meta.count : (exFile ? Object.keys(JSON.parse(exFile.getBlob().getDataAsString('UTF-8')).links || {}).length : 0);
  if (!force && shrinkRejected_(prevCount, count)) {
    var rej = { at: new Date().toISOString(), oldCount: prevCount, newCount: count };
    props.setProperty('rejected', JSON.stringify(rej));
    return { ok: false, rejected: rej };
  }
  var updated = new Date().toISOString();
  var json = JSON.stringify({ updated: updated, sources: sources, links: merged });
  if (exFile) exFile.setContent(json); else folder.createFile(LINKS_FILE_NAME, json, 'application/json');
  var excelModified = maxModified_(sources);
  props.setProperty('meta', JSON.stringify({ updated: updated, count: count, excelModified: excelModified, sig: signature_(files) }));
  props.deleteProperty('rejected');
  return { ok: true, updated: updated, count: count, prevCount: prevCount, excelModified: excelModified };
}
/** 毎朝6時のトリガー用(トリガーは引数にイベントを渡すので、force を取らない形にしている) */
function buildMaster() { return build_(false); }
/** 件数が正当に10%以上減ったときだけ、Apps Scriptから手動実行する(安全弁を無視して作り直す) */
function buildMasterForce() { return build_(true); }
function setupDaily() {
  ScriptApp.getProjectTriggers().forEach(function (t) { if (t.getHandlerFunction() === 'buildMaster') ScriptApp.deleteTrigger(t); });
  ScriptApp.newTrigger('buildMaster').timeBased().everyDays(1).atHour(6).inTimezone('Asia/Tokyo').create();
}
function loadLinksJson_() {
  var ex = DriveApp.getFolderById(SAVE_FOLDER_ID).getFilesByName(LINKS_FILE_NAME);
  if (!ex.hasNext()) { buildMaster(); ex = DriveApp.getFolderById(SAVE_FOLDER_ID).getFilesByName(LINKS_FILE_NAME); }
  return ex.next().getBlob().getDataAsString('UTF-8');
}
function json_(o) { return ContentService.createTextOutput(typeof o === 'string' ? o : JSON.stringify(o)).setMimeType(ContentService.MimeType.JSON); }

var REBUILD_MIN_INTERVAL_MS = 60000; // 手動の再生成は1分以内に続けて実行しない

/** 画面の「最新のリンク付きマスタを取得」ボタン用。連打は1分で制限し、同時に走らないようロックする */
function rebuildNow_() {
  var props = PropertiesService.getScriptProperties(), meta = JSON.parse(props.getProperty('meta') || 'null');
  var last = Number(props.getProperty('lastRebuildAt') || 0);
  if (Date.now() - last < REBUILD_MIN_INTERVAL_MS && meta) return { ok: true, throttled: true, updated: meta.updated, count: meta.count, excelModified: meta.excelModified };
  var lock = LockService.getScriptLock();
  if (!lock.tryLock(1000)) return { ok: true, busy: true };
  try {
    // マスタExcelに変更がなければ(名前+更新日時が前回の再生成時と同じ)、約30秒かかる再生成を省く
    if (meta && meta.sig && signature_(masterFiles_()) === meta.sig) return { ok: true, unchanged: true, updated: meta.updated, count: meta.count, excelModified: meta.excelModified };
    props.setProperty('lastRebuildAt', String(Date.now()));
    return build_(false);
  } finally { lock.releaseLock(); }
}
/** 軽い状態確認(Driveを読まない)。画面が再生成の完了を待つときに使う */
function info_() {
  var props = PropertiesService.getScriptProperties(), meta = JSON.parse(props.getProperty('meta') || 'null') || {};
  return { ok: true, updated: meta.updated || '', count: meta.count || 0, excelModified: meta.excelModified || '', rejected: JSON.parse(props.getProperty('rejected') || 'null') };
}

function doGet(e) {
  var a = (e && e.parameter && e.parameter.action) || 'links';
  if (a === 'ping') return json_({ ok: true });
  if (a === 'info') return json_(info_());
  if (a === 'rebuild') {
    try { return json_(rebuildNow_()); } catch (err) { return json_({ ok: false, error: String(err) }); }
  }
  return json_(loadLinksJson_());
}

/** body(text/plain): JSON {name, pages, linked, ng, pdf(base64)} */
function doPost(e) {
  var lock = LockService.getScriptLock();
  try {
    lock.waitLock(20000);
    var d = JSON.parse(e.postData.contents), now = new Date();
    var stamp = Utilities.formatDate(now, 'Asia/Tokyo', 'yyyyMMdd_HHmmss');
    var blob = Utilities.newBlob(Utilities.base64Decode(d.pdf), 'application/pdf', sanitizeName_(d.name) + '_' + stamp + '.pdf');
    var file = DriveApp.getFolderById(SAVE_FOLDER_ID).createFile(blob);
    // 2行目に挿入(最新が常に2行目、古い記録ほど下へ)。列: 日時 / 枚数 / PDFのURL / リンク付与 / NG
    var sh = SpreadsheetApp.openById(SHEET_ID).getSheetByName(SHEET_NAME);
    sh.insertRowAfter(1);
    sh.getRange(2, 1, 1, 5).setValues([[Utilities.formatDate(now, 'Asia/Tokyo', 'yyyy/MM/dd HH:mm:ss'), Number(d.pages) || '', file.getUrl(),
      d.linked === undefined ? '' : Number(d.linked), d.ng === undefined ? '' : Number(d.ng)]]);
    return json_({ ok: true, url: file.getUrl() });
  } catch (err) {
    return json_({ ok: false, error: String(err) });
  } finally { lock.releaseLock(); }
}
