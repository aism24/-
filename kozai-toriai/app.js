// デプロイ済みGAS WebアプリのURL(/exec で終わるURL)。デプロイ後にここへ差し替えてください。
const GAS_API_URL = "https://script.google.com/macros/s/REPLACE_WITH_DEPLOYED_URL/exec";

// ---------- GAS API共通 ----------
// (URL未設定・GAS側の不調時もアプリ本来の計算・Excel出力は止めない。
//  呼び出し側は必ずcatchし、失敗してもユーザー作業は継続させること)

async function apiGet(action, params) {
  const url = new URL(GAS_API_URL);
  url.searchParams.set('action', action);
  if (params) Object.keys(params).forEach(k => { if (params[k] !== undefined && params[k] !== null) url.searchParams.set(k, params[k]); });
  const res = await fetch(url.toString(), { method: 'GET' });
  if (!res.ok) throw new Error('サーバーエラー(HTTP ' + res.status + ')');
  const json = await res.json();
  if (json.status !== 'success') throw new Error(json.message || '取得に失敗しました');
  return json.data;
}

// Content-Type: text/plain でCORSプリフライト(OPTIONS)を回避する(GASはOPTIONS未対応のため)
async function apiPost(action, payload) {
  const res = await fetch(GAS_API_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'text/plain;charset=utf-8' },
    body: JSON.stringify(Object.assign({ action: action }, payload)),
  });
  if (!res.ok) throw new Error('サーバーエラー(HTTP ' + res.status + ')');
  const json = await res.json();
  if (json.status !== 'success') throw new Error(json.message || '処理に失敗しました');
  return json.data;
}

/* =========================================================
   定数(現行VBAの定数定義を踏襲)
   ========================================================= */
var DATA_START_ROW = 4;
var DATA_END_ROW = 200;
var STOCK_INV_START = 12;
var STOCK_INV_END = 16;
var STOCK_PUR_START = 4;
var STOCK_PUR_END = 9;

var RESULT_COLS = ['P','Q','R','S','T','U','V','W','X','Y','Z','AA','AB','AC','AD','AE','AF','AG','AH'];
var TRIPLE_COLS = [['T','U','V'],['W','X','Y'],['Z','AA','AB'],['AC','AD','AE'],['AF','AG','AH']];
var MEDIUM_AFTER = {S:1, V:1, Y:1, AB:1, AE:1};
var HAIRLINE_AFTER = {T:1,U:1,W:1,X:1,Z:1,AA:1,AC:1,AD:1,AF:1,AG:1};

/* =========================================================
   ユーティリティ
   ========================================================= */
function trim(s){ return (s === null || s === undefined) ? '' : String(s).trim(); }
function toNum(v){
  if (v === null || v === undefined || v === '') return 0;
  if (typeof v === 'object' && v.result !== undefined) v = v.result; // 数式セル対応
  var n = parseFloat(v);
  return isNaN(n) ? 0 : n;
}
function cellText(v){
  if (v === null || v === undefined) return '';
  if (typeof v === 'object' && v.result !== undefined) return String(v.result);
  return String(v);
}

// VBAのRound()は銀行丸め(round half to even)。端数境界での挙動を一致させる。
function bankersRound(value, decimals){
  var factor = Math.pow(10, decimals);
  var x = value * factor;
  var f = Math.floor(x);
  var diff = x - f;
  var eps = 1e-9;
  var rounded;
  if (diff > 0.5 + eps) rounded = f + 1;
  else if (diff < 0.5 - eps) rounded = f;
  else rounded = (f % 2 === 0) ? f : f + 1;
  return rounded / factor;
}

function getPrioNum(raw){
  var s = trim(raw);
  if (s === '') return 999999;
  var n = Number(s);
  if (!isNaN(n)) return n;
  return 999998;
}

function showMessage(text, kind){
  var el = document.getElementById('msgArea');
  el.textContent = text;
  el.className = kind || '';
}

/* =========================================================
   グローバル状態
   ========================================================= */
var state = {
  cutMargin: 0, gripMargin: 0, minRem: 0,
  purchaseStocks: [], // {row, len, limit, usedDisplay}
  inventoryStocks: [], // {row, len, limit, usedDisplay}
  products: [], // {row, mark, size, process, priorityRaw, group, length, qty}
  sizeList: [],
  lastResult: null, // {outputRows, blocks, pageBreakBeforeIdxs, targetSize}
  // 実績記録用(Excelテンプレート側で記入、インポート時に読み込むのみ。Webアプリ内での編集は行わない)
  workName: '', workNo: '', workerName: '', usagePurpose: ''
};

/* =========================================================
   ① テンプレート生成
   ========================================================= */
function estimateColWidth(text, minWidth){
  var width = 0;
  for (var i=0; i<text.length; i++){
    var code = text.charCodeAt(i);
    width += (code > 255) ? 2.2 : 1.1;
  }
  return Math.max(minWidth || 0, width + 2);
}

var INPUT_FILL = { type:'pattern', pattern:'solid', fgColor:{argb:'FFFFF2AE'} };

function styleHeaderCell(cell, text){
  cell.value = text;
  cell.font = { bold: true };
  cell.border = {
    top:{style:'thin'}, left:{style:'thin'}, right:{style:'thin'}, bottom:{style:'thin'}
  };
  cell.fill = { type:'pattern', pattern:'solid', fgColor:{argb:'FFEFEFEF'} };
}

function styleInputCell(cell){
  cell.fill = INPUT_FILL;
  cell.border = { top:{style:'hair'}, left:{style:'hair'}, right:{style:'hair'}, bottom:{style:'hair'} };
}

// 工事番号・工事名・氏名マスタをGASから取得する。取得できなくても
// テンプレート作成自体は止めず、その場合は工事名・担当者とも自由入力にフォールバックする。
async function fetchMasterInfo(){
  try {
    var data = await apiGet('getMasterInfo');
    return {
      projects: Array.isArray(data && data.projects) ? data.projects : [], // [{no, name}]
      names: Array.isArray(data && data.names) ? data.names : []
    };
  } catch (err){
    console.warn('マスタ情報の取得に失敗しました(工事名・担当者は自由入力になります): ' + err.message);
    return { projects: [], names: [] };
  }
}

async function buildTemplateWorkbook(){
  var master = await fetchMasterInfo();

  var wb = new ExcelJS.Workbook();
  var ws = wb.addWorksheet('入力シート');

  var headerA = '製品マーク', headerB = 'サイズ', headerC = '工程',
      headerD = '優先度(数値小=先／空欄可)', headerE = 'グループ(空欄可)',
      headerF = '長さ(mm)', headerG = '数量';
  var headerK3 = '新品購入尺', headerK11 = '在庫材', headerK18 = '基本情報';
  var labelK19 = '切断代(mm)', labelK20 = 'つかみ代(mm)', labelK21 = '最小端材長(mm)';
  var labelK22 = '工事名', labelK23 = '工事番号', labelK24 = '担当者', labelK25 = '使用用途';
  var headerL = '長さ(mm)', headerM = '上限本数(0=無制限)';

  ws.getColumn(1).width = estimateColWidth(headerA);
  ws.getColumn(2).width = estimateColWidth(headerB, 8);
  ws.getColumn(3).width = estimateColWidth(headerC, 8);
  ws.getColumn(4).width = estimateColWidth(headerD);
  ws.getColumn(5).width = estimateColWidth(headerE);
  ws.getColumn(6).width = estimateColWidth(headerF, 8);
  ws.getColumn(7).width = estimateColWidth(headerG, 6);
  ws.getColumn(8).width = 3;  // H (spacer)
  ws.getColumn(9).width = 3;  // I (spacer)
  ws.getColumn(10).width = 3; // J (spacer)
  ws.getColumn(11).width = Math.max(
    estimateColWidth(headerK3), estimateColWidth(headerK11), estimateColWidth(headerK18),
    estimateColWidth(labelK19), estimateColWidth(labelK20), estimateColWidth(labelK21),
    estimateColWidth(labelK22), estimateColWidth(labelK23), estimateColWidth(labelK24), estimateColWidth(labelK25)
  );
  ws.getColumn(12).width = estimateColWidth(headerL, 8);
  ws.getColumn(13).width = estimateColWidth(headerM);

  // 製品データ表ヘッダー(row3, A:G)
  styleHeaderCell(ws.getCell('A3'), headerA);
  styleHeaderCell(ws.getCell('B3'), headerB);
  styleHeaderCell(ws.getCell('C3'), headerC);
  styleHeaderCell(ws.getCell('D3'), headerD);
  styleHeaderCell(ws.getCell('E3'), headerE);
  styleHeaderCell(ws.getCell('F3'), headerF);
  styleHeaderCell(ws.getCell('G3'), headerG);

  // 新品購入尺リスト(row3 header, row4-9 入力)
  styleHeaderCell(ws.getCell('K3'), headerK3);
  styleHeaderCell(ws.getCell('L3'), headerL);
  styleHeaderCell(ws.getCell('M3'), headerM);

  // 在庫材リスト(row11 header, row12-16 入力)
  styleHeaderCell(ws.getCell('K11'), headerK11);
  styleHeaderCell(ws.getCell('L11'), headerL);
  styleHeaderCell(ws.getCell('M11'), headerM);

  // 基本情報(row18 header, row19-21 入力)
  styleHeaderCell(ws.getCell('K18'), headerK18);
  ws.getCell('K19').value = labelK19;
  ws.getCell('K20').value = labelK20;
  ws.getCell('K21').value = labelK21;

  // 基本情報デフォルト値
  ws.getCell('L19').value = 0;
  ws.getCell('L20').value = 150;
  ws.getCell('L21').value = 500;

  // 実績記録用メタ情報(row22-25): 工事名・工事番号・担当者・使用用途
  ws.getCell('K22').value = labelK22;
  ws.getCell('K23').value = labelK23;
  ws.getCell('K24').value = labelK24;
  ws.getCell('K25').value = labelK25;

  // 入力セルの色塗り+罫線
  for (var r = DATA_START_ROW; r <= DATA_END_ROW; r++){
    ['A','B','C','D','E','F','G'].forEach(function(col){ styleInputCell(ws.getCell(col+r)); });
  }
  for (var r2 = STOCK_PUR_START; r2 <= STOCK_PUR_END; r2++){
    ['L','M'].forEach(function(col){ styleInputCell(ws.getCell(col+r2)); });
  }
  for (var r3 = STOCK_INV_START; r3 <= STOCK_INV_END; r3++){
    ['L','M'].forEach(function(col){ styleInputCell(ws.getCell(col+r3)); });
  }
  ['L19','L20','L21','L22','L23','L24','L25'].forEach(function(addr){ styleInputCell(ws.getCell(addr)); });

  // 工事名(ドロップダウン)→工事番号(VLOOKUP自動表示)、担当者(候補付き自由入力)の設定。
  // マスタが1件も取得できなかった場合は、入力規則を付けず単純な自由入力欄のままにする
  // (通信不良等でテンプレート作成自体を止めないため)。
  if (master.projects.length > 0 || master.names.length > 0){
    var lookupWs = wb.addWorksheet('マスタ', { state: 'hidden' });
    master.projects.forEach(function(p, i){
      lookupWs.getCell(i+1, 1).value = p.name; // A列: 工事名
      lookupWs.getCell(i+1, 2).value = p.no;   // B列: 工事番号
    });
    master.names.forEach(function(n, i){
      lookupWs.getCell(i+1, 3).value = n; // C列: 氏名
    });

    if (master.projects.length > 0){
      var lastProjRow = master.projects.length;
      ws.getCell('L22').dataValidation = {
        type: 'list',
        allowBlank: true,
        showErrorMessage: true,
        errorStyle: 'information',
        errorTitle: '工事名候補',
        error: '候補にない工事名です。新規の工事の場合はそのまま入力してください。',
        formulae: ["'マスタ'!$A$1:$A$" + lastProjRow]
      };
      ws.getCell('L23').value = { formula: "IFERROR(VLOOKUP($L$22,'マスタ'!$A$1:$B$" + lastProjRow + ",2,FALSE),\"\")" };
    }
    if (master.names.length > 0){
      var lastNameRow = master.names.length;
      ws.getCell('L24').dataValidation = {
        type: 'list',
        allowBlank: true,
        showErrorMessage: true,
        errorStyle: 'information',
        errorTitle: '氏名候補',
        error: '候補にない氏名です。新規登録の場合はそのまま入力してください。',
        formulae: ["'マスタ'!$C$1:$C$" + lastNameRow]
      };
    }
  }

  return wb;
}

function downloadWorkbookAsXlsx(wb, filename){
  return wb.xlsx.writeBuffer().then(function(buffer){
    var blob = new Blob([buffer], { type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' });
    var url = URL.createObjectURL(blob);
    var a = document.createElement('a');
    a.href = url;
    a.download = filename;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    setTimeout(function(){ URL.revokeObjectURL(url); }, 4000);
  });
}

/* =========================================================
   ② インポート
   ========================================================= */
async function importFile(file){
  var buffer = await file.arrayBuffer();
  var wb = new ExcelJS.Workbook();
  await wb.xlsx.load(buffer);
  var ws = wb.worksheets[0];
  if (!ws) throw new Error('シートが見つかりませんでした。');

  state.cutMargin = toNum(ws.getCell('L19').value);
  state.gripMargin = toNum(ws.getCell('L20').value);
  state.minRem = toNum(ws.getCell('L21').value);

  state.workName = trim(cellText(ws.getCell('L22').value));
  state.workNo = trim(cellText(ws.getCell('L23').value));
  state.workerName = trim(cellText(ws.getCell('L24').value));
  state.usagePurpose = trim(cellText(ws.getCell('L25').value));

  state.purchaseStocks = [];
  for (var r = STOCK_PUR_START; r <= STOCK_PUR_END; r++){
    state.purchaseStocks.push({
      row: r,
      len: toNum(ws.getCell('L'+r).value),
      limit: toNum(ws.getCell('M'+r).value),
      usedDisplay: ''
    });
  }
  state.inventoryStocks = [];
  for (var r2 = STOCK_INV_START; r2 <= STOCK_INV_END; r2++){
    state.inventoryStocks.push({
      row: r2,
      len: toNum(ws.getCell('L'+r2).value),
      limit: toNum(ws.getCell('M'+r2).value),
      usedDisplay: ''
    });
  }

  state.products = [];
  for (var r3 = DATA_START_ROW; r3 <= DATA_END_ROW; r3++){
    var mark = trim(cellText(ws.getCell('A'+r3).value));
    var size = trim(cellText(ws.getCell('B'+r3).value));
    var process = trim(cellText(ws.getCell('C'+r3).value));
    var priorityRaw = ws.getCell('D'+r3).value;
    var group = trim(cellText(ws.getCell('E'+r3).value));
    var length = toNum(ws.getCell('F'+r3).value);
    var qty = Math.trunc(toNum(ws.getCell('G'+r3).value));
    state.products.push({ row:r3, mark:mark, size:size, process:process, priorityRaw:priorityRaw, group:group, length:length, qty:qty });
  }

  var seen = {};
  state.sizeList = [];
  state.products.forEach(function(p){
    if (p.size !== '' && !seen[p.size]) { seen[p.size] = true; state.sizeList.push(p.size); }
  });

  return {
    productCount: state.products.filter(function(p){ return p.size !== ''; }).length,
    sizeCount: state.sizeList.length
  };
}

/* =========================================================
   ③ 計算エンジン(現行VBA Module1のロジックを1:1移植)
   ========================================================= */
function resetAllMarks(products){
  products.forEach(function(p){
    var idx = p.mark.indexOf('[仮');
    if (idx >= 0) p.mark = p.mark.substring(0, idx).trim();
  });
}

function uniquifyMarks(products, targetSize){
  var dict = {};
  products.forEach(function(p){
    if (p.size === targetSize){
      var key = p.size + '|' + p.process + '|' + p.length + '|' + p.mark;
      if (!(key in dict)) { dict[key] = 1; }
      else {
        dict[key] += 1;
        p.mark = p.mark + '[仮' + (dict[key]-1) + ']';
      }
    }
  });
}

function buildGroups(products, targetSize){
  var groups = {};      // key -> array of items
  var groupOrder = [];  // key insertion order
  var processNames = {}; // key -> array of unique process names (insertion order)
  products.forEach(function(p){
    if (p.size !== targetSize) return;
    var qty = Math.trunc(p.qty);
    if (qty <= 0) return;
    var grpStr = trim(p.group);
    var grpKey = grpStr !== '' ? ('G_'+grpStr) : ('P_'+p.process);
    if (!groups[grpKey]) { groups[grpKey] = []; groupOrder.push(grpKey); processNames[grpKey] = []; }
    groups[grpKey].push({
      rowIndex: p.row,
      mark: p.mark,
      process: p.process,
      priority: getPrioNum(p.priorityRaw),
      length: p.length,
      qty: qty
    });
    if (processNames[grpKey].indexOf(p.process) === -1) processNames[grpKey].push(p.process);
  });
  return { groups:groups, groupOrder:groupOrder, processNames:processNames };
}

function buildGroupMeta(groups, groupOrder){
  var meta = groupOrder.map(function(key){
    var items = groups[key];
    var minP = 999999, fRow = Infinity;
    items.forEach(function(it){
      if (it.priority < minP) minP = it.priority;
      if (it.rowIndex < fRow) fRow = it.rowIndex;
    });
    return { key:key, minP:minP, fRow:fRow };
  });
  meta.sort(function(a,b){ return (a.minP - b.minP) || (a.fRow - b.fRow); });
  return meta;
}

function sortGroup(items){
  items.sort(function(a,b){
    if (a.priority !== b.priority) return a.priority - b.priority;
    return b.length - a.length;
  });
}

function sortRelayedStocks(relays){
  relays.sort(function(a,b){ return b.remLen - a.remLen; });
}

function totalRemaining(items){
  var t = 0;
  items.forEach(function(it){ t += it.qty; });
  return t;
}

function getQty(items, rowIndex){
  for (var i=0;i<items.length;i++){ if (items[i].rowIndex === rowIndex) return items[i].qty; }
  return 0;
}

function deductQty(items, rowIndex, amount){
  for (var i=0;i<items.length;i++){ if (items[i].rowIndex === rowIndex){ items[i].qty -= amount; return; } }
}

function updatePattern(pattern, rowIndex, mark, length){
  for (var i=0;i<pattern.length;i++){
    if (pattern[i].rowIndex === rowIndex){ pattern[i].count += 1; return; }
  }
  pattern.push({ rowIndex:rowIndex, mark:mark, length:length, count:1 });
}

function simulatePack(items, stockLen, gMargin, cMargin){
  var availLen = stockLen - gMargin;
  var totalProdLen = 0;
  var pattern = [];
  var tempQty = items.map(function(it){ return it.qty; });
  for (var i=0;i<items.length;i++){
    while (tempQty[i] > 0){
      var reqLen = items[i].length + cMargin;
      if (bankersRound(reqLen,4) <= bankersRound(availLen,4)){
        availLen = bankersRound(availLen - reqLen, 4);
        totalProdLen += items[i].length;
        tempQty[i] -= 1;
        updatePattern(pattern, items[i].rowIndex, items[i].mark, items[i].length);
      } else {
        break;
      }
    }
  }
  var usedLen = (stockLen - gMargin) - availLen;
  var rem = stockLen - usedLen;
  var yieldVal = totalProdLen > 0 ? (totalProdLen/stockLen) : -1;
  return { yieldVal:yieldVal, pattern:pattern, rem:rem };
}

function evaluateMaterial(items, sLen, sKey, matStatus, gripMargin, cutMargin, best){
  var r = simulatePack(items, sLen, gripMargin, cutMargin);
  if (r.yieldVal > best.yieldVal || (r.yieldVal === best.yieldVal && r.yieldVal >= 0 && sLen < best.usedLen)){
    best.yieldVal = r.yieldVal;
    best.pattern = r.pattern;
    best.stockKey = sKey;
    best.rem = r.rem;
    best.usedLen = sLen;
    best.status = matStatus;
  }
}

function makeEmptyCells(){
  var cells = {};
  RESULT_COLS.forEach(function(c){ cells[c] = { value:'', color:null, format:null }; });
  return cells;
}

function makeTitleRow(text){
  var cells = makeEmptyCells();
  cells.Q.value = text;
  return { kind:'title', cells:cells };
}

function makeColHeadRow(){
  var cells = makeEmptyCells();
  cells.P.value = '使用尺'; cells.Q.value = '本数'; cells.R.value = '残尺'; cells.S.value = '歩留り';
  TRIPLE_COLS.forEach(function(triple, idx){
    cells[triple[0]].value = 'マーク'+(idx+1);
    cells[triple[1]].value = '長さ'+(idx+1);
    cells[triple[2]].value = '本数'+(idx+1);
  });
  return { kind:'colhead', cells:cells };
}

function makeDataRow(){
  return { kind:'data', cells: makeEmptyCells() };
}

function runOptimization(targetSize){
  targetSize = trim(targetSize);
  resetAllMarks(state.products);
  uniquifyMarks(state.products, targetSize);

  var built = buildGroups(state.products, targetSize);
  if (built.groupOrder.length === 0){
    return { success:false, error:'選択したサイズに該当する数量のある製品データが見つかりません。' };
  }
  var groupMeta = buildGroupMeta(built.groups, built.groupOrder);

  var stockUsage = {};    // inventory row -> used count
  var purchaseUsage = {}; // purchase row -> used qty
  var relayedStocks = []; // {remLen, sourceRowIdx}
  var outputRows = [];
  var blocks = [];              // {outerStart, outerEnd, dataStart, dataEnd}
  var pageBreakBeforeIdxs = []; // title行indexで改ページ

  var isFirstGroup = true;

  for (var gi=0; gi<groupMeta.length; gi++){
    var meta = groupMeta[gi];
    var currentGroup = built.groups[meta.key];
    sortGroup(currentGroup);

    if (!isFirstGroup) pageBreakBeforeIdxs.push(outputRows.length);
    var titleIdx = outputRows.length;
    outputRows.push(makeTitleRow(built.processNames[meta.key].join('＿')));
    var colHeadIdx = outputRows.length;
    outputRows.push(makeColHeadRow());
    var dataStartIdx = outputRows.length;
    isFirstGroup = false;

    var guard = 0;
    while (totalRemaining(currentGroup) > 0){
      guard++;
      if (guard > 20000){ return { success:false, error:'計算が収束しませんでした(データ異常の可能性)。' }; }

      var best = { yieldVal:-1, pattern:null, stockKey:null, rem:0, usedLen:0, status:null };

      // ① 在庫優先
      state.inventoryStocks.forEach(function(s){
        if (s.len > 0 && s.limit > 0){
          var used = stockUsage[s.row] || 0;
          if (s.limit - used > 0){
            evaluateMaterial(currentGroup, s.len, s.row, 'Inventory', state.gripMargin, state.cutMargin, best);
          }
        }
      });

      // ② Relay優先
      if (best.yieldVal < 0 && relayedStocks.length > 0){
        for (var ri=0; ri<relayedStocks.length; ri++){
          evaluateMaterial(currentGroup, relayedStocks[ri].remLen, ri, 'Relay', state.gripMargin, state.cutMargin, best);
        }
      }

      // ③ 新品購入
      if (best.yieldVal < 0){
        state.purchaseStocks.forEach(function(s){
          var limit = s.limit; if (limit === 0) limit = 999999;
          if (s.len > 0){
            var used = purchaseUsage[s.row] || 0;
            if (limit - used > 0){
              evaluateMaterial(currentGroup, s.len, s.row, 'Purchase', state.gripMargin, state.cutMargin, best);
            }
          }
        });
      }

      if (best.yieldVal < 0){
        return { success:false, error:'切断可能な素材が見つかりません(在庫・端材・新品購入いずれも不足)。' };
      }

      var maxSets = 1;
      if (best.status === 'Purchase'){
        maxSets = 999999;
        best.pattern.forEach(function(pi){
          var possible = Math.floor(getQty(currentGroup, pi.rowIndex) / pi.count);
          if (possible < maxSets) maxSets = possible;
        });
        var stockDef = state.purchaseStocks.filter(function(s){ return s.row === best.stockKey; })[0];
        var lmt = stockDef.limit; if (lmt === 0) lmt = 999999;
        var usedP = purchaseUsage[best.stockKey] || 0;
        if (maxSets > (lmt - usedP)) maxSets = lmt - usedP;
        if (maxSets < 1) maxSets = 1;
      }

      if (best.status === 'Inventory'){
        stockUsage[best.stockKey] = (stockUsage[best.stockKey] || 0) + 1;
      } else if (best.status === 'Purchase'){
        purchaseUsage[best.stockKey] = (purchaseUsage[best.stockKey] || 0) + maxSets;
      } else if (best.status === 'Relay'){
        var relay = relayedStocks[best.stockKey];
        outputRows[relay.sourceRowIdx].cells.R.color = 'relay-hit';
        relayedStocks.splice(best.stockKey, 1);
      }

      best.pattern.forEach(function(pi){
        deductQty(currentGroup, pi.rowIndex, pi.count * maxSets);
      });

      var nextRowIdx = outputRows.length;
      if (best.rem >= state.minRem){
        for (var c=0;c<maxSets;c++){ relayedStocks.push({ remLen:best.rem, sourceRowIdx:nextRowIdx }); }
        sortRelayedStocks(relayedStocks);
      }

      var rowsNeeded = Math.max(1, Math.ceil(best.pattern.length/5));
      for (var rOffset=0; rOffset<rowsNeeded; rOffset++){
        var row = makeDataRow();
        if (rOffset === 0){
          row.cells.P.value = best.usedLen;
          row.cells.P.color = best.status === 'Relay' ? 'relay' : (best.status === 'Inventory' ? 'inventory' : 'purchase');
          row.cells.Q.value = maxSets;
          row.cells.R.value = best.rem;
          row.cells.R.color = best.rem >= state.minRem ? 'remnant-hit' : null;
          row.cells.S.value = best.yieldVal;
          row.cells.S.format = 'percent1';
        }
        for (var colIdx=0; colIdx<5; colIdx++){
          var itmIdx = rOffset*5 + colIdx;
          if (itmIdx < best.pattern.length){
            var itm = best.pattern[itmIdx];
            var triple = TRIPLE_COLS[colIdx];
            row.cells[triple[0]].value = itm.mark;
            row.cells[triple[1]].value = itm.length;
            row.cells[triple[2]].value = itm.count;
          }
        }
        outputRows.push(row);
      }
    }

    var dataEndIdx = outputRows.length - 1;
    blocks.push({ outerStart: colHeadIdx, outerEnd: dataEndIdx, dataStart: dataStartIdx, dataEnd: dataEndIdx });
  }

  state.purchaseStocks.forEach(function(s){
    if (purchaseUsage[s.row] !== undefined) s.usedDisplay = String(purchaseUsage[s.row]);
  });
  state.inventoryStocks.forEach(function(s){
    if (stockUsage[s.row] !== undefined) s.usedDisplay = stockUsage[s.row] + '本使用';
  });

  return { success:true, outputRows:outputRows, blocks:blocks, pageBreakBeforeIdxs:pageBreakBeforeIdxs, targetSize:targetSize };
}

/* =========================================================
   ④ 結果テーブル描画(編集可能)
   ========================================================= */
function formatCellDisplay(cell){
  if (cell.value === '' || cell.value === null || cell.value === undefined) return '';
  if (cell.format === 'percent1'){
    return (cell.value * 100).toFixed(1) + '%';
  }
  if (typeof cell.value === 'number'){
    // 小数は最大2桁表示、整数はそのまま
    return (Math.round(cell.value*100)/100).toString();
  }
  return String(cell.value);
}

function colorClass(color){
  if (color === 'inventory') return 'color-inventory';
  if (color === 'relay') return 'color-relay';
  if (color === 'purchase') return 'color-purchase';
  if (color === 'remnant-hit') return 'color-remnant-hit';
  if (color === 'relay-hit') return 'color-relay';
  return '';
}

function borderClassForCol(col){
  if (MEDIUM_AFTER[col]) return 'medium';
  if (HAIRLINE_AFTER[col]) return 'hair';
  return '';
}

function renderResultTable(){
  var result = state.lastResult;
  var table = document.getElementById('resultTable');
  table.innerHTML = '';
  if (!result){ return; }

  var blockLookup = {}; // rowIdx -> {isFirst, isLast}
  result.blocks.forEach(function(b){
    blockLookup[b.outerStart] = blockLookup[b.outerStart] || {};
    blockLookup[b.outerStart].isFirst = true;
    blockLookup[b.outerEnd] = blockLookup[b.outerEnd] || {};
    blockLookup[b.outerEnd].isLast = true;
  });

  result.outputRows.forEach(function(row, rowIdx){
    var tr = document.createElement('tr');
    if (row.kind === 'title') tr.className = 'title-row';
    else if (row.kind === 'colhead') tr.className = 'colhead-row';
    var edgeInfo = blockLookup[rowIdx] || {};
    if (edgeInfo.isFirst) tr.classList.add('block-first');
    if (edgeInfo.isLast) tr.classList.add('block-last');

    RESULT_COLS.forEach(function(col, colIdx){
      var td = document.createElement('td');
      var cell = row.cells[col];
      td.textContent = formatCellDisplay(cell);
      var bc = borderClassForCol(col);
      if (bc) td.classList.add(bc);
      var cc = colorClass(cell.color);
      if (cc) td.classList.add(cc);
      if (col === 'P') td.classList.add('block-edge-left');
      if (col === 'AH') td.classList.add('block-edge-right');
      if (row.kind === 'data'){
        td.contentEditable = 'true';
        td.classList.add('editable');
        td.dataset.rowIdx = rowIdx;
        td.dataset.col = col;
        td.addEventListener('blur', onCellEdit);
      }
      tr.appendChild(td);
    });
    table.appendChild(tr);
  });
}

function onCellEdit(e){
  var td = e.target;
  var rowIdx = parseInt(td.dataset.rowIdx, 10);
  var col = td.dataset.col;
  var row = state.lastResult.outputRows[rowIdx];
  var cell = row.cells[col];
  var text = td.textContent.trim();
  if (cell.format === 'percent1'){
    var pct = parseFloat(text.replace('%',''));
    cell.value = isNaN(pct) ? cell.value : pct/100;
  } else {
    var num = parseFloat(text);
    cell.value = (text === '' ) ? '' : (isNaN(num) ? text : num);
  }
  td.textContent = formatCellDisplay(cell);
}

/* =========================================================
   ⑤ Excelエクスポート
   ========================================================= */
var BORDER_STYLE = { thin:'thin', hair:'hairline', medium:'medium', double:'double' };
var FONT_COLOR = {
  inventory: 'FF0A7D2C',
  relay: 'FF1257C9',
  purchase: 'FF111111',
  'remnant-hit': 'FFC62828',
  'relay-hit': 'FF1257C9'
};

async function buildResultWorkbook(){
  var result = state.lastResult;
  var wb = new ExcelJS.Workbook();
  var ws = wb.addWorksheet('計算結果');

  var colOffset = {}; // col letter -> 1-based column index (P=16 ...)
  RESULT_COLS.forEach(function(c, i){ colOffset[c] = 16 + i; });

  ws.getColumn(colOffset.P).width = 10;
  ws.getColumn(colOffset.Q).width = 8;
  ws.getColumn(colOffset.R).width = 8;
  ws.getColumn(colOffset.S).width = 8;
  TRIPLE_COLS.forEach(function(triple){
    ws.getColumn(colOffset[triple[0]]).width = 12;
    ws.getColumn(colOffset[triple[1]]).width = 8;
    ws.getColumn(colOffset[triple[2]]).width = 6;
  });

  var blockLookup = {};
  result.blocks.forEach(function(b){
    blockLookup[b.outerStart] = blockLookup[b.outerStart] || {};
    blockLookup[b.outerStart].isFirst = true;
    blockLookup[b.outerEnd] = blockLookup[b.outerEnd] || {};
    blockLookup[b.outerEnd].isLast = true;
  });

  result.outputRows.forEach(function(row, rowIdx){
    var excelRow = rowIdx + 1;
    var edgeInfo = blockLookup[rowIdx] || {};
    RESULT_COLS.forEach(function(col){
      var cellObj = row.cells[col];
      var cell = ws.getCell(excelRow, colOffset[col]);
      if (cellObj.value !== '' && cellObj.value !== null && cellObj.value !== undefined){
        cell.value = cellObj.value;
      }
      if (cellObj.format === 'percent1') cell.numFmt = '0.0%';
      if (row.kind === 'title' || row.kind === 'colhead') cell.font = { bold:true };
      if (cellObj.color && FONT_COLOR[cellObj.color]){
        cell.font = Object.assign({}, cell.font, { color:{argb:FONT_COLOR[cellObj.color]}, bold: cellObj.color==='remnant-hit' });
      }
      var border = {};
      if (row.kind === 'data'){
        border.top = { style:'thin' };
        border.bottom = { style:'thin' };
        border.left = { style:'thin' };
        border.right = { style:'thin' };
      }
      var bc = borderClassForCol(col);
      if (bc === 'medium') border.right = { style:'medium' };
      else if (bc === 'hair') border.right = { style:'hair' };
      if (edgeInfo.isFirst) border.top = { style:'double' };
      if (edgeInfo.isLast) border.bottom = { style:'double' };
      if (col === 'P') border.left = { style:'double' };
      if (col === 'AH') border.right = { style:'double' };
      cell.border = border;
    });
  });

  ws.pageSetup = {
    orientation: 'landscape',
    paperSize: 9, // A4
    fitToPage: true,
    fitToWidth: 1,
    fitToHeight: 0,
    margins: { top:0.75, bottom:0, left:0, right:0, header:0, footer:0 }
  };
  result.pageBreakBeforeIdxs.forEach(function(rowIdx){
    ws.getRow(rowIdx + 1).addPageBreak && ws.getRow(rowIdx + 1).addPageBreak();
  });

  return wb;
}

// エクスポートされた結果から、実績記録シート用のサマリを集計する。
// P列(使用尺)が入っている行=1パターンの代表行(データ明細の続き行は含まない)。
function computeSummary(result){
  var counts = { inventory:0, relay:0, purchase:0 };
  var remnantCount = 0, remnantLenSum = 0;
  var productLenSum = 0, materialLenSum = 0;

  result.outputRows.forEach(function(row){
    if (row.kind !== 'data') return;
    if (row.cells.P.value === '' || row.cells.P.value === null || row.cells.P.value === undefined) return;
    var qty = toNum(row.cells.Q.value);
    var stockLen = toNum(row.cells.P.value);
    var yieldVal = toNum(row.cells.S.value);
    var cat = row.cells.P.color;
    if (counts[cat] !== undefined) counts[cat] += qty;
    materialLenSum += stockLen * qty;
    productLenSum += stockLen * yieldVal * qty;
    if (row.cells.R.color === 'remnant-hit'){
      remnantCount += qty;
      remnantLenSum += toNum(row.cells.R.value) * qty;
    }
  });

  return {
    groupCount: result.blocks.length,
    inventoryCount: counts.inventory,
    relayCount: counts.relay,
    purchaseCount: counts.purchase,
    overallYield: materialLenSum > 0 ? (productLenSum / materialLenSum) : 0,
    remnantCount: remnantCount,
    remnantLenSum: Math.round(remnantLenSum)
  };
}

// 実績記録をGASへ送信する。あくまで付随機能のため、失敗してもExcelダウンロードは
// 既に完了しており、ユーザーの作業を妨げない(呼び出し元でawaitしないこと)。
function recordResultToSheet(){
  if (!state.lastResult) return;
  var summary = computeSummary(state.lastResult);
  apiPost('recordResult', {
    担当者: state.workerName || '',
    工事番号: state.workNo || '',
    工事名: state.workName || '',
    使用用途: state.usagePurpose || '',
    対象サイズ: state.lastResult.targetSize || '',
    グループ数: summary.groupCount,
    在庫材使用本数: summary.inventoryCount,
    端材リレー使用本数: summary.relayCount,
    新品購入本数: summary.purchaseCount,
    全体歩留まり: summary.overallYield,
    端材発生本数: summary.remnantCount,
    端材発生長さ合計: summary.remnantLenSum
  }).catch(function(err){
    console.warn('実績記録の書き込みに失敗しました(Excel出力自体は完了しています): ' + err.message);
  });
}

/* =========================================================
   背景スライドショー(masamiz.com自社サイト写真、3秒おきに切替)
   ========================================================= */
var BG_IMAGES = [
  'https://www.masamiz.com/image/iron_about/image06.jpg',
  'https://www.masamiz.com/image/iron_about/image01.jpg',
  'https://www.masamiz.com/image/flow/image01.png',
  'https://www.masamiz.com/image/flow/image02.png',
  'https://www.masamiz.com/image/flow/image03_02.png',
  'https://www.masamiz.com/image/flow/image12_02.png',
  'https://www.masamiz.com/image/flow/image13_02.png',
  'https://www.masamiz.com/image/flow/image04.png',
  'https://www.masamiz.com/image/flow/image05.png',
  'https://www.masamiz.com/image/flow/image06_02.png',
  'https://www.masamiz.com/image/flow/image07.png',
  'https://www.masamiz.com/image/flow/image09.png',
  'https://www.masamiz.com/image/flow/image10.png',
  'https://www.masamiz.com/image/flow/image11.png',
  'https://www.masamiz.com/image/factory/image01.jpg',
  'https://www.masamiz.com/image/factory/image02.jpg',
  'https://www.masamiz.com/image/factory/image03.jpg'
];

function initBgSlideshow(){
  var container = document.getElementById('bgSlideshow');
  if (!container || BG_IMAGES.length === 0) return;
  BG_IMAGES.forEach(function(url){
    var div = document.createElement('div');
    div.className = 'slide';
    div.style.backgroundImage = "url('" + url + "')";
    container.appendChild(div);
  });
  var slides = container.querySelectorAll('.slide');
  var idx = 0;
  slides[0].classList.add('active');
  if (slides.length > 1){
    setInterval(function(){
      slides[idx].classList.remove('active');
      idx = (idx + 1) % slides.length;
      slides[idx].classList.add('active');
    }, 3000);
  }
}

/* =========================================================
   イベント配線
   ========================================================= */
document.addEventListener('DOMContentLoaded', function(){
  initBgSlideshow();

  document.getElementById('btnTemplate').addEventListener('click', function(){
    showMessage('テンプレートを作成しています…', '');
    buildTemplateWorkbook().then(function(wb){
      return downloadWorkbookAsXlsx(wb, '鋼材取合最適化_テンプレート.xlsx');
    }).then(function(){
      showMessage('テンプレートをダウンロードしました。', 'ok');
    }).catch(function(err){
      console.error(err);
      showMessage('テンプレート作成でエラーが発生しました: ' + err.message, 'error');
    });
  });

  function handleFileSelected(file){
    if (!file){
      showMessage('ファイルを選択してください。', 'error');
      return;
    }
    showMessage('インポート中…', '');
    importFile(file).then(function(summary){
      document.getElementById('importSummary').textContent =
        '製品データ: ' + summary.productCount + '件 / サイズ種類: ' + summary.sizeCount + '種類 / ' +
        '切断代=' + state.cutMargin + 'mm, つかみ代=' + state.gripMargin + 'mm, 最小端材長=' + state.minRem + 'mm';
      var sel = document.getElementById('sizeSelect');
      sel.innerHTML = '';
      state.sizeList.forEach(function(sz){
        var opt = document.createElement('option');
        opt.value = sz; opt.textContent = sz;
        sel.appendChild(opt);
      });
      document.getElementById('sizeStep').style.display = state.sizeList.length ? 'block' : 'none';
      document.getElementById('resultStep').style.display = 'none';
      if (state.sizeList.length === 0){
        showMessage('インポートしましたが、サイズが入力された製品データが見つかりませんでした。', 'error');
      } else {
        showMessage('インポートが完了しました。', 'ok');
      }
    }).catch(function(err){
      console.error(err);
      showMessage('インポートでエラーが発生しました: ' + err.message, 'error');
    });
  }

  var fileInputEl = document.getElementById('fileInput');
  fileInputEl.addEventListener('change', function(){
    if (fileInputEl.files && fileInputEl.files[0]) handleFileSelected(fileInputEl.files[0]);
  });

  var dropZone = document.getElementById('importDropZone');
  dropZone.addEventListener('dragover', function(e){
    e.preventDefault();
    dropZone.classList.add('drag-over');
  });
  dropZone.addEventListener('dragleave', function(){
    dropZone.classList.remove('drag-over');
  });
  dropZone.addEventListener('drop', function(e){
    e.preventDefault();
    dropZone.classList.remove('drag-over');
    var file = e.dataTransfer && e.dataTransfer.files && e.dataTransfer.files[0];
    if (!file) return;
    try { fileInputEl.files = e.dataTransfer.files; } catch (err) { /* 一部ブラウザでは代入不可、handleFileSelectedは別途実行 */ }
    handleFileSelected(file);
  });

  document.getElementById('btnCalc').addEventListener('click', function(){
    var size = document.getElementById('sizeSelect').value;
    if (!size){ showMessage('サイズを選択してください。', 'error'); return; }
    showMessage('計算しています…', '');
    var result = runOptimization(size);
    if (!result.success){
      document.getElementById('resultStep').style.display = 'none';
      showMessage(result.error, 'error');
      return;
    }
    state.lastResult = result;
    renderResultTable();
    document.getElementById('resultStep').style.display = 'block';
    showMessage('計算が完了しました。結果は直接編集できます。', 'ok');
  });

  document.getElementById('btnExport').addEventListener('click', function(){
    if (!state.lastResult){ showMessage('先に計算を実行してください。', 'error'); return; }
    showMessage('Excelを作成しています…', '');
    buildResultWorkbook().then(function(wb){
      return downloadWorkbookAsXlsx(wb, '鋼材取合最適化_計算結果.xlsx');
    }).then(function(){
      showMessage('結果をダウンロードしました。', 'ok');
      recordResultToSheet(); // 失敗してもダウンロードは既に完了しているため、ここでは待たない
    }).catch(function(err){
      console.error(err);
      showMessage('Excel出力でエラーが発生しました: ' + err.message, 'error');
    });
  });
});
