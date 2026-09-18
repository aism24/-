// デプロイ済みGAS WebアプリのURL(/exec で終わるURL)。デプロイ後にここへ差し替えてください。
const GAS_API_URL = "https://script.google.com/macros/s/AKfycbzLz81VioiuR3ku_utdvDlwpT6ImXXQmM6ziZtDX4If9Q0MWxi0926U8rFikxEV9qo4Ig/exec";

pdfjsLib.GlobalWorkerOptions.workerSrc =
  "https://cdnjs.cloudflare.com/ajax/libs/pdf.js/3.11.174/pdf.worker.min.js";

let oldFile = null;
let newFile = null;
let lastResult = null;
let zoom = 1.0;
let selectedType = null;

const els = {
  homeScreen: document.getElementById('home-screen'),
  appScreen: document.getElementById('app-screen'),
  homeBtn: document.getElementById('home-btn'),
  typeBtns: document.querySelectorAll('.type-btn'),
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
  status: document.getElementById('status'),
  resultSection: document.getElementById('result-section'),
  resultCategory: document.getElementById('result-category'),
  viewer: document.getElementById('viewer'),
  zoomLevel: document.getElementById('zoom-level'),
  zoomIn: document.getElementById('zoom-in'),
  zoomOut: document.getElementById('zoom-out'),
  zoomReset: document.getElementById('zoom-reset'),
  downloadBtn: document.getElementById('download-btn'),
};

function updateRunEnabled() {
  els.runBtn.disabled = !(oldFile && newFile);
}

function updateResetEnabled() {
  els.resetBtn.disabled = !(oldFile || newFile || lastResult);
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
  els.oldInput.value = '';
  els.newInput.value = '';
  setOldFile(null);
  setNewFile(null);
  clearLog();
  els.resultSection.classList.add('hidden');
  els.viewer.innerHTML = '';
}

els.resetBtn.addEventListener('click', clearWorkArea);

function selectType(type) {
  selectedType = type;
  clearWorkArea();
  els.homeScreen.classList.add('hidden');
  els.appScreen.classList.remove('hidden');
  els.homeBtn.classList.remove('hidden');
}

function goHome() {
  selectedType = null;
  clearWorkArea();
  els.appScreen.classList.add('hidden');
  els.homeScreen.classList.remove('hidden');
  els.homeBtn.classList.add('hidden');
}

els.typeBtns.forEach((btn) => {
  btn.addEventListener('click', () => selectType(btn.dataset.type));
});
els.homeBtn.addEventListener('click', goHome);

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

function buildSide(canvas, label, side, placeholderMessage) {
  const col = document.createElement('div');
  col.className = `page-col page-col-${side}`;

  const header = document.createElement('div');
  header.className = `page-col-header page-col-header-${side}`;
  header.textContent = label;
  col.appendChild(header);

  if (canvas) {
    const img = document.createElement('img');
    img.src = canvas.toDataURL('image/png');
    img.dataset.baseWidth = canvas.width;
    img.className = 'page-image';
    img.draggable = false;
    col.appendChild(img);
  } else {
    const ph = document.createElement('div');
    ph.className = `page-placeholder page-placeholder-${side}`;
    ph.textContent = placeholderMessage || '';
    col.appendChild(ph);
  }
  return col;
}

function renderResults(results) {
  els.viewer.innerHTML = '';
  results.forEach((r) => {
    const row = document.createElement('div');
    row.className = 'page-row';
    row.appendChild(buildSide(r.oldCanvas, r.labelOld, 'old', r.placeholderMessage));
    row.appendChild(buildSide(r.newCanvas, r.labelNew, 'new', r.placeholderMessage));
    els.viewer.appendChild(row);
  });
  applyZoom();
}

// ページごとに旧/新を別々の<img>として描画しているため、各画像は自分自身の
// 基準幅(元のcanvas幅)を基準に拡大縮小する。これにより、旧新をまとめた1枚の
// 画像を全体の中心基準で拡大縮小していた以前の挙動と異なり、それぞれが
// 自分の位置を保ったまま独立してズームする。
function applyZoom() {
  els.zoomLevel.textContent = `${Math.round(zoom * 100)}%`;
  document.querySelectorAll('.page-image').forEach((img) => {
    const baseWidth = Number(img.dataset.baseWidth) || img.naturalWidth;
    img.style.width = `${baseWidth * zoom}px`;
  });
}

function setZoom(z) {
  zoom = Math.max(0.2, Math.min(3, z));
  applyZoom();
}

els.zoomIn.addEventListener('click', () => setZoom(zoom + 0.1));
els.zoomOut.addEventListener('click', () => setZoom(zoom - 0.1));
els.zoomReset.addEventListener('click', () => setZoom(1.0));

els.viewer.addEventListener('wheel', (e) => {
  if (!els.viewer.querySelector('.page-image')) return;
  e.preventDefault();
  setZoom(zoom - e.deltaY * 0.001);
}, { passive: false });

// 差分表示エリアを左クリックで掴んでドラッグすると、上下左右にパン(スクロール)できる
let isPanning = false;
let panStartX = 0, panStartY = 0, panStartScrollLeft = 0, panStartScrollTop = 0;

els.viewer.addEventListener('mousedown', (e) => {
  if (e.button !== 0 || !els.viewer.querySelector('.page-image')) return;
  isPanning = true;
  panStartX = e.clientX;
  panStartY = e.clientY;
  panStartScrollLeft = els.viewer.scrollLeft;
  panStartScrollTop = window.scrollY;
  els.viewer.classList.add('panning');
  e.preventDefault();
});

window.addEventListener('mousemove', (e) => {
  if (!isPanning) return;
  els.viewer.scrollLeft = panStartScrollLeft - (e.clientX - panStartX);
  window.scrollTo(window.scrollX, panStartScrollTop - (e.clientY - panStartY));
});

window.addEventListener('mouseup', () => {
  isPanning = false;
  els.viewer.classList.remove('panning');
});

els.runBtn.addEventListener('click', async () => {
  if (!oldFile || !newFile) return;
  els.runBtn.disabled = true;
  els.resultSection.classList.add('hidden');
  clearLog();
  log('解析を開始します...');
  try {
    const [oldBuf, newBuf] = await Promise.all([
      fileToArrayBuffer(oldFile),
      fileToArrayBuffer(newFile),
    ]);
    const result = await PdfDiffCore.runDiff(oldBuf, newBuf, { onLog: log, forceCategory: selectedType });
    lastResult = result;
    updateResetEnabled();
    els.resultCategory.textContent = `分類: ${result.category}`;
    renderResults(result.results);
    els.resultSection.classList.remove('hidden');
    log('解析が完了しました。');
    await sendLog(result.category);
  } catch (err) {
    console.error(err);
    log(`エラーが発生しました: ${err.message || err}`);
  } finally {
    els.runBtn.disabled = false;
  }
});

els.downloadBtn.addEventListener('click', () => {
  if (!lastResult || !lastResult.results.length) return;
  const { jsPDF } = window.jspdf;
  let doc = null;
  lastResult.results.forEach((r, i) => {
    const canvas = r.composed;
    const w = canvas.width, h = canvas.height;
    const orientation = w > h ? 'l' : 'p';
    if (i === 0) {
      doc = new jsPDF({ orientation, unit: 'px', format: [w, h] });
    } else {
      doc.addPage([w, h], orientation);
    }
    doc.addImage(canvas.toDataURL('image/png'), 'PNG', 0, 0, w, h);
  });
  const stamp = formatDateJST(new Date()).replace(/[-: ]/g, '');
  doc.save(`pdf-diff-${stamp}.pdf`);
});
