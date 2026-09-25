/* 生産損益分析 - 画面ロジック(計算はcalc.jsのPPCalc、描画はChart.js) */
'use strict';

// GASのウェブアプリURL(gas/Code.gsをデプロイしたURL)。README参照。
const GAS_API_URL = '';
// ?demo=1 で開くと、GAS無しでダミーデータにより画面を確認できる(保存は画面内のみ)。
const DEMO = new URLSearchParams(location.search).get('demo') === '1';

const C = PPCalc;
const SITE_COLORS = ['--s1', '--s2', '--s3'];
const state = { cache: null, settings: null, pw: '', editPw: '', dirty: false, charts: {}, simBase: null };

/* ===================== 通信 ===================== */

async function api(action, extra) {
  if (DEMO) return demoApi(action, extra);
  if (!GAS_API_URL) throw new Error('GAS_API_URLが未設定です(app.js)');
  // text/plainで送り、CORSのプリフライトを発生させない
  const res = await fetch(GAS_API_URL, {
    method: 'POST', headers: { 'Content-Type': 'text/plain;charset=utf-8' },
    body: JSON.stringify(Object.assign({ action: action, pw: state.pw, editPw: state.editPw }, extra || {})),
  });
  const body = await res.json();
  if (body.status !== 'success') throw new Error(body.message || 'エラー');
  return body.data;
}

function showLoading(text) {
  document.getElementById('loading-text').textContent = text || '読み込み中…';
  document.getElementById('loading').hidden = false;
}
function hideLoading() { document.getElementById('loading').hidden = true; }

/* ===================== 書式 ===================== */

function fmt(v, d) {
  if (v === null || v === undefined || !isFinite(v)) return '—';
  if (Math.abs(v) < 0.5 * Math.pow(10, -(d || 0))) v = 0; // 「-0」表示を防ぐ
  return v.toLocaleString('ja-JP', { minimumFractionDigits: d || 0, maximumFractionDigits: d || 0 });
}
const yen = (v) => fmt(v, 0);
const ton = (v) => fmt(v, 1);
const npt = (v) => fmt(v, 2);
const pct = (v) => (v === null || v === undefined || !isFinite(v)) ? '—' : (v * 100).toFixed(1) + '%';
function esc(s) { return String(s === null || s === undefined ? '' : s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c])); }
function css(name) { return getComputedStyle(document.documentElement).getPropertyValue(name).trim(); }
function siteColor(site) {
  const i = state.cache.sites.indexOf(site);
  return css(SITE_COLORS[i] || '--muted');
}

/* ===================== 起動 ===================== */

document.addEventListener('DOMContentLoaded', () => {
  const saved = sessionStorageGet('pp-pw');
  document.getElementById('lock-btn').onclick = () => unlock(document.getElementById('lock-input').value);
  document.getElementById('lock-input').onkeydown = (e) => { if (e.key === 'Enter') unlock(e.target.value); };
  if (DEMO) unlock('demo');
  else if (saved) unlock(saved);
});

function sessionStorageGet(k) { try { return sessionStorage.getItem(k); } catch (e) { return null; } }
function sessionStorageSet(k, v) { try { sessionStorage.setItem(k, v); } catch (e) { /* 保存できなくても動作に支障なし */ } }

async function unlock(pw) {
  state.pw = pw;
  const msg = document.getElementById('lock-msg');
  msg.textContent = '';
  showLoading('データを読み込み中…(初回は集計に1分程度かかる場合があります)');
  try {
    const data = await api('getData');
    sessionStorageSet('pp-pw', pw);
    onData(data);
    document.getElementById('screen-lock').hidden = true;
    document.getElementById('screen-main').hidden = false;
    initUi();
    renderAll();
  } catch (e) {
    msg.textContent = e.message;
  } finally {
    hideLoading();
  }
}

function onData(data) {
  state.cache = data.cache;
  state.settings = Object.assign(C.defaultSettings(), data.settings || {});
  const w = document.getElementById('warnings');
  const list = state.cache.warnings || [];
  w.hidden = !list.length;
  w.innerHTML = list.map(esc).join('<br>');
  const g = new Date(state.cache.generatedAt);
  document.getElementById('updated').textContent = '集計: ' + g.toLocaleString('ja-JP');
}

let uiReady = false;
function initUi() {
  if (uiReady) return;
  uiReady = true;
  document.querySelectorAll('.tabs button').forEach((b) => b.onclick = () => {
    document.querySelectorAll('.tabs button').forEach((x) => x.classList.toggle('active', x === b));
    document.querySelectorAll('.tab').forEach((t) => t.classList.toggle('active', t.id === 'tab-' + b.dataset.tab));
    renderAll();
  });

  // 期間の選択肢: データのある最初の月度〜今日の月度
  const today = C.utcToYmd(Date.now() + 9 * 3600 * 1000);
  const recs = state.cache.rec;
  const first = recs.length ? C.periodKeyOf(recs[0][0]) : C.periodKeyOf(today);
  const cur = C.periodKeyOf(today);
  const periods = [];
  for (let k = cur; k >= first; k = C.shiftPeriod(k, -1)) periods.push(k);
  const selP = document.getElementById('f-period');
  selP.innerHTML = periods.map((k) => `<option value="${k}">${C.periodLabel(k)}</option>`).join('');
  // 既定は直近の確定月度(当月度が始まったばかりの時に空の画面にならないように)
  selP.value = periods[1] || periods[0];
  const fys = [];
  for (let y = C.fiscalYearOf(cur); y >= C.fiscalYearOf(first); y--) fys.push(y);
  document.getElementById('f-fiscal').innerHTML = fys.map((y) => `<option value="${y}">${C.fiscalLabel(y)}</option>`).join('');
  const r = C.periodRange(selP.value);
  document.getElementById('f-from').value = r.from;
  document.getElementById('f-to').value = r.to;
  document.getElementById('f-site').innerHTML = '<option value="">全社</option>' +
    state.cache.sites.map((s) => `<option>${esc(s)}</option>`).join('');
  // 2行目: 工場ボタン(3工場=全社 / 本社 / 夢前 / 鳥取)
  const segs = [['', state.cache.sites.length + '工場']].concat(state.cache.sites.map((s) => [s, s]));
  const box = document.getElementById('f-sites');
  box.innerHTML = segs.map(([v, l]) => `<button type="button" data-site="${esc(v)}" class="${v === '' ? 'active' : ''}">${esc(l)}</button>`).join('');
  box.onclick = (e) => {
    const b = e.target.closest('button');
    if (!b) return;
    box.querySelectorAll('button').forEach((x) => x.classList.toggle('active', x === b));
    document.getElementById('f-site').value = b.dataset.site;
    onFilterChange();
  };
  document.getElementById('set-tperiod').innerHTML = periods.slice().reverse().concat([C.shiftPeriod(cur, 1), C.shiftPeriod(cur, 2)])
    .filter((k, i, a) => a.indexOf(k) === i).sort().reverse().map((k) => `<option value="${k}">${C.periodLabel(k)}</option>`).join('');
  document.getElementById('set-tperiod').value = cur;

  ['f-mode', 'f-period', 'f-fiscal', 'f-from', 'f-to', 'f-site', 'f-work'].forEach((id) => {
    document.getElementById(id).onchange = onFilterChange;
  });
  document.getElementById('refresh-btn').onclick = refresh;
  document.getElementById('w-search').oninput = renderWorks;
  document.getElementById('w-alloc').onchange = renderWorks;
  document.getElementById('w-csv').onclick = downloadWorksCsv;
  initSim();
  initSettings();
}

async function refresh() {
  showLoading('最新データで集計し直しています…(1分程度かかる場合があります)');
  try {
    onData(await api('refresh'));
    renderAll();
  } catch (e) {
    alert('更新に失敗しました: ' + e.message);
  } finally {
    hideLoading();
  }
}

/* ===================== 選択範囲 ===================== */

function onFilterChange() {
  state.simBase = null;
  renderAll();
}

/* 3行目の工事リスト: 選択中の期間・工場に生産重量か工数がある工事だけを並べる
   (選択中の工事がリストから外れる場合は「全工事」に戻す)。 */
function refreshWorkList(from, to, sites) {
  const sel = document.getElementById('f-work');
  const cur = sel.value;
  const common = C.commonWorkSet(state.settings);
  const siteSet = new Set(sites);
  const found = {};
  state.cache.rec.forEach((r) => {
    if (r[0] < from || r[0] > to || !siteSet.has(r[1])) return;
    const wn = (!r[2] || common[r[2]]) ? C.COMMON_WORK : r[2];
    const f = found[wn] || (found[wn] = { weight: 0, hours: 0 });
    f.weight += r[3]; f.hours += r[4];
  });
  const list = Object.keys(found).filter((wn) => wn !== C.COMMON_WORK).sort().reverse();
  if (found[C.COMMON_WORK]) list.push(C.COMMON_WORK);
  const name = (wn) => wn === C.COMMON_WORK ? '共通(工事なし)' : ((state.cache.works[wn] || {}).name || '');
  sel.innerHTML = '<option value="">全工事</option>' + list.map((wn) =>
    `<option value="${esc(wn)}">${esc(wn === C.COMMON_WORK ? '' : wn + '　')}${esc(name(wn))}(${ton(found[wn].weight)}t)</option>`).join('');
  sel.value = list.includes(cur) ? cur : '';
  document.getElementById('f-work-note').textContent = sel.value ? '工事に絞ると固定費は工場の固定費を売上比で配賦します(月間目標は工場単位のため対象外)' : list.length + '件';
  return sel.value;
}

function selection() {
  const mode = document.getElementById('f-mode').value;
  document.getElementById('f-period-wrap').hidden = mode !== 'period';
  document.getElementById('f-fiscal-wrap').hidden = mode !== 'fiscal';
  document.getElementById('f-range-wrap').hidden = mode !== 'range';
  let r;
  if (mode === 'period') r = C.periodRange(document.getElementById('f-period').value);
  else if (mode === 'fiscal') r = C.fiscalRange(Number(document.getElementById('f-fiscal').value));
  else {
    r = { from: document.getElementById('f-from').value, to: document.getElementById('f-to').value };
    if (!r.from || !r.to || r.from > r.to) r = C.periodRange(document.getElementById('f-period').value);
  }
  const site = document.getElementById('f-site').value;
  const sites = site ? [site] : state.cache.sites;
  document.getElementById('f-range-text').textContent = r.from.replace(/-/g, '/') + ' 〜 ' + r.to.replace(/-/g, '/');
  const work = refreshWorkList(r.from, r.to, sites);
  return { mode, from: r.from, to: r.to, site, sites, work, periodKey: mode === 'period' ? document.getElementById('f-period').value : null };
}

function renderAll() {
  if (!state.cache) return;
  const active = document.querySelector('.tabs button.active').dataset.tab;
  const sel = selection();
  const an = C.analyze(state.cache, state.settings, sel.from, sel.to, sel.sites, sel.work || undefined);
  if (active === 'dash') renderDash(sel, an);
  if (active === 'bep') renderBep(sel, an);
  if (active === 'sim') renderSim(sel, an);
  if (active === 'works') renderWorks();
  if (active === 'settings') renderSettings();
}

/* ===================== KPI ===================== */

function kpi(label, value, unit, sub, cls) {
  return `<div class="kpi"><div class="label">${label}</div><div class="value ${cls || ''}">${value}<span class="unit">${unit || ''}</span></div><div class="sub">${sub || ''}</div></div>`;
}
function vsTarget(actual, target, fmtFn, lowerIsBetter) {
  if (!target) return '目標未設定';
  const ok = lowerIsBetter ? actual <= target : actual >= target;
  return `目標 ${fmtFn(target)} <span class="${ok ? 'pos' : 'neg'}">(${lowerIsBetter ? '' : '達成率 '}${lowerIsBetter ? (ok ? '達成' : '未達') : pct(actual / target)})</span>`;
}

function renderDash(sel, an) {
  const t = an.total;
  const note = document.getElementById('dash-note');
  note.hidden = !t.estimated;
  note.textContent = '目標が未設定の月度は、実績売上を基準に費用を配分率で割り付けているため、損益は利益率(' +
    state.settings.rates.profit + '%)どおりの見込み値になります。月間目標や実額(設定タブ)を入れると、実態との差が表れます。';
  document.getElementById('kpis').innerHTML = [
    kpi('生産重量', ton(t.weight), 't', vsTarget(t.weight, t.hasTarget && t.targetWeight, ton)),
    kpi('1t当たり人工数', npt(t.ninkuPerTon), '人工/t', `総工数 ${fmt(t.hours, 1)}h(${fmt(t.ninku, 1)}人工)<br>` + vsTarget(t.ninkuPerTon, t.hasTarget && t.targetNinkuPerTon, npt, true)),
    kpi('平均トン単価', yen(t.unitPrice), '円/t', t.hasTarget ? '目標 ' + yen(t.targetUnitPrice) + '円/t' : '目標未設定'),
    kpi('売上額', yen(t.sales), '円', vsTarget(t.sales, t.hasTarget && t.targetSales, yen)),
    kpi('損益', yen(t.profit), '円', `利益率 ${pct(t.profitRate)} / 利益目標 ${yen(t.profitGoal)}円`, t.profit >= 0 ? 'pos' : 'neg'),
    kpi('損益分岐点', ton(t.breakEvenTons), 't', t.breakEvenTons !== null ? `実績は分岐点の ${pct(t.weight / t.breakEvenTons)}` : '限界利益がマイナスのため到達不能'),
    kpi('目標売上額(利益目標達成)', yen(t.goalSales), '円', t.goalTons !== null ? `必要生産量 ${ton(t.goalTons)}t` + (t.goalSales ? ` / 達成率 ${pct(t.sales / t.goalSales)}` : '') : '到達不能'),
  ].join('');

  // 推移: 選択範囲の終了月度から遡って12月度(期のときは期の12月度)
  const endKey = C.periodKeyOf(sel.to);
  let startKey = sel.mode === 'fiscal' ? C.periodKeyOf(sel.from) : C.shiftPeriod(endKey, -11);
  const firstKey = state.cache.rec.length ? C.periodKeyOf(state.cache.rec[0][0]) : startKey;
  if (startKey < firstKey && firstKey <= endKey) startKey = firstKey; // データの無い月度は並べない
  const tr = { from: C.periodRange(startKey).from, to: C.periodRange(endKey).to };
  const trAll = C.analyze(state.cache, state.settings, tr.from, tr.to, sel.sites, sel.work || undefined);
  const labels = trAll.byPeriod.map((p) => C.periodLabel(p.period).replace(/^\d{2}(\d{2})年/, '$1/').replace('月度', ''));
  const perSite = sel.sites.map((s) => ({ site: s, an: C.analyze(state.cache, state.settings, tr.from, tr.to, [s], sel.work || undefined) }));

  drawChart('c-weight', {
    type: 'bar',
    data: { labels, datasets: perSite.map((p) => ({ label: p.site, data: p.an.byPeriod.map((x) => x.weight), backgroundColor: siteColor(p.site), borderRadius: 4, stack: 'w' })) },
    options: stackedOpts('t'),
  });
  drawChart('c-ninku', {
    type: 'line',
    data: { labels, datasets: perSite.map((p) => ({ label: p.site, data: p.an.byPeriod.map((x) => x.ninkuPerTon), borderColor: siteColor(p.site), backgroundColor: siteColor(p.site), borderWidth: 2, pointRadius: 4, spanGaps: true }))
      .concat(sel.sites.length > 1 ? [{ label: '全社', data: trAll.byPeriod.map((x) => x.ninkuPerTon), borderColor: css('--text2'), borderDash: [5, 4], borderWidth: 2, pointRadius: 0, spanGaps: true }] : []) },
    options: baseOpts('人工/t', 2),
  });
  drawChart('c-pnl', {
    type: 'bar',
    data: { labels, datasets: [
      { label: '売上', data: trAll.byPeriod.map((x) => x.sales), backgroundColor: css('--s1'), borderRadius: 4 },
      { label: '総費用', data: trAll.byPeriod.map((x) => x.labor + x.variable + x.fixed), backgroundColor: css('--s2'), borderRadius: 4 },
      { label: '損益', data: trAll.byPeriod.map((x) => x.profit), backgroundColor: trAll.byPeriod.map((x) => x.profit >= 0 ? css('--good') : css('--bad')), borderRadius: 4 },
    ] },
    options: baseOpts('円', 0),
  });

  const head = '<tr><th>月度</th><th class="n">生産重量(t)</th><th class="n">目標重量</th><th class="n">工数(h)</th><th class="n">人工/t</th><th class="n">トン単価</th><th class="n">売上</th><th class="n">人件費</th><th class="n">変動費</th><th class="n">固定費</th><th class="n">損益</th><th class="n">利益率</th><th class="n">分岐点(t)</th></tr>';
  const rowHtml = (label, x, cls) => `<tr class="${cls || ''}"><td>${label}</td><td class="n">${ton(x.weight)}</td><td class="n">${x.hasTarget ? ton(x.targetWeight) : '—'}</td><td class="n">${fmt(x.hours, 1)}</td><td class="n">${npt(x.ninkuPerTon)}</td><td class="n">${yen(x.unitPrice)}</td><td class="n">${yen(x.sales)}</td><td class="n">${yen(x.labor)}</td><td class="n">${yen(x.variable)}</td><td class="n">${yen(x.fixed)}</td><td class="n ${x.profit >= 0 ? 'pos' : 'neg'}">${yen(x.profit)}</td><td class="n">${pct(x.profitRate)}</td><td class="n">${ton(x.breakEvenTons)}</td></tr>`;
  document.getElementById('t-trend').innerHTML = head + trAll.byPeriod.map((x) => rowHtml(C.periodLabel(x.period), x)).join('') + rowHtml('合計', trAll.total, 'total');
  document.getElementById('t-site').innerHTML = head.replace('<th>月度</th>', '<th>工場</th>') +
    an.bySite.map((x) => rowHtml(esc(x.site), x)).join('') + (an.bySite.length > 1 ? rowHtml('全社', an.total, 'total') : '');
}

/* ===================== グラフ共通 ===================== */

function baseOpts(unit, digits) {
  const tick = css('--text2'), grid = css('--grid');
  return {
    responsive: true, maintainAspectRatio: false, animation: false,
    interaction: { mode: 'index', intersect: false },
    plugins: {
      legend: { labels: { color: tick, boxWidth: 12 } },
      tooltip: { callbacks: { label: (c) => `${c.dataset.label}: ${fmt(c.parsed.y, digits)} ${unit}` } },
    },
    scales: {
      x: { ticks: { color: tick }, grid: { display: false } },
      y: { ticks: { color: tick, callback: (v) => fmt(v, digits) }, grid: { color: grid }, title: { display: true, text: unit, color: tick } },
    },
  };
}
function stackedOpts(unit) {
  const o = baseOpts(unit, 1);
  o.scales.x.stacked = true; o.scales.y.stacked = true;
  return o;
}
function drawChart(id, cfg) {
  if (state.charts[id]) state.charts[id].destroy();
  state.charts[id] = new Chart(document.getElementById(id), cfg);
}

/* 損益分岐点グラフ(SVG。横軸=生産トン数、縦軸=金額)。
   o: {fixed, unitPrice, laborPerTon, varPerTon, profitRate, x(つまみの初期位置t), beTons, goalTons, handleLabel, onMove(t)}
   面の塗り分け: 固定費帯 / 人件費帯 / 変動費帯 / 損失域(分岐点の左、売上線と総費用線の間) / 利益域(右)。
   つまみ(縦の点線)をドラッグすると、その重量での内訳(固定費・人件費・変動費・利益or損失)を積み上げバーで表示する。 */
const bepState = {};
function niceStep(range, count) {
  const raw = range / Math.max(count, 1), mag = Math.pow(10, Math.floor(Math.log10(raw || 1)));
  const n = raw / mag;
  return (n <= 1 ? 1 : n <= 2 ? 2 : n <= 5 ? 5 : 10) * mag;
}
function man(v) { return Math.abs(v) >= 10000 ? fmt(v / 10000, 0) + '万円' : yen(v) + '円'; }

function drawBep(id, o) {
  const box = document.getElementById(id);
  const prev = bepState[id];
  // 同じ条件の再描画(ドラッグ中など)ではつまみ位置を保つ。条件が変わったら初期位置に戻す。
  const sig = [o.fixed, o.unitPrice, o.laborPerTon, o.varPerTon, o.profitRate].join('|');
  const st = bepState[id] = { o, x: (prev && prev.sig === sig && !o.forceX) ? prev.x : (o.x || 0), sig, maxX: prev && prev.sig === sig ? prev.maxX : null };
  if (!st.maxX) st.maxX = Math.max(o.x || 0, o.beTons || 0, o.goalTons || 0, 1) * 1.35;
  renderBepSvg(id);
  if (!box.dataset.bound) {
    box.dataset.bound = '1';
    let dragging = false;
    const toX = (e) => {
      const s = bepState[id], g = s.geom, r = box.getBoundingClientRect();
      return Math.min(s.maxX, Math.max(0, (e.clientX - r.left - g.l) / g.w * s.maxX));
    };
    box.addEventListener('pointerdown', (e) => {
      const s = bepState[id], g = s.geom, r = box.getBoundingClientRect();
      if (!g || e.clientY - r.top > g.t + g.h + 4) return;
      dragging = true; box.setPointerCapture(e.pointerId);
      s.x = toX(e); renderBepSvg(id); if (s.o.onMove) s.o.onMove(s.x);
    });
    box.addEventListener('pointermove', (e) => {
      if (!dragging) return;
      const s = bepState[id]; s.x = toX(e); renderBepSvg(id); if (s.o.onMove) s.o.onMove(s.x);
    });
    const end = () => { dragging = false; };
    box.addEventListener('pointerup', end); box.addEventListener('pointercancel', end);
    window.addEventListener('resize', () => bepState[id] && renderBepSvg(id));
  }
}

function renderBepSvg(id) {
  const box = document.getElementById(id), st = bepState[id], o = st.o;
  const W = box.clientWidth || 600, H = box.clientHeight || 380;
  const g = st.geom = { l: 64, r: 16, t: 16, b: 36 };
  g.w = W - g.l - g.r; g.h = H - g.t - g.b;
  const P = o.unitPrice || 0, lab = o.laborPerTon || 0, vr = o.varPerTon || 0, F = o.fixed || 0;
  const maxX = st.maxX;
  const cost = (x) => F + (lab + vr) * x, sales = (x) => P * x;
  const maxY = Math.max(sales(maxX), cost(maxX), F, 1) * 1.05;
  const X = (x) => g.l + x / maxX * g.w, Y = (y) => g.t + g.h - y / maxY * g.h;
  const pts = (arr) => arr.map((p) => X(p[0]).toFixed(1) + ',' + Y(p[1]).toFixed(1)).join(' ');
  const be = o.beTons !== null && o.beTons !== undefined && o.beTons <= maxX ? o.beTons : null;
  let h = '';
  // グリッドと目盛
  const xs = niceStep(maxX, Math.max(3, Math.floor(g.w / 90))), ys = niceStep(maxY, 5);
  for (let v = 0; v <= maxY + 1e-9; v += ys) h += `<line class="bg" x1="${g.l}" x2="${g.l + g.w}" y1="${Y(v)}" y2="${Y(v)}"/><text class="ax" x="${g.l - 6}" y="${Y(v) + 4}" text-anchor="end">${fmt(v / 10000, 0)}万</text>`;
  for (let v = 0; v <= maxX + 1e-9; v += xs) h += `<line class="bg" y1="${g.t}" y2="${g.t + g.h}" x1="${X(v)}" x2="${X(v)}"/><text class="ax" x="${X(v)}" y="${g.t + g.h + 16}" text-anchor="middle">${fmt(v, 0)}</text>`;
  h += `<text class="ax" x="${g.l + g.w}" y="${H - 4}" text-anchor="end">生産重量(t)</text>`;
  // 面: 固定費帯・人件費帯・変動費帯
  h += `<polygon class="fFixed" points="${pts([[0, 0], [maxX, 0], [maxX, F], [0, F]])}"/>`;
  h += `<polygon class="fLabor" points="${pts([[0, F], [maxX, F + lab * maxX], [maxX, F]])}"/>`;
  h += `<polygon class="fVar" points="${pts([[0, F], [maxX, cost(maxX)], [maxX, F + lab * maxX]])}"/>`;
  // 損失域・利益域
  if (be !== null) {
    h += `<polygon class="fLoss" points="${pts([[0, 0], [0, F], [be, sales(be)]])}"/>`;
    h += `<polygon class="fProfit" points="${pts([[be, sales(be)], [maxX, sales(maxX)], [maxX, cost(maxX)]])}"/>`;
  } else {
    h += `<polygon class="fLoss" points="${pts([[0, 0], [0, F], [maxX, cost(maxX)], [maxX, sales(maxX)]])}"/>`;
  }
  // 線
  h += `<line class="lFixed" x1="${X(0)}" x2="${X(maxX)}" y1="${Y(F)}" y2="${Y(F)}"/>`;
  h += `<text class="lbl" x="${g.l + 6}" y="${Y(F) - 6}">固定費 ${man(F)}</text>`;
  h += `<line class="lCost" x1="${X(0)}" y1="${Y(F)}" x2="${X(maxX)}" y2="${Y(cost(maxX))}"/>`;
  h += `<line class="lSales" x1="${X(0)}" y1="${Y(0)}" x2="${X(maxX)}" y2="${Y(sales(maxX))}"/>`;
  h += `<text class="lbl" x="${X(maxX) - 4}" y="${Y(sales(maxX)) + 14}" text-anchor="end">売上</text>`;
  h += `<text class="lbl cost" x="${X(maxX) - 4}" y="${Y(cost(maxX)) + 14}" text-anchor="end">総費用</text>`;
  // 利益目標達成点
  if (o.goalTons !== null && o.goalTons !== undefined && o.goalTons <= maxX) {
    const gx = X(o.goalTons), gy = Y(sales(o.goalTons));
    h += `<path class="mGoal" d="M${gx},${gy - 7} L${gx + 6},${gy + 4} L${gx - 6},${gy + 4} Z"/><text class="lbl good" x="${gx - 8}" y="${gy - 10}" text-anchor="end">利益目標 ${ton(o.goalTons)}t</text>`;
  }
  // 損益分岐点(軸への補助線付き)
  if (be !== null) {
    const bx = X(be), by = Y(sales(be));
    h += `<line class="lBe" x1="${bx}" x2="${bx}" y1="${by}" y2="${g.t + g.h}"/><line class="lBe" x1="${g.l}" x2="${bx}" y1="${by}" y2="${by}"/>`;
    h += `<circle class="mBeHalo" cx="${bx}" cy="${by}" r="11"/><circle class="mBe" cx="${bx}" cy="${by}" r="7"/>`;
    h += `<text class="lbl be" x="${bx + 14}" y="${by - 10}">損益分岐点 ${ton(be)}t / ${man(sales(be))}</text>`;
  }
  // つまみ位置の内訳バー
  const x = st.x, cx = X(x), bw = 8;
  const segs = [['固定費', 0, F, 'bFixed'], ['人件費', F, F + lab * x, 'bLabor'], ['変動費', F + lab * x, cost(x), 'bVar']];
  const profit = sales(x) - cost(x);
  if (profit >= 0) segs.push(['利益', cost(x), sales(x), 'bProfit']); else segs.push(['損失', sales(x), cost(x), 'bLoss']);
  h += `<line class="lCursor" x1="${cx}" x2="${cx}" y1="${g.t}" y2="${g.t + g.h}"/>`;
  const labels = [];
  segs.forEach(([name, y0, y1, cls]) => {
    if (y1 - y0 <= 0) return;
    h += `<rect class="${cls}" x="${cx - bw / 2}" width="${bw}" y="${Y(y1)}" height="${Math.max(1, Y(y0) - Y(y1))}"/>`;
    labels.push({ text: `${name} ${man(y1 - y0)}`, y: (Y(y0) + Y(y1)) / 2 + 4, cls });
  });
  // ラベルの重なりを避ける(下のつまみに掛からない位置から、下から順に最低16px間隔)
  labels.sort((a, b) => b.y - a.y);
  if (labels.length && labels[0].y > g.t + g.h - 32) labels[0].y = g.t + g.h - 32;
  for (let i = 1; i < labels.length; i++) if (labels[i - 1].y - labels[i].y < 16) labels[i].y = labels[i - 1].y - 16;
  const right = cx < g.l + g.w * 0.62;
  labels.forEach((lb) => { h += `<text class="lbl seg ${lb.cls}" x="${right ? cx + 10 : cx - 10}" y="${lb.y}" text-anchor="${right ? 'start' : 'end'}">${lb.text}</text>`; });
  // つまみ
  const hl = `${o.handleLabel || '生産重量'} ◀▶ ${ton(x)}t`;
  const hw = hl.length * 7.5 + 18;
  h += `<g class="handle"><rect x="${cx - hw / 2}" y="${g.t + g.h - 26}" width="${hw}" height="22" rx="11"/><text x="${cx}" y="${g.t + g.h - 11}" text-anchor="middle">${hl}</text></g>`;
  box.innerHTML = `<svg class="bepSvg" width="${W}" height="${H}" viewBox="0 0 ${W} ${H}" role="img" aria-label="損益分岐点グラフ">${h}</svg>`;
}

/* ===================== 損益分岐点タブ ===================== */

function renderBep(sel, an) {
  const t = an.total;
  const perTon = (t.varPerTon || 0) + (t.laborPerTon || 0);
  const p = state.settings.rates.profit / 100;
  document.getElementById('bep-kpis').innerHTML = [
    kpi('損益分岐点トン数', ton(t.breakEvenTons), 't', '売上 ' + yen(t.breakEvenTons !== null ? t.breakEvenTons * t.unitPrice : null) + '円'),
    kpi('利益目標達成トン数', ton(t.goalTons), 't', '目標売上額 ' + yen(t.goalSales) + '円'),
    kpi('実績生産重量', ton(t.weight), 't', t.goalTons ? `目標達成まで ${ton(Math.max(0, t.goalTons - t.weight))}t` : ''),
    kpi('1t当たり限界利益', yen(t.unitPrice !== null ? t.unitPrice - perTon : null), '円/t', `トン単価 ${yen(t.unitPrice)} − 変動費 ${yen(t.varPerTon)} − 人件費 ${yen(t.laborPerTon)}`),
  ].join('');
  drawBep('c-bep', { fixed: t.fixed, unitPrice: t.unitPrice || 0, laborPerTon: t.laborPerTon || 0, varPerTon: t.varPerTon || 0,
    profitRate: p, x: t.weight, beTons: t.breakEvenTons, goalTons: t.goalTons, handleLabel: '生産重量' });
  const rows = [
    ['固定費(期間計)', yen(t.fixed) + ' 円', '費用設定の月固定費×月数、未入力の工場は 基準売上×固定費率'],
    ['トン単価(平均)', yen(t.unitPrice) + ' 円/t', '売上 ÷ 生産重量(工事ごとの契約金額÷総重量で計算した売上の合計)'],
    ['変動費単価', yen(t.varPerTon) + ' 円/t', '実額未入力の工場は 基準トン単価×変動費率'],
    ['1t当たり人件費', yen(t.laborPerTon) + ' 円/t', `人工/t ${npt(t.ninkuPerTon)} × 人件費単価 ${yen(t.laborRate)}円/人工`],
    ['利益率(目標)', pct(p), '設定タブの配分率'],
    ['損益分岐点', ton(t.breakEvenTons) + ' t', '固定費 ÷ (トン単価 − 変動費単価 − 1t当たり人件費)'],
    ['利益目標達成点', ton(t.goalTons) + ' t', '固定費 ÷ (トン単価×(1−利益率) − 変動費単価 − 1t当たり人件費)'],
  ];
  document.getElementById('t-bep').innerHTML = '<tr><th>項目</th><th class="n">値</th><th>計算方法</th></tr>' +
    rows.map((r) => `<tr><td>${r[0]}</td><td class="n">${r[1]}</td><td class="muted small">${r[2]}</td></tr>`).join('');
}

/* ===================== シミュレーション ===================== */

const SIM = [['w', 1], ['n', 0.01], ['p', 100]];
let simDragging = false;
function initSim() {
  SIM.forEach(([k]) => {
    const r = document.getElementById('s-' + k + '-r'), n = document.getElementById('s-' + k);
    r.oninput = () => { n.value = r.value; updateSim(); };
    n.oninput = () => { r.value = n.value; updateSim(); };
  });
  document.getElementById('s-reset').onclick = () => { state.simBase = null; renderAll(); };
  document.getElementById('s-save').onclick = saveSimAsTarget;
}

function renderSim(sel, an) {
  const t = an.total;
  const base = {
    w: t.hasTarget ? t.targetWeight : t.weight,
    n: t.hasTarget && t.targetNinkuPerTon ? t.targetNinkuPerTon : (t.ninkuPerTon || 0),
    p: t.hasTarget && t.targetUnitPrice ? t.targetUnitPrice : (t.unitPrice || state.settings.standardUnitPrice || 0),
  };
  state.simSel = sel;
  state.simTotal = t;
  if (!state.simBase) {
    state.simBase = base;
    const set = (k, v, max, step) => {
      const r = document.getElementById('s-' + k + '-r'), n = document.getElementById('s-' + k);
      // 数値欄は刻みで丸めない(丸めると基準値でも損益が配分どおりにならず「未達」と出るため)
      r.min = 0; r.max = max; r.step = step; r.value = v; n.value = +v.toFixed(3);
    };
    set('w', base.w, Math.max(base.w * 2, 10), 0.1);
    set('n', base.n, Math.max(base.n * 2, 1), 0.01);
    set('p', base.p, Math.max(base.p * 2, 10000), 100);
  }
  const canSave = sel.mode === 'period' && !!sel.site && !sel.work;
  const btn = document.getElementById('s-save');
  btn.disabled = !canSave;
  document.getElementById('s-save-note').textContent = canSave ? `${C.periodLabel(sel.periodKey)}・${sel.site} の月間目標として保存します(編集用パスワードが必要)`
    : '月間目標として保存するには、期間を「月度」、工場を1つ、工事は「全工事」を選んでください。';
  updateSim();
}

function updateSim() {
  const t = state.simTotal;
  if (!t) return;
  const W = Number(document.getElementById('s-w').value) || 0;
  const n = Number(document.getElementById('s-n').value) || 0;
  const P = Number(document.getElementById('s-p').value) || 0;
  const r = C.simulate(t, state.settings, W, n, P);
  const b = state.simBase;
  const diff = (v, bv, f) => { const d = v - bv; return d === 0 ? '基準どおり' : `基準比 ${d > 0 ? '+' : ''}${f(d)}`; };
  document.getElementById('sim-kpis').innerHTML = [
    kpi('売上額', yen(r.sales), '円', diff(r.sales, b.w * b.p, yen)),
    kpi('損益', yen(r.profit), '円', `利益率 ${pct(r.profitRate)}`, r.profit >= 0 ? 'pos' : 'neg'),
    kpi('利益目標', r.goalMet ? '達成' : '未達', '', `目標利益 ${yen(r.profitGoal)}円`, r.goalMet ? 'pos' : 'neg'),
    kpi('必要人工', fmt(r.ninku, 1), '人工', `${fmt(r.hours, 0)}h`),
    kpi('損益分岐点', ton(r.breakEvenTons), 't', r.breakEvenTons !== null ? `余裕 ${ton(W - r.breakEvenTons)}t` : '到達不能'),
    kpi('目標売上額', yen(r.goalSales), '円', r.goalTons !== null ? `必要生産量 ${ton(r.goalTons)}t` : '到達不能'),
    kpi('人件費', yen(r.labor), '円', `${yen(r.laborRate)}円/人工`),
    kpi('変動費+固定費', yen(r.variable + r.fixed), '円', `変動費 ${yen(r.varPerTon)}円/t・固定費 ${yen(r.fixed)}円`),
  ].join('');
  // つまみのドラッグで試算の生産重量を動かせる(スライダー・数値欄と連動)
  drawBep('c-sim', { fixed: r.fixed, unitPrice: P, laborPerTon: n * r.laborRate, varPerTon: r.varPerTon, profitRate: state.settings.rates.profit / 100,
    x: W, forceX: !simDragging, beTons: r.breakEvenTons, goalTons: r.goalTons, handleLabel: '試算重量',
    onMove: (t) => {
      simDragging = true;
      document.getElementById('s-w').value = +t.toFixed(1);
      document.getElementById('s-w-r').value = t;
      updateSim();
      simDragging = false;
    } });
}

async function saveSimAsTarget() {
  const sel = state.simSel;
  if (!(await ensureEdit())) return;
  state.settings.targets[sel.periodKey + '|' + sel.site] = {
    weight: Number(document.getElementById('s-w').value) || 0,
    ninkuPerTon: Number(document.getElementById('s-n').value) || 0,
    unitPrice: Number(document.getElementById('s-p').value) || 0,
  };
  await saveSettings();
  state.simBase = null;
  renderAll();
}

/* ===================== 工事別分析 ===================== */

function worksRows() {
  const sel = selection();
  const an = C.analyze(state.cache, state.settings, sel.from, sel.to, sel.sites);
  const q = document.getElementById('w-search').value.trim().toLowerCase();
  let rows = C.workBreakdown(an, state.cache);
  if (q) rows = rows.filter((r) => (r.workNo + ' ' + r.name).toLowerCase().includes(q));
  return rows;
}

function renderWorks() {
  const alloc = document.getElementById('w-alloc').checked;
  const rows = worksRows();
  const npCol = (r) => alloc ? r.allocNinkuPerTon : r.ninkuPerTon;
  const top = rows.filter((r) => r.workNo !== C.COMMON_WORK && r.weight > 0).sort((a, b) => b.weight - a.weight).slice(0, 15);
  drawChart('c-works', {
    type: 'bar',
    data: { labels: top.map((r) => r.workNo), datasets: [{ label: alloc ? '人工/t(共通按分後)' : '人工/t(直接)', data: top.map(npCol), backgroundColor: css('--s1'), borderRadius: 4 }] },
    options: Object.assign(baseOpts('人工/t', 2), { indexAxis: 'y', plugins: { legend: { display: false }, tooltip: { callbacks: {
      title: (c) => { const r = top[c[0].dataIndex]; return r.workNo + ' ' + r.name; }, label: (c) => fmt(c.parsed.x, 2) + ' 人工/t' } } },
    scales: { x: { ticks: { color: css('--text2') }, grid: { color: css('--grid') } }, y: { ticks: { color: css('--text2') }, grid: { display: false } } } }),
  });
  const sum = rows.reduce((a, r) => { ['weight', 'hours', 'allocHours', 'sales', 'labor', 'variable', 'fixed', 'marginal', 'profit'].forEach((k) => a[k] += r[k]); return a; },
    { weight: 0, hours: 0, allocHours: 0, sales: 0, labor: 0, variable: 0, fixed: 0, marginal: 0, profit: 0 });
  const h = (r) => alloc ? r.allocHours : r.hours;
  const tr = (r, cls) => `<tr class="${cls || ''}"><td>${esc(r.workNo)}</td><td>${esc(r.name)}</td><td class="n">${ton(r.weight)}</td><td class="n">${fmt(h(r), 1)}</td><td class="n">${fmt(h(r) / C.HOURS_PER_NINKU, 1)}</td><td class="n">${npt(r.weight > 0 ? h(r) / C.HOURS_PER_NINKU / r.weight : null)}</td><td class="n">${yen(r.unitPrice)}</td><td class="n">${yen(r.sales)}</td><td class="n">${yen(r.labor)}</td><td class="n">${yen(r.variable)}</td><td class="n">${yen(r.marginal)}</td><td class="n">${yen(r.fixed)}</td><td class="n ${r.profit >= 0 ? 'pos' : 'neg'}">${yen(r.profit)}</td></tr>`;
  document.getElementById('t-works').innerHTML = '<tr><th>工事No</th><th>工事名</th><th class="n">重量(t)</th><th class="n">工数(h)</th><th class="n">人工</th><th class="n">人工/t</th><th class="n">トン単価</th><th class="n">売上</th><th class="n">人件費</th><th class="n">変動費</th><th class="n">限界利益</th><th class="n">固定費配賦</th><th class="n">損益</th></tr>' +
    rows.map((r) => tr(r, r.workNo === C.COMMON_WORK ? 'common' : '')).join('') +
    tr(Object.assign({ workNo: '合計', name: '', unitPrice: sum.weight > 0 ? sum.sales / sum.weight : null }, sum), 'total');
}

function downloadWorksCsv() {
  const alloc = document.getElementById('w-alloc').checked;
  const sel = selection();
  const lines = [['工事No', '工事名', '重量(t)', '工数(h)', '人工', '人工/t', 'トン単価', '売上', '人件費', '変動費', '限界利益', '固定費配賦', '損益']];
  worksRows().forEach((r) => {
    const h = alloc ? r.allocHours : r.hours;
    lines.push([r.workNo, r.name, r.weight.toFixed(3), h.toFixed(2), (h / 8).toFixed(2), r.weight > 0 ? (h / 8 / r.weight).toFixed(3) : '',
      r.unitPrice !== null ? Math.round(r.unitPrice) : '', Math.round(r.sales), Math.round(r.labor), Math.round(r.variable), Math.round(r.marginal), Math.round(r.fixed), Math.round(r.profit)]);
  });
  const csv = '﻿' + lines.map((l) => l.map((v) => /[",\n]/.test(String(v)) ? '"' + String(v).replace(/"/g, '""') + '"' : v).join(',')).join('\r\n');
  const a = document.createElement('a');
  a.href = URL.createObjectURL(new Blob([csv], { type: 'text/csv' }));
  a.download = `工事別分析_${sel.from}_${sel.to}${sel.site ? '_' + sel.site : ''}.csv`;
  a.click();
  URL.revokeObjectURL(a.href);
}

/* ===================== 設定 ===================== */

const RATE_LABELS = [['labor', '人件費率'], ['variable', '変動費率(材料等)'], ['fixed', '固定費率'], ['profit', '利益率(目標)']];

async function ensureEdit() {
  if (state.editPw) return true;
  const pw = prompt('編集用パスワードを入力してください');
  if (!pw) return false;
  return checkEdit(pw);
}
async function checkEdit(pw) {
  state.editPw = pw;
  try {
    await api('checkEdit');
    return true;
  } catch (e) {
    state.editPw = '';
    alert(e.message);
    return false;
  }
}

function initSettings() {
  document.getElementById('edit-btn').onclick = async () => {
    const ok = await checkEdit(document.getElementById('edit-input').value);
    document.getElementById('edit-msg').textContent = ok ? '' : 'パスワードが違います';
    renderSettings();
  };
  document.getElementById('set-save').onclick = saveSettings;
  document.getElementById('set-tperiod').onchange = renderSettings;
  document.getElementById('set-wsearch').oninput = renderSettingsWorks;
  document.getElementById('set-wunset').onchange = renderSettingsWorks;
  // 入力はすべて委譲で拾い、state.settingsへ即時反映する(保存ボタンで送信)
  document.getElementById('set-body').addEventListener('input', (e) => {
    const el = e.target, d = el.dataset;
    if (!d.k) return;
    const s = state.settings;
    const v = el.type === 'number' ? (el.value === '' ? null : Number(el.value)) : el.value;
    if (d.k === 'rate') s.rates[d.f] = v === null ? 0 : v;
    else if (d.k === 'std') s.standardUnitPrice = v || 0;
    else if (d.k === 'common') s.commonWorkNos = v;
    else if (d.k === 'cost') (s.costs[d.site] = s.costs[d.site] || {})[d.f] = v;
    else if (d.k === 'target') (s.targets[d.key] = s.targets[d.key] || {})[d.f] = v;
    else if (d.k === 'work') {
      const w = (s.works[d.wn] = s.works[d.wn] || { name: (state.cache.works[d.wn] || {}).name || '' });
      w[d.f] = v;
      const cell = document.getElementById('wp-' + d.wn);
      if (cell) cell.textContent = yen(C.unitPriceOf(d.wn, state.cache, s).price);
    }
    state.dirty = true;
    document.getElementById('set-dirty').textContent = '未保存の変更があります';
    if (d.k === 'rate') updateRateSum();
    if (d.k === 'target') renderTargetSales();
  });
}

async function saveSettings() {
  if (!(await ensureEdit())) return;
  showLoading('設定を保存中…');
  try {
    const data = await api('saveSettings', { settings: state.settings });
    state.settings = Object.assign(C.defaultSettings(), data.settings);
    state.dirty = false;
    document.getElementById('set-dirty').textContent = '保存しました';
  } catch (e) {
    alert('保存に失敗しました: ' + e.message);
  } finally {
    hideLoading();
  }
}

function numInput(attrs, v, step) {
  const a = Object.keys(attrs).map((k) => `data-${k}="${esc(attrs[k])}"`).join(' ');
  return `<input type="number" step="${step || 1}" ${a} value="${v === null || v === undefined ? '' : esc(v)}">`;
}

function updateRateSum() {
  const r = state.settings.rates;
  const sum = (r.labor || 0) + (r.variable || 0) + (r.fixed || 0) + (r.profit || 0);
  const el = document.getElementById('set-rate-sum');
  el.textContent = `合計 ${fmt(sum, 1)}%` + (Math.abs(sum - 100) > 0.01 ? '(100%になるように調整してください)' : '');
  el.className = 'small ' + (Math.abs(sum - 100) > 0.01 ? 'neg' : 'pos');
}

function renderSettings() {
  const unlocked = !!state.editPw;
  document.getElementById('set-lock').hidden = unlocked;
  document.getElementById('set-body').hidden = !unlocked;
  if (!unlocked) return;
  const s = state.settings;
  document.getElementById('set-rates').innerHTML = RATE_LABELS.map(([f, l]) =>
    `<label>${l}(%)${numInput({ k: 'rate', f }, s.rates[f], 0.1)}</label>`).join('');
  updateRateSum();
  document.getElementById('set-std').value = s.standardUnitPrice || '';
  document.getElementById('set-std').dataset.k = 'std';
  document.getElementById('set-common').value = s.commonWorkNos || '';
  document.getElementById('set-common').dataset.k = 'common';

  document.getElementById('set-costs').innerHTML = '<tr><th>工場</th><th class="n">人件費単価(円/人工)</th><th class="n">月固定費(円)</th><th class="n">変動費単価(円/t)</th></tr>' +
    state.cache.sites.map((site) => {
      const c = s.costs[site] || {};
      return `<tr><td>${esc(site)}</td><td class="n">${numInput({ k: 'cost', site, f: 'laborRate' }, c.laborRate, 100)}</td><td class="n">${numInput({ k: 'cost', site, f: 'fixedMonthly' }, c.fixedMonthly, 10000)}</td><td class="n">${numInput({ k: 'cost', site, f: 'variablePerTon' }, c.variablePerTon, 100)}</td></tr>`;
    }).join('');

  const pk = document.getElementById('set-tperiod').value;
  document.getElementById('set-targets').innerHTML = '<tr><th>工場</th><th class="n">目標重量(t)</th><th class="n">目標人工/t</th><th class="n">目標トン単価(円/t)</th><th class="n">目標売上</th></tr>' +
    state.cache.sites.map((site) => {
      const key = pk + '|' + site, t = s.targets[key] || {};
      return `<tr><td>${esc(site)}</td><td class="n">${numInput({ k: 'target', key, f: 'weight' }, t.weight, 0.1)}</td><td class="n">${numInput({ k: 'target', key, f: 'ninkuPerTon' }, t.ninkuPerTon, 0.01)}</td><td class="n">${numInput({ k: 'target', key, f: 'unitPrice' }, t.unitPrice, 100)}</td><td class="n" id="ts-${esc(site)}"></td></tr>`;
    }).join('');
  renderTargetSales();
  renderSettingsWorks();
}

function renderTargetSales() {
  const pk = document.getElementById('set-tperiod').value;
  state.cache.sites.forEach((site) => {
    const t = state.settings.targets[pk + '|' + site] || {};
    const el = document.getElementById('ts-' + site);
    if (el) el.textContent = t.weight && t.unitPrice ? yen(t.weight * t.unitPrice) + '円' : '—';
  });
}

function renderSettingsWorks() {
  const s = state.settings;
  const q = document.getElementById('set-wsearch').value.trim().toLowerCase();
  const onlyUnset = document.getElementById('set-wunset').checked;
  const list = Object.keys(state.cache.works).filter((wn) => state.cache.works[wn].totalWeight > 0)
    .filter((wn) => !q || (wn + ' ' + state.cache.works[wn].name).toLowerCase().includes(q))
    .filter((wn) => !onlyUnset || !(s.works[wn] && s.works[wn].contract))
    .sort().reverse();
  document.getElementById('set-works').innerHTML = '<tr><th>工事No</th><th>工事名</th><th class="n">生産実績の総重量(t)</th><th class="n">総重量(上書き・t)</th><th class="n">契約金額(円)</th><th class="n">トン単価(円/t)</th></tr>' +
    list.map((wn) => {
      const w = s.works[wn] || {}, info = state.cache.works[wn];
      return `<tr><td>${esc(wn)}</td><td>${esc(info.name)}</td><td class="n">${ton(info.totalWeight)}</td><td class="n">${numInput({ k: 'work', wn, f: 'totalWeight' }, w.totalWeight, 0.1)}</td><td class="n">${numInput({ k: 'work', wn, f: 'contract' }, w.contract, 10000)}</td><td class="n" id="wp-${esc(wn)}">${yen(C.unitPriceOf(wn, state.cache, s).price)}</td></tr>`;
    }).join('');
}

/* ===================== デモ(?demo=1) ===================== */

function demoApi(action, extra) {
  if (!state.demoCache) {
    state.demoCache = makeDemoCache();
    state.demoSettings = Object.assign(C.defaultSettings(), { standardUnitPrice: 250000,
      works: { '26-01': { contract: 60000000, totalWeight: 200 }, '26-02': { contract: 45000000, totalWeight: null } } });
  }
  if (action === 'saveSettings') { state.demoSettings = JSON.parse(JSON.stringify(extra.settings)); }
  return Promise.resolve({ cache: state.demoCache, settings: state.demoSettings || null, ok: true });
}

function makeDemoCache() {
  let seed = 7;
  const rnd = () => (seed = (seed * 16807) % 2147483647) / 2147483647;
  const sites = ['本社', '夢前', '鳥取'];
  const works = {};
  for (let i = 1; i <= 12; i++) works['26-' + String(i).padStart(2, '0')] = { name: 'デモ工事' + i, totalWeight: 0 };
  const rec = [];
  const start = Date.UTC(2025, 10, 21), end = Date.now();
  for (let t = start; t < end; t += 86400000) {
    const ymd = C.utcToYmd(t);
    if (new Date(t).getUTCDay() === 0) continue;
    sites.forEach((site, si) => {
      const wn = Object.keys(works)[Math.floor(rnd() * 12)];
      const w = (4 + si * -1 + rnd() * 3);
      rec.push([ymd, site, wn, +w.toFixed(3), +(w * (3 + rnd() * 2) * 8).toFixed(2)]);
      rec.push([ymd, site, '00-00', 0, +(8 + rnd() * 16).toFixed(2)]);
      works[wn].totalWeight += w;
    });
  }
  return { generatedAt: new Date().toISOString(), sites, works, rec, warnings: ['デモデータで表示しています(?demo=1)'] };
}
