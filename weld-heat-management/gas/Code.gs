/**
 * 「入熱・パス間温度管理」アプリのGAS APIバックエンド。
 * このファイルの内容をまるごとGASプロジェクトの Code.gs に貼り付けて使用してください。
 *
 * フロントエンド（index.html/app.js）はGitHub Pagesで配信し、
 * このスクリプトはJSON専用APIとしてdoGet/doPostのみを提供します。
 *
 * データは以下4枚のシートに保存します（スプレッドシートに事前に作成してください）。
 *   Projects : id, name, createdAt
 *   Parts    : id, projectId, code, steelType, thickness, createdAt
 *   Joints   : id, partId, position, posture, method, material, weldLength,
 *              welder, inspector, heatInputLimit, tempMin, tempMax,
 *              status, createdAt, completedAt, overallResult, pdfUrl
 *   Passes   : id, jointId, passNo, recordedAt, current, voltage, speed,
 *              heatInput, passTemp, judgement, note
 */

const SPREADSHEET_ID = "★ここにスプレッドシートIDを設定してください★";
const DRIVE_FOLDER_ID = "★ここにPDF保存先DriveフォルダIDを設定してください★";

const SHEETS = {
  PROJECTS: "Projects",
  PARTS: "Parts",
  JOINTS: "Joints",
  PASSES: "Passes",
};

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
    if (action === "listProjects") return ok_(listProjects());
    if (action === "listParts") return ok_(listParts(e.parameter.projectId));
    if (action === "listJoints") return ok_(listJoints(e.parameter.partId));
    if (action === "getJoint") return ok_(getJoint(e.parameter.jointId));
    if (action === "listRecentJoints") return ok_(listRecentJoints(Number(e.parameter.limit) || 30));
    if (action === "searchJoints") return ok_(searchJoints(e.parameter.keyword || ""));
    return errRes_("不明なaction: " + action);
  } catch (err) {
    return errRes_(err.message);
  }
}

function doPost(e) {
  try {
    const body = JSON.parse(e.postData.contents);
    const action = body.action;
    if (action === "addProject") return ok_(addProject(body));
    if (action === "addPart") return ok_(addPart(body));
    if (action === "addJoint") return ok_(addJoint(body));
    if (action === "addPass") return ok_(addPass(body));
    if (action === "completeJoint") return ok_(completeJoint(body));
    if (action === "generatePdf") return ok_(generatePdf(body));
    return errRes_("不明なaction: " + action);
  } catch (err) {
    return errRes_(err.message);
  }
}

// ---------- 共通ヘルパー ----------

function sheet_(name) {
  const ss = SpreadsheetApp.openById(SPREADSHEET_ID);
  const sh = ss.getSheetByName(name);
  if (!sh) throw new Error("シートが見つかりません: " + name);
  return sh;
}

// A列(id)を走査して次の連番IDを返す
function nextId_(sh) {
  const lastRow = sh.getLastRow();
  if (lastRow < 2) return 1;
  const ids = sh.getRange(2, 1, lastRow - 1, 1).getValues().map(r => Number(r[0]) || 0);
  return Math.max(0, ...ids) + 1;
}

// シート全体を「idをキーにしたオブジェクトの配列」として取得
function allRows_(sh, headerNames) {
  const lastRow = sh.getLastRow();
  if (lastRow < 2) return [];
  const values = sh.getRange(2, 1, lastRow - 1, headerNames.length).getValues();
  return values
    .filter(row => row[0] !== "" && row[0] !== null)
    .map(row => {
      const obj = {};
      headerNames.forEach((name, i) => { obj[name] = row[i]; });
      return obj;
    });
}

function fmtDateTime_(d) {
  if (!(d instanceof Date) || isNaN(d)) return "";
  return Utilities.formatDate(d, Session.getScriptTimeZone() || "Asia/Tokyo", "yyyy/MM/dd HH:mm");
}

// ---------- Projects ----------

const PROJECT_COLS = ["id", "name", "createdAt"];

function listProjects() {
  const rows = allRows_(sheet_(SHEETS.PROJECTS), PROJECT_COLS);
  rows.forEach(r => { r.createdAt = fmtDateTime_(r.createdAt); });
  rows.reverse();
  return rows;
}

function addProject(body) {
  const name = String(body.name || "").trim();
  if (!name) throw new Error("工事名を入力してください");
  const sh = sheet_(SHEETS.PROJECTS);
  const id = nextId_(sh);
  const now = new Date();
  sh.appendRow([id, name, now]);
  return { id: id, name: name, createdAt: fmtDateTime_(now) };
}

// ---------- Parts ----------

const PART_COLS = ["id", "projectId", "code", "steelType", "thickness", "createdAt"];

function listParts(projectId) {
  const rows = allRows_(sheet_(SHEETS.PARTS), PART_COLS)
    .filter(r => String(r.projectId) === String(projectId));
  rows.forEach(r => { r.createdAt = fmtDateTime_(r.createdAt); });
  rows.reverse();
  return rows;
}

function addPart(body) {
  const projectId = Number(body.projectId);
  const code = String(body.code || "").trim();
  if (!projectId) throw new Error("工事が指定されていません");
  if (!code) throw new Error("部材符号を入力してください");
  const sh = sheet_(SHEETS.PARTS);
  const id = nextId_(sh);
  const now = new Date();
  sh.appendRow([id, projectId, code, body.steelType || "", body.thickness || "", now]);
  return { id: id };
}

// ---------- Joints ----------

const JOINT_COLS = [
  "id", "partId", "position", "posture", "method", "material", "weldLength",
  "welder", "inspector", "heatInputLimit", "tempMin", "tempMax",
  "status", "createdAt", "completedAt", "overallResult", "pdfUrl",
];

function listJoints(partId) {
  const rows = allRows_(sheet_(SHEETS.JOINTS), JOINT_COLS)
    .filter(r => String(r.partId) === String(partId));
  rows.forEach(r => {
    r.createdAt = fmtDateTime_(r.createdAt);
    r.completedAt = fmtDateTime_(r.completedAt);
  });
  rows.reverse();
  return rows;
}

function getJoint(jointId) {
  const joint = allRows_(sheet_(SHEETS.JOINTS), JOINT_COLS)
    .find(r => String(r.id) === String(jointId));
  if (!joint) throw new Error("継手が見つかりません");
  joint.createdAt = fmtDateTime_(joint.createdAt);
  joint.completedAt = fmtDateTime_(joint.completedAt);

  const part = allRows_(sheet_(SHEETS.PARTS), PART_COLS).find(r => String(r.id) === String(joint.partId));
  const project = part ? allRows_(sheet_(SHEETS.PROJECTS), PROJECT_COLS).find(r => String(r.id) === String(part.projectId)) : null;

  const passes = allRows_(sheet_(SHEETS.PASSES), PASS_COLS)
    .filter(r => String(r.jointId) === String(jointId))
    .sort((a, b) => a.passNo - b.passNo);
  passes.forEach(p => { p.recordedAt = fmtDateTime_(p.recordedAt); });

  return {
    joint: joint,
    part: part || null,
    project: project || null,
    passes: passes,
  };
}

function addJoint(body) {
  const partId = Number(body.partId);
  if (!partId) throw new Error("部材が指定されていません");
  const position = String(body.position || "").trim();
  if (!position) throw new Error("継手位置・名称を入力してください");
  const sh = sheet_(SHEETS.JOINTS);
  const id = nextId_(sh);
  const now = new Date();
  sh.appendRow([
    id, partId, position,
    body.posture || "", body.method || "", body.material || "",
    body.weldLength || "", body.welder || "", body.inspector || "",
    body.heatInputLimit || "", body.tempMin || "", body.tempMax || "",
    "進行中", now, "", "", "",
  ]);
  return { id: id };
}

function findJointRowIndex_(sh, jointId) {
  const lastRow = sh.getLastRow();
  if (lastRow < 2) return -1;
  const ids = sh.getRange(2, 1, lastRow - 1, 1).getValues();
  for (let i = 0; i < ids.length; i++) {
    if (String(ids[i][0]) === String(jointId)) return i + 2;
  }
  return -1;
}

function completeJoint(body) {
  const jointId = Number(body.jointId);
  const sh = sheet_(SHEETS.JOINTS);
  const rowIndex = findJointRowIndex_(sh, jointId);
  if (rowIndex === -1) throw new Error("継手が見つかりません");

  const passes = allRows_(sheet_(SHEETS.PASSES), PASS_COLS).filter(r => String(r.jointId) === String(jointId));
  if (passes.length === 0) throw new Error("パスが1件も記録されていません");
  const overallResult = passes.some(p => p.judgement === "NG") ? "NG" : "OK";

  const now = new Date();
  sh.getRange(rowIndex, 13).setValue("完了");       // status
  sh.getRange(rowIndex, 15).setValue(now);           // completedAt
  sh.getRange(rowIndex, 16).setValue(overallResult); // overallResult
  return { status: "完了", overallResult: overallResult, completedAt: fmtDateTime_(now) };
}

// ---------- Passes ----------

const PASS_COLS = [
  "id", "jointId", "passNo", "recordedAt", "current", "voltage",
  "speed", "heatInput", "passTemp", "judgement", "note",
];

function addPass(body) {
  const jointId = Number(body.jointId);
  if (!jointId) throw new Error("継手が指定されていません");

  const jointRow = allRows_(sheet_(SHEETS.JOINTS), JOINT_COLS).find(r => String(r.id) === String(jointId));
  if (!jointRow) throw new Error("継手が見つかりません");
  if (jointRow.status === "完了") throw new Error("この継手は既に完了しています");

  const existingPasses = allRows_(sheet_(SHEETS.PASSES), PASS_COLS).filter(r => String(r.jointId) === String(jointId));
  const passNo = existingPasses.length + 1;

  const current = Number(body.current) || "";
  const voltage = Number(body.voltage) || "";
  const speed = body.speed !== undefined && body.speed !== null && body.speed !== "" ? Number(body.speed) : "";
  const passTemp = Number(body.passTemp);
  if (isNaN(passTemp)) throw new Error("パス間温度を入力してください");

  let heatInput = "";
  if (speed && current && voltage) {
    // 入熱量(kJ/cm) = 60 × 電流(A) × 電圧(V) / (1000 × 溶接速度(cm/min))
    heatInput = Math.round((60 * current * voltage / (1000 * speed)) * 100) / 100;
  }

  let judgement = "OK";
  const reasons = [];
  if (jointRow.tempMin !== "" && passTemp < Number(jointRow.tempMin)) { judgement = "NG"; reasons.push("温度不足"); }
  if (jointRow.tempMax !== "" && passTemp > Number(jointRow.tempMax)) { judgement = "NG"; reasons.push("温度超過"); }
  if (heatInput !== "" && jointRow.heatInputLimit !== "" && heatInput > Number(jointRow.heatInputLimit)) {
    judgement = "NG"; reasons.push("入熱超過");
  }

  const sh = sheet_(SHEETS.PASSES);
  const id = nextId_(sh);
  const now = new Date();
  const note = reasons.length ? (reasons.join("・") + (body.note ? " / " + body.note : "")) : (body.note || "");
  sh.appendRow([id, jointId, passNo, now, current, voltage, speed, heatInput, passTemp, judgement, note]);

  return {
    id: id, passNo: passNo, recordedAt: fmtDateTime_(now),
    current: current, voltage: voltage, speed: speed, heatInput: heatInput,
    passTemp: passTemp, judgement: judgement, note: note,
  };
}

// ---------- 履歴・検索 ----------

function joinJointWithNames_(joint) {
  const part = allRows_(sheet_(SHEETS.PARTS), PART_COLS).find(r => String(r.id) === String(joint.partId));
  const project = part ? allRows_(sheet_(SHEETS.PROJECTS), PROJECT_COLS).find(r => String(r.id) === String(part.projectId)) : null;
  return Object.assign({}, joint, {
    partCode: part ? part.code : "",
    projectName: project ? project.name : "",
  });
}

function listRecentJoints(limit) {
  const rows = allRows_(sheet_(SHEETS.JOINTS), JOINT_COLS).map(joinJointWithNames_);
  rows.forEach(r => { r.createdAt = fmtDateTime_(r.createdAt); r.completedAt = fmtDateTime_(r.completedAt); });
  rows.reverse();
  return rows.slice(0, limit);
}

function searchJoints(keyword) {
  const kw = String(keyword || "").trim().toLowerCase();
  let rows = allRows_(sheet_(SHEETS.JOINTS), JOINT_COLS).map(joinJointWithNames_);
  if (kw) {
    rows = rows.filter(r =>
      String(r.projectName).toLowerCase().indexOf(kw) !== -1 ||
      String(r.partCode).toLowerCase().indexOf(kw) !== -1 ||
      String(r.position).toLowerCase().indexOf(kw) !== -1 ||
      String(r.welder).toLowerCase().indexOf(kw) !== -1 ||
      String(r.inspector).toLowerCase().indexOf(kw) !== -1
    );
  }
  rows.forEach(r => { r.createdAt = fmtDateTime_(r.createdAt); r.completedAt = fmtDateTime_(r.completedAt); });
  rows.reverse();
  return rows.slice(0, 200);
}

// ---------- PDF出力 ----------

function generatePdf(body) {
  const jointId = Number(body.jointId);
  const detail = getJoint(jointId);
  const joint = detail.joint, part = detail.part, project = detail.project, passes = detail.passes;

  const folder = DriveApp.getFolderById(DRIVE_FOLDER_ID);
  const docName = "入熱パス間温度管理記録_" + (project ? project.name : "") + "_" + (part ? part.code : "") + "_" + joint.position;
  const doc = DocumentApp.create(docName);
  const body_ = doc.getBody();
  body_.setPageWidth(595).setPageHeight(842).setMarginTop(36).setMarginBottom(36).setMarginLeft(36).setMarginRight(36);

  body_.appendParagraph("入熱・パス間温度管理記録").setHeading(DocumentApp.ParagraphHeading.HEADING1);

  const headerTable = [
    ["工事名", project ? project.name : "", "部材符号", part ? part.code : ""],
    ["鋼材種別", part ? String(part.steelType) : "", "板厚(mm)", part ? String(part.thickness) : ""],
    ["継手位置・名称", joint.position, "溶接姿勢", joint.posture],
    ["溶接方法", joint.method, "溶接材料", joint.material],
    ["溶接士", joint.welder, "検査員", joint.inspector],
    ["入熱上限(kJ/cm)", String(joint.heatInputLimit || "-"), "パス間温度範囲(℃)",
      (joint.tempMin || "-") + " 〜 " + (joint.tempMax || "-")],
    ["記録開始", joint.createdAt, "記録完了", joint.completedAt || "-"],
    ["総合判定", joint.overallResult || "-", "総パス数", String(passes.length)],
  ];
  body_.appendTable(headerTable);
  body_.appendParagraph("");

  body_.appendParagraph("パス記録").setHeading(DocumentApp.ParagraphHeading.HEADING2);
  const passTable = [["パス", "時刻", "電流(A)", "電圧(V)", "速度(cm/min)", "入熱(kJ/cm)", "パス間温度(℃)", "判定", "備考"]];
  passes.forEach(p => {
    passTable.push([
      String(p.passNo), p.recordedAt, String(p.current), String(p.voltage),
      p.speed === "" ? "-" : String(p.speed), p.heatInput === "" ? "-" : String(p.heatInput),
      String(p.passTemp), p.judgement, p.note || "",
    ]);
  });
  const table = body_.appendTable(passTable);
  const headerRow = table.getRow(0);
  for (let c = 0; c < headerRow.getNumCells(); c++) {
    headerRow.getCell(c).setBackgroundColor("#333333");
    headerRow.getCell(c).editAsText().setBold(true).setForegroundColor("#ffffff");
  }
  for (let r = 1; r < table.getNumRows(); r++) {
    if (passTable[r][7] === "NG") {
      for (let c = 0; c < table.getRow(r).getNumCells(); c++) {
        table.getRow(r).getCell(c).setBackgroundColor("#ffdddd");
      }
    }
  }

  body_.appendParagraph("");
  body_.appendParagraph("検査員署名: ______________________　　管理者署名: ______________________");

  doc.saveAndClose();
  const docFile = DriveApp.getFileById(doc.getId());
  const pdfBlob = docFile.getAs("application/pdf").setName(docName + ".pdf");
  const pdfFile = folder.createFile(pdfBlob);
  pdfFile.setSharing(DriveApp.Access.ANYONE_WITH_LINK, DriveApp.Permission.VIEW);
  docFile.setTrashed(true);

  const pdfUrl = "https://drive.google.com/file/d/" + pdfFile.getId() + "/view";

  const sh = sheet_(SHEETS.JOINTS);
  const rowIndex = findJointRowIndex_(sh, jointId);
  if (rowIndex !== -1) sh.getRange(rowIndex, 17).setValue(pdfUrl);

  return { pdfUrl: pdfUrl };
}
