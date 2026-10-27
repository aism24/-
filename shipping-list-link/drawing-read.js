/* 文字データの無い詳細図PDF(文字が線で描かれたCAD図面)へのリンク付与。
 * 画像にして Gemini(GAS経由)で「右下の図面番号」と「製品表のセル」を読み、
 * 読んだ図番のマスタ上の製品名と、製品表のいずれかのセルが一致したら、そのセルにリンクを付ける。
 * 梁詳細図(製品名|設計符号|部材サイズ|台数)・柱詳細図(設計符号|設計符号|製品名|図示|台数)のどちらも、セルの位置は決め打ちしない。
 * 読み取りの誤りでリンクを付けないよう、マスタとの一致だけを根拠にする(CADの文字ではOと0・Iと1の見分けがつかないので、比較時だけ同一視)。 */
(function (root) {
  var LOCATE_SIDE = 2000;   // 場所を探すための全体画像の長辺(px)
  var READ_DPI = 300;       // 読み取り用の切り出し画像の解像度

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
  function jpeg(canvas) { return canvas.toDataURL('image/jpeg', 0.9).replace(/^data:image\/jpeg;base64,/, ''); }
  function clamp(v, a, b) { return Math.max(a, Math.min(b, v)); }
  // [ymin,xmin,ymax,xmax](0〜1000)→ 範囲 {x0,y0,x1,y1}(px)。不正なら null
  function boxPx(box, w, h) {
    if (!box || box.length !== 4 || box.some(function (n) { return typeof n !== 'number' || isNaN(n); })) return null;
    var r = { x0: box[1] / 1000 * w, y0: box[0] / 1000 * h, x1: box[3] / 1000 * w, y1: box[2] / 1000 * h };
    if (r.x1 <= r.x0 || r.y1 <= r.y0) return null;
    return r;
  }
  // 画像の読み取りで得た文字の範囲を、周りの罫線(セルの枠)まで広げる。見つからない方向は文字の範囲に少し余白を足す
  function snapCell(canvas, r) {
    var w = canvas.width, h = canvas.height, d = canvas.getContext('2d').getImageData(0, 0, w, h).data;
    function dark(x, y) { x = clamp(Math.round(x), 0, w - 1); y = clamp(Math.round(y), 0, h - 1); var i = (y * w + x) * 4; return (d[i] + d[i + 1] + d[i + 2]) / 3 < 170; }
    var th = r.y1 - r.y0, tw = r.x1 - r.x0, yc = (r.y0 + r.y1) / 2, xc = (r.x0 + r.x1) / 2;
    function vline(x) {   // 文字より背の高い縦線があるか(文字の縦画ではなく罫線だけを拾うため、文字高の±0.75倍を見る)
      var n = 0, t = 0, y;
      for (y = yc - th * 0.75; y <= yc + th * 0.75; y += 1) { t++; if (dark(x - 1, y) || dark(x, y) || dark(x + 1, y)) n++; }
      return n / t >= 0.9;
    }
    function hline(y, xa, xb) {
      var n = 0, t = 0, x;
      for (x = xa; x <= xb; x += 1) { t++; if (dark(x, y - 1) || dark(x, y) || dark(x, y + 1)) n++; }
      return n / t >= 0.9;
    }
    var L = null, R = null, T = null, B = null, x, y;
    for (x = r.x0 - 2; x >= Math.max(0, r.x0 - tw * 1.5 - 40); x--) if (vline(x)) { L = x; break; }
    for (x = r.x1 + 2; x <= Math.min(w - 1, r.x1 + tw * 1.5 + 40); x++) if (vline(x)) { R = x; break; }
    if (L !== null && R !== null) {
      var xa = L + 2, xb = R - 2;
      for (y = r.y0 - 2; y >= Math.max(0, r.y0 - th * 2); y--) if (hline(y, xa, xb)) { T = y; break; }
      for (y = r.y1 + 2; y <= Math.min(h - 1, r.y1 + th * 2); y++) if (hline(y, xa, xb)) { B = y; break; }
      if (T !== null && B !== null) return { x0: L, y0: T, x1: R, y1: B, snapped: true };
    }
    var m = th * 0.25;
    return { x0: r.x0 - m, y0: r.y0 - m, x1: r.x1 + m, y1: r.y1 + m, snapped: false };
  }

  // links: { "図番\t製品名": url | [url,...] } / ask(kind, base64Jpeg) → Promise<{ok, data|error}>
  async function linkDrawing(pdfjsLib, PDFLib, data, links, ask) {
    var doc = await pdfjsLib.getDocument({ data: new Uint8Array(data.slice(0)) }).promise;
    var out = await PDFLib.PDFDocument.load(data, { ignoreEncryption: true });
    var stats = { pages: doc.numPages, linked: 0, dup: 0, ng: 0, partial: [], tables: 0 };
    // 図番 → その図番の製品名の一覧(比較用にそろえた形)
    var byZ = {};
    Object.keys(links).forEach(function (k) {
      var p = k.split('\t'), z = fold(p[0]);
      (byZ[z] = byZ[z] || []).push({ zuban: p[0], name: p[1], f: fold(p[1]), v: links[k] });
    });
    async function call(kind, canvas) {
      var r = await ask(kind, jpeg(canvas));
      if (!r || !r.ok) throw new Error((r && r.error) || '読み取りに失敗しました');
      return r.data;
    }
    try {
      for (var pn = 1; pn <= doc.numPages; pn++) {
        var page = await doc.getPage(pn), v1 = page.getViewport({ scale: 1 }), W = v1.width, H = v1.height;
        var s0 = LOCATE_SIDE / Math.max(W, H), sH = READ_DPI / 72, pdfPage = out.getPage(pn - 1), annots = [];
        var full = await renderRegion(page, s0, 0, 0, W * s0, H * s0);
        var loc = await call('locate', full.canvas);
        // 図面番号: 右下の図面番号欄を高解像度で読み直し、マスタにある方を採る(場所探しで読んだ値も候補)
        var cands = [];
        var nb = boxPx(loc.drawingNumberBox, W * sH, H * sH);
        if (nb) {
          var padx = (nb.x1 - nb.x0) * 0.4 + 20, pady = (nb.y1 - nb.y0) * 0.6 + 20;
          var rx0 = clamp(nb.x0 - padx, 0, W * sH), ry0 = clamp(nb.y0 - pady, 0, H * sH), rx1 = clamp(nb.x1 + padx, 0, W * sH), ry1 = clamp(nb.y1 + pady, 0, H * sH);
          var nr = await renderRegion(page, sH, rx0, ry0, rx1 - rx0, ry1 - ry0);
          try { cands.push((await call('number', nr.canvas)).text); } catch (e) { /* 読み直しに失敗しても、場所探しの値で続ける */ }
        }
        if (loc.drawingNumber) cands.push(loc.drawingNumber);
        var zRead = cands.filter(Boolean).filter(function (t) { return byZ[fold(t)]; })[0], zShow = cands.filter(Boolean)[0] || '';
        var tables = loc.tables || [];
        if (!tables.length) { stats.ng++; stats.partial.push({ page: pn, zuban: zShow, name: '', reason: '製品表が見つかりません' }); continue; }
        if (!zRead) { tables.forEach(function () { stats.ng++; }); stats.partial.push({ page: pn, zuban: zShow, name: '', reason: 'マスタに無い図番(読み取り: ' + (zShow || '読めず') + ')' }); continue; }
        var entries = byZ[fold(zRead)], used = {};
        for (var ti = 0; ti < tables.length; ti++) {
          var tb = boxPx(tables[ti].box, W * sH, H * sH);
          if (!tb) { stats.ng++; continue; }
          stats.tables++;
          var px = (tb.x1 - tb.x0) * 0.03 + 24, py = (tb.y1 - tb.y0) * 0.3 + 24;
          var cx0 = clamp(tb.x0 - px, 0, W * sH), cy0 = clamp(tb.y0 - py, 0, H * sH), cx1 = clamp(tb.x1 + px, 0, W * sH), cy1 = clamp(tb.y1 + py, 0, H * sH);
          var tr = await renderRegion(page, sH, cx0, cy0, cx1 - cx0, cy1 - cy0);
          var tbl = await call('table', tr.canvas), cw = tr.canvas.width, ch = tr.canvas.height, hit = null, seen = [];
          (tbl.cells || []).forEach(function (c, ci) {
            if (c.text) seen.push(c.text);
            if (hit || !c.text) return;
            for (var ei = 0; ei < entries.length; ei++) if (!used[ei] && entries[ei].f === fold(c.text)) { hit = { e: entries[ei], ei: ei, c: c }; return; }
          });
          if (!hit) { stats.ng++; stats.partial.push({ page: pn, zuban: zRead, name: seen.join(' | '), reason: '製品名が不一致(読み取った表の文字を表示)' }); continue; }
          used[hit.ei] = 1;
          if (Array.isArray(hit.e.v)) { stats.dup++; stats.ng++; stats.partial.push({ page: pn, zuban: hit.e.zuban, name: hit.e.name, reason: '重複' }); continue; }
          var tbx = boxPx(hit.c.box, cw, ch);
          if (!tbx) { stats.ng++; stats.partial.push({ page: pn, zuban: zRead, name: hit.c.text, reason: 'セルの位置を読み取れません' }); continue; }
          var cell = snapCell(tr.canvas, tbx);
          var A = tr.vp.convertToPdfPoint(cx0 + cell.x0, cy0 + cell.y0), B = tr.vp.convertToPdfPoint(cx0 + cell.x1, cy0 + cell.y1);
          var U0 = tr.vp.convertToPdfPoint(cx0 + tbx.x0, cy0 + tbx.y1 + 2), U1 = tr.vp.convertToPdfPoint(cx0 + tbx.x1, cy0 + tbx.y1 + 2);
          annots.push({ rect: [Math.min(A[0], B[0]), Math.min(A[1], B[1]), Math.max(A[0], B[0]), Math.max(A[1], B[1])], ul: [U0[0], U0[1], U1[0], U1[1]], uri: hit.e.v });
          stats.linked++;
        }
        annots.forEach(function (a) {
          var ctx = out.context;
          var act = ctx.obj({ S: 'URI', URI: PDFLib.PDFString.of(root.ShippingCore.encodeUri(a.uri)) });
          pdfPage.node.addAnnot(ctx.register(ctx.obj({ Type: 'Annot', Subtype: 'Link', Rect: a.rect, Border: [0, 0, 0], A: act })));
          pdfPage.drawLine({ start: { x: a.ul[0], y: a.ul[1] }, end: { x: a.ul[2], y: a.ul[3] }, thickness: 0.9, color: PDFLib.rgb(0, 0.2, 0.9) });
        });
      }
    } finally { doc.destroy(); }
    return { bytes: await out.save(), stats: stats };
  }

  var api = { linkDrawing: linkDrawing, fold: fold, snapCell: snapCell, boxPx: boxPx };
  if (typeof module !== 'undefined' && module.exports) module.exports = api; else root.ShippingDrawing = api;
})(typeof window !== 'undefined' ? window : this);
