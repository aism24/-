// 製品別金物リスト(tdf) — 画面の動き。抽出は extract.js、Excelは excel.js。
// 仕様: docs/apps/tdf-kanamono-list.md
'use strict';

// GASのウェブアプリURL(スプレッドシート「製品別金物一覧アプリ」の gas/Code.gs をデプロイしたもの)。空の間は工事リストを読めない
const GAS_URL = 'https://script.google.com/macros/s/AKfycbyKURzPEeCi9kQ7Pfb_WXBJ7ntKNCwSzK9cWkT_YWGrHdAyF4SVBgix4VlSUlVVKUktzg/exec';
const EXCELJS_URL = 'https://cdnjs.cloudflare.com/ajax/libs/exceljs/4.4.0/exceljs.min.js';
const LS_KEY = 'tdf-kanamono-list:last';

const state = {
  factory: '', kojiNo: '', kojiName: '',
  kojiList: [], servers: [],
  tdfs: [],          // {id, fileName, path, res}
  server: null, root: null,   // ① サーバー選択で決めたサーバーと、その「①進行中工事」
  started: false,
};
let nextId = 1;

// ---------- 共通 ----------
const $ = id => document.getElementById(id);
function esc(s) { return String(s === null || s === undefined ? '' : s).replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c])); }
function toast(msg, type) {
  const t = $('toast'); t.textContent = msg; t.className = 'show' + (type === 'error' ? ' error' : '');
  clearTimeout(toast._t); toast._t = setTimeout(() => { t.className = ''; }, 4000);
}
// ratio(0〜1)を渡すとデータバーで進み具合を出す。渡さなければバーは出さない
function busy(msg, ratio) {
  $('status-text').textContent = msg || '処理中…';
  const has = typeof ratio === 'number';
  $('status-progress').hidden = !has;
  if (has) { const pc = Math.max(0, Math.min(100, Math.round(ratio * 100))); $('status-bar').style.width = pc + '%'; $('status-pct').textContent = pc + '%'; }
  $('status-overlay').classList.add('open');
}
function idle() { $('status-overlay').classList.remove('open'); }
function notice(title, body) {
  return new Promise(resolve => {
    $('notice-title').textContent = title; $('notice-body').textContent = body;
    $('notice-modal').classList.add('open');
    $('notice-ok').onclick = () => { $('notice-modal').classList.remove('open'); resolve(); };
  });
}
// 2つのボタンの確認。戻り値 true = okLabel / false = cancelLabel
function confirm2(title, body, okLabel, cancelLabel) {
  return new Promise(resolve => {
    $('notice-title').textContent = title; $('notice-body').textContent = body;
    $('notice-ok').textContent = okLabel; $('notice-cancel').textContent = cancelLabel; $('notice-cancel').style.display = '';
    $('notice-modal').classList.add('open');
    const done = v => { $('notice-modal').classList.remove('open'); $('notice-ok').textContent = 'OK'; $('notice-cancel').style.display = 'none'; resolve(v); };
    $('notice-ok').onclick = () => done(true); $('notice-cancel').onclick = () => done(false);
  });
}
async function apiGet(action) {
  if (!GAS_URL) throw new Error('GASのURLが未設定です');
  const r = await fetch(GAS_URL + '?action=' + encodeURIComponent(action));
  const j = await r.json(); if (j.status !== 'success') throw new Error(j.message || 'GASエラー'); return j;
}
// 利用記録は画面に何も出さない(成功・失敗とも)。docs/know-how/usage-log-hidden-check.md
function apiPostQuiet(payload) {
  if (!GAS_URL) return;
  try { fetch(GAS_URL, { method: 'POST', headers: { 'Content-Type': 'text/plain;charset=utf-8' }, body: JSON.stringify(payload) }).catch(() => {}); } catch (e) { /* 記録の失敗は無視 */ }
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

async function loadSettings() {
  const sel = $('koji-select');
  try {
    const j = await apiGet('settings');
    state.kojiList = j.koji || []; state.servers = j.servers || [];
    sel.innerHTML = '<option value="" disabled selected>選択してください</option>' +
      state.kojiList.map(k => `<option value="${esc(k.no)}">${esc(k.no)}　${esc(k.name)}</option>`).join('');
    let last = {}; try { last = JSON.parse(localStorage.getItem(LS_KEY) || '{}'); } catch (e) { /* なし */ }
    if (last.kojiNo && state.kojiList.some(k => k.no === last.kojiNo)) sel.value = last.kojiNo;
    if (last.factory) { const b = document.querySelector(`.factory-btn[data-factory="${last.factory}"]`); if (b) b.click(); }
  } catch (e) {
    sel.innerHTML = '<option value="" disabled selected>工事リストを読めませんでした</option>';
    $('koji-msg').textContent = e.message + '(GASのURLを設定するまでは開始できません)';
  }
  updateStartBtn();
}
$('start-btn').addEventListener('click', () => {
  const no = $('koji-select').value, k = state.kojiList.find(x => x.no === no);
  state.kojiNo = no; state.kojiName = k ? k.name : '';
  try { localStorage.setItem(LS_KEY, JSON.stringify({ kojiNo: no, factory: state.factory })); } catch (e) { /* なし */ }
  apiPostQuiet({ action: 'start', koji: state.kojiName, factory: state.factory });
  $('koji-label').textContent = `${state.factory}工場 / ${state.kojiNo} ${state.kojiName}`;
  $('start-modal').classList.add('hidden');
  document.body.classList.add('app-started'); state.started = true;
  renderServer();
  render();
});
$('btn-change').addEventListener('click', () => { $('start-modal').classList.remove('hidden'); });
$('start-cancel-btn').addEventListener('click', () => { $('start-modal').classList.add('hidden'); });

// Excelのリンク(file://)
function fileUrl(dir, name) {
  if (!dir) return '';
  const n = dir.replace(/\\/g, '/').replace(/\/+$/, '');
  const path = n + '/' + name;
  return (/^\/\//.test(n) ? 'file:' + path : 'file:///' + path.replace(/^\/+/, '')).replace(/ /g, '%20');
}
// 画面の図番クリック(jissun:// → パソコン側のPowerShellの設定で実寸法師が開く)
function jissunUrl(dir, name) {
  if (!dir) return '';
  const segs = (dir.replace(/\\/g, '/').replace(/^\/+/, '').replace(/\/+$/, '') + '/' + name).split('/');
  return 'jissun://' + segs.map(s => encodeURIComponent(s)).join('/');
}

// ---------- サーバーの「①進行中工事」(ブラウザに覚える) ----------
function idb() {
  return new Promise((res, rej) => { const r = indexedDB.open('tdf-kanamono-list', 1); r.onupgradeneeded = () => r.result.createObjectStore('kv'); r.onsuccess = () => res(r.result); r.onerror = () => rej(r.error); });
}
async function idbGet(k) { const d = await idb(); return new Promise(res => { const q = d.transaction('kv').objectStore('kv').get(k); q.onsuccess = () => res(q.result); q.onerror = () => res(undefined); }); }
async function idbSet(k, v) { const d = await idb(); return new Promise(res => { const t = d.transaction('kv', 'readwrite'); t.objectStore('kv').put(v, k); t.oncomplete = () => res(); t.onerror = () => res(); }); }

// サーバーの「①進行中工事」(初回だけ選んで、ブラウザに覚える)
// 目印ファイル: ①進行中工事 の直下にある「_○○サーバー…」のファイルの ○○ (tdf-master-web と同じ)
async function readMarks(dir) {
  const out = [];
  try { for await (const e of dir.values()) { if (e.kind !== 'file') continue; const m = e.name.normalize('NFKC').match(/^_(.+?)サーバー/); if (m && !out.includes(m[1])) out.push(m[1]); } } catch (e) { /* 読めなければ目印なし */ }
  return out;
}
// 覚えている(または選んだ)フォルダが、そのサーバーの ①進行中工事 か。'ok' / 'wrong'(別のサーバーの目印) / 'unknown'(目印なし)
async function checkRoot(h, sv) {
  const marks = await readMarks(h);
  if (marks.includes(sv.name)) return 'ok';
  return marks.length ? 'wrong' : 'unknown';
}
// サーバーの「①進行中工事」(通常は初回だけ選んで、ブラウザに覚える)。
// 2026-11-20 ユーザー指示: tottori-production-status から飛んだとき(#plan。鳥取専用)だけは、覚えたフォルダを使わず毎回選ぶ(forcePick)。
// 2026-11-19: 本社を覚えたあと鳥取を選ぶと、選ぶ画面が本社の①進行中工事から開き、同じ名前なので本社を鳥取として覚えてしまうことがあった。
// 目印ファイルと「別のサーバーとして覚えたフォルダと同じでないか」で確かめる
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
  await notice(forcePick ? `${sv.name}サーバーの「①進行中工事」を選びます` : `${sv.name}サーバーの「①進行中工事」を覚えます`, `次の画面で、${sv.name}サーバーの「①進行中工事」フォルダを選んでください${forcePick ? '' : '(最初の1回だけ)'}。\n画面は前に開いた場所から開くので、別のサーバーのフォルダを選ばないよう、場所を確かめてください。`);
  // id は英数字・_・- だけ(32文字まで)。日本語を入れると開かずにエラーになる(2026-11-19、「root-本社」で開かなかった)
  const pid = 'root' + Math.max(0, state.servers.findIndex(x => x.name === sv.name));
  for (;;) {
    let h;
    try { h = await window.showDirectoryPicker({ id: pid, mode: 'read' }); }
    catch (e) { if (e && e.name !== 'AbortError') toast('フォルダを選ぶ画面を開けませんでした: ' + e.message, 'error'); return null; }
    // 別のサーバーとして覚えたフォルダと同じなら選び直し
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
    toast(forcePick ? `${sv.name}サーバーの「${h.name}」を選びました` : `${sv.name}サーバーの「${h.name}」を覚えました`);
    return h;
  }
}
// ① サーバーのボタン: 使うサーバーを決め、その「①進行中工事」を覚える(フォルダはたどらない)。
// 選んだら、もう一方のボタンはリセットするまで押せない
async function selectServer(sv) {
  if (state.server) return false;
  // tottori から飛んだとき(#plan)は、毎回 ①進行中工事 を選び、選んだらそのままTDFを読む(2026-11-20 ユーザー指示。サーバーは本社・鳥取どちらも可)
  const root = await getRoot(sv, true, !!PLAN); if (!root) return false;
  state.server = sv; state.root = root;
  renderServer(); render();
  if (PLAN) await runPlan(PLAN);
  return true;
}
function renderServer() {
  const box = $('server-btns');
  box.innerHTML = '';
  // 並びは本社 → 夢前 → 鳥取(ユーザー指定。設定シートの順には左右されない)、それ以外は後ろ
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
// 覚えている ①進行中工事 を選び直す(選んでいるサーバーの分)
$('repick-root').addEventListener('click', async () => {
  if (!state.server) return;
  const root = await getRoot(state.server, true, true);
  if (root) { state.root = root; renderServer(); }
});
// 選んだファイルが ①進行中工事 のどこにあるかを受け取り、設定シートF列のパスとつなぐ(①進行中工事 の外なら '')
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
// ② ファイル選択: ①進行中工事 から開くファイル選択の画面でTDFを選ぶ
async function pickFiles() {
  if (!state.started) { toast('先に工場と工事を選んでください', 'error'); return; }
  if (!window.showOpenFilePicker) { $('file-input').click(); return; }  // 古いブラウザ: リンクなしで取り込む
  if (!state.server || !state.root) { toast('先に ① でサーバーを選んでください', 'error'); return; }
  if (!(await ensureRootPermission())) { toast('「①進行中工事」を読む許可がありません。① サーバー選択からやり直してください', 'error'); return; }
  let handles;
  const startIn = await lastPickDir();
  try {
    handles = await window.showOpenFilePicker({ id: 'tdf' + Math.max(0, state.servers.findIndex(x => x.name === state.server.name)), startIn, multiple: true,
      types: [{ description: 'TDFファイル', accept: { 'application/octet-stream': ['.tdf'] } }], excludeAcceptAllOption: false });
  } catch (e) { if (e && e.name !== 'AbortError') toast('ファイルを選ぶ画面を開けませんでした: ' + e.message, 'error'); return; }
  const items = [];
  for (const h of handles) items.push({ file: await h.getFile(), path: await pathOf(h) });
  // 前回開いたところを覚える(①進行中工事 の中のファイルだけ。サーバーごとではなく最後の1つ)
  if (handles.length && items[0].path) await idbSet('lastPick', { server: state.server.name, handle: handles[0] });
  await importWithNotice(items);
}
// ② の画面を開く場所(2026-11-19 ユーザー指示): 前回選んだファイルのフォルダ。
// ただし前回と選んだサーバーが違う・前回のファイルが今の ①進行中工事 の外のときは、今までどおり ①進行中工事
async function lastPickDir() {
  try {
    const last = await idbGet('lastPick');
    if (!last || !last.handle || last.server !== state.server.name) return state.root;
    if (!(await state.root.resolve(last.handle))) return state.root;
    return last.handle;   // ファイルを渡すと、そのファイルのあるフォルダから開く
  } catch (e) { return state.root; }
}
async function importWithNotice(items) {
  items = items.filter(it => /\.tdf$/i.test(it.file.name));
  if (!items.length) return;
  const noLink = items.filter(it => !it.path).map(it => it.file.name);
  await importItems(items);
  if (noLink.length) await notice('リンクを付けられなかったTDF', noLink.join('\n') + '\n\n選んだサーバーの「①進行中工事」の中のファイルではないため、場所が分かりません。図番を押しても実寸法師は開きません(Excelにもリンクは付きません)。\n「リセット」を押してから ① で正しいサーバー(このTDFがあるサーバー)を選び、「② ファイル選択」から選び直してください。');
}

async function importItems(items) {
  const total = items.length;
  // 進み具合: 1枚の中で 図面の読み取り=0〜0.3、長さ(初回は Python の準備を含む)=0.3〜1
  const step = (i, r, msg) => busy(`${msg}\n${i + 1}/${total}枚目 ${items[i].file.name}`, (i + r) / total);
  step(0, 0, 'TDFを読み込んでいます…');
  const errors = [], excluded = new Set(), warns = [];
  try {
    for (const [i, { file: f, path }] of items.entries()) {
      step(i, 0, 'TDFを読み込んでいます…');
      try {
        if (state.tdfs.some(t => t.fileName === f.name && t.path === path)) { errors.push(`${f.name}: すでに取り込んでいます`); continue; }
        const buf = await f.arrayBuffer();
        const res = KanamonoExtract.extract(buf, f.name);
        if (!res.products.length) { errors.push(`${f.name}: 製品(「製品名 符号 N台」の行)が見つかりませんでした`); continue; }
        // 長さは tdf-master-web と同じ方法で求める(2026-11-20 ユーザー指示)。読めなければ図面の寸法から読んだ長さのまま
        try {
          step(i, 0.3, pyPromise ? '長さを読んでいます…' : '長さを読む準備をしています…(初回だけ数秒かかります)');
          const ml = await masterLengths(buf, f.name, r => step(i, 0.3 + 0.6 * r, '長さを読む準備をしています…(初回だけ数秒かかります)'));
          res.products.forEach(p => { const m = ml.find(x => x[0] === p.name); if (m && m[1]) p.length = Math.round(m[1] * 10000) / 10; });
        } catch (e) { warns.push(`${f.name}: 長さを tdf-master-web と同じ方法で読めませんでした(${e.message})。図面の寸法から読んだ長さを使います`); }
        step(i, 1, 'TDFを読み込んでいます…');
        const base = state.tdfs[0];
        if (base && base.res.koji !== res.koji) { errors.push(`${f.name}: 工事名が違うため取り込みません(「${res.koji || '不明'}」。取り込み済みは「${base.res.koji}」)`); continue; }
        res.products.forEach(p => p.items.forEach(it => { it.n0 = it.n; }));
        state.tdfs.push({ id: nextId++, fileName: f.name, path: path || '', res });
        if (res.kojiNo && res.kojiNo !== state.kojiNo) warns.push(`${f.name}: 図面の工事番号(${res.kojiNo})が、選んだ工事(${state.kojiNo})と違います`);
        res.excluded.forEach(x => excluded.add(x));
        res.warnings.forEach(w => warns.push(`${f.name}: ${w}`));
      } catch (e) { errors.push(`${f.name}: 読めませんでした(${e.message})`); }
    }
  } finally { idle(); }
  render();
  if (excluded.size) await notice('お知らせ', Array.from(excluded).join('・') + 'は抽出していません');
  // 取り込めなかったTDFがあるときは、対象外の図面の説明を添える(2026-11-19 ユーザー指示。2G-07A のような断面だけの補助図面は対象外)
  const NOTE_UNSUPPORTED = '断面だけの補助図面がある場合（a付など）は、抽出できません';
  if (errors.length || warns.length) await notice('取り込めなかったTDF・確認が必要なこと', errors.concat(warns).join('\n') + (errors.length ? '\n\n' + NOTE_UNSUPPORTED : ''));
}
$('btn-files').addEventListener('click', pickFiles);
$('file-input').addEventListener('change', e => { const fs = Array.from(e.target.files); e.target.value = ''; importWithNotice(fs.map(f => ({ file: f, path: '' }))); });
let dragDepth = 0;
document.addEventListener('dragenter', e => { e.preventDefault(); dragDepth++; $('drop-overlay').classList.add('active'); });
document.addEventListener('dragleave', e => { e.preventDefault(); if (--dragDepth <= 0) { dragDepth = 0; $('drop-overlay').classList.remove('active'); } });
document.addEventListener('dragover', e => e.preventDefault());
// ドロップしたファイルも、①進行中工事 の中なら場所が分かる(getAsFileSystemHandle)
document.addEventListener('drop', async e => {
  e.preventDefault(); dragDepth = 0; $('drop-overlay').classList.remove('active');
  if (!state.started) { toast('先に工場と工事を選んでください', 'error'); return; }
  const its = Array.from(e.dataTransfer.items || []).filter(i => i.kind === 'file');
  const pend = its.map(i => ({ file: i.getAsFile(), hp: i.getAsFileSystemHandle ? i.getAsFileSystemHandle() : null }));
  if (state.root) await ensureRootPermission();
  const items = [];
  for (const x of pend) { const h = x.hp ? await x.hp.catch(() => null) : null; items.push({ file: x.file, path: h && h.kind === 'file' ? await pathOf(h) : '' }); }
  await importWithNotice(items);
});

// ---------- 表示 ----------
function allProducts() {
  // 図面番号順。同じ図面の中は図面に書かれた順(上段から)
  const out = [];
  state.tdfs.slice().sort((a, b) => KanamonoExtract.cmpNat(a.res.zuban || a.fileName, b.res.zuban || b.fileName)).forEach(t => {
    t.res.products.forEach(p => out.push({ t, p }));
  });
  return out;
}
function render() {
  const has = state.tdfs.length > 0;
  $('btn-excel').disabled = !has; $('btn-reset').disabled = !has && !state.server;
  $('tdf-list').innerHTML = has ? '<table><tr><th>図面番号</th><th>工事名(図面)</th><th>ファイル名</th><th></th></tr>' +
    state.tdfs.map(t => `<tr><td>${esc(t.res.zuban)}</td><td>${esc(t.res.koji)}</td><td title="${esc(t.path || 'リンクなし')}">${esc(t.fileName)}${t.path ? '' : '(リンクなし)'}</td><td><button type="button" class="rm-btn" data-rm="${t.id}">外す</button></td></tr>`).join('') + '</table>' : '';
  const R = $('result');
  if (!has) { R.innerHTML = state.started ? '<div class="empty-msg">TDFを取り込むと、製品ごとの金物リストがここに出ます。<br>枚数(本数)と備考は直してからExcelに出せます。</div>' : ''; return; }
  let html = '';
  allProducts().forEach(({ t, p }, pi) => {
    const link = jissunUrl(t.path, t.fileName);
    const zb = link ? `<a href="${esc(link)}" title="実寸法師で開く">${esc(p.zuban)}</a>` : `<span class="nolink" title="サーバーの場所が分からないため、リンクはありません">${esc(p.zuban)}</span>`;
    const nm = link ? `<a href="${esc(link)}" title="実寸法師で開く">${esc(p.name)}</a>` : `<span class="nolink" title="サーバーの場所が分からないため、リンクはありません">${esc(p.name)}</span>`;
    const items = p.items.slice().sort(KanamonoExtract.cmpItem);
    const sum = items.reduce((a, it) => a + (it.n > 0 ? it.n : 0), 0);
    html += `<div class="prod-card"><table class="kl">
      <tr class="phead"><td>図面番号</td><td>製品名</td><td>サイズ</td><td>長さ（mm）</td><td>台数</td></tr>
      <tr class="pval"><td>${zb}</td><td>${nm}</td><td>${esc(p.size)}</td><td>${esc(p.length || '')}</td><td>${esc(p.dai)}</td></tr>
      <tr class="lhead"><td>サイズ</td><td>切板名（長さ）</td><td>枚数（本数）</td><td>備考</td><td></td></tr>` +
      items.map(it => {
        const idx = p.items.indexOf(it), g = KanamonoExtract.kindOf(it.size) === 'GPL' ? ' gpl' : '';
        return `<tr class="item${g}"><td class="b">${esc(it.size)}</td><td class="b">${esc(it.name)}</td>
          <td class="b"><input class="qty${it.n !== it.n0 ? ' changed' : ''}" type="number" min="0" value="${it.n}" data-t="${t.id}" data-p="${t.res.products.indexOf(p)}" data-i="${idx}"></td>
          <td class="note"><input class="note-in" value="${esc(it.note)}" data-t="${t.id}" data-p="${t.res.products.indexOf(p)}" data-i="${idx}"></td><td></td></tr>`;
      }).join('') +
      `<tr class="sub"><td></td><td>小計</td><td>${sum}</td><td></td><td></td></tr></table></div>`;
  });
  // 総まとめ(Excelと同じ並び)
  const lay = KanamonoExcel.layout({ kojiNo: state.kojiNo, koji: '' }, buildExportProducts(), state.tdfs.length > 1);
  let sumHtml = '', inSum = false;
  lay.rows.forEach(r => {
    if (r.kind === 'stitle') { inSum = true; sumHtml += `<div class="sum-title">${esc(r.vals[0])}</div>`; return; }
    if (!inSum) return;
    if (r.kind === 'cat') { sumHtml += (sumHtml.includes('<table') ? '</table></div>' : '') + `<div class="prod-card"><div class="cat-title">${esc(r.vals[0])}</div><table class="kl">`; return; }
    if (r.kind === 'shead') { sumHtml += '<tr class="shead"><td>サイズ</td><td>切板名（長さ）</td><td>枚数（本数）</td><td>備考</td></tr>'; return; }
    if (r.kind === 'sitem' || r.kind === 'sitem_gpl') sumHtml += `<tr class="sitem${r.kind === 'sitem_gpl' ? ' gpl' : ''}"><td class="b">${esc(r.vals[0])}</td><td class="b">${esc(r.vals[1])}</td><td class="b">${esc(r.vals[2])}</td><td class="note">${esc(r.vals[3] || '')}</td></tr>`;
  });
  if (sumHtml.includes('<table')) sumHtml += '</table></div>';
  R.innerHTML = html + sumHtml;
}
document.addEventListener('click', e => {
  const rm = e.target.closest('[data-rm]');
  if (rm) { state.tdfs = state.tdfs.filter(t => String(t.id) !== rm.dataset.rm); render(); }
});
document.addEventListener('change', e => {
  const el = e.target; if (!el.dataset || !el.dataset.t) return;
  const t = state.tdfs.find(x => String(x.id) === el.dataset.t); if (!t) return;
  const it = t.res.products[+el.dataset.p].items[+el.dataset.i];
  if (el.classList.contains('qty')) { const v = parseInt(el.value, 10); it.n = isNaN(v) || v < 0 ? 0 : v; }
  if (el.classList.contains('note-in')) it.note = el.value.trim();
  render();
});
$('btn-reset').addEventListener('click', () => { if (confirm('取り込んだTDF・修正・選んだサーバーをすべて消します。よろしいですか?')) { state.tdfs = []; state.server = null; state.root = null; renderServer(); render(); } });

// ---------- Excel ----------
function buildExportProducts() {
  return allProducts().map(({ t, p }) => ({
    zuban: p.zuban, name: p.name, size: p.size, length: p.length, dai: p.dai,
    link: fileUrl(t.path, t.fileName),
    items: p.items.map(it => ({ size: it.size, name: it.name, n: it.n, note: it.note })),
  }));
}
// ---------- 長さ(tdf-master-web と同じ Python を Pyodide で動かす。py/ は tdf-master-web の写し) ----------
const PYODIDE_URL = 'https://cdn.jsdelivr.net/pyodide/v0.26.4/full/pyodide.js';   // tdf-master-web と同じ版
const PY_FILES = ['tdf_binary.py', 'tdf_master_extractor.py', 'tdf_master_extractor_multi.py', 'tdf_app.py'];
let pyPromise = null;
// onProgress(0〜1): 準備の段階(部品の読み込み・Python の起動・ファイル4つ・取り込み)ごとに呼ぶ
let pyProgress = null;
function loadPy(onProgress) {
  if (onProgress) pyProgress = onProgress;
  const tick = (k) => { if (pyProgress) pyProgress(k / (PY_FILES.length + 3)); };
  if (!pyPromise) {
    pyPromise = (async () => {
      tick(0);
      if (!window.loadPyodide) await new Promise((res, rej) => { const s = document.createElement('script'); s.src = PYODIDE_URL; s.onload = res; s.onerror = () => rej(new Error('Pythonの部品を読み込めませんでした')); document.head.appendChild(s); });
      tick(1);
      const py = await window.loadPyodide();
      tick(2);
      py.FS.mkdir('/mw');
      for (const [k, n] of PY_FILES.entries()) {
        const r = await fetch('py/' + n + '?v=' + PY_VER);
        if (!r.ok) throw new Error(n + ' を読み込めませんでした');
        py.FS.writeFile('/mw/' + n, await r.text());
        tick(3 + k);
      }
      await py.runPythonAsync("import sys, json\nsys.path.insert(0, '/mw')\nimport tdf_app");
      tick(PY_FILES.length + 3);
      pyProgress = null;
      return py;
    })();
    pyPromise.catch(() => { pyPromise = null; });
  }
  return pyPromise;
}
// [[製品マーク, 長さ(m)], …]
async function masterLengths(buf, name, onProgress) {
  const py = await loadPy(onProgress);
  py.FS.writeFile('/input.tdf', new Uint8Array(buf));
  py.globals.set('tdf_filename', name);
  const out = await py.runPythonAsync("json.dumps([[r.get('製品マーク'), r.get('長さ')] for r in tdf_app.extract_file('/input.tdf', tdf_filename)], ensure_ascii=False)");
  return JSON.parse(out);
}
const PY_VER = '20261120c';

let exceljsPromise = null;
function loadExcelJS() {
  if (window.ExcelJS) return Promise.resolve();
  if (!exceljsPromise) exceljsPromise = new Promise((res, rej) => { const s = document.createElement('script'); s.src = EXCELJS_URL; s.onload = res; s.onerror = () => { exceljsPromise = null; rej(new Error('Excelを作る部品を読み込めませんでした')); }; document.head.appendChild(s); });
  return exceljsPromise;
}
function pad(n) { return String(n).padStart(2, '0'); }
$('btn-excel').addEventListener('click', async () => {
  if (!state.tdfs.length) return;
  busy('Excelを作っています…');
  try {
    await loadExcelJS();
    const multi = state.tdfs.length > 1;
    const koji = state.tdfs[0].res.koji;
    const head = { kojiNo: state.kojiNo, koji };
    const { wb, layout } = KanamonoExcel.build(window.ExcelJS, state.factory, head, buildExportProducts(), multi);
    const buf = await wb.xlsx.writeBuffer();
    const d = new Date();
    const name = multi ? `${state.kojiNo}_${d.getFullYear()}${pad(d.getMonth() + 1)}${pad(d.getDate())}_${pad(d.getHours())}${pad(d.getMinutes())}_金物リスト.xlsx`
      : `${state.tdfs[0].res.zuban || state.tdfs[0].fileName.replace(/\.tdf$/i, '')}_金物リスト.xlsx`;
    const url = URL.createObjectURL(new Blob([buf], { type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' }));
    const a = document.createElement('a'); a.href = url; a.download = name; document.body.appendChild(a); a.click(); a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 2000);
    apiPostQuiet({ action: 'download', koji: state.kojiName, factory: state.factory, rows: KanamonoExcel.toValues(layout) });
  } catch (e) { toast('Excelを作れませんでした: ' + e.message, 'error'); }
  finally { idle(); }
});

// ---------- 次の加工予定から作る(tottori-production-status と連動。2026-11-20 ユーザー指示) ----------
// tottori-production-status で加工結果PDFを取り込み、「次の加工予定の金物リストを作りますか？」で「はい」を押すと、
// このページが #plan=…(予定表で台数のセルが黄色の行)付きで開く。工場は鳥取固定。TDFのサーバーは本社・鳥取のどちらかを ① で選ぶ(2026-11-20)。工事ごとにシートを分け(シート名は工事番号)、
// 1枚目に次の加工予定の一覧を入れたExcelをダウンロードする。TDFは shipping-list-link のリンク表の場所を「①進行中工事」から読む
function readPlanFromHash() {
  const m = /^#plan=(.+)$/.exec(location.hash || '');
  if (!m) return null;
  try { const p = JSON.parse(decodeURIComponent(m[1])); return p && Array.isArray(p.rows) && p.rows.length ? p : null; } catch (e) { return null; }
}
const PLAN = readPlanFromHash();
const nk = s => String(s || '').normalize('NFKC').trim();
// リンク(file://サーバー/…/①進行中工事/工事/…/X.tdf)の「①進行中工事」より後ろ
function relFromLink(link, rootName) {
  if (!link) return null;
  let s = String(link).replace(/^file:/i, '');
  try { s = decodeURIComponent(s); } catch (e) { /* そのまま */ }
  const segs = s.split(/[\\/]+/).filter(Boolean), k = segs.findIndex(x => nk(x) === nk(rootName));
  return k < 0 || k === segs.length - 1 ? null : segs.slice(k + 1);
}
async function fileAt(root, segs) {
  let d = root;
  for (const sg of segs.slice(0, -1)) d = await d.getDirectoryHandle(sg);
  return d.getFileHandle(segs[segs.length - 1]);
}
async function startPlan() {
  history.replaceState(null, '', location.pathname + location.search);   // 開き直しで二重に作らないよう、#plan を消す
  state.factory = '鳥取'; state.kojiNo = ''; state.kojiName = '次の加工予定';
  $('start-modal').classList.add('hidden');
  document.body.classList.add('app-started'); state.started = true;
  $('koji-label').textContent = `鳥取工場 / 次の加工予定(${PLAN.rows.length}件)`;
  apiPostQuiet({ action: 'start', koji: '次の加工予定', factory: '鳥取' });
  const kojis = [...new Set(PLAN.rows.map(r => r.kojiNo || r.abbr))];
  renderServer();
  // サーバーは本社・鳥取のどちらか(鳥取サーバー固定ではない)。① のボタンで選び、毎回「①進行中工事」まで選ぶ(2026-11-20 ユーザー指示)
  await notice('次の加工予定の金物リスト',
    `${PLAN.src ? '「' + PLAN.src + '」の' : ''}次の加工予定(黄色) ${PLAN.rows.length}件(工事 ${kojis.join('・')})の金物リストを作ります。\n「① 本社サーバー」か「① 鳥取サーバー」を押し、そのサーバーの「①進行中工事」を選ぶと、TDFを読み込みます。`);
}
async function runPlan(plan) {
  const sv = state.server, root = state.root;
  if (!sv || !root) return;
  const rows = plan.rows.map(r => Object.assign({}, r, { status: '' }));
  const files = new Map();   // 「①進行中工事」からの場所 → {fileName, dir, res | err}
  rows.forEach(r => {
    r.segs = relFromLink(r.link, root.name);
    if (!r.link) r.status = 'リンク表にありません';
    else if (!r.segs) r.status = 'TDFの場所が「①進行中工事」の中ではありません';
    else if (!files.has(r.segs.join('/'))) files.set(r.segs.join('/'), { segs: r.segs });
  });
  const list = [...files.values()], total = list.length || 1;
  try {
    for (const [i, f] of list.entries()) {
      const step = (r, msg) => busy(`${msg}\n${i + 1}/${total}枚目 ${f.segs[f.segs.length - 1]}`, (i + r) / total);
      step(0, 'TDFを読み込んでいます…');
      try {
        const file = await (await fileAt(root, f.segs)).getFile();
        const buf = await file.arrayBuffer();
        const res = KanamonoExtract.extract(buf, file.name);
        try {
          step(0.3, pyPromise ? '長さを読んでいます…' : '長さを読む準備をしています…(初回だけ数秒かかります)');
          const ml = await masterLengths(buf, file.name, r => step(0.3 + 0.6 * r, '長さを読む準備をしています…(初回だけ数秒かかります)'));
          res.products.forEach(p => { const m = ml.find(x => x[0] === p.name); if (m && m[1]) p.length = Math.round(m[1] * 10000) / 10; });
        } catch (e) { /* 長さは図面の寸法から読んだもの */ }
        f.fileName = file.name; f.res = res;
        f.dir = [sv.path.replace(/[\\/]+$/, '')].concat(f.segs.slice(0, -1)).join('\\');
      } catch (e) { f.err = 'TDFを開けませんでした'; }
    }
  } finally { idle(); }
  // 予定の行ごとに、TDFの中の同じ製品名の製品を使う。枚数は1台あたり × 予定の台数
  const groups = new Map();
  rows.forEach(r => {
    if (r.status) return;
    const f = files.get(r.segs.join('/'));
    if (f.err) { r.status = f.err; return; }
    const p = f.res.products.find(x => nk(x.name) === nk(r.mark));
    if (!p) { r.status = 'TDFにこの製品がありません'; return; }
    r.status = '作成';
    const key = r.kojiNo || r.abbr || '工事番号なし';
    if (!groups.has(key)) groups.set(key, { sheet: key.replace(/[\\/?*\[\]:]/g, '_').slice(0, 31), head: { kojiNo: r.kojiNo || '', koji: f.res.koji || r.abbr || '' }, products: [], tdfs: [] });
    const g = groups.get(key), qty = Number(r.qty) || p.dai || 1;
    g.products.push({ zuban: p.zuban, name: p.name, size: p.size, length: p.length, dai: qty, link: r.link || fileUrl(f.dir, f.fileName),
      items: p.items.map(it => ({ size: it.size, name: it.name, n: it.n * qty, note: it.note })) });
    if (!g.tdfs.includes(f)) g.tdfs.push(f);
  });
  // 画面にも出す(作った製品だけ)
  state.tdfs = [];
  groups.forEach(g => g.tdfs.forEach(f => {
    const names = g.products.map(x => nk(x.name));
    const res = Object.assign({}, f.res, { products: f.res.products.filter(p => names.includes(nk(p.name))) });
    res.products.forEach(p => p.items.forEach(it => { it.n0 = it.n; }));
    state.tdfs.push({ id: nextId++, fileName: f.fileName, path: f.dir, res });
  }));
  render();
  if (!groups.size) { await notice('金物リストを作れませんでした', rows.map(r => `${r.abbr} ${r.mark}: ${r.status}`).join('\n')); return; }
  busy('Excelを作っています…');
  try {
    await loadExcelJS();
    const gs = [...groups.values()];
    const { wb, layouts } = KanamonoExcel.buildPlan(window.ExcelJS, '鳥取', rows, gs);
    const buf = await wb.xlsx.writeBuffer();
    const d = new Date();
    const name = `次の加工予定_金物リスト_${d.getFullYear()}${pad(d.getMonth() + 1)}${pad(d.getDate())}_${pad(d.getHours())}${pad(d.getMinutes())}.xlsx`;
    const url = URL.createObjectURL(new Blob([buf], { type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' }));
    const a = document.createElement('a'); a.href = url; a.download = name; document.body.appendChild(a); a.click(); a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 2000);
    layouts.forEach(l => apiPostQuiet({ action: 'download', koji: l.sheet, factory: '鳥取', rows: KanamonoExcel.toValues(l.layout) }));
  } catch (e) { toast('Excelを作れませんでした: ' + e.message, 'error'); }
  finally { idle(); }
  const miss = rows.filter(r => r.status !== '作成');
  if (miss.length) await notice('金物リストに入れなかった製品', miss.map(r => `${r.abbr} ${r.mark}(${r.zuban || '図番なし'}): ${r.status}`).join('\n') + '\n\n「次の加工予定」のシートには載せています。');
}

loadSettings().then(() => { if (PLAN) startPlan(); });
render();
