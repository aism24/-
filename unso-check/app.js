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

const SCREENS = ["home", "import", "check", "yearly", "project", "company", "delete"];
// opts.preselect: { company, closingMonth } — 20日締めチェック画面を、業者「全て」+最新月の
// デフォルト表示ではなく、指定した業者+締め月の結果を開いた状態で表示する(Excel取込み直後、
// その場で確定を促すために使う)。
function showScreen(name, opts) {
  SCREENS.forEach(s => { document.getElementById("screen-" + s).style.display = (s === name) ? "block" : "none"; });
  document.getElementById("header-back-btn").style.display = (name === "home") ? "none" : "inline-block";
  // 呼び出し元(submitImport)が画面の表示完了を待てるよう、各初期化処理のPromiseを返す
  if (name === "check") return initCheckScreen(opts && opts.preselect);
  if (name === "yearly") return initYearlyScreen();
  if (name === "project") return initProjectScreen();
  if (name === "company") return initCompanyScreen();
  if (name === "delete") return initDeleteScreen();
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

// ---------- 配車データキャッシュ(20日締めチェック・年度集計・工事別内訳・業者別内訳で共通) ----------
// この4画面はいずれも同じ配車データ(gas/Code.gsのgetHaulingRawData)を業者・年度・月・物件で
// 絞り込んで集計するだけなので、画面遷移・ボタン切り替えのたびにGASを呼び直すのではなく、
// 最初に1回だけ取得してブラウザ内に保持し、以降の絞り込み・集計はこのキャッシュに対する
// ローカル計算(このファイル内に移植した集計ロジック)で完結させる。これにより、GAS呼び出し
// 1回あたり数秒規模かかる応答時間を、ボタンを押すたびに払わずに済む。
// アプリを開いた直後に1回だけ読み込み中モーダルを見せて先読みし(下記DOMContentLoaded参照)、
// 以降はこのキャッシュだけで完結させる。配車データ・締め状態が変わる操作(Excel取込み・確定・
// 確定済みデータ削除)の直後はrefreshHaulingDataInBackground()でキャッシュを破棄しつつ即座に
// 裏で再取得するため、その後の画面遷移でも読み込み中モーダルが再び出ることは基本的に無い。
let haulingDataCache = null;
let haulingDataPromise = null;

function invalidateHaulingData() {
  haulingDataCache = null;
  haulingDataPromise = null;
}

async function ensureHaulingData() {
  if (haulingDataCache) return haulingDataCache;
  if (!haulingDataPromise) {
    haulingDataPromise = apiGet("getHaulingRawData").then(raw => {
      const rows = raw.rows.map(arr => {
        const obj = {};
        raw.fields.forEach((f, i) => { obj[f] = arr[i]; });
        return obj;
      });
      const statusRows = raw.statusRows.map(arr => {
        const obj = {};
        raw.statusFields.forEach((f, i) => { obj[f] = arr[i]; });
        return obj;
      });
      haulingDataCache = {
        rows: rows,
        statusRows: statusRows,
        companies: raw.companies,
        currentFiscalYearEnd: raw.currentFiscalYearEnd,
      };
      return haulingDataCache;
    });
    haulingDataPromise.catch(() => { haulingDataPromise = null; });
  }
  return haulingDataPromise;
}

// 取得済み(キャッシュ済み)ならモーダルを出さずに即座に返す(体感上ほぼ瞬時)。
// 未取得(初回、またはinvalidateHaulingData後の初回アクセス)の場合のみ読み込み中モーダルを出す。
async function ensureHaulingDataWithModal() {
  if (haulingDataCache) return haulingDataCache;
  showLoadingModal();
  try {
    const data = await ensureHaulingData();
    hideLoadingModal(true);
    return data;
  } catch (err) {
    hideLoadingModal(false);
    throw err;
  }
}

// 取込み・確定・削除でデータが変わった直後に呼ぶ。キャッシュを破棄したうえで、その場で
// バックグラウンド再取得を開始しておく(呼び出し元は完了を待たない)。ホームへ戻ったあと
// 次にどれかの画面を開いた時点では、多くの場合この再取得が既に完了しているため、
// 読み込み中モーダルを再び表示せずに済む(アプリ起動時の1回だけモーダルを見せたい、という
// 方針に合わせるため)。再取得中にユーザーが画面を開いた場合は、ensureHaulingDataWithModal()が
// この進行中の取得を待つだけで、二重に取得が走ることはない。
function refreshHaulingDataInBackground() {
  invalidateHaulingData();
  ensureHaulingData().catch(() => {});
}

// アプリを開いた直後に1回だけ、配車データを先読みしておく(以降の画面はキャッシュ済みの
// データに対するローカル計算のみになるため、ボタンを押すたびに読み込み中を見せずに済む)。
document.addEventListener("DOMContentLoaded", () => {
  ensureHaulingDataWithModal().catch(() => {});
});

// ---------- 集計ロジック(gas/Code.gsのclassifyFeeType_〜getCompanyDetailと同一ロジックのJS移植) ----------
// ここから先はGAS側を都度呼び出す代わりに、ensureHaulingData()で取得済みのキャッシュに対して
// ブラウザ内で同じ計算を行うための関数群。ロジックはgas/Code.gsと完全に一致させること
// (集計結果は請求額に直結するため、ロジックを変更する場合は必ずgas/Code.gs側と両方直したうえで、
// 本番データを使った突き合わせ確認を行うこと)。

function classifyFeeType(block) {
  const b = String(block || "");
  if (b.indexOf("メッキ") !== -1) return "メッキ";
  if (b.indexOf("横持ち1") !== -1) return "コラム横持";
  if (b.indexOf("横持ち3") !== -1) return "製品等横持";
  if (b.indexOf("横持ち2") !== -1 || b.indexOf("横持ち4") !== -1) return "その他横持";
  return "現場搬入費用";
}

function toNum(v) { return Number(v) || 0; }

function emptyFeeBucketLocal() {
  return { コラム横持: 0, 製品等横持: 0, その他横持: 0, メッキ: 0, 現場搬入費用: 0, 重量: 0, 合計: 0 };
}

// 締め日文字列("YYYY/MM/DD")が属する会計年度(11月21日始まり、翌年11月20日決算)を返す
function fiscalYearForClosing(closingStr) {
  const parts = String(closingStr).split("/").map(Number);
  return parts[1] === 12 ? parts[0] + 1 : parts[0];
}

// 会計年度(fiscalYearEnd)内の12回の締め月を昇順で返す
function fiscalYearClosingMonthsLocal(fiscalYearEnd) {
  const months = [(fiscalYearEnd - 1) + "/12/20"];
  for (let m = 1; m <= 11; m++) months.push(fiscalYearEnd + "/" + pad2(m) + "/20");
  return months;
}

// 配車データの全行から、実際に登録されている締め月の会計年度を重複排除・昇順で返す
// (現在の会計年度は、データが無くても常に含める)
function availableYearsFromRowsLocal(rows, currentFiscalYearEnd) {
  const years = {};
  years[currentFiscalYearEnd] = true;
  rows.forEach(r => { if (r.締め月) years[fiscalYearForClosing(r.締め月)] = true; });
  return Object.keys(years).map(Number).sort((a, b) => a - b);
}

function findStatusLocal(statusRows, company, closingMonth) {
  return statusRows.find(r => r.業者 === company && r.締め月 === closingMonth) || null;
}

// 20日締めチェック(単一業者分): buildClosingCheckResult_のJS版
function buildClosingCheckResultLocal(company, closingMonth, rows, statusRows) {
  const byProject = {};
  rows.forEach(r => {
    const key = r.物件名 || "(物件名なし)";
    if (!byProject[key]) byProject[key] = { 物件名: key, コラム横持: 0, 製品等横持: 0, その他横持: 0, メッキ: 0, 現場搬入費用: 0, 重量: 0 };
    const feeType = classifyFeeType(r.ブロック);
    byProject[key][feeType] = (byProject[key][feeType] || 0) + toNum(r.費用額);
    if (feeType === "現場搬入費用") byProject[key].重量 += toNum(r.総重量);
  });
  const projects = Object.keys(byProject).map(k => {
    const p = byProject[k];
    p.請求額 = p.コラム横持 + p.製品等横持 + p.その他横持 + p.メッキ + p.現場搬入費用;
    p.消費税 = Math.round(p.請求額 * 0.1);
    p.合計請求額 = p.請求額 + p.消費税;
    return p;
  });
  const total = projects.reduce((acc, p) => {
    acc.コラム横持 += p.コラム横持; acc.製品等横持 += p.製品等横持; acc.その他横持 += p.その他横持;
    acc.メッキ += p.メッキ; acc.現場搬入費用 += p.現場搬入費用;
    acc.重量 += p.重量; acc.請求額 += p.請求額; acc.消費税 += p.消費税; acc.合計請求額 += p.合計請求額;
    return acc;
  }, { コラム横持: 0, 製品等横持: 0, その他横持: 0, メッキ: 0, 現場搬入費用: 0, 重量: 0, 請求額: 0, 消費税: 0, 合計請求額: 0 });
  const status = findStatusLocal(statusRows, company, closingMonth);
  return { company: company, closingMonth: closingMonth, status: status ? status.状態 : "未取込", projects: projects, total: total };
}

function getClosingCheckLocal(data, company, closingMonth) {
  const rows = data.rows.filter(r => r.業者 === company && r.締め月 === closingMonth);
  return buildClosingCheckResultLocal(company, closingMonth, rows, data.statusRows);
}

function getClosingCheckAllLocal(data, closingMonth) {
  const byCompany = {};
  data.rows.forEach(r => {
    if (r.締め月 !== closingMonth) return;
    if (!byCompany[r.業者]) byCompany[r.業者] = [];
    byCompany[r.業者].push(r);
  });
  const companies = data.companies.map(company =>
    buildClosingCheckResultLocal(company, closingMonth, byCompany[company] || [], data.statusRows)
  );
  return { closingMonth: closingMonth, companies: companies };
}

// 「年度全体集計」: 年度・工事別・業者別の合計、費用区分別の内訳、月別(締め月単位)の内訳を返す
function getYearlySummaryLocal(data, fiscalYearEnd) {
  const fye = fiscalYearEnd || data.currentFiscalYearEnd;
  const closingMonths = fiscalYearClosingMonthsLocal(fye);
  const closingSet = {};
  closingMonths.forEach(c => { closingSet[c] = true; });
  const rows = data.rows.filter(r => closingSet[r.締め月]);

  const byProject = {};
  const byCompany = {};
  const byMonth = {};
  closingMonths.forEach(c => { byMonth[c] = Object.assign({ 締め月: c }, emptyFeeBucketLocal()); });

  rows.forEach(r => {
    const amt = toNum(r.費用額);
    const weight = toNum(r.総重量);
    const feeType = classifyFeeType(r.ブロック);
    const yardWeight = feeType === "現場搬入費用" ? weight : 0;

    const pKey = r.物件名 || "(物件名なし)";
    if (!byProject[pKey]) byProject[pKey] = Object.assign({ 物件名: pKey }, emptyFeeBucketLocal());
    byProject[pKey][feeType] += amt;
    byProject[pKey].重量 += yardWeight;
    byProject[pKey].合計 += amt;

    const cKey = r.業者 || "(業者不明)";
    if (!byCompany[cKey]) byCompany[cKey] = Object.assign({ 業者: cKey }, emptyFeeBucketLocal());
    byCompany[cKey][feeType] += amt;
    byCompany[cKey].重量 += yardWeight;
    byCompany[cKey].合計 += amt;

    byMonth[r.締め月][feeType] += amt;
    byMonth[r.締め月].重量 += yardWeight;
    byMonth[r.締め月].合計 += amt;
  });

  const total = rows.reduce((acc, r) => acc + toNum(r.費用額), 0);
  return {
    fiscalYearEnd: fye,
    合計請求額: total,
    工事別: Object.keys(byProject).map(k => byProject[k]),
    業者別: Object.keys(byCompany).map(k => byCompany[k]),
    月別: closingMonths.map(c => byMonth[c]),
  };
}

// 工事別内訳画面の物件ボタン用: 実際に登録されている物件名を、最後の締め月が属する年度ごとに
// 区分けして返す(新しい年度が先頭、各年度内はアルファベット順)
function listProjectsLocal(data) {
  const latestClosingByProject = {};
  data.rows.forEach(r => {
    if (!r.物件名 || !r.締め月) return;
    if (!latestClosingByProject[r.物件名] || r.締め月 > latestClosingByProject[r.物件名]) {
      latestClosingByProject[r.物件名] = r.締め月;
    }
  });
  const byYear = {};
  Object.keys(latestClosingByProject).forEach(name => {
    const year = fiscalYearForClosing(latestClosingByProject[name]);
    if (!byYear[year]) byYear[year] = [];
    byYear[year].push(name);
  });
  return Object.keys(byYear).map(Number).sort((a, b) => b - a).map(year => ({
    year: year,
    names: byYear[year].sort(),
  }));
}

// 工事別内訳: 指定した物件名の配車データを業者ごと・締め月ごとに集計する
function getProjectDetailLocal(data, projectName) {
  const rows = data.rows.filter(r => r.物件名 === projectName);
  let 開始日 = "", 終了日 = "";
  rows.forEach(r => {
    if (!r.降日) return;
    if (!開始日 || r.降日 < 開始日) 開始日 = r.降日;
    if (!終了日 || r.降日 > 終了日) 終了日 = r.降日;
  });

  const byCompany = {};
  const byMonth = {};
  rows.forEach(r => {
    const amt = toNum(r.費用額);
    const feeType = classifyFeeType(r.ブロック);
    const yardWeight = feeType === "現場搬入費用" ? toNum(r.総重量) : 0;
    const cKey = r.業者 || "(業者不明)";
    if (!byCompany[cKey]) byCompany[cKey] = Object.assign({ 業者: cKey }, emptyFeeBucketLocal());
    byCompany[cKey][feeType] += amt;
    byCompany[cKey].重量 += yardWeight;
    byCompany[cKey].合計 += amt;

    const mKey = r.締め月 || "(締め月不明)";
    if (!byMonth[mKey]) byMonth[mKey] = Object.assign({ 締め月: mKey }, emptyFeeBucketLocal());
    byMonth[mKey][feeType] += amt;
    byMonth[mKey].重量 += yardWeight;
    byMonth[mKey].合計 += amt;
  });

  const companies = Object.keys(byCompany).map(k => byCompany[k]);
  const months = Object.keys(byMonth).sort().map(k => byMonth[k]);
  const total = companies.reduce((acc, c) => {
    acc.コラム横持 += c.コラム横持; acc.製品等横持 += c.製品等横持; acc.その他横持 += c.その他横持;
    acc.メッキ += c.メッキ; acc.現場搬入費用 += c.現場搬入費用;
    acc.重量 += c.重量; acc.合計 += c.合計;
    return acc;
  }, emptyFeeBucketLocal());

  return { 物件名: projectName, 開始日: 開始日, 終了日: 終了日, 業者別: companies, 締め月別: months, total: total };
}

// 業者別内訳: 指定した業者の配車データを締め月ごと・物件名ごとに集計する。
// fiscalYearEndsArr: 選択中の会計年度末の配列(空配列なら全期間が対象)。
function getCompanyDetailLocal(data, company, fiscalYearEndsArr) {
  const allRows = data.rows.filter(r => (r.業者 || "(業者不明)") === company);
  const selectedYears = fiscalYearEndsArr || [];
  const yearsToSeed = selectedYears.length > 0 ? selectedYears : availableYearsFromRowsLocal(allRows, data.currentFiscalYearEnd);
  const rows = selectedYears.length > 0
    ? allRows.filter(r => selectedYears.indexOf(fiscalYearForClosing(r.締め月)) !== -1)
    : allRows;

  let 開始日 = "", 終了日 = "";
  rows.forEach(r => {
    if (!r.降日) return;
    if (!開始日 || r.降日 < 開始日) 開始日 = r.降日;
    if (!終了日 || r.降日 > 終了日) 終了日 = r.降日;
  });

  const byMonth = {};
  yearsToSeed.forEach(fye => {
    fiscalYearClosingMonthsLocal(fye).forEach(c => {
      if (!byMonth[c]) byMonth[c] = Object.assign({ 締め月: c }, emptyFeeBucketLocal());
    });
  });

  const byProject = {};
  rows.forEach(r => {
    const amt = toNum(r.費用額);
    const feeType = classifyFeeType(r.ブロック);
    const yardWeight = feeType === "現場搬入費用" ? toNum(r.総重量) : 0;

    if (byMonth[r.締め月]) {
      byMonth[r.締め月][feeType] += amt;
      byMonth[r.締め月].重量 += yardWeight;
      byMonth[r.締め月].合計 += amt;
    }

    const pKey = r.物件名 || "(物件名なし)";
    if (!byProject[pKey]) byProject[pKey] = Object.assign({ 物件名: pKey }, emptyFeeBucketLocal());
    byProject[pKey][feeType] += amt;
    byProject[pKey].重量 += yardWeight;
    byProject[pKey].合計 += amt;
  });

  const months = Object.keys(byMonth).sort().map(k => byMonth[k]);
  const projects = Object.keys(byProject).map(k => byProject[k]);
  const total = projects.reduce((acc, p) => {
    acc.コラム横持 += p.コラム横持; acc.製品等横持 += p.製品等横持; acc.その他横持 += p.その他横持;
    acc.メッキ += p.メッキ; acc.現場搬入費用 += p.現場搬入費用;
    acc.重量 += p.重量; acc.合計 += p.合計;
    return acc;
  }, emptyFeeBucketLocal());

  return {
    業者: company,
    開始日: 開始日, 終了日: 終了日,
    年度一覧: availableYearsFromRowsLocal(allRows, data.currentFiscalYearEnd),
    締め月別: months,
    物件別: projects,
    total: total,
  };
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

// ロゴを短時間(2秒)以内に5回連続タップすると、データ削除画面へ移動する隠しコマンド。
// ホーム画面には「データ削除はコマンド入力」というヒントテキストのみを表示し、ロゴ自体に
// クリック可能を示す見た目上の変化は付けない。
function setupSecretLogoTap() {
  const logo = document.querySelector(".header-logo");
  if (!logo) return;
  const TAP_COUNT = 5;
  const TAP_WINDOW_MS = 2000;
  let count = 0;
  let lastTap = 0;
  logo.addEventListener("click", () => {
    const now = Date.now();
    count = (now - lastTap <= TAP_WINDOW_MS) ? count + 1 : 1;
    lastTap = now;
    if (count >= TAP_COUNT) {
      count = 0;
      showScreen("delete");
    }
  });
}
document.addEventListener("DOMContentLoaded", setupSecretLogoTap);

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

// ---------- 読み込み中ポップアップ(GAS呼び出しを伴う全ての画面表示・更新で共通) ----------
// カード内に「読み込み中...」を個別表示する代わりに、画面中央のポップアップ+データバーで
// 読み込み中であることを示す。20秒かけて95%まで進み(それ以上は実際の完了を待つ)、実際に
// 表示が完了した時点で100%まで一気に進めてから閉じる。
// showLoadingModal()は、複数のGAS呼び出しを連続して挟む一連の処理(例: Excel取込み→
// 20日締めチェック画面への自動遷移→その業者+締め月の内容表示)の間に何度呼ばれても、既に
// 表示中であれば進捗をリセットしない(処理が続いている間、体感上は1本の読み込み中として見せる)。
let loadingModalTimer = null;
let loadingModalStart = null;

function showLoadingModal() {
  const overlay = document.getElementById("loading-progress-overlay");
  if (overlay.style.display === "flex") return;
  const bar = document.getElementById("loading-progress-bar");
  bar.style.width = "0%";
  overlay.style.display = "flex";

  loadingModalStart = Date.now();
  const DURATION_MS = 20000;
  const TARGET_PERCENT = 95;
  clearInterval(loadingModalTimer);
  loadingModalTimer = setInterval(() => {
    const percent = Math.min(TARGET_PERCENT, ((Date.now() - loadingModalStart) / DURATION_MS) * TARGET_PERCENT);
    bar.style.width = percent + "%";
  }, 200);
}

// completed=true: 100%まで進めてから閉じる(一連の処理が全て成功し、表示が完了した時点)
// completed=false: 進行を止めて即座に閉じる(重複確認・対象外行・エラー等、この後表示を続けないため)
function hideLoadingModal(completed) {
  clearInterval(loadingModalTimer);
  loadingModalTimer = null;
  const overlay = document.getElementById("loading-progress-overlay");
  if (completed) {
    document.getElementById("loading-progress-bar").style.width = "100%";
    setTimeout(() => { overlay.style.display = "none"; }, 300);
  } else {
    overlay.style.display = "none";
  }
}

// エラー表示ポップアップ(ブラウザ標準alertの代替)
function showErrorModal(message) {
  document.getElementById("error-modal-message").textContent = message;
  document.getElementById("error-modal-overlay").style.display = "flex";
}
function closeErrorModal() {
  document.getElementById("error-modal-overlay").style.display = "none";
}

// 確認ポップアップ(ブラウザ標準confirmの代替)。resolveConfirmModal(true/false)が
// 呼ばれるまで待つPromiseを返すので、呼び出し側は const proceed = await showConfirmModal(...) で使う。
let confirmModalResolve_ = null;
function showConfirmModal(message) {
  document.getElementById("confirm-modal-message").textContent = message;
  document.getElementById("confirm-modal-overlay").style.display = "flex";
  return new Promise(resolve => { confirmModalResolve_ = resolve; });
}
function resolveConfirmModal(result) {
  document.getElementById("confirm-modal-overlay").style.display = "none";
  if (confirmModalResolve_) {
    confirmModalResolve_(result);
    confirmModalResolve_ = null;
  }
}

async function submitImport(force) {
  if (!pendingImport) return;
  const statusEl = document.getElementById("import-status");
  const submitBtn = document.getElementById("import-submit-btn");
  submitBtn.disabled = true;
  statusEl.textContent = "";
  statusEl.className = "import-status";
  showLoadingModal();
  try {
    const payload = force ? Object.assign({}, pendingImport, { force: true }) : pendingImport;
    const result = await apiPost("importHaulingFile", payload);
    if (result.duplicate) {
      hideLoadingModal(false);
      statusEl.textContent = "";
      const proceed = await showConfirmModal(
        "この内容は、既に取り込まれている " + result.company + " " + result.closingMonth + "〆 のデータと完全に一致しています。\n" +
        "同じファイルを間違って選択していませんか？\n\n" +
        "そのまま同じ内容で再取込みする場合は「続行する」を、取り消す場合は「キャンセル」を押してください。"
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
      statusEl.textContent = "";
      statusEl.className = "import-status";
      document.getElementById("excluded-rows-container").innerHTML = "";
      resetImportSelection();
      // 配車データが変わったため、キャッシュを破棄してその場で再取得を始めておく。
      refreshHaulingDataInBackground();
      // 取込み成功後は「20日締めチェック」画面のこの業者+締め月の結果へ自動的に移動し、
      // その場で確定を促す(確定を忘れたまま次のファイルを選んでしまうことを防ぐため)。
      // 別のファイルを取り込みたい場合は、ホームから「Excelファイルを取り込む」をやり直す。
      // (読み込み中ポップアップは、遷移先のinitCheckScreen内のensureHaulingDataWithModal()が閉じる)
      await showScreen("check", { preselect: { company: result.company, closingMonth: result.closingMonth } });
    } else {
      hideLoadingModal(false);
      statusEl.textContent = "対象外の行があったため、今回の取り込みは保存されませんでした。内容を確認し、正しいファイルを再アップロードしてください。";
      statusEl.className = "import-status error";
      renderExcludedRows(result.excludedRows);
    }
  } catch (err) {
    hideLoadingModal(false);
    showErrorModal("エラー: " + err.message);
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
// preselect: { company, closingMonth } が指定された場合、デフォルトの業者「全て」+最新月では
// なく、その業者+締め月の結果を開いた状態で表示する(Excel取込み直後の確定促し用)。
// 【本更新で修正】以前はpreselect指定時も一旦「全て」の結果をGAS側で計算させてから使わずに
// 捨て、refreshCheckResult()で単体の結果を別リクエストとして取り直していた(配車データの
// 二重読み込み+GAS呼び出しがもう1往復発生していた)。GAS側にpreselectの業者+締め月を渡し、
// 最初から単体の結果を返してもらう形にして、この無駄な往復を無くした。
async function initCheckScreen(preselect) {
  checkState = { company: null, fiscalYear: null, month: null };
  document.getElementById("check-status-badge").innerHTML = "";
  document.getElementById("check-confirm-slot").innerHTML = "";
  const resultEl = document.getElementById("check-result");
  const yearContainer = document.getElementById("check-year-buttons");

  let data;
  try {
    data = await ensureHaulingDataWithModal();
  } catch (err) {
    resultEl.innerHTML = "<p class=\"import-status error\">エラー: " + err.message + "</p>";
    yearContainer.innerHTML = "";
    return;
  }

  const years = availableYearsFromRowsLocal(data.rows, data.currentFiscalYearEnd);
  let latestClosing = null;
  data.rows.forEach(r => { if (r.締め月 && (!latestClosing || r.締め月 > latestClosing)) latestClosing = r.締め月; });

  if (preselect) {
    const fm = closingToFiscalYearMonth_(preselect.closingMonth);
    checkState.company = preselect.company;
    checkState.fiscalYear = fm.fiscalYear;
    checkState.month = fm.month;
  } else {
    checkState.company = CHECK_COMPANY_ALL;
    if (latestClosing) {
      const fm = closingToFiscalYearMonth_(latestClosing);
      checkState.fiscalYear = fm.fiscalYear;
      checkState.month = fm.month;
    }
  }

  renderCheckCompanyButtons();
  renderCheckMonthButtons();
  renderCheckYearButtons(years);

  if (preselect) {
    renderCheckResultData_(getClosingCheckLocal(data, preselect.company, preselect.closingMonth));
  } else if (latestClosing) {
    renderCheckResultAll_(getClosingCheckAllLocal(data, latestClosing));
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
  let html = "<div class=\"overflow-x\"><table class=\"data-table summary-table check-table\"><thead><tr>" +
    "<th>工事名</th><th>コラム横持</th><th>製品等横持</th><th>その他横持</th><th>メッキ</th><th>現場搬入費用</th><th>現場搬入重量</th><th>請求額</th><th>消費税</th><th>合計請求額</th></tr></thead><tbody>";
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

// 状態チップ: 色だけでなくアイコン+ラベルで判別できるようにする(色弱の方への配慮、および
// 単色バッジよりも視覚的な情報量を増やすため)。色の意味(緑=確定済み/オレンジ=未確定/
// グレー=データなし)自体は変更していない。
const STATUS_BADGE_ICON_ = {
  confirmed: "<svg viewBox=\"0 0 20 20\" fill=\"none\"><path d=\"M4 10.5l3.5 3.5L16 5\" stroke=\"currentColor\" stroke-width=\"2\" stroke-linecap=\"round\" stroke-linejoin=\"round\"/></svg>",
  pending: "<svg viewBox=\"0 0 20 20\" fill=\"none\"><circle cx=\"10\" cy=\"10\" r=\"7\" stroke=\"currentColor\" stroke-width=\"1.6\"/><path d=\"M10 6.5V10l2.5 1.5\" stroke=\"currentColor\" stroke-width=\"1.6\" stroke-linecap=\"round\"/></svg>",
  none: "<svg viewBox=\"0 0 20 20\" fill=\"none\"><circle cx=\"10\" cy=\"10\" r=\"1.4\" fill=\"currentColor\"/></svg>"
};
function statusBadgeHtml_(status) {
  const badgeClass = status === "確定済み" ? "confirmed" : (status === "未確定" ? "pending" : "none");
  return "<span class=\"status-badge " + badgeClass + "\">" + STATUS_BADGE_ICON_[badgeClass] + status + "</span>";
}

function renderCheckResultData_(data) {
  const badgeEl = document.getElementById("check-status-badge");
  const confirmSlot = document.getElementById("check-confirm-slot");
  const resultEl = document.getElementById("check-result");
  badgeEl.innerHTML = statusBadgeHtml_(data.status);
  resultEl.innerHTML = closingCheckTableHtml_(data);
  confirmSlot.innerHTML = (data.status === "未確定" && data.projects.length > 0)
    ? "<button class=\"btn btn-confirm\" onclick=\"confirmCurrentClosing()\">内容確定(担当者チェック)</button>"
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
  try {
    const data = await ensureHaulingDataWithModal();
    if (checkState.company === CHECK_COMPANY_ALL) {
      renderCheckResultAll_(getClosingCheckAllLocal(data, closingMonth));
    } else {
      renderCheckResultData_(getClosingCheckLocal(data, checkState.company, closingMonth));
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
  showLoadingModal();
  try {
    await apiPost("confirmClosing", { company: company, closingMonth: closingMonth });
    refreshHaulingDataInBackground(); // 締め状態が変わったため、キャッシュを破棄して再取得を始めておく
    hideLoadingModal(true);
    showConfirmDoneModal(company, closingMonth);
  } catch (err) {
    hideLoadingModal(false);
    showErrorModal("エラー: " + err.message);
  }
}

// 完了ポップアップ(確定完了・削除完了で共用): メッセージを表示し、OKボタンを押すとホーム画面へ戻る
function showDoneModal(message) {
  document.getElementById("confirm-done-message").textContent = message;
  document.getElementById("confirm-done-overlay").style.display = "flex";
}

function showConfirmDoneModal(company, closingMonth) {
  const month = Number(closingMonth.split("/")[1]);
  showDoneModal(company + "の" + month + "月20日〆が確定しました");
}

function closeConfirmDoneModal() {
  document.getElementById("confirm-done-overlay").style.display = "none";
  goHome();
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
  let data;
  try {
    data = await ensureHaulingDataWithModal();
  } catch (err) {
    container.innerHTML = "";
    resultEl.innerHTML = "<p class=\"import-status error\">エラー: " + err.message + "</p>";
    return;
  }
  const years = availableYearsFromRowsLocal(data.rows, data.currentFiscalYearEnd);
  yearlyState.fiscalYear = data.currentFiscalYearEnd;
  container.innerHTML = years.slice().reverse().map(y =>
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
  renderYearlyResult(getYearlySummaryLocal(data, yearlyState.fiscalYear));
}

async function loadYearlySummary() {
  const resultEl = document.getElementById("yearly-result");
  try {
    const data = await ensureHaulingDataWithModal();
    renderYearlyResult(getYearlySummaryLocal(data, yearlyState.fiscalYear));
  } catch (err) {
    resultEl.innerHTML = "<p class=\"import-status error\">エラー: " + err.message + "</p>";
  }
}

function renderYearlyResult(data) {
  const resultEl = document.getElementById("yearly-result");
  document.getElementById("yearly-total-line").textContent = data.fiscalYearEnd + "年度 合計請求額: " + fmtYen(data.合計請求額);
  let html = "";

  html += "<h3>月別内訳</h3><div class=\"overflow-x\"><table class=\"data-table summary-table\"><thead><tr><th>締め月</th><th>コラム横持</th><th>製品等横持</th><th>その他横持</th><th>メッキ</th><th>現場搬入費用</th><th>現場搬入重量</th><th>合計</th></tr></thead><tbody>";
  data.月別.forEach(m => {
    html += "<tr><td>" + m.締め月 + "〆</td><td>" + fmtYen(m.コラム横持) + "</td><td>" + fmtYen(m.製品等横持) + "</td><td>" + fmtYen(m.その他横持) + "</td><td>" + fmtYen(m.メッキ) + "</td><td>" +
      fmtYen(m.現場搬入費用) + "</td><td>" + (m.重量 || 0).toFixed(1) + "t</td><td>" + fmtYen(m.合計) + "</td></tr>";
  });
  html += feeBucketTotalRowHtml_(sumFeeBuckets_(data.月別));
  html += "</tbody></table></div>";

  html += "<h3>工事別内訳</h3><div class=\"overflow-x\"><table class=\"data-table summary-table\"><thead><tr><th>物件名</th><th>コラム横持</th><th>製品等横持</th><th>その他横持</th><th>メッキ</th><th>現場搬入費用</th><th>現場搬入重量</th><th>合計</th></tr></thead><tbody>";
  data.工事別.forEach(p => {
    html += "<tr><td>" + p.物件名 + "</td><td>" + fmtYen(p.コラム横持) + "</td><td>" + fmtYen(p.製品等横持) + "</td><td>" + fmtYen(p.その他横持) + "</td><td>" + fmtYen(p.メッキ) + "</td><td>" +
      fmtYen(p.現場搬入費用) + "</td><td>" + (p.重量 || 0).toFixed(1) + "t</td><td>" + fmtYen(p.合計) + "</td></tr>";
  });
  html += feeBucketTotalRowHtml_(sumFeeBuckets_(data.工事別));
  html += "</tbody></table></div>";

  html += "<h3>業者別内訳</h3><div class=\"overflow-x\"><table class=\"data-table summary-table\"><thead><tr><th>業者</th><th>コラム横持</th><th>製品等横持</th><th>その他横持</th><th>メッキ</th><th>現場搬入費用</th><th>現場搬入重量</th><th>合計</th></tr></thead><tbody>";
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

// 特定の会計年度について、工事別内訳の年度ラベル横に注意書きを出す(ユーザー指示による)
const PROJECT_YEAR_CAUTION = {
  2024: "（※合計金額は正確ですが、その他は参考としてください）",
};

async function initProjectScreen() {
  projectState = { name: null };
  document.getElementById("project-result").innerHTML = "";
  const container = document.getElementById("project-buttons");
  container.style.display = "";
  let data;
  try {
    data = await ensureHaulingDataWithModal();
  } catch (err) {
    container.innerHTML = "<p class=\"import-status error\">エラー: " + err.message + "</p>";
    return;
  }
  const yearGroups = listProjectsLocal(data);
  if (yearGroups.length === 0) {
    container.innerHTML = "<span class=\"hint\">物件データがありません</span>";
    return;
  }
  container.innerHTML = yearGroups.map(g => {
    const caution = PROJECT_YEAR_CAUTION[g.year]
      ? "<span class=\"project-year-caution\">" + PROJECT_YEAR_CAUTION[g.year] + "</span>"
      : "";
    return "<div class=\"project-year-group\"><div class=\"project-year-label\"><span class=\"project-year-num\">" + g.year + "年度</span>" + caution + "</div><div class=\"button-group\">" +
      g.names.map(n => "<button type=\"button\" class=\"btn\" data-name=\"" + n + "\">" + n + "</button>").join("") +
      "</div></div>";
  }).join("");
  container.querySelectorAll("button").forEach(btn => {
    btn.onclick = () => {
      projectState.name = btn.dataset.name;
      container.querySelectorAll("button").forEach(b => b.classList.toggle("btn-primary", b === btn));
      container.style.display = "none";
      loadProjectDetail();
    };
  });
}

// 「物件選択に戻る」: 選択状態を解除し、物件一覧のボタンのハイライトを外して再表示する
function backToProjectSelection() {
  projectState.name = null;
  document.getElementById("project-result").innerHTML = "";
  const container = document.getElementById("project-buttons");
  container.querySelectorAll("button").forEach(b => b.classList.remove("btn-primary"));
  container.style.display = "";
}

async function loadProjectDetail() {
  const resultEl = document.getElementById("project-result");
  try {
    const cached = await ensureHaulingDataWithModal();
    const data = getProjectDetailLocal(cached, projectState.name);
    let html = "<div class=\"check-title-row\"><h3>" + data.物件名 + "</h3>" +
      "<button type=\"button\" class=\"btn btn-back\" onclick=\"backToProjectSelection()\">← 物件選択に戻る</button></div>";
    html += "<p class=\"hint\">搬入期間: " + (data.開始日 && data.終了日 ? data.開始日 + " 〜 " + data.終了日 : "データがありません") + "</p>";

    const t = data.total;
    const perTonText = t.重量 > 0 ? fmtYen(t.合計 / t.重量) + "/t" : "現場搬入の重量が無いため算出不可";
    html += "<p class=\"per-ton-summary\">合計重量: " + (t.重量 || 0).toFixed(1) + "t　総額: " + fmtYen(t.合計) +
      "　<strong>1トン当たりの金額: " + perTonText + "</strong></p>";

    html += "<h3>業者別</h3><div class=\"overflow-x\"><table class=\"data-table summary-table\"><thead><tr><th>業者</th><th>コラム横持</th><th>製品等横持</th><th>その他横持</th><th>メッキ</th><th>現場搬入費用</th><th>現場搬入重量</th><th>合計</th></tr></thead><tbody>";
    data.業者別.forEach(c => {
      html += "<tr><td>" + c.業者 + "</td><td>" + fmtYen(c.コラム横持) + "</td><td>" + fmtYen(c.製品等横持) + "</td><td>" + fmtYen(c.その他横持) + "</td><td>" + fmtYen(c.メッキ) + "</td><td>" +
        fmtYen(c.現場搬入費用) + "</td><td>" + (c.重量 || 0).toFixed(1) + "t</td><td>" + fmtYen(c.合計) + "</td></tr>";
    });
    html += feeBucketTotalRowHtml_(data.total);
    html += "</tbody></table></div>";

    html += "<h3>締め月別</h3><div class=\"overflow-x\"><table class=\"data-table summary-table\"><thead><tr><th>締め月</th><th>コラム横持</th><th>製品等横持</th><th>その他横持</th><th>メッキ</th><th>現場搬入費用</th><th>現場搬入重量</th><th>合計</th></tr></thead><tbody>";
    (data.締め月別 || []).forEach(m => {
      html += "<tr><td>" + m.締め月 + "〆</td><td>" + fmtYen(m.コラム横持) + "</td><td>" + fmtYen(m.製品等横持) + "</td><td>" + fmtYen(m.その他横持) + "</td><td>" + fmtYen(m.メッキ) + "</td><td>" +
        fmtYen(m.現場搬入費用) + "</td><td>" + (m.重量 || 0).toFixed(1) + "t</td><td>" + fmtYen(m.合計) + "</td></tr>";
    });
    html += feeBucketTotalRowHtml_(data.total);
    html += "</tbody></table></div>";

    resultEl.innerHTML = html;
  } catch (err) {
    resultEl.innerHTML = "<p class=\"import-status error\">エラー: " + err.message + "</p>";
  }
}

// ---------- 業者別内訳画面 ----------

let companyState = { name: null, years: [] };

async function initCompanyScreen() {
  companyState = { name: null, years: [] };
  document.getElementById("company-detail-header").innerHTML = "";
  document.getElementById("company-result").innerHTML = "";
  const container = document.getElementById("company-buttons");
  container.style.display = "";
  let data;
  try {
    data = await ensureHaulingDataWithModal();
  } catch (err) {
    container.innerHTML = "<p class=\"import-status error\">エラー: " + err.message + "</p>";
    return;
  }
  const companies = data.companies;
  container.innerHTML = companies.map(c => "<button type=\"button\" class=\"btn\" data-name=\"" + c + "\">" + c + "</button>").join("");
  container.querySelectorAll("button").forEach(btn => {
    btn.onclick = () => {
      companyState.name = btn.dataset.name;
      companyState.years = [];
      container.querySelectorAll("button").forEach(b => b.classList.toggle("btn-primary", b === btn));
      container.style.display = "none";
      loadCompanyDetail();
    };
  });
}

// 「業者選択に戻る」: 選択状態(年度フィルターも含む)を解除し、業者一覧を再表示する
function backToCompanySelection() {
  companyState.name = null;
  companyState.years = [];
  document.getElementById("company-detail-header").innerHTML = "";
  document.getElementById("company-result").innerHTML = "";
  const container = document.getElementById("company-buttons");
  container.querySelectorAll("button").forEach(b => b.classList.remove("btn-primary"));
  container.style.display = "";
}

// 年度フィルターボタンの押下: 「全ての年度」は排他的(押すと個別年度の選択を全て解除する)。
// 個別年度は複数選択可(トグル)。個別年度を選ぶと、選択数が0でなくなるため
// 「全ての年度」は自動的に非アクティブ表示になる(companyState.years.length===0で判定するため)。
function toggleCompanyYear(fiscalYearEnd) {
  if (fiscalYearEnd === null) {
    companyState.years = [];
  } else {
    const idx = companyState.years.indexOf(fiscalYearEnd);
    if (idx !== -1) companyState.years.splice(idx, 1);
    else companyState.years.push(fiscalYearEnd);
  }
  loadCompanyDetail();
}

async function loadCompanyDetail() {
  const headerEl = document.getElementById("company-detail-header");
  const resultEl = document.getElementById("company-result");
  try {
    const cached = await ensureHaulingDataWithModal();
    const data = getCompanyDetailLocal(cached, companyState.name, companyState.years);
    let headerHtml = "<div class=\"check-title-row\"><h3>" + data.業者 + "</h3>" +
      "<button type=\"button\" class=\"btn btn-back\" onclick=\"backToCompanySelection()\">← 業者選択に戻る</button></div>";

    const allYearsActive = companyState.years.length === 0;
    headerHtml += "<div class=\"button-group\">";
    headerHtml += "<button type=\"button\" class=\"btn" + (allYearsActive ? " btn-primary" : "") + "\" onclick=\"toggleCompanyYear(null)\">全ての年度</button>";
    data.年度一覧.slice().reverse().forEach(y => {
      const active = companyState.years.indexOf(y) !== -1;
      headerHtml += "<button type=\"button\" class=\"btn" + (active ? " btn-primary" : "") + "\" onclick=\"toggleCompanyYear(" + y + ")\">" + y + "年度</button>";
    });
    headerHtml += "</div>";

    headerHtml += "<p class=\"hint\">搬入期間: " + (data.開始日 && data.終了日 ? data.開始日 + " 〜 " + data.終了日 : "データがありません") + "</p>";

    const t = data.total;
    const perTonText = t.重量 > 0 ? fmtYen(t.合計 / t.重量) + "/t" : "現場搬入の重量が無いため算出不可";
    headerHtml += "<p class=\"per-ton-summary\">合計重量: " + (t.重量 || 0).toFixed(1) + "t　総額: " + fmtYen(t.合計) +
      "　<strong>1トン当たりの金額: " + perTonText + "</strong></p>";
    headerEl.innerHTML = headerHtml;

    let html = "<h3>締め月別</h3><div class=\"overflow-x\"><table class=\"data-table summary-table\"><thead><tr><th>締め月</th><th>コラム横持</th><th>製品等横持</th><th>その他横持</th><th>メッキ</th><th>現場搬入費用</th><th>現場搬入重量</th><th>合計</th></tr></thead><tbody>";
    data.締め月別.forEach(m => {
      html += "<tr><td>" + m.締め月 + "〆</td><td>" + fmtYen(m.コラム横持) + "</td><td>" + fmtYen(m.製品等横持) + "</td><td>" + fmtYen(m.その他横持) + "</td><td>" + fmtYen(m.メッキ) + "</td><td>" +
        fmtYen(m.現場搬入費用) + "</td><td>" + (m.重量 || 0).toFixed(1) + "t</td><td>" + fmtYen(m.合計) + "</td></tr>";
    });
    html += feeBucketTotalRowHtml_(data.total);
    html += "</tbody></table></div>";

    html += "<h3>物件別</h3><div class=\"overflow-x\"><table class=\"data-table summary-table\"><thead><tr><th>物件名</th><th>コラム横持</th><th>製品等横持</th><th>その他横持</th><th>メッキ</th><th>現場搬入費用</th><th>現場搬入重量</th><th>合計</th></tr></thead><tbody>";
    data.物件別.forEach(p => {
      html += "<tr><td>" + p.物件名 + "</td><td>" + fmtYen(p.コラム横持) + "</td><td>" + fmtYen(p.製品等横持) + "</td><td>" + fmtYen(p.その他横持) + "</td><td>" + fmtYen(p.メッキ) + "</td><td>" +
        fmtYen(p.現場搬入費用) + "</td><td>" + (p.重量 || 0).toFixed(1) + "t</td><td>" + fmtYen(p.合計) + "</td></tr>";
    });
    html += feeBucketTotalRowHtml_(data.total);
    html += "</tbody></table></div>";

    resultEl.innerHTML = html;
  } catch (err) {
    headerEl.innerHTML = "";
    resultEl.innerHTML = "<p class=\"import-status error\">エラー: " + err.message + "</p>";
  }
}

// ---------- データ削除画面(ロゴ5回タップの隠しコマンドからのみ遷移) ----------
// 「一意の月をやり直したい」場合の復旧手段。年度→月→業者の順で選択させ、業者ボタンは
// その締め月で実際に「確定済み」のものしか表示しない(確定済み以外は選びようが無い)。
// 業者は複数選択可(1回の操作で複数社まとめて削除できる)。削除は「配車データ」「締め状態」
// 両シートの該当行を完全に削除する、取り消しの無い操作(ユーザー指示により確認ダイアログは無し)。

let deleteState = { fiscalYear: null, month: null, companies: new Set() };

async function initDeleteScreen() {
  deleteState = { fiscalYear: null, month: null, companies: new Set() };
  document.getElementById("delete-company-buttons").innerHTML = "";
  document.getElementById("delete-confirm-slot").innerHTML = "";
  const yearContainer = document.getElementById("delete-year-buttons");
  let data;
  try {
    data = await ensureHaulingDataWithModal();
  } catch (err) {
    yearContainer.innerHTML = "<p class=\"import-status error\">エラー: " + err.message + "</p>";
    return;
  }
  renderDeleteYearButtons(availableYearsFromRowsLocal(data.rows, data.currentFiscalYearEnd));
  renderDeleteMonthButtons();
}

function renderDeleteYearButtons(years) {
  const container = document.getElementById("delete-year-buttons");
  if (years.length === 0) { container.innerHTML = "<span class=\"hint\">対象年度がありません</span>"; return; }
  container.innerHTML = years.slice().reverse().map(y =>
    "<div class=\"year-btn-item\"><button type=\"button\" class=\"btn" + (y === deleteState.fiscalYear ? " btn-primary" : "") + "\" data-year=\"" + y + "\">" + y + "年</button>" +
    "<div class=\"year-period\">" + fiscalYearPeriodLabel(y) + "</div></div>"
  ).join("");
  container.querySelectorAll("button").forEach(btn => {
    btn.onclick = () => {
      deleteState.fiscalYear = Number(btn.dataset.year);
      container.querySelectorAll("button").forEach(b => b.classList.toggle("btn-primary", b === btn));
      refreshDeleteCompanies();
    };
  });
}

function renderDeleteMonthButtons() {
  const container = document.getElementById("delete-month-buttons");
  container.innerHTML = CHECK_MONTH_ORDER.map(m =>
    "<button type=\"button\" class=\"btn" + (m === deleteState.month ? " btn-primary" : "") + "\" data-month=\"" + m + "\">" + m + "月</button>"
  ).join("");
  container.querySelectorAll("button").forEach(btn => {
    btn.onclick = () => {
      deleteState.month = Number(btn.dataset.month);
      container.querySelectorAll("button").forEach(b => b.classList.toggle("btn-primary", b === btn));
      refreshDeleteCompanies();
    };
  });
}

// 年度+月が両方選択されたら、その締め月で実際に「確定済み」の業者だけをボタンとして表示する
// (①の指示: 確定済み以外はそもそも選べないようにする)。
async function refreshDeleteCompanies() {
  deleteState.companies = new Set();
  const companyContainer = document.getElementById("delete-company-buttons");
  document.getElementById("delete-confirm-slot").innerHTML = "";
  if (!deleteState.fiscalYear || !deleteState.month) {
    companyContainer.innerHTML = "";
    return;
  }
  const closingMonth = fiscalMonthToClosing(deleteState.fiscalYear, deleteState.month);
  try {
    const cached = await ensureHaulingDataWithModal();
    const data = getClosingCheckAllLocal(cached, closingMonth);
    const confirmed = data.companies.filter(c => c.status === "確定済み");
    if (confirmed.length === 0) {
      companyContainer.innerHTML = "<span class=\"hint\">この締め月(" + closingMonth + "〆)に確定済みのデータがありません</span>";
      return;
    }
    companyContainer.innerHTML = confirmed.map(c =>
      "<button type=\"button\" class=\"btn\" data-company=\"" + c.company + "\">" + c.company + "</button>"
    ).join("");
    companyContainer.querySelectorAll("button").forEach(btn => {
      btn.onclick = () => {
        const name = btn.dataset.company;
        if (deleteState.companies.has(name)) {
          deleteState.companies.delete(name);
          btn.classList.remove("btn-primary");
        } else {
          deleteState.companies.add(name);
          btn.classList.add("btn-primary");
        }
        renderDeleteConfirmSlot();
      };
    });
  } catch (err) {
    companyContainer.innerHTML = "<p class=\"import-status error\">エラー: " + err.message + "</p>";
  }
}

function renderDeleteConfirmSlot() {
  const slot = document.getElementById("delete-confirm-slot");
  slot.innerHTML = deleteState.companies.size > 0
    ? "<div class=\"check-row\"><button class=\"btn btn-danger\" onclick=\"executeDelete()\">確定済みデータを削除</button>" +
      "<span class=\"delete-danger-warning\">！！！完全にデータが消えるので注意！！！</span></div>"
    : "";
}

// 削除実行: 確認ダイアログ無し(ユーザー指示による)。「配車データ」「締め状態」両シートの
// 該当行を削除するGAS APIを1回のリクエストで(選択した複数業者分まとめて)呼び出す。
async function executeDelete() {
  const closingMonth = fiscalMonthToClosing(deleteState.fiscalYear, deleteState.month);
  const companies = Array.from(deleteState.companies);
  showLoadingModal();
  try {
    await apiPost("deleteConfirmedMonth", { companies: companies, closingMonth: closingMonth });
    refreshHaulingDataInBackground(); // 配車データ・締め状態が変わったため、キャッシュを破棄して再取得を始めておく
    hideLoadingModal(true);
    const month = Number(closingMonth.split("/")[1]);
    showDoneModal(companies.join("・") + "の" + month + "月20日〆の確定済みデータを削除しました");
  } catch (err) {
    hideLoadingModal(false);
    showErrorModal("エラー: " + err.message);
  }
}
