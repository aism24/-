/**
 * 「実寸法師を開く」(製品マーク検索→CAD図面(実寸法師)起動アプリ)のGAS APIバックエンド。
 *
 * このスクリプトは、「マスタから実寸法師を開く」スプレッドシートの
 * 「拡張機能→Apps Script」から作成するコンテナバインド型スクリプトとして使う前提です。
 * SpreadsheetApp.getActiveSpreadsheet()で自分自身のスプレッドシートを参照するため、
 * SPREADSHEET_IDの設定は不要です。
 *
 * このアプリ本体(index.html / app.js)はフロントエンド(GitHub Pages)で、GASは
 * JSON APIのみを提供します(検索・表示・CAD起動リンクへの遷移はすべてブラウザ側で行います)。
 *
 * ■ 読み取り専用の原則
 *   案件ごとのマスターExcelファイルは常に「読み取り専用」で開きます。書き込みは一切行いません。
 *   xlsx→Googleスプレッドシート変換が必要な処理では、このスプレッドシートと同じフォルダ内に
 *   作業用のスプレッドシートを作成(既存があれば内容だけ上書き)しますが、元のExcelファイル
 *   本体には一切触れません。
 *
 * ■ 前提となる「情報」シートの構成(1行目が見出し。手動で用意されている想定):
 *   A列: No(参考情報。アプリのロジックでは使用しない)
 *   B列: ファイル名
 *   C列: URL(案件マスターExcelファイルへのGoogleドライブ共有リンク)
 *   D列: 工事番号
 *   E列: 工事名
 *   F列: マスタ場所(例: 鳥取/姫路)
 *   H列: 表示工事番号、I列: 表示工事名(=SORT(UNIQUE(FILTER(D2:E, D2:D<>"")))等の数式で、
 *        案件マスターExcelがある工事番号・工事名の一覧を手動で用意したもの。フロントエンドの
 *        「検索可能な工事一覧」表示にのみ使用する)
 *   (G列・L:M列等、上記以外は他の用途の一覧のため、このアプリでは使用しない)
 *
 * ■ 案件マスターExcelファイルの列構成(各行=部材1つ。1行目が見出し):
 *   ﾏｽﾀｰﾃﾞｰﾀ ID, 建方日, ブロック, 部位, 加工先, 図番, 製品マーク, サイズ, 備考①, 備考②,
 *   長さ, 本数, 重量, 塗装, 形状, ... (以降は工程管理用の列で、このアプリでは使用しない)
 *   列の並び順はファイルによって多少ずれても、見出し文字列で自動判定します。
 *   セルの値は表示されている通りの文字列(getDisplayValues)としてそのまま読み取ります。
 *
 * ■ 図番のハイパーリンク(CAD起動リンク)
 *   図番セルには、実寸法師(CAD)の図面ファイル(.tdf等)への絶対パス
 *   (例: file://192.168.1.2/share/.../EA1-0C-01　260619.tdf)がハイパーリンクとして
 *   設定されている行があります(全行には無く、図面が未作成の行は無し)。
 *   xlsx→Googleスプレッドシート変換(Drive.Files.create)ではこのハイパーリンクが失われる
 *   ことが確認されているため、変換後のシートからは取得せず、元のxlsxファイル(zip形式)を
 *   Utilities.unzipで直接展開し、ワークシートXML内の<hyperlinks>要素と関係定義(.rels)から
 *   セル参照(例:"F123")→URLの対応を抽出する(extractHyperlinks_)。ハイパーリンクが無い行は、
 *   フロントエンド側で「図面作成未完」として案内されます。
 *
 * セットアップ手順は README.md を参照してください。
 */

// ========== 設定 ==========

const INFO_SHEET_NAME = '情報';
const CACHE_FILE_NAME = '_cache_jissunpoushi.json';
const RECORDS_CACHE_FILE_NAME = '_records_cache_jissunpoushi.json';
// records(案件ごとの読み込み結果キャッシュ)の形式を変える際にインクリメントする。
const RECORDS_CACHE_VERSION = 4;
const WORK_COPY_PREFIX = '_作業用_実寸法師_';
const TIMEZONE = 'Asia/Tokyo';

// 案件マスターExcelの列見出し(この文字列で列位置を特定する)。
const HEADERS = {
  erectionDate: '建方日',
  block: 'ブロック',
  drawingNo: '図番',
  mark: '製品マーク',
  processedDate: '加工',
};

// ========== エントリーポイント(JSON API) ==========

function doGet(e) {
  try {
    const action = (e && e.parameter && e.parameter.action) || 'getData';
    if (action === 'getData') return ok_(getData_());
    if (action === 'refresh') return userRefresh_();
    return errRes_('不明なaction: ' + action);
  } catch (err) {
    return errRes_(err.message);
  }
}

function jsonResponse_(payload) {
  return ContentService.createTextOutput(JSON.stringify(payload)).setMimeType(ContentService.MimeType.JSON);
}
function ok_(data) { return jsonResponse_({ status: 'success', data: data }); }
function errRes_(message) { return jsonResponse_({ status: 'error', message: message }); }
function busyRes_(message) { return jsonResponse_({ status: 'busy', message: message }); }

// キャッシュがあればそれを返し、無ければ初回のみ集計する。
// searchableProjects(「情報」シートH:I列の一覧。ヘッダーの「検索可能な工事一覧」表示用)は
// 集計キャッシュとは別に、呼び出しのたびに直接シートから読み直す(読み取りが軽く、シート編集
// (SORT/UNIQUE数式の再計算含む)が即座に反映されてほしいため、Excel集計キャッシュの更新
// タイミングとは連動させない)。
function getData_() {
  const folder = dataFolder_();
  const cached = loadCache_(folder);
  const data = cached || refreshAndGetData_(folder);
  data.searchableProjects = readSearchableProjects_();
  return data;
}

// getData_(初回・キャッシュが無い場合のみ)、および毎日の自動トリガー(dailyRefresh)から
// 呼ばれる本体処理。スクリプトロックで直列化し、後発の呼び出しは先発の完了を待ってから
// 実行する(同時に複数走ってキャッシュファイルの読み書きが競合するのを防ぐ)。
function refreshAndGetData_(folder) {
  const lock = LockService.getScriptLock();
  lock.waitLock(120000);
  try {
    const targetFolder = folder || dataFolder_();
    const data = buildData_(targetFolder);
    saveCache_(targetFolder, data);
    return data;
  } finally {
    lock.releaseLock();
  }
}

// 「最新化」ボタン(action=refresh)専用のエントリーポイント。他の集計が実行中で
// ロックが取れない場合は、待たずにその場で「他の人が更新中」を返す。
function userRefresh_() {
  const lock = LockService.getScriptLock();
  if (!lock.tryLock(3000)) {
    return busyRes_('他の人がデータを更新中です。完了までしばらくお待ちください(通常は数十秒程度で終わります)。');
  }
  try {
    const folder = dataFolder_();
    const data = buildData_(folder);
    saveCache_(folder, data);
    data.searchableProjects = readSearchableProjects_();
    return ok_(data);
  } finally {
    lock.releaseLock();
  }
}

// 時間主導トリガー用のエントリーポイント。
function dailyRefresh() {
  refreshAndGetData_();
}

// Apps Scriptエディタから手動で1回実行して、毎日早朝の自動更新トリガーを設定する。
function createDailyTrigger() {
  ScriptApp.getProjectTriggers().forEach(function (t) {
    if (t.getHandlerFunction() === 'dailyRefresh') ScriptApp.deleteTrigger(t);
  });
  ScriptApp.newTrigger('dailyRefresh').timeBased().atHour(5).nearMinute(0).everyDays(1).create();
  Logger.log('毎日5:00頃に自動更新するトリガーを設定しました。');
}

// Apps Scriptエディタから手動で実行して、「情報」シートの構成を確認する。
function checkSetup() {
  const files = readFileIndex_();
  Logger.log('「' + INFO_SHEET_NAME + '」シートの案件マスターファイル: ' + files.length + '件');
  files.forEach(function (f) {
    Logger.log('  - [' + f.workNo + '] ' + f.workName + ' (' + f.fileName + ')');
  });
  if (files.length === 0) {
    Logger.log('警告: 「' + INFO_SHEET_NAME + '」シートに有効な行(ファイル名・URL列とも入力済み)が見つかりません。');
  }
  const projects = readSearchableProjects_();
  Logger.log('「検索可能な工事一覧」(H:I列): ' + projects.length + '件');
  const folder = dataFolder_();
  Logger.log('作業用ファイル・キャッシュの保存先フォルダ: ' + folder.getName() + ' (' + folder.getId() + ')');
}

// 「サービス」にDrive APIを追加しただけでは、そのサービスへのアクセス権(OAuth承認)が
// まだ一度も許可されていないことがある(checkSetup等、Driveサービスを使わない関数を実行
// しただけでは承認画面が出ないため)。この関数をApps Scriptエディタから手動で1回▶実行し、
// 表示される「アクセスの承認」画面で許可してください(読み取り専用のDrive.About.get()を
// 呼ぶだけで、データの変更は一切行いません)。これを行わないと、デプロイ済みのWebアプリから
// Driveサービスを呼び出した際に「Drive is not defined」エラーになることがあります。
function authorizeDriveService() {
  const about = Drive.About.get();
  Logger.log('Drive APIへのアクセスを確認しました。利用者: ' + about.user.displayName);
}

// ========== 「情報」シートの読み取り ==========

function ss_() { return SpreadsheetApp.getActiveSpreadsheet(); }

// このスプレッドシートが置かれているフォルダ(=キャッシュ・作業用ファイルの保存先)。
function dataFolder_() {
  const file = DriveApp.getFileById(ss_().getId());
  const parents = file.getParents();
  return parents.hasNext() ? parents.next() : DriveApp.getRootFolder();
}

function extractFileIdFromUrl_(url) {
  const m = String(url || '').match(/\/d\/([a-zA-Z0-9_-]+)/);
  return m ? m[1] : '';
}

// 「情報」シートのA:F列(No/ファイル名/URL/工事番号/工事名/マスタ場所)を読む。
// ファイル名またはURLが空の行(未入力の枠)は無視する。
function readFileIndex_() {
  const sh = ss_().getSheetByName(INFO_SHEET_NAME);
  if (!sh) throw new Error('「' + INFO_SHEET_NAME + '」シートが見つかりません');
  const lastRow = sh.getLastRow();
  if (lastRow < 2) return [];

  const rows = sh.getRange(2, 1, lastRow - 1, 6).getValues(); // A:F
  const list = [];
  rows.forEach(function (row) {
    const fileName = String(row[1] || '').trim();
    const url = String(row[2] || '').trim();
    const workNo = String(row[3] || '').trim();
    const workName = String(row[4] || '').trim();
    const masterLocation = String(row[5] || '').trim();
    if (!fileName || !url) return;
    const fileId = extractFileIdFromUrl_(url);
    if (!fileId) return;
    list.push({ fileId: fileId, fileName: fileName, workNo: workNo, workName: workName, masterLocation: masterLocation });
  });
  return list;
}

// 「情報」シートのH:I列(表示工事番号/表示工事名。=SORT(UNIQUE(FILTER(D2:E, D2:D<>"")))で
// 案件マスターExcelがある工事番号・工事名の一覧を手動で数式化したもの)を読む。
// ヘッダーの「検索可能な工事一覧」表示にのみ使用する(検索・集計のロジックには使わない)。
function readSearchableProjects_() {
  const sh = ss_().getSheetByName(INFO_SHEET_NAME);
  if (!sh) return [];
  const lastRow = sh.getLastRow();
  if (lastRow < 2) return [];

  const rows = sh.getRange(2, 8, lastRow - 1, 2).getValues(); // H:I
  const list = [];
  rows.forEach(function (row) {
    const workNo = String(row[0] || '').trim();
    const workName = String(row[1] || '').trim();
    if (workNo || workName) list.push({ workNo: workNo, workName: workName });
  });
  return list;
}

// ========== Excel→Googleスプレッドシート変換(読み取り専用の元ファイルには触れない) ==========

// 変換結果のスプレッドシートIDと、変換時点の元Excelファイルの最終更新日時をスクリプト
// プロパティに記憶しておく。次回以降、元ファイルの最終更新日時が前回と変わっていなければ
// 変換処理そのものをスキップし、前回変換済みのスプレッドシートをそのまま再利用する。
function convertToSheet_(sourceFileId, label, folder, currentMtime, blob) {
  const props = PropertiesService.getScriptProperties();
  const propKey = 'conv_' + sourceFileId;
  const mtimeKey = 'mtime_' + sourceFileId;
  const lastMtime = props.getProperty(mtimeKey);
  const existingId = props.getProperty(propKey);

  if (existingId && lastMtime === currentMtime) {
    try {
      DriveApp.getFileById(existingId); // 作業用ファイルがまだ存在するかだけ確認する(軽量)
      return existingId;
    } catch (e) {
      // 作業用ファイルが手動で削除されていた場合は、下の再変換にフォールバックする。
    }
  }

  if (existingId) {
    try {
      Drive.Files.update({}, existingId, blob);
      props.setProperty(mtimeKey, currentMtime);
      return existingId;
    } catch (e) {
      // 作業用ファイルが手動で削除されている等の場合は、新規作成にフォールバックする。
    }
  }

  const created = Drive.Files.create(
    { name: WORK_COPY_PREFIX + label, mimeType: MimeType.GOOGLE_SHEETS, parents: [folder.getId()] },
    blob
  );
  props.setProperty(propKey, created.id);
  props.setProperty(mtimeKey, currentMtime);
  return created.id;
}

// ========== 案件ごとの集計結果(records)のキャッシュ ==========
// ファイル更新日時が前回と変わっていなければ、変換だけでなく解析(parseMasterSheet_)自体を
// 丸ごとスキップし、前回のrecordsをそのまま使い回す。
function loadRecordsCache_(folder) {
  const files = folder.getFilesByName(RECORDS_CACHE_FILE_NAME);
  if (!files.hasNext()) return {};
  try {
    return JSON.parse(files.next().getBlob().getDataAsString());
  } catch (e) {
    return {};
  }
}

function saveRecordsCache_(folder, cache) {
  const content = JSON.stringify(cache);
  const files = folder.getFilesByName(RECORDS_CACHE_FILE_NAME);
  if (files.hasNext()) {
    files.next().setContent(content);
  } else {
    folder.createFile(RECORDS_CACHE_FILE_NAME, content, MimeType.PLAIN_TEXT);
  }
}

// ========== xlsx内部のハイパーリンク抽出 ==========
// xlsx→Googleスプレッドシート変換ではハイパーリンクが失われるため、元のxlsx(zip形式)を
// 直接展開し、ワークシートXML内の<hyperlinks>要素と関係定義(.rels)からセル参照→URLの
// 対応を取得する。

// 列インデックス(0始まり)をExcelの列文字(A, B, ..., Z, AA, ...)に変換する。
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

// Relationshipの Target を実際のzipエントリ名(パッケージルートからのフルパス)に解決する。
// OOXMLの仕様上、Targetが"/"始まりならパッケージルートからの絶対パス、それ以外は基準
// パート(baseDir、末尾"/"付き)からの相対パスとして扱う必要がある
// (実データで workbook.xml.rels の Target が "/xl/worksheets/sheet1.xml" という絶対パス
// 形式になっているケースを確認済みのため、相対パスと決め打ちしない)。
function resolveRelTarget_(target, baseDir) {
  return target.charAt(0) === '/' ? target.slice(1) : baseDir + target;
}

// xl/workbook.xmlと関係定義(xl/_rels/workbook.xml.rels)から、1シート目の実体パートの
// フルパス(例:"xl/worksheets/sheet2.xml"。シートの削除・並べ替えの履歴によっては
// "sheet1.xml"と決め打ちできないため、正規の手順で解決する)を求める。
function findFirstSheetPartName_(entriesByName) {
  const workbookXml = entriesByName['xl/workbook.xml'];
  const workbookRels = entriesByName['xl/_rels/workbook.xml.rels'];
  if (!workbookXml || !workbookRels) return 'xl/worksheets/sheet1.xml'; // 想定外の構成へのフォールバック

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

// xlsx(zip形式)を展開し、1シート目の外部ハイパーリンクを { "F123": "file://..." } の形式
// (セル参照→URL)で返す。解析に失敗した場合は空のオブジェクトを返す(致命的にはしない。
// 図面リンクが無い扱いになるだけ)。1つのリンクが複数セルにまたがる(ref="F3:F5"等)ケースは
// 想定していない(このアプリのデータでは1行1リンクの前提)。
function extractHyperlinks_(blob) {
  try {
    const entries = Utilities.unzip(blob);
    const entriesByName = {};
    entries.forEach(function (e) { entriesByName[e.getName()] = e; });

    const sheetPath = findFirstSheetPartName_(entriesByName); // 例: "xl/worksheets/sheet1.xml"
    const sheetXml = entriesByName[sheetPath];
    if (!sheetXml) return {};

    const relsPath = sheetPath.replace(/^(.*\/)?([^/]+)$/, function (_, dir, file) {
      return (dir || '') + '_rels/' + file + '.rels';
    });
    const relsEntry = entriesByName[relsPath];
    const relMap = {}; // rId -> 外部URL(TargetMode="External"のもののみ)
    if (relsEntry) {
      const relsRoot = XmlService.parse(relsEntry.getDataAsString()).getRootElement();
      relsRoot.getChildren('Relationship', relsRoot.getNamespace()).forEach(function (rel) {
        const modeAttr = rel.getAttribute('TargetMode');
        if (modeAttr && modeAttr.getValue() === 'External') {
          relMap[rel.getAttribute('Id').getValue()] = rel.getAttribute('Target').getValue();
        }
      });
    }

    const rNs = XmlService.getNamespace('r', 'http://schemas.openxmlformats.org/officeDocument/2006/relationships');
    const sheetRoot = XmlService.parse(sheetXml.getDataAsString()).getRootElement();
    const hyperlinksEl = sheetRoot.getChild('hyperlinks', sheetRoot.getNamespace());
    const map = {};
    if (hyperlinksEl) {
      hyperlinksEl.getChildren('hyperlink', sheetRoot.getNamespace()).forEach(function (h) {
        const refAttr = h.getAttribute('ref');
        const ridAttr = h.getAttribute('id', rNs);
        if (!refAttr || !ridAttr) return; // location(シート内リンク)のみの行は対象外
        const url = relMap[ridAttr.getValue()];
        if (url) map[refAttr.getValue()] = url;
      });
    }
    return map;
  } catch (e) {
    return {};
  }
}

// 建方日・加工列は、実際の日付が入っているセルだけ和暦(令和)の「R○年○月○日」表記に
// 変換する。日付になっていないセル(未加工を表す「*」や、一部ファイルにある0扱いの
// 日付データ等)は、表示されている通りの文字列(displayText)をそのまま使い、isUnclearを
// trueにする(フロントエンドで赤文字表示・備考への「日付不明」追記に使う)。
function isValidEraDate_(rawValue) {
  return Object.prototype.toString.call(rawValue) === '[object Date]' && !isNaN(rawValue.getTime()) && rawValue.getFullYear() >= 2019;
}
function formatEraDate_(rawValue, displayText) {
  if (isValidEraDate_(rawValue)) {
    const y = rawValue.getFullYear();
    return { text: 'R' + (y - 2018) + '年' + (rawValue.getMonth() + 1) + '月' + rawValue.getDate() + '日', isUnclear: false };
  }
  // 日付シリアル値が0付近(未入力のまま日付書式だけが残っているセル)は、スプレッドシート上
  // 西暦1899〜1900年頃の日付として表示される("12/30(土)"等、一見すると日付のように見える
  // 紛らわしい文字列になる)。これは実質「未入力」なので、赤文字・備考の「日付不明」表示には
  // せず、素直に空欄として扱う。
  if (Object.prototype.toString.call(rawValue) === '[object Date]' && !isNaN(rawValue.getTime()) && rawValue.getFullYear() <= 1900) {
    return { text: '', isUnclear: false };
  }
  return { text: displayText, isUnclear: !!displayText };
}

// 見出し行の文字列で列位置を特定するため、ファイルごとの多少の列ズレを吸収できる。
// セルは表示されている通りの文字列(getDisplayValues)として読み取り、図番のハイパーリンクは
// hyperlinkMap(元のxlsxから抽出済み、セル参照→URL)から、建方日・加工列だけは和暦変換用に
// 実際の値(getValues)を別途取得する。
function parseMasterSheet_(convertedSheetId, workNo, workName, masterLocation, fileName, hyperlinkMap) {
  const ss = SpreadsheetApp.openById(convertedSheetId);
  const sh = ss.getSheets()[0];
  const values = sh.getDataRange().getDisplayValues();
  if (values.length < 2) return [];

  const header = values[0].map(function (h) { return String(h || '').trim(); });
  const col = {};
  Object.keys(HEADERS).forEach(function (key) { col[key] = header.indexOf(HEADERS[key]); });
  if (col.mark < 0 || col.drawingNo < 0) return []; // 検索・CADリンクに必須の列が無いファイルは対象外

  const drawingColLetter = columnIndexToLetter_(col.drawingNo);
  const erectionRaw = col.erectionDate >= 0 ? sh.getRange(2, col.erectionDate + 1, sh.getLastRow() - 1, 1).getValues() : null;
  const processedRaw = col.processedDate >= 0 ? sh.getRange(2, col.processedDate + 1, sh.getLastRow() - 1, 1).getValues() : null;

  const records = [];
  for (let i = 1; i < values.length; i++) {
    const row = values[i];
    const mark = String(row[col.mark] || '').trim();
    if (!mark) continue; // 製品マークが空の行は除外

    const cellRef = drawingColLetter + (i + 1); // 元のxlsxでの行番号(見出し行=1行目を含む)
    const erectionDisplay = col.erectionDate >= 0 ? String(row[col.erectionDate] || '').trim() : '';
    const processedDisplay = col.processedDate >= 0 ? String(row[col.processedDate] || '').trim() : '';
    const erection = formatEraDate_(erectionRaw && erectionRaw[i - 1][0], erectionDisplay);
    const processed = formatEraDate_(processedRaw && processedRaw[i - 1][0], processedDisplay);

    records.push({
      workNo: workNo,
      workName: workName,
      masterLocation: masterLocation,
      fileName: fileName,
      mark: mark,
      drawingNo: String(row[col.drawingNo] || '').trim(),
      drawingLink: hyperlinkMap[cellRef] || '',
      erectionDate: erection.text,
      erectionDateUnclear: erection.isUnclear,
      block: col.block >= 0 ? String(row[col.block] || '').trim() : '',
      processedDate: processed.text,
      processedDateUnclear: processed.isUnclear,
    });
  }
  return records;
}

// ========== 集計本体 ==========

function buildData_(folder) {
  const fileIndex = readFileIndex_();
  const warnings = [];
  const recordsCache = loadRecordsCache_(folder);
  const newRecordsCache = {};
  const allRecords = [];

  fileIndex.forEach(function (entry) {
    let driveFile;
    try {
      driveFile = DriveApp.getFileById(entry.fileId);
    } catch (err) {
      warnings.push('「' + entry.fileName + '」の読み込みに失敗しました: ' + err.message);
      return;
    }
    const currentMtime = String(driveFile.getLastUpdated().getTime());

    const cached = recordsCache[entry.fileId];
    let records;
    if (cached && cached.mtime === currentMtime && cached.v === RECORDS_CACHE_VERSION) {
      records = cached.records;
    } else {
      try {
        const blob = driveFile.getBlob();
        const hyperlinkMap = extractHyperlinks_(blob);
        const convertedId = convertToSheet_(entry.fileId, entry.fileName, folder, currentMtime, blob);
        records = parseMasterSheet_(convertedId, entry.workNo, entry.workName, entry.masterLocation, entry.fileName, hyperlinkMap);
      } catch (err) {
        warnings.push('「' + entry.fileName + '」の読み込みに失敗しました: ' + err.message);
        return;
      }
    }
    newRecordsCache[entry.fileId] = { mtime: currentMtime, v: RECORDS_CACHE_VERSION, records: records };
    allRecords.push.apply(allRecords, records);
  });

  // 「情報」シートから消えたファイルのキャッシュは持ち越さない(newRecordsCacheには今回
  // 処理したファイルのfileIdしか入っていないため、そのまま保存するだけで自然に整理される)。
  saveRecordsCache_(folder, newRecordsCache);

  return {
    generatedAt: Utilities.formatDate(new Date(), TIMEZONE, "yyyy-MM-dd'T'HH:mm:ssXXX"),
    records: allRecords,
    warnings: warnings,
  };
}

// ========== キャッシュの保存/読み込み(同じフォルダ内、毎回上書き) ==========

function saveCache_(folder, data) {
  const content = JSON.stringify(data);
  const files = folder.getFilesByName(CACHE_FILE_NAME);
  if (files.hasNext()) {
    files.next().setContent(content);
  } else {
    folder.createFile(CACHE_FILE_NAME, content, MimeType.PLAIN_TEXT);
  }
}

function loadCache_(folder) {
  const files = folder.getFilesByName(CACHE_FILE_NAME);
  if (!files.hasNext()) return null;
  try {
    return JSON.parse(files.next().getBlob().getDataAsString());
  } catch (e) {
    return null;
  }
}
