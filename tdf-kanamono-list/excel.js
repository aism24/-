// 金物リストのExcelを作る(様式は docs/apps/tdf-kanamono-list.md。ユーザーの見本ファイルとセル単位で合わせた)。
// 工場ごとに様式を変えられるよう、FORMATS[工場] で作り方を選ぶ(2026-11-19時点は3工場とも同じ様式)。
// レイアウト(layout)は、ExcelJS で書く処理と、GASのデータシート(値だけ)の両方で使う。
(function (root) {
  'use strict';
  var X = (typeof module !== 'undefined' && module.exports) ? require('./extract.js') : root.KanamonoExtract;
  var FONT = 'ＭＳ Ｐゴシック';
  var HT = { title: 17.25, phead: 14.25, pval: 28.5, lhead: 14.25, sub: 14.25, blank: 15, stitle: 14.25, cat: 14.25, empty4: 14.25 };
  var DEF_H = 13.5;

  // ---------- 重量・注文書(2026-11-25 ユーザー指示) ----------
  // 形鋼の単位質量(kg/m。JIS の表の値)。軽量溝形鋼(C-)・鋼管(P-)・平鋼(FB-/PL-幅)は形から計算する
  var STEEL_KGM = { 'L-50x50x6': 4.43, 'L-65x65x6': 5.91, 'L-75x75x6': 6.85, 'L-90x90x7': 9.59, 'L-100x100x7': 10.7, '[-100x50x5x7.5': 9.36, '[-75x40x5x7': 6.92 };
  var R2 = function (x) { return Math.round(x * 100) / 100; };
  var NUM = '(\\d+(?:\\.\\d+)?)';
  function kgPerM(size) {
    if (STEEL_KGM[size]) return STEEL_KGM[size];
    var m = new RegExp('^C-' + NUM + 'x' + NUM + 'x' + NUM + 'x' + NUM + '$').exec(size);
    // 軽量溝形鋼: 断面積 = t(H+2B+2C-4t) - 角の丸み(内側の半径 = t)。C-100x50x20x2.3 で JIS の 5.172cm²・4.06kg/m と一致
    if (m) { var H = +m[1], B = +m[2], C = +m[3], t = +m[4]; return R2((t * (H + 2 * B + 2 * C - 4 * t) - 3 * (4 - Math.PI) * t * t) * 7.85e-3); }
    m = new RegExp('^P-' + NUM + 'φx' + NUM + '$').exec(size);
    if (m) return R2(Math.PI * (+m[1] - +m[2]) * +m[2] * 7.85e-3);   // 鋼管(P-60.5φx3.2 = 4.52)
    m = new RegExp('^(?:FB|PL)-' + NUM + 'x' + NUM + '$').exec(size);
    if (m) return +m[1] * +m[2] * 7.85e-3;   // 平鋼・幅の決まった板(厚さ×幅)
    return null;
  }
  var isMark = function (name) { return typeof name === 'string' && /[A-Za-z]/.test(name); };
  // 1枚(1本)の重量(kg)。分からないもの(支給品・スリーブ・フック・ピースなど)は null
  //   符号のある切板 = 注文書のネット重量(1枚当り)。注文書に無ければ、PL-厚x幅x長さ が書いてあるときだけ計算
  //   形鋼・平鋼 = 単位質量 × 長さ(切板名の欄の数字)
  function unitWeight(it, marks) {
    if (/支給品/.test(it.note || '')) return null;
    var full = new RegExp('^PL-' + NUM + 'x' + NUM + 'x' + NUM + '$').exec(it.size);
    if (isMark(it.name)) {
      var o = marks && marks[it.name];
      if (o && o.w > 0) return o.w;
      return full ? R2(+full[1] * +full[2] * +full[3] * 7.85e-6) : null;
    }
    var len = typeof it.name === 'number' ? it.name : (/^\d+(\.\d+)?$/.test(String(it.name)) ? +it.name : 0);
    if (len > 0) { var k = kgPerM(it.size); return k ? R2(k * len / 1000) : null; }
    return full ? R2(+full[1] * +full[2] * +full[3] * 7.85e-6) : null;
  }
  // 注文書との照合: 符号ごとに {ord: 手配数, nos: 注文番号の末尾(_ でつなぐ), used: 使う枚数(リスト全体), diff: 差し引き}。注文書に無い符号は入れない
  function checkMarks(products, marks) {
    var used = {}, out = {};
    if (!marks) return out;
    products.forEach(function (p) { p.items.forEach(function (it) { if (isMark(it.name) && it.n > 0) used[it.name] = (used[it.name] || 0) + it.n; }); });
    Object.keys(used).forEach(function (k) {
      var o = marks[k]; if (!o) return;
      out[k] = { ord: o.n, nos: (o.nos || []).join('_'), used: used[k], diff: o.n - used[k] };
    });
    return out;
  }

  // products: [{zuban, name, size, length, dai, items:[{size,name,n,note}], link}]
  // 戻り値: { rows:[{kind, vals, link}], breaks:[行番号(この行の後で改ページ)] }
  // orders: 注文書 {marks:{符号:{n, w, nos}}}(無ければ null。重量は形鋼だけ、照合はしない)
  function layout(head, products, multi, orders) {
    var marks = orders && orders.marks || null, chk = checkMarks(products, marks);
    var rows = [
      { kind: 'title', vals: ['金物リスト'] },
      { kind: 'info', vals: ['工事番号', head.kojiNo] },
      { kind: 'info', vals: ['工事名', head.koji] },
      { kind: 'empty4', vals: [] }
    ];
    var blocks = [], tot = {};
    products.forEach(function (p) {
      var b = [
        { kind: 'phead', vals: ['図面番号', '製品名', 'サイズ', '長さ（mm）', '台数'] },
        { kind: 'pval', vals: [p.zuban, p.name, p.size, p.length || null, p.dai], link: p.link || '' },
        { kind: 'lhead', vals: ['サイズ', '切板名（長さ）', '枚数（本数）', '備考', null, null, '単重（kg）', '重量（kg）'] }
      ];
      var s = 0, ws = 0, hasW = false;
      p.items.filter(function (it) { return it.n > 0; }).sort(X.cmpItem).forEach(function (it) {
        var u = unitWeight(it, marks), w = u === null ? null : R2(u * it.n), c = isMark(it.name) ? chk[it.name] : null;
        b.push({ kind: X.kindOf(it.size) === 'GPL' ? 'item_gpl' : 'item', vals: [it.size, it.name, it.n, it.note || null, null, null, u, w], short: !!(c && c.diff < 0) });
        s += it.n;
        if (w !== null) { ws += w; hasW = true; }
        var k = it.size + '|' + it.name + '|' + (it.note || '');
        if (!tot[k]) tot[k] = { size: it.size, name: it.name, n: 0, note: it.note || '', u: u };
        tot[k].n += it.n;
      });
      b.push({ kind: 'sub', vals: [null, '小計', s, null, null, null, null, hasW ? R2(ws) : null] });
      blocks.push({ rows: b, type: 'prod' });
    });
    var cats = [['GPL', 'GPL'], ['他', 'PL'], ['鋼材', 'STEEL']];
    var sblocks = [];
    cats.forEach(function (c) {
      var its = Object.keys(tot).map(function (k) { return tot[k]; }).filter(function (t) { return X.kindOf(t.size) === c[1]; }).sort(X.cmpItem);
      if (!its.length) return;
      var sb = [{ kind: 'cat', vals: [c[0]] }, { kind: 'shead', vals: ['サイズ', '切板名（長さ）', '枚数（本数）', '備考', '注文番号', null, '単重（kg）', '重量（kg）', null, null, '手配総数', '差し引き'] }];
      // E=注文番号の末尾 G=単重 H=単重×枚数 K=手配総数(注文書の合計) L=差し引き(手配総数 − リスト全体で使う枚数。不足は赤)
      its.forEach(function (t) {
        var ck = isMark(t.name) ? chk[t.name] : null;
        sb.push({ kind: c[1] === 'GPL' ? 'sitem_gpl' : 'sitem', short: !!(ck && ck.diff < 0),
          vals: [t.size, t.name, t.n, t.note || null, ck ? ck.nos : null, null, t.u, t.u === null ? null : R2(t.u * t.n), null, null, ck ? ck.ord : null, ck ? ck.diff : null] });
      });
      sblocks.push({ rows: sb, type: 'sum' });
    });
    if (sblocks.length) sblocks[0].rows.unshift({ kind: 'stitle', vals: [multi ? '取り込んだTDF全ての総まとめ' : '総まとめ'] });

    // 改ページ: A4縦・上下余白2.5cm・縮小96%。1〜4行目は毎ページ印刷される。
    // 製品のブロック・総まとめの種類別の表は途中で切らない。総まとめは必ず新しいページから。
    var titleH = rows.reduce(function (a, r) { return a + (HT[r.kind] || DEF_H); }, 0);
    var PAGE = (841.89 - 2 * 0.984251968503937 * 72) / 0.96 - titleH;
    function h(rs) { return rs.reduce(function (a, r) { return a + (HT[r.kind] || DEF_H); }, 0); }
    var all = blocks.concat(sblocks), breaks = [], used = 0;
    all.forEach(function (bl, i) {
      var body = bl.rows, withSep = body.slice();
      if (i < all.length - 1) withSep.push({ kind: bl.type === 'prod' ? 'blank' : 'sblank', vals: [] });
      var firstSum = bl.type === 'sum' && i > 0 && all[i - 1].type === 'prod';
      if (used > 0 && (firstSum || used + h(body) > PAGE)) { breaks.push(rows.length); used = 0; }
      Array.prototype.push.apply(rows, withSep); used += h(withSep);
    });
    return { rows: rows, breaks: breaks };
  }

  // 値だけの表(GASのデータシート用)
  function toValues(lay) {
    return lay.rows.map(function (r) { var v = r.vals.slice(); while (v.length < 5) v.push(''); return v.map(function (x) { return x === null || x === undefined ? '' : x; }); });
  }

  // ---------- 標準の様式(ExcelJS) ----------
  var THIN = { style: 'thin' }, DBL = { style: 'double' }, THICK = { style: 'thick' };
  function fill(rgb) { return { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FF' + rgb } }; }
  function font(o) { o = o || {}; return { name: FONT, size: o.size || 11, bold: !!o.bold, underline: o.u ? true : undefined, color: o.color ? { argb: o.color } : undefined, charset: 128 }; }
  // 列ごとの罫線(左, 右, 上, 下)。製品のブロックは外周の左右が二重線、D列の右は線なし(E列の左の線が付く)
  function prodBorder(col, top, bottom) {
    var l = col === 0 ? DBL : THIN, r = col === 3 ? undefined : (col === 4 ? DBL : THIN);
    var b = { left: l, top: top, bottom: bottom }; if (r) b.right = r; return b;
  }
  var CENTER = { horizontal: 'center' };
  function styleCell(cell, kind, col) {
    switch (kind) {
      case 'title': cell.font = font({ size: col === 0 ? 14 : 11, bold: col === 0 }); cell.border = { bottom: THIN }; if (col === 4) cell.alignment = CENTER; break;
      case 'info': cell.font = font({ bold: col === 0 }); cell.border = { top: THIN, bottom: THIN }; if (col === 4) cell.alignment = CENTER; break;
      case 'phead': cell.fill = fill('FFFFCC'); cell.font = font(); cell.border = prodBorder(col, DBL, THIN); cell.alignment = CENTER; break;
      case 'pval': cell.fill = fill('FFFFCC'); cell.border = prodBorder(col, THIN, THICK); cell.alignment = { horizontal: 'center', vertical: 'middle' };
        cell.font = col <= 1 ? font({ bold: true, u: true, color: 'FF0000FF' }) : font(); break;
      case 'lhead': cell.fill = fill('DDEBF7'); cell.font = font({ bold: col <= 3 }); cell.border = prodBorder(col, undefined, THIN); cell.alignment = CENTER; break;
      case 'item': case 'item_gpl': cell.font = font({ bold: kind === 'item_gpl' && col <= 2 }); cell.border = prodBorder(col, THIN, THIN); if (col !== 3) cell.alignment = CENTER; break;
      case 'sub': cell.fill = fill('F2F2F2'); cell.font = font({ bold: col === 1 || col === 2 }); cell.border = prodBorder(col, THIN, DBL); if (col === 0 || col === 2 || col === 4) cell.alignment = CENTER; break;
      case 'stitle': case 'cat': cell.font = font({ size: col === 0 ? 12 : 11, bold: col === 0 }); if (col === 0) cell.alignment = { horizontal: 'left' }; break;
      case 'shead': cell.fill = fill('DDEBF7'); cell.font = font({ bold: true }); cell.border = { left: THIN, right: THIN, top: THIN, bottom: THIN }; cell.alignment = CENTER; break;
      case 'sitem': case 'sitem_gpl': cell.fill = fill('FFF2CC'); cell.font = font({ bold: kind === 'sitem_gpl' && col <= 2 }); cell.border = { left: THIN, right: THIN, top: THIN, bottom: THIN }; if (col <= 2) cell.alignment = CENTER; break;
      default: cell.font = font();
    }
  }
  var STYLED_COLS = { title: 5, info: 5, phead: 5, pval: 5, lhead: 5, item: 5, item_gpl: 5, sub: 5, shead: 4, sitem: 4, sitem_gpl: 4, stitle: 1, cat: 1 };
  // 重量・注文書の列(2026-11-25): 製品の表は G・H、総まとめは E・G・H・K・L。枠は細線
  var EXTRA_COLS = { lhead: [6, 7], item: [6, 7], item_gpl: [6, 7], sub: [6, 7], shead: [4, 6, 7, 10, 11], sitem: [4, 6, 7, 10, 11], sitem_gpl: [4, 6, 7, 10, 11] };
  var RED = 'FFFF0000';
  function styleExtra(cell, kind, red) {
    var box = { left: THIN, right: THIN, top: THIN, bottom: THIN };
    cell.border = kind === 'sub' ? { left: THIN, right: THIN, top: THIN, bottom: DBL } : box;
    cell.alignment = CENTER;
    if (kind === 'lhead') { cell.fill = fill('DDEBF7'); cell.font = font({ bold: true }); }
    else if (kind === 'shead') { cell.fill = fill('DDEBF7'); cell.font = font({ bold: true }); }
    else if (kind === 'sub') { cell.fill = fill('F2F2F2'); cell.font = font({ bold: true }); }
    else { if (kind === 'sitem' || kind === 'sitem_gpl') cell.fill = fill('FFF2CC'); cell.font = font({ color: red ? RED : undefined }); }
  }

  function buildStandard(ExcelJS, head, products, multi, orders) {
    var wb = new ExcelJS.Workbook();
    var lay = addStandardSheet(wb, '金物リスト', head, products, multi, orders);
    return { wb: wb, layout: lay };
  }
  // 1枚のシート(標準の様式)を wb に足す。次の加工予定では工事ごとに1枚(シート名は工事番号。2026-11-20)
  function addStandardSheet(wb, sheetName, head, products, multi, orders) {
    var lay = layout(head, products, multi, orders);
    var ws = wb.addWorksheet(sheetName, {
      // E列の幅9は ExcelJS が既定値として書かないので、シートの既定の列幅を9にして合わせる
      properties: { defaultRowHeight: DEF_H, defaultColWidth: 9 },
      pageSetup: { paperSize: 9, orientation: 'portrait', fitToPage: true, fitToWidth: 1, fitToHeight: 0, scale: 96,
        margins: { left: 0.748031496062992, right: 0.748031496062992, top: 0.984251968503937, bottom: 0.984251968503937, header: 0.511811023622047, footer: 0.511811023622047 },
        printTitlesRow: '1:4' }
    });
    // E は総まとめの注文番号(「172_173」など)も入るので 9 → 14。F・I・J は空き。G・H = 重量、K・L = 手配総数・差し引き(2026-11-25)
    ws.columns = [{ width: 20.625 }, { width: 20.625 }, { width: 20.625 }, { width: 20.625 }, { width: 14 }, { width: 2 }, { width: 10 }, { width: 10 }, { width: 2 }, { width: 2 }, { width: 9 }, { width: 9 }];
    lay.rows.forEach(function (r, i) {
      var row = ws.getRow(i + 1);
      if (HT[r.kind]) row.height = HT[r.kind];
      var n = STYLED_COLS[r.kind] || 0, ex = EXTRA_COLS[r.kind] || [];
      for (var c = 0; c < 12; c++) {
        var cell = row.getCell(c + 1), v = r.vals[c];
        if (v !== undefined && v !== null && v !== '') {
          if (r.kind === 'pval' && c <= 1 && r.link) cell.value = { text: String(v), hyperlink: r.link };
          else cell.value = v;
        }
        if (c < n) styleCell(cell, r.kind, c);
        else if (ex.indexOf(c) >= 0) styleExtra(cell, r.kind, r.short && c === 11);
        else cell.font = font();
        // 注文書より使う枚数が多い符号は、製品の表の枚数を赤に(2026-11-25 ユーザー指示)
        if (r.short && c === 2 && (r.kind === 'item' || r.kind === 'item_gpl')) cell.font = Object.assign({}, cell.font, { color: { argb: RED } });
      }
    });
    ws.mergeCells('B2:D2'); ws.mergeCells('B3:D3');
    [2, 3].forEach(function (r) { for (var c = 2; c <= 4; c++) styleCell(ws.getRow(r).getCell(c), 'info', c - 1); });
    lay.breaks.forEach(function (b) { ws.getRow(b).addPageBreak(); });
    ws.pageSetup.printArea = 'A1:L' + lay.rows.length;
    return lay;
  }

  // 次の加工予定の一覧のシート(tottori-production-status の予定表の黄色の行。2026-11-20)
  // rows: [{date, abbr, kojiNo, mark, zuban, qty, weight, link, status}]。製品名・図番に実寸法師へのリンク
  function addPlanSheet(wb, rows) {
    var ws = wb.addWorksheet('次の加工予定', { properties: { defaultRowHeight: DEF_H },
      pageSetup: { paperSize: 9, orientation: 'landscape', fitToPage: true, fitToWidth: 1, fitToHeight: 0, printTitlesRow: '1:2' } });
    ws.columns = [{ width: 12 }, { width: 10 }, { width: 10 }, { width: 24 }, { width: 7 }, { width: 9 }, { width: 18 }, { width: 34 }];
    var t = ws.getRow(1); t.getCell(1).value = '次の加工予定'; t.getCell(1).font = font({ size: 14, bold: true }); t.height = HT.title;
    var hd = ['予定日', '件名', '工事番号', '製品名', '台数', '重量(t)', '図番', '金物リスト'];
    var hr = ws.getRow(2);
    hd.forEach(function (h, i) { var c = hr.getCell(i + 1); c.value = h; c.fill = fill('DDEBF7'); c.font = font({ bold: true }); c.border = { left: THIN, right: THIN, top: THIN, bottom: THIN }; c.alignment = CENTER; });
    rows.forEach(function (r, i) {
      var row = ws.getRow(i + 3);
      var vals = [r.date || '', r.abbr || '', r.kojiNo || '', r.mark || '', r.qty, r.weight, r.zuban || '', r.status || ''];
      vals.forEach(function (v, c) {
        var cell = row.getCell(c + 1);
        if ((c === 3 || c === 6) && r.link && v) { cell.value = { text: String(v), hyperlink: r.link }; cell.font = font({ bold: true, u: true, color: 'FF0000FF' }); }
        else { cell.value = v === undefined ? '' : v; cell.font = font({ color: c === 7 && r.status && !/^作成/.test(r.status) ? 'FFC00000' : undefined }); }
        cell.border = { left: THIN, right: THIN, top: THIN, bottom: THIN };
        if (c !== 7) cell.alignment = CENTER;
      });
    });
    ws.pageSetup.printArea = 'A1:H' + (rows.length + 2);
  }
  // 次の加工予定のExcel: 1枚目=次の加工予定の一覧、2枚目から=工事ごとの金物リスト(シート名は工事番号)
  // groups: [{sheet, head, products, orders}]
  function buildPlan(ExcelJS, planRows, groups) {
    var wb = new ExcelJS.Workbook();
    addPlanSheet(wb, planRows);
    var layouts = groups.map(function (g) { return { sheet: g.sheet, layout: addStandardSheet(wb, g.sheet, g.head, g.products, true, g.orders) }; });
    return { wb: wb, layouts: layouts };
  }

  var FORMATS = { '本社': buildStandard, '夢前': buildStandard, '鳥取': buildStandard };
  function build(ExcelJS, factory, head, products, multi, orders) { return (FORMATS[factory] || buildStandard)(ExcelJS, head, products, multi, orders); }

  var api = { layout: layout, toValues: toValues, build: build, buildPlan: buildPlan, unitWeight: unitWeight, checkMarks: checkMarks, kgPerM: kgPerM };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else root.KanamonoExcel = api;
})(typeof window !== 'undefined' ? window : this);
