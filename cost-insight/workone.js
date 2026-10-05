/*
 * 工事別結果分析 = 工事別の目標シミュレーター
 *   実行予算にある工事をリストから選び、その工事の「目標値」と「現状」を、詳細版(detail.js)と同じ表示で出す。
 *   売上=契約金額(生産重量×トン単価) / 変動費=仕入(未完は予算、完了は実績) / 人件費=工数×時間単価(労務費)。
 *   その他固定費は工事には配分しない(会社・工場単位のため)。目標利益率は基本設定の値。
 *   入力欄の初期値: 生産重量=契約総重量、1t当たり人工数=これまでの実績(工数÷8÷生産重量)、トン単価=契約金額÷契約総重量。
 */
(function () {
  'use strict';
  const C = CICalc, K = CIKit;
  const $ = (id) => document.getElementById(id);
  const D = { inited: false, no: '', ctx: null, base: null, exact: {}, hours: 0 };
  const DIG = { w: 1, n: 2, p: 0 };
  const simFmt = (k, v) => fmt(v, DIG[k]);
  const parseNumIn = (text) => {
    const s = String(text === null || text === undefined ? '' : text)
      .replace(/[０-９．，－]/g, (c) => ({ '．': '.', '，': ',', '－': '-' }[c] || String.fromCharCode(c.charCodeAt(0) - 0xFEE0))).replace(/[,\s円t]/g, '');
    const v = parseFloat(s);
    return isFinite(v) ? v : 0;
  };
  const simValue = (k) => { const v = $('w-' + k).value, ex = D.exact[k]; return ex && ex.shown === v ? ex.value : parseNumIn(v); };

  // 実行予算にある工事(工事No順)
  function budgetWorks() {
    const b = state.data.budget, rows = (b && b.rows) || {}, set = {};
    Object.keys(rows).forEach((k) => {
      const no = String(rows[k].no || rows[k].fileNo || '').trim();
      if (no && rows[k].matchedBy !== '一覧に未登録' && state.model.works[no]) set[no] = true;
    });
    return Object.keys(set).sort((a, b) => a.localeCompare(b, 'ja', { numeric: true }));
  }

  // 選んだ工事の計算の前提(単価・時間単価・実績)
  function context(no) {
    const w = state.model.works[no], g = K.goalRate() / 100;
    const all = C.summarize(state.model.cells);
    const own = w.hourRate !== null && w.hourRate !== undefined;
    const L = (own ? w.hourRate : all.hourRate || 0) * 8; // 1人工(8h)当たりの労務費
    const W0 = w.unitWeight > 0 ? w.unitWeight : w.weight; // 完了は生産実績の累計、未完は契約総重量
    return { w, no, g, L, ownRate: own, W0, P: w.procUnit || 0, v: w.purchaseUnit || 0,
      nNow: w.weight > 0 ? w.hours / 8 / w.weight : 0 };
  }

  function simulate(x, W, n, P) {
    const sales = W * P, ninku = W * n, labor = ninku * x.L, variable = W * x.v, profit = sales - labor - variable, goal = sales * x.g;
    const room = sales * (1 - x.g) - variable; // 人件費に使える上限(目標利益率を確保した場合)
    return { weight: W, n, unitPrice: P, sales, ninku, hours: ninku * 8, labor, variable, profit, rate: sales > 0 ? profit / sales : null, goal,
      nMax: W > 0 && x.L > 0 ? room / (W * x.L) : null, nBe: W > 0 && x.L > 0 ? (sales - variable) / (W * x.L) : null,
      vMax: W > 0 ? (sales * (1 - x.g) - labor) / W : null };
  }

  function init() {
    $('w-pick').onchange = () => select($('w-pick').value);
    const step = (d) => { const s = $('w-pick'), i = s.selectedIndex + d; if (i >= 0 && i < s.options.length) { s.selectedIndex = i; select(s.value); } };
    $('w-prev').onclick = () => step(-1);
    $('w-next').onclick = () => step(1);
    Object.keys(DIG).forEach((k) => {
      const el = $('w-' + k);
      el.oninput = () => onInput(k);
      el.onchange = () => {
        const v = parseNumIn(el.value), ex = D.exact[k];
        if (ex && Math.abs(v - parseNumIn(ex.shown)) < 1e-9) { el.value = ex.shown; return; }
        el.value = simFmt(k, v);
        onInput(k);
      };
    });
    $('w-reset').onclick = () => select(D.no);
    D.inited = true;
  }

  function show() {
    if (!state.model) return;
    if (!D.inited) init();
    const list = budgetWorks(), sel = $('w-pick');
    sel.innerHTML = list.map((no) => `<option value="${esc(no)}">${esc(no)} ${esc(state.model.works[no].name)}</option>`).join('');
    if (!list.length) { D.no = ''; D.ctx = null; $('w-kpis').innerHTML = ''; $('w-advice').innerHTML = ''; $('w-status').innerHTML = '<p class="note">実行予算に取り込まれた工事がありません</p>'; return; }
    select(list.indexOf(D.no) >= 0 ? D.no : list[0]);
  }

  // 工事を選び直す(入力欄は実績の値に戻す)
  function select(no) {
    D.no = no;
    $('w-pick').value = no;
    const i = $('w-pick').selectedIndex;
    $('w-prev').disabled = i <= 0;
    $('w-next').disabled = i >= $('w-pick').options.length - 1;
    const x = D.ctx = context(no);
    D.base = { w: x.W0, n: x.nNow, p: x.P };
    D.hours = x.W0 * x.nNow * 8;
    D.exact = {};
    ['w', 'n', 'p'].forEach((k) => {
      const el = $('w-' + k);
      el.value = simFmt(k, D.base[k]);
      D.exact[k] = { shown: el.value, value: D.base[k] };
    });
    const w = x.w;
    $('w-basis').innerHTML = esc(w.no + ' ' + w.name) + '(' + (w.done ? '完了' : '未完') + ' / ' + esc(w.year || '年度未設定') + ')。生産重量=' + (w.unitByActual ? '生産実績の累計(完了のため)' : '契約総重量') + '、1t当たり人工数=これまでの実績、トン単価=契約金額÷' + (w.unitByActual ? '生産重量' : '契約総重量') + '。' +
      (x.ownRate ? '' : '時間単価は工事の値がないため全体の平均を使用。') + 'その他固定費は工事には配分していません。';
    update();
  }

  // 総工数(=必要人工)は生産重量を変えても変わらない人員体制として固定し、生産重量を増やすと1t当たり人工数が減る
  function onInput(k) {
    if (k === 'w') {
      const W = simValue('w');
      if (W > 0 && D.hours > 0) { const n = D.hours / 8 / W, el = $('w-n'); el.value = simFmt('n', n); D.exact.n = { shown: el.value, value: n }; }
    } else if (k === 'n') D.hours = simValue('w') * simValue('n') * 8;
    update();
  }

  const simNote = (note) => String(note || '').replace(/(^|>)([^<]*)/g, (m, a, txt) => a + txt.replace(/[+\-]?\d[\d,]*(\.\d+)?%?/g, '<span class="nv">$&</span>'));

  function update() {
    const x = D.ctx;
    if (!x) return;
    const W = simValue('w'), n = simValue('n'), P = simValue('p'), b = D.base, g = K.goalRate();
    const r = simulate(x, W, n, P);
    $('w-s').value = fmt(r.sales, 0);
    const changed = Math.abs(W - b.w) > 1e-9 || Math.abs(n - b.n) > 1e-9 || Math.abs(P - b.p) > 1e-9;
    $('w-reset').classList.toggle('changed', changed);
    $('w-title').textContent = changed ? '試算' : '現在';
    const sRow = (label, value, unit, note, cls) =>
      `<div class="dLabel">${label}</div><div class="dVal ${cls || ''}">${value}<span class="unit">${unit || ''}</span></div><div class="dNote">${simNote(note)}</div>`;
    const gOk = r.sales > 0 && r.profit - r.goal >= -0.5, gd = r.profit - r.goal;
    const nOk = r.nMax !== null && n <= r.nMax + 1e-9;
    $('w-kpis').innerHTML = [
      sRow('売上額(概算)', yen(r.sales), '円', `契約金額 ${yen(x.w.contract)}円`),
      sRow('損益', yen(r.profit), '円', (r.rate === null ? '利益率 —' : `利益率 <span class="${r.rate * 100 >= g - 1e-9 ? 'pos' : 'neg'}">${pct(r.rate)}</span>`) + `<span class="goalPctWrap">（<b class="goalPct">目標${fmt(g, g % 1 ? 1 : 0)}%</b>）</span>`, r.profit >= 0 ? 'pos' : 'neg'),
      sRow('利益目標額', yen(r.goal), '円', r.sales > 0 ? `<span class="${gOk ? 'pos' : 'neg'}">${gOk ? '達成' : '未達'}</span>(損益との差 <span class="${gd >= 0 ? 'pos' : 'neg'}">${gd >= 0 ? '+' : ''}${yen(gd)}</span>円)` : '売上なし', r.sales > 0 ? (gOk ? 'pos' : 'neg') : ''),
      sRow('許容人工数(目標達成)', r.nMax === null ? '—' : fmt(r.nMax, 2), '人工/t', r.nMax === null ? '算出不可' : (nOk ? `<span class="pos">余裕 ${fmt(r.nMax - n, 2)}</span>人工/t` : `<span class="neg">超過 ${fmt(n - r.nMax, 2)}</span>人工/t`)),
      sRow('許容総工数(目標達成)', r.nMax === null ? '—' : fmt(r.nMax * W * 8, 0), 'h', `必要 ${fmt(r.hours, 0)}h`),
      sRow('損益分岐人工数', r.nBe === null ? '—' : fmt(r.nBe, 2), '人工/t', r.nBe === null ? '算出不可' : (n <= r.nBe ? `<span class="pos">余裕 ${fmt(r.nBe - n, 2)}</span>人工/t` : `<span class="neg">超過 ${fmt(n - r.nBe, 2)}</span>人工/t`)),
      sRow('必要人工', fmt(r.ninku, 1), '人工', `${fmt(r.hours, 0)}h`),
      sRow('変動費(仕入)', yen(r.variable), '円', `${yen(x.v)}円/t` + (x.w.done ? '(実績)' : '(予算)')),
      sRow('人件費', yen(r.labor), '円', `${yen(x.L)}円/人工`),
    ].join('');
    renderAdvice(x, r, W, P, g, gOk);
    renderStatus(x, r);
  }

  /* 現状分析: 目標利益率に届くには(ほかの条件は同じとして1つずつ) */
  function renderAdvice(x, r, W, P, g, ok) {
    const box = $('w-advice'), gl = fmt(g, g % 1 ? 1 : 0) + '%';
    if (!(r.sales > 0)) { box.innerHTML = ''; return; }
    const gap = r.goal - r.profit, perHour = x.L / 8;
    let html = `<div class="advHead">現状分析：目標利益率${gl}を達成するには${ok ? '' : '<small>ほかの条件は同じとして、どれか1つで達成する場合</small>'}</div>`;
    const plans = [
      { cls: 'advH', title: '時間を減らす', cond: '今の生産量のまま', need: perHour > 0 ? gap / perHour : null, unit: 'h', d: 0, from: r.hours, unitNote: perHour > 0 ? `1h減で 利益 +${yen(perHour)}円` : '' },
      { cls: 'advV', title: '変動費(仕入)を下げる', cond: '1tあたり', need: W > 0 ? gap / W : null, unit: '円/t', d: 0, from: x.v, unitNote: `1,000円/t減で 利益 +${yen(W * 1000)}円` },
    ];
    plans.forEach((c) => { c.ng = c.need === null || c.need > c.from; c.rate = !c.ng && c.from > 0 ? Math.abs(c.need) / c.from : null; });
    const cand = ok ? [] : plans.filter((c) => !c.ng && c.rate !== null), best = cand.length ? cand.reduce((a, b) => (b.rate < a.rate ? b : a)) : null;
    html += ok
      ? `<div class="advLead">✓ 目標を達成しています <span class="advLeadSub">目標より <b>${yen(-gap)}</b>円 超</span></div>`
      : `<div class="advLead" title="不足額 ${yen(gap)}円">あと <b class="advLeadGap">${bepMan(gap)}</b> 不足` +
        (best ? ` <span class="advArrow">➜</span> 最短は <b class="advLeadKey">「${best.title} −${pct(best.rate)}」</b>` : ' <span class="advArrow">➜</span> 1つだけでは届きません（組み合わせが必要）') + '</div>';
    const maxRate = Math.max(...plans.map((c) => (!c.ng && c.rate) || 0)) || 1;
    html += '<div class="advCards">' + plans.map((c) => {
      let body;
      if (c.ng) body = `<div class="advBig neg">${c.need === null ? '到達不能' : 'これだけでは不可'}</div>`;
      else body = `<div class="advBig ${ok ? 'pos' : 'neg'}">${ok ? '超 ' : '−'}${fmt(Math.abs(c.need), c.d)}<span class="advUnit">${c.unit}</span></div>` +
        `<div class="advFromTo">${fmt(c.from, c.d)} → ${fmt(c.from - c.need, c.d)}${c.unit}</div>` +
        `<div class="advBar"><i style="width:${Math.max(2, c.rate / maxRate * 100)}%"></i><span>${ok ? '' : '−'}${pct(c.rate)}</span></div>`;
      return `<div class="advCard ${c.cls}${c === best ? ' advBest' : ''}">${c === best ? '<span class="advRibbon">最短</span>' : ''}<div class="advTitle">${c.title}<small>（${c.cond}）</small></div>${body}<div class="advNote">${c.unitNote}</div></div>`;
    }).join('') + '</div>';
    // 今後の見積もりの目安単価
    const cost = r.labor + r.variable, goalPrice = W > 0 && x.g < 1 ? cost / (W * (1 - x.g)) : null, bePrice = W > 0 ? cost / W : null;
    if (goalPrice !== null && P > 0) {
      const vals = [bePrice, P, goalPrice], lo = Math.min(...vals), hi = Math.max(...vals), pad = (hi - lo) * 0.12 || hi * 0.05;
      const pos = (v) => ((v - lo + pad) / (hi - lo + pad * 2) * 100).toFixed(1);
      const mk = (v, cls, label) => `<div class="advMk ${cls}" style="left:${pos(v)}%"><span>${label}<b>${yen(v)}</b></span></div>`;
      html += `<div class="advRow2"><div class="advCard advPrice"><div class="advTitle">この工事の目安単価<small>（円/t）</small></div>
        <div class="advScale"><div class="advLine"></div>${mk(bePrice, 'mkBe', '損益0')}${mk(goalPrice, 'mkGoal', '目標' + gl)}${mk(P, 'mkNow', '今')}</div>
        <div class="advNote">利益率${gl}には、今より <b class="${goalPrice > P ? 'neg' : 'pos'}">${goalPrice > P ? '+' : ''}${yen(goalPrice - P)}</b>円/t</div></div></div>`;
    }
    box.innerHTML = html;
  }

  /* 右: 目標と現状(これまでの実績。試算の入力とは別に、実績の工数・仕入を目標の上限と比べる) */
  function renderStatus(x, r) {
    const w = x.w, done = w.weight, prog = w.totalWeight > 0 ? done / w.totalWeight : null, progW = x.W0 > 0 ? done / x.W0 : null; // prog=契約総重量に対する進捗、progW=試算の重量に対する進捗
    const allowH = r.nMax !== null ? r.nMax * x.W0 * 8 : null; // 契約総重量を作るのに使える総工数
    const info = (l, v) => `<div>${l}<b>${v}</b></div>`;
    const bar = (title, v, mark, max, capL, capR) => `<div class="woBar"><h3>${title}</h3><div class="track"><div class="fill${mark !== null && v > mark ? ' over' : ''}" style="width:${Math.min(100, max > 0 ? v / max * 100 : 0)}%"></div>` +
      (mark !== null ? `<div class="mark" style="left:${Math.min(100, max > 0 ? mark / max * 100 : 0)}%"></div>` : '') + `</div><div class="cap"><span>${capL}</span><span>${capR}</span></div></div>`;
    let h = '<div class="woInfo">' +
      info('契約総重量', fmt(w.totalWeight, 1) + ' t') + info('契約金額', yen(w.contract) + ' 円') + info('生産重量(累計)', fmt(done, 1) + ' t') +
      info('生産進捗', pct(prog)) + info('工数(累計)', fmt(w.hours, 0) + ' h') + info('1t当たり人工数(実績)', fmt(x.nNow, 2)) +
      info('労務費の締め', esc(w.cutoff ? C.periodLabel(w.cutoff) : '—')) + info('時間単価', w.hourRate ? yen(w.hourRate) + ' 円/h' : '—') + '</div>';
    h += bar('生産進捗', done, null, Math.max(w.totalWeight, done), `累計 ${fmt(done, 1)}t`, `契約 ${fmt(w.totalWeight, 1)}t(${pct(prog)})`);
    if (allowH !== null && allowH > 0) h += bar('工数の消化(目標利益率を確保できる総工数に対して)', w.hours, allowH * (progW || 0), Math.max(allowH, w.hours) * 1.05,
      `累計 ${fmt(w.hours, 0)}h`, `許容 ${fmt(allowH, 0)}h(黒線=生産進捗に見合う工数 ${fmt(allowH * (progW || 0), 0)}h)`);
    if (r.nMax !== null) h += bar('1t当たり人工数(実績と目標の上限)', x.nNow, r.nMax, Math.max(x.nNow, r.nMax) * 1.1, `実績 ${fmt(x.nNow, 2)}`, `上限 ${fmt(r.nMax, 2)}(黒線)`);
    if (w.hasBudget && w.purchaseBudget !== null && w.purchaseActual !== null) h += bar('仕入(実行予算 実際と予算)', w.purchaseActual, w.purchaseBudget, Math.max(w.purchaseActual, w.purchaseBudget) * 1.1,
      `実際 ${yen(w.purchaseActual)}円`, `予算 ${yen(w.purchaseBudget)}円(黒線)`);
    if (w.notes.length) h += '<ul id="notes">' + w.notes.map((t) => '<li>' + esc(t) + '</li>').join('') + '</ul>';
    $('w-status').innerHTML = h;
  }

  window.WorkView = { show };
})();
