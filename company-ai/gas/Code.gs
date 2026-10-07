/**
 * 社内AI(第1弾): 就業規則への質問 + ログイン照合 + 質問ログ/👎報告 + 毎朝の名簿取り込み + 朝3時のメール
 * スプレッドシート「社内AI」にコンテナバインドして使う。設置手順は README.md。
 * 純粋な処理(条文分割・検索・名簿の合体・プロンプト)は Logic.gs。
 */
var MODEL = 'gemini-3.5-flash-lite'; // 固定。明示の指示があるときだけ変える(自動選択・可変にしない)
var SHEET = { OPERATOR: 'Operator', ADMIN: '管理者', RULES: '規則', STAGE: '規則_取込', HIST: '規則履歴',
              LOG: '質問ログ', CAL: 'CompanyCalendar', CONS: 'Construction', META: '設定', INFO: '諸情報', ABS: '有給欠勤' };
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
  for (var i = 1; i < vals.length; i++) if (vals[i][0] === k) return String(vals[i][1]);
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
  return values.map(function (row) { return row.map(function (v) { return v instanceof Date ? Utilities.formatDate(v, TZ, 'yyyy/MM/dd HH:mm:ss') : v; }); });
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
  var res = UrlFetchApp.fetch('https://generativelanguage.googleapis.com/v1beta/models/' + MODEL + ':generateContent', {
    method: 'post', contentType: 'application/json', muteHttpExceptions: true,
    headers: { 'x-goog-api-key': prop_('GEMINI_API_KEY') },
    payload: JSON.stringify({ contents: [{ role: 'user', parts: [{ text: prompt }] }],
                              generationConfig: { temperature: 0, responseMimeType: 'application/json' } })
  });
  var code = res.getResponseCode();
  if (code === 429) throw err_('busy', 'ただいま混み合っています。少し待ってからもう一度お試しください');
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
    CacheService.getScriptCache().remove('roster_n');
    setMeta_('roster_synced_at', now_());
    setMeta_('roster_warnings', r.warnings.join('\n'));
    setMeta_('roster_error', '');
    return '名簿 ' + r.table.length + '人(管理者' + r.adminCount + '人) / 警告' + r.warnings.length + '件 / 有給欠勤 ' + (getMeta_('absence_error') ? '要確認: ' + getMeta_('absence_error') : getMeta_('absence_synced_at') + ' 更新');
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
    setMeta_('absence_error', s5 ? '' : 'B5にAbsenteeismシートが無いため、B2のみ取り込みました');
  } catch (err) { setMeta_('absence_error', now_() + ' ' + err.message); }
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
  ['・前日分メールを今すぐ送る: 動作確認用'],
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
    if (['syncRoster', 'dailyMail'].indexOf(t.getHandlerFunction()) >= 0) ScriptApp.deleteTrigger(t);
  });
  ScriptApp.newTrigger('syncRoster').timeBased().everyDays(1).atHour(1).create();
  ScriptApp.newTrigger('dailyMail').timeBased().everyDays(1).atHour(3).create();
  var later = ['DailyReport_DATA2024.11.21以降', 'DailyReport_DATA2025.11.21以降'];
  var missing = CONFIG_GUIDE.map(function (g) { return g[0]; }).filter(function (k) { return later.indexOf(k) < 0 && !prop_(k, true); });
  Logger.log(missing.length ? '「諸情報」シートが未入力: ' + missing.join(', ') : '設定OK。モデル=' + MODEL);
}
function onOpen() {
  SpreadsheetApp.getUi().createMenu('社内AI')
    .addItem('動作確認(自己診断)', 'menuSelfTest')
    .addItem('名簿・工事・カレンダーを今すぐ更新', 'menuSync')
    .addItem('就業規則を取り込む(確認用)', 'menuIngest')
    .addItem('就業規則を公開する', 'menuPublish')
    .addItem('前日分メールを今すぐ送る', 'menuMail').addToUi();
}
// メニューの操作は、このスプレッドシートの編集権限がある人だけが使える(共有を作成者・クリエーターに限る)。メール一致では判定しない
function run_(fn) { try { SpreadsheetApp.getUi().alert(fn()); } catch (e) { SpreadsheetApp.getUi().alert('エラー: ' + e.message); } }
function menuSelfTest() { run_(selfTest); }
function menuSync() { run_(syncRoster); }
function menuIngest() { run_(ingestRules); }
function menuPublish() { run_(publishRules); }
function menuMail() { run_(dailyMail); }
