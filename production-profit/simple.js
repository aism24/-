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
      works: { '26-01': { contract: 60000000, totalWeight: 200 }, '26-02': { contract: 45000000, totalWeight: null } } }) };
  }
  const res = await fetch(GAS_API_URL, {
    method: 'POST', headers: { 'Content-Type': 'text/plain;charset=utf-8' },
    body: JSON.stringify({ action: action, pw: state.pw }),
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
function esc(s) { return String(s === null || s === undefined ? '' : s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c])); }
/* 金額は万円単位で見やすく(1億円以上は億円) */
function money(v) {
  if (v === null || v === undefined || !isFinite(v)) return ['—', ''];
  return Math.abs(v) >= 1e8 ? [fmt(v / 1e8, 2), '億円'] : [fmt(v / 1e4, 0), '万円'];
}
function ssGet(k) { try { return sessionStorage.getItem(k); } catch (e) { return null; } }
function ssSet(k, v) { try { sessionStorage.setItem(k, v); } catch (e) { /* 無視 */ } }

document.addEventListener('DOMContentLoaded', () => {
  $('lock-btn').onclick = () => unlock($('lock-input').value);
  $('lock-input').onkeydown = (e) => { if (e.key === 'Enter') unlock(e.target.value); };
  $('to-home').onclick = () => { location.href = 'index.html' + (DEMO ? '?demo=1' : ''); };
  $('to-detail').onclick = () => { location.href = 'detail.html' + viewQuery(); };
  unlock(DEMO ? 'demo' : (ssGet('pp-pw') || '')); // パスワードは詳細版と共用(同じタブで入力済みなら再入力不要)
});

async function unlock(pw) {
  state.pw = pw;
  $('lock-msg').textContent = '';
  $('loading').hidden = false;
  try {
    const data = await api('getData');
    ssSet('pp-pw', pw);
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
    $('screen-lock').hidden = false;
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
  $('f-period').value = periods[1] || periods[0];
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

  $('f-modes').onclick = (e) => { const b = e.target.closest('button'); if (b) { state.mode = b.dataset.mode; render(); } };
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
  return { mode, from: r.from, to, fullTo: r.to, sites, data, fc, note, periodKey: mode === 'period' ? selPer.value : null };
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
    $('cards').innerHTML = `<div class="sMsg">${esc(C.periodLabel(sel.periodKey))}は、まだ出勤日${sel.fc.done}日分の実績しかないため表示していません` +
      `(出勤日${FC_MIN_DAYS}日分以上で月末見込みを表示します)。<br>◀で前の月度を見るか、「月末見込み」を押して実績のみで表示してください。</div>`;
    return;
  }
  $('s-note').textContent = state.pass.w ? `詳細版で選んでいた工事(${state.pass.w})の絞り込みは、シンプル版では使わず全工事で表示しています(詳細版へ戻ると元に戻ります)。` : '';
  const t = C.analyze(sel.data, state.settings, sel.from, sel.to, sel.sites).total;
  const hasSales = t.sales > 0;
  const [pv, pu] = money(t.profit), [sv, su] = money(t.sales);
  let beSub, beVal, beCls = '';
  if (t.breakEvenTons === null) { beVal = '—'; beSub = '限界利益がマイナスのため到達できません'; beCls = 'bad'; }
  else if (t.weight >= t.breakEvenTons) { beVal = fmt(t.weight - t.breakEvenTons, 1); beSub = `達成(損益分岐 ${fmt(t.breakEvenTons, 1)}t を上回り)`; beCls = 'good'; }
  else { beVal = fmt(t.breakEvenTons - t.weight, 1); beSub = `損益分岐 ${fmt(t.breakEvenTons, 1)}t まであと`; beCls = 'bad'; }
  $('cards').innerHTML = [
    card('損益', (t.profit > 0.5 ? '+' : '') + pv, pu, hasSales ? `利益率 ${t.profitRate === null ? '—' : (t.profitRate * 100).toFixed(1) + '%'}` : '売上なし', 'big ' + (t.profit >= 0 ? 'good' : 'bad')),
    card('生産重量', fmt(t.weight, 1), 't', ''),
    card('1t当たり人工数', fmt(t.ninkuPerTon, 2), '人工/t', `総工数 ${fmt(t.ninku, 1)}人工`),
    card('売上額', sv, su, ''),
    card(t.breakEvenTons !== null && t.weight >= t.breakEvenTons ? '損益分岐を超えた量' : '損益分岐まで', beVal, beVal === '—' ? '' : 't', beSub, beCls),
  ].join('');
}
