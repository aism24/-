/**
 * 「鋼材取合最適化アプリ」の実績記録用GAS APIバックエンド。
 *
 * このスクリプトは、データストアとなるGoogleスプレッドシート(「鋼材取合い」)の
 * 「拡張機能→Apps Script」から作成するコンテナバインド型スクリプトとして使う前提です。
 * SpreadsheetApp.getActiveSpreadsheet()で自分自身のスプレッドシートを参照するため、
 * SPREADSHEET_IDの設定は不要です。
 *
 * このアプリ本体(index.html / app.js)は、計算・Excel出力そのものは完全クライアント
 * サイドで完結します。GASが担うのは付随機能である「実績記録」のみです。GAS側が不調でも
 * アプリ本来の計算・Excel出力は止まりません(app.js側で必ずcatchしています)。
 *
 * 前提となるスプレッドシートの構成(シートはあらかじめ手動で用意されている想定。
 * このスクリプトはシートの新規作成は行いません):
 *
 * ■ 「実績記録」シート(1行目=見出し、2行目以降に1エクスポート=1行で追記):
 *   記録ID, 記録日時, 担当者, 工事番号, 工事名, 使用用途, 対象サイズ, グループ数,
 *   在庫材使用本数, 端材リレー使用本数, 新品購入本数, 全体歩留まり, 端材発生本数, 端材発生長さ合計
 *
 * ■ 「情報」シート(1行目=見出し: 工事番号/工事名/氏名):
 *   A・B列(工事番号・工事名)は他のスプレッドシートからQUERY/IMPORTRANGEで自動反映される
 *   数式列のため、このスクリプトからは一切書き込みません(読み取り専用として扱います)。
 *   C列(氏名)のみ、テンプレート記入時に新規入力された名前をGASが追記していきます。
 *
 * セットアップ手順:
 *   1. 「鋼材取合い」スプレッドシートを開き、「拡張機能→Apps Script」を開く。
 *   2. このファイルの内容をまるごとコピー&ペーストして保存。
 *   3. 右上の「デプロイ→新しいデプロイ」→種類「ウェブアプリ」を選択。
 *        次のユーザーとして実行: 「自分」
 *        アクセスできるユーザー: 「全員」(フロントエンドから匿名でアクセスするため必須)
 *   4. 発行された /exec で終わるURLを、app.js の GAS_API_URL に反映してpush。
 */

const SHEET_RECORD = "実績記録";
const SHEET_INFO = "情報";

const RECORD_HEADERS = [
  "記録ID", "記録日時", "担当者", "工事番号", "工事名", "使用用途", "対象サイズ", "グループ数",
  "在庫材使用本数", "端材リレー使用本数", "新品購入本数", "全体歩留まり", "端材発生本数", "端材発生長さ合計",
];

// ---------- API本体 ----------

function getMasterInfo() {
  const sh = sheet_(SHEET_INFO);
  const lastRow = sh.getLastRow();
  if (lastRow < 2) return { projects: [], names: [] };

  const values = sh.getRange(2, 1, lastRow - 1, 3).getValues(); // A:C, 2行目から
  const projects = [];
  const names = [];
  values.forEach(row => {
    const no = String(row[0] || "").trim();
    const name = String(row[1] || "").trim();
    const person = String(row[2] || "").trim();
    if (no !== "" || name !== "") projects.push({ no: no, name: name });
    if (person !== "") names.push(person);
  });
  return { projects: projects, names: names };
}

function recordResult(body) {
  const sh = sheet_(SHEET_RECORD);
  const id = Utilities.getUuid();
  const now = new Date();

  const row = [
    id,
    now,
    String(body.担当者 || ""),
    String(body.工事番号 || ""),
    String(body.工事名 || ""),
    String(body.使用用途 || ""),
    String(body.対象サイズ || ""),
    Number(body.グループ数) || 0,
    Number(body.在庫材使用本数) || 0,
    Number(body.端材リレー使用本数) || 0,
    Number(body.新品購入本数) || 0,
    Number(body.全体歩留まり) || 0,
    Number(body.端材発生本数) || 0,
    Number(body.端材発生長さ合計) || 0,
  ];
  sh.appendRow(row);
  const lastRow = sh.getLastRow();
  sh.getRange(lastRow, 2).setNumberFormat("yyyy-mm-dd hh:mm:ss"); // 記録日時
  sh.getRange(lastRow, 12).setNumberFormat("0.0%");               // 全体歩留まり

  const worker = String(body.担当者 || "").trim();
  if (worker !== "") addNameIfMissing_(worker);

  return { id: id };
}

// 「情報」シートC列(氏名)に、まだ無い名前だけを次の空き行へ追記する。
// A・B列(工事番号・工事名、数式で自動反映)には一切触れない。
function addNameIfMissing_(name) {
  const sh = sheet_(SHEET_INFO);
  const lastRow = sh.getLastRow();
  const existing = lastRow >= 2 ? sh.getRange(2, 3, lastRow - 1, 1).getValues() : [];

  let nextEmptyRow = 2;
  let found = false;
  existing.forEach((r, i) => {
    const v = String(r[0] || "").trim();
    if (v !== "") {
      nextEmptyRow = 2 + i + 1;
      if (v === name) found = true;
    }
  });
  if (found) return;
  sh.getRange(nextEmptyRow, 3).setValue(name);
}

// ---------- JSON API共通 ----------

function jsonResponse_(payload) {
  return ContentService.createTextOutput(JSON.stringify(payload)).setMimeType(ContentService.MimeType.JSON);
}
function ok_(data) { return jsonResponse_({ status: "success", data: data }); }
function errRes_(message) { return jsonResponse_({ status: "error", message: message }); }

function doGet(e) {
  try {
    const p = e.parameter;
    if (p.action === "getMasterInfo") return ok_(getMasterInfo());
    return errRes_("不明なaction: " + p.action);
  } catch (err) {
    return errRes_(err.message);
  }
}

function doPost(e) {
  try {
    const body = JSON.parse(e.postData.contents);
    if (body.action === "recordResult") return ok_(recordResult(body));
    return errRes_("不明なaction: " + body.action);
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

// 「実績記録」シートの見出し行が想定通りか確認する(Apps Scriptエディタから手動で1回実行する
// 想定の関数。doGet/doPostからは呼ばない。ズレがあればログに出すだけで、自動修正はしない)。
function checkSetup() {
  const sh = sheet_(SHEET_RECORD);
  const headerRow = sh.getRange(1, 1, 1, RECORD_HEADERS.length).getValues()[0];
  const mismatch = RECORD_HEADERS.filter((h, i) => headerRow[i] !== h);
  if (mismatch.length > 0) {
    Logger.log("「実績記録」シートの見出しが想定と異なります: " + JSON.stringify(headerRow));
  } else {
    Logger.log("「実績記録」シートの見出しはOKです。");
  }
  sheet_(SHEET_INFO); // 存在確認のみ(無ければ例外)
  Logger.log("「情報」シートも存在します。セットアップ確認完了。");
}
