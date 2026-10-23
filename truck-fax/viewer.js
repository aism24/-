// 取り込んだFAX(PDF・画像)を、画面の下に大きく表示する。ホイールでズーム、ドラッグで上下左右に移動。
// PDFの描画には pdf.js(無料。CDNから必要になったときだけ読み込む)を使う。読み込めないときは、ブラウザ標準のPDF表示に切り替える。
(function (root) {
  'use strict';
  var BASE = 'https://cdnjs.cloudflare.com/ajax/libs/pdf.js/3.11.174/';
  var STAGE_W = 1000; // 表示の基準幅(CSS px)。PDFはこの3倍の解像度で描く
  var pdfLoading = null;

  function loadPdfJs() {
    if (root.pdfjsLib) return Promise.resolve(root.pdfjsLib);
    if (!pdfLoading) pdfLoading = new Promise(function (resolve, reject) {
      var s = document.createElement('script');
      s.src = BASE + 'pdf.min.js';
      s.onload = function () { root.pdfjsLib.GlobalWorkerOptions.workerSrc = BASE + 'pdf.worker.min.js'; resolve(root.pdfjsLib); };
      s.onerror = function () { pdfLoading = null; reject(new Error('pdf.js を読み込めませんでした')); };
      document.head.appendChild(s);
    });
    return pdfLoading;
  }

  function el(tag, cls, text) { var e = document.createElement(tag); if (cls) e.className = cls; if (text) e.textContent = text; return e; }

  /** opts.onRotate(delta): 指定すると、原本の上に「↺ 左に90°」「↻ 右に90°」を出す(押すと delta=-90/+90 で呼ぶ) */
  function create(file, mime, url, opts) {
    var box = el('div', 'viewer');
    var bar = el('div', 'viewer-bar');
    var label = el('span', 'viewer-zoom', '');
    var stage = el('div', 'viewer-stage');
    var msg = el('div', 'viewer-msg', '原本を読み込んでいます…');
    box.appendChild(stage); box.appendChild(msg); box.appendChild(bar);
    stage.style.width = STAGE_W + 'px';
    var scale = 1, tx = 0, ty = 0, fitScale = 1;

    function apply() {
      stage.style.transform = 'translate(' + tx + 'px,' + ty + 'px) scale(' + scale + ')';
      label.textContent = Math.round(scale / fitScale * 100) + '%';
    }
    function fit() {
      fitScale = scale = Math.max(0.1, (box.clientWidth || STAGE_W) / STAGE_W);
      tx = 0; ty = 0; apply();
    }
    function zoomAt(factor, cx, cy) {
      var ns = Math.min(fitScale * 8, Math.max(fitScale * 0.3, scale * factor)), r = ns / scale;
      tx = cx - (cx - tx) * r; ty = cy - (cy - ty) * r; scale = ns; apply();
    }
    function btn(text, title, fn) { var b = el('button', 'btn sm', text); b.type = 'button'; b.title = title; b.addEventListener('click', fn); return b; }
    bar.appendChild(btn('−', '縮小', function () { zoomAt(1 / 1.3, box.clientWidth / 2, box.clientHeight / 2); }));
    bar.appendChild(label);
    bar.appendChild(btn('＋', '拡大', function () { zoomAt(1.3, box.clientWidth / 2, box.clientHeight / 2); }));
    bar.appendChild(btn('全体表示', '幅に合わせる', fit));
    if (opts && opts.onRotate) {
      bar.appendChild(btn('↺ 左に90°', '原本を左に90°回す(保存する原本も回る)', function () { opts.onRotate(-90); }));
      bar.appendChild(btn('↻ 右に90°', '原本を右に90°回す(保存する原本も回る)', function () { opts.onRotate(90); }));
    }

    box.addEventListener('wheel', function (e) {
      e.preventDefault();
      var r = box.getBoundingClientRect();
      zoomAt(Math.exp(-e.deltaY * (e.deltaMode === 1 ? 0.05 : 0.0015)), e.clientX - r.left, e.clientY - r.top);
    }, { passive: false });
    var drag = null;
    box.addEventListener('pointerdown', function (e) {
      if (e.button !== 0 || e.target.closest('.viewer-bar')) return;
      drag = { x: e.clientX, y: e.clientY, tx: tx, ty: ty };
      box.setPointerCapture(e.pointerId); box.classList.add('grabbing');
    });
    box.addEventListener('pointermove', function (e) { if (!drag) return; tx = drag.tx + e.clientX - drag.x; ty = drag.ty + e.clientY - drag.y; apply(); });
    function end() { drag = null; box.classList.remove('grabbing'); }
    box.addEventListener('pointerup', end); box.addEventListener('pointercancel', end);
    box.addEventListener('dblclick', function (e) { if (!e.target.closest('.viewer-bar')) fit(); });

    function done() { msg.remove(); fit(); }
    function fallback(why) {
      stage.textContent = ''; bar.remove();
      msg.textContent = '原本を拡大表示できないため、ブラウザの表示に切り替えました(' + why + ')';
      var f = el('iframe', 'viewer-frame'); f.src = url + '#navpanes=0&view=FitH'; f.title = '原本';
      box.textContent = ''; box.appendChild(msg); box.appendChild(f); box.classList.add('plain');
    }

    if (mime === 'application/pdf') {
      Promise.all([loadPdfJs(), file.arrayBuffer()]).then(function (v) {
        return v[0].getDocument({ data: v[1] }).promise;
      }).then(async function (pdf) {
        for (var p = 1; p <= pdf.numPages; p++) {
          var page = await pdf.getPage(p);
          var base = page.getViewport({ scale: 1 }), k = STAGE_W * 3 / base.width;
          var vp = page.getViewport({ scale: k });
          var c = document.createElement('canvas'); c.width = Math.round(vp.width); c.height = Math.round(vp.height);
          c.style.width = STAGE_W + 'px'; c.style.height = Math.round(vp.height / 3) + 'px';
          stage.appendChild(c);
          await page.render({ canvasContext: c.getContext('2d'), viewport: vp }).promise;
        }
        done();
      }).catch(function (e) { fallback(e.message || '描画に失敗'); });
    } else {
      var img = el('img'); img.alt = '原本'; img.draggable = false; img.style.width = STAGE_W + 'px'; img.style.display = 'block';
      img.onload = done; img.onerror = function () { msg.textContent = '画像を表示できませんでした。'; };
      img.src = url; stage.appendChild(img);
    }
    return box;
  }

  /** pdf.js を先に読み込んでおく(取込一覧を開いたとき。原本を初めて開くときの待ち時間を減らす)。失敗しても何もしない */
  function preload() {
    loadPdfJs().then(function () { return fetch(BASE + 'pdf.worker.min.js'); }).catch(function () {});
  }

  // ---------- 原本の回転(表示も、Driveに保存する原本も、回したものにする) ----------
  var LIB_URL = 'https://cdnjs.cloudflare.com/ajax/libs/pdf-lib/1.17.1/pdf-lib.min.js', libLoading = null;
  function loadPdfLib() {
    if (root.PDFLib) return Promise.resolve(root.PDFLib);
    if (!libLoading) libLoading = new Promise(function (resolve, reject) {
      var s = document.createElement('script'); s.src = LIB_URL;
      s.onload = function () { resolve(root.PDFLib); };
      s.onerror = function () { libLoading = null; reject(new Error('pdf-lib を読み込めませんでした')); };
      document.head.appendChild(s);
    });
    return libLoading;
  }
  /** 原本(PDF・PNG・JPEG)を時計回りに deg(90の倍数)回したファイルを返す。PDFはページの向きの設定だけを変える(画質は変わらない)。画像は描き直す */
  function rotateFile(file, mime, deg) {
    deg = ((deg % 360) + 360) % 360;
    if (!deg) return Promise.resolve(file);
    if (mime === 'application/pdf') {
      return Promise.all([loadPdfLib(), file.arrayBuffer()]).then(function (v) {
        var lib = v[0];
        return lib.PDFDocument.load(v[1], { ignoreEncryption: true }).then(function (doc) {
          doc.getPages().forEach(function (pg) { pg.setRotation(lib.degrees((pg.getRotation().angle + deg) % 360)); });
          return doc.save();
        });
      }).then(function (bytes) { return new File([bytes], file.name || 'fax.pdf', { type: mime }); });
    }
    return new Promise(function (resolve, reject) {
      var u = URL.createObjectURL(file), img = new Image();
      img.onload = function () {
        var side = deg % 180 !== 0, c = document.createElement('canvas');
        c.width = side ? img.naturalHeight : img.naturalWidth; c.height = side ? img.naturalWidth : img.naturalHeight;
        var ctx = c.getContext('2d');
        ctx.translate(c.width / 2, c.height / 2); ctx.rotate(deg * Math.PI / 180); ctx.drawImage(img, -img.naturalWidth / 2, -img.naturalHeight / 2);
        URL.revokeObjectURL(u);
        c.toBlob(function (b) { if (b) resolve(new File([b], file.name || 'fax', { type: mime })); else reject(new Error('画像を回せませんでした')); }, mime, 0.92);
      };
      img.onerror = function () { URL.revokeObjectURL(u); reject(new Error('画像を読み込めませんでした')); };
      img.src = u;
    });
  }

  // ---------- 原本の向きの判定(画像から。Geminiは向きを正しく返さないため。2026-10-23 実測) ----------
  // 配車連絡表は横長の表。①罫線(長い線)が横に多いか縦に多いかで、正立・逆さま か 横倒し かを決め、
  // ②表(縦線のある範囲)の中心が下寄り・文字(表題・宛名・住所)が上寄りなら正立。ユーザーのFAX 5枚×4方向=20通りで全問正解(2026-10-23)。
  function grayOf(file, mime, width) {
    if (mime === 'application/pdf') {
      return Promise.all([loadPdfJs(), file.arrayBuffer()]).then(function (v) { return v[0].getDocument({ data: v[1] }).promise; })
        .then(function (pdf) { return pdf.getPage(1); }).then(function (page) {
          var base = page.getViewport({ scale: 1 }), vp = page.getViewport({ scale: width / base.width });
          var c = document.createElement('canvas'); c.width = Math.round(vp.width); c.height = Math.round(vp.height);
          var ctx = c.getContext('2d'); ctx.fillStyle = '#fff'; ctx.fillRect(0, 0, c.width, c.height);
          return page.render({ canvasContext: ctx, viewport: vp }).promise.then(function () { return c; });
        }).then(toGray);
    }
    return new Promise(function (resolve, reject) {
      var u = URL.createObjectURL(file), img = new Image();
      img.onload = function () {
        var k = width / img.naturalWidth, c = document.createElement('canvas'); c.width = width; c.height = Math.round(img.naturalHeight * k);
        var ctx = c.getContext('2d'); ctx.fillStyle = '#fff'; ctx.fillRect(0, 0, c.width, c.height); ctx.drawImage(img, 0, 0, c.width, c.height);
        URL.revokeObjectURL(u); resolve(toGray(c));
      };
      img.onerror = function () { URL.revokeObjectURL(u); reject(new Error('画像を読み込めませんでした')); };
      img.src = u;
    });
  }
  function toGray(c) { // 黒=1、白=0 の配列
    var d = c.getContext('2d').getImageData(0, 0, c.width, c.height).data, n = c.width * c.height, g = new Uint8Array(n);
    for (var i = 0; i < n; i++) g[i] = (d[i * 4] * 0.299 + d[i * 4 + 1] * 0.587 + d[i * 4 + 2] * 0.114) < 128 ? 1 : 0;
    return { w: c.width, h: c.height, d: g };
  }
  function rot90cw(m) { // 時計回りに90°
    var w = m.h, h = m.w, d = new Uint8Array(w * h);
    for (var y = 0; y < m.h; y++) for (var x = 0; x < m.w; x++) d[x * w + (m.h - 1 - y)] = m.d[y * m.w + x];
    return { w: w, h: h, d: d };
  }
  function lineMasks(m) { // 長い横線・縦線(幅・高さの12%以上)の画素
    var hm = new Uint8Array(m.d.length), vm = new Uint8Array(m.d.length), Lh = Math.round(m.w * 0.12), Lv = Math.round(m.h * 0.12), hs = 0, vs = 0, x, y, s;
    for (y = 0; y < m.h; y++) for (x = 0, s = -1; x <= m.w; x++) {
      var on = x < m.w && m.d[y * m.w + x];
      if (on && s < 0) s = x; else if (!on && s >= 0) { if (x - s >= Lh) for (var k = s; k < x; k++) { hm[y * m.w + k] = 1; hs++; } s = -1; }
    }
    for (x = 0; x < m.w; x++) for (y = 0, s = -1; y <= m.h; y++) {
      var on2 = y < m.h && m.d[y * m.w + x];
      if (on2 && s < 0) s = y; else if (!on2 && s >= 0) { if (y - s >= Lv) for (var k2 = s; k2 < y; k2++) { vm[k2 * m.w + x] = 1; vs++; } s = -1; }
    }
    return { hm: hm, vm: vm, hs: hs, vs: vs };
  }
  function uprightScore(m, lm) { // 正立らしさ(正=正立、負=逆さま)
    var H = m.h, W = m.w, top = 0, bot = 0, vy0 = -1, vy1 = -1;
    for (var y = 0; y < H; y++) for (var x = 0; x < W; x++) {
      var i = y * W + x;
      if (lm.vm[i]) { if (vy0 < 0) vy0 = y; vy1 = y; }
      if (m.d[i] && !lm.hm[i] && !lm.vm[i]) { if (y < H / 3) top++; else if (y >= H - H / 3) bot++; }
    }
    var c = vy0 < 0 ? 0.5 : (vy0 + vy1) / 2 / H;
    return (c - 0.5) * 10 + Math.log((top + 1) / (bot + 1));
  }
  /** 原本を正しい向きにするには、時計回りに何度回せばよいか(0・90・180・270)。判定できないときは0 */
  function detectRotation(file, mime) {
    return grayOf(file, mime, 600).then(function (m) {
      var lm = lineMasks(m);
      if (lm.vs > lm.hs * 1.5) { var r = rot90cw(m); return uprightScore(r, lineMasks(r)) >= 0 ? 90 : 270; } // 横倒し
      if (lm.hs > lm.vs * 1.5) return uprightScore(m, lm) < -0.3 ? 180 : 0; // はっきり逆さまのときだけ180
      return 0;
    });
  }

  root.TruckViewer = { create: create, preload: preload, rotateFile: rotateFile, detectRotation: detectRotation };
})(typeof self !== 'undefined' ? self : this);
