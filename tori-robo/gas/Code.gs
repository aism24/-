/**
 * 鳥取梁ロボ管理アプリ(tori-robo)のGAS APIバックエンド。
 *
 * 「鳥取梁ロボ管理データ」スプレッドシートの「拡張機能→Apps Script」に貼り付けて使う
 * コンテナバインド型スクリプトです(SpreadsheetApp.getActiveSpreadsheet()で自分自身を参照)。
 * 画面(index.html / app.js)は静的ページで、GASはJSON APIのみを提供します。
 *
 * ■ 読み取り専用の原則(厳守)
 *   ・1号機/2号機の稼動実績スプレッドシートは読み取りのみ(書き込まない)。
 *   ・工事別マスターExcelも読み取りのみ。Excelはこのスプレッドシートと同じフォルダに
 *     作る「作業用コピー」へ変換して読み、元ファイルには一切触れない。
 *   ・書き込むのは、(a)同フォルダ内の作業用コピー/キャッシュJSON、(b)このスプレッドシートの
 *     「各種情報」V:W列(工事名称の別名表)のみ。
 *
 * ■ 「各種情報」シートの構成
 *   A〜E : ドライブ / マスタNo / 工事番号 / Excelファイル名 / URL(工事別マスター)
 *   G〜H : ファイル名 / ID(1号機・2号機の稼動実績。上から順に1号機・2号機)
 *   P〜Q : 工事番号 / 工事名
 *   S〜T : 会社カレンダー(Date / 出勤・休日)。最初の日付より前のデータは集計しない
 *   V〜W : 工事名称の別名表(入力名 / 工事番号)。アプリの画面から追記される
 *
 * ■ 突き合わせ
 *   ロボ側の「工事名称」(手入力)→工事、「柱番号」(手入力)=工事マスターの「製品マーク」。
 *   工事名称は、別名表(V:W)に登録されたものだけ判定する(部分一致の自動判定はしない。未登録は画面2.で選択して保存)。
 *   製品マークがマスターに無い場合は誤入力の可能性があるため、近い製品マークを候補にする。
 */

// ========== 設定 ==========

const INFO_SHEET_NAME = '各種情報';
const CACHE_FOLDER_PROP = 'CACHE_FOLDER_ID';
const MASTER_CACHE_FILE_NAME = '_cache_tottori_robot_masters.json';
const MASTER_CACHE_VERSION = 5;
const SNAPSHOT_LOGIC_VERSION = 2; // 集計ロジック(判定方法・出力項目)を変えたら上げる。元データが同じでも保存結果を作り直す(マスター全読み直しの MASTER_CACHE_VERSION とは別)
// 実寸法師のリンク(図番のハイパーリンク)入りマスターExcelの置き場所(毎日更新される。鳥取以外の工事も含む)。
// 「各種情報」D列のファイル名と同じ名前(「_マスタのまま」の有無・拡張子は無視)のファイルだけを使う。
const SNAPSHOT_FILE_NAME = '_snapshot_tori_robo.json';
const ARCHIVE_FILE_NAME = '_archive_tori_robo_products.json';
const LINK_FOLDER_ID = '1HuBr3qZnO4N6BA6Zm_aU8BkVM45Q1K5q';
const LINK_FILE_SUFFIX = /_?マスタのまま/g;
const WORK_COPY_PREFIX = '_作業用_梁ロボ_';
const TIMEZONE = 'Asia/Tokyo';
const IGNORE_WORK_NO = '00-00';
const MIRROR_COL = 25; // Y列。Y=入力工事名 / Z=正式工事名(別名表の名前版。人が読む用)
const ALIAS_COL = 22; // V列(1始まり)。V=入力名 / W=工事番号
const ROBOT_SHEET_ROWS = { 1: 0, 2: 1 }; // ロボ番号 → G:H列の有効行の順番(0始まり)

// ロボ稼動実績シートの列見出し(完全一致。見つからなければ下のfallback位置を使う)
const ROBOT_HEADERS = {
  workName: ['工事名称', 0],
  mark: ['柱番号', 1],
  startDate: ['開始日', 3],
  startTime: ['開始時', 4],
  endDate: ['終了日', 5],
  endTime: ['終了時', 6],
  run: ['運転時間(ワーク)', 8],
  arc: ['アークタイム(ワーク)', 16],
  wire: ['ワイヤ使用量(Kg)(ワーク)', 28],
  len: ['換算溶接長(m)(ワーク)', 46],
};

// マスターExcelの列見出し
const MASTER_HEADERS = {
  part: '部位',
  site: '加工先',
  drawingNo: '図番',
  mark: '製品マーク',
  size: 'サイズ',
  qty: '本数',
  weight: '重量',
  processed: '加工',
  welded: '溶接',
};

// ========== 純粋関数(GASサービスに依存しない。ローカルのテストでも使う) ==========

// 突き合わせ用に文字列を正規化する(全角→半角、空白・括弧・記号を除去、大文字化)。
function normName_(s) {
  return String(s == null ? '' : s)
    .normalize('NFKC')
    .replace(/[\s　()（）【】\[\]「」・._\-]/g, '')
    .toUpperCase();
}

// ファイル名から拡張子と「_マスタのまま」を除いた名前(突き合わせ用に正規化)。
function baseKey_(fileName) {
  return normName_(String(fileName || '').replace(/\.(xlsx?|xlsm)$/i, '').replace(LINK_FILE_SUFFIX, ''));
}

// 工事フォルダ名(例: "25-11エスロジ松原" / "26-12OSAKA SAKURAJIMA")から工事番号と工事名を取り出す。
// 工事番号は「2桁-1〜2桁」+英字(最大2文字。直後に英字が続く場合は工事名の一部とみなす)。
function parseWorkFolderName_(name) {
  const m = String(name || '').normalize('NFKC').trim().match(/^(\d{2}-\d{1,2})([A-Za-z]{1,2}(?![A-Za-z]))?\s*(.*)$/);
  return m ? { workNo: m[1] + (m[2] || ''), workName: m[3].trim() } : null;
}

// 製品マークの正規化(大文字小文字・全角半角・空白を吸収。記号は区別する)。
function normMark_(s) {
  return String(s == null ? '' : s).normalize('NFKC').replace(/[\s　]/g, '').toUpperCase();
}

// "h:mm:ss" を秒に。不正なら0。
function parseHms_(s) {
  const m = String(s || '').trim().match(/^(\d+):(\d{1,2}):(\d{1,2})$/);
  return m ? Number(m[1]) * 3600 + Number(m[2]) * 60 + Number(m[3]) : 0;
}

// "24/07/24" → "2024-07-24"。日付でなければ''。
function parseYmd_(s) {
  const m = String(s || '').trim().match(/^(\d{2,4})[\/\-](\d{1,2})[\/\-](\d{1,2})$/);
  if (!m) return '';
  const y = m[1].length === 2 ? 2000 + Number(m[1]) : Number(m[1]);
  return y + '-' + String(m[2]).padStart(2, '0') + '-' + String(m[3]).padStart(2, '0');
}

function levenshtein_(a, b) {
  const al = a.length, bl = b.length;
  if (!al) return bl;
  if (!bl) return al;
  let prev = [];
  for (let j = 0; j <= bl; j++) prev[j] = j;
  for (let i = 1; i <= al; i++) {
    const cur = [i];
    for (let j = 1; j <= bl; j++) {
      cur[j] = Math.min(prev[j] + 1, cur[j - 1] + 1, prev[j - 1] + (a.charAt(i - 1) === b.charAt(j - 1) ? 0 : 1));
    }
    prev = cur;
  }
  return prev[bl];
}

// 製品マークの候補(「この製品名では?」)。編集距離が小さい順に最大3件。
// marks: [{key(正規化済み), mark(表示用)}]
function suggestMarks_(entered, marks) {
  const e = normMark_(entered);
  if (e.length < 2) return [];
  const limit = Math.max(1, Math.min(3, Math.floor(e.length * 0.3)));
  const scored = [];
  for (let i = 0; i < marks.length; i++) {
    const k = marks[i].key;
    if (Math.abs(k.length - e.length) > limit) continue;
    const d = levenshtein_(e, k);
    if (d <= limit) scored.push({ mark: marks[i].mark, d: d });
  }
  scored.sort(function (x, y) { return x.d - y.d; });
  return scored.slice(0, 3).map(function (x) { return x.mark; });
}

// 工事名称(手入力)から工事番号の候補を求める。
// works: [{workNo, names:[正規化済みの名称...]}], alias: { 正規化した入力名: workNo }
function matchWorkNos_(enteredName, works, alias) {
  // 別名表(V:W)に登録された入力名だけを工事に結び付ける。部分一致などの自動判定はしない(画面2.で人が指定する)
  const n = normName_(enteredName);
  if (!n) return [];
  return alias && alias[n] ? [alias[n]] : [];
}

// ロボ1行分を解決する。
// masterIndex: { workNo: { byMark: { 正規化マーク: record }, marks: [{key,mark}] } }
// 戻り値: { workNo, status, product, suggestions }
//   status: 'ok'(製品確定) / 'suggest'(製品マークが無く候補あり) / 'nomark'(製品マークが無い) / 'nowork'(工事が判定できない)
function resolveRow_(row, works, alias, masterIndex) {
  const cands = matchWorkNos_(row.wn, works, alias);
  if (!cands.length) return { workNo: '', status: 'nowork', product: null, suggestions: [] };
  const key = normMark_(row.mk);
  let workNo = cands[0];
  if (cands.length > 1) {
    const withMark = cands.filter(function (c) { return masterIndex[c] && masterIndex[c].byMark[key]; });
    if (withMark.length === 1) workNo = withMark[0];
    else if (withMark.length === 0) return { workNo: '', status: 'nowork', product: null, suggestions: [], ambiguous: cands };
    else workNo = withMark[0];
  }
  const mi = masterIndex[workNo];
  const rec = mi && key ? mi.byMark[key] : null;
  if (rec) return { workNo: workNo, status: 'ok', product: rec, suggestions: [] };
  const sug = mi ? suggestMarks_(row.mk, mi.marks) : [];
  return { workNo: workNo, status: sug.length ? 'suggest' : 'nomark', product: null, suggestions: sug };
}

// ========== エントリーポイント(JSON API) ==========

function doGet(e) {
  try {
    const p = (e && e.parameter) || {};
    const action = p.action || 'getData';
    if (action === 'getData') return okRaw_(getSnapshotText_());
    if (action === 'refresh') return ok_(refreshSnapshot_(false));
    if (action === 'refreshMasters') return ok_(refreshMasters_());
    if (action === 'logDownload') return ok_(logDownload_(p.period));
    if (action === 'saveAlias') return ok_(saveAlias_(p.name, p.workNo));
    return errRes_('不明なaction: ' + action);
  } catch (err) {
    return errRes_(err.message);
  }
}

function jsonResponse_(payload) {
  return ContentService.createTextOutput(JSON.stringify(payload)).setMimeType(ContentService.MimeType.JSON);
}
// 保存済みの結果(JSON文字列)をそのまま返す。parse→stringifyの無駄を省く
function okRaw_(dataText) {
  return ContentService.createTextOutput('{"status":"success","data":' + dataText + '}').setMimeType(ContentService.MimeType.JSON);
}
function ok_(data) { return jsonResponse_({ status: 'success', data: data }); }
function errRes_(message) { return jsonResponse_({ status: 'error', message: message }); }

// ========== 索引シートの読み取り ==========

function ss_() { return SpreadsheetApp.getActiveSpreadsheet(); }
function infoSheet_() { return ss_().getSheetByName(INFO_SHEET_NAME) || ss_().getSheets()[0]; }

// ---- 速度対策: 1回の実行中は同じファイルを何度も開き直さない(メモ) ----
var FILE_MEMO_ = {};
function fileOf_(id) {
  if (!FILE_MEMO_[id]) FILE_MEMO_[id] = DriveApp.getFileById(id);
  return FILE_MEMO_[id];
}
var MTIME_MEMO_ = {};
function mtimeOf_(id) {
  if (MTIME_MEMO_[id] === undefined) MTIME_MEMO_[id] = String(fileOf_(id).getLastUpdated().getTime());
  return MTIME_MEMO_[id];
}

// リンク用フォルダのファイル一覧(id・名前・更新日時)を Drive API の1回の呼び出し(1000件ずつ)で取る。
// 1件ずつ DriveApp で名前と更新日時を聞くより桁違いに速い。失敗したときだけ従来の方法に切り替える。
var LINK_LIST_MEMO_ = null;
function listLinkFiles_() {
  if (LINK_LIST_MEMO_) return LINK_LIST_MEMO_;
  const out = [];
  try {
    let token = '';
    do {
      const args = { q: "'" + LINK_FOLDER_ID + "' in parents and trashed = false", fields: 'nextPageToken, files(id, name, modifiedTime)', pageSize: 1000, orderBy: 'name', supportsAllDrives: true, includeItemsFromAllDrives: true };
      if (token) args.pageToken = token;
      const res = Drive.Files.list(args);
      (res.files || []).forEach(function (f) { out.push({ id: f.id, name: f.name, mtime: new Date(f.modifiedTime).getTime() }); });
      token = res.nextPageToken || '';
    } while (token);
  } catch (err) {
    out.length = 0;
    const it = DriveApp.getFolderById(LINK_FOLDER_ID).getFiles(); // 従来の方法(遅いが確実)
    while (it.hasNext()) { const f = it.next(); out.push({ id: f.getId(), name: f.getName(), mtime: f.getLastUpdated().getTime() }); }
  }
  LINK_LIST_MEMO_ = out;
  return out;
}

// 「各種情報」C列(工事番号)・D列(Excelファイル名)を、E列URLの実ファイルから毎回調べて更新する。
//   D = そのファイルの実際の名前 / C = そのファイルが入っているフォルダ名の先頭の工事番号。
// 変わっていなければ書き込まない。変わった場合のみ書き換え、変更内容を返す。
var PARENT_NAME_MEMO_ = {};
function parentFolderName_(f, fileId) {
  const parents = f.getParents();
  if (!parents.hasNext()) return '';
  const p = parents.next();
  const pid = p.getId();
  if (PARENT_NAME_MEMO_[pid] === undefined) PARENT_NAME_MEMO_[pid] = p.getName();
  return PARENT_NAME_MEMO_[pid]; // 同じフォルダの名前は1回だけ聞く
}

function syncIndexRows_() {
  const sh = infoSheet_();
  const lastRow = sh.getLastRow();
  const out = { changes: [], warnings: [] };
  if (lastRow < 2) return out;
  const vals = sh.getRange(2, 1, lastRow - 1, 5).getValues(); // A:E
  vals.forEach(function (r, i) {
    const fileId = extractFileIdFromUrl_(r[4]);
    if (!fileId) return;
    const row = i + 2;
    try {
      const f = fileOf_(fileId);
      const name = f.getName();
      const folderName = parentFolderName_(f, fileId);
      let parsed = parseWorkFolderName_(folderName);
      // 現在のC列の工事番号でフォルダ名が始まっていれば「変更なし」とみなす(例: C=24-12A、フォルダ=24-12AGLP_…。
      // 英字付きの工事番号は工事名の英字と区別できないため、既存の値を優先する)。
      const cur = String(r[2] || '').trim();
      if (cur && folderName.normalize('NFKC').toUpperCase().indexOf(cur.normalize('NFKC').toUpperCase()) === 0) {
        parsed = { workNo: cur, workName: parsed ? parsed.workName : '' };
      }
      if (String(r[3]).trim() !== name) {
        sh.getRange(row, 4).setValue(name);
        out.changes.push(row + '行目 Excelファイル名: ' + r[3] + ' → ' + name);
      }
      if (!parsed) {
        out.warnings.push(row + '行目: フォルダ名から工事番号を判定できません(C列は変更しません)');
      } else if (String(r[2]).trim() !== parsed.workNo) {
        sh.getRange(row, 3).setValue(parsed.workNo);
        out.changes.push(row + '行目 工事番号: ' + r[2] + ' → ' + parsed.workNo + '(' + parsed.workName + ')');
      }
    } catch (err) {
      out.warnings.push(row + '行目のファイルを確認できません: ' + err.message);
    }
  });
  return out;
}

function readInfoRows_() {
  const sh = infoSheet_();
  const lastRow = sh.getLastRow();
  if (lastRow < 2) return [];
  return sh.getRange(2, 1, lastRow - 1, ALIAS_COL + 1).getValues(); // A:W
}

function extractFileIdFromUrl_(url) {
  const m = String(url || '').match(/[?&]id=([a-zA-Z0-9_-]+)/) || String(url || '').match(/\/d\/([a-zA-Z0-9_-]+)/);
  return m ? m[1] : '';
}

function readMasterIndex_(rows) {
  const list = [];
  rows.forEach(function (r) {
    const workNo = String(r[2] || '').trim();
    const fileName = String(r[3] || '').trim();
    const fileId = extractFileIdFromUrl_(r[4]);
    if (!workNo || !fileName || !fileId || workNo === IGNORE_WORK_NO) return;
    list.push({ masterNo: r[1], workNo: workNo, fileName: fileName, fileId: fileId });
  });
  return list;
}

function readRobotSheets_(rows) {
  const list = [];
  rows.forEach(function (r) {
    const id = String(r[7] || '').trim();
    if (id) list.push({ name: String(r[6] || '').trim(), id: id });
  });
  return list; // 上から順に1号機・2号機
}

function readWorkNames_(rows) {
  const map = {};
  rows.forEach(function (r) {
    const no = String(r[15] || '').trim();
    const nm = String(r[16] || '').trim();
    if (no && nm && no !== '工事番号') map[no] = nm;
  });
  return map;
}

function readCalendarMin_(rows) {
  let min = '';
  let max = '';
  rows.forEach(function (r) {
    const d = r[18];
    if (!(d instanceof Date) || isNaN(d.getTime())) return;
    const k = Utilities.formatDate(d, TIMEZONE, 'yyyy-MM-dd');
    if (!min || k < min) min = k;
    if (!max || k > max) max = k;
  });
  return { min: min, max: max };
}

// 別名表(V:W=工事番号)の名前版をY:Zに書く(入力工事名→正式工事名)。Y:Zは人が見る用で、アプリはV:Wを参照する
function mirrorAlias_(sh, name, workNo) {
  const pq = sh.getRange(1, 16, Math.max(sh.getLastRow(), 3), 2).getValues();
  let workName = '';
  pq.forEach(function (r) { if (String(r[0]).trim() === workNo) workName = String(r[1]).trim(); });
  if (!workName) return;
  const lastRow = Math.max(sh.getLastRow(), 3);
  const vals = sh.getRange(1, MIRROR_COL, lastRow, 2).getValues();
  if (!String(vals[1][0] || '').trim()) sh.getRange(2, MIRROR_COL, 1, 2).setValues([['入力工事名', '正式工事名']]);
  const target = normName_(name);
  for (let i = 2; i < vals.length; i++) {
    if (normName_(vals[i][0]) === target) { sh.getRange(i + 1, MIRROR_COL + 1).setValue(workName); return; }
  }
  let row = 3;
  while (row <= vals.length && String(vals[row - 1][0] || '').trim()) row++;
  sh.getRange(row, MIRROR_COL, 1, 2).setValues([[name, workName]]);
}

function readAlias_(rows) {
  const alias = {};
  rows.forEach(function (r) {
    const name = normName_(r[ALIAS_COL - 1]);
    const no = String(r[ALIAS_COL] || '').trim();
    if (name && no && name !== normName_('入力名')) alias[name] = no;
  });
  return alias;
}

// 工事名称の別名を「各種情報」V:W列に追記する(同じ入力名があれば工事番号を上書き)。
// Excelダウンロードの記録: シート「記録」の2行目に挿入(常に2行目が最新、古いものほど下)。A=日時 / B=期間。
const LOG_SHEET_NAME = '記録';
function logDownload_(period) {
  const lock = LockService.getScriptLock();
  lock.waitLock(10000);
  try {
    let sh = ss_().getSheetByName(LOG_SHEET_NAME);
    if (!sh) {
      sh = ss_().insertSheet(LOG_SHEET_NAME);
      sh.getRange(1, 1, 1, 2).setValues([['日時', '期間']]);
    }
    sh.insertRowBefore(2);
    const now = Utilities.formatDate(new Date(), 'Asia/Tokyo', 'yyyy/MM/dd HH:mm:ss');
    sh.getRange(2, 1, 1, 2).setNumberFormat('@').setValues([[now, String(period || '')]]);
    return { logged: true, at: now };
  } finally {
    lock.releaseLock();
  }
}

function saveAlias_(name, workNo) {
  name = String(name || '').trim();
  workNo = String(workNo || '').trim();
  if (!name || !workNo) throw new Error('入力名と工事番号が必要です');
  const sh = infoSheet_();
  const lastRow = Math.max(sh.getLastRow(), 3);
  const vals = sh.getRange(1, ALIAS_COL, lastRow, 2).getValues();
  if (!String(vals[0][0] || '').trim()) sh.getRange(1, ALIAS_COL).setValue('工事名称の別名');
  if (!String(vals[1][0] || '').trim()) sh.getRange(2, ALIAS_COL, 1, 2).setValues([['入力名', '工事番号']]);
  const target = normName_(name);
  for (let i = 2; i < vals.length; i++) {
    if (normName_(vals[i][0]) === target) {
      sh.getRange(i + 1, ALIAS_COL + 1).setValue(workNo);
      mirrorAlias_(sh, name, workNo);
      refreshSnapshot_(true);
      return { saved: true, updated: true };
    }
  }
  let row = 3;
  while (row <= vals.length && String(vals[row - 1][0] || '').trim()) row++;
  sh.getRange(row, ALIAS_COL, 1, 2).setValues([[name, workNo]]);
  mirrorAlias_(sh, name, workNo);
  refreshSnapshot_(true);
  return { saved: true, updated: false };
}

// ========== フォルダ・キャッシュ ==========

function getCacheFolder_() {
  const props = PropertiesService.getScriptProperties();
  const cachedId = props.getProperty(CACHE_FOLDER_PROP);
  if (cachedId) {
    try { return DriveApp.getFolderById(cachedId); } catch (e) { /* 無効なら下で再取得 */ }
  }
  const parents = DriveApp.getFileById(ss_().getId()).getParents();
  const folder = parents.hasNext() ? parents.next() : DriveApp.getRootFolder();
  props.setProperty(CACHE_FOLDER_PROP, folder.getId());
  return folder;
}

function loadMasterCache_(folder) {
  const files = folder.getFilesByName(MASTER_CACHE_FILE_NAME);
  if (!files.hasNext()) return {};
  try { return JSON.parse(files.next().getBlob().getDataAsString()); } catch (e) { return {}; }
}

function saveMasterCache_(folder, cache) {
  const content = JSON.stringify(cache);
  const files = folder.getFilesByName(MASTER_CACHE_FILE_NAME);
  if (files.hasNext()) files.next().setContent(content);
  else folder.createFile(MASTER_CACHE_FILE_NAME, content, MimeType.PLAIN_TEXT);
}

// ========== xlsx内部のハイパーリンク抽出(実寸法師の絶対パス) ==========
// xlsx→スプレッドシート変換ではハイパーリンクが失われるため、元のxlsx(zip)を展開して
// 1シート目の<hyperlinks>とrelsから セル参照→URL を取得する(読み取りのみ)。

function columnIndexToLetter_(index0) {
  let n = index0 + 1;
  let letters = '';
  while (n > 0) {
    const rem = (n - 1) % 26;
    letters = String.fromCharCode(65 + rem) + letters;
    n = Math.floor((n - 1) / 26);
  }
  return letters;
}

function resolveRelTarget_(target, baseDir) {
  return target.charAt(0) === '/' ? target.slice(1) : baseDir + target;
}

function findFirstSheetPartName_(entriesByName) {
  const workbookXml = entriesByName['xl/workbook.xml'];
  const workbookRels = entriesByName['xl/_rels/workbook.xml.rels'];
  if (!workbookXml || !workbookRels) return 'xl/worksheets/sheet1.xml';
  const rNs = XmlService.getNamespace('r', 'http://schemas.openxmlformats.org/officeDocument/2006/relationships');
  const wbRoot = XmlService.parse(workbookXml.getDataAsString()).getRootElement();
  const sheetsEl = wbRoot.getChild('sheets', wbRoot.getNamespace());
  const firstSheet = sheetsEl && sheetsEl.getChildren('sheet', wbRoot.getNamespace())[0];
  const ridAttr = firstSheet && firstSheet.getAttribute('id', rNs);
  if (!ridAttr) return 'xl/worksheets/sheet1.xml';
  const relsRoot = XmlService.parse(workbookRels.getDataAsString()).getRootElement();
  let target = null;
  relsRoot.getChildren('Relationship', relsRoot.getNamespace()).some(function (rel) {
    if (rel.getAttribute('Id').getValue() === ridAttr.getValue()) {
      target = rel.getAttribute('Target').getValue();
      return true;
    }
    return false;
  });
  return target ? resolveRelTarget_(target, 'xl/') : 'xl/worksheets/sheet1.xml';
}

function extractHyperlinks_(blob) {
  try {
    const entries = Utilities.unzip(blob.copyBlob().setContentType('application/zip'));
    const byName = {};
    entries.forEach(function (e) { byName[e.getName()] = e; });
    const sheetPath = findFirstSheetPartName_(byName);
    const sheetXml = byName[sheetPath];
    if (!sheetXml) return {};
    const relsPath = sheetPath.replace(/^(.*\/)?([^/]+)$/, function (_, dir, file) { return (dir || '') + '_rels/' + file + '.rels'; });
    const relsEntry = byName[relsPath];
    const relMap = {};
    if (relsEntry) {
      const relsRoot = XmlService.parse(relsEntry.getDataAsString()).getRootElement();
      relsRoot.getChildren('Relationship', relsRoot.getNamespace()).forEach(function (rel) {
        const modeAttr = rel.getAttribute('TargetMode');
        if (modeAttr && modeAttr.getValue() === 'External') relMap[rel.getAttribute('Id').getValue()] = rel.getAttribute('Target').getValue();
      });
    }
    const rNs = XmlService.getNamespace('r', 'http://schemas.openxmlformats.org/officeDocument/2006/relationships');
    const sheetRoot = XmlService.parse(sheetXml.getDataAsString()).getRootElement();
    const hyperlinksEl = sheetRoot.getChild('hyperlinks', sheetRoot.getNamespace());
    const map = {};
    // 診断用: 0件のとき原因を切り分けられるよう、構造の概要を残す。
    const hlEls = hyperlinksEl ? hyperlinksEl.getChildren('hyperlink', sheetRoot.getNamespace()) : [];
    Object.defineProperty(map, '__diag', { enumerable: false, value: 'zip' + entries.length + '件/シート' + sheetPath + '/hyperlink要素' + hlEls.length + '件/外部rels' + Object.keys(relMap).length + '件/mime=' + blob.getContentType() });
    if (hyperlinksEl) {
      hyperlinksEl.getChildren('hyperlink', sheetRoot.getNamespace()).forEach(function (h) {
        const refAttr = h.getAttribute('ref');
        const ridAttr = h.getAttribute('id', rNs);
        if (!refAttr || !ridAttr) return;
        const url = relMap[ridAttr.getValue()];
        if (url) map[refAttr.getValue()] = url;
      });
    }
    return map;
  } catch (e) {
    return { __error: String((e && e.message) || e) };
  }
}

// ========== マスターExcel(変換後)の解析 ==========

// 元Excelは読み取りのみ。変換結果は同フォルダの作業用スプレッドシートへ(元ファイルには触れない)。
function convertToSheet_(sourceFileId, label, folder, currentMtime, sourceFile, workNo) {
  const props = PropertiesService.getScriptProperties();
  // 工事番号ごとに別の作業用シートを作る(同じファイルでも工事が差し替わったら新しいスプレッドシートを作り、古い工事の作業用シートは残す)。
  const propKey = 'rconv_' + sourceFileId + '_' + workNo;
  const mtimeKey = 'rmtime_' + sourceFileId + '_' + workNo;
  const existingId = props.getProperty(propKey);
  if (existingId && props.getProperty(mtimeKey) === currentMtime) {
    try { DriveApp.getFileById(existingId); return existingId; } catch (e) { /* 再変換 */ }
  }
  const blob = sourceFile.getBlob();
  if (existingId) {
    try {
      Drive.Files.update({}, existingId, blob);
      props.setProperty(mtimeKey, currentMtime);
      return existingId;
    } catch (e) { /* 新規作成へ */ }
  }
  const created = Drive.Files.create({ name: WORK_COPY_PREFIX + label, mimeType: MimeType.GOOGLE_SHEETS, parents: [folder.getId()] }, blob);
  props.setProperty(propKey, created.id);
  props.setProperty(mtimeKey, currentMtime);
  return created.id;
}

function dateCellToYmd_(v) {
  if (!(v instanceof Date) || isNaN(v.getTime()) || v.getFullYear() < 2019) return '';
  return Utilities.formatDate(v, TIMEZONE, 'yyyy-MM-dd');
}

// 1シート目を読み、製品ごとの記録 [{m, d, s, w, q, p, k, v, l}] を返す。
// m=製品マーク d=図番 s=サイズ w=重量(t) q=本数 p=部位 k=加工日 v=溶接日 l=実寸法師リンク
function parseMasterSheet_(convertedSheetId, hyperlinkMap) {
  const sh = SpreadsheetApp.openById(convertedSheetId).getSheets()[0];
  const lastRow = sh.getLastRow();
  const lastCol = sh.getLastColumn();
  if (lastRow < 2) return [];
  const header = sh.getRange(1, 1, 1, lastCol).getValues()[0].map(function (h) { return String(h || '').trim(); });
  const col = {};
  Object.keys(MASTER_HEADERS).forEach(function (k) { col[k] = header.indexOf(MASTER_HEADERS[k]); });
  if (col.mark < 0) return [];
  const idxs = Object.keys(col).map(function (k) { return col[k]; }).filter(function (c) { return c >= 0; });
  const maxCol = Math.max.apply(null, idxs) + 1;
  const n = lastRow - 1;
  const display = sh.getRange(2, 1, n, maxCol).getDisplayValues();
  const raw = sh.getRange(2, 1, n, maxCol).getValues();
  const drawingLetter = col.drawingNo >= 0 ? columnIndexToLetter_(col.drawingNo) : '';
  // 変換後のシートに残っているリンク(HYPERLINK関数・リッチテキストのリンク)も補助的に拾う。
  let drawFormulas = null;
  let drawRich = null;
  if (col.drawingNo >= 0) {
    const rng = sh.getRange(2, col.drawingNo + 1, n, 1);
    drawFormulas = rng.getFormulas();
    try { drawRich = rng.getRichTextValues(); } catch (e) { drawRich = null; }
  }
  const linkOf = function (i) {
    if (!drawingLetter) return '';
    const fromXml = hyperlinkMap[drawingLetter + (i + 2)];
    if (fromXml) return fromXml;
    const f = drawFormulas && drawFormulas[i][0];
    const m = f && String(f).match(/HYPERLINK\(\s*"([^"]+)"/i);
    if (m) return m[1];
    const u = drawRich && drawRich[i][0] && drawRich[i][0].getLinkUrl();
    return u || '';
  };
  const out = [];
  for (let i = 0; i < n; i++) {
    const mark = String(display[i][col.mark] || '').trim();
    if (!mark) continue;
    const w = col.weight >= 0 ? Number(raw[i][col.weight]) : 0;
    const q = col.qty >= 0 ? Number(raw[i][col.qty]) : 1;
    out.push({
      m: mark,
      d: col.drawingNo >= 0 ? String(display[i][col.drawingNo] || '').trim() : '',
      s: col.size >= 0 ? String(display[i][col.size] || '').trim() : '',
      w: isNaN(w) ? 0 : w,
      q: isNaN(q) || q <= 0 ? 1 : q,
      p: col.part >= 0 ? String(display[i][col.part] || '').trim() : '',
      k: col.processed >= 0 ? dateCellToYmd_(raw[i][col.processed]) : '',
      v: col.welded >= 0 ? dateCellToYmd_(raw[i][col.welded]) : '',
      l: linkOf(i),
    });
  }
  return out;
}

// 工事の差し替え(同じURLのExcelが別の工事に入れ替わる)で古い工事のデータが失われないよう、
// 読み込んだ工事ごとの製品データを工事番号ごとに保存し続ける(消さない)。
function loadArchive_(folder) {
  const files = folder.getFilesByName(ARCHIVE_FILE_NAME);
  if (!files.hasNext()) return {};
  try { return JSON.parse(files.next().getBlob().getDataAsString()); } catch (e) { return {}; }
}

function saveArchive_(folder, archive) {
  const content = JSON.stringify(archive);
  const files = folder.getFilesByName(ARCHIVE_FILE_NAME);
  if (files.hasNext()) files.next().setContent(content);
  else folder.createFile(ARCHIVE_FILE_NAME, content, MimeType.PLAIN_TEXT);
}

// リンク用フォルダ内のExcelを { 正規化した名前: {id, name} } で返す(読み取りのみ)。
function readLinkFiles_(warnings) {
  const map = {};
  try {
    listLinkFiles_().forEach(function (f) {
      if (!/\.(xlsx?|xlsm)$/i.test(f.name)) return;
      const key = baseKey_(f.name);
      if (!map[key]) map[key] = { id: f.id, name: f.name };
    });
  } catch (err) {
    warnings.push('リンク用フォルダを開けません: ' + err.message);
  }
  return map;
}

// 工事別マスターの記録をキャッシュ付きで読む。{ workNo: [records] }, warnings
function loadMasters_(folder, masterList) {
  const cache = loadMasterCache_(folder);
  const next = {};
  const result = {};
  const warnings = [];
  const linkedWorks = {};
  const archive = loadArchive_(folder);
  let archiveDirty = false;
  let changed = false;
  const linkFiles = readLinkFiles_(warnings);
  masterList.forEach(function (m) {
    // リンク入りマスター(同名のファイル)があればそれを読む。無ければ「各種情報」のURLのファイル(リンクなし)。
    const lk = linkFiles[baseKey_(m.fileName)] || linkFiles[baseKey_(m.workName || '')];
    const src = lk ? { fileId: lk.id, fileName: lk.name, linked: true } : { fileId: m.fileId, fileName: m.fileName, linked: false };
    let file;
    try { file = fileOf_(src.fileId); } catch (err) {
      warnings.push('「' + src.fileName + '」を開けません: ' + err.message);
      return;
    }
    const mtime = mtimeOf_(src.fileId);
    const c = cache[src.fileId + '|' + m.workNo];
    let records;
    if (c && c.mtime === mtime && c.v === MASTER_CACHE_VERSION) {
      records = c.records;
    } else {
      changed = true;
      try {
        const blob = file.getBlob();
        const links = extractHyperlinks_(blob);
        if (links.__error) warnings.push('「' + src.fileName + '」の図面リンク取得エラー: ' + links.__error);
        const sheetId = convertToSheet_(src.fileId, m.workNo + '_' + m.fileName, folder, mtime, file, m.workNo);
        records = parseMasterSheet_(sheetId, links);
      } catch (err) {
        warnings.push('「' + src.fileName + '」の読み込みに失敗: ' + err.message);
        return;
      }
    }
    next[src.fileId + '|' + m.workNo] = { mtime: mtime, v: MASTER_CACHE_VERSION, records: records };
    result[m.workNo] = (result[m.workNo] || []).concat(records);
    if (src.linked) linkedWorks[m.workNo] = true;
    const ar = archive[m.workNo];
    if (!ar || ar.mtime !== mtime || ar.fileName !== m.fileName) {
      archive[m.workNo] = { fileName: m.fileName, workName: m.workName || '', mtime: mtime, savedAt: Utilities.formatDate(new Date(), TIMEZONE, 'yyyy-MM-dd HH:mm'), records: records };
      archiveDirty = true;
    }
  });
  if (changed || Object.keys(cache).sort().join() !== Object.keys(next).sort().join()) saveMasterCache_(folder, next);
  if (archiveDirty) saveArchive_(folder, archive);
  return { records: result, warnings: warnings, linkedWorks: linkedWorks, archive: archive };
}

// ========== ロボ稼動実績の読み取り(読み取りのみ・毎回最新を読む) ==========

function readRobotRows_(robotNo, sheetId) {
  const sh = SpreadsheetApp.openById(sheetId).getSheets()[0];
  const lastRow = sh.getLastRow();
  const lastCol = sh.getLastColumn();
  if (lastRow < 2) return [];
  const values = sh.getRange(1, 1, lastRow, lastCol).getDisplayValues();
  const header = values[0].map(function (h) { return String(h || '').trim(); });
  const ix = {};
  Object.keys(ROBOT_HEADERS).forEach(function (k) {
    const found = header.indexOf(ROBOT_HEADERS[k][0]);
    ix[k] = found >= 0 ? found : ROBOT_HEADERS[k][1];
  });
  const rows = [];
  for (let i = 1; i < values.length; i++) {
    const r = values[i];
    if (String(r[ix.workName]).trim() === '工事名称') continue; // 貼り付け時に混ざる見出し行
    const sd = parseYmd_(r[ix.startDate]);
    if (!sd) continue;
    rows.push({
      r: robotNo,
      wn: String(r[ix.workName] || '').trim(),
      mk: String(r[ix.mark] || '').trim(),
      sd: sd,
      st: String(r[ix.startTime] || '').trim(),
      ed: parseYmd_(r[ix.endDate]) || sd,
      et: String(r[ix.endTime] || '').trim(),
      run: parseHms_(r[ix.run]),
      arc: parseHms_(r[ix.arc]),
      wire: Number(r[ix.wire]) || 0,
      len: Number(r[ix.len]) || 0,
    });
  }
  return rows;
}

// ========== 集計本体 ==========

function buildData_() {
  const sync = syncIndexRows_();
  const rows = readInfoRows_();
  const masterList = readMasterIndex_(rows);
  const robotSheets = readRobotSheets_(rows);
  const workNames = readWorkNames_(rows);
  const cal = readCalendarMin_(rows);
  const alias = readAlias_(rows);
  const folder = getCacheFolder_();

  masterList.forEach(function (m) { m.workName = workNames[m.workNo] || ''; });
  const loaded = loadMasters_(folder, masterList);
  const warnings = loaded.warnings.slice();
  sync.changes.forEach(function (c) { warnings.push('【更新】' + c); });
  sync.warnings.forEach(function (c) { warnings.push(c); });

  // 突き合わせ用の索引
  const works = [];
  const masterIndex = {};
  const workInfo = [];
  masterList.forEach(function (m) {
    const base = m.fileName.replace(/\.(xlsx?|xlsm)$/i, '');
    const names = [normName_(base)];
    if (workNames[m.workNo]) names.push(normName_(workNames[m.workNo]));
    if (!works.some(function (w) { return w.workNo === m.workNo; })) {
      works.push({ workNo: m.workNo, names: names });
      workInfo.push({ workNo: m.workNo, workName: workNames[m.workNo] || base, fileName: m.fileName });
    }
    const recs = loaded.records[m.workNo];
    if (recs && !masterIndex[m.workNo]) {
      const byMark = {};
      const marks = [];
      recs.forEach(function (r) {
        const key = normMark_(r.m);
        if (!byMark[key]) { byMark[key] = r; marks.push({ key: key, mark: r.m }); }
      });
      masterIndex[m.workNo] = { byMark: byMark, marks: marks };
    }
  });

  // 工事の差し替えで「各種情報」から消えた工事も、保存済みの製品データで突き合わせを続ける(過去の期間を再現するため)。
  Object.keys(loaded.archive || {}).forEach(function (workNo) {
    if (works.some(function (w) { return w.workNo === workNo; })) return;
    const a = loaded.archive[workNo];
    const names = [baseKey_(a.fileName)];
    if (a.workName) names.push(normName_(a.workName));
    if (workNames[workNo]) names.push(normName_(workNames[workNo]));
    works.push({ workNo: workNo, names: names });
    workInfo.push({ workNo: workNo, workName: workNames[workNo] || a.workName || a.fileName, fileName: a.fileName, archived: true });
    const byMark = {};
    const marks = [];
    (a.records || []).forEach(function (r) {
      const key = normMark_(r.m);
      if (!byMark[key]) { byMark[key] = r; marks.push({ key: key, mark: r.m }); }
    });
    masterIndex[workNo] = { byMark: byMark, marks: marks };
  });

  // ロボ稼動実績 → 突き合わせ
  const outRows = [];
  const products = {}; // 'workNo|mark' → 製品情報
  robotSheets.slice(0, 2).forEach(function (rs, idx) {
    let rr;
    try { rr = readRobotRows_(idx + 1, rs.id); } catch (err) {
      warnings.push((idx + 1) + '号機の稼動実績を読み込めません: ' + err.message);
      return;
    }
    rr.forEach(function (row) {
      if (row.sd < cal.min) return; // 会社カレンダーの最初の日より前は集計しない
      const res = resolveRow_(row, works, alias, masterIndex);
      const o = { r: row.r, wn: row.wn, mk: row.mk, sd: row.sd, st: row.st, ed: row.ed, et: row.et, run: row.run, arc: row.arc, wire: row.wire, len: row.len, no: res.workNo, s: res.status, al: alias[normName_(row.wn)] ? 1 : 0 }; // al=1: 別名表(V:W)に登録済みの入力名
      if (res.status === 'ok') {
        o.pk = res.workNo + '|' + res.product.m;
        if (!products[o.pk]) products[o.pk] = res.product;
      } else if (res.status === 'suggest') {
        o.sg = res.suggestions;
      }
      outRows.push(o);
    });
  });

  // 候補として出した製品マークの情報も渡す(画面で選んだ時に製品を確定できるように)
  outRows.forEach(function (o) {
    (o.sg || []).forEach(function (mk) {
      const k = o.no + '|' + mk;
      if (!products[k]) {
        const mi = masterIndex[o.no];
        if (mi && mi.byMark[normMark_(mk)]) products[k] = mi.byMark[normMark_(mk)];
      }
    });
  });

  return {
    generatedAt: Utilities.formatDate(new Date(), TIMEZONE, "yyyy-MM-dd'T'HH:mm:ssXXX"),
    calendarMin: cal.min,
    calendarMax: cal.max,
    works: workInfo,
    rows: outRows,
    products: products,
    warnings: warnings,
  };
}

// ========== 結果の保存(スナップショット) ==========
// 画面を開くたびに集計し直さず、保存済みの結果を返す。更新確認(トリガー/更新ボタン)のときだけ、
// 元データが変わっていれば作り直して保存する。

const SNAP_ID_PROP = 'SNAPSHOT_FILE_ID';
const SNAP_CACHE_KEY = 'snapData';
const SNAP_CHUNK = 30000; // CacheServiceは1キー100KBまで(日本語は3バイト/字)

function getSnapshotFile_(folder) {
  const props = PropertiesService.getScriptProperties();
  const id = props.getProperty(SNAP_ID_PROP);
  if (id) { try { return DriveApp.getFileById(id); } catch (e) { /* 無効なら検索し直す */ } }
  const files = folder.getFilesByName(SNAPSHOT_FILE_NAME);
  if (!files.hasNext()) return null;
  const f = files.next();
  props.setProperty(SNAP_ID_PROP, f.getId());
  return f;
}

function loadSnapshot_(folder) {
  const f = getSnapshotFile_(folder);
  if (!f) return null;
  try { return JSON.parse(f.getBlob().getDataAsString()); } catch (e) { return null; }
}

function saveSnapshot_(folder, snap) {
  const content = JSON.stringify(snap);
  const f = getSnapshotFile_(folder);
  if (f) f.setContent(content);
  else PropertiesService.getScriptProperties().setProperty(SNAP_ID_PROP, folder.createFile(SNAPSHOT_FILE_NAME, content, MimeType.PLAIN_TEXT).getId());
  putSnapshotCache_(JSON.stringify(snap.data));
}

function putSnapshotCache_(text) {
  try {
    const cache = CacheService.getScriptCache();
    const n = Math.ceil(text.length / SNAP_CHUNK);
    const obj = {};
    for (let i = 0; i < n; i++) obj[SNAP_CACHE_KEY + i] = text.substr(i * SNAP_CHUNK, SNAP_CHUNK);
    obj[SNAP_CACHE_KEY + 'n'] = String(n);
    cache.putAll(obj, 21600);
  } catch (e) { /* キャッシュできなくても動作は続ける */ }
}

function getSnapshotCache_() {
  try {
    const cache = CacheService.getScriptCache();
    const n = Number(cache.get(SNAP_CACHE_KEY + 'n'));
    if (!n) return null;
    const keys = [];
    for (let i = 0; i < n; i++) keys.push(SNAP_CACHE_KEY + i);
    const got = cache.getAll(keys);
    let out = '';
    for (let i = 0; i < n; i++) { if (got[keys[i]] == null) return null; out += got[keys[i]]; }
    return out;
  } catch (e) { return null; }
}

// 元データの「更新の目印」: 稼動実績2本・「各種情報」・リンク用フォルダ内の各Excelの最終更新日時。
function computeFingerprint_() {
  const parts = [];
  const rows = readInfoRows_();
  readRobotSheets_(rows).forEach(function (r) {
    try { parts.push(mtimeOf_(r.id)); } catch (e) { parts.push('x'); }
  });
  try { parts.push(mtimeOf_(ss_().getId())); } catch (e) { parts.push('x'); }
  try {
    parts.push(listLinkFiles_().map(function (f) { return f.name + ':' + f.mtime; }).sort().join(','));
  } catch (e) { parts.push('x'); }
  readMasterIndex_(rows).forEach(function (m) {
    try { parts.push(mtimeOf_(m.fileId)); } catch (e) { parts.push('x'); }
  });
  parts.push('logic' + SNAPSHOT_LOGIC_VERSION);
  return parts.join('|');
}

// 画面表示用: 保存済みの結果をそのまま返す(無ければ初回のみ作る)。
function getSnapshotText_() {
  const cached = getSnapshotCache_();
  if (cached) return cached;
  const folder = getCacheFolder_();
  const snap = loadSnapshot_(folder);
  const text = JSON.stringify(snap && snap.data ? snap.data : refreshSnapshot_(true));
  putSnapshotCache_(text);
  return text;
}

// 更新確認: 元データが変わっていれば作り直して保存、変わっていなければ保存済みをそのまま返す。
function refreshSnapshot_(force) {
  const lock = LockService.getScriptLock();
  lock.waitLock(240000);
  try {
    const t0 = Date.now();
    const folder = getCacheFolder_();
    const fp = computeFingerprint_();
    const t1 = Date.now();
    const snap = loadSnapshot_(folder);
    if (!force && snap && snap.fp === fp && snap.data) {
      return Object.assign({}, snap.data, { timing: { fingerprintMs: t1 - t0, rebuilt: false, totalMs: Date.now() - t0 } });
    }
    const data = buildData_();
    const t2 = Date.now();
    saveSnapshot_(folder, { fp: fp, data: data });
    const t3 = Date.now();
    // 所要時間(ミリ秒)の内訳。画面のコンソール(F12)で確認できる。保存する結果には含めない。
    return Object.assign({}, data, { timing: { fingerprintMs: t1 - t0, buildMs: t2 - t1, saveMs: t3 - t2, rebuilt: true, totalMs: t3 - t0 } });
  } finally {
    lock.releaseLock();
  }
}

// マスター(Excel)の再読み込みだけを行う(キャッシュ更新用。毎日のトリガーからも呼ぶ)。
function refreshMasters_() {
  syncIndexRows_();
  const folder = getCacheFolder_();
  const loaded = loadMasters_(folder, readMasterIndex_(readInfoRows_()));
  return { masters: Object.keys(loaded.records).length, warnings: loaded.warnings };
}

// 作業用スプレッドシート(_作業用_梁ロボ_*)のうち、今の読み込みで使っていない古いものをゴミ箱へ移す(完全削除はしない)。
// 使用中 = スクリプトプロパティ rconv_<ファイルID>_<工事番号> に記録されているもの。毎朝の更新確認の最後にも実行する。
function cleanupWorkCopies() {
  const props = PropertiesService.getScriptProperties();
  const all = props.getProperties();
  const used = {};
  Object.keys(all).forEach(function (k) {
    if (/^rconv_.+_\d{2}-\d{1,2}[A-Za-z]{0,2}$/.test(k)) used[all[k]] = true;
    else if (/^(rconv_|rmtime_)/.test(k) && !/^rmtime_.+_\d{2}-\d{1,2}[A-Za-z]{0,2}$/.test(k)) props.deleteProperty(k); // 旧形式の記録
  });
  const it = getCacheFolder_().getFiles();
  const trashed = [];
  while (it.hasNext()) {
    const f = it.next();
    if (f.getName().indexOf(WORK_COPY_PREFIX) !== 0 || used[f.getId()]) continue;
    f.setTrashed(true);
    trashed.push(f.getName());
  }
  Logger.log('ゴミ箱へ移した古い作業用シート: ' + trashed.length + '件');
  return trashed;
}

// トリガーから呼ばれる更新確認(元データが変わっていれば作り直して保存する)。
function dailyRefresh() {
  refreshSnapshot_(false);
  cleanupWorkCopies();
}

// エディタから1回だけ実行する。毎朝9時に更新確認を行う(前日分の記録は毎朝8時以降に更新されるため、9時で足りる)。
function createDailyTrigger() {
  ScriptApp.getProjectTriggers().forEach(function (t) {
    if (t.getHandlerFunction() === 'dailyRefresh') ScriptApp.deleteTrigger(t);
  });
  ScriptApp.newTrigger('dailyRefresh').timeBased().atHour(9).nearMinute(0).everyDays(1).create();
  Logger.log('毎朝9時に更新確認するトリガーを設定しました。');
}

// Apps Scriptエディタから手動で実行して、構成を確認する。
function checkSetup() {
  const rows = readInfoRows_();
  const cal = readCalendarMin_(rows);
  Logger.log('工事マスター: ' + readMasterIndex_(rows).length + '件 / ロボ稼動実績: ' + readRobotSheets_(rows).length + '件');
  Logger.log('工事名リスト: ' + Object.keys(readWorkNames_(rows)).length + '件 / カレンダー: ' + cal.min + ' 〜 ' + cal.max);
  Logger.log('別名表: ' + Object.keys(readAlias_(rows)).length + '件');
  Logger.log('作業用ファイルの保存先: ' + getCacheFolder_().getName());
}
