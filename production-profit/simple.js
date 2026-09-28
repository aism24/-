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

/* ===================== 目標(何tを何時間で) =====================
   詳細版の目標シミュレーターと同じ前提: 人件費=工数×人件費単価(工数で決まる額を固定費に含める)、
   トン単価・変動費単価・人件費単価は実績の値。目標は「損益 ≧ 売上×利益率」。
   - 期間の途中(今期・今月度): 残りの出勤日も、これまでと同じ1日あたり工数で働く前提で、
     期間全体(残りの月の固定費を含む)で目標に届く生産量 → 「残り◯日で あと◯t を ◯h で」
   - 締まった期間(過去): 実績の工数なら何t必要だったか / 実績の生産量なら工数は何h以内だったか */
/* 目標の計算と表示内容を作る(DOMは触らない)。ov = { goalTons, hours }: 工場を1つ選んだとき、
   3工場の目標を割り振った値(工場別の目標値の表と同じ)で目標生産量を置き換える */
function buildGoal(sel, ov) {
  const g = state.settings.rates.profit, gl = fmt(g, g % 1 ? 1 : 0) + '%', p = g / 100;
  const cur = sel.lastTo < sel.fullTo; // 期間の途中
  // 実績(月末見込みにしない、実績の最終日まで)
  const t = C.analyze(state.cache, state.settings, sel.from, sel.lastTo, sel.sites).total;
  if (!(t.weight > 0)) return null;
  if (!(t.unitPrice > 0) && !cur) return null; // 締まった期間で売上が無いときは目標を出せない
  const ovNote = ov ? '・3工場の目標を過去の実績の比で割り振った値' : '';
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
    const c = ov ? null : carryFor(sel, p), carry = c ? c.carry : 0; // 工場を選んだとき(ov)は、負担分は3工場の目標の割り振りに含まれている
    const r = C.simulate(Object.assign({}, tf, { fixed: tf.fixed + carry }), state.settings, tf.weight, tf.ninkuPerTon || 0, tf.unitPrice);
    const a = C.advise(r, state.settings);             // 不足額(先月度までの負担分を含む)
    if (ov) { r.goalTons = ov.goalTons; r.goalSales = ov.goalTons * r.unitPrice; }
    const ok = ov ? tf.weight >= ov.goalTons - 0.05 : a.gap <= 0.5;
    const profit = r.profit + carry;                    // 表示する損益は実際の見込み額(負担分を引く前)
    // 工数の上限: 工場を選んだときは目標の1t当たり人工数(表と同じ)を保つ工数
    const hMax = ov ? (ov.goalTons > 0 ? tf.weight * r.hours / ov.goalTons : null) : (a.cutHours !== null ? r.hours - a.cutHours : null);
    head = `月末見込みで目標利益率${gl}に届くか<small>（${esc(sel.label)}・〜${md(sel.fullTo)}・出勤日${sel.fc.done}/${sel.fc.total}日の実績から見込み${c ? '・年間目標に向けて先月度までの過不足を反映' : ''}${ovNote}）</small>`;
    const rate = tf.sales > 0 ? profit / tf.sales : null, needRate = tf.sales > 0 ? p + carry / tf.sales : p;
    const rateTxt = ov ? `見込み生産量 ${ton(tf.weight)}t／目標 ${ton(ov.goalTons)}t` : `見込み利益率 ${rate === null ? '—' : fmt(rate * 100, 1) + '%'}（必要 ${fmt(needRate * 100, 1)}%）`;
    lead = ok ? `<span class="pos">✓ 見込みでは目標を達成</span><span class="gLeadSub">（${rateTxt}）</span>` : `<span class="neg">見込みでは目標に届きません</span><span class="gLeadSub">（${rateTxt}）</span>`;
    rows = (c ? carryRows(c, tf.sales) : '') + [ // 見込みONは見込みの売上で割合を出す(見出しの「必要◯%」と同じ)
      row('見込み生産量', ton(tf.weight), 't', r.goalTons !== null ? `目標 ${ton(r.goalTons)}t（${cmp(tf.weight - r.goalTons, 't', 1, true)}）` : '目標: 到達不能', r.goalTons !== null && tf.weight >= r.goalTons - 0.05 ? 'pos' : 'neg'),
      row('見込み工数', fmt(r.hours, 0), 'h', hMax !== null && hMax > 0 ? `この生産量なら ${fmt(hMax, 0)}h以内（${cmp(r.hours - hMax, 'h', 0, false)}）` : ''),
      row('目標生産量<small>（見込みの工数なら）</small>', r.goalTons !== null ? ton(r.goalTons) : '到達不能', r.goalTons !== null ? 't' : '', r.goalTons !== null ? `1日あたり ${ton(r.goalTons / sel.fc.total)}t（見込み ${ton(tf.weight / sel.fc.total)}t/日）` : ''),
      row('1t当たり人工数', npt(tf.ninkuPerTon), '人工/t', hMax !== null && hMax > 0 ? `目標 ${npt(hMax / 8 / tf.weight)}以下（見込みの生産量なら）` : ''),
      ov ? row('見込み利益率', rate === null ? '—' : fmt(rate * 100, 1), rate === null ? '' : '%', '工場単独の値（目標は3工場合計で達成）')
        : row('見込み利益率', rate === null ? '—' : fmt(rate * 100, 1), rate === null ? '' : '%', `必要 ${fmt(needRate * 100, 1)}%（${rate === null ? '—' : `<span class="${ok ? 'pos' : 'neg'}">${pts(rate - needRate)}</span>`}）`, ok ? 'pos' : 'neg'),
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
    if ((few && sel.mode === 'period') || !(t.unitPrice > 0)) { // 実績が少ない/今期間のトン単価が出ないときは今期の実績
      const fyR = C.fiscalRange(C.fiscalYearOf(C.periodKeyOf(sel.from)));
      const tf = C.analyze(state.cache, state.settings, fyR.from, sel.lastTo, sel.sites).total;
      if (tf.weight > 0 && tf.unitPrice > 0) { rate = tf; rateNote = `・${t.unitPrice > 0 ? '今月度の実績が少ない' : 'この期間のトン単価が出ない'}ため、トン単価・変動費・人件費単価は今期の実績で計算`; }
      else if (!(t.unitPrice > 0)) return null;
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
    const carryInfo = ov ? null : carryFor(sel, p), carry = carryInfo ? carryInfo.carry : 0;
    if (carryInfo) carryInfo.solo = C.simulate(Object.assign({}, t, rates, { fixed: full.fixed }), state.settings, Wpace, Wpace > 0 ? H / 8 / Wpace : 0, rates.unitPrice);
    const base = Object.assign({}, t, rates, { fixed: full.fixed + carry });
    const r = C.simulate(base, state.settings, Wpace, Wpace > 0 ? H / 8 / Wpace : 0, rates.unitPrice);
    r.fixed -= carry; r.carry = carry; // 表示用の固定費は実際の額(上乗せ分は carry で別に持つ)
    if (ov) { r.goalTons = ov.goalTons; r.goalSales = ov.goalTons * r.unitPrice; }
    head = `目標利益率${gl}を達成するには<small>（${esc(sel.label)}・〜${md(sel.fullTo)}${carryInfo ? '・年間目標に向けて先月度までの過不足を反映' : ''}${ov ? '・年間目標に向けて先月度までの過不足を反映' + ovNote : rateNote}）</small>`;
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
    if (ov) { r.goalTons = ov.goalTons; r.goalSales = ov.goalTons * r.unitPrice; }
    const ok = ov ? t.weight >= ov.goalTons - 0.05 : a.gap <= 0.5;
    head = `目標利益率${gl}を達成するには、どうするべきだったか<small>（${esc(sel.label)}${ovNote}）</small>`;
    const rate = t.sales > 0 ? r.profit / t.sales : null;
    const rateTxt = ov ? `生産量 ${ton(t.weight)}t／目標 ${ton(ov.goalTons)}t` : `利益率 ${rate === null ? '—' : fmt(rate * 100, 1) + '%'}／目標 ${gl}`;
    lead = ok ? `<span class="pos">✓ 目標を達成しました</span><span class="gLeadSub">（${rateTxt}）</span>`
      : ov ? `<span class="neg">目標生産量に <b>${ton(ov.goalTons - t.weight)}t</b> 届きませんでした</span><span class="gLeadSub">（${rateTxt}）</span>`
        : `<span class="neg">目標利益率に <b>${rate === null ? '—' : fmt((p - rate) * 100, 1)}ポイント</b> 届きませんでした</span><span class="gLeadSub">（${rateTxt}）</span>`;
    // 実績の生産量で目標に届く工数の上限。工場を選んだときは目標の1t当たり人工数(表と同じ)を保つ工数
    const hMax = ov ? (ov.goalTons > 0 ? t.weight * r.hours / ov.goalTons : null) : (a.cutHours !== null ? r.hours - a.cutHours : null);
    rows = [
      row('生産量<small>（実績の工数なら）</small>', r.goalTons !== null ? ton(r.goalTons) : '到達不能', r.goalTons !== null ? 't' : '', r.goalTons !== null ? `実績 ${ton(t.weight)}t（${cmp(t.weight - r.goalTons, 't', 1, true)}）` : ''),
      row('工数<small>（実績の生産量なら）</small>', hMax !== null && hMax > 0 ? fmt(hMax, 0) : '—', 'h以内', hMax !== null ? `実績 ${fmt(r.hours, 0)}h（${cmp(r.hours - hMax, 'h', 0, false)}）` : ''),
      row('1t当たり人工数', hMax !== null && hMax > 0 ? npt(hMax / 8 / t.weight) : '—', '人工/t以下', `実績 ${npt(t.ninkuPerTon)}`),
      ov ? row('利益率', rate === null ? '—' : fmt(rate * 100, 1), rate === null ? '' : '%', '工場単独の値（目標は3工場合計で達成）')
        : row('利益率', rate === null ? '—' : fmt(rate * 100, 1), rate === null ? '' : '%', `目標 ${gl}（${rate === null ? '—' : `<span class="${ok ? 'pos' : 'neg'}">${pts(rate - p)}</span>`}）`, ok ? 'pos' : 'neg'),
    ].join('');
    chart = { r, x: t.weight, label: '実績' };
  }
  return { head, lead, rows, chart, fcOn, cur, p };
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
  const stdNote = `標準の目標: 直近12か月度の実績の単価・費用、|在職中人数×8h×標準出勤日数 ${fmt(plan.dStd, 1)}日/月`;
  const rateTxt = (x) => x === null ? '—' : fmt(x * 100, 1) + '%';
  let head, lead, rows, x, label;
  const A = fcOn ? C.analyze(sel.data, state.settings, sel.from, sel.fullTo, sel.sites).total : t; // 比べる実績(見込みONは月末見込み)
  const aRate = A.sales > 0 ? A.profit / A.sales : null;
  if (!cur || fcOn) {
    const word = fcOn ? '見込み' : '実績';
    const ok = A.weight >= T.W - 0.05;
    head = `${fcOn ? '月末見込みで' : ''}目標（${unitLbl}）に${fcOn ? '届くか' : '届いたか'}<small><span class="hl">（${esc(sel.label)}${fcOn ? `・出勤日${sel.fc.done}/${sel.fc.total}日の実績から見込み` : ''}）</span><span class="hl">${stdNote.replace('|', '')}</span></small>`;
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
    head = `目標（${unitLbl}）を達成するには<small><span class="hl">（${esc(sel.label)}・〜${md(sel.fullTo)}）</span><span class="hl">${stdNote.replace('|', '')}</span></small>`;
    lead = need <= 0 ? `<span class="pos">✓ 目標生産量に到達済み</span><span class="gLeadSub">（実績 ${ton(t.weight)}t／目標 ${ton(T.W)}t）</span>`
      : leftDays > 0 ? `残り <b>${leftDays}</b>出勤日で あと <b class="gKey">${ton(need)}t</b> を <b class="gKey">${fmt(perDayH * leftDays, 0)}h</b> で`
        : '<span class="neg">残りの出勤日がありません</span>';
    rows = [
      row('目標生産量', ton(T.W), 't', `実績 ${ton(t.weight)}t ＋ 残り ${ton(need)}t`),
      row('目標工数', fmt(T.H, 0), 'h', `実績 ${fmt(t.hours, 0)}h ＋|残り ${fmt(perDayH * leftDays, 0)}h（1日 ${fmt(perDayH, 0)}h × ${leftDays}日）`),
      row('1日あたり生産量', needDay !== null && need > 0 ? ton(needDay) : '—', 't/日', needDay !== null && need > 0 ? `これまで ${ton(perDayW)}t/日（${perDayW > 0 ? fmt(needDay / perDayW, 2) + '倍' : '—'}）` : ''),
      row('1日あたり工数', fmt(perDayH, 0), 'h/日', (T.people > 0 ? `全員出勤で１日８時間で計算（在職中 ${T.people}人）` : '従業員名簿が読めないため、これまでのペースで計算') + (doneDays > 0 ? `（これまで ${fmt(t.hours / doneDays, 0)}h/日）` : '')),
      row('目標の1t当たり人工数', npt(T.n), '人工/t', `以下|（実績 ${npt(t.ninkuPerTon)}${few ? `・${doneDays}日分` : ''}）`),
    ].join('');
    // 参考: 先月度までの不足分を取り返して年間目標に届くための、今月度の生産量(先月度までの過不足を按分)
    if (sel.mode === 'period') {
      const old = buildGoal(sel, null);
      const c = carryFor(sel, p);
      if (old && old.chart.r.goalTons !== null && c) rows += row('参考: 先月度までの過不足を含めた目標', ton(old.chart.r.goalTons), 't', `今期の先月度までの利益率 ${rateTxt(c.prevRate)}（目標${gl}）|を期末までに取り返す場合`);
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
