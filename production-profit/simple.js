/* 生産損益分析 シンプル版 - 画面ロジック(計算はcalc.jsのPPCalc。詳細版(app.js)と同じ計算で数字を出す) */
'use strict';

// GASのウェブアプリURL(app.js と同じ値にすること)
const GAS_API_URL = 'https://script.google.com/macros/s/AKfycbzmypFiUSkOwBsDW49EP11sagGjpwsh0DXBSrKbvJONn0MymshWeJl-WBjIx-LGrJG5/exec';
const DEMO = new URLSearchParams(location.search).get('demo') === '1';
const C = PPCalc;
const FC_MIN_DAYS = 3; // app.js と同じ(月末見込みを出す最低の出勤日数)
const state = { cache: null, settings: null, pw: '', fcOff: false, pass: {} };
const $ = (id) => document.getElementById(id);

async function api(action) {
  if (DEMO) {
    return { cache: PPDemo.makeDemoCache(C), settings: Object.assign(C.defaultSettings(), {
      works: { '26-01': { contract: 60000000, totalWeight: 200 }, '26-02': { contract: 45000000, totalWeight: null } },
      headcount: { '本社': 20, '夢前': 18, '鳥取': 22 } }) };
  }
  const res = await fetch(GAS_API_URL, {
    method: 'POST', headers: { 'Content-Type': 'text/plain;charset=utf-8' },
    body: JSON.stringify({ action: action, pw: state.pw, app: 'simple' }), // app: GASはシンプル版の読み込みに閲覧用パスワードを求めない
  });
  const body = await res.json();
  if (body.status !== 'success') throw new Error(body.message || 'エラー');
  return body.data;
}

function fmt(v, d) {
  if (v === null || v === undefined || !isFinite(v)) return '—';
  if (Math.abs(v) < 0.5 * Math.pow(10, -(d || 0))) v = 0;
  return v.toLocaleString('ja-JP', { minimumFractionDigits: d || 0, maximumFractionDigits: d || 0 });
}
const yen = (v) => fmt(v, 0), ton = (v) => fmt(v, 1), npt = (v) => fmt(v, 2); // bepchart.js も使う
function esc(s) { return String(s === null || s === undefined ? '' : s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c])); }
document.addEventListener('DOMContentLoaded', () => {
  $('lock-btn').onclick = () => unlock($('lock-input').value);
  $('lock-input').onkeydown = (e) => { if (e.key === 'Enter') unlock(e.target.value); };
  $('to-home').onclick = () => { location.href = 'index.html' + (DEMO ? '?demo=1' : ''); };
  $('to-detail').onclick = () => { location.href = 'detail.html' + viewQuery(); };
  unlock(DEMO ? 'demo' : ''); // シンプル版は閲覧用パスワード無しで開ける(GASが app:'simple' の読み込みは確認しない)
});

async function unlock(pw) {
  state.pw = pw;
  $('lock-msg').textContent = '';
  // 読み込み中は詳細版と同じく、ロゴのカードの上に読み込み表示を重ねる(パスワード欄は読み込みに失敗したときだけ出す)
  $('lock-input').hidden = $('lock-btn').hidden = !state.pw && !$('lock-msg').dataset.failed;
  $('screen-lock').hidden = false;
  $('loading').hidden = false;
  try {
    const data = await api('getData');
    state.cache = data.cache;
    state.cache.sites = C.DEFAULT_SITES.slice();
    state.cache.rec = (state.cache.rec || []).filter((r) => C.DEFAULT_SITES.indexOf(r[1]) >= 0);
    state.settings = Object.assign(C.defaultSettings(), data.settings || {});
    state.lastYmd = C.lastDataYmd(state.cache);
    $('updated').textContent = '集計: ' + new Date(state.cache.generatedAt).toLocaleString('ja-JP');
    $('screen-lock').hidden = true;
    $('screen-main').hidden = false;
    initUi();
    render();
  } catch (e) {
    $('lock-input').hidden = $('lock-btn').hidden = false;
    $('lock-msg').dataset.failed = '1';
    $('lock-msg').textContent = e.message;
  } finally {
    $('loading').hidden = true;
  }
}

function initUi() {
  // 期間の選択肢は詳細版と同じ(月度: 今日の月度から13か月分、期: データのある期)
  const today = C.utcToYmd(Date.now() + 9 * 3600 * 1000);
  const recs = state.cache.rec;
  const first = recs.length ? C.periodKeyOf(recs[0][0]) : C.periodKeyOf(today);
  const cur = C.periodKeyOf(today);
  const monthFirst = C.shiftPeriod(cur, -12) > first ? C.shiftPeriod(cur, -12) : first;
  const periods = [];
  for (let k = cur; k >= monthFirst; k = C.shiftPeriod(k, -1)) periods.push(k);
  $('f-period').innerHTML = periods.map((k) => `<option value="${k}">${C.periodLabel(k)}</option>`).join('');
  state.defPeriod = periods[1] || periods[0]; // 先月度(直近の確定月度)。年度→月〆に切り替えたときもこの月度
  $('f-period').value = state.defPeriod;
  const fys = [];
  for (let y = C.fiscalYearOf(cur); y >= C.fiscalYearOf(first); y--) fys.push(y);
  $('f-fiscal').innerHTML = fys.map((y) => `<option value="${y}">${C.fiscalLabel(y)}</option>`).join('');
  const fy = String(C.fiscalYearOf(cur));
  $('f-fiscal').value = fy;
  if ($('f-fiscal').value !== fy) $('f-fiscal').selectedIndex = 0;
  state.mode = 'fiscal';
  state.site = '';
  $('f-sites').innerHTML = [['', state.cache.sites.length + '工場']].concat(state.cache.sites.map((s) => [s, s]))
    .map(([v, l]) => `<button type="button" data-site="${esc(v)}">${esc(l)}</button>`).join('');

  // 詳細版から来たときは、その表示条件で開く(工事・タブは詳細版へ戻るときにそのまま返す)
  const q = new URLSearchParams(location.search);
  const setSel = (id, v) => { const el = $(id), old = el.value; el.value = v; if (el.value !== v) el.value = old; };
  if (q.get('m') === 'period' || q.get('m') === 'fiscal') state.mode = q.get('m');
  if (q.has('fy')) setSel('f-fiscal', q.get('fy'));
  if (q.has('p')) setSel('f-period', q.get('p'));
  if (state.cache.sites.includes(q.get('s'))) state.site = q.get('s');
  if (q.get('fc') === '0') state.fcOff = true;
  ['w', 't'].forEach((k) => { if (q.has(k)) state.pass[k] = q.get(k); });

  $('f-modes').onclick = (e) => {
    const b = e.target.closest('button');
    if (!b) return;
    if (b.dataset.mode === 'period' && state.mode !== 'period') $('f-period').value = state.defPeriod; // 年度→月〆は常に先月度から
    state.mode = b.dataset.mode;
    render();
  };
  $('f-sites').onclick = (e) => { const b = e.target.closest('button'); if (b) { state.site = b.dataset.site; render(); } };
  $('f-period').onchange = render;
  $('f-fiscal').onchange = render;
  const step = (d) => { const s = $('f-period'), i = s.selectedIndex + d; if (i >= 0 && i < s.options.length) { s.selectedIndex = i; render(); } };
  $('f-prev').onclick = () => step(1);
  $('f-next').onclick = () => step(-1);
  $('f-fc').onclick = () => { state.fcOff = !state.fcOff; render(); };
}

function viewQuery() {
  const q = new URLSearchParams();
  if (DEMO) q.set('demo', '1');
  q.set('m', state.mode);
  q.set('fy', $('f-fiscal').value);
  q.set('p', $('f-period').value);
  if (state.site) q.set('s', state.site);
  if (state.pass.w) q.set('w', state.pass.w); // 工事が選んだ工場・期間に無ければ詳細版側で「全工事」に戻る
  if (state.pass.t) q.set('t', state.pass.t);
  if (state.fcOff) q.set('fc', '0');
  return '?' + q.toString();
}

/* 選択範囲(詳細版 app.js の selection() と同じ計算。工事は常に全工事) */
function selection() {
  const mode = state.mode, selPer = $('f-period');
  const r = mode === 'period' ? C.periodRange(selPer.value) : C.fiscalRange(Number($('f-fiscal').value));
  const sites = state.site ? [state.site] : state.cache.sites;
  let to = state.lastYmd && state.lastYmd >= r.from && state.lastYmd < r.to ? state.lastYmd : r.to;
  const md = (d) => `${Number(d.slice(5, 7))}/${Number(d.slice(8))}`;
  let note = to < r.to ? `(実績〜${md(to)})` : '';
  let data = state.cache, fc = null;
  if (mode === 'period' && to < r.to) {
    const cal = state.settings.calendar || {};
    const done = C.workDaysIn(cal, r.from, to), total = C.workDaysIn(cal, r.from, r.to);
    fc = { done, total, on: !state.fcOff, few: done < FC_MIN_DAYS };
    note = `(実績〜${md(to)}・出勤日 ${done}/${total}日${fc.on && !fc.few ? '→月末見込み' : ''})`;
    if (fc.on && !fc.few) { data = C.scaleRange(state.cache, r.from, to, total / done); to = r.to; }
  }
  const lastTo = state.lastYmd && state.lastYmd >= r.from && state.lastYmd < r.to ? state.lastYmd : r.to; // 実績の最終日(見込みにしない)
  // 目標の欄の見出し用(令和。期は終わりの年で数える 例: 2025/11/21〜2026/11/20期=R8年度、2026年8月度=R8年8月度)
  const pk = mode === 'period' ? selPer.value.split('-') : null;
  const reiwa = pk ? 'R' + (Number(pk[0]) - 2018) + '年' + Number(pk[1]) + '月度' : 'R' + (Number($('f-fiscal').value) + 1 - 2018) + '年度';
  return { mode, from: r.from, to, fullTo: r.to, lastTo, reiwa, sites, data, fc, note, periodKey: mode === 'period' ? selPer.value : null };
}

function card(label, value, unit, sub, cls) {
  return `<div class="sCard ${cls || ''}"><div class="sLabel">${label}</div><div class="sValue">${value}<span class="sUnit">${unit}</span></div><div class="sSub">${sub || ''}</div></div>`;
}

function render() {
  document.querySelectorAll('#f-modes button').forEach((b) => b.classList.toggle('active', b.dataset.mode === state.mode));
  document.querySelectorAll('#f-sites button').forEach((b) => b.classList.toggle('active', b.dataset.site === state.site));
  $('f-period-wrap').hidden = state.mode !== 'period';
  $('f-fiscal-wrap').hidden = state.mode !== 'fiscal';
  const selPer = $('f-period');
  $('f-prev').disabled = selPer.selectedIndex >= selPer.options.length - 1;
  $('f-next').disabled = selPer.selectedIndex <= 0;
  const sel = selection();
  $('f-range').textContent = sel.from.replace(/-/g, '/') + ' 〜 ' + sel.fullTo.replace(/-/g, '/') + sel.note;
  $('f-fc').hidden = !sel.fc;
  $('f-fc').classList.toggle('active', !!(sel.fc && sel.fc.on));
  if (sel.fc && sel.fc.on && sel.fc.few) {
    renderGoal(sel); // 目標(在職中人数×8h・先月度までの過不足から出す)は、月末見込みを使わないので実績が少なくても出す
    $('res-note').textContent = '';
    $('cards').innerHTML = `<div class="sMsg">${esc(C.periodLabel(sel.periodKey))}は、まだ出勤日${sel.fc.done}日分の実績しかないため表示していません` +
      `(出勤日${FC_MIN_DAYS}日分以上で月末見込みを表示します)。<br>「月末見込み」を押すと実績のみで表示します。目標は右（下）の欄をご覧ください。</div>`;
    return;
  }
  $('s-note').textContent = state.pass.w ? `詳細版で選んでいた工事(${state.pass.w})の絞り込みは、シンプル版では使わず全工事で表示しています(詳細版へ戻ると元に戻ります)。` : '';
  const t = C.analyze(sel.data, state.settings, sel.from, sel.to, sel.sites).total;
  const hasSales = t.sales > 0;
  const gi = renderGoal(sel);
  $('res-note').textContent = sel.fc && sel.fc.on && !sel.fc.few ? '（月末見込み）' : sel.lastTo < sel.fullTo ? `（〜${Number(sel.lastTo.slice(5, 7))}/${Number(sel.lastTo.slice(8))}の実績）` : '（実績）';
  // 生産重量・工数は値を、売上額・損益は目標に対する割合を表示する(1行に4枚)
  const g = state.settings.rates.profit, gl = fmt(g, g % 1 ? 1 : 0) + '%';
  let sVal = '—', sCls = '';
  if (gi && gi.goalSales > 0) {
    const ratio = t.sales / gi.goalSales, rest = 1 - ratio;
    sVal = fmt(ratio * 100, 0);
    sCls = gi.progress ? '' : (rest > 0.005 ? 'bad' : 'good');
  }
  const pr = hasSales && t.profitRate !== null ? t.profitRate * 100 : null;
  $('cards').innerHTML = [
    card('生産重量', fmt(t.weight, 1), 't', ''),
    card('1t当たり人工数', fmt(t.ninkuPerTon, 2), '人工/t', `総工数 ${fmt(t.hours, 0)}h`),
    card('売上額（概算）', sVal, sVal === '—' ? '' : '%', '', sCls),
    card('損益（概算）', pr === null ? '—' : pr.toFixed(1), pr === null ? '' : '%', `（目標${gl}）`, pr === null ? '' : (pr >= g - 1e-9 ? 'good' : pr < 0 ? 'bad' : 'warn')),
  ].join('');
}

/* 月〆の今月度: 今期の先月度までの過不足(損益−売上×利益率)を、今月度〜期末の出勤日数で按分した今月度の負担分。
   毎月この負担分を上乗せした目標を達成すれば、期末に年間目標にも届く。carry>0 = 不足分を取り返す額、<0 = 余裕。
   期首の月度・年度表示は null */
function carryFor(sel, p) {
  if (sel.mode !== 'period') return null;
  const cal = state.settings.calendar || {};
  const fy = C.fiscalRange(C.fiscalYearOf(sel.periodKey));
  const prevTo = C.utcToYmd(Date.parse(sel.from + 'T00:00:00Z') - 86400000);
  if (prevTo < fy.from) return null;
  const pv = C.analyze(state.cache, state.settings, fy.from, prevTo, sel.sites).total;
  const diff = pv.profit - pv.sales * p;
  const monthDays = C.workDaysIn(cal, sel.from, sel.fullTo), restDays = C.workDaysIn(cal, sel.from, fy.to);
  return { diff, prevRate: pv.sales > 0 ? pv.profit / pv.sales : null, monthDays, restDays, fyTo: fy.to, carry: restDays > 0 ? -diff * monthDays / restDays : 0 };
}

/* 月〆の今月度(期間の途中)の「参考: 先月度までの過不足を含めた目標」の生産量。
   前提は目標シミュレーターと同じ(人件費=工数×人件費単価を固定費扱い、トン単価・変動費単価・人件費単価は実績)。
   期間全体の固定費に先月度までの過不足の負担分(carry)を上乗せし、今のペースの生産量・工数で目標に届く生産量を求める */
function carryGoalTons(sel, p, c) {
  const t = C.analyze(state.cache, state.settings, sel.from, sel.lastTo, sel.sites).total;
  if (!(t.weight > 0)) return null;
  const full = C.analyze(state.cache, state.settings, sel.from, sel.fullTo, sel.sites).total;
  const cal = state.settings.calendar || {};
  const next = C.utcToYmd(Date.parse(sel.lastTo + 'T00:00:00Z') + 86400000);
  const doneDays = C.workDaysIn(cal, sel.from, sel.lastTo), leftDays = C.workDaysIn(cal, next, sel.fullTo);
  // トン単価・変動費単価・人件費単価: 出勤日の実績が少ない/この期間のトン単価が出ないときは今期(期首〜ここまで)の実績
  let rate = t;
  if (doneDays < FC_MIN_DAYS || !(t.unitPrice > 0)) {
    const fyR = C.fiscalRange(C.fiscalYearOf(sel.periodKey));
    const tf = C.analyze(state.cache, state.settings, fyR.from, sel.lastTo, sel.sites).total;
    if (tf.weight > 0 && tf.unitPrice > 0) rate = tf;
    else if (!(t.unitPrice > 0)) return null;
  }
  const hc = state.settings.headcount;
  const people = hc ? sel.sites.reduce((a, x) => a + (hc[x] || 0), 0) : 0;
  const perDayH = people > 0 ? people * 8 : (doneDays > 0 ? t.hours / doneDays : 0);
  const H = t.hours + perDayH * leftDays, Wpace = t.weight + (doneDays > 0 ? t.weight / doneDays : 0) * leftDays;
  const base = Object.assign({}, t, { unitPrice: rate.unitPrice, varPerTon: rate.varPerTon, laborRate: rate.laborRate, fixed: full.fixed + c.carry });
  return C.simulate(base, state.settings, Wpace, Wpace > 0 ? H / 8 / Wpace : 0, rate.unitPrice).goalTons;
}

/* ===================== 工場別の目標値(グラフ内の表) =====================
   選択した期間(年度・月度)の工場別の目標(生産重量・工数・1t当たり人工数)。常に 3工場・本社・夢前・鳥取 の4行。
   - 利益目標を達成する: 3工場合計で 損益 ≧ 売上×目標利益率(月〆の今月度は先月度までの過不足の負担分も含む)。
     工場ごとのトン単価・変動費単価・人件費単価・固定費で計算する(目標シミュレーターと同じ前提。工数で決まる人件費を固定費扱い)
   - 過去に実績がある値以下: 直近12か月度(締まった月度)の工場ごとの
       生産重量の上限 = 1出勤日あたり生産量の過去最高 × 出勤日数、1t当たり人工数の下限 = 過去最高(最少)の月の値
   - 3工場とも「上限の同じ割合 θ」で生産量を決め、目標に届く最小の θ を二分法で求める(上限まで上げても届かなければ上限を表示)
   - 工数: 過去の期間=実績、期間の途中=実績＋在職中人数×8h×残りの出勤日、月末見込み=見込みの工数 */
function pastBest(cal) {
  const last = state.lastYmd;
  if (!last) return {};
  const lastKey = C.periodKeyOf(last);
  const endKey = last === C.periodRange(lastKey).to ? lastKey : C.shiftPeriod(lastKey, -1);
  const startKey = C.shiftPeriod(endKey, -11);
  const agg = {};
  state.cache.rec.forEach((r) => {
    const k = C.periodKeyOf(r[0]);
    if (k < startKey || k > endKey) return;
    const a = (agg[r[1]] = agg[r[1]] || {}), m = (a[k] = a[k] || { w: 0, h: 0 });
    m.w += r[3]; m.h += r[4];
  });
  const out = {};
  state.cache.sites.forEach((site) => {
    let daily = null, npt = null;
    Object.keys(agg[site] || {}).forEach((k) => {
      const m = agg[site][k], rg = C.periodRange(k), d = C.workDaysIn(cal, rg.from, rg.to);
      if (!(m.w > 0) || !(d > 0)) return;
      if (daily === null || m.w / d > daily) daily = m.w / d;
      const n = m.h / 8 / m.w;
      if (m.h > 0 && (npt === null || n < npt)) npt = n;
    });
    out[site] = { daily, npt };
  });
  return out;
}

/* 1か月あたりの標準の目標(工場別)。月〆はどの月も同じ値(同じ年度の中)、年度は12か月分。
   - 単価・費用: 直近12か月度(締まった月度)の工場ごとの実績(トン単価・変動費単価・人件費単価・月あたり固定費)
   - 工数: 在職中人数 × 8h × 標準出勤日数(その年度の出勤日数 ÷ 12)。名簿が無い工場は直近12か月度の月平均
   - 生産重量: 3工場合計で 損益 = 売上 × 目標利益率 になる量を、各工場の上限(過去最高の実績)の同じ割合 θ で割り振る
     (上限 = 1出勤日あたり生産量の過去最高 × 標準出勤日数、ただし 1t当たり人工数が過去最高(最少)を下回らない量)。
     損益は θ について一次式なので θ は式で求まる。θ > 1 なら上限を超える(⚠) */
function stdPlan(sel) {
  const cal = state.settings.calendar || {}, p = state.settings.rates.profit / 100;
  const fy = C.fiscalRange(C.fiscalYearOf(C.periodKeyOf(sel.from)));
  const dStd = C.workDaysIn(cal, fy.from, fy.to) / 12;
  const last = state.lastYmd;
  if (!last || !(dStd > 0)) return null;
  const lastKey = C.periodKeyOf(last);
  const endKey = last === C.periodRange(lastKey).to ? lastKey : C.shiftPeriod(lastKey, -1);
  const startKey = C.shiftPeriod(endKey, -11);
  const wFrom = C.periodRange(startKey).from, wTo = C.periodRange(endKey).to;
  const best = pastBest(cal), hc = state.settings.headcount || {};
  const rows = state.cache.sites.map((site) => {
    const a = C.analyze(state.cache, state.settings, wFrom, wTo, [site]).total, b = best[site] || {};
    const P = a.unitPrice || 0, v = a.varPerTon || 0, L = a.laborRate || 0, F = a.fixed / 12;
    const H = hc[site] > 0 ? hc[site] * 8 * dStd : a.hours / 12;
    let cap = 0;
    if (P > 0 && b.daily > 0) cap = Math.min(b.daily * dStd, b.npt > 0 && H > 0 ? H / 8 / b.npt : Infinity);
    return { site, P, v, L, F, H, cap, people: hc[site] || 0 };
  });
  const den = rows.reduce((x, r) => x + r.cap * (r.P * (1 - p) - r.v), 0);
  const need = rows.reduce((x, r) => x + r.H / 8 * r.L + r.F, 0);
  const th = den > 0 ? Math.max(0, need / den) : null;
  rows.forEach((r) => { r.w = th === null ? null : th * r.cap; r.over = th !== null && th > 1.0005 && r.cap > 0; });
  return { rows, th, dStd, reach: th !== null && th <= 1.0005, from: startKey, to: endKey };
}
/* 選んだ工場・期間(月〆=1か月、年度=12か月)の標準の目標をまとめる。グラフ用に平均の単価・費用も出す */
function stdScope(plan, sel) {
  const m = sel.mode === 'fiscal' ? 12 : 1, set = new Set(sel.sites);
  const rs = plan.rows.filter((r) => set.has(r.site));
  if (plan.th === null || !rs.length) return null;
  const W = rs.reduce((x, r) => x + r.w, 0), H = rs.reduce((x, r) => x + r.H, 0);
  if (!(W > 0)) return null;
  const sales = rs.reduce((x, r) => x + r.w * r.P, 0), vari = rs.reduce((x, r) => x + r.w * r.v, 0);
  const labor = rs.reduce((x, r) => x + r.H / 8 * r.L, 0), F = rs.reduce((x, r) => x + r.F, 0);
  return { W: W * m, H: H * m, n: H / 8 / W, P: sales / W, v: vari / W, laborRate: H > 0 ? labor / (H / 8) : 0, fixedOther: F * m, labor: labor * m,
    people: rs.reduce((x, r) => x + r.people, 0), over: rs.some((r) => r.over), mult: m };
}

/* 目標の表(紫の欄)・グラフ・工場別の目標値の表を描く。目標はすべて標準の目標(stdPlan)にそろえる */
function renderGoal(sel) {
  const box = $('goal'), chartBox = $('goal-chart');
  const g = state.settings.rates.profit, gl = fmt(g, g % 1 ? 1 : 0) + '%', p = g / 100;
  const plan = stdPlan(sel), T = plan ? stdScope(plan, sel) : null;
  renderTargetsTable(plan, sel, p);
  const cur = sel.lastTo < sel.fullTo, fcOn = cur && sel.fc && sel.fc.on && !sel.fc.few;
  const t = C.analyze(state.cache, state.settings, sel.from, sel.lastTo, sel.sites).total; // 実績(ここまで)
  if (!T || !(t.weight > 0 || cur)) { box.hidden = true; chartBox.hidden = true; return null; }
  box.hidden = false; chartBox.hidden = false;
  const md = (d) => `${Number(d.slice(5, 7))}/${Number(d.slice(8))}`;
  const phr = (html) => String(html || '').split(/(?=（)|\|/).filter((x) => x !== '').map((x) => `<span class="ph">${x}</span>`).join('');
  const row = (label, value, unit, note, cls) => `<div class="gLabel">${label}</div><div class="gVal ${cls || ''}">${value}<span class="unit">${unit || ''}</span></div><div class="gNote">${phr(note)}</div>`;
  const cmp = (d, unit, digits, goodWhenPlus) => {
    if (Math.abs(d) < 0.5 * Math.pow(10, -digits)) return '<span class="pos">目標どおり</span>';
    const good = goodWhenPlus ? d > 0 : d < 0;
    return `<span class="${good ? 'pos' : 'neg'}">${d > 0 ? '+' : '−'}${fmt(Math.abs(d), digits)}${unit}</span>`;
  };
  const isAll = sel.sites.length === state.cache.sites.length;
  const unitLbl = sel.mode === 'fiscal' ? '年度・12か月分' : '1か月';
  const rateTxt = (x) => x === null ? '—' : fmt(x * 100, 1) + '%';
  let head, lead, rows, x, label;
  const A = fcOn ? C.analyze(sel.data, state.settings, sel.from, sel.fullTo, sel.sites).total : t; // 比べる実績(見込みONは月末見込み)
  const aRate = A.sales > 0 ? A.profit / A.sales : null;
  if (!cur || fcOn) {
    const word = fcOn ? '見込み' : '実績';
    const ok = A.weight >= T.W - 0.05;
    head = `${fcOn ? '月末見込みで' : ''}目標（${unitLbl}）に${fcOn ? '届くか' : '届いたか'}（${sel.reiwa}）${fcOn ? `<small><span class="hl">（出勤日${sel.fc.done}/${sel.fc.total}日の実績から見込み）</span></small>` : ''}`;
    lead = ok ? `<span class="pos">✓ ${word}で目標生産量を達成</span><span class="gLeadSub">（${word} ${ton(A.weight)}t／目標 ${ton(T.W)}t）</span>`
      : `<span class="neg">目標生産量に <b>${ton(T.W - A.weight)}t</b> 届き${fcOn ? 'ません' : 'ませんでした'}</span><span class="gLeadSub">（${word} ${ton(A.weight)}t／目標 ${ton(T.W)}t）</span>`;
    rows = [
      row('生産重量', ton(T.W), 't', `${word} ${ton(A.weight)}t（${cmp(A.weight - T.W, 't', 1, true)}）`),
      row('工数', fmt(T.H, 0), 'h', `${word} ${fmt(A.hours, 0)}h（${cmp(A.hours - T.H, 'h', 0, false)}）`),
      row('1t当たり人工数', npt(T.n), '人工/t', `${word} ${npt(A.ninkuPerTon)}（${A.ninkuPerTon === null ? '—' : cmp(A.ninkuPerTon - T.n, '', 2, false)}）`),
      // 右は目標値(他の行と同じ)。下の実績は マイナス=赤・0%以上で目標未満=オレンジ・目標以上=緑
      row('利益率', fmt(g, g % 1 ? 1 : 0), '%', aRate === null ? `${word} —` : `${word} <span class="${aRate >= p - 1e-9 ? 'pos' : aRate < 0 ? 'neg' : 'warn'}">${fmt(aRate * 100, 1)}%</span>` + (isAll ? `（${cmp((aRate - p) * 100, 'ポイント', 1, true)}）` : '（工場単独の値・目標は3工場合計で達成）')),
    ].join('');
    x = A.weight; label = word;
  } else {
    // 期間の途中(実績のみ・実績が少ないとき・今期): 残りの出勤日で あと何tを何時間で
    const cal = state.settings.calendar || {};
    const next = C.utcToYmd(Date.parse(sel.lastTo + 'T00:00:00Z') + 86400000);
    const doneDays = C.workDaysIn(cal, sel.from, sel.lastTo), leftDays = C.workDaysIn(cal, next, sel.fullTo);
    const perDayH = T.people > 0 ? T.people * 8 : (doneDays > 0 ? t.hours / doneDays : 0);
    const need = Math.max(0, T.W - t.weight), needDay = leftDays > 0 ? need / leftDays : null, perDayW = doneDays > 0 ? t.weight / doneDays : 0;
    const few = doneDays < FC_MIN_DAYS;
    // 工場ごとの1日あたり生産量(工場の目標−工場の実績を残りの出勤日で割る。整数)。例: （本社52_夢前55_鳥取31）
    const siteDay = sel.sites.length > 1 && leftDays > 0 ? '<small>（' + plan.rows.filter((r) => sel.sites.indexOf(r.site) >= 0).map((r) => {
      const a = C.analyze(state.cache, state.settings, sel.from, sel.lastTo, [r.site]).total.weight;
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
      // 今の工数のまま目標の1t当たり人工数になるには、生産重量を何t増やせばよいか(工数÷8÷目標人工/t − 実績重量)
      row('目標の1t当たり人工数', npt(T.n), '人工/t', t.ninkuPerTon === null || !(T.n > 0) ? '' : `実績 ${npt(t.ninkuPerTon)}${few ? `（${doneDays}日分）` : ''}` + (t.ninkuPerTon <= T.n + 1e-9 ? '（<span class="pos">目標達成</span>）' : `（生産 ${ton(t.hours / 8 / T.n - t.weight)}tアップで目標達成）`)),
    ].join('');
    // 参考: 先月度までの不足分を取り返して年間目標に届くための、今月度の生産量(先月度までの過不足を按分)
    if (sel.mode === 'period') {
      const c = carryFor(sel, p), cg = c ? carryGoalTons(sel, p, c) : null;
      if (cg !== null && cg !== undefined) rows += row('参考: 先月度までの過不足を含めた目標', ton(cg), 't', `今期の先月度までの利益率 ${rateTxt(c.prevRate)}（目標${gl}）|を期末までに取り返す場合`);
    }
    x = t.weight; label = '実績';
  }
  box.querySelector('.gHead').innerHTML = head;
  fitHeadSmall(box.querySelector('.gHead small'));
  box.querySelector('.gLead').innerHTML = lead;
  box.querySelector('.gTable').innerHTML = rows;
  // グラフ: 選んだ期間の実績(見込み)の単価・費用で描く(目標シミュレーターと同じ。点線の内訳が実際の損益と一致する)。
  //   締まった期間=実績、月末見込みON=見込み、期間の途中=期間全体の費用(実績＋残りの予定工数)で点線は今のペースの見込み。
  //   ★=標準の目標の目標生産量(表・紫の欄と同じ値)
  let base, cx = x, clabel = label, cn;
  if (!cur || fcOn) {
    base = fcOn ? A : C.analyze(state.cache, state.settings, sel.from, sel.fullTo, sel.sites).total;
    cn = base.ninkuPerTon || 0;
  } else {
    const cal = state.settings.calendar || {};
    const next = C.utcToYmd(Date.parse(sel.lastTo + 'T00:00:00Z') + 86400000);
    const doneDays = C.workDaysIn(cal, sel.from, sel.lastTo), leftDays = C.workDaysIn(cal, next, sel.fullTo);
    const full = C.analyze(state.cache, state.settings, sel.from, sel.fullTo, sel.sites).total;
    let rt = t;
    if (doneDays < FC_MIN_DAYS || !(t.unitPrice > 0)) { const fyR = C.fiscalRange(C.fiscalYearOf(C.periodKeyOf(sel.from))); const tf = C.analyze(state.cache, state.settings, fyR.from, sel.lastTo, sel.sites).total; if (tf.unitPrice > 0) rt = tf; }
    const perDayH = T.people > 0 ? T.people * 8 : (doneDays > 0 ? t.hours / doneDays : 0);
    const H = t.hours + perDayH * leftDays, few = doneDays < FC_MIN_DAYS;
    const Wp = few ? T.W : t.weight + (doneDays > 0 ? t.weight / doneDays : 0) * leftDays;
    base = Object.assign({}, t, { unitPrice: rt.unitPrice, varPerTon: rt.varPerTon, laborRate: rt.laborRate, fixed: full.fixed });
    cx = Wp; clabel = few ? '目標' : '見込み'; cn = Wp > 0 ? H / 8 / Wp : 0;
  }
  const r = C.simulate(base, state.settings, cx, cn, base.unitPrice || 0);
  drawBep('c-goal', { fixed: r.fixed + r.labor, unitPrice: r.unitPrice, laborPerTon: 0, varPerTon: r.varPerTon, profitRate: p,
    fixedLabel: ['固定費', '(人件費込み)'], otherFixed: r.fixed, laborRate: r.laborRate,
    x: cx, fixedX: true, beTons: r.breakEvenTons, goalTons: T.W, handleLabel: clabel, hideMoney: true });
  placeTargets(); requestAnimationFrame(placeTargets);
  return { goalSales: T.W * T.P, progress: cur && !fcOn };
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
    <div class="tgNote">上限: 直近12か月度の各工場の最高実績（1日あたり生産量・人工数）以内${plan.reach ? '' : '。⚠は上限超え'}</div>`;
  el.hidden = false;
}

/* 表の位置(PC): グラフ内で、線(引き出し線・売上・総費用・固定費・補助線・つまみ)や文字・欄と重ならない場所のうち、
   「損益分岐値」の欄のすぐ下に最も近い場所に置く。どこにも空きが無いときは重なりが最も少ない場所。スマホはグラフの下(CSS) */
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
    // 欄の移動先の候補: 表の下(左端をそろえる) → 表の右隣
    const cands = [[tx, ty + h + 12], [tx + w + 14, ty]];
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
window.addEventListener('resize', () => setTimeout(placeTargets, 0));

/* 見出しの（ ）内は2行目に1行で表示し、入りきらないときは文字を小さくして収める */
function fitHeadSmall(sm) {
  if (!sm) return;
  sm.querySelectorAll('.hl').forEach((el) => {
    el.style.fontSize = '';
    if (getComputedStyle(el).whiteSpace !== 'nowrap') return; // 折り返す行は縮めない
    let f = parseFloat(getComputedStyle(el).fontSize);
    while (el.scrollWidth > el.clientWidth + 1 && f > 9) { f -= 0.5; el.style.fontSize = f + 'px'; }
  });
}
window.addEventListener('resize', () => fitHeadSmall(document.querySelector('#goal .gHead small')));
