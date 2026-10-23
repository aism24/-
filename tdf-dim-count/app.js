(function () {
  // 利用記録用GAS(WebアプリのURL。/execで終わる)。空のときは記録しない。gas/Code.gs を参照
  var GAS_URL = 'https://script.google.com/macros/s/AKfycbwPEdgh02ck9j_ykjBZ2EGsmYvmi6aHuVVExgkC_-Q04vxVwOGj-KR6g1fmGhdUNWo/exec';
  var openBtn = document.getElementById('open'), file = document.getElementById('file');
  var out = document.getElementById('out'), info = document.getElementById('info');
  var layerEl = document.getElementById('layer'), xlsxBtn = document.getElementById('xlsx');
  var cur = null, last = null, width = 0, mode = 1;
  var modeEl = document.getElementById('modebtns'), segWrap = document.getElementById('seg');
  var segEl = document.getElementById('segbtns'), ttlEl = document.getElementById('ttl');
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
  }
  Array.prototype.forEach.call(modeEl.children, function (b) { b.onclick = function () { setMode(parseInt(b.dataset.m, 10)); render(); }; });

  openBtn.onclick = function () { file.click(); };
  var depth = 0;
  window.addEventListener('dragenter', function (e) { e.preventDefault(); depth++; document.body.classList.add('dragging'); });
  window.addEventListener('dragover', function (e) { e.preventDefault(); });
  window.addEventListener('dragleave', function () { if (--depth <= 0) { depth = 0; document.body.classList.remove('dragging'); } });
  window.addEventListener('drop', function (e) { e.preventDefault(); depth = 0; document.body.classList.remove('dragging'); load(e.dataTransfer.files[0]); });
  file.onchange = function () { load(file.files[0]); };
  layerEl.onchange = render;
  xlsxBtn.onclick = download;
  document.getElementById('reset').onclick = function () {
    cur = null; last = null; width = 0; setMode(1);
    file.value = '';
    info.textContent = '';
    layerEl.innerHTML = '<option value="">（先にTDFを選んでください）</option>';
    layerEl.disabled = true;
    Array.prototype.forEach.call(segEl.children, function (b) { b.classList.remove('on'); });
    reset('レイヤを選ぶと表示されます');
  };

  // 手配長さ: 代表の長さを1の位で四捨五入して10単位にする(876→880, 2551→2550)
  function tehai(v) { return Math.round(v / 10) * 10; }
  function esc(s) { return String(s).replace(/[&<>]/g, function (c) { return { '&': '&amp;', '<': '&lt;', '>': '&gt;' }[c]; }); }
  var card2 = document.getElementById('card2');
  function reset(msg) { card2.classList.remove('alert'); ttlEl.textContent = ''; last = null; xlsxBtn.disabled = true; out.className = 'small'; out.innerHTML = msg; }

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
        var gen = cur.choices.filter(function (c) { return c.name === 'GEN'; })[0];
        if (gen) { layerEl.value = gen.no; render(); }
      } catch (e) { reset('<span class="warn">読み込みに失敗しました: ' + esc(e.message || e) + '</span>'); }
    };
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
      s.rows.forEach(function (r) { h += '<tr><td class="c">' + esc(r.text) + '</td><td class="c' + (r.count ? '' : ' warn') + '">' + r.count + '</td></tr>'; });
      h += '<tr><th>合計(' + s.textCount + '種類・線は重複なし)</th><th style="text-align:center">' + s.total + '</th></tr></table>';
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
    out.className = ''; out.innerHTML = h; setS3();
    xlsxBtn.disabled = !s.rows.length;
    card2.classList.toggle('alert', !s.rows.length);
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
    out.className = ''; out.innerHTML = h; setS3();
    xlsxBtn.disabled = !b.rows.length;
    card2.classList.toggle('alert', !b.rows.length);
  }

  // Excelダウンロード時に、ファイル名・レイヤ名・総本数だけを記録(失敗しても作業は止めない)
  function logDownload(fileName, layer, total) {
    if (!GAS_URL) return;
    try {
      fetch(GAS_URL, { method: 'POST', headers: { 'Content-Type': 'text/plain;charset=utf-8' }, keepalive: true,
        body: JSON.stringify({ action: 'logDownload', fileName: fileName, layer: layer, total: total }) }).catch(function () {});
    } catch (e) { /* 記録の失敗は無視 */ }
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
    var buf = XLSX.write(wb, { type: 'array', bookType: 'xlsx' });
    var blob = new Blob([buf], { type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' });
    var a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = last.name.replace(/\.tdf$/i, '') + '_' + last.layer + '_寸法本数.xlsx';
    document.body.appendChild(a); a.click(); document.body.removeChild(a);
    logDownload(last.name, last.layer, last.s.total);
  }

  function saveBook(wb, fileName) {
    var buf = XLSX.write(wb, { type: 'array', bookType: 'xlsx' });
    var blob = new Blob([buf], { type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' });
    var a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = fileName;
    document.body.appendChild(a); a.click(); document.body.removeChild(a);
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
