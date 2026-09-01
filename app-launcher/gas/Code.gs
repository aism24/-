// ============================================================
// アプリ一覧ポータル - GAS バックエンド
// ============================================================
//
// 【セットアップ手順】
// 1. このスクリプトは「情報」シートを持つスプレッドシートに紐付けたコンテナバインド型で使用する
//    (スプレッドシート上部「拡張機能」→「Apps Script」で新規プロジェクトを作成)
// 2. Code.gs / Index.html の内容をそのままコピーして貼り付ける
// 3. 「デプロイ」→「新しいデプロイ」→ 種類「ウェブアプリ」、アクセス権「全員」で公開する
//
// 【情報シートの想定列】
// A:ID  B:アプリ名  C:URL  D:説明  E:分類  F:ロゴ  (1行目はヘッダー、2行目以降がデータ)
// 分類(E列)が同じ行はまとめて1つの行(セクション)として表示する
// ロゴ(F列)はカード左上のアイコンに表示する文字(例:正光/阪和。未入力ならアプリ名の頭文字を使う)
//
// 【記録シートの想定列】
// A:日時  B:アプリ名  (1行目はヘッダー、2行目以降に追記していく)
// ============================================================

const SPREADSHEET_ID = SpreadsheetApp.getActiveSpreadsheet().getId();
const SHEET_NAME = '情報';
const LOG_SHEET_NAME = '記録';

// カードごとのアクセントカラーを、黄金角(137.508°)で色相をずらしながら生成する。
// 固定パレットの巡回と違い何番目でも重複しない(似た色にはなり得るが完全同色にはならない)。
function cardColorForIndex_(index) {
  const hue = Math.round((index * 137.508) % 360);
  return 'hsl(' + hue + ', 65%, 55%)';
}

function doGet() {
  const template = HtmlService.createTemplateFromFile('Index');
  template.groups = getAppGroups();
  return template.evaluate()
    .setTitle('アプリ一覧')
    .setXFrameOptionsMode(HtmlService.XFrameOptionsMode.ALLOWALL);
}

// 分類(E列)ごとにアプリをグループ化して返す。
// 戻り値: [{ category: '【自社DXF】', apps: [{...}, ...] }, ...]
function getAppGroups() {
  const sheet = SpreadsheetApp.openById(SPREADSHEET_ID).getSheetByName(SHEET_NAME);
  if (!sheet) return [];

  const rows = sheet.getDataRange().getValues();
  const groupsMap = {};
  const order = [];
  let colorIndex = 0;

  for (let i = 1; i < rows.length; i++) {
    const [id, name, url, description, category, logo] = rows[i];
    if (!name || !url) continue;

    const cat = category || 'その他';
    if (!groupsMap[cat]) {
      groupsMap[cat] = [];
      order.push(cat);
    }

    groupsMap[cat].push({
      id: id,
      name: name,
      url: url,
      description: description || '',
      color: cardColorForIndex_(colorIndex),
      initial: logo || String(name).charAt(0)
    });
    colorIndex++;
  }

  return order.map(function (cat) {
    return { category: cat, apps: groupsMap[cat] };
  });
}

// アプリ起動時にクライアント側(Index.html)から呼び出される。
// 「記録」シートの最終行の下に [日時, アプリ名] を追記する。
function logAppOpen(appName) {
  const sheet = SpreadsheetApp.openById(SPREADSHEET_ID).getSheetByName(LOG_SHEET_NAME);
  if (!sheet) return;
  sheet.appendRow([new Date(), appName]);
}

/* =====================================================================
 * ここから下は「アプリ一覧ポータル」(GitHub Pages版)専用の追加分。
 * 上記の既存コードは一切変更していない(既存のGAS Webアプリ・doGet/logAppOpenの
 * 動作への影響はゼロ)。
 *
 * 【デプロイについて重要】
 * このdoPost(e)は、既存のGAS Webアプリのデプロイとは【別の新規デプロイ】として
 * 公開すること。既存デプロイ(Index.html用、doGetでレンダリング)はそのまま残し、
 * 「デプロイを管理」から追加デプロイを作成し、そちらだけ
 * 次のユーザーとして実行:自分 / アクセスできるユーザー:全員 にする
 * (GitHub Pagesからの匿名fetchに対応するため)。
 * 新規デプロイのURLを app-launcher/app.js 先頭の GAS_API_URL 定数に設定すること。
 * ===================================================================== */

function apiJsonOk_(data) {
  return ContentService
    .createTextOutput(JSON.stringify({ status: 'success', data: data }))
    .setMimeType(ContentService.MimeType.JSON);
}

function apiJsonErr_(message) {
  return ContentService
    .createTextOutput(JSON.stringify({ status: 'error', message: message }))
    .setMimeType(ContentService.MimeType.JSON);
}

/**
 * POSTリクエスト用(新規。既存のdoGetとは独立しており、既存の動作には影響しない)。
 * リクエストボディ(JSON文字列)の例: { "action": "getAppGroups" }
 *
 * CORSプリフライト(OPTIONS)はGASが対応していないため、フロントエンド側は
 * 必ず Content-Type: text/plain でPOSTすること(hot-heart等、他アプリと同じ方式)。
 */
function doPost(e) {
  try {
    const body = JSON.parse(e.postData.contents);
    const action = body.action;
    const params = body.params || {};

    if (action === 'getAppGroups') return apiJsonOk_(getAppGroups());
    if (action === 'logAppOpen') {
      logAppOpen(params.appName);
      return apiJsonOk_({});
    }
    return apiJsonErr_('不明なaction: ' + action);
  } catch (err) {
    return apiJsonErr_(String(err && err.message || err));
  }
}
