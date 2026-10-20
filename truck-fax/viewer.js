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

  function create(file, mime, url) {
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

  root.TruckViewer = { create: create };
})(typeof self !== 'undefined' ? self : this);
