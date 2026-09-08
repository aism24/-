// デプロイ済みGAS WebアプリのURL（/exec で終わるURL）
// GASプロジェクトを新規デプロイした後、ここを実際のURLに書き換えてください。
const GAS_API_URL = "https://script.google.com/macros/s/AKfycbxxr8gS18NwLqMEfxz87ISsvix6HJAD9TqHQt2oAHILxqLdW9f6CWYqam8ym_gBvhWt1w/exec";

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
  document.getElementById('createFormBody').style.display = 'none';
  loadTournamentList();
}

function toggleCreateForm() {
  const body = document.getElementById('createFormBody');
  body.style.display = (body.style.display === 'none') ? 'block' : 'none';
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
      `<div class="tournamentListItem" onclick="openTournament('${t.prefix}')">${t.name}（${t.prefix}）</div>`
    ).join('');
  }).catch(e => { container.innerText = 'エラー: ' + e.message; });
}

// 大会名を入力すると、略称欄がユーザーに手で編集されるまでは頭2文字を自動追従する
let prefixManuallyEdited = false;
document.getElementById('newTournamentName').addEventListener('input', (e) => {
  if (prefixManuallyEdited) return;
  document.getElementById('newTournamentPrefix').value = e.target.value.trim().substring(0, 2);
});
document.getElementById('newTournamentPrefix').addEventListener('input', () => {
  prefixManuallyEdited = true;
});

function createTournament() {
  const nameEl = document.getElementById('newTournamentName');
  const prefixEl = document.getElementById('newTournamentPrefix');
  const errorEl = document.getElementById('createError');
  errorEl.innerText = '';
  const name = nameEl.value.trim();
  const prefix = prefixEl.value.trim();
  if (!name) { errorEl.innerText = '大会名を入力してください'; return; }
  if (prefix.length > 4) { errorEl.innerText = '略称は4文字以内にしてください'; return; }
  showLoading('作成中…');
  apiPost('createTournament', { name: name, prefix: prefix }).then(data => {
    hideLoading();
    nameEl.value = '';
    prefixEl.value = '';
    prefixManuallyEdited = false;
    // 作成応答に大会データが同梱されているので、改めてgetTournamentを呼ばずに開く
    openTournamentWithData(data.prefix, data.tournament);
  }).catch(e => { hideLoading(); errorEl.innerText = 'エラー: ' + e.message; });
}

/* ---- 大会画面 ---- */

function resetEditingState() {
  scoreBuffer = {};
  pdfLinks = { day1: null, day2: null };
}

// 取得済みの大会データをそのまま画面に反映する（getTournamentを呼び直さない版）
function applyTournament(data) {
  currentTournament = data;
  document.getElementById('tournamentTitle').innerText = data.name;
  updateTabVisibility();
}

function openTournament(prefix) {
  currentPrefix = prefix;
  resetEditingState();
  document.getElementById('homeScreen').style.display = 'none';
  document.getElementById('tournamentApp').style.display = 'block';
  document.getElementById('tournamentTitle').innerText = '読み込み中…';
  loadTournament(() => showTab(currentTournament.day1.teamsFilled ? 'day1' : 'teams'));
}

// createTournamentの応答にすでに大会データが含まれている場合、
// getTournamentを呼び直さずにそのまま大会画面を開く（往復回数の削減）
function openTournamentWithData(prefix, data) {
  currentPrefix = prefix;
  resetEditingState();
  document.getElementById('homeScreen').style.display = 'none';
  document.getElementById('tournamentApp').style.display = 'block';
  applyTournament(data);
  showTab(currentTournament.day1.teamsFilled ? 'day1' : 'teams');
}

function loadTournament(afterLoad) {
  showLoading('読み取り中…');
  apiGet('getTournament', { prefix: currentPrefix }).then(data => {
    hideLoading();
    applyTournament(data);
    if (afterLoad) afterLoad();
    else showTab(currentTab);
  }).catch(e => { hideLoading(); showStatus('エラー: ' + e.message); });
}

// チーム登録が済むまで「1日目」タブ、1日目の結果が出揃うまで「2日目」タブを非表示にする。
// 非表示になったタブが選択中だった場合は、表示できる最後のタブに戻す。
function updateTabVisibility() {
  const day1Ready = currentTournament.day1.teamsFilled;
  const day2Ready = currentTournament.day1.scoresComplete;
  document.getElementById('tabBtn-day1').style.display = day1Ready ? '' : 'none';
  document.getElementById('tabBtn-day2').style.display = day2Ready ? '' : 'none';
  if (currentTab === 'day1' && !day1Ready) currentTab = 'teams';
  if (currentTab === 'day2' && !day2Ready) currentTab = day1Ready ? 'day1' : 'teams';
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
  renderPdfHeaderActions(null);
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
  apiPost('setTeams', { prefix: currentPrefix, teams: teams }).then(result => {
    hideLoading();
    showStatus(result.message);
    applyTournament(result.tournament);
    showTab('day1');
  }).catch(e => { hideLoading(); errorEl.innerText = 'エラー: ' + e.message; });
}

/* ---- 1日目／2日目：対戦・得点入力 ---- */

function renderDayTab(day) {
  const container = document.getElementById(day + 'Content');
  const dayData = currentTournament[day];

  if (!currentTournament.day1.teamsFilled) {
    container.innerHTML = '<p class="hint">先に「チーム登録」タブでチームを登録してください。</p>';
    renderPdfHeaderActions(null);
    return;
  }
  if (day === 'day2' && !dayData.teamsFilled) {
    container.innerHTML = '<p class="hint">1日目の結果が出揃うと、ここで「2日目作成」ができるようになります。</p>';
    renderPdfHeaderActions(null);
    return;
  }

  // 未記録の試合は、それより前がすべて記録済みでない限り新規入力させない（順番に記録させるため）
  let priorAllRecorded = true;
  const rows = dayData.matches.map(m => {
    const recorded = m.lightScore !== '' && m.lightScore !== null && m.darkScore !== '' && m.darkScore !== null;
    const row = renderMatchRow(day, m, recorded, priorAllRecorded);
    if (!recorded) priorAllRecorded = false;
    return row;
  }).join('');
  let html = `<table>
    <tr><th>#</th><th>淡チーム</th><th>得点（淡-濃）</th><th>濃チーム</th><th></th></tr>
    ${rows}
  </table>`;

  const rankRows = dayData.rank.map((team, i) => team ? `<tr><td>${i + 1}位</td><td>${team}</td></tr>` : '').join('');
  if (rankRows) {
    const rankTitle = day === 'day2' ? '総合順位（1・2日目合算）' : '順位';
    html += `<h2 style="margin-top:20px">${rankTitle}</h2><table class="rankTable"><tr><th>順位</th><th>チーム</th></tr>${rankRows}</table>`;
  }

  if (day === 'day1' && dayData.scoresComplete && !currentTournament.day2.teamsFilled) {
    html += `<div id="day2Bar"><p>1日目の全結果が出揃いました。2日目の組み合わせを作成できます。</p>
      <button type="button" onclick="createDay2Action()">2日目作成</button></div>`;
  }

  container.innerHTML = html;
  renderPdfHeaderActions(day);
}

// 大会名と同じ行に、現在表示中の日の操作ボタンを描画する（PDFの左に「2日目を再編集」）
function renderPdfHeaderActions(day) {
  const el = document.getElementById('pdfHeaderActions');
  if (!day) { el.innerHTML = ''; return; }
  const link = pdfLinks[day];
  const redoBtn = (day === 'day1' && currentTournament.day1.scoresComplete)
    ? `<button type="button" class="btnRedoDay2" onclick="createDay2Action()">2日目を再編集</button>` : '';
  el.innerHTML = redoBtn +
    `<button type="button" class="btnPdfDownload" onclick="downloadPdf('${day}')">PDFダウンロード</button>` +
    (link ? `<a class="pdfBtn" href="${link.url}" target="_blank" download="${link.fileName}">PDF表示</a>` : '');
}

// 生成済みPDFのリンク（大会名と同じ行のヘッダーに表示）。day1/day2で別管理。
let pdfLinks = { day1: null, day2: null };

/* ---- 得点入力：得点欄をタップすると0〜9ボタンで3桁まで入力できる（例: 1→2→3の順で押すと「123」）---- */

// キーが存在しない = まだ一度もタップして入力していない（保存済みの得点をそのまま表示する）。
// キーの値は「タップ後に押した数字をそのまま並べた文字列」で、保存済みの得点は含めない
// （既存の得点に追記するのではなく、タップ後の最初の入力から新しい数字を打ち直す）。
let scoreBuffer = {}; // "day-index-side" -> "" | "1" | "12" | "123" など
let activeScoreEntry = null; // {day, index, side}

function scoreKey(day, index, side) { return `${day}-${index}-${side}`; }

function padScore(v) {
  const n = (v === '' || v === null || v === undefined) ? 0 : Number(v);
  return String(Math.max(0, Math.min(199, Math.floor(n) || 0)));
}

// 得点欄に表示する現在値。未入力ならsavedScore（保存済みの得点）をそのまま表示する
function currentScoreStr(day, index, side, savedScore) {
  const key = scoreKey(day, index, side);
  return padScore((key in scoreBuffer) ? scoreBuffer[key] : savedScore);
}

function scoreFromBuffer(day, index, side, savedScore) {
  const key = scoreKey(day, index, side);
  return Number(padScore((key in scoreBuffer) ? scoreBuffer[key] : savedScore));
}

function openDigitPicker(day, index, side, savedScore) {
  activeScoreEntry = { day, index, side, savedScore };
  document.getElementById('digitPickerTitle').innerText = (side === 'light' ? '淡' : '濃') + '得点';
  document.getElementById('digitPickerButtons').innerHTML = [0, 1, 2, 3, 4, 5, 6, 7, 8, 9].map((d) =>
    `<button type="button" class="digitChoice" onclick="pressDigit(${d})">${d}</button>`
  ).join('');
  updateDigitPickerPreview();
  document.getElementById('digitPickerOverlay').classList.add('active');
}

function updateDigitPickerPreview() {
  if (!activeScoreEntry) return;
  const { day, index, side, savedScore } = activeScoreEntry;
  const key = scoreKey(day, index, side);
  const value = padScore((key in scoreBuffer) ? scoreBuffer[key] : savedScore);
  document.getElementById('digitPickerPreview').innerText = value;
  const tapBtn = document.querySelector(`.scoreTap[data-key="${key}"]`);
  if (tapBtn) tapBtn.textContent = value;
  updateSaveButtonState(day, index);
}

// 押すたびに末尾へ数字を追加していく（保存済みの得点には追記せず、タップ後の最初の入力から打ち直す）。
// 3桁を超えたら先頭からあふれた分を捨てる（例: 1→2→3の順で押すと「123」）
function pressDigit(d) {
  if (!activeScoreEntry) return;
  const key = scoreKey(activeScoreEntry.day, activeScoreEntry.index, activeScoreEntry.side);
  const typed = (key in scoreBuffer) ? scoreBuffer[key] : '';
  scoreBuffer[key] = (typed + String(d)).slice(-3);
  updateDigitPickerPreview();
}

// 入力間違いのとき、この得点欄だけを0に戻す
function clearDigitEntry() {
  if (!activeScoreEntry) return;
  const key = scoreKey(activeScoreEntry.day, activeScoreEntry.index, activeScoreEntry.side);
  scoreBuffer[key] = '';
  updateDigitPickerPreview();
}

function closeDigitPicker() {
  activeScoreEntry = null;
  document.getElementById('digitPickerOverlay').classList.remove('active');
}

// 保存済みの得点から変更されていなければ「保存」ボタンをグレーアウトする
function updateSaveButtonState(day, index) {
  const m = currentTournament[day].matches.find((x) => x.index === index);
  if (!m) return;
  const recorded = m.lightScore !== '' && m.lightScore !== null && m.darkScore !== '' && m.darkScore !== null;
  const changed = !recorded ||
    scoreFromBuffer(day, index, 'light', m.lightScore) !== Number(m.lightScore) ||
    scoreFromBuffer(day, index, 'dark', m.darkScore) !== Number(m.darkScore);
  const btn = document.getElementById(`saveBtn-${day}-${index}`);
  if (btn) btn.disabled = !changed;
}

/* ---- 対戦行の描画 ---- */

function renderMatchRow(day, m, recorded, allowedToEnter) {
  if (!recorded && !allowedToEnter) {
    return `<tr>
      <td>${m.index + 1}</td>
      <td>${m.light}</td>
      <td class="hint">前の試合を先に</td>
      <td>${m.dark}</td>
      <td></td>
    </tr>`;
  }

  let lightWins = false, darkWins = false;
  if (recorded) {
    const ls = Number(m.lightScore), ds = Number(m.darkScore);
    if (!isNaN(ls) && !isNaN(ds) && ls !== ds) { lightWins = ls > ds; darkWins = ds > ls; }
  }

  const lightVal = currentScoreStr(day, m.index, 'light', m.lightScore);
  const darkVal = currentScoreStr(day, m.index, 'dark', m.darkScore);
  const changed = !recorded || Number(lightVal) !== Number(m.lightScore) || Number(darkVal) !== Number(m.darkScore);

  return `<tr>
    <td>${m.index + 1}</td>
    <td class="${lightWins ? 'winCell' : ''}">${m.light}</td>
    <td class="scoreCell">${renderScoreTap(day, m.index, 'light', lightVal, m.lightScore)}<span class="scoreDash">-</span>${renderScoreTap(day, m.index, 'dark', darkVal, m.darkScore)}</td>
    <td class="${darkWins ? 'winCell' : ''}">${m.dark}</td>
    <td><button type="button" id="saveBtn-${day}-${m.index}" ${changed ? '' : 'disabled'} onclick="submitMatchScore('${day}', ${m.index})">保存</button></td>
  </tr>`;
}

// タップすると数字ピッカーが開く、常に編集可能な得点欄（記録済み・未記録どちらも同じ見た目）
function renderScoreTap(day, index, side, value, savedScore) {
  const key = scoreKey(day, index, side);
  const savedArg = (savedScore === '' || savedScore === null || savedScore === undefined) ? 'null' : Number(savedScore);
  return `<button type="button" class="scoreTap" data-key="${key}" onclick="openDigitPicker('${day}', ${index}, '${side}', ${savedArg})">${value}</button>`;
}

function submitMatchScore(day, index) {
  const m = currentTournament[day].matches.find((x) => x.index === index);
  const lightScore = scoreFromBuffer(day, index, 'light', m.lightScore);
  const darkScore = scoreFromBuffer(day, index, 'dark', m.darkScore);
  showLoading('保存中…');
  apiPost('submitScore', { prefix: currentPrefix, day: day, matchIndex: index, lightScore: lightScore, darkScore: darkScore }).then(result => {
    hideLoading();
    showStatus(result.message);
    applyTournament(result.tournament);
    showTab(currentTab);
  }).catch(e => { hideLoading(); showStatus('エラー: ' + e.message); });
}

function createDay2Action() {
  const msg = currentTournament.day2.teamsFilled
    ? '1日目の最新結果で2日目の組み合わせを作り直します。現在の2日目の対戦・得点はリセットされます。よろしいですか？'
    : '2日目の組み合わせを作成します。よろしいですか？';
  if (!confirm(msg)) return;
  showLoading('作成中…');
  apiPost('createDay2', { prefix: currentPrefix }).then(result => {
    hideLoading();
    showStatus(result.message);
    applyTournament(result.tournament);
    showTab('day2');
  }).catch(e => { hideLoading(); showStatus('エラー: ' + e.message); });
}

function downloadPdf(day) {
  showLoading('作成中…');
  apiPost('exportPdf', { prefix: currentPrefix, day: day }).then(data => {
    hideLoading();
    const byteChars = atob(data.base64);
    const byteNumbers = new Array(byteChars.length);
    for (let i = 0; i < byteChars.length; i++) byteNumbers[i] = byteChars.charCodeAt(i);
    const blob = new Blob([new Uint8Array(byteNumbers)], { type: 'application/pdf' });
    const url = URL.createObjectURL(blob);
    pdfLinks[day] = { url: url, fileName: data.fileName };
    renderPdfHeaderActions(day);
    showStatus('作成しました');
  }).catch(e => { hideLoading(); showStatus('エラー: ' + e.message); });
}

/* ---- 起動時 ---- */
showHome();
