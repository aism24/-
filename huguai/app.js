/** ===================== 共通ユーティリティ ===================== */

function escapeHtml(str) {
  if (str === null || str === undefined) return '';
  return String(str)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
}

function stripLeadingNumber(str) {
  return String(str || '').replace(/^\d+\.\s*/, '');
}

function showToast(msg) {
  var root = document.getElementById('toastRoot');
  root.innerHTML = '<div class="toast">' + escapeHtml(msg) + '</div>';
  setTimeout(function () { root.innerHTML = ''; }, 2500);
}

function showLoading(msg) {
  document.getElementById('loadingRoot').innerHTML =
    '<div class="loading-overlay"><div class="loading-card">' +
    '<div class="loading-msg">' + escapeHtml(msg || '読み込み中...') + '</div>' +
    '<div class="loading-bar-track"><div class="loading-bar-fill" id="loadingBarFill"></div></div>' +
    '</div></div>';
  var fill = document.getElementById('loadingBarFill');
  requestAnimationFrame(function () {
    fill.style.transition = 'width 5s linear';
    fill.style.width = '100%';
  });
}
function hideLoading() {
  var fill = document.getElementById('loadingBarFill');
  var root = document.getElementById('loadingRoot');
  if (fill) {
    fill.style.transition = 'none';
    void fill.offsetWidth; // 進行中のtransitionを打ち切って強制的に再描画させる
    fill.style.width = '100%';
    void fill.offsetWidth; // 100%になった状態を必ず1フレーム描画させる
    setTimeout(function () { root.innerHTML = ''; }, 250);
  } else {
    root.innerHTML = '';
  }
}

/** GAS WebアプリのURL（config.js で定義） */
/** localStorage(使えない環境でも動くよう、失敗は無視する) */
var Store = {
  get: function (k) { try { var v = localStorage.getItem('hg:' + k); return v ? JSON.parse(v) : null; } catch (e) { return null; } },
  set: function (k, v) { try { localStorage.setItem('hg:' + k, JSON.stringify(v)); } catch (e) {} },
  del: function (k) { try { localStorage.removeItem('hg:' + k); } catch (e) {} }
};

function loadScript(src) {
  return new Promise(function (resolve, reject) {
    var el = document.createElement('script');
    el.src = src;
    el.onload = resolve;
    el.onerror = function () { reject(new Error('読み込みに失敗しました: ' + src)); };
    document.head.appendChild(el);
  });
}

/** PDF用ライブラリは、PDFを作るときだけ読み込む(通常の画面表示を軽くする) */
var PdfLibs = {
  p: null,
  load: function () {
    if (!PdfLibs.p) {
      PdfLibs.p = Promise.all([
        loadScript('https://cdnjs.cloudflare.com/ajax/libs/jspdf/2.5.1/jspdf.umd.min.js'),
        loadScript('https://cdnjs.cloudflare.com/ajax/libs/html2canvas/1.4.1/html2canvas.min.js')
      ]).catch(function (e) { PdfLibs.p = null; throw e; });
    }
    return PdfLibs.p;
  }
};

function callServer(fnName) {
  var args = Array.prototype.slice.call(arguments, 1);
  // text/plain にすることでCORSプリフライトを避ける（GASはOPTIONS非対応）
  var t0 = Date.now();
  return fetch(GAS_API_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'text/plain;charset=utf-8' },
    body: JSON.stringify({ fn: fnName, args: args })
  }).then(function (r) { return r.json(); }).then(function (res) {
    // 合計時間とGAS内の処理時間(server)の差が通信・起動のオーバーヘッド
    console.log('[API] ' + fnName + ' total=' + (Date.now() - t0) + 'ms server=' + res.ms + 'ms');
    if (!res.ok) throw new Error(res.error || 'サーバーエラー');
    return res.data;
  });
}

function resizeImageFile(file, maxDim) {
  return new Promise(function (resolve, reject) {
    var reader = new FileReader();
    reader.onload = function (e) {
      var img = new Image();
      img.onload = function () {
        var w = img.width, h = img.height;
        if (w > h && w > maxDim) { h = Math.round(h * maxDim / w); w = maxDim; }
        else if (h > maxDim) { w = Math.round(w * maxDim / h); h = maxDim; }
        var canvas = document.createElement('canvas');
        canvas.width = w; canvas.height = h;
        canvas.getContext('2d').drawImage(img, 0, 0, w, h);
        var dataUrl = canvas.toDataURL('image/jpeg', 0.75);
        resolve({ base64: dataUrl.split(',')[1], mimeType: 'image/jpeg', dataUrl: dataUrl });
      };
      img.onerror = reject;
      img.src = e.target.result;
    };
    reader.onerror = reject;
    reader.readAsDataURL(file);
  });
}

function todayStr() {
  var d = new Date();
  var m = String(d.getMonth() + 1).padStart(2, '0');
  var day = String(d.getDate()).padStart(2, '0');
  return d.getFullYear() + '-' + m + '-' + day;
}

var GoogleChartsReady = new Promise(function (resolve) {
  google.charts.load('current', { packages: ['corechart'] });
  google.charts.setOnLoadCallback(resolve);
});

/** ===================== App本体 ===================== */

var LOGO_SRC_WHITE = 'data:image/svg+xml;base64,PHN2ZyB4bWxucz0iaHR0cDovL3d3dy53My5vcmcvMjAwMC9zdmciIHZpZXdCb3g9IjAgMCA0NjQgNTE0IiB3aWR0aD0iMTAwJSIgaGVpZ2h0PSIxMDAlIj4KICA8IS0tIOato+WFiSAobWFzYW1peikgTG9nbyBNYXJrIC0tPgogIDxwYXRoIGQ9Ik0gMzk4IDE1OCBMIDM5NiAxNTkgTCAzOTIgMTYxIEwgMzg3IDE2NSBMIDM4MCAxNjggTCAzNzMgMTczIEwgMzcxIDE3MyBMIDM2OCAxNzUgTCAzNzAgMTc5IEwgMzczIDE5MCBMIDM3NCAxOTUgTCAzNzUgMjAxIEwgMzc2IDIwNyBMIDM3NyAyMjAgTCAzNzYgMjQwIEwgMzc1IDI0NiBMIDM3NCAyNTIgTCAzNzMgMjU3IEwgMzcxIDI2NCBMIDM2NyAyNzYgTCAzNjMgMjg1IEwgMzYyIDI4NyBMIDM2MCAyODkgTCAzNjAgMjkxIEwgMzU3IDI5NiBMIDM0OSAzMDggTCAzNDYgMzEyIEwgMzQwIDMxOSBMIDMyOCAzMzEgTCAzMjIgMzM2IEwgMzE4IDMzOSBMIDMxNCAzNDIgTCAzMTEgMzQ0IEwgMzA2IDM0NyBMIDMwMSAzNTAgTCAyOTMgMzU0IEwgMjg2IDM1NyBMIDI4MSAzNTkgTCAyNzggMzYwIEwgMjcxIDM2MSBMIDI2OCAzNjMgTCAyNjMgMzY0IEwgMjU3IDM2NSBMIDI1MiAzNjYgTCAyNDkgMzY1IEwgMjUwIDMxMSBMIDI1MyAzMTAgTCAyNTcgMzEwIEwgMjYxIDMwOSBMIDI2OSAzMDYgTCAyNzEgMzA1IEwgMjczIDMwMyBMIDI3NSAzMDMgTCAyODAgMzAwIEwgMjg2IDI5NSBMIDI4OCAyOTUgTCAyOTMgMjg5IEwgMjk0IDI4OCBMIDI5NyAyODcgTCAzMDUgMjc4IEwgMzA3IDI3NSBMIDMwNyAyNzMgTCAzMDQgMjcxIEwgMjk0IDI2NiBMIDI5MCAyNjMgTCAyODggMjYzIEwgMjg2IDI2NSBMIDI3NiAyNzYgTCAyNzIgMjc5IEwgMjY5IDI4MSBMIDI2NCAyODQgTCAyNTcgMjg3IEwgMjU0IDI4OCBMIDI1MSAyODkgTCAyNDEgMjg5IEwgMjQwIDI5MSBMIDIyOCAyOTAgTCAyMTggMjg5IEwgMjE0IDI4OCBMIDIxMSAyODcgTCAyMDkgMjg1IEwgMTk5IDI4MSBMIDE5NSAyNzggTCAxOTEgMjc1IEwgMTkwIDI3NCBMIDE4OCAyNzIgTCAxODcgMjcxIEwgMTgxIDI2MyBMIDE3OCAyNjUgTCAxNjEgMjc0IEwgMTYyIDI3NiBMIDE2NSAyODAgTCAxNzQgMjg4IEwgMTc1IDI4OSBMIDE3NSAyOTAgTCAxNzcgMjkyIEwgMTgxIDI5NSBMIDE4NSAyOTggTCAxODggMzAwIEwgMTkzIDMwMyBMIDE5NSAzMDQgTCAxOTcgMzA0IEwgMTk5IDMwNiBMIDIwMiAzMDcgTCAyMTEgMzEwIEwgMjE1IDMxMSBMIDIyMCAzMTIgTCAyMjAgNDAwIEwgMjMxIDQwMSBMIDIzMyA0MDEgTCAyMzggNDAxIEwgMjU0IDQwMCBMIDI2NiAzOTggTCAyNzIgMzk3IEwgMjgzIDM5NCBMIDI5NSAzOTAgTCAzMDAgMzg4IEwgMzA3IDM4NSBMIDMwOSAzODMgTCAzMjEgMzc4IEwgMzI2IDM3NSBMIDMyOSAzNzMgTCAzMzIgMzcwIEwgMzM1IDM2OSBMIDMzOSAzNjYgTCAzNDQgMzYxIEwgMzQ3IDM2MCBMIDM0OCAzNTkgTCAzNDggMzU4IEwgMzQ5IDM1NyBMIDM2OCAzMzkgTCAzNzIgMzM0IEwgMzc3IDMyOCBMIDM3OSAzMjUgTCAzODYgMzE0IEwgMzg5IDMwOSBMIDM5MiAzMDMgTCAzOTIgMzAxIEwgMzk0IDI5OSBMIDM5NSAyOTQgTCAzOTggMjkwIEwgNDAxIDI4MiBMIDQwNCAyNzIgTCA0MDcgMjYxIEwgNDA4IDI1NCBMIDQwOSAyNDggTCA0MTAgMjQxIEwgNDEwIDIwNiBMIDQwOSAxOTkgTCA0MDggMTkzIEwgNDA3IDE4NyBMIDQwNCAxNzQgTCA0MDIgMTcxIEwgNDAyIDE2OCBMIDQwMSAxNjUgTCAzOTkgMTYyIFogTSA4OSAxMjQgTCA4NyAxMjYgTCA4NSAxMjkgTCA4MyAxMzIgTCA3NyAxNDMgTCA3NyAxNDUgTCA3NSAxNDcgTCA3MCAxNTkgTCA2OCAxNjQgTCA2NSAxNzQgTCA2MiAxODUgTCA2MiAxOTEgTCA1OSAyMDIgTCA1OCAyMTUgTCA1OSAyMTggTCA1OCAyMzIgTCA1OSAyNDQgTCA2MSAyNTYgTCA2MiAyNjIgTCA2NCAyNjYgTCA2NCAyNzAgTCA2NyAyODAgTCA2OCAyODMgTCA3MSAyOTEgTCA3MyAyOTMgTCA3NSAzMDAgTCA3NyAzMDIgTCA3NyAzMDQgTCA4MyAzMTUgTCA4NyAzMjEgTCA5MiAzMjcgTCA5MyAzMzAgTCA5NiAzMzQgTCA5OCAzMzYgTCAxMDIgMzQxIEwgMTA1IDM0MyBMIDExOCAzNTcgTCAxMjQgMzYyIEwgMTM1IDM3MCBMIDEzOCAzNzIgTCAxNDEgMzc0IEwgMTQ2IDM3NyBMIDE1MyAzODEgTCAxNTUgMzgyIEwgMTU3IDM4MiBMIDE1OSAzODQgTCAxNjEgMzg1IEwgMTY4IDM4OCBMIDE3NiAzOTEgTCAxODkgMzk1IEwgMTkzIDM5NSBMIDE5NyAzOTcgTCAyMDIgMzk4IEwgMjA4IDM5OSBMIDIwOSAzNjQgTCAyMDYgMzY0IEwgMjA1IDM2MyBMIDIwMSAzNjMgTCAxOTEgMzYwIEwgMTg3IDM1OSBMIDE4NSAzNTcgTCAxODAgMzU2IEwgMTczIDM1MyBMIDE3MSAzNTEgTCAxNjkgMzUxIEwgMTYyIDM0NyBMIDE1MyAzNDEgTCAxNDkgMzM4IEwgMTQ0IDMzNCBMIDEzNyAzMjggTCAxMzYgMzI3IEwgMTM1IDMyNiBMIDEzMyAzMjQgTCAxMjQgMzE0IEwgMTIwIDMwOSBMIDExNyAzMDUgTCAxMTUgMzAyIEwgMTEyIDI5NyBMIDEwOCAyOTAgTCAxMDcgMjg4IEwgMTAxIDI3NCBMIDk4IDI2NiBMIDk4IDI2MiBMIDk1IDI1NSBMIDk0IDI0OSBMIDkzIDI0NCBMIDkyIDIzMyBMIDkyIDIxNCBMIDkzIDIwNCBMIDk0IDE5OCBMIDk1IDE5MiBMIDk4IDE4MiBMIDEwMSAxNzMgTCAxMDUgMTY2IEwgMTA3IDE2NyBMIDExMSAxNjkgTCAxMTggMTczIEwgMTI1IDE3OCBMIDEzMiAxODEgTCAxMzkgMTg1IEwgMTQ5IDE5MSBMIDE1MSAxOTQgTCAxNDkgMTk3IEwgMTQ4IDIwMiBMIDE0NyAyMDYgTCAxNDYgMjExIEwgMTQ2IDIzNiBMIDE0OCAyNDEgTCAxNDggMjQ2IEwgMTUyIDI1OCBMIDE1NCAyNjIgTCAxNTYgMjYyIEwgMTYwIDI1OSBMIDE2OCAyNTUgTCAxNzMgMjUyIEwgMTczIDI0OSBMIDE3MSAyNDYgTCAxNjkgMjM5IEwgMTY4IDIzNCBMIDE2OCAyMTMgTCAxNzAgMjA1IEwgMTcxIDIwMSBMIDE3NCAxOTQgTCAxNzcgMTg5IEwgMTc5IDE4NiBMIDE4MSAxODMgTCAxODYgMTc3IEwgMTg4IDE3NSBMIDE5NCAxNzAgTCAxOTcgMTY4IEwgMjAwIDE2NiBMIDIwNSAxNjMgTCAyMDcgMTYyIEwgMjEyIDE2MCBMIDIxNSAxNTkgTCAyMjIgMTU3IEwgMjI4IDE1NiBMIDIyNyAxMzUgTCAyMjAgMTM1IEwgMjExIDEzNyBMIDIwMiAxNDAgTCAxOTkgMTQxIEwgMTkzIDE0NCBMIDE4OCAxNDcgTCAxODUgMTQ5IEwgMTgyIDE1MSBMIDE3OCAxNTQgTCAxNjUgMTY3IEwgMTYzIDE2NiBMIDE2MSAxNjQgTCAxNTUgMTYxIEwgMTM5IDE1MSBMIDEzMiAxNDcgTCAxMjggMTQ2IEwgMTIzIDE0MiBMIDExMSAxMzUgTCAxMDQgMTMxIEwgOTUgMTI2IEwgOTEgMTI0IFogTSAyMTkgNDYgTCAyMTAgNDcgTCAxOTkgNDkgTCAxOTQgNTAgTCAxODMgNTMgTCAxODAgNTUgTCAxNzcgNTUgTCAxNzQgNTYgTCAxNjYgNTkgTCAxNjQgNjEgTCAxNDggNjggTCAxNDMgNzEgTCAxMzcgNzUgTCAxMzQgNzcgTCAxMzIgNzkgTCAxMzIgODAgTCAxMzEgODEgTCAxMjcgODMgTCAxMjIgODcgTCAxMTYgOTIgTCAxMDcgMTAyIEwgMTA1IDEwMyBMIDEwNCAxMDQgTCA5OSAxMTEgTCA5NiAxMTMgTCA5NyAxMTUgTCAxMDAgMTE2IEwgMTEyIDEyNCBMIDEyMSAxMjkgTCAxMjMgMTI5IEwgMTI1IDEzMSBMIDEyNyAxMzEgTCAxNDMgMTE0IEwgMTQ5IDEwOSBMIDE1NiAxMDQgTCAxNjEgMTAxIEwgMTY2IDk4IEwgMTcwIDk2IEwgMTc2IDkzIEwgMTgzIDkwIEwgMTg4IDg4IEwgMTk4IDg1IEwgMjAyIDg0IEwgMjExIDgyIEwgMjE5IDgxIEwgMjUwIDgxIEwgMjU4IDgyIEwgMjY3IDg0IEwgMjcxIDg1IEwgMjc4IDg3IEwgMjgxIDg4IEwgMjg5IDkxIEwgMjkxIDkzIEwgMzAzIDk4IEwgMzEwIDEwMiBMIDMxMyAxMDQgTCAzMTYgMTA2IEwgMzIwIDEwOSBMIDMyNSAxMTMgTCAzNDMgMTMxIEwgMzQ3IDEzNiBMIDM0OCAxNDEgTCAzNDYgMTQxIEwgMzQxIDE0NCBMIDMyOSAxNTEgTCAzMTcgMTU5IEwgMzEyIDE2MiBMIDMwOCAxNjMgTCAzMDUgMTY1IEwgMzAzIDE2NyBMIDMwMSAxNjUgTCAyOTIgMTU1IEwgMjg3IDE1MSBMIDI3OSAxNDYgTCAyNzUgMTQ0IEwgMjY5IDE0MSBMIDI2MSAxMzggTCAyNTcgMTM3IEwgMjQ5IDEzNSBMIDI0MSAxMzUgTCAyNDEgMTU3IEwgMjQ3IDE1NyBMIDI1NCAxNTkgTCAyNTcgMTYwIEwgMjY0IDE2MyBMIDI2OSAxNjYgTCAyNzIgMTY4IEwgMjc2IDE3MSBMIDI4OCAxODMgTCAyOTAgMTg2IEwgMjkzIDE5MSBMIDI5NiAxOTcgTCAyOTggMjAyIEwgMjk5IDIwNiBMIDMwMCAyMTAgTCAzMDEgMjE1IEwgMzAxIDIzMSBMIDMwMCAyMzcgTCAyOTggMjQ0IEwgMjk2IDI0NyBMIDI5NSAyNTAgTCAyOTggMjUzIEwgMzAzIDI1NiBMIDMxMiAyNjAgTCAzMTUgMjYyIEwgMzE3IDI1NyBMIDMyMCAyNDkgTCAzMjEgMjQ0IEwgMzIxIDIzOSBMIDMyMyAyMzYgTCAzMjMgMjEzIEwgMzIxIDIwMiBMIDMyMCAxOTggTCAzMTggMTk1IEwgMzE5IDE5MSBMIDMyMiAxOTAgTCAzMzEgMTg0IEwgMzQ0IDE3NiBMIDM1MSAxNzIgTCAzNTggMTY4IEwgMzYwIDE2OCBMIDM2NSAxNjUgTCAzODkgMTUwIEwgMzkwIDE1MCBMIDM5MiAxNDkgTCAzOTMgMTQ2IEwgMzg5IDE0MCBMIDM4OSAxMzggTCAzODggMTM2IEwgMzgzIDEyOCBMIDM3NyAxMTkgTCAzNzQgMTE1IEwgMzcwIDExMCBMIDM2NSAxMDQgTCAzNTUgOTQgTCAzNTQgOTMgTCAzNDggODggTCAzNDcgODggTCAzNDEgODMgTCAzMzggNzkgTCAzMjYgNzEgTCAzMjEgNjggTCAzMDcgNjEgTCAyOTUgNTYgTCAyODYgNTMgTCAyNzUgNTAgTCAyNzAgNDkgTCAyNjUgNDkgTCAyNjAgNDcgTCAyNDkgNDYgWiIgZmlsbD0iI0U3NDE1NSIgZmlsbC1ydWxlPSJldmVub2RkIiAvPgogIAogIDwhLS0gbWFzYW1peiBUZXh0IC0tPgogIDxwYXRoIGQ9Ik0gMzYzIDQzOCBMIDM2NCA0NTAgTCAzNzAgNDUwIEwgMzc2IDQ1MCBMIDM4NSA0NTAgTCAzOTEgNDUwIEwgMzg4IDQ1MiBMIDM4MSA0NTUgTCAzNzQgNDYwIEwgMzY1IDQ2NCBMIDM2MyA0NjYgTCAzNjQgNDg1IEwgNDIxIDQ4NSBMIDQyMSA0NzMgTCAzODkgNDcyIEwgMzkyIDQ3MCBMIDM5NyA0NjcgTCA0MDEgNDY2IEwgNDA2IDQ2MyBMIDQxNSA0NTcgTCA0MTggNDU2IEwgNDIwIDQ1NSBMIDQyMSA0MzcgWiBNIDI5OCA0MzYgTCAyOTggNDg1IEwgMzE2IDQ4NSBMIDMxNyA0NDggTCAzMjAgNDQ5IEwgMzIwIDQ4NSBMIDMzOCA0ODQgTCAzMzkgNDQ4IEwgMzQzIDQ0OCBMIDM0OSA0NTMgTCAzNDIgNDU1IEwgMzQyIDQ3MSBMIDM0MyA0ODUgTCAzNjAgNDg1IEwgMzYwIDQ1NCBMIDM1MyA0NTMgTCAzNTggNDQ5IEwgMzU5IDQ0NyBMIDM1OSA0NDIgTCAzNTcgNDM4IEwgMzU2IDQzOCBMIDM1NCA0MzYgTCAzNDggNDM2IEwgMzQ2IDQzNyBMIDM0NCA0MzkgTCAzNDMgNDQxIEwgMzQyIDQzNiBaIE0gMjM2IDQzNiBMIDIzNiA0NTAgTCAyNDUgNDUwIEwgMjQ4IDQ0OSBMIDI1MSA0NTAgTCAyNjAgNDUwIEwgMjc5IDQ1MCBMIDI3OCA0NTUgTCAyNDEgNDU1IEwgMjM5IDQ1NiBMIDIzNyA0NTggTCAyMzYgNDYwIEwgMjM2IDQ4NSBMIDI5NSA0ODUgTCAyOTUgNDQzIEwgMjk0IDQ0MSBMIDI5MyA0MzkgTCAyOTIgNDM4IEwgMjkxIDQzOCBMIDI4OSA0MzYgWiBNIDI1MyA0NjcgTCAyNzkgNDY4IEwgMjc4IDQ3MiBMIDI1MyA0NzMgWiBNIDE3OCA0MzYgTCAxNzUgNDM3IEwgMTcyIDQ0MCBMIDE3MSA0NDcgTCAxNzEgNDQ5IEwgMTcxIDQ1NCBMIDE3MyA0NTggTCAxNzUgNDU4IEwgMTc3IDQ2MCBMIDE3OSA0NjEgTCAxODEgNDYxIEwgMTgzIDQ2MyBMIDE5NCA0NjcgTCAxOTYgNDY5IEwgMjAzIDQ3MiBMIDE3MiA0NzMgTCAxNzEgNDc1IEwgMTcyIDQ4NSBMIDIyOCA0ODUgTCAyMzAgNDg0IEwgMjMxIDQ4MyBMIDIzMiA0ODEgTCAyMzIgNDY2IEwgMjI5IDQ2NCBMIDIyNCA0NjIgTCAyMTggNDYwIEwgMjE2IDQ1OCBMIDIxMCA0NTUgTCAyMDMgNDUzIEwgMjAxIDQ1MSBMIDE5OCA0NTAgTCAyMzIgNDQ5IEwgMjMyIDQzNiBaIE0gMTEwIDQzNiBMIDEwOSA0NTAgTCAxNTIgNDUxIEwgMTUxIDQ1NSBMIDExNyA0NTUgTCAxMTQgNDU2IEwgMTEyIDQ1NyBMIDExMCA0NTkgTCAxMDkgNDYxIEwgMTA5IDQ4NSBMIDE2OCA0ODUgTCAxNjggNDQyIEwgMTY3IDQ0MCBMIDE2NSA0MzggTCAxNjMgNDM3IEwgMTYwIDQzNiBMIDEzMyA0MzcgTCAxMTUgNDM3IFogTSAxMjcgNDY3IEwgMTUyIDQ2OCBMIDE1MSA0NzMgTCAxMjYgNDcyIFogTSA0NCA0MzYgTCA0MyA0NzQgTCA0NSA0ODYgTCA2MyA0ODUgTCA2NCA0NDggTCA2OCA0NDkgTCA2OCA0ODYgTCA3MyA0ODYgTCA4NCA0ODUgTCA4NSA0NDggTCA4OSA0NDkgTCA4OSA0ODUgTCAxMDYgNDg1IEwgMTA2IDQ0NSBMIDEwNSA0NDEgTCAxMDQgNDM5IEwgMTAzIDQzOCBMIDEwMSA0MzcgTCA5OSA0MzYgWiIgZmlsbD0iI0ZGRkZGRiIgZmlsbC1ydWxlPSJldmVub2RkIiAvPgo8L3N2Zz4=';

var App = {
  master: null,
  masterPromise: null,
  weightPromise: null,
  pf: {},
  mc: {},
  navId: 0,

  /** 生産重量(約12秒かかる集計)を、画面操作と並行して裏で取得しておく(保存済みなら即返る) */
  prefetchWeights: function () {
    App.weightPromise = callServer('getProductionWeights').catch(function () {
      App.weightPromise = null;
      return null;
    });
  },

  /** マスタを取得する。前回の値があればそれで先に動き、取得できたら差し替える */
  loadMaster: function () {
    App.masterPromise = callServer('getMasterData').then(function (data) {
      App.master = data;
      Store.set('master', data);
      return data;
    });
    App.masterPromise.catch(function (err) {
      if (!App.master) showToast('マスタデータの取得に失敗: ' + (err.message || err));
    });
  },

  /** マスタが必要な処理の前に呼ぶ。まだ無ければ読み込みを待つ */
  ready: function (fn) {
    if (App.master) { fn(); return; }
    showLoading('読み込み中...');
    App.masterPromise.then(function () { hideLoading(); fn(); })
      .catch(function (err) { hideLoading(); showToast('マスタデータの取得に失敗: ' + (err.message || err)); });
  },

  /** 結果分析・一覧の初回データ。直近(30秒以内)に取得済み/取得中のものがあればそれを使う */
  fetchBoot: function (name, fn) {
    var e = App.pf[name];
    if (e && Date.now() - e.t < 30000) return e.p;
    var p = callServer(fn);
    p.catch(function () { if (App.pf[name] && App.pf[name].p === p) delete App.pf[name]; });
    App.pf[name] = { t: Date.now(), p: p };
    return p;
  },

  /** ホームにいる間に、結果分析と一覧のデータを裏で取得しておく(サーバー側のキャッシュも温まる) */
  prefetchBoots: function () {
    App.fetchBoot('kb', 'getKekkaBunsekiBootstrap').catch(function () {});
    App.fetchBoot('rb', 'getRecordsBootstrap').catch(function () {});
  },

  /** 保存したときなど、前回の結果を捨てる */
  invalidate: function () {
    App.pf = {};
    App.mc = {};
    Store.del('kb');
    Store.del('rb');
  },

  /** 「最新データに更新」: サーバーのキャッシュも捨てて取り直す(シートを直接編集したとき用) */
  refreshData: function () {
    showLoading('更新中...');
    callServer('clearCache').then(function () {
      App.invalidate();
      Store.del('master');
      App.loadMaster();
      App.prefetchBoots();
      return App.masterPromise;
    }).then(function () {
      hideLoading();
      showToast('最新データに更新しました');
    }).catch(function (err) {
      hideLoading();
      showToast('更新に失敗: ' + (err.message || err));
    });
  },

  init: function () {
    App.master = Store.get('master');
    App.loadMaster();
    App.prefetchWeights();
    App.showHome();
    setTimeout(App.prefetchBoots, 400);
  },

  setHeader: function (title, showBack, backFn) {
    App.navId++;
    var isHome = !showBack;
    document.getElementById('pageTitle').textContent = isHome ? '' : title;
    var backBtn = document.getElementById('backBtn');
    var homeBtn = document.getElementById('homeBtn');
    var header = document.querySelector('.header');
    if (showBack) {
      backBtn.classList.remove('hidden');
      homeBtn.classList.remove('hidden');
      App.currentBack = backFn || App.goHome;
    } else {
      backBtn.classList.add('hidden');
      homeBtn.classList.add('hidden');
    }
    header.classList.toggle('header-home', isHome);
    App.setHeaderAction(null);
    App.setHeaderAction2(null);
  },

  setHeaderAction: function (label, fn) {
    var btn = document.getElementById('headerActionBtn');
    if (label) {
      btn.textContent = label;
      btn.classList.remove('hidden');
      btn.onclick = fn;
    } else {
      btn.classList.add('hidden');
      btn.onclick = null;
    }
  },

  setHeaderAction2: function (label, fn, extraClass) {
    var btn = document.getElementById('headerAction2Btn');
    if (label) {
      btn.className = 'back-btn header-action-btn' + (extraClass ? ' ' + extraClass : '');
      btn.textContent = label;
      btn.classList.remove('hidden');
      btn.onclick = fn;
    } else {
      btn.classList.add('hidden');
      btn.onclick = null;
    }
  },

  goHome: function () { App.showHome(); },

  setWide: function (wide) {
    var appEl = document.getElementById('app');
    appEl.style.maxWidth = wide ? '1200px' : '';
    appEl.classList.toggle('sticky-analysis', !!wide);
  },

  showHome: function () {
    App.setWide(false);
    App.setHeader('', false);
    document.getElementById('view').innerHTML =
      '<div class="home-hero">' +
      '<div class="home-brand"><img class="home-logo" alt="masamiz" src="' + LOGO_SRC_WHITE + '"><h1 class="home-title">社内不具合アプリNew</h1></div>' +
      '<div class="menu-grid">' +
      '<button class="menu-btn" onclick="App.showInput()">新規入力</button>' +
      '<button class="menu-btn secondary" onclick="App.showRecords()">不具合記録</button>' +
      '<button class="menu-btn tertiary" onclick="App.showBunseki()">結果仕訳け</button>' +
      '<button class="menu-btn quaternary" onclick="App.showKekkaBunseki()">結果分析</button>' +
      '</div><button class="refresh-link" onclick="App.refreshData()">最新データに更新</button></div>';
  },

  showInput: function () {
    App.ready(function () {
      App.setWide(false);
      App.setHeader('新規入力', true, App.goHome);
      Wizard.start(null);
    });
  },

  showRecords: function () {
    App.setWide(false);
    App.setHeader('不具合記録', true, App.goHome);
    Records.show();
  },

  showBunseki: function () {
    App.setWide(false);
    App.setHeader('結果仕訳け', true, App.goHome);
    Bunseki.showMenu();
  },

  showKekkaBunseki: function () {
    App.setWide(true);
    App.setHeader('結果分析', true, App.goHome);
    KekkaBunseki.showTabs();
  }
};

(function () {
  var header = document.querySelector('.header');
  var appEl = document.getElementById('app');
  var sync = function () { appEl.style.setProperty('--hdr-h', header.offsetHeight + 'px'); };
  sync();
  if (window.ResizeObserver) new ResizeObserver(sync).observe(header);
  window.addEventListener('resize', sync);
})();

document.getElementById('backBtn').onclick = function () {
  (App.currentBack || App.goHome)();
};

window.addEventListener('load', App.init);

/** ===================== 入力ウィザード ===================== */

var Wizard = {
  formData: {},
  editingId: null,
  modalMode: false,

  start: function (record, inModal) {
    Wizard.modalMode = !!inModal;
    Wizard.editingId = record ? record['不具合記録ID'] : null;
    Wizard.formData = record ? Wizard.recordToForm(record) : {
      '発生日': todayStr(),
      '検査確認者': localStorage.getItem('lastInspector') || ''
    };
    Wizard.render();
  },

  recordToForm: function (r) {
    return {
      id: r['不具合記録ID'],
      '検査確認者': r['検査確認者'],
      '発生日': r['発生日'],
      '選択物件名': r['選択物件名'],
      '製品名': r['製品名'],
      '部署対象者': r['部署選択(対象者)'],
      '対象者': r['対象者'],
      '梁ロボ': r['梁ロボ'],
      '加工先': r['加工先'],
      '分類選択': r['分類選択'],
      '不具合内容': r['不具合内容、原因'],
      '対策': r['対策'],
      'コメント有無': r['コメント有無'],
      'コメント': r['コメント'],
      '状況写真Url': r['状況写真'],
      '製品名写真Url': r['製品名写真']
    };
  },

  setField: function (key, value) {
    Wizard.formData[key] = value;
    // 入力し直した項目の「未記入あり」表示は消す
    var errEl = document.getElementById('err_' + key);
    if (errEl && value) errEl.classList.add('hidden');
    Wizard.updateSaveButtonState();
  },

  container: function () {
    return Wizard.modalMode ? document.getElementById('wizardModalBody') : document.getElementById('view');
  },

  radioGroup: function (name, options, selected) {
    var html = '<div class="radio-group" id="rg_' + name + '">';
    options.forEach(function (opt) {
      var sel = (String(selected) === String(opt)) ? ' selected' : '';
      html += '<label class="' + sel.trim() + '" data-name="' + name + '" data-v="' + escapeHtml(opt) + '" onclick="Wizard.pickRadioEl(this)">' +
        '<input type="radio" name="' + name + '">' + escapeHtml(opt) + '</label>';
    });
    html += '</div>';
    return html;
  },

  pickRadioEl: function (el) { Wizard.pickRadio(el.getAttribute('data-name'), el.getAttribute('data-v')); },

  pickRadio: function (name, value) {
    Wizard.setField(name, value);
    var group = document.getElementById('rg_' + name);
    if (group) {
      Array.prototype.forEach.call(group.children, function (label) {
        var isSel = label.textContent.trim() === value;
        label.classList.toggle('selected', isSel);
      });
    }
    if (name === '部署対象者') Wizard.refreshPersonSelect('対象者Select', '部署対象者', '対象者');
    if (name === '加工先') Wizard.refreshClassSelect();
  },

  refreshPersonSelect: function (selectId, deptKey, fieldKey) {
    var dept = Wizard.formData[deptKey];
    var names = App.master.names.filter(function (n) { return n['部署'] === dept; }).map(function (n) { return n['氏名']; });
    Wizard.setField(fieldKey, '');
    var el = document.getElementById(selectId);
    if (el) {
      el.innerHTML = '<option value="">選択してください</option>' +
        names.map(function (n) { return '<option value="' + escapeHtml(n) + '">' + escapeHtml(n) + '</option>'; }).join('');
    }
  },

  refreshClassSelect: function () {
    var group = Wizard.formData['加工先'];
    var list = App.master.classifications.filter(function (c) { return c['加工分類'] === group; });
    Wizard.setField('分類選択', '');
    var el = document.getElementById('classSelect');
    if (el) {
      el.innerHTML = '<option value="">選択してください</option>' +
        list.map(function (c) { return '<option value="' + escapeHtml(c['分類']) + '">' + escapeHtml(c['分類']) + '</option>'; }).join('');
    }
  },

  onPropertyChange: function (value) {
    var newRow = document.getElementById('newPropertyRow');
    if (value === '__new__') {
      newRow.classList.remove('hidden');
      Wizard.setField('選択物件名', '');
      Wizard.formData.isNewProperty = true;
    } else {
      newRow.classList.add('hidden');
      Wizard.formData.isNewProperty = false;
      Wizard.setField('選択物件名', value);
    }
  },

  handlePhotoCapture: function (event, targetField, previewId) {
    var file = event.target.files[0];
    if (!file) return;
    resizeImageFile(file, 1280).then(function (res) {
      Wizard.formData[targetField + 'Base64'] = res.base64;
      Wizard.formData[targetField + 'MimeType'] = res.mimeType;
      var img = document.getElementById(previewId);
      if (img) { img.src = res.dataUrl; img.classList.remove('hidden'); }
      if (targetField === '製品名写真') {
        var ocrBtn = document.getElementById('ocrBtn');
        if (ocrBtn) ocrBtn.disabled = false;
      }
    });
  },

  runOcr: function () {
    var base64 = Wizard.formData['製品名写真Base64'];
    var mime = Wizard.formData['製品名写真MimeType'];
    if (!base64) { showToast('先に写真を撮影してください'); return; }
    showLoading('OCRで読み取り中...');
    callServer('ocrProductName', base64, mime).then(function (text) {
      hideLoading();
      Wizard.setField('製品名', text);
      var el = document.getElementById('productNameInput');
      if (el) el.value = text;
    }).catch(function (err) {
      hideLoading();
      showToast('OCR失敗: ' + (err.message || err));
    });
  },

  toggleCommentBox: function (value) {
    Wizard.setField('コメント有無', value);
    var box = document.getElementById('commentBox');
    if (box) box.classList.toggle('hidden', value !== 'あり');
  },

  REQUIRED_FIELDS: [
    { key: '検査確認者', label: '① 検査員' },
    { key: '発生日', label: '② 発生日' },
    { key: '選択物件名', label: '③ 物件名' },
    { key: '製品名', label: '⑤ 製品名' },
    { key: '部署対象者', label: '⑥ 対象部署' },
    { key: '対象者', label: '⑦ 対象者' },
    { key: '梁ロボ', label: '⑧ 梁ロボ' },
    { key: '加工先', label: '⑨ 加工先' },
    { key: '不具合内容', label: '⑩ 不具合内容、原因' },
    { key: '分類選択', label: '分類選択' },
    { key: 'コメント有無', label: '⑭ コメント有無' }
  ],

  errorSpan: function (key) {
    return '<div class="error-text hidden" id="err_' + key + '">未記入あり</div>';
  },

  isValid: function () {
    var f = Wizard.formData;
    for (var i = 0; i < Wizard.REQUIRED_FIELDS.length; i++) {
      if (!f[Wizard.REQUIRED_FIELDS[i].key]) return false;
    }
    if (f['コメント有無'] === 'あり' && !f['コメント']) return false;
    return true;
  },

  updateSaveButtonState: function () {
    var invalid = !Wizard.isValid();
    var buttons = Wizard.container().querySelectorAll('.save-btn');
    Array.prototype.forEach.call(buttons, function (btn) {
      btn.classList.toggle('btn-invalid', invalid);
    });
  },

  render: function () {
    var f = Wizard.formData;
    var propOptions = App.master.properties.map(function (p) {
      var sel = (p === f['選択物件名'] && !f.isNewProperty) ? ' selected' : '';
      return '<option value="' + escapeHtml(p) + '"' + sel + '>' + escapeHtml(p) + '</option>';
    }).join('');
    var targetNames = App.master.names.filter(function (n) { return n['部署'] === f['部署対象者']; }).map(function (n) { return n['氏名']; });
    var classOptions = App.master.classifications.filter(function (c) { return c['加工分類'] === f['加工先']; });

    var topSaveBtnHtml = '<div class="btn-row" style="margin-top:0;margin-bottom:16px;">' +
      '<button class="btn btn-success save-btn" style="padding:8px 12px;font-size:14px;" onclick="Wizard.save()">保存</button></div>';
    var bottomSaveBtnHtml = '<div class="btn-row"><button class="btn btn-success save-btn" onclick="Wizard.save()">保存</button></div>';

    var html = '<div class="card">' +
      topSaveBtnHtml +

      '<div class="field" id="field_検査確認者"><label class="field-label">① 検査員</label><div class="field-content">' +
      Wizard.radioGroup('検査確認者', App.master.inspectors, f['検査確認者']) + Wizard.errorSpan('検査確認者') + '</div></div>' +

      '<div class="field" id="field_発生日"><label class="field-label">② 発生日</label><div class="field-content">' +
      '<input type="date" value="' + escapeHtml(f['発生日'] || todayStr()) + '" oninput="Wizard.setField(\'発生日\', this.value)">' + Wizard.errorSpan('発生日') + '</div></div>' +

      '<div class="field" id="field_選択物件名"><label class="field-label">③ 物件名</label><div class="field-content">' +
      '<select onchange="Wizard.onPropertyChange(this.value)">' +
      '<option value="">選択してください</option>' +
      '<option value="__new__"' + (f.isNewProperty ? ' selected' : '') + '>＋ 新規追加</option>' +
      propOptions +
      '</select>' +
      '<div id="newPropertyRow" class="' + (f.isNewProperty ? '' : 'hidden') + '" style="margin-top:8px;">' +
      '<input type="text" placeholder="新しい物件名を入力" value="' + escapeHtml(f.isNewProperty ? (f['選択物件名'] || '') : '') + '" ' +
      'oninput="Wizard.setField(\'選択物件名\', this.value)"></div>' + Wizard.errorSpan('選択物件名') + '</div></div>' +

      '<div class="field"><label class="field-label">④ 製品名写真（任意）</label><div class="field-content">' +
      '<input type="file" accept="image/*" capture="environment" onchange="Wizard.handlePhotoCapture(event,\'製品名写真\',\'productPhotoPreview\')">' +
      '<img id="productPhotoPreview" class="photo-preview ' + (f['製品名写真Base64'] ? '' : 'hidden') + '" src="' +
      (f['製品名写真Base64'] ? 'data:' + f['製品名写真MimeType'] + ';base64,' + f['製品名写真Base64'] : (f['製品名写真Url'] || '')) + '">' +
      '<div class="photo-actions"><button type="button" class="btn btn-secondary" id="ocrBtn" ' +
      (f['製品名写真Base64'] ? '' : 'disabled') + ' onclick="Wizard.runOcr()">OCRで製品名を読み取る</button></div></div></div>' +

      '<div class="field" id="field_製品名"><label class="field-label">⑤ 製品名</label><div class="field-content">' +
      '<input type="text" id="productNameInput" value="' + escapeHtml(f['製品名'] || '') + '" ' +
      'placeholder="写真から読み取る、または直接入力" oninput="Wizard.setField(\'製品名\', this.value)">' + Wizard.errorSpan('製品名') + '</div></div>' +

      '<div class="field" id="field_部署対象者"><label class="field-label">⑥ 対象部署</label><div class="field-content">' +
      Wizard.radioGroup('部署対象者', App.master.departments, f['部署対象者']) + Wizard.errorSpan('部署対象者') + '</div></div>' +

      '<div class="field" id="field_対象者"><label class="field-label">⑦ 対象者</label><div class="field-content">' +
      '<select id="対象者Select" onchange="Wizard.setField(\'対象者\', this.value)">' +
      '<option value="">選択してください</option>' +
      targetNames.map(function (n) {
        var sel = (n === f['対象者']) ? ' selected' : '';
        return '<option value="' + escapeHtml(n) + '"' + sel + '>' + escapeHtml(n) + '</option>';
      }).join('') + '</select>' + Wizard.errorSpan('対象者') + '</div></div>' +

      '<div class="field" id="field_梁ロボ"><label class="field-label">⑧ 梁ロボ</label><div class="field-content">' +
      Wizard.radioGroup('梁ロボ', ['○', '-'], f['梁ロボ']) + Wizard.errorSpan('梁ロボ') + '</div></div>' +

      '<div class="field" id="field_加工先"><label class="field-label">⑨ 加工先</label><div class="field-content">' +
      Wizard.radioGroup('加工先', ['柱', '梁'], f['加工先']) + Wizard.errorSpan('加工先') + '</div></div>' +

      '<div class="field" id="field_不具合内容"><label class="field-label">⑩ 不具合内容、原因</label><div class="field-content">' +
      '<textarea oninput="Wizard.setField(\'不具合内容\', this.value)">' + escapeHtml(f['不具合内容'] || '') + '</textarea>' + Wizard.errorSpan('不具合内容') + '</div></div>' +

      '<div class="field" id="field_分類選択"><label class="field-label">分類選択</label><div class="field-content">' +
      '<select id="classSelect" onchange="Wizard.setField(\'分類選択\', this.value)">' +
      '<option value="">選択してください</option>' +
      classOptions.map(function (c) {
        var sel = (c['分類'] === f['分類選択']) ? ' selected' : '';
        return '<option value="' + escapeHtml(c['分類']) + '"' + sel + '>' + escapeHtml(c['分類']) + '</option>';
      }).join('') + '</select>' + Wizard.errorSpan('分類選択') + '</div></div>' +

      '<div class="field" id="field_コメント有無"><label class="field-label">⑭ コメント有無</label><div class="field-content">' +
      '<div class="radio-group" id="rg_コメント有無">' +
      ['あり', 'なし'].map(function (opt) {
        var sel = (f['コメント有無'] === opt) ? ' selected' : '';
        return '<label class="' + sel.trim() + '" onclick="Wizard.toggleCommentBox(\'' + opt + '\'); ' +
          'this.parentNode.querySelectorAll(\'label\').forEach(function(l){l.classList.remove(\'selected\')}); this.classList.add(\'selected\')">' +
          '<input type="radio">' + opt + '</label>';
      }).join('') + '</div>' + Wizard.errorSpan('コメント有無') +
      '<div id="commentBox" class="' + (f['コメント有無'] === 'あり' ? '' : 'hidden') + '" style="margin-top:8px;">' +
      '<textarea placeholder="コメント内容" oninput="Wizard.setField(\'コメント\', this.value)">' + escapeHtml(f['コメント'] || '') + '</textarea>' + Wizard.errorSpan('コメント') + '</div></div></div>' +

      '<div class="field"><label class="field-label">⑮ 状況写真（任意）</label><div class="field-content">' +
      '<input type="file" accept="image/*" capture="environment" onchange="Wizard.handlePhotoCapture(event,\'状況写真\',\'statusPhotoPreview\')">' +
      '<img id="statusPhotoPreview" class="photo-preview ' + (f['状況写真Base64'] ? '' : 'hidden') + '" src="' +
      (f['状況写真Base64'] ? 'data:' + f['状況写真MimeType'] + ';base64,' + f['状況写真Base64'] : (f['状況写真Url'] || '')) + '"></div></div>' +

      bottomSaveBtnHtml +
      '</div>';

    Wizard.container().innerHTML = html;
    Wizard.updateSaveButtonState();
  },

  clearErrorSpans: function () {
    var spans = Wizard.container().querySelectorAll('.error-text');
    Array.prototype.forEach.call(spans, function (s) { s.classList.add('hidden'); });
  },

  validate: function () {
    Wizard.clearErrorSpans();
    var f = Wizard.formData;
    for (var i = 0; i < Wizard.REQUIRED_FIELDS.length; i++) {
      var req = Wizard.REQUIRED_FIELDS[i];
      if (!f[req.key]) {
        var err = document.getElementById('err_' + req.key);
        if (err) err.classList.remove('hidden');
        var el = document.getElementById('field_' + req.key);
        if (el) el.scrollIntoView({ behavior: 'smooth', block: 'center' });
        return false;
      }
    }
    if (f['コメント有無'] === 'あり' && !f['コメント']) {
      var errComment = document.getElementById('err_コメント');
      if (errComment) errComment.classList.remove('hidden');
      var box = document.getElementById('commentBox');
      if (box) box.scrollIntoView({ behavior: 'smooth', block: 'center' });
      return false;
    }
    return true;
  },

  save: function () {
    if (!Wizard.validate()) return;
    var f = Wizard.formData;
    var wasNew = !Wizard.editingId;
    showLoading('保存中...');

    var uploadTasks = [];
    if (f['製品名写真Base64']) {
      uploadTasks.push(
        callServer('uploadPhoto', f['製品名写真Base64'], f['製品名写真MimeType'], 'product_' + Date.now() + '.jpg')
          .then(function (url) { f['製品名写真Url'] = url; })
      );
    }
    if (f['状況写真Base64']) {
      uploadTasks.push(
        callServer('uploadPhoto', f['状況写真Base64'], f['状況写真MimeType'], 'status_' + Date.now() + '.jpg')
          .then(function (url) { f['状況写真Url'] = url; })
      );
    }

    Promise.all(uploadTasks).then(function () {
      var payload = Object.assign({}, f, { id: Wizard.editingId });
      delete payload['製品名写真Base64']; delete payload['製品名写真MimeType'];
      delete payload['状況写真Base64']; delete payload['状況写真MimeType'];
      return callServer('saveRecord', payload);
    }).then(function (res) {
      hideLoading();
      showToast('保存しました');
      App.invalidate();
      if (f.isNewProperty) { Store.del('master'); App.loadMaster(); }
      if (wasNew && f['検査確認者']) localStorage.setItem('lastInspector', f['検査確認者']);
      if (Wizard.modalMode) {
        Modal.close();
        if (Modal.onSaved) Modal.onSaved();
      } else {
        App.showRecords();
      }
    }).catch(function (err) {
      hideLoading();
      showToast('保存失敗: ' + (err.message || err));
    });
  }
};

/** ===================== モーダル（既存レコード編集） ===================== */

var Modal = {
  onSaved: null,
  open: function (record, onSaved) {
    App.ready(function () { Modal.openNow_(record, onSaved); });
  },
  openNow_: function (record, onSaved) {
    var overlay = document.createElement('div');
    overlay.className = 'modal-overlay';
    overlay.id = 'wizardModalOverlay';
    overlay.innerHTML = '<div class="modal-box"><div style="text-align:right;">' +
      '<button class="btn-secondary" style="border:none;border-radius:6px;padding:6px 10px;cursor:pointer;" onclick="Modal.close()">✕ 閉じる</button>' +
      '</div><div id="wizardModalBody"></div></div>';
    document.getElementById('modalRoot').appendChild(overlay);
    Modal.onSaved = onSaved || function () {};
    Wizard.start(record, true);
  },
  close: function () {
    var overlay = document.getElementById('wizardModalOverlay');
    if (overlay) overlay.remove();
  }
};

/** ===================== 不具合記録画面 ===================== */

var Records = {
  year: null,
  month: '',
  summary: null,

  touched: false,

  show: function () {
    App.currentBack = App.goHome;
    Records.touched = false;
    var nav = App.navId;
    document.getElementById('view').innerHTML = '<div id="recordsNotice"></div><div id="recordsFilterBar" class="filter-bar"></div><div id="recordsTableArea"></div>';
    var cached = Store.get('rb');
    var fresh = App.fetchBoot('rb', 'getRecordsBootstrap');
    var fail = function (err) { hideLoading(); showToast('取得失敗: ' + (err.message || err)); };
    if (cached) {
      Records.applyBoot_(cached);
      fresh.then(function (boot) {
        Store.set('rb', boot);
        if (nav === App.navId && !Records.touched && JSON.stringify(boot) !== JSON.stringify(cached)) Records.applyBoot_(boot);
      }).catch(fail);
    } else {
      showLoading('読み込み中...');
      fresh.then(function (boot) {
        Store.set('rb', boot);
        hideLoading();
        if (nav === App.navId) Records.applyBoot_(boot);
      }).catch(fail);
    }
  },

  applyBoot_: function (boot) {
    if (!document.getElementById('recordsTableArea')) return;
    Records.summary = boot.summary;
    var years = Object.keys(boot.summary.yearCounts).sort(function (a, b) { return b - a; });
    Records.year = (boot.year !== null) ? String(boot.year) : null;
    Records.month = '';
    Records.renderFilterBar(years);
    document.getElementById('recordsNotice').innerHTML = boot.undated
      ? '<div class="count-badge" style="color:#ffb300;margin-bottom:8px;">⚠ 発生日が未入力の記録が ' + boot.undated + ' 件あります（年度・月の一覧と結果分析の対象外）</div>' : '';
    renderRecordTable(boot.rows, document.getElementById('recordsTableArea'), boot.total, Records.refresh);
  },

  CLOSING_PERIODS: {
    1: '前年12/21〜1/20', 2: '1/21〜2/20', 3: '2/21〜3/20', 4: '3/21〜4/20',
    5: '4/21〜5/20', 6: '5/21〜6/20', 7: '6/21〜7/20', 8: '7/21〜8/20',
    9: '8/21〜9/20', 10: '9/21〜10/20', 11: '10/21〜11/20（決算）', 12: '11/21〜12/20'
  },

  renderFilterBar: function (years) {
    var yearOptions = years.map(function (y) {
      var sel = (String(y) === String(Records.year)) ? ' selected' : '';
      return '<option value="' + y + '"' + sel + '>' + y + '年度 (' + Records.summary.yearCounts[y] + '件)</option>';
    }).join('');

    var monthOptions = '<option value="">全月</option>';
    for (var m = 1; m <= 12; m++) {
      var key = Records.year + '-' + m;
      var cnt = Records.summary.yearMonthCounts[key] || 0;
      var sel = (String(m) === String(Records.month)) ? ' selected' : '';
      monthOptions += '<option value="' + m + '"' + sel + '>' + m + '月20日締め（' + Records.CLOSING_PERIODS[m] + '）(' + cnt + '件)</option>';
    }

    document.getElementById('recordsFilterBar').innerHTML =
      '<select onchange="Records.onYearChange(this.value)">' + yearOptions + '</select>' +
      '<select onchange="Records.onMonthChange(this.value)">' + monthOptions + '</select>';
  },

  onYearChange: function (year) {
    Records.touched = true;
    Records.year = year;
    Records.month = '';
    var years = Object.keys(Records.summary.yearCounts).sort(function (a, b) { return b - a; });
    Records.renderFilterBar(years);
    Records.load();
  },

  onMonthChange: function (month) {
    Records.touched = true;
    Records.month = month;
    Records.load();
  },

  load: function () {
    return callServer('getRecords', Records.year, Records.month).then(function (res) {
      renderRecordTable(res.rows, document.getElementById('recordsTableArea'), res.total, Records.refresh);
    });
  },

  refresh: function () { Records.load(); }
};

var TABLE_COLUMNS = [
  '選択物件名', '発生日', '製品名', '梁ロボ', '加工先', '分類選択',
  '不具合内容、原因', '対象者', '処理者', '対策', '検査確認者', 'コメント有無'
];

function renderRecordTable(rows, container, total, refreshFn, columns) {
  var cols = columns || TABLE_COLUMNS;
  var html = '<div class="count-badge">' + (total !== undefined ? total : rows.length) + ' 件</div>' +
    '<div class="table-scroll"><table class="record-table"><thead><tr>' +
    cols.map(function (c) { return '<th>' + escapeHtml(c) + '</th>'; }).join('') +
    '</tr></thead><tbody>';

  rows.forEach(function (r, idx) {
    html += '<tr onclick="renderRecordTable._openRow(' + idx + ')">' +
      cols.map(function (c) {
        var v = (c === '分類選択') ? stripLeadingNumber(r[c]) : r[c];
        return '<td>' + escapeHtml(v) + '</td>';
      }).join('') +
      '</tr>';
  });
  html += '</tbody></table></div>';
  container.innerHTML = html;

  renderRecordTable._rows = rows;
  renderRecordTable._openRow = function (idx) {
    Modal.open(renderRecordTable._rows[idx], refreshFn);
  };
}

/** ===================== 結果仕訳け画面 ===================== */

var Bunseki = {
  showMenu: function () {
    App.currentBack = App.goHome;
    document.getElementById('view').innerHTML =
      '<div class="menu-grid">' +
      '<button class="menu-btn secondary" onclick="Bunseki.showCounts(\'field\',\'選択物件名\',\'物件\')">物件</button>' +
      '<button class="menu-btn tertiary" onclick="Bunseki.showCounts(\'process\',\'加工先\',\'加工先\')">加工先</button>' +
      '<button class="menu-btn" style="background:#9334e8;" onclick="Bunseki.showCounts(\'process\',\'分類\',\'分類\')">分類</button>' +
      '</div>';
  },

  showCounts: function (mode, field, title) {
    App.currentBack = Bunseki.showMenu;
    showLoading('集計中...');
    var call = (mode === 'field') ? callServer('getBunsekiByField', field) : callServer('getBunsekiByProcessType', field);
    call.then(function (counts) {
      hideLoading();
      var entries = Object.keys(counts).map(function (k) { return { name: k, count: counts[k] }; });
      entries.sort(function (a, b) { return b.count - a.count; });

      var html = '<div class="bunseki-list">';
      entries.forEach(function (e) {
        html += '<div class="bunseki-item" data-mode="' + mode + '" data-field="' + escapeHtml(field) + '" data-v="' + escapeHtml(e.name) + '" onclick="Bunseki.showTableEl(this)">' +
          '<span>' + escapeHtml(e.name) + '</span><span class="count">' + e.count + ' 件</span></div>';
      });
      html += '</div>';
      document.getElementById('view').innerHTML = html;
    }).catch(function (err) {
      hideLoading();
      showToast('集計失敗: ' + (err.message || err));
    });
  },

  showTableEl: function (el) { Bunseki.showTable(el.getAttribute('data-mode'), el.getAttribute('data-field'), el.getAttribute('data-v')); },

  showTable: function (mode, field, value) {
    App.currentBack = function () { Bunseki.showCounts(mode, field, field); };
    var serverField = (mode === 'process' && field === '分類') ? '分類グループ' : field;
    showLoading('読み込み中...');
    callServer('getFilteredRecords', serverField, value).then(function (rows) {
      hideLoading();
      var area = document.createElement('div');
      document.getElementById('view').innerHTML = '';
      document.getElementById('view').appendChild(area);
      renderRecordTable(rows, area, undefined, function () { Bunseki.showTable(mode, field, value); });
    }).catch(function (err) {
      hideLoading();
      showToast('取得失敗: ' + (err.message || err));
    });
  }
};

/** ===================== 結果分析画面（年度指定/月指定を左右に並べて表示） ===================== */

var KekkaBunseki = {
  summary: null,
  years: [],
  yearSel: null,
  monthYearSel: null,
  monthSel: null,
  yearData: null,
  monthData: null,
  yearChart: null,
  touched: false,
  ym: null,

  mode: 'yearMonth',
  projectSel: null,
  projectData: null,
  projectCheckedKeys: null,

  showTabs: function () {
    App.currentBack = App.goHome;
    KekkaBunseki.mode = 'yearMonth';
    KekkaBunseki.touched = false;
    App.setHeaderAction('PDFダウンロード', KekkaBunseki.downloadPdf);
    App.setHeaderAction2('工事別分析', KekkaBunseki.toggleMode, 'header-action-btn-yellow');
    var nav = App.navId;
    var cached = Store.get('kb');
    var fresh = App.fetchBoot('kb', 'getKekkaBunsekiBootstrap');
    var fail = function (err) { hideLoading(); showToast('取得失敗: ' + (err.message || err)); };
    if (cached) {
      // 前回の結果を先に表示し、裏で最新を取得。変わっていて、まだ操作していなければ差し替える
      GoogleChartsReady.then(function () { if (nav === App.navId) KekkaBunseki.applyBoot_(cached); });
      fresh.then(function (boot) {
        Store.set('kb', boot);
        if (nav !== App.navId || KekkaBunseki.touched || JSON.stringify(boot) === JSON.stringify(cached)) return;
        return GoogleChartsReady.then(function () { if (nav === App.navId && !KekkaBunseki.touched) KekkaBunseki.applyBoot_(boot); });
      }).catch(fail);
    } else {
      showLoading('読み込み中...');
      fresh.then(function (boot) {
        Store.set('kb', boot);
        return GoogleChartsReady.then(function () {
          hideLoading();
          if (nav === App.navId) KekkaBunseki.applyBoot_(boot);
        });
      }).catch(fail);
    }
    KekkaBunseki.preloadPdfLibs_();
  },

  applyBoot_: function (boot) {
    KekkaBunseki.summary = boot.summary;
    var years = Object.keys(boot.summary.yearCounts).sort(function (a, b) { return b - a; });
    KekkaBunseki.years = years;
    KekkaBunseki.yearSel = (boot.defaultYear !== null) ? String(boot.defaultYear) : null;
    KekkaBunseki.monthYearSel = KekkaBunseki.yearSel;
    KekkaBunseki.monthSel = boot.defaultMonth;
    KekkaBunseki.renderShell();
    KekkaBunseki.renderYear(boot.yearData);
    KekkaBunseki.renderMonth(boot.monthData);
    KekkaBunseki.alignPreChartBlocks_();
    KekkaBunseki.syncWeights_(boot.yearData, boot.weightReady, boot.weightStale);
    KekkaBunseki.syncWeights_(boot.monthData, boot.weightReady, boot.weightStale);
    KekkaBunseki.prefetchNeighbors_();
  },

  /** PDFを押す前に、ライブラリを裏で読み込んでおく */
  preloadPdfLibs_: function () {
    setTimeout(function () { PdfLibs.load().catch(function () {}); }, 1500);
  },

  toggleMode: function () {
    KekkaBunseki.touched = true;
    if (KekkaBunseki.mode === 'yearMonth') {
      App.ready(function () {
        KekkaBunseki.mode = 'project';
        KekkaBunseki.ym = { yearData: KekkaBunseki.yearData, monthData: KekkaBunseki.monthData };
        App.setHeaderAction2('年度/月別に戻る', KekkaBunseki.toggleMode);
        KekkaBunseki.renderShell();
        if (!KekkaBunseki.projectSel && App.master.properties.length) {
          KekkaBunseki.projectSel = App.master.properties[0];
        }
        if (KekkaBunseki.projectSel) {
          KekkaBunseki.loadProject();
        } else {
          document.getElementById('kekkaYearBody').innerHTML = '<div class="card">物件名が登録されていません</div>';
        }
      });
    } else {
      KekkaBunseki.mode = 'yearMonth';
      if (KekkaBunseki.ym) {
        KekkaBunseki.yearData = KekkaBunseki.ym.yearData;
        KekkaBunseki.monthData = KekkaBunseki.ym.monthData;
      }
      App.setHeaderAction2('工事別分析', KekkaBunseki.toggleMode, 'header-action-btn-yellow');
      KekkaBunseki.renderShell();
      KekkaBunseki.renderYear(KekkaBunseki.yearData);
      KekkaBunseki.renderMonth(KekkaBunseki.monthData);
      KekkaBunseki.alignPreChartBlocks_();
    }
  },

  renderShell: function () {
    if (KekkaBunseki.mode === 'project') {
      document.getElementById('view').innerHTML =
        '<div class="kekka-split">' +
        '<div class="kekka-col">' +
        '<div class="kekka-sticky"><div class="kekka-col-title">工事選択</div>' +
        '<div id="kekkaYearFilterBar" class="filter-bar"></div></div>' +
        '<div id="kekkaYearBody"></div>' +
        '</div>' +
        '<div class="kekka-col">' +
        '<div class="kekka-col-title">締め月選択（複数可・チェックで集計対象を切替）</div>' +
        '<div id="kekkaMonthFilterBar"></div>' +
        '<div id="kekkaMonthBody"></div>' +
        '</div>' +
        '</div>';
      KekkaBunseki.renderProjectFilterBar();
      return;
    }
    document.getElementById('view').innerHTML =
      '<div class="kekka-split">' +
      '<div class="kekka-col">' +
      '<div class="kekka-sticky"><div class="kekka-col-title">年度指定</div>' +
      '<div id="kekkaYearFilterBar" class="filter-bar"></div></div>' +
      '<div id="kekkaYearBody"></div>' +
      '</div>' +
      '<div class="kekka-col">' +
      '<div class="kekka-sticky"><div class="kekka-col-title">月指定</div>' +
      '<div id="kekkaMonthFilterBar" class="filter-bar"></div></div>' +
      '<div id="kekkaMonthBody"></div>' +
      '</div>' +
      '</div>';
    KekkaBunseki.renderYearFilterBar();
    KekkaBunseki.renderMonthFilterBar();
  },

  alignPreChartBlocks_: function () {
    var leftWrap = document.getElementById('kekkaYearCharts');
    var rightWrap = document.getElementById('kekkaMonthCharts');
    if (!leftWrap || !rightWrap) return;
    var leftFirst = leftWrap.querySelector('.card');
    var rightFirst = rightWrap.querySelector('.card');
    if (!leftFirst || !rightFirst) return;
    leftFirst.style.marginBottom = '';
    rightFirst.style.marginBottom = '';
    var leftH = leftFirst.getBoundingClientRect().height;
    var rightH = rightFirst.getBoundingClientRect().height;
    var delta = Math.round(leftH - rightH);
    var baseMargin = 12;
    if (delta > 0) rightFirst.style.marginBottom = (baseMargin + delta) + 'px';
    else if (delta < 0) leftFirst.style.marginBottom = (baseMargin - delta) + 'px';
  },

  renderProjectFilterBar: function () {
    var options = App.master.properties.map(function (p) {
      var sel = (p === KekkaBunseki.projectSel) ? ' selected' : '';
      return '<option value="' + escapeHtml(p) + '"' + sel + '>' + escapeHtml(p) + '</option>';
    }).join('');
    document.getElementById('kekkaYearFilterBar').innerHTML =
      '<select onchange="KekkaBunseki.onProjectSelChange(this.value)">' + options + '</select>';
  },

  onProjectSelChange: function (name) {
    KekkaBunseki.projectSel = name;
    KekkaBunseki.loadProject();
  },

  loadProject: function () {
    showLoading('集計中...');
    callServer('getKekkaBunsekiByProject', KekkaBunseki.projectSel).then(function (data) {
      return GoogleChartsReady.then(function () {
        hideLoading();
        KekkaBunseki.projectData = data;
        KekkaBunseki.yearData = data;
        KekkaBunseki.projectCheckedKeys = {};
        data.periods.forEach(function (p) { KekkaBunseki.projectCheckedKeys[p.key] = true; });
        KekkaBunseki.renderProjectLeft(data);
        KekkaBunseki.renderProjectPeriodChecklist(data.periods);
        KekkaBunseki.renderProjectRight();
        KekkaBunseki.alignPreChartBlocks_();
      });
    }).catch(function (err) {
      hideLoading();
      showToast('取得失敗: ' + (err.message || err));
    });
  },

  renderProjectLeft: function (data) {
    if (!data.periods.length) {
      document.getElementById('kekkaYearBody').innerHTML = '<div class="card">この工事の不具合記録はありません</div>';
      KekkaBunseki.yearChart = null;
      return;
    }
    document.getElementById('kekkaYearBody').innerHTML =
      '<div id="kekkaYearCharts" class="kekka-pretable">' +
      '<div class="card"><div id="yearComboChart" style="width:100%;height:280px;"></div></div>' +
      KekkaBunseki.ratioCardHtml(KekkaBunseki.projectSel + ' 全期間', data.pillarTotal, data.beamTotal) +
      '</div>' +
      KekkaBunseki.contentTableHtml(data.contentCounts, 'projectAll');

    var table = new google.visualization.DataTable();
    table.addColumn('string', '締め月');
    table.addColumn('number', '柱');
    table.addColumn({ type: 'string', role: 'annotation' });
    table.addColumn('number', '梁');
    table.addColumn({ type: 'string', role: 'annotation' });
    table.addRows(data.periods.map(function (p) {
      return [p.label, p['柱'], String(p['柱']), p['梁'], String(p['梁'])];
    }));

    var options = {
      isStacked: true,
      colors: ['#f9ab00', '#34a853'],
      vAxis: { title: '件数' },
      legend: { position: 'top' },
      chartArea: { width: '82%', height: '65%' },
      annotations: { alwaysOutside: false, textStyle: { fontSize: 10, color: '#000' } }
    };
    KekkaBunseki.yearChart = new google.visualization.ColumnChart(document.getElementById('yearComboChart'));
    KekkaBunseki.yearChart.draw(table, options);

    requestAnimationFrame(KekkaBunseki.alignChartHeights);
  },

  renderProjectPeriodChecklist: function (periods) {
    if (!periods.length) {
      document.getElementById('kekkaMonthFilterBar').innerHTML = '';
      return;
    }
    var html = periods.map(function (p) {
      var checked = KekkaBunseki.projectCheckedKeys[p.key] ? ' checked' : '';
      return '<label class="kekka-check-item"><input type="checkbox"' + checked +
        ' onchange="KekkaBunseki.onPeriodCheckChange(\'' + p.key + '\', this.checked)"> ' +
        escapeHtml(p.label) + ' 20日締め（' + p['合計'] + '件）</label>';
    }).join('');
    document.getElementById('kekkaMonthFilterBar').innerHTML = '<div class="kekka-checklist">' + html + '</div>';
  },

  onPeriodCheckChange: function (key, checked) {
    KekkaBunseki.projectCheckedKeys[key] = checked;
    KekkaBunseki.renderProjectRight();
    KekkaBunseki.alignPreChartBlocks_();
  },

  renderProjectRight: function () {
    var periods = (KekkaBunseki.projectData.periods || []).filter(function (p) {
      return KekkaBunseki.projectCheckedKeys[p.key];
    });
    var pillar = 0, beam = 0;
    var contentMap = {};
    periods.forEach(function (p) {
      pillar += p['柱'];
      beam += p['梁'];
      (p.contentCounts || []).forEach(function (c) {
        if (!contentMap[c.name]) contentMap[c.name] = { name: c.name, count: 0, group: c.group };
        contentMap[c.name].count += c.count;
      });
    });
    var total = pillar + beam;
    var contentCounts = Object.keys(contentMap).map(function (k) { return contentMap[k]; })
      .sort(function (a, b) { return b.count - a.count; });

    KekkaBunseki.monthData = {
      label: KekkaBunseki.projectSel + '（選択期間合計）',
      '柱': pillar, '梁': beam, '合計': total,
      contentCounts: contentCounts
    };

    document.getElementById('kekkaMonthBody').innerHTML =
      '<div id="kekkaMonthCharts" class="kekka-pretable">' +
      '<div class="card kekka-cards">' +
      '<div class="kekka-card"><div class="kekka-num">' + total + '</div><div class="kekka-label">合計件数</div></div>' +
      '<div class="kekka-card"><div class="kekka-num">' + pillar + '</div><div class="kekka-label">柱</div></div>' +
      '<div class="kekka-card"><div class="kekka-num">' + beam + '</div><div class="kekka-label">梁</div></div>' +
      '</div>' +
      KekkaBunseki.ratioCardHtml('選択期間', pillar, beam) +
      '</div>' +
      KekkaBunseki.contentTableHtml(contentCounts, 'projectSelected');

    if (!total) {
      requestAnimationFrame(KekkaBunseki.alignChartHeights);
      return;
    }

    requestAnimationFrame(KekkaBunseki.alignChartHeights);
  },

  /** 柱/梁の比率: 1本の横バー + 件数・%のテキスト（画面・PDF共通。インラインスタイルでhtml2canvasにも対応） */
  ratioBlockHtml_: function (title, pillar, beam) {
    var total = (pillar || 0) + (beam || 0);
    var pP = total ? pillar / total * 100 : 0;
    var bP = total ? beam / total * 100 : 0;
    var seg = function (w, bg, fg, n) {
      if (!(w > 0)) return '';
      return '<div style="width:' + w + '%;background:' + bg + ';color:' + fg + ';display:flex;align-items:center;justify-content:center;' +
        'font-weight:bold;font-size:15px;overflow:hidden;white-space:nowrap;">' + n + '</div>';
    };
    var bar = total
      ? seg(pP, '#f9ab00', '#000', pillar) + seg(bP, '#34a853', '#fff', beam)
      : '<div style="width:100%;background:#ddd;color:#666;display:flex;align-items:center;justify-content:center;font-size:13px;">データなし</div>';
    return '<div style="font-size:13px;font-weight:bold;margin-bottom:6px;">' + escapeHtml(title) + ' 柱/梁比率</div>' +
      '<div style="font-size:14px;margin-bottom:8px;">' +
      '<span style="color:#b57a00;font-weight:bold;">柱 ' + pillar + '件（' + pP.toFixed(1) + '%）</span>　' +
      '<span style="color:#2a8a44;font-weight:bold;">梁 ' + beam + '件（' + bP.toFixed(1) + '%）</span>　' +
      '<span>合計 ' + total + '件</span></div>' +
      '<div style="display:flex;height:34px;border-radius:6px;overflow:hidden;">' + bar + '</div>';
  },

  ratioCardHtml: function (title, pillar, beam) {
    return '<div class="card">' + KekkaBunseki.ratioBlockHtml_(title, pillar, beam) + '</div>';
  },

  /**
   * 工事名｜柱｜梁｜合計｜年度比率｜比率データバー の表。工事は合計の多い順。
   * 年度比率は、全工事の合計に対する割合。データバーは0〜100%の1本の帯で、前の工事の累積%から
   * 自分の累積%までを塗る(例: 0〜74.7%、74.7〜95.4%、…、98.8〜100%)。
   */
  projectTableHtml: function (projectCounts, ratioLabel, title) {
    var list = projectCounts || [];
    var grand = list.reduce(function (a, p) { return a + p.total; }, 0);
    var cum = 0;
    var rows = list.map(function (p) {
      var start = grand ? cum / grand * 100 : 0;
      cum += p.total;
      var end = grand ? cum / grand * 100 : 0;
      var ratio = end - start;
      return '<tr><td>' + escapeHtml(p.name) + '</td><td style="text-align:right;">' + p['柱'] + '</td><td style="text-align:right;">' + p['梁'] + '</td><td style="text-align:right;">' + p.total + '</td>' +
        '<td style="text-align:right;">' + ratio.toFixed(1) + '%</td>' +
        '<td style="min-width:200px;"><div style="display:flex;align-items:center;gap:6px;">' +
        '<div title="' + start.toFixed(1) + '%〜' + end.toFixed(1) + '%" style="flex:1;position:relative;overflow:hidden;background:#e6edfa;border:1px solid #9bb3e0;border-radius:3px;height:14px;box-sizing:border-box;">' +
        '<div style="position:absolute;top:0;left:' + start.toFixed(2) + '%;width:' + ratio.toFixed(2) + '%;min-width:2px;height:100%;background:#1a73e8;"></div></div>' +
        '</div></td></tr>';
    }).join('');
    if (!rows) rows = '<tr><td colspan="6">該当なし</td></tr>';
    return '<div class="card"><div class="kekka-subtitle">' + escapeHtml(title || '工事別 不具合件数') + '</div>' +
      '<div class="table-scroll" style="max-height:none;overflow-y:visible;overflow-x:auto;"><table class="record-table"><thead><tr>' +
      ['工事名', '柱', '梁', '合計', ratioLabel, '比率データバー'].map(function (h) { return '<th style="text-align:center;">' + h + '</th>'; }).join('') +
      '</tr></thead><tbody>' + rows + '</tbody></table></div></div>';
  },

  /** 月の詳細: 日付(m/d)｜工事名｜分類(柱・梁)｜不具合内容。日付の古い順 */
  detailTableHtml: function (details) {
    var list = details || [];
    var rows = list.map(function (d) {
      var bg = d.proc === '柱' ? ' class="row-pillar"' : (d.proc === '梁' ? ' class="row-beam"' : '');
      return '<tr' + bg + '><td style="text-align:center;">' + escapeHtml(d.date) + '</td><td>' + escapeHtml(d.project) + '</td>' +
        '<td style="text-align:center;">' + escapeHtml(d.proc) + '</td>' +
        '<td style="white-space:normal;min-width:260px;">' + escapeHtml(d.content) + '</td></tr>';
    }).join('');
    if (!rows) rows = '<tr><td colspan="4">該当なし</td></tr>';
    return '<div class="card"><div class="kekka-subtitle">詳細（' + list.length + '件）</div>' +
      '<div class="table-scroll" style="max-height:none;overflow-y:visible;overflow-x:auto;"><table class="record-table"><thead><tr>' +
      ['日付', '工事名', '分類', '不具合内容'].map(function (h) { return '<th style="text-align:center;">' + h + '</th>'; }).join('') +
      '</tr></thead><tbody>' + rows + '</tbody></table></div></div>';
  },

  contentTableHtml: function (contentCounts, side) {
    return '<div class="card"><div class="kekka-subtitle">不具合内容（件数）</div>' +
      '<div class="table-scroll" style="max-height:none;overflow-y:visible;overflow-x:auto;"><table class="record-table"><thead><tr><th>不具合内容</th><th style="text-align:center;">件数</th></tr></thead><tbody>' +
      contentCounts.map(function (c) {
        var rowClass = (c.group === '柱') ? 'row-pillar' : (c.group === '梁') ? 'row-beam' : '';
        return '<tr class="' + rowClass + '" data-side="' + side + '" data-v="' + escapeHtml(c.name) + '" onclick="KekkaBunseki.showContentDetailEl(this)">' +
          '<td>' + escapeHtml(stripLeadingNumber(c.name)) + '</td><td style="text-align:center;">' + c.count + '</td></tr>';
      }).join('') +
      '</tbody></table></div></div>';
  },

  openDetail: { left: null, right: null },

  showContentDetailEl: function (el) { KekkaBunseki.showContentDetail(el.getAttribute('data-side'), el.getAttribute('data-v')); },

  showContentDetail: function (side, contentName) {
    var filter = { content: contentName };
    var position = (side === 'year' || side === 'projectAll') ? 'left' : 'right';
    if (side === 'year') {
      filter.scope = 'year';
      filter.year = KekkaBunseki.yearSel;
    } else if (side === 'month') {
      filter.scope = 'month';
      filter.year = KekkaBunseki.monthYearSel;
      filter.month = KekkaBunseki.monthSel;
    } else if (side === 'projectAll') {
      filter.scope = 'project';
      filter.project = KekkaBunseki.projectSel;
    } else if (side === 'projectSelected') {
      filter.scope = 'projectPeriods';
      filter.project = KekkaBunseki.projectSel;
      filter.periodKeys = Object.keys(KekkaBunseki.projectCheckedKeys || {}).filter(function (k) {
        return KekkaBunseki.projectCheckedKeys[k];
      });
    } else {
      return;
    }

    showLoading('読み込み中...');
    callServer('getKekkaBunsekiContentRecords', filter).then(function (rows) {
      hideLoading();
      KekkaBunseki.openDetailModal(contentName, rows, function () {
        KekkaBunseki.showContentDetail(side, contentName);
      }, position);
    }).catch(function (err) {
      hideLoading();
      showToast('取得失敗: ' + (err.message || err));
    });
  },

  ensureDetailOverlay_: function () {
    var overlay = document.getElementById('kekkaDetailOverlayRoot');
    if (overlay) return overlay;
    overlay = document.createElement('div');
    overlay.id = 'kekkaDetailOverlayRoot';
    overlay.className = 'modal-overlay-split';
    document.getElementById('modalRoot').appendChild(overlay);
    return overlay;
  },

  openDetailModal: function (title, rows, refreshFn, position) {
    var overlay = KekkaBunseki.ensureDetailOverlay_();
    var cardId = 'kekkaDetailCard_' + position;
    var existing = document.getElementById(cardId);
    if (existing) existing.remove();

    KekkaBunseki.openDetail[position] = { title: title, rows: rows };

    var card = document.createElement('div');
    card.id = cardId;
    card.className = 'kekka-detail-card kekka-detail-card-' + position;
    card.innerHTML = '<div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:8px;">' +
      '<div class="kekka-subtitle" style="margin:0;">' + escapeHtml(stripLeadingNumber(title)) + '（' + rows.length + '件）</div>' +
      '<button class="btn-secondary" style="border:none;border-radius:6px;padding:6px 10px;cursor:pointer;" onclick="KekkaBunseki.closeDetailModal(\'' + position + '\')">✕ 閉じる</button>' +
      '</div><div id="kekkaDetailBody_' + position + '"></div>';
    overlay.appendChild(card);
    renderRecordTable(rows, document.getElementById('kekkaDetailBody_' + position), rows.length, refreshFn, ['不具合内容、原因']);
  },

  closeDetailModal: function (position) {
    KekkaBunseki.openDetail[position] = null;
    var card = document.getElementById('kekkaDetailCard_' + position);
    if (card) card.remove();
    var overlay = document.getElementById('kekkaDetailOverlayRoot');
    if (overlay && !overlay.querySelector('.kekka-detail-card')) overlay.remove();
  },

  renderYearFilterBar: function () {
    var options = KekkaBunseki.years.map(function (y) {
      var sel = (String(y) === String(KekkaBunseki.yearSel)) ? ' selected' : '';
      return '<option value="' + y + '"' + sel + '>' + y + '年度 (' + KekkaBunseki.summary.yearCounts[y] + '件)</option>';
    }).join('');
    document.getElementById('kekkaYearFilterBar').innerHTML =
      '<select onchange="KekkaBunseki.onYearSelChange(this.value)">' + options + '</select>';
  },

  /** 今の締め月(日本時間)。◀▶で未来の月へ進めないようにする */
  nowClosing_: function () {
    var t = new Date(Date.now() + 9 * 60 * 60 * 1000);
    var y = t.getUTCFullYear(), m = t.getUTCMonth() + 1, d = t.getUTCDate();
    var cm = d <= 20 ? m : (m === 12 ? 1 : m + 1);
    var cy = d <= 20 ? y : (m === 12 ? y + 1 : y);
    return { fy: cm === 12 ? cy + 1 : cy, cm: cm };
  },

  MONTH_ORDER_: [12, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11],

  /** 年度+締め月を、時系列の通し番号にする(会計年度は12月締めから始まる) */
  monthIndex_: function (fy, cm) { return fy * 12 + KekkaBunseki.MONTH_ORDER_.indexOf(cm); },

  /** 指定した通し番号の月へ移動できるか(データのある年度で、今の締め月まで) */
  monthAllowed_: function (idx) {
    var fy = Math.floor(idx / 12);
    var now = KekkaBunseki.nowClosing_();
    return idx >= 0 && KekkaBunseki.years.map(String).indexOf(String(fy)) !== -1 && idx <= KekkaBunseki.monthIndex_(now.fy, now.cm);
  },

  monthFromIndex_: function (idx) {
    return { fy: Math.floor(idx / 12), cm: KekkaBunseki.MONTH_ORDER_[idx % 12] };
  },

  renderMonthFilterBar: function () {
    var yearOptions = KekkaBunseki.years.map(function (y) {
      var sel = (String(y) === String(KekkaBunseki.monthYearSel)) ? ' selected' : '';
      return '<option value="' + y + '"' + sel + '>' + y + '年度</option>';
    }).join('');
    var monthOptions = '';
    for (var m = 1; m <= 12; m++) {
      var key = KekkaBunseki.monthYearSel + '-' + m;
      var cnt = KekkaBunseki.summary.yearMonthCounts[key] || 0;
      var sel = (Number(m) === Number(KekkaBunseki.monthSel)) ? ' selected' : '';
      monthOptions += '<option value="' + m + '"' + sel + '>' + m + '月20日締め（' + Records.CLOSING_PERIODS[m] + '）(' + cnt + '件)</option>';
    }
    var idx = KekkaBunseki.monthIndex_(Number(KekkaBunseki.monthYearSel), Number(KekkaBunseki.monthSel));
    var prevOk = KekkaBunseki.monthAllowed_(idx - 1), nextOk = KekkaBunseki.monthAllowed_(idx + 1);
    document.getElementById('kekkaMonthFilterBar').innerHTML =
      '<select onchange="KekkaBunseki.onMonthYearSelChange(this.value)">' + yearOptions + '</select>' +
      '<div class="month-step">' +
      '<button class="step-btn" title="前の月" aria-label="前の月" onclick="KekkaBunseki.stepMonth(-1)"' + (prevOk ? '' : ' disabled') + '>◀</button>' +
      '<select onchange="KekkaBunseki.onMonthSelChange(this.value)">' + monthOptions + '</select>' +
      '<button class="step-btn" title="次の月" aria-label="次の月" onclick="KekkaBunseki.stepMonth(1)"' + (nextOk ? '' : ' disabled') + '>▶</button>' +
      '</div>';
  },

  /** ◀▶: 前の月/次の月へ(年度をまたぐときは年度も切り替える) */
  stepMonth: function (delta) {
    var idx = KekkaBunseki.monthIndex_(Number(KekkaBunseki.monthYearSel), Number(KekkaBunseki.monthSel)) + delta;
    if (!KekkaBunseki.monthAllowed_(idx)) return;
    var t = KekkaBunseki.monthFromIndex_(idx);
    KekkaBunseki.touched = true;
    KekkaBunseki.monthYearSel = String(t.fy);
    KekkaBunseki.monthSel = t.cm;
    KekkaBunseki.renderMonthFilterBar();
    KekkaBunseki.loadMonth();
  },

  /** 月の集計を取得する。取得済み・取得中(2分以内)のものは使い回す */
  monthFetch_: function (year, month) {
    var key = year + '-' + month;
    var e = App.mc[key];
    if (e && Date.now() - e.t < 120000) return e;
    e = { t: Date.now(), done: false };
    e.p = callServer('getKekkaBunsekiMonth', year, month).then(function (d) { e.done = true; return d; });
    e.p.catch(function () { if (App.mc[key] === e) delete App.mc[key]; });
    App.mc[key] = e;
    return e;
  },

  /** 前後の月を裏で取得しておく(◀▶を押したとき、すぐ切り替わる) */
  prefetchNeighbors_: function () {
    var idx = KekkaBunseki.monthIndex_(Number(KekkaBunseki.monthYearSel), Number(KekkaBunseki.monthSel));
    [-1, 1].forEach(function (dlt) {
      if (!KekkaBunseki.monthAllowed_(idx + dlt)) return;
      var t = KekkaBunseki.monthFromIndex_(idx + dlt);
      KekkaBunseki.monthFetch_(t.fy, t.cm).p.catch(function () {});
    });
  },

  onYearSelChange: function (year) {
    KekkaBunseki.touched = true;
    KekkaBunseki.yearSel = year;
    KekkaBunseki.loadYear();
  },

  onMonthYearSelChange: function (year) {
    KekkaBunseki.touched = true;
    KekkaBunseki.monthYearSel = year;
    KekkaBunseki.monthSel = 1;
    KekkaBunseki.renderMonthFilterBar();
    KekkaBunseki.loadMonth();
  },

  onMonthSelChange: function (month) {
    KekkaBunseki.touched = true;
    KekkaBunseki.monthSel = month;
    KekkaBunseki.loadMonth();
  },

  loadYear: function () {
    showLoading('集計中...');
    return callServer('getKekkaBunsekiYear', KekkaBunseki.yearSel).then(function (data) {
      return GoogleChartsReady.then(function () {
        hideLoading();
        KekkaBunseki.renderYear(data);
        KekkaBunseki.syncWeights_(data, data.weightReady, data.weightStale);
      });
    }).catch(function (err) {
      hideLoading();
      showToast('取得失敗: ' + (err.message || err));
    });
  },

  loadMonth: function () {
    var year = KekkaBunseki.monthYearSel, month = KekkaBunseki.monthSel;
    var e = KekkaBunseki.monthFetch_(year, month);
    if (!e.done) showLoading('集計中...');
    return e.p.then(function (data) {
      return GoogleChartsReady.then(function () {
        hideLoading();
        // 取得中に別の月へ移動していたら、この結果は表示しない
        if (String(year) !== String(KekkaBunseki.monthYearSel) || Number(month) !== Number(KekkaBunseki.monthSel)) return;
        KekkaBunseki.renderMonth(data);
        KekkaBunseki.syncWeights_(data, data.weightReady, data.weightStale);
        KekkaBunseki.prefetchNeighbors_();
      });
    }).catch(function (err) {
      hideLoading();
      showToast('取得失敗: ' + (err.message || err));
    });
  },

  renderYear: function (data) {
    KekkaBunseki.yearData = data;
    document.getElementById('kekkaYearBody').innerHTML =
      '<div id="kekkaYearCharts" class="kekka-pretable">' +
      '<div class="card"><div id="yearComboChart" style="width:100%;height:280px;"></div></div>' +
      KekkaBunseki.ratioCardHtml(data.year + '年度', data.pillarTotal, data.beamTotal) +
      '</div>' +
      KekkaBunseki.projectTableHtml(data.projectCounts, '年度比率') +
      KekkaBunseki.contentTableHtml(data.contentCounts, 'year');

    var table = new google.visualization.DataTable();
    table.addColumn('string', '締め月');
    table.addColumn('number', '柱');
    table.addColumn({ type: 'string', role: 'annotation' });
    table.addColumn('number', '梁');
    table.addColumn({ type: 'string', role: 'annotation' });
    table.addColumn('number', '生産重量');
    table.addRows(data.months.map(function (m) {
      return [m.label, m['柱'], String(m['柱']), m['梁'], String(m['梁']), m['生産重量']];
    }));

    var options = {
      seriesType: 'bars',
      series: { 2: { type: 'line', targetAxisIndex: 1 } },
      isStacked: true,
      colors: ['#f9ab00', '#34a853', '#ea4335'],
      vAxes: { 0: { title: '件数' }, 1: { title: '生産重量(t)' } },
      legend: { position: 'top' },
      chartArea: { left: 40, right: 55, top: 28, bottom: 45 },
      annotations: { alwaysOutside: false, textStyle: { fontSize: 10, color: '#000' } }
    };
    KekkaBunseki.yearChart = new google.visualization.ComboChart(document.getElementById('yearComboChart'));
    KekkaBunseki.yearChart.draw(table, options);

    requestAnimationFrame(KekkaBunseki.alignChartHeights);
  },

  renderMonth: function (data) {
    KekkaBunseki.monthData = data;
    document.getElementById('kekkaMonthBody').innerHTML =
      '<div id="kekkaMonthCharts" class="kekka-pretable">' +
      '<div class="card kekka-cards">' +
      '<div class="kekka-card"><div class="kekka-num">' + data['合計'] + '</div><div class="kekka-label">合計件数</div></div>' +
      '<div class="kekka-card"><div class="kekka-num">' + data['柱'] + '</div><div class="kekka-label">柱</div></div>' +
      '<div class="kekka-card"><div class="kekka-num">' + data['梁'] + '</div><div class="kekka-label">梁</div></div>' +
      '<div class="kekka-card"><div class="kekka-num">' + (data['生産重量'] == null ? '…' : data['生産重量']) + '</div><div class="kekka-label">生産重量(t)</div></div>' +
      '</div>' +
      KekkaBunseki.ratioCardHtml(data.label, data['柱'], data['梁']) +
      '</div>' +
      KekkaBunseki.projectTableHtml(data.projectCounts, '年度比率', data.year + '年度' + data.month + '月分　工事別 不具合件数') +
      KekkaBunseki.contentTableHtml(data.contentCounts, 'month') +
      KekkaBunseki.detailTableHtml(data.details);

    requestAnimationFrame(KekkaBunseki.alignChartHeights);
  },

  applyWeights_: function (data, map) {
    var r1 = function (v) { return Math.round((v || 0) * 10) / 10; };
    if (data.months) {
      data.months.forEach(function (m) { m['生産重量'] = r1(map[data.year + '-' + m.closingMonth]); });
      return true;
    }
    if (data.month !== undefined) {
      data['生産重量'] = r1(map[data.year + '-' + data.month]);
      return true;
    }
    return false;
  },

  /** サーバーが重量を未計算(weightReady=false)で返したとき、先読み結果が届き次第、重量だけ差し替えて再描画する */
  syncWeights_: function (data, weightReady, weightStale) {
    if ((weightReady !== false && !weightStale) || !data) return;
    if (!App.weightPromise) App.prefetchWeights();
    App.weightPromise.then(function (map) {
      if (!map || !KekkaBunseki.applyWeights_(data, map)) return;
      if (KekkaBunseki.mode !== 'yearMonth') return;
      if (data === KekkaBunseki.yearData) KekkaBunseki.renderYear(data);
      else if (data === KekkaBunseki.monthData) KekkaBunseki.renderMonth(data);
      KekkaBunseki.alignPreChartBlocks_();
    });
  },

  alignChartHeights: function () {
    var l = document.getElementById('kekkaYearCharts');
    var r = document.getElementById('kekkaMonthCharts');
    if (!l || !r) return;
    l.style.minHeight = '';
    r.style.minHeight = '';
    var h = Math.max(l.offsetHeight, r.offsetHeight);
    l.style.minHeight = h + 'px';
    r.style.minHeight = h + 'px';
  },

  captureHtml: function (html, widthPx) {
    var el = document.getElementById('pdfCapture');
    if (widthPx) {
      el.style.display = '';
      el.style.width = widthPx + 'px';
    } else {
      el.style.display = 'inline-block';
      el.style.width = 'auto';
    }
    el.innerHTML = html;
    return html2canvas(el, { scale: 2, backgroundColor: '#ffffff' }).then(function (canvas) {
      el.innerHTML = '';
      el.style.display = '';
      el.style.width = '';
      return canvas;
    });
  },

  contentTableHtmlForPdf: function (contentCounts, fontSize) {
    var fs = fontSize || 12;
    var pad = Math.max(2, Math.round(fs * 0.4));
    return '<table style="border-collapse:collapse;font-size:' + fs + 'px;">' +
      '<thead><tr><th style="border:1px solid #999;padding:' + pad + 'px 6px;background:#eee;text-align:left;width:' + (fs * 18) + 'px;">不具合内容</th>' +
      '<th style="border:1px solid #999;padding:' + pad + 'px 6px;background:#eee;width:' + (fs * 4) + 'px;">件数</th></tr></thead><tbody>' +
      (contentCounts || []).map(function (c) {
        var bg = (c.group === '柱') ? '#fdf0d9' : (c.group === '梁') ? '#e3f2e8' : '#fff';
        return '<tr style="background:' + bg + ';">' +
          '<td style="border:1px solid #ccc;padding:' + pad + 'px 6px;">' + escapeHtml(stripLeadingNumber(c.name)) + '</td>' +
          '<td style="border:1px solid #ccc;padding:' + pad + 'px 6px;text-align:right;">' + c.count + '</td></tr>';
      }).join('') +
      '</tbody></table>';
  },

  placeScaledToFit: function (doc, canvas, x, y, maxW, maxH) {
    var naturalH = canvas.height / canvas.width * maxW;
    var w, h;
    if (naturalH <= maxH) {
      w = maxW; h = naturalH;
    } else {
      h = maxH; w = canvas.width / canvas.height * maxH;
    }
    doc.addImage(canvas.toDataURL('image/png'), 'PNG', x, y, w, h);
    return h;
  },

  placeChartImageScaledToFit: function (doc, dataUri, x, y, maxW, maxH) {
    var props = doc.getImageProperties(dataUri);
    var naturalH = props.height / props.width * maxW;
    var w, h;
    if (naturalH <= maxH) {
      w = maxW; h = naturalH;
    } else {
      h = maxH; w = props.width / props.height * maxH;
    }
    doc.addImage(dataUri, 'PNG', x, y, w, h);
    return h;
  },

  placeNaturalOrFit: function (doc, canvas, x, y, maxW, maxH) {
    var pxToMm = 25.4 / 96 / 2;
    var w = canvas.width * pxToMm;
    var h = canvas.height * pxToMm;
    if (w > maxW) { h = h * maxW / w; w = maxW; }
    if (h > maxH) { w = w * maxH / h; h = maxH; }
    doc.addImage(canvas.toDataURL('image/png'), 'PNG', x, y, w, h);
    return { w: w, h: h };
  },

  detailTableHtmlForPdf: function (detail, fontSize) {
    var fontFamily = "'Hiragino Kaku Gothic ProN','Meiryo',sans-serif";
    var fs = fontSize || 8;
    var pad = Math.max(2, Math.round(fs * 0.4));
    return '<div style="font-family:' + fontFamily + ';color:#000;">' +
      '<div style="font-size:' + (fs + 2) + 'px;font-weight:bold;margin-bottom:4px;">' +
      escapeHtml(stripLeadingNumber(detail.title)) + '（' + detail.rows.length + '件）</div>' +
      '<table style="border-collapse:collapse;width:100%;font-size:' + fs + 'px;">' +
      '<thead><tr><th style="border:1px solid #999;padding:' + pad + 'px 6px;background:#eee;text-align:left;">不具合内容、原因</th></tr></thead><tbody>' +
      detail.rows.map(function (r) {
        return '<tr><td style="border:1px solid #ccc;padding:' + pad + 'px 6px;">' + escapeHtml(r['不具合内容、原因'] || '') + '</td></tr>';
      }).join('') +
      '</tbody></table></div>';
  },

  downloadPdf: function () {
    var yd = KekkaBunseki.yearData;
    var md = KekkaBunseki.monthData;
    var fontFamily = "'Hiragino Kaku Gothic ProN','Meiryo',sans-serif";
    var isProject = (KekkaBunseki.mode === 'project');
    var leftDetail = KekkaBunseki.openDetail.left;
    var rightDetail = KekkaBunseki.openDetail.right;

    var yearLabelHtml = '<div style="font-family:' + fontFamily + ';color:#000;font-size:14px;font-weight:bold;">' +
      (isProject ? (KekkaBunseki.projectSel || '') + '（全期間）' : ((yd ? yd.year : '') + '年度')) + '</div>';

    var yearTableHtml = '<div style="font-family:' + fontFamily + ';color:#000;">' +
      '<div style="font-size:11px;font-weight:bold;margin-bottom:4px;">不具合内容（件数）</div>' +
      KekkaBunseki.contentTableHtmlForPdf(yd ? yd.contentCounts : [], 9) + '</div>';

    var monthLabelHtml = '<div style="font-family:' + fontFamily + ';color:#000;">' +
      '<div style="font-size:14px;font-weight:bold;">' + (isProject ? '選択した締め月の合計' : ((md ? md.label : '') + ' 締め')) + '</div>' +
      (md ? '<div style="font-size:10px;margin-top:3px;">合計: ' + md['合計'] + '件（柱' + md['柱'] + ' / 梁' + md['梁'] + '）' + (isProject ? '' : ('　生産重量: ' + (md['生産重量'] == null ? '-' : md['生産重量']) + 't')) + '</div>' : '') +
      '</div>';

    var monthTableHtml = '<div style="font-family:' + fontFamily + ';color:#000;">' +
      '<div style="font-size:11px;font-weight:bold;margin-bottom:4px;">不具合内容（件数）</div>' +
      KekkaBunseki.contentTableHtmlForPdf(md ? md.contentCounts : [], 9) + '</div>';

    var captureJobs = [
      { key: 'yearLabel', html: yearLabelHtml, w: 500 },
      { key: 'yearTable', html: yearTableHtml, w: 0 },
      { key: 'monthLabel', html: monthLabelHtml, w: 500 },
      { key: 'monthTable', html: monthTableHtml, w: 0 }
    ];
    var barWrap = function (inner) { return '<div style="font-family:' + fontFamily + ';color:#000;background:#fff;padding:4px 2px;">' + inner + '</div>'; };
    captureJobs.push({ key: 'yearBar', w: 500, html: barWrap(KekkaBunseki.ratioBlockHtml_(isProject ? (KekkaBunseki.projectSel || '') + ' 全期間' : ((yd ? yd.year : '') + '年度'), yd ? yd.pillarTotal : 0, yd ? yd.beamTotal : 0)) });
    captureJobs.push({ key: 'monthBar', w: 500, html: barWrap(KekkaBunseki.ratioBlockHtml_(isProject ? '選択期間' : (md ? md.label : ''), md ? md['柱'] : 0, md ? md['梁'] : 0)) });
    if (leftDetail) captureJobs.push({ key: 'leftDetail', html: KekkaBunseki.detailTableHtmlForPdf(leftDetail, 9), w: 500 });
    if (rightDetail) captureJobs.push({ key: 'rightDetail', html: KekkaBunseki.detailTableHtmlForPdf(rightDetail, 9), w: 500 });

    showLoading('PDF作成中...');
    PdfLibs.load().then(function () { return Promise.all(captureJobs.map(function (j) { return KekkaBunseki.captureHtml(j.html, j.w); })); })
      .then(function (canvases) {
      var canvasByKey = {};
      captureJobs.forEach(function (j, i) { canvasByKey[j.key] = canvases[i]; });

      var JsPdf = window.jspdf.jsPDF;
      var doc = new JsPdf({ orientation: 'portrait', unit: 'mm', format: 'a4' });
      var pageW = doc.internal.pageSize.getWidth();
      var pageH = doc.internal.pageSize.getHeight();
      var margin = 10;
      var subGap = 4;
      var contentW = pageW - margin * 2;
      var contentBottom = pageH - margin;
      var chartW = Math.min(contentW, 170);
      var comboH = 55;

      // ページ1: 年度指定/工事全期間
      var yL = margin;
      yL += KekkaBunseki.placeScaledToFit(doc, canvasByKey.yearLabel, margin, yL, contentW, 10);
      yL += 2;
      if (KekkaBunseki.yearChart) {
        yL += KekkaBunseki.placeChartImageScaledToFit(doc, KekkaBunseki.yearChart.getImageURI(), margin, yL, chartW, comboH) + 3;
      }
      yL += KekkaBunseki.placeScaledToFit(doc, canvasByKey.yearBar, margin, yL, chartW, 26) + 3;
      var yearTableRes = KekkaBunseki.placeNaturalOrFit(doc, canvasByKey.yearTable, margin, yL, contentW, contentBottom - yL);
      if (leftDetail) {
        var leftDetailX = margin + yearTableRes.w + subGap;
        var leftDetailW = contentW - yearTableRes.w - subGap;
        KekkaBunseki.placeScaledToFit(doc, canvasByKey.leftDetail, leftDetailX, yL, leftDetailW, contentBottom - yL);
      }

      // ページ2: 月指定/選択締め月（すべて縦並び）
      doc.addPage('a4', 'portrait');
      var yR = margin;
      yR += KekkaBunseki.placeScaledToFit(doc, canvasByKey.monthLabel, margin, yR, contentW, 16);
      yR += 2;
      yR += KekkaBunseki.placeScaledToFit(doc, canvasByKey.monthBar, margin, yR, chartW, 26) + 3;
      var monthTableRes = KekkaBunseki.placeNaturalOrFit(doc, canvasByKey.monthTable, margin, yR, contentW, contentBottom - yR);
      yR += monthTableRes.h + 3;
      if (rightDetail) {
        KekkaBunseki.placeScaledToFit(doc, canvasByKey.rightDetail, margin, yR, contentW, contentBottom - yR);
      }

      hideLoading();
      var filenamePart = isProject
        ? ('工事別_' + (KekkaBunseki.projectSel || ''))
        : ((yd ? yd.year + '年度' : '') + '_' + (md ? md.label.replace('/', '_') : ''));
      var pdfName = '結果分析_' + filenamePart + '.pdf';
      doc.save(pdfName);
      callServer('logPdfDownload', pdfName).catch(function () {});
    }).catch(function (err) {
      hideLoading();
      showToast('PDF作成失敗: ' + (err.message || err));
    });
  }
};
