/* 実行予算まとめ - 画面 */
'use strict';

// GAS WebアプリのURL(gas/Code.gs をデプロイしたURL)
const GAS_API_URL = 'https://script.google.com/macros/s/AKfycbyun0FKHcFSvu5j8RRYpevoZfMC3F2WUkd3vC7_PopGvuv3i2ecwfRy3aiPOaXb9K1G3A/exec';
// ?demo=1 でダミーデータ表示(動作確認用。実データは使わない)
const DEMO = new URLSearchParams(location.search).get('demo') === '1';

const EXCELJS_URL = 'https://cdnjs.cloudflare.com/ajax/libs/exceljs/4.4.0/exceljs.min.js';

let payload = null;   // GASの保存データ {baseline, today}
let settings = {};    // 完了・年度 { 工事No: {done, year} }(「情報」シート)
let view = null;
let filter = { done: false, years: [] }; // 抽出画面の絞り込み(どちらも空 = 全て表示)
let edits = {};       // 設定画面の未保存の変更 { 工事No: {done?, year?} }

function loadScript(src) {
  return new Promise((resolve, reject) => {
    const s = document.createElement('script');
    s.src = src;
    s.onload = resolve;
    s.onerror = () => reject(new Error(src + ' を読み込めませんでした'));
    document.head.appendChild(s);
  });
}

function showLoading(text) {
  document.getElementById('loading-text').textContent = text;
  document.getElementById('loading').hidden = false;
}
function hideLoading() { document.getElementById('loading').hidden = true; }

function showMsg(text, ok) {
  const m = document.getElementById('msg');
  m.textContent = text;
  m.className = 'msg' + (ok ? ' ok' : '');
  m.hidden = !text;
}

async function load() {
  let settingRows;
  if (DEMO) {
    await loadScript('demo.js?v=20260930i');
    payload = window.JY_DEMO;
    settingRows = window.JY_DEMO_SETTINGS;
  } else {
    const res = await fetch(GAS_API_URL + '?t=' + Date.now());
    const body = await res.json();
    if (body.status !== 'success') throw new Error(body.message || 'エラー');
    payload = body.data;
    if (body.settings && body.settings.error) showMsg('完了・年度を読み込めませんでした: ' + body.settings.error);
    settingRows = body.settings && body.settings.rows;
  }
  settings = JY.buildSettings(settingRows);
  rebuild();
}

// 完了・年度が変わったら行を作り直す(抽出画面にもすぐ反映)
function rebuild() {
  view = JY.buildView(payload, settings);
}

function esc(s) {
  return String(s === null || s === undefined ? '' : s).replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
}

// 横スクロールしても固定する列(状態〜参照シート。Excelの固定範囲 A〜H列と同じ)。状態〜工事名はrender内で指定
const STICKY = { weight: 'c-w', amount: 'c-a', sheet: 'c-s' };

function setMeta(count) {
  const meta = document.getElementById('meta');
  if (!view || !view.rows.length) {
    meta.textContent = 'まだデータがありません(会社PCで「実行予算更新.bat」を実行すると表示されます)';
    return;
  }
  meta.innerHTML = (DEMO ? '<b class="demo">デモ表示</b> ' : '') +
    '最終更新: ' + esc(JY.fmt('date', view.todayAt)) +
    ' / 比較の基準: ' + esc(view.baselineAt ? JY.fmt('date', view.baselineAt) : 'なし(初回)') +
    ' / ' + (count === undefined || count === view.rows.length ? view.rows.length + '件' : count + '件(全' + view.rows.length + '件)');
}

/* ===================== 実行予算抽出 ===================== */

function renderFilters() {
  const years = JY.yearsInRows(view.rows);
  filter.years = filter.years.filter(y => years.indexOf(y) >= 0);
  const all = !JY.isFiltered(filter);
  let h = '<button class="chip' + (all ? ' on' : '') + '" data-f="all">全て表示</button>' +
    '<button class="chip' + (filter.done ? ' on' : '') + '" data-f="done">完了のみ表示</button>' +
    '<span class="sep">年度:</span>';
  years.forEach(y => {
    h += '<button class="chip' + (filter.years.indexOf(y) >= 0 ? ' on' : '') + '" data-f="year" data-y="' + esc(y) + '">' + esc(y) + '</button>';
  });
  document.getElementById('filters').innerHTML = h;
}

document.getElementById('filters').addEventListener('click', e => {
  const b = e.target.closest('button[data-f]');
  if (!b) return;
  if (b.dataset.f === 'all') filter = { done: false, years: [] };
  else if (b.dataset.f === 'done') filter.done = !filter.done;
  else {
    const i = filter.years.indexOf(b.dataset.y);
    if (i >= 0) filter.years.splice(i, 1); else filter.years.push(b.dataset.y);
  }
  renderExtract();
});

function statusHtml(status) {
  return esc(status).replace('（', '<br>（').replace('未完成', '<span class="inc">未完成</span>');
}

function cellHtml(c, tag) {
  const cls = [c.kind === 'str' || c.kind === 'date' ? 'txt' : 'num'];
  if (c.id.endsWith(':b')) cls.push('grp-l');
  if (STICKY[c.id]) cls.push(STICKY[c.id]);
  if (c.id === 'author') cls.push('ctr');
  if (c.changed) cls.push('chg');
  if (c.zero) cls.push('zero');
  if (c.over) cls.push('over');
  return '<' + tag + ' class="' + cls.join(' ') + '">' + esc(c.text) +
    (c.changed ? '<div class="prev">前回：' + esc(c.prev) + '</div>' : '') + '</' + tag + '>';
}

function renderExtract() {
  renderFilters();
  const rows = JY.filterRows(view.rows, filter);
  setMeta(rows.length);
  if (!view.rows.length) {
    document.getElementById('tbl').innerHTML = '';
    return;
  }

  let h = '<thead><tr><th rowspan="2" class="c-st">状態</th><th rowspan="2" class="c-y">年度</th><th rowspan="2" class="c-d">完了</th>' +
    '<th rowspan="2" class="c-no">工事No</th><th rowspan="2" class="c-name">工事名</th>' +
    '<th rowspan="2" class="c-w">契約総重量(t)</th><th rowspan="2" class="c-a">契約金額(円)</th><th rowspan="2" class="c-s">参照シート</th>';
  JY.PROFITS.forEach(p => { h += '<th colspan="2" class="grp">' + esc(p.label) + '</th>'; });
  JY.CATS.forEach(c => { h += '<th colspan="3" class="grp">' + esc(c) + '</th>'; });
  h += '<th rowspan="2">前回の保存者</th><th rowspan="2">保存日時</th></tr><tr>';
  JY.PROFITS.forEach(() => { h += '<th class="grp-l">予算</th><th>実際</th>'; });
  JY.CATS.forEach(() => { h += '<th class="grp-l">予算</th><th>実際</th><th>割合</th>'; });
  h += '</tr>';
  // 合計行: 絞り込んだときだけ(見出しの下に固定)
  if (JY.isFiltered(filter)) {
    const tot = JY.computeTotals(rows);
    h += '<tr class="total"><th class="c-st">合計（' + tot.count + '件）</th><th class="c-y"></th><th class="c-d"></th><th class="c-no"></th><th class="c-name"></th>';
    tot.cells.forEach(c => { h += cellHtml(c, 'th'); });
    h += '</tr>';
  }
  h += '</thead><tbody>';

  rows.forEach(r => {
    h += '<tr class="' + r.rowClass + '"><td class="txt st c-st' + (r.status.startsWith('変更あり') ? ' chg' : '') + '"' + (r.warn ? ' title="' + esc(r.warn) + '"' : '') + '>' + statusHtml(r.status) + '</td>' +
      '<td class="c-y">' + esc(r.year || JY.UNSET) + '</td><td class="c-d">' + (r.done ? '完了' : '未完') + '</td>' +
      '<td class="c-no">' + esc(r.no) + '</td><td class="c-name">' + esc(r.name) + '</td>';
    r.cells.forEach(c => { h += cellHtml(c, 'td'); });
    h += '</tr>';
  });
  if (!rows.length) h += '<tr><td class="txt" colspan="8">条件に合う工事がありません</td></tr>';
  const tbl = document.getElementById('tbl');
  tbl.innerHTML = h + '</tbody>';
  // 見出しの2行目・合計行の固定位置(上の行の高さの合計)
  let top = 0;
  tbl.querySelectorAll('thead tr').forEach((tr, i) => {
    if (i) tr.querySelectorAll('th').forEach(th => { th.style.top = top + 'px'; });
    top += i ? tr.offsetHeight : tr.querySelector('th:not([rowspan])').offsetHeight;
  });
  document.getElementById('btn-xlsx').disabled = !rows.length;
}

async function downloadXlsx() {
  if (!window.ExcelJS) await loadScript(EXCELJS_URL);
  const wb = JY.buildWorkbook(ExcelJS, view, { filter: filter });
  const buf = await wb.xlsx.writeBuffer();
  const d = new Date(Date.now() + 9 * 3600000);
  const cond = JY.isFiltered(filter) ? JY.filterLabel(filter).replace(/[\\/:*?"<>|]/g, '・') + '_' : '';
  const name = '実行予算まとめ_' + cond + d.getUTCFullYear() + String(d.getUTCMonth() + 1).padStart(2, '0') +
    String(d.getUTCDate()).padStart(2, '0') + '.xlsx';
  const a = document.createElement('a');
  a.href = URL.createObjectURL(new Blob([buf], { type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' }));
  a.download = name;
  document.body.appendChild(a);
  a.click();
  setTimeout(() => { URL.revokeObjectURL(a.href); a.remove(); }, 1000);
}

// セルをクリックすると、その行を強調(二重罫線+薄い緑)。同じ行をもう一度クリックで解除
document.getElementById('tbl').addEventListener('click', e => {
  const tr = e.target.closest('tbody tr');
  if (!tr) return;
  const cur = document.querySelector('#tbl tr.sel');
  if (cur) cur.classList.remove('sel');
  if (cur !== tr) tr.classList.add('sel');
});

document.getElementById('btn-xlsx').addEventListener('click', () => {
  const btn = document.getElementById('btn-xlsx');
  btn.disabled = true;
  showLoading('Excel作成中');
  downloadXlsx()
    .catch(err => alert('Excelの作成に失敗しました: ' + err.message))
    .finally(() => { btn.disabled = false; hideLoading(); });
});

/* ===================== 完了設定｜年度設定 ===================== */

function isDirty() { return Object.keys(edits).length > 0; }

function current(r) {
  const e = edits[r.no] || {};
  return { done: 'done' in e ? e.done : r.done, year: 'year' in e ? e.year : r.year };
}

let setList = []; // 設定画面の行(renderSettings で作り、setEdit で使い回す)

function renderSettings() {
  setMeta();
  const list = setList = JY.settingRows(view ? view.rows : []);
  const opts = JY.yearOptions(settings);
  let h = '<thead><tr><th>工事No</th><th>工事名</th><th>完了</th><th>年度</th><th>契約重量(t)</th><th>契約金額(円)</th>' +
    '<th>粗利益(実際)</th><th>営業損益(実際)</th></tr></thead><tbody>';
  list.forEach(r => {
    const cur = current(r), e = edits[r.no] || {};
    const dis = r.unlisted ? ' disabled' : '';
    const yOpts = opts.indexOf(cur.year) < 0 && cur.year ? opts.concat([cur.year]) : opts;
    h += '<tr' + (r.unlisted ? ' class="unlisted"' : '') + ' data-no="' + esc(r.no) + '"><td class="ctr">' + esc(r.no) + '</td><td class="txt">' + esc(r.name) +
      (r.unlisted ? '<div class="unlisted-note">情報シートに無いため設定不可</div>' : '') + '</td>' +
      '<td class="ctr' + ('done' in e ? ' edited' : '') + '"><span class="seg">' +
      '<button data-done="1" class="' + (cur.done ? 'on' : '') + '"' + dis + '>完了</button>' +
      '<button data-done="0" class="' + (cur.done ? '' : 'on') + '"' + dis + '>未完</button></span></td>' +
      '<td class="ctr' + ('year' in e ? ' edited' : '') + '"><select' + yearCls(cur.year) + dis + '>' +
      yOpts.map(y => '<option value="' + esc(y) + '"' + (y === cur.year ? ' selected' : '') + '>' + esc(y) + '</option>').join('') +
      '<option value=""' + (cur.year ? '' : ' selected') + '>' + JY.UNSET + '</option></select></td>';
    r.cells.forEach(c => { h += '<td class="num">' + esc(c.text) + '</td>'; });
    h += '</tr>';
  });
  if (!list.length) h += '<tr><td class="txt" colspan="8">工事がありません</td></tr>';
  document.getElementById('tbl-set').innerHTML = h + '</tbody>';
  document.getElementById('btn-save').hidden = !isDirty();
}

// 年度リストの色(R8=青・R9=緑・R10=ピンク・R7=黄…の4色周期。未設定は色なし)
function yearCls(y) {
  const m = /^R(\d+)$/.exec(y || '');
  return m ? ' class="y' + (Number(m[1]) % 4) + '"' : '';
}

// 変更を記録(元の値に戻したら変更なし)
function setEdit(no, field, value) {
  const r = setList.find(x => x.no === no);
  if (!r) return;
  const e = edits[no] || {};
  if (r[field] === value) delete e[field]; else e[field] = value;
  if (Object.keys(e).length) edits[no] = e; else delete edits[no];
  renderSettings();
}

document.getElementById('tbl-set').addEventListener('click', e => {
  const b = e.target.closest('button[data-done]');
  if (!b || b.disabled) return;
  setEdit(b.closest('tr').dataset.no, 'done', b.dataset.done === '1');
});
document.getElementById('tbl-set').addEventListener('change', e => {
  if (e.target.tagName !== 'SELECT') return;
  setEdit(e.target.closest('tr').dataset.no, 'year', e.target.value);
});

async function saveSettings() {
  const changes = Object.keys(edits).map(no => Object.assign({ no: no }, edits[no]));
  let res;
  if (DEMO) {
    // デモ: 送信せず画面内だけで反映
    const rows = Object.keys(settings).map(no => [no, settings[no].done ? '完了' : '', settings[no].year]);
    changes.forEach(c => {
      const row = rows.find(v => v[0] === c.no);
      if (!row) return;
      if ('done' in c) row[1] = c.done ? '完了' : '';
      if ('year' in c) row[2] = c.year;
    });
    res = { updated: changes.map(c => c.no), notFound: [], dup: [], rows: rows };
  } else {
    // text/plain で送る(GASはCORSの事前確認に対応しないため)
    const r = await fetch(GAS_API_URL, { method: 'POST', body: JSON.stringify({ action: 'settings', changes: changes }) });
    const body = await r.json();
    if (body.status !== 'success') throw new Error(body.message || 'エラー');
    res = body.data;
  }
  settings = JY.buildSettings(res.rows);
  edits = {};
  rebuild();
  renderSettings();
  let msg = '保存しました(' + res.updated.length + '件)';
  if (res.notFound.length) msg += '。情報シートに無い工事No: ' + res.notFound.join(', ');
  if (res.dup.length) msg += '。情報シートに同じ工事Noの行が複数あるため上の行に保存: ' + res.dup.join(', ');
  showMsg(msg, !res.notFound.length && !res.dup.length);
}

document.getElementById('btn-save').addEventListener('click', () => {
  const btn = document.getElementById('btn-save');
  btn.disabled = true;
  showLoading('保存中');
  saveSettings()
    .catch(err => showMsg('保存に失敗しました: ' + err.message))
    .finally(() => { btn.disabled = false; hideLoading(); });
});

/* ===================== 画面の切り替え(#extract / #settings / ホーム) ===================== */

const LEAVE_MSG = '保存されていない変更があります。\nこのまま移動すると、変更内容は保存されません。移動しますか？';
let screen = 'home';

function route() {
  const next = location.hash === '#extract' ? 'extract' : location.hash === '#settings' ? 'settings' : 'home';
  if (screen === 'settings' && next !== 'settings' && isDirty()) {
    if (!confirm(LEAVE_MSG)) { history.pushState(null, '', '#settings'); return; }
    edits = {};
  }
  if (screen !== next) showMsg('');
  screen = next;
  ['home', 'extract', 'settings'].forEach(s => { document.getElementById('scr-' + s).hidden = s !== next; });
  document.getElementById('btn-xlsx').hidden = next !== 'extract';
  document.getElementById('btn-home').hidden = next === 'home';
  document.getElementById('btn-save').hidden = true;
  if (!view) return;
  if (next === 'extract') renderExtract();
  else if (next === 'settings') renderSettings();
  else setMeta();
}

window.addEventListener('hashchange', route);
document.querySelectorAll('.home-btn').forEach(b => b.addEventListener('click', () => { location.hash = b.dataset.go; }));
document.getElementById('btn-home').addEventListener('click', () => {
  if (screen === 'settings' && isDirty() && !confirm(LEAVE_MSG)) return;
  edits = {};
  history.pushState(null, '', location.pathname + location.search);
  route();
});
// タブを閉じる・再読み込み
window.addEventListener('beforeunload', e => {
  if (screen === 'settings' && isDirty()) { e.preventDefault(); e.returnValue = ''; }
});

route();
load().then(route).catch(err => {
  document.getElementById('meta').textContent = '';
  showMsg('読み込みに失敗しました: ' + err.message);
}).finally(hideLoading);
