// デプロイ済みGAS WebアプリのURL(/exec で終わるURL)。デプロイ後にここへ差し替えてください。
const GAS_API_URL = "https://script.google.com/macros/s/AKfycbxyGKGdIUONX9-kvs-mTayA3UXp6Rztc9VjP4jloTMRDctTQqrWeIC5CWQDSz4rfXs/exec";

let pyodide = null;
let weightMap = {};
let beamType = null;
let kojiNo = '';
let extractedResults = [];

const FACTORY_NAMES = { h: '本社', y: '夢前', t: '鳥取' };

// ---------- GAS API共通 ----------
// (URL未設定・GAS側の不調時もアプリ本来の抽出・Excel出力は止めない。
//  呼び出し側は必ずcatchし、失敗してもユーザー作業は継続させること)

async function apiGet(action, params) {
  const url = new URL(GAS_API_URL);
  url.searchParams.set('action', action);
  if (params) Object.keys(params).forEach(k => { if (params[k] !== undefined && params[k] !== null) url.searchParams.set(k, params[k]); });
  const res = await fetch(url.toString(), { method: 'GET' });
  if (!res.ok) throw new Error('サーバーエラー(HTTP ' + res.status + ')');
  const json = await res.json();
  if (json.status !== 'success') throw new Error(json.message || '取得に失敗しました');
  return json.data;
}

// Content-Type: text/plain でCORSプリフライト(OPTIONS)を回避する(GASはOPTIONS未対応のため)
async function apiPost(action, payload) {
  const res = await fetch(GAS_API_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'text/plain;charset=utf-8' },
    body: JSON.stringify(Object.assign({ action: action }, payload)),
  });
  if (!res.ok) throw new Error('サーバーエラー(HTTP ' + res.status + ')');
  const json = await res.json();
  if (json.status !== 'success') throw new Error(json.message || '処理に失敗しました');
  return json.data;
}

function selectFactory(code) {
  // 利用記録シートへ日時・工場のみ記録する(失敗してもアプリ利用は継続させる)。
  apiPost('logUsageStart', { factory: FACTORY_NAMES[code] || code }).catch(() => {});
  // 工事名選択肢・重量表はアプリを開いた時点(loadMasterData()参照)で先読み済みのため、
  // ここでは呼び出さない。工場選択→梁種別選択の間には既にプルダウンへ反映されている。
  document.getElementById('factory-modal').classList.add('hidden');
  document.getElementById('beam-modal').classList.remove('hidden');
}

function selectBeamType(type, btnEl) {
  beamType = type;
  document.querySelectorAll('.beam-btn').forEach(b => b.classList.remove('selected'));
  btnEl.classList.add('selected');
  updateStartBtn();
}

const KOJI_STORAGE_KEY = 'tdf_master_web_last_koji';

function updateStartBtn() {
  kojiNo = document.getElementById('koji-select').value;
  document.getElementById('beam-start-btn').disabled = !(beamType && kojiNo);
  if (kojiNo) {
    try { localStorage.setItem(KOJI_STORAGE_KEY, kojiNo); } catch (_) {}
  }
}

// 設定シートの重量表・工事名一覧は、アプリを開いた直後(工場選択モーダルが
// 表示されている間、Pyodideの起動も待たずに)先読みしておく。こうすることで
// 「工場選択→梁種別選択」と進む一連の操作の間にAPI応答が完了し、工事名
// プルダウンや前回選択の復元が体感的に即座に反映される。2つのAPI呼び出しは
// 互いに依存しないので並列実行し、直列実行した場合に比べて待ち時間を短縮する。
async function loadMasterData() {
  const [weightResult, kojiResult] = await Promise.allSettled([
    apiGet('getWeightTable'),
    apiGet('getKojiList'),
  ]);

  if (weightResult.status === 'fulfilled') {
    const data = weightResult.value;
    if (data && data.length > 0) weightMap = Object.fromEntries(data);
  }

  if (kojiResult.status === 'fulfilled') {
    const kojiList = kojiResult.value;
    const sel = document.getElementById('koji-select');
    if (kojiList && kojiList.length > 0) {
      kojiList.forEach(([no, name]) => {
        const opt = document.createElement('option');
        opt.value = no; opt.textContent = name || no;
        sel.appendChild(opt);
      });
    }
    // 初回は空欄のまま、2回目以降は前回選んだ工事名を記憶して自動選択する。
    let lastKoji = null;
    try { lastKoji = localStorage.getItem(KOJI_STORAGE_KEY); } catch (_) {}
    if (lastKoji && [...sel.options].some(o => o.value === lastKoji)) {
      sel.value = lastKoji;
      updateStartBtn();
    }
  }
}

async function startApp() {
  document.getElementById('beam-modal').classList.add('hidden');
  const kojiName = document.getElementById('koji-select').selectedOptions[0]?.textContent || kojiNo;
  document.getElementById('beam-type-label').textContent = kojiNo + '＿' + kojiName;
  await initPyodide();
}

async function initPyodide() {
  showStatus('準備中', '初回は30秒ほどかかる場合があります');
  try {
    pyodide = await loadPyodide();
    pyodide.FS.mkdir('/scripts');
    const files = {
      '/scripts/tdf_binary.py': 'py-tdf-binary',
      '/scripts/tdf_master_extractor.py': 'py-tdf-master-extractor',
      '/scripts/tdf_master_extractor_multi.py': 'py-tdf-master-extractor-multi',
      '/scripts/tdf_app.py': 'py-tdf-app',
    };
    for (const [path, elId] of Object.entries(files)) {
      pyodide.FS.writeFile(path, document.getElementById(elId).textContent);
    }
    await pyodide.runPythonAsync("import sys\nsys.path.insert(0, '/scripts')\nimport tdf_app");

    hideStatus();
    showToast('準備完了 — TDFファイルを選択してください', 'success');
  } catch (e) {
    hideStatus();
    showToast('初期化エラー: ' + e.message, 'error');
  }
}

async function processFiles(files) {
  const tdfFiles = Array.from(files).filter(f => f.name.toLowerCase().endsWith('.tdf'));
  if (tdfFiles.length === 0) { showToast('TDFファイルを選択してください', 'error'); return; }
  if (!pyodide) { showToast('準備中です。しばらくお待ちください', 'error'); return; }

  document.getElementById('result-area').classList.remove('visible');
  extractedResults = [];
  const errors = [];
  const noTableFiles = [];

  for (let i = 0; i < tdfFiles.length; i++) {
    const file = tdfFiles[i];
    showStatus('TDF解析中...', `(${i + 1}/${tdfFiles.length}) ${file.name}`);
    try {
      const uint8 = new Uint8Array(await file.arrayBuffer());
      pyodide.FS.writeFile('/input.tdf', uint8);
      const pyResult = await pyodide.runPythonAsync(`tdf_app.extract_file('/input.tdf', '${beamType}')`);
      const rows = pyResult.toJs({ dict_converter: Object.fromEntries });
      pyResult.destroy();
      if (rows.length === 0) {
        noTableFiles.push(file.name);
      } else {
        rows.forEach(r => r['_filename'] = file.name);
        extractedResults.push(...rows);
      }
    } catch (e) {
      errors.push(file.name + ': ' + e.message);
      console.error(e);
    }
  }

  hideStatus();

  if (extractedResults.length === 0) {
    showToast('製品情報が見つかりませんでした' + (errors.length ? '（エラー: ' + errors.join(' / ') + '）' : ''), 'error');
    return;
  }

  document.getElementById('btn-reset').disabled = false;

  extractedResults.sort((a, b) => {
    const cmp = (key) => String(a[key] ?? '').localeCompare(String(b[key] ?? ''), 'ja', { numeric: true });
    return cmp('図番') || cmp('製品マーク');
  });

  const kojiRaw = kojiNo.replace(/-/g, '');
  extractedResults.forEach((r, i) => { r._id = kojiRaw + String(i + 1).padStart(4, '0'); });

  renderTable(extractedResults);
  document.getElementById('file-info').textContent = tdfFiles.length + ' ファイル  /  ' + extractedResults.length + ' 件';
  document.getElementById('result-area').classList.add('visible');
  document.getElementById('empty-state').style.display = 'none';
  document.getElementById('btn-excel').disabled = false;

  let msg = extractedResults.length + ' 件を抽出しました';
  if (errors.length) msg += '（' + errors.length + ' ファイルでエラー）';
  showToast(msg, errors.length ? '' : 'success');

  if (noTableFiles.length > 0) {
    showToast('製品情報が見つからなかったファイル: ' + noTableFiles.join(', '), 'error');
  }
}

// 重量(t)を求める。TDFファイル自身に重量セル(kg)があればそれをt換算して使い
// (「N.Nkg」形式のテキストからkgを取り除いてt換算)、無ければ設定シートの
// 重量表(サイズ→kg/m)×長さ(m)×本数をt換算して概算する。長さは既にPython側で
// m単位に変換済みなので、ここでの長さの単位変換は不要。
function computeWeightT(r) {
  const size = r['サイズ'] ?? '';
  const honsu = parseInt(r['本数'] ?? 1) || 1;
  const lenM = parseFloat(r['長さ']);
  const rawWeight = r['重量'];
  if (rawWeight) {
    const n = parseFloat(String(rawWeight).replace(/kg$/i, ''));
    if (!isNaN(n)) return n / 1000;
  }
  if (!isNaN(lenM) && weightMap[size] != null) {
    return (weightMap[size] * lenM * honsu) / 1000;
  }
  return null;
}

function renderTable(results) {
  const tbody = document.getElementById('result-tbody');
  tbody.innerHTML = '';

  const markCounts = {};
  results.forEach(r => { if (r['製品マーク']) markCounts[r['製品マーク']] = (markCounts[r['製品マーク']] || 0) + 1; });

  results.forEach(r => {
    const size = r['サイズ'] ?? '';
    const honsuRaw = r['本数'] ?? '';
    const lenRaw = r['長さ'];
    const lenStr = (lenRaw === null || lenRaw === undefined) ? '' : lenRaw;
    const weightT = computeWeightT(r);
    const weightStr = weightT == null ? '' : weightT.toFixed(2);

    const isDupMark = r['製品マーク'] && markCounts[r['製品マーク']] > 1;
    const tr = document.createElement('tr');
    if (isDupMark) tr.classList.add('dup-mark-row');

    const cols = [
      r._id, r['図番'] ?? '', r['製品マーク'] ?? '', r['設計符号'] ?? '', size,
      honsuRaw, lenStr, weightStr, r['左継手'] ?? '', r['右継手'] ?? '',
    ];
    const missingIdx = new Set([6, 8, 9]); // 長さ・左継手・右継手が空なら強調
    cols.forEach((v, ci) => {
      const td = document.createElement('td');
      td.textContent = v === null || v === undefined ? '' : v;
      if (missingIdx.has(ci) && !v) td.classList.add('cell-missing');
      tr.appendChild(td);
    });
    tbody.appendChild(tr);
  });
}

// Windowsエクスプローラーの「パスのコピー」は前後を二重引用符で囲むため、あれば取り除く。
function stripQuotes(s) {
  return s.replace(/^"(.*)"$/, '$1');
}

// フォルダの絶対パス(basePath)とファイル名から、そのファイルへのfile://リンクを作る。
// (excel-drawing-link-tool と同じロジック。UNCパス(\\server\share)とローカルドライブ
//  パス(C:\...)の両方に対応する)
function buildFileUrl(basePath, fileName) {
  const normalized = (basePath || '').trim().replace(/\\/g, '/').replace(/\/+$/, '');
  const isUnc = /^\/\//.test(normalized);
  let path = normalized + '/' + fileName;
  let url;
  if (isUnc) {
    url = 'file:' + path;
  } else {
    path = path.replace(/^\/+/, '');
    url = 'file:///' + path;
  }
  return url.replace(/ /g, '%20');
}

// 図面フォルダの絶対パス入力ポップアップ。ブラウザはセキュリティ上ドロップ/選択された
// ファイルの実際の絶対パスを取得できないため、フォルダのパスだけユーザーに貼って
// もらい、既に判明しているファイル名(_filename)と組み合わせてリンクを作る。
// 案件ごとにフォルダが変わるため、前回値は記憶せず毎回空欄から始める。
function askBasePath() {
  return new Promise(resolve => {
    const overlay = document.getElementById('basepath-overlay');
    const textarea = document.getElementById('basepath-textarea');
    const okBtn = document.getElementById('basepath-ok-btn');
    const skipBtn = document.getElementById('basepath-skip-btn');
    textarea.value = '';
    overlay.classList.add('open');
    textarea.focus();

    function cleanup() {
      overlay.classList.remove('open');
      okBtn.removeEventListener('click', onOk);
      skipBtn.removeEventListener('click', onSkip);
    }
    function onOk() {
      const val = stripQuotes(textarea.value.trim());
      cleanup();
      resolve(val);
    }
    function onSkip() {
      cleanup();
      resolve('');
    }
    okBtn.addEventListener('click', onOk);
    skipBtn.addEventListener('click', onSkip);
  });
}

async function downloadExcel() {
  if (extractedResults.length === 0) return;
  const basePath = await askBasePath();

  const headers = ['ID', '工事番号', '図番', '製品マーク', '設計符号', 'サイズ', '本数', '長さ(m)', '重量(t)', '左継手', '右継手'];
  const ZUBAN_COL = 2; // headers配列内の「図番」の列インデックス(0始まり)
  const WEIGHT_COL = 8; // headers配列内の「重量(t)」の列インデックス(0始まり)
  const rows = extractedResults.map(r => {
    const weightT = computeWeightT(r);
    return [
      r._id, kojiNo, r['図番'], r['製品マーク'], r['設計符号'], r['サイズ'], r['本数'],
      r['長さ'], weightT == null ? '' : weightT, r['左継手'], r['右継手'],
    ];
  });
  const excelRows = [headers, ...rows];

  const ws = XLSX.utils.aoa_to_sheet(excelRows);
  // セルの値は丸めない実数値のまま、表示形式(セル書式)だけ小数2桁にする
  // (Excel上で参照・計算する際に元の精度が失われないようにするため)。
  rows.forEach((_row, i) => {
    const cellRef = XLSX.utils.encode_cell({ r: i + 1, c: WEIGHT_COL });
    const cell = ws[cellRef];
    if (cell && typeof cell.v === 'number') cell.z = '0.00';
  });
  // 図面フォルダの絶対パスが入力されていれば、図番セルに元TDFファイルへの
  // ハイパーリンクを付与する(そのファイル名は抽出時点で既に判明しているため、
  // フォルダの絶対パスとファイル名を組み合わせるだけで済む)。
  if (basePath) {
    extractedResults.forEach((r, i) => {
      if (!r._filename) return;
      const cellRef = XLSX.utils.encode_cell({ r: i + 1, c: ZUBAN_COL });
      const cell = ws[cellRef];
      if (cell) cell.l = { Target: buildFileUrl(basePath, r._filename) };
    });
  }
  const wb = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(wb, ws, '製品情報');
  const ts = new Date().toISOString().replace(/[-:T]/g, '').slice(0, 14);
  const baseName = (kojiNo || 'TDF') + '_' + (beamType === 'small' ? '小梁' : '大梁');
  XLSX.writeFile(wb, baseName + '_' + ts + '.xlsx');

  try {
    await apiPost('onExcelDownload', { kojiNo, productCount: extractedResults.length, rows: excelRows });
  } catch (e) {
    console.error('GAS記録エラー', e);
  }
}

function resetApp() {
  extractedResults = [];
  document.getElementById('result-area').classList.remove('visible');
  document.getElementById('empty-state').style.display = 'flex';
  document.getElementById('file-info').textContent = '';
  document.getElementById('btn-reset').disabled = true;
  document.getElementById('btn-excel').disabled = true;
  document.getElementById('file-input').value = '';
}

function showStatus(msg, sub) {
  document.getElementById('status-msg').textContent = msg;
  document.getElementById('status-sub').textContent = sub || '';
  document.getElementById('status-overlay').classList.add('open');
}
function hideStatus() { document.getElementById('status-overlay').classList.remove('open'); }

function showToast(msg, type) {
  const el = document.createElement('div');
  el.className = 'toast-item' + (type ? ' ' + type : '');
  el.textContent = msg;
  document.getElementById('toast').appendChild(el);
  setTimeout(() => el.remove(), 4500);
}

document.getElementById('file-input').addEventListener('change', e => {
  if (e.target.files.length) processFiles(e.target.files);
});

['dragenter', 'dragover'].forEach(ev => {
  document.body.addEventListener(ev, e => {
    e.preventDefault();
    if (pyodide) document.getElementById('drop-overlay').classList.add('active');
  });
});
['dragleave', 'drop'].forEach(ev => {
  document.body.addEventListener(ev, e => {
    e.preventDefault();
    document.getElementById('drop-overlay').classList.remove('active');
  });
});
document.body.addEventListener('drop', e => {
  if (pyodide && e.dataTransfer.files.length) processFiles(e.dataTransfer.files);
});

// アプリを開いた直後(工場選択モーダル表示中)に工事名選択肢・重量表を先読みする。
loadMasterData();
