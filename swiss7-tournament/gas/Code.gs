/**
 * スイス7風トーナメント運営アプリ（7チーム・2日間・複数大会対応）のGAS APIバックエンド。
 *
 * このスクリプトはスプレッドシートの「拡張機能→Apps Script」から作成する
 * コンテナバインド型スクリプトとして使う前提です。SpreadsheetApp.getActiveSpreadsheet()で
 * 自分自身のスプレッドシートを参照するため、SPREADSHEET_IDの設定は不要です。
 *
 * スプレッドシートには、あらかじめテンプレートシート「１日目」「２日目」
 * （B2:B8=チーム名、C12:C18・E12:E18=得点入力、K2:K8=順位、のレイアウト）が
 * 存在している必要があります。大会を1件作成するたびに、このテンプレート2枚を
 * 複製して「(大会名の頭文字2文字)＿１日目」「(大会名の頭文字2文字)２日目」を作ります。
 *
 * フロントエンド（GitHub Pagesで配信するswiss7-tournament/index.html等）とはJSON専用APIで
 * 通信します（doGet/doPostがaction名でリクエストを振り分ける。taikai-unei等と同じ方式）。
 */

const TEMPLATE_DAY1 = '１日目';
const TEMPLATE_DAY2 = '２日目';
const TEAM_RANGE = 'B2:B8';
const RANK_RANGE = 'K2:K8';
const LIGHT_SCORE_COL = 3; // C列
const DARK_SCORE_COL = 5; // E列
const FIRST_MATCH_ROW = 12;
const NUM_TEAMS = 7;
const NUM_MATCHES = 7;

function jsonResponse_(payload) {
  return ContentService
    .createTextOutput(JSON.stringify(payload))
    .setMimeType(ContentService.MimeType.JSON);
}
function ok_(data) { return jsonResponse_({ status: 'success', data: data }); }
function errRes_(message) { return jsonResponse_({ status: 'error', message: message }); }

function getSs() {
  return SpreadsheetApp.getActiveSpreadsheet();
}

function dayToSheetSuffix_(day) {
  if (day === 'day1') return '＿１日目';
  if (day === 'day2') return '２日目';
  throw new Error('dayはday1かday2を指定してください');
}

function sheetNameFor_(prefix, day) {
  return prefix + dayToSheetSuffix_(day);
}

function getSheetOrThrow_(sheetName) {
  const sheet = getSs().getSheetByName(sheetName);
  if (!sheet) throw new Error('シートが見つかりません: ' + sheetName);
  return sheet;
}

function doGet(e) {
  try {
    const action = e.parameter.action;
    if (action === 'listTournaments') return ok_(listTournaments());
    if (action === 'getTournament') return ok_(getTournament(e.parameter.prefix));
    return errRes_('不明なaction: ' + action);
  } catch (err) {
    return errRes_(err.message);
  }
}

function doPost(e) {
  try {
    const body = JSON.parse(e.postData.contents);
    const action = body.action;
    if (action === 'createTournament') return ok_(createTournament(body.name, body.prefix));
    if (action === 'setTeams') return ok_(setTeams(body.prefix, body.teams));
    if (action === 'submitScore') {
      return ok_(submitScore(body.prefix, body.day, body.matchIndex, body.lightScore, body.darkScore));
    }
    if (action === 'createDay2') return ok_(createDay2(body.prefix));
    if (action === 'exportPdf') return ok_(exportPdf(body.prefix, body.day));
    if (action === 'deleteTournament') return ok_(deleteTournament(body.prefix));
    return errRes_('不明なaction: ' + action);
  } catch (err) {
    return errRes_(err.message);
  }
}

/* ============ 大会一覧 ============ */

// テンプレート自体（'１日目'／'２日目'）は一覧に含めない。
// シート名が「(1〜PREFIX_MAX_LENGTH文字)＿１日目」の形式のものを大会として拾う。
function listTournaments() {
  const ss = getSs();
  const day1Re = new RegExp('^(.{1,' + PREFIX_MAX_LENGTH + '})＿１日目$');
  const list = [];
  ss.getSheets().forEach((sh) => {
    const name = sh.getName();
    if (name === TEMPLATE_DAY1 || name === TEMPLATE_DAY2) return;
    const m = name.match(day1Re);
    if (!m) return;
    const prefix = m[1];
    const day2Name = sheetNameFor_(prefix, 'day2');
    list.push({
      prefix: prefix,
      name: getTournamentName_(name) || prefix,
      day1Sheet: name,
      day2Sheet: day2Name,
      day2Exists: !!ss.getSheetByName(day2Name),
    });
  });
  return list;
}

/* ============ 大会名（略称=シート名の頭文字とは別に、大会のフルネームを保持） ============ */

// 大会名（フルネーム）は、シート名の頭文字（略称）だけでは表現しきれないため、
// day1シート名をキーにドキュメントプロパティへ保存する（taikai-uneiのday2VenueName_と同じ手法）。
function tournamentNameProp_(day1SheetName) {
  return 'TOURNAMENT_NAME::' + day1SheetName;
}
function getTournamentName_(day1SheetName) {
  return PropertiesService.getDocumentProperties().getProperty(tournamentNameProp_(day1SheetName)) || '';
}
function setTournamentName_(day1SheetName, name) {
  PropertiesService.getDocumentProperties().setProperty(tournamentNameProp_(day1SheetName), name || '');
}

/* ============ 大会作成 ============ */

const PREFIX_MAX_LENGTH = 4;

function createTournament(name, prefixInput) {
  const trimmedName = (name || '').trim();
  if (!trimmedName) throw new Error('大会名を入力してください');
  let prefix = (prefixInput || '').trim();
  if (!prefix) prefix = trimmedName.substring(0, 2);
  if (prefix.length > PREFIX_MAX_LENGTH) throw new Error('略称は' + PREFIX_MAX_LENGTH + '文字以内にしてください');

  const day1Name = sheetNameFor_(prefix, 'day1');
  const day2Name = sheetNameFor_(prefix, 'day2');
  const ss = getSs();
  if (ss.getSheetByName(day1Name) || ss.getSheetByName(day2Name)) {
    throw new Error('同じ略称（' + prefix + '）の大会が既に存在します。別の略称にしてください');
  }
  const tpl1 = ss.getSheetByName(TEMPLATE_DAY1);
  const tpl2 = ss.getSheetByName(TEMPLATE_DAY2);
  if (!tpl1 || !tpl2) throw new Error('テンプレートシート「' + TEMPLATE_DAY1 + '」「' + TEMPLATE_DAY2 + '」が見つかりません');

  const s1 = tpl1.copyTo(ss);
  s1.setName(day1Name);
  const s2 = tpl2.copyTo(ss);
  s2.setName(day2Name);

  // テンプレートに前回の入力が残っていても、新規大会は必ず空の状態から始める
  [s1, s2].forEach((sheet) => {
    sheet.getRange(TEAM_RANGE).clearContent();
    sheet.getRange(FIRST_MATCH_ROW, LIGHT_SCORE_COL, NUM_MATCHES, 1).clearContent();
    sheet.getRange(FIRST_MATCH_ROW, DARK_SCORE_COL, NUM_MATCHES, 1).clearContent();
  });

  setTournamentName_(day1Name, trimmedName);

  // 作成直後、フロントエンドが改めてgetTournamentを呼ばなくて済むよう、
  // 大会データ（空の状態）もこの応答に含める（往復回数の削減）。
  return { prefix: prefix, name: trimmedName, day1Sheet: day1Name, day2Sheet: day2Name, tournament: getTournament(prefix) };
}

/* ============ チーム登録 ============ */

function setTeams(prefix, teams) {
  if (!teams || teams.length !== NUM_TEAMS) throw new Error('チーム名は' + NUM_TEAMS + '件入力してください');
  const trimmed = teams.map((t) => (t || '').trim());
  if (trimmed.some((t) => !t)) throw new Error('すべてのチーム名を入力してください');
  if (new Set(trimmed).size !== NUM_TEAMS) throw new Error('チーム名が重複しています。すべて別の名前にしてください');

  const sheet = getSheetOrThrow_(sheetNameFor_(prefix, 'day1'));
  sheet.getRange(TEAM_RANGE).setValues(trimmed.map((t) => [t]));
  // 保存後にフロントエンドが別途getTournamentを呼ばなくて済むよう、更新後のデータを一緒に返す
  return { message: 'チームを登録しました', tournament: getTournament(prefix) };
}

/* ============ 対戦カード計算（共通） ============ */

// 循環対戦パターン: 試合i(0始まり)の淡=teams[2i mod 7], 濃=teams[(2i+1) mod 7]
// TO・審判1=teams[(2i+2) mod 7]（同一チーム）, 審判2=teams[(2i+3) mod 7]
// （引継ぎ書に記載のオフセット: 淡=0, 濃=1, TO・審判1=2, 審判2=3 をそのまま踏襲）
function buildMatches_(teams, lightScores, darkScores) {
  const matches = [];
  for (let i = 0; i < NUM_MATCHES; i++) {
    const li = (2 * i) % NUM_TEAMS;
    const di = (2 * i + 1) % NUM_TEAMS;
    const toi = (2 * i + 2) % NUM_TEAMS;
    const r2i = (2 * i + 3) % NUM_TEAMS;
    matches.push({
      index: i,
      light: teams[li] || '',
      dark: teams[di] || '',
      lightScore: lightScores[i],
      darkScore: darkScores[i],
      to: teams[toi] || '',
      referee1: teams[toi] || '',
      referee2: teams[r2i] || '',
    });
  }
  return matches;
}

function readDaySheet_(sheet) {
  // B2:K18相当（チーム名・得点・順位）を1回のgetValues()でまとめて読み込み、
  // 以降はメモリ上の配列から切り出す（getRange呼び出しを4回→1回に削減）。
  const bulk = sheet.getRange(2, 2, FIRST_MATCH_ROW - 2 + NUM_MATCHES, 10).getValues();
  const scoreOffset = FIRST_MATCH_ROW - 2;
  const teams = bulk.slice(0, NUM_TEAMS).map((r) => r[0]); // B2:B8
  const lightScores = bulk.slice(scoreOffset, scoreOffset + NUM_MATCHES).map((r) => r[1]); // C12:C18
  const darkScores = bulk.slice(scoreOffset, scoreOffset + NUM_MATCHES).map((r) => r[3]); // E12:E18
  const rank = bulk.slice(0, NUM_TEAMS).map((r) => r[9]); // K2:K8
  const teamsFilled = teams.every((t) => t !== '' && t !== null);
  const scoresComplete = lightScores.concat(darkScores).every((v) => v !== '' && v !== null);
  return {
    teams: teams,
    matches: teamsFilled ? buildMatches_(teams, lightScores, darkScores) : [],
    rank: rank,
    teamsFilled: teamsFilled,
    scoresComplete: scoresComplete,
  };
}

function getTournament(prefix) {
  if (!prefix) throw new Error('大会を指定してください');
  const ss = getSs();
  const day1Name = sheetNameFor_(prefix, 'day1');
  const day2Name = sheetNameFor_(prefix, 'day2');
  const s1 = getSheetOrThrow_(day1Name);
  const day1 = readDaySheet_(s1);

  const s2 = ss.getSheetByName(day2Name);
  const day2 = s2 ? readDaySheet_(s2) : null;

  return {
    prefix: prefix,
    name: getTournamentName_(day1Name) || prefix,
    day1Sheet: day1Name,
    day2Sheet: day2Name,
    day1: day1,
    day2: day2, // day2.teamsFilled === false は「まだ２日目作成前」を意味する
  };
}

/* ============ 得点入力 ============ */

function submitScore(prefix, day, matchIndex, lightScore, darkScore) {
  const idx = Number(matchIndex);
  if (isNaN(idx) || idx < 0 || idx >= NUM_MATCHES) throw new Error('試合番号が不正です');
  if (lightScore === '' || lightScore === undefined || lightScore === null ||
      darkScore === '' || darkScore === undefined || darkScore === null) {
    throw new Error('得点を両方入力してください');
  }
  const sheet = getSheetOrThrow_(sheetNameFor_(prefix, day));

  // C:E列（淡得点・区切り・濃得点）を1回のgetValues()でまとめて読み込む
  const numCols = DARK_SCORE_COL - LIGHT_SCORE_COL + 1;
  const existing = sheet.getRange(FIRST_MATCH_ROW, LIGHT_SCORE_COL, NUM_MATCHES, numCols).getValues();
  const isRecorded = (i) => {
    const v = existing[i];
    return v[0] !== '' && v[0] !== null && v[numCols - 1] !== '' && v[numCols - 1] !== null;
  };

  // 新規入力（まだ未記録の試合）は、それより前の試合がすべて記録済みでないと登録できない。
  // 既に記録済みの試合を修正する場合（再編集）は、この順序チェックの対象外。
  if (!isRecorded(idx)) {
    for (let i = 0; i < idx; i++) {
      if (!isRecorded(i)) throw new Error((i + 1) + '試合目がまだ未記入です。試合は順番に記録してください');
    }
  }

  const row = FIRST_MATCH_ROW + idx;
  const rowValues = existing[idx].slice(); // 区切り列（D列）は現在の値のまま書き戻す
  rowValues[0] = Number(lightScore);
  rowValues[numCols - 1] = Number(darkScore);
  sheet.getRange(row, LIGHT_SCORE_COL, 1, numCols).setValues([rowValues]);
  // 保存後にフロントエンドが別途getTournamentを呼ばなくて済むよう、更新後のデータを一緒に返す
  return { message: '記録しました', tournament: getTournament(prefix) };
}

/* ============ ２日目作成（１日目の結果から自動組み合わせ） ============ */

function createDay2(prefix) {
  const ss = getSs();
  const day1Name = sheetNameFor_(prefix, 'day1');
  const day2Name = sheetNameFor_(prefix, 'day2');
  const s1 = getSheetOrThrow_(day1Name);
  const s2 = getSheetOrThrow_(day2Name);

  // B2:B8（チーム名）とK2:K8（順位）をまとめて1回のgetValues()で読み込む
  const bulk = s1.getRange(2, 2, NUM_TEAMS, 10).getValues();
  const day1Teams = bulk.map((r) => r[0]);
  const rankedTeams = bulk.map((r) => r[9]);
  for (let x = 0; x < rankedTeams.length; x++) {
    if (!rankedTeams[x]) throw new Error('1日目の順位が未確定です。全試合の結果を入力してから実行してください');
  }

  const n = NUM_TEAMS;
  const day1Index = {};
  for (let i = 0; i < n; i++) day1Index[day1Teams[i]] = i;
  const rankOf = {};
  for (let i2 = 0; i2 < n; i2++) rankOf[rankedTeams[i2]] = i2 + 1;

  function isDay1Opponent(a, b) {
    const ia = day1Index[a], ib = day1Index[b];
    const d = Math.abs(ia - ib);
    return d === 1 || d === n - 1;
  }

  const rest = rankedTeams.slice(1);
  let best = null;
  let bestCost = Infinity;

  function permute(arr, l) {
    if (l === arr.length - 1) {
      const order = [rankedTeams[0]].concat(arr);
      let valid = true;
      let cost = 0;
      for (let k = 0; k < n; k++) {
        const a = order[k], b = order[(k + 1) % n];
        if (isDay1Opponent(a, b)) { valid = false; break; }
        cost += Math.abs(rankOf[a] - rankOf[b]);
      }
      if (valid && cost < bestCost) { bestCost = cost; best = order.slice(); }
      return;
    }
    for (let j = l; j < arr.length; j++) {
      const tmp = arr[l]; arr[l] = arr[j]; arr[j] = tmp;
      permute(arr, l + 1);
      const tmp2 = arr[l]; arr[l] = arr[j]; arr[j] = tmp2;
    }
  }
  permute(rest, 0);

  if (!best) throw new Error('制約を満たす組み合わせが見つかりませんでした');

  s2.getRange(TEAM_RANGE).setValues(best.map((t) => [t]));
  // 保存後にフロントエンドが別途getTournamentを呼ばなくて済むよう、更新後のデータを一緒に返す
  return { message: '2日目の対戦カードを作成しました', tournament: getTournament(prefix) };
}

/* ============ 大会削除（作成し直したい・テストデータの削除など） ============ */

function deleteTournament(prefix) {
  if (!prefix) throw new Error('大会を指定してください');
  const ss = getSs();
  const day1Name = sheetNameFor_(prefix, 'day1');
  const s1 = ss.getSheetByName(day1Name);
  const s2 = ss.getSheetByName(sheetNameFor_(prefix, 'day2'));
  if (!s1 && !s2) throw new Error('大会が見つかりません: ' + prefix);
  if (s1) ss.deleteSheet(s1);
  if (s2) ss.deleteSheet(s2);
  PropertiesService.getDocumentProperties().deleteProperty(tournamentNameProp_(day1Name));
  return '大会を削除しました';
}

/* ============ 速報PDF ============ */

const PDF_NUM_COLS = 8;
const PDF_HEADERS = ['試合', '淡チーム', '淡得点', '濃得点', '濃チーム', 'TO', '審判１', '審判２'];
const PDF_RANK_HEADERS = ['順位', 'チーム', '勝数', '得点', '失点', '得失点'];
const WIN_COLOR = '#ffd700'; // アプリ画面の勝利ハイライト（winCell）と同じ色

// 得点が両方入力済みの試合から、チームごとの勝数・得点・失点・得失点を集計する。
// 1試合も入力されていなければ空配列を返す（＝PDFの順位表を丸ごと省略する合図）。
// 順位は「勝数→得失点」の2項目が同じチームは同順位（引き分け扱い）とし、
// スプレッドシート側のK列にある行番号タイブレークは使わない。
function computePdfStandings_(teams, matches) {
  const anyRecorded = matches.some((m) =>
    m.lightScore !== '' && m.lightScore !== null && m.darkScore !== '' && m.darkScore !== null);
  if (!anyRecorded) return [];

  const stats = {};
  teams.forEach((t) => { stats[t] = { wins: 0, points: 0, allowed: 0 }; });
  matches.forEach((m) => {
    if (m.lightScore === '' || m.lightScore === null || m.darkScore === '' || m.darkScore === null) return;
    const ls = Number(m.lightScore), ds = Number(m.darkScore);
    if (stats[m.light]) { stats[m.light].points += ls; stats[m.light].allowed += ds; }
    if (stats[m.dark]) { stats[m.dark].points += ds; stats[m.dark].allowed += ls; }
    if (ls > ds) { if (stats[m.light]) stats[m.light].wins++; }
    else if (ds > ls) { if (stats[m.dark]) stats[m.dark].wins++; }
  });

  const list = teams.map((t) => {
    const s = stats[t];
    return { team: t, wins: s.wins, points: s.points, allowed: s.allowed, diff: s.points - s.allowed };
  });
  list.sort((a, b) => b.wins - a.wins || b.diff - a.diff);

  let rank = 0;
  list.forEach((s, i) => {
    if (i === 0 || s.wins !== list[i - 1].wins || s.diff !== list[i - 1].diff) rank = i + 1;
    s.rank = rank;
  });
  return list;
}

// 大会名・対戦結果(勝ったチームの色付き)・順位(勝数/得点/失点/得失点入り)・TO/審判まで
// 全てを1枚に大きく中央揃えでまとめた、印刷用の一時シートを作る。
// テンプレートのシートをそのまま書き出すのではなく、この専用レイアウトを都度組み立てて破棄する。
function buildPdfSheet_(prefix, day, tournamentName, dayData) {
  const ss = getSs();
  const tmp = ss.insertSheet('_pdf_tmp_' + Utilities.getUuid());
  const dayLabel = day === 'day1' ? '1日目' : '2日目';

  let row = 1;
  tmp.getRange(row, 1, 1, PDF_NUM_COLS).merge()
    .setValue(tournamentName + '　' + dayLabel)
    .setFontSize(26).setFontWeight('bold').setHorizontalAlignment('center').setVerticalAlignment('middle');
  tmp.setRowHeight(row, 56);
  row += 2;

  // 対戦表（ヘッダー＋各試合行）をまとめて1回のsetValues()で書き込み、
  // 罫線・フォント等の共通スタイルも表全体へ一括適用する。
  const matchHeaderRow = row;
  const matchTable = [PDF_HEADERS].concat(dayData.matches.map((m) => [
    m.index + 1, m.light,
    m.lightScore === '' || m.lightScore === null ? '' : m.lightScore,
    m.darkScore === '' || m.darkScore === null ? '' : m.darkScore,
    m.dark, m.to, m.referee1, m.referee2,
  ]));
  tmp.getRange(matchHeaderRow, 1, matchTable.length, PDF_NUM_COLS).setValues(matchTable)
    .setFontSize(16).setHorizontalAlignment('center').setVerticalAlignment('middle')
    .setBorder(true, true, true, true, true, true);
  tmp.getRange(matchHeaderRow, 1, 1, PDF_NUM_COLS)
    .setFontSize(14).setFontWeight('bold').setBackground('#e8e8e8');
  for (let i = 0; i < matchTable.length; i++) tmp.setRowHeight(matchHeaderRow + i, i === 0 ? 34 : 32);

  // 勝ったチーム側（チーム名・得点セル）を、アプリ画面と同じ色でハイライトする
  dayData.matches.forEach((m, i) => {
    if (m.lightScore === '' || m.lightScore === null || m.darkScore === '' || m.darkScore === null) return;
    const ls = Number(m.lightScore), ds = Number(m.darkScore);
    if (ls === ds) return;
    const r = matchHeaderRow + 1 + i;
    if (ls > ds) tmp.getRange(r, 2, 1, 2).setBackground(WIN_COLOR);
    else tmp.getRange(r, 4, 1, 2).setBackground(WIN_COLOR);
  });
  row = matchHeaderRow + matchTable.length + 1;

  // 順位表：1試合も結果が入っていない（大会開始前）状態では、丸ごと出力しない
  const standings = computePdfStandings_(dayData.teams, dayData.matches);
  if (standings.length) {
    tmp.getRange(row, 1, 1, PDF_NUM_COLS).merge()
      .setValue('順位').setFontSize(18).setFontWeight('bold').setHorizontalAlignment('center');
    tmp.setRowHeight(row, 34);
    row++;

    const rankHeaderRow = row;
    const rankTable = [PDF_RANK_HEADERS].concat(standings.map((s) =>
      [s.rank + '位', s.team, s.wins, s.points, s.allowed, s.diff]));
    tmp.getRange(rankHeaderRow, 1, rankTable.length, PDF_RANK_HEADERS.length).setValues(rankTable)
      .setFontSize(16).setHorizontalAlignment('center').setVerticalAlignment('middle')
      .setBorder(true, true, true, true, true, true);
    tmp.getRange(rankHeaderRow, 1, 1, PDF_RANK_HEADERS.length)
      .setFontSize(14).setFontWeight('bold').setBackground('#e8e8e8');
    for (let i = 0; i < rankTable.length; i++) tmp.setRowHeight(rankHeaderRow + i, i === 0 ? 34 : 32);
    row += rankTable.length;
  }

  tmp.setColumnWidths(1, PDF_NUM_COLS, 95);
  tmp.setHiddenGridlines(true);
  return tmp;
}

// Driveに保存せず、PDFのバイト列をそのままBase64でフロントエンドに返す方式。
// DriveApp（フォルダへのアクセス権限）が一切不要になるため、追加の権限承認は発生しない。
function exportPdf(prefix, day) {
  const sheetName = sheetNameFor_(prefix, day);
  const sheet = getSheetOrThrow_(sheetName);
  const dayData = readDaySheet_(sheet);
  const day1Name = sheetNameFor_(prefix, 'day1');
  const tournamentName = getTournamentName_(day1Name) || prefix;

  const ss = getSs();
  const tmp = buildPdfSheet_(prefix, day, tournamentName, dayData);
  SpreadsheetApp.flush();
  try {
    const token = ScriptApp.getOAuthToken();
    const url = 'https://docs.google.com/spreadsheets/d/' + ss.getId() + '/export' +
      '?format=pdf&gid=' + tmp.getSheetId() +
      '&size=A4&portrait=true&fitw=true&gridlines=false&printtitle=false&sheetnames=false&attachment=false' +
      '&top_margin=0.4&bottom_margin=0.4&left_margin=0.4&right_margin=0.4' +
      '&horizontal_alignment=CENTER&vertical_alignment=TOP';
    const response = UrlFetchApp.fetch(url, { headers: { Authorization: 'Bearer ' + token } });
    const blob = response.getBlob();
    return { fileName: sheetName + '.pdf', base64: Utilities.base64Encode(blob.getBytes()) };
  } finally {
    ss.deleteSheet(tmp);
  }
}
