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

const SCREENS = ["home", "import", "check", "yearly", "project"];
function showScreen(name) {
  SCREENS.forEach(s => { document.getElementById("screen-" + s).style.display = (s === name) ? "block" : "none"; });
  document.getElementById("header-back-btn").style.display = (name === "home") ? "none" : "inline-block";
  if (name === "check") initCheckScreen();
  if (name === "yearly") initYearlyScreen();
  if (name === "project") initProjectScreen();
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
  yard_zero_error: "現場搬入費用なのに長さ・重量が共にゼロ",
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

// 業者「全て」を示す内部値(業者マスタの実名とは衝突しない固定値)
const CHECK_COMPANY_ALL = "ALL";

// 表示ラベル(短縮名)→業者マスタ上のフルネームの固定マッピング(この順序でボタン表示)。
// 「全て」は一番左に固定でデフォルト選択とする。
const CHECK_COMPANY_BUTTONS = [
  { label: "全て", name: CHECK_COMPANY_ALL },
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

// 締め日文字列("YYYY/MM/DD")を会計年度+月ボタンの値に変換する(fiscalMonthToClosingの逆変換)
function closingToFiscalYearMonth_(closingStr) {
  const [y, m] = closingStr.split("/").map(Number);
  return { fiscalYear: m === 12 ? y + 1 : y, month: m };
}

// 20日締めチェック画面の初期表示。以前は「年ボタンの選択肢取得」「デフォルト締め月の判定」
// 「集計結果取得」の3回に分けてGASを呼んでいたため、呼び出しごとのオーバーヘッド(スプレッド
// シートを開く処理等)が重なって表示が遅くなっていた。GAS側のgetCheckScreenInitに統合し、
// 1回のリクエストで全て取得する。
async function initCheckScreen() {
  checkState = { company: null, fiscalYear: null, month: null };
  document.getElementById("check-status-badge").innerHTML = "";
  document.getElementById("check-confirm-slot").innerHTML = "";
  const resultEl = document.getElementById("check-result");
  const yearContainer = document.getElementById("check-year-buttons");
  resultEl.innerHTML = "<p class=\"hint\">読み込み中...</p>";
  yearContainer.innerHTML = "<span class=\"hint\">読み込み中...</span>";

  let init;
  try {
    init = await apiGet("getCheckScreenInit");
  } catch (err) {
    resultEl.innerHTML = "<p class=\"import-status error\">エラー: " + err.message + "</p>";
    yearContainer.innerHTML = "";
    return;
  }

  checkState.company = CHECK_COMPANY_ALL;
  if (init.latestClosing) {
    const fm = closingToFiscalYearMonth_(init.latestClosing);
    checkState.fiscalYear = fm.fiscalYear;
    checkState.month = fm.month;
  }

  renderCheckCompanyButtons();
  renderCheckMonthButtons();
  renderCheckYearButtons(init.years);

  if (init.result) {
    renderCheckResultAll_(init.result);
  } else {
    resultEl.innerHTML = "";
  }
}

function renderCheckCompanyButtons() {
  const container = document.getElementById("check-company-buttons");
  container.innerHTML = CHECK_COMPANY_BUTTONS.map(c =>
    "<button type=\"button\" class=\"btn" + (c.name === checkState.company ? " btn-primary" : "") + "\" data-company=\"" + c.name + "\">" + c.label + "</button>"
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
    "<button type=\"button\" class=\"btn" + (m === checkState.month ? " btn-primary" : "") + "\" data-month=\"" + m + "\">" + m + "月</button>"
  ).join("");
  container.querySelectorAll("button").forEach(btn => {
    btn.onclick = () => {
      checkState.month = Number(btn.dataset.month);
      container.querySelectorAll("button").forEach(b => b.classList.toggle("btn-primary", b === btn));
      refreshCheckResult();
    };
  });
}

function renderCheckYearButtons(years) {
  const container = document.getElementById("check-year-buttons");
  if (years.length === 0) { container.innerHTML = "<span class=\"hint\">対象年度がありません</span>"; return; }
  container.innerHTML = years.slice().reverse().map(y =>
    "<div class=\"year-btn-item\"><button type=\"button\" class=\"btn" + (y === checkState.fiscalYear ? " btn-primary" : "") + "\" data-year=\"" + y + "\">" + y + "年</button>" +
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

// 1業者分の工事名別内訳テーブル(合計行込み)のHTMLを組み立てる。単独業者表示・「全て」表示の
// 両方から使う共通部品。
function closingCheckTableHtml_(data) {
  let html = "<div class=\"overflow-x\"><table class=\"data-table summary-table\"><thead><tr>" +
    "<th>工事名</th><th>コラム横持</th><th>製品等横持</th><th>その他横持</th><th>メッキ</th><th>現場搬入費用</th><th>重量</th><th>請求額</th><th>消費税</th><th>合計請求額</th></tr></thead><tbody>";
  data.projects.forEach(p => {
    html += "<tr><td>" + p.物件名 + "</td><td>" + fmtYen(p.コラム横持) + "</td><td>" + fmtYen(p.製品等横持) + "</td><td>" +
      fmtYen(p.その他横持) + "</td><td>" + fmtYen(p.メッキ) + "</td><td>" + fmtYen(p.現場搬入費用) + "</td><td>" +
      (p.重量 || 0).toFixed(1) + "t</td><td>" + fmtYen(p.請求額) + "</td><td>" + fmtYen(p.消費税) + "</td><td>" + fmtYen(p.合計請求額) + "</td></tr>";
  });
  const t = data.total;
  html += "<tr class=\"total-row\"><td>合計</td><td>" + fmtYen(t.コラム横持) + "</td><td>" + fmtYen(t.製品等横持) + "</td><td>" +
    fmtYen(t.その他横持) + "</td><td>" + fmtYen(t.メッキ) + "</td><td>" + fmtYen(t.現場搬入費用) + "</td><td>" +
    (t.重量 || 0).toFixed(1) + "t</td><td>" + fmtYen(t.請求額) + "</td><td>" + fmtYen(t.消費税) + "</td><td>" + fmtYen(t.合計請求額) + "</td></tr>";
  html += "</tbody></table></div>";
  return html;
}

function statusBadgeHtml_(status) {
  const badgeClass = status === "確定済み" ? "confirmed" : (status === "未確定" ? "pending" : "none");
  return "<span class=\"status-badge " + badgeClass + "\">" + status + "</span>";
}

function renderCheckResultData_(data) {
  const badgeEl = document.getElementById("check-status-badge");
  const confirmSlot = document.getElementById("check-confirm-slot");
  const resultEl = document.getElementById("check-result");
  badgeEl.innerHTML = statusBadgeHtml_(data.status);
  resultEl.innerHTML = closingCheckTableHtml_(data);
  confirmSlot.innerHTML = (data.status === "未確定" && data.projects.length > 0)
    ? "<button class=\"btn btn-confirm\" onclick=\"confirmCurrentClosing()\">この内容で確定する(担当者チェック完了・支払可)</button>"
    : "";
}

// 業者「全て」表示: 業者ごとに見出し(業者名+状態)とテーブルを並べる。業者をまたいだ
// 総合計は表示しない(確定操作も業者を個別に選んで行う運用のため、ここでは表示しない)。
function renderCheckResultAll_(data) {
  const badgeEl = document.getElementById("check-status-badge");
  const confirmSlot = document.getElementById("check-confirm-slot");
  const resultEl = document.getElementById("check-result");
  badgeEl.innerHTML = "";
  confirmSlot.innerHTML = "";
  if (data.companies.length === 0) {
    resultEl.innerHTML = "<p class=\"hint\">データがありません</p>";
    return;
  }
  resultEl.innerHTML = data.companies.map(c => {
    let block = "<h3>" + c.company + " " + statusBadgeHtml_(c.status) + "</h3>";
    block += c.projects.length > 0 ? closingCheckTableHtml_(c) : "<p class=\"hint\">データがありません</p>";
    return block;
  }).join("");
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
    if (checkState.company === CHECK_COMPANY_ALL) {
      const data = await apiGet("getClosingCheckAll", { closingMonth: closingMonth });
      renderCheckResultAll_(data);
    } else {
      const data = await apiGet("getClosingCheck", { company: checkState.company, closingMonth: closingMonth });
      renderCheckResultData_(data);
    }
  } catch (err) {
    resultEl.innerHTML = "<p class=\"import-status error\">エラー: " + err.message + "</p>";
    confirmSlot.innerHTML = "";
    badgeEl.innerHTML = "";
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

let yearlyState = { fiscalYear: null };

function sumFeeBuckets_(rows) {
  const total = { コラム横持: 0, 製品等横持: 0, その他横持: 0, メッキ: 0, 現場搬入費用: 0, 重量: 0, 合計: 0 };
  rows.forEach(r => {
    total.コラム横持 += r.コラム横持 || 0;
    total.製品等横持 += r.製品等横持 || 0;
    total.その他横持 += r.その他横持 || 0;
    total.メッキ += r.メッキ || 0;
    total.現場搬入費用 += r.現場搬入費用 || 0;
    total.重量 += r.重量 || 0;
    total.合計 += r.合計 || 0;
  });
  return total;
}

// 月別/工事別/業者別いずれも同じ列構成なので、合計行の描画を共通化する
function feeBucketTotalRowHtml_(r) {
  return "<tr class=\"total-row\"><td>合計</td><td>" + fmtYen(r.コラム横持) + "</td><td>" + fmtYen(r.製品等横持) + "</td><td>" +
    fmtYen(r.その他横持) + "</td><td>" + fmtYen(r.メッキ) + "</td><td>" + fmtYen(r.現場搬入費用) + "</td><td>" +
    (r.重量 || 0).toFixed(1) + "t</td><td class=\"grand-total-cell\">" + fmtYen(r.合計) + "</td></tr>";
}

async function initYearlyScreen() {
  yearlyState = { fiscalYear: null };
  await renderYearlyYearButtons();
}

async function renderYearlyYearButtons() {
  const container = document.getElementById("yearly-year-buttons");
  const resultEl = document.getElementById("yearly-result");
  container.innerHTML = "<span class=\"hint\">読み込み中...</span>";
  resultEl.innerHTML = "<p class=\"hint\">読み込み中...</p>";
  let init;
  try {
    init = await apiGet("getYearlySummaryInit", {});
  } catch (err) {
    container.innerHTML = "";
    resultEl.innerHTML = "<p class=\"import-status error\">エラー: " + err.message + "</p>";
    return;
  }
  const data = init.summary;
  yearlyState.fiscalYear = data.fiscalYearEnd;
  container.innerHTML = init.years.slice().reverse().map(y =>
    "<div class=\"year-btn-item\"><button type=\"button\" class=\"btn" + (y === yearlyState.fiscalYear ? " btn-primary" : "") + "\" data-year=\"" + y + "\">" + y + "年</button>" +
    "<div class=\"year-period\">" + fiscalYearPeriodLabel(y) + "</div></div>"
  ).join("");
  container.querySelectorAll("button").forEach(btn => {
    btn.onclick = () => {
      yearlyState.fiscalYear = Number(btn.dataset.year);
      container.querySelectorAll("button").forEach(b => b.classList.toggle("btn-primary", b === btn));
      loadYearlySummary();
    };
  });
  renderYearlyResult(data);
}

async function loadYearlySummary() {
  const resultEl = document.getElementById("yearly-result");
  resultEl.innerHTML = "<p class=\"hint\">読み込み中...</p>";
  try {
    const data = await apiGet("getYearlySummary", { fiscalYearEnd: yearlyState.fiscalYear });
    renderYearlyResult(data);
  } catch (err) {
    resultEl.innerHTML = "<p class=\"import-status error\">エラー: " + err.message + "</p>";
  }
}

function renderYearlyResult(data) {
  const resultEl = document.getElementById("yearly-result");
  let html = "<p><strong>" + data.fiscalYearEnd + "年度 合計請求額: " + fmtYen(data.合計請求額) + "</strong></p>";

  html += "<h3>月別内訳</h3><div class=\"overflow-x\"><table class=\"data-table summary-table\"><thead><tr><th>締め月</th><th>コラム横持</th><th>製品等横持</th><th>その他横持</th><th>メッキ</th><th>現場搬入費用</th><th>重量</th><th>合計</th></tr></thead><tbody>";
  data.月別.forEach(m => {
    html += "<tr><td>" + m.締め月 + "〆</td><td>" + fmtYen(m.コラム横持) + "</td><td>" + fmtYen(m.製品等横持) + "</td><td>" + fmtYen(m.その他横持) + "</td><td>" + fmtYen(m.メッキ) + "</td><td>" +
      fmtYen(m.現場搬入費用) + "</td><td>" + (m.重量 || 0).toFixed(1) + "t</td><td>" + fmtYen(m.合計) + "</td></tr>";
  });
  html += feeBucketTotalRowHtml_(sumFeeBuckets_(data.月別));
  html += "</tbody></table></div>";

  html += "<h3>工事別内訳</h3><div class=\"overflow-x\"><table class=\"data-table summary-table\"><thead><tr><th>物件名</th><th>コラム横持</th><th>製品等横持</th><th>その他横持</th><th>メッキ</th><th>現場搬入費用</th><th>重量</th><th>合計</th></tr></thead><tbody>";
  data.工事別.forEach(p => {
    html += "<tr><td>" + p.物件名 + "</td><td>" + fmtYen(p.コラム横持) + "</td><td>" + fmtYen(p.製品等横持) + "</td><td>" + fmtYen(p.その他横持) + "</td><td>" + fmtYen(p.メッキ) + "</td><td>" +
      fmtYen(p.現場搬入費用) + "</td><td>" + (p.重量 || 0).toFixed(1) + "t</td><td>" + fmtYen(p.合計) + "</td></tr>";
  });
  html += feeBucketTotalRowHtml_(sumFeeBuckets_(data.工事別));
  html += "</tbody></table></div>";

  html += "<h3>業者別内訳</h3><div class=\"overflow-x\"><table class=\"data-table summary-table\"><thead><tr><th>業者</th><th>コラム横持</th><th>製品等横持</th><th>その他横持</th><th>メッキ</th><th>現場搬入費用</th><th>重量</th><th>合計</th></tr></thead><tbody>";
  data.業者別.forEach(c => {
    html += "<tr><td>" + c.業者 + "</td><td>" + fmtYen(c.コラム横持) + "</td><td>" + fmtYen(c.製品等横持) + "</td><td>" + fmtYen(c.その他横持) + "</td><td>" + fmtYen(c.メッキ) + "</td><td>" +
      fmtYen(c.現場搬入費用) + "</td><td>" + (c.重量 || 0).toFixed(1) + "t</td><td>" + fmtYen(c.合計) + "</td></tr>";
  });
  html += feeBucketTotalRowHtml_(sumFeeBuckets_(data.業者別));
  html += "</tbody></table></div>";

  resultEl.innerHTML = html;
}

// ---------- 工事別内訳画面 ----------

let projectState = { name: null };

async function initProjectScreen() {
  projectState = { name: null };
  document.getElementById("project-result").innerHTML = "";
  const container = document.getElementById("project-buttons");
  container.innerHTML = "<span class=\"hint\">読み込み中...</span>";
  let names;
  try {
    names = await apiGet("listProjects");
  } catch (err) {
    container.innerHTML = "<p class=\"import-status error\">エラー: " + err.message + "</p>";
    return;
  }
  if (names.length === 0) { container.innerHTML = "<span class=\"hint\">物件データがありません</span>"; return; }
  container.innerHTML = names.map(n =>
    "<button type=\"button\" class=\"btn\" data-name=\"" + n + "\">" + n + "</button>"
  ).join("");
  container.querySelectorAll("button").forEach(btn => {
    btn.onclick = () => {
      projectState.name = btn.dataset.name;
      container.querySelectorAll("button").forEach(b => b.classList.toggle("btn-primary", b === btn));
      loadProjectDetail();
    };
  });
}

async function loadProjectDetail() {
  const resultEl = document.getElementById("project-result");
  resultEl.innerHTML = "<p class=\"hint\">読み込み中...</p>";
  try {
    const data = await apiGet("getProjectDetail", { projectName: projectState.name });
    let html = "<div class=\"overflow-x\"><table class=\"data-table summary-table\"><thead><tr><th>業者</th><th>コラム横持</th><th>製品等横持</th><th>その他横持</th><th>メッキ</th><th>現場搬入費用</th><th>重量</th><th>合計</th></tr></thead><tbody>";
    data.業者別.forEach(c => {
      html += "<tr><td>" + c.業者 + "</td><td>" + fmtYen(c.コラム横持) + "</td><td>" + fmtYen(c.製品等横持) + "</td><td>" + fmtYen(c.その他横持) + "</td><td>" + fmtYen(c.メッキ) + "</td><td>" +
        fmtYen(c.現場搬入費用) + "</td><td>" + (c.重量 || 0).toFixed(1) + "t</td><td>" + fmtYen(c.合計) + "</td></tr>";
    });
    html += feeBucketTotalRowHtml_(data.total);
    html += "</tbody></table></div>";

    const t = data.total;
    const perTonText = t.重量 > 0 ? fmtYen(t.合計 / t.重量) + "/t" : "現場搬入の重量が無いため算出不可";
    html += "<p class=\"per-ton-summary\">合計重量: " + (t.重量 || 0).toFixed(1) + "t　総額: " + fmtYen(t.合計) +
      "　<strong>1トン当たりの金額: " + perTonText + "</strong></p>";

    resultEl.innerHTML = html;
  } catch (err) {
    resultEl.innerHTML = "<p class=\"import-status error\">エラー: " + err.message + "</p>";
  }
}
