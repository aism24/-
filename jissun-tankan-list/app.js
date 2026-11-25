// 大組図から短管リスト作成 — 画面の動き。図面の読み取りは py/tankan_core.py(Pyodide)、Excel は excel.js。
// 工場・工事の選択、サーバーの「①進行中工事」、TDF の選び方は tdf-kanamono-list と同じ。
'use strict';

// GAS のウェブアプリ URL(スプレッドシート「短管リスト」の gas/Code.gs をデプロイしたもの)
const GAS_URL = 'https://script.google.com/macros/s/AKfycbziB1nE6QDN_ADEwtrSo6o3WE06uqIgvRLdpQ1JJqhY35Vj_Btk7TIJ_xvpkw1zfHYHTQ/exec';
const PYODIDE_URL = 'https://cdn.jsdelivr.net/pyodide/v0.26.4/full/pyodide.js';   // tdf-master-web と同じ版
const PY_FILES = ['tdf_binary.py', 'plate.py', 'tankan_core.py'], PY_VER = '20261125f';
const LS_KEY = 'jissun-tankan-list:last';
const LS_SETTINGS = 'jissun-tankan-list:settings';

const state = {
  factory: '', kojiNo: '', kojiName: '',
  kojiList: [], servers: [],
  server: null, root: null,     // ① で決めたサーバーと、その「①進行中工事」
  started: false,
  files: [],                    // {file, path}  path = TDF のあるフォルダ(サーバーのパス。リンク用。分からなければ '')
  res: null,                    // tankan_core.run の結果
  orders: null,                 // 注文書キャッシュ {name, updated, csv}
};

// ---------- 共通 ----------
const $ = id => document.getElementById(id);
function esc(s) { return String(s === null || s === undefined ? '' : s).replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c])); }
function toast(msg, type) {
  const t = $('toast'); t.textContent = msg; t.className = 'show' + (type === 'error' ? ' error' : '');
  clearTimeout(toast._t); toast._t = setTimeout(() => { t.className = ''; }, 4000);
}
function busy(msg, ratio) {
  $('status-text').textContent = msg || '処理中…';
  const has = typeof ratio === 'number';
  $('status-progress').hidden = !has;
  if (has) { const pc = Math.max(0, Math.min(100, Math.round(ratio * 100))); $('status-bar').style.width = pc + '%'; $('status-pct').textContent = pc + '%'; }
  $('status-overlay').classList.add('open');
}
function idle() { $('status-overlay').classList.remove('open'); }
function notice(title, body, lines) {
  return new Promise(resolve => {
    $('notice-title').textContent = title; $('notice-body').textContent = body;
    $('notice-modal').querySelector('.dialog').classList.toggle('lines', !!lines);
    $('notice-modal').classList.add('open');
    $('notice-ok').onclick = () => { $('notice-modal').classList.remove('open'); resolve(); };
  });
}
function confirm2(title, body, okLabel, cancelLabel) {
  return new Promise(resolve => {
    $('notice-title').textContent = title; $('notice-body').textContent = body;
    $('notice-ok').textContent = okLabel; $('notice-cancel').textContent = cancelLabel; $('notice-cancel').style.display = '';
    $('notice-modal').classList.add('open');
    const done = v => { $('notice-modal').classList.remove('open'); $('notice-ok').textContent = 'OK'; $('notice-cancel').style.display = 'none'; resolve(v); };
    $('notice-ok').onclick = () => done(true); $('notice-cancel').onclick = () => done(false);
  });
}
async function apiGet(params) {
  const q = Object.entries(params).map(([k, v]) => k + '=' + encodeURIComponent(v)).join('&');
  const r = await fetch(GAS_URL + '?' + q);
  const j = await r.json(); if (j.status !== 'success') throw new Error(j.message || 'GASエラー'); return j;
}
// 記録は画面に何も出さない(成功・失敗とも)。docs/know-how/usage-log-hidden-check.md
function apiPostQuiet(payload) {
  try { fetch(GAS_URL, { method: 'POST', headers: { 'Content-Type': 'text/plain;charset=utf-8' }, body: JSON.stringify(payload) }).catch(() => {}); } catch (e) { /* 失敗は無視 */ }
}

// ---------- 起動画面(工場・工事) ----------
function updateStartBtn() { $('start-btn').disabled = !(state.factory && $('koji-select').value); }
document.querySelectorAll('.factory-btn').forEach(b => b.addEventListener('click', () => {
  state.factory = b.dataset.factory;
  document.querySelectorAll('.factory-btn').forEach(x => x.classList.toggle('selected', x === b));
  $('factory-btns').classList.add('has-selection');
  updateStartBtn();
}));
$('koji-select').addEventListener('change', updateStartBtn);

function applySettings(j, first) {
  const sel = $('koji-select'), cur = sel.value;
  state.kojiList = j.koji || []; state.servers = j.servers || [];
  sel.innerHTML = '<option value="" disabled selected>選択してください</option>' +
    state.kojiList.map(k => `<option value="${esc(k.no)}">${esc(k.no)}　${esc(k.name)}</option>`).join('');
  if (first) {
    let last = {}; try { last = JSON.parse(localStorage.getItem(LS_KEY) || '{}'); } catch (e) { /* なし */ }
    if (last.kojiNo && state.kojiList.some(k => k.no === last.kojiNo)) sel.value = last.kojiNo;
    if (last.factory) { const b = document.querySelector(`.factory-btn[data-factory="${last.factory}"]`); if (b) b.click(); }
  } else if (cur && state.kojiList.some(k => k.no === cur)) sel.value = cur;
  $('koji-msg').textContent = '';
  if (state.started && !state.server) renderServer();
  updateStartBtn();
}
// 前回の工事リストがあれば、それをすぐ出す。裏で GAS から読み、変わっていれば置き換える
async function loadSettings() {
  let cached = null;
  try { cached = JSON.parse(localStorage.getItem(LS_SETTINGS) || 'null'); } catch (e) { cached = null; }
  if (cached && Array.isArray(cached.koji)) applySettings(cached, true); else cached = null;
  const fresh = apiGet({ action: 'settings' }).then(j => {
    const v = { koji: j.koji || [], servers: j.servers || [] };
    try { localStorage.setItem(LS_SETTINGS, JSON.stringify(v)); } catch (e) { /* なし */ }
    if (!cached || JSON.stringify(v) !== JSON.stringify({ koji: cached.koji || [], servers: cached.servers || [] })) applySettings(v, !cached);
  }).catch(e => {
    if (cached) return;
    $('koji-select').innerHTML = '<option value="" disabled selected>工事リストを読めませんでした</option>';
    $('koji-msg').textContent = e.message;
    updateStartBtn();
  });
  if (!cached) await fresh;
}
$('start-btn').addEventListener('click', () => {
  const no = $('koji-select').value, k = state.kojiList.find(x => x.no === no);
  const changed = state.kojiNo && state.kojiNo !== no;
  state.kojiNo = no; state.kojiName = k ? k.name : '';
  try { localStorage.setItem(LS_KEY, JSON.stringify({ kojiNo: no, factory: state.factory })); } catch (e) { /* なし */ }
  apiPostQuiet({ action: 'start', factory: state.factory });
  $('koji-label').textContent = `${state.factory}工場 / ${state.kojiNo} ${state.kojiName}`;
  $('start-modal').classList.add('hidden');
  document.body.classList.add('app-started'); state.started = true;
  if (changed) { state.files = []; state.res = null; state.orders = null; }   // 工事を変えたら読んだ結果は捨てる
  renderServer(); render();
  preloadPy();
});
$('btn-change').addEventListener('click', () => { $('start-modal').classList.remove('hidden'); });
$('start-cancel-btn').addEventListener('click', () => { $('start-modal').classList.add('hidden'); });

// ---------- リンク ----------
// Excel のリンク(file://)
function fileUrl(dir, name) {
  if (!dir) return '';
  const n = dir.replace(/\\/g, '/').replace(/\/+$/, '');
  const path = n + '/' + name;
  return (/^\/\//.test(n) ? 'file:' + path : 'file:///' + path.replace(/^\/+/, '')).replace(/ /g, '%20');
}
// 画面の図番クリック(jissun:// → パソコン側の設定で実寸法師が開く)
function jissunUrl(dir, name) {
  if (!dir) return '';
  const segs = (dir.replace(/\\/g, '/').replace(/^\/+/, '').replace(/\/+$/, '') + '/' + name).split('/');
  return 'jissun://' + segs.map(s => encodeURIComponent(s)).join('/');
}

// ---------- サーバーの「①進行中工事」(ブラウザに覚える。tdf-kanamono-list と同じ) ----------
function idb() {
  return new Promise((res, rej) => { const r = indexedDB.open('jissun-tankan-list', 1); r.onupgradeneeded = () => r.result.createObjectStore('kv'); r.onsuccess = () => res(r.result); r.onerror = () => rej(r.error); });
}
async function idbGet(k) { const d = await idb(); return new Promise(res => { const q = d.transaction('kv').objectStore('kv').get(k); q.onsuccess = () => res(q.result); q.onerror = () => res(undefined); }); }
async function idbSet(k, v) { const d = await idb(); return new Promise(res => { const t = d.transaction('kv', 'readwrite'); t.objectStore('kv').put(v, k); t.oncomplete = () => res(); t.onerror = () => res(); }); }
// 目印ファイル: ①進行中工事 の直下にある「_○○サーバー…」のファイルの ○○
async function readMarks(dir) {
  const out = [];
  try { for await (const e of dir.values()) { if (e.kind !== 'file') continue; const m = e.name.normalize('NFKC').match(/^_(.+?)サーバー/); if (m && !out.includes(m[1])) out.push(m[1]); } } catch (e) { /* 読めなければ目印なし */ }
  return out;
}
async function checkRoot(h, sv) {
  const marks = await readMarks(h);
  if (marks.includes(sv.name)) return 'ok';
  return marks.length ? 'wrong' : 'unknown';
}
async function getRoot(sv, ask, forcePick) {
  let root = forcePick ? null : await idbGet('root:' + sv.name);
  try {
    if (root) {
      let perm = await root.queryPermission({ mode: 'read' });
      if (perm !== 'granted' && ask) perm = await root.requestPermission({ mode: 'read' });
      if (perm !== 'granted') root = ask ? null : undefined;
    }
  } catch (e) { root = null; }
  if (root && (await checkRoot(root, sv)) === 'wrong') {
    await notice('覚えているフォルダが違います', `${sv.name}サーバーとして覚えていたフォルダは、目印ファイルを見ると別のサーバーの「${root.name}」でした。${sv.name}サーバーの「①進行中工事」を選び直してください。`);
    await idbSet('root:' + sv.name, null); root = null;
    if (!ask) return null;
  }
  if (root || !ask) return root || null;
  await notice(`${sv.name}サーバーの「①進行中工事」を覚えます`, `次の画面で、${sv.name}サーバーの「①進行中工事」フォルダを選んでください(最初の1回だけ)。\n画面は前に開いた場所から開くので、別のサーバーのフォルダを選ばないよう、場所を確かめてください。`);
  // id は英数字だけ(日本語を入れると画面が開かない)
  const pid = 'root' + Math.max(0, state.servers.findIndex(x => x.name === sv.name));
  for (;;) {
    let h;
    try { h = await window.showDirectoryPicker({ id: pid, mode: 'read' }); }
    catch (e) { if (e && e.name !== 'AbortError') toast('フォルダを選ぶ画面を開けませんでした: ' + e.message, 'error'); return null; }
    let same = '';
    for (const o of state.servers) {
      if (o.name === sv.name) continue;
      const oh = await idbGet('root:' + o.name);
      try { if (oh && await h.isSameEntry(oh)) same = o.name; } catch (e) { /* 比べられなければ別とみなす */ }
    }
    if (same) {
      if (await confirm2('同じフォルダです', `このフォルダは${same}サーバーの「①進行中工事」として覚えています。${sv.name}サーバーの「①進行中工事」を選んでください。`, '選び直す', 'やめる')) continue;
      return null;
    }
    const v = await checkRoot(h, sv);
    if (v === 'wrong') {
      if (await confirm2('サーバーが違います', `選んだ「${h.name}」は、目印ファイルを見ると${sv.name}サーバーのものではありません。${sv.name}サーバーの「①進行中工事」を選び直してください。`, '選び直す', 'やめる')) continue;
      return null;
    }
    if (v === 'unknown' && !(await confirm2('サーバーを確認できません', `選んだ「${h.name}」に目印ファイル(「_${sv.name}サーバー…」で始まるファイル)がありません。${sv.name}サーバーの「①進行中工事」で合っていますか?`, 'このフォルダを使う', '選び直す'))) continue;
    await idbSet('root:' + sv.name, h);
    toast(`${sv.name}サーバーの「${h.name}」を覚えました`);
    return h;
  }
}
async function selectServer(sv) {
  if (state.server) return;
  const root = await getRoot(sv, true, false); if (!root) return;
  state.server = sv; state.root = root;
  renderServer(); render();
}
function renderServer() {
  const box = $('server-btns');
  box.innerHTML = '';
  const ORDER = ['本社', '夢前', '鳥取'], rank = n => { const i = ORDER.indexOf(n); return i < 0 ? 99 : i; };
  state.servers.slice().sort((a, b) => rank(a.name) - rank(b.name)).forEach(sv => {
    const b = document.createElement('button');
    b.type = 'button'; b.className = 'big-btn server' + (state.server && state.server.name === sv.name ? ' selected' : '');
    b.textContent = `① ${sv.name}サーバー`;
    b.disabled = !!state.server && state.server.name !== sv.name;
    b.addEventListener('click', () => { if (!state.server) selectServer(sv); });
    box.appendChild(b);
  });
  $('repick-root').style.display = state.server ? '' : 'none';
}
$('repick-root').addEventListener('click', async () => {
  if (!state.server) return;
  const root = await getRoot(state.server, true, true);
  if (root) { state.root = root; renderServer(); }
});
// 選んだファイルが ①進行中工事 のどこにあるかを受け取り、情報シートF列のパスとつなぐ(①進行中工事 の外なら '')
async function pathOf(handle) {
  if (!state.root || !handle) return '';
  let rel = null;
  try { rel = await state.root.resolve(handle); } catch (e) { rel = null; }
  if (!rel) return '';
  return [state.server.path.replace(/[\\/]+$/, '')].concat(rel.slice(0, -1)).join('\\');
}
async function ensureRootPermission() {
  if (!state.root) return false;
  try {
    if ((await state.root.queryPermission({ mode: 'read' })) === 'granted') return true;
    return (await state.root.requestPermission({ mode: 'read' })) === 'granted';
  } catch (e) { return false; }
}
async function lastPickDir() {
  try {
    const last = await idbGet('lastPick');
    if (!last || !last.handle || last.server !== state.server.name) return state.root;
    if (!(await state.root.resolve(last.handle))) return state.root;
    return last.handle;
  } catch (e) { return state.root; }
}
// ② 大組図の TDF を選ぶ(1つの節の立面図と A付きの断面図をまとめて)
async function pickFiles() {
  if (!state.started) { toast('先に工場と工事を選んでください', 'error'); return; }
  if (!window.showOpenFilePicker) { $('file-input').click(); return; }   // 古いブラウザ: リンクなしで読む
  if (!state.server || !state.root) { toast('先に ① でサーバーを選んでください', 'error'); return; }
  if (!(await ensureRootPermission())) { toast('「①進行中工事」を読む許可がありません。① サーバー選択からやり直してください', 'error'); return; }
  let handles;
  try {
    handles = await window.showOpenFilePicker({ id: 'tdf' + Math.max(0, state.servers.findIndex(x => x.name === state.server.name)), startIn: await lastPickDir(), multiple: true,
      types: [{ description: 'TDFファイル', accept: { 'application/octet-stream': ['.tdf'] } }], excludeAcceptAllOption: false });
  } catch (e) { if (e && e.name !== 'AbortError') toast('ファイルを選ぶ画面を開けませんでした: ' + e.message, 'error'); return; }
  if (!handles.length) return;
  busy('図面を読んでいます…', 0);   // 「開く」の直後に出す(ファイルの受け取りにも数秒かかる)
  const items = [];
  try {
    for (const [i, h] of handles.entries()) { items.push({ file: await h.getFile(), path: await pathOf(h) }); busy('図面を読んでいます…', 0.1 * (i + 1) / handles.length); }
  } catch (e) { idle(); await notice('図面を読めませんでした', String(e && e.message || e)); return; }
  if (items[0].path) await idbSet('lastPick', { server: state.server.name, handle: handles[0] });
  await readDrawings(items);
}
$('btn-files').addEventListener('click', pickFiles);
$('file-input').addEventListener('change', e => { const fs = Array.from(e.target.files); e.target.value = ''; readDrawings(fs.map(f => ({ file: f, path: '' }))); });
let dragDepth = 0;
document.addEventListener('dragenter', e => { e.preventDefault(); dragDepth++; $('drop-overlay').classList.add('active'); });
document.addEventListener('dragleave', e => { e.preventDefault(); if (--dragDepth <= 0) { dragDepth = 0; $('drop-overlay').classList.remove('active'); } });
document.addEventListener('dragover', e => e.preventDefault());
document.addEventListener('drop', async e => {
  e.preventDefault(); dragDepth = 0; $('drop-overlay').classList.remove('active');
  if (!state.started) { toast('先に工場と工事を選んでください', 'error'); return; }
  const its = Array.from(e.dataTransfer.items || []).filter(i => i.kind === 'file');
  const pend = its.map(i => ({ file: i.getAsFile(), hp: i.getAsFileSystemHandle ? i.getAsFileSystemHandle() : null }));
  if (!pend.length) return;
  busy('図面を読んでいます…', 0);
  if (state.root) await ensureRootPermission();
  const items = [];
  for (const [i, x] of pend.entries()) { const h = x.hp ? await x.hp.catch(() => null) : null; items.push({ file: x.file, path: h && h.kind === 'file' ? await pathOf(h) : '' }); busy('図面を読んでいます…', 0.1 * (i + 1) / pend.length); }
  await readDrawings(items);
});

// ---------- 図面の読み取り(Pyodide で py/tankan_core.py を動かす) ----------
let pyPromise = null;
function loadPy(onProgress) {
  const tick = k => { if (onProgress) onProgress(k / (PY_FILES.length + 3)); };
  if (!pyPromise) {
    pyPromise = (async () => {
      tick(0);
      if (!window.loadPyodide) await new Promise((res, rej) => { const s = document.createElement('script'); s.src = PYODIDE_URL; s.onload = res; s.onerror = () => rej(new Error('Pythonの部品を読み込めませんでした')); document.head.appendChild(s); });
      tick(1);
      const py = await window.loadPyodide();
      tick(2);
      py.FS.mkdir('/tk'); py.FS.mkdir('/tdf');
      for (const [k, n] of PY_FILES.entries()) {
        const r = await fetch('py/' + n + '?v=' + PY_VER);
        if (!r.ok) throw new Error(n + ' を読み込めませんでした');
        py.FS.writeFile('/tk/' + n, await r.text());
        tick(3 + k);
      }
      await py.runPythonAsync("import sys, json\nsys.path.insert(0, '/tk')\nimport tankan_core");
      return py;
    })();
    pyPromise.catch(() => { pyPromise = null; });
  }
  return pyPromise;
}
function preloadPy() { setTimeout(() => { loadPy().catch(() => {}); }, 300); }

async function readDrawings(items) {
  items = items.filter(it => /\.tdf$/i.test(it.file.name));
  if (!items.length) { idle(); return; }
  state.files = items; state.res = null;
  try {
    busy('図面を読んでいます…', 0.1);
    const ordersP = apiGet({ action: 'orders', koji: state.kojiNo }).catch(e => ({ error: e.message }));
    const excelP = TankanExcel.prepare().catch(() => null);   // 単重表(画面の重量に使う)とひな形
    const py = await loadPy(r => busy('図面を読む準備をしています…(初回だけ数秒かかります)', 0.1 + r * 0.05));
    for (const [i, it] of items.entries()) { py.FS.writeFile('/tdf/' + it.file.name, new Uint8Array(await it.file.arrayBuffer())); busy('図面を読んでいます…', 0.15 + 0.1 * (i + 1) / items.length); }
    const o = await ordersP;
    state.orders = o.error ? { name: '', updated: '', csv: '', error: o.error } : o;
    const files = {}; items.forEach(it => { files[it.file.name] = '/tdf/' + it.file.name; });
    // 段階ごとの重み(図面の読み取りがいちばん重い)
    const W = { '図面を読んでいます': [0.25, 0.65], '板の外形を測っています': [0.65, 0.9], '板の絵を作っています': [0.9, 1.0] };
    const progress = (stage, i, n, name) => { const w = W[stage] || [0, 1]; busy(`${stage}…\n${name}`, w[0] + (w[1] - w[0]) * (i / Math.max(n, 1))); };
    py.globals.set('tk_files', JSON.stringify(files));
    py.globals.set('tk_orders', state.orders.csv || '');
    py.globals.set('tk_progress', progress);
    await new Promise(r => setTimeout(r, 30));   // 進み具合の表示を先に出す
    const out = await py.runPythonAsync('tankan_core.run_json(tk_files, tk_orders, "", tk_progress)');
    state.res = JSON.parse(out);
    await excelP;
    TankanExcel.sortFloors(state.res);   // 表の並び(画面とExcelで同じ番号)
    for (const it of items) { try { py.FS.unlink('/tdf/' + it.file.name); } catch (e) { /* なし */ } }
  } catch (e) {
    idle(); render();
    await notice('図面を読めませんでした', String(e && e.message || e));
    return;
  }
  idle(); render();
  await showReadNotes();
}
async function showReadNotes() {
  const r = state.res, msg = [];
  if (state.orders && state.orders.error) msg.push(`注文書(切板手配書)を読めませんでした: ${state.orders.error}\n板の重量は図面から計算した値になります。`);
  else if (state.orders && !state.orders.csv) msg.push(`注文書(切板手配書)のキャッシュに ${state.kojiNo} がありません。板の重量は図面から計算した値になります。`);
  if (r.log.length) msg.push('読めなかった図面:\n' + r.log.join('\n'));
  if (r.mat_ng && r.mat_ng.length) msg.push(`材質の印を読めなかった柱(材質は空欄・黄色。図面で確かめてください):\n` + r.mat_ng.join('\n'));
  const ng = Object.entries(r.verify).filter(([m, v]) => !v.ok);
  if (ng.length) msg.push(`手配書と合わない板(${ng.length}種類。重量は図面から計算した値で黄色):\n` + ng.map(([m, v]) => `${m}: ${v.ng.join('; ')}`).join('\n'));
  const noLink = state.files.filter(it => !it.path).length;
  if (noLink) msg.push(`リンクを付けられないTDFが ${noLink} 個あります(選んだサーバーの「①進行中工事」の中のファイルではないため)。`);
  if (msg.length) await notice('確認が必要なこと', msg.join('\n\n'), true);
}

// ---------- 表示 ----------
const fmt = v => (v === null || v === undefined) ? '' : (typeof v === 'number' ? String(Math.round(v * 100) / 100) : String(v));
function dirOf(name) { const it = state.files.find(x => x.file.name === name); return it ? it.path : ''; }
// 表の行(画面とスプレッドシートの記録で同じもの): [階, 番号, 柱符号, 図面番号, サイズ, コラム長さ, 仕上がり, 板マーク, 重量, 状態]
function tableRows() {
  const r = state.res, out = [];
  if (!r) return out;
  Object.keys(r.floors).sort().forEach(fl => r.floors[fl].forEach((g, i) => {
    const b = g.block, segs = b.segs || [];
    const marks = b.plates.map(p => p[0]);
    const ng = marks.filter(m => r.verify[m] && !r.verify[m].ok);
    const st = !b.segs ? '図面から取れず' : (ng.length ? '要確認: ' + ng.join('・') : 'OK');
    const w = TankanExcel.groupWeight(g, r.verify);
    out.push([fl, i + 1, g.members.map(m => m.sym).join(' / '), Array.from(new Set(g.members.map(m => m.dwg))).join(' / '),
      segs.map(s => s[0]).join(' / '), segs.map(s => fmt(s[1])).join(' / '), fmt(b.fin), marks.join(' / '), fmt(w), st]);
  }));
  return out;
}
function render() {
  const has = !!state.res;
  $('btn-excel').disabled = !has; $('btn-reset').disabled = !has && !state.server;
  const r = state.res;
  if (!has) { $('summary').innerHTML = ''; $('result').innerHTML = ''; return; }
  const nG = Object.values(r.floors).reduce((a, gs) => a + gs.length, 0);
  const nNg = Object.values(r.verify).filter(v => !v.ok).length;
  $('summary').innerHTML = `<div class="sum-card">図番の頭 <b>${esc(r.zuban)}</b>(${esc(r.setsu)})・読んだTDF ${state.files.length} 個・柱の表 ${nG} 個・板 ${Object.keys(r.verify).length} 種類` +
    `(手配書と合わない板 <b class="${nNg ? 'ng' : ''}">${nNg}</b>)・注文書 ${state.orders && state.orders.updated ? esc(state.orders.updated) + ' 更新' : 'なし'}</div>`;
  const rows = tableRows();
  let html = '';
  Object.keys(r.floors).sort().forEach(fl => {
    html += `<div class="prod-card"><div class="fl-title">${esc(fl)}</div><table class="kl tk"><tr class="lhead"><td>番号</td><td>柱符号</td><td>図面番号</td><td>サイズ</td><td>コラム長さ</td><td>仕上がり</td><td>板マーク(上→下)</td><td>重量</td><td>状態</td></tr>`;
    r.floors[fl].forEach((g, i) => {
      const row = rows.find(x => x[0] === fl && x[1] === i + 1);
      const dwgs = Array.from(new Set(g.members.map(m => m.dwg)));
      const dl = dwgs.map(d => { const n = r.files.full[d.split('-').pop()], u = n ? jissunUrl(dirOf(n), n) : ''; return u ? `<a href="${esc(u)}">${esc(d)}</a>` : esc(d); }).join('<br>');
      html += `<tr class="${row[9] === 'OK' ? '' : 'warn'}"><td>${row[1]}</td><td>${g.members.map(m => esc(m.sym)).join('<br>')}</td><td>${dl}</td><td>${esc(row[4]).replace(/ \/ /g, '<br>')}</td>` +
        `<td>${esc(row[5]).replace(/ \/ /g, '<br>')}</td><td>${esc(row[6])}</td><td>${esc(row[7]).replace(/ \/ /g, '<br>')}</td><td>${esc(row[8])}</td><td class="note">${esc(row[9])}</td></tr>`;
    });
    html += '</table></div>';
  });
  $('result').innerHTML = html;
}

// ---------- Excel ダウンロード ----------
$('btn-excel').addEventListener('click', async () => {
  if (!state.res) return;
  const d = new Date(), p2 = n => String(n).padStart(2, '0');
  const stamp = `${d.getFullYear()}${p2(d.getMonth() + 1)}${p2(d.getDate())}_${p2(d.getHours())}${p2(d.getMinutes())}`;
  const name = `短管リスト_${state.kojiNo}_${state.res.setsu}_${stamp}.xlsx`;
  try {
    busy('Excelを作っています…', 0);
    const blob = await TankanExcel.build({
      res: state.res, kojiName: state.kojiName, factory: state.factory,
      link: n => fileUrl(dirOf(n), n), onProgress: (msg, r) => busy(msg, r),
    });
    const a = document.createElement('a'); a.href = URL.createObjectURL(blob); a.download = name; a.click();
    setTimeout(() => URL.revokeObjectURL(a.href), 10000);
    const rows = [['階', '番号', '柱符号', '図面番号', 'サイズ', 'コラム長さ', '仕上がり', '板マーク', '重量', '状態']].concat(tableRows());
    apiPostQuiet({ action: 'download', factory: state.factory, rows: [[`${state.kojiNo} ${state.kojiName} ${state.res.setsu}  ${name}`]].concat(rows) });
  } catch (e) {
    await notice('Excelを作れませんでした', String(e && e.message || e));
  } finally { idle(); }
});

// ---------- リセット ----------
$('btn-reset').addEventListener('click', async () => {
  if (state.res && !(await confirm2('リセット', '読んだ図面と結果を消して、最初からやり直します。', 'リセットする', 'やめる'))) return;
  state.files = []; state.res = null; state.orders = null; state.server = null; state.root = null;
  renderServer(); render();
});

loadSettings();
