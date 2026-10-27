/* 文字データの無い詳細図PDF(文字が線で描かれたCAD図面)へのリンク付与。
 * 画像にして Gemini(GAS経由)で「右下の図面番号」と「製品表のセル」を読み、
 * 読んだ図番のマスタ上の製品名と、製品表のいずれかのセルが一致したら、そのセルにリンクを付ける。
 * 梁詳細図(製品名|設計符号|部材サイズ|台数)・柱詳細図(設計符号|設計符号|製品名|図示|台数)のどちらも、セルの位置は決め打ちしない。
 * 読み取りの誤りでリンクを付けないよう、マスタとの一致だけを根拠にする(CADの文字ではOと0・Iと1の見分けがつかないので、比較時だけ同一視)。 */
(function (root) {
  var LOCATE_SIDE = 2000;   // 場所を探すための全体画像の長辺(px)
  var READ_DPI = 300;       // 読み取り用の切り出し画像の解像度
  var CORNER_SIDE = 2000;   // 右下(図面番号欄のあたり)だけを拡大して図面番号の位置を探すときの、その画像の横幅(px)
  var MAX_CALLS_PER_MIN = 12;   // Geminiの無料枠は1分あたりの呼び出し回数に上限がある(429)ので、それを超えないよう間隔をあける
  var RETRY_429 = 3;            // 429が返ったときの再試行の回数(そのつど少し待つ)
  var HALF_SIDE = 2400;     // 製品表を見落としたとき、上下に分けて探し直す画像の横幅(px)

  function fold(s) { return String(s).normalize('NFKC').replace(/\s+/g, '').toUpperCase().replace(/O/g, '0').replace(/[IL]/g, '1'); }

  // ページの一部を描いた canvas を返す。(x0,y0,w,h)はそのscaleでのページ画像上の範囲(px)
  async function renderRegion(page, scale, x0, y0, w, h) {
    var vp = page.getViewport({ scale: scale }), c = document.createElement('canvas');
    c.width = Math.max(1, Math.round(w)); c.height = Math.max(1, Math.round(h));
    var ctx = c.getContext('2d');
    ctx.fillStyle = '#fff'; ctx.fillRect(0, 0, c.width, c.height);
    await page.render({ canvasContext: ctx, viewport: vp, transform: [1, 0, 0, 1, -x0, -y0] }).promise;
    return { canvas: c, vp: vp };
  }
  // canvas の画素を手放す(複数ページを並行して読むとき、メモリを使い続けないように)
  function release(c) { if (c && c.canvas) { c.canvas.width = 0; c.canvas.height = 0; } }
  // 切り出し画像上の範囲({x0,y0,x1,y1}。切り出し画像の左上が (ox,oy))→ PDFのページ座標の矩形 [x0,y0,x1,y1]
  function pdfRect(vp, ox, oy, r) {
    var a = vp.convertToPdfPoint(ox + r.x0, oy + r.y0), b = vp.convertToPdfPoint(ox + r.x1, oy + r.y1);
    return [Math.min(a[0], b[0]), Math.min(a[1], b[1]), Math.max(a[0], b[0]), Math.max(a[1], b[1])];
  }
  function sleep(ms) { return new Promise(function (r) { setTimeout(r, ms); }); }
  // 図面番号欄のあたりの画像(box は 0〜1000 のページ全体の位置)。着色の範囲を求める・読み直し(遅い道)に使う
  function renderAround(page, sH, PW, PH, box) {
    var nb = boxPx(box, PW, PH);
    if (!nb) return Promise.resolve(null);
    var padx = (nb.x1 - nb.x0) * 0.6 + 40, pady = (nb.y1 - nb.y0) * 3 + 60;   // 欄の罫線(上は「図面番号」の文字の上)まで入る広さ
    var rx0 = clamp(nb.x0 - padx, 0, PW), ry0 = clamp(nb.y0 - pady, 0, PH), rx1 = clamp(nb.x1 + padx, 0, PW), ry1 = clamp(nb.y1 + pady, 0, PH);
    return renderRegion(page, sH, rx0, ry0, rx1 - rx0, ry1 - ry0).then(function (r) { return { r: r, nb: nb, rx0: rx0, ry0: ry0 }; });
  }
  function jpeg(canvas) { return canvas.toDataURL('image/jpeg', 0.9).replace(/^data:image\/jpeg;base64,/, ''); }
  function clamp(v, a, b) { return Math.max(a, Math.min(b, v)); }
  // [ymin,xmin,ymax,xmax](0〜1000)→ 範囲 {x0,y0,x1,y1}(px)。不正なら null
  function boxPx(box, w, h) {
    if (!box || box.length !== 4 || box.some(function (n) { return typeof n !== 'number' || isNaN(n); })) return null;
    var r = { x0: box[1] / 1000 * w, y0: box[0] / 1000 * h, x1: box[3] / 1000 * w, y1: box[2] / 1000 * h };
    if (r.x1 <= r.x0 || r.y1 <= r.y0) return null;
    return r;
  }
  // 製品表の罫線からセルの範囲を求める(Geminiが返す文字の枠は上下・左右にずれることがあるため、枠の大きさや横位置には頼らない)
  // tbl: 製品表の範囲(canvas上のpx)/ cb: 読み取ったセルの文字の範囲(使うのは中心の位置だけ)
  // opt.idx(省略可): 読み取った表の中で左から何番目のセルか
  // 1. 文字の中心から上下にいちばん近い、ほぼ全幅に渡る横線 → セルの上端・下端
  // 2. 上端〜下端のほぼ全高に渡る縦線 → 列の区切り。opt.idx があれば、上の罫線をたどって見つけた表の端から数えて idx 番目と次の区切りを左右の端にする
  //    (無ければ、文字の中心を挟む2本)
  function cellFromLines(canvas, tbl, cb, opt) {
    var w = canvas.width, h = canvas.height, d = canvas.getContext('2d').getImageData(0, 0, w, h).data;
    function dark(x, y) { x = clamp(Math.round(x), 0, w - 1); y = clamp(Math.round(y), 0, h - 1); var i = (y * w + x) * 4; return (d[i] + d[i + 1] + d[i + 2]) / 3 < 170; }
    var xc = (cb.x0 + cb.x1) / 2, yc = (cb.y0 + cb.y1) / 2, tw = tbl.x1 - tbl.x0, T = null, B = null;
    function hFrac(y, xa, xb) { var n = 0, t = 0, x; for (x = xa; x <= xb; x += 2) { t++; if (dark(x, y - 1) || dark(x, y) || dark(x, y + 1)) n++; } return t ? n / t : 0; }
    function vFrac(x, ya, yb) { var n = 0, t = 0, y; for (y = ya; y <= yb; y += 2) { t++; if (dark(x - 1, y) || dark(x, y) || dark(x + 1, y)) n++; } return n / t; }
    // 上端・下端: 先に、そのセルの文字のあたり(横幅は文字の範囲)で探す。表の枠の外に文字(重量など)がはみ出す表でも見つかるように。だめなら表の中央80%で探す
    var ranges = [[cb.x0, cb.x1], [tbl.x0 + tw * 0.1, tbl.x1 - tw * 0.1]], ri, y;
    for (ri = 0; ri < ranges.length && (T === null || B === null); ri++) {
      T = null; B = null;
      for (y = yc; y >= Math.max(0, yc - h * 0.5); y--) if (hFrac(y, ranges[ri][0], ranges[ri][1]) >= 0.85) { T = y; break; }
      for (y = yc; y <= Math.min(h - 1, yc + h * 0.5); y++) if (hFrac(y, ranges[ri][0], ranges[ri][1]) >= 0.85) { B = y; break; }
    }
    if (T !== null && B !== null && B - T >= 8) {
      var lines = [], x, last = -99;
      for (x = 0; x < w; x++) if (vFrac(x, T + 3, B - 3) >= 0.85) { if (x - last > 3) lines.push([x, x]); else lines[lines.length - 1][1] = x; last = x; }
      var L = null, R = null;
      if (opt && opt.idx >= 0) {
        // 上の罫線をたどって表の左右の端を見つけ、その中の縦線で区切られた「左から idx 番目」のセルにする
        // (Geminiの横位置は1セル近くずれることがあるので、横位置ではなく順番で決める)
        var dk = function (xx) { return dark(xx, T - 1) || dark(xx, T) || dark(xx, T + 1); }, Lx = clamp(xc, 0, w - 1), Rx = Lx, gp = 0, xx;
        for (xx = Lx, gp = 0; xx >= 0; xx--) { if (dk(xx)) { gp = 0; Lx = xx; } else if (++gp > 4) break; }
        for (xx = Rx, gp = 0; xx < w; xx++) { if (dk(xx)) { gp = 0; Rx = xx; } else if (++gp > 4) break; }
        var inner = lines.filter(function (l) { var c = (l[0] + l[1]) / 2; return c >= Lx - 4 && c <= Rx + 4; });
        if (inner.length > opt.idx + 1) {
          var l0 = (inner[opt.idx][0] + inner[opt.idx][1]) / 2, l1 = (inner[opt.idx + 1][0] + inner[opt.idx + 1][1]) / 2;
          if (l1 - l0 >= 8) return { x0: l0, y0: T, x1: l1, y1: B, snapped: true };
        }
      }
      lines.forEach(function (l) { var c = (l[0] + l[1]) / 2; if (c <= xc) L = c; else if (R === null) R = c; });
      if (L !== null && R !== null && R - L >= 8) return { x0: L, y0: T, x1: R, y1: B, snapped: true };
    }
    var m = (cb.y1 - cb.y0) * 0.5;
    return { x0: cb.x0 - m, y0: cb.y0 - m, x1: cb.x1 + m, y1: cb.y1 + m, snapped: false };
  }

  // links: { "図番\t製品名": url | [url,...] } / ask(kind, base64Jpeg) → Promise<{ok, data|error}> / opts.mapUri(url): PDFに入れるリンク先の変換(省略可)
  async function linkDrawing(pdfjsLib, PDFLib, data, links, ask, opts) {
    var mapUri = (opts && opts.mapUri) || function (u) { return u; };
    var doc = await pdfjsLib.getDocument({ data: new Uint8Array(data.slice(0)) }).promise;
    var out = await PDFLib.PDFDocument.load(data, { ignoreEncryption: true });
    var stats = { pages: doc.numPages, linked: 0, dup: 0, ng: 0, partial: [] };
    // 図番 → その図番の製品名の一覧(比較用にそろえた形)
    var byZ = {};
    Object.keys(links).forEach(function (k) {
      var p = k.split('\t'), z = fold(p[0]);
      (byZ[z] = byZ[z] || []).push({ zuban: p[0], name: p[1], f: fold(p[1]), v: links[k] });
    });
    var sent = [];   // 直近1分に送った時刻
    async function throttle() {   // 1分あたりの回数を超えないよう、空くまで待つ
      for (;;) {
        var now = Date.now();
        sent = sent.filter(function (t) { return now - t < 60000; });
        if (sent.length < MAX_CALLS_PER_MIN) { sent.push(now); return; }
        await sleep(60000 - (now - sent[0]) + 200);
      }
    }
    async function call(kind, r, keep) {   // keep=true: 送ったあとも画像を使い続けるので手放さない
      var img = jpeg(r.canvas);
      if (!keep) release(r);
      for (var attempt = 0; ; attempt++) {
        await throttle();
        var res = await ask(kind, img);
        if (res && res.ok) return res.data;
        var msg = (res && res.error) || '読み取りに失敗しました';
        if (attempt < RETRY_429 && /429|quota/i.test(msg)) { await sleep(8000 * (attempt + 1)); continue; }   // 上限に当たったときは待って再試行
        throw new Error(msg);
      }
    }
    // 読み取ったセルの中から、図番 z の製品名(まだ使っていないもの)と一致する最初のセルを探す。seen には読み取った文字を集める
    function pick(cells, z, used, seen) {
      var fz = fold(z), es = byZ[fz];
      for (var ci = 0; ci < (cells || []).length; ci++) {
        var c = cells[ci];
        if (!c.text) continue;
        seen.push(c.text);
        var fc = fold(c.text);
        for (var ei = 0; ei < es.length; ei++) if (!used[fz + '#' + ei] && es[ei].f === fc) return { e: es[ei], k: fz + '#' + ei, c: c };
      }
      return null;
    }
    // リンク(クリックできる範囲)と、セル全体の薄い青の着色を、ページに付ける
    function addLink(pdfPage, a) {
      var ctx = out.context, act = ctx.obj({ S: 'URI', URI: PDFLib.PDFString.of(root.ShippingCore.encodeUri(a.uri)) });
      pdfPage.node.addAnnot(ctx.register(ctx.obj({ Type: 'Annot', Subtype: 'Link', Rect: a.rect, Border: [0, 0, 0], A: act })));
      // 図面は文字が細かく下線だと文字に重なるので、セル全体を薄い青で塗る(乗算なので文字はそのまま見える)
      pdfPage.drawRectangle({ x: a.rect[0], y: a.rect[1], width: a.rect[2] - a.rect[0], height: a.rect[3] - a.rect[1],
        color: PDFLib.rgb(0.62, 0.78, 1), blendMode: PDFLib.BlendMode.Multiply });
    }
    var numCands = [];   // 製品名にリンクを付けたページ(図面番号欄の着色の候補): { pn, fz(図番), uri }
    // ページごとの処理。ページは並行して読む(Geminiの待ち時間が重ならないように)。結果の順序は最後に頁順に整える
    async function pageJob(pn) {
      var page = await doc.getPage(pn), v1 = page.getViewport({ scale: 1 }), W = v1.width, H = v1.height;
      var s0 = LOCATE_SIDE / Math.max(W, H), sH = READ_DPI / 72, PW = W * sH, PH = H * sH, pdfPage = out.getPage(pn - 1), annots = [];
      var loc = await call('locate', await renderRegion(page, s0, 0, 0, W * s0, H * s0));
      // 製品表を見落としたときだけ: ページを上下2つ(少し重ねる)に分け、拡大して探し直す。位置はページ全体の0〜1000に直して使う
      if (!(loc.tables || []).length) {
        var sh = HALF_SIDE / W, found = await Promise.all([[0, 0.55], [0.45, 0.55]].map(async function (h) {
          try {
            var r2 = await call('locate', await renderRegion(page, sh, 0, H * sh * h[0], W * sh, H * sh * h[1])), off = h[0] * 1000;
            var mapBox = function (b) { return b && b.length === 4 ? [off + b[0] * h[1], b[1], off + b[2] * h[1], b[3]] : b; };
            return (r2.tables || []).map(function (t) {
              return { box: mapBox(t.box), cells: (t.cells || []).map(function (c) { return { text: c.text, box: mapBox(c.box) }; }) };
            });
          } catch (e) { return []; }
        }));
        loc.tables = [].concat.apply([], found);
      }
      var tables = loc.tables || [];
      if (!tables.length) { stats.ng++; stats.partial.push({ page: pn, zuban: loc.drawingNumber || '', name: '', reason: '製品表が見つかりません' }); return; }

      // 読み直し(遅い道)用の、図面番号欄のあたりの画像。必要になったときだけ描く
      var numMemo = null, numRead = null;
      function numberImage() { return numMemo || (numMemo = renderAround(page, sH, PW, PH, loc.drawingNumberBox)); }
      async function readNumber() {   // 図面番号を高解像度で読み直し、マスタにある方を採る(場所探しで読んだ値も候補)
        if (numRead) return numRead;
        var cs = [], im = await numberImage();
        if (im) { try { cs.push((await call('number', im.r, true)).text); } catch (e) { /* 読み直しに失敗しても、場所探しの値で続ける */ } }
        if (loc.drawingNumber) cs.push(loc.drawingNumber);
        cs = cs.filter(Boolean);
        return (numRead = { z: cs.filter(function (t) { return byZ[fold(t)]; })[0], show: cs[0] || '' });
      }

      // 速い道: 全体画像の1回の読み取りで、図面番号がマスタにあり、製品表のセルがその図番の製品名と一致すればそこで確定する(Geminiの呼び出し1回)。
      // 遅い道(確定できなかったときだけ): 図面番号欄と製品表を高解像度で切り出して読み直す(最大2回追加)
      var used = {}, zMsg = false, zFast = loc.drawingNumber && byZ[fold(loc.drawingNumber)] ? loc.drawingNumber : null;
      for (var ti = 0; ti < tables.length; ti++) {
        var tb = boxPx(tables[ti].box, PW, PH);
        if (!tb) { stats.ng++; continue; }
        var px = Math.max((tb.x1 - tb.x0) * 0.03 + 24, PW * 0.04), py = (tb.y1 - tb.y0) * 0.3 + 24;   // 横はGeminiの位置のずれ(最大でページ幅の数%)を見込んで広く
        var cx0 = clamp(tb.x0 - px, 0, PW), cy0 = clamp(tb.y0 - py, 0, PH), cx1 = clamp(tb.x1 + px, 0, PW), cy1 = clamp(tb.y1 + py, 0, PH);
        var tr = await renderRegion(page, sH, cx0, cy0, cx1 - cx0, cy1 - cy0);
        var hit = null, seen = [], zUse = zFast, tbx = null, cellOpt = null;
        if (zFast && tables[ti].cells) {
          hit = pick(tables[ti].cells, zFast, used, seen);
          var fb = hit && boxPx(hit.c.box, PW, PH);
          if (fb) { tbx = { x0: fb.x0 - cx0, y0: fb.y0 - cy0, x1: fb.x1 - cx0, y1: fb.y1 - cy0 }; cellOpt = { idx: tables[ti].cells.indexOf(hit.c) }; }
          else hit = null;
        }
        if (!hit) {
          seen = [];
          var zn = await readNumber();
          zUse = zn.z;
          if (!zUse) {
            release(tr); stats.ng++;
            if (!zMsg) { zMsg = true; stats.partial.push({ page: pn, zuban: zn.show, name: '', reason: 'マスタに無い図番(読み取り: ' + (zn.show || '読めず') + ')' }); }
            continue;
          }
          var tbl = await call('table', tr, true);
          hit = pick(tbl.cells, zUse, used, seen);
          if (hit) { tbx = boxPx(hit.c.box, tr.canvas.width, tr.canvas.height); cellOpt = { idx: tbl.cells.indexOf(hit.c) }; }
        }
        var ng = null;
        if (!hit) ng = { zuban: zUse, name: seen.join(' | '), reason: '製品名が不一致(読み取った表の文字を表示)' };
        else if (Array.isArray(hit.e.v)) { stats.dup++; ng = { zuban: hit.e.zuban, name: hit.e.name, reason: '重複' }; }
        else if (!tbx) ng = { zuban: zUse, name: hit.c.text, reason: 'セルの位置を読み取れません' };
        if (hit) used[hit.k] = 1;
        if (ng) { stats.ng++; ng.page = pn; stats.partial.push(ng); release(tr); continue; }
        var cell = cellFromLines(tr.canvas, { x0: tb.x0 - cx0, y0: tb.y0 - cy0, x1: tb.x1 - cx0, y1: tb.y1 - cy0 }, tbx, cellOpt);
        annots.push({ rect: pdfRect(tr.vp, cx0, cy0, cell), uri: mapUri(hit.e.v), fz: fold(hit.e.zuban) });
        stats.linked++;
        release(tr);
      }
      if (annots.length) numCands.push({ pn: pn, fz: annots[0].fz, uri: annots[0].uri });   // 図面番号欄の着色は、全ページ処理のあとでまとめて行う
      var imEnd = numMemo && await numMemo;
      if (imEnd) release(imEnd.r);
      annots.forEach(function (a) { addLink(pdfPage, a); });
    }
    // 図面番号(右下)にも、製品名と同じリンクと着色を付ける。全体画像では、Geminiが図面番号の位置を隣のセル(工事番号・図面名称など)と取り違えることがあるので、
    // 右下だけを拡大して探し直し、読んだ図面番号が、製品名にリンクを付けた図番と一致したときだけ位置を採る。同じ図面セットなら表題欄の位置は全ページで同じなので、
    // 探し直しはPDF全体で最大3回(1回で確定すれば1回)にして、Geminiの呼び出し回数を増やさない。一致しなければ、位置が違う疑いがあるので塗らない
    async function markNumberCells(cands) {
      cands.sort(function (a, b) { return a.pn - b.pn; });
      var tpl = null;
      for (var ci = 0; ci < Math.min(3, cands.length) && !tpl; ci++) {
        var pg = await doc.getPage(cands[ci].pn), v = pg.getViewport({ scale: 1 }), sc = CORNER_SIDE / (v.width * 0.5);
        try {
          var cn = await call('locate', await renderRegion(pg, sc, v.width * sc * 0.5, v.height * sc * 0.8, v.width * sc * 0.5, v.height * sc * 0.2)), cb = cn.drawingNumberBox;
          if (cn.drawingNumber && fold(cn.drawingNumber) === cands[ci].fz && cb && cb.length === 4) tpl = [800 + cb[0] * 0.2, 500 + cb[1] * 0.5, 800 + cb[2] * 0.2, 500 + cb[3] * 0.5];
        } catch (e) { /* 探し直しに失敗しても、製品名のリンクはそのまま */ }
      }
      if (!tpl) return;
      for (var k = 0; k < cands.length; k++) {
        var page = await doc.getPage(cands[k].pn), vp1 = page.getViewport({ scale: 1 }), sH = READ_DPI / 72;
        var im = await renderAround(page, sH, vp1.width * sH, vp1.height * sH, tpl);
        if (!im) continue;
        var nl = { x0: im.nb.x0 - im.rx0, y0: im.nb.y0 - im.ry0, x1: im.nb.x1 - im.rx0, y1: im.nb.y1 - im.ry0 }, nc = cellFromLines(im.r.canvas, nl, nl);
        if (nc.snapped) addLink(out.getPage(cands[k].pn - 1), { rect: pdfRect(im.r.vp, im.rx0, im.ry0, nc), uri: cands[k].uri });
        release(im.r);
      }
    }
    try {
      var nextPage = 1;
      var worker = async function () { while (nextPage <= doc.numPages) await pageJob(nextPage++); };
      await Promise.all([worker(), worker(), worker()]);
      stats.partial.sort(function (a, b) { return a.page - b.page; });
      await markNumberCells(numCands);
    } finally { doc.destroy(); }   // pdf.js のworker・ページ資源を解放
    return { bytes: await out.save(), stats: stats };
  }

  var api = { linkDrawing: linkDrawing };
  if (typeof module !== 'undefined' && module.exports) module.exports = api; else root.ShippingDrawing = api;
})(typeof window !== 'undefined' ? window : this);
