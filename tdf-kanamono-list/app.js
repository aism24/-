// 製品別金物リスト(tdf) — 画面の動き。抽出は extract.js、Excelは excel.js。
// 仕様: docs/apps/tdf-kanamono-list.md
'use strict';

// GASのウェブアプリURL(スプレッドシート「製品別金物一覧アプリ」の gas/Code.gs をデプロイしたもの)。空の間は工事リストを読めない
const GAS_URL = 'https://script.google.com/macros/s/AKfycbyKURzPEeCi9kQ7Pfb_WXBJ7ntKNCwSzK9cWkT_YWGrHdAyF4SVBgix4VlSUlVVKUktzg/exec';
const EXCELJS_URL = 'https://cdnjs.cloudflare.com/ajax/libs/exceljs/4.4.0/exceljs.min.js';
const LS_KEY = 'tdf-kanamono-list:last';
const LS_SETTINGS = 'tdf-kanamono-list:settings';   // 前回GASから読んだ工事リスト・サーバー(開いたらすぐ出し、裏で最新に置き換える。2026-11-21)

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
// lines: true = 書いた改行の位置だけで改行する(文の途中で折り返さない。枠は文の長さに合わせて広げる。2026-11-20 ユーザー指示)
function notice(title, body, lines) {
  return new Promise(resolve => {
    $('notice-title').textContent = title; $('notice-body').textContent = body;
    $('notice-modal').querySelector('.dialog').classList.toggle('lines', !!lines);
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
// Excelダウンロード後の案内(図番・製品名のリンクの注意)。「閉じる」で閉じる(2026-11-25 ユーザー指示)
function linkNotice() {
  return new Promise(resolve => {
    $('link-notice').classList.add('open');
    $('link-notice-close').focus();
    $('link-notice-close').onclick = () => { $('link-notice').classList.remove('open'); resolve(); };
  });
}
async function apiGet(action, params) {
  if (!GAS_URL) throw new Error('GASのURLが未設定です');
  const q = Object.entries(params || {}).map(([k, v]) => '&' + k + '=' + encodeURIComponent(v)).join('');
  const r = await fetch(GAS_URL + '?action=' + encodeURIComponent(action) + q);
  const j = await r.json(); if (j.status !== 'success') throw new Error(j.message || 'GASエラー'); return j;
}
// ---------- 注文書(切板の手配書。GAS が符号ごとに合計して返す。2026-11-25 ユーザー指示) ----------
// 工事番号ごとに1回だけ読む。結果 {koji, name, updated, marks} / 読めなければ {koji, error}。読み終わったものは ordersData に入る
const ordersPromise = new Map(), ordersData = new Map();
function ordersFor(koji) {
  koji = String(koji || '').trim();
  if (!koji) return Promise.resolve(null);
  if (!ordersPromise.has(koji)) {
    ordersPromise.set(koji, apiGet('orders', { koji }).then(j => {
      if (!j.marks) throw new Error('GASが古いため読めません(Code.gs の貼り替えが必要です)');
      return j;
    }).catch(e => ({ koji, error: e.message })).then(o => { ordersData.set(koji, o); return o; }));
  }
  return ordersPromise.get(koji);
}
// 製品の工事番号(次の加工予定は工事ごと、それ以外は選んだ工事)の注文書(読めていなければ null)
const kojiOf = t => t.koji || state.kojiNo;
const ordersOf = koji => { const o = ordersData.get(koji); return o && o.marks ? o : null; };
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

// 工事リスト・サーバーを画面に入れる。first = 最初の1回(前回選んだ工事・工場を選んでおく)。2回目以降は今選んでいる工事を残す
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
// 前回の工事リストがあれば、それをすぐ出して返す(GASの返事を待たない。GASは1〜4秒かかる)。裏でGASから読み、変わっていれば置き換える
async function loadSettings() {
  let cached = null;
  try { cached = JSON.parse(localStorage.getItem(LS_SETTINGS) || 'null'); } catch (e) { cached = null; }
  if (cached && Array.isArray(cached.koji)) applySettings(cached, true); else cached = null;
  const fresh = apiGet('settings').then(j => {
    const v = { koji: j.koji || [], servers: j.servers || [] };
    try { localStorage.setItem(LS_SETTINGS, JSON.stringify(v)); } catch (e) { /* なし */ }
    if (!cached || JSON.stringify(v) !== JSON.stringify({ koji: cached.koji || [], servers: cached.servers || [] })) applySettings(v, !cached);
  }).catch(e => {
    if (cached) return;   // 前回の工事リストで続けられる
    $('koji-select').innerHTML = '<option value="" disabled selected>工事リストを読めませんでした</option>';
    $('koji-msg').textContent = e.message + '(GASのURLを設定するまでは開始できません)';
    updateStartBtn();
  });
  if (!cached) await fresh;
}
$('start-btn').addEventListener('click', () => {
  const no = $('koji-select').value, k = state.kojiList.find(x => x.no === no);
  state.kojiNo = no; state.kojiName = k ? k.name : '';
  try { localStorage.setItem(LS_KEY, JSON.stringify({ kojiNo: no, factory: state.factory })); } catch (e) { /* なし */ }
  apiPostQuiet({ action: 'start', koji: state.kojiName, factory: state.factory });
  $('koji-label').textContent = `${state.factory}工場 / ${state.kojiNo} ${state.kojiName}`;
  moveManualButtonToHeader();   // 起動画面を閉じる前に呼ぶ(カードの中の位置から動かすため)
  $('start-modal').classList.add('hidden');
  document.body.classList.add('app-started'); state.started = true;
  renderServer();
  render();
  preloadPy();
  ordersFor(state.kojiNo).then(() => render());
});
$('btn-change').addEventListener('click', () => { $('start-modal').classList.remove('hidden'); });
$('start-cancel-btn').addEventListener('click', () => { $('start-modal').classList.add('hidden'); });

// ---------- アプリ説明書(manual/p-N.jpg。作り方は docs/manual-draft-kanamono/README.md) ----------
// ページ数を変えたら MANUAL_PAGES、画像を差し替えたら MANUAL_V も直す
const MANUAL_PAGES = 13, MANUAL_V = '20261126a';
let manualPage = 1;
const manualSrc = n => `manual/p-${n}.jpg?v=${MANUAL_V}`;
function showManualPage(n) {
  manualPage = Math.max(1, Math.min(MANUAL_PAGES, n));
  $('manual-image').src = manualSrc(manualPage);
  $('manual-page-indicator').textContent = `${manualPage} / ${MANUAL_PAGES}`;
  $('manual-prev').disabled = manualPage === 1;
  $('manual-next').disabled = manualPage === MANUAL_PAGES;
  if (manualPage < MANUAL_PAGES) new Image().src = manualSrc(manualPage + 1);   // 次のページを先に読んでおく
}
const manualOpen = () => $('manual-overlay').classList.contains('open');
function openManual() { $('manual-overlay').classList.add('open'); showManualPage(1); }
function closeManual() { $('manual-overlay').classList.remove('open'); }
$('manual-btn').addEventListener('click', openManual);
$('manual-close').addEventListener('click', closeManual);
$('manual-prev').addEventListener('click', () => showManualPage(manualPage - 1));
$('manual-next').addEventListener('click', () => showManualPage(manualPage + 1));
document.addEventListener('keydown', e => {
  if (!manualOpen()) return;
  if (e.key === 'ArrowLeft') showManualPage(manualPage - 1);
  else if (e.key === 'ArrowRight') showManualPage(manualPage + 1);
  else if (e.key === 'Escape') closeManual();
});
// 「開始」を押したとき、説明書のボタンを起動画面のカードからヘッダーの「工場・工事の変更」の右へ移す(tdf-master-web と同じ FLIP:
// 先に移動先へ置き、元の位置・大きさとの差を transform で戻してから外すと、縮みながら移って見える)。
// 2回目以降(「工場・工事の変更」から開始し直したとき)は何もしない
function moveManualButtonToHeader() {
  const btn = $('manual-btn'), change = $('btn-change');
  if (!btn || !change || btn.classList.contains('manual-btn-header')) return;
  const first = btn.getBoundingClientRect();
  btn.classList.remove('manual-btn'); btn.classList.add('manual-btn-header');
  btn.textContent = '説明書';
  change.insertAdjacentElement('afterend', btn);
  if (!first.width) return;   // 起動画面を出さずに始めたとき(次の加工予定)は、動かさずに置くだけ
  const last = btn.getBoundingClientRect();
  btn.style.position = 'relative'; btn.style.zIndex = '2500'; btn.style.transformOrigin = 'top left'; btn.style.transition = 'none';
  btn.style.transform = `translate(${first.left - last.left}px, ${first.top - last.top}px) scale(${first.width / last.width}, ${first.height / last.height})`;
  void btn.offsetWidth;   // 上の transform を一度確実に反映させる
  requestAnimationFrame(() => { btn.style.transition = 'transform .6s cubic-bezier(0.22, 1, 0.36, 1)'; btn.style.transform = 'none'; });
  // 動きが終わったら元に戻す(transitionend が来ないとき(タブが裏にある等)のために、時間でも戻す)
  const reset = () => { ['transition', 'zIndex', 'position', 'transformOrigin', 'transform'].forEach(k => { btn.style[k] = ''; }); };
  btn.addEventListener('transitionend', reset, { once: true });
  setTimeout(reset, 900);
}

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
// 1回開いたものを使い回す(2026-11-25。以前は読み書きのたびに開き直していた)。開けなかったら次は開き直す
let idbPromise = null;
function idb() {
  if (!idbPromise) {
    idbPromise = new Promise((res, rej) => { const r = indexedDB.open('tdf-kanamono-list', 1); r.onupgradeneeded = () => r.result.createObjectStore('kv'); r.onsuccess = () => res(r.result); r.onerror = () => rej(r.error); });
    idbPromise.catch(() => { idbPromise = null; });
  }
  return idbPromise;
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
  const errors = [], excluded = new Set(), included = new Set(), warns = [];
  try {
    for (const [i, { file: f, path }] of items.entries()) {
      step(i, 0, 'TDFを読み込んでいます…');
      try {
        if (state.tdfs.some(t => t.fileName === f.name && t.path === path)) { errors.push(`${f.name}: すでに取り込んでいます`); continue; }
        const buf = await f.arrayBuffer();
        const res = KanamonoExtract.extract(buf, f.name);
        if (!res.products.length) { errors.push(`${f.name}: 製品(「製品名 符号 N台」の行)が見つかりませんでした`); continue; }
        // 工事名が違うTDFは取り込まないので、長さ(Python)を読む前に止める(2026-11-21。以前は長さを読んでから止めていた)
        const base = state.tdfs[0];
        if (base && base.res.koji !== res.koji) { errors.push(`${f.name}: 工事名が違うため取り込みません(「${res.koji || '不明'}」。取り込み済みは「${base.res.koji}」)`); continue; }
        // 長さは tdf-master-web と同じ方法で求める(2026-11-20 ユーザー指示)。読めなければ図面の寸法から読んだ長さのまま
        try { await applyMasterLengths(buf, f.name, res, (r, msg) => step(i, r, msg)); }
        catch (e) { warns.push(`${f.name}: 長さを tdf-master-web と同じ方法で読めませんでした(${e.message})。図面の寸法から読んだ長さを使います`); }
        step(i, 1, 'TDFを読み込んでいます…');
        res.products.forEach(p => p.items.forEach(it => { it.n0 = it.n; }));
        state.tdfs.push({ id: nextId++, fileName: f.name, path: path || '', res });
        if (res.kojiNo && res.kojiNo !== state.kojiNo) warns.push(`${f.name}: 図面の工事番号(${res.kojiNo})が、選んだ工事(${state.kojiNo})と違います`);
        res.excluded.forEach(x => excluded.add(x));
        (res.included || []).forEach(x => included.add(x));
        res.warnings.forEach(w => warns.push(`${f.name}: ${w}`));
      } catch (e) { errors.push(`${f.name}: 読めませんでした(${e.message})`); }
    }
  } finally { idle(); }
  render();
  // 除外することもある金物(サヤ管)を図面から拾えたときは「抽出しました」と出す(2026-11-20 ユーザー指示)。拾えた図面と拾えなかった図面が混ざるときは「一部の図面で」
  const msg = [];
  const exOnly = Array.from(excluded).filter(x => !included.has(x)), both = Array.from(excluded).filter(x => included.has(x));
  // 文言(2026-11-21 ユーザー指示「サヤ管は金物リストに入れました/吊りピース・ネット受けピースは対象外のため入れていません」)
  if (included.size) msg.push(Array.from(included).join('・') + 'は金物リストに入れました');
  if (exOnly.length) msg.push(exOnly.join('・') + 'は対象外のため入れていません');
  if (both.length) msg.push(both.join('・') + 'は一部の図面で入れていません(図面から長さなどが読めなかったため)');
  if (msg.length) await notice('お知らせ', msg.join('\n'));
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
  // 図面番号順。同じ図面の中は製品番号順(EA11-3TB489-1, -2, … -18。2026-11-20 ユーザー指示。以前は図面に書かれた順)
  const out = [];
  state.tdfs.slice().sort((a, b) => KanamonoExtract.cmpNat(a.res.zuban || a.fileName, b.res.zuban || b.fileName)).forEach(t => {
    t.res.products.slice().sort((a, b) => KanamonoExtract.cmpNat(a.name, b.name)).forEach(p => out.push({ t, p }));
  });
  // 次の加工予定から作ったときは 工事 → 柱 → 大梁 → 小梁 → 製品番号順(runPlan が付けた ord。2026-11-21 ユーザー指示)
  if (out.length && out.every(x => typeof x.p.ord === 'number')) out.sort((a, b) => a.p.ord - b.p.ord);
  return out;
}
function render() {
  const has = state.tdfs.length > 0;
  $('btn-excel').disabled = !has; $('btn-reset').disabled = !has && !state.server;
  const prods = has ? allProducts() : [];
  // 取り込んだTDFの一覧も、下の金物リストと同じ並び(2026-11-21。以前は取り込んだ順だった)
  const listOrder = [];
  prods.forEach(({ t }) => { if (!listOrder.includes(t)) listOrder.push(t); });
  $('tdf-list').innerHTML = has ? '<table><tr><th>図面番号</th><th>工事名(図面)</th><th>ファイル名</th><th></th></tr>' +
    listOrder.map(t => `<tr><td>${esc(t.res.zuban)}</td><td>${esc(t.res.koji)}</td><td title="${esc(t.path || 'リンクなし')}">${esc(t.fileName)}${t.path ? '' : '(リンクなし)'}</td><td><button type="button" class="rm-btn" data-rm="${t.id}">外す</button></td></tr>`).join('') + '</table>' : '';
  const R = $('result');
  if (!has) { R.innerHTML = state.started ? '<div class="empty-msg">TDFを取り込むと、製品ごとの金物リストがここに出ます。<br>枚数(本数)と備考は直してからExcelに出せます。</div>' : ''; return; }
  // 重量と注文書の照合(工事ごと)。不足(注文書の合計より使う枚数が多い符号)は枚数を赤に
  const chkBy = new Map();
  prods.forEach(({ t, p }) => { const k = kojiOf(t); if (!chkBy.has(k)) chkBy.set(k, []); chkBy.get(k).push(p); });
  chkBy.forEach((ps, k) => chkBy.set(k, KanamonoExcel.checkMarks(ps, (ordersOf(k) || {}).marks)));
  let html = orderInfoHtml();
  prods.forEach(({ t, p }) => {
    const marks = (ordersOf(kojiOf(t)) || {}).marks, chk = chkBy.get(kojiOf(t));
    const link = jissunUrl(t.path, t.fileName), pIdx = t.res.products.indexOf(p);
    const zb = link ? `<a href="${esc(link)}" title="実寸法師で開く">${esc(p.zuban)}</a>` : `<span class="nolink" title="サーバーの場所が分からないため、リンクはありません">${esc(p.zuban)}</span>`;
    const nm = link ? `<a href="${esc(link)}" title="実寸法師で開く">${esc(p.name)}</a>` : `<span class="nolink" title="サーバーの場所が分からないため、リンクはありません">${esc(p.name)}</span>`;
    const items = p.items.map((it, idx) => ({ it, idx })).sort((a, b) => KanamonoExtract.cmpItem(a.it, b.it));
    html += `<div class="prod-card"><table class="kl">
      <tr class="phead"><td>図面番号</td><td>製品名</td><td>サイズ</td><td>長さ（mm）</td><td>台数</td><td class="gap"></td><td class="wcol"></td><td class="wcol"></td></tr>
      <tr class="pval"><td>${zb}</td><td>${nm}</td><td>${esc(p.size)}</td><td>${esc(p.length || '')}</td><td>${esc(p.dai)}</td><td class="gap"></td><td class="wcol"></td><td class="wcol"></td></tr>
      <tr class="lhead"><td>サイズ</td><td>切板名（長さ）</td><td>枚数（本数）</td><td>備考</td><td></td><td class="gap"></td><td class="wcol wh">単重（kg）</td><td class="wcol wh">重量（kg）</td></tr>` +
      items.map(({ it, idx }) => {
        const g = KanamonoExtract.kindOf(it.size) === 'GPL' ? ' gpl' : '';
        const c = chk[it.name], u = KanamonoExcel.unitWeight(it, marks);
        return `<tr class="item${g}"><td class="b">${esc(it.size)}</td><td class="b">${esc(it.name)}</td>
          <td class="b"><input class="qty${it.n !== it.n0 ? ' changed' : ''}${c && c.diff < 0 ? ' short' : ''}" type="number" min="0" value="${it.n}" data-t="${t.id}" data-p="${pIdx}" data-i="${idx}"${c ? ` title="手配総数 ${c.ord}・リスト全体で ${c.used}"` : ''}></td>
          <td class="note"><input class="note-in" value="${esc(it.note)}" data-t="${t.id}" data-p="${pIdx}" data-i="${idx}"></td><td></td><td class="gap"></td>
          <td class="wcol w-unit">${u === null ? '' : u}</td><td class="wcol w-total">${weightText(u, it.n)}</td></tr>`;
      }).join('') +
      `<tr class="sub"><td></td><td>小計</td><td>${subTotal(p)}</td><td></td><td></td><td class="gap"></td><td class="wcol"></td><td class="wcol w-sub">${subWeight(p, marks)}</td></tr></table></div>`;
  });
  R.innerHTML = html + '<div id="sum-area">' + summaryHtml() + '</div>';
}
function subTotal(p) { return p.items.reduce((a, it) => a + (it.n > 0 ? it.n : 0), 0); }
const r2 = x => Math.round(x * 100) / 100;
const weightText = (u, n) => u === null || !(n > 0) ? '' : r2(u * n);
// 製品の重量の小計(重量の分かるものだけ。1つも分からなければ空欄)
function subWeight(p, marks) {
  let s = 0, has = false;
  p.items.forEach(it => { if (!(it.n > 0)) return; const u = KanamonoExcel.unitWeight(it, marks); if (u !== null) { s += u * it.n; has = true; } });
  return has ? r2(s) : '';
}
// 注文書を読めたか(工事ごと)。読めないときは理由を出す
function orderInfoHtml() {
  const ks = [...new Set(state.tdfs.map(kojiOf))].filter(Boolean);
  if (!ks.length) return '';
  return '<div class="order-info">' + ks.map(k => {
    const o = ordersData.get(k);
    if (!o) return `注文書(${esc(k)}): 読み込み中…`;
    if (o.error) return `<span class="order-ng">注文書(${esc(k)})を読めませんでした: ${esc(o.error)}。重量は形鋼などだけ入れ、枚数の照合はしません</span>`;
    if (!o.name) return `<span class="order-ng">注文書(${esc(k)}.csv)がありません。重量は形鋼などだけ入れ、枚数の照合はしません</span>`;
    return `注文書: ${esc(o.name)}(${esc(o.updated)} 更新)。注文書より使う枚数が多い切板は、枚数が<span class="short-sample">赤</span>`;
  }).join('<br>') + '</div>';
}
// 総まとめ(Excelと同じ並び)
function summaryHtml() {
  // 注文書は工事が1つのときだけ(次の加工予定で工事が複数あるときは、Excel の工事ごとのシートで照合する)
  const ks = [...new Set(state.tdfs.map(kojiOf))];
  const lay = KanamonoExcel.layout({ kojiNo: state.kojiNo, koji: '' }, buildExportProducts(), state.tdfs.length > 1, ks.length === 1 ? ordersOf(ks[0]) : null);
  const cell = v => esc(v === null || v === undefined ? '' : v);
  let sumHtml = '', inSum = false;
  lay.rows.forEach(r => {
    if (r.kind === 'stitle') { inSum = true; sumHtml += `<div class="sum-title">${esc(r.vals[0])}</div>`; return; }
    if (!inSum) return;
    if (r.kind === 'cat') { sumHtml += (sumHtml.includes('<table') ? '</table></div>' : '') + `<div class="prod-card"><div class="cat-title">${esc(r.vals[0])}</div><table class="kl">`; return; }
    if (r.kind === 'shead') { sumHtml += '<tr class="shead"><td>サイズ</td><td>切板名（長さ）</td><td>枚数（本数）</td><td>備考</td><td>注文番号</td><td>単重（kg）</td><td>重量（kg）</td><td>手配総数</td><td>差し引き</td></tr>'; return; }
    if (r.kind === 'sitem' || r.kind === 'sitem_gpl') sumHtml += `<tr class="sitem${r.kind === 'sitem_gpl' ? ' gpl' : ''}"><td class="b">${cell(r.vals[0])}</td><td class="b">${cell(r.vals[1])}</td><td class="b">${cell(r.vals[2])}</td><td class="note">${cell(r.vals[3])}</td><td class="nos">${cell(r.vals[4])}</td><td>${cell(r.vals[6])}</td><td>${cell(r.vals[7])}</td><td>${cell(r.vals[10])}</td><td${r.short ? ' class="short"' : ''}>${cell(r.vals[11])}</td></tr>`;
  });
  if (sumHtml.includes('<table')) sumHtml += '</table></div>';
  return sumHtml;
}
document.addEventListener('click', e => {
  const rm = e.target.closest('[data-rm]');
  if (rm) { state.tdfs = state.tdfs.filter(t => String(t.id) !== rm.dataset.rm); render(); }
});
document.addEventListener('change', e => {
  const el = e.target; if (!el.dataset || !el.dataset.t) return;
  const t = state.tdfs.find(x => String(x.id) === el.dataset.t); if (!t) return;
  const it = t.res.products[+el.dataset.p].items[+el.dataset.i];
  const p = t.res.products[+el.dataset.p];
  if (el.classList.contains('qty')) { const v = parseInt(el.value, 10); it.n = isNaN(v) || v < 0 ? 0 : v; el.value = it.n; el.classList.toggle('changed', it.n !== it.n0); }
  if (el.classList.contains('note-in')) { it.note = el.value.trim(); el.value = it.note; }
  // 直した欄・その製品の小計・総まとめだけ書き換える(2026-11-21。以前は全体を描き直していて、Tab で次の欄へ移ると選択が外れた)
  const sub = el.closest('table.kl') && el.closest('table.kl').querySelector('tr.sub td:nth-child(3)');
  if (sub) sub.textContent = subTotal(p);
  if (el.classList.contains('qty')) refreshWeights(t);
  if ($('sum-area')) $('sum-area').innerHTML = summaryHtml();
});
// 確認はほかと同じアプリの確認画面で(2026-11-25。以前はブラウザ標準の確認窓)
// 枚数を直したとき: その工事の製品の重量・小計と、不足の赤を描き直す(表全体は描き直さない。Tab の選択を残す)
function refreshWeights(t0) {
  const k = kojiOf(t0), marks = (ordersOf(k) || {}).marks;
  const ps = allProducts().filter(x => kojiOf(x.t) === k);
  const chk = KanamonoExcel.checkMarks(ps.map(x => x.p), marks);
  document.querySelectorAll('input.qty').forEach(inp => {
    const t = state.tdfs.find(x => String(x.id) === inp.dataset.t); if (!t || kojiOf(t) !== k) return;
    const p = t.res.products[+inp.dataset.p], it = p.items[+inp.dataset.i], c = chk[it.name], tr = inp.closest('tr');
    inp.classList.toggle('short', !!(c && c.diff < 0));
    const wt = tr.querySelector('.w-total'); if (wt) wt.textContent = weightText(KanamonoExcel.unitWeight(it, marks), it.n);
    const ws = inp.closest('table.kl').querySelector('.w-sub'); if (ws) ws.textContent = subWeight(p, marks);
  });
}
$('btn-reset').addEventListener('click', async () => {
  if (!(await confirm2('リセット', '取り込んだTDF・修正・選んだサーバーをすべて消します。よろしいですか?', 'すべて消す', 'やめる'))) return;
  state.tdfs = []; state.server = null; state.root = null; state.planCtx = null; renderServer(); render();
});

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
const PY_FILES = ['tdf_binary.py', 'tdf_master_extractor.py', 'tdf_master_extractor_multi.py', 'tdf_app.py', 'tdf_column.py'];   // tdf_column = 柱モード(2026-11-20)
let pyPromise = null;
// onProgress(0〜1): 準備の段階(部品の読み込み・Python の起動・ファイル4つ・取り込み)ごとに呼ぶ
let pyProgress = null;
function loadPy(onProgress) {
  if (onProgress) pyProgress = onProgress;
  const tick = (k) => { if (pyProgress) pyProgress(k / (PY_FILES.length + 3)); };
  if (!pyPromise) {
    if (!onProgress) pyProgress = null;   // 裏で先に読むとき(preloadPy)は進み具合を出さない。前の取り込みの表示を使わない(2026-11-21)
    pyPromise = (async () => {
      tick(0);
      if (!window.loadPyodide) await new Promise((res, rej) => { const s = document.createElement('script'); s.src = PYODIDE_URL; s.onload = res; s.onerror = () => rej(new Error('Pythonの部品を読み込めませんでした')); document.head.appendChild(s); });
      tick(1);
      const py = await window.loadPyodide();
      tick(2);
      py.FS.mkdir('/mw');
      // 5つのファイルは同時に読む(2026-11-25。1つずつだと約0.1秒×5)
      let got = 0;
      await Promise.all(PY_FILES.map(async n => {
        const r = await fetch('py/' + n + '?v=' + PY_VER);
        if (!r.ok) throw new Error(n + ' を読み込めませんでした');
        py.FS.writeFile('/mw/' + n, await r.text());
        tick(3 + got++);
      }));
      await py.runPythonAsync("import sys, json\nsys.path.insert(0, '/mw')\nimport tdf_app\nimport tdf_column");
      tick(PY_FILES.length + 3);
      pyProgress = null;
      return py;
    })();
    pyPromise.catch(() => { pyPromise = null; pyProgress = null; });   // 失敗したら次は読み直す。進み具合の表示も外す
  }
  return pyPromise;
}
// [[製品マーク, 長さ(m)], …]。柱の図面(column)は tdf-master-web の柱モード(tdf_column)で求める(2026-11-20 ユーザー指摘「長さは？」。EB1-0C-04: 梁モードだと 368.1、柱モードは 3248.1)
async function masterLengths(buf, name, onProgress, column) {
  const py = await loadPy(onProgress);
  py.FS.writeFile('/input.tdf', new Uint8Array(buf));
  py.globals.set('tdf_filename', name);
  const mod = column ? 'tdf_column' : 'tdf_app';
  const out = await py.runPythonAsync("json.dumps([[r.get('製品マーク'), r.get('長さ')] for r in " + mod + ".extract_file('/input.tdf', tdf_filename)], ensure_ascii=False)");
  return JSON.parse(out);
}
// 長さを tdf-master-web と同じ方法で読んで、製品の長さを置き換える(TDFの取り込み・次の加工予定で共通)。step(0〜1, 文) = 進み具合
async function applyMasterLengths(buf, name, res, step) {
  const PREP = '長さを読む準備をしています…(初回だけ数秒かかります)';
  step(0.3, pyPromise ? '長さを読んでいます…' : PREP);
  const ml = await masterLengths(buf, name, r => step(0.3 + 0.6 * r, PREP), res.columnDrawing);
  res.products.forEach(p => { const m = ml.find(x => x[0] === p.name); if (m && m[1]) p.length = Math.round(m[1] * 10000) / 10; });
}
const PY_VER = '20261120d';
// 長さを読む Python の部品(約5MB。初回の準備に数秒)を、工場・工事を選んで開始したときに裏で読み始める(2026-11-21)。
// 最初のTDFを取り込むときの待ちを短くするため。失敗しても何も出さない(取り込むときに読み直す)
function preloadPy() { setTimeout(() => { loadPy().catch(() => {}); }, 300); }

let exceljsPromise = null;
function loadExcelJS() {
  if (window.ExcelJS) return Promise.resolve();
  if (!exceljsPromise) exceljsPromise = new Promise((res, rej) => { const s = document.createElement('script'); s.src = EXCELJS_URL; s.onload = res; s.onerror = () => { exceljsPromise = null; rej(new Error('Excelを作る部品を読み込めませんでした')); }; document.head.appendChild(s); });
  return exceljsPromise;
}
function pad(n) { return String(n).padStart(2, '0'); }
function stamp(d) { return `${d.getFullYear()}${pad(d.getMonth() + 1)}${pad(d.getDate())}_${pad(d.getHours())}${pad(d.getMinutes())}`; }
function saveXlsx(buf, name) {
  const url = URL.createObjectURL(new Blob([buf], { type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' }));
  const a = document.createElement('a'); a.href = url; a.download = name; document.body.appendChild(a); a.click(); a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 2000);
}
$('btn-excel').addEventListener('click', async () => {
  if (!state.tdfs.length) return;
  // 次の加工予定から作った画面なら、最初に届いたExcelと同じ形(シート１の一覧+工事ごとのシート)で、画面で直した数を入れて作り直す(2026-11-21)
  if (state.planCtx && allProducts().every(x => typeof x.p.ord === 'number')) { await downloadPlanExcel(state.planCtx, planGroupsFromScreen(state.planCtx)); return; }
  busy('Excelを作っています…');
  let saved = false;
  try {
    await loadExcelJS();
    const multi = state.tdfs.length > 1;
    const koji = state.tdfs[0].res.koji;
    const head = { kojiNo: state.kojiNo, koji };
    const orders = await ordersFor(state.kojiNo);
    const { wb, layout } = KanamonoExcel.build(window.ExcelJS, state.factory, head, buildExportProducts(), multi, orders && orders.marks ? orders : null);
    const buf = await wb.xlsx.writeBuffer();
    const name = multi ? `${state.kojiNo}_${stamp(new Date())}_金物リスト.xlsx`
      : `${state.tdfs[0].res.zuban || state.tdfs[0].fileName.replace(/\.tdf$/i, '')}_金物リスト.xlsx`;
    saveXlsx(buf, name); saved = true;
    apiPostQuiet({ action: 'download', koji: state.kojiName, factory: state.factory, rows: KanamonoExcel.toValues(layout) });
  } catch (e) { toast('Excelを作れませんでした: ' + e.message, 'error'); }
  finally { idle(); }
  if (saved) await linkNotice();
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
  moveManualButtonToHeader();
  $('koji-label').textContent = `鳥取工場 / 次の加工予定(${PLAN.rows.length}件)`;
  apiPostQuiet({ action: 'start', koji: '次の加工予定', factory: '鳥取' });
  const kojis = [...new Set(PLAN.rows.map(r => r.kojiNo || r.abbr))];
  kojis.forEach(k => { if (/^\d{2}-\d{2}$/.test(k)) ordersFor(k); });   // 注文書は先に読み始める
  renderServer();
  preloadPy();
  // サーバーは本社・鳥取のどちらか(鳥取サーバー固定ではない)。① のボタンで選び、毎回「①進行中工事」まで選ぶ(2026-11-20 ユーザー指示)
  await notice('次の加工予定の金物リスト',
    `${PLAN.src ? '「' + PLAN.src + '」の' : ''}次の加工予定(黄色) ${PLAN.rows.length}件\n(工事 ${kojis.join('・')})の金物リストを作ります。\n「① 本社サーバー」か「① 鳥取サーバー」を押し、\nサーバー内の「①進行中工事」を選ぶと、TDFを読み込みます。`, true);
}
// リンク表に無い行は、工事のフォルダの中から図番でTDFを探す(ファイル名「EA1-3B-04　260928.tdf」。2026-11-20 ユーザー指示)
// 工事のフォルダ = 同じ工事のリンクのある行の「①進行中工事」の次のフォルダ、無ければ名前が工事番号で始まるフォルダ
const zubanOf = name => { const m = /^(.+?)(?:[\s_]+(\d{6}))?\.tdf$/i.exec(nk(name)); return m ? { zuban: m[1].trim().toUpperCase(), date: m[2] || '' } : null; };
async function kojiDirName(root, rows, r, memo) {
  const key = r.kojiNo || r.abbr;
  if (memo.has(key)) return memo.get(key);   // 同じ工事は1回だけ探す(2026-11-21。以前は行ごとに「①進行中工事」を見直していた)
  const kd = await kojiDirName0(root, rows, r, key);
  memo.set(key, kd);
  return kd;
}
async function kojiDirName0(root, rows, r, key) {
  const hit = rows.find(x => x.segs && (x.kojiNo || x.abbr) === key);
  if (hit) return hit.segs[0];
  const no = nk(r.kojiNo);
  if (!no) return null;
  for await (const e of root.values()) if (e.kind === 'directory' && nk(e.name).startsWith(no) && !/[0-9]/.test(nk(e.name).charAt(no.length))) return e.name;
  return null;
}
// フォルダの中の TDF を全部(下のフォルダも)。図番 → [{segs, date}]
async function indexTdfs(dir, base, out, onDir) {
  onDir();
  for await (const e of dir.values()) {
    if (e.kind === 'directory') { try { await indexTdfs(e, base.concat(e.name), out, onDir); } catch (err) { /* 読めないフォルダは飛ばす */ } }
    else { const z = zubanOf(e.name); if (z) (out[z.zuban] = out[z.zuban] || []).push({ segs: base.concat(e.name), date: z.date }); }
  }
  return out;
}
async function findByZuban(root, rows) {
  const need = rows.filter(r => !r.link);
  if (!need.length) return;
  const idx = new Map(), memo = new Map();   // 工事のフォルダ名 → 図番の索引 / 工事 → 工事のフォルダ名
  try {
    for (const r of need) {
      const kd = await kojiDirName(root, rows, r, memo);
      if (!kd) { r.status = 'リンク表に無く、工事のフォルダも分かりません'; continue; }
      if (!idx.has(kd)) {
        let n = 0;
        busy(`マスタに無い製品をサーバーから探しています…\n${kd}`, 0);
        idx.set(kd, await indexTdfs(await root.getDirectoryHandle(kd), [kd], {}, () => { if (++n % 20 === 0) busy(`マスタに無い製品をサーバーから探しています…(${n}フォルダ)\n${kd}`, 0); }));
      }
      const c = (idx.get(kd)[nk(r.zuban).toUpperCase()] || []).slice().sort((a, b) => b.date.localeCompare(a.date));
      if (!c.length) { r.status = 'リンク表に無く、図番のTDFも見つかりません'; continue; }
      r.segs = c[0].segs; r.byZuban = true;   // 同じ図番が複数あればファイル名の日付の新しいもの
    }
  } finally { idle(); }
}
// 次の加工予定の並び(2026-11-21 ユーザー指示): 工事 → 柱 → 大梁 → 小梁 → その他 → 製品番号順。画面の表・Excel(1枚目・工事ごとのシート)とも。
// 部位は tottori が案件マスターから渡す(r.part)。無ければ図面から推定: 柱の詳細図なら柱、図番の区切りの記号(3G・RG=大梁、3B・RB=小梁、2C・0C=柱)。分からなければ「その他」
const PLAN_PARTS = ['柱', '大梁', '小梁'];
function guessPart(zuban, columnDrawing) {
  if (columnDrawing) return '柱';
  const segs = nk(zuban).toUpperCase().split('-');
  for (let i = segs.length - 2; i >= 0; i--) {
    const m = /^(?:[0-9A-Z]*[0-9][0-9A-Z]*|R|PH|K)([CGB])$/.exec(segs[i]);   // 数字を含む(3G・B1M2G)か R・PH・K で始まる記号だけ(「EB」のような工区の記号は見ない)
    if (m) return { C: '柱', G: '大梁', B: '小梁' }[m[1]];
  }
  return '';
}
const partRank = part => { const i = PLAN_PARTS.indexOf(part); return i < 0 ? PLAN_PARTS.length : i; };
const kojiKeyOf = r => r.kojiNo || r.abbr || '工事番号なし';
const cmpText = (a, b) => a < b ? -1 : a > b ? 1 : 0;
async function runPlan(plan) {
  const sv = state.server, root = state.root;
  if (!sv || !root) return;
  const rows = plan.rows.map(r => Object.assign({}, r, { status: '' }));
  const files = new Map();   // 「①進行中工事」からの場所 → {fileName, dir, res | err}
  rows.forEach(r => { r.segs = relFromLink(r.link, root.name); });
  await findByZuban(root, rows);
  rows.forEach(r => {
    if (r.status) return;
    if (!r.segs) r.status = 'TDFの場所が「①進行中工事」の中ではありません';
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
        try { await applyMasterLengths(buf, file.name, res, step); } catch (e) { /* 長さは図面の寸法から読んだもの */ }
        f.fileName = file.name; f.res = res;
        f.dir = [sv.path.replace(/[\\/]+$/, '')].concat(f.segs.slice(0, -1)).join('\\');
      } catch (e) { f.err = 'TDFを開けませんでした'; }
    }
  } finally { idle(); }
  rows.forEach(r => { const f = r.segs && files.get(r.segs.join('/')); r.partEff = r.part || guessPart(r.zuban, !!(f && f.res && f.res.columnDrawing)); });
  // 予定の行ごとに、TDFの中の同じ製品名の製品を使う。枚数は1台あたり × 予定の台数
  const groups = new Map();
  rows.forEach(r => {
    if (r.status) return;
    const f = files.get(r.segs.join('/'));
    if (f.err) { r.status = f.err; return; }
    const p = f.res.products.find(x => nk(x.name) === nk(r.mark));
    if (!p) { r.status = 'TDFにこの製品がありません'; return; }
    r.status = r.byZuban ? '作成(図番で探したTDF)' : '作成';
    if (!r.link) r.link = fileUrl(f.dir, f.fileName);   // 次の加工予定のシートのリンクも、見つけたTDFにする
    const key = kojiKeyOf(r);
    if (!groups.has(key)) groups.set(key, { sheet: key.replace(/[\\/?*\[\]:]/g, '_').slice(0, 31), head: { kojiNo: r.kojiNo || '', koji: f.res.koji || r.abbr || '' }, products: [], tdfs: [] });
    const g = groups.get(key), qty = Number(r.qty) || p.dai || 1;
    g.products.push({ zuban: p.zuban, name: p.name, size: p.size, length: p.length, dai: qty, link: r.link, rank: partRank(r.partEff),
      items: p.items.map(it => ({ size: it.size, name: it.name, n: it.n * qty, note: it.note })), src: p, f });
    if (!g.tdfs.includes(f)) g.tdfs.push(f);
  });
  // 並び: 工事 → 柱 → 大梁 → 小梁 → その他 → 製品番号順(1枚目の一覧の行も同じ)
  rows.sort((a, b) => cmpText(kojiKeyOf(a), kojiKeyOf(b)) || partRank(a.partEff) - partRank(b.partEff) || KanamonoExtract.cmpNat(nk(a.mark), nk(b.mark)));
  const gs = [...groups.keys()].sort(cmpText).map(k => groups.get(k));
  let ord = 0;
  gs.forEach(g => { g.products.sort((a, b) => a.rank - b.rank || KanamonoExtract.cmpNat(a.name, b.name)); g.products.forEach(x => { x.ord = ord++; }); });
  // 画面にも出す(作った製品だけ。画面の表もこの並び = 製品の ord)
  state.tdfs = [];
  gs.forEach(g => g.tdfs.forEach(f => {
    // 画面も予定の台数分(台数 = 予定の台数、枚数 = 1台あたり × 予定の台数。Excel と同じ。2026-11-21 ユーザー指示)。
    // 予定の行ごとに1つの製品(同じ製品が2行あっても、Excel と同じく2つ出す。2026-11-25。以前は1つにまとまり、画面から作り直すと1行消えた)
    const res = Object.assign({}, f.res, { products: g.products.filter(gp => gp.f === f).map(gp =>
      Object.assign({}, gp.src, { ord: gp.ord, dai: gp.dai, items: gp.src.items.map(it => Object.assign({}, it, { n: it.n * gp.dai, n0: it.n * gp.dai })) })) });
    state.tdfs.push({ id: nextId++, fileName: f.fileName, path: f.dir, res, koji: g.head.kojiNo });
  }));
  const minOrd = t => Math.min(...t.res.products.map(p => p.ord));
  state.tdfs.sort((a, b) => minOrd(a) - minOrd(b));
  render();
  if (!groups.size) { await notice('金物リストを作れませんでした', rows.map(r => `${r.abbr} ${r.mark}: ${r.status}`).join('\n')); return; }
  // 注文書(工事ごと。startPlan で読み始めている)が届いてから Excel を作る
  await Promise.all(gs.map(g => ordersFor(g.head.kojiNo)));
  gs.forEach(g => { g.orders = ordersOf(g.head.kojiNo); });
  render();
  // 画面の「Excelダウンロード」で作り直すときのために、一覧の行と工事ごとの製品(並び順 ord・リンク)を覚えておく
  state.planCtx = { rows, groups: gs.map(g => ({ sheet: g.sheet, head: g.head, prods: g.products.map(x => ({ ord: x.ord, link: x.link })) })) };
  await downloadPlanExcel(state.planCtx, gs);
  const miss = rows.filter(r => !/^作成/.test(r.status));
  if (miss.length) await notice('金物リストに入れなかった製品', miss.map(r => `${r.abbr} ${r.mark}(${r.zuban || '図番なし'}): ${r.status}`).join('\n') + '\n\n「次の加工予定」のシートには載せています。');
}

// 次の加工予定のExcel(シート１=一覧、シート２以降=工事ごと)を作ってダウンロードする
async function downloadPlanExcel(ctx, groups) {
  busy('Excelを作っています…');
  let saved = false;
  try {
    await loadExcelJS();
    const { wb, layouts } = KanamonoExcel.buildPlan(window.ExcelJS, ctx.rows, groups);
    saveXlsx(await wb.xlsx.writeBuffer(), `次の加工予定_金物リスト_${stamp(new Date())}.xlsx`); saved = true;
    layouts.forEach(l => apiPostQuiet({ action: 'download', koji: l.sheet, factory: '鳥取', rows: KanamonoExcel.toValues(l.layout) }));
  } catch (e) { toast('Excelを作れませんでした: ' + e.message, 'error'); }
  finally { idle(); }
  if (saved) await linkNotice();
}
// 画面の今の数・備考で、工事ごとの製品を作り直す(外したTDFの製品は入れない)
function planGroupsFromScreen(ctx) {
  const byOrd = new Map(allProducts().map(x => [x.p.ord, x.p]));
  return ctx.groups.map(g => ({ sheet: g.sheet, head: g.head, orders: ordersOf(g.head.kojiNo), products: g.prods.filter(x => byOrd.has(x.ord)).map(x => {
    const p = byOrd.get(x.ord);
    return { zuban: p.zuban, name: p.name, size: p.size, length: p.length, dai: p.dai, link: x.link, items: p.items.map(it => ({ size: it.size, name: it.name, n: it.n, note: it.note })) };
  }) })).filter(g => g.products.length);
}

loadSettings().then(() => { if (PLAN) startPlan(); });
// 長さを読む Python の部品は、ページを開いたらすぐ裏で読み始める(2026-11-25 ユーザー承認。工事を選んでいる間に準備が終わる。以前は「開始」を押してから)
preloadPy();
render();
