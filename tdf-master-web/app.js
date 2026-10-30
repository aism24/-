// デプロイ済みGAS WebアプリのURL(/exec で終わるURL)。デプロイ後にここへ差し替えてください。
const GAS_API_URL = "https://script.google.com/macros/s/AKfycbxyGKGdIUONX9-kvs-mTayA3UXp6Rztc9VjP4jloTMRDctTQqrWeIC5CWQDSz4rfXs/exec";

let pyodide = null;
let weightMap = {};
let kojiNo = '';
let selectedFactory = null;
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
  selectedFactory = code;
  document.querySelectorAll('.factory-btn').forEach(btn => {
    btn.classList.toggle('selected', btn.dataset.factory === code);
  });
  // 選択された工場以外はグレーアウトする(押し直せば選択し直せる)。
  document.getElementById('factory-btns').classList.add('has-selection');
  updateStartBtn();
}

const KOJI_STORAGE_KEY = 'tdf_master_web_last_koji';

function updateStartBtn() {
  kojiNo = document.getElementById('koji-select').value;
  const ready = !!(selectedFactory && kojiNo);
  document.getElementById('mode-btn-beam').disabled = !ready;
  document.getElementById('mode-btn-column').disabled = !ready;
  document.getElementById('mode-btn-merge').disabled = !ready;
  if (kojiNo) {
    try { localStorage.setItem(KOJI_STORAGE_KEY, kojiNo); } catch (_) {}
  }
}

// 設定シートの重量表・工事名一覧は、アプリ起動直後(工場・工事名選択
// モーダルを表示する前、Pyodideの起動も待たずに)取得する。取得完了
// (前回選択した工事名の復元含む)まで「読込中」を表示し、完了後に
// モーダルを表示することで、工場・工事名を選択できる時点で工事名
// プルダウンが既に使える状態にする。2つのAPI呼び出しは互いに依存
// しないので並列実行し、直列実行した場合に比べて待ち時間を短縮する。
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

// ---------- モード選択 ----------
// 工場・工事名を選んだ画面で、モードボタン(梁/柱/結合)を押して開始する。
// 開始後はヘッダーの「モード切替」で同じ画面を開き直す(工場・工事名は選んだまま残し、
// 梁モード・柱モードの抽出結果と結合モードの取り込みも消さない)。
// 梁モードと柱モードは抽出のPythonと継手の列(左右/下上)が違うので、抽出結果を
// モードごとに分けて持ち、切り替えたときに入れ替える。

const MODE_NAMES = { beam: '梁モード', column: '柱モード', merge: '結合モード' };
const JOINT_HEADERS = { beam: ['左継手', '右継手'], column: ['下継手', '上継手'] };
let currentMode = null;
let resultsMode = 'beam'; // extractedResults がどちらのモードの結果か
const savedResults = { beam: { rows: [], info: '' }, column: { rows: [], info: '' } };
let appliedFactory = null; // 最後にモードボタンを押したときの工場・工事名(キャンセルで戻す)
let appliedKoji = '';

function jointKeys() { return JOINT_HEADERS[resultsMode]; }

// 梁モード⇔柱モードの切り替えで、抽出結果・件数表示・表の継手の見出しを入れ替える。
function switchResults(mode) {
  if (mode === resultsMode) return;
  savedResults[resultsMode] = { rows: extractedResults, info: document.getElementById('file-info').textContent };
  resultsMode = mode;
  extractedResults = savedResults[mode].rows;
  document.getElementById('file-info').textContent = savedResults[mode].info;
  const [a, b] = jointKeys();
  document.getElementById('th-joint-a').textContent = a;
  document.getElementById('th-joint-b').textContent = b;
  document.getElementById('file-input').value = '';
  if (extractedResults.length > 0) renderTable(extractedResults);
}

async function startApp(mode) {
  // 利用記録シートへ日時・工場・モードを記録する(失敗してもアプリ利用は継続させる)。
  apiPost('logUsageStart', { factory: FACTORY_NAMES[selectedFactory] || selectedFactory, mode: MODE_NAMES[mode] }).catch(() => {});
  moveManualButtonToHeader();
  document.getElementById('beam-modal').classList.add('hidden');
  currentMode = mode;
  appliedFactory = selectedFactory;
  appliedKoji = kojiNo;
  const kojiName = document.getElementById('koji-select').selectedOptions[0]?.textContent || kojiNo;
  document.getElementById('beam-type-label').textContent = kojiNo + '＿' + kojiName;
  document.getElementById('mode-label').textContent = MODE_NAMES[mode];
  document.body.classList.add('app-started');
  if (mode === 'merge') {
    if (!mergeMode) openMerge();
    return;
  }
  switchResults(mode);
  if (mergeMode) closeMerge();
  else showExtractView();
  // Pyodideは梁モード・柱モードを初めて選んだときだけ読み込む(結合モードでは使わない)。
  if (!pyodide) await initPyodide();
}

function openModeSelect() {
  document.getElementById('beam-modal').classList.remove('hidden');
}

function closeModeSelect() {
  if (appliedFactory) selectFactory(appliedFactory);
  document.getElementById('koji-select').value = appliedKoji;
  updateStartBtn();
  document.getElementById('beam-modal').classList.add('hidden');
}

// ---------- 操作マニュアル(説明書) ----------

const MANUAL_PAGE_COUNT = 11;
let manualPage = 1;

// 1ページ目のPDF埋め込みリンク(「実際のアプリを開く」)の矩形を、PDFページ
// 全体に対する割合で表したもの(page.get_links()の座標から算出)。
const MANUAL_LINK_RECT_PCT = { left: 0.0671875, top: 0.8736111111111111, width: 0.2125, height: 0.07916666666666666 };

// 説明書を画面いっぱいに表示する都合上、画像はmax-width/max-height:100%で
// アスペクト比を保って収められるため、表示領域(#manual-image-wrap)より
// 実際の画像が小さくなる(上下または左右に余白が出る)ことがある。そのため
// リンクの重ね要素はCSSの割合指定ではなく、実際に描画された<img>の矩形を
// 都度計測して位置・サイズを反映する。
function positionManualLink() {
  const link = document.getElementById('manual-link-app');
  const img = document.getElementById('manual-image');
  const wrap = document.getElementById('manual-image-wrap');
  if (!link || !img || !wrap || !link.classList.contains('visible')) return;
  const place = () => {
    const imgRect = img.getBoundingClientRect();
    const wrapRect = wrap.getBoundingClientRect();
    const offsetX = imgRect.left - wrapRect.left;
    const offsetY = imgRect.top - wrapRect.top;
    link.style.left = (offsetX + imgRect.width * MANUAL_LINK_RECT_PCT.left) + 'px';
    link.style.top = (offsetY + imgRect.height * MANUAL_LINK_RECT_PCT.top) + 'px';
    link.style.width = (imgRect.width * MANUAL_LINK_RECT_PCT.width) + 'px';
    link.style.height = (imgRect.height * MANUAL_LINK_RECT_PCT.height) + 'px';
  };
  if (img.complete) place(); else img.onload = place;
}

window.addEventListener('resize', () => {
  if (document.getElementById('manual-overlay').classList.contains('open')) positionManualLink();
});

function renderManualPage() {
  document.getElementById('manual-image').src = `assets/manual/page${manualPage}.png?v=20261030`;
  document.getElementById('manual-page-indicator').textContent = `${manualPage} / ${MANUAL_PAGE_COUNT}`;
  document.getElementById('manual-prev').disabled = manualPage <= 1;
  document.getElementById('manual-next').disabled = manualPage >= MANUAL_PAGE_COUNT;
  document.getElementById('manual-link-app').classList.toggle('visible', manualPage === 1);
  positionManualLink();
}

function openManual() {
  manualPage = 1;
  renderManualPage();
  document.getElementById('manual-overlay').classList.add('open');
}

function closeManual() {
  document.getElementById('manual-overlay').classList.remove('open');
}

function manualPrev() {
  if (manualPage > 1) { manualPage--; renderManualPage(); }
}

function manualNext() {
  if (manualPage < MANUAL_PAGE_COUNT) { manualPage++; renderManualPage(); }
}

// 最初にモードボタンを押したとき、説明書ボタンを工場・工事名選択モーダル内から
// ヘッダーの会社ロゴ左側へ移動させる。FLIP(First-Last-Invert-Play)手法:
// 先に実際の移動先(ヘッダー)へ要素を配置してしまい、旧位置・旧サイズとの
// 差分から逆算したtransformを一旦適用して見た目上は元の位置に留めておき、
// そのtransformを解除するアニメーションを再生することで、「縮みながら
// 移動する」演出を実現する(要素を毎フレームJSで動かす方式より軽量)。
function moveManualButtonToHeader() {
  const btn = document.getElementById('manual-btn');
  const headerBrand = document.getElementById('header-brand');
  if (!btn || !headerBrand) return;
  if (btn.classList.contains('manual-btn-header')) return; // モード切替で2回目以降に呼ばれたとき

  const firstRect = btn.getBoundingClientRect();

  btn.classList.remove('manual-btn');
  btn.classList.add('manual-btn-header');
  btn.textContent = '説明書';
  headerBrand.insertBefore(btn, headerBrand.firstChild);

  const lastRect = btn.getBoundingClientRect();
  const dx = firstRect.left - lastRect.left;
  const dy = firstRect.top - lastRect.top;
  const sx = firstRect.width / lastRect.width;
  const sy = firstRect.height / lastRect.height;

  btn.style.position = 'relative';
  btn.style.zIndex = '2500';
  btn.style.transformOrigin = 'top left';
  btn.style.transition = 'none';
  btn.style.transform = `translate(${dx}px, ${dy}px) scale(${sx}, ${sy})`;
  void btn.offsetWidth; // 上記transformを一度確実に反映させる(強制リフロー)

  requestAnimationFrame(() => {
    btn.style.transition = 'transform .6s cubic-bezier(0.22, 1, 0.36, 1)';
    btn.style.transform = 'none';
  });

  btn.addEventListener('transitionend', function onEnd() {
    btn.style.transition = '';
    btn.style.zIndex = '';
    btn.style.position = '';
    btn.style.transformOrigin = '';
    btn.removeEventListener('transitionend', onEnd);
  });
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
      '/scripts/tdf_column.py': 'py-tdf-column',
    };
    for (const [path, elId] of Object.entries(files)) {
      pyodide.FS.writeFile(path, document.getElementById(elId).textContent);
    }
    await pyodide.runPythonAsync("import sys\nsys.path.insert(0, '/scripts')\nimport tdf_app\nimport tdf_column");

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
      // 柱モードは柱・間柱用の別のPython(tdf_column.py)で抽出する
      const pyModule = resultsMode === 'column' ? 'tdf_column' : 'tdf_app';
      const pyResult = await pyodide.runPythonAsync(`${pyModule}.extract_file('/input.tdf')`);
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
  const [ja, jb] = jointKeys(); // 梁モードは左継手・右継手、柱モードは下継手・上継手

  const markCounts = {};
  results.forEach(r => { if (r['製品マーク']) markCounts[r['製品マーク']] = (markCounts[r['製品マーク']] || 0) + 1; });

  results.forEach(r => {
    const size = r['サイズ'] ?? '';
    const honsuRaw = r['本数'] ?? '';
    const lenRaw = r['長さ'];
    // 表示は ##.####(小数4桁まで、末尾の0は出さない)。Excelには元の値を書く。
    const lenStr = (lenRaw === null || lenRaw === undefined || lenRaw === '') ? '' : String(Number(Number(lenRaw).toFixed(4)));
    const weightT = computeWeightT(r);
    const weightStr = weightT == null ? '' : weightT.toFixed(2);

    const isDupMark = r['製品マーク'] && markCounts[r['製品マーク']] > 1;
    const tr = document.createElement('tr');
    if (isDupMark) tr.classList.add('dup-mark-row');

    const cols = [
      r._id, r['図番'] ?? '', r['製品マーク'] ?? '', r['設計符号'] ?? '', size,
      honsuRaw, lenStr, weightStr, r[ja] ?? '', r[jb] ?? '',
    ];
    const missingIdx = new Set([6, 8, 9]); // 長さ・継手が空なら強調
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
    const pasteBtn = document.getElementById('basepath-paste-btn');
    const okBtn = document.getElementById('basepath-ok-btn');
    const skipBtn = document.getElementById('basepath-skip-btn');
    textarea.value = '';
    overlay.classList.add('open');
    textarea.focus();

    function cleanup() {
      overlay.classList.remove('open');
      pasteBtn.removeEventListener('click', onPaste);
      okBtn.removeEventListener('click', onOk);
      skipBtn.removeEventListener('click', onSkip);
    }
    async function onPaste() {
      try {
        textarea.value = stripQuotes((await navigator.clipboard.readText()).trim());
        textarea.focus();
      } catch (e) {
        showToast('クリップボードを読み取れませんでした。テキスト欄に直接貼り付けてください', 'error');
      }
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
    pasteBtn.addEventListener('click', onPaste);
    okBtn.addEventListener('click', onOk);
    skipBtn.addEventListener('click', onSkip);
  });
}

// 各列の最大文字幅(全角文字は2、半角文字は1として概算)から、Excelの列幅を
// オートフィットに近い形で求める。SheetJSコミュニティ版は列幅の指定
// (`!cols`)には対応しているため、追加ライブラリなしで実現できる。
function computeColWidths(aoaRows) {
  const colCount = aoaRows[0].length;
  const widths = new Array(colCount).fill(0);
  aoaRows.forEach(row => {
    row.forEach((cell, ci) => {
      const s = cell === null || cell === undefined ? '' : String(cell);
      let w = 0;
      for (const ch of s) w += /[^\x00-\xff]/.test(ch) ? 2 : 1;
      if (w > widths[ci]) widths[ci] = w;
    });
  });
  return widths.map(w => ({ wch: Math.min(Math.max(w + 2, 6), 60) }));
}

// ハイパーリンクを付与したセルへ、Excel標準のハイパーリンク書式(青太字・
// 下線)を適用する。SheetJSコミュニティ版はcell.sによる書式書き込みに
// 対応していない(書式書き込みは有償のPro版のみ)ため、生成されたxlsx
// (実体はzip)をJSZipで開き、styles.xmlへ新しいフォント定義とセル書式を
// 追加、対象セルのs属性を差し替える形で実現する。
async function applyHyperlinkStyle(wb, hyperlinkRefs) {
  const arrayBuf = XLSX.write(wb, { type: 'array', bookType: 'xlsx' });
  const zip = await JSZip.loadAsync(arrayBuf);

  let stylesXml = await zip.file('xl/styles.xml').async('string');
  const fontCount = parseInt(stylesXml.match(/<fonts count="(\d+)">/)[1], 10);
  const newFontId = fontCount;
  stylesXml = stylesXml
    .replace(/<fonts count="(\d+)">/, `<fonts count="${fontCount + 1}">`)
    .replace('</fonts>', '<font><u/><b/><sz val="11"/><color rgb="FF0000FF"/><name val="Calibri"/><family val="2"/><scheme val="minor"/></font></fonts>');

  const xfCount = parseInt(stylesXml.match(/<cellXfs count="(\d+)">/)[1], 10);
  const newXfId = xfCount;
  stylesXml = stylesXml
    .replace(/<cellXfs count="(\d+)">/, `<cellXfs count="${xfCount + 1}">`)
    .replace('</cellXfs>', `<xf numFmtId="0" fontId="${newFontId}" fillId="0" borderId="0" xfId="0" applyFont="1"/></cellXfs>`);
  zip.file('xl/styles.xml', stylesXml);

  const refSet = new Set(hyperlinkRefs);
  let sheetXml = await zip.file('xl/worksheets/sheet1.xml').async('string');
  sheetXml = sheetXml.replace(/<c r="([A-Z]+\d+)"([^>]*?)(\/?)>/g, (m, ref, attrs, selfClose) => {
    if (!refSet.has(ref)) return m;
    const cleanedAttrs = attrs.replace(/\ss="\d+"/, '');
    return `<c r="${ref}"${cleanedAttrs} s="${newXfId}"${selfClose}>`;
  });
  zip.file('xl/worksheets/sheet1.xml', sheetXml);

  return zip.generateAsync({ type: 'blob', mimeType: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' });
}

function downloadBlob(blob, filename) {
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url; a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

async function downloadExcel() {
  if (mergeMode) return downloadMergedExcel();
  if (extractedResults.length === 0) return;
  const basePath = await askBasePath();

  const [ja, jb] = jointKeys(); // 梁モードは左継手・右継手、柱モードは下継手・上継手
  const headers = ['ID', '工事番号', '図番', '製品マーク', '設計符号', 'サイズ', '本数', '長さ(m)', '重量(t)', ja, jb];
  const ZUBAN_COL = 2; // headers配列内の「図番」の列インデックス(0始まり)
  const WEIGHT_COL = 8; // headers配列内の「重量(t)」の列インデックス(0始まり)
  const rows = extractedResults.map(r => {
    const weightT = computeWeightT(r);
    return [
      r._id, kojiNo, r['図番'], r['製品マーク'], r['設計符号'], r['サイズ'], r['本数'],
      r['長さ'], weightT == null ? '' : weightT, r[ja], r[jb],
    ];
  });
  const excelRows = [headers, ...rows];

  // スプレッドシート記録用(GAS)のみ、L列=梁判別・M列=段を追加する
  // (ダウンロードするExcelファイル自体には含めない)。
  const recordHeaders = [...headers, '梁判別', '段'];
  const recordRows = extractedResults.map((r, i) => [...rows[i], r['種別'] ?? '', r['製品段'] ?? '']);
  const recordExcelRows = [recordHeaders, ...recordRows];

  const ws = XLSX.utils.aoa_to_sheet(excelRows);
  ws['!cols'] = computeColWidths(excelRows);
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
  const hyperlinkRefs = [];
  if (basePath) {
    extractedResults.forEach((r, i) => {
      if (!r._filename) return;
      const cellRef = XLSX.utils.encode_cell({ r: i + 1, c: ZUBAN_COL });
      const cell = ws[cellRef];
      if (cell) {
        cell.l = { Target: buildFileUrl(basePath, r._filename) };
        hyperlinkRefs.push(cellRef);
      }
    });
  }
  const wb = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(wb, ws, '製品情報');
  const ts = new Date().toISOString().replace(/[-:T]/g, '').slice(0, 14);
  // ファイル名は「工事番号_図番(枝番を除く)_日時」とする。枝番は図番末尾の
  // 「-数字」または「-数字+英数字」(例: -11 / -11A)なので、それを取り除いた
  // 部分を使う。複数図番が含まれる場合は先頭行の図番を代表として使う。
  const firstZuban = extractedResults[0] ? extractedResults[0]['図番'] : '';
  const zubanPrefix = String(firstZuban || '').replace(/-\d+[A-Za-z0-9]*$/, '') || 'TDF';
  const filename = (kojiNo || 'TDF') + '_' + zubanPrefix + '_' + ts + '.xlsx';

  if (hyperlinkRefs.length > 0) {
    try {
      const blob = await applyHyperlinkStyle(wb, hyperlinkRefs);
      downloadBlob(blob, filename);
    } catch (e) {
      console.error('ハイパーリンク書式の適用に失敗しました', e);
      XLSX.writeFile(wb, filename);
    }
  } else {
    XLSX.writeFile(wb, filename);
  }

  try {
    await apiPost('onExcelDownload', { kojiNo, productCount: extractedResults.length, rows: recordExcelRows });
  } catch (e) {
    console.error('GAS記録エラー', e);
  }
}

function resetApp() {
  if (mergeMode) {
    if (mergeFiles.length && confirm('取り込んだ ' + mergeFiles.length + ' ファイルをすべて一覧から外しますか?(Excelファイル自体は消えません)')) {
      mergeFiles = [];
      renderMerge();
    }
    return;
  }
  extractedResults = [];
  document.getElementById('result-area').classList.remove('visible');
  document.getElementById('empty-state').style.display = 'flex';
  document.getElementById('file-info').textContent = '';
  document.getElementById('btn-reset').disabled = true;
  document.getElementById('btn-excel').disabled = true;
  document.getElementById('file-input').value = '';
}

// ---------- 複数のダウンロードファイルの結合 ----------
// フォルダごとにダウンロードしたExcel(ハイパーリンクのフォルダパスがファイルごとに
// 異なる)を取り込み、1つの集計リストExcelにまとめる。ドラッグ&ドロップは画面のどこでも、
// 何回でも追加できる。追加のたびに、(図番+製品マーク)が完全一致する行を持つ別ファイル・
// 工事番号の食い違いを警告する(警告のみで、外すかどうかは利用者が決める)。

let mergeMode = false;
let mergeFiles = []; // { id, name, kojiNo, rows: [{...列, link}], checked }
let mergeSeq = 0;

function mergeRowKey(r) {
  return String(r.zuban).trim() + '\u0000' + String(r.mark).trim();
}

// 先頭シートのハイパーリンク(セル位置→リンク先)を、xlsx(zip)から直接読む。
// SheetJSの cell.l.Target はリンク先の日本語(UTF-8)が文字化けして返るため使わない。
async function readSheetLinks(arrayBuf) {
  const links = {};
  const zip = await JSZip.loadAsync(arrayBuf);
  const attr = (tag, name) => { const m = tag.match(new RegExp('\\s' + name + '="([^"]*)"')); return m ? m[1] : ''; };
  const unesc = (t) => t.replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&apos;/g, "'").replace(/&amp;/g, '&');
  // 先頭シートのパス(workbook.xml + そのrels)。分からなければ sheet1.xml。
  let sheetPath = 'xl/worksheets/sheet1.xml';
  try {
    const wbXml = await zip.file('xl/workbook.xml').async('string');
    const wbRels = await zip.file('xl/_rels/workbook.xml.rels').async('string');
    const firstSheet = (wbXml.match(/<sheet\b[^>]*>/) || [''])[0];
    const rid = attr(firstSheet, 'r:id');
    const rel = (wbRels.match(/<Relationship\b[^>]*>/g) || []).find(t => attr(t, 'Id') === rid);
    if (rel) { const t = attr(rel, 'Target'); sheetPath = t.startsWith('/') ? t.slice(1) : 'xl/' + t; }
  } catch (_) {}
  const sheetXml = await zip.file(sheetPath).async('string');
  const relsPath = sheetPath.replace(/([^/]+)$/, '_rels/$1.rels');
  const relsFile = zip.file(relsPath);
  if (!relsFile) return links;
  const targets = {};
  ((await relsFile.async('string')).match(/<Relationship\b[^>]*>/g) || []).forEach(t => { targets[attr(t, 'Id')] = unesc(attr(t, 'Target')); });
  (sheetXml.match(/<hyperlink\b[^>]*>/g) || []).forEach(t => {
    const target = targets[attr(t, 'r:id')];
    if (!target) return;
    const rng = XLSX.utils.decode_range(attr(t, 'ref'));
    for (let r = rng.s.r; r <= rng.e.r; r++) for (let c = rng.s.c; c <= rng.e.c; c++) links[XLSX.utils.encode_cell({ r, c })] = target;
  });
  return links;
}

// ダウンロード済みExcel(downloadExcelの出力と同じ列)を読み、行データにする。
// 列は見出し文字で探す(列順が変わっても読める)。図番セルのハイパーリンクも保持する。
async function readDownloadedExcel(file) {
  const buf = await file.arrayBuffer();
  const wb = XLSX.read(new Uint8Array(buf), { type: 'array' });
  let links = {};
  try { links = await readSheetLinks(buf); } catch (e) { console.error('ハイパーリンクの読み取りに失敗しました', e); }
  const ws = wb.Sheets[wb.SheetNames[0]];
  if (!ws || !ws['!ref']) throw new Error('シートが空です');
  const aoa = XLSX.utils.sheet_to_json(ws, { header: 1, raw: true, defval: '' });
  const hIdx = aoa.findIndex(row => row.includes('図番') && row.includes('製品マーク'));
  if (hIdx < 0) throw new Error('このアプリでダウンロードしたExcelではありません(見出し「図番」「製品マーク」が見つかりません)');
  const head = aoa[hIdx].map(v => String(v).trim());
  const col = (prefix) => head.findIndex(h => h === prefix || h.startsWith(prefix + '(') || h.startsWith(prefix + '\uff08'));
  const ci = {
    kojiNo: col('工事番号'), zuban: col('図番'), mark: col('製品マーク'), design: col('設計符号'),
    size: col('サイズ'), honsu: col('本数'), len: col('長さ'), weight: col('重量'),
    left: col('左継手'), right: col('右継手'),
  };
  // 柱モードでダウンロードしたExcelは継手が「下継手」「上継手」
  const isColumn = ci.left < 0 && col('下継手') >= 0;
  if (isColumn) { ci.left = col('下継手'); ci.right = col('上継手'); }
  const get = (row, i) => (i < 0 || row[i] === undefined || row[i] === null) ? '' : row[i];
  const rows = [];
  for (let r = hIdx + 1; r < aoa.length; r++) {
    const row = aoa[r];
    const zuban = get(row, ci.zuban), mark = get(row, ci.mark);
    if (String(zuban).trim() === '' && String(mark).trim() === '') continue;
    rows.push({
      kojiNo: String(get(row, ci.kojiNo)).trim(), zuban, mark, design: get(row, ci.design),
      size: get(row, ci.size), honsu: get(row, ci.honsu), len: get(row, ci.len),
      weight: get(row, ci.weight), left: get(row, ci.left), right: get(row, ci.right),
      link: links[XLSX.utils.encode_cell({ r: r, c: ci.zuban })] || '',
    });
  }
  if (rows.length === 0) throw new Error('製品行がありません');
  const kojis = rows.map(r => r.kojiNo).filter(Boolean);
  return { kojiNo: kojis[0] || '', rows, isColumn };
}

async function processMergeFiles(files) {
  const list = Array.from(files).filter(f => /\.xlsx$/i.test(f.name));
  const skipped = Array.from(files).length - list.length;
  if (skipped > 0) showToast('Excel(.xlsx)以外の ' + skipped + ' ファイルは取り込みませんでした', 'error');
  if (list.length === 0) return;
  const errors = [];
  for (const file of list) {
    try {
      const { kojiNo: k, rows, isColumn } = await readDownloadedExcel(file);
      mergeFiles.push({ id: ++mergeSeq, name: file.name, kojiNo: k, rows, isColumn, checked: true });
    } catch (e) {
      errors.push(file.name + ': ' + e.message);
      console.error(e);
    }
  }
  const added = list.length - errors.length;
  if (added > 0) showToast(added + ' ファイルを取り込みました', 'success');
  if (errors.length) showToast('取り込めなかったファイル: ' + errors.join(' / '), 'error');
  document.getElementById('merge-file-input').value = '';
  renderMerge();
}

// 対象(チェック済み)ファイルについて、工事番号の食い違い・他ファイルとの重複を求める。
function analyzeMerge() {
  const checked = mergeFiles.filter(f => f.checked);
  const kojiCount = {};
  checked.forEach(f => { if (f.kojiNo) kojiCount[f.kojiNo] = (kojiCount[f.kojiNo] || 0) + 1; });
  let baseKoji = '';
  checked.forEach(f => { if (f.kojiNo && (!baseKoji || kojiCount[f.kojiNo] > kojiCount[baseKoji])) baseKoji = f.kojiNo; });

  const keySets = new Map(checked.map(f => [f.id, new Set(f.rows.map(mergeRowKey))]));
  const info = new Map();
  mergeFiles.forEach(f => info.set(f.id, { kojiMismatch: false, dups: [] }));
  checked.forEach(f => {
    const entry = info.get(f.id);
    entry.kojiMismatch = !!(baseKoji && f.kojiNo && f.kojiNo !== baseKoji);
    checked.forEach(o => {
      if (o.id === f.id) return;
      const a = keySets.get(f.id), b = keySets.get(o.id);
      let n = 0;
      a.forEach(k => { if (b.has(k)) n++; });
      if (n > 0) entry.dups.push({ name: o.name, count: n, same: n === a.size && a.size === b.size });
    });
  });
  const total = checked.reduce((s, f) => s + f.rows.length, 0);
  const dupFiles = checked.filter(f => info.get(f.id).dups.length > 0).length;
  const kojiMix = checked.some(f => info.get(f.id).kojiMismatch);
  return { checked, info, baseKoji, total, dupFiles, kojiMix };
}

function renderMerge() {
  const { checked, info, baseKoji, total, dupFiles, kojiMix } = analyzeMerge();
  const tbody = document.getElementById('merge-tbody');
  tbody.innerHTML = '';
  // 表は、ファイル内の先頭の図番(昇順)→ファイル名の順に並べる(集計Excelの並びと揃える)。
  const cmp = (p, q) => String(p ?? '').localeCompare(String(q ?? ''), 'ja', { numeric: true });
  const firstZuban = f => f.rows.map(r => String(r.zuban).trim()).sort(cmp)[0] || '';
  const shown = mergeFiles.map(f => ({ f, z: firstZuban(f) })).sort((p, q) => cmp(p.z, q.z) || cmp(p.f.name, q.f.name)).map(o => o.f);
  shown.forEach(f => {
    const inf = info.get(f.id);
    const tr = document.createElement('tr');
    if (!f.checked) tr.classList.add('merge-off');
    if (f.checked && (inf.dups.length || inf.kojiMismatch)) tr.classList.add('merge-warn');

    const tdChk = document.createElement('td');
    const chk = document.createElement('input');
    chk.type = 'checkbox'; chk.checked = f.checked; chk.title = '集計に含める';
    chk.addEventListener('change', () => { f.checked = chk.checked; renderMerge(); });
    tdChk.appendChild(chk);

    const tdName = document.createElement('td'); tdName.textContent = f.name; tdName.className = 'merge-name';
    const tdKoji = document.createElement('td'); tdKoji.textContent = f.kojiNo;
    const tdCnt = document.createElement('td'); tdCnt.textContent = f.rows.length;
    const tdZ = document.createElement('td');
    const zubans = [...new Set(f.rows.map(r => String(r.zuban).trim()))].sort(cmp);
    tdZ.textContent = zubans.length > 2 ? zubans.slice(0, 2).join(' / ') + ' ほか' + (zubans.length - 2) : zubans.join(' / ');

    const tdWarn = document.createElement('td'); tdWarn.className = 'merge-msg';
    if (!f.checked) {
      tdWarn.textContent = '(集計に含めません)';
    } else {
      const msgs = [];
      if (inf.kojiMismatch) msgs.push('⚠ 工事番号が他と異なります(' + f.kojiNo + ' ≠ ' + baseKoji + ')');
      inf.dups.forEach(d => msgs.push(d.same
        ? '⚠ 「' + d.name + '」と内容が同じです(' + d.count + '件すべて重複)'
        : '⚠ 「' + d.name + '」と ' + d.count + ' 件重複(図番+製品マーク一致)'));
      if (msgs.length === 0) msgs.push('OK');
      msgs.forEach(m => { const d = document.createElement('div'); d.textContent = m; tdWarn.appendChild(d); });
    }

    const tdDel = document.createElement('td');
    const del = document.createElement('button');
    del.type = 'button'; del.textContent = '外す'; del.className = 'header-btn';
    del.addEventListener('click', () => { mergeFiles = mergeFiles.filter(x => x.id !== f.id); renderMerge(); });
    tdDel.appendChild(del);

    [tdChk, tdName, tdKoji, tdCnt, tdZ, tdWarn, tdDel].forEach(td => tr.appendChild(td));
    tbody.appendChild(tr);
  });

  document.getElementById('merge-empty').style.display = mergeFiles.length ? 'none' : 'block';
  document.getElementById('merge-table-wrap').style.display = mergeFiles.length ? 'block' : 'none';

  let sum = '対象 ' + checked.length + ' ファイル / 合計 ' + total + ' 行';
  if (dupFiles) sum += ' ⚠重複あり';
  if (kojiMix) sum += ' ⚠工事番号が混在';
  const sumEl = document.getElementById('merge-summary');
  sumEl.textContent = sum;
  sumEl.classList.toggle('warn', !!(dupFiles || kojiMix));
  // 結合モード中は、ヘッダーのExcelダウンロード=集計リストの出力、リセット=取り込み一覧のクリア。
  document.getElementById('btn-excel').disabled = checked.length === 0;
  document.getElementById('btn-reset').disabled = mergeFiles.length === 0;
}

function openMerge() {
  mergeMode = true;
  document.getElementById('empty-state').style.display = 'none';
  document.getElementById('result-area').classList.remove('visible');
  document.getElementById('merge-area').classList.add('open');
  document.getElementById('drop-overlay').textContent = 'Excelファイルをここにドロップ';
  renderMerge();
}

function closeMerge() {
  mergeMode = false;
  document.getElementById('merge-area').classList.remove('open');
  document.getElementById('drop-overlay').textContent = 'TDFファイルをここにドロップ';
  showExtractView();
}

// 抽出画面(梁モード・柱モード)を、今の抽出結果の有無に合わせて表示する。
function showExtractView() {
  const has = extractedResults.length > 0;
  document.getElementById('btn-excel').disabled = !has;
  document.getElementById('btn-reset').disabled = !has;
  document.getElementById('result-area').classList.toggle('visible', has);
  document.getElementById('empty-state').style.display = has ? 'none' : 'flex';
}

async function downloadMergedExcel() {
  const { checked, info, baseKoji, total } = analyzeMerge();
  if (checked.length === 0) return;
  const warnings = [];
  if (checked.some(f => info.get(f.id).dups.length)) warnings.push('図番+製品マークが重複しているファイルがあります。');
  if (checked.some(f => info.get(f.id).kojiMismatch)) warnings.push('工事番号が異なるファイルが混ざっています。');
  if (warnings.length && !confirm(warnings.join('\n') + '\nこのまま ' + total + ' 行を集計リストにしますか?')) return;

  // 図番→製品マークの順に並べてIDを1から振り直す(通常のダウンロードと同じ並び・ID形式)。
  // 工事番号が混在していても、IDは行の工事番号ごとに1から振る。
  const all = [];
  checked.forEach(f => f.rows.forEach(r => all.push(r)));
  all.sort((a, b) => {
    const cmp = (x, y) => String(x ?? '').localeCompare(String(y ?? ''), 'ja', { numeric: true });
    return cmp(a.zuban, b.zuban) || cmp(a.mark, b.mark);
  });
  const counters = {};
  const rows = all.map(r => {
    const koji = r.kojiNo || baseKoji;
    counters[koji] = (counters[koji] || 0) + 1;
    return [
      koji.replace(/-/g, '') + String(counters[koji]).padStart(4, '0'), koji, r.zuban, r.mark, r.design,
      r.size, r.honsu, r.len, r.weight, r.left, r.right,
    ];
  });

  // 柱モードのExcelだけを結合したときは継手の見出しを下継手・上継手にする
  // (梁と柱が混ざるときは左継手・右継手のまま。柱の行は左=下、右=上)
  const [ja, jb] = JOINT_HEADERS[checked.every(f => f.isColumn) ? 'column' : 'beam'];
  const headers = ['ID', '工事番号', '図番', '製品マーク', '設計符号', 'サイズ', '本数', '長さ(m)', '重量(t)', ja, jb];
  const ZUBAN_COL = 2, WEIGHT_COL = 8;
  const excelRows = [headers, ...rows];
  const ws = XLSX.utils.aoa_to_sheet(excelRows);
  ws['!cols'] = computeColWidths(excelRows);
  const hyperlinkRefs = [];
  all.forEach((r, i) => {
    const wCell = ws[XLSX.utils.encode_cell({ r: i + 1, c: WEIGHT_COL })];
    if (wCell && typeof wCell.v === 'number') wCell.z = '0.00';
    if (r.link) {
      const ref = XLSX.utils.encode_cell({ r: i + 1, c: ZUBAN_COL });
      if (ws[ref]) { ws[ref].l = { Target: r.link }; hyperlinkRefs.push(ref); }
    }
  });
  const wb = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(wb, ws, '製品情報');
  const ts = new Date().toISOString().replace(/[-:T]/g, '').slice(0, 14);
  const filename = (baseKoji || 'TDF') + '_' + ts + '.xlsx';

  if (hyperlinkRefs.length > 0) {
    try {
      downloadBlob(await applyHyperlinkStyle(wb, hyperlinkRefs), filename);
    } catch (e) {
      console.error('ハイパーリンク書式の適用に失敗しました', e);
      XLSX.writeFile(wb, filename);
    }
  } else {
    XLSX.writeFile(wb, filename);
  }

  // 通常のダウンロードと同じ形式でスプレッドシートへ記録する(梁判別・段は、
  // ダウンロード済みExcelに無いため空欄)。失敗してもダウンロードは完了させる。
  try {
    const recordRows = [[...headers, '梁判別', '段'], ...rows.map(r => [...r, '', ''])];
    await apiPost('onExcelDownload', { kojiNo: baseKoji, productCount: rows.length, rows: recordRows });
  } catch (e) {
    console.error('GAS記録エラー', e);
  }
}

document.getElementById('merge-file-input').addEventListener('change', e => {
  if (e.target.files.length) processMergeFiles(e.target.files);
});

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
    if (pyodide || mergeMode) document.getElementById('drop-overlay').classList.add('active');
  });
});
['dragleave', 'drop'].forEach(ev => {
  document.body.addEventListener(ev, e => {
    e.preventDefault();
    document.getElementById('drop-overlay').classList.remove('active');
  });
});
document.body.addEventListener('drop', e => {
  if (mergeMode) {
    if (e.dataTransfer.files.length) processMergeFiles(e.dataTransfer.files);
    return;
  }
  if (pyodide && e.dataTransfer.files.length) processFiles(e.dataTransfer.files);
});

// アプリ起動直後は「読込中」を表示し、工事名選択肢・重量表の取得(前回選択
// した工事名の復元含む)が完了してから工場・工事名選択モーダルを表示する。
(async () => {
  showStatus('読込中', '工事情報を取得しています…');
  await loadMasterData();
  hideStatus();
  document.getElementById('beam-modal').classList.remove('hidden');
})();
