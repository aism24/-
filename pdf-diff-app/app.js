// デプロイ済みGAS WebアプリのURL(/exec で終わるURL)。デプロイ後にここへ差し替えてください。
const GAS_API_URL = "https://script.google.com/macros/s/AKfycbzLz81VioiuR3ku_utdvDlwpT6ImXXQmM6ziZtDX4If9Q0MWxi0926U8rFikxEV9qo4Ig/exec";

pdfjsLib.GlobalWorkerOptions.workerSrc =
  "https://cdnjs.cloudflare.com/ajax/libs/pdf.js/3.11.174/pdf.worker.min.js";

let oldFile = null;
let newFile = null;
let lastResult = null;
let zoom = 1.0;

const els = {
  oldInput: document.getElementById('old-pdf'),
  newInput: document.getElementById('new-pdf'),
  oldName: document.getElementById('old-pdf-name'),
  newName: document.getElementById('new-pdf-name'),
  runBtn: document.getElementById('run-btn'),
  status: document.getElementById('status'),
  resultSection: document.getElementById('result-section'),
  resultCategory: document.getElementById('result-category'),
  viewer: document.getElementById('viewer'),
  zoomLevel: document.getElementById('zoom-level'),
  zoomIn: document.getElementById('zoom-in'),
  zoomOut: document.getElementById('zoom-out'),
  downloadBtn: document.getElementById('download-btn'),
};

function updateRunEnabled() {
  els.runBtn.disabled = !(oldFile && newFile);
}

els.oldInput.addEventListener('change', (e) => {
  oldFile = e.target.files[0] || null;
  els.oldName.textContent = oldFile ? oldFile.name : '未選択';
  updateRunEnabled();
});

els.newInput.addEventListener('change', (e) => {
  newFile = e.target.files[0] || null;
  els.newName.textContent = newFile ? newFile.name : '未選択';
  updateRunEnabled();
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
      body: JSON.stringify({ date: new Date().toISOString(), category }),
    });
  } catch (err) {
    // 記録の失敗はアプリ本来の解析結果表示を止めない
    console.warn('記録シートへの書き込みに失敗しました', err);
  }
}

function renderResults(results) {
  els.viewer.innerHTML = '';
  results.forEach((r) => {
    const img = document.createElement('img');
    img.src = r.composed.toDataURL('image/png');
    img.className = 'page-image';
    els.viewer.appendChild(img);
  });
  applyZoom();
}

function applyZoom() {
  els.zoomLevel.textContent = `${Math.round(zoom * 100)}%`;
  document.querySelectorAll('.page-image').forEach((img) => {
    img.style.width = `${zoom * 100}%`;
  });
}

els.zoomIn.addEventListener('click', () => { zoom = Math.min(3, zoom + 0.1); applyZoom(); });
els.zoomOut.addEventListener('click', () => { zoom = Math.max(0.2, zoom - 0.1); applyZoom(); });

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
    const result = await PdfDiffCore.runDiff(oldBuf, newBuf, { onLog: log });
    lastResult = result;
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
  const now = new Date();
  const stamp = now.toISOString().slice(0, 19).replace(/[-:T]/g, '');
  doc.save(`pdf-diff-${stamp}.pdf`);
});
