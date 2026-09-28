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
const yen = (v) => fmt(v, 0), ton = (v) => fmt(v, 1), npt = (v) => fmt(v, 2); // bepchart.js も使う
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
  const lastTo = state.lastYmd && state.lastYmd >= r.from && state.lastYmd < r.to ? state.lastYmd : r.to; // 実績の最終日(見込みにしない)
  const label = (mode === 'period' ? C.periodLabel(selPer.value) : C.fiscalLabel(Number($('f-fiscal').value))) + '・' + (state.site || state.cache.sites.length + '工場');
  return { mode, from: r.from, to, fullTo: r.to, lastTo, label, sites, data, fc, note, periodKey: mode === 'period' ? selPer.value : null };
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
    $('s-warn').textContent = priceWarn(sel);
    renderGoal(sel); // 目標(在職中人数×8h・先月度までの過不足から出す)は、月末見込みを使わないので実績が少なくても出す
    $('cards').innerHTML = `<div class="sMsg">${esc(C.periodLabel(sel.periodKey))}は、まだ出勤日${sel.fc.done}日分の実績しかないため表示していません` +
      `(出勤日${FC_MIN_DAYS}日分以上で月末見込みを表示します)。<br>「月末見込み」を押すと実績のみで表示します。目標は右（下）の欄をご覧ください。</div>`;
    return;
  }
  $('s-warn').textContent = priceWarn(sel);
  $('s-note').textContent = state.pass.w ? `詳細版で選んでいた工事(${state.pass.w})の絞り込みは、シンプル版では使わず全工事で表示しています(詳細版へ戻ると元に戻ります)。` : '';
  const t = C.analyze(sel.data, state.settings, sel.from, sel.to, sel.sites).total;
  const hasSales = t.sales > 0;
  const gi = renderGoal(sel);
  // 生産重量・工数は値を、売上額・損益は目標に対する割合を表示する(1行に4枚)
  const g = state.settings.rates.profit, gl = fmt(g, g % 1 ? 1 : 0) + '%';
  let sVal = '—', sSub = '', sCls = '';
  if (gi && gi.goalSales > 0) {
    const ratio = t.sales / gi.goalSales, rest = 1 - ratio;
    sVal = fmt(ratio * 100, 0);
    sSub = gi.progress ? `目標値に対して（${rest > 0.005 ? '残り ' + fmt(rest * 100, 0) + '%' : '達成'}・期間の途中）`
      : `目標値に対して（${rest > 0.005 ? fmt(rest * 100, 0) + '%不足' : '達成'}）`;
    sCls = gi.progress ? '' : (rest > 0.005 ? 'bad' : 'good');
  }
  const pr = hasSales && t.profitRate !== null ? t.profitRate * 100 : null;
  $('cards').innerHTML = [
    card('生産重量', fmt(t.weight, 1), 't', ''),
    card('1t当たり人工数', fmt(t.ninkuPerTon, 2), '人工/t', `総工数 ${fmt(t.ninku, 1)}人工`),
    card('売上額（概算）', sVal, sVal === '—' ? '' : '%', sSub, sCls),
    card('損益（概算）', pr === null ? '—' : pr.toFixed(1), pr === null ? '' : '%', `利益率：現在（目標＝${gl}）`, pr === null ? '' : (pr >= g - 1e-9 ? 'good' : 'bad')),
  ].join('');
}

/* 契約金額が未入力で、選択した期間・工場に生産実績がある工事(売上0円で計算される)。詳細版の警告と同じ判定 */
function priceWarn(sel) {
  const common = C.commonWorkSet(state.settings), siteSet = new Set(sel.sites), w = {};
  state.cache.rec.forEach((r) => {
    if (r[0] < sel.from || r[0] > sel.lastTo || !siteSet.has(r[1]) || !r[2] || common[r[2]]) return;
    w[r[2]] = (w[r[2]] || 0) + r[3];
  });
  const list = Object.keys(w).filter((wn) => w[wn] >= 0.05 && C.unitPriceOf(wn, state.cache, state.settings).source === 'none').sort().reverse();
  return list.length ? `⚠ 契約金額が未入力の工事があります(売上0円で計算。売上・損益・目標が実際より悪く出ます): ${list.slice(0, 5).join('、')}${list.length > 5 ? ' ほか' + (list.length - 5) + '件' : ''}` : '';
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

/* ===================== 目標(何tを何時間で) =====================
   詳細版の目標シミュレーターと同じ前提: 人件費=工数×人件費単価(工数で決まる額を固定費に含める)、
   トン単価・変動費単価・人件費単価は実績の値。目標は「損益 ≧ 売上×利益率」。
   - 期間の途中(今期・今月度): 残りの出勤日も、これまでと同じ1日あたり工数で働く前提で、
     期間全体(残りの月の固定費を含む)で目標に届く生産量 → 「残り◯日で あと◯t を ◯h で」
   - 締まった期間(過去): 実績の工数なら何t必要だったか / 実績の生産量なら工数は何h以内だったか */
function renderGoal(sel) {
  const box = $('goal');
  const g = state.settings.rates.profit, gl = fmt(g, g % 1 ? 1 : 0) + '%', p = g / 100;
  const cur = sel.lastTo < sel.fullTo; // 期間の途中
  // 実績(月末見込みにしない、実績の最終日まで)
  const t = C.analyze(state.cache, state.settings, sel.from, sel.lastTo, sel.sites).total;
  const chartBox = $('goal-chart');
  if (!(t.weight > 0) || !(t.unitPrice > 0)) { box.hidden = true; chartBox.hidden = true; return null; }
  box.hidden = false;
  chartBox.hidden = false;
  const md = (d) => `${Number(d.slice(5, 7))}/${Number(d.slice(8))}`;
  // 備考は「（」の前と「|」の位置で区切り、区切りの位置でだけ改行する(言葉の途中で折り返さない)
  const phr = (html) => String(html || '').split(/(?=（)|\|/).filter((x) => x !== '').map((x) => `<span class="ph">${x}</span>`).join('');
  const row = (label, value, unit, note, cls) => `<div class="gLabel">${label}</div><div class="gVal ${cls || ''}">${value}<span class="unit">${unit || ''}</span></div><div class="gNote">${phr(note)}</div>`;
  const cmp = (d, unit, digits, goodWhenPlus) => {
    if (Math.abs(d) < 0.5 * Math.pow(10, -digits)) return '<span class="pos">目標どおり</span>';
    const good = goodWhenPlus ? d > 0 : d < 0;
    return `<span class="${good ? 'pos' : 'neg'}">${d > 0 ? '+' : '−'}${fmt(Math.abs(d), digits)}${unit}</span>`;
  };
  // 金額は出さず割合で表す。pts: 利益率の差(ポイント)。S: 割合の分母の売上(見込みON=見込みの売上、実績のみ=目標生産量×トン単価)
  const pts = (v) => `${v > 0 ? '+' : v < 0 ? '−' : ''}${fmt(Math.abs(v) * 100, 1)}ポイント`;
  const carryRows = (c, S) => {
    const pr = c.prevRate, d = pr === null ? null : pr - p;
    const add = S > 0 ? c.carry / S : null; // 先月度までの過不足を取り返すための上乗せ(利益率のポイント)
    return row('今期の先月度までの利益率', pr === null ? '—' : fmt(pr * 100, 1), pr === null ? '' : '%', d === null ? '' : `目標${gl}に対して <span class="${d >= 0 ? 'pos' : 'neg'}">${pts(d)}</span>（${d >= 0 ? '余裕' : '不足'}）`, d === null ? '' : (d >= 0 ? 'pos' : 'neg')) +
      row('今月度に必要な利益率', add === null ? '—' : fmt((p + add) * 100, 1), add === null ? '' : '%', add === null ? '' : `目標${gl}${add >= 0 ? '＋' : '−'}先月度までの${add >= 0 ? '不足' : '余裕'}分 ${fmt(Math.abs(add) * 100, 1)}ポイント（今月度の出勤日 ${c.monthDays}日 ÷|期末(${md(c.fyTo)})までの出勤日 ${c.restDays}日で按分）`);
  };
  // 月末見込みON(月度の途中で見込みを計算しているとき): 見込みの生産量・工数・損益を目標と比べる(目標シミュレーターと同じく見込みのデータで計算)
  const fcOn = cur && sel.fc && sel.fc.on && !sel.fc.few;
  let head, lead, rows, chart;
  if (fcOn) {
    const tf = C.analyze(sel.data, state.settings, sel.from, sel.fullTo, sel.sites).total; // 月末見込み(実績を出勤日数の比で引き伸ばし)
    const c = carryFor(sel, p), carry = c ? c.carry : 0;
    const r = C.simulate(Object.assign({}, tf, { fixed: tf.fixed + carry }), state.settings, tf.weight, tf.ninkuPerTon || 0, tf.unitPrice);
    const a = C.advise(r, state.settings);             // 不足額(先月度までの負担分を含む)
    const ok = a.gap <= 0.5;
    const profit = r.profit + carry;                    // 表示する損益は実際の見込み額(負担分を引く前)
    const hMax = a.cutHours !== null ? r.hours - a.cutHours : null;
    head = `月末見込みで目標利益率${gl}に届くか<small>（${esc(sel.label)}・〜${md(sel.fullTo)}・出勤日${sel.fc.done}/${sel.fc.total}日の実績から見込み${c ? '・年間目標に向けて先月度までの過不足を反映' : ''}）</small>`;
    const rate = tf.sales > 0 ? profit / tf.sales : null, needRate = tf.sales > 0 ? p + carry / tf.sales : p;
    const rateTxt = `見込み利益率 ${rate === null ? '—' : fmt(rate * 100, 1) + '%'}（必要 ${fmt(needRate * 100, 1)}%）`;
    lead = ok ? `<span class="pos">✓ 見込みでは目標を達成</span><span class="gLeadSub">（${rateTxt}）</span>` : `<span class="neg">見込みでは目標に届きません</span><span class="gLeadSub">（${rateTxt}）</span>`;
    rows = (c ? carryRows(c, tf.sales) : '') + [ // 見込みONは見込みの売上で割合を出す(見出しの「必要◯%」と同じ)
      row('見込み生産量', ton(tf.weight), 't', r.goalTons !== null ? `目標 ${ton(r.goalTons)}t（${cmp(tf.weight - r.goalTons, 't', 1, true)}）` : '目標: 到達不能', r.goalTons !== null && tf.weight >= r.goalTons - 0.05 ? 'pos' : 'neg'),
      row('見込み工数', fmt(r.hours, 0), 'h', hMax !== null && hMax > 0 ? `この生産量なら ${fmt(hMax, 0)}h以内（${cmp(r.hours - hMax, 'h', 0, false)}）` : ''),
      row('目標生産量<small>（見込みの工数なら）</small>', r.goalTons !== null ? ton(r.goalTons) : '到達不能', r.goalTons !== null ? 't' : '', r.goalTons !== null ? `1日あたり ${ton(r.goalTons / sel.fc.total)}t（見込み ${ton(tf.weight / sel.fc.total)}t/日）` : ''),
      row('1t当たり人工数', npt(tf.ninkuPerTon), '人工/t', hMax !== null && hMax > 0 ? `目標 ${npt(hMax / 8 / tf.weight)}以下（見込みの生産量なら）` : ''),
      row('見込み利益率', rate === null ? '—' : fmt(rate * 100, 1), rate === null ? '' : '%', `必要 ${fmt(needRate * 100, 1)}%（${rate === null ? '—' : `<span class="${ok ? 'pos' : 'neg'}">${pts(rate - needRate)}</span>`}）`, ok ? 'pos' : 'neg'),
    ].join('');
    r.fixed -= carry; // 表示用は実際の固定費(負担分は carry で別に描く)
    chart = { r, x: tf.weight, label: '見込み', carry };
  } else if (cur) {
    const full = C.analyze(state.cache, state.settings, sel.from, sel.fullTo, sel.sites).total;
    const cal = state.settings.calendar || {};
    const next = C.utcToYmd(Date.parse(sel.lastTo + 'T00:00:00Z') + 86400000);
    const doneDays = C.workDaysIn(cal, sel.from, sel.lastTo), leftDays = C.workDaysIn(cal, next, sel.fullTo);
    const perDayW = doneDays > 0 ? t.weight / doneDays : 0;
    // 1t当たり人工数の実績: 月〆は今月度(ここまで)と今期(期首〜ここまで)を並べる(月の初めは今月度の値がぶれるため)
    let fyNote = `実績 ${npt(t.ninkuPerTon)}`;
    if (sel.mode === 'period') {
      const fyR = C.fiscalRange(C.fiscalYearOf(sel.periodKey));
      const tf = C.analyze(state.cache, state.settings, fyR.from, sel.lastTo, sel.sites).total;
      fyNote = `今月度の実績 ${npt(t.ninkuPerTon)}（${doneDays}日分）・|今期の実績 ${npt(tf.ninkuPerTon)}`;
    }
    const few = doneDays < FC_MIN_DAYS; // 実績が少ないときは「今のペースの見込み」を出さない(ぶれが大きいため)
    // トン単価・変動費単価・人件費単価: 月〆で出勤日の実績が少ないときは今期(期首〜ここまで)の実績を使う(数日分では工事の偏りでぶれるため)
    let rate = t, rateNote = '';
    if (few && sel.mode === 'period') {
      const fyR = C.fiscalRange(C.fiscalYearOf(sel.periodKey));
      const tf = C.analyze(state.cache, state.settings, fyR.from, sel.lastTo, sel.sites).total;
      if (tf.weight > 0 && tf.unitPrice > 0) { rate = tf; rateNote = '・今月度の実績が少ないため、トン単価・変動費・人件費単価は今期の実績で計算'; }
    }
    const rates = { unitPrice: rate.unitPrice, varPerTon: rate.varPerTon, laborRate: rate.laborRate };
    // 残り期間の1日あたり工数 = 在職中の従業員数(基本設定の名簿) × 8h(全員出勤)。名簿が読めないときはこれまでのペース
    const hc = state.settings.headcount;
    const people = hc ? sel.sites.reduce((a, x) => a + (hc[x] || 0), 0) : 0;
    const perDayH = people > 0 ? people * 8 : (doneDays > 0 ? t.hours / doneDays : 0);
    const hNote = people > 0 ? `全員出勤で１日８時間で計算（在職中 ${people}人）` : '従業員名簿が読めないため、これまでのペースで計算';
    const H = t.hours + perDayH * leftDays;             // 期間全体の予定工数(実績＋残りの出勤日×1日あたり工数)
    const Wpace = t.weight + perDayW * leftDays;        // 今のペースで続けたときの生産量
    // 月〆の今月度: 今期の先月度までの過不足(損益−売上×利益率)を、今月度〜期末の出勤日数で按分して今月度の目標に上乗せする
    // (毎月この目標を達成すれば、期末に年間目標にも届く)。carry>0 = 不足分を取り返す額、<0 = 余裕
    const carryInfo = carryFor(sel, p), carry = carryInfo ? carryInfo.carry : 0;
    if (carryInfo) carryInfo.solo = C.simulate(Object.assign({}, t, rates, { fixed: full.fixed }), state.settings, Wpace, Wpace > 0 ? H / 8 / Wpace : 0, rates.unitPrice);
    const base = Object.assign({}, t, rates, { fixed: full.fixed + carry });
    const r = C.simulate(base, state.settings, Wpace, Wpace > 0 ? H / 8 / Wpace : 0, rates.unitPrice);
    r.fixed -= carry; r.carry = carry; // 表示用の固定費は実際の額(上乗せ分は carry で別に持つ)
    head = `目標利益率${gl}を達成するには<small>（${esc(sel.label)}・〜${md(sel.fullTo)}${carryInfo ? '・年間目標に向けて先月度までの過不足を反映' : ''}${rateNote}）</small>`;
    if (r.goalTons === null) {
      lead = '<span class="neg">今のトン単価・費用では、生産量を増やしても目標に届きません</span>';
      rows = '';
    } else {
      const need = r.goalTons - t.weight;               // 残りの必要生産量
      const needDay = leftDays > 0 ? need / leftDays : null;
      lead = need <= 0
        ? `<span class="pos">✓ 目標の生産量に到達済み</span><span class="gLeadSub">（残り期間の生産量に関わらず達成）</span>`
        : leftDays > 0
          ? `残り <b>${leftDays}</b>出勤日で あと <b class="gKey">${ton(need)}t</b> を <b class="gKey">${fmt(perDayH * leftDays, 0)}h</b> で`
          : '<span class="neg">残りの出勤日がありません</span>';
      rows = [
        row('目標生産量(期間合計)', ton(r.goalTons), 't', `実績 ${ton(t.weight)}t ＋ 残り ${ton(Math.max(0, need))}t`),
        row('予定工数(期間合計)', fmt(H, 0), 'h', `実績 ${fmt(t.hours, 0)}h ＋|1日 ${fmt(perDayH, 0)}h × 残り ${leftDays}日`),
        row('1日あたり生産量', needDay !== null && need > 0 ? ton(needDay) : '—', 't/日', needDay !== null && need > 0 ? `これまで ${ton(perDayW)}t/日（${perDayW > 0 ? fmt(needDay / perDayW, 2) + '倍' : '—'}）` : ''),
        row('1日あたり工数', fmt(perDayH, 0), 'h/日', hNote + (doneDays > 0 ? `（これまで ${fmt(t.hours / doneDays, 0)}h/日）` : '')),
        row('目標の1t当たり人工数', npt(H / 8 / r.goalTons), '人工/t', `以下|（${fyNote}）`),
        few ? '' : row('今のペースの見込み', ton(Wpace), 't', '目標との差 ' + cmp(Wpace - r.goalTons, 't', 1, true), Wpace >= r.goalTons - 0.05 ? 'pos' : 'neg'),
      ].join('');
      if (carryInfo) {
        const c = carryInfo;
        rows = carryRows(c, r.goalTons * r.unitPrice) +
          rows +
          row('参考: 今月度だけの目標', c.solo.goalTons !== null ? ton(c.solo.goalTons) : '到達不能', c.solo.goalTons !== null ? 't' : '', '先月度までの過不足を入れない場合');
      }
    }
    // 実績が少ないときは見込みがぶれるので、点線は目標の位置に置く(損益分岐値の欄が極端な値にならないように)
    chart = { r, x: few && r.goalTons !== null ? r.goalTons : Wpace, label: few ? '目標' : '見込み' };
  } else {
    const r = C.simulate(t, state.settings, t.weight, t.ninkuPerTon || 0, t.unitPrice);
    const a = C.advise(r, state.settings);
    const ok = a.gap <= 0.5;
    head = `目標利益率${gl}を達成するには、どうするべきだったか<small>（${esc(sel.label)}）</small>`;
    const rate = t.sales > 0 ? r.profit / t.sales : null;
    const rateTxt = `利益率 ${rate === null ? '—' : fmt(rate * 100, 1) + '%'}／目標 ${gl}`;
    lead = ok ? `<span class="pos">✓ 目標を達成しました</span><span class="gLeadSub">（${rateTxt}）</span>` : `<span class="neg">目標利益率に <b>${rate === null ? '—' : fmt((p - rate) * 100, 1)}ポイント</b> 届きませんでした</span><span class="gLeadSub">（${rateTxt}）</span>`;
    const hMax = a.cutHours !== null ? r.hours - a.cutHours : null; // 実績の生産量で目標に届く工数の上限
    rows = [
      row('生産量<small>（実績の工数なら）</small>', r.goalTons !== null ? ton(r.goalTons) : '到達不能', r.goalTons !== null ? 't' : '', r.goalTons !== null ? `実績 ${ton(t.weight)}t（${cmp(t.weight - r.goalTons, 't', 1, true)}）` : ''),
      row('工数<small>（実績の生産量なら）</small>', hMax !== null && hMax > 0 ? fmt(hMax, 0) : '—', 'h以内', hMax !== null ? `実績 ${fmt(r.hours, 0)}h（${cmp(r.hours - hMax, 'h', 0, false)}）` : ''),
      row('1t当たり人工数', hMax !== null && hMax > 0 ? npt(hMax / 8 / t.weight) : '—', '人工/t以下', `実績 ${npt(t.ninkuPerTon)}`),
      row('利益率', rate === null ? '—' : fmt(rate * 100, 1), rate === null ? '' : '%', `目標 ${gl}（${rate === null ? '—' : `<span class="${ok ? 'pos' : 'neg'}">${pts(rate - p)}</span>`}）`, ok ? 'pos' : 'neg'),
    ].join('');
    chart = { r, x: t.weight, label: '実績' };
  }
  box.querySelector('.gHead').innerHTML = head.replace(/<small>([\s\S]*)<\/small>/, (m, x) => '<small>' + x.split(/(?<=・)/).map((y) => `<span class="ph">${y}</span>`).join('') + '</small>');
  box.querySelector('.gLead').innerHTML = lead;
  box.querySelector('.gTable').innerHTML = rows;
  const r = chart.r;
  const cyRaw = chart.carry !== undefined ? chart.carry : (r.carry || 0);
  const cy = Math.abs(cyRaw) >= 1 ? cyRaw : 0; // 先月度までの不足の今月度負担分は、グラフでは固定費に上乗せして描く(余裕分は差し引く)
  drawBep('c-goal', { fixed: r.fixed + r.labor + cy, unitPrice: r.unitPrice, laborPerTon: 0, varPerTon: r.varPerTon, profitRate: p,
    fixedLabel: cy ? ['固定費(人件費込み)', cy > 0 ? '+先月度までの不足分' : '−先月度までの超過分'] : ['固定費', '(人件費込み)'], otherFixed: r.fixed + cy, laborRate: r.laborRate,
    x: chart.x, fixedX: true, beTons: r.breakEvenTons, goalTons: r.goalTons, handleLabel: chart.label, hideMoney: true });
  renderTargets(sel, fcOn ? 'fc' : cur ? 'cur' : 'past', p);
  // カードの「売上額(概算)」の目標: 目標生産量 × トン単価(目標の表・グラフと同じ値)
  return { goalSales: r.goalTons !== null ? r.goalTons * r.unitPrice : null, progress: cur && !fcOn };
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

function renderTargets(sel, kind, p) {
  const el = $('goal-targets');
  const cal = state.settings.calendar || {};
  const sites = state.cache.sites, best = pastBest(cal);
  const next = C.utcToYmd(Date.parse(sel.lastTo + 'T00:00:00Z') + 86400000);
  const doneDays = C.workDaysIn(cal, sel.from, sel.lastTo), leftDays = kind === 'cur' ? C.workDaysIn(cal, next, sel.fullTo) : 0;
  const totalDays = C.workDaysIn(cal, sel.from, sel.fullTo);
  const few = kind === 'cur' && sel.mode === 'period' && doneDays < FC_MIN_DAYS;
  const hc = state.settings.headcount || {};
  const fs = sites.map((site) => {
    const one = [site];
    let t, H, F, floor = 0, Wmax;
    const b = best[site] || {};
    if (kind === 'fc') {
      t = C.analyze(sel.data, state.settings, sel.from, sel.fullTo, one).total;
      H = t.hours; F = t.fixed; Wmax = b.daily !== null && b.daily !== undefined ? b.daily * totalDays : null;
    } else if (kind === 'cur') {
      t = C.analyze(state.cache, state.settings, sel.from, sel.lastTo, one).total;
      F = C.analyze(state.cache, state.settings, sel.from, sel.fullTo, one).total.fixed;
      const perDay = hc[site] > 0 ? hc[site] * 8 : (doneDays > 0 ? t.hours / doneDays : 0);
      H = t.hours + perDay * leftDays; floor = t.weight;
      Wmax = b.daily !== null && b.daily !== undefined ? t.weight + b.daily * leftDays : null;
    } else {
      t = C.analyze(state.cache, state.settings, sel.from, sel.fullTo, one).total;
      H = t.hours; F = t.fixed; Wmax = b.daily !== null && b.daily !== undefined ? b.daily * totalDays : null;
    }
    // 単価: 実績が少ない月度の途中は今期の実績(目標の表と同じ)
    let rt = t;
    if (few || !(t.unitPrice > 0)) {
      const fy = C.fiscalRange(C.fiscalYearOf(C.periodKeyOf(sel.from)));
      const tf = C.analyze(state.cache, state.settings, fy.from, sel.lastTo, one).total;
      if (tf.unitPrice > 0) rt = tf;
    }
    const P = rt.unitPrice || 0, v = rt.varPerTon || 0, L = rt.laborRate || 0;
    const cap = Wmax === null ? null : Math.max(floor, Math.min(Wmax, b.npt > 0 && H > 0 ? H / 8 / b.npt : Wmax));
    return { site, P, v, L, H, F, floor, cap, ok: P > 0 && cap !== null && cap > 0 };
  });
  const use = fs.filter((f) => f.ok);
  if (!use.length) { el.hidden = true; return; }
  // 先月度までの過不足の負担分は、目標の表と同じく期間の途中(今月度)だけ含める(過去の期間はその期間だけで評価)
  const c = kind === 'past' ? null : carryFor(Object.assign({}, sel, { sites }), p), carry = c ? c.carry : 0;
  const W = (f, th) => Math.max(f.floor, th * f.cap);
  const surplus = (th) => use.reduce((a, f) => { const w = W(f, th); return a + w * (f.P * (1 - p) - f.v) - f.H / 8 * f.L - f.F; }, 0) - carry;
  let th = 1, reach = surplus(1) >= 0;
  if (reach) { let lo = 0, hi = 1; for (let i = 0; i < 60; i++) { const m = (lo + hi) / 2; if (surplus(m) >= 0) hi = m; else lo = m; } th = hi; }
  const rows = use.map((f) => ({ site: f.site, w: W(f, th), h: f.H, sales: W(f, th) * f.P, profit: W(f, th) * (f.P - f.v) - f.H / 8 * f.L - f.F }));
  const tot = rows.reduce((a, r) => ({ w: a.w + r.w, h: a.h + r.h, sales: a.sales + r.sales, profit: a.profit + r.profit }), { w: 0, h: 0, sales: 0, profit: 0 });
  const rate = tot.sales > 0 ? tot.profit / tot.sales : null, need = tot.sales > 0 ? p + carry / tot.sales : p;
  const g = fmt(p * 100, (p * 100) % 1 ? 1 : 0) + '%';
  const tr = (name, r, cls) => `<tr class="${cls || ''}"><td>${esc(name)}</td><td>${r ? ton(r.w) : '—'}</td><td>${r ? fmt(r.h, 0) : '—'}</td><td>${r && r.w > 0 ? npt(r.h / 8 / r.w) : '—'}</td></tr>`;
  el.innerHTML = `<div class="tgHead">【目標値】<small>${kind === 'past' ? 'この期間に' : '期間合計で'}${reach ? `目標利益率${g}${carry ? '（先月度までの過不足を含む）' : ''}を達成する量` : `<b class="neg">過去の実績の範囲では目標に届きません</b>（上限まで上げて利益率 ${rate === null ? '—' : fmt(rate * 100, 1) + '%'}／必要 ${fmt(need * 100, 1)}%）`}</small></div>
    <table><tr><th>工場</th><th>生産重量<br>(t)</th><th>工数<br>(h)</th><th>人工数<br>(人工/t)</th></tr>
    ${tr('3工場', tot, 'tot')}${sites.map((site) => tr(site, rows.find((r) => r.site === site))).join('')}</table>
    <div class="tgNote">上限: 直近12か月度の各工場の最高実績（1日あたり生産量・人工数）以内</div>`;
  el.hidden = false;
  placeTargets();
  requestAnimationFrame(placeTargets); // グラフの欄の位置が描画後に決まる場合に備えて、もう一度合わせる
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
    // 欄の移動先の候補: 表の右隣 → 表の下
    const cands = [[tx + w + 14, ty], [tx, ty + h + 12]];
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
