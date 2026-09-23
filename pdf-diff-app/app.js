// デプロイ済みGAS WebアプリのURL(/exec で終わるURL)。デプロイ後にここへ差し替えてください。
const GAS_API_URL = "https://script.google.com/macros/s/AKfycbzLz81VioiuR3ku_utdvDlwpT6ImXXQmM6ziZtDX4If9Q0MWxi0926U8rFikxEV9qo4Ig/exec";

// 表/文章/図面の各モードの比較は、必ずVercelのPythonサーバーレス関数で行う
// (同一オリジンの相対パス。Vercelデプロイ時のみ存在する)。ブラウザ内(JS)
// での計算は行わない(Python版と結果がズレる実害バグがあったため撤去済み)。
// そのためVercel未デプロイの環境(githackプレビュー等)では解析が失敗する。
const DIFF_API_URLS = {
  table: "/api/table_diff",
  text: "/api/text_diff",
  image: "/api/image_diff",
};

pdfjsLib.GlobalWorkerOptions.workerSrc =
  "https://cdnjs.cloudflare.com/ajax/libs/pdf.js/3.11.174/pdf.worker.min.js";

let oldFile = null;
let newFile = null;
let lastResult = null;
let selectedMode = null; // 'table' | 'text' | 'image'。自動判定は行わず、ユーザーの指定を必須とする。
let currentPageIndex = 0; // 解析結果のうち、旧新で共通して表示中のページ番号(0始まり)
let viewMode = 'side'; // 'side'(左右表示) | 'overlay'(重ね合わせ)
let overlayLayer = 'both'; // 重ね合わせ時のみ有効: 'old' | 'both' | 'new'
const MODE_LABELS = { table: '表', text: '文章', image: '図面' };
const zoomBySide = { old: 1.0, new: 1.0 };
const panBySide = { old: { x: 0, y: 0 }, new: { x: 0, y: 0 } };

const els = {
  homeScreen: document.getElementById('home-screen'),
  appScreen: document.getElementById('app-screen'),
  homeBtn: document.getElementById('home-btn'),
  oldInput: document.getElementById('old-pdf'),
  newInput: document.getElementById('new-pdf'),
  oldBtn: document.getElementById('old-pdf-btn'),
  newBtn: document.getElementById('new-pdf-btn'),
  oldName: document.getElementById('old-pdf-name'),
  newName: document.getElementById('new-pdf-name'),
  oldField: document.getElementById('old-pdf-field'),
  newField: document.getElementById('new-pdf-field'),
  runBtn: document.getElementById('run-btn'),
  resetBtn: document.getElementById('reset-btn'),
  pageNav: document.getElementById('page-nav'),
  pagePrevBtn: document.getElementById('page-prev-btn'),
  pageNextBtn: document.getElementById('page-next-btn'),
  pageInput: document.getElementById('page-input'),
  pageTotalLabel: document.getElementById('page-total-label'),
  viewModeBtn: document.getElementById('view-mode-btn'),
  overlayLayerNav: document.getElementById('overlay-layer-nav'),
  layerBtns: document.querySelectorAll('.layer-btn'),
  modeBtns: document.querySelectorAll('.type-btn'),
  selectedModeLabel: document.getElementById('selected-mode-label'),
  imageModeNotice: document.getElementById('image-mode-notice'),
  analyzingOverlay: document.getElementById('analyzing-overlay'),
  status: document.getElementById('status'),
  resultSection: document.getElementById('result-section'),
  resultCategory: document.getElementById('result-category'),
  downloadBtn: document.getElementById('download-btn'),
  viewers: {
    old: document.getElementById('viewer-old'),
    new: document.getElementById('viewer-new'),
  },
};

function updateRunEnabled() {
  els.runBtn.disabled = !(oldFile && newFile && selectedMode);
}

function updateResetEnabled() {
  // ファイルが1つも選択されておらず解析結果も無い間は、リセットボタンもグレーアウトのままにする
  els.resetBtn.disabled = !(oldFile || newFile || lastResult);
}

function setMode(mode) {
  selectedMode = mode;
  els.modeBtns.forEach((btn) => btn.classList.toggle('active', btn.dataset.mode === mode));
  els.selectedModeLabel.textContent = mode ? MODE_LABELS[mode] : '';
  els.imageModeNotice.classList.toggle('hidden', mode !== 'image');
  updateRunEnabled();
  updateResetEnabled();
}

function setAnalyzing(isAnalyzing) {
  els.analyzingOverlay.classList.toggle('hidden', !isAnalyzing);
}

function setOldFile(file) {
  oldFile = file || null;
  els.oldName.textContent = oldFile ? oldFile.name : '未選択(ドラッグ&ドロップ可)';
  els.oldBtn.disabled = !!oldFile;
  updateRunEnabled();
  updateResetEnabled();
}

function setNewFile(file) {
  newFile = file || null;
  els.newName.textContent = newFile ? newFile.name : '未選択(ドラッグ&ドロップ可)';
  els.newBtn.disabled = !!newFile;
  updateRunEnabled();
  updateResetEnabled();
}

els.oldInput.addEventListener('change', (e) => setOldFile(e.target.files[0]));
els.newInput.addEventListener('change', (e) => setNewFile(e.target.files[0]));

function setupDropZone(fieldEl, setFile) {
  ['dragenter', 'dragover'].forEach((evt) => {
    fieldEl.addEventListener(evt, (e) => {
      e.preventDefault();
      fieldEl.classList.add('drag-over');
    });
  });
  ['dragleave', 'dragend'].forEach((evt) => {
    fieldEl.addEventListener(evt, () => fieldEl.classList.remove('drag-over'));
  });
  fieldEl.addEventListener('drop', (e) => {
    e.preventDefault();
    fieldEl.classList.remove('drag-over');
    const file = e.dataTransfer.files && e.dataTransfer.files[0];
    if (file && file.type === 'application/pdf') setFile(file);
  });
}

setupDropZone(els.oldField, setOldFile);
setupDropZone(els.newField, setNewFile);

function clearWorkArea() {
  lastResult = null;
  currentPageIndex = 0;
  els.oldInput.value = '';
  els.newInput.value = '';
  setOldFile(null);
  setNewFile(null);
  setMode(null);
  clearLog();
  els.resultSection.classList.add('hidden');
  els.viewers.old.innerHTML = '';
  els.viewers.new.innerHTML = '';
  els.pageNav.classList.add('hidden');
  els.pageInput.value = '1';
  els.pageTotalLabel.textContent = '';
  els.viewModeBtn.classList.add('hidden');
  overlayLayer = 'both';
  els.layerBtns.forEach((b) => b.classList.toggle('active', b.dataset.layer === 'both'));
  setViewMode('side');
}

els.resetBtn.addEventListener('click', clearWorkArea);

els.modeBtns.forEach((btn) => {
  btn.addEventListener('click', () => {
    setMode(btn.dataset.mode);
    els.homeScreen.classList.add('hidden');
    els.appScreen.classList.remove('hidden');
    els.homeBtn.classList.remove('hidden');
  });
});

els.homeBtn.addEventListener('click', () => {
  clearWorkArea();
  els.appScreen.classList.add('hidden');
  els.homeScreen.classList.remove('hidden');
  els.homeBtn.classList.add('hidden');
});

function log(msg) {
  const p = document.createElement('div');
  p.textContent = msg;
  els.status.appendChild(p);
  els.status.scrollTop = els.status.scrollHeight;
}

function clearLog() {
  els.status.innerHTML = '';
}

function formatDateJST(date) {
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Asia/Tokyo',
    year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', second: '2-digit',
    hour12: false,
  }).formatToParts(date);
  const get = (type) => parts.find((p) => p.type === type).value;
  return `${get('year')}-${get('month')}-${get('day')} ${get('hour')}:${get('minute')}:${get('second')}`;
}

function fileToArrayBuffer(file) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(reader.result);
    reader.onerror = reject;
    reader.readAsArrayBuffer(file);
  });
}

async function sendLog(category) {
  if (!GAS_API_URL) return;
  try {
    await fetch(GAS_API_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'text/plain;charset=utf-8' },
      body: JSON.stringify({ date: formatDateJST(new Date()), category }),
    });
  } catch (err) {
    // 記録の失敗はアプリ本来の解析結果表示を止めない
    console.warn('記録シートへの書き込みに失敗しました', err);
  }
}

// ページごとのヘッダーに、その面(旧/新)のズーム操作をまとめて載せる。
// ページ数分だけ同じ操作一式が繰り返し生成されるが、IDではなくdata-side/
// data-actionでイベント委譲するため個数はいくつでもよく、position:stickyに
// より現在スクロール中のページのヘッダーが画面上部に固定表示される。
function buildHeader(label, side) {
  const header = document.createElement('div');
  header.className = `page-col-header page-col-header-${side}`;

  const labelEl = document.createElement('span');
  labelEl.className = 'page-label';
  labelEl.textContent = label;
  header.appendChild(labelEl);

  const zoomControls = document.createElement('div');
  zoomControls.className = 'zoom-controls';
  zoomControls.innerHTML = `
    <button type="button" class="zoom-btn" data-side="${side}" data-action="out" title="縮小">－</button>
    <span class="zoom-level" data-side="${side}">${Math.round(zoomBySide[side] * 100)}%</span>
    <button type="button" class="zoom-btn" data-side="${side}" data-action="in" title="拡大">＋</button>
    <button type="button" class="zoom-btn zoom-reset-btn" data-side="${side}" data-action="reset" title="ズームを元に戻す">戻す</button>
  `;
  header.appendChild(zoomControls);
  return header;
}

// 表モード(サーバーAPI経由)はcanvasではなくHTMLImageElementが渡ってくるため、
// toDataURLが無ければsrcをそのまま使う
function toImgSrc(canvas) {
  return typeof canvas.toDataURL === 'function' ? canvas.toDataURL('image/png') : canvas.src;
}

function buildSide(canvas, label, side, placeholderMessage) {
  const col = document.createElement('div');
  col.className = `page-col page-col-${side}`;
  col.appendChild(buildHeader(label, side));

  const viewport = document.createElement('div');
  viewport.className = 'page-viewport';

  if (canvas) {
    const img = document.createElement('img');
    img.src = toImgSrc(canvas);
    img.className = 'page-image';
    img.draggable = false;
    viewport.appendChild(img);
  } else {
    const ph = document.createElement('div');
    ph.className = `page-placeholder page-placeholder-${side}`;
    ph.textContent = placeholderMessage || '';
    viewport.appendChild(ph);
  }
  col.appendChild(viewport);
  return col;
}

// 重ね合わせ表示: 旧新のページ画像を同じ.page-viewportに重ねて配置する。
// ズーム・パンは(独立した旧新ではなく)oldのスロットを共用の状態として使う
// ため、ヘッダーのズーム操作もdata-side="old"のまま流用する。
function buildOverlayView(r) {
  const col = document.createElement('div');
  col.className = 'page-col page-col-old';
  col.appendChild(buildHeader(`重ね合わせ: ${r.labelOld} / ${r.labelNew}`, 'old'));

  const viewport = document.createElement('div');
  viewport.className = 'page-viewport';

  if (r.oldCanvas) {
    const imgOld = document.createElement('img');
    imgOld.src = toImgSrc(r.oldCanvas);
    imgOld.className = 'page-image overlay-image overlay-image-old';
    imgOld.draggable = false;
    viewport.appendChild(imgOld);
  }
  if (r.newCanvas) {
    const imgNew = document.createElement('img');
    imgNew.src = toImgSrc(r.newCanvas);
    imgNew.className = 'page-image overlay-image overlay-image-new';
    imgNew.draggable = false;
    viewport.appendChild(imgNew);
  }
  if (!r.oldCanvas && !r.newCanvas) {
    const ph = document.createElement('div');
    ph.className = 'page-placeholder page-placeholder-old';
    ph.textContent = r.placeholderMessage || '';
    viewport.appendChild(ph);
  }
  col.appendChild(viewport);
  return col;
}

// 重ね合わせ時の旧/両/新レイヤーの表示・非表示を反映する
function applyOverlayLayer() {
  const viewerEl = els.viewers.old;
  const imgOld = viewerEl.querySelector('.overlay-image-old');
  const imgNew = viewerEl.querySelector('.overlay-image-new');
  if (imgOld) imgOld.style.opacity = overlayLayer === 'new' ? '0' : overlayLayer === 'both' ? '0.6' : '1';
  if (imgNew) imgNew.style.opacity = overlayLayer === 'old' ? '0' : overlayLayer === 'both' ? '0.6' : '1';
}

els.layerBtns.forEach((btn) => {
  btn.addEventListener('click', () => {
    overlayLayer = btn.dataset.layer;
    els.layerBtns.forEach((b) => b.classList.toggle('active', b === btn));
    applyOverlayLayer();
  });
});

// 左右表示⇔重ね合わせの切り替え時は、旧/新どちらのズーム率もリセットする。
// (重ね合わせ表示は常にoldスロットのズーム状態を流用するため、切り替え前に
// oldだけを拡大していると、切り替え後もそのズーム率を引き継いでしまう一方、
// newは表示されていた間ズーム操作を受け付けないため直前の値のまま残り、
// 旧新でズーム率がズレたまま表示される問題があった。切り替えのたびに必ず
// 全体表示(fit-to-width=100%)へ揃えることでこれを防ぐ)
function setViewMode(mode) {
  viewMode = mode;
  els.viewModeBtn.textContent = viewMode === 'side' ? '重ね合わせ' : '左右表示';
  els.resultSection.classList.toggle('overlay-mode', viewMode === 'overlay');
  els.overlayLayerNav.classList.toggle('hidden', viewMode !== 'overlay');
  zoomBySide.old = 1.0;
  zoomBySide.new = 1.0;
  if (lastResult) showPage(currentPageIndex);
}

els.viewModeBtn.addEventListener('click', () => {
  setViewMode(viewMode === 'side' ? 'overlay' : 'side');
});

// 旧新を1枚の合成画像に描くのではなく、別々の<img>としてそれぞれのペインに
// そのまま表示する(左右表示時)。これにより旧PDF/新PDFを個別にズーム・パン
// できる。複数ページある場合はスクロールでめくらせず、旧新で同じページ番号を
// 1組だけ表示する。重ね合わせ表示時はoldのペインのみに旧新を重ねて描画する。
function showPage(index) {
  if (!lastResult || !lastResult.results.length) return;
  const results = lastResult.results;
  currentPageIndex = Math.max(0, Math.min(index, results.length - 1));
  const r = results[currentPageIndex];

  els.viewers.old.innerHTML = '';
  els.viewers.new.innerHTML = '';
  if (viewMode === 'overlay') {
    els.viewers.old.appendChild(buildOverlayView(r));
  } else {
    els.viewers.old.appendChild(buildSide(r.oldCanvas, r.labelOld, 'old', r.placeholderMessage));
    els.viewers.new.appendChild(buildSide(r.newCanvas, r.labelNew, 'new', r.placeholderMessage));
  }
  panBySide.old = { x: 0, y: 0 };
  panBySide.new = { x: 0, y: 0 };
  applyZoom('old');
  applyZoom('new');
  if (viewMode === 'overlay') applyOverlayLayer();

  els.viewModeBtn.classList.remove('hidden');
  els.pageNav.classList.remove('hidden');
  els.pageInput.max = String(results.length);
  els.pageInput.value = String(currentPageIndex + 1);
  els.pageTotalLabel.textContent = `/ ${results.length}`;
  els.pagePrevBtn.disabled = currentPageIndex <= 0;
  els.pageNextBtn.disabled = currentPageIndex >= results.length - 1;
}

els.pagePrevBtn.addEventListener('click', () => showPage(currentPageIndex - 1));
els.pageNextBtn.addEventListener('click', () => showPage(currentPageIndex + 1));

function goToPageFromInput() {
  const n = parseInt(els.pageInput.value, 10);
  if (Number.isNaN(n)) return;
  showPage(n - 1);
}
els.pageInput.addEventListener('change', goToPageFromInput);
els.pageInput.addEventListener('keydown', (e) => {
  if (e.key === 'Enter') goToPageFromInput();
});

// 100%でPDFの横幅全体がペイン内に収まるよう、ページ画像の実ピクセル幅ではなく
// ペイン自体の表示幅を基準(fit-to-width)にズーム倍率をかける。
// パン位置(ドラッグでの移動量)はtransform: translate()で反映する。ヘッダーは
// このtransformの対象外(別要素)なので、拡大・移動してもヘッダーは動かない。
function applyZoom(side) {
  const zoom = zoomBySide[side];
  const viewerEl = els.viewers[side];
  viewerEl.querySelectorAll(`.zoom-level[data-side="${side}"]`).forEach((el) => {
    el.textContent = `${Math.round(zoom * 100)}%`;
  });
  const viewport = viewerEl.querySelector('.page-viewport');
  const fitWidth = viewport ? viewport.clientWidth : viewerEl.clientWidth;
  viewerEl.querySelectorAll('.page-image').forEach((img) => {
    img.style.width = `${fitWidth * zoom}px`;
  });
  applyPan(side);
}

function applyPan(side) {
  const pan = panBySide[side];
  const viewerEl = els.viewers[side];
  viewerEl.querySelectorAll('.page-image').forEach((img) => {
    img.style.transform = `translate(${pan.x}px, ${pan.y}px)`;
  });
}

function setZoom(side, z) {
  zoomBySide[side] = Math.max(0.2, Math.min(3, z));
  applyZoom(side);
}

function resetView(side) {
  panBySide[side] = { x: 0, y: 0 };
  setZoom(side, 1.0);
}

['old', 'new'].forEach((side) => {
  const viewerEl = els.viewers[side];

  // ページごとに繰り返し生成されるズームボタンをイベント委譲で一括処理する
  viewerEl.addEventListener('click', (e) => {
    const btn = e.target.closest('.zoom-btn');
    if (!btn || btn.dataset.side !== side) return;
    if (btn.dataset.action === 'in') setZoom(side, zoomBySide[side] + 0.1);
    else if (btn.dataset.action === 'out') setZoom(side, zoomBySide[side] - 0.1);
    else if (btn.dataset.action === 'reset') resetView(side);
  });

  viewerEl.addEventListener('wheel', (e) => {
    if (!e.target.closest('.page-viewport') || !viewerEl.querySelector('.page-image')) return;
    e.preventDefault();
    setZoom(side, zoomBySide[side] - e.deltaY * 0.001);
  }, { passive: false });

  // ページ画像の入っている.page-viewportだけを左クリックで掴んでドラッグすると、
  // transform: translate()でその画像だけが動く(ヘッダーは動かない)。旧/新は
  // 別々の状態(panBySide)を持つので、もう一方には一切影響しない。ズーム倍率が
  // 100%未満でペインに収まっている場合も、スクロール量に頼らず動かせる。
  let isPanning = false;
  let panStartX = 0, panStartY = 0, panOriginX = 0, panOriginY = 0;

  viewerEl.addEventListener('mousedown', (e) => {
    if (e.button !== 0 || e.target.closest('button')) return;
    const viewport = e.target.closest('.page-viewport');
    if (!viewport || !viewport.querySelector('.page-image')) return;
    isPanning = true;
    panStartX = e.clientX;
    panStartY = e.clientY;
    panOriginX = panBySide[side].x;
    panOriginY = panBySide[side].y;
    viewport.classList.add('panning');
    e.preventDefault();
  });

  window.addEventListener('mousemove', (e) => {
    if (!isPanning) return;
    panBySide[side].x = panOriginX + (e.clientX - panStartX);
    panBySide[side].y = panOriginY + (e.clientY - panStartY);
    applyPan(side);
  });

  window.addEventListener('mouseup', () => {
    if (!isPanning) return;
    isPanning = false;
    viewerEl.querySelectorAll('.page-viewport.panning').forEach((v) => v.classList.remove('panning'));
  });

  new ResizeObserver(() => applyZoom(side)).observe(viewerEl);
});

els.runBtn.addEventListener('click', async () => {
  if (!oldFile || !newFile || !selectedMode) return;
  els.runBtn.disabled = true;
  els.resultSection.classList.add('hidden');
  clearLog();
  log('解析を開始します...');
  setAnalyzing(true);
  try {
    const [oldBuf, newBuf] = await Promise.all([
      fileToArrayBuffer(oldFile),
      fileToArrayBuffer(newFile),
    ]);
    const result = await PdfDiffCore.runDiff(oldBuf, newBuf, {
      onLog: log,
      manualCategory: selectedMode,
      apiUrls: DIFF_API_URLS,
    });
    lastResult = result;
    updateResetEnabled();
    els.resultCategory.textContent = `分類: ${result.category}`;
    showPage(0);
    els.resultSection.classList.remove('hidden');
    log('解析が完了しました。');
    await sendLog(result.category);
  } catch (err) {
    console.error(err);
    log(`エラーが発生しました: ${err.message || err}`);
  } finally {
    els.runBtn.disabled = false;
    setAnalyzing(false);
  }
});

// PNG+高解像度のまま全ページをjsPDFに渡すと、内部でPDFデータを1つの
// 文字列として組み立てる際にJSエンジンの文字列長上限を超え、
// "Uncaught RangeError: Invalid string length" で失敗することがある
// (就業規則20ページの実データで確認済み)。ダウンロード用画像は
// 縦横の上限を設けて縮小し、JPEG(可逆でなくてよい)に変換して
// 埋め込みサイズを大きく削減する。
const DOWNLOAD_MAX_DIM = 2000;
const DOWNLOAD_JPEG_QUALITY = 0.85;

function canvasToDownloadImage(canvas) {
  const scale = Math.min(1, DOWNLOAD_MAX_DIM / Math.max(canvas.width, canvas.height));
  const w = Math.max(1, Math.round(canvas.width * scale));
  const h = Math.max(1, Math.round(canvas.height * scale));
  let src = canvas;
  if (scale < 1) {
    const resized = document.createElement('canvas');
    resized.width = w;
    resized.height = h;
    resized.getContext('2d').drawImage(canvas, 0, 0, w, h);
    src = resized;
  }
  return { dataUrl: src.toDataURL('image/jpeg', DOWNLOAD_JPEG_QUALITY), w, h };
}

els.downloadBtn.addEventListener('click', () => {
  if (!lastResult || !lastResult.results.length) return;
  try {
    const { jsPDF } = window.jspdf;
    let doc = null;
    lastResult.results.forEach((r, i) => {
      const { dataUrl, w, h } = canvasToDownloadImage(r.composed);
      const orientation = w > h ? 'l' : 'p';
      if (i === 0) {
        doc = new jsPDF({ orientation, unit: 'px', format: [w, h] });
      } else {
        doc.addPage([w, h], orientation);
      }
      doc.addImage(dataUrl, 'JPEG', 0, 0, w, h);
    });
    const stamp = formatDateJST(new Date()).replace(/[-: ]/g, '');
    doc.save(`pdf-diff-${stamp}.pdf`);
  } catch (err) {
    console.error(err);
    log(`ダウンロードに失敗しました: ${err.message || err}`);
  }
});
