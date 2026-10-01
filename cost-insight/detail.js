/*
 * 工場別進捗分析(詳細版)= 目標シミュレーター
 *   生産損益分析(production-profit)の「目標シミュレーター」と同じ画面。
 *   「現在」の入力欄(生産重量・1t当たり人工数・トン単価)を変えるか、グラフのつまみをドラッグすると、
 *   売上・損益・損益分岐生産量・目標生産量・現状分析(目標利益率に届くには)が再計算される。
 *   コストインサイトの数字で計算する: 売上=加工単価×重量 / 変動費=仕入 / 人件費=労務費(工数×時間単価)。その他固定費は 基本設定の月額。
 */
(function () {
  'use strict';
  const C = CICalc, K = CIKit;
  const SITE_LIST = K.SITE_LIST;
  const $ = (id) => document.getElementById(id);
  const D = { mode: 'fiscal', site: '', inited: false, lastYmd: null, defPeriod: null, base: null, exact: {}, total: null, remain: null, daily: null, dragging: false };
  const SIM_DIGITS = { w: 1, n: 2, p: 0 };
  const simFmt = (k, v) => fmt(v, SIM_DIGITS[k]);
  const manU = (v) => Math.abs(v) >= 10000 ? fmt(v / 10000, 0) + '万円' : fmt(v, 0) + '円';

  function parseNumIn(text) {
    const s = String(text === null || text === undefined ? '' : text)
      .replace(/[０-９．，－]/g, (c) => ({ '．': '.', '，': ',', '－': '-' }[c] || String.fromCharCode(c.charCodeAt(0) - 0xFEE0)))
      .replace(/[,\s円t]/g, '');
    const v = parseFloat(s);
    return isFinite(v) ? v : 0;
  }

  /* ---------- 計算(production-profit の PPCalc と同じ式。固定費=人件費のみ) ---------- */
  function simulate(t, W, n, P) {
    const p = K.goalRate() / 100, L = t.laborRate || 0, v = t.varPerTon || 0;
    const fixed = t.fixed || 0;
    const sales = W * P, ninku = W * n, labor = ninku * L, variable = W * v;
    const profit = sales - labor - variable - fixed;
    const dBe = P - v, dGoal = P * (1 - p) - v;
    const be = dBe > 0 ? (fixed + labor) / dBe : null, goal = dGoal > 0 ? (fixed + labor) / dGoal : null;
    return { weight: W, ninkuPerTon: n, unitPrice: P, sales, ninku, hours: ninku * 8, labor, variable, fixed, profit,
      profitRate: sales > 0 ? profit / sales : null, profitGoal: sales * p, breakEvenTons: be, goalTons: goal, goalSales: goal === null ? null : goal * P,
      laborRate: L, varPerTon: v };
  }
  function advise(r) {
    const p = K.goalRate() / 100, W = r.weight || 0, cost = r.labor + r.variable + r.fixed, gap = r.profitGoal - r.profit;
    const perHour = (r.laborRate || 0) / 8;
    return { gap, addTons: r.goalTons !== null ? r.goalTons - W : null, cutHours: perHour > 0 ? gap / perHour : null, cutVarPerTon: W > 0 ? gap / W : null,
      perTon: r.unitPrice - (r.varPerTon || 0), perHour, perVar1000: W * 1000,
      goalPrice: W > 0 && p < 1 ? cost / (W * (1 - p)) : null, bePrice: W > 0 ? cost / W : null };
  }
  function remainingNeed(actual, extraFixed) {
    const p = K.goalRate() / 100;
    const lpt = actual.weight > 0 ? actual.labor / actual.weight : 0;
    const margin = (actual.unitPrice || 0) * (1 - p) - (actual.varPerTon || 0) - lpt;
    const need = p * actual.sales - actual.profit + extraFixed;
    return { extraFixed, tons: margin > 0 ? need / margin : null };
  }
  /* 直近12か月度(締まった月度)の1出勤日あたり工数: 平均と最少の月 */
  function dailyHoursStats(cal, sites, endKey) {
    const set = new Set(sites), startKey = C.shiftPeriod(endKey, -11), hours = {};
    state.model.cells.forEach((c) => { if (set.has(c.site) && c.period >= startKey && c.period <= endKey) hours[c.period] = (hours[c.period] || 0) + c.hours; });
    let sumH = 0, sumD = 0, min = null, minKey = null;
    for (let k = startKey; k <= endKey; k = C.shiftPeriod(k, 1)) {
      const rg = C.periodRange(k), d = K.workDaysIn(cal, rg.from, rg.to), h = hours[k] || 0;
      if (!(h > 0) || !(d > 0)) continue;
      sumH += h; sumD += d;
      if (min === null || h / d < min) { min = h / d; minKey = k; }
    }
    return { avg: sumD > 0 ? sumH / sumD : null, min, minKey };
  }

  /* ---------- 画面の準備 ---------- */
  function init() {
    const m = state.model;
    D.lastYmd = K.lastDataYmd();
    const first = C.periodKeyOf(m.analysisFrom), cur = D.lastYmd ? C.periodKeyOf(D.lastYmd) : first;
    const periods = [];
    for (let k = cur; k >= first; k = C.shiftPeriod(k, -1)) periods.push(k);
    $('d-period').innerHTML = periods.map((k) => `<option value="${k}">${C.periodLabel(k)}</option>`).join('');
    D.defPeriod = periods[1] || periods[0];
    $('d-period').value = D.defPeriod;
    const fys = [];
    for (let y = C.fiscalYearOf(cur); y >= C.fiscalYearOf(first); y--) fys.push(y);
    $('d-fiscal').innerHTML = fys.map((y) => `<option value="${y}">${y}/11/21〜${y + 1}/11/20期</option>`).join('');
    $('d-fiscal').value = String(C.fiscalYearOf(cur));
    $('d-sites').innerHTML = [['', SITE_LIST.length + '工場']].concat(SITE_LIST.map((s) => [s, s]))
      .map(([v, l]) => `<button type="button" data-site="${esc(v)}">${esc(l)}</button>`).join('');
    const change = () => { D.base = null; render(); };
    $('d-modes').onclick = (e) => {
      const b = e.target.closest('button');
      if (!b) return;
      if (b.dataset.mode === 'period' && D.mode !== 'period') $('d-period').value = D.defPeriod;
      D.mode = b.dataset.mode;
      change();
    };
    $('d-sites').onclick = (e) => { const b = e.target.closest('button'); if (b) { D.site = b.dataset.site; change(); } };
    $('d-period').onchange = change;
    $('d-fiscal').onchange = change;
    const step = (d) => { const s = $('d-period'), i = s.selectedIndex + d; if (i >= 0 && i < s.options.length) { s.selectedIndex = i; change(); } };
    $('d-prev').onclick = () => step(1);
    $('d-next').onclick = () => step(-1);
    Object.keys(SIM_DIGITS).forEach((k) => {
      const el = $('s-' + k);
      el.oninput = () => onInput(k);
      // 入力中は自由に打てるようにし、欄を離れたら「,」区切りの形に整える
      el.onchange = () => {
        const v = parseNumIn(el.value), ex = D.exact[k];
        if (ex && Math.abs(v - parseNumIn(ex.shown)) < 1e-9) { el.value = ex.shown; return; }
        el.value = simFmt(k, v);
        onInput(k);
      };
    });
    $('s-reset').onclick = () => { D.base = null; render(); };
    $('d-reset').onclick = () => { resetView(); render(); };
    D.inited = true;
  }

  // 年度・今期・3工場の表示に戻す(画面を開いたときと「リセット」ボタン)
  function resetView() {
    const cur = D.lastYmd ? C.periodKeyOf(D.lastYmd) : C.periodKeyOf(state.model.analysisFrom);
    D.mode = 'fiscal';
    D.site = '';
    $('d-fiscal').value = String(C.fiscalYearOf(cur));
    $('d-period').value = D.defPeriod;
    D.base = null;
  }

  function show() {
    if (!state.model) return;
    if (!D.inited) init();
    resetView();
    render();
  }

  function selection() {
    const mode = D.mode, selPer = $('d-period');
    const r = mode === 'period' ? C.periodRange(selPer.value) : C.fiscalRange(Number($('d-fiscal').value));
    const sites = D.site ? [D.site] : SITE_LIST;
    const lastTo = D.lastYmd && D.lastYmd >= r.from && D.lastYmd < r.to ? D.lastYmd : r.to;
    const md = (d) => `${Number(d.slice(5, 7))}/${Number(d.slice(8))}`;
    return { mode, from: r.from, to: lastTo, fullTo: r.to, sites, note: lastTo < r.to ? `(実績〜${md(lastTo)})` : '' };
  }

  function render() {
    if (!state.model || state.view !== 'detail') return;
    document.querySelectorAll('#d-modes button').forEach((b) => b.classList.toggle('active', b.dataset.mode === D.mode));
    document.querySelectorAll('#d-sites button').forEach((b) => b.classList.toggle('active', b.dataset.site === D.site));
    $('d-period-wrap').hidden = D.mode !== 'period';
    $('d-fiscal-wrap').hidden = D.mode !== 'fiscal';
    const selPer = $('d-period');
    $('d-prev').disabled = selPer.selectedIndex >= selPer.options.length - 1;
    $('d-next').disabled = selPer.selectedIndex <= 0;
    const sel = selection();
    const t = K.analyze(sel.from, sel.to, sel.sites);
    D.total = t;
    const monthly = K.otherFixed() * K.siteShare(sel.sites), mo = monthly > 0 ? t.fixed / monthly : 0;
    D.fixedNote = `${yen(monthly)}円/月 × ${fmt(mo, Math.abs(mo - Math.round(mo)) < 0.05 ? 0 : 1)}か月（${sel.sites.length === SITE_LIST.length ? '3工場合計' : sel.sites.join('・')}）`;
    // 期間の途中なら、期間の終わりまでに目標利益率に届くのに必要な、残り期間の生産量(その他の固定費が無いので固定費の上乗せは0)
    D.remain = null;
    if (sel.to < sel.fullTo) {
      const cal = K.calendar(), next = K.utcToYmd(K.ymdToUtc(sel.to) + 86400000);
      D.remain = Object.assign(remainingNeed(t, K.fixedFor(sel.from, sel.fullTo, sel.sites) - t.fixed), { doneDays: K.workDaysIn(cal, sel.from, sel.to), leftDays: K.workDaysIn(cal, next, sel.fullTo), end: sel.fullTo });
    }
    // 「時間を減らす」の判定用: 期間の出勤日数と、直近12か月度の1出勤日あたり工数
    D.daily = null;
    if (D.lastYmd) {
      const cal = K.calendar(), lastKey = C.periodKeyOf(D.lastYmd);
      const endKey = D.lastYmd === C.periodRange(lastKey).to ? lastKey : C.shiftPeriod(lastKey, -1);
      const days = K.workDaysIn(cal, sel.from, sel.to);
      if (days > 0) D.daily = Object.assign({ days }, dailyHoursStats(cal, sel.sites, endKey));
    }
    renderWorks(sel);
    if (!D.base) {
      D.base = { w: t.weight, n: t.ninkuPerTon || 0, p: t.unitPrice || 0 };
      D.hours = D.base.w * D.base.n * 8;
      D.exact = {};
      ['w', 'n', 'p'].forEach((k) => {
        const el = $('s-' + k);
        el.value = simFmt(k, D.base[k]);
        // 表示は丸めるが、欄を触っていない間は丸める前の値で計算する
        D.exact[k] = { shown: el.value, value: D.base[k] };
      });
    }
    updateSim();
  }

  /* 入力欄の変更。総工数(=必要人工)は生産重量を変えても変わらない人員体制として固定し、
     生産重量を増やすと 1t当たり人工数が減る(減らすと増える)。1t当たり人工数を直接入れたときは、その値で総工数を決め直す */
  function onInput(k) {
    if (k === 'w') {
      const W = simValue('w');
      if (W > 0 && D.hours > 0) setNpt(D.hours / 8 / W);
    } else if (k === 'n') {
      D.hours = simValue('w') * simValue('n') * 8;
    }
    updateSim();
  }
  function setNpt(n) {
    const el = $('s-n');
    el.value = simFmt('n', n);
    D.exact.n = { shown: el.value, value: n };
  }

  /* 入力欄の右に、工事ごとの実績(生産重量・人工/t・トン単価・売上額(概算))を工事番号の昇順に並べる */
  function renderWorks(sel) {
    const g = {};
    C.filterCells(state.model, { from: sel.from, to: sel.to, sites: sel.sites }).forEach((c) => {
      if (c.no === C.COMMON) return;
      const a = g[c.no] || (g[c.no] = { weight: 0, hours: 0, sales: 0 });
      a.weight += c.weight; a.hours += c.hours; a.sales += c.sales || 0;
    });
    const rows = Object.keys(g).filter((no) => g[no].weight > 0).sort((a, b) => a.localeCompare(b, 'ja', { numeric: true }));
    const box = $('sim-works');
    if (!rows.length) { box.innerHTML = '<div class="muted small simEmpty">この条件で生産実績のある工事はありません</div>'; return; }
    box.innerHTML = rows.map((no) => {
      const a = g[no], w = state.model.works[no] || {}, pu = w.procUnit;
      return `<div class="simCol" title="${esc(no + ' ' + (w.name || ''))}">
        <div class="simHead"><b>${esc(no)}</b><span>${esc(w.name || '')}</span></div>
        <div class="simCell">${fmt(a.weight, 1)}</div>
        <div class="simCell">${fmt(a.hours / 8 / a.weight, 2)}</div>
        <div class="simCell ${pu ? '' : 'neg'}">${pu ? fmt(pu, 0) : '未入力'}</div>
        <div class="simCell simSales">${fmt(a.sales, 0)}</div>
      </div>`;
    }).join('');
  }

  const simValue = (k) => { const v = $('s-' + k).value, ex = D.exact[k]; return ex && ex.shown === v ? ex.value : parseNumIn(v); };
  /* 試算表の備考: 数値と「達成/未達」だけを大きく表示する */
  const simNote = (note) => String(note || '').replace(/(^|>)([^<]*)/g, (m, a, txt) => a + txt.replace(/[+\-]?\d[\d,]*(\.\d+)?%?/g, '<span class="nv">$&</span>'));

  function updateSim() {
    const t = D.total;
    if (!t) return;
    const W = simValue('w'), n = simValue('n'), P = simValue('p');
    const r = simulate(t, W, n, P), b = D.base, g = K.goalRate();
    $('s-s').value = fmt(r.sales, 0);
    const changed = Math.abs(W - b.w) > 1e-9 || Math.abs(n - b.n) > 1e-9 || Math.abs(P - b.p) > 1e-9;
    $('s-reset').classList.toggle('changed', changed);
    document.querySelector('#v-detail .simTitle').textContent = changed ? '試算' : '現在';
    const diff = (v, bv, f) => { const d = v - bv; return Math.abs(d) < 0.5 ? '上部試算表参照' : `基準比 ${d > 0 ? '+' : ''}${f(d)}`; };
    const sRow = (label, value, unit, note, cls) =>
      `<div class="dLabel">${label}</div><div class="dVal ${cls || ''}">${value}<span class="unit">${unit || ''}</span></div><div class="dNote">${simNote(note)}</div>`;
    const gOk = r.sales > 0 && r.profit - r.profitGoal >= -0.5, gd = r.profit - r.profitGoal;
    $('sim-kpis').innerHTML = [
      sRow('売上額(概算)', yen(r.sales), '円', diff(r.sales, b.w * b.p, yen)),
      sRow('損益', yen(r.profit), '円', (r.profitRate === null ? '利益率 —' : `利益率 <span class="${r.profitRate * 100 >= g - 1e-9 ? 'pos' : 'neg'}">${pct(r.profitRate)}</span>`) + `<span class="goalPctWrap">（<b class="goalPct">目標${fmt(g, g % 1 ? 1 : 0)}%</b>）</span>`, r.profit >= 0 ? 'pos' : 'neg'),
      sRow('利益目標額', yen(r.profitGoal), '円', r.sales > 0 ? `<span class="${gOk ? 'pos' : 'neg'}">${gOk ? '達成' : '未達'}</span>(損益との差 <span class="${gd >= 0 ? 'pos' : 'neg'}">${gd >= 0 ? '+' : ''}${yen(gd)}</span>円)` : '売上なし', r.sales > 0 ? (gOk ? 'pos' : 'neg') : ''),
      sRow('目標売上額', yen(r.goalSales), '円', r.goalTons !== null ? `必要生産量 ${ton(r.goalTons)}t` + (W >= r.goalTons - 0.05 ? `（<span class="pos">超 ${ton(Math.max(0, W - r.goalTons))}</span>t）` : `（<span class="neg">不足 ${ton(r.goalTons - W)}</span>t）`) : '到達不能'),
      sRow('損益分岐生産量', ton(r.breakEvenTons), 't', r.breakEvenTons !== null ? (W >= r.breakEvenTons ? `<span class="pos">超 ${ton(W - r.breakEvenTons)}</span>t` : `<span class="neg">不足 ${ton(r.breakEvenTons - W)}</span>t`) : '到達不能'),
      sRow('必要人工', fmt(r.ninku, 1), '人工', `${fmt(r.hours, 0)}h`),
      sRow('変動費(仕入)', yen(r.variable), '円', `${yen(r.varPerTon)}円/t`),
      sRow('固定費(人件費込み)', yen(r.fixed + r.labor), '円', '人件費 + その他固定費'),
      sRow('<span class="subLbl">└ 人件費</span>', yen(r.labor), '円', `${yen(r.laborRate)}円/人工`),
      sRow('<span class="subLbl">└ その他固定費</span>', yen(r.fixed), '円', D.fixedNote),
    ].join('');
    renderAdvice(r, t, W, P);
    // 人件費は試算の生産重量での額を固定費に含め、固定費線を水平にする(つまみのドラッグ中に縮尺が変わらないよう、署名は基準値で作る)
    drawBep('c-sim', { fixed: r.fixed + r.labor, unitPrice: P, laborPerTon: 0, varPerTon: r.varPerTon, profitRate: g / 100,
      fixedLabel: ['固定費', '(人件費込み)'], otherFixed: r.fixed, laborRate: r.laborRate, sig: [r.fixed, P, D.hours, r.laborRate, r.varPerTon, g].join('|'),
      x: W, forceX: !D.dragging, beTons: r.breakEvenTons, goalTons: r.goalTons, handleLabel: changed ? '試算' : '現在', dragHint: true,
      onMove: (x) => { D.dragging = true; $('s-w').value = simFmt('w', x); D.exact.w = { shown: $('s-w').value, value: x }; onInput('w'); D.dragging = false; } });
  }

  /* 現状分析: 目標利益率に届くには(ほかの条件は同じとして1つずつ)。トン単価は受注時に決まっているため変えない */
  function renderAdvice(r, t, W, P) {
    const box = $('sim-advice'), g = K.goalRate(), gl = fmt(g, g % 1 ? 1 : 0) + '%';
    if (!(r.sales > 0)) { box.innerHTML = ''; return; }
    const a = advise(r), ok = a.gap <= 0.5;
    const md = (d) => `${Number(d.slice(5, 7))}/${Number(d.slice(8))}`;
    let html = `<div class="advHead">現状分析：目標利益率${gl}を達成するには${ok ? '' : '<small>ほかの条件は同じとして、どれか1つで達成する場合</small>'}</div>`;
    const dailyNote = (c) => {
      const dd = D.daily;
      if (!dd || c.ng || ok || !(c.need > 0)) return '';
      const now = r.hours / dd.days, after = (r.hours - c.need) / dd.days;
      let h = `<div class="advDaily">1日 ${fmt(now, 0)}→<b>${fmt(after, 0)}</b>h（−${fmt(now - after, 0)}h・約${fmt((now - after) / 8, 0)}人分）</div>`;
      if (dd.min !== null && after < dd.min) h += `<div class="advWarn" title="過去1年で最も少なかった月(${esc(C.periodLabel(dd.minKey))})の1日あたり工数 ${fmt(dd.min, 0)}h を下回るため、人員配置の見直しが必要">⚠ 過去1年の最少を下回る＝削減困難</div>`;
      return h;
    };
    const plans = [
      { cls: 'advW', title: '生産量を増やす', cond: '今の時間のまま', need: a.addTons, unit: 't', d: 1, from: W, sign: 1, unitNote: `1t増で 利益 +${yen(a.perTon)}円` },
      { cls: 'advH', title: '時間を減らす', cond: '今の生産量のまま', need: a.cutHours, unit: 'h', d: 0, from: r.hours, sign: -1, unitNote: `1h減で 利益 +${yen(a.perHour)}円`, daily: true },
      { cls: 'advV', title: '変動費を下げる', cond: '1tあたり', need: a.cutVarPerTon, unit: '円/t', d: 0, from: r.varPerTon, sign: -1, unitNote: `1,000円/t減で 利益 +${yen(a.perVar1000)}円` },
    ];
    plans.forEach((c) => {
      c.rate = c.need !== null && c.from > 0 ? Math.abs(c.need) / c.from : null;
      c.ng = c.need === null || (c.sign < 0 && c.need > c.from);
      const dd = D.daily;
      c.hard = !!(c.daily && dd && dd.min !== null && !c.ng && !ok && c.need > 0 && (r.hours - c.need) / dd.days < dd.min);
    });
    const cand = ok ? [] : plans.filter((c) => !c.ng && !c.hard && c.rate !== null);
    const best = cand.length ? cand.reduce((x, y) => (y.rate < x.rate ? y : x)) : null;
    html += ok
      ? `<div class="advLead">✓ 目標を達成しています <span class="advLeadSub">目標より <b>${yen(-a.gap)}</b>円 超</span></div>`
      : `<div class="advLead" title="不足額 ${yen(a.gap)}円">あと <b class="advLeadGap">${manU(a.gap)}</b> 不足` +
        (best ? ` <span class="advArrow">➜</span> 最短は <b class="advLeadKey">「${best.title} ${best.sign > 0 ? '＋' : '−'}${pct(best.rate)}」</b>` : ' <span class="advArrow">➜</span> 1つだけでは届きません（組み合わせが必要）') + '</div>';
    const maxRate = Math.max(...plans.map((c) => (!c.ng && c.rate) || 0)) || 1;
    html += '<div class="advCards">' + plans.map((c) => {
      let body;
      if (c.ng) body = `<div class="advBig neg">${c.need === null ? '到達不能' : 'これだけでは不可'}</div>`;
      else {
        const more = c.need > 0, sg = (c.sign > 0) === more ? '＋' : '−';
        body = `<div class="advBig ${ok ? 'pos' : 'neg'}">${ok ? '超 ' : sg}${fmt(Math.abs(c.need), c.d)}<span class="advUnit">${c.unit}</span></div>` +
          `<div class="advFromTo">${fmt(c.from, c.d)} → ${fmt(c.from + c.sign * c.need, c.d)}${c.unit}</div>` +
          `<div class="advBar"><i style="width:${Math.max(2, c.rate / maxRate * 100)}%"></i><span>${ok ? '' : sg}${pct(c.rate)}</span></div>`;
      }
      const mark = c === best ? ' advBest' : c.hard ? ' advHard' : '';
      return `<div class="advCard ${c.cls}${mark}">${c === best ? '<span class="advRibbon">最短</span>' : ''}<div class="advTitle">${c.title}<small>（${c.cond}）</small></div>${body}${c.daily ? dailyNote(c) : ''}<div class="advNote">${c.unitNote}</div></div>`;
    }).join('') + '</div>';

    // 今後の見積もりの目安単価: 損益0・今・目標の3つの単価を1本の目盛りに並べる
    let row2 = '';
    if (a.goalPrice !== null && a.bePrice !== null && P > 0) {
      const vals = [a.bePrice, P, a.goalPrice], lo = Math.min(...vals), hi = Math.max(...vals), pad = (hi - lo) * 0.12 || hi * 0.05;
      const pos = (v) => ((v - lo + pad) / (hi - lo + pad * 2) * 100).toFixed(1);
      const mk = (v, cls, label) => `<div class="advMk ${cls}" style="left:${pos(v)}%"><span>${label}<b>${yen(v)}</b></span></div>`;
      row2 += `<div class="advCard advPrice"><div class="advTitle">今後の見積もりの目安単価<small>（円/t）</small></div>
        <div class="advScale"><div class="advLine"></div>${mk(a.bePrice, 'mkBe', '損益0')}${mk(a.goalPrice, 'mkGoal', '目標' + gl)}${mk(P, 'mkNow', '今')}</div>
        <div class="advNote">利益率${gl}には、今より <b class="${a.goalPrice > P ? 'neg' : 'pos'}">${a.goalPrice > P ? '+' : ''}${yen(a.goalPrice - P)}</b>円/t</div></div>`;
    }
    // 期間全体で達成するには: 残りの出勤日に1日何t必要か(これまでの1日平均との比較)
    const m = D.remain;
    if (m) {
      const avgT = m.doneDays > 0 ? t.weight / m.doneDays : 0;
      const perM = m.tons !== null && m.leftDays > 0 ? m.tons / m.leftDays : null;
      const ratio = perM !== null && avgT > 0 ? perM / avgT : null;
      const lv = m.tons === null ? 'lvBad' : m.tons <= 0 || (ratio !== null && ratio <= 1) ? 'lvGood' : ratio !== null && ratio <= 1.2 ? 'lvWarn' : 'lvBad';
      let body;
      if (m.tons === null) body = '<div class="advBig neg">今の条件では到達不能</div>';
      else if (m.tons > 0 && !(m.leftDays > 0)) body = '<div class="advBig neg">残りの出勤日がありません</div>';
      else if (m.tons <= 0) body = '<div class="advBig pos">達成見込み</div><div class="advFromTo">残り期間の生産量に関わらず達成</div>';
      else {
        const w = (v) => Math.max(2, v / Math.max(perM, avgT) * 100).toFixed(1);
        body = `<div class="advBig">1出勤日あたり ${ton(perM)}<span class="advUnit">t</span>${ratio !== null ? `<span class="advRatio">これまでの ${fmt(ratio, 2)}倍</span>` : ''}</div>
          <div class="advCmp"><span>必要</span><div class="advBar2"><i class="need" style="width:${w(perM)}%"></i></div><b>${ton(perM)}t/日</b></div>
          <div class="advCmp"><span>これまで</span><div class="advBar2"><i style="width:${w(avgT)}%"></i></div><b>${ton(avgT)}t/日</b></div>
          <div class="advNote">残り${m.leftDays}出勤日で 計${ton(m.tons)}t</div>`;
      }
      row2 += `<div class="advCard advRemain ${lv}"><div class="advTitle">期間全体で達成するには<small>（〜${md(m.end)}）</small></div>${body}</div>`;
    }
    if (row2) html += `<div class="advRow2">${row2}</div>`;
    box.innerHTML = html;
  }

  window.DetailView = { show };
})();
