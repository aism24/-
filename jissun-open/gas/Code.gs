/**
 * 「実寸法師を開く」(jissun-open)の利用記録用GAS(コンテナバインド)。
 *
 * 対象スプレッドシート: 実寸法師を開く_Vercel記録(シート「記録」。A1=見出し「タイムスタンプ」)
 * ページが開かれるたびに1行記録する。常にA2が最新(古いものは下へ移る)。
 * 送られる情報は無く、サーバー側の現在日時だけを記録する。
 *
 * セットアップ: スプレッドシートの「拡張機能→Apps Script」にこのコードを貼り付け、
 * 「デプロイ→新しいデプロイ→ウェブアプリ(実行ユーザー=自分、アクセス=全員)」。
 * 発行された /exec のURLを、jissun-open/index.html の GAS_URL に設定する。
 * コードを直したら CODE_VERSION を更新し、再デプロイ後に /exec をGETで開いて version を確認する。
 */
const CODE_VERSION = '2026-10-21-ver';
const SHEET_NAME = '記録';

function doPost(e) {
  try {
    return json_({ status: 'success', data: logOpen_() });
  } catch (err) {
    return json_({ status: 'error', message: err.message });
  }
}

// 動作確認用(ブラウザでURLを開くと応答する。version で反映中のコードの版を確認できる)
function doGet() {
  return json_({ status: 'success', data: 'jissun-open log API', version: CODE_VERSION });
}

function logOpen_() {
  const lock = LockService.getScriptLock();
  lock.waitLock(10000);
  try {
    const sh = SpreadsheetApp.getActiveSpreadsheet().getSheetByName(SHEET_NAME);
    if (!sh) throw new Error('シート「' + SHEET_NAME + '」がありません');
    sh.insertRowBefore(2); // 常にA2が最新(古いものは下へ移る)
    sh.getRange(2, 1).setNumberFormat('yyyy/mm/dd hh:mm:ss').setValue(new Date());
    return { row: 2 };
  } finally {
    lock.releaseLock();
  }
}

function json_(payload) {
  return ContentService.createTextOutput(JSON.stringify(payload)).setMimeType(ContentService.MimeType.JSON);
}
