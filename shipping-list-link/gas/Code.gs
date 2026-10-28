/**
 * 出荷リスト図番リンク付与アプリ用 GAS(ms-tottori アカウントで実行)
 *  - 毎朝: マスタExcelのハイパーリンクを抜き出し「リンク表(JSON)」をDriveに保存
 *  - doGet : リンク表JSONを返す(?action=links) / 軽い状態確認(?action=info) / 今すぐ再生成(?action=rebuild。Excelに変更がなければ省略、連打は1分で制限、件数が旧の90%未満なら上書きしない)
 *            ?action=rebuild は前回の再生成後に更新されたExcelだけを読み直す(他は「Excelごとの抜き出し結果」を流用)。毎朝は全件読み直す
 *            / 版の確認(?action=ping → {ok, version})
 *  - doPost: 取り込んだ元PDFを保存フォルダへ保存し、スプレッドシート「記録」の2行目に日時/ページ数/URLを挿入(最新が上)
 *            / {action:'ocr', kind, image}: 詳細図PDFの切り出し画像をGeminiで読む(モデル名・APIKEYは「情報」シートから。1日400回まで)。?action=ocrcheck で設定の確認
 *
 * 【初回セットアップ】 ①このコードを貼り付け ②setupDaily を1回実行(権限を承認) ③buildMaster を1回実行
 *  ④デプロイ → ウェブアプリ(実行ユーザー=自分 / アクセス=全員)→ URLを app.js の GAS_URL に設定
 */
var MASTER_FOLDER_ID = '1HuBr3qZnO4N6BA6Zm_aU8BkVM45Q1K5q'; // マスタのままExcel置き場
var SAVE_FOLDER_ID = '1vekpzwfn-W0MqRyWWYzWdS4A6jp2bEt3';   // リンク表・記録シートの置き場
var PENDING_FOLDER_ID = '13RuLGCMh6LK0j3iP2xtTo2_mT7HTytm7'; // 取込んだ元ファイル(PDF・Excel)の保存先「リンク付与前ファイル保存」。作成から KEEP_DAYS 日を超えたらゴミ箱へ
var KEEP_DAYS = 10;
var SHEET_ID = '19l9P9C15wQ0jIcjIc_czZCiyDbnesQbq-Q88ttndMfs';
var SHEET_NAME = '記録';
var LINKS_FILE_NAME = '_リンク表.json';
var STORE_FILE_NAME = '_リンク表_Excel別.json'; // Excelごとの抜き出し結果(ボタンの再生成で、変更の無いExcelを読み直さないため)
var CODE_VERSION = '20261028b';                // コードを変えたら更新する(?action=ping で確認)
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
  return String(s || 'shipping').replace(/\.(pdf|xlsx|xlsm)$/i, '').replace(/[\\\/:*?"<>|]/g, '_').slice(0, 80);
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
/** Excelごとの抜き出し結果(STORE_FILE_NAME)を読む。{ ファイルID: {name, modified, d, links} }。無い・壊れているときは {} */
function readStore_() {
  try {
    var ex = DriveApp.getFolderById(SAVE_FOLDER_ID).getFilesByName(STORE_FILE_NAME);
    return ex.hasNext() ? (JSON.parse(ex.next().getBlob().getDataAsString('UTF-8')).files || {}) : {};
  } catch (e) { return {}; }
}
function writeStore_(files) {
  var folder = DriveApp.getFolderById(SAVE_FOLDER_ID), ex = folder.getFilesByName(STORE_FILE_NAME), json = JSON.stringify({ files: files });
  if (ex.hasNext()) ex.next().setContent(json); else folder.createFile(STORE_FILE_NAME, json, 'application/json');
}
/** マスタExcel → リンク表JSON。incremental=true のときは、名前と更新日時が前回と同じExcelは読まずに前回の抜き出し結果を使う */
function build_(force, incremental) {
  var t0 = Date.now(), files = masterFiles_(), list = [], sources = [], store = incremental ? readStore_() : {}, nextStore = {}, reread = [];
  for (var fi = 0; fi < files.length; fi++) {
    var f = files[fi], id = f.getId(), name = f.getName(), modified = f.getLastUpdated().toISOString(), prev = store[id], one;
    if (prev && prev.name === name && prev.modified === modified) {
      one = expandLinks_(prev);
      nextStore[id] = prev;
    } else {
      var t1 = Date.now();
      one = readXlsxLinks_(f.getBlob());
      reread.push(name + ' ' + (Date.now() - t1) + 'ms');
      var c = compactLinks_(one);
      nextStore[id] = { name: name, modified: modified, d: c.d, links: c.links };
    }
    list.push(one);
    sources.push({ name: name, count: Object.keys(one).length, modified: modified });
  }
  console.log('Excel読み直し ' + reread.length + '/' + files.length + '件: ' + reread.join(', '));
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
  var json = JSON.stringify(compactMaster_({ updated: updated, sources: sources, links: merged }));
  if (exFile) exFile.setContent(json); else folder.createFile(LINKS_FILE_NAME, json, 'application/json');
  var excelModified = maxModified_(sources);
  props.setProperty('meta', JSON.stringify({ updated: updated, count: count, excelModified: excelModified, sig: signature_(files) }));
  props.deleteProperty('rejected');
  try { writeStore_(nextStore); } catch (e) { console.log('Excel別の抜き出し結果の保存に失敗: ' + e); }   // 失敗しても次回は全件読み直すだけ
  cacheClear_();
  cachePut_(json);   // 画面が次に読むGAS側キャッシュを、消すだけでなく新しいリンク表で作り直しておく
  var ms = Date.now() - t0;
  console.log('再生成 ' + ms + 'ms(件数 ' + count + ')');
  return { ok: true, updated: updated, count: count, prevCount: prevCount, excelModified: excelModified, reread: reread.length, ms: ms };
}
/** 毎朝6時のトリガー用(トリガーは引数にイベントを渡すので、force を取らない形にしている)。安全のため全件読み直す */
function buildMaster() { return build_(false); }
/** 件数が正当に10%以上減ったときだけ、Apps Scriptから手動実行する(安全弁を無視して作り直す) */
function buildMasterForce() { return build_(true); }
/** 保存先フォルダ(PENDING_FOLDER_ID)のうち、作成から KEEP_DAYS 日を超えたファイルをゴミ箱へ移す(完全削除はしない)。毎日のトリガー用 */
function trashOldFiles() {
  var limit = Date.now() - KEEP_DAYS * 24 * 3600 * 1000, it = DriveApp.getFolderById(PENDING_FOLDER_ID).getFiles(), n = 0;
  while (it.hasNext()) { var f = it.next(); if (f.getDateCreated().getTime() < limit) { f.setTrashed(true); n++; } }
  return n;
}
/** Apps Scriptから1回だけ手動実行する: 毎日3時に trashOldFiles を動かすトリガーを作る */
function setupTrash() {
  ScriptApp.getProjectTriggers().forEach(function (t) { if (t.getHandlerFunction() === 'trashOldFiles') ScriptApp.deleteTrigger(t); });
  ScriptApp.newTrigger('trashOldFiles').timeBased().everyDays(1).atHour(3).inTimezone('Asia/Tokyo').create();
}
function setupDaily() {
  ScriptApp.getProjectTriggers().forEach(function (t) { if (t.getHandlerFunction() === 'buildMaster') ScriptApp.deleteTrigger(t); });
  ScriptApp.newTrigger('buildMaster').timeBased().everyDays(1).atHour(6).inTimezone('Asia/Tokyo').create();
}
/** リンク表を圧縮形式にする: 同じフォルダ名(URLの最後の「/」まで)を d に1回だけ持ち、links の値は「d の番号|ファイル名」。6.6MB→約1.4MB
 *  重複(リンクが複数)の値は配列のまま、要素ごとに同じ形にする */
function compactLinks_(src) {
  var d = [], idx = {}, links = {};
  var one = function (v) {
    var i = v.lastIndexOf('/') + 1, p = v.slice(0, i);
    if (!(p in idx)) { idx[p] = d.length; d.push(p); }
    return idx[p] + '|' + v.slice(i);
  };
  Object.keys(src).forEach(function (k) { var v = src[k]; links[k] = Array.isArray(v) ? v.map(one) : one(v); });
  return { d: d, links: links };
}
function expandLinks_(c) {
  var links = {};
  var one = function (v) { var i = v.indexOf('|'); return (i > 0 ? c.d[+v.slice(0, i)] : '') + v.slice(i + 1); };
  Object.keys(c.links).forEach(function (k) { var v = c.links[k]; links[k] = Array.isArray(v) ? v.map(one) : one(v); });
  return links;
}
function compactMaster_(m) {
  if (m.d) return m;
  var c = compactLinks_(m.links);
  return { updated: m.updated, sources: m.sources, d: c.d, links: c.links };
}
// GAS側キャッシュ(CacheService)。1キー約100KBまでなので、gzip+base64にして90,000文字ずつに分けて持つ。再生成(build_)で破棄
var CACHE_CHUNK = 90000, CACHE_SEC = 21600;
function cacheClear_() { try { CacheService.getScriptCache().remove('lk_meta'); } catch (e) {} }
function cacheGet_() {
  try {
    var c = CacheService.getScriptCache(), n = Number(c.get('lk_meta') || 0);
    if (!n) return null;
    var keys = [], i; for (i = 0; i < n; i++) keys.push('lk_' + i);
    var got = c.getAll(keys), s = '';
    for (i = 0; i < n; i++) { if (!got['lk_' + i]) return null; s += got['lk_' + i]; }
    return Utilities.ungzip(Utilities.newBlob(Utilities.base64Decode(s), 'application/x-gzip')).getDataAsString('UTF-8');
  } catch (e) { return null; }
}
function cachePut_(json) {
  try {
    var s = Utilities.base64Encode(Utilities.gzip(Utilities.newBlob(json, 'application/json', 'l.json')).getBytes()), o = {}, n = 0;
    for (var p = 0; p < s.length; p += CACHE_CHUNK) o['lk_' + (n++)] = s.slice(p, p + CACHE_CHUNK);
    var c = CacheService.getScriptCache();
    c.putAll(o, CACHE_SEC); c.put('lk_meta', String(n), CACHE_SEC);
  } catch (e) {}
}
function loadLinksJson_() {
  var hit = cacheGet_();
  if (hit) return hit;
  var folder = DriveApp.getFolderById(SAVE_FOLDER_ID), ex = folder.getFilesByName(LINKS_FILE_NAME);
  if (!ex.hasNext()) { buildMaster(); ex = folder.getFilesByName(LINKS_FILE_NAME); }
  var file = ex.next(), json = file.getBlob().getDataAsString('UTF-8');
  if (json.indexOf('"d":[') < 0) { json = JSON.stringify(compactMaster_(JSON.parse(json))); file.setContent(json); }   // 従来形式のファイルは、最初の1回だけ圧縮形式に変換して保存し直す
  cachePut_(json);
  return json;
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
    return build_(false, true);   // 前回の再生成後に更新されたExcelだけを読み直す
  } finally { lock.releaseLock(); }
}
/** 軽い状態確認(Driveを読まない)。画面が再生成の完了を待つときに使う */
function info_() {
  var props = PropertiesService.getScriptProperties(), meta = JSON.parse(props.getProperty('meta') || 'null') || {};
  return { ok: true, updated: meta.updated || '', count: meta.count || 0, excelModified: meta.excelModified || '', rejected: JSON.parse(props.getProperty('rejected') || 'null') };
}

function doGet(e) {
  var a = (e && e.parameter && e.parameter.action) || 'links';
  if (a === 'ping') return json_({ ok: true, version: CODE_VERSION });
  if (a === 'ocrcheck') return json_(ocrCheck_());   // 情報シートのGeminiモデル名・APIKEYが使えるかの確認(キーは返さない)
  if (a === 'info') return json_(info_());
  if (a === 'rebuild') {
    try { return json_(rebuildNow_()); } catch (err) { return json_({ ok: false, error: String(err) }); }
  }
  return json_(loadLinksJson_());
}

/* ===== 図面PDF(文字データの無い詳細図)の読み取り: Gemini =====
 * モデル名・APIKEYはスプレッドシート「情報」シート(A列=項目名、B列=値)から項目名で探して読む。空なら別モデルに切り替えずエラーにする。
 * 画面からは kind(locate/number/table)と画像だけを受け取り、プロンプトはここで固定する(任意の質問に使われないように)。 */
var OCR_DAILY_LIMIT = 400;   // 1日の呼び出し上限(誰でも呼べるdoPostの乱用でGeminiの無料枠を使い切られないように)
var OCR_BOX = { type: 'ARRAY', items: { type: 'INTEGER' } };   // [ymin, xmin, ymax, xmax] を0〜1000で
var OCR_KINDS = {
  locate: {
    prompt: 'これは建築鉄骨の詳細図(日本語のCAD図面)の全体です。次を返してください。\n' +
      '1. drawingNumber: 右下の表題欄の「図面番号」欄に書かれた文字(例 EA1-2G-01)。読めなければ空文字。\n' +
      '2. drawingNumberBox: その図面番号の文字の位置 [ymin,xmin,ymax,xmax](画像全体を0〜1000とした値)。\n' +
      '3. tables: 図面内の「製品表」の位置の一覧。製品表とは、罫線で囲まれた横1行の表で、右端のセルが台数(例「1台」)になっているもの。' +
      '梁は「製品名|設計符号|部材サイズ|台数」、柱は「設計符号|設計符号|製品名|図示|台数」の並び。キープランの中の文字、表題欄、注記の表は含めない。見つからなければ空配列。' +
      ' 各表には cells も付ける: 左のセルから順に、各セルの文字 text と、その文字の位置 box([ymin,xmin,ymax,xmax]、画像全体を0〜1000とした値)。空のセルは text を空文字にする。',
    schema: { type: 'OBJECT', properties: { drawingNumber: { type: 'STRING' }, drawingNumberBox: OCR_BOX,
      tables: { type: 'ARRAY', items: { type: 'OBJECT', properties: { box: OCR_BOX, cells: { type: 'ARRAY', items: { type: 'OBJECT',
      properties: { text: { type: 'STRING' }, box: OCR_BOX }, required: ['text'] } } }, required: ['box'] } } }, required: ['drawingNumber', 'tables'] }
  },
  number: {
    prompt: '画像は図面の表題欄の「図面番号」欄です。図面番号の文字だけを text に返してください(英大文字・数字・ハイフンのみ。例 EA1-2G-01)。読めなければ空文字。',
    schema: { type: 'OBJECT', properties: { text: { type: 'STRING' } }, required: ['text'] }
  },
  table: {
    prompt: '画像は図面の製品表(罫線で囲まれた横1行の表)です。左のセルから順に、各セルの文字を見えるとおりに cells に返してください。' +
      '各セルは text(文字)と box(そのセルの文字の位置 [ymin,xmin,ymax,xmax]、画像全体を0〜1000とした値)。空のセルは text を空文字にする。',
    schema: { type: 'OBJECT', properties: { cells: { type: 'ARRAY', items: { type: 'OBJECT',
      properties: { text: { type: 'STRING' }, box: OCR_BOX }, required: ['text'] } } }, required: ['cells'] }
  }
};
function infoMap_() {   // 情報シート(A列=項目名、B列=値)を1回で読む
  var sh = SpreadsheetApp.openById(SHEET_ID).getSheetByName('情報');
  if (!sh) throw new Error('スプレッドシートに「情報」シートがありません');
  var v = sh.getDataRange().getValues(), o = {};
  for (var i = 0; i < v.length; i++) o[String(v[i][0]).trim()] = String(v[i][1] || '').trim();
  return o;
}
function ocrSettings_() {
  // 情報シートの読み込み(読み取りのたびにスプレッドシートを開かないよう)は、60秒だけスクリプトのキャッシュに持つ。キーやモデル名を変えたら、最大60秒で反映される
  var cache = CacheService.getScriptCache(), hit = cache.get('ocr_settings');
  if (hit) return JSON.parse(hit);
  var info = infoMap_(), model = info['Geminiモデル名'], key = info['APIKEY'];
  if (!model) throw new Error('情報シートのGeminiモデル名が空です');
  if (!key) throw new Error('情報シートのAPIKEYが空です');
  var st = { model: model, key: key };
  cache.put('ocr_settings', JSON.stringify(st), 60);
  return st;
}
function geminiCall_(st, parts, schema) {
  var res = UrlFetchApp.fetch('https://generativelanguage.googleapis.com/v1beta/models/' + encodeURIComponent(st.model) + ':generateContent', {
    method: 'post', contentType: 'application/json', headers: { 'x-goog-api-key': st.key }, muteHttpExceptions: true,
    payload: JSON.stringify({ contents: [{ parts: parts }], generationConfig: { temperature: 0, responseMimeType: 'application/json', responseSchema: schema } })
  });
  var code = res.getResponseCode(), body = res.getContentText();
  if (code !== 200) throw new Error('Gemini応答エラー ' + code + ': ' + body.slice(0, 200));
  var j = JSON.parse(body), t = j.candidates && j.candidates[0] && j.candidates[0].content && j.candidates[0].content.parts && j.candidates[0].content.parts[0] && j.candidates[0].content.parts[0].text;
  if (!t) throw new Error('Geminiの応答が空です');
  return JSON.parse(t);
}
function ocrCheck_() {
  try {
    var st = ocrSettings_();
    geminiCall_(st, [{ text: '{"ok":true} をそのままJSONで返してください。' }], { type: 'OBJECT', properties: { ok: { type: 'BOOLEAN' } } });
    return { ok: true, model: st.model };
  } catch (err) { return { ok: false, error: String(err) }; }
}
function ocrRead_(d) {
  try {
    var k = OCR_KINDS[d.kind];
    if (!k) throw new Error('kind が不正です');
    if (!d.image || String(d.image).length > 6000000) throw new Error('画像が無い、または大きすぎます');
    var props = PropertiesService.getScriptProperties(), day = 'ocr_' + Utilities.formatDate(new Date(), 'Asia/Tokyo', 'yyyyMMdd');
    var n = Number(props.getProperty(day) || 0);
    if (n >= OCR_DAILY_LIMIT) throw new Error('本日の読み取り上限(' + OCR_DAILY_LIMIT + '回)に達しました');
    props.setProperty(day, String(n + 1));
    return { ok: true, data: geminiCall_(ocrSettings_(), [{ text: k.prompt }, { inline_data: { mime_type: 'image/jpeg', data: d.image } }], k.schema) };
  } catch (err) { return { ok: false, error: String(err) }; }
}

/** body(text/plain): JSON {name, pages, linked, ng, pdf(base64)} または {name, pages(シート数), linked, ng, xlsx(base64)}、または {action:'ocr', kind, image(JPEGのbase64)} */
function doPost(e) {
  var d0 = null;
  try { d0 = JSON.parse(e.postData.contents); } catch (err) { return json_({ ok: false, error: String(err) }); }
  if (d0 && d0.action === 'ocr') return json_(ocrRead_(d0));   // 読み取りはロック不要(並列で呼ばれる)
  var lock = LockService.getScriptLock();
  try {
    lock.waitLock(20000);
    var d = d0, now = new Date();
    var stamp = Utilities.formatDate(now, 'Asia/Tokyo', 'yyyyMMdd_HHmmss');
    var blob;
    if (d.xlsx) {   // Excel(枚数の列にはシート数、URLの列にはExcelのURLを入れる)
      var ext = /\.xlsm$/i.test(d.name) ? 'xlsm' : 'xlsx';
      blob = Utilities.newBlob(Utilities.base64Decode(d.xlsx), ext === 'xlsm' ? 'application/vnd.ms-excel.sheet.macroEnabled.12' : 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet', sanitizeName_(d.name) + '_' + stamp + '.' + ext);
    } else {
      blob = Utilities.newBlob(Utilities.base64Decode(d.pdf), 'application/pdf', sanitizeName_(d.name) + '_' + stamp + '.pdf');
    }
    var file = DriveApp.getFolderById(PENDING_FOLDER_ID).createFile(blob);
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
