// 製品別金物リスト(tdf) — 画面の動き。抽出は extract.js、Excelは excel.js。
// 仕様: docs/apps/tdf-kanamono-list.md
'use strict';

// GASのウェブアプリURL(スプレッドシート「製品別金物一覧アプリ」の gas/Code.gs をデプロイしたもの)。空の間は工事リストを読めない
const GAS_URL = '';
const EXCELJS_URL = 'https://cdnjs.cloudflare.com/ajax/libs/exceljs/4.4.0/exceljs.min.js';
const LS_KEY = 'tdf-kanamono-list:last';

const state = {
  factory: '', kojiNo: '', kojiName: '',
  kojiList: [], servers: [],
  tdfs: [],          // {id, fileName, path, res}
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

// ---------- フォルダの場所(パス) ----------
function askPath(title, initial) {
  return new Promise(resolve => {
    $('path-title').textContent = title || 'TDFが入っているフォルダの場所(パス)を入力してください';
    $('path-text').value = initial || '';
    $('path-modal').classList.add('open');
    const done = v => { $('path-modal').classList.remove('open'); resolve(v); };
    $('path-ok').onclick = () => done($('path-text').value.trim().replace(/^"(.*)"$/, '$1'));
    $('path-skip').onclick = () => done('');
    $('path-paste').onclick = async () => {
      try { $('path-text').value = (await navigator.clipboard.readText()).trim().replace(/^"(.*)"$/, '$1'); }
      catch (e) { toast('クリップボードを読めませんでした。欄に直接貼り付けてください', 'error'); }
    };
  });
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
function idb() {
  return new Promise((res, rej) => { const r = indexedDB.open('tdf-kanamono-list', 1); r.onupgradeneeded = () => r.result.createObjectStore('kv'); r.onsuccess = () => res(r.result); r.onerror = () => rej(r.error); });
}
async function idbGet(k) { const d = await idb(); return new Promise(res => { const q = d.transaction('kv').objectStore('kv').get(k); q.onsuccess = () => res(q.result); q.onerror = () => res(undefined); }); }
async function idbSet(k, v) { const d = await idb(); return new Promise(res => { const t = d.transaction('kv', 'readwrite'); t.objectStore('kv').put(v, k); t.oncomplete = () => res(); t.onerror = () => res(); }); }

function chooseServer() {
  return new Promise(resolve => {
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
async function pickFolder() {
  if (!window.showDirectoryPicker) { toast('このブラウザはフォルダを選べません(Edge・Chromeで使ってください)。ファイルを選んで取り込めます', 'error'); return; }
  const sv = await chooseServer(); if (!sv) return;
  let root = await idbGet('root:' + sv.name);
  try {
    if (root && (await root.queryPermission({ mode: 'read' })) !== 'granted') {
      if ((await root.requestPermission({ mode: 'read' })) !== 'granted') root = null;
    }
  } catch (e) { root = null; }
  if (!root) {
    await notice(`${sv.name}の「①進行中工事」を覚えます`, `次の画面で、${sv.name}サーバーの「①進行中工事」フォルダを選んでください(最初の1回だけ)。`);
    try { root = await window.showDirectoryPicker({ id: 'root-' + sv.name, mode: 'read' }); } catch (e) { return; }
    await idbSet('root:' + sv.name, root);
  }
  let dir;
  try { dir = await window.showDirectoryPicker({ id: 'tdf-' + sv.name, startIn: root, mode: 'read' }); } catch (e) { return; }
  let rel = null;
  try { rel = await root.resolve(dir); } catch (e) { rel = null; }
  let path;
  if (rel) path = [sv.path.replace(/[\\/]+$/, '')].concat(rel).join('\\');
  else path = await askPath(`選んだフォルダ「${dir.name}」の場所(パス)を入力してください(「①進行中工事」の外のフォルダです)`, sv.path.replace(/[\\/]+$/, '') + '\\' + dir.name);
  const files = [];
  for await (const [name, h] of dir.entries()) if (h.kind === 'file' && /\.tdf$/i.test(name)) files.push(await h.getFile());
  if (!files.length) { toast(`「${dir.name}」にTDFがありません`, 'error'); return; }
  await importFiles(files, path);
}

// ---------- 取り込み ----------
async function importFiles(files, path) {
  if (!state.started) { toast('先に工場と工事を選んでください', 'error'); return; }
  files = Array.from(files).filter(f => /\.tdf$/i.test(f.name));
  if (!files.length) return;
  if (path === undefined) path = await askPath();
  busy('TDFを読み込んでいます…');
  const errors = [], excluded = new Set(), warns = [];
  try {
    for (const f of files) {
      try {
        if (state.tdfs.some(t => t.fileName === f.name && t.path === path)) { errors.push(`${f.name}: すでに取り込んでいます`); continue; }
        const res = KanamonoExtract.extract(await f.arrayBuffer(), f.name);
        if (!res.products.length) { errors.push(`${f.name}: 製品(「製品名 符号 N台」の行)が見つかりませんでした`); continue; }
        const base = state.tdfs[0];
        if (base && base.res.koji !== res.koji) { errors.push(`${f.name}: 工事名が違うため取り込みません(「${res.koji || '不明'}」。取り込み済みは「${base.res.koji}」)`); continue; }
        res.products.forEach(p => p.items.forEach(it => { it.orig = it.n; it.n0 = it.n; }));
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
    state.tdfs.map(t => `<tr><td>${esc(t.res.zuban)}</td><td>${esc(t.res.koji)}</td><td>${esc(t.fileName)}</td><td>${esc(t.path || '(リンクなし)')}</td><td><button type="button" class="rm-btn" data-rm="${t.id}">外す</button></td></tr>`).join('') + '</table>' : '';
  const R = $('result');
  if (!has) { R.innerHTML = state.started ? '<div class="empty-msg">TDFを取り込むと、製品ごとの金物リストがここに出ます。<br>枚数(本数)と備考は直してからExcelに出せます。</div>' : ''; return; }
  let html = '';
  allProducts().forEach(({ t, p }, pi) => {
    const link = jissunUrl(t.path, t.fileName);
    const zb = link ? `<a href="${esc(link)}" title="実寸法師で開く">${esc(p.zuban)}</a>` : `<span class="nolink" title="フォルダの場所が無いので開けません">${esc(p.zuban)}</span>`;
    const nm = link ? `<a href="${esc(link)}" title="実寸法師で開く">${esc(p.name)}</a>` : `<span class="nolink">${esc(p.name)}</span>`;
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
