/**
 * 社内AI: 純粋関数(GAS固有のAPIを使わない)。Node(vm)でも同じコードをテストする。
 * Code.gs から AI_LOGIC として呼ぶ。
 */
var AI_LOGIC = (function () {
  function nfkc(s) { return String(s == null ? '' : s).normalize('NFKC'); }
  function squash(s) { return nfkc(s).replace(/\s+/g, ''); }
  var C_FILLER = /(ですか|ですね|でしょうか|みんな|全員|全体|総|です|ますか|ます|ください|下さい|教えて|おしえて|知りたい|いくら|いくつ|どれくらい|どのくらい|どれだけ|何|全部|合計|について|ありますか|ある|まで|から|分|現在|今|は|が|を|に|の|で|と|も|へ|や|か|ね|よ|、|。|,|\.|\?|!|\s|「|」|\(|\)|・)/g;

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
    var rows = [], seen = {}, skipped = 0, warnings = [];
    function add(values, kind) {
      if (!values || values.length < 2) return;
      var ix = colIndex(values[0]), before = rows.length;
      var lack = ['AbID', '登録者', '自', '申請項目'].filter(function (n) { return ix[n] == null; });
      if (lack.length) { warnings.push(kind + 'のAbsenteeismに列が見つかりません: ' + lack.join('、') + '(列名が変わっていないか確認)'); return; }
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
    var n2 = 0;
    add(v2, 'B2'); n2 = rows.length; add(v5, 'B5');
    if (v5 && v5.length > 50 && rows.length - n2 === 0 && !warnings.length) warnings.push('B5のAbsenteeismから1件も取り込めませんでした');
    return { table: rows, skipped: skipped, warnings: warnings };
  }

  // 期間(from〜to)。今日(today)から、質問文の指定を読み取る。指定なしは「今年度(4/1〜翌3/31。有給の付与は4月)」
  function parsePeriod(q, today, defKind) {
    var t = nfkc(q), y = +today.slice(0, 4), m = +today.slice(5, 7), d = +today.slice(8, 10), mm;
    function monthDo(yy, mo) { // 月度: 前月21日〜当月20日
      var py = mo === 1 ? yy - 1 : yy, pm = mo === 1 ? 12 : mo - 1;
      return { from: ymd(py, pm, 21), to: ymd(yy, mo, 20), label: yy + '年' + mo + '月度' };
    }
    var curMonthDo = d >= 21 ? (m === 12 ? { y: y + 1, m: 1 } : { y: y, m: m + 1 }) : { y: y, m: m };
    if ((mm = /(\d{4}\/\d{1,2}\/\d{1,2})[〜~](\d{4}\/\d{1,2}\/\d{1,2})/.exec(t))) return { from: normDate(mm[1]), to: normDate(mm[2]), label: normDate(mm[1]) + '〜' + normDate(mm[2]) }; // 選択肢のボタンが作る範囲指定
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
    if (defKind === 'month') { var cm = monthDo(curMonthDo.y, curMonthDo.m); cm.label = '今月度(' + cm.from + '〜' + cm.to + ')'; cm.isDefault = true; return cm; }
    var s1 = m >= 4 ? y : y - 1; // 既定: 今年度
    return { from: ymd(s1, 4, 1), to: ymd(s1 + 1, 3, 31), label: '今年度(' + s1 + '/04/01〜' + (s1 + 1) + '/03/31)', isDefault: true };
  }

  var ABS_TOPIC = /(有給|有休|年休|欠勤|遅刻|早退|遅早|休んだ|休み|休暇|届)/;
  var ABS_CUE = /(私|わたし|自分|僕|俺|取った|取って|取得|使った|使って|消化|何日休|何回休|休んだ|遅刻した|欠勤した)/;
  // roster: [{no, name}]。質問に出てきた氏名(スペースなしの完全一致)を探す
  function findPeople(q, roster) {
    var sq = squash(q), out = [];
    roster.forEach(function (p) { var n = normName(p.name); if (n.length >= 2 && sq.indexOf(n) >= 0) out.push(p); });
    var maxLen = 0; out.forEach(function (p) { maxLen = Math.max(maxLen, normName(p.name).length); });
    out = out.filter(function (p) { return normName(p.name).length === maxLen; }); // 長い名前を優先(部分一致の取りこぼし防止)
    if (out.length) return out;
    // 氏名の完全一致が無いとき: 姓だけ(「角さん」「角の」)。名簿の姓と名の間に空白がある場合だけ。同じ姓が複数なら呼び出し側で「複数該当」になる
    roster.forEach(function (p) {
      var parts = nfkc(p.name).trim().split(/\s+/);
      if (parts.length < 2 || !parts[0]) return;
      var sn = parts[0].replace(/[.\\^$*+?()[\]{}|\/-]/g, '\\$&');
      if (new RegExp(sn + '(さん|くん|君|の|は|が|を|に)').test(sq)) out.push(p);
    });
    return out;
  }
  // 戻り値: null(就業規則の質問として扱う) / {who:'self'|'person'|'ambiguous', people, period, remain}
  function parseAbsenceQuery(q, today, roster) {
    var t = nfkc(q);
    if (!ABS_TOPIC.test(t)) return null;
    var people = findPeople(q, roster), selfCue = /(私|わたし|自分|僕|俺)/.test(t);
    if (!people.length && !selfCue && !ABS_CUE.test(t)) return null;
    if (!people.length && !selfCue) return null; // 「誰の」が分からない取得系の質問は、規則の質問とみなす
    var who = people.length > 1 ? 'ambiguous' : people.length === 1 ? 'person' : 'self';
    if (who === 'self' && !/(取った|取って|取得|使った|使って|消化|休んだ|遅刻|早退|欠勤|何日|何回|残|状況|確認|履歴|一覧|届)/.test(t)) return null;
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


  // ---------- 日報(第2弾): 工数の集計。数字はコードが計算し、AIは使わない ----------
  var WORK_HEADER = ['WorkReportNo', '社員No', '作業日', '工事ID', '工事No', '工事名', '作業内容', '時間', '元'];
  function dnum(s) { return parseInt(String(s).replace(/\//g, ''), 10); }
  function buildConsMap(values) { // 工事ID → {no, name}
    var m = {};
    if (!values || values.length < 2) return m;
    var ix = colIndex(values[0]);
    values.slice(1).forEach(function (r) {
      var id = String(r[ix['工事ID']] == null ? '' : r[ix['工事ID']]).trim();
      if (id) m[id] = { no: String(r[ix['工事No']] == null ? '' : r[ix['工事No']]).trim(), name: String(r[ix['工事名']] == null ? '' : r[ix['工事名']]).trim() };
    });
    return m;
  }
  function hours(v) { var h = parseFloat(nfkc(v)); return isNaN(h) || h <= 0 || h > 24 ? 0 : h; }
  // B2(鉄構)の日報: 1行に最大5件(工事名N・工事名N_free・作業内容N・作業時間N)。seen: 既に取り込んだ WorkReport No(先に入れた方を優先)
  function workFromB2(values, cons, seen, warnings) {
    var out = [];
    if (!values || values.length < 2) return out;
    var ix = colIndex(values[0]);
    var lack = ['WorkReportNo', '登録者', '作業日', '工事名1', '作業時間1'].filter(function (n) { return ix[n] == null; });
    if (lack.length) { warnings.push('日報(鉄構)に列が見つかりません: ' + lack.join('、')); return out; }
    for (var k = 1; k < values.length; k++) {
      var r = values[k], id = String(r[ix['WorkReportNo']]).trim(), no = parseInt(nfkc(r[ix['登録者']]), 10), d = normDate(r[ix['作業日']]);
      if (!id || isNaN(no) || !d || seen[id]) continue;
      var got = false;
      for (var j = 1; j <= 5; j++) {
        var h = hours(r[ix['作業時間' + j]]); if (!h) continue;
        var cid = String(r[ix['工事名' + j]] == null ? '' : r[ix['工事名' + j]]).trim(), free = ix['工事名' + j + '_free'] == null ? '' : String(r[ix['工事名' + j + '_free']]).trim();
        var c = cons[cid] || {};
        out.push([id, no, dnum(d), cid, c.no || cid, c.name || free.replace(/\.\.\.$/, ''), String(r[ix['作業内容' + j]] == null ? '' : r[ix['作業内容' + j]]).trim(), h, 'B2']);
        got = true;
      }
      if (got) seen[id] = true;
    }
    return out;
  }
  // B5(建設・総務)の日報: 作業時間 = 終了 − 開始(休憩は差し引かない)。社員No+2000
  function workFromB5(values, seen, warnings) {
    var out = [];
    if (!values || values.length < 2) return out;
    var ix = colIndex(values[0]);
    var lack = ['WorkReportNo', '登録者', '開始時間', '終了時間'].filter(function (n) { return ix[n] == null; });
    if (lack.length) { warnings.push('日報(建設・総務)に列が見つかりません: ' + lack.join('、')); return out; }
    function ms(v) { var m = /(\d{4})[\/\-](\d{1,2})[\/\-](\d{1,2})[ T](\d{1,2}):(\d{2})/.exec(nfkc(v)); return m ? Date.UTC(+m[1], +m[2] - 1, +m[3], +m[4], +m[5]) : NaN; }
    for (var k = 1; k < values.length; k++) {
      var r = values[k], id = String(r[ix['WorkReportNo']]).trim(), no = parseInt(nfkc(r[ix['登録者']]), 10), d = normDate(r[ix['開始時間']]);
      if (!id || isNaN(no) || !d || seen[id]) continue;
      var a = ms(r[ix['開始時間']]), b = ms(r[ix['終了時間']]), h = (b - a) / 3600000;
      if (!isNaN(h) && h < 0) h += 24;
      h = isNaN(h) || h <= 0 || h > 24 ? 0 : Math.round(h * 100) / 100;
      if (!h) continue;
      seen[id] = true;
      var nm = ix['工事名'] == null ? '' : String(r[ix['工事名']]).trim();
      out.push([id, no + 2000, dnum(d), ix['工事名(参照)'] == null ? '' : String(r[ix['工事名(参照)']]).trim(), ix['工事No'] == null ? '' : String(r[ix['工事No']]).trim(),
                nm, ix['作業内容'] == null ? '' : String(r[ix['作業内容']]).trim(), h, 'B5']);
    }
    return out;
  }
  function sortWork(rows) { return rows.sort(function (x, y) { return x[2] - y[2]; }); }

  function hasToken(sq, tok) { // 数字・英字の途中の一致を除く
    var t = squash(tok).toLowerCase(), s = sq.toLowerCase(), i = -1;
    if (!t) return false;
    while ((i = s.indexOf(t, i + 1)) >= 0) {
      var pre = s.charAt(i - 1), post = s.charAt(i + t.length);
      if (!/[0-9a-z\-]/.test(pre) && !/[0-9a-z\-]/.test(post)) return true;
    }
    return false;
  }
  var GENERIC_PROJECT = ['自由記入', '自由記述', 'その他'];
  // projects: [{id, no, name}]。質問に含まれる工事(名前・工事ID・工事No)を探す
  function findProjects(q, projects) {
    var sq = squash(q), hit = [], seen = {};
    projects.forEach(function (p) {
      var nm = squash(p.name), len = 0;
      if (nm.length >= 3 && GENERIC_PROJECT.indexOf(nm) < 0 && sq.indexOf(nm) >= 0) len = nm.length;
      else if (String(p.id).length >= 6 && hasToken(sq, p.id)) len = 5;
      else if (/^[0-9]{2}-[0-9]+[A-Za-z]?$/.test(String(p.no)) && hasToken(sq, p.no)) len = 4;
      if (!len) return;
      var key = nm + '|' + p.no; if (seen[key]) return; seen[key] = true;
      hit.push({ p: p, len: len });
    });
    var mx = 0; hit.forEach(function (h) { mx = Math.max(mx, h.len); });
    return hit.filter(function (h) { return h.len === mx; }).map(function (h) { return h.p; });
  }
  function parseDay(q, today) {
    var t = nfkc(q), mm;
    if (/\d{4}\/\d{1,2}\/\d{1,2}[〜~]\d{4}\/\d{1,2}\/\d{1,2}/.test(t)) return ''; // 範囲指定は日付ではなく期間
    if (/(一昨日|おととい)/.test(t)) return addDays(today, -2);
    if (/昨日/.test(t)) return addDays(today, -1);
    if (/(今日|本日)/.test(t)) return today;
    if ((mm = /(\d{4})[\/年](\d{1,2})[\/月](\d{1,2})日?/.exec(t))) return ymd(+mm[1], +mm[2], +mm[3]);
    if ((mm = /(\d{1,2})月(\d{1,2})日/.exec(t)) || (mm = /(?:^|[^\d])(\d{1,2})\/(\d{1,2})(?:[^\d]|$)/.exec(t))) {
      var y = +today.slice(0, 4), d = ymd(y, +mm[1], +mm[2]); return d > today ? ymd(y - 1, +mm[1], +mm[2]) : d;
    }
    return '';
  }
  var WORK_TOPIC = /(日報|工数|作業時間|何時間|時間働|どれくらい働|どのくらい働|働いた)/;
  // 戻り値: null / {who, people, projects, period, day}
  function parseWorkQuery(q, today, roster, projects) {
    var t = nfkc(q);
    if (!WORK_TOPIC.test(t)) return null;
    var people = findPeople(q, roster), selfCue = /(私|わたし|自分|僕|俺)/.test(t), pj = findProjects(q, projects);
    if (!people.length && !selfCue && !pj.length) return null; // 誰・どの工事かが分からない質問は、規則の質問とみなす
    var who = people.length > 1 ? 'ambiguous' : people.length === 1 ? 'person' : selfCue ? 'self' : 'none';
    var day = parseDay(q, today), period = day ? { from: day, to: day, label: day, isDay: true } : parsePeriod(q, today, 'month');
    return { who: who, people: people, projects: pj, period: period, day: day };
  }
  // rows: 日報の行(期間内)。f: {no, project}
  function summarizeWork(rows, f) {
    var total = 0, days = {}, people = {}, byP = {}, byC = {}, byW = {}, detail = [], srcs = {};
    rows.forEach(function (r) {
      if (f.no != null && Number(r[1]) !== Number(f.no)) return;
      if (f.project && !(squash(r[5]) === squash(f.project.name) || (r[3] && r[3] === f.project.id) || (f.project.no && r[4] === f.project.no && squash(r[5]) === squash(f.project.name)))) return;
      var h = Number(r[7]); total += h; days[r[2]] = 1; people[r[1]] = (people[r[1]] || 0) + h; srcs[r[8]] = 1;
      var pk = (r[5] || r[4] || '(工事不明)') + (r[4] && r[5] ? '(' + r[4] + ')' : '');
      byP[pk] = (byP[pk] || 0) + h; byC[r[6] || '(不明)'] = (byC[r[6] || '(不明)'] || 0) + h; byW[r[1]] = (byW[r[1]] || 0) + h;
      detail.push({ date: r[2], proj: pk, content: r[6], h: h });
    });
    return { total: total, dayCount: Object.keys(days).length, peopleCount: Object.keys(people).length, byProject: byP, byContent: byC, byPerson: byW, detail: detail, hasB5: !!srcs.B5 };
  }
  function top(o, n) { return Object.keys(o).map(function (k) { return [k, o[k]]; }).sort(function (a, b) { return b[1] - a[1]; }).slice(0, n); }
  function dfmt(n) { var s = String(n); return s.slice(0, 4) + '/' + s.slice(4, 6) + '/' + s.slice(6); }
  // ctx: {title, period, names:{社員No:氏名}, contentNames:{コード:名称}, asOf}
  function formatWorkAnswer(sum, ctx) {
    var out = [ctx.title + ' の ' + ctx.period.label + ' の工数です(' + ctx.asOf + ' 時点のデータ)。'];
    if (!sum.total) { out.push('この期間の日報は見つかりませんでした。'); return out.join('\n'); }
    out.push('合計 ' + fmtNum(sum.total) + '時間(日報のあった日 ' + sum.dayCount + '日' + (ctx.showPeople ? '、延べ' + sum.peopleCount + '人' : '') + ')');
    var cn = function (c) { return ctx.contentNames && ctx.contentNames[c] ? c + ' ' + ctx.contentNames[c] : c; };
    if (ctx.period.isDay) {
      out.push('', '【内訳】');
      sum.detail.slice(0, 15).forEach(function (d) { out.push('・' + d.proj + ' / ' + cn(d.content) + ' / ' + fmtNum(d.h) + '時間'); });
    } else {
      if (!ctx.skipProject) { out.push('', '【工事別】'); top(sum.byProject, 8).forEach(function (x) { out.push('・' + x[0] + ': ' + fmtNum(x[1]) + '時間'); }); }
      out.push('', '【作業内容別】'); top(sum.byContent, 8).forEach(function (x) { out.push('・' + cn(x[0]) + ': ' + fmtNum(x[1]) + '時間'); });
      if (ctx.showPeople) { out.push('', '【人別(上位8)】'); top(sum.byPerson, 8).forEach(function (x) { out.push('・' + (ctx.names[x[0]] || '社員No' + x[0]) + ': ' + fmtNum(x[1]) + '時間'); }); }
    }
    if (sum.hasB5) out.push('', '※建設・総務の時間は、日報の開始〜終了時刻の差です(休憩は差し引いていません)。');
    return out.join('\n');
  }


  // ---------- 会社カレンダーの一般的な質問(今日の日付・出勤日か・次の休日・次の連休・月の出勤日数) ----------
  var WD = ['日', '月', '火', '水', '木', '金', '土'];
  function dlabel(d) { return d + '(' + WD[dow(d)] + ')'; }
  function monthRange(today, t) {
    var mm, y = +today.slice(0, 4), m = +today.slice(5, 7);
    if (/来月/.test(t)) { m++; } else if (/先月|前月/.test(t)) { m--; } else if ((mm = /(\d{1,2})月/.exec(t))) { m = +mm[1]; }
    while (m > 12) { m -= 12; y++; } while (m < 1) { m += 12; y--; }
    var last = new Date(Date.UTC(y, m, 0)).getUTCDate();
    return { from: ymd(y, m, 1), to: ymd(y, m, last), label: y + '年' + m + '月' };
  }
  function resolveCalDate(t, today) {
    var mm;
    if (/明後日|あさって/.test(t)) return addDays(today, 2);
    if (/明日|あした/.test(t)) return addDays(today, 1);
    if (/昨日/.test(t)) return addDays(today, -1);
    if (/(今日|本日)/.test(t)) return today;
    if ((mm = /(\d{4})[\/年](\d{1,2})[\/月](\d{1,2})日?/.exec(t))) return ymd(+mm[1], +mm[2], +mm[3]);
    if ((mm = /(\d{1,2})月(\d{1,2})日/.exec(t)) || (mm = /(?:^|[^\d])(\d{1,2})\/(\d{1,2})(?:[^\d]|$)/.exec(t))) return ymd(+today.slice(0, 4), +mm[1], +mm[2]);
    if ((mm = /(再来週|来週|今週|今度の|次の|この)?の?([月火水木金土日])曜/.exec(t))) {
      var wd = WD.indexOf(mm[2]), cur = dow(today), pre = mm[1] || '';
      if (/週/.test(pre)) { var monday = addDays(today, -((cur + 6) % 7)), k = pre === '再来週' ? 2 : pre === '来週' ? 1 : 0; return addDays(monday, 7 * k + ((wd + 6) % 7)); }
      var n = (wd - cur + 7) % 7; if (/今度|次/.test(pre) && n === 0) n = 7;
      return addDays(today, n);
    }
    return '';
  }
  // 戻り値: null(カレンダーの質問ではない) / {kind: today|day|next|renkyu|month, ...}
  function parseCalendarQuery(q, today) {
    var t = nfkc(q), mm;
    if (/(今日|本日)(の日付|は何日|は何月|は何曜|の曜日)|^日付|日付を教え|今日の日付/.test(t)) return { kind: 'today' };
    if (/(次|今度|直近|最初|今後).*連休|連休.*(いつ|次|今度)/.test(t)) return { kind: 'renkyu' };
    if ((mm = /(次|今度|直近|最初)の?(休日|休み|お休み|出勤日|出社日|営業日)/.exec(t))) return { kind: 'next', want: /出勤|出社|営業/.test(mm[2]) ? '出勤' : '休日' };
    if (/(今月|来月|先月|前月|\d{1,2}月)/.test(t) && /(出勤日|休日|営業日|休み)/.test(t) && /(何日|いくつ|日数|何回)/.test(t) && !/\d{1,2}月\d{1,2}日/.test(t))
      return { kind: 'month', want: /休日|休み/.test(t) && !/出勤日|営業日/.test(t) ? '休日' : '出勤', range: monthRange(today, t) };
    var d = resolveCalDate(t, today);
    var bare = t.replace(/(\d{4}[\/年])?\d{1,2}[\/月]\d{1,2}日?|(再来週|来週|今週|今度|次|この)?の?[月火水木金土日]曜日?|明後日|あさって|明日|あした|昨日|今日|本日/g, '').replace(C_FILLER, '') === '';
    if (d && (bare || /(出勤|休日|休み|お休み|営業日|出社|会社|カレンダー|曜日|何曜|何日|いつ)/.test(t))) return { kind: 'day', date: d };
    return null;
  }
  // hol: {'yyyy/MM/dd': '休日'|'出勤'}
  function answerCalendar(c, today, hol) {
    function st(d) { return hol[d] || ''; }
    function find(from, want, max) { for (var i = 0, d = from; i < max; i++, d = addDays(d, 1)) if (st(d) === want) return d; return ''; }
    function ago(d) { var n = Math.round((toUtc(d) - toUtc(today)) / 86400000); return n === 0 ? '今日' : n === 1 ? '明日' : n + '日後'; }
    var out;
    if (c.kind === 'today') {
      out = '今日は ' + dlabel(today) + ' です。' + (st(today) ? '会社カレンダー上は「' + (st(today) === '出勤' ? '出勤日' : '休日') + '」です。' : '(会社カレンダーに今日の登録がありません)');
    } else if (c.kind === 'day') {
      var s = st(c.date);
      out = dlabel(c.date) + '(' + ago(c.date) + ')は、' + (s ? '会社カレンダー上「' + (s === '出勤' ? '出勤日' : '休日') + '」です。' : '会社カレンダーに登録がないため、出勤日かどうか分かりません。');
    } else if (c.kind === 'next') {
      var d = find(addDays(today, 1), c.want, 400);
      out = d ? '次の' + (c.want === '出勤' ? '出勤日' : '休日') + 'は ' + dlabel(d) + '(' + ago(d) + ')です。' + (st(today) === c.want ? '(今日も' + (c.want === '出勤' ? '出勤日' : '休日') + 'です)' : '') : '会社カレンダーに、今後の' + c.want + 'が登録されていません。';
    } else if (c.kind === 'renkyu') {
      var best = null, i, d0 = today, startToday = null;
      // 今日が連休の途中なら、その旨を添える
      if (st(today) === '休日') { var a = today, b = today; while (st(addDays(a, -1)) === '休日') a = addDays(a, -1); while (st(addDays(b, 1)) === '休日') b = addDays(b, 1); if (a !== b) startToday = [a, b]; }
      var cur = addDays(startToday ? startToday[1] : today, 1);
      for (i = 0; i < 400 && !best; i++) {
        if (st(cur) === '休日') { var e = cur; while (st(addDays(e, 1)) === '休日') e = addDays(e, 1); if (e !== cur) best = [cur, e]; cur = addDays(e, 1); i += 1; }
        else cur = addDays(cur, 1);
      }
      out = (startToday ? '今は連休中です(' + dlabel(startToday[0]) + '〜' + dlabel(startToday[1]) + ')。\n' : '') +
            (best ? '次の連休は ' + dlabel(best[0]) + '〜' + dlabel(best[1]) + ' の ' + (Math.round((toUtc(best[1]) - toUtc(best[0])) / 86400000) + 1) + '連休(' + ago(best[0]) + 'から)です。' : '会社カレンダーに、今後の連休(休日が2日以上続く期間)が登録されていません。');
    } else { // month
      var n = 0, miss = 0, r = c.range;
      for (var dd = r.from; dd <= r.to; dd = addDays(dd, 1)) { if (st(dd) === c.want) n++; else if (!st(dd)) miss++; }
      out = r.label + '(' + r.from + '〜' + r.to + ')の' + (c.want === '出勤' ? '出勤日' : '休日') + 'は ' + n + '日です。' + (miss ? '(カレンダー未登録の日が' + miss + '日あります)' : '');
    }
    return out + '\n※会社カレンダー(出勤/休日)に基づきます。';
  }


  // ---------- 生産重量(第2弾): 「加工」完了日の重量(トン)を集計。期間は会社の締め日(21日区切り)が既定。AIは使わない ----------
  var PROD_HEADER = ['工事番号', '工事名', '加工先', '部位', '加工日', '重量', '本数', '点数', 'マスター'];
  var MAIN_PARTS = ['柱', '大梁', '小梁'];
  var PROD_SITES = ['本社', '夢前', '鳥取']; // 加工先はこの3つだけ(「中止」「にしわき」など他は除外)
  // 案件マスターの1シート分(Code.gsが必要な列だけ取り出した表)を、「同じ生産日・加工先・部位」ごとに足し合わせた行に直す。
  // reduced: 先頭行=見出し(部位・加工先・加工・本数・重量)。加工が日付(年つき)の行だけ=加工完了。「*」(不要)・空欄(未了)・年の無い文字は数えない。
  // meta: {key(ドライブ:マスタNo), workNo, workName}。戻り値の行 = PROD_HEADER の並び(点数=製品の行数)
  function parseMasterRows(reduced, meta) {
    var map = {}, order = [], undated = 0;
    if (!reduced || reduced.length < 2) return { rows: [], undated: 0 };
    var ix = colIndex(reduced[0]);
    for (var k = 1; k < reduced.length; k++) {
      var r = reduced[k], site = String(r[ix['加工先']] == null ? '' : r[ix['加工先']]).trim(), part = String(r[ix['部位']] == null ? '' : r[ix['部位']]).trim();
      var raw = r[ix['加工']], d = normDate(raw);
      if (PROD_SITES.indexOf(site) < 0 || !part) continue;
      if (!d) { if (raw !== '' && raw != null && String(raw).trim() !== '*') undated++; continue; }
      var w = parseFloat(nfkc(r[ix['重量']])); if (isNaN(w)) w = 0;
      var q = parseFloat(nfkc(r[ix['本数']])); if (isNaN(q)) q = 0;
      var p = MAIN_PARTS.indexOf(part) >= 0 ? part : '他', dn = dnum(d), key = site + '|' + p + '|' + dn, row = map[key];
      if (!row) { row = map[key] = [meta.workNo, meta.workName, site, p, dn, 0, 0, 0, meta.key]; order.push(key); }
      row[5] += w; row[6] += q; row[7] += 1;
    }
    var rows = order.map(function (k) { var x = map[k]; x[5] = Math.round(x[5] * 1000) / 1000; return x; });
    return { rows: rows, undated: undated };
  }
  var PROD_TOPIC = /(生産重量|加工重量|生産量|加工量|生産実績|何トン|生産.{0,6}(重量|トン)|加工.{0,6}(重量|トン))/;
  var SITES = ['本社', '夢前', '鳥取'];
  function parseProdQuery(q, today, projects) {
    var t = nfkc(q);
    if (!PROD_TOPIC.test(t)) return null;
    var pj = findProjects(q, projects), sites = SITES.filter(function (x) { return t.indexOf(x) >= 0; });
    var parts = [];
    if (/大梁/.test(t)) parts.push('大梁'); if (/小梁/.test(t)) parts.push('小梁'); if (/柱/.test(t)) parts.push('柱'); if (/(その他|他の部位)/.test(t)) parts.push('他');
    var day = parseDay(q, today), tq = /会計/.test(t) ? t : t.replace(/(昨年度|去年度|前年度)/, '前会計年度').replace(/(今年度|本年度|今期|年間)/, '会計年度');
    var period = day ? { from: day, to: day, label: day, isDay: true } : parsePeriod(tq, today, 'month');
    return { projects: pj, sites: sites, parts: parts, period: period, day: day };
  }
  // 期間内(今日まで)の出勤日数。hol: {'yyyy/MM/dd':'出勤'|'休日'}
  function countWorkDays(hol, from, to) { var n = 0; Object.keys(hol).forEach(function (d) { if (hol[d] === '出勤' && d >= from && d <= to) n++; }); return n; }
  function summarizeProd(rows, f) {
    var total = 0, n = 0, bySite = {}, byPart = {}, byProj = {}, days = {};
    rows.forEach(function (r) {
      if (f.sites && f.sites.length && f.sites.indexOf(r[2]) < 0) return;
      if (f.parts && f.parts.length && f.parts.indexOf(r[3]) < 0) return;
      if (f.project && !(squash(r[1]) === squash(f.project.name) || (r[0] && r[0] === f.project.no))) return;
      var w = Number(r[5]) || 0; total += w; n += Number(r[7]) || 0; days[r[4]] = (days[r[4]] || 0) + w;
      bySite[r[2]] = (bySite[r[2]] || 0) + w; byPart[r[3]] = (byPart[r[3]] || 0) + w;
      var pk = (r[1] || r[0]) + (r[0] && r[1] ? '(' + r[0] + ')' : ''); byProj[pk] = (byProj[pk] || 0) + w;
    });
    return { total: total, count: n, bySite: bySite, byPart: byPart, byProject: byProj, byDay: days };
  }
  // ctx: {title, period, asOf, workDays(期間内で今日までの出勤日数。0なら日平均を出さない), filterNote}
  function formatProdAnswer(sum, ctx) {
    var out = [ctx.title + ' の ' + ctx.period.label + ' の生産重量(加工完了分)です(' + ctx.asOf + ' 時点のデータ)。'];
    if (!sum.count) { out.push('この期間に加工完了の実績が見つかりませんでした。'); return out.join('\n'); }
    out.push('合計 ' + fmtNum(sum.total) + 'トン(' + sum.count + '点)' + (ctx.workDays ? '、出勤日' + ctx.workDays + '日で日平均 ' + fmtNum(sum.total / ctx.workDays) + 'トン' : ''));
    if (ctx.period.isDay === undefined || !ctx.period.isDay) {
      var ds = Object.keys(sum.byDay).sort(); var peak = ds.sort(function (a, b) { return sum.byDay[b] - sum.byDay[a]; })[0];
      if (ds.length > 1) out.push('最大の日: ' + dfmt(peak) + ' ' + fmtNum(sum.byDay[peak]) + 'トン');
    }
    var mk = function (title, o, n) { out.push('', title); top(o, n).forEach(function (x) { out.push('・' + x[0] + ': ' + fmtNum(x[1]) + 'トン'); }); };
    if (Object.keys(sum.bySite).length > 1) mk('【加工先別】', sum.bySite, 6);
    mk('【部位別】', sum.byPart, 6);
    if (!ctx.skipProject) mk('【工事別(上位8)】', sum.byProject, 8);
    out.push('', '※「加工」列に日付が入った製品の重量(トン)の合計です。期間は会社の締め日(前月21日〜当月20日)が基準です。');
    return out.join('\n');
  }

  // ---------- 曖昧な質問: 答えずに選択肢(ボタン)を返す。ボタンを押すと、補った完全な1問として送られる(会話の記憶は使わない) ----------
  var C_PERIOD = /(\d{4}\/\d{1,2}\/\d{1,2}[〜~]\d{4}\/\d{1,2}\/\d{1,2}|\d{4}年度?|\d{1,2}月度?|\d{1,2}\/\d{1,2}|会計年度|会計|年度|暦年|暦月|月度|今年|去年|昨年|本年|前年|今月|先月|先々月|前月|当月|来月|今週|先週|来週|今日|昨日|明日|本日|最近|直近|先日|この前|これまで|今まで|全期間|累計|通算|今期|年間|今回|日|度|年|月|週)/g;
  var C_TOPIC = /(生産重量|加工重量|生産量|加工量|生産実績|生産|加工|重量|トン|有給休暇|有給|有休|年休|欠勤|遅刻|早退|遅早|休暇|休み|届け?|一覧|日報|工数|作業時間|時間|働いた|働|状況|確認|履歴|取得|取った|使った|残り|日数|回数)/g;
  var C_SELF = /(私|わたし|自分|僕|俺)/g;
  var C_FILTER = /(本社|夢前|鳥取|全社|全部位|大梁|小梁|柱|その他)/g;
  function escRe(x) { return String(x).replace(/[.*+?^${}()|[\]\\\/-]/g, '\\$&'); }
  function surnameOf(name) { var ps = nfkc(name).trim().split(/\s+/); return ps.length >= 2 ? ps[0] : ''; }
  function validNo(p) { return /^[0-9]{2}-[0-9]+[A-Za-z]?$/.test(String(p.no)); }
  // 質問から、期間・話題・人名・加工先などを取り除いた残り(空なら「話題だけ」の質問)
  function residueOf(q, roster) {
    var r = squash(q).replace(C_FILTER, '');
    roster.forEach(function (p) {
      var n = normName(p.name), sn = surnameOf(p.name);
      if (n.length >= 2) r = r.split(n).join('');
      if (sn) r = r.split(squash(sn)).join('');
    });
    return r.replace(C_PERIOD, '').replace(C_TOPIC, '').replace(C_SELF, '').replace(C_FILLER, '');
  }
  var RULE_MENU = [
    { re: /^(お休み|休み|休暇)$/, msg: 'どの休みについてですか?', qs: ['年次有給休暇は何日もらえますか', '特別休暇にはどんな種類がありますか', '慶弔休暇について教えてください', '育児・介護休業について教えてください'] },
    { re: /^退職金$/, msg: '退職金の何についてですか?', qs: ['退職金の支給条件を教えてください', '退職金の計算方法を教えてください', '再雇用になった場合の退職金はどうなりますか'] },
    { re: /^(育児|介護)$/, msg: '育児と介護のどちらについてですか?', qs: ['育児休業の条件を教えてください', '介護休業の条件を教えてください'] }
  ];
  function calMonth(today, phrase) { // 暦月(1日〜末日)
    var y = +today.slice(0, 4), m = +today.slice(5, 7), mm;
    if (/先々月/.test(phrase)) m -= 2; else if (/(先月|前月)/.test(phrase)) m -= 1;
    else if ((mm = /(\d{1,2})月/.exec(phrase))) { var n = +mm[1]; if (n > m) y--; m = n; }
    while (m < 1) { m += 12; y--; }
    return { from: ymd(y, m, 1), to: ymd(y, m, new Date(Date.UTC(y, m, 0)).getUTCDate()), label: y + '年' + m + '月' };
  }
  // get: {roster(), work(), prod()}。戻り値: null / {message, choices:[{label, q}]}
  function clarify(q, today, get) {
    var t = nfkc(q), sq = squash(q), mm, y = +today.slice(0, 4), m = +today.slice(5, 7), d = +today.slice(8, 10);
    function res(msg, choices) { return { message: msg, choices: choices.slice(0, 10) }; }
    var bare = sq.replace(C_FILLER, '');
    for (var i = 0; i < RULE_MENU.length; i++) {
      if (RULE_MENU[i].re.test(bare)) return res(RULE_MENU[i].msg, RULE_MENU[i].qs.map(function (x) { return { label: x, q: x }; }));
    }
    if (/(出荷|組立|溶接|切断|塗装|検査|製作完了|製品完成)/.test(t) && /(量|重量|トン)/.test(t) && !/加工/.test(t)) {
      var cm = parsePeriod('今月', today, 'month');
      return res('このアプリで答えられるのは、「加工」が完了した生産重量だけです。出荷・組立など、ほかの工程の重量は集計していません。', [{ label: '今月度の生産重量(加工完了)', q: cm.from + '〜' + cm.to + 'の生産重量' }]);
    }
    var roster = get.roster(), abs = parseAbsenceQuery(q, today, roster);
    var ABS_STRONG = /(有給|有休|年休|欠勤|遅刻|早退|遅早|届)/;
    var topic = abs ? 'abs' : WORK_TOPIC.test(t) ? 'work' : PROD_TOPIC.test(t) ? 'prod' : ABS_STRONG.test(t) ? 'abs?' : '';
    if (!topic) return null;
    var people = (topic === 'abs' || topic === 'work') ? findPeople(q, roster) : [];
    // 人: 姓だけで複数に当たる
    if (people.length > 1 && !people.some(function (p) { return sq.indexOf(normName(p.name)) >= 0; })) {
      var sn = surnameOf(people[0].name), re = new RegExp(escRe(squash(sn)) + '(?=さん|くん|君|の|は|が|を|に)');
      return res('「' + sn + '」さんが複数います。どなたですか?', people.slice(0, 10).map(function (p) {
        var q2 = sq.replace(re, normName(p.name)); if (q2 === sq) q2 = normName(p.name) + 'の' + sq;
        return { label: p.name + '(社員No' + p.no + ')', q: q2 };
      }));
    }
    var self = /(私|わたし|自分|僕|俺)/.test(t);
    // 人: 誰の質問か書かれていない(「有給は?」「工数は?」)
    if (!people.length && !self && (topic === 'abs?' || topic === 'work') && residueOf(q, roster) === '') {
      var core = sq.replace(/[はが]?[?？]*$/, '');
      if (topic === 'abs?') return res('誰の有給・欠勤ですか?「私」を押すか、氏名を入れて質問し直してください。', [{ label: '私(自分)', q: '私の' + core + '状況' }]);
      if (!findProjects(q, get.work()).length) return res('誰の・どの工事の工数ですか?「私」を押すか、氏名または工事名を入れて質問し直してください。' + (/(本社|夢前|鳥取|全社)/.test(t) ? '\n※日報には拠点の区分が無いため、拠点別・全社の工数は集計できません。' : ''), [{ label: '私(自分)', q: '私の' + core }]);
    }
    // 工事: 複数に当たる / 一部だけ書かれている
    if (topic === 'work' || topic === 'prod') {
      var projs = topic === 'work' ? get.work() : get.prod(), hits = findProjects(q, projs);
      function plabel(p) { return (p.no ? p.no + ' ' : '') + p.name; }
      if (hits.length > 1) {
        return res('該当する工事が複数あります。どれですか?', hits.slice(0, 10).map(function (p) {
          return { label: plabel(p), q: sq.replace(squash(p.name), validNo(p) ? p.no : p.name) };
        }));
      }
      if (!hits.length) {
        var rs = residueOf(q, roster).toLowerCase();
        if (rs.length >= 3) {
          var seen = {}, cand = projs.filter(function (p) {
            var k = p.no + '|' + p.name; if (seen[k] || GENERIC_PROJECT.indexOf(squash(p.name)) >= 0) return false; seen[k] = 1;
            return squash(p.name).toLowerCase().indexOf(rs) >= 0;
          });
          if (cand.length) return res('工事は、どれのことですか?', cand.slice(0, 10).map(function (p) { return { label: plabel(p), q: sq + (validNo(p) ? p.no : p.name) }; }));
        }
      }
    }
    // 期間
    if (parseDay(q, today) || /\d{4}\/\d{1,2}\/\d{1,2}[〜~]/.test(t)) return null;
    function span(label, from, to) { return { label: label + '(' + from + '〜' + to + ')', from: from, to: to }; }
    function make(phrase, opts) {
      return res('期間は、どちらですか?', opts.map(function (o) { return { label: o.label, q: t.replace(phrase, o.from + '〜' + o.to) }; }));
    }
    if ((mm = /(今年|本年|去年|昨年|前年)(?!度)/.exec(t)) && !/暦年|会計/.test(t)) {
      var off = /^(去年|昨年|前年)$/.test(mm[1]) ? -1 : 0, yy = y + off, ys = ((m > 11 || (m === 11 && d >= 21)) ? y : y - 1) + off, s0 = (m >= 4 ? y : y - 1) + off;
      var cal = span('暦年 ' + yy + '年', ymd(yy, 1, 1), ymd(yy, 12, 31));
      return make(mm[0], [cal, topic === 'work' || topic === 'prod'
        ? span('会計年度', ymd(ys, 11, 21), ymd(ys + 1, 11, 20)) : span('年度(4月〜3月)', ymd(s0, 4, 1), ymd(s0 + 1, 3, 31))]);
    }
    if (topic === 'work' && (mm = /(今年度|本年度|今期|昨年度|去年度|前年度)/.exec(t)) && !/会計/.test(t)) {
      var off2 = /(昨|去|前)/.test(mm[1]) ? -1 : 0, ys2 = ((m > 11 || (m === 11 && d >= 21)) ? y : y - 1) + off2, s2 = (m >= 4 ? y : y - 1) + off2;
      return make(mm[0], [span('会計年度', ymd(ys2, 11, 21), ymd(ys2 + 1, 11, 20)), span('年度(4月〜3月)', ymd(s2, 4, 1), ymd(s2 + 1, 3, 31))]);
    }
    if (!/月度|暦月/.test(t) && ((mm = /(先々月|先月|前月|今月|当月)(?!度)/.exec(t)) || (mm = /(\d{1,2})月(?![曜度日\d])/.exec(t)))) {
      var md = parsePeriod(mm[0], today, 'month'), cmo = calMonth(today, mm[0]);
      return make(mm[0], [span('月度(前月21日〜当月20日)', md.from, md.to), span('暦月 ' + cmo.label, cmo.from, cmo.to)]);
    }
    if ((mm = /(今週|先週)/.exec(t))) {
      var back = mm[1] === '先週' ? 7 : 0, mon = addDays(today, -((dow(today) + 6) % 7) - back), sun = addDays(today, -dow(today) - back);
      return make(mm[0], [span('月曜始まり', mon, addDays(mon, 6)), span('日曜始まり', sun, addDays(sun, 6))]);
    }
    if ((mm = /(最近|この前|先日|直近)/.exec(t))) {
      return make(mm[0], [span('直近1か月', addDays(today, -30), today), span('直近3か月', addDays(today, -90), today), span('直近1年', addDays(today, -365), today)]);
    }
    return null;
  }
  // 生産重量の回答の下に出す、加工先・部位の切り替えボタン。f: {sites, parts, period, project}
  function prodChoices(f) {
    var base = f.period.from + '〜' + f.period.to + 'の' + (f.project ? f.project.name + 'の' : ''), out = [];
    function mk(sites, parts) {
      return base + (sites.length ? sites.join('・') + 'の' : '') + (parts.length ? parts.map(function (x) { return x === '他' ? 'その他' : x; }).join('・') + 'の' : '') + '生産重量';
    }
    var fs = f.sites || [], fp = f.parts || [];
    if (fs.length) out.push({ group: '加工先', label: '全社', q: mk([], fp) });
    SITES.forEach(function (s) { if (fs.indexOf(s) < 0) out.push({ group: '加工先', label: s, q: mk([s], fp) }); });
    if (fp.length) out.push({ group: '部位', label: '全部位', q: mk(fs, []) });
    ['大梁', '小梁', '柱', '他'].forEach(function (x) { if (fp.indexOf(x) < 0) out.push({ group: '部位', label: x, q: mk(fs, [x]) }); });
    return out;
  }

  return { nfkc: nfkc, squash: squash, parseRules: parseRules, chunkLabel: chunkLabel, searchRules: searchRules,
           buildPrompt: buildPrompt, pickSources: pickSources, parseModelJson: parseModelJson, mergeRoster: mergeRoster, readRoster: readRoster,
           normEmail: normEmail, fixEmail: fixEmail, normName: normName,
           ABS_HEADER: ABS_HEADER, normDate: normDate, mergeAbsence: mergeAbsence, parsePeriod: parsePeriod, findPeople: findPeople,
           parseAbsenceQuery: parseAbsenceQuery, daysInPeriod: daysInPeriod, summarizeAbsence: summarizeAbsence, formatAbsenceAnswer: formatAbsenceAnswer,
           WORK_HEADER: WORK_HEADER, buildConsMap: buildConsMap, workFromB2: workFromB2, workFromB5: workFromB5, sortWork: sortWork, findProjects: findProjects,
           PROD_HEADER: PROD_HEADER, countWorkDays: countWorkDays, parseMasterRows: parseMasterRows, parseProdQuery: parseProdQuery, summarizeProd: summarizeProd, formatProdAnswer: formatProdAnswer,
           clarify: clarify, prodChoices: prodChoices, parseCalendarQuery: parseCalendarQuery, answerCalendar: answerCalendar, parseDay: parseDay, parseWorkQuery: parseWorkQuery, summarizeWork: summarizeWork, formatWorkAnswer: formatWorkAnswer };
})();
