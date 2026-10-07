/**
 * 社内AI: 純粋関数(GAS固有のAPIを使わない)。Node(vm)でも同じコードをテストする。
 * Code.gs から AI_LOGIC として呼ぶ。
 */
var AI_LOGIC = (function () {
  function nfkc(s) { return String(s == null ? '' : s).normalize('NFKC'); }
  function squash(s) { return nfkc(s).replace(/\s+/g, ''); }

  // ---------- 就業規則(PDFを変換したテキスト)を条文に分割 ----------
  // 1つのPDFに「就業規則」と複数の別規程(退職金・再雇用・慶弔見舞金など)が入っていて、条番号が1から振り直される。
  function parseRules(text) {
    var lines = String(text || '').split(/\r?\n/);
    var chunks = [], cur = null, doc = '就業規則', lastNo = 0, docSeq = 0, started = false;
    var pendingHeading = '', pendingTitle = '';
    var reArt = /^第([０-９0-9]+)条[ 　\t]+(.*)$/;
    var reItem = /^([０-９0-9]+[ 　]|[(（][０-９0-9]+[)）])/;
    for (var i = 0; i < lines.length; i++) {
      var raw = lines[i].trim();
      if (!raw) continue;
      if (/^[0-9０-９]{1,3}$/.test(raw)) continue; // ページ番号
      var sq = squash(raw);
      var m = reArt.exec(raw);
      if (m) {
        var no = parseInt(nfkc(m[1]), 10);
        if (started && no === 1 && lastNo > 1) { docSeq++; doc = pendingTitle || ('別規程' + docSeq); }
        cur = { doc: doc, no: no, heading: pendingHeading, body: m[2] };
        chunks.push(cur);
        lastNo = no; started = true; pendingHeading = ''; pendingTitle = '';
        continue;
      }
      if (!started) continue; // 目次は読み飛ばす
      var hm = /^[（(]([^）)]{1,30})[）)]$/.exec(raw);
      if (hm) { pendingHeading = squash(hm[1]); continue; }
      if (sq === '附則' || /^《?別表》?/.test(sq)) {
        cur = { doc: doc, no: 0, heading: sq.slice(0, 20), body: '' };
        chunks.push(cur);
        continue;
      }
      if (sq.length <= 30 && /(規程|内規)$/.test(sq) && !/^[（(第]/.test(sq) && !/[。、]/.test(sq)) { pendingTitle = sq; continue; }
      if (cur) cur.body += (reItem.test(raw) ? '\n' : '') + raw;
    }
    chunks = chunks.filter(function (c) { return c.body.length > 0; });
    // 題名の行が取れなかった別規程は、第1条の本文から「従業員の◯◯」を拾って名前にする
    var rename = {};
    chunks.forEach(function (c) {
      if (/^別規程\d+$/.test(c.doc) && c.no === 1 && !rename[c.doc]) {
        var g = /従業員の([^（(。、以]{2,20})/.exec(squash(c.body));
        if (g) rename[c.doc] = g[1] + '規程';
      }
    });
    chunks.forEach(function (c) { if (rename[c.doc]) c.doc = rename[c.doc]; });
    return chunks;
  }

  function chunkLabel(c) {
    return c.doc + (c.no ? ' 第' + c.no + '条' : ' ' + c.heading) + (c.no && c.heading ? '(' + c.heading + ')' : '');
  }

  // ---------- 検索(文字2連続の一致 + 逆文書頻度。形態素解析なし) ----------
  function bigrams(s) {
    var t = squash(s), out = {};
    for (var i = 0; i < t.length - 1; i++) out[t.substr(i, 2)] = 1;
    return Object.keys(out);
  }
  // 質問の2文字(bigram)が条文に含まれるかを数える。条文側の分解はせず、文字列検索だけで済ませる
  function searchRules(chunks, question, topN) {
    topN = topN || 6;
    var N = chunks.length;
    var body = chunks.map(function (c) { return squash(c.body); });
    var head = chunks.map(function (c) { return squash(c.heading); });
    var name = chunks.map(function (c) { return squash(c.doc); });
    var qkeys = bigrams(question);
    var w = {};
    qkeys.forEach(function (b) {
      var df = 0;
      for (var i = 0; i < N; i++) if (body[i].indexOf(b) >= 0) df++;
      w[b] = Math.log(1 + N / (1 + df));
    });
    var refNos = [];
    var rm, reRef = /第([0-9]+)条/g, qn = nfkc(question);
    while ((rm = reRef.exec(qn))) refNos.push(parseInt(rm[1], 10));
    var scored = chunks.map(function (c, i) {
      var s = 0;
      qkeys.forEach(function (b) {
        if (body[i].indexOf(b) >= 0) s += w[b];
        if (head[i].indexOf(b) >= 0) s += w[b] * 3;
        if (name[i].indexOf(b) >= 0) s += w[b] * 0.5;
      });
      s = s / Math.pow(Math.max(body[i].length, 20), 0.25);
      if (c.no && refNos.indexOf(c.no) >= 0) s += c.doc === '就業規則' ? 1500 : 1000;
      return { chunk: c, score: s };
    }).filter(function (x) { return x.score > 0; });
    scored.sort(function (a, b) { return b.score - a.score; });
    return scored.slice(0, topN);
  }

  // ---------- Geminiへの指示 ----------
  function buildPrompt(question, hits, maxChars) {
    maxChars = maxChars || 3000;
    var ctx = hits.map(function (h, i) {
      return '[C' + (i + 1) + '] ' + chunkLabel(h.chunk) + '\n' + h.chunk.body.slice(0, maxChars);
    }).join('\n\n');
    return [
      'あなたは株式会社正光の社内規程に答えるアシスタントです。',
      '次の「条文」に書かれている内容だけを根拠に、従業員の質問に日本語で簡潔に答えてください。',
      '条文に答えが無い、または判断できないときは answerable を false にし、answer は空にしてください。推測や一般論で補わないこと。',
      '回答には根拠の規程名と条番号を含めてください(例: 就業規則 第20条)。',
      'cited には、実際に回答に使った条文の番号(C1など)だけを入れてください。',
      '出力はJSONのみ: {"answerable": true|false, "answer": "回答文", "cited": ["C1","C2"]}',
      '',
      '【条文】', ctx,
      '',
      '【質問】', String(question).slice(0, 300)
    ].join('\n');
  }
  // 「根拠」として見せる条文を選ぶ。回答文に書かれた「就業規則 第33条」のような言及を最優先にし(読む人の目に入る根拠と一致させる)、
  // 次にAIが引用した番号(C1など)、どちらも無いときは検索1位だけ。最大3件。
  function pickSources(cited, answer, hits) {
    var idx = [], text = squash(answer);
    function add(i) { if (i >= 0 && i < hits.length && idx.indexOf(i) < 0) idx.push(i); }
    hits.forEach(function (h, i) { var c = h.chunk; if (c.no && text.indexOf(squash(c.doc) + '第' + c.no + '条') >= 0) add(i); });
    if (!idx.length) hits.forEach(function (h, i) { var c = h.chunk; if (c.no && c.doc === '就業規則' && text.indexOf('第' + c.no + '条') >= 0) add(i); });
    (cited || []).forEach(function (c) { add(parseInt(String(c).replace(/\D/g, ''), 10) - 1); });
    if (!idx.length) add(0);
    return idx.slice(0, 3);
  }
  function parseModelJson(text) {
    var t = String(text || '').replace(/^```(?:json)?\s*/i, '').replace(/```\s*$/, '').trim();
    var s = t.indexOf('{'), e = t.lastIndexOf('}');
    if (s < 0 || e < s) return null;
    try { return JSON.parse(t.slice(s, e + 1)); } catch (err) { return null; }
  }

  // ---------- 名簿の合体(B2=鉄構、B5=建設・総務) ----------
  var B2_ACTIVE = ['在職中', '休職中', '専務'];
  var B5_ACTIVE = ['勤務'];
  function colIndex(header) {
    var idx = {};
    header.forEach(function (h, i) { idx[squash(h)] = i; });
    return idx;
  }
  function normEmail(s) { return nfkc(s).replace(/\s+/g, '').toLowerCase(); }
  // 打ち間違いを直す: 「@」の重なり(a@@gmail.com)と、よくあるGmailのドメイン誤字(gmeil.com等)
  var DOMAIN_FIX = { 'gmeil.com': 'gmail.com', 'gmial.com': 'gmail.com', 'gamil.com': 'gmail.com', 'gmai.com': 'gmail.com',
                     'gmail.con': 'gmail.com', 'gmail.co': 'gmail.com', 'gmail.comm': 'gmail.com', 'gmaill.com': 'gmail.com' };
  function fixEmail(s) {
    var e = normEmail(s).replace(/@{2,}/g, '@');
    var at = e.lastIndexOf('@');
    if (at > 0 && DOMAIN_FIX[e.slice(at + 1)]) e = e.slice(0, at + 1) + DOMAIN_FIX[e.slice(at + 1)];
    return e;
  }
  function normName(s) { return nfkc(s).replace(/\s+/g, ''); }
  function readRoster(values, kind) {
    if (!values || values.length < 2) return [];
    var ix = colIndex(values[0]), out = [];
    var get = function (r, name) { var i = ix[name]; return i == null ? '' : r[i]; };
    for (var k = 1; k < values.length; k++) {
      var r = values[k];
      var no = String(get(r, '社員No')).trim(), name = normName(get(r, '氏名'));
      if (!no && !name) continue;
      if (kind === 'B5') {
        var n5 = parseInt(nfkc(no), 10);
        out.push({
          no: isNaN(n5) ? '' : n5 + 2000, name: name, div: String(get(r, '事業部')).trim(), factory: '',
          dept: String(get(r, '部署')).trim(), born: '', email: fixEmail(get(r, 'E-Mail')), emailRaw: normEmail(get(r, 'E-Mail')),
          status: String(get(r, '現状')).trim(), driver: ''
        });
      } else {
        var n2 = parseInt(nfkc(no), 10);
        out.push({
          no: isNaN(n2) ? '' : n2, name: name, div: String(get(r, '事業部')).trim(), factory: String(get(r, '工場')).trim(),
          dept: String(get(r, '部')).trim(), born: String(get(r, '生まれた月')).trim(), email: fixEmail(get(r, 'E-Mail')), emailRaw: normEmail(get(r, 'E-Mail')),
          status: String(get(r, 'Reportcheck')).trim(), driver: String(get(r, '運転者')).trim()
        });
      }
    }
    return out;
  }
  // adminValues: 管理者シート(見出し行つき)。C列(管理者)が「管理者」の行だけ
  function mergeRoster(b2Values, b5Values, adminValues) {
    var warnings = [], rows = [], seen = {};
    var admins = {}, adminName = {};
    (adminValues || []).slice(1).forEach(function (r) {
      var em = fixEmail(r[1]);
      if (em && squash(r[2]) === '管理者') { admins[em] = true; adminName[em] = normName(r[0]); }
    });
    function add(list, kind) {
      list.forEach(function (p) {
        var active = (kind === 'B5' ? B5_ACTIVE : B2_ACTIVE).indexOf(p.status) >= 0;
        if (!active) return; // 退職済・退社・状態なしは反映しない
        var tag = '(' + (kind === 'B5' ? 'B5' : 'B2') + ' 社員No' + p.no + ' ' + p.name + ')';
        if (!p.email) { warnings.push('E-Mail空欄' + tag); return; } // ログインはできない(警告には残す)
        if (p.email !== p.emailRaw) warnings.push('E-Mail自動補正 ' + p.emailRaw + ' → ' + p.email + tag);
        if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(p.email) || (/^gmail\./.test(p.email.split('@')[1] || '') && p.email.split('@')[1] !== 'gmail.com')) { warnings.push('E-Mail要確認 ' + p.email + tag); return; }
        if (seen[p.email]) { warnings.push('E-Mail重複 ' + p.email + tag + '(先の行を採用)'); return; }
        seen[p.email] = true;
        p.admin = admins[p.email] ? '管理者' : '';
        rows.push(p);
      });
    }
    add(readRoster(b2Values, 'B2'), 'B2');
    add(readRoster(b5Values, 'B5'), 'B5');
    Object.keys(admins).forEach(function (em) {
      var p = rows.filter(function (x) { return x.email === em; })[0];
      if (!p) warnings.push('管理者シートのE-Mailが名簿に無い: ' + em + '(' + adminName[em] + ')→権限なし');
      else if (adminName[em] && adminName[em] !== p.name) warnings.push('管理者シートの氏名と名簿が不一致: ' + em + ' シート=' + adminName[em] + ' 名簿=' + p.name);
    });
    var table = rows.map(function (p) {
      return [p.no, p.name, p.div, p.factory, p.dept, p.born, '', p.email, p.status === '勤務' ? '在職中' : p.status, p.driver, p.admin];
    });
    return { table: table, warnings: warnings, adminCount: rows.filter(function (p) { return p.admin; }).length };
  }

  // ---------- 有給・欠勤(第2弾): 数字はコードが計算し、AIは使わない ----------
  // 日付は 'yyyy/MM/dd' の文字で扱う(Code.gs側でDateを文字に直してから渡す)
  function pad2(n) { return (n < 10 ? '0' : '') + n; }
  function ymd(y, m, d) { return y + '/' + pad2(m) + '/' + pad2(d); }
  function normDate(v) {
    var m = /(\d{4})[\/\-年](\d{1,2})[\/\-月](\d{1,2})/.exec(nfkc(v));
    return m ? ymd(+m[1], +m[2], +m[3]) : '';
  }
  function toUtc(s) { var p = s.split('/'); return Date.UTC(+p[0], +p[1] - 1, +p[2]); }
  function fromUtc(t) { var d = new Date(t); return ymd(d.getUTCFullYear(), d.getUTCMonth() + 1, d.getUTCDate()); }
  function addDays(s, n) { return fromUtc(toUtc(s) + n * 86400000); }
  function dow(s) { return new Date(toUtc(s)).getUTCDay(); }

  var ABS_HEADER = ['AbID', '社員No', '自', '至', '申請項目', '事由', '振替日', '直属上司', '元'];
  // B2(鉄構)・B5(建設・総務)のAbsenteeismを1つに合体。B5の社員No・直属上司には+2000。AbIDで重複を除く(先に来た行を採用)
  function mergeAbsence(v2, v5) {
    var rows = [], seen = {}, skipped = 0;
    function add(values, kind) {
      if (!values || values.length < 2) return;
      var ix = colIndex(values[0]);
      var g = function (r, n) { var i = ix[n]; return i == null ? '' : r[i]; };
      var off = kind === 'B5' ? 2000 : 0;
      for (var k = 1; k < values.length; k++) {
        var r = values[k], id = String(g(r, 'AbID')).trim(), no = parseInt(nfkc(g(r, '登録者')), 10), from = normDate(g(r, '自'));
        if (!id || isNaN(no) || !from) { if (id || !isNaN(no)) skipped++; continue; }
        if (seen[id]) continue;
        seen[id] = true;
        var boss = parseInt(nfkc(g(r, '直属上司')), 10);
        rows.push([id, no + off, from, normDate(g(r, '至')), String(g(r, '申請項目')).trim(), String(g(r, '事由')).trim(),
                   normDate(g(r, '振替日')), isNaN(boss) ? '' : boss + off, kind]);
      }
    }
    add(v2, 'B2'); add(v5, 'B5');
    return { table: rows, skipped: skipped };
  }

  // 期間(from〜to)。今日(today)から、質問文の指定を読み取る。指定なしは「今年度(4/1〜翌3/31。有給の付与は4月)」
  function parsePeriod(q, today) {
    var t = nfkc(q), y = +today.slice(0, 4), m = +today.slice(5, 7), d = +today.slice(8, 10), mm;
    function monthDo(yy, mo) { // 月度: 前月21日〜当月20日
      var py = mo === 1 ? yy - 1 : yy, pm = mo === 1 ? 12 : mo - 1;
      return { from: ymd(py, pm, 21), to: ymd(yy, mo, 20), label: yy + '年' + mo + '月度' };
    }
    var curMonthDo = d >= 21 ? (m === 12 ? { y: y + 1, m: 1 } : { y: y, m: m + 1 }) : { y: y, m: m };
    if (/(これまで|今まで|全期間|累計|通算|ずっと|全部)/.test(t)) return { from: '2000/01/01', to: '2099/12/31', label: '全期間' };
    if (/会計年度|会計年/.test(t)) {
      var fy = /(昨|去|前)/.test(t) ? -1 : 0, ys = (m > 11 || (m === 11 && d >= 21)) ? y : y - 1; ys += fy;
      return { from: ymd(ys, 11, 21), to: ymd(ys + 1, 11, 20), label: '会計年度 ' + ys + '/11/21〜' + (ys + 1) + '/11/20' };
    }
    if ((mm = /(\d{4})年度/.exec(t))) { var a = +mm[1]; return { from: ymd(a, 4, 1), to: ymd(a + 1, 3, 31), label: a + '年度(' + a + '/04/01〜' + (a + 1) + '/03/31)' }; }
    if ((mm = /(\d{4})年(\d{1,2})月/.exec(t))) { var r1 = monthDo(+mm[1], +mm[2]); return r1; }
    if ((mm = /(\d{4})年/.exec(t))) { var b = +mm[1]; return { from: ymd(b, 1, 1), to: ymd(b, 12, 31), label: b + '年(1/1〜12/31)' }; }
    function monthsBack(n) { var mo = curMonthDo.m - n, yy = curMonthDo.y; while (mo < 1) { mo += 12; yy--; } return monthDo(yy, mo); }
    if (/先々月/.test(t)) return monthsBack(2);
    if (/(先月|前月)/.test(t)) return monthsBack(1);
    if (/(今月|当月|今月度)/.test(t)) return monthDo(curMonthDo.y, curMonthDo.m);
    if ((mm = /(\d{1,2})月(?!曜)/.exec(t))) {
      var mo = +mm[1]; if (mo >= 1 && mo <= 12) { var yy = mo > curMonthDo.m ? curMonthDo.y - 1 : curMonthDo.y; return monthDo(yy, mo); }
    }
    if (/(昨年度|去年度|前年度)/.test(t)) { var s0 = (m >= 4 ? y : y - 1) - 1; return { from: ymd(s0, 4, 1), to: ymd(s0 + 1, 3, 31), label: '昨年度(' + s0 + '/04/01〜' + (s0 + 1) + '/03/31)' }; }
    if (/(昨年|去年|前年)/.test(t)) return { from: ymd(y - 1, 1, 1), to: ymd(y - 1, 12, 31), label: (y - 1) + '年(1/1〜12/31)' };
    if (/(今年|本年)(?!度)/.test(t)) return { from: ymd(y, 1, 1), to: ymd(y, 12, 31), label: y + '年(1/1〜12/31)' };
    var s1 = m >= 4 ? y : y - 1; // 既定: 今年度
    return { from: ymd(s1, 4, 1), to: ymd(s1 + 1, 3, 31), label: '今年度(' + s1 + '/04/01〜' + (s1 + 1) + '/03/31)', isDefault: true };
  }

  var ABS_TOPIC = /(有給|有休|年休|欠勤|遅刻|早退|遅早|休んだ|休み|休暇)/;
  var ABS_CUE = /(私|わたし|自分|僕|俺|取った|取って|取得|使った|使って|消化|何日休|何回休|休んだ|遅刻した|欠勤した)/;
  // roster: [{no, name}]。質問に出てきた氏名(スペースなしの完全一致)を探す
  function findPeople(q, roster) {
    var sq = squash(q), out = [];
    roster.forEach(function (p) { var n = normName(p.name); if (n.length >= 2 && sq.indexOf(n) >= 0) out.push(p); });
    var maxLen = 0; out.forEach(function (p) { maxLen = Math.max(maxLen, normName(p.name).length); });
    return out.filter(function (p) { return normName(p.name).length === maxLen; }); // 長い名前を優先(部分一致の取りこぼし防止)
  }
  // 戻り値: null(就業規則の質問として扱う) / {who:'self'|'person'|'ambiguous', people, period, remain}
  function parseAbsenceQuery(q, today, roster) {
    var t = nfkc(q);
    if (!ABS_TOPIC.test(t)) return null;
    var people = findPeople(q, roster), selfCue = /(私|わたし|自分|僕|俺)/.test(t);
    if (!people.length && !selfCue && !ABS_CUE.test(t)) return null;
    if (!people.length && !selfCue) return null; // 「誰の」が分からない取得系の質問は、規則の質問とみなす
    var who = people.length > 1 ? 'ambiguous' : people.length === 1 ? 'person' : 'self';
    if (who === 'self' && !/(取った|取って|取得|使った|使って|消化|休んだ|遅刻|早退|欠勤|何日|何回|残|状況|確認|履歴)/.test(t)) return null;
    return { who: who, people: people, period: parsePeriod(q, today), remain: /(残り|残数|残日|残って|あと何日|余り)/.test(t) };
  }

  // 申請1件が、期間内で何日分か(至があれば、休日を除いた日数。休日の情報が無い日は土日を休みとみなす)
  function daysInPeriod(row, period, holidays) {
    var from = row[2], to = row[3] || row[2];
    var s = from < period.from ? period.from : from, e = to > period.to ? period.to : to;
    if (s > e) return 0;
    if (from === to || !row[3]) return (from >= period.from && from <= period.to) ? 1 : 0;
    var n = 0, cur = s;
    for (var i = 0; i < 400 && cur <= e; i++, cur = addDays(cur, 1)) {
      var h = holidays[cur];
      if (h === '休日' || (h == null && (dow(cur) === 0 || dow(cur) === 6))) continue;
      n++;
    }
    return n;
  }
  // rows: mergeAbsence後の表。holidays: {'yyyy/MM/dd':'休日'|'出勤'}
  function summarizeAbsence(rows, no, period, holidays) {
    var kinds = {}, details = [];
    rows.forEach(function (r) {
      if (Number(r[1]) !== Number(no)) return;
      var n = daysInPeriod(r, period, holidays);
      if (!n) return;
      var kind = r[4] || '(項目なし)', k = kinds[kind] || (kinds[kind] = { count: 0, days: 0 });
      k.count++; k.days += n;
      details.push({ from: r[2], to: r[3], kind: kind, days: n, reason: r[5] });
    });
    details.sort(function (a, b) { return a.from < b.from ? 1 : a.from > b.from ? -1 : 0; });
    var full = kinds['有給'] || { count: 0, days: 0 }, half = kinds['半日有給'] || { count: 0, days: 0 };
    return { kinds: kinds, details: details, paidDays: full.days + half.count * 0.5, full: full.count, half: half.count };
  }
  function fmtNum(x) { return String(Math.round(x * 10) / 10); }
  function formatAbsenceAnswer(name, no, period, sum, remain, asOfDate) {
    var out = [name + 'さん(社員No' + no + ')の ' + period.label + ' の状況です(' + asOfDate + ' 時点のデータ)。'];
    var ks = Object.keys(sum.kinds);
    if (!ks.length) out.push('この期間に、有給・欠勤・遅早などの申請は見つかりませんでした。');
    else {
      out.push('・有給: ' + fmtNum(sum.paidDays) + '日(全日' + sum.full + '回、半日' + sum.half + '回)');
      ks.filter(function (k) { return k !== '有給' && k !== '半日有給'; }).forEach(function (k) {
        out.push('・' + k + ': ' + sum.kinds[k].count + '回' + (k === '遅早' ? '' : '(' + fmtNum(sum.kinds[k].days) + '日)'));
      });
      var show = sum.details.slice(0, 10);
      out.push('', '【直近の申請】');
      show.forEach(function (d) { out.push(d.from + (d.to && d.to !== d.from ? '〜' + d.to : '') + ' ' + d.kind + (d.reason ? '(' + d.reason + ')' : '')); });
      if (sum.details.length > show.length) out.push('ほか' + (sum.details.length - show.length) + '件');
    }
    if (remain) out.push('', '※残日数は、付与日数のデータがこのアプリに無いため算出できません。付与の日数の決まりは「年次有給休暇は何日もらえますか」でお答えできます。');
    return out.join('\n');
  }

  return { nfkc: nfkc, squash: squash, parseRules: parseRules, chunkLabel: chunkLabel, searchRules: searchRules,
           buildPrompt: buildPrompt, pickSources: pickSources, parseModelJson: parseModelJson, mergeRoster: mergeRoster, readRoster: readRoster,
           normEmail: normEmail, fixEmail: fixEmail, normName: normName,
           ABS_HEADER: ABS_HEADER, normDate: normDate, mergeAbsence: mergeAbsence, parsePeriod: parsePeriod, findPeople: findPeople,
           parseAbsenceQuery: parseAbsenceQuery, daysInPeriod: daysInPeriod, summarizeAbsence: summarizeAbsence, formatAbsenceAnswer: formatAbsenceAnswer };
})();
