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
  resetProgressBar();
}
function hideOverlay() { document.getElementById('overlay').style.display = 'none'; resetProgressBar(); }
function showError(err) { showOverlay('❌', (err && err.message) || String(err), true); }

// ---------- 疑似プログレスバー(製品名OCR読み取り中に使用) ----------
// 5秒かけて95%まで進め、そこで止める。実際の処理が完了した時点でfinishProgressBar()を
// 呼び、即座に100%にしてから閉じる(5秒より早く終わればその時点で100%)。
let progressBarInterval = null;

function resetProgressBar() {
  clearInterval(progressBarInterval);
  progressBarInterval = null;
  document.getElementById('progress-bar-wrap').style.display = 'none';
  document.getElementById('progress-bar-fill').style.width = '0%';
  document.getElementById('progress-bar-pct').textContent = '0%';
}

function startProgressBar() {
  resetProgressBar();
  document.getElementById('progress-bar-wrap').style.display = 'block';
  const fill = document.getElementById('progress-bar-fill');
  const pct = document.getElementById('progress-bar-pct');
  const durationMs = 5000;
  const cap = 95;
  const startTime = new Date().getTime();
  progressBarInterval = setInterval(() => {
    const elapsed = new Date().getTime() - startTime;
    const value = Math.min(cap, Math.round((elapsed / durationMs) * cap));
    fill.style.width = value + '%';
    pct.textContent = value + '%';
    if (elapsed >= durationMs) clearInterval(progressBarInterval);
  }, 100);
}

function finishProgressBar() {
  clearInterval(progressBarInterval);
  document.getElementById('progress-bar-fill').style.width = '100%';
  document.getElementById('progress-bar-pct').textContent = '100%';
}

// ---------- 画面遷移 ----------

let navStack = [];

function showScreen(id) {
  document.querySelectorAll('.screen').forEach(el => { el.style.display = 'none'; });
  // インラインstyleを空にしてCSS側の指定に委ねる(display:blockで固定すると、
  // #home-screenのCSS指定(display:flexによる中央揃え)を永続的に上書きしてしまうため)
  document.getElementById(id).style.display = '';
  if (id === 'home-screen') { startHomeBgSlideshow(); } else { stopHomeBgSlideshow(); }
}

// ---------- ホーム画面 背景スライドショー ----------
// masamiz.com/iron/(製作工程・品質管理体制ページ)に掲載されている鉄構事業部の
// 作業風景写真を、3秒おきにランダムな順(直前と同じ写真は連続させない)でクロスフェード切り替え表示する。
const HOME_BG_IMAGES = [
  'https://www.masamiz.com/image/flow/image01.png',
  'https://www.masamiz.com/image/flow/image02.png',
  'https://www.masamiz.com/image/flow/image04.png',
  'https://www.masamiz.com/image/flow/image05.png',
  'https://www.masamiz.com/image/flow/image06_02.png',
  'https://www.masamiz.com/image/flow/image07.png',
  'https://www.masamiz.com/image/flow/image09.png',
  'https://www.masamiz.com/image/flow/image10.png',
  'https://www.masamiz.com/image/flow/image11.png',
  // quality/image01.jpgは検査員3名の顔がはっきり判別できてしまう(うち社外の方を含む)ため、
  // 元画像をダウンロードして解像度を落としてぼかし処理したものを自社ホスティングして使用する
  'images/home-bg/quality-image01.jpg',
];
const HOME_BG_INTERVAL_MS = 3000;

let homeBgTimer = null;
let homeBgActiveLayer = 'a';
let homeBgLastIndex = -1;

function pickRandomHomeBgIndex() {
  if (HOME_BG_IMAGES.length <= 1) return 0;
  let idx;
  do { idx = Math.floor(Math.random() * HOME_BG_IMAGES.length); } while (idx === homeBgLastIndex);
  homeBgLastIndex = idx;
  return idx;
}

function showNextHomeBgImage() {
  const nextLayer = document.getElementById(homeBgActiveLayer === 'a' ? 'home-bg-b' : 'home-bg-a');
  const currentLayer = document.getElementById(homeBgActiveLayer === 'a' ? 'home-bg-a' : 'home-bg-b');
  if (!nextLayer || !currentLayer) return;
  nextLayer.style.backgroundImage = `url("${HOME_BG_IMAGES[pickRandomHomeBgIndex()]}")`;
  nextLayer.classList.add('active');
  currentLayer.classList.remove('active');
  homeBgActiveLayer = homeBgActiveLayer === 'a' ? 'b' : 'a';
}

function startHomeBgSlideshow() {
  if (homeBgTimer) return;
  showNextHomeBgImage();
  homeBgTimer = setInterval(showNextHomeBgImage, HOME_BG_INTERVAL_MS);
}
function stopHomeBgSlideshow() {
  clearInterval(homeBgTimer);
  homeBgTimer = null;
}
function renderEntry(entry) {
  document.getElementById('app-header').style.display = 'flex';
  document.getElementById('app-header-title').textContent = entry.title;
  // パス記録画面は、誤タップで記録中の内容が見えなくなる事故を防ぐため「← 戻る」を出さない
  // (ホームへは完了後の「🏠 ホームに戻る」ボタンから戻る)
  document.getElementById('header-back-btn').style.visibility = entry.noBack ? 'hidden' : 'visible';
  showScreen(entry.screenId);
  entry.load();
}
function goTo(entry) { navStack.push(entry); renderEntry(entry); }
// 「← 戻る」は常にホームへ戻る(画面ごとの再描画ロジックを経由するとレイアウトが崩れるため、
// 一段階ずつ戻る挙動はやめてgoHome()と同じ動作に統一する)
function goBack() { goHome(); }
function goHome() {
  navStack = [];
  document.getElementById('app-header').style.display = 'none';
  showScreen('home-screen');
  checkDraftButton();
}

// ---------- マスタ選択肢(検査員・工事名・部材・材質・溶接方法・溶接者) ----------
// 検査員は他5項目のゲート役(検査員を確定するまで他5項目は無効化)であり、他5項目の候補
// リスト+デフォルトは検査員ごとの専用シートから読み込む(loadInspectorDefaults/resolveInspector参照)。

const MASTER_FIELDS = [
  { key: '検査員（入力者）', masterKey: '検査員', selectId: 'jn-検査員', newId: 'jn-検査員-new' },
  { key: '工事名', masterKey: '工事名', selectId: 'jn-工事名', newId: 'jn-工事名-new' },
  { key: '部材', masterKey: '部材', selectId: 'jn-部材', newId: 'jn-部材-new' },
  { key: '材質', masterKey: '材質', selectId: 'jn-材質', newId: 'jn-材質-new' },
  { key: '溶接方法', masterKey: '溶接方法', selectId: 'jn-溶接方法', newId: 'jn-溶接方法-new' },
  { key: '溶接者', masterKey: '溶接者', selectId: 'jn-溶接者', newId: 'jn-溶接者-new' },
];
const INSPECTOR_GATED_FIELDS = MASTER_FIELDS.filter(f => f.masterKey !== '検査員');

function masterFieldByKey_(masterKey) { return MASTER_FIELDS.find(f => f.masterKey === masterKey); }

let masterLists = {}; // 検査員確定後、その検査員の工事名・部材・材質・溶接方法・溶接者リスト
let inspectorRoster = []; // 「情報」シートの検査員名簿(検査員選択プルダウンの選択肢)
let currentInspectorName = ''; // 継手記録画面で確定済みの検査員名(未確定なら'')

async function loadInspectorRoster() {
  try {
    const data = await apiGet('listMasterLists');
    inspectorRoster = data['検査員'] || [];
  } catch (err) {
    inspectorRoster = [];
  }
  populateInspectorSelect();
}

function populateInspectorSelect() {
  const select = document.getElementById('jn-検査員');
  select.innerHTML = '<option value="">(選択してください)</option>' +
    inspectorRoster.map(v => `<option value="${escapeHtml(v)}">${escapeHtml(v)}</option>`).join('') +
    '<option value="__new__">＋ 新規入力</option>';
}

// 検査員確定後、その検査員の専用シートから読み込んだ候補リストで他5項目を有効化する
function applyInspectorMasterLists(lists) {
  INSPECTOR_GATED_FIELDS.forEach(f => {
    masterLists[f.masterKey] = lists[f.masterKey] || [];
    populateMasterSelect(f);
    const select = document.getElementById(f.selectId);
    select.disabled = false;
    select.value = masterLists[f.masterKey].length ? masterLists[f.masterKey][0] : ''; // シートの2行目=デフォルト
    document.getElementById(f.newId).style.display = 'none';
    document.getElementById(f.newId).value = '';
  });
  updateRequiredState();
}

// 検査員が未確定/変更された時、他5項目を無効化してリセットする
function disableInspectorGatedFields() {
  INSPECTOR_GATED_FIELDS.forEach(f => {
    masterLists[f.masterKey] = [];
    document.getElementById(f.selectId).innerHTML = '<option value="">(検査員を選んでください)</option>';
    document.getElementById(f.selectId).disabled = true;
    document.getElementById(f.newId).style.display = 'none';
    document.getElementById(f.newId).value = '';
  });
  currentInspectorName = '';
  updateRequiredState();
}

// 検査員名を確定し(既存選択/新規入力どちらも)、その検査員の専用シートを解決してから他5項目を読み込む
function loadInspectorDefaults(name, isNewEntry) {
  showOverlay('⏳', '検査員のデフォルトを読み込んでいます...');
  apiPost('resolveInspector', { name: name }).then(result => {
    hideOverlay();
    currentInspectorName = name;
    if (isNewEntry) {
      if (inspectorRoster.indexOf(name) === -1) inspectorRoster.push(name);
      populateInspectorSelect();
      document.getElementById('jn-検査員').value = name;
      document.getElementById('jn-検査員-new').style.display = 'none';
      document.getElementById('jn-検査員-new').value = '';
      document.getElementById('jn-検査員-confirm-btn').style.display = 'none';
    }
    applyInspectorMasterLists(result.lists);
  }).catch(err => { hideOverlay(); showError(err); disableInspectorGatedFields(); });
}

function onInspectorSelectChange() {
  const value = document.getElementById('jn-検査員').value;
  const confirmBtn = document.getElementById('jn-検査員-confirm-btn');
  const newInput = document.getElementById('jn-検査員-new');
  if (value === '__new__') {
    newInput.style.display = 'block';
    newInput.value = '';
    confirmBtn.style.display = 'inline-block';
    disableInspectorGatedFields();
  } else {
    newInput.style.display = 'none';
    confirmBtn.style.display = 'none';
    if (value) { loadInspectorDefaults(value, false); } else { disableInspectorGatedFields(); }
  }
}

function confirmRecordInspector() {
  const name = document.getElementById('jn-検査員-new').value.trim();
  if (!name) { showOverlay('⚠️', '検査員名を入力してください', true); return; }
  loadInspectorDefaults(name, true);
}

function setupInspectorGating() {
  document.getElementById('jn-検査員').addEventListener('change', onInspectorSelectChange);
}

// ---------- 必須項目バリデーション(継手情報入力画面) ----------
// 必須: 工事名・部材・製品名・サイズ(幅)・板厚・材質・溶接方法・溶接長・気温・計測・
//       ルートギャップ・開先角度・溶接者・検査員(入力者)。すべて埋まるまでアラート表示+送信ボタン非活性。
const REQUIRED_PLAIN_FIELDS = ['jn-製品名', 'jn-幅', 'jn-板厚', 'jn-溶接長', 'jn-気温', 'jn-計測'];

function isRequiredFormValid() {
  const plainOk = REQUIRED_PLAIN_FIELDS.every(id => document.getElementById(id).value.toString().trim() !== '');
  const masterOk = MASTER_FIELDS.every(f => getMasterFieldValue(f).trim() !== '');
  return plainOk && masterOk;
}

function updateRequiredState() {
  const valid = isRequiredFormValid();
  document.getElementById('required-alert').style.display = valid ? 'none' : 'block';
  document.getElementById('jn-submit-btn').disabled = !valid;
}

function setupRequiredValidation() {
  REQUIRED_PLAIN_FIELDS.forEach(id => {
    document.getElementById(id).addEventListener('input', updateRequiredState);
  });
  MASTER_FIELDS.forEach(f => {
    document.getElementById(f.selectId).addEventListener('change', updateRequiredState);
    document.getElementById(f.newId).addEventListener('input', updateRequiredState);
  });
}

// ---------- ルートギャップ・開先角度(0.5単位の+/-ステッパー、デフォルト値あり) ----------
const STEPPER_FIELDS = {
  'jn-ルートギャップ': { default: 7, step: 0.5, min: 0 },
  'jn-開先角度': { default: 35, step: 0.5, min: 0 },
};
let stepperValues = {};

function formatStepperValue(v) { return (Math.round(v * 10) / 10).toString(); }

function resetSteppers() {
  Object.keys(STEPPER_FIELDS).forEach(id => {
    stepperValues[id] = STEPPER_FIELDS[id].default;
    document.getElementById(id).textContent = formatStepperValue(stepperValues[id]);
  });
}

function changeStepper(id, delta) {
  const cfg = STEPPER_FIELDS[id];
  let v = Math.round(((stepperValues[id] || 0) + delta) * 10) / 10;
  if (cfg.min != null) v = Math.max(cfg.min, v);
  stepperValues[id] = v;
  document.getElementById(id).textContent = formatStepperValue(v);
}

function getStepperValue(id) { return stepperValues[id]; }

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

// 検査員自身の新規登録はresolveInspector経由で既に完了しているため、ここでは他5項目のみを扱う。
// 追加先は選択中の検査員の専用シート(currentInspectorName)。
async function persistNewMasterValues() {
  const calls = INSPECTOR_GATED_FIELDS.filter(f => document.getElementById(f.selectId).value === '__new__')
    .map(f => {
      const v = document.getElementById(f.newId).value.trim();
      return v ? apiPost('addMasterValue', { column: f.masterKey, value: v, sheetName: currentInspectorName }).catch(() => {}) : Promise.resolve();
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
  goTo({ screenId: 'joint-record-screen', title: 'パス記録(再開)', load: () => renderRecordScreen(), noBack: true });
}

// ---------- アプリ状態 ----------

const state = { header: null, passes: [], nextLayer: 1, savedIds: null };
let timerState = 'idle'; // idle | running | stopped
let timerStart = null, timerEnd = null, timerInterval = null;
let pendingImageUrl = '';
let recordCompleted = false; // 溶接完了・スプレッドシート保存済みか(完了後の編集で再保存ボタンを出すため)

document.addEventListener('DOMContentLoaded', () => {
  loadInspectorRoster();
  checkDraftButton();
  setupRequiredValidation();
  setupInspectorGating();
  document.getElementById('master-manage-body').addEventListener('click', onMasterManageClick);
});

// ---------- 溶接モード選択(アプリ起動時) ----------

function selectWeldMode(mode) {
  if (mode === 'robot') {
    navStack = [];
    document.getElementById('app-header').style.display = 'none';
    showScreen('robot-home-screen');
  } else {
    goHome();
  }
}

// ---------- 新規継手ヘッダー入力 ----------

function goJointNew() {
  const draft = loadDraftRaw();
  if (draft && draft.passes && draft.passes.length) {
    if (!confirm('前回入力途中の記録が残っています。破棄して新しい継手の記録を始めますか?')) return;
    clearDraft();
  }
  goTo({ screenId: 'joint-new-screen', title: '記録', load: initJointNewForm });
}

// 「製品名」以外(サイズ・板厚・部材サイズ・溶接長・気温・計測・入熱上限・パス間温度下限/上限)は、
// スプレッドシートの最終行(前回の継手)の値をデフォルト表示する。製品名はOCRで都度読み取る
// 製品固有のタグ情報なので前回値を引き継がない。
const LAST_ROW_DEFAULT_FIELDS = [
  { id: 'jn-幅', key: 'サイズ(幅)' },
  { id: 'jn-板厚', key: '板厚' },
  { id: 'jn-部材サイズ', key: '部材サイズ' },
  { id: 'jn-溶接長', key: '溶接長' },
  { id: 'jn-気温', key: '気温' },
  { id: 'jn-計測', key: '計測' },
  { id: 'jn-入熱上限', key: '入熱上限(kJ/cm)' },
  { id: 'jn-温度下限', key: 'パス間温度下限(℃)' },
  { id: 'jn-温度上限', key: 'パス間温度上限(℃)' },
];
const LAST_ROW_DEFAULT_STEPPERS = [
  { id: 'jn-ルートギャップ', key: 'ルートギャップ' },
  { id: 'jn-開先角度', key: '開先角度' },
];

// 1パス目(自分の継手にまだパス履歴がない時点)の電流・電圧・パス間温度のデフォルト表示に使う、
// スプレッドシート最終行(前回の継手の最後のパス)の値。initJointNewFormで取得し、
// submitNewJointでheaderに積んでrenderRecordScreen側から参照する。
let lastRowPassDefaults = null;

async function initJointNewForm() {
  document.getElementById('jn-検査日').value = new Date().toISOString().slice(0, 10);
  disableInspectorGatedFields();
  document.getElementById('jn-検査員-new').style.display = 'none';
  document.getElementById('jn-検査員-new').value = '';
  document.getElementById('jn-検査員-confirm-btn').style.display = 'none';
  const defaultInspector = inspectorRoster.length ? inspectorRoster[0] : ''; // 名簿の2行目=デフォルト検査員
  document.getElementById('jn-検査員').value = defaultInspector;
  if (defaultInspector) loadInspectorDefaults(defaultInspector, false);
  document.getElementById('jn-製品名').value = '';
  LAST_ROW_DEFAULT_FIELDS.forEach(f => { document.getElementById(f.id).value = ''; });
  resetSteppers();
  pendingImageUrl = '';
  recordCompleted = false;
  state.savedIds = null;
  document.getElementById('jn-photo-status').textContent = '';
  updateRequiredState();

  let lastHeader = null;
  lastRowPassDefaults = null;
  try { lastHeader = await apiGet('getLastJointHeader'); } catch (e) { lastHeader = null; }
  if (lastHeader) {
    LAST_ROW_DEFAULT_FIELDS.forEach(f => {
      const v = lastHeader[f.key];
      if (v !== undefined && v !== null && v !== '') document.getElementById(f.id).value = v;
    });
    LAST_ROW_DEFAULT_STEPPERS.forEach(f => {
      const v = lastHeader[f.key];
      if (v !== undefined && v !== null && v !== '') {
        stepperValues[f.id] = Number(v);
        document.getElementById(f.id).textContent = formatStepperValue(stepperValues[f.id]);
      }
    });
    lastRowPassDefaults = { current: lastHeader["電流"], voltage: lastHeader["電圧"], passTemp: lastHeader["パス間温度"] };
    updateRequiredState();
  }
}

function onPhotoSelected(event, kind) {
  const file = event.target.files[0];
  if (!file) return;
  const reader = new FileReader();
  reader.onload = () => {
    const base64 = reader.result.split(',')[1];
    const label = kind === 'productName' ? '製品名タグ' : '積層図';
    showOverlay('⏳', label + 'をアップロード中...' + (kind === 'productName' ? '(自動読み取り中)' : ''));
    if (kind === 'productName') startProgressBar();
    apiPost('uploadPhoto', {
      kind: kind,
      base64: base64,
      mimeType: file.type,
      fileName: (kind === 'productName' ? 'product_' : 'layer_') + Date.now() + '.jpg',
    }).then(result => {
      if (kind === 'productName') {
        pendingImageUrl = result.url;
        finishProgressBar();
        setTimeout(() => {
          hideOverlay();
          if (result.recognizedText) {
            document.getElementById('jn-製品名').value = result.recognizedText;
            updateRequiredState();
          } else {
            showOverlay('⚠️', '製品名の自動読み取りに失敗しました。手入力してください', true);
          }
          document.getElementById('jn-photo-status').textContent = pendingImageUrl ? '✅ 製品名タグ写真 添付済み' : '';
        }, 300);
      } else {
        state.header["積層図"] = result.url;
        saveDraft();
        hideOverlay();
        document.getElementById('rec-photo-status').textContent = '✅ 積層図 添付済み';
      }
    }).catch(showError);
  };
  reader.readAsDataURL(file);
}

function submitNewJoint() {
  const productName = document.getElementById('jn-製品名').value.trim();
  const weldLength = document.getElementById('jn-溶接長').value;
  const width = document.getElementById('jn-幅').value;
  const thickness = document.getElementById('jn-板厚').value;
  const airTemp = document.getElementById('jn-気温').value;
  const measure = document.getElementById('jn-計測').value.trim();
  const construction = getMasterFieldValue(masterFieldByKey_('工事名'));
  const member = getMasterFieldValue(masterFieldByKey_('部材'));
  const material = getMasterFieldValue(masterFieldByKey_('材質'));
  const weldMethod = getMasterFieldValue(masterFieldByKey_('溶接方法'));
  const welder = getMasterFieldValue(masterFieldByKey_('溶接者'));
  const inspector = getMasterFieldValue(masterFieldByKey_('検査員'));

  // 記録開始ボタンは必須項目が揃うまで非活性だが、念のため送信時にも同じ催促ポップアップで再チェックする
  if (!construction) { showOverlay('⚠️', '工事名を入力してください', true); return; }
  if (!member) { showOverlay('⚠️', '部材を入力してください', true); return; }
  if (!productName) { showOverlay('⚠️', '製品名を入力してください', true); return; }
  if (width === '') { showOverlay('⚠️', 'サイズ(幅)を入力してください', true); return; }
  if (thickness === '') { showOverlay('⚠️', '板厚を入力してください', true); return; }
  if (!material) { showOverlay('⚠️', '材質を入力してください', true); return; }
  if (!weldMethod) { showOverlay('⚠️', '溶接方法を入力してください', true); return; }
  if (!weldLength) { showOverlay('⚠️', '溶接長を入力してください(入熱の自動計算に必要です)', true); return; }
  if (airTemp === '') { showOverlay('⚠️', '気温を入力してください', true); return; }
  if (!measure) { showOverlay('⚠️', '計測を入力してください', true); return; }
  if (!welder) { showOverlay('⚠️', '溶接者を入力してください', true); return; }
  if (!inspector) { showOverlay('⚠️', '検査員を入力してください', true); return; }

  const header = {
    "工事名": construction,
    "検査日": document.getElementById('jn-検査日').value,
    "部材": member,
    "サイズ(幅)": width,
    "板厚": thickness,
    "部材サイズ": document.getElementById('jn-部材サイズ').value.trim(),
    "溶接者": welder,
    "検査員（入力者）": inspector,
    "溶接長": weldLength,
    "計測": measure,
    "製品名": productName,
    "材質": material,
    "溶接方法": weldMethod,
    "気温": airTemp,
    "ルートギャップ": getStepperValue('jn-ルートギャップ'),
    "開先角度": getStepperValue('jn-開先角度'),
    "image": pendingImageUrl,
    "積層図": '', // パス記録画面の完了ボタン付近で撮影してから設定する
    heatInputLimit: document.getElementById('jn-入熱上限').value,
    tempMin: document.getElementById('jn-温度下限').value,
    tempMax: document.getElementById('jn-温度上限').value,
    // 1パス目(自分の継手にまだパス履歴がない時点)の電流・電圧・パス間温度のデフォルト表示用
    lastCurrent: lastRowPassDefaults ? lastRowPassDefaults.current : '',
    lastVoltage: lastRowPassDefaults ? lastRowPassDefaults.voltage : '',
    lastPassTemp: lastRowPassDefaults ? lastRowPassDefaults.passTemp : '',
  };

  persistNewMasterValues();
  state.header = header;
  state.passes = [];
  state.nextLayer = 1;
  saveDraft();
  goTo({ screenId: 'joint-record-screen', title: 'パス記録', load: () => renderRecordScreen(), noBack: true });
}

// ---------- パス記録画面 ----------

// 履歴詳細画面の編集(computeMetricsForにheaderを直接渡す)でも使う共通ロジック
function computeMetricsFor(h, current, voltage, arcSeconds, passTemp) {
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

function computeMetrics(current, voltage, arcSeconds, passTemp) {
  return computeMetricsFor(state.header, current, voltage, arcSeconds, passTemp);
}

function renderRecordScreen() {
  const h = state.header;
  document.getElementById('joint-summary').innerHTML = `
    <div>溶接者: ${escapeHtml(h["溶接者"] || '-')}　検査員: ${escapeHtml(h["検査員（入力者）"] || '-')}</div>
  `;
  document.getElementById('layer-value').textContent = state.nextLayer;
  document.getElementById('rec-photo-status').textContent = h["積層図"] ? '✅ 積層図 添付済み' : '';
  resetTimerUi();
  renderPassTable();
  prefillPassInputsFromLastPass();
}

// 層数は「前回記録した層と同じ」か「その1つ上」までしか進められない(飛び番禁止)
function maxRecordedLayer() {
  if (!state.passes.length) return 0;
  return Math.max(...state.passes.map(p => Number(p.layer) || 0));
}

function changeLayer(delta) {
  const cap = maxRecordedLayer() + 1;
  state.nextLayer = Math.max(1, Math.min(cap, state.nextLayer + delta));
  document.getElementById('layer-value').textContent = state.nextLayer;
}

// 2パス目以降は、直前に記録したパスの値をデフォルトとして表示する(電流・電圧・パス間温度はほぼ同じ値が続くため)。
// 1パス目(自分の継手にまだパス履歴がない時点)は、電流・電圧・パス間温度をスプレッドシート最終行
// (前回の継手の最後のパス)の値をデフォルト表示する。
function prefillPassInputsFromLastPass() {
  const last = state.passes[state.passes.length - 1];
  if (last) {
    document.getElementById('pi-current').value = last.current;
    document.getElementById('pi-voltage').value = last.voltage;
    document.getElementById('pi-temp').value = last.passTemp;
    document.getElementById('pi-note').value = last.note || '';
    return;
  }
  const h = state.header;
  const lastCurrent = h && h.lastCurrent;
  const lastVoltage = h && h.lastVoltage;
  const lastPassTemp = h && h.lastPassTemp;
  document.getElementById('pi-current').value = (lastCurrent !== undefined && lastCurrent !== null && lastCurrent !== '') ? lastCurrent : '';
  document.getElementById('pi-voltage').value = (lastVoltage !== undefined && lastVoltage !== null && lastVoltage !== '') ? lastVoltage : '';
  document.getElementById('pi-temp').value = (lastPassTemp !== undefined && lastPassTemp !== null && lastPassTemp !== '') ? lastPassTemp : '';
  document.getElementById('pi-note').value = '';
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

  // 層を進める「＋」の押し忘れで前回と同じ層のまま記録してしまう事故を防ぐための確認
  const lastPass = state.passes[state.passes.length - 1];
  if (lastPass && lastPass.layer === state.nextLayer) {
    if (!confirm(`同じ層数(${state.nextLayer})で良いですか?`)) return;
  }

  const arcSeconds = Math.max(0, Math.round((timerEnd - timerStart) / 1000));
  const metrics = computeMetrics(current, voltage, arcSeconds, passTemp);

  state.passes.push({
    layer: state.nextLayer, current: Number(current), voltage: Number(voltage),
    start: timerStart.toISOString(), end: timerEnd.toISOString(), arcSeconds: arcSeconds,
    passTemp: Number(passTemp), note: note, heatInput: metrics.heatInput, judgement: metrics.judgement,
  });
  saveDraft();
  renderPassTable();

  prefillPassInputsFromLastPass();
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

// 記録済みパスの値(#以外)を編集した際に呼ばれる。入熱・判定は編集不可の自動計算値なので、
// ここで再計算してテーブルに反映する(手入力の判定上書きは許可しない)
function updatePassField(index, field, rawValue) {
  const p = state.passes[index];
  if (field === 'layer') p.layer = Math.max(1, Number(rawValue) || p.layer);
  else if (field === 'current') p.current = Number(rawValue) || 0;
  else if (field === 'voltage') p.voltage = Number(rawValue) || 0;
  else if (field === 'arcSeconds') {
    const arcSeconds = Math.max(0, Number(rawValue) || 0);
    p.arcSeconds = arcSeconds;
    // start/endもアークタイムに合わせて補正する(GAS側はstart/endから再計算するため)
    if (p.start) p.end = new Date(new Date(p.start).getTime() + arcSeconds * 1000).toISOString();
  } else if (field === 'passTemp') p.passTemp = Number(rawValue);

  const metrics = computeMetrics(p.current, p.voltage, p.arcSeconds, p.passTemp);
  p.heatInput = metrics.heatInput;
  p.judgement = metrics.judgement;
  if (recordCompleted) {
    document.getElementById('resave-wrap').style.display = 'block';
  } else {
    saveDraft();
  }
  renderPassTable();
}

function submitJointUpdate() {
  showOverlay('⏳', '修正内容をスプレッドシートへ再保存しています...');
  apiPost('updateJointRecord', { header: state.header, ids: state.savedIds, passes: state.passes }).then(() => {
    hideOverlay();
    document.getElementById('resave-wrap').style.display = 'none';
  }).catch(showError);
}

function renderPassTable() {
  const tbody = document.getElementById('pass-table-body');
  if (!state.passes.length) { tbody.innerHTML = '<tr><td colspan="9" class="loading-text">まだパスが記録されていません</td></tr>'; return; }
  tbody.innerHTML = state.passes.map((p, i) => `
    <tr class="${p.judgement === 'NG' ? 'ng-row' : ''}">
      <td>${i + 1}</td>
      <td><input type="number" class="cell-input" value="${p.layer}" onchange="updatePassField(${i},'layer',this.value)"></td>
      <td><input type="number" class="cell-input" value="${p.current}" onchange="updatePassField(${i},'current',this.value)"></td>
      <td><input type="number" class="cell-input" value="${p.voltage}" onchange="updatePassField(${i},'voltage',this.value)"></td>
      <td><input type="number" class="cell-input" value="${p.arcSeconds}" onchange="updatePassField(${i},'arcSeconds',this.value)"></td>
      <td>${p.heatInput === '' ? '-' : p.heatInput}</td>
      <td><input type="number" class="cell-input" value="${p.passTemp}" onchange="updatePassField(${i},'passTemp',this.value)"></td>
      <td class="${p.judgement === 'NG' ? 'judge-ng' : 'judge-ok'}">${p.judgement}</td>
      <td>${recordCompleted ? '' : `<button class="pass-del-btn" onclick="deletePass(${i})">削除</button>`}</td>
    </tr>`).join('');
}

function onCompleteJoint() {
  if (!state.passes.length) { showOverlay('⚠️', 'パスが1件も記録されていません', true); return; }
  if (!confirm('この継手の溶接記録を確定し、スプレッドシートへ記録します。よろしいですか？')) return;
  showOverlay('⏳', 'スプレッドシートへ記録しています...');
  apiPost('saveJointRecord', { header: state.header, passes: state.passes }).then(result => {
    clearDraft();
    hideOverlay();
    state.savedIds = result.ids;
    recordCompleted = true;
    document.getElementById('pass-input-section').style.display = 'none';
    document.getElementById('pdf-section').style.display = 'block';
    document.getElementById('pdf-link-wrap').style.display = 'none';
    document.getElementById('resave-wrap').style.display = 'none';
    renderPassTable();
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
    <div>溶接者: ${escapeHtml(h["溶接者"] || '-')}　検査員: ${escapeHtml(h["検査員（入力者）"] || '-')}　検査日: ${escapeHtml(h["検査日"])}</div>
  `;
  state.viewingJoint = joint;
  state.viewingPasses = joint.records.map(r => ({
    id: r.ID, layer: r.層数, current: r.電流, voltage: r.電圧, arcSeconds: r.アークタイム,
    passTemp: r.パス間温度, note: r.備考, heatInput: r.heatInput, judgement: r.判定,
  }));
  renderViewPassTable();
  refreshViewResultBanner();
  document.getElementById('view-resave-wrap').style.display = 'none';
  document.getElementById('view-layer-photo-status').textContent = h["積層図"] ? '✅ 積層図 添付済み' : '';
  document.getElementById('view-pdf-link-wrap').style.display = 'none';
}

function renderViewPassTable() {
  const tbody = document.getElementById('view-pass-table-body');
  const passes = state.viewingPasses;
  if (!passes.length) { tbody.innerHTML = '<tr><td colspan="8" class="loading-text">パスが記録されていません</td></tr>'; return; }
  tbody.innerHTML = passes.map((p, i) => `
    <tr class="${p.judgement === 'NG' ? 'ng-row' : ''}">
      <td>${i + 1}</td>
      <td><input type="number" class="cell-input" value="${p.layer}" onchange="updateViewPassField(${i},'layer',this.value)"></td>
      <td><input type="number" class="cell-input" value="${p.current}" onchange="updateViewPassField(${i},'current',this.value)"></td>
      <td><input type="number" class="cell-input" value="${p.voltage}" onchange="updateViewPassField(${i},'voltage',this.value)"></td>
      <td><input type="number" class="cell-input" value="${p.arcSeconds}" onchange="updateViewPassField(${i},'arcSeconds',this.value)"></td>
      <td>${p.heatInput === '' ? '-' : p.heatInput}</td>
      <td><input type="number" class="cell-input" value="${p.passTemp}" onchange="updateViewPassField(${i},'passTemp',this.value)"></td>
      <td class="${p.judgement === 'NG' ? 'judge-ng' : 'judge-ok'}">${p.judgement}</td>
    </tr>`).join('');
}

// 履歴詳細画面での編集(層・電流・電圧・アークタイム・パス間温度)。入熱・判定は編集不可の
// 自動計算値なので、ここで再計算してテーブルに反映する
function updateViewPassField(index, field, rawValue) {
  const p = state.viewingPasses[index];
  if (field === 'layer') p.layer = Math.max(1, Number(rawValue) || p.layer);
  else if (field === 'current') p.current = Number(rawValue) || 0;
  else if (field === 'voltage') p.voltage = Number(rawValue) || 0;
  else if (field === 'arcSeconds') p.arcSeconds = Math.max(0, Number(rawValue) || 0);
  else if (field === 'passTemp') p.passTemp = Number(rawValue);

  const metrics = computeMetricsFor(state.viewingJoint.header, p.current, p.voltage, p.arcSeconds, p.passTemp);
  p.heatInput = metrics.heatInput;
  p.judgement = metrics.judgement;
  document.getElementById('view-resave-wrap').style.display = 'block';
  renderViewPassTable();
}

function refreshViewResultBanner() {
  const banner = document.getElementById('view-result-banner');
  const isNg = state.viewingPasses.some(p => p.judgement === 'NG');
  banner.textContent = '総合判定: ' + (isNg ? '❌ NG(要是正)' : '✅ OK');
  banner.className = 'result-banner ' + (isNg ? 'ng' : 'ok');
}

function submitViewJointUpdate() {
  const joint = state.viewingJoint;
  const ids = state.viewingPasses.map(p => p.id);
  showOverlay('⏳', '修正内容をスプレッドシートへ再保存しています...');
  apiPost('updateJointRecord', { header: joint.header, ids: ids, passes: state.viewingPasses }).then(() => {
    hideOverlay();
    document.getElementById('view-resave-wrap').style.display = 'none';
    refreshViewResultBanner();
  }).catch(showError);
}

// 履歴詳細画面から、保存済みの継手に積層図を後付けで追加・差し替えする
// (作図・撮影が完了操作より後になった場合を想定)
function onViewLayerPhotoSelected(event) {
  const file = event.target.files[0];
  if (!file) return;
  const reader = new FileReader();
  reader.onload = () => {
    const base64 = reader.result.split(',')[1];
    showOverlay('⏳', '積層図をアップロード中...');
    apiPost('uploadPhoto', {
      kind: 'layerDiagram', base64: base64, mimeType: file.type, fileName: 'layer_' + Date.now() + '.jpg',
    }).then(result => {
      const ids = state.viewingPasses.map(p => p.id);
      return apiPost('updateJointLayerDiagram', { ids: ids, url: result.url }).then(() => {
        state.viewingJoint.header["積層図"] = result.url;
        hideOverlay();
        document.getElementById('view-layer-photo-status').textContent = '✅ 積層図 添付済み';
      });
    }).catch(showError);
  };
  reader.readAsDataURL(file);
}

function onGeneratePdfFromView() {
  const joint = state.viewingJoint;
  showOverlay('⏳', 'PDFを作成しています...(数秒かかります)');
  const payload = {
    header: joint.header,
    passes: state.viewingPasses.map(p => ({ layer: p.layer, current: p.current, voltage: p.voltage, arcSeconds: p.arcSeconds, passTemp: p.passTemp, note: p.note })),
  };
  apiPost('generatePdf', payload).then(result => {
    hideOverlay();
    downloadPdfBase64_(result.pdfBase64, result.fileName);
    document.getElementById('view-pdf-link-wrap').style.display = 'block';
  }).catch(showError);
}

// ---------- 【検査員別】初期値設定(検査員ごとの専用シートの追加・削除・デフォルト設定) ----------
// 画面を開くとまず検査員を選択(既存選択/新規入力)し、以後はその検査員の専用シートに対して
// 工事名・部材・材質・溶接方法・溶接者を編集する。各列の1件目(シートの2行目)が「デフォルト」
// として扱われ、継手記録画面でその検査員を選んだ時に自動選択される。
// 5項目はアコーディオン形式(見出しは常に全部表示、クリックした項目だけ中身を展開。1度に1項目のみ開く)。

let openMasterKey = null;
let settingsInspectorName = null;

function goMasterManage() {
  navStack = [];
  openMasterKey = null;
  settingsInspectorName = null;
  goTo({ screenId: 'master-manage-screen', title: '【検査員別】初期値設定', load: renderMasterManage });
}

async function renderMasterManage() {
  const body = document.getElementById('master-manage-body');
  if (!settingsInspectorName) {
    renderInspectorPicker();
    return;
  }
  body.innerHTML = '<div class="loading-text">読み込み中...</div>';
  try {
    const result = await apiPost('resolveInspector', { name: settingsInspectorName });
    masterLists = result.lists;
  } catch (err) {
    masterLists = {};
  }
  renderMasterBody();
}

function renderInspectorPicker() {
  const options = inspectorRoster.map(v => `<option value="${escapeHtml(v)}">${escapeHtml(v)}</option>`).join('');
  document.getElementById('master-manage-body').innerHTML = `
    <div class="section">
      <div class="field-label small">検査員を選択してください(未登録の場合は新規入力できます)</div>
      <select id="ms-inspector-select">
        <option value="">(選択してください)</option>
        ${options}
        <option value="__new__">＋ 新規入力</option>
      </select>
      <input type="text" id="ms-inspector-new" class="new-input" style="display:none;" placeholder="新しい検査員名を入力">
      <button class="small-btn" id="ms-inspector-confirm-btn" style="display:none;margin-top:8px;" onclick="confirmSettingsInspector()">この検査員で開く</button>
    </div>`;
  document.getElementById('ms-inspector-select').onchange = (e) => {
    const v = e.target.value;
    document.getElementById('ms-inspector-new').style.display = v === '__new__' ? 'block' : 'none';
    document.getElementById('ms-inspector-confirm-btn').style.display = v === '__new__' ? 'block' : 'none';
    if (v && v !== '__new__') { settingsInspectorName = v; renderMasterManage(); }
  };
}

function confirmSettingsInspector() {
  const name = document.getElementById('ms-inspector-new').value.trim();
  if (!name) { showOverlay('⚠️', '検査員名を入力してください', true); return; }
  settingsInspectorName = name;
  renderMasterManage();
}

function renderMasterBody() {
  const header = `
    <div class="section" style="padding-bottom:0;">
      <div class="field-label small">検査員: <b>${escapeHtml(settingsInspectorName)}</b>
        <button class="small-btn" data-action="switch-inspector" style="margin-left:8px;">検査員を変更</button>
      </div>
    </div>`;
  document.getElementById('master-manage-body').innerHTML = header + INSPECTOR_GATED_FIELDS.map(f => renderMasterSectionHtml(f)).join('');
}

function renderMasterSectionHtml(f) {
  const isOpen = openMasterKey === f.masterKey;
  const list = masterLists[f.masterKey] || [];
  const rows = list.length ? list.map((v, i) => `
    <div class="master-item">
      <div class="master-item-value">${escapeHtml(v)}${i === 0 ? ' <span class="badge badge-done-ok">デフォルト</span>' : ''}</div>
      <div class="master-item-actions">
        ${i === 0 ? '' : `<button class="small-btn" data-action="default" data-col="${escapeHtml(f.masterKey)}" data-val="${escapeHtml(v)}">デフォルトにする</button>`}
        <button class="pass-del-btn" data-action="delete" data-col="${escapeHtml(f.masterKey)}" data-val="${escapeHtml(v)}">削除</button>
      </div>
    </div>`).join('') : '<div class="loading-text">まだ値がありません</div>';
  return `
    <div class="accordion-item">
      <button class="accordion-header" data-action="toggle" data-col="${escapeHtml(f.masterKey)}">
        <span>${escapeHtml(f.key)}</span>
        <span class="accordion-caret">${isOpen ? '▲' : '▼'}</span>
      </button>
      <div class="accordion-body" style="display:${isOpen ? 'block' : 'none'};">
        ${rows}
        <div class="new-row" style="margin-top:12px;">
          <input type="text" class="master-new-input" placeholder="新しい値を追加">
          <button class="small-btn" data-action="add" data-col="${escapeHtml(f.masterKey)}">＋追加</button>
        </div>
      </div>
    </div>`;
}

function onMasterManageClick(event) {
  const btn = event.target.closest('button[data-action]');
  if (!btn) return;
  const action = btn.dataset.action;
  const col = btn.dataset.col;
  if (action === 'switch-inspector') {
    settingsInspectorName = null;
    renderMasterManage();
  } else if (action === 'toggle') {
    openMasterKey = (openMasterKey === col) ? null : col;
    renderMasterBody();
  } else if (action === 'add') {
    const input = btn.closest('.accordion-body').querySelector('.master-new-input');
    addMasterValueUi(col, input.value);
  } else if (action === 'delete') {
    deleteMasterValueUi(col, btn.dataset.val);
  } else if (action === 'default') {
    setMasterDefaultUi(col, btn.dataset.val);
  }
}

function addMasterValueUi(column, value) {
  const v = String(value || '').trim();
  if (!v) return;
  showOverlay('⏳', '追加しています...');
  apiPost('addMasterValue', { column: column, value: v, sheetName: settingsInspectorName }).then(() => {
    hideOverlay();
    renderMasterManage();
  }).catch(showError);
}

function deleteMasterValueUi(column, value) {
  if (!confirm(`「${value}」を削除しますか?`)) return;
  showOverlay('⏳', '削除しています...');
  apiPost('deleteMasterValue', { column: column, value: value, sheetName: settingsInspectorName }).then(() => {
    hideOverlay();
    renderMasterManage();
  }).catch(showError);
}

function setMasterDefaultUi(column, value) {
  showOverlay('⏳', 'デフォルトに設定しています...');
  apiPost('setDefaultMasterValue', { column: column, value: value, sheetName: settingsInspectorName }).then(() => {
    hideOverlay();
    renderMasterManage();
  }).catch(showError);
}

// ---------- ロボット溶接(β) ----------
// 半自動溶接(CO2半自動)とは入熱の計算式が別物(電流×電圧×60÷溶接速度÷1000。溶接速度は
// 「速度測定長さ」÷アークタイム(秒)×6)なため、専用の画面・状態・保存先シートを持つ。
// 現段階では簡易版として、履歴検索・PDF出力・製品名OCR・検査員別デフォルトには対応していない
// (半自動溶接側の既存機能には一切手を加えていない)。

function goRobotJointNew() {
  goTo({ screenId: 'robot-joint-new-screen', title: 'ロボット溶接 記録', load: initRobotJointNewForm });
}

let robotMasterLists = {};

async function initRobotJointNewForm() {
  document.getElementById('rjn-検査日').value = new Date().toISOString().slice(0, 10);
  ['rjn-製品名', 'rjn-コラム径', 'rjn-板厚', 'rjn-半径標準値', 'rjn-計画層数',
    'rjn-入熱上限', 'rjn-温度下限', 'rjn-温度上限', 'rjn-気温',
    'rjn-溶接管理者', 'rjn-オペレータ', 'rjn-記録者', 'rjn-溶接部位',
    'rjn-継手形状姿勢', 'rjn-溶接材料', 'rjn-銘柄径', 'rjn-使用温度計', 'rjn-天候',
  ].forEach(id => { document.getElementById(id).value = ''; });
  document.getElementById('rjn-溶接区分').value = '全周溶接';
  onRobotWeldKindChange();

  const inspectorSelect = document.getElementById('rjn-検査員');
  inspectorSelect.innerHTML = inspectorRoster.map(v => `<option value="${escapeHtml(v)}">${escapeHtml(v)}</option>`).join('');

  try {
    robotMasterLists = await apiGet('listMasterLists');
  } catch (e) {
    robotMasterLists = {};
  }
  const fillSelect = (id, list) => {
    document.getElementById(id).innerHTML =
      '<option value="">(選択してください)</option>' + list.map(v => `<option value="${escapeHtml(v)}">${escapeHtml(v)}</option>`).join('');
  };
  fillSelect('rjn-工事名', robotMasterLists['工事名'] || []);
  fillSelect('rjn-部材', robotMasterLists['部材'] || []);
  fillSelect('rjn-材質', robotMasterLists['材質'] || []);
  fillSelect('rjn-溶接方法', (robotMasterLists['溶接方法'] || []).filter(v => v.indexOf('ロボット') !== -1));
}

// 全周溶接の時だけ「半径標準値」「計画層数」を使う(一辺溶接では不要なので隠す)
function onRobotWeldKindChange() {
  const isFull = document.getElementById('rjn-溶接区分').value === '全周溶接';
  document.getElementById('rjn-半径標準値-wrap').style.display = isFull ? '' : 'none';
  document.getElementById('rjn-計画層数-wrap').style.display = isFull ? '' : 'none';
}

// 板厚・半径標準値から外周R半径・内周R半径を、そこからさらに外周・内周の全周長(mm)を求める
// (角形鋼管の4辺の直線部+4隅の円弧部)。全周溶接の各層の溶接長は、内周(1層目)→外周(最終層)へ
// 層数に応じて線形補間する。一辺溶接は corner を除いた1辺分の直線長を固定で使う。
function robotGeometry(columnDia, thickness, radiusStd) {
  const outerR = thickness * radiusStd;
  const innerR = outerR - thickness;
  const straightOuter = (columnDia - 2 * outerR) * 4;
  const straightInner = (columnDia - 2 * thickness - 2 * innerR) * 4;
  const outerCirc = straightOuter + 2 * Math.PI * outerR;
  const innerCirc = straightInner + 2 * Math.PI * innerR;
  return { outerR: outerR, innerR: innerR, outerCirc: outerCirc, innerCirc: innerCirc };
}

function robotMeasureLength(header, layer) {
  const columnDia = Number(header["コラム径"]) || 0;
  const thickness = Number(header["板厚"]) || 0;
  if (header["溶接区分"] === '全周溶接') {
    const radiusStd = Number(header["半径標準値"]) || 0;
    const geo = robotGeometry(columnDia, thickness, radiusStd);
    const planLayers = Number(header["計画層数"]) || 1;
    if (planLayers <= 1) return geo.innerCirc;
    const l = Math.max(1, Number(layer) || 1);
    return geo.innerCirc + (l - 1) * (geo.outerCirc - geo.innerCirc) / (planLayers - 1);
  }
  // 一辺溶接: 半径標準値が未入力でも、内周R半径=0とみなしてコラム径をそのまま使う
  const radiusStd = Number(header["半径標準値"]) || 0;
  const geo = robotGeometry(columnDia, thickness, radiusStd || 0);
  return columnDia - 2 * geo.innerR;
}

function computeRobotMetrics(header, current, voltage, arcSeconds, passTemp, layer) {
  current = Number(current) || 0; voltage = Number(voltage) || 0; arcSeconds = Number(arcSeconds) || 0;
  const measureLength = robotMeasureLength(header, layer);
  let weldSpeed = '', heatInput = '';
  if (measureLength > 0 && arcSeconds > 0) {
    weldSpeed = measureLength / arcSeconds * 6;
    if (weldSpeed > 0 && current && voltage) {
      heatInput = Math.round((current * voltage * 60 / weldSpeed / 1000) * 100) / 100;
      weldSpeed = Math.round(weldSpeed * 100) / 100;
    } else {
      weldSpeed = Math.round(weldSpeed * 100) / 100;
    }
  }
  const reasons = [];
  let ok = true;
  const tempMin = header["パス間温度下限(℃)"], tempMax = header["パス間温度上限(℃)"], heatLimit = header["入熱上限(kJ/cm)"];
  if (tempMin !== '' && tempMin != null && Number(passTemp) < Number(tempMin)) { ok = false; reasons.push('温度不足'); }
  if (tempMax !== '' && tempMax != null && Number(passTemp) > Number(tempMax)) { ok = false; reasons.push('温度超過'); }
  if (heatInput !== '' && heatLimit !== '' && heatLimit != null && heatInput > Number(heatLimit)) { ok = false; reasons.push('入熱超過'); }
  return { weldSpeed: weldSpeed, heatInput: heatInput, judgement: ok ? 'OK' : 'NG', reasons: reasons };
}

function submitRobotNewJoint() {
  const inspector = document.getElementById('rjn-検査員').value;
  const construction = document.getElementById('rjn-工事名').value;
  const member = document.getElementById('rjn-部材').value;
  const productName = document.getElementById('rjn-製品名').value.trim();
  const material = document.getElementById('rjn-材質').value;
  const weldMethod = document.getElementById('rjn-溶接方法').value;
  const weldKind = document.getElementById('rjn-溶接区分').value;
  const columnDia = document.getElementById('rjn-コラム径').value;
  const thickness = document.getElementById('rjn-板厚').value;
  const radiusStd = document.getElementById('rjn-半径標準値').value;
  const planLayers = document.getElementById('rjn-計画層数').value;

  if (!inspector) { showOverlay('⚠️', '検査員を選んでください', true); return; }
  if (!construction) { showOverlay('⚠️', '工事名を選んでください', true); return; }
  if (!member) { showOverlay('⚠️', '部材を選んでください', true); return; }
  if (!productName) { showOverlay('⚠️', '製品名を入力してください', true); return; }
  if (!material) { showOverlay('⚠️', '材質を選んでください', true); return; }
  if (!weldMethod) { showOverlay('⚠️', '溶接方法を選んでください', true); return; }
  if (columnDia === '') { showOverlay('⚠️', 'コラム径を入力してください', true); return; }
  if (thickness === '') { showOverlay('⚠️', '板厚を入力してください', true); return; }
  if (weldKind === '全周溶接' && (radiusStd === '' || planLayers === '')) {
    showOverlay('⚠️', '全周溶接の場合、半径標準値と計画層数を入力してください', true); return;
  }

  const geo = robotGeometry(Number(columnDia), Number(thickness), Number(radiusStd) || 0);
  const header = {
    "工事名": construction,
    "検査日": document.getElementById('rjn-検査日').value,
    "部材": member,
    "製品名": productName,
    "材質": material,
    "溶接方法": weldMethod,
    "溶接区分": weldKind,
    "検査員（入力者）": inspector,
    "溶接管理者(確認者)": document.getElementById('rjn-溶接管理者').value.trim(),
    "オペレータ": document.getElementById('rjn-オペレータ').value.trim(),
    "記録者": document.getElementById('rjn-記録者').value.trim(),
    "溶接部位": document.getElementById('rjn-溶接部位').value.trim(),
    "継手形状・姿勢": document.getElementById('rjn-継手形状姿勢').value.trim(),
    "溶接材料": document.getElementById('rjn-溶接材料').value.trim(),
    "銘柄・径": document.getElementById('rjn-銘柄径').value.trim(),
    "使用温度計": document.getElementById('rjn-使用温度計').value.trim(),
    "天候": document.getElementById('rjn-天候').value.trim(),
    "気温": document.getElementById('rjn-気温').value,
    "コラム径": columnDia,
    "板厚": thickness,
    "半径標準値": radiusStd,
    "計画層数": planLayers,
    "内周R半径": Math.round(geo.innerR * 100) / 100,
    "速度測定長さ": weldKind === '一辺溶接' ? Math.round((Number(columnDia) - 2 * geo.innerR) * 100) / 100 : '',
    "入熱上限(kJ/cm)": document.getElementById('rjn-入熱上限').value,
    "パス間温度下限(℃)": document.getElementById('rjn-温度下限').value,
    "パス間温度上限(℃)": document.getElementById('rjn-温度上限').value,
  };

  robotState.header = header;
  robotState.passes = [];
  robotState.nextLayer = 1;
  goTo({ screenId: 'robot-joint-record-screen', title: 'ロボット溶接 パス記録', load: renderRobotRecordScreen, noBack: true });
}

// ---------- ロボット溶接: パス記録画面 ----------

const robotState = { header: null, passes: [], nextLayer: 1 };
let robotTimerState = 'idle';
let robotTimerStart = null, robotTimerEnd = null, robotTimerInterval = null;

function renderRobotRecordScreen() {
  const h = robotState.header;
  document.getElementById('robot-joint-summary').innerHTML = `
    <div>工事名: ${escapeHtml(h["工事名"] || '-')}　製品名: ${escapeHtml(h["製品名"] || '-')}　溶接区分: ${escapeHtml(h["溶接区分"] || '-')}</div>
  `;
  document.getElementById('robot-layer-value').textContent = robotState.nextLayer;
  document.getElementById('robot-pass-input-section').style.display = 'block';
  document.getElementById('robot-done-section').style.display = 'none';
  resetRobotTimerUi();
  renderRobotPassTable();
  document.getElementById('rpi-current').value = '';
  document.getElementById('rpi-voltage').value = '';
  document.getElementById('rpi-temp').value = '';
  document.getElementById('rpi-note').value = '';
}

function robotMaxRecordedLayer() {
  if (!robotState.passes.length) return 0;
  return Math.max(...robotState.passes.map(p => Number(p.layer) || 0));
}

function changeRobotLayer(delta) {
  const cap = robotMaxRecordedLayer() + 1;
  robotState.nextLayer = Math.max(1, Math.min(cap, robotState.nextLayer + delta));
  document.getElementById('robot-layer-value').textContent = robotState.nextLayer;
}

function resetRobotTimerUi() {
  robotTimerState = 'idle'; robotTimerStart = null; robotTimerEnd = null;
  clearInterval(robotTimerInterval);
  document.getElementById('robot-timer-display').textContent = '00:00';
  const btn = document.getElementById('robot-timer-btn');
  btn.textContent = '▶ スタート';
  btn.classList.remove('timer-running'); btn.classList.add('timer-start');
  document.getElementById('rpi-submit-btn').disabled = true;
  document.getElementById('rpi-submit-btn').textContent = '✅ このパスを記録(ストップ後に押せます)';
}

function onRobotTimerButton() {
  if (robotTimerState === 'idle') {
    robotTimerState = 'running';
    robotTimerStart = new Date();
    const btn = document.getElementById('robot-timer-btn');
    btn.textContent = '■ ストップ';
    btn.classList.remove('timer-start'); btn.classList.add('timer-running');
    robotTimerInterval = setInterval(() => {
      document.getElementById('robot-timer-display').textContent = formatElapsed(new Date() - robotTimerStart);
    }, 200);
  } else if (robotTimerState === 'running') {
    robotTimerState = 'stopped';
    robotTimerEnd = new Date();
    clearInterval(robotTimerInterval);
    document.getElementById('robot-timer-display').textContent = formatElapsed(robotTimerEnd - robotTimerStart);
    const btn = document.getElementById('robot-timer-btn');
    btn.textContent = '✅ ストップ済み';
    btn.classList.remove('timer-running');
    document.getElementById('rpi-submit-btn').disabled = false;
    document.getElementById('rpi-submit-btn').textContent = '✅ このパスを記録';
  }
}

function submitRobotPass() {
  if (robotTimerState !== 'stopped') { showOverlay('⚠️', 'スタート→ストップの後に記録してください', true); return; }
  const current = document.getElementById('rpi-current').value;
  const voltage = document.getElementById('rpi-voltage').value;
  const passTemp = document.getElementById('rpi-temp').value;
  const note = document.getElementById('rpi-note').value.trim();
  if (passTemp === '') { showOverlay('⚠️', 'パス間温度を入力してください', true); return; }

  const lastPass = robotState.passes[robotState.passes.length - 1];
  if (lastPass && lastPass.layer === robotState.nextLayer) {
    if (!confirm(`同じ層数(${robotState.nextLayer})で良いですか?`)) return;
  }

  const arcSeconds = Math.max(0, Math.round((robotTimerEnd - robotTimerStart) / 1000));
  const metrics = computeRobotMetrics(robotState.header, current, voltage, arcSeconds, passTemp, robotState.nextLayer);

  robotState.passes.push({
    layer: robotState.nextLayer, current: Number(current) || 0, voltage: Number(voltage) || 0,
    start: robotTimerStart.toISOString(), end: robotTimerEnd.toISOString(), arcSeconds: arcSeconds,
    passTemp: Number(passTemp), note: note, weldSpeed: metrics.weldSpeed, heatInput: metrics.heatInput, judgement: metrics.judgement,
  });
  renderRobotPassTable();

  document.getElementById('rpi-current').value = '';
  document.getElementById('rpi-voltage').value = '';
  document.getElementById('rpi-temp').value = '';
  document.getElementById('rpi-note').value = '';
  resetRobotTimerUi();

  if (metrics.judgement === 'NG') {
    showOverlay('⚠️', 'このパスは管理基準を外れています\n' + metrics.reasons.join('・'), true);
  }
}

function deleteRobotPass(index) {
  if (!confirm('このパスの記録を削除しますか?')) return;
  robotState.passes.splice(index, 1);
  renderRobotPassTable();
}

function renderRobotPassTable() {
  const tbody = document.getElementById('robot-pass-table-body');
  if (!robotState.passes.length) { tbody.innerHTML = '<tr><td colspan="10" class="loading-text">まだパスが記録されていません</td></tr>'; return; }
  tbody.innerHTML = robotState.passes.map((p, i) => `
    <tr class="${p.judgement === 'NG' ? 'ng-row' : ''}">
      <td>${i + 1}</td>
      <td>${p.layer}</td>
      <td>${p.current}</td>
      <td>${p.voltage}</td>
      <td>${p.arcSeconds}</td>
      <td>${p.weldSpeed === '' ? '-' : p.weldSpeed}</td>
      <td>${p.heatInput === '' ? '-' : p.heatInput}</td>
      <td>${p.passTemp}</td>
      <td class="${p.judgement === 'NG' ? 'judge-ng' : 'judge-ok'}">${p.judgement}</td>
      <td><button class="pass-del-btn" onclick="deleteRobotPass(${i})">削除</button></td>
    </tr>`).join('');
}

function onCompleteRobotJoint() {
  if (!robotState.passes.length) { showOverlay('⚠️', 'パスが1件も記録されていません', true); return; }
  if (!confirm('この継手の溶接記録を確定し、スプレッドシートへ記録します。よろしいですか？')) return;
  showOverlay('⏳', 'スプレッドシートへ記録しています...');
  apiPost('saveRobotJointRecord', { header: robotState.header, passes: robotState.passes }).then(() => {
    hideOverlay();
    document.getElementById('robot-pass-input-section').style.display = 'none';
    document.getElementById('robot-done-section').style.display = 'block';
  }).catch(showError);
}
