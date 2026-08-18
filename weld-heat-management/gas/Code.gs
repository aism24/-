/**
 * 「入熱・パス間温度管理」アプリのGAS APIバックエンド。
 * このファイルの内容をまるごとGASプロジェクトの Code.gs に貼り付けて使用してください。
 *
 * データはユーザーが用意した以下2枚のシートを使います(列の並び順は問いません。
 * 列名でマッチングするため、列名だけ一致していれば動作します)。
 *
 *   シート「入熱パス間記録」(1行=1パス、継手のヘッダー情報は全パス行に重複して保持):
 *     ID, 工事名, 検査日, 部材, サイズ(幅), 板厚, 部材サイズ, 溶接者, 検査員（入力者）,
 *     層数, パス数, 溶接長, 電流, 電圧, スタート, エンド, アークタイム, パス間温度,
 *     インターバル, 備考, 計測, 製品名, 材質, 溶接方法, 梁成, ウエブ厚, 気温, 順序,
 *     ルートギャップ, 開先角度, image, 積層図,
 *     入熱上限(kJ/cm), パス間温度下限(℃), パス間温度上限(℃), 判定
 *
 *   シート「情報」(マスタ選択肢。列ごとに独立したリスト):
 *     工事名, 溶接者, 検査員, 部材, 材質, 溶接方法
 *
 * 継手(一連の溶接)のグループ化は、「順序」列が1に戻った行を新しい継手の開始とみなす
 * ルールで行います(saveJointRecordは1継手分のパスを必ずまとめて書き込むため、
 * 同じ継手のパスは常にシート上で連続した行になります)。
 */

const SPREADSHEET_ID = "★ここにスプレッドシートIDを設定してください★";
const DRIVE_FOLDER_ID = "★ここにPDF・写真保存先DriveフォルダIDを設定してください★";

const RECORD_SHEET = "入熱パス間記録";
const MASTER_SHEET = "情報";

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
    return errRes_("不明なaction: " + action);
  } catch (err) {
    return errRes_(err.message);
  }
}

function doPost(e) {
  try {
    const body = JSON.parse(e.postData.contents);
    const action = body.action;
    if (action === "addMasterValue") return ok_(addMasterValue(body.column, body.value));
    if (action === "saveJointRecord") return ok_(saveJointRecord(body));
    if (action === "uploadImage") return ok_(uploadImage(body));
    if (action === "generatePdf") return ok_(generatePdf(body));
    return errRes_("不明なaction: " + action);
  } catch (err) {
    return errRes_(err.message);
  }
}

// ---------- 共通ヘルパー ----------

function ss_() { return SpreadsheetApp.openById(SPREADSHEET_ID); }

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
  return Utilities.formatDate(d, Session.getScriptTimeZone() || "Asia/Tokyo", "yyyy/MM/dd HH:mm:ss");
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

// ---------- マスタ選択肢(「情報」シート) ----------

function listMasterLists() {
  const sh = sheet_(MASTER_SHEET);
  const map = headerMap_(sh);
  const lastRow = sh.getLastRow();
  const result = {};
  Object.keys(map).forEach(colName => {
    if (colName === "__raw__") return;
    if (lastRow < 2) { result[colName] = []; return; }
    const values = sh.getRange(2, map[colName], lastRow - 1, 1).getValues();
    result[colName] = values.map(r => String(r[0] || "").trim()).filter(v => v !== "");
  });
  return result;
}

function addMasterValue(column, value) {
  const v = String(value || "").trim();
  if (!column || !v) throw new Error("列名と値を指定してください");
  return withLock_(() => {
    const sh = sheet_(MASTER_SHEET);
    const map = headerMap_(sh);
    const col = findCol_(map, column);
    if (!col) throw new Error("「情報」シートに列が見つかりません: " + column);
    const lastRow = Math.max(sh.getLastRow(), 1);
    const existing = lastRow >= 2 ? sh.getRange(2, col, lastRow - 1, 1).getValues().map(r => String(r[0] || "").trim()) : [];
    if (existing.indexOf(v) !== -1) return { added: false };
    const emptyIdx = existing.findIndex(x => x === "");
    const writeRow = emptyIdx !== -1 ? emptyIdx + 2 : lastRow + 1;
    sh.getRange(writeRow, col).setValue(v);
    return { added: true };
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
      setIf("梁成", header["梁成"] || "");
      setIf("ウエブ厚", header["ウエブ厚"] || "");
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

    return { savedRows: rows.length, overallResult: overallResult };
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
      "溶接方法": getField_(first, "溶接方法"), "梁成": getField_(first, "梁成"), "ウエブ厚": getField_(first, "ウエブ厚"),
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

// ---------- 画像アップロード(写真・積層図) ----------

function uploadImage(payload) {
  const folder = DriveApp.getFolderById(DRIVE_FOLDER_ID);
  const decoded = Utilities.base64Decode(payload.base64);
  const mimeType = (payload.mimeType === "image/heic" || payload.mimeType === "image/heif") ? "image/jpeg" : payload.mimeType;
  const blob = Utilities.newBlob(decoded, mimeType, payload.fileName);
  const file = folder.createFile(blob);
  file.setSharing(DriveApp.Access.ANYONE_WITH_LINK, DriveApp.Permission.VIEW);
  return { url: "https://drive.google.com/file/d/" + file.getId() + "/view" };
}

// ---------- PDF出力 ----------

function generatePdf(body) {
  const header = body.header || {};
  const passes = body.passes || [];

  const folder = DriveApp.getFolderById(DRIVE_FOLDER_ID);
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
  const pdfFile = folder.createFile(pdfBlob);
  pdfFile.setSharing(DriveApp.Access.ANYONE_WITH_LINK, DriveApp.Permission.VIEW);
  docFile.setTrashed(true);

  return { pdfUrl: "https://drive.google.com/file/d/" + pdfFile.getId() + "/view" };
}
