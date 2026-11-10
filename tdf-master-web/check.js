// ---------- 帳票チェックモード ----------
// 切断リスト・出荷リスト・マスターデータ等のExcelを取り込み、図番から最新の詳細図(TDF)を
// 探して抽出し、Excelのサイズ・長さ・本数・継手が図面と食い違っていないかを表で示す
// (梁モード・柱モードの逆。2026-11-09 ユーザーの仕様)。
//
// - 図面は「①進行中工事」フォルダから、工事番号で始まるフォルダ → その中の「詳細図」
//   フォルダの順に自動でたどる。ブラウザは利用者が選んだフォルダしか読めないので、
//   「①進行中工事」を「フォルダを選ぶ」で選んでもらい、ブラウザごとに(IndexedDB に)覚える。
//   工事フォルダ・詳細図フォルダを選んでもよい(下の「図面の保存場所」)。
// - 梁で読むか柱で読むかは、図面のフォルダ名で決める(checkModeOfPath)。
// - 比べるのはExcelにある列だけ(継手の列が無ければ継手は比べない)。サイズは書き方の違い
//   (柱の板厚の有無・細くなる柱・せいが変わる梁)を同じとみなす。長さは±0.1mm。

let checkMode = false;
let checkResult = null;    // { fileName, xl, rows, extra, stats, kojiDir, times }
let checkOnlyNg = true;    // 一致しない行だけ表示

const CHECK_DB = 'tdf-check';
const CHECK_STORE = 'handles';
const CHECK_ROOT_KEY = 'site-root';
const CHECK_LINK_SERVER_KEY = 'check-link-server'; // 結果Excelのリンク用に最後に選んだサーバーのパス(localStorage。ブラウザごと)
const CHECK_SKIP_DIR = /旧|発行歴/;
const CHECK_LEN_TOL_MM = 0.1; // 長さの許容差(±0.1mm。2026-11-09 ユーザー指定)

// 長さが同じか。Excelの長さがm単位で、小数第一位まで(小数第二位を四捨五入した値)しか書かれていないときは、
// 図面の長さ(m)を小数第二位で四捨五入した値と同じなら一致とする(2026-11-10 ユーザー指示。
// Excel側が四捨五入していることがあるため)。それ以外は ±CHECK_LEN_TOL_MM。
function checkLenSame(xlLen, unit, dwM) {
  const xm = Number(xlLen) * (unit === 'm' ? 1000 : 1);
  if (!isFinite(xm)) return false;
  if (Math.abs(dwM * 1000 - xm) <= CHECK_LEN_TOL_MM + 1e-6) return true;
  if (unit !== 'm') return false;
  const x = Number(xlLen);
  const oneDecimal = Math.abs(x * 10 - Math.round(x * 10)) < 1e-9;
  return oneDecimal && Math.abs(Math.floor(dwM * 10 + 0.5 + 1e-9) / 10 - x) < 1e-9;
}

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

// 図面の保存場所(2026-11-10 ユーザー指示で、本社・鳥取サーバーのボタンをやめた)
// - 「フォルダを選ぶ」で「①進行中工事」を選び、ブラウザごとに 'site-root' に覚える。
// - 工事フォルダ・詳細図フォルダを直接選んでもよい(その工事の分として 'koji:工事番号' に覚え、
//   ①進行中工事より先に使う)。
// ブラウザは選ばれたフォルダの名前しか教えてくれない(上の階層のパスは読めない)ので、名前で見分ける。
//   root  : ①進行中工事(名前に工事番号も「詳細図」も無い)
//   koji  : 工事フォルダ(名前の先頭が工事番号)
//   detail: 詳細図フォルダ(名前に「詳細図」。工事番号が無いので、照合のときにExcelの図番が
//           どれだけ見つかるかで工事の違いを確かめる)
let checkRoot = null;
let checkRootLoaded = false;
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
  return checkKojiFolders[kojiNo] || checkRoot;
}

async function loadCheckRoot() {
  if (!checkRootLoaded) {
    let saved = await checkIdbGet(CHECK_ROOT_KEY);
    if (!saved) {
      // 前の版(本社・鳥取サーバーのボタン)で覚えたものがあれば、最後に使ったサーバーの分を引き継ぐ
      const sel = await checkIdbGet('server-sel');
      for (const k of [sel, 'honsha', 'tottori']) {
        if (!saved && k) saved = await checkIdbGet('server:' + k);
      }
      if (saved) await checkIdbSet(CHECK_ROOT_KEY, saved);
    }
    if (!checkRoot) checkRoot = saved; // 読んでいる間に選ばれたときはそちらを使う
    checkRootLoaded = true;
  }
  if (kojiNo && !(kojiNo in checkKojiFolders)) {
    const saved = await checkIdbGet('koji:' + kojiNo);
    if (!(kojiNo in checkKojiFolders)) checkKojiFolders[kojiNo] = saved;
  }
  renderCheckFolder();
}

function renderCheckFolder() {
  const name = document.getElementById('check-folder-name');
  const own = checkKojiFolders[kojiNo];
  if (own) {
    name.textContent = `${kojiNo} 用: ${own.name}(${checkFolderKind(own) === 'koji' ? '工事フォルダ' : '詳細図フォルダ'})`;
  } else if (checkRoot) {
    name.textContent = `「${checkRoot.name}」から探します`;
  } else {
    name.textContent = '「①進行中工事」が未設定です(「フォルダを選ぶ」で選んでください)';
  }
  name.classList.toggle('unset', !own && !checkRoot);
  document.getElementById('check-folder-clear').style.display = own && checkRoot ? '' : 'none';
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

// 「フォルダを選ぶ」: ①進行中工事・工事フォルダ・詳細図フォルダ
async function pickCheckRoot() {
  const h = await checkPickDir();
  if (!h) return;
  const kind = checkFolderKind(h);
  if (kind === 'root') {
    checkRoot = h;
    await checkIdbSet(CHECK_ROOT_KEY, h);
    if (checkKojiFolders[kojiNo]) { checkKojiFolders[kojiNo] = null; await checkIdbSet('koji:' + kojiNo, null); }
    showToast(`「${h.name}」を覚えました`, 'success');
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

// 工事ごとに覚えたフォルダをやめて、①進行中工事から探す
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
// 見つけた詳細図フォルダの、工事フォルダからの途中のフォルダ名(自分は含まない)。
// 結果Excelの図面へのリンクで、工事フォルダ〜詳細図フォルダの間の階層(例: ①-正光施工図)に使う
const checkDirBase = new WeakMap();
async function checkFindDetailDirs(kojiDir) {
  const found = [];
  let level = [{ d: kojiDir, base: [] }];
  for (let depth = 0; depth < 3 && level.length && !found.length; depth++) {
    const next = [];
    for (const { d, base } of level) {
      for (const e of await checkListDir(d)) {
        if (e.kind !== 'directory' || CHECK_SKIP_DIR.test(e.name)) continue;
        const b = depth === 0 ? [] : base.concat(d.name);
        if (e.name.includes('詳細図')) { checkDirBase.set(e, b); found.push(e); } else next.push({ d: e, base: b });
      }
    }
    level = next;
  }
  return found;
}

// 詳細図フォルダの下を全部たどり、図番が need にあるTDFを集める(同時に8フォルダずつ読む)。
// 以前は8つの読み手が最初にキューが空だとすぐ終わり、実際には1フォルダずつ読んでいた
// (2026-11-10 修正。読み中のフォルダがある間は、新しく見つかったフォルダを待って読み続ける)。
const CHECK_WALK_PARALLEL = 8;
const CHECK_PREFETCH = 4; // 解析中に先に読んでおく図面の数
async function checkWalkTdf(dirs, need, onProgress) {
  const found = new Map(); // 図番 → [{ handle, path }]
  const queue = dirs.map(d => ({ dir: d, path: [d.name], base: checkDirBase.get(d) || [] }));
  let done = 0, active = 0;
  async function visit({ dir, path, base }) {
    for (const e of await checkListDir(dir)) {
      if (e.kind === 'directory') {
        if (!CHECK_SKIP_DIR.test(e.name)) queue.push({ dir: e, path: path.concat(e.name), base });
      } else if (/\.tdf$/i.test(e.name)) {
        const z = checkZkey(e.name);
        if (need.has(z)) {
          if (!found.has(z)) found.set(z, []);
          found.get(z).push({ handle: e, path: path.concat(e.name), base });
        }
      }
    }
  }
  await new Promise(resolve => {
    const pump = () => {
      while (active < CHECK_WALK_PARALLEL && queue.length) {
        active++;
        visit(queue.shift()).finally(() => {
          active--;
          done++;
          if (onProgress) onProgress(done, done + active + queue.length);
          pump();
        });
      }
      if (!active && !queue.length) resolve();
    };
    pump();
  });
  // 読み終わる順は毎回違うので、同じ図番の図面はパスの順に並べておく(結果を毎回同じにする)
  const byPath = (a, b) => (a.path.join('\\') < b.path.join('\\') ? -1 : a.path.join('\\') > b.path.join('\\') ? 1 : 0);
  for (const list of found.values()) list.sort(byPath);
  return found;
}

// ---- Excelを読む ----
function checkNorm(s) {
  return String(s ?? '').normalize('NFKC').replace(/\s+/g, '').trim();
}

// 見出しに「図番」と「製品マーク」(または「製品名」)がある行を、各シートの先頭30行から探す。
// 見出しの合うシートが複数あるときは、行がいちばん多いシートを使う(切断リストは同じ見出しの
// 空のシートが多い。26-11 の切断リストは「工場出図」)。
// 見出しの読み方(2026-11-09):
//   製品マーク … 「製品マーク」「製品名」
//   継手       … 「左継手」「右継手」/「下継手」「上継手」/「J」「J'」(切断リスト。J(開先) 等は使わない)
//                 /「J若番」「J老番」(出荷リスト。左(下)・右(上)。継手名の【】・◎は外す)
//                 /「SPL・方杖」(マスターデータ。結合セルで、その列=左(下)、右隣の列=右(上)。
//                 上の継手の見出しが1つも無いときだけ)
//   製品マーク … 上のほか「製品番号」(出荷リスト。「製品マーク」「製品名」があればそちらを先に使う)
//   長さ       … 「長さ」のほか「製品長」(出荷リスト)
//   サイズ     … 最初の「サイズ」の列。「,,」「〃」は上の行と同じ
const CHECK_DITTO = new Set([',,', '〃', '″', '"', '”']);
function checkHead(v) {
  return checkNorm(v).replace(/[’‘′´`]/g, "'");
}
function checkReadExcel(buf) {
  const wb = XLSX.read(new Uint8Array(buf), { type: 'array', cellDates: true });
  let best = null;
  for (const sheetName of wb.SheetNames) {
    const ws = wb.Sheets[sheetName];
    if (!ws || !ws['!ref']) continue;
    const aoa = XLSX.utils.sheet_to_json(ws, { header: 1, raw: true, defval: '' });
    const top = XLSX.utils.decode_range(ws['!ref']).s.r; // 表がA1から始まらないとき、Excelの行番号に直す
    for (let h = 0; h < Math.min(30, aoa.length); h++) {
      const head = aoa[h].map(checkHead);
      const col = (...keys) => head.findIndex(v => keys.some(k => v === k || v.startsWith(k + '(')));
      const exact = (...keys) => head.findIndex(v => keys.includes(v));
      const zubanCol = exact('図番');
      const markCol = [col('製品マーク', '製品名'), col('製品番号')].find(i => i >= 0) ?? -1; // 出荷リストは「製品番号」
      if (zubanCol < 0 || markCol < 0) continue;
      // マスターデータ(見出しの P1:R1 が結合セルの「SPL・方杖」)は、P列=左(下)継手、Q列=右(上)継手
      // (2026-11-10 ユーザー指示)。ほかの継手の見出しが無いときだけ、この列を継手として使う。
      const spl = exact('SPL・方杖');
      const hasJointHead = col('左継手', '下継手') >= 0 || col('右継手', '上継手') >= 0 || exact('J') >= 0 || exact("J'") >= 0 || exact('J若番') >= 0 || exact('J老番') >= 0;
      const ci = {
        zuban: zubanCol, mark: markCol, size: col('サイズ'), honsu: col('本数'),
        len: [col('長さ'), col('製品長')].find(i => i >= 0) ?? -1, // 出荷リストは「製品長」
        ja: [col('左継手', '下継手'), exact('J'), exact('J若番'), hasJointHead ? -1 : spl].find(i => i >= 0) ?? -1, // 出荷リスト: J若番=左(下)
        jb: [col('右継手', '上継手'), exact("J'"), exact('J老番'), hasJointHead || spl < 0 ? -1 : spl + 1].find(i => i >= 0) ?? -1, // 出荷リスト: J老番=右(上)
      };
      const lenHead = ci.len >= 0 ? head[ci.len] : '';
      const rows = [];
      const prev = {};
      for (let r = h + 1; r < aoa.length; r++) {
        const row = aoa[r];
        const zuban = checkNorm(row[ci.zuban]), mark = checkNorm(row[ci.mark]);
        if (!zuban && !mark) continue;
        const g = (k, i) => {
          if (i < 0) return undefined;
          let v = row[i];
          if (CHECK_DITTO.has(checkNorm(v))) v = prev[k]; // 「,,」は上の行と同じ
          prev[k] = v;
          if ((k === 'ja' || k === 'jb') && typeof v === 'string') v = v.replace(/[【】◎]/g, ''); // 継手名が【CJ1】や IJ250K◎ の形(◎は印。名前ではない)
          return v;
        };
        rows.push({ rowNo: top + r + 1, zuban, mark, rawMarkTail: String(row[ci.mark] ?? '').trim().endsWith('㋱'), size: g('size', ci.size), len: g('len', ci.len), honsu: g('honsu', ci.honsu), ja: g('ja', ci.ja), jb: g('jb', ci.jb) });
      }
      // 長さの単位: 見出しに(mm)・(m)があればそれ。無ければ値の大きさ(中央値が100未満ならm)
      let unit = /mm/i.test(lenHead) ? 'mm' : /\(m\)/i.test(lenHead) ? 'm' : null;
      if (!unit) {
        const v = rows.map(r => Number(r.len)).filter(x => isFinite(x) && x > 0).sort((a, b) => a - b);
        unit = v.length && v[Math.floor(v.length / 2)] < 100 ? 'm' : 'mm';
      }
      // 切断リスト(両端の継手が「J」「J'」の列)は、次の扱いを切断リストのときだけにする(2026-11-09 ユーザー指示)
      //   ・サイズの頭文字「TH」と「H」は、数字がすべて同じなら同じ
      //   ・製品名の最後の「㋱」は外して照合する
      //   ・継手の欄の「孔有」のような、継手名ではない書き込み(英字を含まない)は無視する
      const cut = exact('J') >= 0 && exact("J'") >= 0;
      if (cut) {
        // 「㋱」は NFKC で「メ」になるので、元の文字の最後が「㋱」のときだけ1文字外す
        for (const x of rows) if (x.rawMarkTail) x.mark = x.mark.slice(0, -1);
      }
      const cand = { sheetName, rows, unit, cols: ci, cut, hasSize: ci.size >= 0, hasLen: ci.len >= 0, hasHonsu: ci.honsu >= 0, hasJoint: (ci.ja >= 0 || ci.jb >= 0) && rows.some(r => checkNorm(r.ja) || checkNorm(r.jb)) }; // 継手が1行も書かれていなければ、継手は比べない
      if (!best || rows.length > best.rows.length) best = cand;
      break;
    }
  }
  if (best && best.rows.length) return best;
  throw new Error('見出しに「図番」「製品マーク」(または「製品名」)がある表が見つかりません');
}

// ---- 比べる ----
function checkSizeSame(xl, dw, cut = false) {
  const n = s => String(s ?? '').normalize('NFKC').replace(/\s/g, '').replace(/[×X*]/g, 'x'); // 切断リストは「*」区切り
  let a = n(xl), b = n(dw);
  if (a === b) return true;
  // 切断リストだけ: 頭文字「TH」と「H」は、数字がすべて同じなら同じ(2026-11-09 ユーザー指示)
  if (cut) {
    const th = s => s.replace(/^TH-/, 'H-');
    if (th(a) === th(b)) return true;
  }
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

// 結果のExcelで「不一致→OK」にするサイズの違い(2026-11-10 ユーザー指示。checkSizeSame で
// 一致にならなかったものだけに使う): 頭文字(H・SH・BH・BCP・□ 等)を除いた数字が同じか、
// 図面側の数字が足りないだけ(柱の板厚はアプリでは読まない: BCP-900x900x36 と □-900x900)。
// 図面が節ごとに「＿」で並ぶときは、どれかの節と合えばよい。数字が1つでも違えば不一致のまま
// (H-2448x124x5x8 と H-248x124x5x8 は不一致)。
function checkSizeLoose(xl, dw) {
  const nums = s => (s.match(/\d+(?:\.\d+)?/g) || []).map(Number);
  const n = s => String(s ?? '').normalize('NFKC').replace(/\s/g, '');
  const body = s => s.replace(/^[^-\d]*-/, ''); // 頭文字(「-」より前)を除く
  const xn = nums(body(n(xl)));
  if (!xn.length) return false;
  return body(n(dw)).split('_').some(sec => {
    const dn = nums(sec);
    return dn.length >= 2 && dn.length <= xn.length && dn.every((v, i) => v === xn[i]);
  });
}

// 両端の継手を「左 / 右」(柱は「下 / 上」)の形で表示する。無い端は「－」
function checkJointText(a, b) {
  const s = v => checkNorm(v) || '－';
  return checkNorm(a) || checkNorm(b) ? `${s(a)} / ${s(b)}` : '';
}

// 継手の比べ方: 両端の継手名の組み合わせが同じなら一致(左右の書き順は問わない)。
// Excelの列が片側だけのときは、その継手名が図面の両端のどちらかにあれば一致。
// Excelの行に継手が何も書かれていないときは比べない(不一致にしない。2026-11-09 ユーザー指示)。
// 切断リストでは、継手名ではない書き込み(「孔有」等。英字を含まない)はその端に何も書かれて
// いないのと同じではなく「分からない」として扱い、書かれた継手名が図面にあれば一致とする。
function checkJointSame(x, row, mode, xl) {
  const [ka, kb] = mode === 'column' ? ['下継手', '上継手'] : ['左継手', '右継手'];
  const raw = [xl.cols.ja >= 0 ? x.ja : null, xl.cols.jb >= 0 ? x.jb : null].map(checkNorm);
  const isName = v => !xl.cut || /[A-Za-z]/.test(v);
  const xs = raw.filter(v => v && isName(v)).sort();
  if (!xs.length) return true;
  const ds = [row[ka], row[kb]].map(checkNorm).filter(Boolean).sort();
  const unknown = raw.some(v => v && !isName(v)); // 「孔有」等で分からない端がある
  if (xl.cols.ja >= 0 && xl.cols.jb >= 0 && !unknown) return xs.join('|') === ds.join('|');
  return xs.every(v => ds.includes(v));
}

function checkQty(v) {
  const m = String(v ?? '').normalize('NFKC').match(/^\s*(\d+)/);
  return m ? Number(m[1]) : null;
}

const checkFmtLen = fmtLen; // 長さの表示(app.js と同じ書き方)

function checkFmtDate(ms) {
  if (!ms) return '';
  const d = new Date(ms), p = n => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`;
}

// ---- 実行 ----
function processCheckFile(files) {
  return withBusy(() => processCheckFileInner(files));
}

async function processCheckFileInner(files) {
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
    let detailDirs, label, linkBase = null; // linkBase: サーバーのパスの次に続くフォルダ名(詳細図フォルダの直接指定では上の階層が分からないので null=リンクなし)
    if (kind === 'root') {
      showStatus('工事のフォルダを探しています', kojiNo);
      const kojiDir = await checkFindKojiDir(folder, kojiNo);
      if (!kojiDir) throw new Error(`「${folder.name}」の中に、${kojiNo} で始まるフォルダが見つかりません。「フォルダを選ぶ」で、この工事の入っている「①進行中工事」(または工事フォルダ)を選んでください`);
      detailDirs = await checkFindDetailDirs(kojiDir);
      if (!detailDirs.length) throw new Error(`「${kojiDir.name}」の中に「詳細図」フォルダが見つかりません`);
      label = kojiDir.name;
      linkBase = [kojiDir.name];
    } else if (kind === 'koji') {
      detailDirs = await checkFindDetailDirs(folder);
      if (!detailDirs.length) throw new Error(`「${folder.name}」の中に「詳細図」フォルダが見つかりません`);
      label = folder.name;
      linkBase = [folder.name];
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

    // 抽出(図面ごとに1回)。更新日時・大きさ・抽出の版が前回と同じ図面は、覚えた結果を使う。
    // Python が1つの図面を解析している間に、次の図面(CHECK_PREFETCH 件先まで)の読み込みと
    // 前回の結果の確認を済ませておく(2026-11-10。以前は1件ずつ順番に待っていた)。
    const files = [...found.values()].flat();
    const res = new Map(); // パス → { mode, rows, err, mtime }
    const ver = await checkScriptsVersion();
    let reused = 0;
    const prepare = f => (async () => {
      const key = f.path.join('\\');
      const mode = checkModeOfPath(f.path);
      try {
        const blob = await f.handle.getFile();
        const ckey = [ver, kojiNo, key, blob.lastModified, blob.size].join('|');
        const saved = await checkIdbGet(ckey, CHECK_EXTRACT_STORE);
        if (saved && saved.mode === mode) return { key, mode, blob, saved };
        return { key, mode, blob, ckey, bytes: new Uint8Array(await blob.arrayBuffer()) };
      } catch (e) {
        return { key, mode, err: e };
      }
    })();
    const pending = [];
    for (let i = 0; i < files.length; i++) {
      for (let j = pending.length; j <= Math.min(i + CHECK_PREFETCH, files.length - 1); j++) pending.push(prepare(files[j]));
      const f = files[i];
      showStatus('図面を解析しています', `(${i + 1}/${files.length}) ${f.handle.name}` + (reused ? `  前回の結果を使用 ${reused} 件` : ''));
      const p = await pending[i];
      pending[i] = null; // 読んだ中身を早めに手放す
      if (p.err) { res.set(p.key, { mode: p.mode, rows: [], err: p.err.message, mtime: null, path: f.path, base: f.base }); continue; }
      if (p.saved) {
        res.set(p.key, { mode: p.mode, rows: p.saved.rows, err: null, mtime: p.blob.lastModified, path: f.path, base: f.base });
        reused++;
        continue;
      }
      try {
        pyodide.FS.writeFile('/input.tdf', p.bytes);
        pyodide.globals.set('tdf_filename', f.handle.name);
        const py = await pyodide.runPythonAsync(`${p.mode === 'column' ? 'tdf_column' : 'tdf_app'}.extract_file('/input.tdf', tdf_filename)`);
        const rows = py.toJs({ dict_converter: Object.fromEntries });
        py.destroy();
        res.set(p.key, { mode: p.mode, rows, err: null, mtime: p.blob.lastModified, path: f.path, base: f.base });
        checkIdbSet(p.ckey, { mode: p.mode, rows }, CHECK_EXTRACT_STORE); // 書き込みは待たない(失敗しても照合は続ける)
      } catch (e) {
        res.set(p.key, { mode: p.mode, rows: [], err: e.message, mtime: null, path: f.path, base: f.base });
      }
    }
    const t2 = performance.now();

    checkResult = checkCompare(xl, found, res);
    checkResult.fileName = file.name;
    checkResult.linkBase = linkBase;
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

// 梁で読むか柱で読むか: 図面までのフォルダ名(ファイル名は除く)に「柱」があり「梁」が無いものが
// 1つでもあれば柱(「01.柱詳細図」「間柱詳細図」に加え、「06.EV詳細図\02.間柱」のような
// フォルダもある。2026-11-10、26-16 の WB3-EV1P-04・07 等が梁モードで読まれ、長さが空や
// 違う値になっていた)
function checkModeOfPath(path) {
  return path.slice(0, -1).some(p => p.includes('柱') && !p.includes('梁')) ? 'column' : 'beam';
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
  const honsuSum = new Map(); // 切断リスト: 図番+製品名 → 本数の合計
  if (xl.cut) {
    for (const x of xl.rows) {
      const k = x.zuban + '\u0000' + x.mark;
      honsuSum.set(k, (honsuSum.get(k) || 0) + (checkQty(x.honsu) ?? 0));
    }
  }
  const rows = xl.rows.map(x => {
    const out = { x, judge: '', bad: [], memo: [], dw: null, file: null };
    // 照合するのは、製品名(製品マーク)と図番が図面の製品と一致した行だけ(2026-11-09 ユーザー指示)。
    // 切断リストには柱仕口・大梁付などの部材の行もあるので、一致しない行は「対象外」として照合しない。
    const files = found.get(x.zuban) || [];
    if (files.length) out.file = res.get(files[0].path.join('\\'));
    const cand = (byZuban.get(x.zuban) || []).filter(c => checkNorm(c.row['製品マーク']) === x.mark);
    if (!cand.length) {
      out.judge = '対象外';
      out.memo.push(!files.length ? '図番の図面が見つからない'
        : files.some(f => (res.get(f.path.join('\\')) || {}).err) ? '図面を読めなかった' : '図面の製品マークに無い');
      return out;
    }
    const { key, mode, row } = cand[0];
    used.add(key + '\u0000' + x.mark);
    out.dw = row;
    out.file = res.get(key);
    if (xl.hasSize && !checkSizeSame(x.size, row['サイズ'], xl.cut)) {
      out.bad.push('サイズ');
      out.sizeLoose = checkSizeLoose(x.size, row['サイズ']);
    }
    if (xl.hasLen) {
      if (row['長さ'] == null) { out.bad.push('長さ'); out.memo.push('図面から長さを読めなかった'); }
      else if (!checkLenSame(x.len, xl.unit, row['長さ'])) out.bad.push('長さ');
    }
    if (row['長さの確認']) out.memo.push(`図面の長さは「${row['長さの確認']}」`);
    if (xl.hasHonsu) {
      // 切断リストは製品1本ごとに1行(本数1)なので、同じ図番・製品名の行の本数を合計して図面の台数と比べる
      const xq = xl.cut ? (honsuSum.get(x.zuban + '\u0000' + x.mark) ?? null) : checkQty(x.honsu);
      if (xl.cut) out.honsuSum = xq;
      if (xq !== checkQty(row['本数'])) out.bad.push('本数');
    }
    // 図面から長さを読めなかった行は継手も空になるので、継手は比べない(長さの不一致は残す)
    if (xl.hasJoint && row['長さ'] != null && !checkJointSame(x, row, mode, xl)) out.bad.push('継手');
    if (cand.length > 1) out.memo.push(`図面に同じ製品マークが${cand.length}行`);
    out.judge = out.bad.length ? '不一致' : '一致';
    return out;
  });
  // 図面にあってExcelに無い製品(Excelに載っている図面の中だけ)。切断リストは部材ごとの表で
  // 製品をすべて載せるものではない(柱は柱仕口の行だけ等)ので出さない
  const extra = [];
  for (const z of xl.cut ? [] : new Set(xl.rows.map(r => r.zuban))) {
    for (const c of byZuban.get(z) || []) {
      const m = checkNorm(c.row['製品マーク']);
      if (!used.has(c.key + '\u0000' + m)) extra.push({ zuban: z, row: c.row, file: res.get(c.key) });
    }
  }
  const judged = rows.filter(r => r.judge !== '対象外');
  const stats = { total: judged.length, ok: judged.filter(r => r.judge === '一致').length };
  ['不一致', '対象外'].forEach(k => { stats[k] = rows.filter(r => r.judge === k).length; });
  return { xl, rows, extra, stats };
}

// ---- 表示 ----
const CHECK_JUDGE_CLASS = { '一致': 'ok', '不一致': 'ng', '対象外': 'gray' };

function renderCheck() {
  const has = !!checkResult;
  document.getElementById('check-result').style.display = has ? 'flex' : 'none';
  document.getElementById('check-drop').classList.toggle('compact', has);
  document.getElementById('btn-excel').disabled = !has;
  document.getElementById('btn-reset').disabled = !has;
  if (!has) { document.getElementById('file-info').textContent = ''; return; }
  const { xl, rows, extra, stats } = checkResult;
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
  chip('不一致', stats['不一致'], 'ng', 'サイズ・長さ・本数・継手のどれかが図面と違う');
  chip('対象外', stats['対象外'], 'gray',
    '製品名と図番が図面の製品と一致しない行。照合しない(柱仕口・大梁付などの部材の行、図番の図面が見つからない行等)。結果のExcelには載せます', true);
  chip('図面にあってExcelに無い', extra.length, 'warn', 'Excelに載っている図面の中に、Excelに無い製品マークがある(Excelの書き漏れの可能性)', true);
  const info = document.getElementById('check-info');
  const cols = ['サイズ', '長さ', '本数'].filter((k, i) => [xl.hasSize, xl.hasLen, xl.hasHonsu][i]);
  if (xl.hasJoint) cols.push('継手');
  const tm = checkResult.times;
  info.textContent = `シート「${xl.sheetName}」 / 比べた項目: ${cols.join('・')}(長さ ${xl.unit === 'm' ? 'm' : 'mm'}) / 図面 ${tm.files} 件(${checkResult.kojiDir})` +
    (tm.find || tm.extract ? ` / 探す ${Math.round(tm.find)}秒・解析 ${Math.round(tm.extract)}秒` + (tm.reused ? `(前回の結果を使用 ${tm.reused} 件)` : '') : '') +
    (xl.cut ? ' / 切断リストとして照合' : '');

  // 継手は表に必ず出す(2026-11-09 ユーザー指示)。Excelに継手の列があれば並べて比べる
  const head = ['判定', '行', '図番', '製品マーク', 'サイズ(Excel)', 'サイズ(図面)', '長さ(Excel)', '長さ(図面)', '本数(Excel)', '本数(図面)'];
  head.push('継手(Excel)', '継手(図面)', 'メモ', '図面の更新日'); // Excelに継手の列が無ければ「継手(Excel)」は空欄
  const thead = document.getElementById('check-thead');
  thead.innerHTML = '<tr>' + head.map(h => `<th>${h}</th>`).join('') + '</tr>';

  const tbody = document.getElementById('check-tbody');
  tbody.innerHTML = '';
  const shown = rows.filter(r => r.judge !== '対象外' && (!checkOnlyNg || r.judge !== '一致'));
  const td = (tr, text, cls) => { const c = document.createElement('td'); c.textContent = text ?? ''; if (cls) c.className = cls; tr.appendChild(c); return c; };
  const frag = document.createDocumentFragment(); // 行はまとめて1回で表に入れる
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
    // 切断リストで同じ製品の行が複数あるときだけ、合計を「1(計7)」のように出す
    const hs = r.honsuSum != null && r.honsuSum !== checkQty(r.x.honsu) ? `${r.x.honsu ?? ''}(計${r.honsuSum})` : r.x.honsu;
    td(tr, hs, bad('本数')); td(tr, dw['本数'], bad('本数'));
    td(tr, checkJointText(r.x.ja, r.x.jb), bad('継手'));
    const [ka, kb] = r.file && r.file.mode === 'column' ? ['下継手', '上継手'] : ['左継手', '右継手'];
    td(tr, checkJointText(dw[ka], dw[kb]), bad('継手'));
    td(tr, r.memo.join(' / '), 'memo');
    td(tr, r.file ? checkFmtDate(r.file.mtime) : '');
    frag.appendChild(tr);
  }
  tbody.appendChild(frag);
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

// 結果のExcel(2026-11-10 ユーザー指示)
// - A列の判定: サイズの違いが書き方だけ(checkSizeLoose)で、ほかの項目が合う行は「不一致→OK」。
//   画面の表と件数は変えない(Excelだけ)。
// - 「不一致」の行は A〜P 列を黄色、違う項目の「(Excel)」のセル(サイズ F・長さ H・本数 J・継手 L)を
//   赤の太字にする。書き方だけのサイズの違いは赤にしない。
const CHECK_XL_BAD_COL = { 'サイズ': 5, '長さ': 7, '本数': 9, '継手': 11 }; // 0始まりの列

function checkExcelJudge(r) {
  if (r.judge !== '不一致') return { judge: r.judge, red: [] };
  const real = r.bad.filter(k => !(k === 'サイズ' && r.sizeLoose));
  return real.length ? { judge: '不一致', red: real } : { judge: '不一致→OK', red: [] };
}

async function downloadCheckExcel() {
  if (!checkResult) return;
  const { rows, extra } = checkResult;
  // 図面へのハイパーリンク(2026-11-10 ユーザー指示。リンクの形は「実寸法師ハイパーリンク付与」と同じ
  // file://サーバー/…/図面.tdf)。ブラウザはサーバーのパスを教えてくれないので、設定シートの
  // サーバー一覧(H:I列)から選ぶポップアップで、図面のあるサーバー(パスは伏せ字)を選んでもらう。
  // 詳細図フォルダを直接選んだとき(上の階層が分からない)は、リンクなし。
  let linkServer = '';
  if (checkResult.linkBase) {
    let servers = [];
    try { servers = await apiGet('getServerPaths'); } catch (e) { console.error('サーバー一覧を取得できませんでした', e); }
    let initial = '';
    try { initial = localStorage.getItem(CHECK_LINK_SERVER_KEY) || ''; } catch (_) { /* 覚えられなくてもよい */ }
    linkServer = await askBasePath({
      servers, initial,
      label: '図面があるサーバーを選択してください',
      hint: 'サーバーを選んで「OK」を押すと、製品マークに図面へのリンクを付けて保存します。<br>'
        + '「スキップ」を押すと、リンクなしで保存します。',
    });
    if (linkServer) { try { localStorage.setItem(CHECK_LINK_SERVER_KEY, linkServer); } catch (_) { /* 同上 */ } }
  }
  const links = new Map(); // セル番地 → file://リンク
  const head = ['判定', 'Excelの行', '図番', '製品マーク', '違う項目', 'サイズ(Excel)', 'サイズ(図面)', '長さ(Excel)', '長さ(図面)', '本数(Excel)', '本数(図面)',
    '継手(Excel)', '継手(図面)', 'メモ', '図面', '図面の更新日'];
  const aoa = [head];
  const yellow = new Set(), red = new Set(); // セル番地(A2 等)
  const yellowRows = [], redCells = []; // スプレッドシートの記録用(データ行の番号・列。0始まり)
  for (const r of rows) {
    const dw = r.dw || {};
    const [ka, kb] = r.file && r.file.mode === 'column' ? ['下継手', '上継手'] : ['左継手', '右継手'];
    const j = checkExcelJudge(r);
    const line = [j.judge, r.x.rowNo, r.x.zuban, r.x.mark, r.bad.join('・'), r.x.size ?? '', dw['サイズ'] ?? '', r.x.len ?? '', dw['長さ'] ?? '', r.honsuSum != null ? `${r.x.honsu ?? ''}(計${r.honsuSum})` : (r.x.honsu ?? ''), dw['本数'] ?? '',
      checkJointText(r.x.ja, r.x.jb), r.dw ? checkJointText(dw[ka], dw[kb]) : ''];
    line.push(r.memo.join(' / '), r.file ? r.file.path.join('\\') : '', r.file ? checkFmtDate(r.file.mtime) : '');
    aoa.push(line);
    if (linkServer && r.judge !== '対象外' && r.file && r.file.path) {
      // サーバーのパス + 工事フォルダ + (詳細図フォルダまでの途中) + 詳細図フォルダ以下のパス
      links.set(XLSX.utils.encode_cell({ r: aoa.length - 1, c: 3 }),
        buildFileUrl(linkServer, checkResult.linkBase.concat(r.file.base || [], r.file.path).join('/')));
    }
    if (j.judge === '不一致') {
      const rn = aoa.length;
      for (let c = 0; c < head.length; c++) yellow.add(XLSX.utils.encode_cell({ r: rn - 1, c }));
      for (const k of j.red) red.add(XLSX.utils.encode_cell({ r: rn - 1, c: CHECK_XL_BAD_COL[k] }));
      yellowRows.push(rn - 2);
      for (const k of j.red) redCells.push([rn - 2, CHECK_XL_BAD_COL[k]]);
    }
  }
  const wb = XLSX.utils.book_new();
  const ws1 = XLSX.utils.aoa_to_sheet(aoa);
  for (const [ref, url] of links) { if (ws1[ref]) ws1[ref].l = { Target: url }; }
  // 列をオートフィット、A〜P列にフィルタ、1行目をウィンドウ枠で固定(2026-11-10 ユーザー指示。
  // 固定は SheetJS コミュニティ版では書けないので checkStyleExcel で sheet1.xml に足す)
  ws1['!cols'] = computeColWidths(aoa);
  ws1['!autofilter'] = { ref: XLSX.utils.encode_range({ s: { r: 0, c: 0 }, e: { r: aoa.length - 1, c: head.length - 1 } }) };
  XLSX.utils.book_append_sheet(wb, ws1, '照合結果');
  const ex = [['図番', '製品マーク(図面)', 'サイズ', '長さ', '本数', '図面', '図面の更新日']]
    .concat(extra.map(e => [e.zuban, e.row['製品マーク'], e.row['サイズ'] ?? '', e.row['長さ'] ?? '', e.row['本数'] ?? '', e.file.path.join('\\'), checkFmtDate(e.file.mtime)]));
  const ws2 = XLSX.utils.aoa_to_sheet(ex);
  ws2['!cols'] = computeColWidths(ex);
  XLSX.utils.book_append_sheet(wb, ws2, '図面にあってExcelに無い');
  const base = checkResult.fileName.replace(/\.[^.]+$/, '');
  const fname = base + '_帳票チェック結果.xlsx';
  try {
    downloadBlob(await checkStyleExcel(wb, yellow, red, new Set(links.keys())), fname);
  } catch (e) {
    // 色付けに失敗しても、色の無いExcelは保存する(2026-11-10)
    console.error('結果のExcelの色付けに失敗しました', e);
    showToast('色付けに失敗したため、色の無いExcelを保存します', 'error');
    XLSX.writeFile(wb, fname);
  }

  // スプレッドシートにも記録する(2026-11-10 ユーザー指示): 「照合結果」シートの内容(A〜P列・全行)を
  // 新しいシートに入れ、「記録」シートに1行。製品数は照合結果の行数(対象外も含む)、
  // F列「図番頭」は空欄。新しいシートにも黄色・赤の太字を付ける。失敗してもダウンロードは済んでいる。
  try {
    await apiPost('onExcelDownload', {
      kojiNo, productCount: rows.length, rows: aoa,
      opts: { noZubanHead: true, highlight: { yellowRows, redCells } },
    });
  } catch (e) {
    console.error('GAS記録エラー', e);
  }
}

// SheetJSコミュニティ版は書式を書き込めないので、作ったxlsxをJSZipで開いて、styles.xml に
// 黄色の塗りつぶしと赤の太字を足し、1枚目のシートの対象セルの s 属性を差し替える
// (app.js の applyHyperlinkStyle と同じ方法)。値の無いセルにも色を付けるため、
// 行の中に無いセルは空のセルとして足す。
async function checkStyleExcel(wb, yellow, red, links = new Set()) {
  const zip = await JSZip.loadAsync(XLSX.write(wb, { type: 'array', bookType: 'xlsx' }));
  let st = await zip.file('xl/styles.xml').async('string');
  const fontCount = parseInt(st.match(/<fonts count="(\d+)">/)[1], 10);
  // 赤の太字(fontCount)と、リンクの青の下線太字(fontCount + 1。app.js の applyHyperlinkStyle と同じ書式)
  st = st.replace(/<fonts count="\d+">/, `<fonts count="${fontCount + 2}">`)
    .replace('</fonts>', '<font><b/><sz val="12"/><color rgb="FFFF0000"/><name val="Calibri"/><family val="2"/><scheme val="minor"/></font>'
      + '<font><u/><b/><sz val="11"/><color rgb="FF0000FF"/><name val="Calibri"/><family val="2"/><scheme val="minor"/></font></fonts>');
  const fillCount = parseInt(st.match(/<fills count="(\d+)">/)[1], 10);
  st = st.replace(/<fills count="\d+">/, `<fills count="${fillCount + 1}">`)
    .replace('</fills>', '<fill><patternFill patternType="solid"><fgColor rgb="FFFFFF00"/><bgColor indexed="64"/></patternFill></fill></fills>');
  const xfCount = parseInt(st.match(/<cellXfs count="(\d+)">/)[1], 10);
  const xfYellow = xfCount, xfRed = xfCount + 1, xfLink = xfCount + 2, xfLinkY = xfCount + 3;
  st = st.replace(/<cellXfs count="\d+">/, `<cellXfs count="${xfCount + 4}">`)
    .replace('</cellXfs>', `<xf numFmtId="0" fontId="0" fillId="${fillCount}" borderId="0" xfId="0" applyFill="1"/>` +
      `<xf numFmtId="0" fontId="${fontCount}" fillId="${fillCount}" borderId="0" xfId="0" applyFont="1" applyFill="1"/>` +
      `<xf numFmtId="0" fontId="${fontCount + 1}" fillId="0" borderId="0" xfId="0" applyFont="1"/>` +
      `<xf numFmtId="0" fontId="${fontCount + 1}" fillId="${fillCount}" borderId="0" xfId="0" applyFont="1" applyFill="1"/></cellXfs>`);
  zip.file('xl/styles.xml', st);

  const sheetPath = 'xl/worksheets/sheet1.xml';
  let sh = await zip.file(sheetPath).async('string');
  const styleOf = ref => (red.has(ref) ? xfRed : links.has(ref) ? (yellow.has(ref) ? xfLinkY : xfLink) : yellow.has(ref) ? xfYellow : null);
  const byRow = new Map(); // 行番号 → 塗るセル
  for (const ref of new Set([...yellow, ...links])) {
    const rn = ref.replace(/^[A-Z]+/, '');
    if (!byRow.has(rn)) byRow.set(rn, []);
    byRow.get(rn).push(ref);
  }
  sh = sh.replace(/<row r="(\d+)"([^>]*?)(?:\/>|>([\s\S]*?)<\/row>)/g, (m, rn, attrs, inner = '') => {
    const want = byRow.get(rn);
    if (!want) return m;
    const have = new Set();
    let body = inner.replace(/<c r="([A-Z]+\d+)"([^>]*?)(\/?)>/g, (cm, ref, a, sc) => {
      have.add(ref);
      const s = styleOf(ref);
      return s == null ? cm : `<c r="${ref}"${a.replace(/\ss="\d+"/, '')} s="${s}"${sc}>`;
    });
    const add = want.filter(ref => !have.has(ref)).map(ref => `<c r="${ref}" s="${styleOf(ref)}"/>`).join('');
    if (add) {
      // 列の順に並べ直す
      const cells = (body + add).match(/<c r="[A-Z]+\d+"[^>]*?(?:\/>|>[\s\S]*?<\/c>)/g) || [];
      const col = c => XLSX.utils.decode_cell(c.match(/r="([A-Z]+\d+)"/)[1]).c;
      body = cells.sort((a, b) => col(a) - col(b)).join('');
    }
    return `<row r="${rn}"${attrs}>${body}</row>`;
  });
  // 1行目をウィンドウ枠で固定する(SheetJS は sheetView に枠の固定を書けない)
  const frozen = '<sheetViews><sheetView workbookViewId="0"><pane ySplit="1" topLeftCell="A2" activePane="bottomLeft" state="frozen"/>'
    + '<selection pane="bottomLeft" activeCell="A2" sqref="A2"/></sheetView></sheetViews>';
  if (/<sheetViews>[\s\S]*?<\/sheetViews>/.test(sh)) sh = sh.replace(/<sheetViews>[\s\S]*?<\/sheetViews>/, frozen);
  else sh = sh.replace(/(<worksheet[^>]*>)/, `$1${frozen}`);
  zip.file(sheetPath, sh);
  return zip.generateAsync({ type: 'blob', mimeType: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' });
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
