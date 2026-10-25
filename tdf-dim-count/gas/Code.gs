/**
 * 実寸データより長さと本数集計(tdf-dim-count)の利用記録用GAS(コンテナバインド)。
 *
 * 対象スプレッドシート: tdf-dim-count(シート「記録」)
 *   A:アプリ起動日時 / B:ダウンロード日時 / C:ファイル名 / D:指定レイヤ / E:総本数
 * - アプリを開いたら、2行目に1行入れてAだけ記録する(常に2行目が最新の起動。下に行くほど古い)。
 * - その起動でExcelをダウンロードしたら、同じ行のB:Eに記録する。ダウンロードしなければB:Eは空欄のまま。
 * - 同じ起動で2回目以降のダウンロードは、その起動の行のすぐ下に1行入れて記録する(Aは同じ起動日時)。
 * - 起動の行は、行に付けた開発者メタデータ(画面には出ない)で探す。上に行が増えても行に付いて動く。
 * - 起動の行が見つからない(古いアプリから・起動の記録に失敗)ときは、2行目に1行入れてAを空欄でB:Eを記録する。
 * 送られるのはファイル名・レイヤ名・総本数だけ(TDFの中身は送らない)。
 *
 * セットアップ: スプレッドシートの「拡張機能→Apps Script」にこのコードを貼り付け、
 * 「デプロイ→デプロイを管理→編集→バージョン: 新バージョン→デプロイ」(URLは変わらない)。
 * 反映の確認: /exec をブラウザで開くと CODE_VERSION(version)が返る。
 * 更新履歴: /exec?action=history で、シート「更新履歴」のA:C(更新履歴|内容|状況)の空でない行を返す(1行目は見出し)。
 */
const CODE_VERSION = '2026-10-26-optimize';
const SHEET_NAME = '記録';
const META_KEY = 'tdfSession';
const HISTORY_SHEET = '更新履歴';

function doPost(e) {
  try {
    const body = JSON.parse(e.postData.contents);
    if (body.action === 'logOpen') return json_({ status: 'success', data: logOpen_(body.sessionId) });
    if (body.action === 'logDownload') return json_({ status: 'success', data: logDownload_(body.sessionId, body.fileName, body.layer, body.total) });
    return json_({ status: 'error', message: '不明なaction: ' + body.action });
  } catch (err) {
    return json_({ status: 'error', message: err.message });
  }
}

// 動作確認用(ブラウザでURLを開くと応答する)。?action=history で更新履歴を返す
function doGet(e) {
  try {
    if (e && e.parameter && e.parameter.action === 'history') return json_({ status: 'success', data: history_(), version: CODE_VERSION });
    return json_({ status: 'success', data: 'tdf-dim-count log API', version: CODE_VERSION });
  } catch (err) {
    return json_({ status: 'error', message: err.message });
  }
}

// シート「更新履歴」A:C の表示値。空行は飛ばして上から順に返す
function history_() {
  const sh = SpreadsheetApp.getActiveSpreadsheet().getSheetByName(HISTORY_SHEET);
  if (!sh) throw new Error('シート「' + HISTORY_SHEET + '」がありません');
  const last = sh.getLastRow();
  if (last < 2) return [];
  return sh.getRange(2, 1, last - 1, 3).getDisplayValues()
    .filter(function (r) { return r.join('').trim() !== ''; })
    .map(function (r) { return [r[0].trim(), r[1].trim(), r[2].trim()]; });
}

function sheet_() {
  const sh = SpreadsheetApp.getActiveSpreadsheet().getSheetByName(SHEET_NAME);
  if (!sh) throw new Error('シート「' + SHEET_NAME + '」がありません');
  return sh;
}

// 挿入した行に、隣の行の目印が引き継がれていた場合に備えて消す
function clearMeta_(sh, row) {
  sh.getRange(row + ':' + row).getDeveloperMetadata().forEach(function (m) { if (m.getKey() === META_KEY) m.remove(); });
}

// row の位置に空の行を作る(after=true なら row の下に入れて row+1)。入れた行番号を返す
function insertBlank_(sh, row, after) {
  if (after) { sh.insertRowAfter(row); row++; } else sh.insertRowBefore(row);
  clearMeta_(sh, row);
  sh.getRange(row, 1, 1, 5).clearContent();
  return row;
}

// 「=」「+」「-」「@」で始まる文字列は、シートで数式として扱われないよう先頭に ' を付ける
function plain_(v, max) {
  const s = String(v || '').slice(0, max);
  return /^[=+\-@]/.test(s) ? "'" + s : s;
}

function sid_(sessionId) {
  return String(sessionId || '').replace(/[^0-9a-z]/gi, '').slice(0, 40);
}

function logOpen_(sessionId) {
  const sid = sid_(sessionId);
  const lock = LockService.getScriptLock();
  lock.waitLock(10000);
  try {
    const sh = sheet_();
    insertBlank_(sh, 2, false); // 常に2行目が最新の起動
    sh.getRange(2, 1).setValue(new Date()).setNumberFormat('yyyy/mm/dd hh:mm:ss');
    if (sid) sh.getRange('2:2').addDeveloperMetadata(META_KEY, sid);
    return { row: 2 };
  } finally {
    lock.releaseLock();
  }
}

function logDownload_(sessionId, fileName, layer, total) {
  const sid = sid_(sessionId);
  const lock = LockService.getScriptLock();
  lock.waitLock(10000);
  try {
    const sh = sheet_();
    const vals = [new Date(), plain_(fileName, 200), plain_(layer, 100), Number(total) || 0];
    let row = 0, openAt = '';
    if (sid) {
      const found = sh.createDeveloperMetadataFinder().withKey(META_KEY).withValue(sid).find();
      if (found.length) row = found[0].getLocation().getRow().getRow();
    }
    if (row) {
      if (sh.getRange(row, 2).getValue() !== '') {
        // 同じ起動で2回目以降: 起動の行のすぐ下に入れる
        openAt = sh.getRange(row, 1).getValue();
        row = insertBlank_(sh, row, true);
        sh.getRange(row, 1).setValue(openAt).setNumberFormat('yyyy/mm/dd hh:mm:ss');
      }
    } else {
      row = insertBlank_(sh, 2, false);
    }
    sh.getRange(row, 2, 1, 4).setValues([vals]);
    sh.getRange(row, 2).setNumberFormat('yyyy/mm/dd hh:mm:ss');
    return { row: row };
  } finally {
    lock.releaseLock();
  }
}

function json_(payload) {
  return ContentService.createTextOutput(JSON.stringify(payload)).setMimeType(ContentService.MimeType.JSON);
}
