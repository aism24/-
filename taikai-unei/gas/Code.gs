/**
 * バスケットボール大会運営アプリ（24チーム・2日間）のGAS APIバックエンド。
 * 情報シート / Ｇ１〜Ｇ４ / ２日目決勝側 / ２日目２部側 に対応。
 *
 * このスクリプトはスプレッドシートの「拡張機能→Apps Script」から作成する
 * コンテナバインド型スクリプトとして使う前提です。SpreadsheetApp.getActiveSpreadsheet()で
 * 自分自身のスプレッドシートを参照するため、SPREADSHEET_IDの設定は不要です。
 *
 * フロントエンド（GitHub Pagesで配信するtaikai-unei/index.html等）とはJSON専用APIで通信します
 * （doGet/doPostがaction名でリクエストを振り分ける。hot-heart/weld-heat-managementと同じ方式）。
 * 以前はdoGet()がHtmlService.createHtmlOutputFromFile('Index')でHTMLを直接返していましたが、
 * GitHub Pages側からgoogle.script.runは呼べない（オリジンが異なるため）ので、この方式に置き換えました。
 * スプレッドシート上の「大会運営」メニュー（onOpen）や、Apps Scriptエディタからの直接実行は
 * このスクリプト単体で今までと同じように動作します（変更なし）。
 */

// 結果表Excel・速報PDFの保存先フォルダ（3点セットと同じ共有フォルダ）
const EXPORT_FOLDER_ID = '1R7r0fA_0ThYzOjwyakXjT2tPeGvK69F7';

const INFO_SHEET = '情報';
const GROUP_SHEETS = ['Ｇ１', 'Ｇ２', 'Ｇ３', 'Ｇ４'];
const DAY2_SHEETS = {
 '２日目決勝側': { tournamentRanks: [1, 2], rrRank: 5, placeBase: 0 }, // 1-8位, 17-20位
 '２日目２部側': { tournamentRanks: [3, 4], rrRank: 6, placeBase: 8 }, // 9-16位, 21-24位
};

// 情報シート列
const INFO_COL = { VENUE: 1, SEAT: 2, GROUP: 3, TEAM: 4, SUBRANK: 5, FINALRANK: 6, OVERALLRANK: 7 };
// 試合記録シート列（開始時間,淡チーム,淡得点,-,濃得点,濃チーム,TO,審判1,審判2）
const M_COL = { TIME: 1, LIGHT: 2, LSCORE: 3, DASH: 4, DSCORE: 5, DARK: 6, TO: 7, REF1: 8, REF2: 9 };

const DAY1_TIMES = ['9:00', '10:00', '11:00', '12:00', '13:00', '14:00'];
// フリースロー対決の各「順位ペア」（0=1位決定戦＝サブ1位同士, 1=3位決定戦＝サブ2位同士, 2=5位決定戦＝サブ3位同士）の
// 開始時間欄に表示するラベル（対戦の意味を示す。時刻ではない）
const DAY1_FT_TIME_LABELS = ['1位決定戦', '3位決定戦', '5位決定戦'];
// 試合7,8,9（row8,9,10）が上のどの順位ペアを担当するかの対応表。表示順を5位決定戦→3位決定戦→1位決定戦にするため
// 通常の並び[0,1,2]を反転させている（試合7=5位決定戦側、試合9=1位決定戦側）。
const DAY1_FT_TIER_ORDER = [2, 1, 0];
const DAY2_TIMES = ['8:20', '9:10', '10:00', '10:50', '11:40', '12:30', '13:20', '14:10', '15:00'];

// row2..row7 = 試合1..6。source = 循環的に直前の試合（試合1 は試合6）
const DAY1_MATCH_ROWS = [2, 3, 4, 5, 6, 7];
const DAY1_PAIRS = { 2: [1, 2], 3: [4, 5], 4: [1, 3], 5: [4, 6], 6: [2, 3], 7: [5, 6] }; // row -> [seatLight, seatDark]
const DAY1_FT_ROWS = [8, 9, 10]; // 試合7,8,9 = フリースロー rank1,2,3

// 2日目：18行（row2..19） 9試合枠×2コート
const DAY2_SLOTS = [
 [2, 3],
 [4, 5],
 [6, 7],
 [8, 9],
 [10, 11],
 [12, 13],
 [14, 15],
 [16, 17],
 [18, 19],
];
const D2 = {
 RR1A: 2,
 RR1B: 3,
 T1A: 4,
 T1B: 5,
 T1C: 6,
 T1D: 7,
 RR2A: 8,
 RR2B: 9,
 CONS_A: 10,
 CONS_B: 11,
 SF_A: 12,
 SF_B: 13,
 RR3A: 14,
 RR3B: 15,
 R7TH: 16,
 R3RD: 17,
 R5TH: 18,
 FINAL: 19,
};

function jsonResponse_(payload) {
  return ContentService
    .createTextOutput(JSON.stringify(payload))
    .setMimeType(ContentService.MimeType.JSON);
}
function ok_(data) { return jsonResponse_({ status: "success", data: data }); }
function errRes_(message) { return jsonResponse_({ status: "error", message: message }); }

// courtIndexはクエリ文字列/JSON経由では文字列または未指定で届くため、0/1の数値、または
// 指定なし（undefined）に正規化する（rowsForCourt_は courtIndex === 0 || courtIndex === 1 の
// 場合のみ絞り込みを行い、それ以外は全行を返す仕様のため）。
function normalizeCourtIndex_(v) {
  if (v === undefined || v === null || v === "") return undefined;
  return Number(v);
}

function doGet(e) {
  try {
    const action = e.parameter.action;
    if (action === "getDay2Status") return ok_(getDay2Status());
    if (action === "getInfoEditData") return ok_(getInfoEditData());
    if (action === "getLocationOptions") return ok_(getLocationOptions());
    if (action === "getAssignmentForCourt") {
      return ok_(getAssignmentForCourt(e.parameter.sheet, normalizeCourtIndex_(e.parameter.courtIndex)));
    }
    if (action === "getCourtMatches") {
      return ok_(getCourtMatches(e.parameter.sheet, normalizeCourtIndex_(e.parameter.courtIndex)));
    }
    if (action === "getAllTeams") return ok_(getAllTeams());
    if (action === "getTeamSchedule") return ok_(getTeamSchedule(e.parameter.team));
    return errRes_("不明なaction: " + action);
  } catch (err) {
    return errRes_(err.message);
  }
}

function doPost(e) {
  try {
    const body = JSON.parse(e.postData.contents);
    const action = body.action;
    if (action === "createDay2") return ok_(createDay2());
    if (action === "saveInfoEdits") return ok_(saveInfoEdits(body.venues, body.teamNames, body.day2Venues));
    if (action === "resetScores") return ok_(resetScores());
    if (action === "submitScore") {
      return ok_(submitScore(body.sheet, body.row, body.lightScore, body.darkScore, body.suddenDeath));
    }
    if (action === "exportDay1Results") return ok_(exportDay1Results());
    if (action === "exportDay2RoundRobin") return ok_(exportDay2RoundRobin());
    if (action === "exportDay2Tournament") return ok_(exportDay2Tournament());
    if (action === "exportBulletinPdf") return ok_(exportBulletinPdf(body.day));
    return errRes_("不明なaction: " + action);
  } catch (err) {
    return errRes_(err.message);
  }
}

function getSs() {
 return SpreadsheetApp.getActiveSpreadsheet();
}

function onOpen() {
 SpreadsheetApp.getUi()
 .createMenu('大会運営')
 .addItem('初期設定（情報シート見出し追加）', 'setupInfoHeaders')
 .addItem('全体再計算', 'rebuildAll')
 .addItem('２日目作成', 'createDay2FromMenu_')
 .addItem('試合結果リセット', 'resetScoresFromMenu_')
 .addToUi();
}

function setupInfoHeaders() {
 const sheet = getSs().getSheetByName(INFO_SHEET);
 sheet.getRange(1, INFO_COL.SUBRANK, 1, 3).setValues([['サブ順位', 'グループ最終順位', '総合順位']]);
}

/* ============ 情報シート ============ */

function readInfoRows_() {
 const sheet = getSs().getSheetByName(INFO_SHEET);
 const last = sheet.getLastRow();
 const values = sheet.getRange(2, 1, last - 1, 7).getValues();
 const rows = [];
 values.forEach((v, i) => {
 rows.push({
 rowIndex: i + 2,
 venue: v[INFO_COL.VENUE - 1], // 座席1の行にのみ入っている想定（他行は空欄）
 seat: v[INFO_COL.SEAT - 1],
 group: v[INFO_COL.GROUP - 1],
 team: v[INFO_COL.TEAM - 1],
 subRank: v[INFO_COL.SUBRANK - 1],
 finalRank: v[INFO_COL.FINALRANK - 1],
 overallRank: v[INFO_COL.OVERALLRANK - 1],
 });
 });
 return rows;
}

function teamsOfGroup_(infoRows, groupName) {
 return infoRows.filter((r) => r.group === groupName).sort((a, b) => a.seat - b.seat);
}

/* ============ 情報編集タブ ============ */

// ２日目の2会場（決勝側／2部側）はグループを跨ぐため、情報シートのグループ会場とは別に
// ドキュメントプロパティで会場名を保持する（情報シートの列を増やさずに済むように）。
function day2VenueProp_(sheetName) {
 return 'DAY2_VENUE::' + sheetName;
}

function getDay2VenueName_(sheetName) {
 return PropertiesService.getDocumentProperties().getProperty(day2VenueProp_(sheetName)) || '';
}

function setDay2VenueName_(sheetName, name) {
 PropertiesService.getDocumentProperties().setProperty(day2VenueProp_(sheetName), name || '');
}

function getInfoEditData() {
 const infoRows = readInfoRows_();
 const groups = [...new Set(infoRows.map((r) => r.group))];
 const day2Sheets = Object.keys(DAY2_SHEETS);
 return {
 groups: groups.map((g) => {
 const seat1 = infoRows.find((r) => r.group === g && Number(r.seat) === 1);
 return { group: g, venue: (seat1 && seat1.venue) || '' };
 }),
 teams: infoRows.map((r) => ({ group: r.group, seat: r.seat, team: r.team || '' })),
 day2VenueSheets: day2Sheets,
 day2Venues: day2Sheets.map((name) => getDay2VenueName_(name)),
 };
}

function saveInfoEdits(venues, teamNames, day2Venues) {
 const sheet = getSs().getSheetByName(INFO_SHEET);
 const infoRows = readInfoRows_();
 const groups = [...new Set(infoRows.map((r) => r.group))];
 const day2Sheets = Object.keys(DAY2_SHEETS);
 if (venues.length !== groups.length) {
 throw new Error('会場はグループ数（' + groups.length + '）分入力してください');
 }
 if (teamNames.length !== infoRows.length) {
 throw new Error('チーム数が一致しません（' + infoRows.length + 'チーム分入力してください）');
 }
 if (day2Venues && day2Venues.length !== day2Sheets.length) {
 throw new Error('２日目の会場名は' + day2Sheets.length + '件入力してください');
 }
 const nonEmptyNames = teamNames.map((n) => (n || '').trim()).filter((n) => n);
 const uniqueNames = new Set(nonEmptyNames);
 if (uniqueNames.size !== nonEmptyNames.length) {
 throw new Error('チーム名が重複しています。同じチーム名は使用できません');
 }
 const venueColumn = infoRows.map(() => ['']);
 groups.forEach((g, i) => {
 const seat1Idx = infoRows.findIndex((r) => r.group === g && Number(r.seat) === 1);
 if (seat1Idx !== -1) venueColumn[seat1Idx] = [venues[i]];
 });
 sheet.getRange(2, INFO_COL.VENUE, infoRows.length, 1).setValues(venueColumn);
 sheet.getRange(2, INFO_COL.TEAM, infoRows.length, 1).setValues(teamNames.map((name) => [name]));
 if (day2Venues) {
 day2Sheets.forEach((name, i) => setDay2VenueName_(name, day2Venues[i]));
 }
 rebuildAll();
 return '情報を保存しました';
}

// 情報編集タブの「リセット」ボタンから呼ばれる。試合結果（得点）だけをクリアする。
// チーム名・会場名・審判（REF1/REF2）は変更しない。TOだけは自動計算前のプレースホルダー
// （「○試合負チーム」）に戻す。２日目が作成済みの場合はそのまま維持し（作成し直しは不要）、
// 得点が再入力されるたびに通常どおりトーナメントが再構築される。
function resetScores() {
 GROUP_SHEETS.forEach((name) => {
 const sheet = getSs().getSheetByName(name);
 if (!sheet) return;
 const rows = [...DAY1_MATCH_ROWS, ...DAY1_FT_ROWS];
 const firstRow = rows[0];
 const numRows = rows[rows.length - 1] - firstRow + 1;
 const data = sheet.getRange(firstRow, 1, numRows, 9).getValues();
 rows.forEach((row) => {
 data[row - firstRow][M_COL.LSCORE - 1] = '';
 data[row - firstRow][M_COL.DSCORE - 1] = '';
 });
 sheet.getRange(firstRow, 1, numRows, 9).setValues(data);
 });

 Object.keys(DAY2_SHEETS).forEach((name) => {
 const sheet = getSs().getSheetByName(name);
 if (!sheet) return;
 const rows = DAY2_SLOTS.flat();
 const firstRow = rows[0];
 const numRows = rows[rows.length - 1] - firstRow + 1;
 const data = sheet.getRange(firstRow, 1, numRows, 9).getValues();
 rows.forEach((row) => {
 data[row - firstRow][M_COL.LSCORE - 1] = '';
 data[row - firstRow][M_COL.DSCORE - 1] = '';
 // 第1試合枠（RR1A/RR1B）のTOは自動計算対象外（空欄のまま）のため触らない
 if (row !== D2.RR1A && row !== D2.RR1B) {
 data[row - firstRow][M_COL.TO - 1] = toPlaceholder_(row);
 }
 });
 sheet.getRange(firstRow, 1, numRows, 9).setValues(data);
 });

 const infoSheet = getSs().getSheetByName(INFO_SHEET);
 const lastRow = infoSheet.getLastRow();
 infoSheet.getRange(2, INFO_COL.SUBRANK, lastRow - 1, 3).clearContent(); // サブ順位・グループ最終順位・総合順位

 rebuildAll(); // 初日側の審判・TOをプレースホルダーへ戻す（チーム名は変わらない）
 return 'スコアをリセットしました';
}

// スプレッドシートのメニュー「大会運営 → 試合結果リセット」から呼ばれる
function resetScoresFromMenu_() {
 const ui = SpreadsheetApp.getUi();
 const resp = ui.alert('確認', '試合結果（得点）をすべてリセットします。よろしいですか？', ui.ButtonSet.YES_NO);
 if (resp !== ui.Button.YES) return;
 const msg = resetScores();
 ui.alert(msg);
}

/* ============ 共通ロジック ============ */

function winnerLoser_(lightTeam, darkTeam, lightScore, darkScore) {
 if (lightScore === '' || darkScore === '' || lightScore === null || darkScore === null) return null;
 if (lightScore === darkScore) return null;
 return lightScore > darkScore ? { winner: lightTeam, loser: darkTeam } : { winner: darkTeam, loser: lightTeam };
}

// シート内の行番号2..N を「試合1..(N-1)」として扱い、未確定なTOの表示名を作る
function toPlaceholder_(row) {
 return row - 1 + '試合負チーム';
}

// ２日目のトーナメント枠で、対戦チームがまだ決まっていない場合の表示名を作る（「(未定)」の代わりに使う）
function winPlaceholder_(row) {
 return row - 1 + '試合勝';
}

function losePlaceholder_(row) {
 return row - 1 + '試合負';
}

// 指定した行番号群（連続していなくてもよい）を1回のgetValues()でまとめて読み取り、
// 行番号 -> その行の列値配列（0始まり、M_COLの列番号-1でアクセス）のマップを返す。
// getRange().getValue()をセルごとに呼ぶより大幅に高速なため、読み込み・再構築系の関数で共通利用する。
function readSheetRows_(sheet, rows) {
 const minRow = Math.min.apply(null, rows);
 const maxRow = Math.max.apply(null, rows);
 const values = sheet.getRange(minRow, 1, maxRow - minRow + 1, 9).getValues();
 const map = {};
 rows.forEach((row) => {
 map[row] = values[row - minRow];
 });
 return map;
}

/* ============ 初日：Ｇ１〜Ｇ４ ============ */

function rebuildGroupSheet_(groupSheetName, infoRows) {
 const sheet = getSs().getSheetByName(groupSheetName);
 if (!sheet) return;
 // シート名（Ｇ１〜Ｇ４）と情報シートのグループ名の対応が無いため、出現順の4グループに割当てる。
 const allGroupNames = [...new Set(infoRows.map((r) => r.group))];
 const idx = GROUP_SHEETS.indexOf(groupSheetName);
 const groupName = allGroupNames[idx];
 const teams = teamsOfGroup_(infoRows, groupName); // seat1..6

 if (teams.length < 6 || teams.some((t) => !t.team)) return; // チーム名未登録なら何もしない

 const bySeat = {};
 teams.forEach((t) => (bySeat[t.seat] = t.team));

 // 試合1〜9（フリースロー含む）の全列を1回のgetValues()で読み込み、以降はメモリ上の配列に対して
 // 読み書きし、最後に1回のsetValues()でまとめて反映する（挙動は従来のセル単位アクセスと同一）。
 const ALL_ROWS = [...DAY1_MATCH_ROWS, ...DAY1_FT_ROWS];
 const FIRST_ROW = ALL_ROWS[0];
 const numRows = ALL_ROWS[ALL_ROWS.length - 1] - FIRST_ROW + 1;
 const data = sheet.getRange(FIRST_ROW, 1, numRows, 9).getValues();
 const cell = (row, col) => data[row - FIRST_ROW][col - 1];
 const setCell = (row, col, v) => {
 data[row - FIRST_ROW][col - 1] = v;
 };

 // 1) 試合1〜6：チーム名固定書き込み
 DAY1_MATCH_ROWS.forEach((row, i) => {
 const [ls, ds] = DAY1_PAIRS[row];
 setCell(row, M_COL.TIME, DAY1_TIMES[i]);
 setCell(row, M_COL.LIGHT, bySeat[ls]);
 setCell(row, M_COL.DARK, bySeat[ds]);
 });

 // 2) 各試合の得点を読み取り
 const scores = {};
 DAY1_MATCH_ROWS.forEach((row) => {
 const light = cell(row, M_COL.LIGHT);
 const dark = cell(row, M_COL.DARK);
 const lscore = cell(row, M_COL.LSCORE);
 const dscore = cell(row, M_COL.DSCORE);
 scores[row] = { light, dark, lscore, dscore, wl: winnerLoser_(light, dark, lscore, dscore) };
 });

 // 3) 審判1・審判2・TO（試合1は試合6を参照。TOは試合6の「淡」固定）
 DAY1_MATCH_ROWS.forEach((row, i) => {
 const prevRow = i === 0 ? 7 : DAY1_MATCH_ROWS[i - 1];
 const prev = scores[prevRow];
 setCell(row, M_COL.REF1, prev.light);
 setCell(row, M_COL.REF2, prev.dark);
 if (row === 2) {
 setCell(row, M_COL.TO, prev.light); // 特例：試合6の「淡」固定
 } else {
 setCell(row, M_COL.TO, prev.wl ? prev.wl.loser : toPlaceholder_(prevRow));
 }
 });

 // 4) サブグループ順位（勝数→得失点差）
 const sub1Rows = [2, 4, 6],
 sub2Rows = [3, 5, 7];
 const sub1Teams = [bySeat[1], bySeat[2], bySeat[3]];
 const sub2Teams = [bySeat[4], bySeat[5], bySeat[6]];
 const standing1 = computeStandings_(sub1Teams, sub1Rows, scores);
 const standing2 = computeStandings_(sub2Teams, sub2Rows, scores);
 const complete1 = sub1Rows.every((r) => scores[r].wl);
 const complete2 = sub2Rows.every((r) => scores[r].wl);

 if (complete1) writeSubRanks_(infoRows, groupName, standing1);
 if (complete2) writeSubRanks_(infoRows, groupName, standing2);

 // 5) フリースロー対決（試合7,8,9 = DAY1_FT_TIER_ORDERに従い5位決定戦/3位決定戦/1位決定戦の順）。
 // 開始時間欄には対戦の意味（1位決定戦/3位決定戦/5位決定戦）を常に表示する。
 // チーム名はAブロック・Bブロックの総当たりが両方完了するまで決まらないため、
 // 未完了の間は明示的に空欄にする（前回完了時の対戦相手が残ってしまわないように毎回書き込む）。
 const ftScores = {};
 DAY1_FT_ROWS.forEach((row, i) => {
 const tier = DAY1_FT_TIER_ORDER[i];
 setCell(row, M_COL.TIME, DAY1_FT_TIME_LABELS[tier]);
 let light = '',
 dark = '';
 if (complete1 && complete2) {
 light = standing1[tier].team;
 dark = standing2[tier].team;
 }
 setCell(row, M_COL.LIGHT, light);
 setCell(row, M_COL.DARK, dark);
 const lscore = cell(row, M_COL.LSCORE);
 const dscore = cell(row, M_COL.DSCORE);
 ftScores[row] = { light, dark, lscore, dscore, tier };
 });

 // 5b) 試合7,8,9の審判1・審判2・TO。担当は「1つ前のフリースロー対決の対戦2チーム」で、
 // 試合7（5位決定戦）だけは循環的に試合9（1位決定戦）を参照する（試合1が試合6を参照するのと同じ考え方）。
 // TOは担当元の「淡」チーム固定（担当元はまだ結果が出ていない場合があるため、勝敗に依存しない）。
 DAY1_FT_ROWS.forEach((row, i) => {
 const prevRow = i === 0 ? DAY1_FT_ROWS[DAY1_FT_ROWS.length - 1] : DAY1_FT_ROWS[i - 1];
 const prev = ftScores[prevRow];
 setCell(row, M_COL.REF1, prev.light);
 setCell(row, M_COL.REF2, prev.dark);
 setCell(row, M_COL.TO, prev.light);
 });

 sheet.getRange(FIRST_ROW, 1, numRows, 9).setValues(data);

 // 6) 最終順位（1〜6位）を情報シートへ
 if (complete1 && complete2) {
 const finalRanks = {}; // team -> rank
 DAY1_FT_ROWS.forEach((row) => {
 const s = ftScores[row];
 if (s.lscore === '' || s.dscore === '' || s.light === '' || s.dark === '') return;
 let winner, loser;
 if (s.lscore > s.dscore) {
 winner = s.light;
 loser = s.dark;
 } else if (s.dscore > s.lscore) {
 winner = s.dark;
 loser = s.light;
 } else return; // サドンデス未記入
 finalRanks[winner] = s.tier * 2 + 1;
 finalRanks[loser] = s.tier * 2 + 2;
 });
 Object.keys(finalRanks).forEach((team) => {
 const info = infoRows.find((r) => r.group === groupName && r.team === team);
 if (info) getSs().getSheetByName(INFO_SHEET).getRange(info.rowIndex, INFO_COL.FINALRANK).setValue(finalRanks[team]);
 });
 }
}

function computeStandings_(teams, rows, scores) {
 const stat = {};
 teams.forEach((t) => (stat[t] = { team: t, wins: 0, diff: 0 }));
 rows.forEach((row) => {
 const s = scores[row];
 if (!s.wl) return;
 const diff = Math.abs((s.lscore || 0) - (s.dscore || 0));
 stat[s.wl.winner].wins += 1;
 stat[s.wl.winner].diff += diff;
 stat[s.wl.loser].diff -= diff;
 });
 return Object.values(stat).sort((a, b) => b.wins - a.wins || b.diff - a.diff);
}

function writeSubRanks_(infoRows, groupName, standing) {
 const sheet = getSs().getSheetByName(INFO_SHEET);
 standing.forEach((s, i) => {
 const info = infoRows.find((r) => r.group === groupName && r.team === s.team);
 if (info) sheet.getRange(info.rowIndex, INFO_COL.SUBRANK).setValue(i + 1);
 });
}

/* ============ 2日目：決勝側／2部側 ============ */

function rankedTeamsAcrossGroups_(infoRows, rank) {
 const groups = [...new Set(infoRows.map((r) => r.group))];
 return groups.map((g) => {
 const t = infoRows.find((r) => r.group === g && Number(r.finalRank) === rank);
 return t ? t.team : '';
 });
}

function rebuildDay2Sheet_(sheetName, infoRows) {
 const sheet = getSs().getSheetByName(sheetName);
 if (!sheet) return;
 const cfg = DAY2_SHEETS[sheetName];
 const high = rankedTeamsAcrossGroups_(infoRows, cfg.tournamentRanks[0]); // [G1,G2,G3,G4] highシード
 const low = rankedTeamsAcrossGroups_(infoRows, cfg.tournamentRanks[1]);
 const rr = rankedTeamsAcrossGroups_(infoRows, cfg.rrRank);
 if (high.some((t) => !t) || low.some((t) => !t) || rr.some((t) => !t)) return; // 初日の順位が全部揃うまで何もしない

 // 全18行×9列を1回のgetValues()で読み込み、以降はメモリ上の配列に対して読み書きし、
 // 最後に1回のsetValues()でまとめて反映する（挙動は従来のセル単位アクセスと同一）。
 const FIRST_ROW = DAY2_SLOTS[0][0];
 const numRows = DAY2_SLOTS[DAY2_SLOTS.length - 1][1] - FIRST_ROW + 1;
 const data = sheet.getRange(FIRST_ROW, 1, numRows, 9).getValues();
 const cell = (row, col) => data[row - FIRST_ROW][col - 1];
 const setCell = (row, col, v) => {
 data[row - FIRST_ROW][col - 1] = v;
 };

 // 既に確定済み（＝現在値と一致）なら上書きしない（入力済得点を保持）。挙動はsetPair_と同一で、
 // 読み書き対象がシートではなくメモリ上のdata配列になった点のみが変更。
 const setPair = (row, light, dark) => {
 if (cell(row, M_COL.LIGHT) === light && cell(row, M_COL.DARK) === dark) return;
 setCell(row, M_COL.LIGHT, light);
 setCell(row, M_COL.DARK, dark);
 };

 // 開始時間
 DAY2_SLOTS.forEach((pair, i) => {
 pair.forEach((row) => setCell(row, M_COL.TIME, DAY2_TIMES[i]));
 });

 // 総当たり（4チーム、3ラウンド）
 setPair(D2.RR1A, rr[0], rr[1]);
 setPair(D2.RR1B, rr[2], rr[3]);
 setPair(D2.RR2A, rr[0], rr[2]);
 setPair(D2.RR2B, rr[1], rr[3]);
 setPair(D2.RR3A, rr[0], rr[3]);
 setPair(D2.RR3B, rr[1], rr[2]);

 // トーナメント1回戦（対角シード）
 setPair(D2.T1A, high[0], low[2]);
 setPair(D2.T1B, high[1], low[3]);
 setPair(D2.T1C, high[2], low[0]);
 setPair(D2.T1D, high[3], low[1]);

 // 得点読み取り
 const read = (row) => {
 const light = cell(row, M_COL.LIGHT);
 const dark = cell(row, M_COL.DARK);
 const lscore = cell(row, M_COL.LSCORE);
 const dscore = cell(row, M_COL.DSCORE);
 return { light, dark, lscore, dscore, wl: winnerLoser_(light, dark, lscore, dscore) };
 };
 const r1a = read(D2.T1A),
 r1b = read(D2.T1B),
 r1c = read(D2.T1C),
 r1d = read(D2.T1D);

 // 準決勝・敗者復活1回戦（対戦チームが未確定の側は「○試合勝／○試合負」のプレースホルダーを表示する）
 setPair(D2.SF_A, r1a.wl ? r1a.wl.winner : winPlaceholder_(D2.T1A), r1b.wl ? r1b.wl.winner : winPlaceholder_(D2.T1B));
 setPair(D2.CONS_A, r1a.wl ? r1a.wl.loser : losePlaceholder_(D2.T1A), r1b.wl ? r1b.wl.loser : losePlaceholder_(D2.T1B));
 setPair(D2.SF_B, r1c.wl ? r1c.wl.winner : winPlaceholder_(D2.T1C), r1d.wl ? r1d.wl.winner : winPlaceholder_(D2.T1D));
 setPair(D2.CONS_B, r1c.wl ? r1c.wl.loser : losePlaceholder_(D2.T1C), r1d.wl ? r1d.wl.loser : losePlaceholder_(D2.T1D));

 const sfA = read(D2.SF_A),
 sfB = read(D2.SF_B);
 const consA = read(D2.CONS_A),
 consB = read(D2.CONS_B);

 // 決勝・3位決定戦・5位決定戦・7位決定戦（同様にプレースホルダー対応）
 setPair(D2.FINAL, sfA.wl ? sfA.wl.winner : winPlaceholder_(D2.SF_A), sfB.wl ? sfB.wl.winner : winPlaceholder_(D2.SF_B));
 setPair(D2.R3RD, sfA.wl ? sfA.wl.loser : losePlaceholder_(D2.SF_A), sfB.wl ? sfB.wl.loser : losePlaceholder_(D2.SF_B));
 setPair(D2.R5TH, consA.wl ? consA.wl.winner : winPlaceholder_(D2.CONS_A), consB.wl ? consB.wl.winner : winPlaceholder_(D2.CONS_B));
 setPair(D2.R7TH, consA.wl ? consA.wl.loser : losePlaceholder_(D2.CONS_A), consB.wl ? consB.wl.loser : losePlaceholder_(D2.CONS_B));

 // 審判1・審判2・TO（前の試合枠、同じコート位置。第1試合枠は手動のため触らない）
 for (let i = 1; i < DAY2_SLOTS.length; i++) {
 const prevPair = DAY2_SLOTS[i - 1];
 DAY2_SLOTS[i].forEach((row, pos) => {
 const prevRow = prevPair[pos];
 const prevLight = cell(prevRow, M_COL.LIGHT);
 const prevDark = cell(prevRow, M_COL.DARK);
 if (!prevLight || !prevDark) return;
 setCell(row, M_COL.REF1, prevLight);
 setCell(row, M_COL.REF2, prevDark);
 const prevScore = read(prevRow);
 setCell(row, M_COL.TO, prevScore.wl ? prevScore.wl.loser : toPlaceholder_(prevRow));
 });
 }

 sheet.getRange(FIRST_ROW, 1, numRows, 9).setValues(data);

 // 総合順位（1〜24位）を情報シートへ
 const finalMatch = read(D2.FINAL),
 r3rd = read(D2.R3RD),
 r5th = read(D2.R5TH),
 r7th = read(D2.R7TH);
 const rrScores = {};
 [D2.RR1A, D2.RR1B, D2.RR2A, D2.RR2B, D2.RR3A, D2.RR3B].forEach((row) => (rrScores[row] = read(row)));
 const rrRanked = computeStandings_(rr, [D2.RR1A, D2.RR1B, D2.RR2A, D2.RR2B, D2.RR3A, D2.RR3B], rrScores);
 const rrComplete = [D2.RR1A, D2.RR1B, D2.RR2A, D2.RR2B, D2.RR3A, D2.RR3B].every((r) => rrScores[r].wl);

 const overall = {};
 if (finalMatch.wl) {
 overall[finalMatch.wl.winner] = cfg.placeBase + 1;
 overall[finalMatch.wl.loser] = cfg.placeBase + 2;
 }
 if (r3rd.wl) {
 overall[r3rd.wl.winner] = cfg.placeBase + 3;
 overall[r3rd.wl.loser] = cfg.placeBase + 4;
 }
 if (r5th.wl) {
 overall[r5th.wl.winner] = cfg.placeBase + 5;
 overall[r5th.wl.loser] = cfg.placeBase + 6;
 }
 if (r7th.wl) {
 overall[r7th.wl.winner] = cfg.placeBase + 7;
 overall[r7th.wl.loser] = cfg.placeBase + 8;
 }
 if (rrComplete) rrRanked.forEach((s, i) => (overall[s.team] = 16 + cfg.placeBase / 2 + i + 1));

 const infoSheet = getSs().getSheetByName(INFO_SHEET);
 Object.keys(overall).forEach((team) => {
 const info = infoRows.find((r) => r.team === team);
 if (info) infoSheet.getRange(info.rowIndex, INFO_COL.OVERALLRANK).setValue(overall[team]);
 });
}

/* ============ 全体再構築（得点入力ごとに呼ぶ） ============ */

function rebuildAll() {
 const infoRows = readInfoRows_();
 GROUP_SHEETS.forEach((name) => rebuildGroupSheet_(name, infoRows));
 const infoRows2 = readInfoRows_(); // グループ最終順位が更新された最新値を再取得
 // ２日目シートは「２日目作成」ボタン（createDay2）が押されるまでは触らない。
 // 押された後は、これまで通り得点入力のたびに自動で再構築（トーナメント進行）する。
 if (isDay2Created_()) {
 Object.keys(DAY2_SHEETS).forEach((name) => rebuildDay2Sheet_(name, infoRows2));
 }
}

/* ============ ２日目作成の管理 ============ */

const DAY2_CREATED_PROP = 'DAY2_CREATED';

function isDay2Created_() {
 return PropertiesService.getDocumentProperties().getProperty(DAY2_CREATED_PROP) === 'true';
}

function setDay2Created_(value) {
 PropertiesService.getDocumentProperties().setProperty(DAY2_CREATED_PROP, value ? 'true' : 'false');
}

// 情報シートの全チームにグループ最終順位（1〜6）が入っているか＝初日の結果が出揃ったかを判定する
function isDay1Complete_(infoRows) {
 return (
 infoRows.length > 0 &&
 infoRows.every((r) => {
 const rank = Number(r.finalRank);
 return rank >= 1 && rank <= 6;
 })
 );
}

// アプリの「２日目作成」ボタン表示判定用。初日が完了しているか／２日目が作成済みかを返す
function getDay2Status() {
 const infoRows = readInfoRows_();
 return {
 day1Complete: isDay1Complete_(infoRows),
 day2Created: isDay2Created_(),
 };
}

// アプリの「２日目作成」ボタンから呼ばれる。以後はrebuildAll()のたびに２日目シートも自動再構築されるようになる
function createDay2() {
 const infoRows = readInfoRows_();
 if (!isDay1Complete_(infoRows)) {
 throw new Error('初日の全結果（グループ最終順位）がまだ揃っていません');
 }
 setDay2Created_(true);
 rebuildAll();
 return '２日目を作成しました';
}

// スプレッドシートのメニュー「大会運営 → ２日目作成」から呼ばれる
function createDay2FromMenu_() {
 try {
 const msg = createDay2();
 SpreadsheetApp.getUi().alert(msg);
 } catch (e) {
 SpreadsheetApp.getUi().alert('エラー: ' + e.message);
 }
}

/* ============ アプリからの得点入力 ============ */

// シート名（Ｇ１〜Ｇ４／２日目決勝側／２日目２部側）を「コート名」として画面に表示するためのラベルを返す。
// Ｇ１〜Ｇ４は情報シートに登録された会場名（そのグループの座席1の行の会場名）を使う。
// ２日目の2シートはグループを跨ぐため、情報編集で入力された２日目専用の会場名（day2Venues）を使う。
function courtLabelForSheet_(sheetName, infoRows) {
 if (GROUP_SHEETS.includes(sheetName)) {
 const allGroupNames = [...new Set(infoRows.map((r) => r.group))];
 const idx = GROUP_SHEETS.indexOf(sheetName);
 const groupName = allGroupNames[idx];
 const seat1 = infoRows.find((r) => r.group === groupName && Number(r.seat) === 1);
 return (seat1 && seat1.venue) || sheetName;
 }
 return getDay2VenueName_(sheetName) || sheetName;
}

// 試合結果タブの選択肢を返す。Ｇ１〜Ｇ４は1グループ=1コートのためボタンを押すと即テーブル表示（hasCourts:false）。
// ２日目の2シートは1シートに2コート分の試合が同居しているため、会場ボタン押下後にさらに
// 「コート1」「コート2」を選ぶ2段階（hasCourts:true, courts:[{index,label}]）にする。
function getLocationOptions() {
 const infoRows = readInfoRows_();
 const groupOptions = GROUP_SHEETS.map((name) => ({
 sheet: name,
 label: courtLabelForSheet_(name, infoRows),
 hasCourts: false,
 }));
 // 初日の全結果（グループ最終順位）が揃うまでは、２日目の会場ボタン自体を表示しない
 const day2Options = isDay1Complete_(infoRows)
 ? Object.keys(DAY2_SHEETS).map((name) => ({
 sheet: name,
 label: courtLabelForSheet_(name, infoRows),
 hasCourts: true,
 courts: [
 { index: 0, label: 'コート1' },
 { index: 1, label: 'コート2' },
 ],
 }))
 : [];
 return [...groupOptions, ...day2Options];
}

// ２日目の2シートは`DAY2_SLOTS`の各枠が[コート1の行, コート2の行]のペアになっているため、
// courtIndex（0または1）を指定するとその位置の行だけに絞り込む。Ｇ１〜Ｇ４はコートの概念が無いので全行を返す。
function rowsForCourt_(sheetName, courtIndex) {
 if (GROUP_SHEETS.includes(sheetName)) {
 return [...DAY1_MATCH_ROWS, ...DAY1_FT_ROWS];
 }
 if (courtIndex === 0 || courtIndex === 1) {
 return DAY2_SLOTS.map((pair) => pair[courtIndex]);
 }
 return DAY2_SLOTS.flat();
}

// 試合結果タブのテーブル表示用。1コート分の試合を、シートに記載されている列順（淡チーム,淡得点,濃得点,濃チーム,TO,審判1,審判2）で返す。
// 審判・TOは全自動計算のため読み取り専用。フリースロー対決（isFt）のみサドンデス入力欄を出す。
function getCourtMatches(sheetName, courtIndex) {
 const sheet = getSs().getSheetByName(sheetName);
 const ftRows = GROUP_SHEETS.includes(sheetName) ? DAY1_FT_ROWS : [];
 const rows = rowsForCourt_(sheetName, courtIndex);
 const data = readSheetRows_(sheet, rows);
 return rows.map((row) => {
 const v = data[row];
 const lscore = v[M_COL.LSCORE - 1];
 const dscore = v[M_COL.DSCORE - 1];
 return {
 row,
 light: v[M_COL.LIGHT - 1],
 dark: v[M_COL.DARK - 1],
 lscore,
 dscore,
 to: v[M_COL.TO - 1],
 ref1: v[M_COL.REF1 - 1],
 ref2: v[M_COL.REF2 - 1],
 isFt: ftRows.includes(row),
 recorded: lscore !== '' && dscore !== '' && lscore !== null && dscore !== null,
 };
 });
}

// 割り当てタブのテーブル表示用（読み取り専用）。getCourtMatchesと同じ絞り込みだが、開始時間を含める。
function getAssignmentForCourt(sheetName, courtIndex) {
 const sheet = getSs().getSheetByName(sheetName);
 const rows = rowsForCourt_(sheetName, courtIndex);
 const data = readSheetRows_(sheet, rows);
 return rows.map((row) => {
 const v = data[row];
 return {
 row,
 time: formatTimeValue_(v[M_COL.TIME - 1]),
 light: v[M_COL.LIGHT - 1],
 lscore: v[M_COL.LSCORE - 1],
 dscore: v[M_COL.DSCORE - 1],
 dark: v[M_COL.DARK - 1],
 to: v[M_COL.TO - 1],
 ref1: v[M_COL.REF1 - 1],
 ref2: v[M_COL.REF2 - 1],
 };
 });
}

function submitScore(sheetName, row, lightScore, darkScore, suddenDeathWinner) {
 const sheet = getSs().getSheetByName(sheetName);
 sheet.getRange(row, M_COL.LSCORE).setValue(lightScore);
 sheet.getRange(row, M_COL.DSCORE).setValue(darkScore);
 if (Number(lightScore) === Number(darkScore) && suddenDeathWinner) {
 const light = sheet.getRange(row, M_COL.LIGHT).getValue();
 const dark = sheet.getRange(row, M_COL.DARK).getValue();
 const winnerTeam = suddenDeathWinner === 'light' ? light : dark;
 sheet.getRange(row, M_COL.TO).setValue(`(サドンデス勝者: ${winnerTeam})`);
 sheet.getRange(row, suddenDeathWinner === 'light' ? M_COL.LSCORE : M_COL.DSCORE).setValue(Number(lightScore) + 0.1);
 }
 rebuildAll();
 return '記録しました';
}

/* ============ 個別検索 ============ */

// 個別検索タブのラジオボタン一覧用。登録済み全チームを情報シートの登録順で{team}の配列で返す
function getAllTeams() {
 const infoRows = readInfoRows_();
 return infoRows.filter((r) => r.team).map((r) => ({ team: r.team }));
}

// 個別検索タブの「詳細表示」から呼ばれる。指定チームの初日・２日目の予定（試合・審判/TO当番）を返す
function getTeamSchedule(team) {
 const infoRows = readInfoRows_();
 return {
 day1: day1ScheduleForTeam_(team, infoRows),
 day2: day2ScheduleForTeam_(team, infoRows),
 };
}

// セルの値が時刻フォーマットの場合Date型で返ってくるため、個別検索のように複数階層ネストした
// オブジェクトに含めるとgoogle.script.runのシリアライズに失敗し、クライアント側にnullが渡ることがある。
// 表示用の文字列（H:mm）に変換してから返す。
function formatTimeValue_(v) {
 return v instanceof Date ? Utilities.formatDate(v, 'Asia/Tokyo', 'H:mm') : v || '';
}

// 初日：チームが所属するＧ１〜Ｇ４シートから、そのチームが関わる試合行・審判/TO当番行を抽出する
function day1ScheduleForTeam_(team, infoRows) {
 const info = infoRows.find((r) => r.team === team);
 if (!info) return null;
 const allGroupNames = [...new Set(infoRows.map((r) => r.group))];
 const idx = allGroupNames.indexOf(info.group);
 const sheetName = GROUP_SHEETS[idx];
 const sheet = getSs().getSheetByName(sheetName);
 if (!sheet) return null;
 const venue = courtLabelForSheet_(sheetName, infoRows);

 const matches = [];
 const duties = [];
 const rows = [...DAY1_MATCH_ROWS, ...DAY1_FT_ROWS];
 const data = readSheetRows_(sheet, rows);
 rows.forEach((row) => {
 const isFt = DAY1_FT_ROWS.includes(row);
 const v = data[row];
 const time = formatTimeValue_(v[M_COL.TIME - 1]);
 const light = v[M_COL.LIGHT - 1];
 const dark = v[M_COL.DARK - 1];
 const lscore = v[M_COL.LSCORE - 1];
 const dscore = v[M_COL.DSCORE - 1];
 const ref1 = v[M_COL.REF1 - 1];
 const ref2 = v[M_COL.REF2 - 1];
 const to = v[M_COL.TO - 1];

 if (light === team || dark === team) {
 matches.push({
 row,
 label: isFt ? 'フリースロー対決' : '試合' + (row - 1),
 time,
 light,
 dark,
 lscore,
 dscore,
 to,
 ref1,
 ref2,
 opponent: light === team ? dark : light,
 isFt,
 venue,
 court: '', // 初日はグループ＝コートが固定で別データを持たないため空欄
 });
 }
 if (ref1 === team || ref2 === team) {
 duties.push({
 row,
 label: isFt ? 'フリースロー対決' : '試合' + (row - 1),
 time,
 light,
 dark,
 lscore,
 dscore,
 to,
 ref1,
 ref2,
 teams: [light, dark],
 isTo: to === team,
 venue,
 court: '',
 });
 }
 });

 return { sheetName, venue, matches, duties };
}

// ２日目のトーナメント構造：各枠が勝者／敗者としてどの枠のどちら側（light/dark）に進むかの固定表
function day2NextSide_() {
 const next = {};
 next[D2.T1A] = { winner: [D2.SF_A, 'light'], loser: [D2.CONS_A, 'light'] };
 next[D2.T1B] = { winner: [D2.SF_A, 'dark'], loser: [D2.CONS_A, 'dark'] };
 next[D2.T1C] = { winner: [D2.SF_B, 'light'], loser: [D2.CONS_B, 'light'] };
 next[D2.T1D] = { winner: [D2.SF_B, 'dark'], loser: [D2.CONS_B, 'dark'] };
 next[D2.SF_A] = { winner: [D2.FINAL, 'light'], loser: [D2.R3RD, 'light'] };
 next[D2.SF_B] = { winner: [D2.FINAL, 'dark'], loser: [D2.R3RD, 'dark'] };
 next[D2.CONS_A] = { winner: [D2.R5TH, 'light'], loser: [D2.R7TH, 'light'] };
 next[D2.CONS_B] = { winner: [D2.R5TH, 'dark'], loser: [D2.R7TH, 'dark'] };
 return next;
}

function day2RoundLabels_() {
 const label = {};
 [D2.RR1A, D2.RR1B, D2.RR2A, D2.RR2B, D2.RR3A, D2.RR3B].forEach((r) => (label[r] = '総当たり'));
 [D2.T1A, D2.T1B, D2.T1C, D2.T1D].forEach((r) => (label[r] = 'トーナメント1回戦'));
 label[D2.SF_A] = label[D2.SF_B] = '準決勝';
 label[D2.CONS_A] = label[D2.CONS_B] = '敗者復活1回戦';
 label[D2.FINAL] = '決勝';
 label[D2.R3RD] = '3位決定戦';
 label[D2.R5TH] = '5位決定戦';
 label[D2.R7TH] = '7位決定戦';
 return label;
}

// ２日目：DAY2_SLOTSの[コート1の行, コート2の行]ペアから、その行がコート1/コート2どちらかを返す
function day2CourtLabelForRow_(row) {
 const pair = DAY2_SLOTS.find((p) => p.includes(row));
 if (!pair) return '';
 return pair[0] === row ? 'コート1' : 'コート2';
}

// ２日目：チームのグループ最終順位から所属シート（決勝側／2部側）を特定し、
// 総当たり・トーナメントの試合（未確定な先の試合は勝敗両パターンに分岐）・審判/TO当番を抽出する
function day2ScheduleForTeam_(team, infoRows) {
 const info = infoRows.find((r) => r.team === team);
 if (!info) return null;
 const finalRank = Number(info.finalRank);
 if (!finalRank) return null; // 初日の結果がまだ確定していない

 let sheetName = null;
 Object.keys(DAY2_SHEETS).forEach((name) => {
 const cfg = DAY2_SHEETS[name];
 if (cfg.tournamentRanks.includes(finalRank) || cfg.rrRank === finalRank) sheetName = name;
 });
 if (!sheetName) return null;
 const sheet = getSs().getSheetByName(sheetName);
 if (!sheet) return null;
 const venue = getDay2VenueName_(sheetName) || sheetName;

 const day2Data = readSheetRows_(sheet, DAY2_SLOTS.flat());
 const read = (row) => {
 const v = day2Data[row];
 const light = v[M_COL.LIGHT - 1];
 const dark = v[M_COL.DARK - 1];
 const lscore = v[M_COL.LSCORE - 1];
 const dscore = v[M_COL.DSCORE - 1];
 return {
 time: formatTimeValue_(v[M_COL.TIME - 1]),
 light,
 dark,
 lscore,
 dscore,
 to: v[M_COL.TO - 1],
 ref1: v[M_COL.REF1 - 1],
 ref2: v[M_COL.REF2 - 1],
 wl: winnerLoser_(light, dark, lscore, dscore),
 };
 };

 const NEXT = day2NextSide_();
 const ROUND_LABEL = day2RoundLabels_();
 const matches = [];
 const seen = new Set();

 const pushMatch = (row, mySide, condition) => {
 const key = row + '|' + condition;
 if (seen.has(key)) return null;
 seen.add(key);
 const m = read(row);
 matches.push({
 row,
 label: ROUND_LABEL[row] || '',
 condition: condition || null,
 time: m.time,
 light: m.light,
 dark: m.dark,
 lscore: m.lscore,
 dscore: m.dscore,
 to: m.to,
 ref1: m.ref1,
 ref2: m.ref2,
 opponent: mySide === 'light' ? m.dark : m.light,
 venue,
 court: day2CourtLabelForRow_(row),
 });
 return m;
 };

 const walk = (row, mySide, condition) => {
 const m = pushMatch(row, mySide, condition);
 if (!m) return;
 const next = NEXT[row];
 if (!next) return; // 決勝・3位・5位・7位決定戦は末端
 if (m.wl) {
 const iWon = (mySide === 'light' && m.wl.winner === m.light) || (mySide === 'dark' && m.wl.winner === m.dark);
 const [nRow, nSide] = iWon ? next.winner : next.loser;
 walk(nRow, nSide, condition);
 } else {
 const [wRow, wSide] = next.winner;
 const [lRow, lSide] = next.loser;
 walk(wRow, wSide, (condition ? condition + '・' : '') + '勝った場合');
 walk(lRow, lSide, (condition ? condition + '・' : '') + '負けた場合');
 }
 };

 // 総当たり（対象なら3試合とも常に確定済みで分岐なし）
 [D2.RR1A, D2.RR1B, D2.RR2A, D2.RR2B, D2.RR3A, D2.RR3B].forEach((row) => {
 const m = read(row);
 if (m.light === team) pushMatch(row, 'light', null);
 else if (m.dark === team) pushMatch(row, 'dark', null);
 });

 // トーナメント（1回戦で自分を見つけたら以降をたどる）
 [D2.T1A, D2.T1B, D2.T1C, D2.T1D].some((row) => {
 const m = read(row);
 if (m.light === team) {
 walk(row, 'light', null);
 return true;
 }
 if (m.dark === team) {
 walk(row, 'dark', null);
 return true;
 }
 return false;
 });

 // 審判・TO当番（実名が一致する行のみを拾う。未確定の枠はプレースホルダー文字のため一致せず自然に除外される）
 const duties = [];
 DAY2_SLOTS.flat().forEach((row) => {
 const m = read(row);
 if (m.ref1 === team || m.ref2 === team) {
 duties.push({
 row,
 label: ROUND_LABEL[row] || '',
 time: m.time,
 light: m.light,
 dark: m.dark,
 lscore: m.lscore,
 dscore: m.dscore,
 to: m.to,
 ref1: m.ref1,
 ref2: m.ref2,
 teams: [m.light, m.dark],
 isTo: m.to === team,
 venue,
 court: day2CourtLabelForRow_(row),
 });
 }
 });

 return {
 sheetName,
 venue,
 matches,
 duties,
 };
}

/* ============ 結果表 Excel / 速報PDF 出力 ============ */
// 「情報編集」タブから呼ばれる。既存の生データシートとは別に、見やすく整形した
// 結果表（得点マトリクス・トーナメント表）を新規スプレッドシートに作成し、
// xlsx（またはPDF）としてDriveに保存してURLを返す。生成に使った一時スプレッドシートは
// エクスポート後にゴミ箱へ移動し、Driveに残るのは出力ファイルのみにする。

function jstTimestamp_() {
 return Utilities.formatDate(new Date(), 'Asia/Tokyo', 'yyyyMMdd_HHmmss');
}

function readMatchRow_(sheet, row) {
 return {
 row,
 time: sheet.getRange(row, M_COL.TIME).getValue(),
 light: sheet.getRange(row, M_COL.LIGHT).getValue(),
 dark: sheet.getRange(row, M_COL.DARK).getValue(),
 lscore: sheet.getRange(row, M_COL.LSCORE).getValue(),
 dscore: sheet.getRange(row, M_COL.DSCORE).getValue(),
 to: sheet.getRange(row, M_COL.TO).getValue(),
 ref1: sheet.getRange(row, M_COL.REF1).getValue(),
 ref2: sheet.getRange(row, M_COL.REF2).getValue(),
 };
}

function scoreOrBlank_(v) {
 return v === '' || v === null || v === undefined ? '' : v;
}

function groupNameForSheet_(groupSheetName, infoRows) {
 const allGroupNames = [...new Set(infoRows.map((r) => r.group))];
 const idx = GROUP_SHEETS.indexOf(groupSheetName);
 return allGroupNames[idx];
}

// 指定した行群をシートから読み取り、時刻表示・勝敗判定まで済ませた「1試合=1行」のデータ配列にする
function buildMatchList_(sheet, rows) {
 return rows.map((row) => {
 const m = readMatchRow_(sheet, row);
 m.time = formatTimeValue_(m.time);
 m.wl = winnerLoser_(m.light, m.dark, m.lscore, m.dscore);
 return m;
 });
}

// 初日1グループ分の結果データ（試合1〜9を1試合=1行のリストで）を、ライブシートと情報シートから読み取って組み立てる
function buildGroupResultData_(groupSheetName, infoRows) {
 const sheet = getSs().getSheetByName(groupSheetName);
 const groupName = groupNameForSheet_(groupSheetName, infoRows) || groupSheetName;
 const teams = teamsOfGroup_(infoRows, groupName);
 const bySeat = {};
 teams.forEach((t) => (bySeat[t.seat] = t));
 const venue = (bySeat[1] && bySeat[1].venue) || '';

 return {
 groupName,
 venue,
 matches: buildMatchList_(sheet, [...DAY1_MATCH_ROWS, ...DAY1_FT_ROWS]),
 };
}

// ２日目・4チーム総当たり（決勝側／2部側 各シートの5位or6位チーム総当たり）の結果データ
function buildDay2RRData_(sheetName, infoRows) {
 const sheet = getSs().getSheetByName(sheetName);
 const rows = [D2.RR1A, D2.RR1B, D2.RR2A, D2.RR2B, D2.RR3A, D2.RR3B];
 return {
 venueLabel: getDay2VenueName_(sheetName) || sheetName,
 matches: buildMatchList_(sheet, rows),
 };
}

// ２日目・決勝トーナメントの結果データ（各枠を素通しで読み取るだけ。未確定枠のプレースホルダー文字も
// ライブシート側の rebuildDay2Sheet_ が既に書き込んでいるため、そのまま流用できる）
function buildDay2TournamentData_(sheetName, infoRows) {
 const sheet = getSs().getSheetByName(sheetName);
 const rows = [D2.T1A, D2.T1B, D2.T1C, D2.T1D, D2.SF_A, D2.SF_B, D2.CONS_A, D2.CONS_B, D2.FINAL, D2.R3RD, D2.R5TH, D2.R7TH];
 const matches = buildMatchList_(sheet, rows);
 const byRow = {};
 matches.forEach((m) => (byRow[m.row] = m));
 return {
 venueLabel: getDay2VenueName_(sheetName) || sheetName,
 t1a: byRow[D2.T1A],
 t1b: byRow[D2.T1B],
 t1c: byRow[D2.T1C],
 t1d: byRow[D2.T1D],
 sfA: byRow[D2.SF_A],
 sfB: byRow[D2.SF_B],
 consA: byRow[D2.CONS_A],
 consB: byRow[D2.CONS_B],
 final: byRow[D2.FINAL],
 r3rd: byRow[D2.R3RD],
 r5th: byRow[D2.R5TH],
 r7th: byRow[D2.R7TH],
 };
}

/* ---- 一時スプレッドシートへの書き込み（1試合=1行のシンプルな一覧テーブル） ---- */

function writeTitle_(sheet, row, col, width, text) {
 sheet
 .getRange(row, col, 1, width)
 .merge()
 .setValue(text)
 .setFontWeight('bold')
 .setFontSize(13)
 .setHorizontalAlignment('center')
 .setBackground('#111827')
 .setFontColor('#ffffff');
 return row + 2;
}

// コート1／コート2などの小見出し行（1行・指定幅で結合）
function writeSubHeader_(sheet, row, col, width, text) {
 sheet
 .getRange(row, col, 1, width)
 .merge()
 .setValue(text)
 .setFontWeight('bold')
 .setBackground('#374151')
 .setFontColor('#ffffff')
 .setHorizontalAlignment('center');
 return row + 1;
}

// 全角文字を2、それ以外を1として文字列の表示幅の目安を計算する（列幅の自動計算に使う）
function displayWidth_(text) {
 const s = text === null || text === undefined ? '' : String(text);
 let w = 0;
 for (const ch of s) {
 w += /[^\x00-\xff]/.test(ch) ? 2 : 1;
 }
 return w;
}

// 指定した範囲内で最も長い文字列の表示幅に合わせて、範囲内の全列を同じ幅に揃える
function applyUniformColumnWidth_(sheet, row, col, numRows, numCols) {
 if (numRows <= 0) return;
 const values = sheet.getRange(row, col, numRows, numCols).getValues();
 let maxUnits = 0;
 values.forEach((r) => {
 r.forEach((v) => {
 const units = displayWidth_(v);
 if (units > maxUnits) maxUnits = units;
 });
 });
 const px = Math.max(50, Math.min(240, maxUnits * 9 + 20));
 sheet.setColumnWidths(col, numCols, px);
}

// 試合一覧を1試合＝1行のテーブルとして書き込む。勝ったチームの名前・得点セルは黄色く塗りつぶす。
// opts.stageLabel(match) を渡すと、先頭に「内容」列（ラウンド名等）を追加する。
// 列幅は表内で最も長い文字列に合わせて全列同じ幅に揃え、テキストは中央揃えにする。
function writeMatchListTable_(sheet, row, col, matches, opts) {
 opts = opts || {};
 const withStage = !!opts.stageLabel;
 const headers = (withStage ? ['内容'] : []).concat(['開始時間', '淡チーム', '淡得点', '濃得点', '濃チーム', 'TO', '審判1', '審判2']);
 const base = col + (withStage ? 1 : 0); // 「開始時間」列の絶対列番号

 sheet.getRange(row, col, 1, headers.length).setValues([headers]).setFontWeight('bold').setBackground('#e5e7eb');
 const dataRow0 = row + 1;
 const dataRows = matches.map((m) => {
 const stage = withStage ? [opts.stageLabel(m)] : [];
 return stage.concat([m.time || '', m.light || '', scoreOrBlank_(m.lscore), scoreOrBlank_(m.dscore), m.dark || '', m.to || '', m.ref1 || '', m.ref2 || '']);
 });
 if (dataRows.length) sheet.getRange(dataRow0, col, dataRows.length, headers.length).setValues(dataRows);
 const blockHeight = dataRows.length + 1;
 sheet.getRange(row, col, blockHeight, headers.length).setBorder(true, true, true, true, true, true);
 sheet.getRange(row, col, blockHeight, headers.length).setHorizontalAlignment('center');
 applyUniformColumnWidth_(sheet, row, col, blockHeight, headers.length);

 matches.forEach((m, i) => {
 const r = dataRow0 + i;
 if (m.wl && m.wl.winner === m.light) sheet.getRange(r, base + 1, 1, 2).setBackground('#ffe066').setFontWeight('bold');
 if (m.wl && m.wl.winner === m.dark) sheet.getRange(r, base + 3, 1, 2).setBackground('#ffe066').setFontWeight('bold');
 });
 return dataRow0 + dataRows.length + 1;
}

// ２日目の試合一覧を、コート1／コート2の2つに分けて上下に積んだテーブルとして書き込む
function writeDay2CourtBlock_(sheet, topRow, leftCol, matches, opts) {
 opts = opts || {};
 const width = (opts.stageLabel ? 1 : 0) + 8;
 const court1 = matches.filter((m) => day2CourtLabelForRow_(m.row) === 'コート1').sort((a, b) => a.row - b.row);
 const court2 = matches.filter((m) => day2CourtLabelForRow_(m.row) === 'コート2').sort((a, b) => a.row - b.row);
 let r = topRow;
 r = writeSubHeader_(sheet, r, leftCol, width, 'コート1');
 r = writeMatchListTable_(sheet, r, leftCol, court1, opts);
 r = writeSubHeader_(sheet, r, leftCol, width, 'コート2');
 r = writeMatchListTable_(sheet, r, leftCol, court2, opts);
 return r;
}

// チーム名／得点セルを、指定した行範囲（[開始行,終了行]）に結合して書き込む。
// 勝ち上がった側（isWinner）は枠を赤の太線に、それ以外は黒の細線にする
function mergeTeamScoreBox_(sheet, rowRange, col, team, score, isWinner) {
 const h = rowRange[1] - rowRange[0] + 1;
 const teamCell = sheet.getRange(rowRange[0], col, h, 1);
 if (h > 1) teamCell.merge();
 teamCell
 .setValue(team || '')
 .setVerticalAlignment('middle')
 .setHorizontalAlignment('center')
 .setFontWeight('bold');
 const scoreCell = sheet.getRange(rowRange[0], col + 1, h, 1);
 if (h > 1) scoreCell.merge();
 scoreCell.setValue(scoreOrBlank_(score)).setVerticalAlignment('middle').setHorizontalAlignment('center');
 if (isWinner) scoreCell.setBackground('#ffe066').setFontWeight('bold');
 const box = sheet.getRange(rowRange[0], col, h, 2);
 if (isWinner) {
 box.setBorder(true, true, true, true, false, false, '#cc0000', SpreadsheetApp.BorderStyle.SOLID_THICK);
 } else {
 box.setBorder(true, true, true, true, false, false, '#000000', SpreadsheetApp.BorderStyle.SOLID);
 }
}

// ２日目：決勝トーナメント（8チーム：1回戦→準決勝→決勝／3位決定戦、敗者復活：1回戦→5位/7位決定戦）を
// 罫線を使ったブラケット図として描画する。勝ち上がった側の枠は赤の太線、それ以外は黒の細線にし、得点も表示する
function writeTournamentBracket_(sheet, topRow, leftCol, data) {
 const colRound1 = leftCol,
 colSF = leftCol + 2,
 colFinal = leftCol + 4,
 colSide = leftCol + 6;

 writeSubHeader_(sheet, topRow, colRound1, 2, '1回戦');
 writeSubHeader_(sheet, topRow, colSF, 2, '準決勝');
 writeSubHeader_(sheet, topRow, colFinal, 2, '決勝');
 writeSubHeader_(sheet, topRow, colSide, 2, '3位決定戦');
 const top = topRow + 1;

 const leaf = [
 [top, top + 1],
 [top + 3, top + 4],
 [top + 6, top + 7],
 [top + 9, top + 10],
 ];
 const lightWon = (m) => !!(m.wl && m.wl.winner === m.light);
 const darkWon = (m) => !!(m.wl && m.wl.winner === m.dark);

 [data.t1a, data.t1b, data.t1c, data.t1d].forEach((m, i) => {
 const [s, e] = leaf[i];
 mergeTeamScoreBox_(sheet, [s, s], colRound1, m.light, m.lscore, lightWon(m));
 mergeTeamScoreBox_(sheet, [e, e], colRound1, m.dark, m.dscore, darkWon(m));
 });

 mergeTeamScoreBox_(sheet, leaf[0], colSF, data.sfA.light, data.sfA.lscore, lightWon(data.sfA));
 mergeTeamScoreBox_(sheet, leaf[1], colSF, data.sfA.dark, data.sfA.dscore, darkWon(data.sfA));
 mergeTeamScoreBox_(sheet, leaf[2], colSF, data.sfB.light, data.sfB.lscore, lightWon(data.sfB));
 mergeTeamScoreBox_(sheet, leaf[3], colSF, data.sfB.dark, data.sfB.dscore, darkWon(data.sfB));

 const sf = [
 [leaf[0][0], leaf[1][1]],
 [leaf[2][0], leaf[3][1]],
 ];
 mergeTeamScoreBox_(sheet, sf[0], colFinal, data.final.light, data.final.lscore, lightWon(data.final));
 mergeTeamScoreBox_(sheet, sf[1], colFinal, data.final.dark, data.final.dscore, darkWon(data.final));

 const r3rdRow = Math.floor((sf[0][0] + sf[1][1]) / 2);
 mergeTeamScoreBox_(sheet, [r3rdRow, r3rdRow], colSide, data.r3rd.light, data.r3rd.lscore, lightWon(data.r3rd));
 mergeTeamScoreBox_(sheet, [r3rdRow + 1, r3rdRow + 1], colSide, data.r3rd.dark, data.r3rd.dscore, darkWon(data.r3rd));

 const consTop = sf[1][1] + 3;
 writeSubHeader_(sheet, consTop - 1, colRound1, 2, '敗者復活1回戦');
 writeSubHeader_(sheet, consTop - 1, colSF, 2, '5位決定戦');
 writeSubHeader_(sheet, consTop - 1, colSide, 2, '7位決定戦');

 const consLeaf = [
 [consTop, consTop + 1],
 [consTop + 3, consTop + 4],
 ];
 [data.consA, data.consB].forEach((m, i) => {
 const [s, e] = consLeaf[i];
 mergeTeamScoreBox_(sheet, [s, s], colRound1, m.light, m.lscore, lightWon(m));
 mergeTeamScoreBox_(sheet, [e, e], colRound1, m.dark, m.dscore, darkWon(m));
 });
 mergeTeamScoreBox_(sheet, consLeaf[0], colSF, data.r5th.light, data.r5th.lscore, lightWon(data.r5th));
 mergeTeamScoreBox_(sheet, consLeaf[1], colSF, data.r5th.dark, data.r5th.dscore, darkWon(data.r5th));

 const r7thRow = Math.floor((consLeaf[0][0] + consLeaf[1][1]) / 2);
 mergeTeamScoreBox_(sheet, [r7thRow, r7thRow], colSide, data.r7th.light, data.r7th.lscore, lightWon(data.r7th));
 mergeTeamScoreBox_(sheet, [r7thRow + 1, r7thRow + 1], colSide, data.r7th.dark, data.r7th.dscore, darkWon(data.r7th));

 const bottom = consLeaf[1][1] + 2;
 applyUniformColumnWidth_(sheet, topRow, leftCol, bottom - topRow, colSide + 2 - leftCol);
 return bottom;
}

// 初日：グループ結果を指定した位置（topRow, leftCol）に書く。複数グループを1シートに並べるための共通処理
function writeGroupResultBlock_(sheet, topRow, leftCol, data) {
 let r = topRow;
 r = writeTitle_(sheet, r, leftCol, 8, `${data.groupName} グループ結果（会場: ${data.venue || '未設定'}）`);
 r = writeMatchListTable_(sheet, r, leftCol, data.matches);
 return r;
}

// 初日：グループ結果シート（Excelダウンロード用。1グループ＝1シート）
function writeGroupResultSheet_(sheet, data) {
 writeGroupResultBlock_(sheet, 1, 1, data);
}

// 速報PDF用：4グループを2x2に並べて1シートにまとめ、空白を減らす
function writeDay1BulletinSheet_(sheet, groupDataList) {
 const colWidth = 10; // グループ1件あたりの幅（データ8列＋余白2列）
 const bottoms = [
 writeGroupResultBlock_(sheet, 1, 1, groupDataList[0]),
 writeGroupResultBlock_(sheet, 1, 1 + colWidth, groupDataList[1]),
 ];
 const row2Top = Math.max(...bottoms) + 1;
 writeGroupResultBlock_(sheet, row2Top, 1, groupDataList[2]);
 writeGroupResultBlock_(sheet, row2Top, 1 + colWidth, groupDataList[3]);
}

// ２日目：4チーム総当たりシート（トーナメントは別関数）。コート1／コート2に分けて上下に表示する
function writeRRResultSheet_(sheet, data) {
 const labels = day2RoundLabels_();
 const r = writeTitle_(sheet, 1, 1, 9, `${data.venueLabel} ２日目総当たり`);
 writeDay2CourtBlock_(sheet, r, 1, data.matches, { stageLabel: (m) => labels[m.row] || '' });
}

function writeTournamentResultSheet_(sheet, data) {
 const r = writeTitle_(sheet, 1, 1, 8, `${data.venueLabel} ２日目トーナメント`);
 writeTournamentBracket_(sheet, r, 1, data);
}

// 速報PDF用：1会場分を指定した位置（topRow, leftCol）に、総当たり（コート1／コート2の一覧表）＋
// トーナメント（ブラケット図）を上下にまとめて書く
function writeDay2VenueBulletinBlock_(sheet, topRow, leftCol, rrData, tournamentData) {
 const labels = day2RoundLabels_();
 let r = topRow;
 r = writeTitle_(sheet, r, leftCol, 9, `${rrData.venueLabel} ２日目結果`);
 r = writeDay2CourtBlock_(sheet, r, leftCol, rrData.matches, { stageLabel: (m) => labels[m.row] || '' });
 r = writeTournamentBracket_(sheet, r + 1, leftCol, tournamentData);
 return r;
}

// 1会場分を1シートにまとめて表示する
function writeDay2VenueBulletinSheet_(sheet, rrData, tournamentData) {
 writeDay2VenueBulletinBlock_(sheet, 1, 1, rrData, tournamentData);
}

// 速報PDF用：決勝側・2部側の2会場を横に並べて1シートにまとめ、空白を減らす
function writeDay2BulletinSheet_(sheet, venues) {
 const colWidth = 11; // 会場1件あたりの幅（データ9列＋余白2列）
 writeDay2VenueBulletinBlock_(sheet, 1, 1, venues[0].rrData, venues[0].tournamentData);
 writeDay2VenueBulletinBlock_(sheet, 1, 1 + colWidth, venues[1].rrData, venues[1].tournamentData);
}

// tempSsを xlsx または pdf としてエクスポートし、Driveに保存してURLを返す。tempSs自体はゴミ箱へ移動する。
function finalizeWorkbook_(tempSs, filenameBase, format) {
 SpreadsheetApp.flush();
 const params =
 format === 'pdf'
 ? 'format=pdf\&size=A3\&portrait=false\&fitw=true\&scale=2\&sheetnames=true\&printtitle=false\&pagenumbers=false\&gridlines=false\&fzr=false'
 : 'format=xlsx';
 const url = `https://docs.google.com/spreadsheets/d/${tempSs.getId()}/export?${params}`;
 const token = ScriptApp.getOAuthToken();
 const response = UrlFetchApp.fetch(url, { headers: { Authorization: 'Bearer ' + token } });
 const ext = format === 'pdf' ? 'pdf' : 'xlsx';
 const blob = response.getBlob().setName(`${filenameBase}_${jstTimestamp_()}.${ext}`);
 const file = DriveApp.getFolderById(EXPORT_FOLDER_ID).createFile(blob);
 DriveApp.getFileById(tempSs.getId()).setTrashed(true);
 return file.getUrl();
}

// 「初日結果」：G1〜G4を4シートにまとめたExcelを1冊作成する
function exportDay1Results() {
 const infoRows = readInfoRows_();
 const tempSs = SpreadsheetApp.create('初日結果');
 const defaultSheet = tempSs.getSheets()[0];
 GROUP_SHEETS.forEach((sheetName) => {
 const data = buildGroupResultData_(sheetName, infoRows);
 const sheet = tempSs.insertSheet(data.groupName || sheetName);
 writeGroupResultSheet_(sheet, data);
 });
 tempSs.deleteSheet(defaultSheet);
 return finalizeWorkbook_(tempSs, '初日結果', 'xlsx');
}

// 「２日目総当たり」：決勝側／2部側の2シートをまとめたExcelを1冊作成する
function exportDay2RoundRobin() {
 if (!isDay2Created_()) throw new Error('２日目がまだ作成されていません');
 const infoRows = readInfoRows_();
 const tempSs = SpreadsheetApp.create('２日目総当たり');
 const defaultSheet = tempSs.getSheets()[0];
 Object.keys(DAY2_SHEETS).forEach((sheetName) => {
 const data = buildDay2RRData_(sheetName, infoRows);
 const sheet = tempSs.insertSheet(sheetName);
 writeRRResultSheet_(sheet, data);
 });
 tempSs.deleteSheet(defaultSheet);
 return finalizeWorkbook_(tempSs, '２日目総当たり', 'xlsx');
}

// 「２日目トーナメント」：決勝側／2部側の2シートをまとめたExcelを1冊作成する
function exportDay2Tournament() {
 if (!isDay2Created_()) throw new Error('２日目がまだ作成されていません');
 const infoRows = readInfoRows_();
 const tempSs = SpreadsheetApp.create('２日目トーナメント');
 const defaultSheet = tempSs.getSheets()[0];
 Object.keys(DAY2_SHEETS).forEach((sheetName) => {
 const data = buildDay2TournamentData_(sheetName, infoRows);
 const sheet = tempSs.insertSheet(sheetName);
 writeTournamentResultSheet_(sheet, data);
 });
 tempSs.deleteSheet(defaultSheet);
 return finalizeWorkbook_(tempSs, '２日目トーナメント', 'xlsx');
}

// 「速報PDF」：day='day1' なら初日結果、day='day2' なら２日目総当たり＋トーナメントをまとめて1つのPDFにする
function exportBulletinPdf(day) {
 const infoRows = readInfoRows_();
 const tempSs = SpreadsheetApp.create('速報');
 const defaultSheet = tempSs.getSheets()[0];

 if (day === 'day1') {
 const groupDataList = GROUP_SHEETS.map((sheetName) => buildGroupResultData_(sheetName, infoRows));
 const sheet = tempSs.insertSheet('初日結果');
 writeDay1BulletinSheet_(sheet, groupDataList);
 } else if (day === 'day2') {
 if (!isDay2Created_()) throw new Error('２日目がまだ作成されていません');
 const venues = Object.keys(DAY2_SHEETS).map((sheetName) => ({
 rrData: buildDay2RRData_(sheetName, infoRows),
 tournamentData: buildDay2TournamentData_(sheetName, infoRows),
 }));
 const sheet = tempSs.insertSheet('２日目結果');
 writeDay2BulletinSheet_(sheet, venues);
 } else {
 DriveApp.getFileById(tempSs.getId()).setTrashed(true);
 throw new Error('不明な区分です: ' + day);
 }

 tempSs.deleteSheet(defaultSheet);
 return finalizeWorkbook_(tempSs, day === 'day1' ? '速報_1日目' : '速報_2日目', 'pdf');
}