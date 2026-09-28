/* 生産損益分析 - 画面ロジック(計算はcalc.jsのPPCalc、描画はChart.js) */
'use strict';

// GASのウェブアプリURL(gas/Code.gsをデプロイしたURL)。README参照。
const GAS_API_URL = 'https://script.google.com/macros/s/AKfycbzmypFiUSkOwBsDW49EP11sagGjpwsh0DXBSrKbvJONn0MymshWeJl-WBjIx-LGrJG5/exec';
// ?demo=1 で開くと、GAS無しでダミーデータにより画面を確認できる(保存は画面内のみ)。
const DEMO = new URLSearchParams(location.search).get('demo') === '1';
// パスワード(閲覧用・編集用)を求めるか。2026-09-28に一時解除 → 2026-09-29に復活(true)。
// gas/Code.gs の REQUIRE_PASSWORD と合わせること(シンプル版は閲覧用パスワード無しで開ける)。
const REQUIRE_PASSWORD = true;

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
  else if (!REQUIRE_PASSWORD) unlock(''); // パスワード解除中は入力画面を出さずに開く(失敗したときは入力画面が残る)
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
  state.lastYmd = C.lastDataYmd(state.cache);
  const w = document.getElementById('warnings');
  const list = state.cache.warnings || [];
  w.hidden = !list.length;
  w.innerHTML = list.map(esc).join('<br>');
  const g = new Date(state.cache.generatedAt);
  document.getElementById('updated').textContent = '集計: ' + g.toLocaleString('ja-JP');
}

// 月末見込みを出すのに必要な、月度の途中の出勤日の実績日数(これ未満は表示しない)
const FC_MIN_DAYS = 3;

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
  // 月〆の選択肢は今日の月度から13か月分(例: 9/25なら 2026年10月度〜2025年10月度)
  const monthFirst = C.shiftPeriod(cur, -12) > first ? C.shiftPeriod(cur, -12) : first;
  const periods = [];
  for (let k = cur; k >= monthFirst; k = C.shiftPeriod(k, -1)) periods.push(k);
  const selP = document.getElementById('f-period');
  selP.innerHTML = periods.map((k) => `<option value="${k}">${C.periodLabel(k)}</option>`).join('');
  // 既定は直近の確定月度=先月度(当月度が始まったばかりの時に空の画面にならないように)。「月〆」を押したとき・リセット時もこの月度にする
  state.defPeriod = periods[1] || periods[0];
  selP.value = state.defPeriod;
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
    const modeEl = document.getElementById('f-mode');
    if (b.dataset.mode === 'period' && modeEl.value !== 'period') selP.value = state.defPeriod; // 年度→月〆は常に先月度から
    modeEl.value = b.dataset.mode;
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
  // 月末見込み ⇔ 実績のみ(月度の途中のときだけ表示)
  document.getElementById('f-fc').onclick = () => { state.fcOff = !state.fcOff; state.simBase = null; renderAll(); };
  document.getElementById('w-search').onchange = () => renderWorks();
  document.getElementById('w-alloc').onchange = () => renderWorks();
  document.getElementById('w-csv').onclick = downloadWorksCsv;
  initSim();
  initSettings();
  applyDefaults();
  applyUrlState();
  document.getElementById('to-simple').onclick = () => { location.href = 'simple.html' + viewQuery(); };
  document.getElementById('to-home').onclick = () => { location.href = 'index.html' + (DEMO ? '?demo=1' : ''); };
}

/* シンプル版・ホームとの行き来: 表示条件(期間・工場・工事・タブ・月末見込み)をURLで受け渡す。
   m=fiscal|period, fy=期, p=月度, s=工場, w=工事No, t=タブ, fc=0(実績のみ)。URLに無い項目は既定のまま。 */
function applyUrlState() {
  const q = new URLSearchParams(location.search);
  const setSel = (id, v) => {
    const el = document.getElementById(id), old = el.value;
    el.value = v;
    if (el.value !== v) el.value = old; // 選択肢に無い値は無視する
  };
  if (q.has('m')) setSel('f-mode', q.get('m'));
  if (q.has('fy')) setSel('f-fiscal', q.get('fy'));
  if (q.has('p')) setSel('f-period', q.get('p'));
  if (q.has('s') && state.cache.sites.includes(q.get('s'))) {
    document.getElementById('f-site').value = q.get('s');
    document.querySelectorAll('#f-sites button').forEach((x) => x.classList.toggle('active', x.dataset.site === q.get('s')));
  }
  if (q.has('w')) state.pendingWork = q.get('w'); // 工事の選択肢は期間・工場で作り直すため、そのときに選ぶ
  const tab = q.get('t');
  if (tab && document.getElementById('tab-' + tab)) {
    document.querySelectorAll('.tabs button').forEach((x) => x.classList.toggle('active', x.dataset.tab === tab));
    document.querySelectorAll('.tab').forEach((t) => t.classList.toggle('active', t.id === 'tab-' + tab));
  }
  if (q.get('fc') === '0') state.fcOff = true;
}

function viewQuery() {
  const q = new URLSearchParams();
  if (DEMO) q.set('demo', '1');
  q.set('m', document.getElementById('f-mode').value);
  q.set('fy', document.getElementById('f-fiscal').value);
  q.set('p', document.getElementById('f-period').value);
  const site = document.getElementById('f-site').value, work = document.getElementById('f-work').value;
  if (site) q.set('s', site);
  if (work) q.set('w', work);
  q.set('t', document.querySelector('.tabs button.active').dataset.tab);
  if (state.fcOff) q.set('fc', '0');
  return '?' + q.toString();
}

/* 開いたとき・リセット時の既定表示: 本日を含む「今期」・3工場・全工事・目標シミュレーター */
function applyDefaults() {
  const today = C.utcToYmd(Date.now() + 9 * 3600 * 1000);
  const fy = String(C.fiscalYearOf(C.periodKeyOf(today)));
  document.getElementById('f-mode').value = 'fiscal';
  if (state.defPeriod) document.getElementById('f-period').value = state.defPeriod; // 月〆に切り替えたときの月度も既定(先月度)に戻す
  const selF = document.getElementById('f-fiscal');
  selF.value = fy;
  if (selF.value !== fy) selF.selectedIndex = 0;
  document.getElementById('f-site').value = '';
  document.querySelectorAll('#f-sites button').forEach((x) => x.classList.toggle('active', x.dataset.site === ''));
  document.getElementById('f-work').value = '';
  document.querySelectorAll('.tabs button').forEach((x) => x.classList.toggle('active', x.dataset.tab === 'sim'));
  document.querySelectorAll('.tab').forEach((t) => t.classList.toggle('active', t.id === 'tab-sim'));
  state.simBase = null;
  state.fcOff = false;
}

async function refresh() {
  showLoading('最新データで集計し直しています…(1分程度かかる場合があります)');
  try {
    // 設定タブの未保存の変更は、再集計で読み直した設定で上書きしない
    const unsaved = document.getElementById('set-dirty').textContent === '未保存の変更があります' ? state.settings : null;
    onData(await api('refresh'));
    if (unsaved) state.settings = Object.assign(unsaved, { calendar: state.settings.calendar });
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
  const cur = state.pendingWork !== undefined ? state.pendingWork : sel.value;
  state.pendingWork = undefined;
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
  // 計算は実績の最終日まで(期・月度の途中では、まだ来ていない日の固定費を入れない)。fullToは期間本来の終わり
  let to = state.lastYmd && state.lastYmd >= r.from && state.lastYmd < r.to ? state.lastYmd : r.to;
  const md = (d) => `${Number(d.slice(5, 7))}/${Number(d.slice(8))}`;
  let rangeNote = to < r.to ? `(実績〜${md(to)})` : '';
  // 月度の途中: ここまでの実績を出勤日数(会社カレンダー)の比で月末まで引き伸ばした「月末見込み」で計算する
  let data = state.cache, fc = null;
  if (mode === 'period' && to < r.to) {
    const cal = state.settings.calendar || {};
    const done = C.workDaysIn(cal, r.from, to), total = C.workDaysIn(cal, r.from, r.to);
    fc = { done, total, on: !state.fcOff, few: done < FC_MIN_DAYS };
    rangeNote = `(実績〜${md(to)}・出勤日 ${done}/${total}日${fc.on && !fc.few ? '→月末見込み' : ''})`;
    if (fc.on && !fc.few) { data = C.scaleRange(state.cache, r.from, to, total / done); to = r.to; }
  }
  document.getElementById('f-range-text').textContent = r.from.replace(/-/g, '/') + ' 〜 ' + r.to.replace(/-/g, '/') + rangeNote;
  const fcBtn = document.getElementById('f-fc');
  fcBtn.hidden = !fc;
  fcBtn.classList.toggle('active', !!(fc && fc.on));
  const work = refreshWorkList(r.from, r.to, sites);
  return { mode, from: r.from, to, fullTo: r.to, site, sites, work, periodKey: mode === 'period' ? selPer.value : null, data, fc };
}

function renderAll() {
  if (!state.cache) return;
  const active = document.querySelector('.tabs button.active').dataset.tab;
  const sel = selection();
  // 月度の途中で出勤日の実績がまだ少ないときは、ぶれた数字を出さずに案内だけ表示する
  const blk = document.getElementById('fc-block');
  const block = !!(sel.fc && sel.fc.on && sel.fc.few) && ['sim', 'bep', 'dash'].includes(active);
  blk.hidden = !block;
  document.querySelectorAll('.tab').forEach((t) => t.classList.toggle('fcHidden', block && t.id === 'tab-' + active));
  if (block) {
    blk.innerHTML = `<p><b>${esc(C.periodLabel(sel.periodKey))}</b>は、まだ出勤日${sel.fc.done}日分の実績しかないため表示していません` +
      `（出勤日${FC_MIN_DAYS}日分以上で、月末見込みを表示します）。</p>` +
      '<p><button type="button" class="fcPrev">前の月度を表示</button> <button type="button" class="fcRaw">実績のみで表示</button></p>';
    blk.querySelector('.fcPrev').onclick = () => document.getElementById('f-prev').click();
    blk.querySelector('.fcRaw').onclick = () => { state.fcOff = true; state.simBase = null; renderAll(); };
    return;
  }
  if (active === 'works') return renderWorks(sel);
  if (active === 'settings') return renderSettings();
  const an = C.analyze(sel.data, state.settings, sel.from, sel.to, sel.sites, sel.work || undefined);
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
  const ok = hasSales && profit - goal >= -0.5; // 1円未満の誤差は達成扱い(現状分析の判定と同じ)
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
  if (sel.to < tr.to) tr.to = sel.to; // 実績の最終日まで
  const trAll = C.analyze(sel.data, state.settings, tr.from, tr.to, sel.sites, sel.work || undefined);
  const labels = trAll.byPeriod.map((p) => C.periodLabel(p.period).replace(/^\d{2}(\d{2})年/, '$1/').replace('月度', ''));
  const perSite = sel.sites.map((s) => ({ site: s, an: C.analyze(sel.data, state.settings, tr.from, tr.to, [s], sel.work || undefined) }));

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

/* 損益分岐生産量グラフ(drawBep / renderBepSvg)は bepchart.js(シンプル版と共用) */

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
  const fm = (sel.work ? C.analyze(sel.data, state.settings, sel.from, sel.to, sel.sites) : an).models;
  const frac = fm.reduce((a, m) => a + m.frac, 0), fix = fm.reduce((a, m) => a + m.fixed, 0);
  const months = sel.sites.length ? frac / sel.sites.length : 0;
  state.simFixedNote = frac > 0 ? `${yen(fix / frac)}円/月 × ${sel.sites.length}工場 × ${fmt(months, Math.abs(months - Math.round(months)) < 0.05 ? 0 : 1)}か月` + (sel.work ? '(工事へ売上比で配賦)' : '') : '';
  // 期間の途中なら、期間全体(残りの月の固定費を含む)で目標利益率に届くのに必要な、残り期間の生産量
  state.simRemain = null;
  if (sel.to < sel.fullTo) {
    const full = C.analyze(sel.data, state.settings, sel.from, sel.fullTo, sel.sites, sel.work || undefined).total;
    // これまで・残りの期間は出勤日数で数える(残りの月の連休なども反映される)
    const cal = state.settings.calendar || {};
    const next = C.utcToYmd(Date.parse(sel.to + 'T00:00:00Z') + 86400000);
    const doneDays = C.workDaysIn(cal, sel.from, sel.to), leftDays = C.workDaysIn(cal, next, sel.fullTo);
    state.simRemain = Object.assign(C.remainingNeed(t, full, state.settings), { doneDays, leftDays, end: sel.fullTo });
  }
  // 「時間を減らす」の判定用: 期間の出勤日数と、直近12か月度(締まった月)の1出勤日あたり工数(工場単位。工事を選んだときは使わない)
  state.simDaily = null;
  if (!sel.work && state.lastYmd) {
    const cal = state.settings.calendar || {};
    const lastKey = C.periodKeyOf(state.lastYmd);
    const endKey = state.lastYmd === C.periodRange(lastKey).to ? lastKey : C.shiftPeriod(lastKey, -1);
    const days = C.workDaysIn(cal, sel.from, sel.to);
    if (days > 0) state.simDaily = Object.assign({ days }, C.dailyHoursStats(state.cache, cal, sel.sites, endKey));
  }
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

function parseNum(v) { return parseNumIn(v) || 0; } // 「,」・全角数字も読む(読めないときは0)

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
  // 左上の表の見出しも、グラフの札と同じく実績のままは「現在」、値を変えたら「試算」
  document.querySelector('#tab-sim .simTitle').textContent = changed ? '試算' : '現在';
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
  renderSimAdvice(r, t, W, P);
  // つまみのドラッグで試算の生産重量を動かせる(スライダー・数値欄と連動)
  // 人件費は試算の生産重量での額を固定費に含め、固定費線を水平にする(つまみのドラッグ中に縮尺が変わらないよう、署名は基準値で作る)
  drawBep('c-sim', { fixed: r.fixed + r.labor, unitPrice: P, laborPerTon: 0, varPerTon: r.varPerTon, profitRate: state.settings.rates.profit / 100,
    fixedLabel: ['固定費', '(人件費込み)'], otherFixed: r.fixed, laborRate: r.laborRate, sig: [r.fixed, P, n, r.laborRate, r.varPerTon, state.settings.rates.profit].join('|'),
    x: W, forceX: !simDragging, beTons: r.breakEvenTons, goalTons: r.goalTons, handleLabel: changed ? '試算' : '現在', dragHint: true, // 実績のままは「現在」、動かしたら「試算」
    onMove: (t) => {
      simDragging = true;
      document.getElementById('s-w').value = simFmt('w', t);
      updateSim();
      simDragging = false;
    } });
}

/* 現状分析: 目標利益率に届くには(ほかの条件は同じとして1つずつ)。トン単価は受注時に決まっているため変えない。
   ②施策カード3枚(生産量・時間・変動費) ③見積もりの目安単価 ④期間全体で達成するには(期間の途中のときだけ) */
function renderSimAdvice(r, t, W, P) {
  const box = document.getElementById('sim-advice');
  const g = state.settings.rates.profit;
  const gl = fmt(g, g % 1 ? 1 : 0) + '%';
  if (!(r.sales > 0)) { box.innerHTML = ''; return; }
  const a = C.advise(r, state.settings);
  const ok = a.gap <= 0.5;
  const md = (d) => `${Number(d.slice(5, 7))}/${Number(d.slice(8))}`;
  // 見出しは色帯。すぐ下に結論の1行(不足額と、一番小さい変化で届く施策)を大きく出す
  let html = `<div class="advHead">現状分析：目標利益率${gl}を達成するには${ok ? '' : '<small>ほかの条件は同じとして、どれか1つで達成する場合</small>'}</div>`;

  // 「時間を減らす」を1出勤日あたりに直し、直近1年で最も少なかった月の1日あたり工数(今の体制で実際に出せた最少水準)と比べる
  const dailyNote = (c) => {
    const dd = state.simDaily;
    if (!dd || c.ng || ok || !(c.need > 0)) return '';
    const now = r.hours / dd.days, after = (r.hours - c.need) / dd.days;
    let h = `<div class="advDaily">1日 ${fmt(now, 0)}→<b>${fmt(after, 0)}</b>h（−${fmt(now - after, 0)}h・約${fmt((now - after) / 8, 0)}人分）</div>`;
    if (dd.min !== null) {
      if (after < dd.min) h += `<div class="advWarn" title="過去1年で最も少なかった月(${esc(C.periodLabel(dd.minKey))})の1日あたり工数 ${fmt(dd.min, 0)}h を下回るため、人員配置の見直しが必要">⚠ 過去1年の最少を下回る＝削減困難</div>`;
    }
    return h;
  };

  // ② 施策カード: 必要な変化量・変更前→後・変化率のバー(3枚の中で一番大きい変化率を100%とする)・1単位あたりの利益増
  const plans = [
    { cls: 'advW', title: '生産量を増やす', cond: '今の時間のまま', need: a.addTons, unit: 't', d: 1, from: W, sign: 1, unitNote: `1t増で 利益 +${yen(a.perTon)}円` },
    { cls: 'advH', title: '時間を減らす', cond: '今の生産量のまま', need: a.cutHours, unit: 'h', d: 0, from: r.hours, sign: -1, unitNote: `1h減で 利益 +${yen(a.perHour)}円`, daily: true },
    { cls: 'advV', title: '変動費を下げる', cond: '1tあたり', need: a.cutVarPerTon, unit: '円/t', d: 0, from: r.varPerTon, sign: -1, unitNote: `1,000円/t減で 利益 +${yen(a.perVar1000)}円` },
  ];
  plans.forEach((c) => {
    c.rate = c.need !== null && c.from > 0 ? Math.abs(c.need) / c.from : null;
    c.ng = c.need === null || (c.sign < 0 && c.need > c.from); // 到達不能、または減らしきっても届かない
    // 時間を減らす: 削減後の1日あたり工数が過去1年の最少の月を下回る(=時間削減だけでは困難)
    const dd = state.simDaily;
    c.hard = !!(c.daily && dd && dd.min !== null && !c.ng && !ok && c.need > 0 && (r.hours - c.need) / dd.days < dd.min);
  });
  // 一番の近道: 実現できる施策のうち変化率が最も小さいもの(金枠と「最短」の印を付ける)
  const cand = ok ? [] : plans.filter((c) => !c.ng && !c.hard && c.rate !== null);
  const best = cand.length ? cand.reduce((x, y) => (y.rate < x.rate ? y : x)) : null;
  html += ok
    ? `<div class="advLead">✓ 目標を達成しています <span class="advLeadSub">目標より <b>${yen(-a.gap)}</b>円 超</span></div>`
    : `<div class="advLead" title="不足額 ${yen(a.gap)}円">あと <b class="advLeadGap">${man(a.gap)}</b> 不足` +
      (best ? ` <span class="advArrow">➜</span> 最短は <b class="advLeadKey">「${best.title} ${best.sign > 0 ? '＋' : '−'}${pct(best.rate)}」</b>` : ' <span class="advArrow">➜</span> 1つだけでは届きません（組み合わせが必要）') + '</div>';
  const maxRate = Math.max(...plans.map((c) => (!c.ng && c.rate) || 0)) || 1;
  html += '<div class="advCards">' + plans.map((c) => {
    let body;
    if (c.ng) body = `<div class="advBig neg">${c.need === null ? '到達不能' : 'これだけでは不可'}</div>`;
    else {
      const more = c.need > 0; // false = 既に達成(超えている量)
      const sg = (c.sign > 0) === more ? '＋' : '−';
      body = `<div class="advBig ${ok ? 'pos' : 'neg'}">${ok ? '超 ' : sg}${fmt(Math.abs(c.need), c.d)}<span class="advUnit">${c.unit}</span></div>` +
        `<div class="advFromTo">${fmt(c.from, c.d)} → ${fmt(c.from + c.sign * c.need, c.d)}${c.unit}</div>` +
        `<div class="advBar"><i style="width:${Math.max(2, c.rate / maxRate * 100)}%"></i><span>${ok ? '' : sg}${pct(c.rate)}</span></div>`;
    }
    const mark = c === best ? ' advBest' : c.hard ? ' advHard' : '';
    return `<div class="advCard ${c.cls}${mark}">${c === best ? '<span class="advRibbon">最短</span>' : ''}<div class="advTitle">${c.title}<small>（${c.cond}）</small></div>${body}${c.daily ? dailyNote(c) : ''}<div class="advNote">${c.unitNote}</div></div>`;
  }).join('') + '</div>';

  // ③ 今後の見積もりの目安単価: 損益0・今・目標の3つの単価を1本の目盛りに並べる
  let row2 = '';
  if (a.goalPrice !== null && a.bePrice !== null && P > 0) {
    const vals = [a.bePrice, P, a.goalPrice];
    const lo = Math.min(...vals), hi = Math.max(...vals), pad = (hi - lo) * 0.12 || hi * 0.05;
    const pos = (v) => ((v - lo + pad) / (hi - lo + pad * 2) * 100).toFixed(1);
    const mk = (v, cls, label) => `<div class="advMk ${cls}" style="left:${pos(v)}%"><span>${label}<b>${yen(v)}</b></span></div>`;
    row2 += `<div class="advCard advPrice"><div class="advTitle">今後の見積もりの目安単価<small>（円/t）</small></div>
      <div class="advScale"><div class="advLine"></div>${mk(a.bePrice, 'mkBe', '損益0')}${mk(a.goalPrice, 'mkGoal', '目標' + gl)}${mk(P, 'mkNow', '今')}</div>
      <div class="advNote">利益率${gl}には、今より <b class="${a.goalPrice > P ? 'neg' : 'pos'}">${a.goalPrice > P ? '+' : ''}${yen(a.goalPrice - P)}</b>円/t</div></div>`;
  }
  // ④ 期間全体で達成するには: 残り期間に月あたり何t必要か(これまでの月平均との比較)
  const m = state.simRemain;
  if (m) {
    // 1出勤日あたりの必要生産量と、これまでの1出勤日あたり生産量を比べる
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
        <div class="advNote" title="残りの固定費 ${yen(m.extraFixed)}円を含む">残り${m.leftDays}出勤日で 計${ton(m.tons)}t（固定費${man(m.extraFixed)}込み）</div>`;
    }
    row2 += `<div class="advCard advRemain ${lv}"><div class="advTitle">期間全体で達成するには<small>（〜${md(m.end)}）</small></div>${body}</div>`;
  }
  if (row2) html += `<div class="advRow2">${row2}</div>`;
  box.innerHTML = html;
}

/* ===================== 工事別分析 ===================== */

function worksRows(sel) {
  const an = C.analyze(sel.data, state.settings, sel.from, sel.to, sel.sites);
  const rows = C.workBreakdown(an, state.cache);
  // 工事の絞り込み: 選択中の期間・工場にある工事をリストにする(既定は全工事。選択中の工事が無くなったら全工事に戻す)
  const selW = document.getElementById('w-search');
  const cur = selW.value;
  const name = (r) => r.workNo === C.COMMON_WORK ? '共通(工事なし)' : `${r.workNo}　${r.name}`;
  const list = rows.slice().sort((a, b) => (a.workNo === C.COMMON_WORK) - (b.workNo === C.COMMON_WORK) || a.workNo.localeCompare(b.workNo, 'ja', { numeric: true }));
  selW.innerHTML = '<option value="">全工事</option>' + list.map((r) => `<option value="${esc(r.workNo)}">${esc(name(r))}</option>`).join('');
  selW.value = list.some((r) => r.workNo === cur) ? cur : '';
  return selW.value ? rows.filter((r) => r.workNo === selW.value) : rows;
}

function renderWorks(sel) {
  const alloc = document.getElementById('w-alloc').checked;
  const rows = worksRows(sel || selection());
  const npCol = (r) => alloc ? r.allocNinkuPerTon : r.ninkuPerTon;
  const top = rows.filter((r) => r.workNo !== C.COMMON_WORK && r.weight > 0).sort((a, b) => b.weight - a.weight).slice(0, 15);
  drawChart('c-works', {
    type: 'bar',
    data: { labels: top.map((r) => r.workNo), datasets: [{ label: alloc ? '人工/t(共通按分後)' : '人工/t(直接)', data: top.map(npCol), backgroundColor: css('--s1'), borderRadius: 4 }] },
    // 横棒グラフなので、マウスの縦位置(y)にある工事のポップアップを出す(既定のindexモードは横位置xで探すため、別の工事が出ていた)
    options: Object.assign(baseOpts('人工/t', 2), { indexAxis: 'y', interaction: { mode: 'index', axis: 'y', intersect: false }, plugins: { legend: { display: false }, tooltip: { callbacks: {
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
    lines.push([csvText(r.workNo), csvText(r.name), r.weight.toFixed(3), h.toFixed(2), (h / C.HOURS_PER_NINKU).toFixed(2), r.weight > 0 ? (h / C.HOURS_PER_NINKU / r.weight).toFixed(3) : '',
      r.unitPrice !== null ? Math.round(r.unitPrice) : '', Math.round(r.sales), Math.round(r.labor), Math.round(r.variable), Math.round(r.marginal), Math.round(r.fixed), Math.round(r.profit)]);
  });
  const csv = '﻿' + lines.map((l) => l.map((v) => /[",\n]/.test(String(v)) ? '"' + String(v).replace(/"/g, '""') + '"' : v).join(',')).join('\r\n');
  const a = document.createElement('a');
  a.href = URL.createObjectURL(new Blob([csv], { type: 'text/csv' }));
  a.download = `工事別分析_${sel.from}_${sel.to}${sel.site ? '_' + sel.site : ''}.csv`;
  a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 0); // すぐに解放するとダウンロードが中断するブラウザがある
}
// 表計算ソフトで式として解釈されないよう、= + - @ で始まる文字列の先頭に ' を付ける
function csvText(v) { const t = String(v === null || v === undefined ? '' : v); return /^[=+\-@]/.test(t) ? "'" + t : t; }

/* ===================== 設定 ===================== */

const RATE_LABELS = [['labor', '人件費率'], ['variable', '変動費率(材料等)'], ['fixed', '固定費率'], ['profit', '利益率(目標)']];

async function ensureEdit() {
  if (state.editPw || !REQUIRE_PASSWORD) return true;
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
    let v = el.value;
    if (el.classList.contains('numIn')) { // 数値欄は3桁区切り(,)を外して数値にする。数値として読めない途中の入力は反映しない
      v = parseNumIn(el.value);
      if (v === undefined) return;
    }
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
  // 数値欄は入力を終えたら3桁区切り(,)で表示し直す
  document.getElementById('set-body').addEventListener('focusout', (e) => {
    const el = e.target;
    if (!el.classList || !el.classList.contains('numIn')) return;
    const v = parseNumIn(el.value);
    if (v !== undefined) el.value = fmtNumIn(v);
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

// 設定の数値欄: 3桁区切り(,)付きで表示する(type=numberは「,」を表示できないためtext+数字キーボード)
function numInput(attrs, v) {
  const a = Object.keys(attrs).map((k) => `data-${k}="${esc(attrs[k])}"`).join(' ');
  return `<input type="text" inputmode="decimal" class="numIn" autocomplete="off" ${a} value="${esc(fmtNumIn(v))}">`;
}
function fmtNumIn(v) {
  return v === null || v === undefined || v === '' || !isFinite(v) ? '' : Number(v).toLocaleString('ja-JP', { maximumFractionDigits: 6 });
}
// 「1,234.5」「１２３４」などを数値に。空欄はnull、読めないときはundefined
function parseNumIn(text) {
  const t = String(text).replace(/[０-９．－]/g, (c) => String.fromCharCode(c.charCodeAt(0) - 0xFEE0)).replace(/[,，\s]/g, '');
  if (t === '') return null;
  const n = Number(t);
  return isFinite(n) ? n : undefined;
}

function updateRateSum() {
  const r = state.settings.rates;
  const sum = (r.labor || 0) + (r.variable || 0) + (r.fixed || 0) + (r.profit || 0);
  const el = document.getElementById('set-rate-sum');
  el.textContent = `合計 ${fmt(sum, 1)}%` + (Math.abs(sum - 100) > 0.01 ? '(100%になるように調整してください)' : '');
  el.className = 'small ' + (Math.abs(sum - 100) > 0.01 ? 'neg' : 'pos');
}

function renderSettings() {
  const unlocked = !!state.editPw || !REQUIRE_PASSWORD; // パスワード解除中は最初から編集できる
  document.getElementById('set-lock').hidden = unlocked;
  document.getElementById('set-body').hidden = !unlocked;
  if (!unlocked) return;
  const s = state.settings;
  document.getElementById('set-rates').innerHTML = RATE_LABELS.map(([f, l]) =>
    `<label>${l}(%)${numInput({ k: 'rate', f }, s.rates[f])}</label>`).join('');
  updateRateSum();
  document.getElementById('set-common').value = s.commonWorkNos || '';
  document.getElementById('set-common').dataset.k = 'common';

  document.getElementById('set-costs').innerHTML = '<tr><th>工場</th><th class="n">人件費単価(円/人工)</th><th class="n">月固定費(円)</th><th class="n">変動費単価(円/t)</th></tr>' +
    state.cache.sites.map((site) => {
      const c = s.costs[site] || {};
      return `<tr><td>${esc(site)}</td><td class="n">${numInput({ k: 'cost', site, f: 'laborRate' }, c.laborRate)}</td><td class="n">${numInput({ k: 'cost', site, f: 'fixedMonthly' }, c.fixedMonthly)}</td><td class="n">${numInput({ k: 'cost', site, f: 'variablePerTon' }, c.variablePerTon)}</td></tr>`;
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
      return `<tr><td>${esc(wn)}</td><td>${esc(info.name)}</td><td class="n">${ton(info.totalWeight)}</td><td class="n">${numInput({ k: 'work', wn, f: 'totalWeight' }, w.totalWeight)}</td><td class="n">${numInput({ k: 'work', wn, f: 'contract' }, w.contract)}</td><td class="n" id="wp-${esc(wn)}">${yen(C.unitPriceOf(wn, state.cache, s).price)}</td></tr>`;
    }).join('');
}

/* ===================== デモ(?demo=1) ===================== */

function demoApi(action, extra) {
  if (!state.demoCache) {
    state.demoCache = PPDemo.makeDemoCache(C);
    state.demoSettings = Object.assign(C.defaultSettings(), {
      works: { '26-01': { contract: 60000000, totalWeight: 200 }, '26-02': { contract: 45000000, totalWeight: null } } });
  }
  if (action === 'saveSettings') { state.demoSettings = JSON.parse(JSON.stringify(extra.settings)); }
  return Promise.resolve({ cache: state.demoCache, settings: state.demoSettings || null, ok: true });
}
