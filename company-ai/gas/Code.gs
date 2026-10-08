/**
 * 社内AI(第1弾): 就業規則への質問 + ログイン照合 + 質問ログ/👎報告 + 毎朝の名簿取り込み + 朝3時のメール
 * スプレッドシート「社内AI」にコンテナバインドして使う。設置手順は README.md。
 * 純粋な処理(条文分割・検索・名簿の合体・プロンプト)は Logic.gs。
 */
var MODEL = 'gemini-3.5-flash-lite'; // 固定。明示の指示があるときだけ変える(自動選択・可変にしない)
var SHEET = { OPERATOR: 'Operator', ADMIN: '管理者', RULES: '規則', STAGE: '規則_取込', HIST: '規則履歴',
              LOG: '質問ログ', CAL: 'CompanyCalendar', CONS: 'Construction', META: '設定', INFO: '諸情報', ABS: '有給欠勤',
              WORK: '日報', WORKP: '日報_過去', CONT: '作業内容', CONS5: '工事_建設', PROD: '生産重量', PRODS: '生産重量_状態' };
var PROD_INDEX_ID = '14Wgpkny7wIboiRKLyp7wZ8hxzUVevKmXdVJGIpV7A3c'; // 「Excelマスタ一覧」(諸情報の「Excelマスタ一覧」に入れれば、そちらを優先)
var OPERATOR_HEADER = ['社員No', '氏名', '事業部', '工場', '部', '生まれた月', '電話番号', 'E-Mail', 'Reportcheck', '運転者', '管理者'];
var LOG_HEADER = ['質問ID', '日時', 'E-Mail', '氏名', '質問', '回答', '区分', '参照', '評価', 'コメント', '検索ms', 'Gemini ms', '合計ms', '対応状況'];
var RULE_HEADER = ['規程', '条', '見出し', '本文'];
var TZ = 'Asia/Tokyo';

// ---------- 小さな道具 ----------
// 設定は「諸情報」シート(A=名前、B=値)だけから読む
function prop_(k, optional) {
  var v = '', sh = ss_().getSheetByName(SHEET.INFO);
  if (sh) {
    var vals = sh.getDataRange().getValues();
    for (var i = 1; i < vals.length; i++) {
      if (String(vals[i][0]).trim() === k && String(vals[i][1]).trim()) { v = String(vals[i][1]).trim(); break; }
    }
  }
  if (!v && !optional) throw new Error('「諸情報」シートの「' + k + '」が未入力です');
  return v;
}
function ss_() { return SpreadsheetApp.getActiveSpreadsheet(); }
function sheet_(name, header) {
  var sh = ss_().getSheetByName(name);
  if (!sh) { sh = ss_().insertSheet(name); if (header) sh.getRange(1, 1, 1, header.length).setValues([header]); }
  return sh;
}
function now_() { return Utilities.formatDate(new Date(), TZ, 'yyyy/MM/dd HH:mm:ss'); }
function getMeta_(k) {
  var vals = sheet_(SHEET.META, ['項目', '値']).getDataRange().getValues();
  for (var i = 1; i < vals.length; i++) if (vals[i][0] === k) return ts_(vals[i][1]); // 日時はシートが日付に変えて返すため、文字に直す
  return '';
}
function setMeta_(k, v) {
  var sh = sheet_(SHEET.META, ['項目', '値']), vals = sh.getDataRange().getValues();
  for (var i = 1; i < vals.length; i++) if (vals[i][0] === k) { sh.getRange(i + 1, 2).setValue(v); return; }
  sh.appendRow([k, v]);
}
function json_(o) { return ContentService.createTextOutput(JSON.stringify(o)).setMimeType(ContentService.MimeType.JSON); }
function err_(code, msg) { var e = new Error(msg || code); e.code = code; return e; }
var CACHE_PART = 30000; // 日本語は1文字3バイト。1キー100KBの上限に収める
function putLarge_(key, str, sec) {
  try {
    var c = CacheService.getScriptCache(), n = Math.ceil(str.length / CACHE_PART), o = {};
    for (var i = 0; i < n; i++) o[key + '_' + i] = str.substr(i * CACHE_PART, CACHE_PART);
    o[key + '_n'] = String(n); c.putAll(o, sec);
  } catch (e) { /* キャッシュに載せられなくても、毎回シートから読むだけで動く */ }
}
function getLarge_(key) {
  var c = CacheService.getScriptCache(), n = parseInt(c.get(key + '_n') || '0', 10);
  if (!n) return null;
  var keys = []; for (var i = 0; i < n; i++) keys.push(key + '_' + i);
  var got = c.getAll(keys), s = '';
  for (var j = 0; j < n; j++) { if (got[key + '_' + j] == null) return null; s += got[key + '_' + j]; }
  return s;
}

// シートに書く文字が「=」などで始まると数式として実行されるため、先頭に ' を付けて文字として扱わせる
function safe_(s) { s = String(s == null ? '' : s); return /^[=+\-@\t\r]/.test(s) ? "'" + s : s; }
// 日時はシートが日付に変換して返すことがあるため、文字でも日付でも同じ形に直す
function ts_(v) { return v instanceof Date ? Utilities.formatDate(v, TZ, 'yyyy/MM/dd HH:mm:ss') : String(v); }
// シートから読んだ日時(Date)を、タイムゾーンの影響が出ないよう文字に直す(Logic.gsは文字の日付だけを扱う)
function plain_(values) {
  function p2(n) { return (n < 10 ? '0' : '') + n; }
  return values.map(function (row) {
    return row.map(function (v) {
      if (!(v instanceof Date)) return v;
      var j = new Date(v.getTime() + 9 * 3600000); // 日本時間(夏時間なし)。大量の日報で formatDate を呼ぶと遅いため直接計算
      return j.getUTCFullYear() + '/' + p2(j.getUTCMonth() + 1) + '/' + p2(j.getUTCDate()) + ' ' + p2(j.getUTCHours()) + ':' + p2(j.getUTCMinutes()) + ':' + p2(j.getUTCSeconds());
    });
  });
}
// 書き込み中に空になる瞬間を作らない: 先に新しい内容を書き、余った下の行だけを消す
function writeTable_(sh, values) {
  var rows = values.length, last = sh.getLastRow();
  sh.getRange(1, 1, rows, values[0].length).setValues(values);
  if (last > rows) sh.getRange(rows + 1, 1, last - rows, sh.getMaxColumns()).clearContent();
}

// 同じ要求ID(rid)の再送は、もう一度実行せず前回の結果を返す。
// Googleの応答が途中で失われて画面が再送しても、質問が二重に記録されたり、AIが二重に呼ばれたりしない
function replay_(user, rid, fn) {
  if (!rid) return fn();
  var c = CacheService.getScriptCache(), k = 'rid_' + user.email + '_' + String(rid).slice(0, 40), hit = c.get(k);
  if (hit) return JSON.parse(hit);
  if (c.get(k + '_run')) { // 同じ要求が実行中: 終わるのを待って、その結果を返す
    for (var i = 0; i < 40; i++) { Utilities.sleep(500); hit = c.get(k); if (hit) return JSON.parse(hit); }
    throw err_('busy', '処理に時間がかかっています。少し待ってからもう一度お試しください');
  }
  c.put(k + '_run', '1', 60);
  try { var r = fn(); c.put(k, JSON.stringify(r), 300); return r; } finally { c.remove(k + '_run'); }
}

// ---------- Webアプリ ----------
function doGet() { return json_({ ok: true, app: '社内AI', model: MODEL }); }

function doPost(e) {
  try {
    var req = JSON.parse(e.postData.contents);
    var user = authenticate_(req.idToken);
    if (req.action === 'me') return json_({ ok: true, name: user.name, isAdmin: user.isAdmin });
    if (req.action === 'ask') return json_(replay_(user, req.rid, function () { return ask_(user, req.question); }));
    if (req.action === 'feedback') return json_(replay_(user, req.rid, function () { return feedback_(user, req); }));
    throw err_('bad_request', '不明な操作です');
  } catch (err) {
    return json_({ ok: false, error: err.code || 'error', message: String(err.message || err) });
  }
}

// ---------- ログイン: GoogleのIDトークンを検証 → 名簿(Operator)のE-Mailと照合 ----------
function authenticate_(idToken) {
  if (!idToken) throw err_('auth', 'ログインが必要です');
  var cache = CacheService.getScriptCache();
  var hash = Utilities.base64EncodeWebSafe(Utilities.computeDigest(Utilities.DigestAlgorithm.SHA_256, idToken));
  var email = cache.get('tok_' + hash);
  if (!email) {
    var res = UrlFetchApp.fetch('https://oauth2.googleapis.com/tokeninfo?id_token=' + encodeURIComponent(idToken), { muteHttpExceptions: true });
    if (res.getResponseCode() !== 200) throw err_('auth', 'ログインの期限が切れました。もう一度ログインしてください');
    var info = JSON.parse(res.getContentText());
    if (info.aud !== prop_('CLIENT_ID') || String(info.email_verified) !== 'true') throw err_('auth', 'ログイン情報が正しくありません');
    email = AI_LOGIC.normEmail(info.email);
    var left = Math.max(60, Math.min(600, Number(info.exp) - Math.floor(Date.now() / 1000)));
    cache.put('tok_' + hash, email, left);
  }
  var roster = getRoster_();
  var p = roster[email];
  if (!p) throw err_('forbidden', 'このアカウントは利用登録されていません。管理者へ連絡してください');
  return { email: email, name: p.name, no: p.no, isAdmin: p.admin };
}
function getRoster_() {
  var c = getLarge_('roster');
  if (c) return JSON.parse(c);
  var vals = sheet_(SHEET.OPERATOR, OPERATOR_HEADER).getDataRange().getValues(), map = {};
  for (var i = 1; i < vals.length; i++) {
    var em = AI_LOGIC.normEmail(vals[i][7]);
    if (em) map[em] = { no: vals[i][0], name: vals[i][1], admin: String(vals[i][10]) === '管理者' };
  }
  if (Object.keys(map).length) putLarge_('roster', JSON.stringify(map), 300);
  return map;
}

// ---------- 質問に答える ----------
function loadRules_() {
  var c = getLarge_('rules'), chunks;
  if (c) chunks = JSON.parse(c);
  else {
    var vals = sheet_(SHEET.RULES, RULE_HEADER).getDataRange().getValues();
    chunks = vals.slice(1).filter(function (r) { return r[3]; }).map(function (r) {
      return { doc: String(r[0]), no: Number(r[1]) || 0, heading: String(r[2]), body: String(r[3]) };
    });
    if (chunks.length) putLarge_('rules', JSON.stringify(chunks), 21600);
  }
  return chunks;
}

function callGemini_(prompt) {
  var res, code;
  for (var i = 0; i < 3; i++) { // 一時的な障害(500/502/503/504)は、少し待って最大3回まで送る
    res = UrlFetchApp.fetch('https://generativelanguage.googleapis.com/v1beta/models/' + MODEL + ':generateContent', {
      method: 'post', contentType: 'application/json', muteHttpExceptions: true,
      headers: { 'x-goog-api-key': prop_('GEMINI_API_KEY') },
      payload: JSON.stringify({ contents: [{ role: 'user', parts: [{ text: prompt }] }],
                                generationConfig: { temperature: 0, responseMimeType: 'application/json' } })
    });
    code = res.getResponseCode();
    if (code !== 500 && code !== 502 && code !== 503 && code !== 504) break;
    if (i < 2) Utilities.sleep(2000 * (i + 1));
  }
  if (code === 429 || code === 503) throw err_('busy', 'ただいま混み合っています。少し待ってからもう一度お試しください');
  if (code !== 200) throw err_('ai', 'AIの呼び出しに失敗しました(' + code + ')');
  var j = JSON.parse(res.getContentText());
  var parts = (j.candidates && j.candidates[0] && j.candidates[0].content && j.candidates[0].content.parts) || [];
  return parts.map(function (p) { return p.text || ''; }).join('');
}

function ask_(user, question) {
  var t0 = Date.now();
  question = String(question || '').trim();
  if (!question) throw err_('bad_request', '質問を入力してください');
  if (question.length > 300) throw err_('bad_request', '質問は300文字以内にしてください');
  var abs = AI_LOGIC.parseAbsenceQuery(question, Utilities.formatDate(new Date(), TZ, 'yyyy/MM/dd'), rosterList_());
  if (abs) return askAbsence_(user, question, abs, t0);
  var wk = AI_LOGIC.parseWorkQuery(question, Utilities.formatDate(new Date(), TZ, 'yyyy/MM/dd'), rosterList_(), loadProjects_());
  if (wk) return askWork_(user, question, wk, t0);
  var prod = AI_LOGIC.parseProdQuery(question, Utilities.formatDate(new Date(), TZ, 'yyyy/MM/dd'), loadProdProjects_());
  if (prod) return askProd_(user, question, prod, t0);
  var cal = AI_LOGIC.parseCalendarQuery(question, Utilities.formatDate(new Date(), TZ, 'yyyy/MM/dd'));
  if (cal) return askCalendar_(user, question, cal, t0);
  var chunks = loadRules_();
  if (!chunks.length) throw err_('no_rules', '就業規則がまだ登録されていません');
  var t1 = Date.now();
  var hits = AI_LOGIC.searchRules(chunks, question, 6);
  var tSearch = Date.now() - t1, tAi = 0;
  var answerable = false, answer = '', sources = [];
  var qid = 'Q' + Utilities.getUuid().replace(/-/g, '').slice(0, 7).toUpperCase();
  if (hits.length) {
    var t2 = Date.now(), out;
    try {
      out = AI_LOGIC.parseModelJson(callGemini_(AI_LOGIC.buildPrompt(question, hits)));
    } catch (e) { // AIが失敗した質問も、担当者が気づけるようログに残す
      logAsk_(qid, user, question, '', 'エラー', '', tSearch, Date.now() - t2, Date.now() - t0, '未対応');
      throw e;
    }
    tAi = Date.now() - t2;
    if (out && out.answerable === true && out.answer) {
      answerable = true; answer = String(out.answer);
      sources = AI_LOGIC.pickSources(out.cited, answer, hits).map(function (i) { return AI_LOGIC.chunkLabel(hits[i].chunk); });
    }
  }
  var total = Date.now() - t0;
  logAsk_(qid, user, question, answer, answerable ? '回答済' : '回答不可', sources.join(' / '), tSearch, tAi, total, answerable ? '' : '未対応');
  return { ok: true, qid: qid, answerable: answerable, answer: answer, sources: sources,
           asOf: getMeta_('rules_version'), ms: { search: tSearch, ai: tAi, total: total } };
}

// 有給・欠勤の質問: 数字はコードが計算して文章にする(AIは使わない)
function rosterList_() {
  var m = getRoster_(), out = [];
  Object.keys(m).forEach(function (k) { out.push({ no: m[k].no, name: m[k].name }); });
  return out;
}
function loadAbsence_() {
  var vals = plain_(sheet_(SHEET.ABS, AI_LOGIC.ABS_HEADER).getDataRange().getValues());
  return vals.slice(1).filter(function (r) { return r[0]; });
}
function loadHolidays_() {
  var vals = plain_(sheet_(SHEET.CAL).getDataRange().getValues()), h = {};
  for (var i = 1; i < vals.length; i++) { var d = AI_LOGIC.normDate(vals[i][0]); if (d) h[d] = String(vals[i][1]).trim(); }
  return h;
}
function askAbsence_(user, question, abs, t0) {
  var qid = 'Q' + Utilities.getUuid().replace(/-/g, '').slice(0, 7).toUpperCase(), answer = '', ok = false;
  var src = '有給・欠勤データ(日報アプリのAbsenteeism)';
  if (abs.who === 'ambiguous') {
    answer = '該当する方が複数います: ' + abs.people.map(function (p) { return p.name + '(社員No' + p.no + ')'; }).join('、') + '。お一人ずつ質問してください。';
  } else {
    var p = abs.who === 'self' ? { no: user.no, name: user.name } : abs.people[0];
    var rows = loadAbsence_();
    if (!rows.length) throw err_('no_data', '有給・欠勤のデータがまだ取り込まれていません。管理者に連絡してください');
    var sum = AI_LOGIC.summarizeAbsence(rows, p.no, abs.period, loadHolidays_());
    answer = AI_LOGIC.formatAbsenceAnswer(p.name, p.no, abs.period, sum, abs.remain, getMeta_('absence_synced_at').slice(0, 10) || '更新日不明');
    ok = true;
  }
  var total = Date.now() - t0;
  logAsk_(qid, user, question, answer, '回答済', ok ? src : '', 0, 0, total, '');
  return { ok: true, qid: qid, answerable: true, answer: answer, sources: [src], asOf: '有給・欠勤 ' + (getMeta_('absence_synced_at') || '(更新日不明)'),
           ms: { search: 0, ai: 0, total: total } };
}

// ---------- 生産重量の質問(「加工」完了日の重量。締め日基準): コードが集計して答える ----------
function loadProdProjects_() {
  var c = getLarge_('prodprojects');
  if (c) return JSON.parse(c);
  var sh = ss_().getSheetByName(SHEET.PROD), out = [], seen = {};
  if (sh && sh.getLastRow() > 1) sh.getRange(2, 1, sh.getLastRow() - 1, 2).getValues().forEach(function (r) {
    var k = String(r[0]) + '|' + String(r[1]);
    if (r[1] && !seen[k]) { seen[k] = 1; out.push({ id: '', no: String(r[0]).trim(), name: String(r[1]).trim() }); }
  });
  if (out.length) putLarge_('prodprojects', JSON.stringify(out), 3600);
  return out;
}
function askProd_(user, question, pq, t0) {
  var qid = 'Q' + Utilities.getUuid().replace(/-/g, '').slice(0, 7).toUpperCase(), src = '生産重量(案件マスターの「加工」完了日)', answer;
  if (pq.projects.length > 1) {
    answer = '該当する工事が複数あります: ' + pq.projects.slice(0, 6).map(function (p) { return p.name + '(' + p.no + ')'; }).join('、') + '。工事名か工事番号をもう少し詳しく書いてください。';
  } else {
    if (!ss_().getSheetByName(SHEET.PROD) || ss_().getSheetByName(SHEET.PROD).getLastRow() < 2) throw err_('no_data', '生産重量のデータがまだ取り込まれていません。管理者に連絡してください');
    var fromN = Number(pq.period.from.replace(/\//g, '')), toN = Number(pq.period.to.replace(/\//g, ''));
    var rows = rangeRows_(SHEET.PROD, 5, AI_LOGIC.PROD_HEADER.length, fromN, toN), f = { sites: pq.sites, parts: pq.parts };
    var title = '全社';
    if (pq.projects.length) { f.project = pq.projects[0]; title = '工事「' + f.project.name + '」(' + f.project.no + ')'; }
    if (pq.sites.length) title += ' ' + pq.sites.join('・');
    if (pq.parts.length) title += ' ' + pq.parts.join('・');
    var today = Utilities.formatDate(new Date(), TZ, 'yyyy/MM/dd'), last = pq.period.to < today ? pq.period.to : today;
    var wd = AI_LOGIC.countWorkDays(loadHolidays_(), pq.period.from, last);
    var sum = AI_LOGIC.summarizeProd(rows, f);
    answer = AI_LOGIC.formatProdAnswer(sum, { title: title, period: pq.period, asOf: (getMeta_('prod_synced_at') || '').slice(0, 10) || '更新日不明', workDays: pq.period.isDay ? 0 : wd, skipProject: !!f.project });
  }
  var total = Date.now() - t0;
  logAsk_(qid, user, question, answer, '回答済', src, 0, 0, total, '');
  return { ok: true, qid: qid, answerable: true, answer: answer, sources: [src], asOf: '生産重量 ' + (getMeta_('prod_synced_at') || '(更新日不明)'), ms: { search: 0, ai: 0, total: total } };
}

// 案件マスター(約34件)から「加工」完了分だけを「生産重量」シートへ。工事番号・工事名は「Excelマスタ一覧」の表を正とする。
// 6分の制限があるため、更新があったファイルだけを時間の許す限り処理する(残りは次回。メニューで続けて実行できる)
function readProdIndex_() {
  var id = prop_('Excelマスタ一覧', true) || PROD_INDEX_ID, ss = SpreadsheetApp.openById(id);
  var sh = ss.getSheetByName('情報') || ss.getSheets()[0], vals = plain_(sh.getDataRange().getValues());
  var hd = vals[0].map(function (h) { return AI_LOGIC.squash(h); });
  var c = { drive: hd.indexOf('ドライブ'), no: hd.indexOf('マスタNo'), work: hd.indexOf('工事番号'), file: hd.indexOf('ファイル名'), url: hd.indexOf('URL') };
  if (c.no < 0 || c.work < 0 || c.url < 0) throw new Error('「Excelマスタ一覧」の見出し(マスタNo・工事番号・URL)が見つかりません');
  var listNo = -1, listRow = 0;
  for (var r = 0; r < Math.min(3, vals.length) && listNo < 0; r++)
    for (var j = 0; j < vals[r].length - 1; j++)
      if (j !== c.work && String(vals[r][j]).trim() === '工事番号' && String(vals[r][j + 1]).trim() === '工事名') { listNo = j; listRow = r; break; }
  if (listNo < 0) { listNo = 6; listRow = 0; } // 既定: G列=工事番号、H列=工事名
  var names = {};
  for (var i = listRow + 1; i < vals.length; i++) {
    var no = String(vals[i][listNo]).trim(), nm = String(vals[i][listNo + 1]).trim();
    if (no && no !== '工事番号' && nm && !names[no]) names[no] = nm;
  }
  var masters = [], seenFile = {};
  for (var k = 1; k < vals.length; k++) {
    var wn = String(vals[k][c.work]).trim(), m = /\/d\/([-\w]+)/.exec(String(vals[k][c.url]));
    if (!wn || wn === '00-00' || !m) continue;
    if (seenFile[m[1]]) continue; // 同じファイルを指す行は、二重に数えない
    seenFile[m[1]] = true;
    var fname = c.file >= 0 ? String(vals[k][c.file]).replace(/\.xlsx?$/i, '').trim() : '';
    // マスタNo はドライブごとに別の体系(ms-tottori と mst に同じ番号がある)。「ドライブ:マスタNo」で区別する
    masters.push({ no: (c.drive >= 0 ? String(vals[k][c.drive]).trim() + ':' : '') + String(vals[k][c.no]).trim(), workNo: wn, workName: names[wn] || fname, fileId: m[1], fromList: !!names[wn] });
  }
  return masters;
}
function readMasterTable_(ss) {
  var sheets = ss.getSheets(), sh = sheets[0];
  for (var i = 0; i < sheets.length; i++) if (/マスターデータ|ﾏｽﾀｰﾃﾞｰﾀ/.test(AI_LOGIC.nfkc(sheets[i].getName()).replace(/ﾏｽﾀｰﾃﾞｰﾀ/, 'マスターデータ'))) { sh = sheets[i]; break; }
  var lastRow = sh.getLastRow(), lastCol = sh.getLastColumn();
  if (lastRow < 2) return [];
  var top = sh.getRange(1, 1, Math.min(5, lastRow), lastCol).getValues(), hr = -1, want = ['部位', '加工先', '加工', '重量'], col = {};
  for (var r = 0; r < top.length && hr < 0; r++) {
    var hd = top[r].map(function (h) { return AI_LOGIC.squash(h); }), ok = want.every(function (w) { return hd.indexOf(w) >= 0; });
    if (ok) { hr = r; want.concat(['本数']).forEach(function (w) { col[w] = hd.indexOf(w); }); }
  }
  if (hr < 0) throw new Error('見出し(部位・加工先・加工・重量)が見つかりません');
  var order = ['部位', '加工先', '加工', '本数', '重量'], idx = order.map(function (o) { return col[o]; }), maxc = Math.max.apply(null, idx.filter(function (x) { return x >= 0; })) + 1;
  var data = sh.getRange(hr + 2, 1, Math.max(1, lastRow - hr - 1), maxc).getValues();
  return [order].concat(data.map(function (row) {
    return idx.map(function (ci, n) { var v = ci >= 0 ? row[ci] : ''; return n === 2 ? plain_([[v]])[0][0] : v; });
  }));
}
function syncProduction() {
  var t0 = Date.now(), BUDGET = 240000, notes = [];
  try {
    var masters = readProdIndex_(), st = sheet_(SHEET.PRODS, ['マスター(ドライブ:マスタNo)', 'ファイルID', '更新日時(ミリ秒)', '行数', '取込日時', 'メモ']), sv = st.getDataRange().getValues(), state = {};
    for (var i = 1; i < sv.length; i++) state[String(sv[i][0])] = { id: sv[i][1], mt: String(sv[i][2]), rows: sv[i][3], at: sv[i][4], memo: sv[i][5] };
    var cur = sheet_(SHEET.PROD, AI_LOGIC.PROD_HEADER), byNo = {}, all = cur.getLastRow() > 1 ? cur.getRange(2, 1, cur.getLastRow() - 1, AI_LOGIC.PROD_HEADER.length).getValues() : [];
    all.forEach(function (r) { (byNo[String(r[8])] = byNo[String(r[8])] || []).push(r); });
    var live = {}; masters.forEach(function (m) { live[m.no] = 1; });
    Object.keys(byNo).forEach(function (k) { if (!live[k]) delete byNo[k]; }); // 一覧から消えたマスターは外す
    // 取り込みが古い・未取込のものを先に
    masters.sort(function (a, b) { var x = state[a.no] ? String(state[a.no].at) : '', y = state[b.no] ? String(state[b.no].at) : ''; return x < y ? -1 : x > y ? 1 : 0; });
    var pending = 0, changed = false;
    masters.forEach(function (m) {
      var ent = state[m.no] || {};
      try {
        var file = DriveApp.getFileById(m.fileId), mt = String(file.getLastUpdated().getTime());
        if (ent.mt === mt && byNo[m.no] !== undefined && ent.id === m.fileId && !ent.memo) return; // 変わっていない
        if (Date.now() - t0 > BUDGET) { pending++; return; }
        var ss, tmp = null;
        if (file.getMimeType() === 'application/vnd.google-apps.spreadsheet') ss = SpreadsheetApp.openById(m.fileId);
        else { tmp = Drive.Files.create({ name: 'tmp_prod_' + Date.now(), mimeType: 'application/vnd.google-apps.spreadsheet' }, file.getBlob()); ss = SpreadsheetApp.openById(tmp.id); }
        var res;
        try { res = AI_LOGIC.parseMasterRows(readMasterTable_(ss), { key: m.no, workNo: m.workNo, workName: m.workName }); }
        finally { if (tmp) DriveApp.getFileById(tmp.id).setTrashed(true); }
        byNo[m.no] = res.rows; changed = true;
        var memo = (res.undated ? '年のない日付の行が' + res.undated + '行(数えていません)' : '') + (m.fromList ? '' : ' 工事名が一覧に無くファイル名を使用');
        state[m.no] = { id: m.fileId, mt: mt, rows: res.rows.length, at: now_(), memo: memo.trim() };
      } catch (e) { notes.push('マスタ' + m.no + '(' + m.workNo + '): ' + e.message); state[m.no] = { id: m.fileId, mt: '', rows: (ent.rows || 0), at: ent.at || '', memo: 'エラー: ' + e.message }; }
    });
    if (changed) {
      var rows = []; Object.keys(byNo).forEach(function (k) { rows = rows.concat(byNo[k]); });
      rows.sort(function (x, y) { return x[4] - y[4]; });
      writeBig_(cur, [AI_LOGIC.PROD_HEADER].concat(rows.length ? rows : [AI_LOGIC.PROD_HEADER.map(function () { return ''; })]));
      CacheService.getScriptCache().remove('prodprojects_n');
    }
    var out = [['マスター(ドライブ:マスタNo)', 'ファイルID', '更新日時(ミリ秒)', '行数', '取込日時', 'メモ']];
    Object.keys(state).forEach(function (k) { if (live[k]) out.push([k, state[k].id, state[k].mt, state[k].rows, state[k].at, state[k].memo || '']); });
    writeTable_(st, out);
    var memos = out.slice(1).filter(function (r) { return r[5]; }).length;
    if (!pending && !notes.length) setMeta_('prod_synced_at', now_());
    setMeta_('prod_error', (pending ? '未更新' + pending + '件(続けて実行してください)。' : '') + notes.join(' / '));
    return '生産重量: マスター' + masters.length + '件 / 未更新' + pending + '件 / エラー' + notes.length + '件' + (memos ? ' / 要確認メモ' + memos + '件(「生産重量_状態」シート)' : '') + (notes.length ? '\n' + notes.join('\n') : '');
  } catch (err) { setMeta_('prod_error', now_() + ' ' + err.message); return '失敗: ' + err.message; }
}

// ---------- 会社カレンダーの質問(今日の日付・出勤日か・次の休日/連休): コードが答える ----------
function askCalendar_(user, question, cal, t0) {
  var qid = 'Q' + Utilities.getUuid().replace(/-/g, '').slice(0, 7).toUpperCase(), src = '会社カレンダー(CompanyCalendar)';
  var today = Utilities.formatDate(new Date(), TZ, 'yyyy/MM/dd'), hol = loadHolidays_();
  if (!Object.keys(hol).length) throw err_('no_data', '会社カレンダーがまだ取り込まれていません。管理者に連絡してください');
  var answer = AI_LOGIC.answerCalendar(cal, today, hol), total = Date.now() - t0;
  logAsk_(qid, user, question, answer, '回答済', src, 0, 0, total, '');
  return { ok: true, qid: qid, answerable: true, answer: answer, sources: [src], asOf: '会社カレンダー ' + (getMeta_('roster_synced_at') || '(更新日不明)'), ms: { search: 0, ai: 0, total: total } };
}

// ---------- 日報(工数)の質問: 数字はコードが集計して文章にする(AIは使わない) ----------
function loadProjects_() {
  var out = [], c = getLarge_('projects');
  if (c) return JSON.parse(c);
  [SHEET.CONS, SHEET.CONS5].forEach(function (n) {
    var sh = ss_().getSheetByName(n); if (!sh || sh.getLastRow() < 2) return;
    var ix = {}; sh.getRange(1, 1, 1, sh.getLastColumn()).getValues()[0].forEach(function (h, i) { ix[AI_LOGIC.squash(h)] = i; });
    sh.getDataRange().getValues().slice(1).forEach(function (r) {
      var nm = String(r[ix['工事名']] || '').replace(/\.\.\.$/, '').trim();
      if (nm) out.push({ id: String(r[ix['工事ID']] || '').trim(), no: String(r[ix['工事No']] || '').trim(), name: nm });
    });
  });
  if (out.length) putLarge_('projects', JSON.stringify(out), 3600);
  return out;
}
function loadContentNames_() {
  var sh = ss_().getSheetByName(SHEET.CONT), m = {};
  if (!sh || sh.getLastRow() < 2) return m;
  sh.getDataRange().getValues().slice(1).forEach(function (r) { if (r[0]) m[String(r[0]).trim()] = String(r[1]).trim(); });
  return m;
}
// 日付(yyyymmdd・小さい順)の列を二分探索して、期間に当たる行だけを読む
function rangeRows_(sheetName, dateCol, ncols, fromNum, toNum) {
  var sh = ss_().getSheetByName(sheetName), last = sh ? sh.getLastRow() : 0;
  if (last < 2) return [];
  var dates = sh.getRange(2, dateCol, last - 1, 1).getValues(), n = dates.length, lo = 0, hi = n, mid;
  while (lo < hi) { mid = (lo + hi) >> 1; if (Number(dates[mid][0]) < fromNum) lo = mid + 1; else hi = mid; }
  var start = lo; lo = start; hi = n;
  while (lo < hi) { mid = (lo + hi) >> 1; if (Number(dates[mid][0]) <= toNum) lo = mid + 1; else hi = mid; }
  if (lo <= start) return [];
  return sh.getRange(start + 2, 1, lo - start, ncols).getValues();
}
function workRows_(sheetName, fromNum, toNum) { return rangeRows_(sheetName, 3, AI_LOGIC.WORK_HEADER.length, fromNum, toNum); }
function askWork_(user, question, wk, t0) {
  var qid = 'Q' + Utilities.getUuid().replace(/-/g, '').slice(0, 7).toUpperCase(), answer = '';
  var src = '日報データ(日報アプリのDailyReport)';
  if (wk.who === 'ambiguous') {
    answer = '該当する方が複数います: ' + wk.people.map(function (p) { return p.name + '(社員No' + p.no + ')'; }).join('、') + '。お一人ずつ質問してください。';
  } else if (wk.projects.length > 1) {
    answer = '該当する工事が複数あります: ' + wk.projects.slice(0, 6).map(function (p) { return p.name + (p.no ? '(' + p.no + ')' : ''); }).join('、') + '。工事名をもう少し詳しく書いてください。';
  } else {
    var f = {}, title = '', roster = rosterList_(), names = {};
    roster.forEach(function (p) { names[p.no] = p.name; });
    var person = wk.who === 'self' ? { no: user.no, name: user.name } : wk.who === 'person' ? wk.people[0] : null;
    if (person) f.no = person.no;
    if (wk.projects.length) f.project = wk.projects[0];
    title = person && f.project ? person.name + 'さん(社員No' + person.no + ')の工事「' + f.project.name + '」'
          : person ? person.name + 'さん(社員No' + person.no + ')' : '工事「' + f.project.name + '」';
    var fromN = Number(wk.period.from.replace(/\//g, '')), toN = Number(wk.period.to.replace(/\//g, ''));
    var rows = workRows_(SHEET.WORK, fromN, toN).concat(workRows_(SHEET.WORKP, fromN, toN));
    if (!rows.length && !ss_().getSheetByName(SHEET.WORK)) throw err_('no_data', '日報のデータがまだ取り込まれていません。管理者に連絡してください');
    var sum = AI_LOGIC.summarizeWork(rows, f);
    answer = AI_LOGIC.formatWorkAnswer(sum, { title: title, period: wk.period, names: names, contentNames: loadContentNames_(),
      showPeople: !person, skipProject: !!f.project, asOf: (getMeta_('work_synced_at') || '').slice(0, 10) || '更新日不明' });
    if (!f.project && !person) answer = '誰の・どの工事の工数かを書いてください(例: 「私の今月の工数」「◯◯さんの先月の作業時間」)。';
  }
  var total = Date.now() - t0;
  logAsk_(qid, user, question, answer, '回答済', src, 0, 0, total, '');
  return { ok: true, qid: qid, answerable: true, answer: answer, sources: [src], asOf: '日報 ' + (getMeta_('work_synced_at') || '(更新日不明)'),
           ms: { search: 0, ai: 0, total: total } };
}

function logAsk_(qid, user, question, answer, kind, sources, tSearch, tAi, total, status) {
  sheet_(SHEET.LOG, LOG_HEADER).appendRow([qid, now_(), user.email, user.name, safe_(question), safe_(answer), kind,
    sources, '', '', tSearch, tAi, total, status]);
}

function feedback_(user, req) {
  var rating = req.rating === 'bad' ? '👎' : req.rating === 'good' ? '👍' : '';
  if (!rating) throw err_('bad_request', '評価が正しくありません');
  var sh = sheet_(SHEET.LOG, LOG_HEADER);
  var f = sh.getRange(2, 1, Math.max(1, sh.getLastRow() - 1), 1).createTextFinder(String(req.qid || '')).matchEntireCell(true).findNext();
  if (!f) throw err_('bad_request', '質問が見つかりません');
  var row = f.getRow();
  if (AI_LOGIC.normEmail(sh.getRange(row, 3).getValue()) !== user.email) throw err_('forbidden', '自分の質問だけ評価できます');
  sh.getRange(row, 9, 1, 2).setValues([[rating, safe_(String(req.comment || '').slice(0, 300))]]);
  if (rating === '👎') sh.getRange(row, 14).setValue('未対応');
  return { ok: true };
}

// ---------- 毎晩1時台: 名簿・工事・カレンダーをB2(名簿はB5も)から取り込む。失敗したら前回のまま ----------
function syncRoster() {
  try {
    var b2 = SpreadsheetApp.openById(prop_('DailyReport')), b5 = SpreadsheetApp.openById(prop_('DailyReport建築'));
    var v2 = b2.getSheetByName('Operator').getDataRange().getValues();
    var v5 = b5.getSheetByName('Operator').getDataRange().getValues();
    var adm = sheet_(SHEET.ADMIN, ['氏名', 'E-Mail', '管理者']).getDataRange().getValues();
    var r = AI_LOGIC.mergeRoster(v2, v5, adm);
    if (r.table.length < 50) throw new Error('名簿が極端に少ない(' + r.table.length + '件)ため更新を中止しました');
    if (r.adminCount === 0) throw new Error('管理者が0人になるため名簿の更新を中止しました(管理者シートを確認)');
    writeTable_(sheet_(SHEET.OPERATOR, OPERATOR_HEADER), [OPERATOR_HEADER].concat(r.table));
    copySheet_(b2, SHEET.CAL);
    copySheet_(b2, SHEET.CONS);
    syncAbsence_(b2, b5);
    syncWork_(b2, b5);
    CacheService.getScriptCache().remove('roster_n');
    setMeta_('roster_synced_at', now_());
    setMeta_('roster_warnings', r.warnings.join('\n'));
    setMeta_('roster_error', '');
    return '名簿 ' + r.table.length + '人(管理者' + r.adminCount + '人) / 警告' + r.warnings.length + '件 / 有給欠勤 ' + (getMeta_('absence_error') ? '要確認: ' + getMeta_('absence_error') : getMeta_('absence_synced_at') + ' 更新') + ' / 日報 ' + (getMeta_('work_error') ? '要確認: ' + getMeta_('work_error') : getMeta_('work_synced_at') + ' 更新');
  } catch (err) {
    setMeta_('roster_error', now_() + ' ' + err.message); // 失敗時は前回の名簿のまま
    return '失敗: ' + err.message;
  }
}
// 有給・欠勤: B2・B5のAbsenteeismを合体して「有給欠勤」シートへ。失敗しても名簿の更新は止めない(前回のまま)
function syncAbsence_(b2, b5) {
  try {
    var s2 = b2.getSheetByName('Absenteeism'), s5 = b5.getSheetByName('Absenteeism');
    if (!s2) throw new Error('B2にAbsenteeismシートがありません');
    var r = AI_LOGIC.mergeAbsence(plain_(s2.getDataRange().getValues()), s5 ? plain_(s5.getDataRange().getValues()) : null);
    if (r.table.length < 1000) throw new Error('有給欠勤の件数が極端に少ない(' + r.table.length + '件)ため更新を中止しました');
    writeTable_(sheet_(SHEET.ABS, AI_LOGIC.ABS_HEADER), [AI_LOGIC.ABS_HEADER].concat(r.table));
    setMeta_('absence_synced_at', now_());
    setMeta_('absence_error', r.warnings.concat(s5 ? [] : ['B5にAbsenteeismシートが無いため、B2のみ取り込みました']).join(' / '));
  } catch (err) { setMeta_('absence_error', now_() + ' ' + err.message); }
}
// 書き込みは大きいため、先に新しい内容を書き(分割)、余った下の行だけを消す
function writeBig_(sh, values) {
  var rows = values.length, cols = values[0].length, last = sh.getLastRow(), CH = 15000;
  if (sh.getMaxRows() < rows) sh.insertRowsAfter(sh.getMaxRows(), rows - sh.getMaxRows());
  for (var i = 0; i < rows; i += CH) { var part = values.slice(i, i + CH); sh.getRange(i + 1, 1, part.length, cols).setValues(part); }
  if (last > rows) sh.getRange(rows + 1, 1, last - rows, sh.getMaxColumns()).clearContent();
}
// 日報(現行分): B2・B5の現行DailyReportを、1作業=1行にそろえて「日報」シートへ。失敗しても前回のまま
function syncWork_(b2, b5) {
  try {
    var warnings = [], seen = {};
    var cons = AI_LOGIC.buildConsMap(plain_(b2.getSheetByName('Construction').getDataRange().getValues()));
    var rows = AI_LOGIC.workFromB2(plain_(b2.getSheetByName('DailyReport').getDataRange().getValues()), cons, seen, warnings);
    var n2 = rows.length;
    rows = rows.concat(AI_LOGIC.workFromB5(plain_(b5.getSheetByName('DailyReport').getDataRange().getValues()), seen, warnings));
    if (warnings.length) throw new Error(warnings.join(' / '));
    if (n2 < 1000 || rows.length - n2 < 1000) throw new Error('日報の件数が極端に少ない(B2 ' + n2 + '件、B5 ' + (rows.length - n2) + '件)ため更新を中止しました');
    AI_LOGIC.sortWork(rows);
    writeBig_(sheet_(SHEET.WORK, AI_LOGIC.WORK_HEADER), [AI_LOGIC.WORK_HEADER].concat(rows));
    // 作業内容の名前(B2のWorkcontent・B5のSection)と、B5の工事一覧
    var cont = [['コード', '名称', '元']];
    var wc = b2.getSheetByName('Workcontent'), sc = b5.getSheetByName('Section');
    if (wc) wc.getDataRange().getValues().slice(1).forEach(function (r) { if (r[0]) cont.push([String(r[0]).trim(), String(r[1]).trim(), 'B2']); });
    if (sc) sc.getDataRange().getValues().slice(1).forEach(function (r) { if (r[0]) cont.push([String(r[0]).trim(), String(r[1]).trim(), 'B5']); });
    writeTable_(sheet_(SHEET.CONT), cont);
    var c5 = b5.getSheetByName('Construction');
    if (c5) { var cv = c5.getDataRange().getValues().filter(function (r) { return r[0] || r[1]; }); if (cv.length > 1) writeTable_(sheet_(SHEET.CONS5), cv); }
    CacheService.getScriptCache().remove('projects_n');
    setMeta_('work_synced_at', now_());
    setMeta_('work_error', '');
  } catch (err) { setMeta_('work_error', now_() + ' ' + err.message); }
}
// 日報(過去分): DATA2025.11.21以降 → DATA2024.11.21以降 の順に、現行分に無い WorkReport No だけを「日報_過去」へ(メニューから手動。再実行できる)
function importWorkPast() {
  var cur = sheet_(SHEET.WORK, AI_LOGIC.WORK_HEADER), seen = {}, vals = cur.getLastRow() > 1 ? cur.getRange(2, 1, cur.getLastRow() - 1, 1).getValues() : [];
  if (vals.length < 1000) throw new Error('先に「名簿・工事・カレンダーを今すぐ更新」で現行の日報を取り込んでください');
  vals.forEach(function (r) { seen[String(r[0]).trim()] = true; });
  var b2 = SpreadsheetApp.openById(prop_('DailyReport'));
  var cons = AI_LOGIC.buildConsMap(plain_(b2.getSheetByName('Construction').getDataRange().getValues()));
  var rows = [], warnings = [], report = [];
  ['DailyReport_DATA2025.11.21以降', 'DailyReport_DATA2024.11.21以降'].forEach(function (k) {
    var id = prop_(k, true); if (!id) { report.push(k + ': 未設定'); return; }
    var sh = SpreadsheetApp.openById(id).getSheetByName('DailyReport');
    var part = AI_LOGIC.workFromB2(plain_(sh.getDataRange().getValues()), cons, seen, warnings);
    report.push(k + ': ' + part.length + '行'); rows = rows.concat(part);
  });
  if (warnings.length) throw new Error(warnings.join(' / '));
  if (!rows.length) throw new Error('過去分が1行も取れませんでした(諸情報のIDを確認)');
  AI_LOGIC.sortWork(rows);
  writeBig_(sheet_(SHEET.WORKP, AI_LOGIC.WORK_HEADER), [AI_LOGIC.WORK_HEADER].concat(rows));
  setMeta_('work_past_at', now_());
  return '過去分を取り込みました(合計' + rows.length + '行)\n' + report.join('\n');
}
function copySheet_(srcSs, name) {
  var src = srcSs.getSheetByName(name);
  if (!src) throw new Error(name + ' が元ファイルにありません');
  var vals = src.getDataRange().getValues();
  if (vals.length < 2) throw new Error(name + ' の元データが空のため更新を中止しました');
  writeTable_(sheet_(name), vals);
}

// ---------- 就業規則の取り込みと公開(メニューから実行。シートの編集権限がある人だけ) ----------
function ingestRules() {
  var id = prop_('RULES_PDF_ID'), file = DriveApp.getFileById(id);
  var doc = Drive.Files.create({ name: 'tmp_rules_' + Date.now(), mimeType: 'application/vnd.google-apps.document' }, file.getBlob(), { ocrLanguage: 'ja' });
  var text;
  try { text = DocumentApp.openById(doc.id).getBody().getText(); } finally { DriveApp.getFileById(doc.id).setTrashed(true); }
  var chunks = AI_LOGIC.parseRules(text);
  var main = chunks.filter(function (c) { return c.doc === '就業規則' && c.no; }).length;
  if (main < 100) throw new Error('就業規則の条文が ' + main + ' 件しか取れませんでした(PDFの形式を確認してください)');
  var st = sheet_(SHEET.STAGE, RULE_HEADER);
  st.clearContents();
  st.getRange(1, 1, 1, 4).setValues([RULE_HEADER]);
  st.getRange(2, 1, chunks.length, 4).setValues(chunks.map(function (c) { return [c.doc, c.no, c.heading, c.body]; }));
  setMeta_('stage_label', file.getName());
  setMeta_('stage_at', now_());
  var diff = diffRules_(sheet_(SHEET.RULES, RULE_HEADER).getDataRange().getValues(), st.getDataRange().getValues());
  return '取り込み完了: ' + chunks.length + '件(就業規則 ' + main + '条)\n' + diff;
}
function diffRules_(cur, next) {
  function key(r) { return r[0] + '|' + r[1] + '|' + r[2]; }
  function map(v) { var m = {}; v.slice(1).forEach(function (r) { m[key(r)] = AI_LOGIC.squash(r[3]); }); return m; }
  var a = map(cur), b = map(next), add = 0, del = 0, chg = 0;
  Object.keys(b).forEach(function (k) { if (!(k in a)) add++; else if (a[k] !== b[k]) chg++; });
  Object.keys(a).forEach(function (k) { if (!(k in b)) del++; });
  return '現行との差分: 追加' + add + ' / 削除' + del + ' / 変更' + chg;
}
function publishRules() {
  var st = sheet_(SHEET.STAGE, RULE_HEADER).getDataRange().getValues();
  if (st.length < 2) throw new Error('先に「就業規則を取り込む」を実行してください');
  var rules = sheet_(SHEET.RULES, RULE_HEADER), cur = rules.getDataRange().getValues();
  if (cur.length > 1 && st.length < (cur.length - 1) * 0.9) throw new Error('条文数が現行の9割未満のため公開を中止しました');
  if (cur.length > 1) { // 旧版は履歴に残す
    var hist = sheet_(SHEET.HIST, ['版', '公開日時'].concat(RULE_HEADER)), label = getMeta_('rules_version') || '(不明)';
    var rows = cur.slice(1).map(function (r) { return [label, now_()].concat(r); });
    hist.getRange(hist.getLastRow() + 1, 1, rows.length, rows[0].length).setValues(rows);
  }
  writeTable_(rules, st);
  setMeta_('rules_version', getMeta_('stage_label'));
  setMeta_('rules_published_at', now_());
  CacheService.getScriptCache().remove('rules_n');
  return '公開しました: ' + getMeta_('rules_version') + '(' + (st.length - 1) + '件)';
}

// ---------- 毎朝3時: 前日分の「回答できなかった質問」「AIエラー」「👎報告」と、名簿の確認事項(変化があった日だけ)をメール。どちらも無ければ送らない ----------
function dailyMail() {
  var y = Utilities.formatDate(new Date(new Date().getTime() - 24 * 3600 * 1000), TZ, 'yyyy/MM/dd');
  var vals = sheet_(SHEET.LOG, LOG_HEADER).getDataRange().getValues();
  var items = vals.slice(1).filter(function (r) {
    return ts_(r[1]).indexOf(y) === 0 && (r[6] === '回答不可' || r[6] === 'エラー' || r[8] === '👎');
  });
  var warn = getMeta_('roster_warnings') + (getMeta_('roster_error') ? '\n取り込み失敗: ' + getMeta_('roster_error') : '')
  warn += (getMeta_('absence_error') ? '\n有給欠勤の取り込み: ' + getMeta_('absence_error') : '');
  warn += (getMeta_('prod_error') ? '\n生産重量の取り込み: ' + getMeta_('prod_error') : '');
  warn += (getMeta_('work_error') ? '\n日報の取り込み: ' + getMeta_('work_error') : '');
  var hash = Utilities.base64Encode(Utilities.computeDigest(Utilities.DigestAlgorithm.MD5, warn));
  var warnNew = warn.trim() && hash !== getMeta_('roster_warnings_sent');
  if (!items.length && !warnNew) return '送信なし';
  var body = [];
  if (items.length) {
    body.push('■ ' + y + ' の回答不可・間違い報告(' + items.length + '件)');
    items.forEach(function (r, i) {
      body.push((i + 1) + '. [' + r[6] + (r[8] ? ' ' + r[8] : '') + '] ' + r[3] + '(' + r[2] + ') ' + ts_(r[1]));
      body.push('   質問: ' + r[4]);
      if (r[5]) body.push('   回答: ' + r[5]);
      if (r[7]) body.push('   参照: ' + r[7]);
      if (r[9]) body.push('   コメント: ' + r[9]);
    });
  }
  if (warnNew) { body.push('', '■ 名簿の確認事項', warn); setMeta_('roster_warnings_sent', hash); }
  body.push('', 'スプレッドシート: ' + ss_().getUrl());
  MailApp.sendEmail(prop_('OWNER_EMAIL'), '【社内AI】' + y + ' 確認事項', body.join('\n'));
  return '送信しました';
}

// ---------- 自己診断(メニュー「動作確認」): 実際の環境で、公開前に各部分が動くかを1つずつ確かめる ----------
function selfTest() {
  var out = [];
  function step(name, fn) {
    var t = Date.now();
    try { var r = fn(); out.push('✔ ' + name + (r ? ': ' + r : '') + ' (' + (Date.now() - t) + 'ms)'); }
    catch (e) { out.push('✖ ' + name + ': ' + e.message); }
  }
  var q = '年次有給休暇は何日もらえますか';
  step('設定(諸情報シート)', function () {
    ['GEMINI_API_KEY', 'CLIENT_ID', 'OWNER_EMAIL', 'DailyReport', 'DailyReport建築', 'RULES_PDF_ID'].forEach(function (k) { prop_(k); });
    return '必須6項目すべて入力済み';
  });
  step('元ファイルの読み取り(B2・B5のOperator)', function () {
    var a = SpreadsheetApp.openById(prop_('DailyReport')).getSheetByName('Operator'), b = SpreadsheetApp.openById(prop_('DailyReport建築')).getSheetByName('Operator');
    if (!a || !b) throw new Error('Operatorシートが見つかりません');
    return 'B2 ' + (a.getLastRow() - 1) + '行 / B5 ' + (b.getLastRow() - 1) + '行';
  });
  step('名簿(Operatorシート)', function () {
    var m = getRoster_(), keys = Object.keys(m), adm = keys.filter(function (k) { return m[k].admin; }).length;
    if (keys.length < 50) throw new Error('名簿が少なすぎます(' + keys.length + '人)。メニューで名簿を更新してください');
    if (!adm) throw new Error('管理者が0人です');
    return keys.length + '人(管理者' + adm + '人)';
  });
  step('有給・欠勤データ', function () {
    var rows = loadAbsence_();
    if (rows.length < 1000) throw new Error('有給欠勤シートが少なすぎます(' + rows.length + '件)。メニューで更新してください' + (getMeta_('absence_error') ? ' / ' + getMeta_('absence_error') : ''));
    var me = rosterList_()[0], s = AI_LOGIC.summarizeAbsence(rows, me.no, AI_LOGIC.parsePeriod('', Utilities.formatDate(new Date(), TZ, 'yyyy/MM/dd')), loadHolidays_());
    return rows.length + '件 / ' + getMeta_('absence_synced_at') + ' / 試算OK(' + me.name + ' 今年度の有給 ' + s.paidDays + '日)';
  });
  step('日報(現行分・過去分)', function () {
    var sh = ss_().getSheetByName(SHEET.WORK), n = sh ? sh.getLastRow() - 1 : 0, p = ss_().getSheetByName(SHEET.WORKP);
    if (n < 1000) throw new Error('日報シートが少なすぎます(' + n + '件)。メニューで更新してください' + (getMeta_('work_error') ? ' / ' + getMeta_('work_error') : ''));
    var np = p ? Math.max(0, p.getLastRow() - 1) : 0, t = Date.now(), r = workRows_(SHEET.WORK, 20000101, 20991231);
    return '現行' + n + '行 / 過去' + np + '行' + (np ? '' : '(過去分は未取込。メニューで取り込み)') + ' / 全期間の読み込み' + (Date.now() - t) + 'ms';
  });
  step('生産重量(案件マスター)', function () {
    var sh = ss_().getSheetByName(SHEET.PROD), n = sh ? sh.getLastRow() - 1 : 0;
    if (n < 1) throw new Error('生産重量シートが空です。メニュー「生産重量を今すぐ更新」を実行してください' + (getMeta_('prod_error') ? ' / ' + getMeta_('prod_error') : ''));
    return n + '行 / ' + (getMeta_('prod_synced_at') || '取り込み未完了') + (getMeta_('prod_error') ? ' / ' + getMeta_('prod_error') : '');
  });
  step('就業規則(公開済み)', function () {
    var c = loadRules_(), main = c.filter(function (x) { return x.doc === '就業規則' && x.no; }).length;
    if (main < 100) throw new Error('就業規則が公開されていません(' + main + '条)。メニューで取り込み→公開してください');
    return c.length + '件(就業規則' + main + '条) / ' + getMeta_('rules_version');
  });
  step('検索', function () {
    var h = AI_LOGIC.searchRules(loadRules_(), q, 6);
    if (!h.length) throw new Error('条文が見つかりません');
    return '最上位=' + AI_LOGIC.chunkLabel(h[0].chunk);
  });
  step('Gemini(' + MODEL + ')', function () {
    var h = AI_LOGIC.searchRules(loadRules_(), q, 6);
    var o = AI_LOGIC.parseModelJson(callGemini_(AI_LOGIC.buildPrompt(q, h)));
    if (!o) throw new Error('AIの応答を読み取れませんでした');
    return o.answerable ? '回答あり「' + String(o.answer).slice(0, 50) + '…」' : '回答なし(answerable=false)';
  });
  step('ログイン検証の通信(Google)', function () {
    var r = UrlFetchApp.fetch('https://oauth2.googleapis.com/tokeninfo?id_token=x', { muteHttpExceptions: true });
    if (r.getResponseCode() !== 400) throw new Error('想定外の応答(' + r.getResponseCode() + ')');
    return '接続OK';
  });
  step('Drive API(就業規則の取り込みに必要)', function () {
    if (typeof Drive === 'undefined') throw new Error('サービス「Drive API」を追加してください(左の「サービス」の＋)');
    return DriveApp.getFileById(prop_('RULES_PDF_ID')).getName();
  });
  step('朝のメールの宛先', function () { return prop_('OWNER_EMAIL') + '(送信はしません)'; });
  return out.join('\n');
}

// ---------- 初期設定とメニュー ----------
var CONFIG_GUIDE = [
  ['DailyReport', '日報(鉄構)の現行ファイルのID。鉄構の名簿・工事・カレンダー・有給の元(B2)'],
  ['DailyReport_DATA2024.11.21以降', '日報(鉄構)の過去分。日報を扱う弾から使う'],
  ['DailyReport_DATA2025.11.21以降', '同上(2026/11/21以降はこちらも使う)'],
  ['Excelマスタ一覧', '案件マスター(生産重量)の一覧スプレッドシートのID。空のままでも、標準のものを使います(別のファイルに替えるときだけ入力)'],
  ['DailyReport建築', '日報(建設・総務)の現行ファイルのID。建設・総務の名簿・有給欠勤の元(B5)'],
  ['RULES_PDF_ID', '就業規則PDFのファイルID。改訂したら新しいPDFのIDに書き換え → メニューで取り込み・公開'],
  ['GEMINI_API_KEY', 'AI Studioで取得したAPIキー。他人に見せない・このシートを不用意に共有しない'],
  ['OWNER_EMAIL', 'クリエーターのGmail。朝3時の確認メールの宛先'],
  ['CLIENT_ID', 'Googleログイン用のOAuthクライアントID(…apps.googleusercontent.com)']
];
var GUIDE_LINES = [
  ['クリエーター用ガイド(このシートを見れば運用できます)'],
  [''],
  ['■ このアプリは何か'],
  ['社員が就業規則などを質問すると、AIが条文を根拠に答えます。答えられない質問と「間違い」の報告は「質問ログ」に溜まり、毎朝3時に前日分がクリエーターへメールで届きます。'],
  [''],
  ['■ 設定(「諸情報」シート)'],
  ['A列=名前、B列=ファイルIDやキー。D列が「✔入力済」ならOK、「★未入力」は埋める必要があります。'],
  [''],
  ['■ 毎日の流れ'],
  ['1. 朝にメールを確認(0件で名簿の警告もない日はメールは来ません)'],
  ['2. 「回答不可」: 規程に答えが無い質問。規程を直すか、検索を直す必要があるかをClaudeと相談'],
  ['3. 「👎」: 利用者が間違いと報告した回答。コメントと参照した条文を見て原因を調べる'],
  ['4. 直したら、対応状況(質問ログのN列)を「対応済」に変える'],
  [''],
  ['■ メニュー「社内AI」(このシートを編集できる人だけが使えます。共有はクリエーターだけにしてください)'],
  ['・動作確認(自己診断): 設定・名簿・就業規則・AI・Googleとの通信を1つずつ確かめ、✔/✖で表示。✖が出たら、その行の指示どおりに直す'],
  ['・名簿・工事・カレンダーを今すぐ更新: 毎晩1時に自動で行われます。急ぐときだけ使う'],
  ['・就業規則を取り込む(確認用): PDFを条文に分けて「規則_取込」シートに入れ、現行との差(追加/削除/変更)を表示'],
  ['・就業規則を公開する: 確認した内容を本番にする(旧版は「規則履歴」に残る)'],
  ['・日報の過去分を取り込む: 初回と、日報の現行ファイルが替わる年度替わり(11/21)に1回。「諸情報」の DailyReport_DATA2024.11.21以降 / DATA2025.11.21以降 のIDを読み、現行分と重複しない分を「日報_過去」へ'],
  ['・前日分メールを今すぐ送る: 動作確認用'],
  ['・生産重量の質問(「今月の生産重量」「ランドポート京都伏見の生産重量」「鳥取の先月の加工重量」)も、コードが答えます。案件マスターの「加工」に日付が入った製品の重量(トン)の合計で、期間は会社の締め日(前月21日〜当月20日)が基準。工事番号・工事名は「Excelマスタ一覧」の表を正とします。毎晩2時に、更新があったマスターだけ取り込み(初回は、メニュー「生産重量を今すぐ更新」を未更新が0件になるまで数回実行)'],
  ['・会社カレンダーの質問(「今日の日付」「今度の土曜は出勤日?」「次の連休」「次の休日」「今月の出勤日は何日」)も、コードが答えます(毎晩1時に取り込む CompanyCalendar を使用)'],
  ['・日報(工数)の質問(「私の今月の工数」「◯◯さんの昨日の日報」「◯◯工事の工数」)も、コードが集計して答えます。期間の指定がなければ今月度(前月21日〜当月20日)。現行分は毎晩1時に「日報」シートへ取り込み'],
  ['・有給・欠勤の質問(「私の有給は今年度何日?」「◯◯さんの先月の欠勤」)は、AIではなくコードが計算して答えます。データは毎晩1時に「有給欠勤」シートへ取り込み(B2・B5のAbsenteeismを合体)'],
  [''],
  ['■ 就業規則を改訂したとき'],
  ['1. 新しいPDFをドライブに置く → そのファイルIDを「諸情報」の RULES_PDF_ID に入れる'],
  ['2. メニュー「就業規則を取り込む」→ 差分の件数を確認 → 「就業規則を公開する」'],
  ['3. 条文数が極端に減ると公開は自動で止まります(PDFの形式を確認)'],
  [''],
  ['■ よくあるトラブル'],
  ['・ある人がログインできない: 名簿(元のOperatorシート)にGmailが入っているか、状態が在職中/休職中/専務(B5は勤務)か。誤字は朝のメールの警告に出ます'],
  ['・管理者の追加・削除: 「管理者」シートに氏名・E-Mail・「管理者」と入れる(翌朝の更新で反映。急ぐ場合はメニューで更新)'],
  ['・名簿が更新されない: 「設定」シートの roster_error を見る。管理者が0人だと安全のため更新を止めます']
];
function setup() {
  [[SHEET.OPERATOR, OPERATOR_HEADER], [SHEET.ADMIN, ['氏名', 'E-Mail', '管理者']], [SHEET.RULES, RULE_HEADER], [SHEET.STAGE, RULE_HEADER],
   [SHEET.HIST, ['版', '公開日時'].concat(RULE_HEADER)], [SHEET.LOG, LOG_HEADER], [SHEET.META, ['項目', '値']], [SHEET.ABS, AI_LOGIC.ABS_HEADER]]
    .forEach(function (x) { sheet_(x[0], x[1]); });
  // 「諸情報」: 不足している設定行を足し、説明(C列)と状態(D列)を書く。A・B列の入力済みの値は変えない
  var info = sheet_(SHEET.INFO, ['ファイル名', 'ID']), vals = info.getDataRange().getValues(), have = {};
  for (var i = 1; i < vals.length; i++) have[String(vals[i][0]).trim()] = i + 1;
  CONFIG_GUIDE.forEach(function (g) { if (!have[g[0]]) { info.appendRow([g[0], '']); have[g[0]] = info.getLastRow(); } });
  info.getRange(1, 3, 1, 2).setValues([['説明', '状態']]);
  vals = info.getDataRange().getValues();
  var desc = {}; CONFIG_GUIDE.forEach(function (g) { desc[g[0]] = g[1]; });
  for (var r = 2; r <= vals.length; r++) {
    var name = String(vals[r - 1][0]).trim();
    if (!name) continue;
    info.getRange(r, 3, 1, 2).setValues([[desc[name] || vals[r - 1][2] || '', '=IF(LEN(B' + r + ')>0,"✔入力済","★未入力")']]);
  }
  var gs = sheet_('クリエーター用ガイド');
  gs.clearContents();
  gs.getRange(1, 1, GUIDE_LINES.length, 1).setValues(GUIDE_LINES);
  gs.setColumnWidth(1, 900);
  ScriptApp.getProjectTriggers().forEach(function (t) {
    if (['syncRoster', 'dailyMail', 'syncProduction'].indexOf(t.getHandlerFunction()) >= 0) ScriptApp.deleteTrigger(t);
  });
  ScriptApp.newTrigger('syncRoster').timeBased().everyDays(1).atHour(1).create();
  ScriptApp.newTrigger('dailyMail').timeBased().everyDays(1).atHour(3).create();
  ScriptApp.newTrigger('syncProduction').timeBased().everyDays(1).atHour(2).create();
  var later = ['DailyReport_DATA2024.11.21以降', 'DailyReport_DATA2025.11.21以降'];
  var missing = CONFIG_GUIDE.map(function (g) { return g[0]; }).filter(function (k) { return later.indexOf(k) < 0 && k !== 'Excelマスタ一覧' && !prop_(k, true); }); // Excelマスタ一覧は空でも標準のファイルを使う
  Logger.log(missing.length ? '「諸情報」シートが未入力: ' + missing.join(', ') : '設定OK。モデル=' + MODEL);
}
function onOpen() {
  SpreadsheetApp.getUi().createMenu('社内AI')
    .addItem('動作確認(自己診断)', 'menuSelfTest')
    .addItem('名簿・工事・カレンダーを今すぐ更新', 'menuSync')
    .addItem('日報の過去分を取り込む(初回・年度替わり)', 'menuWorkPast')
    .addItem('生産重量を今すぐ更新(未更新が残ったら続けて実行)', 'menuProd')
    .addItem('就業規則を取り込む(確認用)', 'menuIngest')
    .addItem('就業規則を公開する', 'menuPublish')
    .addItem('前日分メールを今すぐ送る', 'menuMail').addToUi();
}
// メニューの操作は、このスプレッドシートの編集権限がある人だけが使える(共有を作成者・クリエーターに限る)。メール一致では判定しない
function run_(fn) { try { SpreadsheetApp.getUi().alert(fn()); } catch (e) { SpreadsheetApp.getUi().alert('エラー: ' + e.message); } }
function menuSelfTest() { run_(selfTest); }
function menuSync() { run_(syncRoster); }
function menuIngest() { run_(ingestRules); }
function menuWorkPast() { run_(importWorkPast); }
function menuProd() { run_(syncProduction); }
function menuPublish() { run_(publishRules); }
function menuMail() { run_(dailyMail); }
