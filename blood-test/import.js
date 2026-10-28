// 取り込みタブ: 撮影・画像・PDF → Geminiで読み取り(GAS経由) → 確認・修正 → 記録に追加
(function () {
  'use strict';

  var BT = window.BT;
  var esc = BT.esc, S = BT.S;
  var MAX_EDGE = 2000;
  var PDFJS = 'https://cdnjs.cloudflare.com/ajax/libs/pdf.js/3.11.174/pdf.min.js';
  var PDFJS_WORKER = 'https://cdnjs.cloudflare.com/ajax/libs/pdf.js/3.11.174/pdf.worker.min.js';

  var Q = [];          // 読み取り待ちのページ { id, name, page, url, status, error, records }
  var REVIEW = null;   // 確認中の検査 [{ date, time, files, pages, items:[{ name, value, alt, inc }] }]
  var seq = 0;

  function $(id) { return document.getElementById(id); }

  function msg(text, kind) {
    var m = $('impMsg');
    m.textContent = text || '';
    m.className = 'msg' + (kind === 'info' ? ' info' : kind === 'ok' ? ' ok' : '');
    m.hidden = !text;
  }

  // ---- 画像・PDFの取り込み ---------------------------------------------
  function loadScript(url) {
    return new Promise(function (resolve, reject) {
      var el = document.createElement('script');
      el.src = url;
      el.onload = resolve;
      el.onerror = function () { reject(new Error('PDF読み込み部品を読み込めませんでした(ネットワークを確認してください)')); };
      document.head.appendChild(el);
    });
  }

  function canvasJpeg(source, w, h) {
    var s = Math.min(1, MAX_EDGE / Math.max(w, h));
    var c = document.createElement('canvas');
    c.width = Math.round(w * s);
    c.height = Math.round(h * s);
    var ctx = c.getContext('2d');
    ctx.fillStyle = '#fff';
    ctx.fillRect(0, 0, c.width, c.height);
    ctx.drawImage(source, 0, 0, c.width, c.height);
    return c.toDataURL('image/jpeg', 0.85);
  }

  function imageToJpeg(file) {
    if (window.createImageBitmap) {
      return createImageBitmap(file).then(function (bmp) {
        var url = canvasJpeg(bmp, bmp.width, bmp.height);
        if (bmp.close) bmp.close();
        return url;
      });
    }
    return new Promise(function (resolve, reject) {
      var img = new Image();
      img.onload = function () { resolve(canvasJpeg(img, img.naturalWidth, img.naturalHeight)); };
      img.onerror = function () { reject(new Error('画像を開けませんでした')); };
      img.src = URL.createObjectURL(file);
    });
  }

  function pdfToJpegs(file) {
    var ready = window.pdfjsLib ? Promise.resolve() : loadScript(PDFJS);
    return ready.then(function () {
      window.pdfjsLib.GlobalWorkerOptions.workerSrc = PDFJS_WORKER;
      return file.arrayBuffer();
    }).then(function (buf) {
      return window.pdfjsLib.getDocument({ data: buf }).promise;
    }).then(function (pdf) {
      var urls = [];
      var next = function (n) {
        if (n > pdf.numPages) return urls;
        return pdf.getPage(n).then(function (page) {
          var v1 = page.getViewport({ scale: 1 });
          var scale = Math.min(4, MAX_EDGE / Math.max(v1.width, v1.height));
          var vp = page.getViewport({ scale: scale });
          var c = document.createElement('canvas');
          c.width = Math.round(vp.width);
          c.height = Math.round(vp.height);
          var ctx = c.getContext('2d');
          ctx.fillStyle = '#fff';
          ctx.fillRect(0, 0, c.width, c.height);
          return page.render({ canvasContext: ctx, viewport: vp }).promise.then(function () {
            urls.push(c.toDataURL('image/jpeg', 0.85));
            return next(n + 1);
          });
        });
      };
      return next(1);
    });
  }

  function addFiles(files) {
    var list = Array.prototype.slice.call(files || []);
    if (!list.length) return Promise.resolve();
    var chain = Promise.resolve();
    list.forEach(function (f) {
      chain = chain.then(function () {
        msg(f.name + ' を準備しています…', 'info');
        var isPdf = f.type === 'application/pdf' || /\.pdf$/i.test(f.name);
        var job = isPdf ? pdfToJpegs(f) : imageToJpeg(f).then(function (u) { return [u]; });
        return job.then(function (urls) {
          urls.forEach(function (u, i) {
            Q.push({ id: ++seq, name: f.name || '撮影', page: urls.length > 1 || isPdf ? i + 1 : 0, url: u, status: 'pending', error: '', records: null });
          });
          renderQueue();
        });
      }).catch(function (e) { msg(f.name + ': ' + e.message); });
    });
    return chain.then(function () { if (!$('impMsg').classList.contains('msg-keep') && Q.length) msg(''); });
  }

  // ---- 読み取り待ちの一覧 -----------------------------------------------
  function statusText(it) {
    return it.status === 'pending' ? '待機中' : it.status === 'running' ? '読み取り中…' : it.status === 'done' ? '読み取り済み(' + countItems(it) + '項目)' : 'エラー: ' + it.error;
  }
  function countItems(it) {
    return (it.records || []).reduce(function (n, r) { return n + (r.items || []).length; }, 0);
  }

  function renderQueue() {
    var box = $('impList');
    box.innerHTML = Q.map(function (it) {
      return '<div class="qi ' + it.status + '"><img src="' + it.url + '" alt=""><div class="qt"><div class="qn">' + esc(it.name) + (it.page ? ' ' + it.page + 'ページ目' : '') + '</div><div class="qs">' + esc(statusText(it)) + '</div></div>' +
        (it.status === 'running' ? '' : '<button class="x" type="button" data-rm="' + it.id + '" aria-label="削除">×</button>') + '</div>';
    }).join('');
    var todo = Q.some(function (it) { return it.status !== 'done'; });
    $('impRun').hidden = !todo;
    $('impClear').hidden = !Q.length && !REVIEW;
    $('impRun').textContent = Q.some(function (it) { return it.status === 'error'; }) && !Q.some(function (it) { return it.status === 'pending'; }) ? 'エラーのページを再読み取り' : '読み取る(' + Q.filter(function (it) { return it.status !== 'done'; }).length + 'ページ)';
  }

  function runAll() {
    var jobs = Q.filter(function (it) { return it.status !== 'done'; });
    if (!jobs.length) return;
    $('impRun').disabled = true;
    msg('読み取っています。1ページあたり数秒〜十数秒かかります…', 'info');
    var idx = 0;
    var worker = function () {
      if (idx >= jobs.length) return Promise.resolve();
      var it = jobs[idx++];
      it.status = 'running';
      it.error = '';
      renderQueue();
      return BT.post({ action: 'extract', image: { mime: 'image/jpeg', data: it.url.split(',')[1] } }).then(function (d) {
        if (d && d.ok) { it.records = d.records || []; it.status = 'done'; }
        else { it.status = 'error'; it.error = (d && d.error) || '読み取りに失敗しました'; }
      }).catch(function (e) {
        it.status = 'error';
        it.error = e.message || '通信に失敗しました';
      }).then(function () { renderQueue(); return worker(); });
    };
    Promise.all([worker(), worker()]).then(function () {
      $('impRun').disabled = false;
      var errs = Q.filter(function (it) { return it.status === 'error'; }).length;
      if (errs) msg(errs + 'ページ読み取れませんでした。「エラーのページを再読み取り」を押すか、×で外してください。読み取れたページは下で確認できます。');
      else msg('');
      buildReview();
    });
  }

  // ---- 読み取り結果の整理 -----------------------------------------------
  function normVal(v) {
    return String(v == null ? '' : v).trim()
      .replace(/[０-９]/g, function (c) { return String.fromCharCode(c.charCodeAt(0) - 0xFEE0); })
      .replace(/[（]/g, '(').replace(/[）]/g, ')').replace(/[＜〈]/g, '<').replace(/＋/g, '+')
      .replace(/[－−‐‒–—―]/g, '-').replace(/±/g, '+-').replace(/[～〜~]/g, '-').replace(/\s+/g, '').replace(/？/g, '?').replace(/．/g, '.');
  }
  function normTime(t) {
    var m = /^(\d{1,2})[:：](\d{2})/.exec(String(t || '').trim());
    return m ? ('0' + m[1]).slice(-2) + ':' + m[2] : '';
  }
  function normDate(d) {
    var m = /^(\d{4})[-\/.年](\d{1,2})[-\/.月](\d{1,2})/.exec(String(d || '').trim());
    return m ? m[1] + '-' + ('0' + m[2]).slice(-2) + '-' + ('0' + m[3]).slice(-2) : '';
  }

  function buildReview() {
    var map = {}, order = [];
    Q.forEach(function (it) {
      if (it.status !== 'done') return;
      (it.records || []).forEach(function (r) {
        var date = normDate(r.date), time = normTime(r.time);
        var key = date + ' ' + time;
        var rec = map[key];
        if (!rec) { rec = map[key] = { date: date, time: time, files: [], pages: [], imgs: [], items: [], seen: {} }; order.push(key); }
        if (rec.files.indexOf(it.name) < 0) rec.files.push(it.name);
        rec.pages.push(it.page || 1);
        if (rec.imgs.indexOf(it.url) < 0) rec.imgs.push(it.url);
        (r.items || []).forEach(function (x) {
          var name = String(x.name || '').trim(), val = normVal(x.value);
          if (!name) return;
          var prev = rec.seen[name];
          if (prev) { if (prev.value !== val && !prev.alt) prev.alt = val; return; }
          var item = { name: name, value: val, alt: '', inc: true };
          rec.seen[name] = item;
          rec.items.push(item);
        });
      });
    });
    REVIEW = order.map(function (k) { var r = map[k]; delete r.seen; return r; });
    REVIEW.sort(function (a, b) { return a.date < b.date ? -1 : a.date > b.date ? 1 : 0; });
    applyDefaults();
    renderReview();
    renderQueue();
  }

  // 初期のチェック状態: 登録済み・項目マスタにない・読めない値は外す
  function existing(rec, name) { return S.recMap ? S.recMap[rec.date + ' ' + rec.time + '|' + name] : null; }
  function applyDefaults() {
    (REVIEW || []).forEach(function (rec) {
      rec.items.forEach(function (it) {
        it.inc = !!S.minfo[it.name] && it.value !== '' && it.value.indexOf('?') < 0 && !existing(rec, it.name);
      });
    });
  }

  // ---- 検算(読み間違いの目印) ---------------------------------------------
  function numOf(rec, name) {
    for (var i = 0; i < rec.items.length; i++) {
      if (rec.items[i].name === name && /^-?\d+(\.\d+)?$/.test(rec.items[i].value)) return Number(rec.items[i].value);
    }
    return null;
  }
  function checks(rec) {
    var out = [];
    var add = function (label, names, calc, shown, tol) {
      if (calc === null || shown === null) return;
      if (Math.abs(calc - shown) > tol) out.push({ label: label + ' 計算値 ' + calc.toFixed(2) + ' / 読み取り ' + shown, names: names });
    };
    var tp = numOf(rec, '総蛋白'), alb = numOf(rec, 'アルブミン'), ag = numOf(rec, 'A/G');
    if (tp !== null && alb !== null && tp - alb !== 0) add('A/G(アルブミン÷(総蛋白−アルブミン))', ['総蛋白', 'アルブミン', 'A/G'], alb / (tp - alb), ag, 0.03);
    var rbc = numOf(rec, '赤血球数'), hb = numOf(rec, 'ヘモグロビン'), ht = numOf(rec, 'ヘマトクリット');
    if (rbc) {
      add('MCV(Ht÷赤血球×10)', ['赤血球数', 'ヘマトクリット', 'MCV'], ht === null ? null : ht / rbc * 10, numOf(rec, 'MCV'), 1.2);
      add('MCH(Hb÷赤血球×10)', ['赤血球数', 'ヘモグロビン', 'MCH'], hb === null ? null : hb / rbc * 10, numOf(rec, 'MCH'), 0.6);
    }
    if (ht) add('MCHC(Hb÷Ht×100)', ['ヘモグロビン', 'ヘマトクリット', 'MCHC'], hb === null ? null : hb / ht * 100, numOf(rec, 'MCHC'), 0.6);
    var w = numOf(rec, '白血球数');
    if (w) {
      var parts = ['好中球', 'リンパ球', '単球', '好酸球', '好塩基球'], sum = 0, all = true, names = ['白血球数'];
      parts.forEach(function (p) {
        var n = numOf(rec, p + '#'), pc = numOf(rec, p + '%');
        names.push(p + '#');
        if (n === null) all = false; else sum += n;
        if (n !== null && pc !== null && Math.abs(n / w * 100 - pc) > 0.8) out.push({ label: p + '% が、' + p + '#÷白血球数 と合いません(' + (n / w * 100).toFixed(1) + ' / ' + pc + ')', names: [p + '#', p + '%', '白血球数'] });
      });
      if (all) add('白血球分画の合計', names, sum, w, 0.06);
    }
    var utp = numOf(rec, 'U-TPテイリョ'), ucre = numOf(rec, 'U-CRE');
    if (utp !== null && ucre) add('尿中蛋白/Cre比(U-TP÷U-CRE)', ['U-TPテイリョ', 'U-CRE', '尿中蛋白/Cre比'], utp / ucre, numOf(rec, '尿中蛋白/Cre比'), 0.015);
    return out;
  }

  // ---- 確認画面 -----------------------------------------------------------
  function byItemIndex() {
    var idx = {};
    S.rows.forEach(function (r) { (idx[r['項目名']] = idx[r['項目名']] || []).push(r); });
    Object.keys(idx).forEach(function (k) { idx[k].sort(function (a, b) { return (a['検査日'] + a['到着時間']) < (b['検査日'] + b['到着時間']) ? -1 : 1; }); });
    return idx;
  }
  function prevOf(idx, name, date, time) {
    var arr = idx[name] || [], best = null;
    for (var i = 0; i < arr.length; i++) { if ((arr[i]['検査日'] + arr[i]['到着時間']) < (date + time)) best = arr[i]; }
    return best;
  }
  function showVal(r) {
    var v = r['値'], q = r['定性'];
    if (BT.isNum(v)) return v + (q ? '(' + q + ')' : '');
    return q || '';
  }
  // 登録済みの値と、読み取った値が同じか(7 と 7.0 は同じ)
  function sameValue(ex, raw) {
    var p = parseValue(raw);
    if (BT.isNum(ex['値'])) return p.num !== '' && p.num === ex['値'] && p.qual === (ex['定性'] || '');
    return p.num === '' && p.qual === (ex['定性'] || '');
  }
  function parseValue(raw) {
    if (/^-?\d+(\.\d+)?$/.test(raw)) return { num: Number(raw), qual: '' };
    var m = /^(\d+(?:\.\d+)?)\((.*)\)$/.exec(raw);
    if (m) return { num: Number(m[1]), qual: m[2] };
    return { num: '', qual: raw };
  }
  function flagOf(num, mi) {
    if (num === '' || !mi) return '';
    if (mi.lo != null && num < mi.lo) return 'L';
    if (mi.hi != null && num > mi.hi) return 'H';
    return '';
  }

  function renderReview() {
    var box = $('impReview');
    if (!REVIEW) { box.innerHTML = ''; return; }
    if (!REVIEW.length) { box.innerHTML = '<div class="msg">読み取れた検査がありませんでした。写真を撮り直して、もう一度試してください。</div>'; return; }
    var idx = byItemIndex();
    var total = 0, skip = 0, html = '<h2>読み取り結果の確認</h2><div class="note">間違いがないか、値を見比べて、直してから追加してください。オレンジ色の行は「検算が合わない」行、グレーは登録済み・追加できない行です。</div>';
    REVIEW.forEach(function (rec, ri) {
      var ck = checks(rec), warnNames = {};
      ck.forEach(function (c) { c.names.forEach(function (n) { warnNames[n] = 1; }); });
      html += '<div class="rec"><h3>' + (ri + 1) + '件目 <small>' + esc(rec.files.join('、')) + '</small></h3>' +
        '<div class="row"><label>検査日<input type="date" data-ri="' + ri + '" data-f="date" value="' + esc(rec.date) + '"></label><label>到着時間<input type="time" data-ri="' + ri + '" data-f="time" value="' + esc(rec.time) + '"></label></div>';
      html += '<div class="thumbs">' + rec.imgs.map(function (u, k) { return '<img src="' + u + '" alt="元の画像" data-zoom="' + ri + '-' + k + '">'; }).join('') + '<span class="note">画像を押すと拡大します。元の紙と見比べて確認してください。</span></div>';
      if (!rec.date) html += '<div class="warn">検査日が読み取れませんでした。入力してください。</div>';
      if (BT.noteOf(rec.date)) html += '<div class="warn">' + esc(BT.noteOf(rec.date)) + '</div>';
      if (ck.length) html += '<div class="checks"><b>検算が合いません(読み間違いの可能性)</b><ul>' + ck.map(function (c) { return '<li>' + esc(c.label) + '</li>'; }).join('') + '</ul></div>';
      html += '<div class="tablewrap"><table><thead><tr><th class="c">追加</th><th>項目</th><th>値</th><th>前回</th></tr></thead><tbody>';
      rec.items.forEach(function (it, ii) {
        var mi = S.minfo[it.name], ex = existing(rec, it.name), pv = prevOf(idx, it.name, rec.date, rec.time);
        var cls = [], notes = [];
        if (!mi) { cls.push('off'); notes.push('項目マスタにない項目(追加できません)'); }
        if (it.value === '' || it.value.indexOf('?') >= 0) { cls.push('bad'); notes.push('読み取れませんでした。値を入力してください'); }
        if (ex) { cls.push('off'); notes.push('登録済み' + (sameValue(ex, it.value) ? '(同じ値)' : '(スプシの値: ' + showVal(ex) + ')。同じ項目は上書きできません')); }
        if (warnNames[it.name]) { cls.push('warn'); notes.push('検算が合いません'); }
        if (it.alt) { cls.push('warn'); notes.push('別のページに違う値があります: ' + it.alt); }
        var p = parseValue(it.value), fl = mi ? flagOf(p.num, mi) : '';
        var can = !!mi && it.value !== '' && it.value.indexOf('?') < 0 && !ex;
        if (it.inc && can) total++; else skip++;
        html += '<tr class="' + cls.join(' ') + '"><td class="c"><input type="checkbox" data-ri="' + ri + '" data-ii="' + ii + '" data-f="inc"' + (it.inc && can ? ' checked' : '') + (can ? '' : ' disabled') + '></td>' +
          '<td>' + esc(it.name) + '<div class="pd">' + esc(mi ? (mi.unit || '') : '') + '</div></td>' +
          '<td><input class="vin ' + fl + '" type="text" data-ri="' + ri + '" data-ii="' + ii + '" data-f="value" value="' + esc(it.value) + '">' + (fl ? '<span class="fl ' + fl + '">' + fl + '</span>' : '') +
          (notes.length ? '<div class="why">' + esc(notes.join(' / ')) + '</div>' : '') + '</td>' +
          '<td class="pv">' + (pv ? esc(showVal(pv)) + '<div class="pd">' + esc(pv['検査日']) + '</div>' : '') + '</td></tr>';
      });
      html += '</tbody></table></div></div>';
    });
    html += '<div class="imp-actions"><button id="impAdd" class="btn primary" type="button"' + (total ? '' : ' disabled') + '>記録に追加する(' + total + '件)</button></div>';
    box.innerHTML = html;
  }

  function onReviewChange(e) {
    var t = e.target, f = t.getAttribute && t.getAttribute('data-f');
    if (!f) return;
    var ri = Number(t.getAttribute('data-ri')), rec = REVIEW[ri];
    if (f === 'date') { rec.date = t.value; applyDefaults(); }
    else if (f === 'time') { rec.time = t.value; applyDefaults(); }
    else {
      var it = rec.items[Number(t.getAttribute('data-ii'))];
      if (f === 'value') {
        it.value = normVal(t.value);
        var ok = !!S.minfo[it.name] && it.value !== '' && it.value.indexOf('?') < 0 && !existing(rec, it.name);
        it.inc = ok;
        it.alt = '';
      } else if (f === 'inc') it.inc = t.checked;
    }
    renderReview();
  }

  // ---- 記録に追加 ---------------------------------------------------------
  function addToSheet() {
    var rows = [], bad = '';
    REVIEW.forEach(function (rec) {
      var picked = rec.items.filter(function (it) { return it.inc; });
      if (!picked.length) return;
      if (!/^\d{4}-\d{2}-\d{2}$/.test(rec.date)) bad = '検査日が入っていない検査があります。';
      if (!/^\d{2}:\d{2}$/.test(rec.time)) bad = bad || '到着時間が入っていない検査があります。';
      picked.forEach(function (it) {
        var mi = S.minfo[it.name], p = parseValue(it.value);
        rows.push({
          '検査日': rec.date, '到着時間': rec.time, '区分': mi.cat, '項目名': it.name, '値': p.num, '定性': p.qual, '単位': mi.unit || '',
          '基準下限': mi.lo == null ? '' : mi.lo, '基準上限': mi.hi == null ? '' : mi.hi, '判定': flagOf(p.num, mi), '備考': '画像取込',
          '元ファイル': rec.files.join('、'), 'ページ': rec.pages.slice().sort().join('、')
        });
      });
    });
    if (bad) { msg(bad); return; }
    if (!rows.length) { msg('追加する項目がありません。'); return; }
    $('impAdd').disabled = true;
    msg(rows.length + '件を追加しています…', 'info');
    BT.post({ action: 'append', rows: rows }).then(function (d) {
      if (!d || !d.ok) throw new Error((d && d.error) || '追加に失敗しました');
      Q = []; REVIEW = null;
      renderQueue(); renderReview();
      msg(d.added + '件を記録に追加しました' + (d.skipped ? '(登録済みのため ' + d.skipped + '件はスキップ)' : '') + '。サマリー・グラフ・一覧に反映しています。', 'ok');
      BT.load();
    }).catch(function (e) {
      msg('追加できませんでした: ' + e.message);
      $('impAdd').disabled = false;
    });
  }

  // ---- 画面の操作 -----------------------------------------------------------
  $('fCam').addEventListener('change', function () { var f = this.files; addFiles(f).then(function () { $('fCam').value = ''; }); });
  $('fPick').addEventListener('change', function () { var f = this.files; addFiles(f).then(function () { $('fPick').value = ''; }); });
  $('impRun').addEventListener('click', runAll);
  $('impClear').addEventListener('click', function () {
    if ((Q.length || REVIEW) && !window.confirm('読み取り待ちのページと、確認中の内容を消します。よろしいですか?')) return;
    Q = []; REVIEW = null; msg(''); renderQueue(); renderReview();
  });
  $('impList').addEventListener('click', function (e) {
    var id = e.target.getAttribute && e.target.getAttribute('data-rm');
    if (!id) return;
    Q = Q.filter(function (it) { return String(it.id) !== id; });
    renderQueue();
  });
  $('impReview').addEventListener('change', onReviewChange);
  $('impReview').addEventListener('click', function (e) {
    if (e.target.id === 'impAdd') { addToSheet(); return; }
    var z = e.target.getAttribute && e.target.getAttribute('data-zoom');
    if (z) {
      var parts = z.split('-'), url = REVIEW[Number(parts[0])].imgs[Number(parts[1])];
      var ov = document.createElement('div');
      ov.className = 'zoom';
      ov.innerHTML = '<img src="' + url + '" alt="拡大"><button class="x" type="button" aria-label="閉じる">×</button>';
      ov.addEventListener('click', function () { ov.remove(); });
      document.body.appendChild(ov);
    }
  });
  renderQueue();
})();
