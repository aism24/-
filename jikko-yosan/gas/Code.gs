/**
 * 実行予算まとめ - GAS API バックエンド
 *
 * スタンドアロンのApps Scriptとして作成し、Webアプリとしてデプロイする
 * (次のユーザーとして実行: 自分 / アクセスできるユーザー: 全員)。
 *
 * ■ データの流れ
 *   会社PCの「実行予算更新.bat」(pc/update.js)が毎朝、各工事の現在値を POST する。
 *     本文(text/plain): {"secret":"…","data": data.json の中身}
 *   画面(jikko-yosan/index.html)は GET で「比較の基準」と「当日の値」を受け取り、
 *   変更セルの黄色表示・Excel書き出しを画面側で行う。
 *
 * ■ 保存先
 *   会社フォルダ(実行予算まとめアプリ用)の「実行予算まとめデータ.json」1ファイル。
 *   { version, baseline:{day,at,rows}, today:{day,at,rows} }
 *   rows は key(ファイル名)→ 1工事の値。
 *   - 受信時、保存済みの today が前日以前のものなら、それを baseline(比較の基準)に繰り上げる。
 *     → 基準は常に「前日までの最後の値」。同じ日に何度受信しても基準は変わらない。
 *   - 今回の受信に無い工事は、最後の値のまま missing:true で残す(画面では灰色「元ファイルなし」)。
 *   - 読み取りエラーの工事は、前回の値を引き継いで status:'error' にする(誤って黄色にしないため)。
 *   マスタのスプレッドシート「実行予算」には一切書き込まない(工事No・工事名の対応付けはPC側で済んでいる)。
 *
 * ■ 秘密キー(スクリプトプロパティ SECRET。リポジトリには書かない)
 *   PC側の 設定.json の「秘密キー」と同じ値を入れる。未設定なら書き込みはすべて拒否する。
 */

const FOLDER_ID = '1EwfXNOal_AdY6MzARgEGV_aKAcf6HjWN';
const DATA_FILE_NAME = '実行予算まとめデータ.json';
const TZ = 'Asia/Tokyo';

function doGet() {
  try {
    const state = loadState_();
    return json_({ status: 'success', data: { baseline: state.baseline, today: state.today } });
  } catch (err) {
    return json_({ status: 'error', message: String(err && err.message || err) });
  }
}

function doPost(e) {
  const lock = LockService.getScriptLock();
  try {
    const body = JSON.parse((e && e.postData && e.postData.contents) || '{}');
    const secret = PropertiesService.getScriptProperties().getProperty('SECRET');
    if (!secret || body.secret !== secret) return json_({ status: 'error', message: '秘密キーが違います' });
    const rows = normalizeRows(body.data);
    if (!rows.length) return json_({ status: 'error', message: 'データが空です' });

    lock.waitLock(30000);
    const now = new Date();
    const next = mergeState(loadState_(), rows,
      Utilities.formatDate(now, TZ, 'yyyy-MM-dd'), Utilities.formatDate(now, TZ, "yyyy-MM-dd'T'HH:mm:ssXXX"));
    saveState_(next);
    return json_({ status: 'success', data: { rows: Object.keys(next.today.rows).length, baselineDay: next.baseline ? next.baseline.day : null } });
  } catch (err) {
    return json_({ status: 'error', message: String(err && err.message || err) });
  } finally {
    try { lock.releaseLock(); } catch (ignore) {}
  }
}

/* ===================== 保存データの更新(純粋関数。Nodeでテストする) ===================== */

// data.json の中身から1工事ずつの配列を取り出す(配列 / {rows:[…]} / {key:行} のどれでも受ける)
function normalizeRows(data) {
  if (!data) return [];
  let list = Array.isArray(data) ? data
    : Array.isArray(data.rows) ? data.rows
    : Array.isArray(data.items) ? data.items
    : Array.isArray(data.data) ? data.data
    : Object.keys(data).map(function (k) { return data[k]; });
  return list.filter(function (r) { return r && typeof r === 'object' && r.key; });
}

function mergeState(state, incoming, day, at) {
  state = state || {};
  let baseline = state.baseline || null;
  const prev = state.today || null;
  if (prev && prev.day < day) baseline = prev;
  const prevRows = prev ? prev.rows : {};

  const rows = {};
  incoming.forEach(function (r) {
    const old = prevRows[r.key];
    let row;
    if (r.status === 'error' && old) {
      row = JSON.parse(JSON.stringify(old));
      row.status = 'error';
      row.warn = r.warn || '';
      row.locked = !!r.locked;
    } else {
      row = JSON.parse(JSON.stringify(r));
    }
    delete row.missing;
    rows[r.key] = row;
  });
  Object.keys(prevRows).forEach(function (k) {
    if (rows[k]) return;
    const row = JSON.parse(JSON.stringify(prevRows[k]));
    row.missing = true;
    row.locked = false;
    rows[k] = row;
  });
  return { version: 1, baseline: baseline, today: { day: day, at: at, rows: rows } };
}

/* ===================== ファイル入出力 ===================== */

function getFile_() {
  const it = DriveApp.getFolderById(FOLDER_ID).getFilesByName(DATA_FILE_NAME);
  return it.hasNext() ? it.next() : null;
}

function loadState_() {
  const f = getFile_();
  if (!f) return { version: 1, baseline: null, today: null };
  return JSON.parse(f.getBlob().getDataAsString('UTF-8') || '{}');
}

function saveState_(state) {
  const text = JSON.stringify(state);
  const f = getFile_();
  if (f) f.setContent(text);
  else DriveApp.getFolderById(FOLDER_ID).createFile(DATA_FILE_NAME, text, 'application/json');
}

function json_(obj) {
  return ContentService.createTextOutput(JSON.stringify(obj)).setMimeType(ContentService.MimeType.JSON);
}

// 初回のみ手動実行: Drive の権限承認と、保存先フォルダに届くかの確認
function checkSetup() {
  const folder = DriveApp.getFolderById(FOLDER_ID);
  const secret = PropertiesService.getScriptProperties().getProperty('SECRET');
  Logger.log('保存先フォルダ: ' + folder.getName());
  Logger.log('データファイル: ' + (getFile_() ? 'あり' : 'なし(初回受信で作成)'));
  Logger.log('秘密キー(SECRET): ' + (secret ? '設定済み' : '未設定 ← スクリプトプロパティに設定してください'));
}
