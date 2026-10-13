(function () {
  var openBtn = document.getElementById('open'), file = document.getElementById('file');
  var out = document.getElementById('out'), info = document.getElementById('info');
  var layerEl = document.getElementById('layer'), xlsxBtn = document.getElementById('xlsx');
  var cur = null, last = null, width = 0;
  var segEl = document.getElementById('segbtns');
  [0, 10, 20, 30].forEach(function (n) {
    var b = document.createElement('button'); b.textContent = n === 0 ? 'まとめない' : '±' + n; b.dataset.n = n;
    b.onclick = function () { width = n; render(); }; segEl.appendChild(b);
  });

  openBtn.onclick = function () { file.click(); };
  var depth = 0;
  window.addEventListener('dragenter', function (e) { e.preventDefault(); depth++; document.body.classList.add('dragging'); });
  window.addEventListener('dragover', function (e) { e.preventDefault(); });
  window.addEventListener('dragleave', function () { if (--depth <= 0) { depth = 0; document.body.classList.remove('dragging'); } });
  window.addEventListener('drop', function (e) { e.preventDefault(); depth = 0; document.body.classList.remove('dragging'); load(e.dataTransfer.files[0]); });
  file.onchange = function () { load(file.files[0]); };
  layerEl.onchange = render;
  xlsxBtn.onclick = download;

  function esc(s) { return String(s).replace(/[&<>]/g, function (c) { return { '&': '&amp;', '<': '&lt;', '>': '&gt;' }[c]; }); }
  function reset(msg) { last = null; xlsxBtn.disabled = true; out.className = 'small'; out.innerHTML = msg; }

  function load(f) {
    if (!f) return;
    reset('読み込み中…'); layerEl.disabled = true;
    var r = new FileReader();
    r.onload = function () {
      try {
        var p = TdfDim.parse(r.result);
        cur = { name: f.name, parsed: p, choices: TdfDim.layerChoices(p) };
        info.textContent = f.name + '　レイヤ数 ' + p.layers.length + ' / テキスト ' + p.texts.length + ' / 線 ' + p.lines.length;
        if (!cur.choices.length) { layerEl.innerHTML = '<option value="">（斜めの数値テキストを持つレイヤがありません）</option>'; reset('該当レイヤなし'); return; }
        layerEl.innerHTML = '<option value="">（レイヤを選んでください）</option>' + cur.choices.map(function (c) {
          return '<option value="' + c.no + '">' + esc(c.name) + '</option>';
        }).join('');
        layerEl.disabled = false;
        reset('レイヤを選ぶと表示されます');
      } catch (e) { reset('<span class="warn">読み込みに失敗しました: ' + esc(e.message || e) + '</span>'); }
    };
    r.readAsArrayBuffer(f);
  }

  function render() {
    if (!cur || !layerEl.value) { reset('レイヤを選ぶと表示されます'); return; }
    var no = parseInt(layerEl.value, 10);
    var ch = cur.choices.filter(function (c) { return c.no === no; })[0];
    var s = TdfDim.summarize(cur.parsed, no);
    var g = width ? TdfDim.groupLengths(cur.parsed, no, width) : null;
    last = { name: cur.name, layer: ch.name, s: s, g: g, width: width };
    Array.prototype.forEach.call(segEl.children, function (b) { b.classList.toggle('on', parseInt(b.dataset.n, 10) === width); });
    var h = '<b>' + esc(cur.name) + ' ／ レイヤ ' + esc(ch.name) + (width ? ' ／ 長さ ±' + width + 'mm でまとめ' : '') + '</b>';
    if (!g) {
      h += '<table><tr><th>テキスト(寸法)</th><th>線の本数</th></tr>';
      s.rows.forEach(function (r) { h += '<tr><td>' + esc(r.text) + '</td><td' + (r.count ? '' : ' class="warn"') + '>' + r.count + '</td></tr>'; });
      h += '<tr><th>合計(テキスト' + s.textCount + '個・線は重複なし)</th><th>' + s.total + '</th></tr></table>';
    } else {
      h += '<table><tr><th>代表の長さ</th><th>範囲</th><th>本数</th><th>元のテキスト</th></tr>';
      g.groups.forEach(function (x) { h += '<tr><td>' + x.rep.toFixed(1) + '</td><td>' + x.min.toFixed(1) + '〜' + x.max.toFixed(1) + '</td><td>' + x.count + '</td><td style="text-align:left">' + esc(x.texts.join('、')) + '</td></tr>'; });
      h += '<tr><th>合計(' + g.groups.length + 'グループ・線は重複なし)</th><th></th><th>' + g.total + '</th><th></th></tr></table>';
    }
    out.className = ''; out.innerHTML = h;
    xlsxBtn.disabled = false;
  }

  function download() {
    if (!last) return;
    if (typeof XLSX === 'undefined') { alert('Excel出力用ライブラリを読み込めませんでした。ネットワークを確認してください。'); return; }
    var rows = [['ファイル', 'レイヤ', 'テキスト(寸法)', '線の本数']];
    last.s.rows.forEach(function (r) { rows.push([last.name, last.layer, parseFloat(r.text), r.count]); });
    rows.push(['', '', '合計(線は重複なし)', last.s.total]);
    var ws = XLSX.utils.aoa_to_sheet(rows);
    ws['!cols'] = [{ wch: 36 }, { wch: 14 }, { wch: 18 }, { wch: 12 }];
    var wb = XLSX.utils.book_new();
    if (last.g) {
      var gr = [['ファイル', 'レイヤ', 'まとめ幅(±mm)', '代表の長さ', '範囲(最小)', '範囲(最大)', '本数', '元のテキスト']];
      last.g.groups.forEach(function (x) { gr.push([last.name, last.layer, last.width, x.rep, Math.round(x.min * 100) / 100, Math.round(x.max * 100) / 100, x.count, x.texts.join('、')]); });
      gr.push(['', '', '', '合計(線は重複なし)', '', '', last.g.total, '']);
      var wg = XLSX.utils.aoa_to_sheet(gr);
      wg['!cols'] = [{ wch: 36 }, { wch: 14 }, { wch: 14 }, { wch: 12 }, { wch: 12 }, { wch: 12 }, { wch: 8 }, { wch: 40 }];
      XLSX.utils.book_append_sheet(wb, wg, '長さまとめ(±' + last.width + ')');
    }
    XLSX.utils.book_append_sheet(wb, ws, 'テキスト別');
    var buf = XLSX.write(wb, { type: 'array', bookType: 'xlsx' });
    var blob = new Blob([buf], { type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' });
    var a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = last.name.replace(/\.tdf$/i, '') + '_' + last.layer + '_斜め寸法本数.xlsx';
    document.body.appendChild(a); a.click(); document.body.removeChild(a);
  }
})();
