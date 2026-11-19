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
  lastServer: '',
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
function busy(msg) { $('status-text').textContent = msg || '処理中…'; $('status-overlay').classList.add('open'); }
function idle() { $('status-overlay').classList.remove('open'); }
function notice(title, body) {
  return new Promise(resolve => {
    $('notice-title').textContent = title; $('notice-body').textContent = body;
    $('notice-modal').classList.add('open');
    $('notice-ok').onclick = () => { $('notice-modal').classList.remove('open'); resolve(); };
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

function chooseServer(title) {
  return new Promise(resolve => {
    document.querySelector('#server-modal .dialog-title').textContent = title || '図面があるサーバーを選んでください';
    const list = $('server-list');
    list.innerHTML = '';
    if (!state.servers.length) $('server-msg').textContent = 'スプレッドシートの設定シート(E列・F列)にサーバーがありません。';
    state.servers.forEach(s => {
      const b = document.createElement('button'); b.type = 'button'; b.className = 'server-btn'; b.textContent = s.name;
      b.onclick = () => { $('server-modal').classList.remove('open'); resolve(s); };
      list.appendChild(b);
    });
    $('server-back').onclick = () => { $('server-modal').classList.remove('open'); resolve(null); };
    $('server-modal').classList.add('open');
  });
}
const SKIP_DIR = /旧|発行歴/;
async function listDir(dir) { const out = []; try { for await (const e of dir.values()) out.push(e); } catch (e) { /* 読めないフォルダは飛ばす */ } return out; }
// ①進行中工事の中で、名前が工事番号で始まるフォルダ(26-17 と 26-170 は区別する)
async function findKojiDir(root, no) {
  return (await listDir(root)).find(d => d.kind === 'directory' && (d.name === no || (d.name.startsWith(no) && !/[0-9]/.test(d.name.charAt(no.length))))) || null;
}
// 工事フォルダの下を全部たどり、TDFのあるフォルダごとにまとめる(旧・発行歴は除く)
async function scanTdf(kojiDir) {
  const groups = new Map(); const queue = [{ dir: kojiDir, rel: [] }]; let seen = 0;
  while (queue.length) {
    const batch = queue.splice(0, 8);
    await Promise.all(batch.map(async ({ dir, rel }) => {
      seen++; busy(`TDFを探しています…(${seen} フォルダ目)`);
      for (const e of await listDir(dir)) {
        if (e.kind === 'directory') { if (!SKIP_DIR.test(e.name)) queue.push({ dir: e, rel: rel.concat(e.name) }); }
        else if (/\.tdf$/i.test(e.name)) { const k = rel.join('\\'); if (!groups.has(k)) groups.set(k, { rel, files: [] }); groups.get(k).files.push(e); }
      }
    }));
  }
  const ja = (a, b) => a.localeCompare(b, 'ja', { numeric: true });
  return [...groups.values()].map(g => (g.files.sort((a, b) => ja(a.name, b.name)), g)).sort((a, b) => ja(a.rel.join('\\'), b.rel.join('\\')));
}
// サーバーの「①進行中工事」(初回だけ選んで、ブラウザに覚える)
async function getRoot(sv, ask) {
  let root = await idbGet('root:' + sv.name);
  try {
    if (root) {
      let perm = await root.queryPermission({ mode: 'read' });
      if (perm !== 'granted' && ask) perm = await root.requestPermission({ mode: 'read' });
      if (perm !== 'granted') root = ask ? null : undefined;
    }
  } catch (e) { root = null; }
  if (root || !ask) return root || null;
  await notice(`${sv.name}の「①進行中工事」を覚えます`, `次の画面で、${sv.name}サーバーの「①進行中工事」フォルダを選んでください(最初の1回だけ)。`);
  try { root = await window.showDirectoryPicker({ id: 'root-' + sv.name, mode: 'read' }); } catch (e) { return null; }
  await idbSet('root:' + sv.name, root);
  return root;
}
function choosePick(title, note, groups, taken) {
  return new Promise(resolve => {
    $('pick-title').textContent = title; $('pick-note').textContent = note;
    const list = $('pick-list'); list.innerHTML = '';
    const boxes = [];
    groups.forEach((g, gi) => {
      const det = document.createElement('details');
      const sum = document.createElement('summary');
      const cb = document.createElement('input'); cb.type = 'checkbox';
      sum.append(cb, Object.assign(document.createElement('span'), { className: 'pick-dir', textContent: ' ' + (g.rel.join('\\') || '(工事フォルダの直下)') }),
        Object.assign(document.createElement('span'), { className: 'pick-count', textContent: g.files.length + ' ファイル' }));
      det.appendChild(sum);
      const fcs = g.files.map(f => {
        const lab = document.createElement('label'); lab.className = 'pick-file';
        const fc = document.createElement('input'); fc.type = 'checkbox';
        const isTaken = taken.has(g.rel.join('\\') + '\\' + f.name);
        lab.append(fc, document.createTextNode(' ' + f.name + (isTaken ? '(取り込み済み)' : '')));
        det.appendChild(lab); boxes.push({ fc, g, f, isTaken });
        fc.addEventListener('change', update);
        return fc;
      });
      cb.addEventListener('click', e => e.stopPropagation());
      cb.addEventListener('change', () => { fcs.forEach((fc, i) => { fc.checked = cb.checked && !boxes.find(b => b.fc === fc).isTaken; }); update(); });
      list.appendChild(det);
    });
    function update() { const n = boxes.filter(b => b.fc.checked).length; $('pick-ok').textContent = `取り込む(${n} ファイル)`; $('pick-ok').disabled = n === 0; }
    update();
    $('pick-all').onclick = () => { boxes.forEach(b => { b.fc.checked = !b.isTaken; }); update(); };
    $('pick-none').onclick = () => { boxes.forEach(b => { b.fc.checked = false; }); update(); };
    const close = v => { $('pick-modal').classList.remove('open'); resolve(v); };
    $('pick-cancel').onclick = () => close(null);
    $('pick-ok').onclick = () => close(boxes.filter(b => b.fc.checked));
    $('pick-modal').classList.add('open');
  });
}
async function pickFolder() {
  if (!state.started) { toast('先に工場と工事を選んでください', 'error'); return; }
  if (!window.showDirectoryPicker) { toast('このブラウザはフォルダを読めません(Edge・Chromeで使ってください)', 'error'); return; }
  const sv = await chooseServer(); if (!sv) return;
  let root = await getRoot(sv, true); if (!root) return;
  let kojiDir = await findKojiDir(root, state.kojiNo);
  if (!kojiDir) {
    await notice('工事のフォルダが見つかりません', `${sv.name}の「${root.name}」の中に、${state.kojiNo} で始まるフォルダがありません。\nサーバーが違うか、覚えたフォルダが「①進行中工事」ではない可能性があります。次の画面で、${sv.name}の「①進行中工事」を選び直してください。`);
    await idbSet('root:' + sv.name, null);
    root = await getRoot(sv, true); if (!root) return;
    kojiDir = await findKojiDir(root, state.kojiNo);
    if (!kojiDir) { toast(`${state.kojiNo} で始まるフォルダが見つかりませんでした`, 'error'); return; }
  }
  state.lastServer = sv.name;
  let groups;
  try { groups = await scanTdf(kojiDir); } finally { idle(); }
  if (!groups.length) { toast(`「${kojiDir.name}」の下にTDFがありません`, 'error'); return; }
  const kojiPath = sv.path.replace(/[\\/]+$/, '') + '\\' + kojiDir.name;
  const taken = new Set(state.tdfs.filter(t => t.path.startsWith(kojiPath)).map(t => t.path.slice(kojiPath.length + 1) + '\\' + t.fileName).map(s => s.replace(/^\\/, '')));
  const picked = await choosePick(`${sv.name} ／ ${kojiDir.name} の下でTDFがあるフォルダ(${groups.length} か所)`,
    'フォルダ名の左のチェックでそのフォルダのTDFをまとめて選べます。▶を押すとファイルを1つずつ選べます。名前に「旧」「発行歴」を含むフォルダは外しています。', groups, taken);
  if (!picked || !picked.length) return;
  const items = [];
  for (const b of picked) items.push({ file: await b.f.getFile(), path: [kojiPath].concat(b.g.rel).join('\\') });
  await importItems(items);
}
// ファイル選択・ドラッグ&ドロップのTDFは、覚えたサーバーの工事フォルダで同じ名前のTDFを探してリンクの場所にする(見つからなければリンクなし)
async function findPaths(names) {
  const out = new Map();
  const svs = state.servers.slice().sort((a, b) => (a.name === state.lastServer ? -1 : 0) - (b.name === state.lastServer ? -1 : 0));
  for (const sv of svs) {
    if (out.size === names.length) break;
    const root = await getRoot(sv, false); if (!root) continue;
    const kojiDir = await findKojiDir(root, state.kojiNo); if (!kojiDir) continue;
    let groups; try { groups = await scanTdf(kojiDir); } finally { idle(); }
    const kojiPath = sv.path.replace(/[\\/]+$/, '') + '\\' + kojiDir.name;
    groups.forEach(g => g.files.forEach(f => { if (names.includes(f.name) && !out.has(f.name)) out.set(f.name, [kojiPath].concat(g.rel).join('\\')); }));
  }
  return out;
}

// ---------- 取り込み ----------
async function importFiles(files) {
  if (!state.started) { toast('先に工場と工事を選んでください', 'error'); return; }
  files = Array.from(files).filter(f => /\.tdf$/i.test(f.name));
  if (!files.length) return;
  const names = files.map(f => f.name);
  let paths = new Map();
  try { paths = await findPaths(names); } catch (e) { /* 次で聞く */ }
  // 覚えたサーバーで見つからなければ、サーバーを選んでもらう(初回は①進行中工事を選んで覚える)
  if (names.some(n => !paths.has(n)) && window.showDirectoryPicker && state.servers.length) {
    const sv = await chooseServer('リンクを付けるため、このTDFがあるサーバーを選んでください(「戻る」でリンクなし)');
    if (sv) {
      const root = await getRoot(sv, true);
      if (root) {
        const kojiDir = await findKojiDir(root, state.kojiNo);
        if (kojiDir) {
          state.lastServer = sv.name;
          let groups; try { groups = await scanTdf(kojiDir); } finally { idle(); }
          const kojiPath = sv.path.replace(/[\\/]+$/, '') + '\\' + kojiDir.name;
          groups.forEach(g => g.files.forEach(f => { if (names.includes(f.name) && !paths.has(f.name)) paths.set(f.name, [kojiPath].concat(g.rel).join('\\')); }));
        } else {
          await notice('工事のフォルダが見つかりません', `${sv.name}の「${root.name}」の中に、${state.kojiNo} で始まるフォルダがありません。覚えたフォルダが「①進行中工事」でなければ、「📁 サーバーの工事フォルダから選ぶ」から選び直してください。`);
        }
      }
    }
  }
  const noLink = names.filter(n => !paths.has(n));
  await importItems(files.map(f => ({ file: f, path: paths.get(f.name) || '' })));
  if (noLink.length) await notice('リンクを付けられなかったTDF', noLink.join('\n') + '\n\n選んだ工事のフォルダの中に、同じ名前のTDFが見つかりませんでした。図番を押しても実寸法師は開きません(Excelにもリンクは付きません)。');
}
async function importItems(items) {
  busy('TDFを読み込んでいます…');
  const errors = [], excluded = new Set(), warns = [];
  try {
    for (const { file: f, path } of items) {
      try {
        if (state.tdfs.some(t => t.fileName === f.name && t.path === path)) { errors.push(`${f.name}: すでに取り込んでいます`); continue; }
        const res = KanamonoExtract.extract(await f.arrayBuffer(), f.name);
        if (!res.products.length) { errors.push(`${f.name}: 製品(「製品名 符号 N台」の行)が見つかりませんでした`); continue; }
        const base = state.tdfs[0];
        if (base && base.res.koji !== res.koji) { errors.push(`${f.name}: 工事名が違うため取り込みません(「${res.koji || '不明'}」。取り込み済みは「${base.res.koji}」)`); continue; }
        res.products.forEach(p => p.items.forEach(it => { it.n0 = it.n; }));
        state.tdfs.push({ id: nextId++, fileName: f.name, path: path || '', res });
        res.excluded.forEach(x => excluded.add(x));
        res.warnings.forEach(w => warns.push(`${f.name}: ${w}`));
      } catch (e) { errors.push(`${f.name}: 読めませんでした(${e.message})`); }
    }
  } finally { idle(); }
  render();
  if (excluded.size) await notice('お知らせ', Array.from(excluded).join('・') + 'は抽出していません');
  if (errors.length || warns.length) await notice('取り込めなかったTDF・確認が必要なこと', errors.concat(warns).join('\n'));
}
$('btn-files').addEventListener('click', () => $('file-input').click());
$('file-input').addEventListener('change', e => { const fs = Array.from(e.target.files); e.target.value = ''; importFiles(fs); });
$('btn-folder').addEventListener('click', pickFolder);
let dragDepth = 0;
document.addEventListener('dragenter', e => { e.preventDefault(); dragDepth++; $('drop-overlay').classList.add('active'); });
document.addEventListener('dragleave', e => { e.preventDefault(); if (--dragDepth <= 0) { dragDepth = 0; $('drop-overlay').classList.remove('active'); } });
document.addEventListener('dragover', e => e.preventDefault());
document.addEventListener('drop', e => { e.preventDefault(); dragDepth = 0; $('drop-overlay').classList.remove('active'); importFiles(e.dataTransfer.files); });

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
  $('btn-excel').disabled = !has; $('btn-reset').disabled = !has;
  $('tdf-list').innerHTML = has ? '<table><tr><th>図面番号</th><th>工事名(図面)</th><th>ファイル名</th><th>フォルダ</th><th></th></tr>' +
    state.tdfs.map(t => `<tr><td>${esc(t.res.zuban)}</td><td>${esc(t.res.koji)}</td><td>${esc(t.fileName)}</td><td class="path">${esc(t.path || '(リンクなし)')}</td><td><button type="button" class="rm-btn" data-rm="${t.id}">外す</button></td></tr>`).join('') + '</table>' : '';
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
$('btn-reset').addEventListener('click', () => { if (confirm('取り込んだTDFと修正をすべて消します。よろしいですか?')) { state.tdfs = []; render(); } });

// ---------- Excel ----------
function buildExportProducts() {
  return allProducts().map(({ t, p }) => ({
    zuban: p.zuban, name: p.name, size: p.size, length: p.length, dai: p.dai,
    link: fileUrl(t.path, t.fileName),
    items: p.items.map(it => ({ size: it.size, name: it.name, n: it.n, note: it.note })),
  }));
}
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

loadSettings();
render();
