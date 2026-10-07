/* コストインサイト「AIに質問」。実行予算・工数・生産重量を、全体/工場別/工事別/年度別/締め月別 で答える。
 * 流れ: ①ブラウザ内で質問を読み取れたら即集計 → ②読み取れなければGeminiに「意図だけ」聞く(Vercel中継api/ask→失敗時GAS直接)
 *       → ③それも失敗したら聞き方の例を返す。予算・工数・重量・工事名の実データはGeminiに送らない(集計は常にこのブラウザ内)。
 * 集計は calc.js の model(state.model)をそのまま使うため、画面(進捗・結果確認)の数字と一致する。
 * 要素・CSSは cw- 接頭辞で隔離。ブラウザ(window.CIChat)とNodeの両方から読み込める(テスト用: CIChat.answer)。 */
(function (root) {
  'use strict';

  var SITES = ['本社', '夢前', '鳥取'];
  var EXAMPLES = '例:\n・夢前の今期の生産重量は?\n・R8年度の工場別の工数を教えて\n・堂島浜二丁目の実行予算は?\n・9月締めの工事別の生産重量\n・全体の締め月別の工数';

  function pad2(n) { return (n < 10 ? '0' : '') + n; }
  function ymdOf(d) { return d.getFullYear() + '-' + pad2(d.getMonth() + 1) + '-' + pad2(d.getDate()); }
  function z2h(s) { return String(s || '').replace(/[０-９]/g, function (c) { return String.fromCharCode(c.charCodeAt(0) - 0xFEE0); }); }
  function norm(s) { return String(s || '').replace(/[\s　]/g, '').toLowerCase(); }
  function fmtN(v, d) { return Number(v || 0).toLocaleString('ja-JP', { minimumFractionDigits: d || 0, maximumFractionDigits: d || 0 }); }
  function man(v) { return fmtN(v / 1e4) + '万円'; }

  /* ===================== 質問の読み取り(AIなし) ===================== */

  /* 戻り値 intent = { metric, groupBy, site, work(質問に書かれた工事の語), fy(期の開始年), closing('yyyy-MM'), explicit:{...} } */
  function parseLocal(q0, ctx) {
    var C = ctx.C, q = z2h(q0), today = ctx.today, m;
    var it = { metric: '', groupBy: '', site: '', work: '', fy: null, closing: '', raw: q0 };
    if ((m = q.match(/本社|夢前|鳥取/))) it.site = m[0];
    // 指標
    var hasW = /重量|トン|生産量|生産実績|\bt\b|[0-9]t/.test(q), hasH = /工数|時間|人工|稼働/.test(q),
      hasB = /予算|仕入|労務|契約|金額|売上|損益|利益|原価|単価|コスト/.test(q);
    if (hasB) it.metric = 'budget';
    else if (hasW && hasH) it.metric = 'all';
    else if (hasW) it.metric = 'weight';
    else if (hasH) it.metric = 'hours';
    if (hasB && (hasW || hasH)) it.metric = 'all';
    // 内訳の切り口
    if (/工場(別|ごと|毎)|拠点(別|ごと)/.test(q)) it.groupBy = 'factory';
    else if (/工事(別|ごと|毎)|物件(別|ごと)/.test(q)) it.groupBy = 'work';
    else if (/年度(別|ごと|毎)|期(別|ごと)/.test(q)) it.groupBy = 'year';
    else if (/(月|月度|締め月|〆月|締め)(別|ごと|毎)|月次|毎月/.test(q)) it.groupBy = 'month';
    // 期(年度): 2026年度=2025/11/21〜2026/11/20(R8)。今期=今日を含む年度
    var cur = C.fiscalYearOf(C.periodKeyOf(ymdOf(today)));
    if ((m = q.match(/(\d{4})\s*年度/))) it.fy = Number(m[1]) - 1;
    else if ((m = q.match(/(?:R|Ｒ|令和)\s*(\d{1,2})(?!\d)\s*年度?/i))) it.fy = 2018 + Number(m[1]) - 1;
    else if (/今期|今年度|当期|本年度/.test(q)) it.fy = cur;
    else if (/前期|昨年度|前年度|去年度/.test(q)) it.fy = cur - 1;
    // 締め月(20日締め)。年の指定が無い「N月」は期間の始まりが今日以前で最も近い年
    if (/先月|前月/.test(q)) it.closing = C.shiftPeriod(C.periodKeyOf(ymdOf(today)), -1);
    else if (/今月|当月/.test(q)) it.closing = C.periodKeyOf(ymdOf(today));
    else if ((m = q.match(/(?:(\d{4})年)?(\d{1,2})月(度|締め?|〆|分)?(?![\d日])/)) && Number(m[2]) >= 1 && Number(m[2]) <= 12 && (it.fy === null || m[3])) {
      var y = m[1] ? Number(m[1]) : today.getFullYear(), mo = Number(m[2]);
      if (!m[1] && C.periodRange(y + '-' + pad2(mo)).from > ymdOf(today)) y--;
      it.closing = y + '-' + pad2(mo);
    }
    // 工事: 質問文に含まれる工事名・工事番号(最長一致)。無ければ「○○の」の語を後でAI/部分一致で探す
    var best = '', qn = norm(q);
    Object.keys(ctx.model.works).forEach(function (no) {
      var w = ctx.model.works[no], nm = norm(w.name);
      if (nm.length >= 2 && qn.indexOf(nm) >= 0 && nm.length > best.length) best = w.name;
      if (qn.indexOf(norm(no)) >= 0 && no.length >= 4 && no.length > best.length) best = no;
    });
    if (!best) { // 工事名の一部(例: 「KIX01の生産重量」)。助詞・空白で区切った語のうち、工事に1件以上当たる語を使う
      q.split(/[のはをがでとも、,\s?？]+/).forEach(function (t) {
        if (!best && t.length >= 3 && !/重量|工数|予算|年度|工場|全体|合計|生産|金額|仕入|労務|契約|売上|損益|利益|締め/.test(t) && findWorks(ctx.model, t).length) best = t;
      });
    }
    it.work = best;
    return it;
  }

  /* AI(Gemini)が返したJSONを intent に直す。足りない項目はローカルの読み取りで補う */
  function fromAI(j, loc, ctx) {
    var C = ctx.C, it = {
      metric: /^(weight|hours|budget|all)$/.test(j.metric) ? j.metric : loc.metric,
      groupBy: /^(factory|work|year|month)$/.test(j.groupBy) ? j.groupBy : (j.groupBy === 'none' ? '' : loc.groupBy),
      site: SITES.indexOf(j.factory) >= 0 ? j.factory : loc.site,
      work: j.construction ? String(j.construction) : loc.work, fy: loc.fy, closing: loc.closing, raw: loc.raw,
    };
    var m, fy = String(j.fiscalYear || '');
    if ((m = /^R(\d+)$/i.exec(fy))) it.fy = 2018 + Number(m[1]) - 1;
    else if ((m = /^(\d{4})$/.exec(fy))) it.fy = Number(m[1]) - 1;
    if (/^\d{4}-\d{2}$/.test(j.closing || '')) it.closing = j.closing;
    return it;
  }

  /* ===================== 集計(calc.jsのmodelをそのまま使う) ===================== */

  function findWorks(model, word) {
    var wn = norm(word), out = [];
    if (!wn) return out;
    Object.keys(model.works).forEach(function (no) {
      var nm = norm(model.works[no].name);
      if (norm(no) === wn || (nm && (nm.indexOf(wn) >= 0 || (nm.length >= 3 && wn.indexOf(nm) >= 0)))) out.push(no);
    });
    return out;
  }

  function fyLabel(fy) { return (fy + 1) + '年度(R' + (fy + 1 - 2018) + ')'; }

  /* 質問(intent)を集計して、文章(複数行)を返す。ctx = { C: CICalc, model, today: Date } */
  function answer(it, ctx) {
    var C = ctx.C, model = ctx.model, lines = [], cond = [];
    var opt = {};
    if (it.site) { opt.sites = [it.site]; cond.push(it.site); }
    if (it.work) {
      var nos = findWorks(model, it.work);
      if (!nos.length) return '「' + it.work + '」に当てはまる工事が見つかりません。工事名(の一部)か工事番号で聞いてください。\n' + EXAMPLES;
      opt.works = {}; nos.forEach(function (n) { opt.works[n] = true; });
      cond.push(nos.length === 1 ? model.works[nos[0]].name + '(' + nos[0] + ')' : '工事「' + it.work + '」に一致する' + nos.length + '件');
    }
    var from = '', to = '';
    if (it.closing) { var r = C.periodRange(it.closing); from = r.from; to = r.to; cond.push(C.periodLabel(it.closing) + '(' + from.replace(/-/g, '/') + '〜' + to.replace(/-/g, '/') + ')'); }
    else if (it.fy !== null) { var fr = C.fiscalRange(it.fy); from = fr.from; to = fr.to; cond.push(fyLabel(it.fy) + '(' + from.replace(/-/g, '/') + '〜' + to.replace(/-/g, '/') + ')'); }
    if (from) { opt.from = from; opt.to = to; }
    var metric = it.metric || 'all';
    var head = (cond.length ? cond.join('・') : '全体(全期間・全工場)');

    var cells = C.filterCells(model, opt);
    if (!cells.length && metric !== 'budget') return head + ' の生産重量・工数のデータはありません。';

    // 工事ごとの実行予算(絞り込みが工事・年度タグだけのとき)。工場・期間で絞ったときはセルの按分(下)で答える
    var timeFiltered = !!(from || it.site);
    if (metric === 'budget' && !timeFiltered) return head + '\n' + budgetByWork(model, opt.works, it);

    var key = null, keyLabel = '';
    if (it.groupBy === 'factory') { key = function (c) { return c.site; }; keyLabel = '工場別'; }
    else if (it.groupBy === 'work') { key = function (c) { var w = model.works[c.no]; return c.no + ' ' + (w.name || ''); }; keyLabel = '工事別'; }
    else if (it.groupBy === 'year') { key = function (c) { return C.fiscalYearOf(c.period); }; keyLabel = '年度別'; }
    else if (it.groupBy === 'month') { key = function (c) { return c.period; }; keyLabel = '締め月別'; }

    function row(label, t) {
      var p = [];
      if (metric === 'weight' || metric === 'all') p.push('生産重量 ' + fmtN(t.weight, 1) + ' t');
      if (metric === 'hours' || metric === 'all') p.push('工数 ' + fmtN(t.hours) + ' h');
      if (metric === 'budget' || metric === 'all') {
        p.push('売上 ' + man(t.sales) + ' / 仕入 ' + man(t.purchase) + ' / 労務費 ' + man(t.labor) + ' / 損益 ' + man(t.profit) + (t.ngWeight > 0 ? '(単価不明分除く)' : ''));
      }
      return (label ? '・' + label + ': ' : '') + p.join(' / ');
    }
    lines.push(head + (keyLabel ? ' の' + keyLabel + '内訳' : ''));
    if (key) {
      var g = {};
      cells.forEach(function (c) { var k = key(c); (g[k] || (g[k] = [])).push(c); });
      Object.keys(g).forEach(function (k) { // 見たい指標が0のグループ(まだ生産していない工事・データ前の月度等)は出さない
        var t = C.summarize(g[k]);
        if ((metric === 'weight' && !(t.weight > 0)) || (metric === 'hours' && !(t.hours > 0)) || (metric === 'all' && !(t.weight > 0) && !(t.hours > 0))) delete g[k];
      });
      var keys = Object.keys(g).sort(function (a, b) { return it.groupBy === 'month' || it.groupBy === 'year' ? (a < b ? -1 : 1) : (a < b ? -1 : 1); });
      keys.forEach(function (k) { lines.push(row(it.groupBy === 'year' ? fyLabel(Number(k)) : it.groupBy === 'month' ? C.periodLabel(k) : k, C.summarize(g[k]))); });
      lines.push('─────');
      lines.push(row('合計', C.summarize(cells)));
    } else lines.push(row('', C.summarize(cells)));
    if (metric === 'budget' || metric === 'all') lines.push('※金額は工事ごとの実行予算の単価を生産重量・工数で按分した値(未完工事の仕入・労務費は見込みを含む)。工事ごとの実行予算そのものは「○○の実行予算」で聞けます。');
    lines.push((metric !== 'weight' ? '※工数は共通工数を按分した値。' : '※') + '月度は21日〜翌20日締め、年度は11/21〜翌11/20。');
    return lines.join('\n');
  }

  /* 工事ごとの実行予算(契約金額・仕入・労務費)。年度は工事に付けた年度タグ(R7・R8…)で絞る */
  function budgetByWork(model, worksSet, it) {
    var list = Object.keys(model.works).filter(function (no) { return !worksSet || worksSet[no]; });
    var out = [], tot = { contract: 0, purchase: 0, labor: 0 };
    list.sort().forEach(function (no) {
      var w = model.works[no];
      if (!w.hasBudget) { out.push('・' + no + ' ' + w.name + ': 実行予算のデータなし'); return; }
      var labor = w.laborActual || 0;
      out.push('・' + no + ' ' + w.name + (w.year ? '(' + w.year + ')' : '') + (w.done ? '[完了]' : '[進行中]') + ': 契約金額 ' + (w.contract === null ? '—' : man(w.contract)) +
        ' / 仕入 ' + man(w.purchase) + (w.purchaseEst ? '(見込)' : '') + ' / 労務費(実際) ' + man(labor) + ' / 仕入予算 ' + man(w.purchaseBudget));
      tot.contract += w.contract || 0; tot.purchase += w.purchase || 0; tot.labor += labor;
    });
    if (!out.length) return '該当する工事がありません。';
    if (list.length > 1) out.push('─────\n合計(' + list.length + '件): 契約金額 ' + man(tot.contract) + ' / 仕入 ' + man(tot.purchase) + ' / 労務費(実際) ' + man(tot.labor));
    return out.join('\n');
  }

  var api = { parseLocal: parseLocal, fromAI: fromAI, answer: answer, findWorks: findWorks, EXAMPLES: EXAMPLES };
  if (typeof module !== 'undefined' && module.exports) { module.exports = api; return; }
  root.CIChat = api;

  /* ===================== 画面(右下の「AIに質問」ボタン+LINE風の窓) ===================== */
  if (typeof document === 'undefined') return;
  var busy = false;
  var css = '.cw-fab{position:fixed;right:16px;bottom:16px;z-index:99998;padding:10px 16px;border:0;border-radius:24px;background:#06c755;color:#fff;font-size:15px;font-weight:bold;cursor:pointer;box-shadow:0 2px 8px #0004}.cw-fab:hover{background:#05b04b}' +
    '.cw-box{position:fixed;left:50%;top:50%;transform:translate(-50%,-50%);z-index:99999;width:min(640px,calc(100vw - 32px));height:min(640px,calc(100vh - 64px));background:#8cabd9;color:#111;border-radius:14px;overflow:hidden;box-shadow:0 8px 32px #0006;display:none;flex-direction:column;font:14px/1.5 "Hiragino Sans","Meiryo",sans-serif}' +
    '.cw-box.cw-open{display:flex}' +
    '.cw-head{padding:12px 14px;background:#273246;color:#fff;font-weight:bold;display:flex;justify-content:space-between;align-items:center}.cw-head span{cursor:pointer;font-weight:normal;font-size:13px;opacity:.85}' +
    '.cw-log{flex:1 1 auto;min-height:60px;overflow:auto;padding:12px 10px;display:flex;flex-direction:column;gap:10px}' +
    '.cw-row{display:flex;align-items:flex-end;gap:6px;max-width:100%}.cw-row-u{align-self:flex-end;flex-direction:row-reverse}.cw-row-b{align-self:flex-start;align-items:flex-start}' +
    '.cw-av{flex:0 0 36px;width:36px;height:36px;border-radius:50%;background:#fff;display:flex;align-items:center;justify-content:center;font-size:20px;box-shadow:0 1px 2px #0002}' +
    '.cw-col{display:flex;flex-direction:column;min-width:0;max-width:calc(100% - 42px)}.cw-name{font-size:11px;color:#fff;margin:0 0 3px 4px}' +
    '.cw-line{display:flex;align-items:flex-end;gap:5px;min-width:0}.cw-row-u .cw-line{flex-direction:row-reverse}' +
    '.cw-meta{font-size:10px;color:#fff;line-height:1.3;white-space:nowrap;flex:0 0 auto;text-align:right}.cw-row-b .cw-meta{text-align:left}' +
    '.cw-m{position:relative;font-size:15px;max-width:34em;width:fit-content;min-width:0;padding:8px 12px;border-radius:18px;white-space:pre-wrap;word-break:break-word;overflow-x:auto}' +
    '.cw-u{background:#8de055;color:#111}.cw-b{background:#fff;color:#111}' +
    '.cw-u::after{content:"";position:absolute;right:-6px;top:8px;border:7px solid transparent;border-left:10px solid #8de055;border-right:0}' +
    '.cw-b::before{content:"";position:absolute;left:-6px;top:8px;border:7px solid transparent;border-right:10px solid #fff;border-left:0}' +
    '.cw-form{display:flex;gap:8px;align-items:center;padding:8px 10px;background:#fff;border-top:1px solid #e3e3e3}' +
    '.cw-form input{flex:1;min-width:0;padding:9px 14px;border:0;border-radius:20px;background:#f2f3f5;font-size:16px;outline:none}' +
    '.cw-form button{flex:0 0 auto;width:40px;height:40px;border:0;border-radius:50%;background:#06c755;color:#fff;font-size:18px;cursor:pointer}.cw-form button:disabled{background:#b8e6c9}';
  var st = document.createElement('style'); st.textContent = css; document.head.appendChild(st);

  function el(t, c, txt) { var e = document.createElement(t); if (c) e.className = c; if (txt) e.textContent = txt; return e; }
  function hhmm() { var d = new Date(); return d.getHours() + ':' + pad2(d.getMinutes()); }
  var box = el('div', 'cw-box'), head = el('div', 'cw-head'), log = el('div', 'cw-log'), form = el('form', 'cw-form');
  head.appendChild(el('div', '', 'AI_masamiz(コストインサイト)')); var x = el('span', '', '✕ 閉じる'); head.appendChild(x);
  var inp = el('input'); inp.placeholder = '例: 夢前のR8年度の工数は?'; inp.maxLength = 300;
  var send = el('button', '', '➤'); send.type = 'submit'; send.title = '送信'; form.appendChild(inp); form.appendChild(send);
  box.appendChild(head); box.appendChild(log); box.appendChild(form); document.body.appendChild(box);
  var fab = el('button', 'cw-fab', '💬 AIに質問'); fab.type = 'button'; fab.setAttribute('data-cw-open', '1'); document.body.appendChild(fab);

  function say(text, who) {
    var u = who === 'u', row = el('div', 'cw-row ' + (u ? 'cw-row-u' : 'cw-row-b')), m = el('div', 'cw-m ' + (u ? 'cw-u' : 'cw-b'), text);
    var meta = el('div', 'cw-meta'); if (u) meta.appendChild(el('div', '', '既読')); meta.appendChild(el('div', '', hhmm()));
    var line = el('div', 'cw-line'); line.appendChild(m); line.appendChild(meta);
    if (u) row.appendChild(line);
    else { row.appendChild(el('div', 'cw-av', '🤖')); var col = el('div', 'cw-col'); col.appendChild(el('div', 'cw-name', 'AI_masamiz')); col.appendChild(line); row.appendChild(col); }
    log.appendChild(row); log.scrollTop = log.scrollHeight; return m;
  }
  function open() {
    box.classList.add('cw-open');
    if (!log.children.length) say('こんにちは。実行予算・工数・生産重量を、全体・工場別・工事別・年度別・締め月別で質問してください。\n' + EXAMPLES, 'b');
    inp.focus();
  }
  function close() { box.classList.remove('cw-open'); }
  window.cwOpen = open; fab.onclick = open; x.onclick = close;
  document.addEventListener('keydown', function (e) { if (e.key === 'Escape') close(); });

  function G(n) { try { return (0, eval)(n); } catch (e) { return undefined; } } // app.jsのグローバルconst参照
  function ctxNow() {
    var s = G('state'); if (!s || !s.model) return null;
    return { C: root.CICalc, model: s.model, today: new Date() };
  }
  function askVia(url, payload, gas) {
    return fetch(url, { method: 'POST', headers: { 'Content-Type': gas ? 'text/plain;charset=utf-8' : 'application/json' }, body: JSON.stringify(payload) })
      .then(function (r) { return r.json(); })
      .then(function (j) { if (j.status !== 'success') throw new Error(j.message || 'error'); return j.data.answer; });
  }
  function ask(q) {
    var d = new Date(), payload = { action: 'askAI', params: { question: q, today: ymdOf(d).replace(/-/g, '/') + '(' + '日月火水木金土'.charAt(d.getDay()) + ')' } };
    var gasUrl = G('GAS_API_URL');
    return askVia('api/ask', payload, false).catch(function (e) { if (!gasUrl) throw e; return askVia(gasUrl, payload, true); });
  }
  form.onsubmit = function (e) {
    e.preventDefault(); var q = inp.value.trim(); if (!q || busy) return; inp.value = ''; say(q, 'u');
    var ctx = ctxNow();
    if (!ctx) { say('データを読み込み中です。読み込みが終わってからもう一度質問してください。', 'b'); return; }
    var loc = parseLocal(q, ctx);
    // 指標が読み取れていて、「どの切り口か」も(全体指定でなく)分かる/不要なら、AIを使わずに即答
    var simple = loc.metric && (loc.groupBy || loc.site || loc.work || loc.fy !== null || loc.closing || /全体|全部|合計|総/.test(q));
    if (simple) { say(answer(loc, ctx), 'b'); return; }
    busy = true; var w = say('考え中…', 'b');
    ask(q).then(function (a) {
      var j = {}; try { j = JSON.parse(a); } catch (x) { }
      if (j.intent === 'data' || j.metric) { w.textContent = answer(fromAI(j, loc, ctx), ctx); }
      else w.textContent = loc.metric ? answer(loc, ctx) : 'すみません、質問の内容を読み取れませんでした。実行予算・工数・生産重量についての質問をお願いします。\n' + EXAMPLES;
    }, function () {
      w.textContent = loc.metric ? answer(loc, ctx) : 'すみません、AIに接続できず、質問の内容を読み取れませんでした。\n' + EXAMPLES;
    }).then(function () { busy = false; log.scrollTop = log.scrollHeight; });
  };
})(typeof self !== 'undefined' ? self : this);
