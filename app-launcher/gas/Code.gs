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
// A:日時  B:アプリ名  (1行目はヘッダー。2行目に最新の記録を挿入していく=新しい順)
// ============================================================

const SPREADSHEET_ID = SpreadsheetApp.getActiveSpreadsheet().getId();
const SHEET_NAME = '情報';
const LOG_SHEET_NAME = '記録';

// HSL(0-360, 0-100, 0-100)をRGB(0-255)に変換する。
function hslToRgb_(h, s, l) {
  s /= 100;
  l /= 100;
  const c = (1 - Math.abs(2 * l - 1)) * s;
  const x = c * (1 - Math.abs((h / 60) % 2 - 1));
  const m = l - c / 2;
  let r, g, b;
  if (h < 60) { r = c; g = x; b = 0; }
  else if (h < 120) { r = x; g = c; b = 0; }
  else if (h < 180) { r = 0; g = c; b = x; }
  else if (h < 240) { r = 0; g = x; b = c; }
  else if (h < 300) { r = c; g = 0; b = x; }
  else { r = x; g = 0; b = c; }
  return [
    Math.round((r + m) * 255),
    Math.round((g + m) * 255),
    Math.round((b + m) * 255)
  ];
}

// 背景色(RGB)の知覚輝度(YIQ)から、読みやすい文字色(黒/白)を選ぶ。
// 色相だけを黄金角でずらしているため、明度が同じ(55%)でも黄色系は明るく、
// 青系は暗く見える(知覚輝度が大きく異なる)。単純な明度値ではなく実際の
// RGBから輝度を計算しないと、背景が薄い/濃いの判定を誤る。
function textColorForRgb_(r, g, b) {
  const yiq = (r * 299 + g * 587 + b * 114) / 1000;
  return yiq >= 128 ? '#000' : '#fff';
}

// カードごとのアクセントカラーと、それに合う文字色を、黄金角(137.508°)で
// 色相をずらしながら生成する。固定パレットの巡回と違い何番目でも重複しない
// (似た色にはなり得るが完全同色にはならない)。
function cardStyleForIndex_(index) {
  const hue = Math.round((index * 137.508) % 360);
  const sat = 65, light = 55;
  const rgb = hslToRgb_(hue, sat, light);
  return {
    color: 'hsl(' + hue + ', ' + sat + '%, ' + light + '%)',
    textColor: textColorForRgb_(rgb[0], rgb[1], rgb[2])
  };
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

    const style = cardStyleForIndex_(colorIndex);
    groupsMap[cat].push({
      id: id,
      name: name,
      url: url,
      description: description || '',
      color: style.color,
      textColor: style.textColor,
      initial: logo || String(name).charAt(0)
    });
    colorIndex++;
  }

  return order.map(function (cat) {
    return { category: cat, apps: groupsMap[cat] };
  });
}

// アプリ起動時にクライアント側(Index.html)から呼び出される。
// 「記録」シートの2行目(ヘッダーの直下)に [日時, アプリ名] を挿入する。
// 既存の記録は下に押し出されるため、常に最新の記録が上から並ぶ。
function logAppOpen(appName) {
  const sheet = SpreadsheetApp.openById(SPREADSHEET_ID).getSheetByName(LOG_SHEET_NAME);
  if (!sheet) return;
  sheet.insertRowBefore(2);
  sheet.getRange(2, 1, 1, 2).setValues([[new Date(), appName]]);
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
