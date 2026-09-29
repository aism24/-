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
 * ■ 工事単価シートへの反映(受信のたびに実行)
 *   生産損益分析アプリの管理用スプレッドシート「損益分岐点生産重量」のシート「工事単価」の
 *   A〜D列(工事No | 工事名 | 契約総重量(t) | 契約金額(円))を工事No単位で更新し、無い工事Noは末尾に追加する。
 *   - 実行予算の値を正とする(手入力の値も上書き)。工事名は「情報」シートの工事名(PC側で対応付けた値)。
 *   - 値が変わった行だけ書き換える。E列以降(トン単価のARRAYFORMULA等)には触らない。
 *   - 対象外: 元ファイルなし・読み取りエラー・一覧に未登録・契約総重量と契約金額がどちらも0/空欄の工事。
 *   - 反映に失敗しても、実行予算まとめデータの保存は成功扱いにする(結果は応答とログに出す)。
 *
 * ■ 秘密キー(スクリプトプロパティ SECRET。リポジトリには書かない)
 *   PC側の 設定.json の「秘密キー」と同じ値を入れる。未設定なら書き込みはすべて拒否する。
 */

const FOLDER_ID = '1EwfXNOal_AdY6MzARgEGV_aKAcf6HjWN';
const DATA_FILE_NAME = '実行予算まとめデータ.json';
const TZ = 'Asia/Tokyo';
const PRICE_SS_ID = '1OnFx_JegSzXZo6lqMOw4yZ30xvmptA5HRdB6Cv1hgpY'; // 損益分岐点生産重量
const PRICE_SHEET = '工事単価';
const CACHE_KEY = 'state_v1'; // 画面の読み込み用に保存データの本文をキャッシュ(受信のたびに更新)
const EMPTY_STATE_TEXT = '{"version":1,"baseline":null,"today":null}';

function doGet() {
  try {
    // 保存データの本文をそのまま埋め込んで返す(JSONの解析・再生成をしない)
    return ContentService.createTextOutput('{"status":"success","data":' + loadStateText_() + '}')
      .setMimeType(ContentService.MimeType.JSON);
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
    let price;
    try {
      price = syncPriceSheet_(next.today.rows);
    } catch (err) {
      price = { error: String(err && err.message || err) };
    }
    Logger.log('工事単価への反映: ' + JSON.stringify(price));
    return json_({ status: 'success', data: { rows: Object.keys(next.today.rows).length, baselineDay: next.baseline ? next.baseline.day : null, price: price } });
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
  const list = Array.isArray(data) ? data
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
      row = r; // 受信データは毎回新しく解析したものなので複製不要
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

// 工事単価シートの既存値(A〜D列、2行目から)と当日の値から、書き換える行と追加する行を決める
//   existing: [[工事No, 工事名, 重量, 金額], …](シートの2行目から順)
//   戻り値: { updates:[{row:シートの行番号, values:[4列]}], appends:[[4列]], lastRow:A列に値がある最後の行 }
function computePriceUpdates(existing, rows) {
  const want = {};
  Object.keys(rows).forEach(function (k) {
    const r = rows[k];
    if (!r || r.missing || r.status === 'error' || r.matchedBy === '一覧に未登録' || !r.no) return;
    const w = numOrNull_(r.weight), a = numOrNull_(r.amount);
    if (!w && !a) return;
    const prev = want[r.no];
    if (prev && String(prev.saved || '') >= String(r.saved || '')) return; // 同じ工事Noが複数あれば保存日時の新しい方
    want[r.no] = { saved: r.saved, values: [r.no, r.name || '', w === null ? '' : Math.round(w * 1000) / 1000, a === null ? '' : a] };
  });

  const updates = [], seen = {};
  let lastRow = 1;
  existing.forEach(function (v, i) {
    const no = String(v[0] === null || v[0] === undefined ? '' : v[0]).trim();
    if (!no) return;
    lastRow = i + 2;
    if (seen[no] || !want[no]) return;
    seen[no] = true;
    const nv = want[no].values;
    if (!samePrice_(v, nv)) updates.push({ row: i + 2, values: nv });
  });
  const appends = Object.keys(want).filter(function (no) { return !seen[no]; })
    .sort(function (x, y) { return x.localeCompare(y, 'ja', { numeric: true }); })
    .map(function (no) { return want[no].values; });
  return { updates: updates, appends: appends, lastRow: lastRow };
}

function numOrNull_(v) {
  if (v === null || v === undefined || v === '') return null;
  const n = Number(v);
  return isFinite(n) ? n : null;
}

function samePrice_(cur, nv) {
  if (String(cur[1] === null || cur[1] === undefined ? '' : cur[1]).trim() !== String(nv[1]).trim()) return false;
  for (let i = 2; i < 4; i++) {
    const a = numOrNull_(cur[i]), b = numOrNull_(nv[i]);
    if (a === null && b === null) continue;
    if (a === null || b === null || Math.abs(a - b) > 1e-6) return false;
  }
  return true;
}

function syncPriceSheet_(rows) {
  const sh = SpreadsheetApp.openById(PRICE_SS_ID).getSheetByName(PRICE_SHEET);
  if (!sh) throw new Error('シート「' + PRICE_SHEET + '」が見つかりません');
  const last = sh.getLastRow();
  const existing = last >= 2 ? sh.getRange(2, 1, last - 1, 4).getValues() : [];
  const plan = computePriceUpdates(existing, rows);
  plan.updates.forEach(function (u) { sh.getRange(u.row, 1, 1, 4).setValues([u.values]); });
  if (plan.appends.length) sh.getRange(plan.lastRow + 1, 1, plan.appends.length, 4).setValues(plan.appends);
  return {
    updated: plan.updates.map(function (u) { return u.values[0]; }),
    appended: plan.appends.map(function (v) { return v[0]; }),
  };
}

/* ===================== ファイル入出力 ===================== */

// データファイル。IDをスクリプトプロパティ(DATA_FILE_ID)に覚えて、フォルダ内の名前検索を初回だけにする
function getFile_() {
  const props = PropertiesService.getScriptProperties();
  const id = props.getProperty('DATA_FILE_ID');
  if (id) {
    try {
      const f = DriveApp.getFileById(id);
      if (!f.isTrashed()) return f;
    } catch (ignore) {}
  }
  const it = DriveApp.getFolderById(FOLDER_ID).getFilesByName(DATA_FILE_NAME);
  if (!it.hasNext()) return null;
  const f = it.next();
  props.setProperty('DATA_FILE_ID', f.getId());
  return f;
}

function readFileText_() {
  const f = getFile_();
  return (f && f.getBlob().getDataAsString('UTF-8')) || EMPTY_STATE_TEXT;
}

// 画面の読み込み用: キャッシュにあればDriveを読まない
function loadStateText_() {
  const cached = CacheService.getScriptCache().get(CACHE_KEY);
  if (cached) return cached;
  const text = readFileText_();
  putCache_(text);
  return text;
}

// 受信時の更新用: 正はファイル(キャッシュは使わない)
function loadState_() {
  return JSON.parse(readFileText_());
}

function saveState_(state) {
  const text = JSON.stringify(state);
  const f = getFile_();
  if (f) f.setContent(text);
  else {
    const nf = DriveApp.getFolderById(FOLDER_ID).createFile(DATA_FILE_NAME, text, 'application/json');
    PropertiesService.getScriptProperties().setProperty('DATA_FILE_ID', nf.getId());
  }
  putCache_(text);
}

// CacheServiceは1件100KBまで・最長6時間。入らない大きさなら消して、毎回ファイルを読む
function putCache_(text) {
  const cache = CacheService.getScriptCache();
  try {
    if (text.length < 90000) cache.put(CACHE_KEY, text, 21600);
    else cache.remove(CACHE_KEY);
  } catch (ignore) {
    try { cache.remove(CACHE_KEY); } catch (ignore2) {}
  }
}

function json_(obj) {
  return ContentService.createTextOutput(JSON.stringify(obj)).setMimeType(ContentService.MimeType.JSON);
}

// 初回のみ手動実行: Drive・スプレッドシートの権限承認と、保存先に届くかの確認
function checkSetup() {
  const folder = DriveApp.getFolderById(FOLDER_ID);
  const secret = PropertiesService.getScriptProperties().getProperty('SECRET');
  Logger.log('保存先フォルダ: ' + folder.getName());
  Logger.log('データファイル: ' + (getFile_() ? 'あり' : 'なし(初回受信で作成)'));
  Logger.log('工事単価シート: ' + (SpreadsheetApp.openById(PRICE_SS_ID).getSheetByName(PRICE_SHEET) ? 'あり' : '見つかりません'));
  Logger.log('秘密キー(SECRET): ' + (secret ? '設定済み' : '未設定 ← スクリプトプロパティに設定してください'));
}
