/** ===================== 共通ユーティリティ ===================== */

function escapeHtml(str) {
  if (str === null || str === undefined) return '';
  return String(str)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
}

/** <option>の並び。items は {value,label}。selected と value は文字列として比較する */
function optionsHtml(items, selected) {
  return items.map(function (it) {
    var sel = (String(it.value) === String(selected)) ? ' selected' : '';
    return '<option value="' + it.value + '"' + sel + '>' + it.label + '</option>';
  }).join('');
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
  del: function (k) { try { localStorage.removeItem('hg:' + k); } catch (e) {} },
  delPrefix: function (p) {
    try {
      Object.keys(localStorage).filter(function (k) { return k.indexOf('hg:' + p) === 0; })
        .forEach(function (k) { localStorage.removeItem(k); });
    } catch (e) {}
  }
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

/**
 * PDF用ライブラリと日本語フォント。PDFを作るとき(または結果分析を開いた少し後に裏で)だけ読み込む。
 * フォントは M PLUS 1p Regular(OFL・無料。約1.7MB。ブラウザのキャッシュに残る)。太字は輪郭を足して表現する。
 * 注意: pdf-lib のサブセット埋め込み(subset:true)は、日本語フォントで一部の文字が欠けるため使わない(全体を埋め込む。PDFは約1MB)。
 */
var PdfLibs = {
  p: null,
  font: null,
  FONT_URL: 'https://cdn.jsdelivr.net/npm/@expo-google-fonts/m-plus-1p@0.4.2/400Regular/MPLUS1p_400Regular.ttf',
  load: function () {
    if (!PdfLibs.p) {
      PdfLibs.p = Promise.all([
        loadScript('https://cdnjs.cloudflare.com/ajax/libs/pdf-lib/1.17.1/pdf-lib.min.js'),
        loadScript('https://cdn.jsdelivr.net/npm/@pdf-lib/fontkit@1.1.1/dist/fontkit.umd.min.js'),
        fetch(PdfLibs.FONT_URL).then(function (r) {
          if (!r.ok) throw new Error('フォント取得失敗 ' + r.status);
          return r.arrayBuffer();
        })
      ]).then(function (r) {
        PdfLibs.font = r[2];
        // 画面側でも同じフォントで文字の幅を測る(PDFの文字位置を画面の測定値どおりにするため)
        var face = new FontFace('HgPdfJP', r[2].slice(0), { weight: '100 900' });
        return face.load().then(function (f) { document.fonts.add(f); });
      }).catch(function (e) { PdfLibs.p = null; throw e; });
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
  tc: {},
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
  fetchBoot: function (name, fn, args) {
    var e = App.pf[name];
    if (e && Date.now() - e.t < 30000) return e.p;
    var p = callServer.apply(null, [fn].concat(args || []));
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
    App.tc = {};
    Store.del('kb');
    Store.del('rb');
    Store.delPrefix('bn:');
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
      '検査確認者': Wizard.lastInspector_() || ''
    };
    Wizard.render();
  },

  /** 前回の検査員(保存領域が使えない環境でも落ちない)。引数ありで保存、なしで取得 */
  lastInspector_: function (v) {
    try {
      if (v === undefined) return localStorage.getItem('lastInspector');
      localStorage.setItem('lastInspector', v);
    } catch (e) { return null; }
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
      if (wasNew && f['検査確認者']) Wizard.lastInspector_(f['検査確認者']);
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

  /** 「m月20日締め（期間）(件数)」の選択肢(1〜12月) */
  monthOptionsHtml_: function (summary, year, selected) {
    var items = [];
    for (var m = 1; m <= 12; m++) {
      var cnt = summary.yearMonthCounts[year + '-' + m] || 0;
      items.push({ value: m, label: m + '月20日締め（' + Records.CLOSING_PERIODS[m] + '）(' + cnt + '件)' });
    }
    return optionsHtml(items, selected);
  },

  renderFilterBar: function (years) {
    var yearOptions = optionsHtml(years.map(function (y) {
      return { value: y, label: y + '年度 (' + Records.summary.yearCounts[y] + '件)' };
    }), Records.year);

    var monthOptions = '<option value="">全月</option>' + Records.monthOptionsHtml_(Records.summary, Records.year, Records.month);

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

var RecordTables = { seq: 0, map: {} };

function renderRecordTable(rows, container, total, refreshFn, columns) {
  var cols = columns || TABLE_COLUMNS;
  // 画面に無くなった表の行データは捨てる。表ごとに別の登録にして、左右の詳細カードなどが混ざらないようにする
  Object.keys(RecordTables.map).forEach(function (k) {
    if (!document.querySelector('[data-rt="' + k + '"]')) delete RecordTables.map[k];
  });
  var rtId = container.getAttribute('data-rt') || ('rt' + (++RecordTables.seq));
  container.setAttribute('data-rt', rtId);
  RecordTables.map[rtId] = { rows: rows, refreshFn: refreshFn };

  var html = '<div class="count-badge">' + (total !== undefined ? total : rows.length) + ' 件</div>' +
    '<div class="table-scroll"><table class="record-table"><thead><tr>' +
    cols.map(function (c) { return '<th>' + escapeHtml(c) + '</th>'; }).join('') +
    '</tr></thead><tbody>';

  rows.forEach(function (r, idx) {
    html += '<tr onclick="renderRecordTable._openRow(\'' + rtId + '\',' + idx + ')">' +
      cols.map(function (c) {
        var v = (c === '分類選択') ? stripLeadingNumber(r[c]) : r[c];
        return '<td>' + escapeHtml(v) + '</td>';
      }).join('') +
      '</tr>';
  });
  html += '</tbody></table></div>';
  container.innerHTML = html;
}

renderRecordTable._openRow = function (rtId, idx) {
  var t = RecordTables.map[rtId];
  if (t) Modal.open(t.rows[idx], t.refreshFn);
};

/** ===================== 結果仕訳け画面 ===================== */

var Bunseki = {
  token: 0, // 画面を切り替えるたびに進める。古い取得結果が、移動後の画面に描かれないようにする

  /** メニューの3項目(件数一覧の取得先) */
  COUNT_DEFS: [
    { mode: 'field', field: '選択物件名' },
    { mode: 'process', field: '加工先' },
    { mode: 'process', field: '分類' }
  ],

  showMenu: function () {
    App.currentBack = App.goHome;
    Bunseki.token++;
    document.getElementById('view').innerHTML =
      '<div class="menu-grid">' +
      '<button class="menu-btn secondary" onclick="Bunseki.showCounts(\'field\',\'選択物件名\',\'物件\')">物件</button>' +
      '<button class="menu-btn tertiary" onclick="Bunseki.showCounts(\'process\',\'加工先\',\'加工先\')">加工先</button>' +
      '<button class="menu-btn" style="background:#9334e8;" onclick="Bunseki.showCounts(\'process\',\'分類\',\'分類\')">分類</button>' +
      '</div>';
    // メニューを開いたらすぐ3つの件数を裏で取得しておく(押したとき待たずに表示できる)
    Bunseki.COUNT_DEFS.forEach(function (d) { Bunseki.fetchCounts_(d.mode, d.field).catch(function () {}); });
  },

  fetchCounts_: function (mode, field) {
    return App.fetchBoot('bn:' + mode + ':' + field, mode === 'field' ? 'getBunsekiByField' : 'getBunsekiByProcessType', [field]);
  },

  showCounts: function (mode, field, title) {
    App.currentBack = Bunseki.showMenu;
    var token = ++Bunseki.token;
    var key = 'bn:' + mode + ':' + field;
    var cached = Store.get(key);
    var fresh = Bunseki.fetchCounts_(mode, field);

    var render = function (counts) {
      var entries = Object.keys(counts).map(function (k) { return { name: k, count: counts[k] }; });
      entries.sort(function (a, b) { return b.count - a.count; });

      var html = '<div class="bunseki-list">';
      entries.forEach(function (e) {
        html += '<div class="bunseki-item" data-mode="' + mode + '" data-field="' + escapeHtml(field) + '" data-v="' + escapeHtml(e.name) + '" onclick="Bunseki.showTableEl(this)">' +
          '<span>' + escapeHtml(e.name) + '</span><span class="count">' + e.count + ' 件</span></div>';
      });
      html += '</div>';
      document.getElementById('view').innerHTML = html;
    };

    if (cached) {
      // 前回の結果を先に表示し、裏で最新を取得。変わっていれば差し替える
      render(cached);
      fresh.then(function (counts) {
        Store.set(key, counts);
        if (token === Bunseki.token && JSON.stringify(counts) !== JSON.stringify(cached)) render(counts);
      }).catch(function () {});
    } else {
      showLoading('集計中...');
      fresh.then(function (counts) {
        Store.set(key, counts);
        hideLoading();
        if (token === Bunseki.token) render(counts);
      }).catch(function (err) {
        hideLoading();
        showToast('集計失敗: ' + (err.message || err));
      });
    }
  },

  showTableEl: function (el) { Bunseki.showTable(el.getAttribute('data-mode'), el.getAttribute('data-field'), el.getAttribute('data-v')); },

  showTable: function (mode, field, value) {
    App.currentBack = function () { Bunseki.showCounts(mode, field, field); };
    var token = ++Bunseki.token;
    var serverField = (mode === 'process' && field === '分類') ? '分類グループ' : field;
    var key = serverField + '|' + value;
    var cached = App.tc[key];
    if (Object.keys(App.tc).length > 30) App.tc = {};

    var show = function (rows) {
      var area = document.createElement('div');
      document.getElementById('view').innerHTML = '';
      document.getElementById('view').appendChild(area);
      renderRecordTable(rows, area, undefined, function () { Bunseki.showTable(mode, field, value); });
    };
    var p = callServer('getFilteredRecords', serverField, value);

    if (cached) {
      // 一度開いた表は先に表示し、裏で最新を取得。変わっていれば差し替える(保存・更新すると破棄される)
      show(cached);
      p.then(function (rows) {
        App.tc[key] = rows;
        if (token === Bunseki.token && JSON.stringify(rows) !== JSON.stringify(cached)) show(rows);
      }).catch(function () {});
    } else {
      showLoading('読み込み中...');
      p.then(function (rows) {
        App.tc[key] = rows;
        hideLoading();
        if (token === Bunseki.token) show(rows);
      }).catch(function (err) {
        hideLoading();
        showToast('取得失敗: ' + (err.message || err));
      });
    }
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
    KekkaBunseki.preloadPdfLibs_();
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

  /** PDFを押す前に、ライブラリとフォントを裏で読み込んでおく(2回目以降はブラウザのキャッシュから) */
  preloadPdfLibs_: function () {
    setTimeout(function () { PdfLibs.load().catch(function () {}); }, 3000);
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
    // 下端の位置で揃える(工事別では右列の上に締め月の一覧があり、左右で上端の位置が違うため)
    var delta = Math.round(leftFirst.getBoundingClientRect().bottom - rightFirst.getBoundingClientRect().bottom);
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

  /** 柱/梁の積み上げ棒(+生産重量)のグラフ用データ表 */
  chartTable_: function (withWeight, rows) {
    var table = new google.visualization.DataTable();
    table.addColumn('string', '締め月');
    table.addColumn('number', '柱');
    table.addColumn({ type: 'string', role: 'annotation' });
    table.addColumn('number', '梁');
    table.addColumn({ type: 'string', role: 'annotation' });
    if (withWeight) table.addColumn('number', '生産重量');
    table.addRows(rows);
    return table;
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

    var table = KekkaBunseki.chartTable_(false, data.periods.map(function (p) {
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

    requestAnimationFrame(KekkaBunseki.alignChartHeights);
  },

  /** 柱/梁の比率: 1本の横バー + 件数・%のテキスト（画面・PDF共通） */
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

  /** 見出し(タイトル)つきカードの中に表を置く共通の枠。headHtml は <th>…</th> の並び */
  tableCardHtml_: function (titleHtml, headHtml, bodyHtml) {
    return '<div class="card"><div class="kekka-subtitle">' + titleHtml + '</div>' +
      '<div class="table-scroll" style="max-height:none;overflow-y:visible;overflow-x:auto;"><table class="record-table"><thead><tr>' +
      headHtml + '</tr></thead><tbody>' + bodyHtml + '</tbody></table></div></div>';
  },

  /** 見出しセルを中央揃えで並べる */
  centerHeadHtml_: function (labels) {
    return labels.map(function (h) { return '<th style="text-align:center;">' + h + '</th>'; }).join('');
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
    return KekkaBunseki.tableCardHtml_(escapeHtml(title || '工事別 不具合件数'),
      KekkaBunseki.centerHeadHtml_(['工事名', '柱', '梁', '合計', ratioLabel, '比率データバー']), rows);
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
    return KekkaBunseki.tableCardHtml_('詳細（' + list.length + '件）',
      KekkaBunseki.centerHeadHtml_(['日付', '工事名', '分類', '不具合内容']), rows);
  },

  contentTableHtml: function (contentCounts, side) {
    return KekkaBunseki.tableCardHtml_('不具合内容（件数）',
      '<th>不具合内容</th><th style="text-align:center;">件数</th>',
      contentCounts.map(function (c) {
        var rowClass = (c.group === '柱') ? 'row-pillar' : (c.group === '梁') ? 'row-beam' : '';
        return '<tr class="' + rowClass + '" data-side="' + side + '" data-v="' + escapeHtml(c.name) + '" onclick="KekkaBunseki.showContentDetailEl(this)">' +
          '<td>' + escapeHtml(stripLeadingNumber(c.name)) + '</td><td style="text-align:center;">' + c.count + '</td></tr>';
      }).join(''));
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
    var options = optionsHtml(KekkaBunseki.years.map(function (y) {
      return { value: y, label: y + '年度 (' + KekkaBunseki.summary.yearCounts[y] + '件)' };
    }), KekkaBunseki.yearSel);
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
    var yearOptions = optionsHtml(KekkaBunseki.years.map(function (y) { return { value: y, label: y + '年度' }; }), KekkaBunseki.monthYearSel);
    var monthOptions = Records.monthOptionsHtml_(KekkaBunseki.summary, KekkaBunseki.monthYearSel, KekkaBunseki.monthSel);
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

    var table = KekkaBunseki.chartTable_(true, data.months.map(function (m) {
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
    // 下端の位置を揃える(これより下の表が左右で並ぶ)。左右の上端が同じなら、高さを揃えるのと同じ
    var lt = l.getBoundingClientRect().top, rt = r.getBoundingClientRect().top;
    var bottom = Math.max(lt + l.offsetHeight, rt + r.offsetHeight);
    l.style.minHeight = (bottom - lt) + 'px';
    r.style.minHeight = (bottom - rt) + 'px';
  },

  /**
   * PDF用の表示(#pdfRoot)を画面の外に作る。結果分析の現在の表示(左右2列)を複製し、上部に見出しと印刷日を付ける。
   * ここで測った位置・大きさ・文字をそのままPDFに描く(renderPdf_)ので、画面と同じ見た目になる。
   */
  buildPdfRoot_: function () {
    var target = document.querySelector('#view .kekka-split');
    if (!target) return null;
    KekkaBunseki.removePdfRoot_();
    // 画面が2列で表示される幅ならその幅のまま、狭い画面(携帯)は2列になる幅に広げる
    var live = target.offsetWidth;
    var capW = live >= 860 ? live : 960;

    var root = document.createElement('div');
    root.id = 'pdfRoot';
    var clone = target.cloneNode(true);
    Array.prototype.forEach.call(clone.querySelectorAll('[id]'), function (n) { n.removeAttribute('id'); });
    // 年度・月の選択は、枠とボタンを外してテキストだけにする
    Array.prototype.forEach.call(clone.querySelectorAll('.filter-bar'), function (bar) {
      var texts = Array.prototype.map.call(bar.querySelectorAll('select'), function (sel) {
        return sel.options[sel.selectedIndex] ? sel.options[sel.selectedIndex].text : '';
      }).filter(Boolean);
      if (!texts.length) return;
      bar.innerHTML = '<div style="font-size:14px;font-weight:bold;color:#000;">' + escapeHtml(texts.join('　')) + '</div>';
    });
    // グラフは画像としてPDFに貼る。置き場所の箱を、画面のグラフと同じ縦横比で用意する
    var liveChart = document.getElementById('yearComboChart');
    var chartBox = clone.querySelector('.kekka-pretable .card > div');
    if (liveChart && chartBox && chartBox.style.height) {
      chartBox.id = 'pdfChartBox';
      chartBox.innerHTML = '';
    }
    // ページ上部: 見出し(中央・2倍の大きさ)と印刷日(右端)
    var jst = new Date(Date.now() + 9 * 3600 * 1000);
    var printed = jst.getUTCFullYear() + '.' + String(jst.getUTCMonth() + 1).padStart(2, '0') + '.' + String(jst.getUTCDate()).padStart(2, '0') + '印刷';
    var head = document.createElement('div');
    head.style.cssText = 'flex:0 0 100%;display:grid;grid-template-columns:1fr auto 1fr;align-items:end;color:#000;margin-bottom:10px;';
    head.innerHTML = '<span></span><span style="font-size:32px;font-weight:bold;text-align:center;">社内不具合記録【分析結果】</span>' +
      '<span style="font-size:16px;font-weight:bold;text-align:right;">' + printed + '</span>';
    clone.insertBefore(head, clone.firstChild);
    root.appendChild(clone);

    var st = document.createElement('style');
    st.id = 'pdfStyle';
    st.textContent = '#pdfRoot{position:fixed;left:-99999px;top:0;width:' + capW + 'px;background:#fff;color:#222;font-family:HgPdfJP,sans-serif;}' +
      '#pdfRoot .kekka-split{display:flex;flex-direction:row;flex-wrap:wrap;align-items:flex-start;gap:20px;width:' + capW + 'px;}' +
      '#pdfRoot .kekka-col{flex:1;min-width:0;}' +
      '#pdfRoot .kekka-sticky{position:static;background:transparent;}' +
      '#pdfRoot .kekka-col-title{display:none;}' +
      '#pdfRoot .card{background:#fff;border-radius:10px;padding:16px;margin-bottom:12px;border:1px solid #ccc;box-shadow:none;}' +
      '#pdfRoot .table-scroll{display:block;border:3px double #000;border-radius:0;overflow:visible !important;max-height:none !important;}' +
      '#pdfRoot table.record-table{border:none;border-radius:0;width:100%;}' +
      '#pdfRoot table.record-table th,#pdfRoot table.record-table td{border:1px solid #000;border-left:none;border-right:none;}' +
      '#pdfRoot table.record-table th:not(:first-child),#pdfRoot table.record-table td:not(:first-child){border-left:1px dashed #000;}' +
      '#pdfRoot table.record-table thead tr:first-child>*{border-top:none;}' +
      '#pdfRoot table.record-table tbody tr:last-child>*{border-bottom:none;}' +
      '#pdfRoot table.record-table th{position:static;}';
    document.head.appendChild(st);
    document.body.appendChild(root);
    if (chartBox && chartBox.id === 'pdfChartBox') {
      var box = document.getElementById('pdfChartBox');
      var lw = liveChart.offsetWidth || 1, lh = liveChart.offsetHeight || 280;
      box.style.height = Math.round(box.offsetWidth * lh / lw) + 'px';
    }
    return { root: root, width: capW };
  },

  removePdfRoot_: function () {
    ['pdfRoot', 'pdfStyle'].forEach(function (id) {
      var n = document.getElementById(id);
      if (n) n.remove();
    });
  },

  /**
   * #pdfRoot の中身を、位置・背景・罫線・文字ごとにPDFへ描く(文字は選択・コピーできる)。
   * 戻り値: Promise<Uint8Array>(PDFのデータ)
   */
  renderPdf_: function (root, capW, chartDataUri, title) {
    var PL = window.PDFLib;
    var PW = 595.28, PH = 841.89, M = 22.68; // A4縦、余白8mm
    var rr = root.getBoundingClientRect();
    var contentH = rr.height;
    var S = Math.min((PW - 2 * M) / capW, (PH - 2 * M) / contentH);
    var offX = M + ((PW - 2 * M) - capW * S) / 2;
    var X = function (px) { return offX + (px - rr.left) * S; };
    var Y = function (px) { return PH - (M + (px - rr.top) * S); };

    var doc, page, f400;
    var rgb = function (str) {
      var m = /rgba?\(([\d.]+),\s*([\d.]+),\s*([\d.]+)(?:,\s*([\d.]+))?\)/.exec(str || '');
      if (!m) return null;
      var a = m[4] === undefined ? 1 : parseFloat(m[4]);
      if (a === 0) return null;
      return { c: PL.rgb(m[1] / 255, m[2] / 255, m[3] / 255), a: a };
    };
    var px = function (v) { return parseFloat(v) || 0; };

    // 角丸の四角のパス(単位はpx。drawSvgPathで S 倍して描く)
    var roundPath = function (w, h, r) {
      r = Math.min(r, w / 2, h / 2);
      var k = r * 0.5523;
      return 'M' + r + ',0 L' + (w - r) + ',0 C' + (w - r + k) + ',0 ' + w + ',' + (r - k) + ' ' + w + ',' + r +
        ' L' + w + ',' + (h - r) + ' C' + w + ',' + (h - r + k) + ' ' + (w - r + k) + ',' + h + ' ' + (w - r) + ',' + h +
        ' L' + r + ',' + h + ' C' + (r - k) + ',' + h + ' 0,' + (h - r + k) + ' 0,' + (h - r) +
        ' L0,' + r + ' C0,' + (r - k) + ' ' + (r - k) + ',0 ' + r + ',0 Z';
    };

    var line = function (x1, y1, x2, y2, w, color, dashed) {
      var o = { start: { x: X(x1), y: Y(y1) }, end: { x: X(x2), y: Y(y2) }, thickness: w * S, color: color };
      if (dashed) o.dashArray = [2 * S * Math.max(w, 1), 2 * S * Math.max(w, 1)];
      page.drawLine(o);
    };

    var drawBox = function (el, cs, r) {
      var radius = px(cs.borderTopLeftRadius);
      var bg = rgb(cs.backgroundColor);
      var bw = [px(cs.borderTopWidth), px(cs.borderRightWidth), px(cs.borderBottomWidth), px(cs.borderLeftWidth)];
      var bs = [cs.borderTopStyle, cs.borderRightStyle, cs.borderBottomStyle, cs.borderLeftStyle];
      var bc = [rgb(cs.borderTopColor), rgb(cs.borderRightColor), rgb(cs.borderBottomColor), rgb(cs.borderLeftColor)];
      var uniform = bw[0] > 0 && bw[0] === bw[1] && bw[1] === bw[2] && bw[2] === bw[3] && bs[0] === 'solid' && bs[0] === bs[1] && bs[1] === bs[2] && bs[2] === bs[3];
      if (radius > 0 && (bg || uniform)) {
        // 角丸: 背景と(一様な)枠線を1つのパスで描く
        var path = roundPath(r.width - (uniform ? bw[0] : 0), r.height - (uniform ? bw[0] : 0), radius);
        var o = { x: X(r.left + (uniform ? bw[0] / 2 : 0)), y: Y(r.top + (uniform ? bw[0] / 2 : 0)), scale: S };
        if (bg) { o.color = bg.c; o.opacity = bg.a; }
        if (uniform && bc[0]) { o.borderColor = bc[0].c; o.borderWidth = bw[0]; }
        page.drawSvgPath(path, o);
        return;
      }
      if (bg) page.drawRectangle({ x: X(r.left), y: Y(r.bottom), width: r.width * S, height: r.height * S, color: bg.c, opacity: bg.a });
      var isCell = (el.tagName === 'TD' || el.tagName === 'TH');
      for (var i = 0; i < 4; i++) {
        var w = bw[i];
        if (!(w > 0) || !bc[i] || bs[i] === 'none' || bs[i] === 'hidden') continue;
        if (isCell && i === 1 && el.nextElementSibling) continue; // 隣のセルの左線と重なるので描かない
        if (isCell && i === 2 && el.parentElement.nextElementSibling) continue;
        if (bs[i] === 'double' && w >= 3) {
          // 二重線: 外側と内側の2本の枠(各 w/3 の太さ)。表を囲む枠なので四隅は直角につながる
          if (i === 0) {
            var t = w / 3;
            page.drawRectangle({ x: X(r.left + t / 2), y: Y(r.bottom - t / 2), width: (r.width - t) * S, height: (r.height - t) * S, borderColor: bc[i].c, borderWidth: t * S });
            page.drawRectangle({ x: X(r.left + w - t / 2), y: Y(r.bottom - w + t / 2), width: (r.width - 2 * w + t) * S, height: (r.height - 2 * w + t) * S, borderColor: bc[i].c, borderWidth: t * S });
          }
          continue;
        }
        var dashed = (bs[i] === 'dashed' || bs[i] === 'dotted');
        if (i === 0) line(r.left, r.top + w / 2, r.right, r.top + w / 2, w, bc[i].c, dashed);
        else if (i === 2) line(r.left, r.bottom - w / 2, r.right, r.bottom - w / 2, w, bc[i].c, dashed);
        else if (i === 3) line(r.left + w / 2, r.top, r.left + w / 2, r.bottom, w, bc[i].c, dashed);
        else line(r.right - w / 2, r.top, r.right - w / 2, r.bottom, w, bc[i].c, dashed);
      }
    };

    var drawText = function (node) {
      var parent = node.parentElement;
      if (!parent) return;
      var cs = getComputedStyle(parent);
      if (cs.visibility === 'hidden' || cs.display === 'none') return;
      var fs = px(cs.fontSize);
      var col = rgb(cs.color) || { c: PL.rgb(0, 0, 0), a: 1 };
      var bold = parseInt(cs.fontWeight, 10) >= 600;
      var range = document.createRange();
      var lines = [], cur = null;
      var str = node.data;
      for (var i = 0; i < str.length; i++) {
        range.setStart(node, i);
        range.setEnd(node, i + 1);
        var rects = range.getClientRects();
        if (!rects.length) continue;
        var rc = rects[0];
        if (rc.width === 0 && /\s/.test(str[i])) continue;
        if (!cur || Math.abs(rc.top - cur.top) > fs * 0.5) {
          cur = { top: rc.top, left: rc.left, height: rc.height, text: '' };
          lines.push(cur);
        }
        cur.text += str[i];
      }
      lines.forEach(function (ln) {
        var t = ln.text.replace(/\s+$/, '').replace(/^\s+/, '');
        if (!t) return;
        // 先頭の空白を除いた分だけ開始位置を詰める必要はない(空白は幅0で省かれる/折り返しで消える)
        var base = ln.top + ln.height * 0.7706; // M PLUS 1p: ascent 1.075 / (ascent+descent 1.395)
        var o = { x: X(ln.left), y: Y(base), size: fs * S, font: f400, color: col.c, opacity: col.a };
        if (bold) {
          // 太字: 同じ文字に輪郭を足す(文字は1つのまま。コピーしても重複しない)
          page.pushOperators(PL.setTextRenderingMode(PL.TextRenderingMode.FillAndOutline), PL.setLineWidth(fs * S * 0.04), PL.setStrokingColor(col.c));
          page.drawText(t, o);
          page.pushOperators(PL.setTextRenderingMode(PL.TextRenderingMode.Fill));
        } else {
          page.drawText(t, o);
        }
      });
    };

    var walk = function (node) {
      if (node.nodeType === 3) { if (node.data.trim()) drawText(node); return; }
      if (node.nodeType !== 1) return;
      var cs = getComputedStyle(node);
      if (cs.display === 'none' || cs.visibility === 'hidden') return;
      var r = node.getBoundingClientRect();
      if (node.tagName === 'INPUT' && node.type === 'checkbox') {
        page.drawRectangle({ x: X(r.left), y: Y(r.bottom), width: r.width * S, height: r.height * S, borderColor: PL.rgb(0, 0, 0), borderWidth: 0.7 });
        if (node.checked) {
          line(r.left + r.width * 0.2, r.top + r.height * 0.55, r.left + r.width * 0.43, r.top + r.height * 0.78, 1.5, PL.rgb(0, 0, 0));
          line(r.left + r.width * 0.43, r.top + r.height * 0.78, r.left + r.width * 0.82, r.top + r.height * 0.22, 1.5, PL.rgb(0, 0, 0));
        }
        return;
      }
      if (r.width > 0 && r.height > 0) drawBox(node, cs, r);
      for (var c = node.firstChild; c; c = c.nextSibling) walk(c);
    };

    return PL.PDFDocument.create().then(function (d) {
      doc = d;
      doc.registerFontkit(window.fontkit);
      doc.setTitle(title);
      doc.setProducer('huguai');
      return doc.embedFont(PdfLibs.font, { subset: false });
    }).then(function (font) {
      f400 = font;
      page = doc.addPage([PW, PH]);
      walk(root.firstChild);
      var box = document.getElementById('pdfChartBox');
      if (box && chartDataUri) {
        return doc.embedPng(chartDataUri).then(function (img) {
          var b = box.getBoundingClientRect();
          page.drawImage(img, { x: X(b.left), y: Y(b.bottom), width: b.width * S, height: b.height * S });
        });
      }
    }).then(function () { return doc.save(); });
  },

  /**
   * 結果分析を、現在の画面のままA4縦1ページの文字入りPDFにして、そのままダウンロードする。
   * ファイル名は 結果分析_年度_日時(日本時間 yyyyMMddHHmmss)。
   */
  downloadPdf: function () {
    var yd = KekkaBunseki.yearData;
    var isProject = (KekkaBunseki.mode === 'project');
    if (!document.querySelector('#view .kekka-split')) { showToast('結果分析の画面を表示してからPDFを作成してください'); return; }
    var chartUri = null;
    try { if (KekkaBunseki.yearChart) chartUri = KekkaBunseki.yearChart.getImageURI(); } catch (e) { chartUri = null; }
    var stamp = new Date(Date.now() + 9 * 3600 * 1000).toISOString().replace(/[-:T]/g, '').slice(0, 14);
    var filenamePart = (isProject ? ('工事別_' + (KekkaBunseki.projectSel || '')) : ((yd ? yd.year + '年度' : '') + '')) + '_' + stamp;
    var pdfName = '結果分析_' + filenamePart + '.pdf';

    showLoading('PDF作成中...');
    PdfLibs.load().then(function () {
      var built = KekkaBunseki.buildPdfRoot_();
      if (!built) throw new Error('画面がありません');
      return KekkaBunseki.renderPdf_(built.root, built.width, chartUri, pdfName).then(function (bytes) {
        KekkaBunseki.removePdfRoot_();
        return bytes;
      }, function (e) { KekkaBunseki.removePdfRoot_(); throw e; });
    }).then(function (bytes) {
      hideLoading();
      var url = URL.createObjectURL(new Blob([bytes], { type: 'application/pdf' }));
      var a = document.createElement('a');
      a.href = url; a.download = pdfName;
      document.body.appendChild(a);
      a.click();
      setTimeout(function () { a.remove(); URL.revokeObjectURL(url); }, 3000);
      callServer('logPdfDownload', pdfName).catch(function () {});
    }).catch(function (err) {
      hideLoading();
      showToast('PDF作成失敗: ' + (err.message || err));
    });
  }
};
