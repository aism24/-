/**
 * 「入熱・パス間温度管理」アプリのGAS APIバックエンド。
 *
 * このスクリプトはスプレッドシートの「拡張機能→Apps Script」から作成する
 * コンテナバインド型スクリプトとして使う前提です。SpreadsheetApp.getActiveSpreadsheet()で
 * 自分自身のスプレッドシートを参照するため、SPREADSHEET_IDの設定は不要です。
 *
 * データはユーザーが用意した以下2枚のシートを使います(列の並び順は問いません。
 * 列名でマッチングするため、列名だけ一致していれば動作します)。
 *
 *   シート「入熱パス間記録」(1行=1パス、継手のヘッダー情報は全パス行に重複して保持):
 *     ID, 工事名, 検査日, 部材, サイズ(幅), 板厚, 部材サイズ, 溶接者, 検査員（入力者）,
 *     層数, パス数, 溶接長, 電流, 電圧, スタート, エンド, アークタイム, パス間温度,
 *     インターバル, 備考, 計測, 製品名, 材質, 溶接方法, 気温, 順序,
 *     ルートギャップ, 開先角度, image, 積層図,
 *     入熱上限(kJ/cm), パス間温度下限(℃), パス間温度上限(℃), 判定
 *
 *   シート「情報」:
 *     A〜F列: マスタ選択肢(工事名, 溶接者, 検査員, 部材, 材質, 溶接方法。列ごとに独立したリスト)
 *            検査員列は「登録済み検査員の名簿」を兼ねる(検査員別シートを作る際の基準にもなる)。
 *            ロボット溶接フォームの「オペレータ」は溶接者列、「記録者」は検査員列をそのまま
 *            プルダウンの選択肢として流用する(専用の列は持たない)。
 *     I〜J列: 設定値(キー・値のペア。1行に1項目ずつ、以下のキー名で用意してください)
 *       データソーススプシID … 表示確認用(コードからは参照しません)
 *       製品名フォルダ       … 製品名タグ写真の保存先DriveフォルダID
 *       積層図               … 積層図写真の保存先DriveフォルダID
 *       Geminiモデル名       … 製品名OCRに使うGeminiモデル名(例: gemini-3.5-flash-lite)
 *       タイムゾーン         … 日時表示に使うタイムゾーン(例: Asia/Tokyo)
 *       APIKEY               … Gemini APIキー。サーバー側(このスクリプト内)でのみ使用し、
 *                                クライアント(app.js)には絶対に返さないこと。
 *
 *   検査員別シート(シート名=検査員名。resolveInspectorが自動作成):
 *     初めてその検査員が選ばれた時点で、「情報」シートのA:F列の現在の内容を丸ごと複製して作る。
 *     以後、工事名・部材・材質・溶接方法・溶接者の追加/削除/デフォルト設定はこの専用シートの中だけで
 *     完結し、情報シートや他の検査員には影響しない(「情報」シートは新規作成時のテンプレートと
 *     検査員名簿としてのみ使われる)。I:J列(設定値・APIKEY)は複製後にクリアする。
 *
 * 継手(一連の溶接)のグループ化は、「順序」列が1に戻った行を新しい継手の開始とみなす
 * ルールで行います(saveJointRecordは1継手分のパスを必ずまとめて書き込むため、
 * 同じ継手のパスは常にシート上で連続した行になります)。
 *
 * ---- ロボット溶接用シート ----
 *
 * 半自動溶接(上記「入熱パス間記録」)とはパスの計算式が別物(電流×電圧×60÷溶接速度÷1000。
 * 溶接速度=速度測定長さ÷アークタイム(秒)×6)のため、専用シート「入熱パス間記録(ロボット溶接)」
 * に保存する(saveRobotJointRecord)。まだ未対応の機能: 履歴検索・PDF出力・製品名OCR・
 * 検査員別デフォルト。列構成はROBOT_RECORD_HEADERS/setupRobotWeldSheet()参照。
 *
 * シートがまだ無い場合の作成手順: Apps Scriptエディタでこのファイルを保存後、エディタ上部の
 * 関数選択で「setupRobotWeldSheet」を選び、▶実行ボタンを押す(1回だけでよい)。
 */

const RECORD_SHEET = "入熱パス間記録";
const ROBOT_RECORD_SHEET = "入熱パス間記録(ロボット溶接)";
const MASTER_SHEET = "情報";
const CONFIG_COL_KEY = 9;    // 「情報」シート I列
const CONFIG_COL_VALUE = 10; // 「情報」シート J列

// ロボット溶接用シートの列構成(順序は自由、列名でマッチングする点は「入熱パス間記録」と同じ)。
//
// ヘッダー情報(継手ごと。全パス行に重複して保持):
//   ID, 工事名, 検査日, 部材, 製品名, 材質, 溶接方法(ロボット種別。情報シートの
//     「溶接方法」マスタから選ぶ。例: CO2ロボット溶接A/B), 溶接区分(全周溶接/一辺溶接の2択),
//   検査員（入力者）, 溶接管理者(確認者), オペレータ, 記録者,
//   溶接部位, 継手形状・姿勢, 溶接材料, 銘柄・径, 使用温度計, 天候, 気温,
//   コラム径(mm。角形鋼管の辺長), 板厚(mm), 半径標準値, 計画層数,
//     … この4項目が手入力の起点(添付画像の「サイズ/半径標準値/層」に相当)
//   内周R半径(mm), 速度測定長さ(mm)
//     … 参考記録用の列(クライアント側で計算した値をそのまま保存するだけ)。実際の
//        溶接速度・入熱の計算では、robotMeasureLength_()がコラム径・板厚・半径標準値・
//        計画層数・溶接区分からパスごとに都度算出するため、この2列の値は計算には使わない。
//   入熱上限(kJ/cm), パス間温度下限(℃), パス間温度上限(℃)
//
// パス固有情報(1行=1パス。現行の「▶スタート/■ストップ」タイマーUIをそのまま流用する想定):
//   層数, パス数, 電流, 電圧, スタート, エンド, アークタイム(秒),
//   溶接速度(cm/分) = 速度測定長さ ÷ アークタイム(秒) × 6,
//   入熱(kJ/cm) = 電流 × 電圧 × 60 ÷ 溶接速度(cm/分) ÷ 1000,
//   パス間温度(℃), インターバル(秒), 備考, 順序, 判定, image, 積層図
const ROBOT_RECORD_HEADERS = [
  "ID", "工事名", "検査日", "部材", "製品名", "材質", "溶接方法", "溶接区分",
  "検査員（入力者）", "溶接管理者(確認者)", "オペレータ", "記録者",
  "溶接部位", "継手形状・姿勢", "溶接材料", "銘柄・径", "使用温度計", "天候", "気温",
  "コラム径", "板厚", "半径標準値", "計画層数", "内周R半径", "速度測定長さ",
  "入熱上限(kJ/cm)", "パス間温度下限(℃)", "パス間温度上限(℃)",
  "層数", "パス数", "電流", "電圧", "スタート", "エンド", "アークタイム",
  "溶接速度(cm/分)", "入熱", "パス間温度", "インターバル", "備考",
  "順序", "判定(OK/NG。アプリが自動入力します)", "image", "積層図",
];

// 「入熱パス間記録(ロボット溶接)」シートがまだ無ければ、ヘッダー行付きで新規作成する
// (既にあれば何もしない。既存の「入熱パス間記録」「情報」シートには一切触れない)。
// Apps Scriptエディタから1回だけ手動実行する想定の関数(doGet/doPostからは呼ばない)。
function setupRobotWeldSheet() {
  const ss = ss_();
  if (ss.getSheetByName(ROBOT_RECORD_SHEET)) {
    Logger.log("既に存在するため何もしません: " + ROBOT_RECORD_SHEET);
    return;
  }
  const sh = ss.insertSheet(ROBOT_RECORD_SHEET);
  sh.getRange(1, 1, 1, ROBOT_RECORD_HEADERS.length).setValues([ROBOT_RECORD_HEADERS]);
  sh.setFrozenRows(1);
  sh.getRange(1, 1, 1, ROBOT_RECORD_HEADERS.length).setFontWeight("bold");
  sh.autoResizeColumns(1, ROBOT_RECORD_HEADERS.length);
  Logger.log("作成しました: " + ROBOT_RECORD_SHEET);
}

// マスタ選択肢として公開してよい列名のホワイトリスト。
// 「情報」シートのI:J列(設定値・APIKEYを含む)を誤って外部に公開しないよう、
// listMasterLists/addMasterValueはこのリストにある列名しか扱わない。
const MASTER_COLUMNS = ["工事名", "溶接者", "検査員", "部材", "材質", "溶接方法"];

function jsonResponse_(payload) {
  return ContentService
    .createTextOutput(JSON.stringify(payload))
    .setMimeType(ContentService.MimeType.JSON);
}
function ok_(data) { return jsonResponse_({ status: "success", data: data }); }
function errRes_(message) { return jsonResponse_({ status: "error", message: message }); }

function doGet(e) {
  try {
    const action = e.parameter.action;
    if (action === "listMasterLists") return ok_(listMasterLists());
    if (action === "searchJoints") return ok_(searchJoints(e.parameter.keyword || "", Number(e.parameter.limit) || 200));
    if (action === "searchRobotJoints") return ok_(searchRobotJoints(e.parameter.keyword || "", Number(e.parameter.limit) || 200));
    if (action === "getLastJointHeader") return ok_(getLastJointHeader());
    if (action === "getLastRobotJointHeader") return ok_(getLastRobotJointHeader());
    return errRes_("不明なaction: " + action);
  } catch (err) {
    return errRes_(err.message);
  }
}

function doPost(e) {
  try {
    const body = JSON.parse(e.postData.contents);
    const action = body.action;
    if (action === "addMasterValue") return ok_(addMasterValue(body.column, body.value, body.sheetName));
    if (action === "deleteMasterValue") return ok_(deleteMasterValue(body.column, body.value, body.sheetName));
    if (action === "setDefaultMasterValue") return ok_(setDefaultMasterValue(body.column, body.value, body.sheetName));
    if (action === "resolveInspector") return ok_(resolveInspector(body.name));
    if (action === "saveJointRecord") return ok_(saveJointRecord(body));
    if (action === "saveRobotJointRecord") return ok_(saveRobotJointRecord(body));
    if (action === "updateJointRecord") return ok_(updateJointRecord(body));
    if (action === "uploadPhoto") return ok_(uploadPhoto(body));
    if (action === "updateJointLayerDiagram") return ok_(updateJointLayerDiagram(body.ids, body.url));
    if (action === "generatePdf") return ok_(generatePdf(body));
    return errRes_("不明なaction: " + action);
  } catch (err) {
    return errRes_(err.message);
  }
}

// ---------- 共通ヘルパー ----------

function ss_() { return SpreadsheetApp.getActiveSpreadsheet(); }

function sheet_(name) {
  const sh = ss_().getSheetByName(name);
  if (!sh) throw new Error("シートが見つかりません: " + name);
  return sh;
}

// 1行目のヘッダーから { 列名: 列番号(1始まり) } のマップを作る
// 完全一致が見つからない場合、「列名で始まる見出し」も許容する
// (例: 「判定(OK/NG。アプリが自動入力します)」のような補足付きの見出しでも「判定」でマッチできる)
function headerMap_(sheet) {
  const lastCol = sheet.getLastColumn();
  if (lastCol < 1) return {};
  const headers = sheet.getRange(1, 1, 1, lastCol).getValues()[0];
  const map = {};
  const rawHeaders = [];
  headers.forEach((h, i) => {
    const name = String(h || "").trim();
    rawHeaders.push(name);
    if (name) map[name] = i + 1;
  });
  map.__raw__ = rawHeaders;
  return map;
}

function findCol_(map, name) {
  if (map[name]) return map[name];
  const raw = map.__raw__ || [];
  for (let i = 0; i < raw.length; i++) {
    if (raw[i] && raw[i].indexOf(name) === 0) return i + 1;
  }
  return null;
}

function requireCol_(map, name) {
  const idx = findCol_(map, name);
  if (!idx) throw new Error("シートに列が見つかりません: " + name + " (「入熱パス間記録」シートの1行目に列を追加してください)");
  return idx;
}

function optionalCol_(map, name) { return findCol_(map, name); }

function fmtDateTime_(d) {
  if (!(d instanceof Date) || isNaN(d)) return "";
  const tz = getConfig_()["タイムゾーン"] || Session.getScriptTimeZone() || "Asia/Tokyo";
  return Utilities.formatDate(d, tz, "yyyy/MM/dd HH:mm:ss");
}

function withLock_(fn) {
  const lock = LockService.getScriptLock();
  lock.waitLock(30000);
  try {
    return fn();
  } finally {
    lock.releaseLock();
  }
}

// ---------- 設定値(「情報」シートI:J列) ----------

function getConfig_() {
  const sh = sheet_(MASTER_SHEET);
  const lastRow = sh.getLastRow();
  const cfg = {};
  if (lastRow < 1) return cfg;
  const values = sh.getRange(1, CONFIG_COL_KEY, lastRow, 2).getValues();
  values.forEach(row => {
    const key = String(row[0] || "").trim();
    if (!key) return;
    const val = row[1];
    cfg[key] = (typeof val === "string") ? val.trim() : val;
  });
  return cfg;
}

function requireConfig_(key) {
  const v = getConfig_()[key];
  if (!v) throw new Error("「情報」シートのI:J列に設定が見つかりません: " + key);
  return v;
}

function productNameFolder_() { return DriveApp.getFolderById(requireConfig_("製品名フォルダ")); }
function layerDiagramFolder_() { return DriveApp.getFolderById(requireConfig_("積層図")); }

// PDF変換用の一時Docの保存先(「画像フォルダ」= 製品名フォルダ・積層図フォルダの親)。
// 情報シートに親フォルダIDを別途持たせず、製品名フォルダから実行時にたどる。
// (親が取得できない場合は製品名フォルダ自体にフォールバックする)
function parentImageFolder_() {
  const folder = productNameFolder_();
  const parents = folder.getParents();
  return parents.hasNext() ? parents.next() : folder;
}

function moveFileTo_(file, targetFolder) {
  const parents = file.getParents();
  while (parents.hasNext()) {
    const p = parents.next();
    if (p.getId() !== targetFolder.getId()) p.removeFile(file);
  }
  targetFolder.addFile(file);
}

// ---------- マスタ選択肢(「情報」シートA:F列) ----------
// MASTER_COLUMNSのホワイトリストにある列だけを扱う(I:J列の設定値・APIKEYを絶対に公開しないため)

function listMasterLists() {
  const sh = sheet_(MASTER_SHEET);
  const map = headerMap_(sh);
  const lastRow = sh.getLastRow();
  const result = {};
  MASTER_COLUMNS.forEach(colName => {
    const col = map[colName];
    if (!col || lastRow < 2) { result[colName] = []; return; }
    const values = sh.getRange(2, col, lastRow - 1, 1).getValues();
    result[colName] = values.map(r => String(r[0] || "").trim()).filter(v => v !== "");
  });
  return result;
}

// column="検査員"は名簿そのものなので、指定シートに関わらず常に「情報」シートを対象にする
// (検査員別シートにも同名の列がコピーされているが、そちらは使わない未使用列のため)
function targetSheetName_(column, sheetName) {
  return (column === "検査員") ? MASTER_SHEET : (sheetName || MASTER_SHEET);
}

function addMasterValueCore_(sh, column, v) {
  const map = headerMap_(sh);
  const col = findCol_(map, column);
  if (!col) throw new Error("シートに列が見つかりません: " + column + " (" + sh.getName() + ")");
  const lastRow = Math.max(sh.getLastRow(), 1);
  const existing = lastRow >= 2 ? sh.getRange(2, col, lastRow - 1, 1).getValues().map(r => String(r[0] || "").trim()) : [];
  if (existing.indexOf(v) !== -1) return { added: false };
  const emptyIdx = existing.findIndex(x => x === "");
  const writeRow = emptyIdx !== -1 ? emptyIdx + 2 : lastRow + 1;
  sh.getRange(writeRow, col).setValue(v);
  return { added: true };
}

function addMasterValue(column, value, sheetName) {
  const v = String(value || "").trim();
  if (!column || !v) throw new Error("列名と値を指定してください");
  if (MASTER_COLUMNS.indexOf(column) === -1) throw new Error("許可されていない列名です: " + column);
  return withLock_(() => addMasterValueCore_(sheet_(targetSheetName_(column, sheetName)), column, v));
}

// マスタ選択肢から1件削除する(該当行を除去し、下の値を詰める)
function deleteMasterValue(column, value, sheetName) {
  const v = String(value || "").trim();
  if (!column || !v) throw new Error("列名と値を指定してください");
  if (MASTER_COLUMNS.indexOf(column) === -1) throw new Error("許可されていない列名です: " + column);
  return withLock_(() => {
    const sh = sheet_(targetSheetName_(column, sheetName));
    const map = headerMap_(sh);
    const col = findCol_(map, column);
    if (!col) throw new Error("シートに列が見つかりません: " + column + " (" + sh.getName() + ")");
    const lastRow = sh.getLastRow();
    if (lastRow < 2) return { deleted: false };
    const values = sh.getRange(2, col, lastRow - 1, 1).getValues().map(r => String(r[0] || "").trim());
    const idx = values.indexOf(v);
    if (idx === -1) return { deleted: false };
    values.splice(idx, 1);
    values.push("");
    sh.getRange(2, col, values.length, 1).setValues(values.map(x => [x]));
    return { deleted: true };
  });
}

// マスタ選択肢のうち1件を「デフォルト」(シートの2行目)に設定する。
// 新規継手記録画面では、この2行目の値が自動的に初期選択される。
function setDefaultMasterValue(column, value, sheetName) {
  const v = String(value || "").trim();
  if (!column || !v) throw new Error("列名と値を指定してください");
  if (MASTER_COLUMNS.indexOf(column) === -1) throw new Error("許可されていない列名です: " + column);
  return withLock_(() => {
    const sh = sheet_(targetSheetName_(column, sheetName));
    const map = headerMap_(sh);
    const col = findCol_(map, column);
    if (!col) throw new Error("シートに列が見つかりません: " + column + " (" + sh.getName() + ")");
    const lastRow = sh.getLastRow();
    if (lastRow < 2) throw new Error("値が見つかりません: " + v);
    const values = sh.getRange(2, col, lastRow - 1, 1).getValues().map(r => String(r[0] || "").trim());
    const idx = values.indexOf(v);
    if (idx === -1) throw new Error("値が見つかりません: " + v);
    values.splice(idx, 1);
    values.unshift(v);
    sh.getRange(2, col, values.length, 1).setValues(values.map(x => [x]));
    return { ok: true };
  });
}

// ---------- 検査員別デフォルト(検査員ごとの専用シート) ----------
// 検査員が初めて選ばれた時点で、「情報」シートのA:F列の現在の内容を丸ごと複製した専用シート
// (シート名=検査員名)を作る。以後、工事名・部材・材質・溶接方法・溶接者はこの専用シートの中だけで
// 追加/削除/デフォルト設定が完結する(情報シートは名簿とテンプレートとしてのみ機能する)。
const INSPECTOR_MASTER_COLUMNS = ["工事名", "部材", "材質", "溶接方法", "溶接者"];

function resolveInspector(name) {
  const v = String(name || "").trim();
  if (!v) throw new Error("検査員名を指定してください");
  return withLock_(() => {
    const ss = ss_();
    let sh = ss.getSheetByName(v);
    if (!sh) {
      const info = sheet_(MASTER_SHEET);
      sh = info.copyTo(ss);
      sh.setName(v);
      sh.getRange(1, CONFIG_COL_KEY, sh.getMaxRows(), 2).clearContent(); // 設定値・APIKEYは検査員シートに不要
      addMasterValueCore_(info, "検査員", v); // 既に名簿にいる場合は何もしない(addMasterValueCore_が重複を無視)
    }
    const map = headerMap_(sh);
    const lastRow = sh.getLastRow();
    const lists = {};
    INSPECTOR_MASTER_COLUMNS.forEach(colName => {
      const col = map[colName];
      if (!col || lastRow < 2) { lists[colName] = []; return; }
      const values = sh.getRange(2, col, lastRow - 1, 1).getValues();
      lists[colName] = values.map(r => String(r[0] || "").trim()).filter(x => x !== "");
    });
    return { sheetName: v, lists: lists };
  });
}

// ---------- 継手の記録(パスをまとめて一括保存) ----------

function nextId_(sh, idCol) {
  const lastRow = sh.getLastRow();
  if (lastRow < 2) return 1;
  const ids = sh.getRange(2, idCol, lastRow - 1, 1).getValues().map(r => Number(r[0]) || 0);
  return Math.max(0, ...ids) + 1;
}

function judgePass_(passTemp, heatInput, header) {
  const reasons = [];
  let ok = true;
  if (header.tempMin !== "" && header.tempMin != null && Number(passTemp) < Number(header.tempMin)) { ok = false; reasons.push("温度不足"); }
  if (header.tempMax !== "" && header.tempMax != null && Number(passTemp) > Number(header.tempMax)) { ok = false; reasons.push("温度超過"); }
  if (heatInput !== "" && heatInput != null && header.heatInputLimit !== "" && header.heatInputLimit != null &&
    Number(heatInput) > Number(header.heatInputLimit)) { ok = false; reasons.push("入熱超過"); }
  return { judgement: ok ? "OK" : "NG", reasons: reasons };
}

// 電流・電圧・アークタイム(秒)・溶接長から入熱量(kJ/cm)を算出し、合否判定する
// (saveJointRecordとgeneratePdfの両方から使う、唯一の計算ロジック)
function computePassMetrics_(current, voltage, arcSeconds, passTemp, header) {
  const weldLength = Number(header.weldLength) || 0;
  current = Number(current) || 0;
  voltage = Number(voltage) || 0;
  arcSeconds = Number(arcSeconds) || 0;
  let heatInput = "";
  if (weldLength > 0 && arcSeconds > 0 && current && voltage) {
    heatInput = Math.round((current * voltage * arcSeconds / (1000 * weldLength)) * 100) / 100;
  }
  const judged = judgePass_(passTemp, heatInput, header);
  return { heatInput: heatInput, judgement: judged.judgement, reasons: judged.reasons };
}

function saveJointRecord(body) {
  const header = body.header || {};
  const passes = body.passes || [];
  if (!passes.length) throw new Error("パスが1件も入力されていません");

  return withLock_(() => {
    const sh = sheet_(RECORD_SHEET);
    const map = headerMap_(sh);
    const idCol = requireCol_(map, "ID");
    let nextIdNum = nextId_(sh, idCol);

    const lastCol = sh.getLastColumn();
    const rows = [];
    const ids = [];
    let prevEnd = null;

    passes.forEach((p, i) => {
      const row = new Array(lastCol).fill("");
      const setIf = (name, value) => {
        const col = optionalCol_(map, name);
        if (col) row[col - 1] = value;
      };

      // ヘッダー情報(全パス共通)
      setIf("工事名", header["工事名"] || "");
      setIf("検査日", header["検査日"] || "");
      setIf("部材", header["部材"] || "");
      setIf("サイズ(幅)", header["サイズ(幅)"] || "");
      setIf("板厚", header["板厚"] || "");
      setIf("部材サイズ", header["部材サイズ"] || "");
      setIf("溶接者", header["溶接者"] || "");
      setIf("検査員（入力者）", header["検査員（入力者）"] || "");
      setIf("溶接長", header["溶接長"] || "");
      setIf("計測", header["計測"] || "");
      setIf("製品名", header["製品名"] || "");
      setIf("材質", header["材質"] || "");
      setIf("溶接方法", header["溶接方法"] || "");
      setIf("気温", header["気温"] || "");
      setIf("ルートギャップ", header["ルートギャップ"] || "");
      setIf("開先角度", header["開先角度"] || "");
      setIf("image", header["image"] || "");
      setIf("積層図", header["積層図"] || "");
      setIf("入熱上限(kJ/cm)", header["heatInputLimit"] || "");
      setIf("パス間温度下限(℃)", header["tempMin"] || "");
      setIf("パス間温度上限(℃)", header["tempMax"] || "");

      // パス固有情報
      const start = p.start ? new Date(p.start) : null;
      const end = p.end ? new Date(p.end) : null;
      const arcSec = (start && end) ? Math.max(0, Math.round((end - start) / 1000)) : 0;
      const intervalSec = (prevEnd && start) ? Math.max(0, Math.round((start - prevEnd) / 1000)) : "";
      const current = Number(p.current) || 0;
      const voltage = Number(p.voltage) || 0;
      const metrics = computePassMetrics_(current, voltage, arcSec, p.passTemp, {
        weldLength: header["溶接長"], tempMin: header["tempMin"], tempMax: header["tempMax"], heatInputLimit: header["heatInputLimit"],
      });
      const note = metrics.reasons.length ? (metrics.reasons.join("・") + (p.note ? " / " + p.note : "")) : (p.note || "");

      setIf("層数", p.layer || "");
      setIf("パス数", i + 1);
      setIf("順序", i + 1);
      setIf("電流", current);
      setIf("電圧", voltage);
      setIf("スタート", start || "");
      setIf("エンド", end || "");
      setIf("アークタイム", arcSec);
      setIf("パス間温度", Number(p.passTemp));
      setIf("インターバル", intervalSec);
      setIf("備考", note);
      setIf("判定", metrics.judgement);

      row[idCol - 1] = nextIdNum;
      ids.push(nextIdNum);
      nextIdNum += 1;
      prevEnd = end;
      rows.push(row);
    });

    const startRow = sh.getLastRow() + 1;
    sh.getRange(startRow, 1, rows.length, lastCol).setValues(rows);

    const judgeCol = optionalCol_(map, "判定");
    const overallResult = judgeCol
      ? (rows.some(r => r[judgeCol - 1] === "NG") ? "NG" : "OK")
      : "";

    return { savedRows: rows.length, overallResult: overallResult, ids: ids };
  });
}

// 保存済みの継手のパスを、行を追加せずに既存行を上書きして修正する(完了後の編集用)
function updateJointRecord(body) {
  const header = body.header || {};
  const ids = body.ids || [];
  const passes = body.passes || [];
  if (!ids.length || ids.length !== passes.length) throw new Error("ids/passesの件数が一致しません");

  return withLock_(() => {
    const sh = sheet_(RECORD_SHEET);
    const map = headerMap_(sh);
    const idCol = requireCol_(map, "ID");
    const lastRow = sh.getLastRow();
    if (lastRow < 2) throw new Error("更新対象の行が見つかりません");
    const idValues = sh.getRange(2, idCol, lastRow - 1, 1).getValues().map(r => Number(r[0]));

    let prevEnd = null;
    ids.forEach((id, i) => {
      const rowIndex = idValues.indexOf(Number(id));
      if (rowIndex === -1) throw new Error("該当する行が見つかりません(ID: " + id + ")");
      const sheetRow = rowIndex + 2;
      const p = passes[i];

      const start = p.start ? new Date(p.start) : null;
      const end = p.end ? new Date(p.end) : null;
      const arcSec = (start && end) ? Math.max(0, Math.round((end - start) / 1000)) : 0;
      const intervalSec = (prevEnd && start) ? Math.max(0, Math.round((start - prevEnd) / 1000)) : "";
      const current = Number(p.current) || 0;
      const voltage = Number(p.voltage) || 0;
      const metrics = computePassMetrics_(current, voltage, arcSec, p.passTemp, {
        weldLength: header["溶接長"], tempMin: header["tempMin"], tempMax: header["tempMax"], heatInputLimit: header["heatInputLimit"],
      });
      const note = metrics.reasons.length ? (metrics.reasons.join("・") + (p.note ? " / " + p.note : "")) : (p.note || "");

      const setCell = (name, value) => {
        const col = optionalCol_(map, name);
        if (col) sh.getRange(sheetRow, col).setValue(value);
      };
      setCell("層数", p.layer || "");
      setCell("電流", current);
      setCell("電圧", voltage);
      setCell("スタート", start || "");
      setCell("エンド", end || "");
      setCell("アークタイム", arcSec);
      setCell("パス間温度", Number(p.passTemp));
      setCell("インターバル", intervalSec);
      setCell("備考", note);
      setCell("判定", metrics.judgement);

      prevEnd = end;
    });

    return { updatedRows: ids.length };
  });
}

// 履歴詳細(閲覧)画面から、保存済みの継手に積層図を後付けで追加・差し替えできるようにする。
// 積層図は継手のヘッダー情報として全パス行に重複して保持しているため、該当する全行を更新する。
function updateJointLayerDiagram(ids, url) {
  if (!ids || !ids.length) throw new Error("idsを指定してください");
  return withLock_(() => {
    const sh = sheet_(RECORD_SHEET);
    const map = headerMap_(sh);
    const idCol = requireCol_(map, "ID");
    const col = requireCol_(map, "積層図");
    const lastRow = sh.getLastRow();
    if (lastRow < 2) throw new Error("更新対象の行が見つかりません");
    const idValues = sh.getRange(2, idCol, lastRow - 1, 1).getValues().map(r => Number(r[0]));
    let updated = 0;
    ids.forEach(id => {
      const rowIndex = idValues.indexOf(Number(id));
      if (rowIndex === -1) return;
      sh.getRange(rowIndex + 2, col).setValue(url);
      updated += 1;
    });
    return { updated: updated };
  });
}

// 新規記録画面のデフォルト値用に、スプレッドシート最終行(前回の継手・前回の最後のパス)の値を返す。
// 「製品名」はOCRで都度読み取る製品固有のタグ情報のため、対象に含めない。
// 「電流」「電圧」「パス間温度」は1パス目(まだ自分の継手のパス履歴がない時点)のデフォルト表示に使う。
function getLastJointHeader() {
  const sh = sheet_(RECORD_SHEET);
  const map = headerMap_(sh);
  const lastRow = sh.getLastRow();
  if (lastRow < 2) return null;
  const lastCol = sh.getLastColumn();
  const row = sh.getRange(lastRow, 1, 1, lastCol).getValues()[0];
  const record = {};
  Object.keys(map).forEach(name => {
    if (name === "__raw__") return;
    record[name] = row[map[name] - 1];
  });
  return {
    "サイズ(幅)": getField_(record, "サイズ(幅)"),
    "板厚": getField_(record, "板厚"),
    "部材サイズ": getField_(record, "部材サイズ"),
    "溶接長": getField_(record, "溶接長"),
    "気温": getField_(record, "気温"),
    "計測": getField_(record, "計測"),
    "入熱上限(kJ/cm)": getField_(record, "入熱上限(kJ/cm)"),
    "パス間温度下限(℃)": getField_(record, "パス間温度下限(℃)"),
    "パス間温度上限(℃)": getField_(record, "パス間温度上限(℃)"),
    "ルートギャップ": getField_(record, "ルートギャップ"),
    "開先角度": getField_(record, "開先角度"),
    "電流": getField_(record, "電流"),
    "電圧": getField_(record, "電圧"),
    "パス間温度": getField_(record, "パス間温度"),
  };
}

// ロボット溶接の新規記録画面のデフォルト値用に、「入熱パス間記録(ロボット溶接)」シート最終行
// (前回の継手)の値を返す。コラム径・板厚・半径標準値・計画層数・入熱条件・パス間温度下限・気温・
// 天候は固定のデフォルト値/選択済みボタンを持つためここには含めない(製品名・検査日も対象外)。
function getLastRobotJointHeader() {
  const sh = sheet_(ROBOT_RECORD_SHEET);
  const map = headerMap_(sh);
  const lastRow = sh.getLastRow();
  if (lastRow < 2) return null;
  const lastCol = sh.getLastColumn();
  const row = sh.getRange(lastRow, 1, 1, lastCol).getValues()[0];
  const record = {};
  Object.keys(map).forEach(name => {
    if (name === "__raw__") return;
    record[name] = row[map[name] - 1];
  });
  return {
    "工事名": getField_(record, "工事名"),
    "部材": getField_(record, "部材"),
    "材質": getField_(record, "材質"),
    "溶接方法": getField_(record, "溶接方法"),
    "溶接区分": getField_(record, "溶接区分"),
    "検査員（入力者）": getField_(record, "検査員（入力者）"),
    "溶接管理者(確認者)": getField_(record, "溶接管理者(確認者)"),
    "オペレータ": getField_(record, "オペレータ"),
    "記録者": getField_(record, "記録者"),
    "溶接部位": getField_(record, "溶接部位"),
    "継手形状・姿勢": getField_(record, "継手形状・姿勢"),
    "溶接材料": getField_(record, "溶接材料"),
    "銘柄・径": getField_(record, "銘柄・径"),
    "使用温度計": getField_(record, "使用温度計"),
  };
}

// ---------- ロボット溶接の記録(パスをまとめて一括保存) ----------
// 半自動溶接(saveJointRecord/computePassMetrics_)とは入熱の計算式が別物のため、専用の
// 計算ロジック・保存先シート(ROBOT_RECORD_SHEET)を持つ。現段階では履歴検索・PDF出力は未対応。

// 板厚・半径標準値から外周R半径・内周R半径を、そこから外周・内周の全周長(mm)を求める
// (角形鋼管の4辺の直線部+4隅の円弧部)。
function robotGeometry_(columnDia, thickness, radiusStd) {
  const outerR = thickness * radiusStd;
  const innerR = outerR - thickness;
  const straightOuter = (columnDia - 2 * outerR) * 4;
  const straightInner = (columnDia - 2 * thickness - 2 * innerR) * 4;
  const outerCirc = straightOuter + 2 * Math.PI * outerR;
  const innerCirc = straightInner + 2 * Math.PI * innerR;
  return { outerR: outerR, innerR: innerR, outerCirc: outerCirc, innerCirc: innerCirc };
}

// 全周溶接: 各層の溶接長は内周(1層目)→外周(計画層数の層)へ線形補間する。
// 一辺溶接: 隅Rを除いた1辺分の直線長(コラム径−内周R半径×2)を固定で使う。
function robotMeasureLength_(header, layer) {
  const columnDia = Number(header["コラム径"]) || 0;
  const thickness = Number(header["板厚"]) || 0;
  const radiusStd = Number(header["半径標準値"]) || 0;
  const geo = robotGeometry_(columnDia, thickness, radiusStd);
  if (header["溶接区分"] === "全周溶接") {
    const planLayers = Number(header["計画層数"]) || 1;
    if (planLayers <= 1) return geo.innerCirc;
    const l = Math.max(1, Number(layer) || 1);
    return geo.innerCirc + (l - 1) * (geo.outerCirc - geo.innerCirc) / (planLayers - 1);
  }
  return columnDia - 2 * geo.innerR;
}

// 電流・電圧・アークタイム(秒)・速度測定長さ(層に応じて変わる)から溶接速度・入熱量を算出し、合否判定する
function computeRobotPassMetrics_(current, voltage, arcSeconds, passTemp, header, layer) {
  current = Number(current) || 0;
  voltage = Number(voltage) || 0;
  arcSeconds = Number(arcSeconds) || 0;
  const measureLength = robotMeasureLength_(header, layer);
  let weldSpeed = "", heatInput = "";
  if (measureLength > 0 && arcSeconds > 0) {
    weldSpeed = measureLength / arcSeconds * 6;
    if (weldSpeed > 0 && current && voltage) {
      heatInput = Math.round((current * voltage * 60 / weldSpeed / 1000) * 100) / 100;
    }
    weldSpeed = Math.round(weldSpeed * 100) / 100;
  }
  const judged = judgePass_(passTemp, heatInput, {
    tempMin: header["パス間温度下限(℃)"], tempMax: header["パス間温度上限(℃)"], heatInputLimit: header["入熱上限(kJ/cm)"],
  });
  return { weldSpeed: weldSpeed, heatInput: heatInput, judgement: judged.judgement, reasons: judged.reasons };
}

function saveRobotJointRecord(body) {
  const header = body.header || {};
  const passes = body.passes || [];
  if (!passes.length) throw new Error("パスが1件も入力されていません");

  return withLock_(() => {
    const sh = sheet_(ROBOT_RECORD_SHEET);
    const map = headerMap_(sh);
    const idCol = requireCol_(map, "ID");
    let nextIdNum = nextId_(sh, idCol);

    const lastCol = sh.getLastColumn();
    const rows = [];
    const ids = [];
    let prevEnd = null;

    passes.forEach((p, i) => {
      const row = new Array(lastCol).fill("");
      const setIf = (name, value) => {
        const col = optionalCol_(map, name);
        if (col) row[col - 1] = value;
      };

      // ヘッダー情報(全パス共通。キー名はROBOT_RECORD_HEADERSの列名と一致させてクライアントから送る)
      Object.keys(header).forEach(k => setIf(k, header[k]));

      const start = p.start ? new Date(p.start) : null;
      const end = p.end ? new Date(p.end) : null;
      const arcSec = (start && end) ? Math.max(0, Math.round((end - start) / 1000)) : 0;
      const intervalSec = (prevEnd && start) ? Math.max(0, Math.round((start - prevEnd) / 1000)) : "";
      const current = Number(p.current) || 0;
      const voltage = Number(p.voltage) || 0;
      const metrics = computeRobotPassMetrics_(current, voltage, arcSec, p.passTemp, header, p.layer);
      const note = metrics.reasons.length ? (metrics.reasons.join("・") + (p.note ? " / " + p.note : "")) : (p.note || "");

      setIf("層数", p.layer || "");
      setIf("パス数", i + 1);
      setIf("順序", i + 1);
      setIf("電流", current);
      setIf("電圧", voltage);
      setIf("スタート", start || "");
      setIf("エンド", end || "");
      setIf("アークタイム", arcSec);
      setIf("溶接速度(cm/分)", metrics.weldSpeed);
      setIf("入熱", metrics.heatInput);
      setIf("パス間温度", Number(p.passTemp));
      setIf("インターバル", intervalSec);
      setIf("備考", note);
      setIf("判定", metrics.judgement);

      row[idCol - 1] = nextIdNum;
      ids.push(nextIdNum);
      nextIdNum += 1;
      prevEnd = end;
      rows.push(row);
    });

    const startRow = sh.getLastRow() + 1;
    sh.getRange(startRow, 1, rows.length, lastCol).setValues(rows);

    const judgeCol = optionalCol_(map, "判定");
    const overallResult = judgeCol
      ? (rows.some(r => r[judgeCol - 1] === "NG") ? "NG" : "OK")
      : "";

    return { savedRows: rows.length, overallResult: overallResult, ids: ids };
  });
}

// ---------- 履歴・検索(継手単位にグルーピングして返す) ----------

function readAllRecords_() {
  const sh = sheet_(RECORD_SHEET);
  const map = headerMap_(sh);
  const lastRow = sh.getLastRow();
  const lastCol = sh.getLastColumn();
  if (lastRow < 2) return [];
  const values = sh.getRange(2, 1, lastRow - 1, lastCol).getValues();
  const idCol = requireCol_(map, "ID");
  return values
    .filter(row => row[idCol - 1] !== "" && row[idCol - 1] !== null)
    .map(row => {
      const obj = {};
      Object.keys(map).forEach(name => {
        if (name === "__raw__") return;
        obj[name] = row[map[name] - 1];
      });
      return obj;
    });
}

// レコードオブジェクトから、見出しの完全一致 → 前方一致の順でフィールド値を取得する
// (「判定(OK/NG。アプリが自動入力します)」のような補足付き見出しにも対応するため)
function getField_(record, name) {
  if (Object.prototype.hasOwnProperty.call(record, name)) return record[name];
  const keys = Object.keys(record);
  for (let i = 0; i < keys.length; i++) {
    if (keys[i].indexOf(name) === 0) return record[keys[i]];
  }
  return undefined;
}

// 「順序」が1に戻った行を新しい継手の開始とみなしてグルーピングする
function groupIntoJoints_(records) {
  const joints = [];
  let current = null;
  records.forEach(r => {
    const order = Number(getField_(r, "順序")) || 0;
    if (!current || order === 1) {
      current = { records: [] };
      joints.push(current);
    }
    current.records.push(r);
  });
  return joints.map(j => {
    const first = j.records[0];
    const overallResult = j.records.some(r => getField_(r, "判定") === "NG") ? "NG" : "OK";
    const asDateStr = v => v instanceof Date ? fmtDateTime_(v) : v;
    const header = {
      "工事名": getField_(first, "工事名"),
      "検査日": getField_(first, "検査日") instanceof Date ? asDateStr(getField_(first, "検査日")).slice(0, 10) : getField_(first, "検査日"),
      "部材": getField_(first, "部材"), "サイズ(幅)": getField_(first, "サイズ(幅)"), "板厚": getField_(first, "板厚"),
      "部材サイズ": getField_(first, "部材サイズ"), "溶接者": getField_(first, "溶接者"),
      "検査員（入力者）": getField_(first, "検査員（入力者）"), "溶接長": getField_(first, "溶接長"),
      "計測": getField_(first, "計測"), "製品名": getField_(first, "製品名"), "材質": getField_(first, "材質"),
      "溶接方法": getField_(first, "溶接方法"),
      "気温": getField_(first, "気温"), "ルートギャップ": getField_(first, "ルートギャップ"), "開先角度": getField_(first, "開先角度"),
      "image": getField_(first, "image"), "積層図": getField_(first, "積層図"),
      heatInputLimit: getField_(first, "入熱上限(kJ/cm)"), tempMin: getField_(first, "パス間温度下限(℃)"), tempMax: getField_(first, "パス間温度上限(℃)"),
    };
    return {
      工事名: header["工事名"], 検査日: header["検査日"], 部材: header["部材"], 製品名: header["製品名"],
      材質: header["材質"], 溶接方法: header["溶接方法"], 溶接者: header["溶接者"], 検査員: header["検査員（入力者）"],
      passCount: j.records.length, overallResult: overallResult, header: header,
      records: j.records.map(r => {
        const arcSec = Number(getField_(r, "アークタイム")) || 0;
        const metrics = computePassMetrics_(getField_(r, "電流"), getField_(r, "電圧"), arcSec, getField_(r, "パス間温度"), header);
        return {
          ID: getField_(r, "ID"),
          層数: getField_(r, "層数"), 順序: getField_(r, "順序"),
          電流: getField_(r, "電流"), 電圧: getField_(r, "電圧"),
          スタート: asDateStr(getField_(r, "スタート")), エンド: asDateStr(getField_(r, "エンド")),
          アークタイム: arcSec, heatInput: metrics.heatInput, パス間温度: getField_(r, "パス間温度"),
          インターバル: getField_(r, "インターバル"), 備考: getField_(r, "備考"),
          判定: getField_(r, "判定"),
        };
      }),
    };
  });
}

function searchJoints(keyword, limit) {
  const records = readAllRecords_();
  let joints = groupIntoJoints_(records);
  const kw = String(keyword || "").trim().toLowerCase();
  if (kw) {
    joints = joints.filter(j =>
      String(j.工事名).toLowerCase().indexOf(kw) !== -1 ||
      String(j.製品名).toLowerCase().indexOf(kw) !== -1 ||
      String(j.部材).toLowerCase().indexOf(kw) !== -1 ||
      String(j.溶接者).toLowerCase().indexOf(kw) !== -1 ||
      String(j.検査員).toLowerCase().indexOf(kw) !== -1
    );
  }
  joints.reverse();
  return joints.slice(0, limit);
}

// ---------- ロボット溶接: 履歴・検索(継手単位にグルーピングして返す・閲覧専用) ----------
// 半自動溶接側と違い、パスの電流・電圧・アークタイムを編集して再計算する機能は無いため、
// 溶接速度・入熱・判定は保存時にsaveRobotJointRecordが計算した値をそのまま返す(再計算しない)。

function readAllRobotRecords_() {
  const sh = sheet_(ROBOT_RECORD_SHEET);
  const map = headerMap_(sh);
  const lastRow = sh.getLastRow();
  const lastCol = sh.getLastColumn();
  if (lastRow < 2) return [];
  const values = sh.getRange(2, 1, lastRow - 1, lastCol).getValues();
  const idCol = requireCol_(map, "ID");
  return values
    .filter(row => row[idCol - 1] !== "" && row[idCol - 1] !== null)
    .map(row => {
      const obj = {};
      Object.keys(map).forEach(name => {
        if (name === "__raw__") return;
        obj[name] = row[map[name] - 1];
      });
      return obj;
    });
}

// 「順序」が1に戻った行を新しい継手の開始とみなしてグルーピングする
function groupIntoRobotJoints_(records) {
  const joints = [];
  let current = null;
  records.forEach(r => {
    const order = Number(getField_(r, "順序")) || 0;
    if (!current || order === 1) {
      current = { records: [] };
      joints.push(current);
    }
    current.records.push(r);
  });
  return joints.map(j => {
    const first = j.records[0];
    const overallResult = j.records.some(r => getField_(r, "判定") === "NG") ? "NG" : "OK";
    const asDateStr = v => v instanceof Date ? fmtDateTime_(v) : v;
    const header = {};
    ROBOT_RECORD_HEADERS.forEach(name => {
      if (name === "ID" || name === "image" || name === "積層図") return;
      header[name] = getField_(first, name);
    });
    header["検査日"] = header["検査日"] instanceof Date ? asDateStr(header["検査日"]).slice(0, 10) : header["検査日"];
    return {
      工事名: header["工事名"], 検査日: header["検査日"], 部材: header["部材"], 製品名: header["製品名"],
      材質: header["材質"], 溶接方法: header["溶接方法"], 溶接区分: header["溶接区分"],
      オペレータ: header["オペレータ"], 記録者: header["記録者"], 検査員: header["検査員（入力者）"],
      passCount: j.records.length, overallResult: overallResult, header: header,
      records: j.records.map(r => ({
        ID: getField_(r, "ID"),
        層数: getField_(r, "層数"), 順序: getField_(r, "順序"),
        電流: getField_(r, "電流"), 電圧: getField_(r, "電圧"),
        スタート: asDateStr(getField_(r, "スタート")), エンド: asDateStr(getField_(r, "エンド")),
        アークタイム: getField_(r, "アークタイム"), 溶接速度: getField_(r, "溶接速度(cm/分)"),
        入熱: getField_(r, "入熱"), パス間温度: getField_(r, "パス間温度"),
        インターバル: getField_(r, "インターバル"), 備考: getField_(r, "備考"),
        判定: getField_(r, "判定"),
      })),
    };
  });
}

function searchRobotJoints(keyword, limit) {
  const records = readAllRobotRecords_();
  let joints = groupIntoRobotJoints_(records);
  const kw = String(keyword || "").trim().toLowerCase();
  if (kw) {
    joints = joints.filter(j =>
      String(j.工事名).toLowerCase().indexOf(kw) !== -1 ||
      String(j.製品名).toLowerCase().indexOf(kw) !== -1 ||
      String(j.部材).toLowerCase().indexOf(kw) !== -1 ||
      String(j.オペレータ).toLowerCase().indexOf(kw) !== -1 ||
      String(j.記録者).toLowerCase().indexOf(kw) !== -1 ||
      String(j.検査員).toLowerCase().indexOf(kw) !== -1
    );
  }
  joints.reverse();
  return joints.slice(0, limit);
}

// ---------- 画像アップロード(製品名タグ写真・積層図) ----------

function uploadPhoto(payload) {
  const kind = payload.kind; // "productName" | "layerDiagram"
  if (kind !== "productName" && kind !== "layerDiagram") throw new Error("不明な写真種別です: " + kind);

  const folder = kind === "productName" ? productNameFolder_() : layerDiagramFolder_();
  const decoded = Utilities.base64Decode(payload.base64);
  const mimeType = (payload.mimeType === "image/heic" || payload.mimeType === "image/heif") ? "image/jpeg" : payload.mimeType;
  const blob = Utilities.newBlob(decoded, mimeType, payload.fileName);
  const file = folder.createFile(blob);
  // 組織のDrive共有ポリシーで「リンクを知っている全員」が禁止されている場合でも、
  // 写真の保存・OCR自体は失敗させない(共有設定はベストエフォート)
  try {
    file.setSharing(DriveApp.Access.ANYONE_WITH_LINK, DriveApp.Permission.VIEW);
  } catch (e) {
    // 共有設定のみ失敗。ファイル自体は保存済みなので処理は継続する
  }
  const result = { url: "https://drive.google.com/file/d/" + file.getId() + "/view" };

  if (kind === "productName") {
    result.recognizedText = ocrProductNameWithRetry_(payload.base64, mimeType);
  }
  return result;
}

// ---------- 製品名タグ写真のOCR(Gemini API) ----------

function callGeminiOcr_(base64, mimeType) {
  const apiKey = requireConfig_("APIKEY");
  const model = requireConfig_("Geminiモデル名");
  const url = "https://generativelanguage.googleapis.com/v1beta/models/" + encodeURIComponent(model) +
    ":generateContent?key=" + encodeURIComponent(apiKey);
  const payload = {
    contents: [{
      parts: [
        { text: "この画像は鉄骨部材に記された製品名・符号のタグです。書かれている製品名(英数字・記号の刻印。例: G1-3)だけを1行のプレーンテキストで返してください。説明や前置きは一切不要です。読み取れない場合は空文字を返してください。" },
        { inline_data: { mime_type: mimeType, data: base64 } },
      ],
    }],
    generationConfig: { temperature: 0, maxOutputTokens: 64 },
  };
  const res = UrlFetchApp.fetch(url, {
    method: "post",
    contentType: "application/json",
    payload: JSON.stringify(payload),
    muteHttpExceptions: true,
  });
  const code = res.getResponseCode();
  if (code < 200 || code >= 300) throw new Error("Gemini APIエラー(HTTP " + code + "): " + res.getContentText());
  const json = JSON.parse(res.getContentText());
  const text = json.candidates && json.candidates[0] && json.candidates[0].content &&
    json.candidates[0].content.parts && json.candidates[0].content.parts[0] &&
    json.candidates[0].content.parts[0].text;
  return String(text || "").trim();
}

// 1回失敗したらもう1回だけ自動リトライし、それでも失敗したら空文字を返して手入力にフォールバックする
function ocrProductNameWithRetry_(base64, mimeType) {
  try {
    return callGeminiOcr_(base64, mimeType);
  } catch (e1) {
    try {
      return callGeminiOcr_(base64, mimeType);
    } catch (e2) {
      return "";
    }
  }
}

// ---------- PDF出力(ブラウザへ直接ダウンロード) ----------

function generatePdf(body) {
  const header = body.header || {};
  const passes = body.passes || [];

  const docName = "入熱パス間温度管理記録_" + (header["工事名"] || "") + "_" + (header["製品名"] || "");
  const doc = DocumentApp.create(docName);
  const b = doc.getBody();
  b.setPageWidth(595).setPageHeight(842).setMarginTop(36).setMarginBottom(36).setMarginLeft(36).setMarginRight(36);

  b.appendParagraph("入熱・パス間温度管理記録").setHeading(DocumentApp.ParagraphHeading.HEADING1);

  const metricsHeader = {
    weldLength: header["溶接長"], tempMin: header["tempMin"], tempMax: header["tempMax"], heatInputLimit: header["heatInputLimit"],
  };
  const computed = passes.map(p => computePassMetrics_(p.current, p.voltage, p.arcSeconds, p.passTemp, metricsHeader));
  const overallResult = computed.some(m => m.judgement === "NG") ? "NG" : "OK";
  const headerTable = [
    ["工事名", String(header["工事名"] || ""), "検査日", String(header["検査日"] || "")],
    ["部材", String(header["部材"] || ""), "製品名", String(header["製品名"] || "")],
    ["部材サイズ", String(header["部材サイズ"] || ""), "材質", String(header["材質"] || "")],
    ["溶接方法", String(header["溶接方法"] || ""), "溶接長(cm)", String(header["溶接長"] || "")],
    ["溶接者", String(header["溶接者"] || ""), "検査員", String(header["検査員（入力者）"] || "")],
    ["入熱上限(kJ/cm)", String(header["heatInputLimit"] || "-"), "パス間温度範囲(℃)",
      (header["tempMin"] || "-") + " 〜 " + (header["tempMax"] || "-")],
    ["総合判定", overallResult, "総パス数", String(passes.length)],
  ];
  b.appendTable(headerTable);
  b.appendParagraph("");

  b.appendParagraph("パス記録").setHeading(DocumentApp.ParagraphHeading.HEADING2);
  const passTable = [["層", "パス", "電流(A)", "電圧(V)", "アークタイム(秒)", "入熱(kJ/cm)", "パス間温度(℃)", "判定", "備考"]];
  passes.forEach((p, i) => {
    const m = computed[i];
    passTable.push([
      String(p.layer || "-"), String(i + 1), String(p.current), String(p.voltage),
      String(p.arcSeconds != null ? p.arcSeconds : "-"), String(m.heatInput !== "" ? m.heatInput : "-"),
      String(p.passTemp), m.judgement, p.note || "",
    ]);
  });
  const table = b.appendTable(passTable);
  const headRow = table.getRow(0);
  for (let c = 0; c < headRow.getNumCells(); c++) {
    headRow.getCell(c).setBackgroundColor("#333333");
    headRow.getCell(c).editAsText().setBold(true).setForegroundColor("#ffffff");
  }
  for (let r = 1; r < table.getNumRows(); r++) {
    if (passTable[r][7] === "NG") {
      for (let c = 0; c < table.getRow(r).getNumCells(); c++) table.getRow(r).getCell(c).setBackgroundColor("#ffdddd");
    }
  }

  b.appendParagraph("");
  b.appendParagraph("検査員署名: ______________________　　管理者署名: ______________________");

  doc.saveAndClose();
  const docFile = DriveApp.getFileById(doc.getId());
  const pdfBlob = docFile.getAs("application/pdf").setName(docName + ".pdf");

  // 一時Docは削除せず「画像フォルダ」(製品名フォルダ・積層図フォルダの親)に移動して残す
  moveFileTo_(docFile, parentImageFolder_());

  // PDFはDriveに保存せず、base64でそのままブラウザに返して端末へ直接ダウンロードさせる
  return { pdfBase64: Utilities.base64Encode(pdfBlob.getBytes()), fileName: docName + ".pdf" };
}
