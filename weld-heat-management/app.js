// デプロイ済みGAS WebアプリのURL（/exec で終わるURL）
// GASプロジェクトを新規デプロイした後、ここを実際のURLに書き換えてください。
const GAS_API_URL = "https://script.google.com/macros/s/AKfycbzykwqGknEiLfAta1wPoVXHPpNSsS2-w85tuXQdf0wnvz40APguGxU-dSzIgQZqHEZd8g/exec";

const DRAFT_KEY = "weldHeatDraft_v1";

// ---------- GAS API通信 ----------

async function apiGet(action, params) {
  const url = new URL(GAS_API_URL);
  url.searchParams.set('action', action);
  if (params) {
    Object.keys(params).forEach(key => {
      if (params[key] !== undefined && params[key] !== null) url.searchParams.set(key, params[key]);
    });
  }
  const res = await fetch(url.toString(), { method: 'GET' });
  if (!res.ok) throw new Error('サーバーエラー（HTTP ' + res.status + '）');
  const json = await res.json();
  if (json.status !== 'success') throw new Error(json.message || 'データの取得に失敗しました');
  return json.data;
}

async function apiPost(action, payload) {
  const res = await fetch(GAS_API_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'text/plain;charset=utf-8' },
    body: JSON.stringify(Object.assign({ action: action }, payload)),
  });
  if (!res.ok) throw new Error('サーバーエラー（HTTP ' + res.status + '）');
  const json = await res.json();
  if (json.status !== 'success') throw new Error(json.message || '処理に失敗しました');
  return json.data;
}

function escapeHtml(str) {
  return String(str == null ? '' : str)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
}

// ---------- オーバーレイ ----------

function showOverlay(icon, message, closable) {
  document.getElementById('overlay').style.display = 'flex';
  document.getElementById('overlay-icon').textContent = icon;
  document.getElementById('overlay-message').textContent = message;
  document.getElementById('overlay-close-btn').style.display = closable ? 'inline-block' : 'none';
}
function hideOverlay() { document.getElementById('overlay').style.display = 'none'; }
function showError(err) { showOverlay('❌', (err && err.message) || String(err), true); }

// ---------- 画面遷移 ----------

let navStack = [];

function showScreen(id) {
  document.querySelectorAll('.screen').forEach(el => { el.style.display = 'none'; });
  document.getElementById(id).style.display = 'block';
}
function renderEntry(entry) {
  document.getElementById('app-header').style.display = 'flex';
  document.getElementById('app-header-title').textContent = entry.title;
  showScreen(entry.screenId);
  entry.load();
}
function goTo(entry) { navStack.push(entry); renderEntry(entry); }
function goBack() {
  navStack.pop();
  if (navStack.length === 0) {
    document.getElementById('app-header').style.display = 'none';
    showScreen('home-screen');
    checkDraftButton();
  } else {
    renderEntry(navStack[navStack.length - 1]);
  }
}
function goHome() {
  navStack = [];
  document.getElementById('app-header').style.display = 'none';
  showScreen('home-screen');
  checkDraftButton();
}

// ---------- マスタ選択肢(工事名・部材・材質・溶接方法・溶接者・検査員) ----------

const MASTER_FIELDS = [
  { key: '工事名', masterKey: '工事名', selectId: 'jn-工事名', newId: 'jn-工事名-new' },
  { key: '部材', masterKey: '部材', selectId: 'jn-部材', newId: 'jn-部材-new' },
  { key: '材質', masterKey: '材質', selectId: 'jn-材質', newId: 'jn-材質-new' },
  { key: '溶接方法', masterKey: '溶接方法', selectId: 'jn-溶接方法', newId: 'jn-溶接方法-new' },
  { key: '溶接者', masterKey: '溶接者', selectId: 'jn-溶接者', newId: 'jn-溶接者-new' },
  { key: '検査員（入力者）', masterKey: '検査員', selectId: 'jn-検査員', newId: 'jn-検査員-new' },
];

let masterLists = {};

async function loadMasterLists() {
  try {
    masterLists = await apiGet('listMasterLists');
  } catch (err) {
    masterLists = {};
  }
  MASTER_FIELDS.forEach(f => populateMasterSelect(f));
}

function populateMasterSelect(f) {
  const select = document.getElementById(f.selectId);
  const list = masterLists[f.masterKey] || [];
  select.innerHTML = '<option value="">(選択してください)</option>' +
    list.map(v => `<option value="${escapeHtml(v)}">${escapeHtml(v)}</option>`).join('') +
    '<option value="__new__">＋ 新規入力</option>';
  select.onchange = () => {
    document.getElementById(f.newId).style.display = select.value === '__new__' ? 'block' : 'none';
  };
}

function getMasterFieldValue(f) {
  const select = document.getElementById(f.selectId);
  if (select.value === '__new__') return document.getElementById(f.newId).value.trim();
  return select.value;
}

async function persistNewMasterValues() {
  const calls = MASTER_FIELDS.filter(f => document.getElementById(f.selectId).value === '__new__')
    .map(f => {
      const v = document.getElementById(f.newId).value.trim();
      return v ? apiPost('addMasterValue', { column: f.masterKey, value: v }).catch(() => {}) : Promise.resolve();
    });
  await Promise.all(calls);
}

// ---------- 端末内一時保存(localStorage) ----------

function saveDraft() {
  try {
    localStorage.setItem(DRAFT_KEY, JSON.stringify({ header: state.header, passes: state.passes, nextLayer: state.nextLayer }));
  } catch (e) { /* 保存できなくても致命的ではないので無視 */ }
}
function loadDraftRaw() {
  try {
    const raw = localStorage.getItem(DRAFT_KEY);
    return raw ? JSON.parse(raw) : null;
  } catch (e) { return null; }
}
function clearDraft() { localStorage.removeItem(DRAFT_KEY); }

function checkDraftButton() {
  const draft = loadDraftRaw();
  document.getElementById('resume-btn').style.display = (draft && draft.passes && draft.passes.length) ? 'block' : 'none';
}

function resumeDraft() {
  const draft = loadDraftRaw();
  if (!draft) return;
  state.header = draft.header;
  state.passes = draft.passes || [];
  state.nextLayer = draft.nextLayer || 1;
  goTo({ screenId: 'joint-record-screen', title: 'パス記録(再開)', load: () => renderRecordScreen() });
}

// ---------- アプリ状態 ----------

const state = { header: null, passes: [], nextLayer: 1 };
let timerState = 'idle'; // idle | running | stopped
let timerStart = null, timerEnd = null, timerInterval = null;
let pendingImageUrl = '', pendingLayerImageUrl = '';

document.addEventListener('DOMContentLoaded', () => {
  loadMasterLists();
  checkDraftButton();
});

// ---------- 新規継手ヘッダー入力 ----------

function goJointNew() {
  const draft = loadDraftRaw();
  if (draft && draft.passes && draft.passes.length) {
    if (!confirm('前回入力途中の記録が残っています。破棄して新しい継手の記録を始めますか?')) return;
    clearDraft();
  }
  goTo({ screenId: 'joint-new-screen', title: '継手情報の入力', load: initJointNewForm });
}

function initJointNewForm() {
  document.getElementById('jn-検査日').value = new Date().toISOString().slice(0, 10);
  MASTER_FIELDS.forEach(f => {
    document.getElementById(f.selectId).value = '';
    document.getElementById(f.newId).style.display = 'none';
    document.getElementById(f.newId).value = '';
  });
  ['jn-製品名', 'jn-幅', 'jn-板厚', 'jn-部材サイズ', 'jn-溶接長', 'jn-梁成', 'jn-ウエブ厚', 'jn-気温',
    'jn-計測', 'jn-ルートギャップ', 'jn-開先角度', 'jn-入熱上限', 'jn-温度下限', 'jn-温度上限'].forEach(id => { document.getElementById(id).value = ''; });
  pendingImageUrl = ''; pendingLayerImageUrl = '';
  document.getElementById('jn-photo-status').textContent = '';
}

function onPhotoSelected(event, kind) {
  const file = event.target.files[0];
  if (!file) return;
  const reader = new FileReader();
  reader.onload = () => {
    const base64 = reader.result.split(',')[1];
    const label = kind === 'productName' ? '製品名タグ' : '積層図';
    showOverlay('⏳', label + 'をアップロード中...' + (kind === 'productName' ? '(自動読み取り中)' : ''));
    apiPost('uploadPhoto', {
      kind: kind,
      base64: base64,
      mimeType: file.type,
      fileName: (kind === 'productName' ? 'product_' : 'layer_') + Date.now() + '.jpg',
    }).then(result => {
      if (kind === 'productName') {
        pendingImageUrl = result.url;
        hideOverlay();
        if (result.recognizedText) {
          document.getElementById('jn-製品名').value = result.recognizedText;
        } else {
          showOverlay('⚠️', '製品名の自動読み取りに失敗しました。手入力してください', true);
        }
      } else {
        pendingLayerImageUrl = result.url;
        hideOverlay();
      }
      document.getElementById('jn-photo-status').textContent =
        (pendingImageUrl ? '✅ 製品名タグ写真 添付済み\n' : '') + (pendingLayerImageUrl ? '✅ 積層図 添付済み' : '');
    }).catch(showError);
  };
  reader.readAsDataURL(file);
}

function submitNewJoint() {
  const productName = document.getElementById('jn-製品名').value.trim();
  const weldLength = document.getElementById('jn-溶接長').value;
  if (!productName) { showOverlay('⚠️', '製品名を入力してください', true); return; }
  if (!weldLength) { showOverlay('⚠️', '溶接長を入力してください(入熱の自動計算に必要です)', true); return; }

  const header = {
    "工事名": getMasterFieldValue(MASTER_FIELDS[0]),
    "検査日": document.getElementById('jn-検査日').value,
    "部材": getMasterFieldValue(MASTER_FIELDS[1]),
    "サイズ(幅)": document.getElementById('jn-幅').value,
    "板厚": document.getElementById('jn-板厚').value,
    "部材サイズ": document.getElementById('jn-部材サイズ').value.trim(),
    "溶接者": getMasterFieldValue(MASTER_FIELDS[4]),
    "検査員（入力者）": getMasterFieldValue(MASTER_FIELDS[5]),
    "溶接長": weldLength,
    "計測": document.getElementById('jn-計測').value.trim(),
    "製品名": productName,
    "材質": getMasterFieldValue(MASTER_FIELDS[2]),
    "溶接方法": getMasterFieldValue(MASTER_FIELDS[3]),
    "梁成": document.getElementById('jn-梁成').value,
    "ウエブ厚": document.getElementById('jn-ウエブ厚').value,
    "気温": document.getElementById('jn-気温').value,
    "ルートギャップ": document.getElementById('jn-ルートギャップ').value,
    "開先角度": document.getElementById('jn-開先角度').value,
    "image": pendingImageUrl,
    "積層図": pendingLayerImageUrl,
    heatInputLimit: document.getElementById('jn-入熱上限').value,
    tempMin: document.getElementById('jn-温度下限').value,
    tempMax: document.getElementById('jn-温度上限').value,
  };

  persistNewMasterValues();
  state.header = header;
  state.passes = [];
  state.nextLayer = 1;
  saveDraft();
  goTo({ screenId: 'joint-record-screen', title: 'パス記録', load: () => renderRecordScreen() });
  // joint-new-screen を履歴から外す(戻るで新規フォームに戻らないように)
  navStack.splice(navStack.length - 2, 1);
}

// ---------- パス記録画面 ----------

function computeMetrics(current, voltage, arcSeconds, passTemp) {
  const h = state.header;
  const weldLength = Number(h["溶接長"]) || 0;
  current = Number(current) || 0; voltage = Number(voltage) || 0; arcSeconds = Number(arcSeconds) || 0;
  let heatInput = '';
  if (weldLength > 0 && arcSeconds > 0 && current && voltage) {
    heatInput = Math.round((current * voltage * arcSeconds / (1000 * weldLength)) * 100) / 100;
  }
  const reasons = [];
  let ok = true;
  if (h.tempMin !== '' && h.tempMin != null && Number(passTemp) < Number(h.tempMin)) { ok = false; reasons.push('温度不足'); }
  if (h.tempMax !== '' && h.tempMax != null && Number(passTemp) > Number(h.tempMax)) { ok = false; reasons.push('温度超過'); }
  if (heatInput !== '' && h.heatInputLimit !== '' && h.heatInputLimit != null && heatInput > Number(h.heatInputLimit)) { ok = false; reasons.push('入熱超過'); }
  return { heatInput: heatInput, judgement: ok ? 'OK' : 'NG', reasons: reasons };
}

function renderRecordScreen() {
  const h = state.header;
  document.getElementById('joint-summary').innerHTML = `
    <div><b>${escapeHtml(h["工事名"])}</b> ／ ${escapeHtml(h["部材"])} ／ 製品名: <b>${escapeHtml(h["製品名"])}</b></div>
    <div>材質: ${escapeHtml(h["材質"] || '-')}　溶接方法: ${escapeHtml(h["溶接方法"] || '-')}　溶接長: ${escapeHtml(h["溶接長"])}cm</div>
    <div>溶接者: ${escapeHtml(h["溶接者"] || '-')}　検査員: ${escapeHtml(h["検査員（入力者）"] || '-')}</div>
    <div>管理基準: 入熱≦${escapeHtml(h.heatInputLimit || '-')}kJ/cm　パス間温度 ${escapeHtml(h.tempMin || '-')}〜${escapeHtml(h.tempMax || '-')}℃</div>
  `;
  document.getElementById('layer-value').textContent = state.nextLayer;
  resetTimerUi();
  renderPassTable();
}

function changeLayer(delta) {
  state.nextLayer = Math.max(1, state.nextLayer + delta);
  document.getElementById('layer-value').textContent = state.nextLayer;
}

function resetTimerUi() {
  timerState = 'idle'; timerStart = null; timerEnd = null;
  clearInterval(timerInterval);
  document.getElementById('timer-display').textContent = '00:00';
  const btn = document.getElementById('timer-btn');
  btn.textContent = '▶ スタート';
  btn.classList.remove('timer-running'); btn.classList.add('timer-start');
  document.getElementById('pi-submit-btn').disabled = true;
  document.getElementById('pi-submit-btn').textContent = '✅ このパスを記録(ストップ後に押せます)';
}

function formatElapsed(ms) {
  const totalSec = Math.floor(ms / 1000);
  const m = String(Math.floor(totalSec / 60)).padStart(2, '0');
  const s = String(totalSec % 60).padStart(2, '0');
  return m + ':' + s;
}

function onTimerButton() {
  if (timerState === 'idle') {
    timerState = 'running';
    timerStart = new Date();
    const btn = document.getElementById('timer-btn');
    btn.textContent = '■ ストップ';
    btn.classList.remove('timer-start'); btn.classList.add('timer-running');
    timerInterval = setInterval(() => {
      document.getElementById('timer-display').textContent = formatElapsed(new Date() - timerStart);
    }, 200);
  } else if (timerState === 'running') {
    timerState = 'stopped';
    timerEnd = new Date();
    clearInterval(timerInterval);
    document.getElementById('timer-display').textContent = formatElapsed(timerEnd - timerStart);
    const btn = document.getElementById('timer-btn');
    btn.textContent = '✅ ストップ済み';
    btn.classList.remove('timer-running');
    document.getElementById('pi-submit-btn').disabled = false;
    document.getElementById('pi-submit-btn').textContent = '✅ このパスを記録';
  }
}

function submitPass() {
  if (timerState !== 'stopped') { showOverlay('⚠️', 'スタート→ストップの後に記録してください', true); return; }
  const current = document.getElementById('pi-current').value;
  const voltage = document.getElementById('pi-voltage').value;
  const passTemp = document.getElementById('pi-temp').value;
  const note = document.getElementById('pi-note').value.trim();
  if (current === '' || voltage === '') { showOverlay('⚠️', '電流・電圧を入力してください', true); return; }
  if (passTemp === '') { showOverlay('⚠️', 'パス間温度を入力してください', true); return; }

  const arcSeconds = Math.max(0, Math.round((timerEnd - timerStart) / 1000));
  const metrics = computeMetrics(current, voltage, arcSeconds, passTemp);

  state.passes.push({
    layer: state.nextLayer, current: Number(current), voltage: Number(voltage),
    start: timerStart.toISOString(), end: timerEnd.toISOString(), arcSeconds: arcSeconds,
    passTemp: Number(passTemp), note: note, heatInput: metrics.heatInput, judgement: metrics.judgement,
  });
  saveDraft();
  renderPassTable();

  ['pi-current', 'pi-voltage', 'pi-temp', 'pi-note'].forEach(id => { document.getElementById(id).value = ''; });
  resetTimerUi();

  if (metrics.judgement === 'NG') {
    showOverlay('⚠️', 'このパスは管理基準を外れています\n' + metrics.reasons.join('・'), true);
  }
}

function deletePass(index) {
  if (!confirm('このパスの記録を削除しますか?')) return;
  state.passes.splice(index, 1);
  saveDraft();
  renderPassTable();
}

function renderPassTable() {
  const tbody = document.getElementById('pass-table-body');
  if (!state.passes.length) { tbody.innerHTML = '<tr><td colspan="9" class="loading-text">まだパスが記録されていません</td></tr>'; return; }
  tbody.innerHTML = state.passes.map((p, i) => `
    <tr class="${p.judgement === 'NG' ? 'ng-row' : ''}">
      <td>${i + 1}</td><td>${p.layer}</td><td>${p.current}</td><td>${p.voltage}</td>
      <td>${p.arcSeconds}秒</td><td>${p.heatInput === '' ? '-' : p.heatInput}</td>
      <td>${p.passTemp}</td>
      <td class="${p.judgement === 'NG' ? 'judge-ng' : 'judge-ok'}">${p.judgement}</td>
      <td><button class="pass-del-btn" onclick="deletePass(${i})">削除</button></td>
    </tr>`).join('');
}

function onCompleteJoint() {
  if (!state.passes.length) { showOverlay('⚠️', 'パスが1件も記録されていません', true); return; }
  if (!confirm('この継手の溶接記録を確定し、スプレッドシートへ記録します。よろしいですか？')) return;
  showOverlay('⏳', 'スプレッドシートへ記録しています...');
  apiPost('saveJointRecord', { header: state.header, passes: state.passes }).then(result => {
    clearDraft();
    hideOverlay();
    document.getElementById('pass-input-section').style.display = 'none';
    document.getElementById('complete-section').style.display = 'none';
    document.getElementById('pdf-section').style.display = 'block';
    document.getElementById('pdf-link-wrap').style.display = 'none';
    const banner = document.getElementById('result-banner');
    const isNg = result.overallResult === 'NG';
    banner.textContent = '総合判定: ' + (isNg ? '❌ NG(要是正)' : '✅ OK') + `(記録行数: ${result.savedRows})`;
    banner.className = 'result-banner ' + (isNg ? 'ng' : 'ok');
  }).catch(showError);
}

function downloadPdfBase64_(base64, fileName) {
  const byteChars = atob(base64);
  const byteNumbers = new Array(byteChars.length);
  for (let i = 0; i < byteChars.length; i++) byteNumbers[i] = byteChars.charCodeAt(i);
  const blob = new Blob([new Uint8Array(byteNumbers)], { type: 'application/pdf' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = fileName;
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  setTimeout(() => URL.revokeObjectURL(url), 60000);
}

function onGeneratePdf() {
  showOverlay('⏳', 'PDFを作成しています...(数秒かかります)');
  const payload = { header: state.header, passes: state.passes.map(p => ({ layer: p.layer, current: p.current, voltage: p.voltage, arcSeconds: p.arcSeconds, passTemp: p.passTemp, note: p.note })) };
  apiPost('generatePdf', payload).then(result => {
    hideOverlay();
    downloadPdfBase64_(result.pdfBase64, result.fileName);
    document.getElementById('pdf-link-wrap').style.display = 'block';
  }).catch(showError);
}

// ---------- 履歴検索 ----------

let historyCache = [];

function goHistory() {
  navStack = [];
  goTo({ screenId: 'history-screen', title: '履歴検索', load: loadHistoryDefault });
}

function loadHistoryDefault() {
  document.getElementById('history-keyword').value = '';
  const listEl = document.getElementById('history-list');
  listEl.innerHTML = '<div class="loading-text">読み込み中...</div>';
  apiGet('searchJoints', { limit: 50 }).then(rows => { historyCache = rows; renderHistoryList(rows); }).catch(showError);
}

function submitHistorySearch() {
  const kw = document.getElementById('history-keyword').value.trim();
  const listEl = document.getElementById('history-list');
  listEl.innerHTML = '<div class="loading-text">検索中...</div>';
  apiGet('searchJoints', { keyword: kw, limit: 200 }).then(rows => { historyCache = rows; renderHistoryList(rows); }).catch(showError);
}

function jointBadgeHtml(overallResult) {
  return overallResult === 'NG'
    ? '<span class="badge badge-done-ng">NG</span>'
    : '<span class="badge badge-done-ok">OK</span>';
}

function renderHistoryList(rows) {
  const listEl = document.getElementById('history-list');
  if (!rows.length) { listEl.innerHTML = '<div class="loading-text">該当する記録がありません</div>'; return; }
  listEl.innerHTML = rows.map((r, i) => `
    <div class="list-item" onclick="viewJoint(${i})">
      <div class="list-item-title">${escapeHtml(r.製品名)} ${jointBadgeHtml(r.overallResult)}</div>
      <div class="list-item-sub">${escapeHtml(r.工事名)} ／ ${escapeHtml(r.部材)} ／ ${escapeHtml(r.材質 || '-')}</div>
      <div class="list-item-sub">溶接者: ${escapeHtml(r.溶接者 || '-')}　検査員: ${escapeHtml(r.検査員 || '-')}　パス数: ${r.passCount}</div>
    </div>`).join('');
}

function viewJoint(index) {
  const joint = historyCache[index];
  goTo({ screenId: 'joint-view-screen', title: joint.製品名 || '継手詳細', load: () => renderJointView(joint) });
}

function renderJointView(joint) {
  const h = joint.header;
  document.getElementById('view-joint-summary').innerHTML = `
    <div><b>${escapeHtml(h["工事名"])}</b> ／ ${escapeHtml(h["部材"])} ／ 製品名: <b>${escapeHtml(h["製品名"])}</b></div>
    <div>材質: ${escapeHtml(h["材質"] || '-')}　溶接方法: ${escapeHtml(h["溶接方法"] || '-')}　溶接長: ${escapeHtml(h["溶接長"])}cm</div>
    <div>溶接者: ${escapeHtml(h["溶接者"] || '-')}　検査員: ${escapeHtml(h["検査員（入力者）"] || '-')}　検査日: ${escapeHtml(h["検査日"])}</div>
    <div>管理基準: 入熱≦${escapeHtml(h.heatInputLimit || '-')}kJ/cm　パス間温度 ${escapeHtml(h.tempMin || '-')}〜${escapeHtml(h.tempMax || '-')}℃</div>
  `;
  const tbody = document.getElementById('view-pass-table-body');
  tbody.innerHTML = joint.records.map((r, i) => `
    <tr class="${r.判定 === 'NG' ? 'ng-row' : ''}">
      <td>${i + 1}</td><td>${r.層数}</td><td>${r.電流}</td><td>${r.電圧}</td>
      <td>${r.アークタイム}秒</td><td>${r.パス間温度}</td>
      <td class="${r.判定 === 'NG' ? 'judge-ng' : 'judge-ok'}">${r.判定}</td>
    </tr>`).join('');
  const banner = document.getElementById('view-result-banner');
  const isNg = joint.overallResult === 'NG';
  banner.textContent = '総合判定: ' + (isNg ? '❌ NG(要是正)' : '✅ OK');
  banner.className = 'result-banner ' + (isNg ? 'ng' : 'ok');
  document.getElementById('view-pdf-link-wrap').style.display = 'none';
  state.viewingJoint = joint;
}

function onGeneratePdfFromView() {
  const joint = state.viewingJoint;
  showOverlay('⏳', 'PDFを作成しています...(数秒かかります)');
  const payload = {
    header: joint.header,
    passes: joint.records.map(r => ({ layer: r.層数, current: r.電流, voltage: r.電圧, arcSeconds: r.アークタイム, passTemp: r.パス間温度, note: r.備考 })),
  };
  apiPost('generatePdf', payload).then(result => {
    hideOverlay();
    downloadPdfBase64_(result.pdfBase64, result.fileName);
    document.getElementById('view-pdf-link-wrap').style.display = 'block';
  }).catch(showError);
}
