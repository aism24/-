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
      '出力はJSONのみ: {"answerable": true|false, "answer": "回答文", "cited": ["C1","C2"]}',
      '',
      '【条文】', ctx,
      '',
      '【質問】', String(question).slice(0, 300)
    ].join('\n');
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

  return { nfkc: nfkc, squash: squash, parseRules: parseRules, chunkLabel: chunkLabel, searchRules: searchRules,
           buildPrompt: buildPrompt, parseModelJson: parseModelJson, mergeRoster: mergeRoster, readRoster: readRoster,
           normEmail: normEmail, fixEmail: fixEmail };
})();
