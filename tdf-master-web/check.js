// ---------- 帳票チェックモード ----------
// 切断リスト・出荷リスト・マスターデータ等のExcelを取り込み、図番から最新の詳細図(TDF)を
// 探して抽出し、Excelのサイズ・長さ・本数・継手が図面と食い違っていないかを表で示す
// (梁モード・柱モードの逆。2026-11-09 ユーザーの仕様)。
//
// - 図面は「①進行中工事」フォルダから、工事番号で始まるフォルダ → その中の「詳細図」
//   フォルダの順に自動でたどる。ブラウザは利用者が選んだフォルダしか読めないので、
//   サーバー(本社・鳥取)ごとに「①進行中工事」を最初に1回選んでもらい、ブラウザの中
//   (IndexedDB)に覚える。工事フォルダ・詳細図フォルダを選んでもよい(下の「図面の保存場所」)。
// - 梁で読むか柱で読むかは、図面のフォルダ名に「柱詳細図」(間柱詳細図を含む)があれば柱。
// - 比べるのはExcelにある列だけ(継手の列が無ければ継手は比べない)。サイズは書き方の違い
//   (柱の板厚の有無・細くなる柱・せいが変わる梁)を同じとみなす。長さは±0.1mm。

let checkMode = false;
let checkResult = null;    // { fileName, sheet, hasJoint, rows, extra, stats }
let checkOnlyNg = true;    // 一致しない行だけ表示

const CHECK_DB = 'tdf-check';
const CHECK_STORE = 'handles';
const CHECK_ROOT_KEY = 'site-root';
const CHECK_SKIP_DIR = /旧|発行歴/;
const CHECK_LEN_TOL_MM = 0.1; // 長さの許容差(±0.1mm。2026-11-09 ユーザー指定)

// ---- フォルダを覚える(ブラウザの中だけ。PC・ブラウザごと) ----
const CHECK_EXTRACT_STORE = 'extract'; // 図面ごとの抽出結果(2回目から解析を飛ばす)
let checkDbPromise = null;
function checkIdb() {
  if (!checkDbPromise) {
    checkDbPromise = new Promise((res, rej) => {
      const r = indexedDB.open(CHECK_DB, 2);
      r.onupgradeneeded = () => {
        const db = r.result;
        if (!db.objectStoreNames.contains(CHECK_STORE)) db.createObjectStore(CHECK_STORE);
        if (!db.objectStoreNames.contains(CHECK_EXTRACT_STORE)) db.createObjectStore(CHECK_EXTRACT_STORE);
      };
      r.onsuccess = () => res(r.result);
      r.onerror = () => rej(r.error);
    }).catch(e => { checkDbPromise = null; throw e; });
  }
  return checkDbPromise;
}
async function checkIdbGet(key, store = CHECK_STORE) {
  try {
    const db = await checkIdb();
    return await new Promise((res, rej) => {
      const q = db.transaction(store).objectStore(store).get(key);
      q.onsuccess = () => res(q.result || null);
      q.onerror = () => rej(q.error);
    });
  } catch (_) { return null; }
}
async function checkIdbSet(key, val, store = CHECK_STORE) {
  try {
    const db = await checkIdb();
    await new Promise((res, rej) => {
      const q = db.transaction(store, 'readwrite').objectStore(store).put(val, key);
      q.onsuccess = () => res();
      q.onerror = () => rej(q.error);
    });
  } catch (e) { console.error('ブラウザに保存できませんでした', e); }
}
async function checkIdbClear(store) {
  try {
    const db = await checkIdb();
    await new Promise((res, rej) => {
      const q = db.transaction(store, 'readwrite').objectStore(store).clear();
      q.onsuccess = () => res();
      q.onerror = () => rej(q.error);
    });
  } catch (_) {}
}

// 抽出のPython(index.html に埋め込んだ5つ)の版。これが変われば覚えた抽出結果は使わない。
let checkScriptsVer = null;
async function checkScriptsVersion() {
  if (checkScriptsVer) return checkScriptsVer;
  const ids = ['py-tdf-binary', 'py-tdf-master-extractor', 'py-tdf-master-extractor-multi', 'py-tdf-app', 'py-tdf-column'];
  const text = ids.map(id => document.getElementById(id).textContent).join('\u0000');
  try {
    const buf = await crypto.subtle.digest('SHA-1', new TextEncoder().encode(text));
    checkScriptsVer = [...new Uint8Array(buf)].slice(0, 8).map(b => b.toString(16).padStart(2, '0')).join('');
  } catch (_) {
    let h = 0;
    for (let i = 0; i < text.length; i++) h = (h * 31 + text.charCodeAt(i)) | 0;
    checkScriptsVer = 'h' + (h >>> 0).toString(16) + text.length;
  }
  // 版が変わったら、前の版で覚えた抽出結果を消す(ブラウザの容量を使い続けないため)
  if ((await checkIdbGet('scripts-ver')) !== checkScriptsVer) {
    await checkIdbClear(CHECK_EXTRACT_STORE);
    await checkIdbSet('scripts-ver', checkScriptsVer);
  }
  return checkScriptsVer;
}

// 図面の保存場所(2026-11-09 ユーザー指示)
// - サーバーは2つ(本社・鳥取)。工場(加工先)とは関係なく、帳票チェックの画面のボタンで選ぶ
//   (鳥取で操作して本社サーバーの工事を見ることもある)。サーバーごとに「①進行中工事」を
//   最初に1回だけ選んでもらい、'server:本社/鳥取' に覚える。どちらを使ったかは工事ごとに覚える。
// - 工事フォルダ・詳細図フォルダを直接選んでもよい(その工事の分として 'koji:工事番号' に覚え、
//   サーバーより先に使う)。
// ブラウザは選ばれたフォルダの名前しか教えてくれない(上の階層のパスは読めない)ので、名前で見分ける。
//   root  : ①進行中工事(名前に工事番号も「詳細図」も無い)
//   koji  : 工事フォルダ(名前の先頭が工事番号)
//   detail: 詳細図フォルダ(名前に「詳細図」。工事番号が無いので、照合のときにExcelの図番が
//           どれだけ見つかるかで工事の違いを確かめる)
const CHECK_SERVERS = { honsha: '本社サーバー', tottori: '鳥取サーバー' };
let checkServerRoots = { honsha: null, tottori: null };
let checkServerSel = 'honsha';
let checkServerLoaded = false;
let checkKojiFolders = {}; // 工事番号 → 工事フォルダか詳細図フォルダ(無ければ null)

function checkKojiOfName(name) {
  const m = String(name).normalize('NFKC').match(/^(\d{2}-\d{2})(?![0-9])/);
  return m ? m[1] : null;
}
function checkFolderKind(h) {
  if (checkKojiOfName(h.name)) return 'koji';
  if (h.name.includes('詳細図')) return 'detail';
  return 'root';
}
function checkCurrentFolder() {
  return checkKojiFolders[kojiNo] || checkServerRoots[checkServerSel];
}

async function loadCheckRoot() {
  if (!checkServerLoaded) {
    for (const k of Object.keys(CHECK_SERVERS)) {
      const saved = await checkIdbGet('server:' + k);
      if (!checkServerRoots[k]) checkServerRoots[k] = saved; // 読んでいる間に選ばれたときはそちらを使う
    }
    // 前の版で覚えた「①進行中工事」(本社サーバーのもの)は本社サーバーの分として引き継ぐ
    if (!checkServerRoots.honsha) {
      const old = await checkIdbGet(CHECK_ROOT_KEY);
      if (old) { checkServerRoots.honsha = old; await checkIdbSet('server:honsha', old); }
    }
    checkServerLoaded = true;
  }
  if (kojiNo) {
    const sel = (await checkIdbGet('server-for:' + kojiNo)) || (await checkIdbGet('server-sel'));
    if (sel && CHECK_SERVERS[sel]) checkServerSel = sel;
    if (!(kojiNo in checkKojiFolders)) {
      const saved = await checkIdbGet('koji:' + kojiNo);
      if (!(kojiNo in checkKojiFolders)) checkKojiFolders[kojiNo] = saved;
    }
  }
  renderCheckFolder();
}

function renderCheckFolder() {
  const name = document.getElementById('check-folder-name');
  const own = checkKojiFolders[kojiNo];
  const root = checkServerRoots[checkServerSel];
  for (const k of Object.keys(CHECK_SERVERS)) {
    const b = document.getElementById('srv-' + k);
    b.classList.toggle('selected', !own && k === checkServerSel);
    b.textContent = CHECK_SERVERS[k] + (checkServerRoots[k] ? '' : '(未設定)');
  }
  if (own) {
    name.textContent = `${kojiNo} 用: ${own.name}(${checkFolderKind(own) === 'koji' ? '工事フォルダ' : '詳細図フォルダ'})`;
  } else if (root) {
    name.textContent = `${CHECK_SERVERS[checkServerSel]}の「${root.name}」から探します`;
  } else {
    name.textContent = `${CHECK_SERVERS[checkServerSel]}の「①進行中工事」が未設定です(最初に1回だけ選んでください)`;
  }
  name.classList.toggle('unset', !own && !root);
  document.getElementById('check-folder-clear').style.display = own ? '' : 'none';
}

async function checkPickDir() {
  if (!window.showDirectoryPicker) {
    showErrorDialog('このブラウザではフォルダを選べません', ['Microsoft Edge または Google Chrome で開いてください']);
    return null;
  }
  try {
    return await window.showDirectoryPicker({ id: 'tdf-site-root', mode: 'read' });
  } catch (e) {
    // 画面を閉じた(取り消した)ときも知らせる。Claude アプリの中のブラウザでは、選んでも
    // 取り消し扱いで返ってくる(2026-11-09 確認)
    if (e.name === 'AbortError') showToast('フォルダが選ばれませんでした', 'error');
    else showToast('フォルダを選べませんでした: ' + e.message, 'error');
    return null;
  }
}

async function checkSetServer(key) {
  checkServerSel = key;
  await checkIdbSet('server-sel', key);
  if (kojiNo) await checkIdbSet('server-for:' + kojiNo, key);
}

// サーバーのボタン。まだ「①進行中工事」を選んでいなければ、ここで1回だけ選ぶ
async function selectCheckServer(key) {
  if (!checkServerRoots[key]) {
    const h = await checkPickDir();
    if (!h) return;
    if (checkFolderKind(h) !== 'root') {
      showErrorDialog(`${CHECK_SERVERS[key]}の「①進行中工事」フォルダを選んでください`,
        [`選んだフォルダ: ${h.name}`, '工事フォルダ・詳細図フォルダは「フォルダを選ぶ」から選べます']);
      return;
    }
    checkServerRoots[key] = h;
    await checkIdbSet('server:' + key, h);
    showToast(`「${h.name}」を${CHECK_SERVERS[key]}として覚えました`, 'success');
  }
  await checkSetServer(key);
  // サーバーを選んだときは、この工事の分として覚えた工事・詳細図フォルダは使わない
  if (checkKojiFolders[kojiNo]) { checkKojiFolders[kojiNo] = null; await checkIdbSet('koji:' + kojiNo, null); }
  renderCheckFolder();
}

// 「フォルダを選ぶ」: ①進行中工事(今のサーバーの分として選び直す)・工事フォルダ・詳細図フォルダ
async function pickCheckRoot() {
  const h = await checkPickDir();
  if (!h) return;
  const kind = checkFolderKind(h);
  if (kind === 'root') {
    checkServerRoots[checkServerSel] = h;
    await checkIdbSet('server:' + checkServerSel, h);
    await checkSetServer(checkServerSel);
    if (checkKojiFolders[kojiNo]) { checkKojiFolders[kojiNo] = null; await checkIdbSet('koji:' + kojiNo, null); }
    showToast(`「${h.name}」を${CHECK_SERVERS[checkServerSel]}として覚えました`, 'success');
  } else {
    if (kind === 'koji') {
      const no = checkKojiOfName(h.name);
      if (no !== kojiNo) {
        const ok = await checkConfirm('工事番号が違います',
          `選んだフォルダの工事番号(${no})と、選んでいる工事(${kojiNo})が違います。`, 'このフォルダを使う', 'やめる');
        if (!ok) return;
      }
    }
    checkKojiFolders[kojiNo] = h;
    await checkIdbSet('koji:' + kojiNo, h);
    showToast(`「${h.name}」を ${kojiNo} 用に覚えました` + (kind === 'detail' ? '(照合のときに、Excelの図番が見つかるかで工事を確かめます)' : ''), 'success');
  }
  renderCheckFolder();
}

// 工事ごとに覚えたフォルダをやめて、サーバーの①進行中工事から探す
async function clearKojiFolder() {
  checkKojiFolders[kojiNo] = null;
  await checkIdbSet('koji:' + kojiNo, null);
  renderCheckFolder();
}

// ブラウザを開き直したあとは、読む許可をもう一度求める(利用者のクリックの中で呼ぶ)
async function checkRootPermission(folder, ask = true) {
  if (!folder) return false;
  if (!folder.queryPermission) return true;
  if ((await folder.queryPermission({ mode: 'read' })) === 'granted') return true;
  if (!ask) return false;
  try { return (await folder.requestPermission({ mode: 'read' })) === 'granted'; } catch (_) { return false; }
}

// ---- 図面を探す ----
let checkSkippedDirs = []; // 読めなかったフォルダ(権限が無い等)。止めずに飛ばして、あとで知らせる

async function checkListDir(dir) {
  const out = [];
  try {
    for await (const e of dir.values()) out.push(e);
  } catch (e) {
    checkSkippedDirs.push(dir.name + ': ' + e.message);
  }
  return out;
}

// ファイル名の先頭(空白・_・かっこの前まで)。図番と比べる。
function checkZkey(name) {
  return name.replace(/\.[^.]+$/, '').split(/[\s　_(（]/)[0];
}

async function checkFindKojiDir(root, no) {
  const dirs = (await checkListDir(root)).filter(e => e.kind === 'directory');
  return dirs.find(d => d.name === no || (d.name.startsWith(no) && !/[0-9]/.test(d.name.charAt(no.length)))) || null;
}

// 工事フォルダの下(3段まで)で、名前に「詳細図」を含むフォルダ(旧・発行歴は除く)
async function checkFindDetailDirs(kojiDir) {
  const found = [];
  let level = [kojiDir];
  for (let depth = 0; depth < 3 && level.length && !found.length; depth++) {
    const next = [];
    for (const d of level) {
      for (const e of await checkListDir(d)) {
        if (e.kind !== 'directory' || CHECK_SKIP_DIR.test(e.name)) continue;
        if (e.name.includes('詳細図')) found.push(e); else next.push(e);
      }
    }
    level = next;
  }
  return found;
}

// 詳細図フォルダの下を全部たどり、図番が need にあるTDFを集める(同時に8フォルダずつ読む)
async function checkWalkTdf(dirs, need, onProgress) {
  const found = new Map(); // 図番 → [{ handle, path }]
  const queue = dirs.map(d => ({ dir: d, path: [d.name] }));
  let done = 0;
  async function worker() {
    while (queue.length) {
      const { dir, path } = queue.shift();
      for (const e of await checkListDir(dir)) {
        if (e.kind === 'directory') {
          if (!CHECK_SKIP_DIR.test(e.name)) queue.push({ dir: e, path: path.concat(e.name) });
        } else if (/\.tdf$/i.test(e.name)) {
          const z = checkZkey(e.name);
          if (need.has(z)) {
            if (!found.has(z)) found.set(z, []);
            found.get(z).push({ handle: e, path: path.concat(e.name) });
          }
        }
      }
      done++;
      if (onProgress) onProgress(done, done + queue.length);
    }
  }
  await Promise.all(Array.from({ length: 8 }, worker));
  return found;
}

// ---- Excelを読む ----
function checkNorm(s) {
  return String(s ?? '').normalize('NFKC').replace(/\s+/g, '').trim();
}

// 見出しに「図番」「製品マーク」がある行を、各シートの先頭30行から探す
function checkReadExcel(buf) {
  const wb = XLSX.read(new Uint8Array(buf), { type: 'array', cellDates: true });
  for (const sheetName of wb.SheetNames) {
    const ws = wb.Sheets[sheetName];
    if (!ws || !ws['!ref']) continue;
    const aoa = XLSX.utils.sheet_to_json(ws, { header: 1, raw: true, defval: '' });
    const top = XLSX.utils.decode_range(ws['!ref']).s.r; // 表がA1から始まらないとき、Excelの行番号に直す
    for (let h = 0; h < Math.min(30, aoa.length); h++) {
      const head = aoa[h].map(checkNorm);
      if (!head.includes('図番') || !head.some(v => v.startsWith('製品マーク'))) continue;
      const col = (...keys) => head.findIndex(v => keys.some(k => v === k || v.startsWith(k + '(')));
      const ci = {
        zuban: col('図番'), mark: col('製品マーク'), size: col('サイズ'), len: col('長さ'), honsu: col('本数'),
        ja: col('左継手', '下継手'), jb: col('右継手', '上継手'),
      };
      const lenHead = ci.len >= 0 ? head[ci.len] : '';
      const rows = [];
      for (let r = h + 1; r < aoa.length; r++) {
        const row = aoa[r];
        const zuban = checkNorm(row[ci.zuban]), mark = checkNorm(row[ci.mark]);
        if (!zuban && !mark) continue;
        const g = i => (i < 0 ? undefined : row[i]);
        rows.push({ rowNo: top + r + 1, zuban, mark, size: g(ci.size), len: g(ci.len), honsu: g(ci.honsu), ja: g(ci.ja), jb: g(ci.jb) });
      }
      // 長さの単位: 見出しに(mm)・(m)があればそれ。無ければ値の大きさ(中央値が100未満ならm)
      let unit = /mm/i.test(lenHead) ? 'mm' : /\(m\)/i.test(lenHead) ? 'm' : null;
      if (!unit) {
        const v = rows.map(r => Number(r.len)).filter(x => isFinite(x) && x > 0).sort((a, b) => a - b);
        unit = v.length && v[Math.floor(v.length / 2)] < 100 ? 'm' : 'mm';
      }
      return { sheetName, rows, unit, cols: ci, hasSize: ci.size >= 0, hasLen: ci.len >= 0, hasHonsu: ci.honsu >= 0, hasJoint: ci.ja >= 0 || ci.jb >= 0 };
    }
  }
  throw new Error('見出しに「図番」「製品マーク」がある表が見つかりません');
}

// ---- 比べる ----
function checkSizeSame(xl, dw) {
  const n = s => String(s ?? '').normalize('NFKC').replace(/\s/g, '').replace(/[×X]/g, 'x');
  const a = n(xl), b = n(dw);
  if (a === b) return true;
  // 柱(□): 外形の数字だけ比べる。図面が節ごとに「_」で並ぶときは、どれかと同じなら一致
  if (a.startsWith('□-') && b.startsWith('□-')) {
    const ap = a.slice(2).split('x');
    return b.slice(2).split('_').some(sec => {
      const sp = sec.split('x');
      if (sp.length < 2 || sp[0] !== ap[0] || sp[1] !== ap[1]) return false;
      return !(sp.length >= 3 && ap.length >= 3 && sp[2] !== ap[2]);
    });
  }
  // せいが変わる梁: 頭・幅以降が同じで、Excelのせいの数字がすべて図面側に含まれれば一致
  const re = /^([A-Z]+)-([\d.\-~]+?)x(.+)$/;
  const m1 = a.match(re), m2 = b.match(re);
  if (m1 && m2 && m1[1] === m2[1] && m1[3] === m2[3]) {
    const d1 = m1[2].split(/[-~]/), d2 = new Set(m2[2].split(/[-~]/));
    if (d1.length > 1 || d2.size > 1) return d1.every(d => d2.has(d));
  }
  return false;
}

function checkQty(v) {
  const m = String(v ?? '').normalize('NFKC').match(/^\s*(\d+)/);
  return m ? Number(m[1]) : null;
}

function checkFmtLen(m) {
  return m == null ? '' : String(Number(Number(m).toFixed(4)));
}

function checkFmtDate(ms) {
  if (!ms) return '';
  const d = new Date(ms), p = n => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`;
}

// ---- 実行 ----
async function processCheckFile(files) {
  const file = Array.from(files).find(f => /\.xls[xm]?$/i.test(f.name));
  if (!file) { showToast('Excelファイルを選択してください', 'error'); return; }
  document.getElementById('check-file-input').value = '';
  if (!pyodide) { showToast('準備中です。しばらくお待ちください', 'error'); return; }

  // ファイル名の工事番号(工事のリストにある番号だけ)が、選んだ工事と違えば知らせる
  const known = new Set([...document.getElementById('koji-select').options].map(o => o.value).filter(Boolean));
  const inName = (file.name.normalize('NFKC').match(/\d{2}-\d{2}/g) || []).filter(n => known.has(n));
  if (inName.length && !inName.includes(kojiNo)) {
    const ok = await checkConfirm('工事番号が違います',
      `ファイル名の工事番号(${inName.join('・')})と、選んでいる工事(${kojiNo})が違います。`,
      'このまま続ける', 'やめる');
    if (!ok) return;
  }
  const folder = checkCurrentFolder();
  if (!folder) {
    showErrorDialog('図面のフォルダが未設定です', ['上の「フォルダを選ぶ」で「①進行中工事」(または工事フォルダ・詳細図フォルダ)を選んでください']);
    return;
  }
  if (!(await checkRootPermission(folder))) {
    showErrorDialog('フォルダを読む許可がありません', ['「フォルダを選ぶ」で選び直すか、許可の画面で「許可」を押してください']);
    return;
  }

  const t0 = performance.now();
  checkSkippedDirs = [];
  try {
    showStatus('Excelを読んでいます', file.name);
    const xl = checkReadExcel(await file.arrayBuffer());
    const need = new Set(xl.rows.map(r => r.zuban).filter(Boolean));

    // 選んだフォルダの種類に合わせて「詳細図」フォルダまでたどる
    const kind = checkFolderKind(folder);
    let detailDirs, label;
    if (kind === 'root') {
      showStatus('工事のフォルダを探しています', kojiNo);
      let kojiDir = await checkFindKojiDir(folder, kojiNo);
      if (!kojiDir) {
        // 選んでいるサーバーに無ければ、もう一方のサーバー(選んだことがあり、読む許可があるとき)も探す
        const other = Object.keys(CHECK_SERVERS).find(k => k !== checkServerSel);
        const oroot = checkServerRoots[other];
        if (oroot && (await checkRootPermission(oroot, false))) {
          kojiDir = await checkFindKojiDir(oroot, kojiNo);
          if (kojiDir) {
            await checkSetServer(other);
            renderCheckFolder();
            showToast(`${kojiNo} は${CHECK_SERVERS[other]}にありました(この工事は${CHECK_SERVERS[other]}を使います)`, 'success');
          }
        }
      }
      if (!kojiDir) throw new Error(`${CHECK_SERVERS[checkServerSel]}の「${folder.name}」の中に、${kojiNo} で始まるフォルダが見つかりません。サーバーのボタンで保存場所を確かめてください`);
      detailDirs = await checkFindDetailDirs(kojiDir);
      if (!detailDirs.length) throw new Error(`「${kojiDir.name}」の中に「詳細図」フォルダが見つかりません`);
      label = kojiDir.name;
    } else if (kind === 'koji') {
      detailDirs = await checkFindDetailDirs(folder);
      if (!detailDirs.length) throw new Error(`「${folder.name}」の中に「詳細図」フォルダが見つかりません`);
      label = folder.name;
    } else {
      detailDirs = [folder];
      label = folder.name;
    }

    const found = await checkWalkTdf(detailDirs, need, (d, total) =>
      showStatus('図面を探しています', `${label}  フォルダ ${d} / ${total}`));
    const t1 = performance.now();

    // Excelの図番の半分も見つからなければ、工事やフォルダが違う可能性を知らせる
    // (詳細図フォルダはフォルダ名に工事番号が無いので、ここで確かめる)
    if (need.size && found.size < need.size * 0.5) {
      hideStatus();
      const ok = await checkConfirm('図面があまり見つかりません',
        `Excelの図番 ${need.size} 件のうち、「${label}」で見つかったのは ${found.size} 件です。工事やフォルダが違う可能性があります。`,
        'このまま続ける', 'やめる');
      if (!ok) return;
    }

    // 抽出(図面ごとに1回)。更新日時・大きさ・抽出の版が前回と同じ図面は、覚えた結果を使う
    const files = [...found.values()].flat();
    const res = new Map(); // パス → { mode, rows, err, mtime }
    const ver = await checkScriptsVersion();
    let reused = 0;
    for (let i = 0; i < files.length; i++) {
      const f = files[i];
      const key = f.path.join('\\');
      const mode = f.path.some(p => p.includes('柱詳細図')) ? 'column' : 'beam';
      showStatus('図面を解析しています', `(${i + 1}/${files.length}) ${f.handle.name}` + (reused ? `  前回の結果を使用 ${reused} 件` : ''));
      try {
        const blob = await f.handle.getFile(); // ここでは中身は読まない(更新日時・大きさだけ)
        const ckey = [ver, kojiNo, key, blob.lastModified, blob.size].join('|');
        const saved = await checkIdbGet(ckey, CHECK_EXTRACT_STORE);
        if (saved && saved.mode === mode) {
          res.set(key, { mode, rows: saved.rows, err: null, mtime: blob.lastModified, path: f.path });
          reused++;
          continue;
        }
        pyodide.FS.writeFile('/input.tdf', new Uint8Array(await blob.arrayBuffer()));
        pyodide.globals.set('tdf_filename', f.handle.name);
        const py = await pyodide.runPythonAsync(`${mode === 'column' ? 'tdf_column' : 'tdf_app'}.extract_file('/input.tdf', tdf_filename)`);
        const rows = py.toJs({ dict_converter: Object.fromEntries });
        py.destroy();
        res.set(key, { mode, rows, err: null, mtime: blob.lastModified, path: f.path });
        await checkIdbSet(ckey, { mode, rows }, CHECK_EXTRACT_STORE);
      } catch (e) {
        res.set(key, { mode, rows: [], err: e.message, mtime: null, path: f.path });
      }
    }
    const t2 = performance.now();

    checkResult = checkCompare(xl, found, res);
    checkResult.fileName = file.name;
    checkResult.kojiDir = label;
    checkResult.times = { find: (t1 - t0) / 1000, extract: (t2 - t1) / 1000, files: files.length, reused };
    hideStatus();
    renderCheck();
    const s = checkResult.stats;
    showToast(`${s.total} 行を照合しました(一致 ${s.ok} / 一致しない ${s.total - s.ok})`, s.total === s.ok ? 'success' : '');
    if (checkSkippedDirs.length) showErrorDialog('読めなかったフォルダ(飛ばしました)', checkSkippedDirs);
  } catch (e) {
    hideStatus();
    console.error(e);
    showErrorDialog('照合できませんでした', [e.message]);
  }
}

function checkCompare(xl, found, res) {
  const byZuban = new Map(); // 図番 → [{ key, mode, row }]
  for (const [key, r] of res) {
    for (const row of r.rows) {
      const z = checkNorm(row['図番']);
      if (!byZuban.has(z)) byZuban.set(z, []);
      byZuban.get(z).push({ key, mode: r.mode, row });
    }
  }
  const used = new Set();
  const rows = xl.rows.map(x => {
    const out = { x, judge: '', bad: [], memo: [], dw: null, file: null };
    const files = found.get(x.zuban) || [];
    if (!files.length) { out.judge = '図面が見つからない'; return out; }
    out.file = res.get(files[0].path.join('\\'));
    const cand = (byZuban.get(x.zuban) || []).filter(c => checkNorm(c.row['製品マーク']) === x.mark);
    if (!cand.length) {
      const errs = files.map(f => res.get(f.path.join('\\'))).filter(r => r && r.err);
      out.judge = errs.length ? '図面を読めなかった' : '製品マークが図面に無い';
      if (!errs.length) {
        const marks = (byZuban.get(x.zuban) || []).map(c => c.row['製品マーク']);
        out.memo.push('図面の製品マーク: ' + (marks.length ? marks.join('、') : '(読めず)'));
      }
      return out;
    }
    const { key, mode, row } = cand[0];
    used.add(key + '\u0000' + x.mark);
    out.dw = row;
    out.file = res.get(key);
    if (xl.hasSize && !checkSizeSame(x.size, row['サイズ'])) out.bad.push('サイズ');
    if (xl.hasLen) {
      const xm = Number(x.len) * (xl.unit === 'm' ? 1000 : 1);
      if (row['長さ'] == null) { out.bad.push('長さ'); out.memo.push('図面から長さを読めなかった'); }
      else if (!isFinite(xm) || Math.abs(row['長さ'] * 1000 - xm) > CHECK_LEN_TOL_MM + 1e-6) out.bad.push('長さ');
    }
    if (row['長さの確認']) out.memo.push(`図面の長さは「${row['長さの確認']}」`);
    if (xl.hasHonsu && checkQty(x.honsu) !== checkQty(row['本数'])) out.bad.push('本数');
    if (xl.hasJoint) {
      const [ka, kb] = mode === 'column' ? ['下継手', '上継手'] : ['左継手', '右継手'];
      const eq = (p, q) => checkNorm(p) === checkNorm(q);
      if (xl.cols.ja >= 0 && !eq(x.ja, row[ka])) out.bad.push('継手A');
      if (xl.cols.jb >= 0 && !eq(x.jb, row[kb])) out.bad.push('継手B');
    }
    if (cand.length > 1) out.memo.push(`図面に同じ製品マークが${cand.length}行`);
    out.judge = out.bad.length ? '不一致' : '一致';
    return out;
  });
  // 図面にあってExcelに無い製品(Excelに載っている図面の中だけ)
  const extra = [];
  for (const z of new Set(xl.rows.map(r => r.zuban))) {
    for (const c of byZuban.get(z) || []) {
      const m = checkNorm(c.row['製品マーク']);
      if (!used.has(c.key + '\u0000' + m)) extra.push({ zuban: z, row: c.row, file: res.get(c.key) });
    }
  }
  const stats = { total: rows.length, ok: rows.filter(r => r.judge === '一致').length };
  ['不一致', '製品マークが図面に無い', '図面が見つからない', '図面を読めなかった'].forEach(k => { stats[k] = rows.filter(r => r.judge === k).length; });
  return { xl, rows, extra, stats, hasJoint: xl.hasJoint };
}

// ---- 表示 ----
const CHECK_JUDGE_CLASS = { '一致': 'ok', '不一致': 'ng', '製品マークが図面に無い': 'warn', '図面が見つからない': 'gray', '図面を読めなかった': 'gray' };

function renderCheck() {
  const has = !!checkResult;
  document.getElementById('check-result').style.display = has ? 'flex' : 'none';
  document.getElementById('check-drop').classList.toggle('compact', has);
  document.getElementById('btn-excel').disabled = !has;
  document.getElementById('btn-reset').disabled = !has;
  if (!has) { document.getElementById('file-info').textContent = ''; return; }
  const { xl, rows, extra, stats, hasJoint } = checkResult;
  document.getElementById('file-info').textContent = checkResult.fileName + '  /  ' + stats.total + ' 行';

  const sum = document.getElementById('check-summary');
  sum.innerHTML = '';
  // マウスを乗せると意味が出る(2026-11-09 ユーザーの質問)
  const chip = (label, n, cls, tip, hideZero) => {
    if (hideZero && !n) return; // 「図面が見つからない」「図面にあってExcelに無い」は0件なら出さない(ユーザー指示)
    const s = document.createElement('span');
    s.className = 'check-chip ' + cls + (n ? '' : ' zero');
    s.textContent = `${label} ${n}`;
    s.title = tip;
    sum.appendChild(s);
  };
  chip('一致', stats.ok, 'ok', 'Excelの行が図面と同じ');
  chip('不一致', stats['不一致'], 'ng', '図面はあるが、サイズ・長さ・本数・継手のどれかが図面と違う');
  chip('製品マークが図面に無い', stats['製品マークが図面に無い'], 'warn', '図番の図面はあるが、その中にExcelの製品マークが無い');
  chip('図面が見つからない', stats['図面が見つからない'] + stats['図面を読めなかった'], 'gray',
    'Excelの図番と同じ名前の図面(TDF)が詳細図フォルダに無い(図番の書き違い・図面の未作成・別のフォルダに置かれている等)。図面はあっても読めなかったものも含む', true);
  chip('図面にあってExcelに無い', extra.length, 'warn', 'Excelに載っている図面の中に、Excelに無い製品マークがある(Excelの書き漏れの可能性)', true);
  const info = document.getElementById('check-info');
  const cols = ['サイズ', '長さ', '本数'].filter((k, i) => [xl.hasSize, xl.hasLen, xl.hasHonsu][i]);
  if (hasJoint) cols.push('継手');
  const tm = checkResult.times;
  info.textContent = `シート「${xl.sheetName}」 / 比べた項目: ${cols.join('・')}(長さ ${xl.unit === 'm' ? 'm' : 'mm'}) / 図面 ${tm.files} 件(${checkResult.kojiDir}) / ` +
    `探す ${Math.round(tm.find)}秒・解析 ${Math.round(tm.extract)}秒` + (tm.reused ? `(前回の結果を使用 ${tm.reused} 件)` : '');

  const head = ['判定', '行', '図番', '製品マーク', 'サイズ(Excel)', 'サイズ(図面)', '長さ(Excel)', '長さ(図面)', '本数(Excel)', '本数(図面)'];
  if (hasJoint) head.push('継手A(Excel)', '継手A(図面)', '継手B(Excel)', '継手B(図面)');
  head.push('メモ', '図面の更新日');
  const thead = document.getElementById('check-thead');
  thead.innerHTML = '<tr>' + head.map(h => `<th>${h}</th>`).join('') + '</tr>';

  const tbody = document.getElementById('check-tbody');
  tbody.innerHTML = '';
  const shown = rows.filter(r => !checkOnlyNg || r.judge !== '一致');
  const td = (tr, text, cls) => { const c = document.createElement('td'); c.textContent = text ?? ''; if (cls) c.className = cls; tr.appendChild(c); return c; };
  for (const r of shown) {
    const tr = document.createElement('tr');
    const dw = r.dw || {};
    const bad = k => (r.bad.includes(k) ? 'diff' : '');
    td(tr, r.judge, 'judge ' + CHECK_JUDGE_CLASS[r.judge]);
    td(tr, r.x.rowNo);
    const z = td(tr, r.x.zuban);
    if (r.file) z.title = r.file.path.join('\\');
    td(tr, r.x.mark);
    td(tr, r.x.size, bad('サイズ')); td(tr, dw['サイズ'], bad('サイズ'));
    const xlen = r.x.len == null || r.x.len === '' ? '' : (isFinite(Number(r.x.len)) ? String(Number(Number(r.x.len).toFixed(4))) : String(r.x.len));
    td(tr, xlen, 'num ' + bad('長さ')); td(tr, checkFmtLen(dw['長さ']), 'num ' + bad('長さ'));
    td(tr, r.x.honsu, bad('本数')); td(tr, dw['本数'], bad('本数'));
    if (hasJoint) {
      const [ka, kb] = r.file && r.file.mode === 'column' ? ['下継手', '上継手'] : ['左継手', '右継手'];
      td(tr, r.x.ja, bad('継手A')); td(tr, dw[ka], bad('継手A'));
      td(tr, r.x.jb, bad('継手B')); td(tr, dw[kb], bad('継手B'));
    }
    td(tr, r.memo.join(' / '), 'memo');
    td(tr, r.file ? checkFmtDate(r.file.mtime) : '');
    tbody.appendChild(tr);
  }
  if (!shown.length) {
    const tr = document.createElement('tr');
    const c = td(tr, 'すべての行が図面と一致しました', 'all-ok');
    c.colSpan = head.length;
    tbody.appendChild(tr);
  }

  // 図面にあってExcelに無い製品
  const exWrap = document.getElementById('check-extra');
  exWrap.style.display = extra.length ? 'block' : 'none';
  const exBody = document.getElementById('check-extra-tbody');
  exBody.innerHTML = '';
  for (const e of extra) {
    const tr = document.createElement('tr');
    const z = td(tr, e.zuban); z.title = e.file.path.join('\\');
    td(tr, e.row['製品マーク']); td(tr, e.row['サイズ']); td(tr, checkFmtLen(e.row['長さ']), 'num'); td(tr, e.row['本数']);
    td(tr, checkFmtDate(e.file.mtime));
    exBody.appendChild(tr);
  }
}

function setCheckOnlyNg(v) {
  checkOnlyNg = v;
  if (checkResult) renderCheck();
}

// 続ける/やめる を選ばせるダイアログ(true=続ける)
function checkConfirm(title, message, okLabel, cancelLabel) {
  return new Promise(resolve => {
    const ov = document.getElementById('check-confirm');
    document.getElementById('check-confirm-title').textContent = title;
    document.getElementById('check-confirm-msg').textContent = message;
    const ok = document.getElementById('check-confirm-ok'), ng = document.getElementById('check-confirm-cancel');
    ok.textContent = okLabel; ng.textContent = cancelLabel;
    const done = v => { ov.classList.remove('open'); ok.onclick = ng.onclick = null; resolve(v); };
    ok.onclick = () => done(true);
    ng.onclick = () => done(false);
    ov.classList.add('open');
    ng.focus();
  });
}

function downloadCheckExcel() {
  if (!checkResult) return;
  const { rows, extra, hasJoint } = checkResult;
  const head = ['判定', 'Excelの行', '図番', '製品マーク', '違う項目', 'サイズ(Excel)', 'サイズ(図面)', '長さ(Excel)', '長さ(図面)', '本数(Excel)', '本数(図面)'];
  if (hasJoint) head.push('継手A(Excel)', '継手A(図面)', '継手B(Excel)', '継手B(図面)');
  head.push('メモ', '図面', '図面の更新日');
  const aoa = [head];
  for (const r of rows) {
    const dw = r.dw || {};
    const line = [r.judge, r.x.rowNo, r.x.zuban, r.x.mark, r.bad.join('・'), r.x.size ?? '', dw['サイズ'] ?? '', r.x.len ?? '', dw['長さ'] ?? '', r.x.honsu ?? '', dw['本数'] ?? ''];
    if (hasJoint) {
      const [ka, kb] = r.file && r.file.mode === 'column' ? ['下継手', '上継手'] : ['左継手', '右継手'];
      line.push(r.x.ja ?? '', dw[ka] ?? '', r.x.jb ?? '', dw[kb] ?? '');
    }
    line.push(r.memo.join(' / '), r.file ? r.file.path.join('\\') : '', r.file ? checkFmtDate(r.file.mtime) : '');
    aoa.push(line);
  }
  const wb = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(wb, XLSX.utils.aoa_to_sheet(aoa), '照合結果');
  const ex = [['図番', '製品マーク(図面)', 'サイズ', '長さ', '本数', '図面', '図面の更新日']]
    .concat(extra.map(e => [e.zuban, e.row['製品マーク'], e.row['サイズ'] ?? '', e.row['長さ'] ?? '', e.row['本数'] ?? '', e.file.path.join('\\'), checkFmtDate(e.file.mtime)]));
  XLSX.utils.book_append_sheet(wb, XLSX.utils.aoa_to_sheet(ex), '図面にあってExcelに無い');
  const base = checkResult.fileName.replace(/\.[^.]+$/, '');
  XLSX.writeFile(wb, base + '_帳票チェック結果.xlsx');
}

function resetCheck() {
  checkResult = null;
  renderCheck();
}

function openCheck() {
  checkMode = true;
  document.getElementById('empty-state').style.display = 'none';
  document.getElementById('result-area').classList.remove('visible');
  document.getElementById('check-area').classList.add('open');
  document.getElementById('drop-overlay').textContent = 'チェックするExcelファイルをここにドロップ';
  loadCheckRoot();
  renderCheck();
}

function closeCheck() {
  checkMode = false;
  document.getElementById('check-area').classList.remove('open');
  document.getElementById('drop-overlay').textContent = 'TDFファイルをここにドロップ';
}

document.getElementById('check-file-input').addEventListener('change', e => {
  if (e.target.files.length) processCheckFile(e.target.files);
});
