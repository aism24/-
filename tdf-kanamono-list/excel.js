// 金物リストのExcelを作る(様式は docs/apps/tdf-kanamono-list.md。ユーザーの見本ファイルとセル単位で合わせた)。
// 工場ごとに様式を変えられるよう、FORMATS[工場] で作り方を選ぶ(2026-11-19時点は3工場とも同じ様式)。
// レイアウト(layout)は、ExcelJS で書く処理と、GASのデータシート(値だけ)の両方で使う。
(function (root) {
  'use strict';
  var X = (typeof module !== 'undefined' && module.exports) ? require('./extract.js') : root.KanamonoExtract;
  var FONT = 'ＭＳ Ｐゴシック';
  var HT = { title: 17.25, phead: 14.25, pval: 28.5, lhead: 14.25, sub: 14.25, blank: 15, stitle: 14.25, cat: 14.25, empty4: 14.25 };
  var DEF_H = 13.5;

  // products: [{zuban, name, size, length, dai, items:[{size,name,n,note}], link}]
  // 戻り値: { rows:[{kind, vals, link}], breaks:[行番号(この行の後で改ページ)] }
  function layout(head, products, multi) {
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
        { kind: 'lhead', vals: ['サイズ', '切板名（長さ）', '枚数（本数）', '備考'] }
      ];
      var s = 0;
      p.items.filter(function (it) { return it.n > 0; }).slice().sort(X.cmpItem).forEach(function (it) {
        b.push({ kind: X.kindOf(it.size) === 'GPL' ? 'item_gpl' : 'item', vals: [it.size, it.name, it.n, it.note || null] });
        s += it.n;
        var k = it.size + '|' + it.name + '|' + (it.note || '');
        if (!tot[k]) tot[k] = { size: it.size, name: it.name, n: 0, note: it.note || '' };
        tot[k].n += it.n;
      });
      b.push({ kind: 'sub', vals: [null, '小計', s] });
      blocks.push({ rows: b, type: 'prod' });
    });
    var cats = [['GPL', 'GPL'], ['他', 'PL'], ['鋼材', 'STEEL']];
    var sblocks = [];
    cats.forEach(function (c) {
      var its = Object.keys(tot).map(function (k) { return tot[k]; }).filter(function (t) { return X.kindOf(t.size) === c[1]; }).sort(X.cmpItem);
      if (!its.length) return;
      var sb = [{ kind: 'cat', vals: [c[0]] }, { kind: 'shead', vals: ['サイズ', '切板名（長さ）', '枚数（本数）', '備考'] }];
      its.forEach(function (t) { sb.push({ kind: c[1] === 'GPL' ? 'sitem_gpl' : 'sitem', vals: [t.size, t.name, t.n, t.note || null] }); });
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
      rows = rows.concat(withSep); used += h(withSep);
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
  var STYLED_COLS = { title: 5, info: 5, phead: 5, pval: 5, lhead: 5, item: 5, item_gpl: 5, sub: 5, shead: 5, sitem: 5, sitem_gpl: 5, stitle: 1, cat: 1 };

  function buildStandard(ExcelJS, head, products, multi) {
    var wb = new ExcelJS.Workbook();
    var lay = addStandardSheet(wb, '金物リスト', head, products, multi);
    return { wb: wb, layout: lay };
  }
  // 1枚のシート(標準の様式)を wb に足す。次の加工予定では工事ごとに1枚(シート名は工事番号。2026-11-20)
  function addStandardSheet(wb, sheetName, head, products, multi) {
    var lay = layout(head, products, multi);
    var ws = wb.addWorksheet(sheetName, {
      // E列の幅9は ExcelJS が既定値として書かないので、シートの既定の列幅を9にして合わせる
      properties: { defaultRowHeight: DEF_H, defaultColWidth: 9 },
      pageSetup: { paperSize: 9, orientation: 'portrait', fitToPage: true, fitToWidth: 1, fitToHeight: 0, scale: 96,
        margins: { left: 0.748031496062992, right: 0.748031496062992, top: 0.984251968503937, bottom: 0.984251968503937, header: 0.511811023622047, footer: 0.511811023622047 },
        printTitlesRow: '1:4' }
    });
    ws.columns = [{ width: 20.625 }, { width: 20.625 }, { width: 20.625 }, { width: 20.625 }, { width: 9 }];
    lay.rows.forEach(function (r, i) {
      var row = ws.getRow(i + 1);
      if (HT[r.kind]) row.height = HT[r.kind];
      var n = STYLED_COLS[r.kind] || 0;
      for (var c = 0; c < 5; c++) {
        var cell = row.getCell(c + 1), v = r.vals[c];
        if (v !== undefined && v !== null && v !== '') {
          if (r.kind === 'pval' && c <= 1 && r.link) cell.value = { text: String(v), hyperlink: r.link };
          else cell.value = v;
        }
        if (c < n) styleCell(cell, r.kind, c); else cell.font = font();
      }
    });
    ws.mergeCells('B2:D2'); ws.mergeCells('B3:D3');
    [2, 3].forEach(function (r) { for (var c = 2; c <= 4; c++) styleCell(ws.getRow(r).getCell(c), 'info', c - 1); });
    lay.breaks.forEach(function (b) { ws.getRow(b).addPageBreak(); });
    ws.pageSetup.printArea = 'A1:E' + lay.rows.length;
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
  // groups: [{sheet, head, products}]
  function buildPlan(ExcelJS, factory, planRows, groups) {
    var wb = new ExcelJS.Workbook();
    addPlanSheet(wb, planRows);
    var layouts = groups.map(function (g) { return { sheet: g.sheet, layout: addStandardSheet(wb, g.sheet, g.head, g.products, true) }; });
    return { wb: wb, layouts: layouts };
  }

  var FORMATS = { '本社': buildStandard, '夢前': buildStandard, '鳥取': buildStandard };
  function build(ExcelJS, factory, head, products, multi) { return (FORMATS[factory] || buildStandard)(ExcelJS, head, products, multi); }

  var api = { layout: layout, toValues: toValues, build: build, buildPlan: buildPlan };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else root.KanamonoExcel = api;
})(typeof window !== 'undefined' ? window : this);
