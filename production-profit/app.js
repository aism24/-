/* 生産損益分析 - 画面ロジック(計算はcalc.jsのPPCalc、描画はChart.js) */
'use strict';

// GASのウェブアプリURL(gas/Code.gsをデプロイしたURL)。README参照。
const GAS_API_URL = 'https://script.google.com/macros/s/AKfycbzmypFiUSkOwBsDW49EP11sagGjpwsh0DXBSrKbvJONn0MymshWeJl-WBjIx-LGrJG5/exec';
// ?demo=1 で開くと、GAS無しでダミーデータにより画面を確認できる(保存は画面内のみ)。
const DEMO = new URLSearchParams(location.search).get('demo') === '1';

const C = PPCalc;
const SITE_COLORS = ['--s1', '--s2', '--s3'];
const state = { cache: null, settings: null, pw: '', editPw: '', charts: {}, simBase: null };

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
  // 集計対象は本社・夢前・鳥取の3工場のみ(「中止」など他の加工先・所属は除外。GAS側でも除外している)
  state.cache.sites = C.DEFAULT_SITES.slice();
  state.cache.rec = (state.cache.rec || []).filter((r) => C.DEFAULT_SITES.indexOf(r[1]) >= 0);
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

  ['f-period', 'f-fiscal', 'f-work'].forEach((id) => {
    document.getElementById(id).onchange = onFilterChange;
  });
  document.getElementById('refresh-btn').onclick = refresh;
  // 期間の「年度・月〆」ボタン(どちらか一方だけ選べる)
  document.getElementById('f-modes').onclick = (e) => {
    const b = e.target.closest('button');
    if (!b) return;
    document.getElementById('f-mode').value = b.dataset.mode;
    onFilterChange();
  };
  // 月度の◀▶: 1か月ずつ移動(リストは新しい順)
  const stepPeriod = (d) => {
    const i = selP.selectedIndex + d;
    if (i < 0 || i >= selP.options.length) return;
    selP.selectedIndex = i;
    onFilterChange();
  };
  document.getElementById('f-prev').onclick = () => stepPeriod(1);
  document.getElementById('f-next').onclick = () => stepPeriod(-1);
  document.getElementById('reset-btn').onclick = () => { applyDefaults(); renderAll(); };
  document.getElementById('w-search').oninput = () => renderWorks();
  document.getElementById('w-alloc').onchange = () => renderWorks();
  document.getElementById('w-csv').onclick = downloadWorksCsv;
  initSim();
  initSettings();
  applyDefaults();
}

/* 開いたとき・リセット時の既定表示: 本日を含む「今期」・3工場・全工事・目標シミュレーター */
function applyDefaults() {
  const today = C.utcToYmd(Date.now() + 9 * 3600 * 1000);
  const fy = String(C.fiscalYearOf(C.periodKeyOf(today)));
  document.getElementById('f-mode').value = 'fiscal';
  const selF = document.getElementById('f-fiscal');
  selF.value = fy;
  if (selF.value !== fy) selF.selectedIndex = 0;
  document.getElementById('f-site').value = '';
  document.querySelectorAll('#f-sites button').forEach((x) => x.classList.toggle('active', x.dataset.site === ''));
  document.getElementById('f-work').value = '';
  document.querySelectorAll('.tabs button').forEach((x) => x.classList.toggle('active', x.dataset.tab === 'sim'));
  document.querySelectorAll('.tab').forEach((t) => t.classList.toggle('active', t.id === 'tab-sim'));
  state.simBase = null;
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

/* 3行目の工事リスト: 選択中の期間・工場に生産重量がある工事だけを並べる
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
  // 生産量がゼロ(表示で0.0t)の工事は除外する
  const list = Object.keys(found).filter((wn) => wn !== C.COMMON_WORK && found[wn].weight >= 0.05).sort().reverse();
  if (found[C.COMMON_WORK]) list.push(C.COMMON_WORK);
  const name = (wn) => wn === C.COMMON_WORK ? '共通(工事なし)' : ((state.cache.works[wn] || {}).name || '');
  sel.innerHTML = '<option value="">全工事</option>' + list.map((wn) =>
    `<option value="${esc(wn)}">${esc(wn === C.COMMON_WORK ? '' : wn + '　')}${esc(name(wn))}(${ton(found[wn].weight)}t)</option>`).join('');
  sel.value = list.includes(cur) ? cur : '';
  // 契約金額が未入力で、この期間に生産実績がある工事(売上0円として計算される)を警告する
  const noPrice = list.filter((wn) => wn !== C.COMMON_WORK && found[wn].weight > 0 && C.unitPriceOf(wn, state.cache, state.settings).source === 'none');
  const warn = document.getElementById('f-price-warn');
  warn.hidden = !noPrice.length;
  warn.title = noPrice.join('、'); // 1行に収まらず省略されたときは、マウスを乗せると全件を表示
  warn.textContent = noPrice.length ? `契約金額が未入力の工事があります(売上0円で計算): ${noPrice.slice(0, 5).join('、')}${noPrice.length > 5 ? ' ほか' + (noPrice.length - 5) + '件' : ''}` : '';
  document.getElementById('f-work-note').textContent = sel.value ? '工事に絞ると固定費は工場の固定費を売上比で配賦します' : list.length + '件';
  return sel.value;
}

function selection() {
  const mode = document.getElementById('f-mode').value;
  document.querySelectorAll('#f-modes button').forEach((x) => x.classList.toggle('active', x.dataset.mode === mode));
  document.getElementById('f-period-wrap').hidden = mode !== 'period';
  document.getElementById('f-fiscal-wrap').hidden = mode !== 'fiscal';
  const selPer = document.getElementById('f-period');
  document.getElementById('f-prev').disabled = selPer.selectedIndex >= selPer.options.length - 1;
  document.getElementById('f-next').disabled = selPer.selectedIndex <= 0;
  const r = mode === 'period' ? C.periodRange(selPer.value) : C.fiscalRange(Number(document.getElementById('f-fiscal').value));
  const site = document.getElementById('f-site').value;
  const sites = site ? [site] : state.cache.sites;
  document.getElementById('f-range-text').textContent = r.from.replace(/-/g, '/') + ' 〜 ' + r.to.replace(/-/g, '/');
  const work = refreshWorkList(r.from, r.to, sites);
  return { mode, from: r.from, to: r.to, site, sites, work, periodKey: mode === 'period' ? selPer.value : null };
}

function renderAll() {
  if (!state.cache) return;
  const active = document.querySelector('.tabs button.active').dataset.tab;
  const sel = selection();
  if (active === 'works') return renderWorks(sel);
  if (active === 'settings') return renderSettings();
  const an = C.analyze(state.cache, state.settings, sel.from, sel.to, sel.sites, sel.work || undefined);
  if (active === 'dash') renderDash(sel, an);
  if (active === 'bep') renderBep(sel, an);
  if (active === 'sim') renderSim(sel, an);
}

/* ===================== KPI ===================== */

function kpi(label, value, unit, sub, cls) {
  return `<div class="kpi"><div class="label">${label}</div><div class="value ${cls || ''}">${value}<span class="unit">${unit || ''}</span></div><div class="sub">${sub || ''}</div></div>`;
}
/* 目標は利益目標額(売上×利益率)の1つだけ。損益がこれ以上なら達成。 */
function goalKpi(profit, goal, hasSales, render) {
  const ok = hasSales && profit - goal >= -1; // 1円未満の誤差は達成扱い
  const d = profit - goal;
  return (render || kpi)('利益目標額', yen(goal), '円', hasSales ? `<span class="${ok ? 'pos' : 'neg'}">${ok ? '達成' : '未達'}</span>(損益との差 <span class="${d >= 0 ? 'pos' : 'neg'}">${d >= 0 ? '+' : ''}${yen(d)}</span>円)` : '売上なし',
    hasSales ? (ok ? 'pos' : 'neg') : '');
}

function renderDash(sel, an) {
  const t = an.total;
  const note = document.getElementById('dash-note');
  note.hidden = !t.estimated;
  note.textContent = '費用の実額(スプシ「費用設定」)が未入力の工場は、実績売上を配分率で割り付けているため、損益は利益率(' +
    state.settings.rates.profit + '%)どおりの見込み値になります。実額を入れると、実態との差が表れます。';
  document.getElementById('kpis').innerHTML = [
    kpi('生産重量', ton(t.weight), 't', ''),
    kpi('1t当たり人工数', npt(t.ninkuPerTon), '人工/t', `総工数 ${fmt(t.hours, 1)}h(${fmt(t.ninku, 1)}人工)`),
    kpi('平均トン単価', yen(t.unitPrice), '円/t', ''),
    kpi('売上額', yen(t.sales), '円', ''),
    kpi('損益', yen(t.profit), '円', `利益率 ${pct(t.profitRate)}`, t.profit >= 0 ? 'pos' : 'neg'),
    goalKpi(t.profit, t.profitGoal, t.sales > 0),
    kpi('損益分岐生産量', ton(t.breakEvenTons), 't', t.breakEvenTons !== null ? `実績は損益分岐生産量の ${pct(t.weight / t.breakEvenTons)}` : '限界利益がマイナスのため到達不能'),
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

  const head = '<tr><th>月度</th><th class="n">生産重量(t)</th><th class="n">工数(h)</th><th class="n">人工/t</th><th class="n">トン単価</th><th class="n">売上</th><th class="n">人件費</th><th class="n">変動費</th><th class="n">固定費</th><th class="n">損益</th><th class="n">利益率</th><th class="n">損益分岐生産量(t)</th></tr>';
  const rowHtml = (label, x, cls) => `<tr class="${cls || ''}"><td>${label}</td><td class="n">${ton(x.weight)}</td><td class="n">${fmt(x.hours, 1)}</td><td class="n">${npt(x.ninkuPerTon)}</td><td class="n">${yen(x.unitPrice)}</td><td class="n">${yen(x.sales)}</td><td class="n">${yen(x.labor)}</td><td class="n">${yen(x.variable)}</td><td class="n">${yen(x.fixed)}</td><td class="n ${x.profit >= 0 ? 'pos' : 'neg'}">${yen(x.profit)}</td><td class="n">${pct(x.profitRate)}</td><td class="n">${ton(x.breakEvenTons)}</td></tr>`;
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
  // ダッシュボードのグラフ(Chart.js)も画面と同じフォント(英数字はInter・等幅数字)にする
  Chart.defaults.font.family = getComputedStyle(document.body).fontFamily;
  state.charts[id] = new Chart(document.getElementById(id), cfg);
}

/* 損益分岐生産量グラフ(SVG。横軸=生産トン数、縦軸=金額)。
   o: {fixed, unitPrice, laborPerTon, varPerTon, profitRate, x(つまみの初期位置t), beTons, goalTons, handleLabel, onMove(t)}
   面の塗り分け: 固定費帯 / 人件費帯 / 変動費帯 / 損失域(分岐点の左、売上線と総費用線の間) / 利益域(右)。
   つまみ(縦の点線)をドラッグすると、その重量での内訳(固定費・人件費・変動費・利益or損失)を積み上げバーで表示する。 */
const bepState = {};
function niceStep(range, count) {
  const raw = range / Math.max(count, 1), mag = Math.pow(10, Math.floor(Math.log10(raw || 1)));
  const n = raw / mag;
  return (n <= 1 ? 1 : n <= 2 ? 2 : n <= 5 ? 5 : 10) * mag;
}
/* 1億円以上は「7.6億円」(小数1桁)、未満は万円表示 */
function oku(v) { return Math.abs(v) >= 1e8 ? fmt(v / 1e8, 1) + '億円' : man(v); }
function man(v) { return Math.abs(v) >= 10000 ? fmt(v / 10000, 0) + '万円' : yen(v) + '円'; }

function drawBep(id, o) {
  const box = document.getElementById(id);
  const prev = bepState[id];
  // 同じ条件の再描画(ドラッグ中など)ではつまみ位置を保つ。条件が変わったら初期位置に戻す。
  const sig = o.sig || [o.fixed, o.unitPrice, o.laborPerTon, o.varPerTon, o.profitRate].join('|');
  const st = bepState[id] = { o, x: (prev && prev.sig === sig && !o.forceX) ? prev.x : (o.x || 0), sig, maxX: prev && prev.sig === sig && !o.forceX ? prev.maxX : null }; // ドラッグ中以外は縮尺を取り直す
  if (!st.maxX) st.maxX = Math.max(o.x || 0, o.beTons || 0, o.goalTons || 0, 1) * 1.35;
  box.classList.toggle('fixedX', !!o.fixedX); // fixedX: つまみを動かせない(実績の損益分岐生産量タブ)
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
      if (s.o.fixedX || !g || e.clientY - r.top > g.t + g.h + 4) return;
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
  const g = st.geom = { l: 76, r: 16, t: 54, b: 36 }; // 上の余白につまみ、左の余白に固定費ラベルを置く
  g.w = W - g.l - g.r; g.h = H - g.t - g.b;
  // グラフ内の文字・間隔の倍率(幅1080×高さ600程度のグラフを1倍とし、グラフの大きさに合わせて拡大縮小)
  const k = Math.min(1.3, Math.max(0.55, Math.min(g.w / 1080, g.h / 600)));
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
  for (let v = 0; v <= maxY + 1e-9; v += ys) {
    h += `<line class="bg" x1="${g.l}" x2="${g.l + g.w}" y1="${Y(v)}" y2="${Y(v)}"/>`;
    // 左余白の固定費ラベル(2行)と重なる目盛りの数字は出さない
    if (Math.abs(Y(v) - Y(F)) > (o.fixedLabel ? 34 : 22) * Math.max(1, k)) h += `<text class="ax" x="${g.l - 6}" y="${Y(v) + 4}" text-anchor="end">${fmt(v / 10000, 0)}万</text>`;
  }
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
  h += `<text class="lbl fixedLbl" x="${g.l - 6}" y="${Y(F) - 3}" text-anchor="end">${(o.fixedLabel || ['その他固定費']).map((t, i) => i ? `<tspan x="${g.l - 6}" dy="${13 * Math.max(1, k)}">${t}</tspan>` : t).join('')}<tspan x="${g.l - 6}" dy="${14 * Math.max(1, k)}">${man(F)}</tspan></text>`;
  h += `<line class="lCost" x1="${X(0)}" y1="${Y(F)}" x2="${X(maxX)}" y2="${Y(cost(maxX))}"/>`;
  h += `<line class="lSales" x1="${X(0)}" y1="${Y(0)}" x2="${X(maxX)}" y2="${Y(sales(maxX))}"/>`;
  h += `<text class="lbl lineLbl" x="${X(maxX) - 4}" y="${Y(sales(maxX)) + 26 * k}" text-anchor="end">売上</text>`;
  h += `<text class="lbl cost lineLbl" x="${X(maxX) - 4}" y="${Y(cost(maxX)) + 26 * k}" text-anchor="end">総費用</text>`;
  // 損益分岐生産量(軸への補助線付き)
  let beLbl = '';
  if (be !== null) {
    const bx = X(be), by = Y(sales(be));
    h += `<line class="lBe" x1="${bx}" x2="${bx}" y1="${by}" y2="${g.t + g.h}"/><line class="lBe" x1="${g.l}" x2="${bx}" y1="${by}" y2="${by}"/>`;
    h += `<circle class="mBeHalo" cx="${bx}" cy="${by}" r="11"/><circle class="mBe" cx="${bx}" cy="${by}" r="7"/>`;
    // 損益分岐の5項目(引き出し線で左上の空白へ。位置は描画後に文字の大きさを測って決める)。
    // トン単価・人工数・工数は、つまみ位置の生産重量で損益0になる値。
    const w = st.x, lr = o.laborRate || 0, oF = o.otherFixed !== undefined ? o.otherFixed : F;
    const nBe = w > 0 && lr > 0 ? (P - vr - oF / w) / lr : null;
    // [項目, 数値, 単位]。数値は右端をそろえる(描画後に列幅を測って配置)
    const lines = [
      ['生産量', ton(be), 't'],
      ['売上高', fmt(sales(be) / 10000, 0), '万円'],
      ['トン単価', w > 0 ? yen(F / w + vr + lab) : '—', '円/t'],
      ['人工数', nBe !== null ? npt(nBe) : '—', '人工'],
      ['工数', nBe !== null ? fmt(nBe * w * C.HOURS_PER_NINKU, 0) : '—', 'h'],
    ];
    st.beLh = 22 * k;
    beLbl = `<line class="beLead"/><rect class="beBg" rx="6"/><g class="beInfo"><text class="lbl be bT" text-anchor="middle">損益分岐値</text>${lines.map(([a, b, c]) =>
      `<text class="lbl be bL">${a}</text><text class="lbl be bN" text-anchor="end">${b}</text><text class="lbl be bU">${c}</text>`).join('')}</g>`; // 文字は最前面に描く
    st.beAt = { bx, by };
  } else st.beAt = null;
  // つまみ位置の内訳バー
  const x = st.x, cx = X(x), bw = 8;
  // 人件費は固定費に含めて1つの帯で表示する
  const segs = [['固定費(人件費込み)', 0, F + lab * x, 'bFixed'], ['変動費', F + lab * x, cost(x), 'bVar']];
  const profit = sales(x) - cost(x);
  if (profit >= 0) segs.push(['利益', cost(x), sales(x), 'bProfit']); else segs.push(['損失', sales(x), cost(x), 'bLoss']);
  h += `<line class="lCursor" x1="${cx}" x2="${cx}" y1="${g.t - 10}" y2="${g.t + g.h}"/>`;
  const labels = [];
  segs.forEach(([name, y0, y1, cls]) => {
    if (y1 - y0 <= 0) return;
    h += `<rect class="${cls}" x="${cx - bw / 2}" width="${bw}" y="${Y(y1)}" height="${Math.max(1, Y(y0) - Y(y1))}"/>`;
    labels.push({ text: `${name} ${man(y1 - y0)}`, y: (Y(y0) + Y(y1)) / 2 + 6 * k, cls });
  });
  // ラベルの重なりを避ける(下から順に最低24px×倍率の間隔)
  labels.sort((a, b) => b.y - a.y);
  const gap = 24 * k;
  for (let i = 1; i < labels.length; i++) if (labels[i - 1].y - labels[i].y < gap) labels[i].y = labels[i - 1].y - gap;
  const right = cx < g.l + g.w * 0.62;
  labels.forEach((lb) => { h += `<text class="lbl seg ${lb.cls}" x="${right ? cx + 10 : cx - 10}" y="${lb.y}" text-anchor="${right ? 'start' : 'end'}">${lb.text}</text>`; });
  // つまみ(グラフの上端。左右の端でははみ出さないように寄せる)
  // 2行(ラベル / 重量)・中央揃え
  const hl1 = o.handleLabel || '生産重量', hl2 = `${ton(x)}t`;
  const hw = Math.max(hl1.length * 13, hl2.length * 7.5) + 22;
  const hx = Math.min(W - 4 - hw / 2, Math.max(4 + hw / 2, cx));
  h += `<g class="handle"><rect x="${hx - hw / 2}" y="${g.t - 50}" width="${hw}" height="40" rx="10"/><text x="${hx}" y="${g.t - 34}" text-anchor="middle">${hl1}<tspan x="${hx}" dy="16">${hl2}</tspan></text></g>`;
  h += beLbl;
  // 利益目標達成点(★・目標表示は最前面に描く。試算の破線やバーは裏側を通る)
  if (o.goalTons !== null && o.goalTons !== undefined && o.goalTons <= maxX) {
    const gx = X(o.goalTons), gy = Y(sales(o.goalTons));
    st.goalAt = { gx, gy };
    // ★印(2倍)と「目標生産量/目標利益額」(2倍・黄色背景がゆっくり点滅。背景の大きさは描画後に文字に合わせる)
    const star = Array.from({ length: 10 }, (_, i) => {
      const r = (i % 2 ? 6 : 15) * k, a = -Math.PI / 2 + i * Math.PI / 5;
      return `${(gx + r * Math.cos(a)).toFixed(1)},${(gy + r * Math.sin(a)).toFixed(1)}`;
    }).join(' ');
    const left = gx > g.l + 290 * k, up = gy - 76 * k > g.t;
    const tx = left ? gx - 22 * k : gx + 22 * k, ty = up ? gy - 44 * k : gy + 34 * k;
    h += `<rect class="goalBg" rx="6"/><text class="lbl good goalLbl" x="${tx}" y="${ty}" text-anchor="${left ? 'end' : 'start'}">目標生産量 ${ton(o.goalTons)}t<tspan x="${tx}" dy="${28 * k}">目標利益額 ${oku(sales(o.goalTons) * (o.profitRate || 0))}</tspan></text>`;
    h += `<circle class="goalBg" cx="${gx}" cy="${gy}" r="${22.5 * k}"/><polygon class="mGoal" points="${star}"/>`; // ★の背景に1.5倍の〇(黄色・点滅)
  }
  box.innerHTML = `<svg class="bepSvg" style="--k:${k.toFixed(3)}" width="${W}" height="${H}" viewBox="0 0 ${W} ${H}" role="img" aria-label="損益分岐生産量グラフ">${h}</svg>`;
  const gl = box.querySelector('.goalLbl'), gb = box.querySelector('rect.goalBg');
  if (gl && gb) {
    const bb = gl.getBBox();
    gb.setAttribute('x', bb.x - 6); gb.setAttribute('y', bb.y - 3);
    gb.setAttribute('width', bb.width + 12); gb.setAttribute('height', bb.height + 6);
  }
  // 損益分岐値: グラフの左上に置き、点から引き出し線を引く
  const bi = box.querySelector('.beInfo');
  if (bi && st.beAt) {
    // 列幅(項目・数値・単位)を測り、3列に並べる
    const col = (sel) => [...bi.querySelectorAll(sel)];
    const wmax = (els) => Math.max(0, ...els.map((e) => e.getBBox().width));
    const Ls = col('.bL'), Ns = col('.bN'), Us = col('.bU');
    const lw = wmax(Ls), nw = wmax(Ns), uw = wmax(Us), lh = st.beLh, asc = lh * 0.78;
    const T = bi.querySelector('.bT'), tw = T.getBBox().width; // 見出し「損益分岐値」(1行目・中央揃え)
    const cw = lw + 10 + nw + 3 + uw, bw = Math.max(cw, tw);
    const bb = { width: bw, height: lh * (Ls.length + 1) }, pad = 6;
    // 候補: ①グラフの左上(既定) ②点の左上 ③左端に寄せる。目標表示(黄色)と重ならない最初の候補を使う
    const gr = gb && gb.getAttribute('width') ? { x: +gb.getAttribute('x'), y: +gb.getAttribute('y'), w: +gb.getAttribute('width'), h: +gb.getAttribute('height') } : null;
    const hit = (l, t) => gr && l - pad < gr.x + gr.w && l + bb.width + pad > gr.x && t - pad < gr.y + gr.h && t + bb.height + pad > gr.y;
    const cands = [[g.l + pad + 2, g.t + pad], [st.beAt.bx - 40 - bb.width, st.beAt.by - 40 - bb.height], [g.l + pad + 2, st.beAt.by - 40 - bb.height]]
      .map(([l, t]) => [Math.max(g.l + pad + 2, l), Math.max(g.t + pad, t)]);
    let pick = cands.find(([l, t]) => !hit(l, t));
    if (!pick && gl && st.goalAt) {
      // どこに置いても目標表示と重なるときは、目標表示を★の下へ移してから置き直す
      const ny = st.goalAt.gy + 40 * k;
      gl.setAttribute('y', ny);
      const b2 = gl.getBBox();
      gb.setAttribute('x', b2.x - 6); gb.setAttribute('y', b2.y - 3);
      gr.x = b2.x - 6; gr.y = b2.y - 3; gr.w = b2.width + 12; gr.h = b2.height + 6;
      pick = cands.find(([l, t]) => !hit(l, t));
    }
    const [left, top] = pick || cands[cands.length - 1];
    T.setAttribute('x', left + bw / 2); T.setAttribute('y', top + asc);
    Ls.forEach((e, i) => {
      const y = top + asc + (i + 1) * lh;
      e.setAttribute('x', left); e.setAttribute('y', y);
      Ns[i].setAttribute('x', left + lw + 10 + nw); Ns[i].setAttribute('y', y);
      Us[i].setAttribute('x', left + lw + 10 + nw + 3); Us[i].setAttribute('y', y);
    });
    const rb = box.querySelector('.beBg');
    rb.setAttribute('x', left - pad); rb.setAttribute('y', top - pad / 2);
    rb.setAttribute('width', bb.width + pad * 2); rb.setAttribute('height', bb.height + pad);
    const ln = box.querySelector('.beLead');
    ln.setAttribute('x1', st.beAt.bx); ln.setAttribute('y1', st.beAt.by);
    ln.setAttribute('x2', left + bb.width + pad); ln.setAttribute('y2', top + bb.height + pad / 2);
  }
}

/* ===================== 損益分岐生産量タブ ===================== */

function renderBep(sel, an) {
  const t = an.total;
  const perTon = (t.varPerTon || 0) + (t.laborPerTon || 0);
  const p = state.settings.rates.profit / 100;
  document.getElementById('bep-kpis').innerHTML = [
    kpi('損益分岐生産量', ton(t.breakEvenTons), 't', '売上 ' + yen(t.breakEvenTons !== null ? t.breakEvenTons * t.unitPrice : null) + '円'),
    kpi('利益目標達成トン数', ton(t.goalTons), 't', '目標売上額 ' + yen(t.goalSales) + '円'),
    kpi('実績生産重量', ton(t.weight), 't', t.goalTons ? `目標達成まで ${ton(Math.max(0, t.goalTons - t.weight))}t` : ''),
    kpi('1t当たり限界利益', yen(t.unitPrice !== null ? t.unitPrice - perTon : null), '円/t', `トン単価 ${yen(t.unitPrice)} − 変動費 ${yen(t.varPerTon)} − 人件費 ${yen(t.laborPerTon)}`),
  ].join('');
  drawBep('c-bep', { fixed: t.fixed, unitPrice: t.unitPrice || 0, laborPerTon: t.laborPerTon || 0, varPerTon: t.varPerTon || 0, laborRate: t.laborRate,
    profitRate: p, x: t.weight, fixedX: true, beTons: t.breakEvenTons, goalTons: t.goalTons, handleLabel: '生産重量' });
  const rows = [
    ['固定費(期間計)', yen(t.fixed) + ' 円', '費用設定の月固定費×月数、未入力の工場は 基準売上×固定費率'],
    ['トン単価(平均)', yen(t.unitPrice) + ' 円/t', '売上 ÷ 生産重量(工事ごとの契約金額÷総重量で計算した売上の合計)'],
    ['変動費単価', yen(t.varPerTon) + ' 円/t', '実額未入力の工場は 基準トン単価×変動費率'],
    ['1t当たり人件費', yen(t.laborPerTon) + ' 円/t', `人工/t ${npt(t.ninkuPerTon)} × 人件費単価 ${yen(t.laborRate)}円/人工`],
    ['利益率(目標)', pct(p), '設定タブの配分率'],
    ['損益分岐生産量', ton(t.breakEvenTons) + ' t', '固定費 ÷ (トン単価 − 変動費単価 − 1t当たり人件費)'],
    ['利益目標達成点', ton(t.goalTons) + ' t', '固定費 ÷ (トン単価×(1−利益率) − 変動費単価 − 1t当たり人件費)'],
  ];
  document.getElementById('t-bep').innerHTML = '<tr><th>項目</th><th class="n">値</th><th>計算方法</th></tr>' +
    rows.map((r) => `<tr><td>${r[0]}</td><td class="n">${r[1]}</td><td class="muted small">${r[2]}</td></tr>`).join('');
}

/* ===================== シミュレーション ===================== */

// 入力欄の表示桁(生産重量=#,##0.0 / 人工/t=0.00 / トン単価=#,##0)。「,」区切りを出すため入力欄はtext型
const SIM_DIGITS = { w: 1, n: 2, p: 0 };
const simFmt = (k, v) => fmt(v, SIM_DIGITS[k]);
let simDragging = false;
function initSim() {
  Object.keys(SIM_DIGITS).forEach((k) => {
    const el = document.getElementById('s-' + k);
    el.oninput = updateSim;
    // 入力中は自由に打てるようにし、欄を離れたら「,」区切りの形に整える
    el.onchange = () => {
      const v = parseNum(el.value);
      const ex = (state.simExact || {})[k];
      if (ex && Math.abs(v - parseNum(ex.shown)) < 1e-9) { el.value = ex.shown; return; }
      el.value = simFmt(k, v);
      updateSim();
    };
  });
  document.getElementById('s-reset').onclick = () => { state.simBase = null; renderAll(); };
}

function renderSim(sel, an) {
  const t = an.total;
  // 初期値は選択中の期間・工場・工事の実績
  const base = {
    w: t.weight,
    n: t.ninkuPerTon || 0,
    p: t.unitPrice || 0,
  };
  state.simTotal = t;
  // 固定費の内訳(工場1か所の月固定費 × 工場数 × 月数)。工事を選んでいるときは配賦前の工場の固定費から出す
  const fm = (sel.work ? C.analyze(state.cache, state.settings, sel.from, sel.to, sel.sites) : an).models;
  const frac = fm.reduce((a, m) => a + m.frac, 0), fix = fm.reduce((a, m) => a + m.fixed, 0);
  const months = sel.sites.length ? frac / sel.sites.length : 0;
  state.simFixedNote = frac > 0 ? `${yen(fix / frac)}円/月 × ${sel.sites.length}工場 × ${fmt(months, Math.abs(months - Math.round(months)) < 0.05 ? 0 : 1)}か月` + (sel.work ? '(工事へ売上比で配賦)' : '') : '';
  renderSimWorks(an);
  if (!state.simBase) {
    state.simBase = base;
    state.simExact = {};
    const set = (k, v) => {
      const n = document.getElementById('s-' + k);
      n.value = simFmt(k, v);
      // 表示は丸めるが、数値欄を触っていない間は丸める前の値で計算する(基準値で損益が配分どおりになるように)
      state.simExact[k] = { shown: n.value, value: v };
    };
    ['w', 'n', 'p'].forEach((k) => set(k, base[k]));
  }
  updateSim();
}

/* 入力欄の右に、工事ごとの実績(生産重量・人工/t・トン単価・売上額(概算)=生産重量×トン単価)を工事番号の昇順に並べる */
function renderSimWorks(an) {
  const rows = C.workBreakdown(an, state.cache)
    .filter((r) => r.workNo !== C.COMMON_WORK && r.weight > 0)
    .sort((a, b) => a.workNo.localeCompare(b.workNo, 'ja', { numeric: true })); // 工事番号の昇順
  const box = document.getElementById('sim-works');
  if (!rows.length) { box.innerHTML = '<div class="muted small simEmpty">この条件で生産実績のある工事はありません</div>'; return; }
  box.innerHTML = rows.map((r) => `<div class="simCol" title="${esc(r.workNo + ' ' + r.name)}">
    <div class="simHead"><b>${esc(r.workNo)}</b><span>${esc(r.name)}</span></div>
    <div class="simCell">${fmt(r.weight, 1)}</div>
    <div class="simCell">${npt(r.ninkuPerTon)}</div>
    <div class="simCell ${r.unitPrice ? '' : 'neg'}">${r.unitPrice ? yen(r.unitPrice) : '未入力'}</div>
    <div class="simCell simSales">${yen(r.sales)}</div>
  </div>`).join('');
}

function parseNum(v) { return Number(String(v).replace(/[,，\s]/g, '')) || 0; }

function simValue(k) {
  const v = document.getElementById('s-' + k).value, ex = (state.simExact || {})[k];
  return ex && ex.shown === v ? ex.value : parseNum(v);
}

/* 試算表の備考: 数値と「達成/未達」だけを大きく表示する(説明文・単位は小さいまま) */
function simNote(note) {
  return String(note || '').replace(/(^|>)([^<]*)/g, (m, a, txt) => a + txt.replace(/[+\-]?\d[\d,]*(\.\d+)?%?/g, '<span class="nv">$&</span>'));
}

function updateSim() {
  const t = state.simTotal;
  if (!t) return;
  const W = simValue('w'), n = simValue('n'), P = simValue('p');
  const r = C.simulate(t, state.settings, W, n, P);
  const b = state.simBase;
  document.getElementById('s-s').value = yen(r.sales); // 売上額(概算)は計算値のみ(入力不可)
  // 現在値(実績)から変えたら「現在値に戻す」を黄色・点滅にして知らせる
  const changed = Math.abs(W - b.w) > 1e-9 || Math.abs(n - b.n) > 1e-9 || Math.abs(P - b.p) > 1e-9;
  document.getElementById('s-reset').classList.toggle('changed', changed);
  const diff = (v, bv, f) => { const d = v - bv; return Math.abs(d) < 0.5 ? '上部試算表参照' : `基準比 ${d > 0 ? '+' : ''}${f(d)}`; };
  // 項目(左)・数値(中)・備考(右)の3列の表
  const sRow = (label, value, unit, note, cls) =>
    `<div class="sLabel">${label}</div><div class="sVal ${cls || ''}">${value}<span class="unit">${unit || ''}</span></div><div class="sNote">${simNote(note)}</div>`;
  document.getElementById('sim-kpis').innerHTML = [
    sRow('売上額(概算)', yen(r.sales), '円', diff(r.sales, b.w * b.p, yen)),
    sRow('損益', yen(r.profit), '円', (r.profitRate === null ? '利益率 —' : `利益率 <span class="${r.profitRate * 100 >= state.settings.rates.profit - 1e-9 ? 'pos' : 'neg'}">${pct(r.profitRate)}</span>`) + `<span class="goalPctWrap">（<b class="goalPct">目標${fmt(state.settings.rates.profit, state.settings.rates.profit % 1 ? 1 : 0)}%</b>）</span>`, r.profit >= 0 ? 'pos' : 'neg'),
    goalKpi(r.profit, r.profitGoal, r.sales > 0, sRow),
    sRow('目標売上額', yen(r.goalSales), '円', r.goalTons !== null ? `必要生産量 ${ton(r.goalTons)}t` + (W >= r.goalTons - 0.05 ? `（<span class="pos">超 ${ton(Math.max(0, W - r.goalTons))}</span>t）` : `（<span class="neg">不足 ${ton(r.goalTons - W)}</span>t）`) : '到達不能'),
    sRow('損益分岐生産量', ton(r.breakEvenTons), 't', r.breakEvenTons !== null ? (W >= r.breakEvenTons ? `<span class="pos">超 ${ton(W - r.breakEvenTons)}</span>t` : `<span class="neg">不足 ${ton(r.breakEvenTons - W)}</span>t`) : '到達不能'),
    sRow('必要人工', fmt(r.ninku, 1), '人工', `${fmt(r.hours, 0)}h`),
    sRow('変動費', yen(r.variable), '円', `${yen(r.varPerTon)}円/t`),
    // 人件費は固定費に含めて表示する(計算は従来どおり 人件費=生産重量×1t当たり人工数×人件費単価)
    sRow('固定費(人件費込み)', yen(r.fixed + r.labor), '円', '人件費 + その他固定費'),
    sRow('<span class="subLbl">└ 人件費</span>', yen(r.labor), '円', `${yen(r.laborRate)}円/人工`),
    sRow('<span class="subLbl">└ その他固定費</span>', yen(r.fixed), '円', state.simFixedNote),
  ].join('');
  // つまみのドラッグで試算の生産重量を動かせる(スライダー・数値欄と連動)
  // 人件費は試算の生産重量での額を固定費に含め、固定費線を水平にする(つまみのドラッグ中に縮尺が変わらないよう、署名は基準値で作る)
  drawBep('c-sim', { fixed: r.fixed + r.labor, unitPrice: P, laborPerTon: 0, varPerTon: r.varPerTon, profitRate: state.settings.rates.profit / 100,
    fixedLabel: ['固定費', '(人件費込み)'], otherFixed: r.fixed, laborRate: r.laborRate, sig: [r.fixed, P, n, r.laborRate, r.varPerTon, state.settings.rates.profit].join('|'),
    x: W, forceX: !simDragging, beTons: r.breakEvenTons, goalTons: r.goalTons, handleLabel: '試算',
    onMove: (t) => {
      simDragging = true;
      document.getElementById('s-w').value = simFmt('w', t);
      updateSim();
      simDragging = false;
    } });
}

/* ===================== 工事別分析 ===================== */

function worksRows(sel) {
  const an = C.analyze(state.cache, state.settings, sel.from, sel.to, sel.sites);
  const q = document.getElementById('w-search').value.trim().toLowerCase();
  let rows = C.workBreakdown(an, state.cache);
  if (q) rows = rows.filter((r) => (r.workNo + ' ' + r.name).toLowerCase().includes(q));
  return rows;
}

function renderWorks(sel) {
  const alloc = document.getElementById('w-alloc').checked;
  const rows = worksRows(sel || selection());
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
  worksRows(sel).forEach((r) => {
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
  document.getElementById('set-wsearch').oninput = renderSettingsWorks;
  document.getElementById('set-wunset').onchange = renderSettingsWorks;
  // 入力はすべて委譲で拾い、state.settingsへ即時反映する(保存ボタンで送信)
  document.getElementById('set-body').addEventListener('input', (e) => {
    const el = e.target, d = el.dataset;
    if (!d.k) return;
    const s = state.settings;
    const v = el.type === 'number' ? (el.value === '' ? null : Number(el.value)) : el.value;
    if (d.k === 'rate') s.rates[d.f] = v === null ? 0 : v;
    else if (d.k === 'common') s.commonWorkNos = v;
    else if (d.k === 'cost') (s.costs[d.site] = s.costs[d.site] || {})[d.f] = v;
    else if (d.k === 'work') {
      const w = (s.works[d.wn] = s.works[d.wn] || { name: (state.cache.works[d.wn] || {}).name || '' });
      w[d.f] = v;
      const cell = document.getElementById('wp-' + d.wn);
      if (cell) cell.textContent = yen(C.unitPriceOf(d.wn, state.cache, s).price);
    }
    document.getElementById('set-dirty').textContent = '未保存の変更があります';
    if (d.k === 'rate') updateRateSum();
  });
}

async function saveSettings() {
  if (!(await ensureEdit())) return;
  showLoading('設定を保存中…');
  try {
    const data = await api('saveSettings', { settings: state.settings });
    state.settings = Object.assign(C.defaultSettings(), data.settings);
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
  document.getElementById('set-common').value = s.commonWorkNos || '';
  document.getElementById('set-common').dataset.k = 'common';

  document.getElementById('set-costs').innerHTML = '<tr><th>工場</th><th class="n">人件費単価(円/人工)</th><th class="n">月固定費(円)</th><th class="n">変動費単価(円/t)</th></tr>' +
    state.cache.sites.map((site) => {
      const c = s.costs[site] || {};
      return `<tr><td>${esc(site)}</td><td class="n">${numInput({ k: 'cost', site, f: 'laborRate' }, c.laborRate, 100)}</td><td class="n">${numInput({ k: 'cost', site, f: 'fixedMonthly' }, c.fixedMonthly, 10000)}</td><td class="n">${numInput({ k: 'cost', site, f: 'variablePerTon' }, c.variablePerTon, 100)}</td></tr>`;
    }).join('');

  renderSettingsWorks();
}

function renderSettingsWorks() {
  const s = state.settings;
  const q = document.getElementById('set-wsearch').value.trim().toLowerCase();
  const onlyUnset = document.getElementById('set-wunset').checked;
  const list = Object.keys(state.cache.works).filter((wn) => state.cache.works[wn].totalWeight > 0)
    .filter((wn) => !q || (wn + ' ' + state.cache.works[wn].name).toLowerCase().includes(q))
    .filter((wn) => !onlyUnset || !(s.works[wn] && s.works[wn].contract))
    .sort().reverse();
  document.getElementById('set-works').innerHTML = '<tr><th>工事No</th><th>工事名</th><th class="n">生産実績の総重量(t)</th><th class="n">契約総重量(t)</th><th class="n">契約金額(円)</th><th class="n">トン単価(円/t)</th></tr>' +
    list.map((wn) => {
      const w = s.works[wn] || {}, info = state.cache.works[wn];
      return `<tr><td>${esc(wn)}</td><td>${esc(info.name)}</td><td class="n">${ton(info.totalWeight)}</td><td class="n">${numInput({ k: 'work', wn, f: 'totalWeight' }, w.totalWeight, 0.1)}</td><td class="n">${numInput({ k: 'work', wn, f: 'contract' }, w.contract, 10000)}</td><td class="n" id="wp-${esc(wn)}">${yen(C.unitPriceOf(wn, state.cache, s).price)}</td></tr>`;
    }).join('');
}

/* ===================== デモ(?demo=1) ===================== */

function demoApi(action, extra) {
  if (!state.demoCache) {
    state.demoCache = makeDemoCache();
    state.demoSettings = Object.assign(C.defaultSettings(), {
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
