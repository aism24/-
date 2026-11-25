// 短管リストの Excel を作る(ExcelJS)。ひな形 template/tankan-template.xlsx の「階」シートの表A・表Bを写して値を入れる。
// 決まりはローカルの Python 版(build_all.py・draw_all.py)と同じ。ブラウザでも Node.js(試験用。絵は貼らない)でも動く。
//   表A = 3〜16行目(サイズ1つの柱)、表B = 17〜32行目(サイズ3つ。テーパーの柱)。どちらも
//   サイズの行(ns行) → コラム長さの行(rr) → 「板マーク・板厚・重量」の行 → 板の行9行 → 合計の行2行
(function (root) {
  'use strict';
  const EXCELJS_URL = 'https://cdnjs.cloudflare.com/ajax/libs/exceljs/4.4.0/exceljs.min.js';
  const TEMPLATE_URL = 'template/tankan-template.xlsx?v=20261125a';
  const NCOL = 24;                                   // A〜X
  const PROTO = { 1: { top: 3, ns: 1 }, 3: { top: 17, ns: 3 } };
  const YEL = 'FFFFFF99', ORG = 'FFFFCC66';        // 図面と手配書が合わない(黄色)・図面から取れない(橙色)
  const PAGE_ROWS = 58;                              // 1ページに入れる行の上限(A4縦・見出し2行を除く。提出済みExcelの改ページと同じくらい)

  let ExcelJS = root.ExcelJS || null, tplBuf = null, UW = null;

  function loadScript(src) {
    return new Promise((res, rej) => { const s = document.createElement('script'); s.src = src; s.onload = res; s.onerror = () => rej(new Error('Excelを作る部品を読み込めませんでした')); document.head.appendChild(s); });
  }
  // ExcelJS とひな形を読む(単重表もここで読む)。何度呼んでも1回だけ
  let prepP = null;
  function prepare(opts) {
    if (prepP) return prepP;
    prepP = (async () => {
      if (opts && opts.ExcelJS) ExcelJS = opts.ExcelJS;
      if (!ExcelJS) { await loadScript(EXCELJS_URL); ExcelJS = root.ExcelJS; }
      if (opts && opts.template) tplBuf = opts.template;
      else { const r = await fetch(TEMPLATE_URL); if (!r.ok) throw new Error('ひな形を読み込めませんでした'); tplBuf = await r.arrayBuffer(); }
      const wb = new ExcelJS.Workbook(); await wb.xlsx.load(tplBuf);
      UW = {};
      wb.getWorksheet('板').eachRow((row, n) => { const a = row.getCell(1).value, b = row.getCell(2).value; if (n > 1 && a && typeof b === 'number') UW[String(a)] = b; });
    })();
    prepP.catch(() => { prepP = null; });
    return prepP;
  }

  // 角形鋼管の単重(kg/m)。テーパーは中間サイズの単重(build_all.py の unit_w)
  function unitW(size) {
    if (!UW) return null;
    const m = /^□-(\d+)-(\d+)\*\d+-\d+\*(\d+)$/.exec(size || '');
    if (m) { const a = Math.floor((+m[1] + +m[2]) / 2); return UW[`□-${a}*${a}*${m[3]}`] || null; }
    return UW[size] || null;
  }
  // 小数第2位に丸める。Python の round と同じ結果にするため、v*100 を Math.round せず toFixed を使う(366.885 → 366.88)
  const r2 = v => Number(v.toFixed(2));
  function sizesOf(segs) { return segs.map(s => s[0]).filter((s, j, a) => j === 0 || s !== a[j - 1]); }
  // 短管の重量: サイズ1つなら 単重×長さの合計、サイズが複数なら区間ごと
  function pipeWeights(segs) {
    const sizes = sizesOf(segs);
    if (sizes.length === 1) { const uw = unitW(sizes[0]); return [{ uw, w: uw ? r2(uw * segs.reduce((a, s) => a + (s[1] || 0), 0) / 1000) : null }]; }
    return segs.map(s => { const uw = unitW(s[0]); return { uw, w: uw ? r2(uw * (s[1] || 0) / 1000) : null }; });
  }
  function plateInfo(m, t, verify) {
    const v = verify[m];
    if (!v) return { t, w: null, ng: true };
    return { t: v.t_csv && v.t_csv.length ? v.t_csv[0] : v.t_dwg, w: v.weight, ng: !v.ok };
  }
  // 柱1本の重量(短管+板)。画面の表と Excel の合計で同じ
  function groupWeight(g, verify) {
    const b = g.block;
    if (!b.segs || !UW) return null;
    let s = 0;
    pipeWeights(b.segs).forEach(p => { s += p.w || 0; });
    b.plates.forEach(([m, t]) => { s += plateInfo(m, t, verify).w || 0; });
    return r2(s);
  }
  // 板の行(9行)のどこに板マークを置くか(上から)
  function platePos(k) {
    if (k <= 1) return [0];
    if (k === 2) return [0, 8];
    if (k === 3) return [0, 4, 8];
    if (k === 4) return [0, 2, 6, 8];
    if (k === 5) return [0, 2, 4, 6, 8];
    return Array.from({ length: Math.min(k, 9) }, (_, i) => Math.round(i * 8 / (Math.min(k, 9) - 1)));
  }

  const clone = o => JSON.parse(JSON.stringify(o || {}));
  const isPlaceholder = v => typeof v === 'string' && v.includes('{');
  function copyRows(tpl, merges, src, n, ws, dst) {
    for (let i = 0; i < n; i++) {
      const sr = tpl.getRow(src + i), dr = ws.getRow(dst + i);
      if (sr.height) dr.height = sr.height;
      for (let c = 1; c <= NCOL; c++) {
        const s = sr.getCell(c), d = dr.getCell(c);
        d.style = clone(s.style);
        const v = s.value;
        if (v !== null && v !== undefined && typeof v !== 'object' && !isPlaceholder(v)) d.value = v;   // 見出しの文字・数字だけ(式と置き換え文字は写さない)
      }
    }
    merges.forEach(m => {
      if (m.top >= src && m.bottom < src + n) ws.mergeCells(m.top - src + dst, m.left, m.bottom - src + dst, m.right);
    });
  }
  function parseMerges(tpl) {
    const col = s => s.split('').reduce((a, ch) => a * 26 + ch.charCodeAt(0) - 64, 0);
    return (tpl.model.merges || []).map(r => {
      const m = /^([A-Z]+)(\d+):([A-Z]+)(\d+)$/.exec(r);
      return m && { left: col(m[1]), top: +m[2], right: col(m[3]), bottom: +m[4] };
    }).filter(Boolean);
  }
  // 結合セルの中の左上以外には書かない(書くと左上の値が変わる)
  function put(ws, addr, v, fill) {
    const c = ws.getCell(addr);
    if (c.isMerged && c.master && c.master.address !== c.address) return;
    c.value = v;
    if (fill) c.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: fill } };
  }
  function linkCell(ws, addr, text, url) {
    const c = ws.getCell(addr);
    if (url) { c.value = { text, hyperlink: url }; c.font = Object.assign(clone(c.font), { color: { argb: 'FF0000FF' }, underline: true }); }
    else c.value = text;
  }

  // ---------- 絵(ブラウザだけ) ----------
  const colPx = w => Math.floor((w || 9) * 7 + 5);
  const rowPx = h => (h || 15) * 96 / 72;
  // 短管の絵(draw_all.py と同じ描き方): 板=四角、短管=実線と点線(テーパーは斜め)、3枚以上は上の板からの寸法、内ダイアは点線の四角
  function pipePng(b, Wpx, Hpx) {
    const S = 3, cv = document.createElement('canvas'); cv.width = Math.round(Wpx * S); cv.height = Math.round(Hpx * S);
    const x = cv.getContext('2d'); x.scale(S, S); x.lineWidth = 1; x.strokeStyle = '#000'; x.fillStyle = '#000';
    const plates = b.plates.slice().reverse(), segs = b.segs;   // 下→上
    const outer = plates.filter(p => !p[0].startsWith('OUDY'));
    const L0 = 1, W = Wpx - 3, T0 = 1, H = Hpx - 3, pt = 7 * 96 / 72;
    const hs = [];
    outer.forEach((p, k) => { hs.push(['P', p[1] || 0]); if (k < segs.length) hs.push(['S', (segs[k][1] || 0) + ((segs[k][0] || '').startsWith('□') ? 10 : 0), segs[k][0]]); });
    const tot = hs.reduce((a, h) => a + h[1], 0) || 1;
    const scale = (H - pt * outer.length) / Math.max(tot - outer.reduce((a, p) => a + (p[1] || 0), 0), 1);
    let y = T0 + H; const ys = [];
    hs.forEach(([kind, v, info]) => {
      if (kind === 'P') { y -= pt; x.setLineDash([]); x.strokeRect(L0, y, W, pt); ys.push(y); return; }
      const hseg = v * scale, ytop = y - hseg, tp = /^□-(\d+)-(\d+)\*/.test(info || '');
      [1, -1].forEach(sgn => {
        const xb = L0 + W / 2 - sgn * W * (tp ? 0.40 : 0.37), xt = L0 + W / 2 - sgn * W * (tp ? 0.33 : 0.37);
        x.setLineDash([]); x.lineWidth = 1; x.beginPath(); x.moveTo(xb, y); x.lineTo(xt, ytop); x.stroke();
        x.setLineDash([3, 2]); x.lineWidth = 0.7; x.beginPath(); x.moveTo(xb + sgn * 5, y); x.lineTo(xt + sgn * 5, ytop); x.stroke();
      });
      y = ytop;
    });
    x.setLineDash([]); x.lineWidth = 1;
    const ch = b.chain || [];
    if (outer.length > 2 && ch.length === outer.length - 1) {   // 上の板から中間の板までの寸法
      // 端の●: 上側=いちばん上の板の上面、下側=相手の板の下面(板の中心ではない)
      const ytop = ys[ys.length - 1];
      for (let j = outer.length - 2; j > 0; j--) {
        const dist = ch.slice(j).reduce((a, v) => a + v, 0), xx = L0 + W * (0.42 + 0.16 * (outer.length - 2 - j));
        const yb = ys[j] + pt;
        x.beginPath(); x.moveTo(xx, ytop); x.lineTo(xx, yb); x.stroke();
        [ytop, yb].forEach(yy => { x.beginPath(); x.arc(xx, yy, 3, 0, Math.PI * 2); x.fill(); });
        x.save(); x.translate(xx - 3, (ytop + yb) / 2); x.rotate(-Math.PI / 2); x.font = '11px sans-serif'; x.textAlign = 'center';
        x.fillText(String(Math.round(dist * 10) / 10), 0, 0); x.restore();
      }
    }
    plates.forEach((p, k) => {   // 内ダイア(OUDY): 区切らない板は、その区間の中ほどに点線の四角
      if (!p[0].startsWith('OUDY') || k === 0 || k === plates.length - 1) return;
      const below = plates.slice(0, k).filter(q => !q[0].startsWith('OUDY')).length;
      if (below > 0 && below <= ys.length - 1) { const yy = (ys[below - 1] + ys[below]) / 2; x.setLineDash([3, 2]); x.strokeRect(L0 + W * 0.18, yy, W * 0.64, pt * 0.8); x.setLineDash([]); }
    });
    return cv.toDataURL('image/png');
  }
  // 板の線画(SVG)を PNG に(黒い枠)
  function svgPng(svg) {
    return new Promise((res, rej) => {
      const img = new Image();
      // 縦横の比は SVG の viewBox から(width・height の mm 指定は画像にするとき使えないので置き換える)
      const vb = /viewBox="0 0 ([\d.]+) ([\d.]+)"/.exec(svg), ar = vb ? (+vb[1] / +vb[2]) : 1;
      img.onload = () => {
        // 高さ 80pt(板の行7行に収める。90pt では印刷・PDF で下の表に少しはみ出した)
        const Hh = 80 * 96 / 72, Ww = Hh * ar, S = 3;
        const cv = document.createElement('canvas'); cv.width = Math.round(Ww * S); cv.height = Math.round(Hh * S);
        const x = cv.getContext('2d'); x.fillStyle = '#fff'; x.fillRect(0, 0, cv.width, cv.height);
        x.drawImage(img, 0, 0, cv.width, cv.height); x.lineWidth = 2; x.strokeStyle = '#000'; x.strokeRect(1, 1, cv.width - 2, cv.height - 2);
        res({ data: cv.toDataURL('image/png'), w: Ww, h: Hh });
      };
      img.onerror = () => rej(new Error('板の絵を画像にできませんでした'));
      img.src = 'data:image/svg+xml;charset=utf-8,' + encodeURIComponent(svg.replace(/width="[^"]*mm" height="[^"]*mm"/, `width="${Math.round(800 * ar)}" height="800"`).replace(/font-family="MS Gothic"/g, 'font-family="MS Gothic, sans-serif"'));
    });
  }

  // ---------- 本体 ----------
  // args: {res: tankan_core.run の結果, kojiName, factory, link(ファイル名) → file:// の URL, onProgress(文, 0〜1), images(既定 true)}
  async function build(args) {
    await prepare();
    const { res, kojiName, factory } = args;
    const link = args.link || (() => '');
    const images = args.images !== false && typeof document !== 'undefined';
    const prog = args.onProgress || (() => {});
    const tw = new ExcelJS.Workbook(); await tw.xlsx.load(tplBuf);
    const tpl = tw.getWorksheet('階'), merges = parseMerges(tpl);
    const out = new ExcelJS.Workbook();
    out.creator = ''; out.title = '短管リスト';
    const floors = Object.keys(res.floors).sort();
    const nAll = floors.reduce((a, fl) => a + res.floors[fl].length, 0);
    let done = 0;
    for (const fl of floors) {
      const ws = out.addWorksheet(fl, { pageSetup: clone(tpl.pageSetup), views: clone(tpl.views), properties: clone(tpl.properties), headerFooter: clone(tpl.headerFooter) });
      for (let c = 1; c <= NCOL; c++) { const w = tpl.getColumn(c).width; if (w) ws.getColumn(c).width = w; }
      copyRows(tpl, merges, 1, 2, ws, 1);
      put(ws, 'B1', kojiName || ''); put(ws, 'P1', fl.replace(/L$/, ''));
      put(ws, 'R1', '●シーム方向：特記外 '); put(ws, 'R2', '●ダイア出寸法：特記外 ');
      put(ws, 'W1', factory ? factory + '工場' : '');
      let r = 3, acc = 0;
      for (const [gi, g] of res.floors[fl].entries()) {
        prog(`Excelを作っています…\n${fl} ${g.members[0] ? g.members[0].sym : ''}`, 0.05 + 0.85 * done / Math.max(nAll, 1)); done++;
        const b = g.block, segs = b.segs || [];
        const sizes = b.segs ? sizesOf(segs) : [b.size];
        const proto = PROTO[sizes.length === 1 ? 1 : 3], ns = proto.ns, h = ns + 13;
        if (acc && acc + h > PAGE_ROWS) { ws.getRow(r - 1).addPageBreak(); acc = 0; }
        acc += h;
        copyRows(tpl, merges, proto.top, h, ws, r);
        const rr = r + ns, f1 = rr + 11, f2 = rr + 12;
        put(ws, `A${r}`, gi + 1);
        put(ws, `B${r}`, { formula: `IF(J${rr}="","",$P$1&$A$1&A${r})`, result: `${fl.replace(/L$/, '')}-${gi + 1}` });
        let sumQ = 0;
        if (!b.segs) {
          for (let k = r; k < rr; k++) put(ws, `J${k}`, null, ORG);
          put(ws, `J${rr}`, null, ORG); put(ws, `B${rr + 6}`, null, ORG);
        } else {
          sizes.forEach((s, k) => put(ws, `J${r + k}`, s));
          [['J', rr], ['O', rr], ['P', rr], ['J', rr + 1]].forEach(([c, q], k) => { if (k < segs.length) put(ws, `${c}${q}`, segs[k][1]); });
          put(ws, `B${rr + 6}`, b.fin);
          const pw = pipeWeights(segs);
          pw.forEach((p, k) => {
            if (ns > 1) put(ws, `P${r + k}`, p.uw);
            put(ws, `Q${r + k}`, p.w, p.w === null ? ORG : null);
            sumQ += p.w || 0;
          });
        }
        // 板(上→下)
        const pos = platePos(b.plates.length);
        const markRow = {};
        b.plates.forEach(([m, t], k) => {
          if (k >= pos.length) return;
          const q = rr + 2 + pos[k], pi = plateInfo(m, t, res.verify);
          markRow[m] = q;
          put(ws, `O${q}`, m); put(ws, `P${q}`, pi.t); put(ws, `Q${q}`, pi.w, pi.ng ? YEL : null);
          sumQ += pi.w || 0;
        });
        put(ws, `Q${f1}`, { formula: `SUM(Q${r}:Q${rr - 1},Q${rr + 2}:Q${rr + 10})`, result: r2(sumQ) });
        // 柱符号(R列→S列)と、大組図を開くリンク(V=図面番号・W=A付き図面番号・X=製品名。柱符号1つにつき1行)
        g.members.forEach((mb, i) => {
          put(ws, `${i < 3 ? 'R' : 'S'}${r + (i % 3)}`, mb.sym);
          const no = mb.dwg.split('-').pop(), fn = res.files.full[no], fa = res.files.sec[no];
          linkCell(ws, `V${r + i}`, mb.dwg, fn ? link(fn) : '');
          linkCell(ws, `W${r + i}`, mb.dwg + 'A', fa ? link(fa) : '');
          linkCell(ws, `X${r + i}`, mb.sym, fn ? link(fn) : '');
        });
        put(ws, `O${f2}`, { formula: `COUNTA(R${r}:S${r + 2})`, result: g.members.length });
        put(ws, `Q${f2}`, { formula: `Q${f1}*O${f2}`, result: r2(sumQ * g.members.length) });
        // PL形状注意(draw_all.py と同じ並び。odd は下→上)
        const odd = g.odd || [];
        let place = [];
        if (odd.length === 1) place = [[odd[0], 'T', r + 7, '']];
        else if (odd.length === 2) place = [[odd[0], 'R', r + 7, ' ①'], [odd[1], 'T', r + 7, ' ②']];
        else if (odd.length > 2) place = [[odd[0], 'R', r + 9, ' ①'], [odd[odd.length - 1], 'T', r + 3, ' ②']]
          .concat(odd.slice(1, -1).slice(0, 2).map((o, k) => [o, k ? 'R' : 'T', r + (k ? 15 : 9), ` ${'③④'[k]}`]));
        for (const [o, c, q, lab] of place) {
          put(ws, `${c}${q - 1}`, '※　PL形状注意' + lab);
          if (markRow[o.mark]) put(ws, `C${markRow[o.mark]}`, '※' + lab.trim());
          if (images && o.svg) {
            const im = await svgPng(o.svg);
            const id = out.addImage({ base64: im.data, extension: 'png' });
            const ci = c.charCodeAt(0) - 65;
            ws.addImage(id, { tl: { col: ci + 8.5 / (colPx(ws.getColumn(ci + 1).width) * 0.75), row: q - 1 + 3 / ((ws.getRow(q).height || 14.25)) }, ext: { width: im.w, height: im.h } });
          }
        }
        // 短管の絵(D〜M列 × 板の行)
        if (images && b.segs) {
          let wpx = 0, hpx = 0;
          for (let c = 4; c <= 13; c++) wpx += colPx(ws.getColumn(c).width);
          for (let q = rr + 2; q < f1; q++) hpx += rowPx(ws.getRow(q).height);
          const id = out.addImage({ base64: pipePng(b, wpx, hpx), extension: 'png' });
          ws.addImage(id, { tl: { col: 3, row: rr + 1 }, br: { col: 13, row: f1 - 1 }, editAs: 'oneCell' });
        }
        r += h;
      }
      ws.pageSetup.printArea = `B1:U${r - 1}`;
      ws.pageSetup.printTitlesRow = '1:2';
    }
    // 板シート: この節の柱ダイアの手配書CSVの行を、列も含めてそのまま
    prog('Excelを作っています…(板・照合)', 0.92);
    const ps = out.addWorksheet('板');
    const pr = res.plate_rows;
    ps.addRow(pr.header); pr.rows.forEach(row => ps.addRow(row.map(v => String(v))));
    ps.getRow(1).font = { bold: true };
    pr.header.forEach((hd, i) => { ps.getColumn(i + 1).width = Math.min(40, Math.max(8, String(hd).length * 2 + 2)); });
    // 照合シート: ①図面から計算 ②手配書と照合 ③転記した重量
    const vs = out.addWorksheet('照合');
    const hd = ['板マーク', '図面 板厚', '図面 外形(短辺)', '図面 外形(長辺)', '①図面から計算した重量', '図面 使用枚数',
      '手配 板厚', '手配 縦×横', '手配 枚数', '手配 ネット(1枚)', '手配 グロス(1枚)', '注文', '②照合', '③Excelに転記した重量'];
    vs.addRow(hd); vs.getRow(1).font = { bold: true };
    const g_ = v => String(v);
    Object.entries(res.verify).forEach(([m, v]) => {
      const row = vs.addRow([m, v.t_dwg, v.dim ? v.dim[0] : '', v.dim ? v.dim[1] : '', v.calc, v.use,
        v.t_csv ? v.t_csv.map(g_).join('/') : '', v.ab ? v.ab.map(([a, b]) => `${a}x${b}`).join('/') : '', v.n,
        v.net ? v.net.map(g_).join('/') : '', v.gross ? v.gross.map(g_).join('/') : '', v.files.join(' '),
        v.ok ? 'OK' : '要確認: ' + v.ng.join('; '), v.weight].map(x => x === null || x === undefined ? '' : x));
      if (!v.ok) row.eachCell({ includeEmpty: true }, c => { c.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: YEL } }; });
    });
    hd.forEach((h_, i) => { vs.getColumn(i + 1).width = Math.max(10, h_.length * 2); });
    prog('Excelを保存しています…', 0.97);
    const buf = await out.xlsx.writeBuffer();
    return typeof Blob !== 'undefined' ? new Blob([buf], { type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' }) : buf;
  }

  const api = { prepare, build, groupWeight, unitW, platePos };
  root.TankanExcel = api;
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
})(typeof window !== 'undefined' ? window : globalThis);
