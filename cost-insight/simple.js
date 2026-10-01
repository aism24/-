/*
 * 工場別進捗分析(シンプル版)
 *   生産損益分析(production-profit)のシンプル版と同じ画面。期間(年度/月〆)と工場のボタンで絞り込み、
 *   「現在までの結果」「目標を達成するには」「損益分岐生産量グラフ」「工場別の目標値」を出す。
 *   コストインサイトの数字(calc.js のセル)で計算する。
 *   売上 = 加工単価×重量 / 変動費 = 仕入 / 人件費 = 労務費(工数×時間単価) / その他固定費 = 月額2,500万円(3工場合計、下の OTHER_FIXED_MONTHLY)。
 *   → 損益分岐 = (人件費+その他固定費) ÷ (単価 − 仕入単価) 、目標は 単価×(1−目標利益率) で計算する。
 */
(function () {
  'use strict';
  const C = CICalc;
  const SITE_LIST = ['本社', '夢前', '鳥取'];
  const FIXED_BASE = 12; // 目標の基準にする直近の月度数
  // 月額のその他固定費(人件費以外の固定費。3工場合計・円)。決算に合わせた値(2026-10-01 ユーザー指示: 月2,500万円)。
  // 工場へは在職人数(工数)の比で配分する。変えるときはここの値だけ直す。
  const OTHER_FIXED_MONTHLY = 25000000;
  const $ = (id) => document.getElementById(id);
  const S = { mode: 'fiscal', site: '', inited: false, lastYmd: null, defPeriod: null };

  // bepchart.js も使う書式
  window.yen = (v) => fmt(v, 0);
  window.ton = (v) => fmt(v, 1);
  window.npt = (v) => fmt(v, 2);

  /* ---------- 日付・出勤日(会社カレンダー。無い日は日曜だけ休み) ---------- */
  const ymdToUtc = (s) => Date.parse(s + 'T00:00:00Z');
  const utcToYmd = (t) => { const d = new Date(t); return d.getUTCFullYear() + '-' + pad2(d.getUTCMonth() + 1) + '-' + pad2(d.getUTCDate()); };
  const calendar = () => (state.data.settings && state.data.settings.calendar) || {};
  const isWorkDay = (cal, ymd) => { const v = cal[ymd]; if (v === 1 || v === 0) return v === 1; return new Date(ymdToUtc(ymd)).getUTCDay() !== 0; };
  function workDaysIn(cal, from, to) {
    let n = 0;
    for (let t = ymdToUtc(from), e = ymdToUtc(to); t <= e; t += 86400000) if (isWorkDay(cal, utcToYmd(t))) n++;
    return n;
  }
  const goalRate = () => {
    const g = Number((state.data.settings || {}).targetProfitRate);
    return isFinite(g) && g > 0 ? g : 5;
  };
  const headcount = () => (state.data.settings && state.data.settings.headcount) || {};

  /* ---------- その他固定費 ---------- */
  // 工場の配分比(在職人数。名簿が無ければ均等)
  function siteShare(sites) {
    const hc = headcount(), all = SITE_LIST.reduce((a, s) => a + (hc[s] || 0), 0);
    if (!(all > 0)) return sites.length / SITE_LIST.length;
    return sites.reduce((a, s) => a + (hc[s] || 0), 0) / all;
  }
  // 期間[from,to]のその他固定費。締まった月度は月額そのまま、途中の月度は出勤日数の割合
  function fixedFor(from, to, sites) {
    const cal = calendar(), share = siteShare(sites);
    let sum = 0;
    for (let k = C.periodKeyOf(from); k <= C.periodKeyOf(to); k = C.shiftPeriod(k, 1)) {
      const r = C.periodRange(k), a = r.from < from ? from : r.from, b = r.to > to ? to : r.to;
      const total = workDaysIn(cal, r.from, r.to);
      if (total > 0 && b >= a) sum += OTHER_FIXED_MONTHLY * share * workDaysIn(cal, a, b) / total;
    }
    return sum;
  }

  /* ---------- 集計(calc.js のセルから) ---------- */
  function analyze(from, to, sites) {
    const t = C.summarize(C.filterCells(state.model, { from, to, sites }));
    t.fixed = fixedFor(from, to, sites);                 // その他固定費(人件費は労務費として別に入っている)
    t.profit -= t.fixed;
    t.profitRate = t.profitSales > 0 ? t.profit / t.profitSales : null;
    t.ninkuPerTon = t.weight > 0 ? t.hours / 8 / t.weight : null;
    t.unitPrice = t.procUnit;            // 加工単価(円/t)
    t.varPerTon = t.purchaseUnit;        // 仕入単価(円/t)=変動費
    t.laborRate = t.hourRate === null ? null : t.hourRate * 8; // 1人工(8h)当たりの労務費
    return t;
  }

  /* 目標利益率・単価から損益分岐生産量と目標生産量を出す(人件費を固定費扱い。その他の固定費は無い) */
  function simulate(base, W, n, P, p) {
    const L = base.laborRate || 0, v = base.varPerTon || 0, labor = W * n * L, fixed = base.fixed || 0;
    const dBe = P - v, dGoal = P * (1 - p) - v;
    return { labor, fixed, unitPrice: P, varPerTon: v, laborRate: L,
      breakEvenTons: dBe > 0 ? (fixed + labor) / dBe : null, goalTons: dGoal > 0 ? (fixed + labor) / dGoal : null };
  }

  /* ---------- 画面の準備 ---------- */
  function lastDataYmd() {
    let last = null;
    state.model.cells.forEach((c) => { if ((c.weight > 0 || c.hours > 0) && (!last || c.ymd > last)) last = c.ymd; });
    return last;
  }

  function init() {
    const m = state.model;
    S.lastYmd = lastDataYmd();
    const first = C.periodKeyOf(m.analysisFrom);
    const cur = S.lastYmd ? C.periodKeyOf(S.lastYmd) : first;
    const periods = [];
    for (let k = cur; k >= first; k = C.shiftPeriod(k, -1)) periods.push(k);
    $('f-speriod').innerHTML = periods.map((k) => `<option value="${k}">${C.periodLabel(k)}</option>`).join('');
    S.defPeriod = periods[1] || periods[0]; // 先月度(直近の確定月度)
    $('f-speriod').value = S.defPeriod;
    const fys = [];
    for (let y = C.fiscalYearOf(cur); y >= C.fiscalYearOf(first); y--) fys.push(y);
    $('f-sfiscal').innerHTML = fys.map((y) => `<option value="${y}">${y}/11/21〜${y + 1}/11/20期</option>`).join('');
    $('f-sfiscal').value = String(C.fiscalYearOf(cur));
    $('f-ssites').innerHTML = [['', SITE_LIST.length + '工場']].concat(SITE_LIST.map((s) => [s, s]))
      .map(([v, l]) => `<button type="button" data-site="${esc(v)}">${esc(l)}</button>`).join('');
    $('f-modes').onclick = (e) => {
      const b = e.target.closest('button');
      if (!b) return;
      if (b.dataset.mode === 'period' && S.mode !== 'period') $('f-speriod').value = S.defPeriod; // 年度→月〆は常に先月度から
      S.mode = b.dataset.mode;
      render();
    };
    $('f-ssites').onclick = (e) => { const b = e.target.closest('button'); if (b) { S.site = b.dataset.site; render(); } };
    $('f-speriod').onchange = render;
    $('f-sfiscal').onchange = render;
    const step = (d) => { const s = $('f-speriod'), i = s.selectedIndex + d; if (i >= 0 && i < s.options.length) { s.selectedIndex = i; render(); } };
    $('f-prev').onclick = () => step(1);
    $('f-next').onclick = () => step(-1);
    window.addEventListener('resize', () => setTimeout(placeTargets, 0));
    S.inited = true;
  }

  function show() {
    if (!state.model) return;
    if (!S.inited) init();
    render();
  }

  /* 選択範囲。実績が途中までの期間は、実績の最終日までを「実績」とする */
  function selection() {
    const mode = S.mode, selPer = $('f-speriod');
    const r = mode === 'period' ? C.periodRange(selPer.value) : C.fiscalRange(Number($('f-sfiscal').value));
    const sites = S.site ? [S.site] : SITE_LIST;
    const lastTo = S.lastYmd && S.lastYmd >= r.from && S.lastYmd < r.to ? S.lastYmd : r.to;
    const md = (d) => `${Number(d.slice(5, 7))}/${Number(d.slice(8))}`;
    const note = lastTo < r.to ? `(実績〜${md(lastTo)})` : '';
    // 目標の欄の見出し用(令和。期は終わりの年で数える 例: 2025/11/21〜2026/11/20期=R8年度、2026年8月度=R8年8月度)
    const pk = mode === 'period' ? selPer.value.split('-') : null;
    const reiwa = pk ? 'R' + (Number(pk[0]) - 2018) + '年' + Number(pk[1]) + '月度' : 'R' + (Number($('f-sfiscal').value) + 1 - 2018) + '年度';
    return { mode, from: r.from, to: lastTo, fullTo: r.to, lastTo, reiwa, sites, note, periodKey: mode === 'period' ? selPer.value : null };
  }

  function card(label, value, unit, sub, cls) {
    return `<div class="sCard ${cls || ''}"><div class="sLabel">${label}</div><div class="sValue">${value}<span class="sUnit">${unit}</span></div><div class="sSub">${sub || ''}</div></div>`;
  }

  function render() {
    if (!state.model || state.view !== 'simple') return;
    document.querySelectorAll('#f-modes button').forEach((b) => b.classList.toggle('active', b.dataset.mode === S.mode));
    document.querySelectorAll('#f-ssites button').forEach((b) => b.classList.toggle('active', b.dataset.site === S.site));
    $('f-period-wrap').hidden = S.mode !== 'period';
    $('f-fiscal-wrap').hidden = S.mode !== 'fiscal';
    const selPer = $('f-speriod');
    $('f-prev').disabled = selPer.selectedIndex >= selPer.options.length - 1;
    $('f-next').disabled = selPer.selectedIndex <= 0;
    const sel = selection();
    $('f-range').textContent = sel.from.replace(/-/g, '/') + ' 〜 ' + sel.fullTo.replace(/-/g, '/') + sel.note;
    const t = analyze(sel.from, sel.to, sel.sites);
    const g = goalRate();
    const gi = renderGoal(sel);
    $('res-note').textContent = sel.lastTo < sel.fullTo ? `（〜${Number(sel.lastTo.slice(5, 7))}/${Number(sel.lastTo.slice(8))}の実績）` : '（実績）';
    // 生産重量・工数は値を、売上額・損益は目標に対する割合を表示する(1行に4枚)
    let sVal = '—', sCls = '';
    if (gi && gi.goalSales > 0) {
      const ratio = t.sales / gi.goalSales, rest = 1 - ratio;
      sVal = fmt(ratio * 100, 0);
      sCls = gi.progress ? '' : (rest > 0.005 ? 'bad' : 'good');
    }
    const pr = t.profitRate !== null ? t.profitRate * 100 : null;
    $('cards').innerHTML = [
      card('生産重量', fmt(t.weight, 1), 't', ''),
      card('1t当たり人工数', fmt(t.ninkuPerTon, 2), '人工/t', `総工数 ${fmt(t.hours, 0)}h`),
      card('売上額（概算）', sVal, sVal === '—' ? '' : '%', '', sCls),
      card('損益（概算）', pr === null ? '—' : pr.toFixed(1), pr === null ? '' : '%', `（目標${fmt(g, g % 1 ? 1 : 0)}%）`, pr === null ? '' : (pr >= g - 1e-9 ? 'good' : pr < 0 ? 'bad' : 'warn')),
    ].join('');
    $('s-note').textContent = '売上=加工単価×重量、仕入=実行予算(完了は実際・未完は予算)、人件費=労務費、その他固定費=月額' + fmt(OTHER_FIXED_MONTHLY / 1e4, 0) + '万円(3工場合計)で概算。単価が無い工事は売上・損益に入れていません。';
  }

  /* ===================== 工場別の目標値 =====================
   - 単価・費用: 直近12か月度(締まった月度)の工場ごとの実績(加工単価・仕入単価・1人工当たり労務費)
   - 工数: 在職中人数 × 8h × 標準出勤日数(その年度の出勤日数 ÷ 12)。名簿が無い工場は直近12か月度の月平均
   - 生産重量: 3工場合計で 損益 = 売上 × 目標利益率 になる量を、各工場の上限(過去最高の実績)の同じ割合 θ で割り振る
     (上限 = 1出勤日あたり生産量の過去最高 × 標準出勤日数、ただし 1t当たり人工数が過去最高(最少)を下回らない量)。θ > 1 なら上限を超える(⚠) */
  function recentWindow() {
    const last = S.lastYmd;
    if (!last) return null;
    const lastKey = C.periodKeyOf(last);
    const endKey = last === C.periodRange(lastKey).to ? lastKey : C.shiftPeriod(lastKey, -1);
    const first = C.periodKeyOf(state.model.analysisFrom);
    let startKey = C.shiftPeriod(endKey, -(FIXED_BASE - 1));
    if (startKey < first) startKey = first;
    if (endKey < startKey) return null;
    return { startKey, endKey, n: 0 };
  }

  function pastBest(cal, win) {
    const agg = {};
    state.model.cells.forEach((c) => {
      if (c.period < win.startKey || c.period > win.endKey) return;
      const a = (agg[c.site] = agg[c.site] || {}), m = (a[c.period] = a[c.period] || { w: 0, h: 0 });
      m.w += c.weight; m.h += c.hours;
    });
    const out = {};
    SITE_LIST.forEach((site) => {
      let daily = null, n = null;
      Object.keys(agg[site] || {}).forEach((k) => {
        const m = agg[site][k], rg = C.periodRange(k), d = workDaysIn(cal, rg.from, rg.to);
        if (!(m.w > 0) || !(d > 0)) return;
        if (daily === null || m.w / d > daily) daily = m.w / d;
        const x = m.h / 8 / m.w;
        if (m.h > 0 && (n === null || x < n)) n = x;
      });
      out[site] = { daily, npt: n };
    });
    return out;
  }

  function stdPlan(sel) {
    const cal = calendar(), p = goalRate() / 100;
    const fy = C.fiscalRange(C.fiscalYearOf(C.periodKeyOf(sel.from)));
    const dStd = workDaysIn(cal, fy.from, fy.to) / 12;
    const win = recentWindow();
    if (!win || !(dStd > 0)) return null;
    const months = (() => { let n = 0; for (let k = win.startKey; k <= win.endKey; k = C.shiftPeriod(k, 1)) n++; return n; })();
    const wFrom = C.periodRange(win.startKey).from, wTo = C.periodRange(win.endKey).to;
    const best = pastBest(cal, win), hc = headcount();
    const rows = SITE_LIST.map((site) => {
      const a = analyze(wFrom, wTo, [site]), b = best[site] || {};
      const P = a.unitPrice || 0, v = a.varPerTon || 0, L = a.laborRate || 0;
      const H = hc[site] > 0 ? hc[site] * 8 * dStd : a.hours / months;
      let cap = 0;
      if (P > 0 && b.daily > 0) cap = Math.min(b.daily * dStd, b.npt > 0 && H > 0 ? H / 8 / b.npt : Infinity);
      return { site, P, v, L, F: 0, H, cap, people: hc[site] || 0 };
    });
    // 月額のその他固定費を、工数(在職人数)の比で工場へ配分
    const sumH = rows.reduce((x, r) => x + r.H, 0);
    rows.forEach((r) => { r.F = sumH > 0 ? OTHER_FIXED_MONTHLY * r.H / sumH : OTHER_FIXED_MONTHLY / rows.length; });
    const den = rows.reduce((x, r) => x + r.cap * (r.P * (1 - p) - r.v), 0);
    const need = rows.reduce((x, r) => x + r.H / 8 * r.L + r.F, 0);
    const th = den > 0 ? Math.max(0, need / den) : null;
    rows.forEach((r) => { r.w = th === null ? null : th * r.cap; r.over = th !== null && th > 1.0005 && r.cap > 0; });
    return { rows, th, dStd, reach: th !== null && th <= 1.0005, from: win.startKey, to: win.endKey };
  }

  /* 選んだ工場・期間(月〆=1か月、年度=12か月)の標準の目標をまとめる */
  function stdScope(plan, sel) {
    const m = sel.mode === 'fiscal' ? 12 : 1, set = new Set(sel.sites);
    const rs = plan.rows.filter((r) => set.has(r.site));
    if (plan.th === null || !rs.length) return null;
    const W = rs.reduce((x, r) => x + r.w, 0), H = rs.reduce((x, r) => x + r.H, 0);
    if (!(W > 0)) return null;
    const sales = rs.reduce((x, r) => x + r.w * r.P, 0), vari = rs.reduce((x, r) => x + r.w * r.v, 0);
    const labor = rs.reduce((x, r) => x + r.H / 8 * r.L, 0), F = rs.reduce((x, r) => x + r.F, 0);
    return { W: W * m, H: H * m, n: H / 8 / W, P: sales / W, v: vari / W, laborRate: H > 0 ? labor / (H / 8) : 0, labor: labor * m, fixedOther: F * m,
      people: rs.reduce((x, r) => x + r.people, 0), over: rs.some((r) => r.over), mult: m };
  }

  /* 目標の表(紫の欄)・グラフ・工場別の目標値の表を描く */
  function renderGoal(sel) {
    const box = $('goal'), chartBox = $('goal-chart');
    const g = goalRate(), gl = fmt(g, g % 1 ? 1 : 0) + '%', p = g / 100;
    const plan = stdPlan(sel), T = plan ? stdScope(plan, sel) : null;
    renderTargetsTable(plan, sel, p);
    const cur = sel.lastTo < sel.fullTo;
    const t = analyze(sel.from, sel.lastTo, sel.sites); // 実績(ここまで)
    if (!T || !(t.weight > 0 || cur)) { box.hidden = true; chartBox.hidden = true; return null; }
    box.hidden = false; chartBox.hidden = false;
    const phr = (html) => String(html || '').split(/(?=（)|\|/).filter((x) => x !== '').map((x) => `<span class="ph">${x}</span>`).join('');
    const row = (label, value, unit, note, cls) => `<div class="gLabel">${label}</div><div class="gVal ${cls || ''}">${value}<span class="unit">${unit || ''}</span></div><div class="gNote">${phr(note)}</div>`;
    const cmp = (d, unit, digits, goodWhenPlus) => {
      if (Math.abs(d) < 0.5 * Math.pow(10, -digits)) return '<span class="pos">目標どおり</span>';
      const good = goodWhenPlus ? d > 0 : d < 0;
      return `<span class="${good ? 'pos' : 'neg'}">${d > 0 ? '+' : '−'}${fmt(Math.abs(d), digits)}${unit}</span>`;
    };
    const isAll = sel.sites.length === SITE_LIST.length;
    const unitLbl = sel.mode === 'fiscal' ? '年度・12か月分' : '1か月';
    let head, lead, rows, x, label;
    const A = t;
    const aRate = A.profitRate;
    if (!cur) {
      const ok = A.weight >= T.W - 0.05;
      head = `目標（${unitLbl}）に届いたか（${sel.reiwa}）`;
      lead = ok ? `<span class="pos">✓ 実績で目標生産量を達成</span><span class="gLeadSub">（実績 ${ton(A.weight)}t／目標 ${ton(T.W)}t）</span>`
        : `<span class="neg">目標生産量に <b>${ton(T.W - A.weight)}t</b> 届きませんでした</span><span class="gLeadSub">（実績 ${ton(A.weight)}t／目標 ${ton(T.W)}t）</span>`;
      rows = [
        row('生産重量', ton(T.W), 't', `実績 ${ton(A.weight)}t（${cmp(A.weight - T.W, 't', 1, true)}）`),
        row('工数', fmt(T.H, 0), 'h', `実績 ${fmt(A.hours, 0)}h（${cmp(A.hours - T.H, 'h', 0, false)}）`),
        row('1t当たり人工数', npt(T.n), '人工/t', `実績 ${npt(A.ninkuPerTon)}（${A.ninkuPerTon === null ? '—' : cmp(A.ninkuPerTon - T.n, '', 2, false)}）`),
        row('利益率', fmt(g, g % 1 ? 1 : 0), '%', aRate === null ? '実績 —' : `実績 <span class="${aRate >= p - 1e-9 ? 'pos' : aRate < 0 ? 'neg' : 'warn'}">${fmt(aRate * 100, 1)}%</span>` + (isAll ? `（${cmp((aRate - p) * 100, 'ポイント', 1, true)}）` : '')),
      ].join('');
      x = A.weight; label = '実績';
    } else {
      // 期間の途中: 残りの出勤日で あと何tを何時間で
      const cal = calendar();
      const next = utcToYmd(ymdToUtc(sel.lastTo) + 86400000);
      const doneDays = workDaysIn(cal, sel.from, sel.lastTo), leftDays = workDaysIn(cal, next, sel.fullTo);
      const perDayH = T.people > 0 ? T.people * 8 : (doneDays > 0 ? t.hours / doneDays : 0);
      const need = Math.max(0, T.W - t.weight), needDay = leftDays > 0 ? need / leftDays : null, perDayW = doneDays > 0 ? t.weight / doneDays : 0;
      // 工場ごとの1日あたり生産量(工場の目標−工場の実績を残りの出勤日で割る。整数)。例: （本社52_夢前55_鳥取31）
      const siteDay = sel.sites.length > 1 && leftDays > 0 ? '<small>（' + plan.rows.filter((r) => sel.sites.indexOf(r.site) >= 0).map((r) => {
        const a = analyze(sel.from, sel.lastTo, [r.site]).weight;
        return r.site + fmt(Math.max(0, r.w * T.mult - a) / leftDays, 0);
      }).join('_') + '）</small>' : '';
      head = `目標（${unitLbl}）を達成するには（${sel.reiwa}）`;
      lead = need <= 0 ? `<span class="pos">✓ 目標生産量に到達済み</span><span class="gLeadSub">（実績 ${ton(t.weight)}t／目標 ${ton(T.W)}t）</span>`
        : leftDays > 0 ? `残り <b>${leftDays}</b>出勤日で あと <b class="gKey">${ton(need)}t</b> を <b class="gKey">${fmt(perDayH * leftDays, 0)}h</b>`
          : '<span class="neg">残りの出勤日がありません</span>';
      rows = [
        row('目標生産量', ton(T.W), 't', `実績 ${ton(t.weight)}t ＋ 残り ${ton(need)}t`),
        row('目標工数', fmt(T.H, 0), 'h', `実績 ${fmt(t.hours, 0)}h ＋|残り ${fmt(perDayH * leftDays, 0)}h（1日 ${fmt(perDayH, 0)}h × ${leftDays}日）`),
        row('1日あたり生産量' + siteDay, needDay !== null && need > 0 ? ton(needDay) : '—', 't/日', needDay !== null && need > 0 ? `実績 ${ton(perDayW)}t/日（${perDayW > 0 ? fmt(needDay / perDayW, 2) + '倍' : '—'}）` : ''),
        row('1日あたり工数', fmt(perDayH, 0), 'h/日', (T.people > 0 ? `1日８時間×${T.people}人＝${fmt(T.people * 8, 0)}h` : '従業員名簿が読めないため、これまでのペースで計算') + (doneDays > 0 ? `（実績 ${fmt(t.hours / doneDays, 0)}h/日）` : '')),
        row('目標の1t当たり人工数', npt(T.n), '人工/t', t.ninkuPerTon === null || !(T.n > 0) ? '' : `実績 ${npt(t.ninkuPerTon)}` + (t.ninkuPerTon <= T.n + 1e-9 ? '（<span class="pos">目標達成</span>）' : `（生産${fmt(Math.max(0, t.hours / 8 / T.n - t.weight), 1)}tアップで目標達成）`)),
      ].join('');
      x = t.weight; label = '実績';
    }
    box.querySelector('.gHead').innerHTML = head;
    box.querySelector('.gLead').innerHTML = lead;
    box.querySelector('.gTable').innerHTML = rows;

    // グラフ: 選んだ期間の実績の単価・費用で描く。期間の途中は今のペースの見込み(点線)。★=標準の目標の目標生産量
    let base, cx = x, clabel = label, cn;
    if (!cur) {
      base = analyze(sel.from, sel.fullTo, sel.sites);
      cn = base.ninkuPerTon || 0;
    } else {
      const cal = calendar();
      const next = utcToYmd(ymdToUtc(sel.lastTo) + 86400000);
      const doneDays = workDaysIn(cal, sel.from, sel.lastTo), leftDays = workDaysIn(cal, next, sel.fullTo);
      let rt = t;
      if (doneDays < 3 || !(t.unitPrice > 0)) {
        const fyR = C.fiscalRange(C.fiscalYearOf(C.periodKeyOf(sel.from)));
        const tf = analyze(fyR.from, sel.lastTo, sel.sites);
        if (tf.unitPrice > 0) rt = tf;
      }
      const perDayH = T.people > 0 ? T.people * 8 : (doneDays > 0 ? t.hours / doneDays : 0);
      const H = t.hours + perDayH * leftDays, few = doneDays < 3;
      const Wp = few ? T.W : t.weight + (doneDays > 0 ? t.weight / doneDays : 0) * leftDays;
      base = { unitPrice: rt.unitPrice, varPerTon: rt.varPerTon, laborRate: rt.laborRate, fixed: fixedFor(sel.from, sel.fullTo, sel.sites) };
      cx = Wp; clabel = few ? '目標' : '見込み'; cn = Wp > 0 ? H / 8 / Wp : 0;
    }
    const P = base.unitPrice || 0;
    const r = simulate(base, cx, cn, P, p);
    drawBep('c-goal', { fixed: r.fixed + r.labor, unitPrice: r.unitPrice, laborPerTon: 0, varPerTon: r.varPerTon, profitRate: p,
      fixedLabel: ['固定費', '(人件費込み)'], otherFixed: r.fixed, laborRate: r.laborRate,
      x: cx, fixedX: true, beTons: r.breakEvenTons, goalTons: T.W, handleLabel: clabel, hideMoney: true });
    placeTargets(); requestAnimationFrame(placeTargets);
    return { goalSales: T.W * T.P, progress: cur };
  }

  function renderTargetsTable(plan, sel, p) {
    const el = $('goal-targets');
    if (!plan) { el.hidden = true; return; }
    const m = sel.mode === 'fiscal' ? 12 : 1, g = fmt(p * 100, (p * 100) % 1 ? 1 : 0) + '%';
    const tr = (name, w, h, cls, over) => `<tr class="${cls || ''}"><td>${esc(name)}</td><td>${w !== null && w > 0 ? (over ? '⚠' : '') + ton(w * m) : '—'}</td><td>${fmt(h * m, 0)}</td><td>${w > 0 ? npt(h / 8 / w) : '—'}</td></tr>`;
    const W = plan.th === null ? null : plan.rows.reduce((x, r) => x + r.w, 0), H = plan.rows.reduce((x, r) => x + r.H, 0);
    const head = plan.th === null ? '<b class="neg">今の単価・費用では目標に届きません</b>'
      : `${m === 12 ? '年度（1か月×12）' : '1か月あたり'}・3工場合計で目標利益率${g}${plan.reach ? '' : '　<b class="neg">⚠ 過去の実績を超える</b>'}`;
    el.innerHTML = `<div class="tgHead">【目標値】<small>${head}</small></div>
      <table><tr><th>工場</th><th>生産重量(t)</th><th>工数(h)</th><th>人工数(人工/t)</th></tr>
      ${tr('3工場', W, H, 'tot')}${plan.rows.map((r) => tr(r.site, r.w, r.H, '', r.over)).join('')}</table>
      <div class="tgNote">上限: 直近${FIXED_BASE}か月度の各工場の最高実績（1日あたり生産量・人工数）以内${plan.reach ? '' : '。⚠は上限超え'}</div>`;
    el.hidden = false;
  }

  /* 表の位置(PC): グラフ内で、線や文字・欄と重ならない場所に置く(simple.js と同じ配置ロジック)。スマホはグラフの下(CSS) */
  function placeTargets() {
    const el = $('goal-targets'), panel = $('goal-chart'), svg = panel.querySelector('#c-goal svg');
    if (el.hidden || !svg || getComputedStyle(el).position !== 'absolute') return;
    const pr = panel.getBoundingClientRect(), sr = svg.getBoundingClientRect();
    const ox = sr.left - pr.left, oy = sr.top - pr.top; // svg座標 → パネル座標
    const w = el.offsetWidth, h = el.offsetHeight, SW = sr.width, SH = sr.height, M = 6;
    const segs = [...svg.querySelectorAll('line')].filter((l) => !l.classList.contains('bg')).map((l) => ['x1', 'y1', 'x2', 'y2'].map((k) => +l.getAttribute(k)));
    const rects = [...svg.querySelectorAll('text, rect, circle')].filter((e) => !e.closest('.beInfo') || e.matches('text')).map((e) => { try { const b = e.getBBox(); return b.width > 0 ? b : null; } catch (x) { return null; } }).filter(Boolean);
    // 線分が長方形の中を通る長さ(Liang–Barsky)
    const clipLen = (x0, y0, x1, y1, r) => {
      let t0 = 0, t1 = 1; const dx = x1 - x0, dy = y1 - y0;
      for (const [pp, q] of [[-dx, x0 - r.x], [dx, r.x + r.w - x0], [-dy, y0 - r.y], [dy, r.y + r.h - y0]]) {
        if (pp === 0) { if (q < 0) return 0; continue; }
        const t = q / pp;
        if (pp < 0) { if (t > t1) return 0; if (t > t0) t0 = t; } else { if (t < t0) return 0; if (t < t1) t1 = t; }
      }
      return Math.hypot(dx, dy) * (t1 - t0);
    };
    const area = (a, b) => Math.max(0, Math.min(a.x + a.w, b.x + b.width) - Math.max(a.x, b.x)) * Math.max(0, Math.min(a.y + a.h, b.y + b.height) - Math.max(a.y, b.y));
    if (svg.dataset.placed) return; // 同じ描画に対しては1回だけ(欄を二重に動かさない)
    svg.dataset.placed = '1';
    const bg = svg.querySelector('.beBg'), bb = bg ? bg.getBBox() : { x: 60, y: 40, width: 0, height: 0 };
    // ① 表をグラフの左上に置き、「損益分岐値」の欄を表の右隣へ移す(引き出し線も付け替える)。線や文字と重ならなければこれで決定
    const info = svg.querySelector('.beInfo'), lead = svg.querySelector('.beLead');
    if (bg && info && lead) {
      const tx = bb.x, ty = M + 4, tr = { x: tx - 4, y: ty - 4, w: w + 8, h: h + 8 };
      const lx1 = +lead.getAttribute('x1'), ly1 = +lead.getAttribute('y1');
      const others = segs.filter((q) => !(q[0] === lx1 && q[1] === ly1)); // 引き出し線以外の線
      const textRects = [...svg.querySelectorAll('.goalLbl, .goalBg, .handle rect, .handle text, .lbl.seg, .lbl.lineLbl')].map((e) => { try { return e.getBBox(); } catch (x) { return null; } }).filter(Boolean);
      const free = (r) => others.reduce((a, q) => a + clipLen(q[0], q[1], q[2], q[3], r), 0) === 0 && textRects.every((bx) => area(r, bx) === 0);
      const cands = [[tx, ty + h + 12], [tx + w + 14, ty]]; // 欄の移動先の候補: 表の下(左端をそろえる) → 表の右隣
      if (free(tr)) for (const [nx, ny] of cands) {
        const dx = nx - bb.x, dy = ny - bb.y, nb = { x: nx, y: ny, w: bb.width, h: bb.height };
        const lx2 = +lead.getAttribute('x2') + dx, ly2 = +lead.getAttribute('y2') + dy;
        if (nb.x + nb.w > SW - M || nb.y + nb.h > SH - 24 || !free(nb) || clipLen(lx1, ly1, lx2, ly2, tr) > 0) continue;
        info.setAttribute('transform', `translate(${dx} ${dy})`); bg.setAttribute('transform', `translate(${dx} ${dy})`);
        lead.setAttribute('x2', lx2); lead.setAttribute('y2', ly2);
        el.style.left = (ox + tx) + 'px'; el.style.top = (oy + ty) + 'px';
        return;
      }
    }
    // ② 移せないとき: 空いている場所を探す(引き出し線との重なりは特に避ける)
    const px = bb.x, py = bb.y + bb.height + 10; // 希望の位置: 損益分岐値の欄の真下
    let best = null;
    for (let y = M; y + h <= SH - 24; y += 8) for (let x = M; x + w <= SW - M; x += 8) {
      const r = { x: x - 4, y: y - 4, w: w + 8, h: h + 8 };
      const hit = segs.reduce((a, q) => a + clipLen(q[0], q[1], q[2], q[3], r) * (lead && q[0] === +lead.getAttribute('x1') && q[1] === +lead.getAttribute('y1') ? 20 : 1), 0) + rects.reduce((a, b) => a + area(r, b) / 50, 0);
      const score = hit * 1000 + Math.hypot(x - px, y - py);
      if (!best || score < best.score) best = { score, x, y };
    }
    if (!best) best = { x: px, y: py };
    el.style.left = (ox + best.x) + 'px'; el.style.top = (oy + best.y) + 'px';
  }

  window.CIKit = { SITE_LIST, OTHER_FIXED_MONTHLY, fixedFor, siteShare, analyze, workDaysIn, ymdToUtc, utcToYmd, calendar, goalRate, lastDataYmd };
  window.SimpleView = { show };
})();
