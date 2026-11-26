// 短管リストの Excel を作る(ExcelJS)。ひな形 template/tankan-template.xlsx の「階」シートの表A・表Bを写して値を入れる。
// 決まりはローカルの Python 版(build_all.py・draw_all.py)と同じ。ブラウザでも Node.js(試験用。絵は貼らない)でも動く。
//   表A = 3〜16行目(サイズ1つの柱)、表B = 17〜32行目(サイズ3つ。テーパーの柱)。どちらも
//   サイズの行(ns行) → コラム長さの行(rr) → 「板マーク・板厚・重量」の行 → 板の行9行 → 合計の行2行
(function (root) {
  'use strict';
  const EXCELJS_URL = 'https://cdnjs.cloudflare.com/ajax/libs/exceljs/4.4.0/exceljs.min.js';
  const TEMPLATE_URL = 'template/tankan-template.xlsx?v=20261125b';
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
    if (UW[size]) return UW[size];
    // BH: ひな形の「板」シートに無いサイズは断面から(鋼 7.85t/m³、溶接・フィレットは含まない)
    const h = /^BH-(\d+)\*(\d+)\*([\d.]+)\*([\d.]+)$/.exec(size || '');
    if (h) { const [H, B, tw, tf] = h.slice(1).map(Number); return Number(((2 * B * tf + (H - 2 * tf) * tw) * 7.85 / 1000).toFixed(1)); }
    return null;
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
  // ダイア出寸法 = (図面で測った板の外形 − 接する角形の外寸) ÷ 2。板の並び(上→下)と同じ順に返す。
  //   図面の「30」「80」の文字は書き間違いがありうるので使わない。測れない板・内ダイア(OUDY)・形の違う板(PL形状注意の絵で示す)は null
  function sideOf(size, below) {   // 板に接する角形の外寸(テーパーは下側の板=1つ目の数字)
    let m = /^□-(\d+)-(\d+)\*/.exec(size || '');
    if (m) return +(below ? m[1] : m[2]);
    m = /^□-(\d+)\*/.exec(size || '');
    return m ? +m[1] : null;
  }
  function diaOut(b, verify, odd) {
    const segs = b.segs || [], pl = b.plates || [], n = segs.length;
    if (!n) return pl.map(() => null);
    const skip = new Set((odd || []).map(o => o.mark));
    return pl.map(([m], i) => {
      const k = pl.length - 1 - i;   // 下から何枚目か
      if (String(m).startsWith('OUDY') || skip.has(m)) return null;
      const col = sideOf((k < n ? segs[k] : segs[n - 1])[0], k < n);
      const d = verify[m] && verify[m].dim;
      if (!col || !d) return null;
      return Math.round((Math.min(d[0], d[1]) - col) / 2);
    });
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
  // 階ごとの表の並び(提出済みExcelと同じ): 角形が先・BHが後 → 外寸の大きい順 → 板厚の厚い順 → 1台の重量の重い順 → 図番順。
  //   (1節の正解で、□-800*32(単重730)が□-750*36(755)より先 = 単重ではなく外寸→板厚の順と判明)
  //   res.floors をその場で並べ替える(画面の表と Excel で同じ番号にするため、読み取り直後に1回呼ぶ)
  function sortFloors(res) {
    Object.values(res.floors || {}).forEach(gs => {
      const key = new Map(gs.map(g => {
        const b = g.block, segs = b.segs || [];
        // 柱の中でいちばん大きいサイズ(外寸, 板厚)。テーパーは大きい側の外寸
        const dims = (segs.length ? sizesOf(segs) : [b.size]).map(s => { const m = /^□-(\d+)(?:-\d+)?\*.*\*([\d.]+)$/.exec(s || ''); return m ? [+m[1], +m[2]] : [0, 0]; });
        const big = dims.reduce((p, d) => (d[0] > p[0] || (d[0] === p[0] && d[1] > p[1])) ? d : p, [0, 0]);
        return [g, [String(b.size || '').startsWith('BH') || !b.segs ? 1 : 0, -big[0], -big[1], -(groupWeight(g, res.verify) || 0), g.members.map(m => m.dwg).sort()[0] || '']];
      }));
      gs.sort((a, c) => {
        const x = key.get(a), y = key.get(c);
        for (let i = 0; i < 4; i++) if (x[i] !== y[i]) return x[i] - y[i];
        return x[4] < y[4] ? -1 : x[4] > y[4] ? 1 : 0;
      });
    });
    return res;
  }
  // 板の行(9行)のどこに板マークを置くか(上から)
  function platePos(k, b) {
    // 板5枚以上で内ダイア(OUDY)の無い柱: 図面の高さの割合で 0〜8 行目に置く(提出済みExcelと同じ。例 2CCY8CX2 4階 = 0,2,3,6,8)
    //   4枚以下は下の決まった並び(提出済みExcelはこちら。割合にすると合わなくなる)
    const segs = b && b.segs, pl = b && b.plates;
    if (segs && pl && pl.length === k && k >= 5 && segs.length === k - 1 && !pl.some(p => String(p[0]).startsWith('OUDY')) && segs.every(s => s[1] > 0)) {
      const fromTop = segs.map(s => s[1]).reverse(), tot = fromTop.reduce((a, v) => a + v, 0);
      let acc = 0; const out = [0];
      fromTop.forEach(v => { acc += v; out.push(Math.round(acc / tot * 8)); });
      for (let i = 1; i < out.length; i++) if (out[i] <= out[i - 1]) out[i] = out[i - 1] + 1;   // 同じ行に重ねない
      if (out[out.length - 1] <= 8) return out;
    }
    // 角形の柱で板3・4枚(内ダイア無し): 高さの割合で置き、板と板の間は2行以上あける(1節の正解。2節の 250/956/250 = 0,2,6,8 もこれで同じ)
    if (segs && pl && (k === 3 || k === 4) && pl.length === k && segs.length === k - 1 && !pl.some(p => String(p[0]).startsWith('OUDY'))
        && segs.every(s => s[1] > 0 && String(s[0] || '').startsWith('□'))) {
      const fromTop = segs.map(s => s[1]).reverse(), tot = fromTop.reduce((a, v) => a + v, 0);
      let acc = 0; const out = [0];
      fromTop.forEach(v => { acc += v; out.push(Math.round(acc / tot * 8)); });
      out[k - 1] = 8;
      for (let i = 1; i < k; i++) if (out[i] < out[i - 1] + 2) out[i] = out[i - 1] + 2;
      out[k - 1] = 8;
      for (let i = k - 2; i > 0; i--) if (out[i] > out[i + 1] - 2) out[i] = out[i + 1] - 2;
      if (out.every((v, i) => i === 0 || v >= out[i - 1] + 2)) return out;
    }
    if (k <= 1) return [0];
    if (k === 2) return [0, 8];
    if (k === 3) return [0, 4, 8];
    if (k === 4) return [0, 2, 6, 8];
    if (k === 5) return [0, 2, 4, 6, 8];
    return Array.from({ length: Math.min(k, 9) }, (_, i) => Math.round(i * 8 / (Math.min(k, 9) - 1)));
  }

  const clone = o => JSON.parse(JSON.stringify(o || {}));
  const isPlaceholder = v => typeof v === 'string' && v.includes('{');
  function copyRows(tpl, merges, src, n, ws, dst, styleOnly) {
    for (let i = 0; i < n; i++) {
      const sr = tpl.getRow(src + i), dr = ws.getRow(dst + i);
      if (sr.height) dr.height = sr.height;
      for (let c = 1; c <= NCOL; c++) {
        const s = sr.getCell(c), d = dr.getCell(c);
        d.style = clone(s.style);
        const v = s.value;
        if (!styleOnly && v !== null && v !== undefined && typeof v !== 'object' && !isPlaceholder(v)) d.value = v;   // 見出しの文字・数字だけ(式と置き換え文字は写さない)
      }
    }
    merges.forEach(m => {
      if (!(m.top >= src && m.bottom < src + n)) return;
      // ひな形の板の行にある R:S・T:U の結合は使わない(2026-11-26 ユーザー指示)。結合を外したセルの罫線は、すぐ上の行の同じ列にそろえる
      //   (結合のままの罫線だと R|S の間に太い線が出る)。見出しの R1:U1・R2:U2 は結合のまま
      if (m.left >= 18 && m.top > 2) {
        for (let q = m.top; q <= m.bottom; q++) for (let c = m.left; c <= m.right; c++)
          ws.getRow(q - src + dst).getCell(c).border = clone(tpl.getRow(m.top - 1).getCell(c).border);
        return;
      }
      ws.mergeCells(m.top - src + dst, m.left, m.bottom - src + dst, m.right);
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
    // 区間の太さ(幅に対する割合): サイズが1つの柱は 0.37。外寸が違う区間がある柱(テーパー等)は、外寸に合わせて 0.33(小さい側)〜0.40(大きい側)。
    // 2026-11-26 ユーザー指摘: 以前はまっすぐの区間をサイズに関係なく 0.37 で描き、下の□-800がテーパーの下端より細く、上の□-700が上端より太く見えた
    const dimsOf = s => { const m = /^□-(\d+)(?:-(\d+))?\*/.exec(s || ''); return m ? [+m[1], +(m[2] || m[1])] : null; };   // [下端, 上端]。テーパーは1つ目が下
    const allD = segs.map(s => dimsOf(s[0])), flat = allD.every(Boolean) ? allD.flat() : [];
    const dMax = flat.length ? Math.max(...flat) : 0, dMin = flat.length ? Math.min(...flat) : 0;
    const half = (d, tpFallback) => (dMax > dMin && d) ? 0.33 + 0.07 * (d - dMin) / (dMax - dMin) : tpFallback;
    const tot = hs.reduce((a, h) => a + h[1], 0) || 1;
    const scale = (H - pt * outer.length) / Math.max(tot - outer.reduce((a, p) => a + (p[1] || 0), 0), 1);
    let y = T0 + H; const ys = [];
    hs.forEach(([kind, v, info]) => {
      if (kind === 'P') { y -= pt; x.setLineDash([]); x.strokeRect(L0, y, W, pt); ys.push(y); return; }
      const hseg = v * scale, ytop = y - hseg, tp = /^□-(\d+)-(\d+)\*/.test(info || ''), dd = dimsOf(info) || [0, 0];
      const wb = half(dd[0], tp ? 0.40 : 0.37), wt = half(dd[1], tp ? 0.33 : 0.37);
      [1, -1].forEach(sgn => {
        const xb = L0 + W / 2 - sgn * W * wb, xt = L0 + W / 2 - sgn * W * wt;
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
  // 方位記号(案2: 丸+黒い矢じり+N)。deg = 北の向き(図面の右=0・反時計回り)。背景は透明(セルの罫線を隠さない)
  function northPng(deg, Wpx, Hpx) {
    const S = 3, cv = document.createElement('canvas'); cv.width = Math.round(Wpx * S); cv.height = Math.round(Hpx * S);
    const x = cv.getContext('2d'); x.scale(S, S);
    const a = deg * Math.PI / 180, dx = Math.cos(a), dy = -Math.sin(a);   // 画面は下向きがプラス
    const cx = Wpx / 2, cy = Hpx / 2, r = Math.min(Hpx, Wpx) * 0.46;
    const pt = (u, v) => [cx + (-dy * u + dx * v) * r, cy + (dx * u + dy * v) * r];   // v=北向き・u=北に向かって右の局所座標
    x.lineWidth = Math.max(1, r * 0.06); x.strokeStyle = '#000'; x.fillStyle = '#000';
    x.beginPath(); x.arc(cx, cy, r * 0.62, 0, Math.PI * 2); x.stroke();
    x.beginPath(); [[0, 0.72], [-0.26, -0.5], [0, -0.3], [0.26, -0.5]].forEach(([u, v], i) => { const [X, Y] = pt(u, v); i ? x.lineTo(X, Y) : x.moveTo(X, Y); }); x.closePath(); x.fill();
    x.font = `bold ${r * 0.52}px sans-serif`; x.textAlign = 'center'; x.textBaseline = 'middle';
    x.fillText('N', cx + dx * r * 0.98, cy + dy * r * 0.98);
    return cv.toDataURL('image/png');
  }
  // 板の線画(SVG)を PNG に(黒い枠)
  // maxW・maxH(px): 置ける枠の大きさ。縦横の比を保って枠いっぱいに(2026-11-26 ユーザー指摘: 高さ 80pt 固定では、
  //   サイズ1つの表で3枚のときに次の表の柱符号の上に重なり、7行ある所では小さすぎた)
  function svgPng(svg, maxW, maxH) {
    return new Promise((res, rej) => {
      const img = new Image();
      // 縦横の比は SVG の viewBox から(width・height の mm 指定は画像にするとき使えないので置き換える)
      const vb = /viewBox="0 0 ([\d.]+) ([\d.]+)"/.exec(svg), ar = vb ? (+vb[1] / +vb[2]) : 1;
      img.onload = () => {
        const mh = maxH || 80 * 96 / 72, mw = maxW || mh * ar;
        const Hh = Math.min(mh, mw / ar), Ww = Hh * ar, S = 3;
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
    sortFloors(res);   // 画面側で並べ替え済みでも同じ結果(重量が同じなら図番順)
    const floors = Object.keys(res.floors).sort();
    const nAll = floors.reduce((a, fl) => a + res.floors[fl].length, 0);
    let done = 0;
    for (const fl of floors) {
      const ws = out.addWorksheet(fl, { pageSetup: clone(tpl.pageSetup), views: clone(tpl.views), properties: clone(tpl.properties), headerFooter: clone(tpl.headerFooter) });
      for (let c = 1; c <= NCOL; c++) { const w = tpl.getColumn(c).width; if (w) ws.getColumn(c).width = w; }
      ['V', 'W', 'X'].forEach(c => { ws.getColumn(c).width = 13; });   // リンクの列(図面番号・A付き図面番号・製品名)は幅13
      copyRows(tpl, merges, 1, 2, ws, 1);
      const f0 = clone(ws.getCell('V2').font);   // 見出し V1:X2 の文字は V2 と同じに(セルごとに別のオブジェクト)
      [1, 2].forEach(q => ['V', 'W', 'X'].forEach(c => { ws.getCell(`${c}${q}`).font = Object.keys(f0).length ? clone(f0) : { name: 'Calibri', size: 11, family: 2 }; }));
      put(ws, 'B1', kojiName || ''); put(ws, 'P1', fl.replace(/L$/, ''));
      // 方位記号(O1:O2。2026-11-26 ユーザー指示、形は案2=丸+黒い矢じり+N)。北の向きは大組図の KEY PLAN から(tankan_core.north_tip)
      const nd = res.north && res.north[fl];
      if (images && nd !== null && nd !== undefined) {
        const w = colPx(ws.getColumn(15).width), hh = ((ws.getRow(1).height || 17.25) + (ws.getRow(2).height || 17.25)) * 96 / 72;
        const id = out.addImage({ base64: northPng(nd, w, hh), extension: 'png' });
        ws.addImage(id, { tl: { col: 14, row: 0 }, ext: { width: w, height: hh } });
      }
      // ダイア出寸法: この階でいちばん多い値を「特記外」に、違う板だけ板の行に「←ダイア出寸法：80」(提出済みExcelと同じ)
      const outs = res.floors[fl].map(g => diaOut(g.block, res.verify, g.odd));
      const cnt = {}; outs.flat().forEach(v => { if (v !== null) cnt[v] = (cnt[v] || 0) + 1; });
      const dflt = Object.keys(cnt).length ? +Object.keys(cnt).sort((a, b) => cnt[b] - cnt[a])[0] : null;
      // シーム方向: この階でいちばん多い向きを「特記外」に、違う柱だけ柱符号の右に「←シーム方向：…」(提出済みExcelと同じ)
      const seam = res.seam || {}, sc = {};
      res.floors[fl].forEach(g => g.members.forEach(mb => { const v = seam[mb.dwg]; if (v) sc[v] = (sc[v] || 0) + 1; }));
      const sdef = Object.keys(sc).sort((a, b) => sc[b] - sc[a])[0] || '';
      // 「特記外」は、その階に違う所(←の書き込み)があるときだけ付ける(1節の正解は特記なしで「●ダイア出寸法：30」)
      const seamEx = Object.keys(sc).length > 1;
      const diaEx = Object.keys(cnt).length > 1 ||   // BH柱の「ダイア出寸法注意」の絵も違う所に数える(2節 4・5階の正解は「特記外 30」)
        res.floors[fl].some(g => (g.bhdia || []).some(d => dflt !== null && (d.ox !== dflt || d.oy !== dflt)));
      put(ws, 'R1', '●シーム方向：' + (seamEx ? '特記外 ' : '') + sdef); put(ws, 'R2', '●ダイア出寸法：' + (diaEx ? '特記外 ' : '') + (dflt === null ? '' : dflt));
      put(ws, 'W1', factory ? factory + '工場' : '');
      let r = 3, acc = 0;
      for (const [gi, g] of res.floors[fl].entries()) {
        prog(`Excelを作っています…\n${fl} ${g.members[0] ? g.members[0].sym : ''}`, 0.05 + 0.85 * done / Math.max(nAll, 1)); done++;
        const b = g.block, segs = b.segs || [];
        const sizes = b.segs ? sizesOf(segs) : [b.size];
        const proto = PROTO[sizes.length === 1 ? 1 : 3], tns = proto.ns;   // tns = ひな形のサイズの行数
        // サイズが2つの表は、3行のひな形の上2行だけ使い、表を1行短くする(空いた行を作らない。2026-11-26 ユーザー指示、26-16 2F-1)
        const size2 = tns === 3 && sizes.length === 2, ns = size2 ? 2 : tns;
        const e = segs.length > 3 ? 1 : 0;   // コラム長さが4つある柱(次の行のJまで使う)は1行足す(提出済みExcelと同じ。板の見出しと重ならないように)
        const h = ns + 13 + e;
        if (acc && acc + h > PAGE_ROWS) { ws.getRow(r - 1).addPageBreak(); acc = 0; }
        acc += h;
        if (size2) {
          copyRows(tpl, merges, proto.top, 2, ws, r);                          // サイズの行(上2行)
          copyRows(tpl, merges, proto.top + tns, 1, ws, r + 2);                // コラム長さの行
          ws.mergeCells(r, 1, r + 2, 1); ws.mergeCells(r, 2, r + 2, 3);        // 表の番号(A・B:C)はサイズ2行+コラム長さの行
        } else copyRows(tpl, merges, proto.top, ns + 1, ws, r);              // サイズの行+コラム長さの行
        // サイズ1つの表: ひな形はサイズの J:P が結合で単重(P)を書けないので J:O に(提出済みExcelと同じ。サイズ3つの表は元から J:O)
        if (ns === 1) { ws.unMergeCells(`J${r}:P${r}`); ws.mergeCells(`J${r}:O${r}`); }
        if (e) copyRows(tpl, merges, proto.top + tns, 1, ws, r + ns + 1, true);   // 足した行(書式だけ。結合の中の値を写さない)
        copyRows(tpl, merges, proto.top + tns + 1, 12, ws, r + ns + 1 + e);     // 板の見出し〜合計
        const rr = r + ns, f1 = rr + 11 + e, f2 = rr + 12 + e;
        if (e) {
          // コラム長さが4つ(足した行がある)表: 表の番号(A・B:C)は足した行まで、「コラム長さ」(D:I)は2行で結合(2026-11-26 ユーザー指示。見やすく)
          [`A${r}:A${rr}`, `B${r}:C${rr}`, `D${rr}:I${rr}`, `D${rr + 1}:I${rr + 1}`].forEach(a => { try { ws.unMergeCells(a); } catch (er) { /* 結合なし */ } });
          ws.mergeCells(`A${r}:A${rr + 1}`); ws.mergeCells(`B${r}:C${rr + 1}`); ws.mergeCells(`D${rr}:I${rr + 1}`);
          [`A${r}`, `B${r}`, `D${rr}`].forEach(a => { const cl = ws.getCell(a); cl.alignment = Object.assign(clone(cl.alignment), { vertical: 'middle' }); });   // 2〜3行の真ん中に
        }
        put(ws, `A${r}`, gi + 1);
        put(ws, `B${r}`, { formula: `IF(J${rr}="","",$P$1&$A$1&A${r})`, result: `${fl.replace(/L$/, '')}-${gi + 1}` });
        // 材質(大組図の柱サイズの左の印から。読めなければ空欄・黄色)
        // サイズが2つで3行の表を使うときは、空いた3行目には書かない(2026-11-26 ユーザー指示。26-16 2F-1)
        if (/^(□|BH)/.test(String(b.size || ''))) for (let k = 0; k < Math.min(ns, sizes.length); k++) put(ws, `D${r + k}`, b.mat || null, b.mat ? null : YEL);
        let sumQ = 0;
        if (!b.segs) {
          for (let k = r; k < rr; k++) put(ws, `J${k}`, null, ORG);
          put(ws, `J${rr}`, null, ORG); put(ws, `B${rr + 6 + e}`, null, ORG);
        } else {
          sizes.forEach((s, k) => put(ws, `J${r + k}`, s));
          [['J', rr], ['O', rr], ['P', rr], ['J', rr + 1]].forEach(([c, q], k) => { if (k < segs.length) put(ws, `${c}${q}`, segs[k][1]); });
          put(ws, `B${rr + 6 + e}`, b.fin);
          const pw = pipeWeights(segs);
          pw.forEach((p, k) => {
            // 単重: サイズ1つの柱も入れる(テーパーだけの柱は空欄。提出済みExcelと同じ)
            if (ns > 1 || !/^□-\d+-\d+\*/.test(sizes[0] || '')) {
              put(ws, `P${r + k}`, p.uw);
              // サイズ1つの表は J:P の結合を外した P がひな形の書式を持たない(Calibri 11 で列に入らず「#」になる)。提出済みExcelと同じ ＭＳ Ｐ明朝 9 に
              if (ns === 1) { const pc = ws.getCell(`P${r + k}`); pc.font = { name: 'ＭＳ Ｐ明朝', size: 9 }; pc.alignment = { shrinkToFit: true, vertical: 'middle' }; }   // 縮小して全体を表示
            }
            put(ws, `Q${r + k}`, p.w, p.w === null ? ORG : null);
            sumQ += p.w || 0;
          });
        }
        // 板(上→下)
        const pos = platePos(b.plates.length, b);
        const markRow = {};   // 板マーク → 行(同じ板マークが上下にあれば両方)
        const notes = [];     // [行, 出寸法] 特記外と違う板
        b.plates.forEach(([m, t], k) => {
          const dv = outs[gi][k];
          if (k < pos.length && dv !== null && dflt !== null && dv !== dflt) notes.push([rr + 2 + e + pos[k], dv]);
          if (k >= pos.length) return;
          const q = rr + 2 + e + pos[k], pi = plateInfo(m, t, res.verify);
          (markRow[m] = markRow[m] || []).push(q);
          put(ws, `O${q}`, m); put(ws, `P${q}`, pi.t); put(ws, `Q${q}`, pi.w, pi.ng ? YEL : null);
          sumQ += pi.w || 0;
        });
        put(ws, `Q${f1}`, { formula: `SUM(Q${r}:Q${rr - 1},Q${rr + 2 + e}:Q${rr + 10 + e})`, result: r2(sumQ) });
        // 柱符号(R列に縦に。7つ目からS列)と、大組図を開くリンク(V=図面番号・W=A付き図面番号・X=製品名。柱符号1つにつき1行)
        // 板の行(R列)に出寸法を書く柱は、柱符号を板の行より上に収める(入らなければ R・S の2列。提出済みExcelの 2CCY4CX1 3階と同じ)
        const seamNotes = [];   // [セル, 向き] 柱符号の右
        const nm = g.members.length, room = rr + 2 + e - r;
        const two = nm > 6 || (notes.length > 0 && nm > room);
        const nr = two ? (nm > 6 ? 6 : Math.ceil(nm / 2)) : nm;   // 1列の行数
        g.members.forEach((mb, i) => {
          put(ws, `${i < nr ? 'R' : 'S'}${r + (i % nr)}`, mb.sym);
          const sv = seam[mb.dwg];
          if (sv && sdef && sv !== sdef) seamNotes.push([`${i < nr ? 'S' : 'T'}${r + (i % nr)}`, sv]);
          const no = mb.dwg.split('-').pop(), fn = res.files.full[no], fa = res.files.sec[no];
          linkCell(ws, `V${r + i}`, mb.dwg, fn ? link(fn) : '');
          // 断面図が立面図と同じファイルの中にある工事(26-16。A付きのファイルが1つも無い)は W列を空ける
          if (fa || Object.keys(res.files.sec).length) linkCell(ws, `W${r + i}`, mb.dwg + 'A', fa ? link(fa) : '');
          linkCell(ws, `X${r + i}`, mb.sym, fn ? link(fn) : '');
        });
        put(ws, `O${f2}`, { formula: two ? `COUNTA(R${r}:S${r + nr - 1})` : `COUNTA(R${r}:R${r + Math.max(nm, 1) - 1})`, result: nm });
        for (const [addr, sv] of seamNotes) {   // 赤字・ＭＳ Ｐ明朝 9(提出済みExcelと同じ)。右のセルが空いているときだけ
          const c = ws.getCell(addr);
          if (c.value) continue;
          c.value = '←シーム方向：' + sv;
          c.font = { name: 'ＭＳ Ｐ明朝', size: 9, color: { argb: 'FFFF0000' } };
          c.alignment = { horizontal: 'left', vertical: 'middle' };
        }
        for (const [q, dv] of notes) {   // 赤字・ＭＳ Ｐ明朝 10(提出済みExcelと同じ)
          const c = ws.getCell(`R${q}`);
          if (c.value) continue;
          c.value = '←ダイア出寸法：' + dv;
          c.font = { name: 'ＭＳ Ｐ明朝', size: 10, color: { argb: 'FFFF0000' } };
          c.alignment = { horizontal: 'left', vertical: 'middle' };
        }
        put(ws, `Q${f2}`, { formula: `Q${f1}*O${f2}`, result: r2(sumQ * nm) });
        // PL形状注意(odd は下→上)。番号は提出済みExcelと同じ: ①=いちばん下の板、②③…=その上の板の順
        //   置き場所: 1枚=T列 / 2枚=①R・②T(同じ高さ) / 3枚以上=①R(下段)・②T(上段)・③T(下段)・④R(上段)
        // BH柱: 板は出寸法に関係なく必ず「ダイア出寸法注意」の絵(同じ出寸法の板は1枚の絵にまとめ、※は全部の板に)。
        //   2026-11-26 ユーザー指示「BH柱は必ず出す」。以前は特記外と同じ出寸法の板(3C-14 8階の ODY112、30/30)では絵が出なかった
        const odd = (g.odd || []).slice();
        const bhd = (g.bhdia || []).slice();
        const bseen = {};
        for (const d of bhd) {
          const k = `${d.ox}/${d.oy}`;
          if (bseen[k]) { bseen[k].marks.push(d.mark); continue; }
          odd.push(bseen[k] = { mark: d.mark, marks: [d.mark], svg: d.svg, title: 'ダイア出寸法注意' });
        }
        // 置く行(q=絵の1行目。見出しは q-1)。2026-11-26 ユーザー指示: 1・2枚は大きめに、3枚以上ははみ出さない・絵どうしも重ねない。
        //   R〜U 列に字がある行(柱符号・←シーム方向・←ダイア出寸法)より下に置く(字は右の空いたセルにはみ出して見えるので R〜U をまとめて見る)
        const lastRow = r + h - 1;
        const used = (from, to) => { let u = from - 1; for (let n = from; n <= to; n++) if (['R', 'S', 'T', 'U'].some(cc => { const v = ws.getCell(`${cc}${n}`).value; return v !== null && v !== undefined && v !== ''; })) u = n; return u; };
        const head = rr + 1 + e;   // 板の見出しの行(ここより上には置かない)
        let place = [];
        if (odd.length && odd.length <= 2) {
          // 1・2枚: 板の見出しの行から表の最後の行までを使い、字のある行の下から(2枚は ①R・②T を同じ高さに)
          let q = Math.max(head, used(r, lastRow) + 1) + 1;
          if (lastRow - q + 1 < 5) q = Math.max(head, used(r, r + nr - 1) + 1) + 1;   // ←ダイア出寸法が下の方にあって狭すぎるときは、柱符号の下から
          // 1枚は R〜U の4列の幅を使い、真ん中に置く(T・U の2列では幅で大きさが決まってしまい大きくできなかった)。見出しは S 列
          place = odd.length === 1 ? [[odd[0], 'R', q, '', 4, 'S']] : [[odd[0], 'R', q, ' ①'], [odd[1], 'T', q, ' ②']];
        } else if (odd.length > 2) {
          // 3枚以上: ①R(下段)・②T(上段)・③T(下段)・④R(上段)。上段は字のある行の下から、下段は表の下半分から
          const up = Math.max(r + 3, used(r, r + nr - 1) + 2), low = Math.max(r + 9, up + 4);
          place = [[odd[0], 'R', low, ' ①'], [odd[1], 'T', up, ' ②'], [odd[2], 'T', low, ' ③']]
            .concat(odd.length > 3 ? [[odd[3], 'R', up, ' ④']] : []);
        }
        for (const [o, c, q, lab, span = 2, tc = c] of place) {
          // ※と見出しは置く行のひな形の書式に関係なく、赤・ＭＳ Ｐ明朝 10・中央(提出済みExcelと同じ)
          const red = addr => { const cl = ws.getCell(addr); cl.font = { name: 'ＭＳ Ｐ明朝', size: 10, color: { argb: 'FFFF0000' } }; cl.alignment = { horizontal: 'center', vertical: 'middle' }; };
          put(ws, `${tc}${q - 1}`, '※　' + (o.title || 'PL形状注意') + lab); red(`${tc}${q - 1}`);
          (o.marks || [o.mark]).forEach(mk => (markRow[mk] || []).forEach(q2 => { put(ws, `C${q2}`, '※' + lab.trim()); red(`C${q2}`); }));
          if (images && o.svg) {
            // 置ける枠: 横=その列から span 列(R・S か T・U。1枚は R〜U)、縦=絵の行から、同じ列の下の絵の見出しの上(無ければ表の最後の行)まで。
            //   印刷・PDF では画面の計算より少し大きく出るので 0.92 倍(はみ出して次の表の柱符号や隣の絵に重ならないように)
            const below = place.filter(p => p[1] === c && p[2] > q).map(p => p[2] - 2);
            const last = below.length ? Math.min(...below) : lastRow;
            let hpx = 0; for (let n = q; n <= last; n++) hpx += (ws.getRow(n).height || 14.25) * 96 / 72;
            const c0 = c.charCodeAt(0) - 64, cws = [];
            for (let k = 0; k < span; k++) cws.push(colPx(ws.getColumn(c0 + k).width));
            const wpx = cws.reduce((a, v) => a + v, 0) - 8.5;
            const im = await svgPng(o.svg, (wpx - 6) * 0.92, (hpx - 6) * 0.92);
            const id = out.addImage({ base64: im.data, extension: 'png' });
            // 左の余白: 2列の枠は 8.5(今まで通り)、4列の枠は真ん中に置く。列をまたぐ分は次の列へ進める
            let off = span > 2 ? 8.5 + Math.max(0, (wpx - im.w) / 2) : 8.5, k = 0;
            while (k < span - 1 && off >= cws[k]) { off -= cws[k]; k++; }
            ws.addImage(id, { tl: { col: c0 - 1 + k + off / (cws[k] * 0.75), row: q - 1 + 3 / ((ws.getRow(q).height || 14.25)) }, ext: { width: im.w, height: im.h } });
          }
        }
        // 短管の絵(D〜M列 × 板の行)
        if (images && b.segs) {
          let wpx = 0, hpx = 0;
          for (let c = 4; c <= 13; c++) wpx += colPx(ws.getColumn(c).width);
          for (let q = rr + 2 + e; q < f1; q++) hpx += rowPx(ws.getRow(q).height);
          const id = out.addImage({ base64: pipePng(b, wpx, hpx), extension: 'png' });
          ws.addImage(id, { tl: { col: 3, row: rr + 1 + e }, br: { col: 13, row: f1 - 1 }, editAs: 'oneCell' });
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
    // 値が1つなら数値のまま(Excelで計算できるように)。複数あるときだけ「/」でつないだ文字
    const jn = a => !a || !a.length ? '' : (a.length === 1 && typeof a[0] === 'number' ? a[0] : a.map(String).join('/'));
    Object.entries(res.verify).forEach(([m, v]) => {
      const row = vs.addRow([m, v.t_dwg, v.dim ? v.dim[0] : '', v.dim ? v.dim[1] : '', v.calc, v.use,
        jn(v.t_csv), v.ab ? v.ab.map(([a, b]) => `${a}x${b}`).join('/') : '', v.n,
        jn(v.net), jn(v.gross), v.files.join(' '),
        v.ok ? (v.unused ? '図面で使っていない(手配だけ。問題としない)' : v.extra ? `OK(手配の方が${v.extra}枚多い。ほかの図面の分として問題としない)` : 'OK') : '要確認: ' + v.ng.join('; '), v.weight].map(x => x === null || x === undefined ? '' : x));
      if (!v.ok) row.eachCell({ includeEmpty: true }, c => { c.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: YEL } }; });
    });
    hd.forEach((h_, i) => { vs.getColumn(i + 1).width = Math.max(10, h_.length * 2); });
    prog('Excelを保存しています…', 0.97);
    const buf = await out.xlsx.writeBuffer();
    return typeof Blob !== 'undefined' ? new Blob([buf], { type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' }) : buf;
  }

  const api = { prepare, build, groupWeight, unitW, platePos, sortFloors };
  root.TankanExcel = api;
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
})(typeof window !== 'undefined' ? window : globalThis);
