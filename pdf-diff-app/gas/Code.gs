// PDF差分解析アプリ - 記録シート書き込み用GAS Webアプリ
//
// スプレッドシート「PDF差分解析(表、文章、図面)」の「記録」シートに、
// アプリ側(index.html/app.js)から解析完了時にPOSTされる
// { date: ISO日時文字列, category: "表"|"文章"|"図面"|... } を
// 常に2行目(A2:B2)へ追記する。追記後にA2:Bを日時の降順で並び替えることで、
// 「2行目が常に最新」を維持する。
//
// デプロイ手順:
//   1. 対象スプレッドシートを開き、拡張機能 > Apps Script を開く
//   2. このファイルの内容を貼り付けて保存
//   3. デプロイ > 新しいデプロイ > 種類「ウェブアプリ」
//      - 実行するユーザー: 自分
//      - アクセスできるユーザー: 全員
//   4. 発行された /exec URLを、アプリ側 app.js の GAS_API_URL に設定する

const SPREADSHEET_ID = '1aF19LTDuL-tqXIg27zvydNuKddCeHR6mepTeWBd-kL4';
const SHEET_NAME = '記録';

function doPost(e) {
  try {
    const data = JSON.parse(e.postData.contents);
    const date = data.date || new Date().toISOString();
    const category = data.category || '';

    const ss = SpreadsheetApp.openById(SPREADSHEET_ID);
    const sheet = ss.getSheetByName(SHEET_NAME);
    if (!sheet) throw new Error(`シート「${SHEET_NAME}」が見つかりません`);

    sheet.insertRowBefore(2);
    sheet.getRange(2, 1, 1, 2).setValues([[date, category]]);

    const lastRow = sheet.getLastRow();
    if (lastRow > 2) {
      sheet.getRange(2, 1, lastRow - 1, 2).sort({ column: 1, ascending: false });
    }

    return ContentService
      .createTextOutput(JSON.stringify({ status: 'success' }))
      .setMimeType(ContentService.MimeType.JSON);
  } catch (err) {
    return ContentService
      .createTextOutput(JSON.stringify({ status: 'error', message: String(err) }))
      .setMimeType(ContentService.MimeType.JSON);
  }
}
