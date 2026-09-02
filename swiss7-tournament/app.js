// デプロイ済みGAS WebアプリのURL（/exec で終わるURL）
// GASプロジェクトを新規デプロイした後、ここを実際のURLに書き換えてください。
const GAS_API_URL = "REPLACE_WITH_YOUR_GAS_WEB_APP_URL";

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

function showLoading(text) {
  document.getElementById('loadingText').innerText = text;
  document.getElementById('loadingOverlay').classList.add('active');
}
function hideLoading() {
  document.getElementById('loadingOverlay').classList.remove('active');
}
function showStatus(msg) {
  const el = document.getElementById('status');
  if (el) el.innerText = msg;
}

/* ---- トップ画面（大会一覧） ---- */

let currentPrefix = null;
let currentTournament = null;
let currentTab = 'teams';

function showHome() {
  currentPrefix = null;
  currentTournament = null;
  document.getElementById('homeScreen').style.display = 'block';
  document.getElementById('tournamentApp').style.display = 'none';
  loadTournamentList();
}

function loadTournamentList() {
  const container = document.getElementById('tournamentList');
  container.innerText = '読み込み中…';
  apiGet('listTournaments').then(list => {
    if (!list.length) {
      container.innerHTML = '<p class="hint">まだ大会がありません。上のフォームから作成してください。</p>';
      return;
    }
    container.innerHTML = list.map(t =>
      `<div class="tournamentListItem"><span>${t.prefix}</span><button type="button" onclick="openTournament('${t.prefix}')">開く</button></div>`
    ).join('');
  }).catch(e => { container.innerText = 'エラー: ' + e.message; });
}

function createTournament() {
  const nameEl = document.getElementById('newTournamentName');
  const errorEl = document.getElementById('createError');
  errorEl.innerText = '';
  const name = nameEl.value.trim();
  if (!name) { errorEl.innerText = '大会名を入力してください'; return; }
  showLoading('作成中…');
  apiPost('createTournament', { name: name }).then(data => {
    hideLoading();
    nameEl.value = '';
    openTournament(data.prefix);
  }).catch(e => { hideLoading(); errorEl.innerText = 'エラー: ' + e.message; });
}

/* ---- 大会画面 ---- */

function openTournament(prefix) {
  currentPrefix = prefix;
  document.getElementById('homeScreen').style.display = 'none';
  document.getElementById('tournamentApp').style.display = 'block';
  document.getElementById('tournamentTitle').innerText = '大会: ' + prefix;
  loadTournament(() => showTab(currentTournament.day1.teamsFilled ? 'day1' : 'teams'));
}

function loadTournament(afterLoad) {
  showLoading('読み取り中…');
  apiGet('getTournament', { prefix: currentPrefix }).then(data => {
    hideLoading();
    currentTournament = data;
    if (afterLoad) afterLoad();
    else renderCurrentTab();
  }).catch(e => { hideLoading(); showStatus('エラー: ' + e.message); });
}

function showTab(name) {
  currentTab = name;
  ['teams', 'day1', 'day2'].forEach(n => {
    document.getElementById('panel-' + n).classList.toggle('active', n === name);
    document.getElementById('tabBtn-' + n).classList.toggle('active', n === name);
  });
  renderCurrentTab();
}

function renderCurrentTab() {
  if (currentTab === 'teams') renderTeamsTab();
  if (currentTab === 'day1') renderDayTab('day1');
  if (currentTab === 'day2') renderDayTab('day2');
}

/* ---- チーム登録 ---- */

function renderTeamsTab() {
  const teams = currentTournament.day1.teams;
  const container = document.getElementById('teamInputs');
  container.innerHTML = teams.map((t, i) =>
    `<label class="teamRow"><span>チーム${i + 1}</span><input type="text" class="teamNameInput" data-index="${i}" value="${t || ''}"></label>`
  ).join('');
  document.getElementById('teamsError').innerText = '';
}

function saveTeams() {
  const errorEl = document.getElementById('teamsError');
  errorEl.innerText = '';
  const inputs = document.querySelectorAll('.teamNameInput');
  const teams = Array.from(inputs).map(el => el.value.trim());
  const seen = new Set();
  for (const t of teams) {
    if (!t) { errorEl.innerText = 'すべてのチーム名を入力してください'; return; }
    if (seen.has(t)) { errorEl.innerText = `チーム名が重複しています: 「${t}」`; return; }
    seen.add(t);
  }
  showLoading('保存中…');
  apiPost('setTeams', { prefix: currentPrefix, teams: teams }).then(msg => {
    hideLoading();
    showStatus(msg);
    loadTournament(() => showTab('day1'));
  }).catch(e => { hideLoading(); errorEl.innerText = 'エラー: ' + e.message; });
}

/* ---- 1日目／2日目：対戦・得点入力 ---- */

function renderDayTab(day) {
  const container = document.getElementById(day + 'Content');
  const dayData = currentTournament[day];

  if (!currentTournament.day1.teamsFilled) {
    container.innerHTML = '<p class="hint">先に「チーム登録」タブでチームを登録してください。</p>';
    return;
  }
  if (day === 'day2' && !dayData.teamsFilled) {
    container.innerHTML = '<p class="hint">1日目の結果が出揃うと、ここで「2日目作成」ができるようになります。</p>';
    return;
  }

  const rows = dayData.matches.map(m => renderMatchRow(day, m)).join('');
  let html = `<table>
    <tr><th>#</th><th>淡チーム</th><th>淡得点</th><th>濃得点</th><th>濃チーム</th><th></th></tr>
    ${rows}
  </table>`;

  const rankRows = dayData.rank.map((team, i) => team ? `<tr><td>${i + 1}位</td><td>${team}</td></tr>` : '').join('');
  if (rankRows) {
    html += `<h2 style="margin-top:20px">順位</h2><table class="rankTable"><tr><th>順位</th><th>チーム</th></tr>${rankRows}</table>`;
  }

  if (day === 'day1' && dayData.scoresComplete && !currentTournament.day2.teamsFilled) {
    html += `<div id="day2Bar"><p>1日目の全結果が出揃いました。2日目の組み合わせを作成できます。</p>
      <button type="button" onclick="createDay2Action()">2日目作成</button></div>`;
  }

  html += `<h2 style="margin-top:20px">速報PDF</h2>
    <p class="hint">現時点の結果を1枚のPDFでダウンロードします（途中経過でも可）。</p>
    <button type="button" onclick="downloadPdf('${day}')">PDFダウンロード</button>
    <div id="${day}PdfLink"></div>`;

  container.innerHTML = html;
}

function renderMatchRow(day, m) {
  const recorded = m.lightScore !== '' && m.lightScore !== null && m.darkScore !== '' && m.darkScore !== null;
  let lightWins = false, darkWins = false;
  if (recorded) {
    const ls = Number(m.lightScore), ds = Number(m.darkScore);
    if (!isNaN(ls) && !isNaN(ds) && ls !== ds) { lightWins = ls > ds; darkWins = ds > ls; }
  }
  return `<tr>
    <td>${m.index + 1}</td>
    <td class="${lightWins ? 'winCell' : ''}">${m.light}</td>
    <td class="${lightWins ? 'winCell' : ''}"><input type="number" id="${day}-l-${m.index}" value="${m.lightScore === '' || m.lightScore === null ? '' : m.lightScore}"></td>
    <td class="${darkWins ? 'winCell' : ''}"><input type="number" id="${day}-d-${m.index}" value="${m.darkScore === '' || m.darkScore === null ? '' : m.darkScore}"></td>
    <td class="${darkWins ? 'winCell' : ''}">${m.dark}</td>
    <td><button type="button" onclick="submitMatchScore('${day}', ${m.index})">保存</button></td>
  </tr>`;
}

function submitMatchScore(day, index) {
  const lightScore = document.getElementById(`${day}-l-${index}`).value;
  const darkScore = document.getElementById(`${day}-d-${index}`).value;
  if (lightScore === '' || darkScore === '') { showStatus('得点を両方入力してください'); return; }
  showLoading('保存中…');
  apiPost('submitScore', { prefix: currentPrefix, day: day, matchIndex: index, lightScore: lightScore, darkScore: darkScore }).then(msg => {
    hideLoading();
    showStatus(msg);
    loadTournament();
  }).catch(e => { hideLoading(); showStatus('エラー: ' + e.message); });
}

function createDay2Action() {
  if (!confirm('2日目の組み合わせを作成します。よろしいですか？')) return;
  showLoading('作成中…');
  apiPost('createDay2', { prefix: currentPrefix }).then(msg => {
    hideLoading();
    showStatus(msg);
    loadTournament(() => showTab('day2'));
  }).catch(e => { hideLoading(); showStatus('エラー: ' + e.message); });
}

function downloadPdf(day) {
  showLoading('作成中…');
  apiPost('exportPdf', { prefix: currentPrefix, day: day }).then(url => {
    hideLoading();
    document.getElementById(day + 'PdfLink').innerHTML = `<a class="pdfBtn" href="${url}" target="_blank">PDF表示</a>`;
    showStatus('作成しました');
  }).catch(e => { hideLoading(); showStatus('エラー: ' + e.message); });
}

/* ---- 起動時 ---- */
showHome();
