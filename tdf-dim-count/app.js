(function () {
  // 利用記録用GAS(WebアプリのURL。/execで終わる)。空のときは記録しない。gas/Code.gs を参照
  var GAS_URL = 'https://script.google.com/macros/s/AKfycbwPEdgh02ck9j_ykjBZ2EGsmYvmi6aHuVVExgkC_-Q04vxVwOGj-KR6g1fmGhdUNWo/exec';
  var openBtn = document.getElementById('open'), file = document.getElementById('file');
  var out = document.getElementById('out'), info = document.getElementById('info');
  var layerEl = document.getElementById('layer'), xlsxBtn = document.getElementById('xlsx');
  var cur = null, last = null, width = 0, mode = 1;
  var modeEl = document.getElementById('modebtns'), segWrap = document.getElementById('seg');
  var segEl = document.getElementById('segbtns'), ttlEl = document.getElementById('ttl');
  var condEl = document.querySelector('#cond .condtxt');
  function setHH() { document.documentElement.style.setProperty('--hh', document.querySelector('header').offsetHeight + 'px'); }
  function setS3() { document.documentElement.style.setProperty('--s3h', document.getElementById('sticky3').offsetHeight + 'px'); }
  setHH(); setS3(); window.addEventListener('resize', function () { setHH(); setS3(); });
  [0, 10, 20, 30].forEach(function (n) {
    var b = document.createElement('button'); b.textContent = n === 0 ? 'まとめない' : '±' + n; b.dataset.n = n;
    b.onclick = function () { width = n; render(); }; segEl.appendChild(b);
  });

  // モード: 1=拾い出し(寸法ごとの本数)、2=ブロック分け製品名で仕訳け
  function setMode(m) {
    mode = m;
    Array.prototype.forEach.call(modeEl.children, function (b) { b.classList.toggle('on', parseInt(b.dataset.m, 10) === mode); });
    segWrap.style.display = mode === 2 ? 'none' : '';
    condEl.textContent = mode === 2 ? 'リスト化条件＝レイヤの完全一致' : '集計抽出条件＝レイヤの完全一致、数値と寸法線の完全一致';
  }
  Array.prototype.forEach.call(modeEl.children, function (b) { b.onclick = function () { setMode(parseInt(b.dataset.m, 10)); render(); }; });
  // 起動画面: 集計方法を選ぶまでは手順①〜③を出さない。選んだら通常の画面へ
  var startEl = document.getElementById('start'), workEl = document.getElementById('work');
  function started() { return workEl.hidden === false; }
  function showStart(on) { startEl.hidden = on === false; workEl.hidden = on !== false; if (on === false) setS3(); }
  Array.prototype.forEach.call(document.getElementById('startbtns').children, function (b) {
    b.onclick = function () { setMode(parseInt(b.dataset.m, 10)); showStart(false); };
  });

  openBtn.onclick = function () { file.click(); };
  var depth = 0;
  window.addEventListener('dragenter', function (e) { e.preventDefault(); if (!started()) return; depth++; document.body.classList.add('dragging'); });
  window.addEventListener('dragover', function (e) { e.preventDefault(); });
  window.addEventListener('dragleave', function () { if (--depth <= 0) { depth = 0; document.body.classList.remove('dragging'); } });
  window.addEventListener('drop', function (e) { e.preventDefault(); depth = 0; document.body.classList.remove('dragging'); if (!started()) return; var f = e.dataTransfer.files[0]; if (f && !/\.tdf$/i.test(f.name)) { alert('TDFファイル(.tdf)を選んでください: ' + f.name); return; } load(f); });
  file.onchange = function () { load(file.files[0]); };
  layerEl.onchange = render;
  xlsxBtn.onclick = download;
  document.getElementById('reset').onclick = function () {
    cur = null; width = 0; setMode(1);
    file.value = '';
    info.textContent = '';
    layerEl.innerHTML = '<option value="">（先にTDFを選んでください）</option>';
    layerEl.disabled = true;
    Array.prototype.forEach.call(segEl.children, function (b) { b.classList.remove('on'); });
    reset('レイヤを選ぶと表示されます');
    showStart(true);
  };

  // 手配長さ: 代表の長さを1の位で四捨五入して10単位にする(876→880, 2551→2550)
  function tehai(v) { return Math.round(v / 10) * 10; }
  function esc(s) { return String(s).replace(/[&<>]/g, function (c) { return { '&': '&amp;', '<': '&lt;', '>': '&gt;' }[c]; }); }
  var card2 = document.getElementById('card2');
  function reset(msg) { card2.classList.remove('alert'); ttlEl.textContent = ''; last = null; xlsxBtn.disabled = true; out.className = 'small'; out.innerHTML = msg; }

  function fail(msg) { reset('<span class="warn">読み込みに失敗しました: ' + esc(msg) + '</span>'); }

  function load(f) {
    if (!f) return;
    reset('読み込み中…'); layerEl.disabled = true;
    var r = new FileReader();
    r.onload = function () {
      try {
        var p = TdfDim.parse(r.result);
        cur = { name: f.name, parsed: p, choices: TdfDim.allLayers(p) };
        info.textContent = f.name + '　レイヤ数 ' + p.layers.length + ' / テキスト ' + p.texts.length + ' / 線 ' + p.lines.length;
        if (!cur.choices.length) { layerEl.innerHTML = '<option value="">（レイヤが見つかりません）</option>'; reset('レイヤなし'); return; }
        layerEl.innerHTML = '<option value="">（レイヤを選んでください）</option>' + cur.choices.map(function (c) {
          return '<option value="' + c.no + '">' + esc(c.name) + '</option>';
        }).join('');
        layerEl.disabled = false;
        reset('レイヤを選ぶと表示されます');
        var gen = cur.choices.filter(function (c) { return c.name === TdfDim.DEFAULT_LAYER; })[0];
        if (gen) { layerEl.value = gen.no; render(); }
      } catch (e) { fail(e.message || e); }
    };
    r.onerror = function () { fail(r.error ? r.error.message : 'ファイルを読めませんでした'); };
    r.readAsArrayBuffer(f);
  }

  function render() {
    if (!cur || !layerEl.value) { reset('レイヤを選ぶと表示されます'); return; }
    var no = parseInt(layerEl.value, 10);
    var ch = cur.choices.filter(function (c) { return c.no === no; })[0];
    if (mode === 2) { renderBlocks(no, ch); return; }
    var s = TdfDim.summarize(cur.parsed, no);
    var g = width ? TdfDim.groupLengths(cur.parsed, no, width) : null;
    last = { mode: 1, name: cur.name, layer: ch.name, s: s, g: g, width: width };
    Array.prototype.forEach.call(segEl.children, function (b) { b.classList.toggle('on', parseInt(b.dataset.n, 10) === width); });
    ttlEl.textContent = cur.name + ' ／ レイヤ ' + ch.name + (width ? ' ／ 長さ ±' + width + 'mm でまとめ' : '');
    var h = '';
    if (!s.rows.length) {
      // 数値テキストはあるが全部不一致のときは、下の「集計対象外」の表に出る
      h += '<div class="small c">' + (s.ng.length ? '一致する寸法がありません(数値テキストはすべて、テキストの数と線の本数が不一致です)' : 'このレイヤには、数値テキストがありません') + '</div>';
    } else if (!g) {
      h += '<table><tr><th>テキスト(寸法)</th><th>線の本数</th></tr>';
      s.rows.forEach(function (r) { h += '<tr><td class="c">' + esc(r.text) + '</td><td class="c">' + r.count + '</td></tr>'; });
      h += '<tr><th>合計(' + s.types + '種類・線は重複なし)</th><th style="text-align:center">' + s.total + '</th></tr></table>';
    } else {
      h += '<table><tr><th>手配長さ</th><th>範囲</th><th>本数</th><th>元のテキスト</th></tr>';
      g.groups.forEach(function (x) { h += '<tr><td class="c">' + tehai(x.rep) + '</td><td class="c">' + x.min.toFixed(1) + '〜' + x.max.toFixed(1) + '</td><td>' + x.count + '</td><td style="text-align:left">' + esc(x.texts.join('、')) + '</td></tr>'; });
      h += '<tr><th>合計(' + g.groups.length + 'グループ・線は重複なし)</th><th></th><th>' + g.total + '</th><th></th></tr></table>';
    }
    if (s.ng.length) {
      h += '<div class="ng"><div class="small c">集計対象外（テキストの数と線の本数が不一致）</div><table><tr><th>テキスト(寸法)</th><th>テキストの数</th><th>線の本数</th></tr>';
      s.ng.forEach(function (r) { h += '<tr><td class="c">' + esc(r.text) + '</td><td class="c">' + r.textCount + '</td><td class="c">' + r.lineCount + '</td></tr>'; });
      h += '</table></div>';
    }
    showOut(h, s.rows.length > 0);
  }

  // 集計テーブルを出す。has=出力できる行があるか(なければExcelボタンを無効にし、②のカードを点滅させる)
  function showOut(h, has) {
    out.className = ''; out.innerHTML = h; setS3();
    xlsxBtn.disabled = !has;
    card2.classList.toggle('alert', !has);
  }

  // rows はブロック順(core.js の blockNames)。i がブロックの最後の行なら、そのブロックの種類数・本数を返す
  function blockSub(rows, i) {
    if (i + 1 < rows.length && rows[i + 1].block === rows[i].block) return null;
    var n = 0, count = 0;
    for (var k = i; k >= 0 && rows[k].block === rows[i].block; k--) { n++; count += rows[k].count; }
    return { n: n, count: count };
  }

  // ②ブロック分け製品名で仕訳け(組にならない寸法と「_」の無い製品名は出さない。core.js の blockNames)
  function renderBlocks(no, ch) {
    var b = TdfDim.blockNames(cur.parsed, no);
    last = { mode: 2, name: cur.name, layer: ch.name, b: b };
    ttlEl.textContent = cur.name + ' ／ レイヤ ' + ch.name + ' ／ ブロック分け製品名で仕訳け';
    var h = '';
    if (!b.rows.length) {
      h += '<div class="small c">このレイヤには、寸法と組になる「_」入りの製品名テキストがありません</div>';
    } else {
      h += '<table><tr><th>ブロック</th><th>製品名</th><th>本数</th><th>長さ</th><th>ブロック入り製品名</th></tr>';
      b.rows.forEach(function (r, i) {
        h += '<tr><td class="c">' + esc(r.block) + '</td><td>' + esc(r.product) + '</td><td class="c">' + r.count + '</td><td class="c">' + esc(r.lengths.join(',')) + '</td><td style="text-align:left">' + esc(r.name) + '</td></tr>';
        var sub = blockSub(b.rows, i);
        if (sub) h += '<tr class="bsub"><td colspan="2">' + esc(r.block) + ' 小計(' + sub.n + '種類)</td><td class="c">' + sub.count + '</td><td></td><td></td></tr>';
      });
      h += '<tr><th colspan="2">合計(' + b.rows.length + '種類)</th><th style="text-align:center">' + b.total + '</th><th></th><th></th></tr></table>';
    }
    showOut(h, b.rows.length > 0);
  }

  // 更新履歴: スプレッドシートのシート「更新履歴」A:C(更新履歴|内容|状況)をGASから読んでポップアップに出す
  var histEl = document.getElementById('hist'), histBody = document.getElementById('histbody');
  function fmtDay(v) { var m = /^(\d{4})(\d{2})(\d{2})$/.exec(v); return m ? m[1] + '/' + m[2] + '/' + m[3] : v; }
  function showHist(rows) {
    if (!rows.length) { histBody.textContent = '更新履歴はまだありません'; return; }
    var h = '<table><tr><th>更新日</th><th>内容</th><th>状況</th></tr>';
    rows.forEach(function (r) { h += '<tr><td class="d">' + esc(fmtDay(r[0])) + '</td><td>' + esc(r[1]) + '</td><td>' + esc(r[2]) + '</td></tr>'; });
    histBody.innerHTML = h + '</table>';
  }
  document.getElementById('histBtn').onclick = function () {
    histEl.classList.add('on'); histBody.textContent = '読み込み中…';
    if (!GAS_URL) { histBody.textContent = '更新履歴を読み込めませんでした'; return; }
    fetch(GAS_URL + '?action=history').then(function (r) { return r.json(); }).then(function (j) {
      if (j.status !== 'success' || !Array.isArray(j.data)) throw new Error(j.message || '');
      showHist(j.data);
    }).catch(function () { histBody.textContent = '更新履歴を読み込めませんでした'; });
  };
  function closeHist() { histEl.classList.remove('on'); }
  document.getElementById('histclose').onclick = closeHist;
  histEl.onclick = function (e) { if (e.target === histEl) closeHist(); };
  document.addEventListener('keydown', function (e) { if (e.key === 'Escape') closeHist(); });

  // 利用記録(画面には何も出さない。失敗しても作業は止めない)。起動ごとの目印 SESSION で、起動の行とダウンロードを結び付ける
  function logPost(data) {
    if (!GAS_URL) return;
    try {
      fetch(GAS_URL, { method: 'POST', headers: { 'Content-Type': 'text/plain;charset=utf-8' }, keepalive: true,
        body: JSON.stringify(data) }).catch(function () {});
    } catch (e) { /* 記録の失敗は無視 */ }
  }
  var SESSION = Date.now().toString(36) + Math.random().toString(36).slice(2, 10);
  logPost({ action: 'logOpen', sessionId: SESSION });
  // Excelダウンロード時に、ファイル名・レイヤ名・総本数だけを記録
  function logDownload(fileName, layer, total) {
    logPost({ action: 'logDownload', sessionId: SESSION, fileName: fileName, layer: layer, total: total });
  }

  function download() {
    if (!last) return;
    if (typeof XLSX === 'undefined') { alert('Excel出力用ライブラリを読み込めませんでした。ネットワークを確認してください。'); return; }
    if (last.mode === 2) { downloadBlocks(); return; }
    var rows = [['ファイル', 'レイヤ', 'テキスト(寸法)', '線の本数']];
    last.s.rows.forEach(function (r) { rows.push([last.name, last.layer, parseFloat(r.text), r.count]); });
    rows.push(['', '', '合計(線は重複なし)', last.s.total]);
    var ws = XLSX.utils.aoa_to_sheet(rows);
    ws['!cols'] = [{ wch: 36 }, { wch: 14 }, { wch: 18 }, { wch: 12 }];
    var wb = XLSX.utils.book_new();
    if (last.g) {
      var gr = [['ファイル', 'レイヤ', 'まとめ幅(±mm)', '手配長さ', '範囲(最小)', '範囲(最大)', '本数', '元のテキスト']];
      last.g.groups.forEach(function (x) { gr.push([last.name, last.layer, last.width, tehai(x.rep), Math.round(x.min * 100) / 100, Math.round(x.max * 100) / 100, x.count, x.texts.join('、')]); });
      gr.push(['', '', '', '合計(線は重複なし)', '', '', last.g.total, '']);
      var wg = XLSX.utils.aoa_to_sheet(gr);
      wg['!cols'] = [{ wch: 36 }, { wch: 14 }, { wch: 14 }, { wch: 12 }, { wch: 12 }, { wch: 12 }, { wch: 8 }, { wch: 40 }];
      XLSX.utils.book_append_sheet(wb, wg, '長さまとめ(±' + last.width + ')');
    }
    XLSX.utils.book_append_sheet(wb, ws, 'テキスト別');
    if (last.s.ng.length) {
      var nr = [['ファイル', 'レイヤ', 'テキスト(寸法)', 'テキストの数', '線の本数']];
      last.s.ng.forEach(function (r) { nr.push([last.name, last.layer, parseFloat(r.text), r.textCount, r.lineCount]); });
      var wn = XLSX.utils.aoa_to_sheet(nr);
      wn['!cols'] = [{ wch: 36 }, { wch: 14 }, { wch: 18 }, { wch: 14 }, { wch: 12 }];
      XLSX.utils.book_append_sheet(wb, wn, '不一致(対象外)');
    }
    saveBook(wb, last.name.replace(/\.tdf$/i, '') + '_' + last.layer + '_寸法本数.xlsx');
    logDownload(last.name, last.layer, last.s.total);
  }

  function saveBook(wb, fileName) {
    var buf = XLSX.write(wb, { type: 'array', bookType: 'xlsx' });
    var blob = new Blob([buf], { type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' });
    var a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = fileName;
    document.body.appendChild(a); a.click(); document.body.removeChild(a);
    // 保存が始まってから一時URLを解放する(すぐ解放すると保存に失敗するブラウザがある)
    setTimeout(function () { URL.revokeObjectURL(a.href); }, 10000);
  }

  function downloadBlocks() {
    var rows = [['ブロック', '製品名', '本数', '長さ', 'ブロック入り製品名']];
    last.b.rows.forEach(function (r, i) {
      rows.push([r.block, r.product, r.count, r.lengths.length === 1 ? parseFloat(r.lengths[0]) : r.lengths.join(','), r.name]);
      var sub = blockSub(last.b.rows, i);
      if (sub) rows.push([r.block + ' 小計(' + sub.n + '種類)', '', sub.count, '', '']);
    });
    rows.push(['合計(' + last.b.rows.length + '種類)', '', last.b.total, '', '']);
    var ws = XLSX.utils.aoa_to_sheet(rows);
    ws['!cols'] = [{ wch: 18 }, { wch: 22 }, { wch: 8 }, { wch: 20 }, { wch: 28 }];
    var wb = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(wb, ws, 'ブロック分け');
    saveBook(wb, last.name.replace(/\.tdf$/i, '') + '_' + last.layer + '_ブロック分け.xlsx');
    logDownload(last.name, last.layer, last.b.total);
  }
})();
