// デプロイ済みGAS WebアプリのURL(/exec で終わるURL)。デプロイ後にここへ差し替えてください。
const GAS_API_URL = "https://script.google.com/macros/s/AKfycbzLz81VioiuR3ku_utdvDlwpT6ImXXQmM6ziZtDX4If9Q0MWxi0926U8rFikxEV9qo4Ig/exec";

// 「表」モードの比較をブラウザ内(pdf.js)ではなくVercelのPythonサーバーレス関数で
// 行うためのAPIパス(同一オリジンの相対パス。Vercelデプロイ時のみ存在する)。
// 存在しない/失敗する環境(例: githackプレビュー)では、diff-core.js側で
// 自動的に従来のJS計算にフォールバックする。
const TABLE_DIFF_API_URL = "/api/table-diff";

pdfjsLib.GlobalWorkerOptions.workerSrc =
  "https://cdnjs.cloudflare.com/ajax/libs/pdf.js/3.11.174/pdf.worker.min.js";

let oldFile = null;
let newFile = null;
let lastResult = null;
const zoomBySide = { old: 1.0, new: 1.0 };

const els = {
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
  downloadBtn: document.getElementById('download-btn'),
  viewers: {
    old: document.getElementById('viewer-old'),
    new: document.getElementById('viewer-new'),
  },
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

els.resetBtn.addEventListener('click', () => {
  lastResult = null;
  els.oldInput.value = '';
  els.newInput.value = '';
  setOldFile(null);
  setNewFile(null);
  clearLog();
  els.resultSection.classList.add('hidden');
  els.viewers.old.innerHTML = '';
  els.viewers.new.innerHTML = '';
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

function buildSide(canvas, label, side, placeholderMessage) {
  const col = document.createElement('div');
  col.className = `page-col page-col-${side}`;
  col.appendChild(buildHeader(label, side));

  if (canvas) {
    const img = document.createElement('img');
    // 表モード(サーバーAPI経由)はcanvasではなくHTMLImageElementが渡ってくるため、
    // toDataURLが無ければsrcをそのまま使う
    img.src = typeof canvas.toDataURL === 'function' ? canvas.toDataURL('image/png') : canvas.src;
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

// 旧新を1枚の合成画像に描くのではなく、別々の<img>としてそれぞれのペインに
// そのまま表示する。これにより旧PDF/新PDFを個別にズーム・パンできる。
function renderResults(results) {
  els.viewers.old.innerHTML = '';
  els.viewers.new.innerHTML = '';
  results.forEach((r) => {
    els.viewers.old.appendChild(buildSide(r.oldCanvas, r.labelOld, 'old', r.placeholderMessage));
    els.viewers.new.appendChild(buildSide(r.newCanvas, r.labelNew, 'new', r.placeholderMessage));
  });
  applyZoom('old');
  applyZoom('new');
}

// 100%でPDFの横幅全体がペイン内に収まるよう、ページ画像の実ピクセル幅ではなく
// ペイン自体の表示幅を基準(fit-to-width)にズーム倍率をかける。
function applyZoom(side) {
  const zoom = zoomBySide[side];
  const viewerEl = els.viewers[side];
  viewerEl.querySelectorAll(`.zoom-level[data-side="${side}"]`).forEach((el) => {
    el.textContent = `${Math.round(zoom * 100)}%`;
  });
  const fitWidth = viewerEl.clientWidth;
  viewerEl.querySelectorAll('.page-image').forEach((img) => {
    img.style.width = `${fitWidth * zoom}px`;
  });
}

function setZoom(side, z) {
  zoomBySide[side] = Math.max(0.2, Math.min(3, z));
  applyZoom(side);
}

['old', 'new'].forEach((side) => {
  const viewerEl = els.viewers[side];

  // ページごとに繰り返し生成されるズームボタンをイベント委譲で一括処理する
  viewerEl.addEventListener('click', (e) => {
    const btn = e.target.closest('.zoom-btn');
    if (!btn || btn.dataset.side !== side) return;
    if (btn.dataset.action === 'in') setZoom(side, zoomBySide[side] + 0.1);
    else if (btn.dataset.action === 'out') setZoom(side, zoomBySide[side] - 0.1);
    else if (btn.dataset.action === 'reset') setZoom(side, 1.0);
  });

  viewerEl.addEventListener('wheel', (e) => {
    if (!viewerEl.querySelector('.page-image')) return;
    e.preventDefault();
    setZoom(side, zoomBySide[side] - e.deltaY * 0.001);
  }, { passive: false });

  // ペインを左クリックで掴んでドラッグすると、そのペイン自身の縦横スクロールだけが
  // 動く(旧/新は別々のスクロールコンテナなので、もう一方には一切影響しない)
  let isPanning = false;
  let panStartX = 0, panStartY = 0, panStartScrollLeft = 0, panStartScrollTop = 0;

  viewerEl.addEventListener('mousedown', (e) => {
    if (e.button !== 0 || e.target.closest('button') || !viewerEl.querySelector('.page-image')) return;
    isPanning = true;
    panStartX = e.clientX;
    panStartY = e.clientY;
    panStartScrollLeft = viewerEl.scrollLeft;
    panStartScrollTop = viewerEl.scrollTop;
    viewerEl.classList.add('panning');
    e.preventDefault();
  });

  window.addEventListener('mousemove', (e) => {
    if (!isPanning) return;
    viewerEl.scrollLeft = panStartScrollLeft - (e.clientX - panStartX);
    viewerEl.scrollTop = panStartScrollTop - (e.clientY - panStartY);
  });

  window.addEventListener('mouseup', () => {
    isPanning = false;
    viewerEl.classList.remove('panning');
  });

  new ResizeObserver(() => applyZoom(side)).observe(viewerEl);
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
    const result = await PdfDiffCore.runDiff(oldBuf, newBuf, { onLog: log, tableDiffApiUrl: TABLE_DIFF_API_URL });
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
