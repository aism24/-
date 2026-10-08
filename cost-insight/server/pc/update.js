/*
 * 実行予算の取り込み PC側更新プログラム(実行予算更新.bat から実行)
 * 会社サーバーの「コストインサイト\参照資料（削除厳禁）」に置き、コストインサイトの
 * [実行予算を更新]ボタン(costinsight://)から誰でも実行できる。元は実行予算まとめ(jikko-yosan)の pc/update.js。
 *
 *  1. 会社サーバーの R8以降の年度フォルダを「読み取り専用」で読む
 *     - 使うのは readdir / stat / readFile(読み取り) だけ。書き込み・Excel起動は一切しない
 *     - 保存日時が前回と同じファイルは開かずに前回の値を使う
 *  2. コストインサイトの工事マスタの工事No・工事名一覧(GAS ?action=master。+設定.jsonの例外)で工事を決める
 *     工場加工費・事務図面費・現場費は労務/外注に仕訳し、粗利益・営業利益を計算し直してExcelの式と照合する
 *     労務の行の月度列(M列から右。例 2026.6 = 2026/6/20締め)から月度ごとの労務費と「労務費の締め」
 *     (労務費に金額がある最後の月度)を読む
 *  3. 出力\data.json に書き出し、送信先URL(複数可。移行期間は旧 実行予算まとめ と コストインサイト の2つ)へ送信する
 *  同時に2人が実行しないよう、出力\実行中.lock で順番を守る(30分より古い目印は前回の異常終了とみなして消す)
 *
 *  使い方: node update.js [--src <テスト用フォルダ>] [--no-send(送信しない)]
 */
'use strict';
const fs = require('fs');
const path = require('path');
const XLSX = require('xlsx');

const HERE = __dirname;
const OUT_DIR = path.join(HERE, '出力');
const DATA_FILE = path.join(OUT_DIR, 'data.json');
const LOG_FILE = path.join(OUT_DIR, '実行ログ.txt');
const LOCK_FILE = path.join(OUT_DIR, '実行中.lock');
const LOCK_STALE_MS = 30 * 60e3;
const CATS = ['材料費', '工場加工費', '事務図面費', '外注加工費', 'メッキ費', '運送費', '塗装費', '現場費', 'その他'];
const CATS_T = CATS.concat(['計']);
const PROFITS = ['粗利益', '営業利益'];
// 費目の中の労務/外注の仕訳: [費目, 労務の名前, それ以外の名前]
const SPLITS = [['工場加工費', '工場労務費', '工場外注費'], ['事務図面費', '事務図面労務費', '図面外注費'], ['現場費', '現場労務費', '現場費']];

const logs = [];
function log(m) { console.log(m); logs.push(m); }
// エラーは画面では赤の太字(ログファイルには色コードを入れない)
function logError(m) { console.log(process.stdout.isTTY ? `\x1b[1;31m${m}\x1b[0m` : m); logs.push(m); }

// ---------- サーバー側: 読み取り専用アクセスだけを持つ ----------
function readOnlySource(root) {
  return {
    root,
    list: rel => fs.readdirSync(path.join(root, ...rel), { withFileTypes: true }),
    stat: rel => fs.statSync(path.join(root, ...rel)),
    // 'r' で開いて一括でメモリへ読み、即閉じる
    read: rel => fs.readFileSync(path.join(root, ...rel), { flag: 'r' }),
  };
}

// ---------- 実行予算Excelの読み取り ----------
const SHEET_DATE = /^R?(\d+)\.(\d+)\.(\d+)$/;
function pickLatestSheet(names) {
  let best = null;
  names.forEach((n, i) => {
    const m = SHEET_DATE.exec(String(n).trim());
    if (!m) return;
    const k = [+m[1], +m[2], +m[3], i]; // 年・月・日、同日ならシート位置が右の方
    if (!best || cmpArr(k, best.k) > 0) best = { k, n };
  });
  return best && best.n;
}
function cmpArr(a, b) { for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return a[i] - b[i]; return 0; }
const num = x => (typeof x === 'number' ? x : 0);

function parseBudget(bytes) {
  const meta = XLSX.read(bytes, { type: 'buffer', bookSheets: true, bookProps: true });
  const sheet = pickLatestSheet(meta.SheetNames);
  if (!sheet) throw new Error('日付名のシートがありません');
  const author = (meta.Props && meta.Props.LastAuthor) || '';
  // 労務の判定に塗り色(cellStyles)・数式(cellFormula)・値のない塗りセル(sheetStubs)も読む
  const wb = XLSX.read(bytes, { type: 'buffer', sheets: [sheet], cellFormula: true, cellStyles: true, sheetStubs: true, cellHTML: false, cellText: false });
  const ws = wb.Sheets[sheet];
  const cell = (r, c) => ws[XLSX.utils.encode_cell({ r: r - 1, c: c - 1 })];
  // エラーセル(#DIV/0! 等)は t='e' でエラーコードの数値が入るため空欄扱いにする
  const v = (r, c) => { const x = cell(r, c); return x && x.t !== 'e' && x.v !== undefined && x.v !== '' ? x.v : null; };

  let h = 0;
  for (let r = 1; r <= 200; r++) if (v(r, 1) === '入力日') { h = r; break; }
  if (!h) throw new Error(`シート「${sheet}」に「入力日」見出しがありません`);
  let top = 0;
  for (let r = 3; r < h; r++) if (v(r, 3) === '計') { top = r; break; }
  if (!top) throw new Error(`シート「${sheet}」に契約の「計」行がありません`);

  const cats = {}, sec = {}; // sec[費目] = [明細の先頭行, 明細の最終行](小計行は区分の最下行)
  let secStart = h + 1, totalRow = 0;
  for (let r = h + 1; r <= h + 200; r++) {
    const b = v(r, 2), c = v(r, 3);
    const bn = typeof b === 'string' ? b.trim() : null;
    if (bn && CATS.includes(bn) && c === null && !cats[bn]) { cats[bn] = [num(v(r, 6)), num(v(r, 12))]; sec[bn] = [secStart, r - 1]; secStart = r + 1; }
    if (c === '計') { cats['計'] = [num(v(r, 6)), num(v(r, 12))]; totalRow = r; break; }
  }
  const miss = CATS_T.filter(k => !cats[k]);
  if (miss.length) throw new Error(`シート「${sheet}」で費目が見つかりません: ${miss.join('・')}`);
  const sb = CATS.reduce((s, k) => s + cats[k][0], 0), sa = CATS.reduce((s, k) => s + cats[k][1], 0);
  const warn = (Math.abs(sb - cats['計'][0]) >= 1 || Math.abs(sa - cats['計'][1]) >= 1) ? '費目の合計と「計」が一致しません' : '';
  // 粗利益・営業利益: 予算側は E列見出し → F=額・G=率、実際側は K列見出し → L=額・M=率
  const profit = {}, profitRate = {}, profitCell = {}; // profitCell[k] = [予算のセル, 実際のセル](数式の確認用)
  for (const k of PROFITS) { profit[k] = [null, null]; profitRate[k] = [null, null]; profitCell[k] = [null, null]; }
  for (let r = h + 1; r <= h + 250; r++) {
    for (const k of PROFITS) {
      if (v(r, 5) === k && profit[k][0] === null) { profit[k][0] = num(v(r, 6)); profitRate[k][0] = numOrNull(v(r, 7)); profitCell[k][0] = cell(r, 6); }
      if (v(r, 11) === k && profit[k][1] === null) { profit[k][1] = num(v(r, 12)); profitRate[k][1] = numOrNull(v(r, 13)); profitCell[k][1] = cell(r, 12); }
    }
  }
  const pmiss = PROFITS.flatMap(k => [profit[k][0] === null ? k + '(予算)' : null, profit[k][1] === null ? k + '(実際)' : null]).filter(Boolean);
  if (pmiss.length) throw new Error(`シート「${sheet}」で利益の行が見つかりません: ${pmiss.join('・')}`);

  const amount = v(top, 6);
  const labor = splitLabor({ v, cell, sec, cats, amount, profit, profitCell });
  const monthly = laborByMonth(ws, h, v, labor.laborRowsOf);
  const w = v(top, 4);
  return {
    sheet, author, c2: v(2, 3) === null ? '' : String(v(2, 3)).trim(),
    weight: typeof w === 'number' ? Math.round(w * 1000) / 1000 : w,
    amount, cats, profit, profitRate,
    breakdown: labor.breakdown, profitCalc: labor.profitCalc, profitCalcRate: labor.profitCalcRate, laborCheck: labor.checks,
    laborByMonth: monthly.byMonth, laborCutoff: monthly.cutoff,
    warn: [warn].concat(labor.checks.filter(c => c.level === 'warn').map(c => c.msg)).filter(Boolean).join(' / '),
  };
}
const numOrNull = x => (typeof x === 'number' && isFinite(x) ? x : null);

// ---------- 月度ごとの労務費と労務費の締め ----------
// 見出し行(「入力日」の行)の M列から右に月度(文字の「2024.4」…「2024.10」。数値だと 2024.10 と 2024.1 が
// 区別できないため表示文字で読む)が並ぶ。労務の行(splitLabor の判定)の金額を月度ごとに足す。
// 戻り値: { byMonth: { 工場労務費: { '2026.6': 円, … }, 事務図面労務費: {…}, 現場労務費: {…} }, cutoff: '2026.6' | '' }
const MONTH = /^(\d{4})\.(\d{1,2})$/;
function laborByMonth(ws, h, v, laborRowsOf) {
  const last = XLSX.utils.decode_range(ws['!ref']).e.c + 1;
  const months = []; // [列番号, '2026.6', 並べ替え用の数]
  for (let c = 13; c <= last; c++) {
    const x = ws[XLSX.utils.encode_cell({ r: h - 1, c: c - 1 })];
    const m = x && MONTH.exec(String(typeof x.v === 'string' ? x.v : (x.w || x.v)).trim());
    if (m) months.push([c, `${+m[1]}.${+m[2]}`, +m[1] * 12 + +m[2]]);
  }
  const byMonth = {};
  let cutoff = '', cutoffN = 0;
  for (const [name, rows] of Object.entries(laborRowsOf)) {
    const o = byMonth[name] = {};
    for (const [c, key, n] of months) {
      const s = rows.reduce((t, r) => t + num(v(r, c)), 0);
      if (!s) continue;
      o[key] = Math.round(s);
      if (n > cutoffN) { cutoffN = n; cutoff = key; }
    }
  }
  return { byMonth, cutoff };
}

// ---------- 労務/外注の仕訳と、Excelの粗利益・営業利益の式の確認 ----------
// 労務の行 = 工場加工費・事務図面費は C列が色塗りの行、現場費は項目名が「労務経費」の行。
// 粗利益 = 契約金額 − 計 + 労務、営業利益 = 粗利益 − 労務 をこのルールで計算し直す(正しい値として使う)。
// Excelの式(SUM範囲)・C列とL列の色・Excelの値と食い違えば checks に理由と差額を残す。
const isFilled = c => !!(c && c.s && c.s.patternType && c.s.patternType !== 'none' && !(c.s.fgColor && c.s.fgColor.theme === 0 && !c.s.fgColor.tint));
const yen = n => Math.round(n).toLocaleString('ja-JP');
function formulaRows(f) { // 式の SUM(...) の中で参照している行番号
  const rows = new Set();
  for (const m of String(f || '').matchAll(/SUM\(([^)]*)\)/gi)) {
    for (const part of m[1].split(',')) {
      const mm = /^\$?[A-Z]+\$?(\d+)(?::\$?[A-Z]+\$?(\d+))?$/i.exec(part.trim());
      if (mm) for (let r = +mm[1]; r <= +(mm[2] || mm[1]); r++) rows.add(r);
    }
  }
  return rows;
}
function splitLabor({ v, cell, sec, cats, amount, profit, profitCell }) {
  const checks = [];
  const add = (level, msg) => checks.push({ level, msg });
  const val = (r, side) => num(v(r, side === 0 ? 6 : 12)); // 予算=F列、実際=L列
  const rowName = r => { const c = v(r, 3); return c === null ? `${r}行目` : `${r}行目「${String(c).replace(/\s+/g, ' ').trim()}」`; };
  const laborRows = new Set(), inSec = new Set(), breakdown = {}, laborRowsOf = {};
  for (const [cat, laborName, otherName] of SPLITS) {
    const [s, e] = sec[cat];
    const lab = [], oth = [];
    for (let r = s; r <= e; r++) {
      inSec.add(r);
      const c = v(r, 3);
      // 工場加工費・事務図面費: C列かL列のどちらかに色があれば労務(色の塗り忘れで労務が0円になるのを防ぐ。26-16で発生)
      const isLabor = cat === '現場費'
        ? typeof c === 'string' && c.normalize('NFKC').replace(/\s/g, '') === '労務経費'
        : isFilled(cell(r, 3)) || isFilled(cell(r, 12));
      (isLabor ? lab : oth).push(r);
      if (isLabor) laborRows.add(r);
      // 工場加工費・事務図面費: 労務の行は L列(請求計)にも色がある。C列と食い違えば色の塗り忘れの疑い(労務として扱い、警告は残す)
      if (cat !== '現場費' && isFilled(cell(r, 3)) !== isFilled(cell(r, 12)) && (val(r, 0) || val(r, 1)))
        add('warn', `${cat}の${rowName(r)}: C列とL列の色が食い違っています(C列=${isFilled(cell(r, 3)) ? '色あり' : '色なし'}、L列=${isFilled(cell(r, 12)) ? '色あり' : '色なし'})。どちらかに色があれば労務として扱っています`);
    }
    const sum = (rows, side) => rows.reduce((t, r) => t + val(r, side), 0);
    breakdown[laborName] = [sum(lab, 0), sum(lab, 1)];
    laborRowsOf[laborName] = lab;
    breakdown[otherName] = [sum(oth, 0), sum(oth, 1)];
    for (const side of [0, 1]) {
      if (Math.abs(breakdown[laborName][side] + breakdown[otherName][side] - cats[cat][side]) >= 1)
        add('warn', `${cat}(${side ? '実際' : '予算'}): 明細の合計 ${yen(breakdown[laborName][side] + breakdown[otherName][side])} と小計 ${yen(cats[cat][side])} が一致しません`);
    }
  }
  const laborSum = side => [...laborRows].reduce((t, r) => t + val(r, side), 0);
  const profitCalc = { 粗利益: [null, null], 営業利益: [null, null] }, profitCalcRate = { 粗利益: [null, null], 営業利益: [null, null] };
  for (const side of [0, 1]) {
    const lab = laborSum(side);
    const gp = num(amount) - cats['計'][side] + lab, op = gp - lab;
    profitCalc['粗利益'][side] = gp; profitCalc['営業利益'][side] = op;
    if (typeof amount === 'number' && amount !== 0) { profitCalcRate['粗利益'][side] = gp / amount; profitCalcRate['営業利益'][side] = op / amount; }
  }
  for (const k of PROFITS) {
    for (const side of [0, 1]) {
      const label = `${k}(${side ? '実際' : '予算'})`;
      const c = profitCell[k][side];
      // 式の労務の行とルールの労務の行を比べる(費目の明細の範囲内だけ)
      if (c && c.f) {
        const fr = new Set([...formulaRows(c.f)].filter(r => inSec.has(r)));
        const miss = [...laborRows].filter(r => !fr.has(r)), extra = [...fr].filter(r => !laborRows.has(r));
        const effect = miss.reduce((t, r) => t + val(r, side), 0) - extra.reduce((t, r) => t + val(r, side), 0);
        if (miss.length || extra.length) {
          const what = [miss.length ? `労務の ${miss.map(rowName).join('・')} が式に含まれていません` : '',
            extra.length ? `労務でない ${extra.map(rowName).join('・')} が式に含まれています` : ''].filter(Boolean).join('、');
          add(Math.abs(effect) >= 1 ? 'warn' : 'info', `${label}の式: ${what}(金額への影響 ${effect >= 0 ? '+' : ''}${yen(effect)})`);
        }
      } else add('info', `${label}: 数式ではなく値が入力されています`);
      // 値の検算(式の範囲のずれ・手入力の上書きのどちらでも気付ける)
      const diff = profitCalc[k][side] - profit[k][side];
      if (Math.abs(diff) >= 1) add('warn', `${label}: Excelの値 ${yen(profit[k][side])} ≠ 正しい計算 ${yen(profitCalc[k][side])}(差 ${diff >= 0 ? '+' : ''}${yen(diff)})`);
    }
  }
  return { breakdown, profitCalc, profitCalcRate, checks, laborRowsOf };
}

// ---------- 工事の対応付け ----------
const norm = s => String(s || '').normalize('NFKC').toLowerCase().replace(/[\s　]/g, '').replace(/データセンター/g, 'dc');
function nameFromFile(fileName) {
  return fileName.replace(/\.(xlsx|xlsm)$/i, '').replace(FILE_NO, '').replace(/\s*実行予算\s*(-\s*コピー)?\s*$/, '').trim();
}
// コストインサイトの工事マスタ(A 工事No・B 工事名)を GAS の ?action=master で読む(契約金額などは返らない)
async function loadMaster(cfg) {
  let body;
  try { body = await fetchJson(cfg['工事一覧URL'], RETRY); } catch (e) { throw new Error(`工事の一覧を読めません(${e.message})`); }
  if (body.status !== 'success') throw new Error(`工事の一覧を読めません: ${body.message || ''}`);
  const list = [];
  for (const r of (body.data && body.data.works) || []) {
    const no = String(r.no || '').trim(), name = String(r.name || '').trim();
    if (/^\d{2}-\d{2}[A-Za-z]?$/.test(no)) list.push({ no, name });
  }
  if (!list.length) throw new Error('工事マスタに工事Noがありません');
  return list;
}
function matchMaster(master, cfg, fileName, fileNo, c2) {
  const base = fileName.replace(/\.(xlsx|xlsm)$/i, '').replace(/\s*実行予算\s*$/, '');
  for (const [pre, no] of Object.entries(cfg['ファイル名の例外'] || {})) {
    if (norm(base).startsWith(norm(pre))) { const m = master.find(x => x.no === no); return { no, name: m ? m.name : '', by: '例外表' }; }
  }
  const cands = [norm(nameFromFile(fileName)), norm(c2)].filter(Boolean);
  const hit = master.filter(x => x.name && cands.includes(norm(x.name)));
  if (hit.length === 1) return { no: hit[0].no, name: hit[0].name, by: '工事名' };
  const byNo = master.filter(x => x.no === fileNo);
  if (byNo.length === 1) return { no: byNo[0].no, name: byNo[0].name, by: '工事No' };
  return { no: fileNo, name: nameFromFile(fileName), by: '一覧に未登録' };
}

// ---------- 日時 ----------
// 工事No: 24-12A のような英字1文字の枝番は、次が英字でない場合のみ(25-13JCR… は 25-13)
const FILE_NO = /^(\d{2}-\d{2}(?:[A-Za-z](?![A-Za-z]))?)/;
const pad = n => String(n).padStart(2, '0');
function jst(ms) { const d = new Date(ms + 9 * 3600e3); return `${d.getUTCFullYear()}-${pad(d.getUTCMonth() + 1)}-${pad(d.getUTCDate())}T${pad(d.getUTCHours())}:${pad(d.getUTCMinutes())}:${pad(d.getUTCSeconds())}+09:00`; }

// ---------- 送信 ----------
// GASの応答は「送信先 → 302 → script.googleusercontent.com の応答ページ」の2段階。
// 2段目が Google 側でときどき 404 になる(受信・保存は済んでいる)ため、
// 応答ページの取得をやり直し、それでもだめならアプリのデータ(doGet)で今回の保存を確かめる。
// データの送り直しはしない(二重書き込みを避ける)。
const RETRY = 3, RETRY_WAIT_MS = 3000;
const sleep = ms => new Promise(r => setTimeout(r, ms));
async function fetchJson(url, tries) { // 応答が JSON で返るまでやり直す。返せなければ最後の失敗理由を投げる
  let why = '';
  for (let i = 0; i < tries; i++) {
    if (i) await sleep(RETRY_WAIT_MS);
    try {
      const res = await fetch(url);
      const text = await res.text();
      if (res.ok && text.trim().startsWith('{')) return JSON.parse(text);
      why = `HTTP ${res.status}: ${text.slice(0, 120)}`;
    } catch (e) { why = e.message; }
  }
  throw new Error(why);
}
async function send(url, body, rowCount) {
  const sentAt = Date.now();
  const res = await fetch(url, { method: 'POST', headers: { 'Content-Type': 'text/plain;charset=utf-8' }, body: JSON.stringify(body), redirect: 'manual' });
  const loc = res.headers.get('location');
  let reply, why = '';
  if (res.status >= 300 && res.status < 400 && loc) {
    try { reply = await fetchJson(loc, RETRY); } catch (e) { why = e.message; }
  } else {
    const text = await res.text();
    if (res.ok && text.trim().startsWith('{')) reply = JSON.parse(text);
    else if (res.status >= 400) throw new Error(`送信に失敗しました(HTTP ${res.status}): ${text.slice(0, 200)}`);
    else why = `HTTP ${res.status}: ${text.slice(0, 120)}`;
  }
  if (reply) {
    if (reply.status && reply.status !== 'success') throw new Error(`送信に失敗しました(アプリの応答): ${JSON.stringify(reply).slice(0, 200)}`);
    return `送信: 完了 ${JSON.stringify(reply).slice(0, 200)}`;
  }
  // 応答を受け取れなかった → アプリのデータで今回の保存を確認する
  let saved;
  try { saved = await fetchJson(url + (url.includes('?') ? '&' : '?') + 'action=budget', RETRY); } catch (e) {
    throw new Error(`送信の応答を受け取れず(${why})、保存の確認もできませんでした(${e.message})。アプリで最終更新の時刻を確認してください`);
  }
  const today = saved && saved.data && saved.data.today;
  const rows = today ? (Array.isArray(today.rows) ? today.rows : Object.values(today.rows || {})) : [];
  const at = today && Date.parse(today.at);
  if (at >= sentAt - 60e3 && rows.length === rowCount)
    return `送信: 完了(応答の受け取りに失敗しましたが、アプリ側で保存を確認しました。保存時刻 ${today.at}・${rows.length}件)`;
  throw new Error(`送信の応答を受け取れず(${why})、アプリにも今回の保存が見当たりません(アプリの最終保存 ${today ? today.at : '不明'}・${rows.length}件)`);
}

// ---------- メイン ----------
async function main() {
  const t0 = Date.now();
  const cfg = JSON.parse(fs.readFileSync(path.join(HERE, '設定.json'), 'utf8'));
  const ai = process.argv.indexOf('--src');
  const srcRoot = ai > 0 ? process.argv[ai + 1] : cfg['サーバーフォルダ'];
  if (path.resolve(OUT_DIR).toLowerCase().startsWith(path.resolve(srcRoot).toLowerCase())) throw new Error('出力先がサーバーフォルダの中になっています(中止)');
  fs.mkdirSync(OUT_DIR, { recursive: true });
  takeLock();

  log(`=== 実行予算更新 ${jst(t0)} ===`);
  log(`読み取り元(読み取り専用): ${srcRoot}`);
  const src = readOnlySource(srcRoot);
  const master = await loadMaster(cfg);
  log(`工事一覧: ${master.length} 件(コストインサイトの工事マスタ)`);

  const prev = fs.existsSync(DATA_FILE) ? JSON.parse(fs.readFileSync(DATA_FILE, 'utf8')) : { rows: [] };
  const prevByKey = new Map(prev.rows.map(r => [r.key, r]));

  // 年度フォルダ(R8以降)と対象ファイル(同名は更新日時が新しい方)
  const years = src.list([]).filter(d => d.isDirectory() && /^R(\d+)$/.test(d.name) && +d.name.slice(1) >= cfg['対象年度の下限'])
    .map(d => d.name).sort((a, b) => a.slice(1) - b.slice(1));
  log(`対象の年度フォルダ: ${years.join(', ')}`);
  const files = new Map();
  for (const y of years) {
    const ents = src.list([y]);
    const locks = new Set(ents.filter(e => e.isFile() && e.name.startsWith('~$')).map(e => e.name));
    for (const e of ents) {
      if (!e.isFile() || e.name.startsWith('~$') || !/^\d{2}-\d{2}/.test(e.name) || !/\.(xlsx|xlsm)$/i.test(e.name)) continue;
      const mtimeMs = Math.floor(src.stat([y, e.name]).mtimeMs / 1000) * 1000;
      const item = { folder: y, name: e.name, mtimeMs, locked: locks.has('~$' + e.name) || locks.has('~$' + e.name.slice(2)) };
      const cur = files.get(e.name);
      if (cur) log(`同名ファイル: ${e.name} → ${item.mtimeMs > cur.mtimeMs ? y : cur.folder} を採用(更新日時が新しい方)`);
      if (!cur || item.mtimeMs > cur.mtimeMs) files.set(e.name, item);
    }
  }
  log(`対象ファイル: ${files.size} 件`);

  const rows = [];
  let nRead = 0, nSkip = 0, nErr = 0;
  for (const f of files.values()) {
    const fileNo = FILE_NO.exec(f.name)[1];
    const p = prevByKey.get(f.name);
    let b;
    if (p && p.status === 'ok' && p.mtimeMs === f.mtimeMs && p.profit && p.breakdown && p.laborByMonth) { // 利益項目・労務の仕訳・月度の労務費が無い旧データは読み直す
      b = p; nSkip++;
    } else {
      try {
        b = parseBudget(src.read([f.folder, f.name]));
        nRead++;
        log(`読込: ${f.folder}\\${f.name}(シート ${b.sheet})`);
        for (const c of b.laborCheck) log(`  ${c.level === 'warn' ? '※警告' : '参考'}: ${c.msg}`);
      } catch (e) {
        nErr++;
        logError(`読み取りエラー:${f.folder}\\${f.name} … ${e.message}`);
        rows.push({ key: f.name, folder: f.folder, fileNo, ...matchMaster(master, cfg, f.name, fileNo, ''), status: 'error', error: e.message, mtimeMs: f.mtimeMs, saved: jst(f.mtimeMs), locked: f.locked });
        continue;
      }
    }
    const m = matchMaster(master, cfg, f.name, fileNo, b.c2);
    rows.push({
      key: f.name, folder: f.folder, fileNo, no: m.no, name: m.name, matchedBy: m.by, c2: b.c2,
      sheet: b.sheet, weight: b.weight, amount: b.amount, cats: b.cats, profit: b.profit, profitRate: b.profitRate,
      breakdown: b.breakdown, profitCalc: b.profitCalc, profitCalcRate: b.profitCalcRate, laborCheck: b.laborCheck, author: b.author,
      laborByMonth: b.laborByMonth, laborCutoff: b.laborCutoff,
      saved: jst(f.mtimeMs), mtimeMs: f.mtimeMs, locked: f.locked, status: 'ok', warn: b.warn || '',
    });
  }
  rows.sort((a, b) => (a.no < b.no ? -1 : a.no > b.no ? 1 : a.key.localeCompare(b.key)));

  const data = { generatedAt: jst(Date.now()), source: 'R' + cfg['対象年度の下限'] + '以降', count: rows.length, rows };
  fs.writeFileSync(DATA_FILE, JSON.stringify(data, null, 1), 'utf8');
  log(`読み込み ${nRead} 件 / 変更なしで省略 ${nSkip} 件 / エラー ${nErr} 件`);
  for (const r of rows) log(`  ${r.no} ${r.name} ← ${r.folder}\\${r.key}【${r.matchedBy || ''}】${r.locked ? '(編集中)' : ''}${r.status === 'error' ? ' エラー' : ''}`);
  log(`書き出し: ${DATA_FILE}`);

  const targets = [].concat(cfg['送信先URL'] || []).filter(Boolean);
  if (targets.length && !process.argv.includes('--no-send')) {
    // 1か所が失敗しても残りには送る。失敗があれば最後にエラーにする
    const failed = [];
    for (const url of targets) {
      const label = `送信先${targets.length > 1 ? targets.indexOf(url) + 1 : ''}`;
      try { log(`${label} ${await send(url, { secret: cfg['秘密キー'], data }, data.rows.length)}`); } catch (e) { logError(`${label} ${e.message}`); failed.push(label); }
    }
    if (failed.length) throw new Error(`${failed.join('・')}への送信に失敗しました`);
  } else log(process.argv.includes('--no-send') ? '送信: --no-send 指定のため送信していません' : '送信: 送信先URLが未設定のため送信していません(data.json の作成のみ)');
  log(`所要時間 ${((Date.now() - t0) / 1000).toFixed(1)} 秒`);
}

// 実行中の目印(出力\実行中.lock)。他の人が実行中なら中止する。30分より古い目印は異常終了の残りとみなして消す
let lockTaken = false;
function takeLock() {
  try {
    const st = fs.statSync(LOCK_FILE);
    if (Date.now() - st.mtimeMs < LOCK_STALE_MS) {
      let who = '';
      try { who = fs.readFileSync(LOCK_FILE, 'utf8').trim(); } catch (e) { /* 読めなくてもよい */ }
      throw new Error(`他の人が更新中です(${who})。終わってから(数分後に)もう一度実行してください`);
    }
    fs.unlinkSync(LOCK_FILE);
  } catch (e) { if (e.code !== 'ENOENT') throw e; }
  try { fs.writeFileSync(LOCK_FILE, `${process.env.COMPUTERNAME || ''} ${process.env.USERNAME || ''} ${jst(Date.now())}開始`, { flag: 'wx' }); } catch (e) {
    if (e.code === 'EEXIST') throw new Error('他の人が更新を始めたところです。数分後にもう一度実行してください');
    throw e;
  }
  lockTaken = true;
}

main().catch(e => { logError('エラー: ' + e.message); process.exitCode = 1; })
  .finally(() => {
    if (lockTaken) try { fs.unlinkSync(LOCK_FILE); } catch (e) { /* 消せなくても30分後に自動で無効になる */ }
    try { fs.mkdirSync(OUT_DIR, { recursive: true }); fs.appendFileSync(LOG_FILE, logs.join('\r\n') + '\r\n\r\n', 'utf8'); } catch (e) { /* ログ保存失敗は無視 */ }
  });
