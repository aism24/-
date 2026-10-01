/*
 * コストインサイト 画面
 *   GAS(getData)から 生産重量・工数(cache)・工事マスタ等(settings)・実行予算(budget)を受け取り、
 *   calc.js(CICalc)で 3つの単価・損益 を計算して、工事別/工場別/期間別 のグラフと表にする。
 */
'use strict';

// GAS(スプレッドシート「コストインサイト」のウェブアプリ)
const GAS_API_URL = 'https://script.google.com/macros/s/AKfycbwDhzAWpmCmwrLoFM6gS1GDWYWcc7OvqjdGa7HNObCTednh-FttOPdF3JZlOQVe-Y3Q0A/exec';
const SITES = ['本社', '夢前', '鳥取'];
// 系列の色(識別用。順番固定)。加工単価=青、仕入単価=オレンジ、時間単価=アクア。損益は 黒字=青 / 赤字=赤
const COLOR = { proc: '#2a78d6', purchase: '#eb6834', hour: '#1baf7a', plus: '#2a78d6', minus: '#e34948', grid: '#e1e0d9', muted: '#898781' };

const state = { data: null, model: null, tab: 'work', charts: [], edits: {}, view: 'menu' };

const fmt = (v, d) => (v === null || v === undefined || !isFinite(v)) ? '—' : Number(v).toLocaleString('ja-JP', { minimumFractionDigits: d || 0, maximumFractionDigits: d || 0 });
const man = v => (v === null || v === undefined || !isFinite(v)) ? '—' : fmt(v / 1e4); // 万円
const pct = v => (v === null || v === undefined || !isFinite(v)) ? '—' : (v * 100).toFixed(1) + '%';
const esc = s => String(s === null || s === undefined ? '' : s).replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
const est = on => on ? '<span class="est" title="見込みを含む">見込</span>' : '';
const pad2 = n => (n < 10 ? '0' : '') + n;
const todayYmd = () => { const d = new Date(); return d.getFullYear() + '-' + pad2(d.getMonth() + 1) + '-' + pad2(d.getDate()); };

/* ===================== 読み込み(ポップアップに進み具合を出す) ===================== */

// GASの応答は途中経過が取れないため、経過時間で 90% に近づくように進め、受信したら 100% にする
function startLoadingBar() {
  const fill = document.getElementById('ld-fill'), sub = document.getElementById('ld-sub');
  const t0 = Date.now();
  const tick = () => {
    const sec = (Date.now() - t0) / 1000;
    const p = Math.floor(90 * (1 - Math.exp(-sec / 10)));
    fill.style.width = p + '%';
    sub.textContent = p + '% ・ ' + Math.floor(sec) + '秒';
  };
  tick();
  const timer = setInterval(tick, 300);
  return {
    done() { clearInterval(timer); fill.style.width = '100%'; sub.textContent = '100% ・ 読み込み完了'; },
    fail(msg) {
      clearInterval(timer);
      document.getElementById('ld-title').textContent = '読み込みに失敗しました';
      const err = document.getElementById('ld-err');
      err.hidden = false;
      err.innerHTML = esc(msg) + '<br><button class="btn" type="button" onclick="location.reload()">再読み込み</button>';
    },
  };
}

async function gasGet(action) {
  const res = await fetch(GAS_API_URL + '?action=' + action);
  const text = await res.text();
  let body;
  try { body = JSON.parse(text); } catch (e) { throw new Error('GASの応答を読めませんでした(HTTP ' + res.status + ')'); }
  if (body.status !== 'success') throw new Error(body.message || 'GASのエラー');
  return body.data;
}

// 受け取ったデータを画面の状態に入れ、受信時刻の表示を更新する
function applyData(d) {
  state.data = d;
  state.model = CICalc.build(d);
  const b = d.budget;
  document.getElementById('status').textContent = '生産・日報の集計: ' + new Date(d.cache.generatedAt).toLocaleString('ja-JP')
    + ' / 実行予算の受信: ' + (b ? new Date(b.at).toLocaleString('ja-JP') : 'まだ受信していません');
  document.getElementById('budget').textContent = b ? '最終受信: ' + new Date(b.at).toLocaleString('ja-JP') + '(' + Object.keys(b.rows || {}).length + 'ファイル)' : '最終受信: まだ受信していません';
}

async function load() {
  const bar = startLoadingBar();
  try {
    applyData(await gasGet('getData'));
    setupFilters();
    setupYearFilter();
    renderSettings();
    bar.done();
    setTimeout(() => document.getElementById('loading').classList.add('done'), 300);
    document.querySelectorAll('.menu-btn').forEach(b => { b.disabled = false; });
  } catch (e) {
    bar.fail(e.message + '(ページを再読み込みしてください)');
  }
}

/* ===================== 実行予算の取込の完了を待って自動で反映 ===================== */

// ［実行予算取込］を押したら、GASの最終受信時刻(?action=budget)を10秒おきに確認し、
// 変わったら(＝取込が終わったら)データを取り直して画面に反映する。30分で待つのをやめる。
const WATCH = { timer: null, t0: 0, baseAt: null, busy: false };
function startImportWatch() {
  WATCH.baseAt = state.data && state.data.budget ? state.data.budget.at : null;
  WATCH.t0 = Date.now();
  if (WATCH.timer) clearInterval(WATCH.timer);
  WATCH.timer = setInterval(checkImport, 10000);
  showImportStatus('', '取込を待っています…(黒い画面が閉じると、自動で反映してホームに戻ります)');
}

function showImportStatus(cls, text) {
  const el = document.getElementById('imp-status');
  el.hidden = false;
  el.className = 'imp-status' + (cls ? ' ' + cls : '');
  el.textContent = text;
}

async function checkImport() {
  if (WATCH.busy) return;
  const sec = Math.floor((Date.now() - WATCH.t0) / 1000);
  if (sec > 30 * 60) {
    clearInterval(WATCH.timer); WATCH.timer = null;
    showImportStatus('ng', '30分たっても取込の結果が届きませんでした。黒い画面にエラーが出ていないか確認し、もう一度［実行予算取込］を押してください(何も起きない場合は①の初期設定を行ってください)。');
    return;
  }
  WATCH.busy = true;
  try {
    const t = (await gasGet('budget')).today;
    if (t && t.at !== WATCH.baseAt) {
      clearInterval(WATCH.timer); WATCH.timer = null;
      showImportStatus('', '取込結果を読み込んでいます…');
      applyData(await gasGet('getData'));
      renderSettings();
      render();
      // 「実行予算取込完了＿ホームに戻ります」を2秒出してからホーム(メニュー)へ戻る
      document.getElementById('imp-status').hidden = true;
      const toast = document.getElementById('toast');
      toast.hidden = false;
      setTimeout(() => { toast.hidden = true; showView('menu'); }, 2000);
    } else {
      showImportStatus('', '取込を待っています…(経過 ' + Math.floor(sec / 60) + '分' + (sec % 60) + '秒。黒い画面が閉じると、自動で反映してホームに戻ります)');
    }
  } catch (e) {
    showImportStatus('ng', '確認に失敗しました。再確認します…(' + e.message + ')');
  } finally {
    WATCH.busy = false;
  }
}

/* ===================== 画面の切り替え(メニュー / 3つのモード) ===================== */

function showView(name) {
  state.view = name;
  document.querySelectorAll('.view').forEach(v => { v.hidden = v.id !== 'v-' + name; });
  window.scrollTo(0, 0);
  if (name === 'progress') render(); // グラフは表示されてから描く(非表示のままだと大きさが決まらない)
}
document.querySelectorAll('[data-go]').forEach(b => b.addEventListener('click', () => showView(b.dataset.go)));

/* ===================== 絞り込み ===================== */

function setupFilters() {
  const m = state.model;
  const from = m.analysisFrom, last = m.cells.reduce((x, c) => c.ymd > x ? c.ymd : x, from);
  // 期(11/21始まり)と月度の一覧(分析できる期間のみ)
  const fySel = document.getElementById('f-fy'), pSel = document.getElementById('f-period');
  const fys = [], periods = [];
  for (let p = CICalc.periodKeyOf(from); p <= CICalc.periodKeyOf(last); p = CICalc.shiftPeriod(p, 1)) {
    periods.push(p);
    const fy = CICalc.fiscalYearOf(p);
    if (fys.indexOf(fy) < 0) fys.push(fy);
  }
  fySel.innerHTML = fys.slice().reverse().map(fy => `<option value="${fy}">${fy}/11/21〜${fy + 1}/11/20期</option>`).join('');
  pSel.innerHTML = periods.slice().reverse().map(p => `<option value="${p}">${CICalc.periodLabel(p)}(${CICalc.periodRange(p).from.slice(5).replace('-', '/')}〜${CICalc.periodRange(p).to.slice(5).replace('-', '/')})</option>`).join('');
  const fromIn = document.getElementById('f-from'), toIn = document.getElementById('f-to');
  fromIn.min = toIn.min = from; fromIn.max = toIn.max = last;
  fromIn.value = from; toIn.value = last;
  document.getElementById('f-min').textContent = from.replace(/-/g, '/');
  document.getElementById('f-sites').innerHTML = SITES.map(s => `<label><input type="checkbox" value="${s}" checked> ${s}</label>`).join(' ');
  document.querySelectorAll('#filters select, #filters input').forEach(el => el.addEventListener('change', render));
  document.querySelectorAll('.tab').forEach(b => b.addEventListener('click', () => { state.tab = b.dataset.tab; render(); }));
}

function currentRange() {
  const m = state.model, mode = document.querySelector('input[name="f-mode"]:checked').value;
  let from, to;
  if (mode === 'fy') { const r = CICalc.fiscalRange(Number(document.getElementById('f-fy').value)); from = r.from; to = r.to; }
  else if (mode === 'period') { const r = CICalc.periodRange(document.getElementById('f-period').value); from = r.from; to = r.to; }
  else { from = document.getElementById('f-from').value; to = document.getElementById('f-to').value; }
  if (!from || from < m.analysisFrom) from = m.analysisFrom; // 生産重量が無い期間は選べない
  if (!to) to = todayYmd();
  return { from, to };
}

function currentFilter() {
  const r = currentRange();
  return {
    from: r.from, to: r.to,
    sites: Array.from(document.querySelectorAll('#f-sites input:checked')).map(i => i.value),
    doneOnly: document.getElementById('f-done').checked,
  };
}

/* ===================== 描画 ===================== */

function render() {
  const m = state.model;
  if (!m || state.view !== 'progress') return;
  document.querySelectorAll('.tab').forEach(b => b.classList.toggle('on', b.dataset.tab === state.tab));
  const mode = document.querySelector('input[name="f-mode"]:checked').value;
  document.getElementById('f-fy').disabled = mode !== 'fy';
  document.getElementById('f-period').disabled = mode !== 'period';
  document.getElementById('f-from').disabled = document.getElementById('f-to').disabled = mode !== 'range';

  const f = currentFilter();
  const cells = CICalc.filterCells(m, f);
  const total = CICalc.summarize(cells);
  document.getElementById('range-note').textContent = '対象: ' + f.from.replace(/-/g, '/') + '〜' + f.to.replace(/-/g, '/')
    + ' / ' + (f.sites.length ? f.sites.join('・') : '工場なし') + (f.doneOnly ? ' / 完了の工事のみ' : '');
  renderKpis(total);

  let rows;
  if (state.tab === 'work') rows = workRows(cells);
  else if (state.tab === 'site') rows = f.sites.map(s => ({ key: s, label: s, t: CICalc.summarize(cells.filter(c => c.site === s)) }));
  else {
    const g = CICalc.groupBy(cells, c => c.period);
    rows = Object.keys(g).sort().map(p => ({ key: p, label: CICalc.periodLabel(p), t: g[p] }));
  }
  // グラフには単価か損益がある行だけ出す(実行予算なし等の工事で空き枠が並ばないように)
  renderCharts(rows.filter(r => r.t.procUnit !== null || r.t.hourRate !== null || r.t.profitSales > 0));
  renderTable(rows, total);
  renderNotes(cells);
}

// 工事別の行。単価は工事ごとに決まった値、金額は期間内のセルの合計
function workRows(cells) {
  const m = state.model, g = {};
  cells.forEach(c => { (g[c.no] || (g[c.no] = [])).push(c); });
  return Object.keys(g).sort().map(no => {
    const w = m.works[no];
    return { key: no, label: no + ' ' + w.name, w, t: CICalc.summarize(g[no]) };
  }).filter(r => r.t.weight > 0 || r.t.hours > 0);
}

function renderKpis(t) {
  const k = (label, value, unit, sub) => `<div class="kpi"><div class="kpi-l">${label}</div><div class="kpi-v">${value}<small>${unit}</small></div><div class="kpi-s">${sub || ''}</div></div>`;
  document.getElementById('kpis').innerHTML = [
    k('1t当たり加工単価', fmt(t.procUnit), '円/t', '売上 ' + man(t.sales) + '万円'),
    k('1t当たり仕入単価', fmt(t.purchaseUnit) + est(t.purchaseEst), '円/t', '仕入 ' + man(t.purchase) + '万円'),
    k('1時間当たり単価', fmt(t.hourRate) + est(t.laborEst), '円/h', '労務費 ' + man(t.labor) + '万円'),
    k('損益', man(t.profit), '万円', '利益率 ' + pct(t.profitRate)),
    k('生産重量', fmt(t.weight, 1), 't', '工数 ' + fmt(t.hours) + 'h(人工/t ' + (t.weight > 0 ? (t.hours / 8 / t.weight).toFixed(2) : '—') + ')'),
  ].join('');
}

function destroyCharts() { state.charts.forEach(c => c.destroy()); state.charts = []; }

function baseOptions(yTitle) {
  return {
    responsive: true, maintainAspectRatio: false, animation: false,
    interaction: { mode: 'index', intersect: false },
    plugins: {
      legend: { position: 'top', align: 'start', labels: { boxWidth: 12, color: '#52514e' } },
      tooltip: { callbacks: { label: ctx => ctx.dataset.label + ': ' + fmt(ctx.parsed.y) + ' ' + yTitle } },
    },
    scales: {
      x: { grid: { display: false }, ticks: { color: COLOR.muted, maxRotation: 60, autoSkip: true } },
      y: { title: { display: true, text: yTitle, color: COLOR.muted }, grid: { color: COLOR.grid }, ticks: { color: COLOR.muted, callback: v => fmt(v) } },
    },
  };
}

function renderCharts(rows) {
  destroyCharts();
  const isPeriod = state.tab === 'period';
  const labels = rows.map(r => state.tab === 'work' ? r.key : r.label);
  const type = isPeriod ? 'line' : 'bar';
  const ds = (label, data, color, extra) => Object.assign(isPeriod
    ? { label, data, borderColor: color, backgroundColor: color, borderWidth: 2, pointRadius: 4, pointHoverRadius: 6, spanGaps: true }
    : { label, data, backgroundColor: color, borderRadius: 4, borderSkipped: 'start', maxBarThickness: 28 }, extra || {});
  const nz = v => (v === null || v === undefined || !isFinite(v)) ? null : v;

  // 1) 1t当たり単価(加工・仕入)
  state.charts.push(new Chart(document.getElementById('c-ton'), {
    type, data: { labels, datasets: [
      ds('加工単価', rows.map(r => nz(r.t.procUnit)), COLOR.proc),
      ds('仕入単価', rows.map(r => nz(r.t.purchaseUnit)), COLOR.purchase),
    ] }, options: baseOptions('円/t'),
  }));
  // 2) 1時間当たり単価
  const hopt = baseOptions('円/h');
  hopt.plugins.legend.display = false;
  state.charts.push(new Chart(document.getElementById('c-hour'), {
    type, data: { labels, datasets: [ds('時間単価', rows.map(r => nz(r.t.hourRate)), COLOR.hour)] }, options: hopt,
  }));
  // 3) 損益(黒字=青・赤字=赤)
  const popt = baseOptions('万円');
  popt.plugins.legend.display = false;
  const profits = rows.map(r => r.t.profitSales > 0 ? r.t.profit / 1e4 : null);
  state.charts.push(new Chart(document.getElementById('c-profit'), {
    type: 'bar', data: { labels, datasets: [{ label: '損益', data: profits, backgroundColor: profits.map(v => v < 0 ? COLOR.minus : COLOR.plus), borderRadius: 4, borderSkipped: 'start', maxBarThickness: 28 }] },
    options: popt,
  }));
}

function renderTable(rows, total) {
  const isWork = state.tab === 'work';
  const head = '<tr><th>' + (isWork ? '工事' : state.tab === 'site' ? '工場' : '月度') + '</th>'
    + (isWork ? '<th>完了</th><th class="n">契約総重量(t)</th><th class="n">生産割合</th>' : '')
    + '<th class="n">生産重量(t)</th><th class="n">工数(h)</th><th class="n">人工/t</th>'
    + '<th class="n">加工単価(円/t)</th><th class="n">仕入単価(円/t)</th><th class="n">時間単価(円/h)</th>'
    + '<th class="n">売上(万円)</th><th class="n">仕入(万円)</th><th class="n">労務費(万円)</th><th class="n">損益(万円)</th><th class="n">利益率</th>'
    + (isWork ? '<th>注意</th>' : '') + '</tr>';
  const line = (label, t, w, cls) => {
    const ok = t.profitSales > 0;
    return `<tr class="${cls || ''}"><td class="name">${esc(label)}</td>`
      + (isWork ? `<td>${w && w.done ? '完了' : ''}</td><td class="n">${w ? fmt(w.totalWeight, 1) : ''}</td><td class="n">${w ? pct(w.coverage) : ''}</td>` : '')
      + `<td class="n">${fmt(t.weight, 1)}</td><td class="n">${fmt(t.hours)}</td><td class="n">${t.weight > 0 ? (t.hours / 8 / t.weight).toFixed(2) : '—'}</td>`
      + `<td class="n">${fmt(t.procUnit)}</td><td class="n">${fmt(t.purchaseUnit)}${est(t.purchaseEst)}</td><td class="n">${fmt(t.hourRate)}${est(t.laborEst)}</td>`
      + `<td class="n">${man(t.sales)}</td><td class="n">${man(t.purchase)}</td><td class="n">${man(t.labor)}</td>`
      + `<td class="n ${ok && t.profit < 0 ? 'neg' : ''}">${ok ? man(t.profit) : '—'}</td><td class="n">${ok ? pct(t.profitRate) : '—'}</td>`
      + (isWork ? `<td class="note-cell">${w ? esc(w.notes.join(' / ')) : ''}</td>` : '') + '</tr>';
  };
  document.getElementById('table').innerHTML = head
    + rows.map(r => line(r.label, r.t, r.w, r.w && (r.w.dataShort || !r.w.hasBudget || r.w.procUnit === null) ? 'warnrow' : '')).join('')
    + line('合計', total, null, 'total');
}

function renderNotes(cells) {
  const m = state.model, ng = {};
  cells.forEach(c => { if (!c.ok) { const g = ng[c.no] || (ng[c.no] = { w: 0, h: 0 }); g.w += c.weight; g.h += c.hours; } });
  const list = Object.keys(ng).sort().filter(no => ng[no].w > 0 || ng[no].h > 0);
  const items = [];
  if (list.length) items.push('損益に入れていない工事(実行予算なし・契約金額なし・単価なし): '
    + list.map(no => esc(no + ' ' + m.works[no].name) + '(' + fmt(ng[no].w, 1) + 't/' + fmt(ng[no].h) + 'h)').join('、'));
  items.push('「見込」: 仕入は未完の工事の予算の値、時間単価は労務費の締めより後の工数(直近の確定単価で計算)を含みます。');
  items.push('共通の工数(基本設定の共通扱い工事No・工事No不明)は、同じ工場・同じ月度の各工事に工数比で按分しています。');
  items.push('生産重量のデータは ' + m.analysisFrom.replace(/-/g, '/') + ' からのため、それより前の期間は選べません(時間単価の計算には前の工数・労務費も使っています)。');
  document.getElementById('notes').innerHTML = items.map(t => '<li>' + t + '</li>').join('');
}

/* ===================== 完了・年度の設定(工事データ D・E 列) ===================== */

function yearOptions() {
  const set = {};
  for (let i = 6; i <= new Date().getFullYear() - 2018 + 1; i++) set['R' + i] = true; // R6〜来年度
  Object.values(state.data.settings.works).forEach(w => { if (w.year) set[w.year] = true; });
  return [''].concat(Object.keys(set).sort((a, b) => Number(a.slice(1)) - Number(b.slice(1))));
}

// 実行予算が取り込まれている(契約総重量か契約金額が入っている)工事だけを設定の対象にする
const hasContract = w => (w.totalWeight !== null && w.totalWeight !== undefined) || (w.contract !== null && w.contract !== undefined);

// 年度の絞り込み('' = すべて、'-' = 未設定)
function setupYearFilter() {
  const sel = document.getElementById('set-year');
  sel.innerHTML = '<option value="">すべて</option>'
    + yearOptions().filter(y => y).map(y => `<option value="${y}">${y}</option>`).join('')
    + '<option value="-">(未設定)</option>';
  sel.addEventListener('change', renderSettings);
}

function renderSettings() {
  const works = state.data.settings.works, years = yearOptions();
  const fy = document.getElementById('set-year').value;
  // 年度の絞り込みは保存済みの年度で判定する(行の年度を変えても、保存するまでは表から消えない)
  const nos = Object.keys(works).sort().filter(no => hasContract(works[no])
    && (!fy || (fy === '-' ? !works[no].year : works[no].year === fy)));
  document.getElementById('set-table').innerHTML = '<tr><th>工事No</th><th>工事名</th><th>完了</th><th>年度</th></tr>'
    + nos.map(no => {
      const w = works[no], e = state.edits[no] || {};
      const done = 'done' in e ? e.done : w.done, year = 'year' in e ? e.year : (w.year || '');
      const changed = Object.keys(e).length ? ' class="changed"' : '';
      return `<tr${changed} data-no="${esc(no)}"><td>${esc(no)}</td><td>${esc(w.name)}</td>`
        + `<td class="c"><input type="checkbox" data-k="done"${done ? ' checked' : ''}></td>`
        + `<td><select data-k="year">${years.map(y => `<option value="${y}"${y === year ? ' selected' : ''}>${y || '(未設定)'}</option>`).join('')}</select></td></tr>`;
    }).join('')
    + (nos.length ? '' : '<tr><td colspan="4">該当する工事がありません</td></tr>');
  document.querySelectorAll('#set-table input, #set-table select').forEach(el => el.addEventListener('change', onSettingChange));
  updateSaveButton();
}

function onSettingChange(ev) {
  const tr = ev.target.closest('tr'), no = tr.dataset.no, k = ev.target.dataset.k;
  const w = state.data.settings.works[no];
  const v = k === 'done' ? ev.target.checked : ev.target.value;
  const orig = k === 'done' ? w.done : (w.year || '');
  const e = state.edits[no] || (state.edits[no] = {});
  if (v === orig) delete e[k]; else e[k] = v;
  if (!Object.keys(e).length) delete state.edits[no];
  tr.classList.toggle('changed', !!state.edits[no]);
  updateSaveButton();
}

function updateSaveButton() {
  const n = Object.keys(state.edits).length;
  const btn = document.getElementById('set-save');
  btn.disabled = !n;
  btn.textContent = n ? `更新を保存(${n}件)` : '更新を保存';
}

async function saveSettings() {
  const msg = document.getElementById('set-msg'), btn = document.getElementById('set-save');
  const changes = Object.keys(state.edits).map(no => Object.assign({ no }, state.edits[no]));
  if (!changes.length) return;
  btn.disabled = true;
  msg.textContent = '保存中…';
  try {
    // text/plain で送り、CORSのプリフライトを発生させない
    const res = await fetch(GAS_API_URL, { method: 'POST', headers: { 'Content-Type': 'text/plain;charset=utf-8' }, body: JSON.stringify({ action: 'settings', changes }) });
    const body = await res.json();
    if (body.status !== 'success') throw new Error(body.message || 'GASのエラー');
    // 保存した内容を画面のデータにも反映して計算し直す
    changes.forEach(c => {
      const w = state.data.settings.works[c.no];
      if ('done' in c) w.done = c.done;
      if ('year' in c) w.year = c.year;
    });
    state.edits = {};
    state.model = CICalc.build(state.data);
    render();
    renderSettings();
    const dup = (body.data && body.data.dup) || [];
    msg.textContent = `保存しました(${changes.length}件)` + (dup.length ? `。工事データに同じ工事Noの行が複数あります(上の行に保存): ${dup.join('、')}` : '');
  } catch (e) {
    msg.textContent = '保存に失敗しました: ' + e.message + '(もう一度押してください)';
    updateSaveButton();
  }
}

/* ===================== 実行予算の取り込み(登録ファイル) ===================== */

// 登録ファイル(server/costinsight登録.reg と同じ内容)をその場で作ってダウンロードさせる。
// リンクの中身は使わず、決まった .bat だけを起動する登録にしている。
const BAT_PATH = '\\\\192.168.3.2\\share_01\\⑰その他\\Claude(sumi)\\コストインサイト\\参照資料（削除厳禁）\\実行予算更新.bat';
function downloadReg() {
  const cmd = 'cmd.exe /c ""' + BAT_PATH + '""';
  const regEsc = cmd.replace(/\\/g, '\\\\').replace(/"/g, '\\"');
  const K = 'HKEY_CURRENT_USER\\Software\\Classes\\costinsight';
  const text = ['Windows Registry Editor Version 5.00', '', '[' + K + ']', '@="URL:Cost Insight Protocol"', '"URL Protocol"=""', '',
    '[' + K + '\\shell]', '', '[' + K + '\\shell\\open]', '', '[' + K + '\\shell\\open\\command]', '@="' + regEsc + '"', '', ''].join('\r\n');
  // .reg は UTF-16LE(BOM付き)で保存する(日本語のパスを正しく読ませるため)
  const buf = new Uint8Array(2 + text.length * 2);
  buf[0] = 0xFF; buf[1] = 0xFE;
  for (let i = 0; i < text.length; i++) { const c = text.charCodeAt(i); buf[2 + i * 2] = c & 255; buf[3 + i * 2] = c >> 8; }
  const a = document.createElement('a');
  a.href = URL.createObjectURL(new Blob([buf], { type: 'application/octet-stream' }));
  a.download = '正光コストインサイト登録.reg';
  document.body.appendChild(a); a.click(); a.remove();
  setTimeout(() => URL.revokeObjectURL(a.href), 10000);
  // ボタンを、次にやることの案内(黄色・縁が光って点滅)に置き換える
  const btn = document.getElementById('regBtn');
  if (btn) {
    const note = document.createElement('span');
    note.className = 'reg-next';
    note.textContent = 'ダウンロードフォルダよりダブルクリックで実行してください';
    btn.replaceWith(note);
  }
}

load();
