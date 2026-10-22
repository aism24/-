/*
 * コストインサイト 画面
 *   GAS(getData)から 生産重量・工数(cache)・工事マスタ等(settings)・実行予算(budget)を受け取り、
 *   calc.js(CICalc)でモデルを作る。画面の切り替え・読み込み・実行予算の取込・設定の保存を受け持つ。
 *   各分析画面は simple.js(シンプル版)・detail.js(詳細版)・workone.js(工事別)・extract.js(実行予算の表)。
 */
'use strict';

// GAS(スプレッドシート「コストインサイト」のウェブアプリ)
const GAS_API_URL = 'https://script.google.com/macros/s/AKfycbwDhzAWpmCmwrLoFM6gS1GDWYWcc7OvqjdGa7HNObCTednh-FttOPdF3JZlOQVe-Y3Q0A/exec';
const state = { data: null, model: null, edits: {}, basicEdits: {}, view: 'menu' };

const fmt = (v, d) => (v === null || v === undefined || !isFinite(v)) ? '—' : Number(v).toLocaleString('ja-JP', { minimumFractionDigits: d || 0, maximumFractionDigits: d || 0 });
const pct = v => (v === null || v === undefined || !isFinite(v)) ? '—' : (v * 100).toFixed(1) + '%';
const esc = s => String(s === null || s === undefined ? '' : s).replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
const pad2 = n => (n < 10 ? '0' : '') + n;

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
    stop() { clearInterval(timer); },
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
  document.getElementById('budget').textContent = b ? '前回取込: ' + new Date(b.at).toLocaleString('ja-JP') + '(' + Object.keys(b.rows || {}).length + 'ファイル)' : '前回取込: まだ取り込んでいません';
}

async function load() {
  const bar = startLoadingBar();
  try {
    applyData(await gasGet('getData'));
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
  showImportStatus('', '取込を待っています…(黒い画面が閉じると、完了を自動で確認します。完了したら③実行予算最新確認を押してください)');
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
      // 完了後はホームへ戻らず、この画面で待機(③実行予算最新確認でテーブルを表示する)
      showImportStatus('ok', '取込が完了しました。③実行予算最新確認を押すと、結果のテーブルを表示します。');
    } else {
      showImportStatus('', '取込を待っています…(経過 ' + Math.floor(sec / 60) + '分' + (sec % 60) + '秒。黒い画面が閉じると、完了を自動で確認します。完了したら③実行予算最新確認を押してください)');
    }
  } catch (e) {
    showImportStatus('ng', '確認に失敗しました。再確認します…(' + e.message + ')');
  } finally {
    WATCH.busy = false;
  }
}

// ③実行予算最新確認: 最新のデータを取り直して、実行予算抽出のテーブルを表示する
async function showLatestBudget() {
  const btn = document.getElementById('latestBtn');
  btn.disabled = true;
  showImportStatus('', '最新の実行予算を読み込んでいます…');
  try {
    applyData(await gasGet('getData'));
    renderSettings();
    document.getElementById('imp-status').hidden = true;
    showView('extract');
  } catch (e) {
    showImportStatus('ng', '読み込みに失敗しました: ' + e.message + '(もう一度押してください)');
  } finally {
    btn.disabled = false;
  }
}

// 「重量・工数更新」: GASで生産・日報を今すぐ集計し直して(action=refresh。ふだんは毎朝6時台に自動)、画面に反映する。
// 更新中は読み込みのポップアップ(進み具合のバー)を出す。選んでいる期間・工場はそのまま。集計に30秒〜1分ほどかかる
let refreshingProduction = false;
async function refreshProduction() {
  if (refreshingProduction) return;
  refreshingProduction = true;
  const box = document.getElementById('loading'), title = document.getElementById('ld-title'), err = document.getElementById('ld-err'), note = document.getElementById('ld-note');
  document.querySelectorAll('.refreshBtn').forEach(b => { b.disabled = true; });
  title.textContent = '重量・工数を更新中…';
  note.textContent = '生産重量・工数を集計し直しています(30秒〜1分ほどかかります)';
  err.hidden = true;
  box.classList.remove('done');
  const bar = startLoadingBar();
  let ok = false;
  try {
    applyData(await gasGet('refresh'));
    renderSettings();
    if (window.SimpleView) SimpleView.reload();
    if (window.DetailView) DetailView.reload();
    const last = window.CIKit && CIKit.lastDataYmd();
    bar.done();
    title.textContent = '更新しました' + (last ? '(〜' + Number(last.slice(5, 7)) + '/' + Number(last.slice(8)) + 'の実績)' : '');
    const tm = state.data.cache.timing; // GASが記録した所要時間(古いGASには無い)
    if (tm) note.textContent = '所要時間: 取得 ' + (tm.fetchMs / 1000).toFixed(1) + '秒 / 履歴 ' + (tm.historyMs / 1000).toFixed(1) + '秒 / 集計 ' + (tm.aggregateMs / 1000).toFixed(1) + '秒';
    ok = true;
  } catch (e) {
    bar.stop();
    title.textContent = '更新に失敗しました';
    err.hidden = false;
    err.innerHTML = esc(e.message) + '<br><button class="btn" type="button" onclick="closeLoading()">閉じる</button>';
  } finally {
    refreshingProduction = false;
    document.querySelectorAll('.refreshBtn').forEach(b => { b.disabled = false; });
    if (ok) setTimeout(closeLoading, 2500);
  }
}
function closeLoading() {
  document.getElementById('loading').classList.add('done');
  document.getElementById('ld-note').textContent = '初回は30秒ほどかかることがあります';
}

/* ===================== 画面の切り替え(メニュー / 各モード) ===================== */

// 固定する上部(アプリ名+操作バー)の高さを CSS 変数に入れる(グラフ・カードの高さと固定位置の計算用)
function syncStickyOffsets() {
  const hdr = document.querySelector('header'), bar = document.querySelector('.view:not([hidden]) .sBar');
  const h = hdr.offsetHeight, b = bar ? bar.offsetHeight : 0;
  document.documentElement.style.setProperty('--hdrH', h + 'px');
  document.documentElement.style.setProperty('--stickyH', (h + b) + 'px');
}
window.addEventListener('resize', syncStickyOffsets);
function showView(name) {
  state.view = name;
  document.body.dataset.view = name; // ホームへ戻るボタンをホーム画面では隠す(CSS)
  document.querySelectorAll('.view').forEach(v => { v.hidden = v.id !== 'v-' + name; });
  window.scrollTo(0, 0);
  document.querySelector('main').classList.toggle('wide', name === 'simple' || name === 'detail' || name === 'extract' || name === 'workone'); // シンプル版・実行予算抽出は画面いっぱいに使う
  syncStickyOffsets();
  if (name === 'extract' && window.ExtractView) ExtractView.show();
  if (name === 'workone' && window.WorkView) WorkView.show();
  if (name === 'simple' && window.SimpleView) SimpleView.show();
  if (name === 'detail' && window.DetailView) DetailView.show();
}
document.querySelectorAll('[data-go]').forEach(b => b.addEventListener('click', () => showView(b.dataset.go)));
// ホームの①②: 工場別は 詳細版/シンプル版 を先に選ぶ。工事別は 工事を選んでその工事だけの結果を表示
document.querySelectorAll('[data-analysis]').forEach(b => b.addEventListener('click', () => {
  showView(b.dataset.analysis === 'site' ? 'sitemode' : 'workone');
}));

// 工場別進捗分析 → 詳細版(従来の表とグラフ) / シンプル版(simple.js)
document.querySelectorAll('[data-sitemode]').forEach(b => b.addEventListener('click', () => {
  showView(b.dataset.sitemode === 'simple' ? 'simple' : 'detail'); // 詳細版=目標シミュレーター
}));

/* ===================== 設定(目標利益率（対売比率）・月額概算固定費=基本設定シート / 完了・年度=工事データ D・E 列) ===================== */

// 基本設定シートの値(画面の入力欄の元の値)。月額概算固定費が空のときは simple.js の既定値(2,500万円)
const basicOrig = () => {
  const s = state.data.settings, f = Number(s.otherFixedMonthly);
  return { targetProfitRate: CIKit.goalRate(), otherFixedMonthly: s.otherFixedMonthly === null || s.otherFixedMonthly === undefined || !isFinite(f) ? CIKit.otherFixed() : f };
};

function renderBasic() {
  const o = basicOrig(), e = state.basicEdits;
  const val = k => (k in e ? e[k] : o[k]);
  document.getElementById('set-basic').innerHTML = '<table><tr><th>項目</th><th>値</th></tr>'
    + `<tr data-b="targetProfitRate"${'targetProfitRate' in e ? ' class="changed"' : ''}><td>目標利益率（対売比率）</td><td><input type="text" inputmode="decimal" data-bk="targetProfitRate" value="${esc(val('targetProfitRate'))}"></td></tr>`
    + `<tr data-b="otherFixedMonthly"${'otherFixedMonthly' in e ? ' class="changed"' : ''}><td>月額概算固定費（鉄構部）</td><td><input type="text" inputmode="numeric" data-bk="otherFixedMonthly" value="${esc(fmt(val('otherFixedMonthly'), 0))}"></td></tr></table>`;
  document.querySelectorAll('#set-basic input').forEach(el => el.addEventListener('change', onBasicChange));
}

function onBasicChange(ev) {
  const k = ev.target.dataset.bk, o = basicOrig();
  const v = Number(String(ev.target.value).replace(/[,¥￥円%％\s]/g, ''));
  if (ev.target.value.trim() === '' || !isFinite(v) || v < 0) { document.getElementById('set-msg').textContent = '0以上の数値で入力してください'; ev.target.value = k in state.basicEdits ? state.basicEdits[k] : o[k]; return; }
  document.getElementById('set-msg').textContent = '';
  if (v === o[k]) delete state.basicEdits[k]; else state.basicEdits[k] = v;
  renderBasic();
  updateSaveButton();
}

// 今の会社の年度(11/21始まり・11/20決算。決算の年の令和で呼ぶ 例: 2025/11/21〜2026/11/20 = R8)。端末の時間帯に関わらず日本時間で決める
function currentFiscalReiwa() {
  const d = new Date(Date.now() + 9 * 3600000), y = d.getUTCFullYear(), m = d.getUTCMonth() + 1, day = d.getUTCDate();
  return (m > 11 || (m === 11 && day >= 21) ? y + 1 : y) - 2018;
}

function yearOptions() {
  const set = {};
  for (let i = 6; i <= currentFiscalReiwa() + 1; i++) set['R' + i] = true; // R6〜来年度
  Object.values(state.data.settings.works).forEach(w => { if (w.year) set[w.year] = true; });
  return [''].concat(Object.keys(set).sort((a, b) => Number(a.slice(1)) - Number(b.slice(1))));
}

// 実行予算が取り込まれている(契約総重量か契約金額が入っている)工事だけを設定の対象にする
const hasContract = w => (w.totalWeight !== null && w.totalWeight !== undefined) || (w.contract !== null && w.contract !== undefined);

// 年度の色のクラス(R8=y0 青・R9=y1 緑・R10=y2 ピンク・R7=y3 黄。未設定は色なし)
const yearClass = y => { const m = /^R(\d+)$/.exec(y || ''); return m ? 'y' + (Number(m[1]) % 4) : ''; };

// 工事ごとの生産重量の累計(生産管理の最新の集計)
const prodWeight = no => { const i = (state.data.cache.works || {})[no]; return i && isFinite(i.totalWeight) ? Number(i.totalWeight) : null; };

function renderSettings() {
  // 過去の生産重量(マスターファイルの全期間)をまだ取り込んでいない間だけ注意書きを出す
  document.getElementById('warn-hist').hidden = ((state.data.cache || {}).historyImported || []).length > 0;
  const works = state.data.settings.works, years = yearOptions();
  const nos = Object.keys(works).sort().filter(no => hasContract(works[no]));
  document.getElementById('set-table').innerHTML = '<tr><th>工事No</th><th>工事名</th><th>完了</th><th>年度</th><th class="n">契約重量(t)</th><th class="n">生産重量(t)</th></tr>'
    + nos.map(no => {
      const w = works[no], e = state.edits[no] || {};
      const done = 'done' in e ? e.done : w.done, year = 'year' in e ? e.year : (w.year || '');
      const changed = Object.keys(e).length ? ' class="changed"' : '';
      return `<tr${changed} data-no="${esc(no)}"><td>${esc(no)}</td><td>${esc(w.name)}</td>`
        + `<td class="c"><input type="checkbox" data-k="done"${done ? ' checked' : ''}></td>`
        + `<td class="c"><select data-k="year" class="${yearClass(year)}">${years.map(y => `<option value="${y}"${y === year ? ' selected' : ''}>${y || '(未設定)'}</option>`).join('')}</select></td>`
        // 契約重量は実行予算(工事データ B列)、生産重量は生産管理の最新の累計(2025/8/21以降のデータ)
        + `<td class="n">${fmt(w.totalWeight, 1)}</td><td class="n">${fmt(prodWeight(no), 1)}</td></tr>`;
    }).join('')
    + (nos.length ? '' : '<tr><td colspan="6">該当する工事がありません</td></tr>');
  document.querySelectorAll('#set-table input, #set-table select').forEach(el => el.addEventListener('change', onSettingChange));
  renderBasic();
  updateSaveButton();
}

function onSettingChange(ev) {
  const tr = ev.target.closest('tr'), no = tr.dataset.no, k = ev.target.dataset.k;
  const w = state.data.settings.works[no];
  const v = k === 'done' ? ev.target.checked : ev.target.value;
  if (k === 'year') ev.target.className = yearClass(v);
  const orig = k === 'done' ? w.done : (w.year || '');
  const e = state.edits[no] || (state.edits[no] = {});
  if (v === orig) delete e[k]; else e[k] = v;
  if (!Object.keys(e).length) delete state.edits[no];
  tr.classList.toggle('changed', !!state.edits[no]);
  updateSaveButton();
}

function updateSaveButton() {
  const n = Object.keys(state.edits).length + Object.keys(state.basicEdits).length;
  const btn = document.getElementById('set-save');
  btn.disabled = !n;
  btn.textContent = n ? `更新を保存(${n}件)` : '更新を保存';
}

async function saveSettings() {
  const msg = document.getElementById('set-msg'), btn = document.getElementById('set-save');
  const changes = Object.keys(state.edits).map(no => Object.assign({ no }, state.edits[no]));
  const basic = Object.assign({}, state.basicEdits);
  if (!changes.length && !Object.keys(basic).length) return;
  btn.disabled = true;
  msg.textContent = '保存中…';
  try {
    // text/plain で送り、CORSのプリフライトを発生させない
    const res = await fetch(GAS_API_URL, { method: 'POST', headers: { 'Content-Type': 'text/plain;charset=utf-8' }, body: JSON.stringify({ action: 'settings', changes, basic: Object.keys(basic).length ? basic : undefined }) });
    const body = await res.json();
    if (body.status !== 'success') throw new Error(body.message || 'GASのエラー');
    // 保存した内容を画面のデータにも反映して計算し直す
    changes.forEach(c => {
      const w = state.data.settings.works[c.no];
      if ('done' in c) w.done = c.done;
      if ('year' in c) w.year = c.year;
    });
    Object.assign(state.data.settings, basic);
    state.edits = {};
    state.basicEdits = {};
    state.model = CICalc.build(state.data);
    renderSettings();
    const dup = (body.data && body.data.dup) || [];
    msg.textContent = `保存しました(${changes.length + Object.keys(basic).length}件)` + (dup.length ? `。工事データに同じ工事Noの行が複数あります(上の行に保存): ${dup.join('、')}` : '');
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
