// デプロイ済みGAS WebアプリのURL(/exec で終わるURL)。デプロイ後にここへ差し替えてください。
const GAS_API_URL = "https://script.google.com/macros/s/AKfycbx09IHUZ2c74n0MYCZPV-XUixcKRtEENLkeLhL-xQ_x0BhUIXGM47NUYAEmxv3wp-QksQ/exec";

// ---------- GAS API共通 ----------

async function apiGet(action, params) {
  const url = new URL(GAS_API_URL);
  url.searchParams.set("action", action);
  if (params) Object.keys(params).forEach(k => { if (params[k] !== undefined && params[k] !== null) url.searchParams.set(k, params[k]); });
  const res = await fetch(url.toString(), { method: "GET" });
  if (!res.ok) throw new Error("サーバーエラー(HTTP " + res.status + ")");
  const json = await res.json();
  if (json.status !== "success") throw new Error(json.message || "取得に失敗しました");
  return json.data;
}

// Content-Type: text/plain でCORSプリフライト(OPTIONS)を回避する(GASはOPTIONS未対応のため)
async function apiPost(action, payload) {
  const res = await fetch(GAS_API_URL, {
    method: "POST",
    headers: { "Content-Type": "text/plain;charset=utf-8" },
    body: JSON.stringify(Object.assign({ action: action }, payload)),
  });
  if (!res.ok) throw new Error("サーバーエラー(HTTP " + res.status + ")");
  const json = await res.json();
  if (json.status !== "success") throw new Error(json.message || "処理に失敗しました");
  return json.data;
}

// ---------- 画面切り替え ----------

const SCREENS = ["home", "import", "check", "yearly"];
function showScreen(name) {
  SCREENS.forEach(s => { document.getElementById("screen-" + s).style.display = (s === name) ? "block" : "none"; });
  document.getElementById("header-back-btn").style.display = (name === "home") ? "none" : "inline-block";
  if (name === "check") initCheckScreen();
}
function goHome() { showScreen("home"); }

// ---------- 業者マスタのキャッシュ ----------

const FALLBACK_COMPANIES = ["日本興運", "誠和梱包", "用瀬運送", "川崎クレーン", "鳥取グレーン", "山陰運送"];
let companiesCache = null;

async function getCompanies() {
  if (companiesCache) return companiesCache;
  try {
    companiesCache = await apiGet("listCompanies");
  } catch (e) {
    companiesCache = FALLBACK_COMPANIES;
  }
  return companiesCache;
}

// ---------- セル値の変換ヘルパー ----------

function pad2(n) { return (n < 10 ? "0" : "") + n; }

function excelSerialToDate_(serial) {
  const utcDays = Math.floor(serial - 25569);
  const d = new Date(utcDays * 86400 * 1000);
  return new Date(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate());
}

function excelDateToISO(v) {
  if (v instanceof Date && !isNaN(v)) {
    return v.getFullYear() + "-" + pad2(v.getMonth() + 1) + "-" + pad2(v.getDate());
  }
  if (typeof v === "number") {
    const d = excelSerialToDate_(v);
    return d.getFullYear() + "-" + pad2(d.getMonth() + 1) + "-" + pad2(d.getDate());
  }
  if (typeof v === "string" && v.trim()) {
    const d = new Date(v);
    if (!isNaN(d)) return d.getFullYear() + "-" + pad2(d.getMonth() + 1) + "-" + pad2(d.getDate());
  }
  return "";
}

function cellToTimeString(v) {
  if (v instanceof Date && !isNaN(v)) return pad2(v.getHours()) + ":" + pad2(v.getMinutes());
  if (typeof v === "number") {
    const totalMin = Math.round(v * 24 * 60);
    return pad2(Math.floor(totalMin / 60) % 24) + ":" + pad2(totalMin % 60);
  }
  return cellToString(v);
}

function cellToString(v) { return v == null ? "" : String(v).trim(); }

function cellToNumber(v) {
  if (typeof v === "number") return v;
  const n = parseFloat(String(v == null ? "" : v).replace(/[^0-9.\-]/g, ""));
  return isNaN(n) ? 0 : n;
}

// ---------- ファイル名からの業者・締め月の自動判定(GAS側と同じロジック) ----------

function normalizeSaki(s) { return String(s || "").replace(/﨑/g, "崎"); }

async function detectFromFileName(fileName) {
  const dateMatch = fileName.match(/(\d{4})(\d{2})(\d{2})/);
  if (!dateMatch) return null;
  const closingMonth = dateMatch[1] + "/" + dateMatch[2] + "/" + dateMatch[3];
  const companies = await getCompanies();
  const normalizedName = normalizeSaki(fileName);
  const company = companies.find(c => normalizedName.indexOf(normalizeSaki(c)) !== -1);
  if (!company) return null;
  return { company: company, closingMonth: closingMonth };
}

// ---------- 「配車」シートの解析 ----------

// 「物件名」列を基準にした列オフセット(元Excelの列構成: C=物件名を起点とした相対位置)
const HAULING_COL_OFFSETS = {
  物件名: 0, 積日: 1, 降日: 2, ブロック: 3, 節: 4, 積荷: 6, 現場待機: 7, 車種: 8,
  最大長さ: 25, 総重量: 26, 通常単価: 28, エキストラ1: 29, エキストラ2: 30,
};

function parseHaulingSheet(workbook) {
  const sheetName = workbook.SheetNames.find(n => n === "配車") || workbook.SheetNames.find(n => n.indexOf("配車") !== -1);
  if (!sheetName) throw new Error("「配車」シートが見つかりません");
  const sheet = workbook.Sheets[sheetName];
  const grid = XLSX.utils.sheet_to_json(sheet, { header: 1, raw: true, defval: "" });

  let headerRowIdx = -1, projectColIdx = -1;
  for (let i = 0; i < grid.length; i++) {
    const idx = grid[i].indexOf("物件名");
    if (idx !== -1) { headerRowIdx = i; projectColIdx = idx; break; }
  }
  if (headerRowIdx === -1) throw new Error("「配車」シートに見出し行(物件名)が見つかりません");

  const rows = [];
  for (let r = headerRowIdx + 1; r < grid.length; r++) {
    const line = grid[r];
    const get = key => line[projectColIdx + HAULING_COL_OFFSETS[key]];
    const project = cellToString(get("物件名"));
    const arrivalRaw = get("降日");
    if (!project && (arrivalRaw === "" || arrivalRaw == null)) continue;
    rows.push({
      物件名: project,
      積日: excelDateToISO(get("積日")),
      降日: excelDateToISO(get("降日")),
      ブロック: cellToString(get("ブロック")),
      節: cellToString(get("節")),
      積荷: cellToString(get("積荷")),
      現場待機: cellToTimeString(get("現場待機")),
      車種: cellToString(get("車種")),
      最大長さ: cellToString(get("最大長さ")),
      総重量: cellToNumber(get("総重量")),
      通常単価: cellToNumber(get("通常単価")),
      エキストラ1: cellToNumber(get("エキストラ1")),
      エキストラ2: cellToNumber(get("エキストラ2")),
    });
  }
  return rows;
}

// ---------- インポート画面 ----------

let pendingImport = null; // { fileName, rows }

async function onFileSelected(event) {
  await handleSelectedFile(event.target.files[0]);
}

async function handleSelectedFile(file) {
  const detectedInfo = document.getElementById("detected-info");
  const submitBtn = document.getElementById("import-submit-btn");
  const statusEl = document.getElementById("import-status");
  document.getElementById("excluded-rows-container").innerHTML = "";
  statusEl.textContent = "";
  statusEl.className = "import-status";
  detectedInfo.style.display = "none";
  submitBtn.style.display = "none";
  pendingImport = null;
  if (!file) return;

  try {
    const detected = await detectFromFileName(file.name);
    if (!detected) {
      statusEl.textContent = "ファイル名から業者・締め日を判定できませんでした。ファイル名を確認してください: " + file.name;
      statusEl.className = "import-status error";
      return;
    }
    const buf = await file.arrayBuffer();
    const workbook = XLSX.read(buf, { type: "array", cellDates: true });
    const rows = parseHaulingSheet(workbook);

    pendingImport = { fileName: file.name, rows: rows };
    detectedInfo.style.display = "block";
    detectedInfo.textContent = "業者: " + detected.company + " / 締め月: " + detected.closingMonth + "〆 として認識しました(配車データ " + rows.length + "行)";
    submitBtn.style.display = "inline-block";
  } catch (err) {
    statusEl.textContent = "読み込みエラー: " + err.message;
    statusEl.className = "import-status error";
  }
}

// 画面全体へのドラッグ&ドロップ対応(「Excel取り込み」画面が表示されている時のみ)
function setupImportDragDrop() {
  const isImportScreenActive = () => document.getElementById("screen-import").style.display !== "none";
  let dragDepth = 0;
  window.addEventListener("dragenter", event => {
    if (!isImportScreenActive()) return;
    event.preventDefault();
    dragDepth++;
    document.body.classList.add("drag-over");
  });
  window.addEventListener("dragover", event => {
    if (!isImportScreenActive()) return;
    event.preventDefault();
  });
  window.addEventListener("dragleave", () => {
    if (!isImportScreenActive()) return;
    dragDepth = Math.max(0, dragDepth - 1);
    if (dragDepth === 0) document.body.classList.remove("drag-over");
  });
  window.addEventListener("drop", event => {
    if (!isImportScreenActive()) return;
    event.preventDefault();
    dragDepth = 0;
    document.body.classList.remove("drag-over");
    const file = event.dataTransfer && event.dataTransfer.files && event.dataTransfer.files[0];
    if (file) handleSelectedFile(file);
  });
}
document.addEventListener("DOMContentLoaded", setupImportDragDrop);

function resetImportSelection() {
  document.getElementById("file-input").value = "";
  document.getElementById("detected-info").style.display = "none";
  document.getElementById("import-submit-btn").style.display = "none";
  pendingImport = null;
}

const REASON_LABELS = {
  delete_request: "削除依頼(前月確定済みと重複)",
  date_fix_request: "降日修正依頼(前月分だが重複データなし)",
  next_month_review: "来月分・担当者確認",
  date_mismatch_review: "締め月ズレ・担当者確認",
  date_invalid: "日付形式エラー",
};

function renderExcludedRows(excludedRows) {
  const container = document.getElementById("excluded-rows-container");
  if (!excludedRows || excludedRows.length === 0) { container.innerHTML = ""; return; }
  let html = "<h3 style=\"margin-top:16px;\">対象外の行(" + excludedRows.length + "件) — 業者に確認のうえ、正しいファイルを再アップロードしてください</h3>";
  html += "<div class=\"overflow-x\"><table class=\"data-table excluded-table\"><thead><tr>" +
    "<th>理由</th><th>物件名</th><th>降日</th><th>ブロック</th><th>車種</th><th>詳細</th></tr></thead><tbody>";
  excludedRows.forEach(item => {
    const r = item.row || {};
    const tag = "<span class=\"reason-tag reason-" + item.reason + "\">" + (REASON_LABELS[item.reason] || item.reason) + "</span>";
    html += "<tr><td>" + tag + "</td><td>" + (r.物件名 || "") + "</td><td>" + (r.降日 || "") + "</td><td>" +
      (r.ブロック || "") + "</td><td>" + (r.車種 || "") + "</td><td style=\"text-align:left;\">" + (item.detail || "") + "</td></tr>";
  });
  html += "</tbody></table></div>";
  container.innerHTML = html;
}

async function submitImport(force) {
  if (!pendingImport) return;
  const statusEl = document.getElementById("import-status");
  const submitBtn = document.getElementById("import-submit-btn");
  submitBtn.disabled = true;
  statusEl.textContent = "取り込み中...";
  statusEl.className = "import-status";
  try {
    const payload = force ? Object.assign({}, pendingImport, { force: true }) : pendingImport;
    const result = await apiPost("importHaulingFile", payload);
    if (result.duplicate) {
      statusEl.textContent = "";
      const proceed = confirm(
        "この内容は、既に取り込まれている " + result.company + " " + result.closingMonth + "〆 のデータと完全に一致しています。\n" +
        "同じファイルを間違って選択していませんか？\n\n" +
        "そのまま同じ内容で再取込みする場合は「OK」を、取り消す場合は「キャンセル」を押してください。"
      );
      if (proceed) {
        await submitImport(true);
      } else {
        statusEl.textContent = "取り込みを中止しました(重複のため)。";
        statusEl.className = "import-status error";
      }
      return;
    }
    if (result.imported) {
      statusEl.textContent = "取り込み完了: " + result.company + " " + result.closingMonth + "〆 (" + result.importedCount + "行)。" +
        "内容を確認し、問題なければ「20日締めチェック」画面で確定してください。";
      statusEl.className = "import-status success";
      document.getElementById("excluded-rows-container").innerHTML = "";
      resetImportSelection();
    } else {
      statusEl.textContent = "対象外の行があったため、今回の取り込みは保存されませんでした。内容を確認し、正しいファイルを再アップロードしてください。";
      statusEl.className = "import-status error";
      renderExcludedRows(result.excludedRows);
    }
  } catch (err) {
    alert("エラー: " + err.message);
    document.getElementById("excluded-rows-container").innerHTML = "";
    resetImportSelection();
    statusEl.textContent = "";
    statusEl.className = "import-status";
  } finally {
    submitBtn.disabled = false;
  }
}

// ---------- 20日締めチェック画面 ----------

// 表示ラベル(短縮名)→業者マスタ上のフルネームの固定マッピング(この順序でボタン表示)
const CHECK_COMPANY_BUTTONS = [
  { label: "日興", name: "日本興運" },
  { label: "誠和", name: "誠和梱包" },
  { label: "用瀬", name: "用瀬運送" },
  { label: "川崎", name: "川崎クレーン" },
  { label: "鳥グ", name: "鳥取グレーン" },
  { label: "山陰", name: "山陰運送" },
];
// 会計年度(11月21日始まり)に合わせた月ボタンの並び順
const CHECK_MONTH_ORDER = [12, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11];

let checkState = { company: null, fiscalYear: null, month: null };

function fiscalYearPeriodLabel(fiscalYear) {
  return (fiscalYear - 1) + "/11/21〜" + fiscalYear + "/11/20";
}

// 会計年度+月ボタン(12〜1月)から、実際の締め日文字列("YYYY/MM/20")を組み立てる。
// 12月は前年の12月分(例: 2026年度の12月＝2025/12/20締め)を指す。
function fiscalMonthToClosing(fiscalYear, month) {
  return month === 12 ? (fiscalYear - 1) + "/12/20" : fiscalYear + "/" + pad2(month) + "/20";
}

function fmtYen(n) { return "¥" + Math.round(n || 0).toLocaleString("ja-JP"); }

async function initCheckScreen() {
  checkState = { company: null, fiscalYear: null, month: null };
  document.getElementById("check-status-badge").innerHTML = "";
  document.getElementById("check-confirm-slot").innerHTML = "";
  document.getElementById("check-result").innerHTML = "";
  renderCheckCompanyButtons();
  renderCheckMonthButtons();
  await renderCheckYearButtons();
}

function renderCheckCompanyButtons() {
  const container = document.getElementById("check-company-buttons");
  container.innerHTML = CHECK_COMPANY_BUTTONS.map(c =>
    "<button type=\"button\" class=\"btn\" data-company=\"" + c.name + "\">" + c.label + "</button>"
  ).join("");
  container.querySelectorAll("button").forEach(btn => {
    btn.onclick = () => {
      checkState.company = btn.dataset.company;
      container.querySelectorAll("button").forEach(b => b.classList.toggle("btn-primary", b === btn));
      refreshCheckResult();
    };
  });
}

function renderCheckMonthButtons() {
  const container = document.getElementById("check-month-buttons");
  container.innerHTML = CHECK_MONTH_ORDER.map(m =>
    "<button type=\"button\" class=\"btn\" data-month=\"" + m + "\">" + m + "月</button>"
  ).join("");
  container.querySelectorAll("button").forEach(btn => {
    btn.onclick = () => {
      checkState.month = Number(btn.dataset.month);
      container.querySelectorAll("button").forEach(b => b.classList.toggle("btn-primary", b === btn));
      refreshCheckResult();
    };
  });
}

async function renderCheckYearButtons() {
  const container = document.getElementById("check-year-buttons");
  container.innerHTML = "<span class=\"hint\">読み込み中...</span>";
  let years;
  try {
    years = await apiGet("listAvailableYears");
  } catch (e) {
    years = [];
  }
  if (years.length === 0) { container.innerHTML = "<span class=\"hint\">対象年度がありません</span>"; return; }
  container.innerHTML = years.map(y =>
    "<div class=\"year-btn-item\"><button type=\"button\" class=\"btn\" data-year=\"" + y + "\">" + y + "年</button>" +
    "<div class=\"year-period\">" + fiscalYearPeriodLabel(y) + "</div></div>"
  ).join("");
  container.querySelectorAll("button").forEach(btn => {
    btn.onclick = () => {
      checkState.fiscalYear = Number(btn.dataset.year);
      container.querySelectorAll("button").forEach(b => b.classList.toggle("btn-primary", b === btn));
      refreshCheckResult();
    };
  });
}

async function refreshCheckResult() {
  const badgeEl = document.getElementById("check-status-badge");
  const confirmSlot = document.getElementById("check-confirm-slot");
  const resultEl = document.getElementById("check-result");
  if (!checkState.company || !checkState.fiscalYear || !checkState.month) {
    badgeEl.innerHTML = "";
    confirmSlot.innerHTML = "";
    resultEl.innerHTML = "";
    return;
  }
  const closingMonth = fiscalMonthToClosing(checkState.fiscalYear, checkState.month);
  resultEl.innerHTML = "<p class=\"hint\">読み込み中...</p>";
  try {
    const data = await apiGet("getClosingCheck", { company: checkState.company, closingMonth: closingMonth });
    const badgeClass = data.status === "確定済み" ? "confirmed" : (data.status === "未確定" ? "pending" : "none");
    badgeEl.innerHTML = "<span class=\"status-badge " + badgeClass + "\">" + data.status + "</span>";
    let html = "<div class=\"overflow-x\"><table class=\"data-table\"><thead><tr>" +
      "<th>工事名</th><th>コラム横持</th><th>製品横持</th><th>他横持</th><th>メッキ費用</th><th>現場搬入費用</th><th>重量</th><th>請求額</th><th>消費税</th><th>合計請求額</th></tr></thead><tbody>";
    data.projects.forEach(p => {
      html += "<tr><td>" + p.物件名 + "</td><td>" + fmtYen(p.コラム横持) + "</td><td>" + fmtYen(p.製品横持) + "</td><td>" +
        fmtYen(p.他横持) + "</td><td>" + fmtYen(p.メッキ費用) + "</td><td>" + fmtYen(p.現場搬入費用) + "</td><td>" +
        (p.重量 || 0).toFixed(1) + "t</td><td>" + fmtYen(p.請求額) + "</td><td>" + fmtYen(p.消費税) + "</td><td>" + fmtYen(p.合計請求額) + "</td></tr>";
    });
    const t = data.total;
    html += "<tr class=\"total-row\"><td>合計</td><td>" + fmtYen(t.コラム横持) + "</td><td>" + fmtYen(t.製品横持) + "</td><td>" +
      fmtYen(t.他横持) + "</td><td>" + fmtYen(t.メッキ費用) + "</td><td>" + fmtYen(t.現場搬入費用) + "</td><td>" +
      (t.重量 || 0).toFixed(1) + "t</td><td>" + fmtYen(t.請求額) + "</td><td>" + fmtYen(t.消費税) + "</td><td>" + fmtYen(t.合計請求額) + "</td></tr>";
    html += "</tbody></table></div>";
    resultEl.innerHTML = html;
    confirmSlot.innerHTML = (data.status === "未確定" && data.projects.length > 0)
      ? "<button class=\"btn btn-confirm\" onclick=\"confirmCurrentClosing()\">この内容で確定する(担当者チェック完了・支払可)</button>"
      : "";
  } catch (err) {
    resultEl.innerHTML = "<p class=\"import-status error\">エラー: " + err.message + "</p>";
    confirmSlot.innerHTML = "";
  }
}

async function confirmCurrentClosing() {
  const company = checkState.company;
  const closingMonth = fiscalMonthToClosing(checkState.fiscalYear, checkState.month);
  if (!confirm(company + " " + closingMonth + "〆 を確定します(以後、修正するには担当者による対応が必要になります)。よろしいですか?")) return;
  try {
    await apiPost("confirmClosing", { company: company, closingMonth: closingMonth });
    await refreshCheckResult();
  } catch (err) {
    alert("エラー: " + err.message);
  }
}

// ---------- 年度集計画面 ----------

async function loadYearlySummary() {
  const fyeInput = document.getElementById("yearly-fye").value;
  const resultEl = document.getElementById("yearly-result");
  resultEl.innerHTML = "<p class=\"hint\">読み込み中...</p>";
  try {
    const data = await apiGet("getYearlySummary", fyeInput ? { fiscalYearEnd: fyeInput } : {});
    let html = "<p><strong>" + data.fiscalYearEnd + "年度 合計請求額: " + fmtYen(data.合計請求額) + "</strong></p>";

    html += "<h3>月別内訳</h3><div class=\"overflow-x\"><table class=\"data-table\"><thead><tr><th>締め月</th><th>コラム横持</th><th>製品横持</th><th>他横持</th><th>メッキ費用</th><th>現場搬入費用</th><th>重量</th><th>合計</th></tr></thead><tbody>";
    data.月別.forEach(m => {
      html += "<tr><td>" + m.締め月 + "〆</td><td>" + fmtYen(m.コラム横持) + "</td><td>" + fmtYen(m.製品横持) + "</td><td>" + fmtYen(m.他横持) + "</td><td>" + fmtYen(m.メッキ費用) + "</td><td>" +
        fmtYen(m.現場搬入費用) + "</td><td>" + (m.重量 || 0).toFixed(1) + "t</td><td>" + fmtYen(m.合計) + "</td></tr>";
    });
    html += "</tbody></table></div>";

    html += "<h3>工事別内訳</h3><div class=\"overflow-x\"><table class=\"data-table\"><thead><tr><th>物件名</th><th>コラム横持</th><th>製品横持</th><th>他横持</th><th>メッキ費用</th><th>現場搬入費用</th><th>重量</th><th>合計</th></tr></thead><tbody>";
    data.工事別.forEach(p => {
      html += "<tr><td>" + p.物件名 + "</td><td>" + fmtYen(p.コラム横持) + "</td><td>" + fmtYen(p.製品横持) + "</td><td>" + fmtYen(p.他横持) + "</td><td>" + fmtYen(p.メッキ費用) + "</td><td>" +
        fmtYen(p.現場搬入費用) + "</td><td>" + (p.重量 || 0).toFixed(1) + "t</td><td>" + fmtYen(p.合計) + "</td></tr>";
    });
    html += "</tbody></table></div>";

    html += "<h3>業者別内訳</h3><div class=\"overflow-x\"><table class=\"data-table\"><thead><tr><th>業者</th><th>コラム横持</th><th>製品横持</th><th>他横持</th><th>メッキ費用</th><th>現場搬入費用</th><th>重量</th><th>合計</th></tr></thead><tbody>";
    data.業者別.forEach(c => {
      html += "<tr><td>" + c.業者 + "</td><td>" + fmtYen(c.コラム横持) + "</td><td>" + fmtYen(c.製品横持) + "</td><td>" + fmtYen(c.他横持) + "</td><td>" + fmtYen(c.メッキ費用) + "</td><td>" +
        fmtYen(c.現場搬入費用) + "</td><td>" + (c.重量 || 0).toFixed(1) + "t</td><td>" + fmtYen(c.合計) + "</td></tr>";
    });
    html += "</tbody></table></div>";

    resultEl.innerHTML = html;
  } catch (err) {
    resultEl.innerHTML = "<p class=\"import-status error\">エラー: " + err.message + "</p>";
  }
}
