// デプロイ済みGAS WebアプリのURL（/exec で終わるURL）
const GAS_API_URL = "https://script.google.com/macros/s/AKfycbwMhD_aTkETK4JLBdKj1mtgwKNe790nkdVQWP5laLno4XQN8Ud6Bt69qpELaRgbcSsC/exec";

// GAS APIへのGETリクエスト共通処理
async function apiGet(action, params) {
  const url = new URL(GAS_API_URL);
  url.searchParams.set('action', action);
  if (params) {
    Object.keys(params).forEach(key => url.searchParams.set(key, params[key]));
  }
  const res = await fetch(url.toString(), { method: 'GET' });
  if (!res.ok) throw new Error('サーバーエラー（HTTP ' + res.status + '）');
  const json = await res.json();
  if (json.status !== 'success') throw new Error(json.message || 'データの取得に失敗しました');
  return json.data;
}

// GAS APIへのPOSTリクエスト共通処理
// Content-Type は "text/plain" にすることでCORSプリフライト(OPTIONS)を回避しています。
// GAS側では e.postData.contents を JSON.parse して読み取ります。
async function apiPost(action, payload) {
  const res = await fetch(GAS_API_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'text/plain;charset=utf-8' },
    body: JSON.stringify(Object.assign({ action: action }, payload)),
  });
  if (!res.ok) throw new Error('サーバーエラー（HTTP ' + res.status + '）');
  const json = await res.json();
  if (json.status !== 'success') throw new Error(json.message || '保存に失敗しました');
  return json.data;
}

let selectedFile = null;
let modalResolve = null;
let progressInterval = null;
const digits = { score: { h:0,t:0,u:0 }, concede: { h:0,t:0,u:0 } };


function showSavingPopup() {
  const overlay = document.getElementById('saving-overlay');
  const icon = document.getElementById('saving-icon');
  const message = document.getElementById('saving-message');
  const sub = document.getElementById('saving-sub');
  const bar = document.getElementById('progress-bar');
  const barWrap = document.getElementById('progress-bar-wrap');
  const errorMsg = document.getElementById('saving-error-msg');
  const closeBtn = document.getElementById('saving-close-btn');
  icon.textContent = '⏳';
  message.textContent = '保存中だで...';
  sub.textContent = 'しばらく待っとってごしない';
  bar.style.width = '0%';
  barWrap.style.display = 'block';
  errorMsg.style.display = 'none';
  errorMsg.textContent = '';
  closeBtn.style.display = 'none';
  overlay.classList.add('show');
  let progress = 0;
  progressInterval = setInterval(function() {
    if (progress < 85) {
      progress += Math.random() * 6 + 1;
      if (progress > 85) progress = 85;
      bar.style.width = progress + '%';
    }
  }, 400);
}
function completeSavingPopup() {
  clearInterval(progressInterval);
  document.getElementById('progress-bar').style.width = '100%';
}
function errorSavingPopup(errMsg) {
  clearInterval(progressInterval);
  const icon = document.getElementById('saving-icon');
  const message = document.getElementById('saving-message');
  const sub = document.getElementById('saving-sub');
  const barWrap = document.getElementById('progress-bar-wrap');
  const errorMsg = document.getElementById('saving-error-msg');
  const closeBtn = document.getElementById('saving-close-btn');
  icon.textContent = '❌';
  message.textContent = 'エラーが発生したぞな';
  sub.textContent = '';
  barWrap.style.display = 'none';
  errorMsg.textContent = errMsg;
  errorMsg.style.display = 'block';
  closeBtn.style.display = 'block';
}
function closeSavingPopup() {
  document.getElementById('saving-overlay').classList.remove('show');
  document.getElementById('save-btn').disabled = false;
}
function applyGenderTheme(isFemale) {
  const f = isFemale;
  document.getElementById('record-header').classList.toggle('female', f);
  document.getElementById('scoreboard').classList.toggle('female', f);
  ['sec-top','sec-opponent','sec-score','sec-photo'].forEach(id => {
    document.getElementById(id).classList.toggle('female', f);
  });
  ['lbl-gender','lbl-date','lbl-opponent','lbl-sh','lbl-st','lbl-su','lbl-ch','lbl-ct','lbl-cu','lbl-photo'].forEach(id => {
    document.getElementById(id).classList.toggle('female', f);
  });
  document.getElementById('date-label').classList.toggle('female', f);
  document.getElementById('opponent-select').classList.toggle('female', f);
  document.getElementById('new-opponent').classList.toggle('female', f);
  ['btn-sh-p','btn-st-p','btn-st-m','btn-su-p','btn-su-m',
   'btn-ch-p','btn-ct-p','btn-ct-m','btn-cu-p','btn-cu-m'].forEach(id => {
    document.getElementById(id).classList.toggle('female', f);
  });
  document.getElementById('score-row-concede').classList.toggle('female', f);
  document.getElementById('btn-camera').classList.toggle('female', f);
  document.getElementById('btn-gallery').classList.toggle('female', f);
  ['score-h','concede-h'].forEach(id => {
    const el = document.getElementById(id);
    if (el.classList.contains('zero')) el.classList.toggle('female', f);
  });
}
// デフォルトのチーム写真2枚は常に固定でスライドショーに含める(選択解除できない)
const FIXED_HOME_BG_IMAGES = ['images/home-bg/team-photo-1.jpg', 'images/home-bg/team-photo-2.jpg'];
let customHomeBgImages = []; // [{url, selected}] 追加した写真(チェックで含める/外せる)
let homeBgActiveLayer = 0;
let homeBgCurrentIndex = -1;
let homeBgInterval = null;
function getActiveHomeBgImages() {
  const selected = customHomeBgImages.filter(function(img) { return img.selected; }).map(function(img) { return img.url; });
  return FIXED_HOME_BG_IMAGES.concat(selected);
}
function homeBgSwitch() {
  const images = getActiveHomeBgImages();
  const layers = [document.getElementById('home-bg-img-a'), document.getElementById('home-bg-img-b')];
  const nextLayer = layers[1 - homeBgActiveLayer];
  const currentLayer = layers[homeBgActiveLayer];
  let nextIndex = homeBgCurrentIndex;
  if (images.length > 1) {
    while (nextIndex === homeBgCurrentIndex) nextIndex = Math.floor(Math.random() * images.length);
  } else {
    nextIndex = 0;
  }
  homeBgCurrentIndex = nextIndex;
  nextLayer.src = images[nextIndex];
  nextLayer.classList.add('visible');
  currentLayer.classList.remove('visible');
  homeBgActiveLayer = 1 - homeBgActiveLayer;
}
function homeBgStartSlideshow() {
  homeBgStopSlideshow();
  homeBgCurrentIndex = -1;
  if (getActiveHomeBgImages().length === 0) return;
  homeBgSwitch();
  homeBgInterval = setInterval(homeBgSwitch, 3000);
}
function homeBgStopSlideshow() {
  clearInterval(homeBgInterval);
  homeBgInterval = null;
}
// 追加した写真は共有直後で読み込みが一時的に失敗することがあるため、
// 読み込み失敗時は真っ暗のまま止まらず、少し待って別の写真に切り替える。
function homeBgHandleLoadError_(event) {
  event.target.classList.remove('visible');
  if (getActiveHomeBgImages().length > 1) setTimeout(homeBgSwitch, 800);
}
document.getElementById('home-bg-img-a').addEventListener('error', homeBgHandleLoadError_);
document.getElementById('home-bg-img-b').addEventListener('error', homeBgHandleLoadError_);
function loadHomeBgImages() {
  apiGet('getHomeBgImages').then(function(list) {
    customHomeBgImages = list || [];
    if (document.getElementById('home-screen').style.display !== 'none') homeBgStartSlideshow();
  }).catch(() => {});
}
function showScreen(screen) {
  document.getElementById('home-screen').style.display = 'none';
  homeBgStopSlideshow();
  document.getElementById('gender-select-screen').style.display = 'none';
  document.getElementById('result-screen').style.display = 'none';
  document.getElementById('input-screen').style.display = 'none';
  document.getElementById('complete-screen').style.display = 'none';
  document.getElementById('hot-screen').style.display = 'none';
  document.getElementById('bg-custom-screen').style.display = 'none';
  if (screen === 'home') {
    document.getElementById('home-screen').style.display = 'flex';
    homeBgStartSlideshow();
  } else if (screen === 'gender-select') {
    document.getElementById('gender-select-screen').style.display = 'flex';
  } else if (screen === 'result') {
    document.getElementById('result-screen').style.display = 'block';
  } else if (screen === 'record') {
    document.getElementById('input-screen').style.display = 'block';
    initRecord();
  } else if (screen === 'complete') {
    document.getElementById('complete-screen').style.display = 'block';
  } else if (screen === 'hot') {
    document.getElementById('hot-screen').style.display = 'flex';
    hotUpdateDisplay();
    hotAnimateHotheart();
    hotStartBgSlideshow();
  } else if (screen === 'bg-custom') {
    document.getElementById('bg-custom-screen').style.display = 'block';
    openBgCustomScreen();
  }
}
let currentResultsGender = null;
function showResults(gender) {
  currentResultsGender = gender;
  showScreen('result');
  const isFemale = gender === '女';
  const header = document.getElementById('result-header');
  const summaryCard = document.getElementById('summary-card');
  const resultList = document.getElementById('result-list');
  const headerTitle = document.getElementById('result-header-title');
  header.className = isFemale ? 'result-header-female' : 'result-header-male';
  summaryCard.className = 'summary-card ' + (isFemale ? 'summary-card-female' : 'summary-card-male');
  document.getElementById('sum-score').classList.toggle('female', isFemale);
  headerTitle.textContent = isFemale ? '🌸 女子一覧' : '🔵 男子一覧';
  resultList.innerHTML = '<div class="result-loading">読み込み中だで...</div>';
  apiGet('getResults', { gender: gender })
    .then(rows => renderResults(rows, gender))
    .catch(err => {
      resultList.innerHTML = '<div class="result-loading">読み込みに失敗したわいな: ' + err.message + '</div>';
    });
}
function renderResults(rows, gender) {
  const isFemale = gender === '女';
  let wins = 0, loses = 0, draws = 0;
  let totalScore = 0, totalConcede = 0;
  rows.forEach(r => {
    if (r.result === '勝ち') wins++;
    else if (r.result === '負け') loses++;
    else draws++;
    totalScore += Number(r.score);
    totalConcede += Number(r.concede);
  });
  document.getElementById('sum-win').textContent = wins;
  document.getElementById('sum-lose').textContent = loses;
  document.getElementById('sum-draw').textContent = draws;
  document.getElementById('sum-score').textContent =
    '得点合計 ' + totalScore + ' vs ' + totalConcede + ' 失点合計';
  const list = document.getElementById('result-list');
  if (rows.length === 0) {
    list.innerHTML = '<div class="result-loading">データがないで</div>';
    return;
  }
  list.innerHTML = rows.map(r => {
    const isWin = r.result === '勝ち';
    let badgeClass = 'badge-draw', badgeText = '分';
    if (isWin) { badgeClass = 'badge-win'; badgeText = '勝'; }
    else if (r.result === '負け') { badgeClass = 'badge-lose'; badgeText = '負'; }
    let rowClass = 'result-row ';
    if (isWin) { rowClass += 'result-row-win'; }
    else { rowClass += isFemale ? 'result-row-female' : 'result-row-male'; }
    const photoBtn = r.photoUrl
      ? '<button class="result-photo-btn" onclick="event.stopPropagation();window.open(\'' + escapeHtml(String(r.photoUrl)) + '\',\'_blank\')">📷</button>'
      : '';
    return '<div class="' + rowClass + '" onclick="onResultRowClick(' + Number(r.id) + ')">'
      + '<span class="result-date">' + escapeHtml(String(r.date)) + '</span>'
      + '<span class="result-opponent">' + escapeHtml(String(r.opponent)) + '</span>'
      + '<span class="result-score">' + r.score + 'vs' + r.concede + '</span>'
      + '<span class="result-badge ' + badgeClass + '">' + badgeText + '</span>'
      + photoBtn
      + '</div>';
  }).join('');
}
function escapeHtml(str) {
  return str.replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;');
}
let photoEditTargetId = null;
function onResultRowClick(id) {
  photoEditTargetId = id;
  document.getElementById('photo-edit-modal').classList.add('show');
}
function photoEditNo() {
  document.getElementById('photo-edit-modal').classList.remove('show');
  photoEditTargetId = null;
}
function photoEditYes() {
  document.getElementById('photo-edit-modal').classList.remove('show');
  document.getElementById('photo-edit-file-input').click();
}
function onPhotoEditFileSelected(event) {
  const file = event.target.files[0];
  event.target.value = '';
  const id = photoEditTargetId;
  photoEditTargetId = null;
  if (!file || id === null) return;
  showSavingPopup();
  const reader = new FileReader();
  reader.onload = async function(e) {
    const base64 = e.target.result.split(',')[1];
    const ext = file.type === 'image/png' ? 'png' : 'jpg';
    try {
      await apiPost('replacePhoto', {
        id: id, base64: base64, fileName: 'edit_' + id + '.' + ext, mimeType: file.type
      });
      completeSavingPopup();
      setTimeout(function() {
        document.getElementById('saving-overlay').classList.remove('show');
        if (currentResultsGender) showResults(currentResultsGender);
      }, 600);
    } catch (err) {
      errorSavingPopup(err.message);
    }
  };
  reader.readAsDataURL(file);
}
let recordInited = false;
function initRecord() {
  if (!recordInited) {
    const d = new Date();
    const y = d.getFullYear();
    const m = String(d.getMonth()+1).padStart(2,'0');
    const day = String(d.getDate()).padStart(2,'0');
    document.getElementById('date-input').value = y + '-' + m + '-' + day;
    updateDateLabel();
    loadOpponentList();
    recordInited = true;
  }
}
function loadOpponentList() {
  apiGet('getOpponentList')
    .then(list => {
      const sel = document.getElementById('opponent-select');
      sel.innerHTML = '';
      const topNew = document.createElement('option');
      topNew.value = '__new__'; topNew.textContent = '＋ 新規入力';
      sel.appendChild(topNew);
      const sep1 = document.createElement('option');
      sep1.value = ''; sep1.disabled = true; sep1.textContent = '──────────';
      sel.appendChild(sep1);
      list.forEach(name => {
        const opt = document.createElement('option');
        opt.value = name; opt.textContent = name;
        sel.appendChild(opt);
      });
      if (list.length > 0) {
        const sep2 = document.createElement('option');
        sep2.value = ''; sep2.disabled = true; sep2.textContent = '──────────';
        sel.appendChild(sep2);
      }
      const botNew = document.createElement('option');
      botNew.value = '__new__'; botNew.textContent = '＋ 新規入力';
      sel.appendChild(botNew);
      sel.value = '__new__';
      document.getElementById('new-input-wrap').style.display = 'block';
    })
    .catch(() => {
      document.getElementById('opponent-select').innerHTML = '<option value="__new__">＋ 新規入力</option>';
      document.getElementById('new-input-wrap').style.display = 'block';
    });
}
function updateDateLabel() {
  const val = document.getElementById('date-input').value;
  if (!val) return;
  const d = new Date(val + 'T00:00:00');
  document.getElementById('date-label').textContent =
    (d.getMonth()+1) + '月' + d.getDate() + '日 📅';
}
function onDateChange() { updateDateLabel(); }
function onSelectChange() {
  const val = document.getElementById('opponent-select').value;
  document.getElementById('new-input-wrap').style.display = val === '__new__' ? 'block' : 'none';
  if (val !== '__new__') document.getElementById('new-opponent').value = '';
}
function selectGender(gender) {
  document.querySelector('input[name=gender][value=' + gender + ']').checked = true;
  document.getElementById('label-male').classList.toggle('selected', gender === '男');
  document.getElementById('label-female').classList.toggle('selected', gender === '女');
  applyGenderTheme(gender === '女');
}
function changeDigit(field, pos, delta) {
  const isHundreds = pos === 'h';
  let val = digits[field][pos] + delta;
  if (isHundreds) { if (val < 0) val = 1; if (val > 1) val = 0; }
  else { if (val < 0) val = 9; if (val > 9) val = 0; }
  digits[field][pos] = val;
  updateScoreUI(field);
}
function updateScoreUI(field) {
  const d = digits[field];
  const hEl = document.getElementById(field + '-h');
  const tEl = document.getElementById(field + '-t');
  const uEl = document.getElementById(field + '-u');
  const isFemale = document.querySelector('input[name=gender]:checked').value === '女';
  hEl.textContent = d.h === 0 ? ' ' : String(d.h);
  hEl.className = 'digit-val' + (d.h === 0 ? ' zero' + (isFemale ? ' female' : '') : '');
  tEl.textContent = String(d.t);
  tEl.className = 'digit-val';
  uEl.textContent = String(d.u);
  uEl.className = 'digit-val';
  document.getElementById('sb-' + field).textContent =
    d.h === 0 ? String(d.t * 10 + d.u) : String(d.h * 100 + d.t * 10 + d.u);
}
function getScore(field) {
  const d = digits[field];
  return d.h * 100 + d.t * 10 + d.u;
}
function onPhotoSelected(event) {
  const file = event.target.files[0];
  if (!file) return;
  selectedFile = file;
  const reader = new FileReader();
  reader.onload = function(e) {
    document.getElementById('thumb-img').src = e.target.result;
    document.getElementById('thumb-wrap').style.display = 'flex';
  };
  reader.readAsDataURL(file);
}
function getDateStr() { return document.getElementById('date-input').value.replace(/-/g, ''); }
async function onSave() {
  const gender = document.querySelector('input[name=gender]:checked').value;
  const date = document.getElementById('date-input').value;
  const selVal = document.getElementById('opponent-select').value;
  const newOpponent = document.getElementById('new-opponent').value.trim();
  if (!date) { alert('日付を選んでごしない！'); return; }
  let opponent = '';
  if (selVal === '__new__') {
    if (!newOpponent) { alert('対戦相手を入力してごしない！'); return; }
    opponent = newOpponent;
  } else {
    if (!selVal) { alert('対戦相手を選んでごしない！'); return; }
    opponent = selVal;
  }
  if (!selectedFile) { alert('写真を撮るか選んでごしない！'); return; }
  const score = getScore('score');
  const concede = getScore('concede');
  if (selVal === '__new__') {
    try { await apiPost('addOpponent', { name: opponent }); } catch (e) { /* 追加に失敗しても記録は続行 */ }
  }
  const dateStr = getDateStr();
  const ext = selectedFile.type === 'image/png' ? 'png' : 'jpg';
  let fileName = dateStr + '_' + opponent + '.' + ext;
  let isDuplicate = false;
  try { isDuplicate = await apiGet('checkImageDuplicate', { fileName: fileName }); } catch (e) { /* 判定できない場合はそのまま続行 */ }
  if (isDuplicate) {
    const altName = fileName.replace(/(\.[^.]+)$/, '(1)$1');
    const yes = await showModal('「' + fileName + '」は既に存在するで！\n\n「' + altName + '」として保存しますか？');
    if (yes) { fileName = altName; } else { return; }
  }
  document.getElementById('save-btn').disabled = true;
  showSavingPopup();
  const reader = new FileReader();
  reader.onload = async function(e) {
    const base64 = e.target.result.split(',')[1];
    try {
      await apiPost('uploadImageAndSave', {
        base64: base64, fileName: fileName, mimeType: selectedFile.type,
        gender: gender, date: date, opponent: opponent, score: score, concede: concede
      });
      completeSavingPopup();
      setTimeout(function() {
        document.getElementById('saving-overlay').classList.remove('show');
        const diff = score - concede;
        let res = '引き分け'; let resClass = 'draw';
        if (score > concede) { res = '勝ち'; resClass = 'win'; }
        else if (score < concede) { res = '負け'; resClass = 'lose'; }
        const d = new Date(date + 'T00:00:00');
        document.getElementById('res-gender').textContent = gender;
        document.getElementById('res-date').textContent = (d.getMonth()+1) + '月' + d.getDate() + '日';
        document.getElementById('res-opponent').textContent = opponent;
        document.getElementById('res-score').textContent = score;
        document.getElementById('res-concede').textContent = concede;
        document.getElementById('res-diff').textContent = diff;
        document.getElementById('res-result').textContent = res;
        document.getElementById('res-result').className = 'complete-val ' + resClass;
        document.getElementById('input-screen').style.display = 'none';
        showScreen('complete');
      }, 600);
    } catch (err) {
      errorSavingPopup(err.message);
    }
  };
  reader.readAsDataURL(selectedFile);
}
function resetAll() {
  selectedFile = null;
  document.getElementById('file-camera').value = '';
  document.getElementById('file-gallery').value = '';
  document.getElementById('thumb-wrap').style.display = 'none';
  document.getElementById('thumb-img').src = '';
  document.getElementById('save-btn').disabled = false;
  document.getElementById('new-opponent').value = '';
  document.getElementById('new-input-wrap').style.display = 'block';
  document.getElementById('opponent-select').value = '__new__';
  digits.score = { h:0,t:0,u:0 };
  digits.concede = { h:0,t:0,u:0 };
  updateScoreUI('score');
  updateScoreUI('concede');
  const d = new Date();
  document.getElementById('date-input').value =
    d.getFullYear() + '-' + String(d.getMonth()+1).padStart(2,'0') + '-' + String(d.getDate()).padStart(2,'0');
  updateDateLabel();
  document.querySelector('input[name=gender][value=男]').checked = true;
  document.getElementById('label-male').classList.add('selected');
  document.getElementById('label-female').classList.remove('selected');
  applyGenderTheme(false);
  recordInited = false;
  showScreen('home');
}
function showModal(message) {
  return new Promise(resolve => {
    document.getElementById('modal-body').innerHTML = message.replace(/\n/g,'<br>');
    document.getElementById('modal').classList.add('show');
    modalResolve = resolve;
  });
}
function modalYes() { document.getElementById('modal').classList.remove('show'); if (modalResolve) modalResolve(true); }
function modalNo()  { document.getElementById('modal').classList.remove('show'); if (modalResolve) modalResolve(false); }
let hotTimeLeft = 4500;
let hotTimerInterval = null;
let hotIsRunning = false;
let hotWakeLock = null;
let hotAnimFrame = null;
let hotX = 0, hotY = 0;
const hotSpeed = 9;
let hotVx = Math.cos(70 * Math.PI / 180) * hotSpeed;
let hotVy = Math.sin(70 * Math.PI / 180) * hotSpeed;
async function hotAcquireWakeLock() {
  if ('wakeLock' in navigator) {
    try { hotWakeLock = await navigator.wakeLock.request('screen'); } catch(e) {}
  }
}
function hotReleaseWakeLock() {
  if (hotWakeLock) { hotWakeLock.release(); hotWakeLock = null; }
}
function hotUpdateDisplay() {
  const screen = document.getElementById('hot-screen');
  const timerDisplay = document.getElementById('hot-timer-display');
  const ageText = document.getElementById('hot-age-text');
  const startText = document.getElementById('hot-start-text');
  const warningText = document.getElementById('hot-warning-text');
  const endingText = document.getElementById('hot-ending-text');
  const topMessage = document.getElementById('hot-top-message');
  const seconds = (hotTimeLeft / 100).toFixed(2);
  timerDisplay.style.display = 'none';
  ageText.style.display = 'none';
  startText.style.display = 'none';
  warningText.style.display = 'none';
  endingText.style.display = 'none';
  if (!hotIsRunning) {
    topMessage.textContent = 'モップ担当に声をかけて';
  } else if (hotTimeLeft > 2000) {
    topMessage.textContent = 'ペイントエリアだけモップしてる？';
  } else if (hotTimeLeft > 1000) {
    topMessage.textContent = 'モップが間に合うか確認しよう！';
  } else {
    topMessage.textContent = '';
  }
  if (hotTimeLeft <= 0) {
    screen.className = 'danger';
    endingText.style.display = 'block';
    document.getElementById('hot-start-stop-btn').textContent = 'スタート';
  } else if (hotTimeLeft <= 2499 && hotTimeLeft >= 2400) {
    ageText.style.display = 'block';
    if (hotTimeLeft <= 1000) warningText.style.display = 'block';
  } else if (hotTimeLeft <= 1000) {
    screen.className = 'warning';
    timerDisplay.style.display = 'block';
    timerDisplay.textContent = seconds;
    warningText.style.display = 'block';
  } else {
    screen.className = '';
    timerDisplay.style.display = 'block';
    timerDisplay.textContent = seconds;
  }
  if (!hotIsRunning) startText.style.display = 'block';
}
function hotToggleTimer() {
  if (hotIsRunning) {
    clearInterval(hotTimerInterval);
    document.getElementById('hot-start-stop-btn').textContent = 'スタート';
    hotReleaseWakeLock();
  } else {
    if (hotTimeLeft <= 0) return;
    document.getElementById('hot-start-text').style.display = 'none';
    hotTimerInterval = setInterval(() => { hotTimeLeft -= 1; hotUpdateDisplay(); }, 10);
    document.getElementById('hot-start-stop-btn').textContent = 'ストップ';
    hotAcquireWakeLock();
  }
  hotIsRunning = !hotIsRunning;
}
function hotResetTimer() {
  clearInterval(hotTimerInterval);
  hotIsRunning = false;
  hotTimeLeft = 4500;
  document.getElementById('hot-start-stop-btn').textContent = 'スタート';
  hotReleaseWakeLock();
  hotUpdateDisplay();
}
function hotInitPosition() {
  const el = document.getElementById('hotheart');
  if (!el) return;
  const rect = el.getBoundingClientRect();
  hotX = (window.innerWidth - rect.width) / 2;
  hotY = (window.innerHeight - rect.height) / 2 - (window.innerHeight / 2);
}
function hotAnimateHotheart() {
  if (hotAnimFrame) cancelAnimationFrame(hotAnimFrame);
  const el = document.getElementById('hotheart');
  if (!el) return;
  function step() {
    const rect = el.getBoundingClientRect();
    const w = window.innerWidth;
    const h = window.innerHeight;
    hotX += hotVx;
    hotY += hotVy;
    if (hotX <= -w / 1.5 || hotX + rect.width >= w * 1.2) hotVx *= -1;
    if (hotY <= -h / 2  || hotY + rect.height >= h * 0.7) hotVy *= -1;
    el.style.transform = 'translate(' + hotX + 'px,' + hotY + 'px)';
    hotAnimFrame = requestAnimationFrame(step);
  }
  hotInitPosition();
  step();
}
function leaveHot() {
  clearInterval(hotTimerInterval);
  hotIsRunning = false;
  hotTimeLeft = 4500;
  hotReleaseWakeLock();
  hotStopBgSlideshow();
  if (hotAnimFrame) { cancelAnimationFrame(hotAnimFrame); hotAnimFrame = null; }
  document.getElementById('hot-screen').className = '';
  document.getElementById('hot-start-stop-btn').textContent = 'スタート';
  showScreen('home');
}
let hotImageIds = [];
function loadImageIds() {
  apiGet('imageIds').then(ids => { hotImageIds = ids || []; }).catch(() => {});
}
let hotCurrentImageIndex = 0;
let hotBgInterval = null;
function hotStartBgSlideshow() {
  if (hotImageIds.length === 0) return;
  hotCurrentImageIndex = 0;
  hotSwitchBackground();
  hotBgInterval = setInterval(hotSwitchBackground, 5000);
}
function hotStopBgSlideshow() {
  clearInterval(hotBgInterval);
  hotBgInterval = null;
  const bg = document.getElementById('hot-bg-photo');
  if (bg) { bg.classList.remove('visible'); bg.src = ''; }
}
function hotSwitchBackground() {
  if (hotImageIds.length === 0) return;
  const bg = document.getElementById('hot-bg-photo');
  bg.classList.remove('visible');
  setTimeout(function() {
    const id = hotImageIds[hotCurrentImageIndex];
    bg.src = 'https://drive.google.com/uc?export=view&id=' + id;
    bg.classList.add('visible');
    hotCurrentImageIndex = (hotCurrentImageIndex + 1) % hotImageIds.length;
  }, 1500);
}
window.addEventListener('resize', hotInitPosition);

function openBgCustomScreen() {
  document.getElementById('bg-custom-list').innerHTML = '<div class="bg-custom-loading">読み込み中だで...</div>';
  apiGet('getHomeBgImages').then(function(list) {
    customHomeBgImages = list || [];
    renderBgCustomList();
  }).catch(function(err) {
    document.getElementById('bg-custom-list').innerHTML = '<div class="bg-custom-loading">読み込みに失敗しただ: ' + err.message + '</div>';
  });
}
function renderBgCustomList() {
  const wrap = document.getElementById('bg-custom-list');
  if (!customHomeBgImages.length) {
    wrap.innerHTML = '<div class="bg-custom-loading">まだ、画像がありゃーしません</div>';
    return;
  }
  wrap.innerHTML = customHomeBgImages.map(function(img, i) {
    return '<div class="bg-custom-item">' +
      '<img src="' + img.url + '" alt="">' +
      '<label><input type="checkbox" ' + (img.selected ? 'checked' : '') +
      ' onchange="onBgCustomToggle(' + i + ', this.checked)"> スライドショーに含める</label>' +
      '</div>';
  }).join('');
}
function onBgCustomToggle(index, selected) {
  const img = customHomeBgImages[index];
  if (!img) return;
  img.selected = selected;
  apiPost('toggleHomeBgImage', { url: img.url, selected: selected }).catch(function(err) {
    img.selected = !selected;
    renderBgCustomList();
    alert('更新に失敗しただ: ' + err.message);
  });
}
let bgCustomSelectedFile = null;
function onBgCustomPhotoSelected(event) {
  const file = event.target.files[0];
  if (!file) return;
  bgCustomSelectedFile = file;
  const reader = new FileReader();
  reader.onload = function(e) {
    document.getElementById('bg-custom-thumb-img').src = e.target.result;
    document.getElementById('bg-custom-thumb-wrap').style.display = 'flex';
    document.getElementById('bg-custom-confirm-btn').disabled = false;
  };
  reader.readAsDataURL(file);
}
// 背景写真はアップロード前に長辺1600pxまで縮小・JPEG圧縮する。
// 「フォルダから選択」で選ばれた元画像は数MB〜十数MBになることがあり、
// 無圧縮のままbase64送信するとモバイル回線で送信中に失敗しやすいため。
function resizeImageForUpload_(file, maxDim, quality) {
  return new Promise(function(resolve, reject) {
    const reader = new FileReader();
    reader.onload = function(e) {
      const img = new Image();
      img.onload = function() {
        if (!img.naturalWidth || !img.naturalHeight) {
          reject(new Error('この写真の形式はこの端末では読み込めませんでした(iPhoneの場合、設定→カメラ→フォーマットで「互換性優先」にすると解決することがあります)'));
          return;
        }
        let w = img.width, h = img.height;
        if (w > maxDim || h > maxDim) {
          if (w >= h) { h = Math.round(h * maxDim / w); w = maxDim; }
          else { w = Math.round(w * maxDim / h); h = maxDim; }
        }
        const canvas = document.createElement('canvas');
        canvas.width = w;
        canvas.height = h;
        canvas.getContext('2d').drawImage(img, 0, 0, w, h);
        resolve({ base64: canvas.toDataURL('image/jpeg', quality).split(',')[1], mimeType: 'image/jpeg' });
      };
      img.onerror = function() { reject(new Error('画像を読み込めませんでした')); };
      img.src = e.target.result;
    };
    reader.onerror = function() { reject(new Error('ファイルを読み込めませんでした')); };
    reader.readAsDataURL(file);
  });
}
function onBgCustomConfirm() {
  if (!bgCustomSelectedFile) return;
  document.getElementById('bg-custom-confirm-btn').disabled = true;
  showSavingPopup();
  document.getElementById('saving-message').textContent = '写真を追加中だで...';
  document.getElementById('saving-sub').textContent = 'しばらく待っとってごしない';
  resizeImageForUpload_(bgCustomSelectedFile, 1600, 0.85).then(async function(resized) {
    try {
      const data = await apiPost('addHomeBgImage', {
        base64: resized.base64,
        mimeType: resized.mimeType,
        fileName: 'home_bg_' + Date.now() + '.jpg'
      });
      customHomeBgImages.push({ url: data.url, selected: true });
      renderBgCustomList();
      completeSavingPopup();
      setTimeout(function() {
        document.getElementById('saving-overlay').classList.remove('show');
        resetBgCustomForm();
      }, 400);
    } catch (err) {
      errorSavingPopup(err.message);
      document.getElementById('bg-custom-confirm-btn').disabled = false;
    }
  }).catch(function(err) {
    errorSavingPopup(err.message);
    document.getElementById('bg-custom-confirm-btn').disabled = false;
  });
}
function resetBgCustomForm() {
  bgCustomSelectedFile = null;
  document.getElementById('bg-custom-file-camera').value = '';
  document.getElementById('bg-custom-file-gallery').value = '';
  document.getElementById('bg-custom-thumb-wrap').style.display = 'none';
  document.getElementById('bg-custom-thumb-img').src = '';
  document.getElementById('bg-custom-confirm-btn').disabled = true;
}
function leaveBgCustom() {
  resetBgCustomForm();
  showScreen('home');
}

let logoTapCount = 0;
let logoTapTimer = null;
function onLogoTap() {
  logoTapCount++;
  clearTimeout(logoTapTimer);
  logoTapTimer = setTimeout(function() { logoTapCount = 0; }, 2000);
  if (logoTapCount >= 5) {
    logoTapCount = 0;
    clearTimeout(logoTapTimer);
    showScreen('bg-custom');
  }
}

loadImageIds();
loadHomeBgImages();
showScreen('home');
