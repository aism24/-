(function () {
  var drop = document.getElementById('drop'), file = document.getElementById('file');
  var out = document.getElementById('out'), opts = document.getElementById('opts');
  var layerEl = document.getElementById('layer'), info = document.getElementById('info');
  var cur = null, last = null;

  drop.onclick = function () { file.click(); };
  drop.ondragover = function (e) { e.preventDefault(); drop.classList.add('over'); };
  drop.ondragleave = function () { drop.classList.remove('over'); };
  drop.ondrop = function (e) { e.preventDefault(); drop.classList.remove('over'); load(e.dataTransfer.files[0]); };
  file.onchange = function () { load(file.files[0]); };
  layerEl.onchange = render;

  function esc(s) { return String(s).replace(/[&<>]/g, function (c) { return { '&': '&amp;', '<': '&lt;', '>': '&gt;' }[c]; }); }

  function load(f) {
    if (!f) return;
    out.innerHTML = '<div class="card">読み込み中…</div>';
    var r = new FileReader();
    r.onload = function () {
      try {
        var p = TdfDim.parse(r.result);
        cur = { name: f.name, parsed: p, choices: TdfDim.layerChoices(p) };
        layerEl.innerHTML = cur.choices.map(function (c) {
          return '<option value="' + c.no + '">' + esc(c.name) + '（斜め寸法 ' + c.count + '個）</option>';
        }).join('');
        var gen = cur.choices.filter(function (c) { return c.name === TdfDim.DEFAULT_LAYER; })[0];
        if (gen) layerEl.value = gen.no;
        opts.hidden = false;
        info.textContent = f.name + '　レイヤ数 ' + p.layers.length + ' / テキスト ' + p.texts.length + ' / 線 ' + p.lines.length;
        render();
      } catch (e) { out.innerHTML = '<div class="card warn">読み込みに失敗しました: ' + esc(e.message || e) + '</div>'; }
    };
    r.readAsArrayBuffer(f);
  }

  function render() {
    if (!cur) return;
    if (!cur.choices.length) { out.innerHTML = '<div class="card warn">斜めの数値テキストを持つレイヤがありません</div>'; return; }
    var no = parseInt(layerEl.value, 10);
    var ch = cur.choices.filter(function (c) { return c.no === no; })[0];
    var s = TdfDim.summarize(cur.parsed, no);
    last = { name: cur.name, layer: ch.name, s: s };
    var h = '<div class="card"><b>' + esc(cur.name) + ' ／ レイヤ ' + esc(ch.name) + '</b>';
    h += '<table><tr><th>テキスト(寸法)</th><th>線の本数</th></tr>';
    s.rows.forEach(function (r) {
      h += '<tr><td>' + esc(r.text) + '</td><td' + (r.count ? '' : ' class="warn"') + '>' + r.count + '</td></tr>';
    });
    h += '<tr><th>合計(' + s.textCount + '個)</th><th>' + s.total + '</th></tr></table></div>';
    h += '<button id="csv">CSVダウンロード</button>';
    out.innerHTML = h;
    document.getElementById('csv').onclick = csv;
  }

  function csv() {
    var lines = ['ファイル,レイヤ,テキスト,線の本数'];
    last.s.rows.forEach(function (r) {
      lines.push('"' + last.name.replace(/"/g, '""') + '","' + last.layer.replace(/"/g, '""') + '",' + r.text + ',' + r.angle.toFixed(1) + ',' + r.count);
    });
    var blob = new Blob(['﻿' + lines.join('\r\n')], { type: 'text/csv' });
    var a = document.createElement('a');
    a.href = URL.createObjectURL(blob); a.download = '斜め寸法本数.csv'; a.click();
  }
})();
