// デプロイ済みGAS WebアプリのURL（/exec で終わるURL）
// GASプロジェクトを新規デプロイした後、ここを実際のURLに書き換えてください。
const GAS_API_URL = "★ここにデプロイ後のGAS WebアプリURLを設定してください★";

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

// Content-Type は "text/plain" にすることでCORSプリフライト(OPTIONS)を回避しています。
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

// ---------- オーバーレイ(読み込み中・メッセージ表示) ----------

function showOverlay(icon, message, closable) {
  document.getElementById('overlay').style.display = 'flex';
  document.getElementById('overlay-icon').textContent = icon;
  document.getElementById('overlay-message').textContent = message;
  document.getElementById('overlay-close-btn').style.display = closable ? 'inline-block' : 'none';
}
function hideOverlay() { document.getElementById('overlay').style.display = 'none'; }
function showError(err) { showOverlay('❌', (err && err.message) || String(err), true); }

// ---------- 画面遷移(スタック方式) ----------

const state = {
  projectsCache: [],
  partsCache: [],
  jointsCache: [],
  currentProject: null,
  currentPart: null,
  currentJoint: null, // { joint, part, project, passes }
};

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

function goTo(entry) {
  navStack.push(entry);
  renderEntry(entry);
}

function goBack() {
  navStack.pop();
  if (navStack.length === 0) {
    document.getElementById('app-header').style.display = 'none';
    showScreen('home-screen');
  } else {
    renderEntry(navStack[navStack.length - 1]);
  }
}

function goHome() {
  navStack = [];
  document.getElementById('app-header').style.display = 'none';
  showScreen('home-screen');
}

// ---------- 工事一覧 ----------

function goProjectList() {
  navStack = [];
  goTo({ screenId: 'project-list-screen', title: '工事一覧', load: loadProjectList });
}

function loadProjectList() {
  const listEl = document.getElementById('project-list');
  listEl.innerHTML = '<div class="loading-text">読み込み中...</div>';
  apiGet('listProjects').then(rows => {
    state.projectsCache = rows;
    if (!rows.length) { listEl.innerHTML = '<div class="loading-text">工事がまだありません。上のフォームから作成してください。</div>'; return; }
    listEl.innerHTML = rows.map(r => `
      <div class="list-item" onclick="goPartList(${r.id})">
        <div class="list-item-title">${escapeHtml(r.name)}</div>
        <div class="list-item-sub">作成: ${escapeHtml(r.createdAt)}</div>
      </div>`).join('');
  }).catch(showError);
}

function submitNewProject() {
  const nameEl = document.getElementById('new-project-name');
  const name = nameEl.value.trim();
  if (!name) { showOverlay('⚠️', '工事名を入力してください', true); return; }
  showOverlay('⏳', '作成中...');
  apiPost('addProject', { name: name }).then(() => {
    nameEl.value = '';
    hideOverlay();
    loadProjectList();
  }).catch(showError);
}

// ---------- 部材一覧 ----------

function goPartList(projectId) {
  const proj = state.projectsCache.find(p => p.id === projectId);
  state.currentProject = proj || { id: projectId, name: '' };
  goTo({ screenId: 'part-list-screen', title: state.currentProject.name || '部材一覧', load: () => loadPartList(projectId) });
}

function loadPartList(projectId) {
  const listEl = document.getElementById('part-list');
  listEl.innerHTML = '<div class="loading-text">読み込み中...</div>';
  apiGet('listParts', { projectId: projectId }).then(rows => {
    state.partsCache = rows;
    if (!rows.length) { listEl.innerHTML = '<div class="loading-text">部材がまだありません。上のフォームから登録してください。</div>'; return; }
    listEl.innerHTML = rows.map(r => `
      <div class="list-item" onclick="goJointList(${r.id})">
        <div class="list-item-title">${escapeHtml(r.code)}</div>
        <div class="list-item-sub">${escapeHtml(r.steelType || '-')} ／ 板厚 ${escapeHtml(r.thickness || '-')}mm</div>
      </div>`).join('');
  }).catch(showError);
}

function submitNewPart() {
  const codeEl = document.getElementById('new-part-code');
  const steelEl = document.getElementById('new-part-steel');
  const thicknessEl = document.getElementById('new-part-thickness');
  const code = codeEl.value.trim();
  if (!code) { showOverlay('⚠️', '部材符号を入力してください', true); return; }
  showOverlay('⏳', '登録中...');
  apiPost('addPart', {
    projectId: state.currentProject.id, code: code,
    steelType: steelEl.value.trim(), thickness: thicknessEl.value.trim(),
  }).then(() => {
    codeEl.value = ''; steelEl.value = ''; thicknessEl.value = '';
    hideOverlay();
    loadPartList(state.currentProject.id);
  }).catch(showError);
}

// ---------- 継手一覧 ----------

function goJointList(partId) {
  const part = state.partsCache.find(p => p.id === partId);
  state.currentPart = part || { id: partId, code: '' };
  goTo({ screenId: 'joint-list-screen', title: state.currentPart.code || '継手一覧', load: () => loadJointList(partId) });
}

function jointBadgeHtml(j) {
  if (j.status !== '完了') return '<span class="badge badge-progress">進行中</span>';
  return j.overallResult === 'NG'
    ? '<span class="badge badge-done-ng">完了・NG</span>'
    : '<span class="badge badge-done-ok">完了・OK</span>';
}

function loadJointList(partId) {
  const listEl = document.getElementById('joint-list');
  listEl.innerHTML = '<div class="loading-text">読み込み中...</div>';
  apiGet('listJoints', { partId: partId }).then(rows => {
    state.jointsCache = rows;
    if (!rows.length) { listEl.innerHTML = '<div class="loading-text">継手記録がまだありません。上のボタンから開始してください。</div>'; return; }
    listEl.innerHTML = rows.map(r => `
      <div class="list-item" onclick="goJointRecord(${r.id})">
        <div class="list-item-title">${escapeHtml(r.position)} ${jointBadgeHtml(r)}</div>
        <div class="list-item-sub">溶接士: ${escapeHtml(r.welder || '-')} ／ 開始: ${escapeHtml(r.createdAt)}</div>
      </div>`).join('');
  }).catch(showError);
}

// ---------- 新規継手ヘッダー入力 ----------

function goJointNew() {
  goTo({ screenId: 'joint-new-screen', title: '継手情報の入力', load: clearJointNewForm });
}

function clearJointNewForm() {
  ['jn-position', 'jn-method', 'jn-material', 'jn-weldlength', 'jn-welder', 'jn-inspector',
    'jn-heatlimit', 'jn-tempmin', 'jn-tempmax'].forEach(id => { document.getElementById(id).value = ''; });
  document.getElementById('jn-posture').selectedIndex = 0;
}

function submitNewJoint() {
  const position = document.getElementById('jn-position').value.trim();
  if (!position) { showOverlay('⚠️', '継手位置・名称を入力してください', true); return; }
  const payload = {
    partId: state.currentPart.id,
    position: position,
    posture: document.getElementById('jn-posture').value,
    method: document.getElementById('jn-method').value.trim(),
    material: document.getElementById('jn-material').value.trim(),
    weldLength: document.getElementById('jn-weldlength').value,
    welder: document.getElementById('jn-welder').value.trim(),
    inspector: document.getElementById('jn-inspector').value.trim(),
    heatInputLimit: document.getElementById('jn-heatlimit').value,
    tempMin: document.getElementById('jn-tempmin').value,
    tempMax: document.getElementById('jn-tempmax').value,
  };
  showOverlay('⏳', '作成中...');
  apiPost('addJoint', payload).then(result => {
    hideOverlay();
    goJointRecord(result.id, { replace: true });
  }).catch(showError);
}

// ---------- パス記録画面 ----------

function goJointRecord(jointId, opts) {
  if (opts && opts.replace) navStack.pop();
  goTo({ screenId: 'joint-record-screen', title: 'パス記録', load: () => loadJointRecord(jointId) });
}

function loadJointRecord(jointId) {
  document.getElementById('joint-summary').innerHTML = '<div class="loading-text">読み込み中...</div>';
  apiGet('getJoint', { jointId: jointId }).then(data => {
    state.currentJoint = data;
    renderJointRecordScreen();
  }).catch(showError);
}

function renderJointRecordScreen() {
  const { joint, part, project, passes } = state.currentJoint;
  document.getElementById('joint-summary').innerHTML = `
    <div><b>${escapeHtml(project ? project.name : '')}</b> ／ ${escapeHtml(part ? part.code : '')}
      (${escapeHtml(part ? part.steelType : '')} 板厚${escapeHtml(part ? part.thickness : '')}mm)</div>
    <div>継手: <b>${escapeHtml(joint.position)}</b>　姿勢: ${escapeHtml(joint.posture)}　方法: ${escapeHtml(joint.method)}　材料: ${escapeHtml(joint.material)}</div>
    <div>溶接士: ${escapeHtml(joint.welder || '-')}　検査員: ${escapeHtml(joint.inspector || '-')}</div>
    <div>管理基準: 入熱 ≦ ${escapeHtml(joint.heatInputLimit || '-')}kJ/cm　パス間温度 ${escapeHtml(joint.tempMin || '-')}〜${escapeHtml(joint.tempMax || '-')}℃</div>
  `;
  document.getElementById('next-pass-no').textContent = passes.length + 1;
  renderPassTable(passes);

  const isDone = joint.status === '完了';
  document.getElementById('pass-input-section').style.display = isDone ? 'none' : 'block';
  document.getElementById('complete-section').style.display = isDone ? 'none' : 'block';
  document.getElementById('pdf-section').style.display = isDone ? 'block' : 'none';

  if (isDone) {
    const banner = document.getElementById('result-banner');
    const isNg = joint.overallResult === 'NG';
    banner.textContent = '総合判定: ' + (isNg ? '❌ NG（要是正）' : '✅ OK');
    banner.className = 'result-banner ' + (isNg ? 'ng' : 'ok');
    const linkWrap = document.getElementById('pdf-link-wrap');
    if (joint.pdfUrl) {
      linkWrap.style.display = 'block';
      document.getElementById('pdf-link').href = joint.pdfUrl;
    } else {
      linkWrap.style.display = 'none';
    }
  }
}

function renderPassTable(passes) {
  const tbody = document.getElementById('pass-table-body');
  if (!passes.length) { tbody.innerHTML = '<tr><td colspan="8" class="loading-text">まだパスが記録されていません</td></tr>'; return; }
  tbody.innerHTML = passes.map(p => `
    <tr class="${p.judgement === 'NG' ? 'ng-row' : ''}">
      <td>${p.passNo}</td><td>${escapeHtml(p.recordedAt)}</td><td>${p.current}</td><td>${p.voltage}</td>
      <td>${p.speed === '' ? '-' : p.speed}</td><td>${p.heatInput === '' ? '-' : p.heatInput}</td>
      <td>${p.passTemp}</td>
      <td class="${p.judgement === 'NG' ? 'judge-ng' : 'judge-ok'}">${p.judgement}</td>
    </tr>`).join('');
}

function submitPass() {
  const current = document.getElementById('pi-current').value;
  const voltage = document.getElementById('pi-voltage').value;
  const speed = document.getElementById('pi-speed').value;
  const temp = document.getElementById('pi-temp').value;
  const note = document.getElementById('pi-note').value.trim();
  if (current === '' || voltage === '') { showOverlay('⚠️', '電流・電圧を入力してください', true); return; }
  if (temp === '') { showOverlay('⚠️', 'パス間温度を入力してください', true); return; }

  showOverlay('⏳', '記録中...');
  apiPost('addPass', {
    jointId: state.currentJoint.joint.id, current: current, voltage: voltage,
    speed: speed, passTemp: temp, note: note,
  }).then(pass => {
    state.currentJoint.passes.push(pass);
    renderPassTable(state.currentJoint.passes);
    document.getElementById('next-pass-no').textContent = state.currentJoint.passes.length + 1;
    ['pi-current', 'pi-voltage', 'pi-speed', 'pi-temp', 'pi-note'].forEach(id => { document.getElementById(id).value = ''; });
    if (pass.judgement === 'NG') {
      showOverlay('⚠️', 'このパスは管理基準を外れています\n' + (pass.note || ''), true);
    } else {
      hideOverlay();
    }
  }).catch(showError);
}

function onCompleteJoint() {
  if (!confirm('この継手の溶接記録を完了として確定します。よろしいですか？')) return;
  showOverlay('⏳', '確定しています...');
  apiPost('completeJoint', { jointId: state.currentJoint.joint.id }).then(result => {
    state.currentJoint.joint.status = '完了';
    state.currentJoint.joint.overallResult = result.overallResult;
    state.currentJoint.joint.completedAt = result.completedAt;
    hideOverlay();
    renderJointRecordScreen();
  }).catch(showError);
}

function onGeneratePdf() {
  showOverlay('⏳', 'PDFを作成しています...(数秒かかります)');
  apiPost('generatePdf', { jointId: state.currentJoint.joint.id }).then(result => {
    state.currentJoint.joint.pdfUrl = result.pdfUrl;
    hideOverlay();
    const linkWrap = document.getElementById('pdf-link-wrap');
    linkWrap.style.display = 'block';
    document.getElementById('pdf-link').href = result.pdfUrl;
  }).catch(showError);
}

// ---------- 履歴検索 ----------

function goHistory() {
  navStack = [];
  goTo({ screenId: 'history-screen', title: '履歴検索', load: loadHistoryDefault });
}

function loadHistoryDefault() {
  document.getElementById('history-keyword').value = '';
  const listEl = document.getElementById('history-list');
  listEl.innerHTML = '<div class="loading-text">読み込み中...</div>';
  apiGet('listRecentJoints', { limit: 30 }).then(renderHistoryList).catch(showError);
}

function submitHistorySearch() {
  const kw = document.getElementById('history-keyword').value.trim();
  const listEl = document.getElementById('history-list');
  listEl.innerHTML = '<div class="loading-text">検索中...</div>';
  apiGet('searchJoints', { keyword: kw }).then(renderHistoryList).catch(showError);
}

function renderHistoryList(rows) {
  const listEl = document.getElementById('history-list');
  if (!rows.length) { listEl.innerHTML = '<div class="loading-text">該当する記録がありません</div>'; return; }
  listEl.innerHTML = rows.map(r => `
    <div class="list-item" onclick="goJointRecord(${r.id})">
      <div class="list-item-title">${escapeHtml(r.position)} ${jointBadgeHtml(r)}</div>
      <div class="list-item-sub">${escapeHtml(r.projectName)} ／ ${escapeHtml(r.partCode)}</div>
      <div class="list-item-sub">溶接士: ${escapeHtml(r.welder || '-')}　検査員: ${escapeHtml(r.inspector || '-')}　開始: ${escapeHtml(r.createdAt)}</div>
    </div>`).join('');
}
