/**
 * 実寸データより長さと本数集計(tdf-dim-count)の利用記録用GAS(コンテナバインド)。
 *
 * 対象スプレッドシート: tdf-dim-count(シート「記録」。A:タイムスタンプ / B:ファイル名 / C:指定レイヤ / D:総本数)
 * アプリで「Excelダウンロード」を押すたびに1行記録する。常に2行目が最新(下に行くほど古い)。
 * 送られるのはファイル名・レイヤ名・総本数だけ(TDFの中身は送らない)。
 *
 * セットアップ: スプレッドシートの「拡張機能→Apps Script」にこのコードを貼り付け、
 * 「デプロイ→新しいデプロイ→ウェブアプリ(実行ユーザー=自分、アクセス=全員)」。
 * 発行された /exec のURLを、tdf-dim-count/app.js の GAS_URL に設定する。
 */
const SHEET_NAME = '記録';

function doPost(e) {
  try {
    const body = JSON.parse(e.postData.contents);
    if (body.action !== 'logDownload') return json_({ status: 'error', message: '不明なaction: ' + body.action });
    return json_({ status: 'success', data: logDownload_(body.fileName, body.layer, body.total) });
  } catch (err) {
    return json_({ status: 'error', message: err.message });
  }
}

// 動作確認用(ブラウザでURLを開くと応答する)
function doGet() {
  return json_({ status: 'success', data: 'tdf-dim-count log API' });
}

function logDownload_(fileName, layer, total) {
  const lock = LockService.getScriptLock();
  lock.waitLock(10000);
  try {
    const sh = SpreadsheetApp.getActiveSpreadsheet().getSheetByName(SHEET_NAME);
    if (!sh) throw new Error('シート「' + SHEET_NAME + '」がありません');
    sh.insertRowBefore(2); // 常に2行目が最新
    sh.getRange(2, 1, 1, 4).setValues([[new Date(), String(fileName || '').slice(0, 200), String(layer || '').slice(0, 100), Number(total) || 0]]);
    sh.getRange(2, 1).setNumberFormat('yyyy/mm/dd hh:mm:ss');
    return { row: 2 };
  } finally {
    lock.releaseLock();
  }
}

function json_(payload) {
  return ContentService.createTextOutput(JSON.stringify(payload)).setMimeType(ContentService.MimeType.JSON);
}
