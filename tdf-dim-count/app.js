(function () {
  var results = [];
  var drop = document.getElementById('drop'), file = document.getElementById('file');
  var out = document.getElementById('out'), layerEl = document.getElementById('layer');
  var parsedList = [];

  drop.onclick = function () { file.click(); };
  drop.ondragover = function (e) { e.preventDefault(); drop.classList.add('over'); };
  drop.ondragleave = function () { drop.classList.remove('over'); };
  drop.ondrop = function (e) { e.preventDefault(); drop.classList.remove('over'); load(e.dataTransfer.files); };
  file.onchange = function () { load(file.files); };
  layerEl.oninput = render;

  function load(files) {
    var arr = Array.prototype.slice.call(files).filter(function (f) { return /\.tdf$/i.test(f.name); });
    parsedList = [];
    var n = arr.length, done = 0;
    if (!n) { render(); return; }
    arr.forEach(function (f, i) {
      var r = new FileReader();
      r.onload = function () {
        try { parsedList[i] = { name: f.name, parsed: TdfDim.parse(r.result) }; }
        catch (e) { parsedList[i] = { name: f.name, error: String(e) }; }
        if (++done === n) render();
      };
      r.readAsArrayBuffer(f);
    });
  }

  function esc(s) { return String(s).replace(/[&<>]/g, function (c) { return { '&': '&amp;', '<': '&lt;', '>': '&gt;' }[c]; }); }

  function render() {
    var name = layerEl.value.trim() || 'TB';
    results = [];
    var html = '';
    parsedList.forEach(function (p) {
      if (!p) return;
      if (p.error) { html += '<div class="card warn">' + esc(p.name) + ': 読み込みに失敗しました</div>'; return; }
      var s = TdfDim.summarize(p.parsed, name);
      results.push({ name: p.name, s: s });
      html += '<div class="card"><b>' + esc(p.name) + '</b>';
      if (!s.found) html += '<div class="warn">レイヤ「' + esc(name) + '」が見つかりません</div>';
      else if (!s.total) html += '<div class="warn">レイヤ「' + esc(name) + '」の寸法線はありません</div>';
      else {
        html += '<table><tr><th>寸法(長さ)</th><th>本数</th></tr>';
        s.rows.forEach(function (r) { html += '<tr><td>' + r.length + '</td><td>' + r.count + '</td></tr>'; });
        html += '<tr><th>合計</th><th>' + s.total + '</th></tr></table>';
      }
      html += '</div>';
    });
    if (results.length) html += '<button id="csv">CSVダウンロード</button>';
    out.innerHTML = html;
    var b = document.getElementById('csv');
    if (b) b.onclick = csv;
  }

  function csv() {
    var lines = ['ファイル,レイヤ,寸法(長さ),本数'];
    results.forEach(function (r) {
      r.s.rows.forEach(function (x) { lines.push('"' + r.name.replace(/"/g, '""') + '",' + r.s.layerName + ',' + x.length + ',' + x.count); });
    });
    var blob = new Blob(['﻿' + lines.join('\r\n')], { type: 'text/csv' });
    var a = document.createElement('a');
    a.href = URL.createObjectURL(blob); a.download = '寸法線抽出.csv'; a.click();
  }
})();
