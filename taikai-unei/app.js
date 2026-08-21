// デプロイ済みGAS WebアプリのURL（/exec で終わるURL）
// GASプロジェクトを新規デプロイした後、ここを実際のURLに書き換えてください。
const GAS_API_URL = "https://script.google.com/macros/s/xxxxx/exec";

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

let currentTab = 'assign';

function showStatus(msg) {
  document.getElementById('status').innerText = msg;
}

function showLoading(text) {
  document.getElementById('loadingText').innerText = text;
  document.getElementById('loadingOverlay').classList.add('active');
}

function hideLoading() {
  document.getElementById('loadingOverlay').classList.remove('active');
}

/* ---- トップ画面 ---- */

function showHome() {
  document.getElementById('homeScreen').style.display = 'block';
  document.getElementById('tournamentApp').style.display = 'none';
  document.getElementById('searchApp').style.display = 'none';
}

function showApp(which) {
  document.getElementById('homeScreen').style.display = 'none';
  if (which === 'tournament') {
    document.getElementById('tournamentApp').style.display = 'block';
    document.getElementById('searchApp').style.display = 'none';
    showTab(currentTab);
    refreshDay2Bar();
  } else {
    document.getElementById('tournamentApp').style.display = 'none';
    document.getElementById('searchApp').style.display = 'block';
    loadTeamList();
  }
}

function showTab(name) {
  currentTab = name;
  ['info', 'assign', 'score'].forEach(n => {
    document.getElementById('panel-' + n).classList.toggle('active', n === name);
    document.getElementById('tabBtn-' + n).classList.toggle('active', n === name);
  });
  if (name === 'assign') loadAssignments();
  if (name === 'info') loadInfoEdits();
  if (name === 'score') loadCourtButtons();
}

/* ---- ２日目作成 ---- */

function refreshDay2Bar() {
  apiGet('getDay2Status').then(status => {
    document.getElementById('day2Bar').style.display =
      (status.day1Complete && !status.day2Created) ? 'block' : 'none';
  }).catch(() => {});
}

function createDay2() {
  if (!confirm('２日目の組み合わせを作成します。よろしいですか？')) return;
  showLoading('作成中…');
  apiPost('createDay2', {}).then(msg => {
    hideLoading();
    showStatus(msg);
    refreshDay2Bar();
    if (currentTab === 'assign') loadAssignments();
    if (currentTab === 'score') loadCourtButtons();
  }).catch(e => { hideLoading(); showStatus('エラー: ' + e.message); });
}

/* ---- 情報編集 ---- */

let infoEditData = null; // { groups: [{group, venue}], teams: [{group, seat, team}] }
let infoEditMode = null; // 'venue' | 'team' | null

function loadInfoEdits() {
  showLoading('読み取り中…');
  apiGet('getInfoEditData').then(data => {
    hideLoading();
    infoEditData = data;
    infoEditMode = null;
    document.getElementById('infoForm').innerHTML = '';
    document.getElementById('infoError').innerText = '';
    document.getElementById('infoSaveBtn').style.display = 'none';
  }).catch(e => { hideLoading(); showStatus('エラー: ' + e.message); });
}

function startInfoEdit(mode) {
  infoEditMode = mode;
  document.getElementById('infoError').innerText = '';
  document.getElementById('infoSaveBtn').style.display = 'none';
  const container = document.getElementById('infoForm');

  if (mode === 'venue') {
    const groupInputs = infoEditData.groups.map((g, gi) =>
      `<label>会場（${g.group}）<input type="text" class="venueInput" data-index="${gi}" value="${g.venue}"></label>`
    ).join('');
    const day2Inputs = infoEditData.day2VenueSheets.map((sheetName, di) =>
      `<label>会場（${sheetName}）<input type="text" class="day2VenueInput" data-index="${di}" value="${infoEditData.day2Venues[di]}"></label>`
    ).join('');
    container.innerHTML = groupInputs + day2Inputs;
  } else {
    container.innerHTML = infoEditData.groups.map(g => {
      const teamsOfGroup = infoEditData.teams
        .map((t, ti) => Object.assign({}, t, { ti }))
        .filter(t => t.group === g.group);
      const teamInputs = teamsOfGroup.map(t =>
        `<label class="teamRow"><span class="teamLabel">座席${t.seat} チーム名（${g.group}）</span><input type="text" class="teamInput" data-index="${t.ti}" value="${t.team}"></label>`
      ).join('');
      return `<div class="groupBlock"><strong>${g.group}</strong>${teamInputs}</div>`;
    }).join('');
  }

  container.querySelectorAll('input').forEach(el => {
    el.addEventListener('input', () => {
      document.getElementById('infoError').innerText = '';
      document.getElementById('infoSaveBtn').style.display = 'inline-block';
    });
  });
}

function saveInfoEdits() {
  const errorEl = document.getElementById('infoError');
  errorEl.innerText = '';

  const venues = infoEditData.groups.map(g => g.venue);
  const teamNames = infoEditData.teams.map(t => t.team);
  const day2Venues = infoEditData.day2Venues.slice();

  if (infoEditMode === 'venue') {
    document.querySelectorAll('.venueInput').forEach(el => {
      venues[Number(el.dataset.index)] = el.value;
    });
    document.querySelectorAll('.day2VenueInput').forEach(el => {
      day2Venues[Number(el.dataset.index)] = el.value;
    });
  } else if (infoEditMode === 'team') {
    document.querySelectorAll('.teamInput').forEach(el => {
      teamNames[Number(el.dataset.index)] = el.value;
    });
  }

  if (infoEditMode === 'team') {
    const seen = new Set();
    for (const name of teamNames) {
      const trimmed = (name || '').trim();
      if (!trimmed) continue;
      if (seen.has(trimmed)) {
        errorEl.innerText = `チーム名が重複しています: 「${trimmed}」。別の名前にしてください`;
        return;
      }
      seen.add(trimmed);
    }
  }

  showLoading('保存中…');
  apiPost('saveInfoEdits', { venues: venues, teamNames: teamNames, day2Venues: day2Venues }).then(msg => {
    hideLoading();
    showStatus(msg);
    loadInfoEdits();
    refreshDay2Bar();
  }).catch(e => { hideLoading(); errorEl.innerText = 'エラー: ' + e.message; });
}

function resetScores() {
  if (!confirm('試合結果（得点）をすべてリセットします。チーム名・会場名・審判はそのまま残ります。よろしいですか？')) return;
  showLoading('リセット中…');
  apiPost('resetScores', {}).then(msg => {
    hideLoading();
    showStatus(msg);
    loadInfoEdits();
    refreshDay2Bar();
  }).catch(e => { hideLoading(); showStatus('エラー: ' + e.message); });
}

/* ---- 結果表ダウンロード（Excel） ---- */

function exportDay1Results() {
  showLoading('作成中…');
  apiPost('exportDay1Results', {}).then(url => {
    hideLoading();
    document.getElementById('downloadLinks').innerHTML = `<a href="${url}" target="_blank">初日結果ダウンロードはこちら</a>`;
    showStatus('作成しました');
  }).catch(e => { hideLoading(); showStatus('エラー: ' + e.message); });
}

function exportDay2RoundRobin() {
  showLoading('作成中…');
  apiPost('exportDay2RoundRobin', {}).then(url => {
    hideLoading();
    document.getElementById('downloadLinks').innerHTML = `<a href="${url}" target="_blank">２日目総当たりダウンロードはこちら</a>`;
    showStatus('作成しました');
  }).catch(e => { hideLoading(); showStatus('エラー: ' + e.message); });
}

function exportDay2Tournament() {
  showLoading('作成中…');
  apiPost('exportDay2Tournament', {}).then(url => {
    hideLoading();
    document.getElementById('downloadLinks').innerHTML = `<a href="${url}" target="_blank">２日目トーナメントダウンロードはこちら</a>`;
    showStatus('作成しました');
  }).catch(e => { hideLoading(); showStatus('エラー: ' + e.message); });
}

/* ---- 速報PDF ---- */

function downloadBulletinPdf(day) {
  showLoading('作成中…');
  apiPost('exportBulletinPdf', { day: day }).then(url => {
    hideLoading();
    document.getElementById('pdfExportLink').innerHTML = `<a class="pdfViewBtn" href="${url}" target="_blank">PDF表示</a>`;
    showStatus('作成しました');
  }).catch(e => { hideLoading(); showStatus('エラー: ' + e.message); });
}

function downloadScorePdf(day) {
  showLoading('作成中…');
  apiPost('exportBulletinPdf', { day: day }).then(url => {
    hideLoading();
    document.getElementById('scorePdfExportLink').innerHTML = `<a class="pdfViewBtn" href="${url}" target="_blank">PDF表示</a>`;
    showStatus('作成しました');
  }).catch(e => { hideLoading(); showStatus('エラー: ' + e.message); });
}

function downloadAssignPdf(day) {
  showLoading('作成中…');
  apiPost('exportBulletinPdf', { day: day }).then(url => {
    hideLoading();
    document.getElementById('assignPdfExportLink').innerHTML = `<a class="pdfViewBtn" href="${url}" target="_blank">PDF表示</a>`;
    showStatus('作成しました');
  }).catch(e => { hideLoading(); showStatus('エラー: ' + e.message); });
}

/* ---- 割り当て ---- */

let assignLocations = [];
let assignSelectedSheet = null;
let assignSelectedCourtIndex = null;

function loadAssignments() {
  showLoading('読み取り中…');
  apiGet('getLocationOptions').then(locs => {
    hideLoading();
    assignLocations = locs;
    renderAssignVenueButtons();
    const loc = assignLocations.find(l => l.sheet === assignSelectedSheet);
    if (loc && (!loc.hasCourts || assignSelectedCourtIndex !== null)) {
      loadAssignTable();
    }
  }).catch(e => { hideLoading(); showStatus('エラー: ' + e.message); });
}

// 会場ボタンの行を「1日目」「2日目」ラベル付きで組み立てる（割り当て・試合結果タブ共通）
function renderDayRow(dayLabel, locs, renderBtn) {
  if (!locs.length) return '';
  return `<div class="dayRow"><span class="dayRowLabel">${dayLabel}</span><div class="courtBtnRow">${locs.map(renderBtn).join('')}</div></div>`;
}

function renderAssignVenueButtons() {
  const container = document.getElementById('assignCourtButtons');
  const renderBtn = loc =>
    `<button type="button" class="courtBtn" data-sheet="${loc.sheet}" onclick="selectAssignVenue('${loc.sheet}')">${loc.label}</button>`;
  const day1 = assignLocations.filter(loc => !loc.hasCourts);
  const day2 = assignLocations.filter(loc => loc.hasCourts);
  container.innerHTML = renderDayRow('1日目', day1, renderBtn) + renderDayRow('2日目', day2, renderBtn);
  container.querySelectorAll('.courtBtn').forEach(btn => {
    btn.classList.toggle('active', btn.dataset.sheet === assignSelectedSheet);
  });
  renderAssignSubButtons();
}

function renderAssignSubButtons() {
  const container = document.getElementById('assignSubCourtButtons');
  const loc = assignLocations.find(l => l.sheet === assignSelectedSheet);
  if (!loc || !loc.hasCourts) {
    container.innerHTML = '';
    return;
  }
  container.innerHTML = loc.courts.map(c =>
    `<button type="button" class="subCourtBtn" data-index="${c.index}" onclick="selectAssignCourt(${c.index})">${c.label}</button>`
  ).join('');
  container.querySelectorAll('.subCourtBtn').forEach(btn => {
    btn.classList.toggle('active', Number(btn.dataset.index) === assignSelectedCourtIndex);
  });
}

function selectAssignVenue(sheetName) {
  assignSelectedSheet = sheetName;
  assignSelectedCourtIndex = null;
  document.querySelectorAll('#assignCourtButtons .courtBtn').forEach(btn => {
    btn.classList.toggle('active', btn.dataset.sheet === assignSelectedSheet);
  });
  renderAssignSubButtons();
  const loc = assignLocations.find(l => l.sheet === sheetName);
  if (loc && loc.hasCourts) {
    document.getElementById('assignTables').innerHTML = '';
  } else {
    loadAssignTable();
  }
}

function selectAssignCourt(courtIndex) {
  assignSelectedCourtIndex = courtIndex;
  renderAssignSubButtons();
  loadAssignTable();
}

function loadAssignTable() {
  if (!assignSelectedSheet) return;
  showLoading('読み取り中…');
  apiGet('getAssignmentForCourt', { sheet: assignSelectedSheet, courtIndex: assignSelectedCourtIndex }).then(matches => {
    hideLoading();
    const container = document.getElementById('assignTables');
    const rows = matches.map(m => `<tr>
      <td>${m.time || ''}</td><td>${m.light || ''}</td><td>${m.lscore ?? ''}</td>
      <td>${m.dscore ?? ''}</td><td>${m.dark || ''}</td>
      <td>${m.to || ''}</td><td>${m.ref1 || ''}</td><td>${m.ref2 || ''}</td>
    </tr>`).join('');
    container.innerHTML = `<table>
      <tr><th>開始時間</th><th>淡チーム</th><th>淡得点</th><th>濃得点</th><th>濃チーム</th><th>TO</th><th>審判1</th><th>審判2</th></tr>
      ${rows}
    </table>`;
  }).catch(e => { hideLoading(); showStatus('エラー: ' + e.message); });
}

/* ---- 試合結果 ---- */

let locations = []; // getLocationOptions() の結果
let selectedSheet = null; // 選択中のシート（Ｇ１〜Ｇ４、または２日目の会場シート）
let selectedCourtIndex = null; // ２日目のみ：選択中のコート（0 or 1）。未選択はnull
let courtMatches = [];
let editingRows = new Set(); // 保存済みの行を「再編集」で開いた行番号

function loadCourtButtons() {
  showLoading('読み取り中…');
  apiGet('getLocationOptions').then(locs => {
    hideLoading();
    locations = locs;
    renderVenueButtons();
    const loc = locations.find(l => l.sheet === selectedSheet);
    if (loc && (!loc.hasCourts || selectedCourtIndex !== null)) {
      loadCourtMatches();
    }
  }).catch(e => { hideLoading(); showStatus('エラー: ' + e.message); });
}

function renderVenueButtons() {
  const container = document.getElementById('courtButtons');
  const renderBtn = loc =>
    `<button type="button" class="courtBtn" data-sheet="${loc.sheet}" onclick="selectVenue('${loc.sheet}')">${loc.label}</button>`;
  const day1 = locations.filter(loc => !loc.hasCourts); // Ｇ１〜Ｇ４：上段
  const day2 = locations.filter(loc => loc.hasCourts); // ２日目の2会場：下段
  container.innerHTML = renderDayRow('1日目', day1, renderBtn) + renderDayRow('2日目', day2, renderBtn);
  document.querySelectorAll('.courtBtn').forEach(btn => {
    btn.classList.toggle('active', btn.dataset.sheet === selectedSheet);
  });
  renderCourtSubButtons();
}

function renderCourtSubButtons() {
  const container = document.getElementById('subCourtButtons');
  const loc = locations.find(l => l.sheet === selectedSheet);
  if (!loc || !loc.hasCourts) {
    container.innerHTML = '';
    return;
  }
  container.innerHTML = loc.courts.map(c =>
    `<button type="button" class="subCourtBtn" data-index="${c.index}" onclick="selectCourt(${c.index})">${c.label}</button>`
  ).join('');
  document.querySelectorAll('.subCourtBtn').forEach(btn => {
    btn.classList.toggle('active', Number(btn.dataset.index) === selectedCourtIndex);
  });
}

function selectVenue(sheetName) {
  selectedSheet = sheetName;
  selectedCourtIndex = null;
  editingRows = new Set();
  document.querySelectorAll('.courtBtn').forEach(btn => {
    btn.classList.toggle('active', btn.dataset.sheet === selectedSheet);
  });
  renderCourtSubButtons();
  const loc = locations.find(l => l.sheet === sheetName);
  if (loc && loc.hasCourts) {
    document.getElementById('matchTableContainer').innerHTML = '';
  } else {
    loadCourtMatches();
  }
}

function selectCourt(courtIndex) {
  selectedCourtIndex = courtIndex;
  editingRows = new Set();
  renderCourtSubButtons();
  loadCourtMatches();
}

function loadCourtMatches() {
  if (!selectedSheet) return;
  showLoading('読み取り中…');
  apiGet('getCourtMatches', { sheet: selectedSheet, courtIndex: selectedCourtIndex }).then(matches => {
    hideLoading();
    courtMatches = matches;
    renderMatchTable();
  }).catch(e => { hideLoading(); showStatus('エラー: ' + e.message); });
}

function renderMatchTable() {
  const container = document.getElementById('matchTableContainer');
  const rows = courtMatches.map(renderMatchRow).join('');
  container.innerHTML = `<table>
    <tr><th></th><th>淡チーム</th><th>淡得点</th><th>濃得点</th><th>濃チーム</th><th>TO</th><th>審判1</th><th>審判2</th></tr>
    ${rows}
  </table>`;
}

function renderMatchRow(m) {
  const editing = !m.recorded || editingRows.has(m.row);
  const btn = editing
    ? `<button type="button" onclick="saveRow(${m.row})">保存</button>`
    : `<button type="button" onclick="reeditRow(${m.row})">再編集</button>`;
  const lscoreCell = editing
    ? `<input type="number" id="lscore-${m.row}" value="${m.lscore === '' || m.lscore === null ? '' : m.lscore}">`
    : `${m.lscore}`;
  const dscoreCell = editing
    ? `<input type="number" id="dscore-${m.row}" value="${m.dscore === '' || m.dscore === null ? '' : m.dscore}">`
    : `${m.dscore}`;

  let lightWins = false, darkWins = false;
  if (!editing) {
    const ls = Number(m.lscore), ds = Number(m.dscore);
    if (!isNaN(ls) && !isNaN(ds) && ls !== ds) {
      lightWins = ls > ds;
      darkWins = ds > ls;
    }
  }

  return `<tr>
    <td>${btn}</td>
    <td class="${lightWins ? 'winCell' : ''}">${m.light || '(未定)'}</td>
    <td class="${lightWins ? 'winCell' : ''}">${lscoreCell}</td>
    <td class="${darkWins ? 'winCell' : ''}">${dscoreCell}</td>
    <td class="${darkWins ? 'winCell' : ''}">${m.dark || '(未定)'}</td>
    <td>${m.to || ''}</td>
    <td>${m.ref1 || ''}</td>
    <td>${m.ref2 || ''}</td>
  </tr>`;
}

function reeditRow(row) {
  editingRows.add(row);
  renderMatchTable();
}

function saveRow(row) {
  const lightScore = document.getElementById('lscore-' + row).value;
  const darkScore = document.getElementById('dscore-' + row).value;
  if (lightScore === '' || darkScore === '') {
    showStatus('得点を両方入力してください');
    return;
  }

  let suddenDeath = '';
  const match = courtMatches.find(m => m.row === row);
  if (match && match.isFt && Number(lightScore) === Number(darkScore)) {
    const lightWins = confirm(
      `同点です。フリースロー サドンデスの勝者はどちらですか？\nOK: ${match.light || '淡チーム'} の勝ち / キャンセル: ${match.dark || '濃チーム'} の勝ち`
    );
    suddenDeath = lightWins ? 'light' : 'dark';
  }

  showLoading('保存中…');
  apiPost('submitScore', { sheet: selectedSheet, row: row, lightScore: lightScore, darkScore: darkScore, suddenDeath: suddenDeath }).then(msg => {
    hideLoading();
    showStatus(msg);
    editingRows.delete(row);
    loadCourtMatches();
    refreshDay2Bar();
  }).catch(e => { hideLoading(); showStatus('エラー: ' + e.message); });
}

/* ---- 個別検索 ---- */

let allTeams = [];
let teamDetailData = null;
let teamDetailDay = null; // 'day1' | 'day2'

function loadTeamList() {
  showLoading('読み取り中…');
  document.getElementById('searchStatus').innerText = '';
  apiGet('getAllTeams').then(teams => {
    hideLoading();
    allTeams = teams;
    teamDetailData = null;
    teamDetailDay = null;
    document.getElementById('teamDetailResult').innerHTML = '';
    document.getElementById('teamRadioList').innerHTML = teams.map(t =>
      `<button type="button" class="teamBtn" data-team="${t.team}" onclick="selectTeam('${t.team}')"><span class="teamBtnText">${t.team}</span></button>`
    ).join('');
    fitTeamButtonText();
  }).catch(e => { hideLoading(); document.getElementById('searchStatus').innerText = 'エラー: ' + e.message; });
}

// チーム名ボタンの文字が幅（8文字分）に収まらない場合、はみ出さないようフォントサイズを縮小する
function fitTeamButtonText() {
  document.querySelectorAll('.teamBtn').forEach(btn => {
    const span = btn.querySelector('.teamBtnText');
    span.style.fontSize = '';
    const available = btn.clientWidth - 8;
    if (span.scrollWidth > available) {
      const ratio = available / span.scrollWidth;
      const newSize = Math.max(Math.floor(16 * ratio * 10) / 10, 9);
      span.style.fontSize = newSize + 'px';
    }
  });
}

function selectTeam(team) {
  document.querySelectorAll('.teamBtn').forEach(btn => {
    btn.style.display = (btn.dataset.team === team) ? '' : 'none';
  });
  document.getElementById('teamDetailResult').innerHTML = '';
  document.getElementById('searchStatus').innerText = '';
  showLoading('読み取り中…');
  apiGet('getTeamSchedule', { team: team }).then(data => {
    hideLoading();
    renderTeamDetail(data);
  }).catch(e => { hideLoading(); document.getElementById('searchStatus').innerText = 'エラー: ' + e.message; });
}

function renderTeamDetail(data) {
  if (!data) {
    document.getElementById('searchStatus').innerText = 'エラー: 予定の取得に失敗しました。もう一度お試しください。';
    return;
  }
  teamDetailData = data;
  teamDetailDay = data.day2 ? 'day2' : 'day1';
  renderTeamDetailBody();
}

function showDayTab(day) {
  teamDetailDay = day;
  renderTeamDetailBody();
}

function renderTeamDetailBody() {
  const container = document.getElementById('teamDetailResult');
  const data = teamDetailData;
  if (!data.day1 && !data.day2) {
    container.innerHTML = '<p>予定が見つかりません。</p>';
    return;
  }

  let html = '<div class="dayTabRow">';
  if (data.day1) {
    html += `<button type="button" class="dayTabBtn${teamDetailDay === 'day1' ? ' active' : ''}" onclick="showDayTab('day1')">初日</button>`;
  }
  if (data.day2) {
    html += `<button type="button" class="dayTabBtn${teamDetailDay === 'day2' ? ' active' : ''}" onclick="showDayTab('day2')">２日目</button>`;
  }
  html += '</div>';

  if (teamDetailDay === 'day2' && data.day2) {
    html += renderScheduleTable(data.day2.matches, data.day2.duties);
  } else if (data.day1) {
    html += renderScheduleTable(data.day1.matches, data.day1.duties);
  } else {
    html += '<p style="font-size:13px;color:#aaa">初日の結果がまだ確定していないため、２日目の予定は分かりません。</p>';
  }

  container.innerHTML = html;
}

// 開始時間（"H:mm"）を分に変換して昇順ソートに使う。空欄（フリースロー対決等）は最後尾に回す
function timeToMinutes(t) {
  if (!t) return Infinity;
  const parts = t.split(':');
  if (parts.length < 2) return Infinity; // 「1位決定」等、時刻でないラベルは最後尾に回す
  return Number(parts[0]) * 60 + Number(parts[1]);
}

function renderScheduleTable(matches, duties) {
  // G1〜G4のシートと同じ並び（開始時間昇順、試合と審判/TO当番を1つの表にまとめる）で表示する
  const rows = (matches || []).map(m => Object.assign({}, m, { isDuty: false }))
    .concat((duties || []).map(d => Object.assign({}, d, { isDuty: true })));
  rows.sort((a, b) => timeToMinutes(a.time) - timeToMinutes(b.time));

  let html = '<table><tr><th>会場</th><th>開始時間</th><th>淡チーム</th><th>淡得点</th><th>濃得点</th><th>濃チーム</th><th>TO</th><th>審判１</th><th>審判2</th><th>備考</th></tr>';
  let prevCondition;
  let firstMatch = true;
  rows.forEach(r => {
    const lscore = r.lscore ?? '';
    const dscore = r.dscore ?? '';
    if (r.isDuty) {
      const role = r.isTo ? '審判・TO' : '審判';
      html += `<tr><td>${r.venue || ''}</td><td>${r.time || ''}</td><td>${r.light || ''}</td><td>${lscore}</td><td>${dscore}</td><td>${r.dark || ''}</td><td>${r.to || ''}</td><td>${r.ref1 || ''}</td><td>${r.ref2 || ''}</td><td class="dutyRole">${role}</td></tr>`;
    } else {
      const cond = r.condition ? `<span class="scheduleCond">（${r.condition}）</span>` : '';
      const patternStart = !firstMatch && r.condition !== prevCondition;
      prevCondition = r.condition;
      firstMatch = false;
      html += `<tr class="matchRow${patternStart ? ' patternStart' : ''}"><td>${r.venue || ''}</td><td>${r.time || ''}</td><td>${r.light || ''}</td><td>${lscore}</td><td>${dscore}</td><td>${r.dark || ''}</td><td>${r.to || ''}</td><td>${r.ref1 || ''}</td><td>${r.ref2 || ''}</td><td>試合${cond}</td></tr>`;
    }
  });
  html += '</table>';
  return html;
}

/* ---- 起動時：トップ画面を表示 ---- */
showHome();
