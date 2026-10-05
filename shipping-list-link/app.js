(function () {
  // GAS(Webアプリ)のURL。未設定の間は sample/links.json(動作確認用)を使い、PDF保存・記録は行わない
  var GAS_URL = '';
  var $ = function (id) { return document.getElementById(id); };
  var links = null, CK = 'ship-links-v1';
  pdfjsLib.GlobalWorkerOptions.workerSrc = 'vendor/pdf.worker.min.js?v=20261005a';

  function showMaster(m, note) {
    links = m.links;
    $('master').textContent = 'マスタ: ' + Object.keys(m.links).length + '件 / 更新 ' + (m.updated || '') + (note ? ' / ' + note : '');
  }
  async function loadMaster() {
    try { var c = JSON.parse(localStorage.getItem(CK) || 'null'); if (c && GAS_URL) showMaster(c, 'キャッシュ'); } catch (e) {}
    try {
      var r = await fetch(GAS_URL ? GAS_URL + '?action=links' : 'sample/links.json', { cache: 'no-store' });
      var m = await r.json();
      showMaster(m, GAS_URL ? '最新' : '動作確認用サンプル');
      if (GAS_URL) try { localStorage.setItem(CK, JSON.stringify(m)); } catch (e) {}
    } catch (e) { if (!links) $('master').textContent = 'マスタの取得に失敗しました: ' + e; }
  }
  function esc(s) { return String(s).replace(/[&<>]/g, function (c) { return { '&': '&amp;', '<': '&lt;', '>': '&gt;' }[c]; }); }
  function b64(buf) {
    var u = new Uint8Array(buf), s = '', i;
    for (i = 0; i < u.length; i += 0x8000) s += String.fromCharCode.apply(null, u.subarray(i, i + 0x8000));
    return btoa(s);
  }
  async function handle(file) {
    if (!file) return;
    if (!links) { $('msg').textContent = 'マスタが未取得です。少し待って再実行してください。'; return; }
    $('msg').textContent = '処理中…'; $('result').innerHTML = '';
    try {
      var buf = await file.arrayBuffer();
      var r = await ShippingCore.linkPdf(pdfjsLib, PDFLib, buf, links);
      var base = file.name.replace(/\.pdf$/i, '');
      var a = document.createElement('a');
      a.href = URL.createObjectURL(new Blob([r.bytes], { type: 'application/pdf' }));
      a.download = base + '_リンク付き.pdf'; a.style.display = 'none'; document.body.appendChild(a); a.click();
      setTimeout(function () { a.remove(); URL.revokeObjectURL(a.href); }, 10000);
      var s = r.stats, h = '<div class="card"><div class="row">' +
        '<div class="stat"><span>リンク付与</span><strong class="ok">' + s.linked + '</strong></div>' +
        '<div class="stat"><span>ページ数</span><strong>' + s.pages + '</strong></div>' +
        '<div class="stat"><span>要確認</span><strong class="' + (s.partial.length ? 'warn' : '') + '">' + s.partial.length + '</strong></div></div>';
      if (s.partial.length) h += '<table><tr><th>頁</th><th>図番</th><th>製品名</th><th>理由</th></tr>' + s.partial.map(function (p) {
        return '<tr><td>' + p.page + '</td><td>' + esc(p.zuban) + '</td><td>' + esc(p.name) + '</td><td>' + p.reason + '</td></tr>'; }).join('') + '</table>';
      $('result').innerHTML = h + '</div>';
      $('msg').textContent = 'ダウンロードしました。';
      if (GAS_URL) await save(file.name, s.pages, buf); else $('msg').textContent += '(GAS未設定のため保存・記録はスキップ)';
    } catch (e) { $('msg').textContent = '失敗しました: ' + e; }
  }
  async function save(name, pages, buf) {
    try {
      var r = await fetch(GAS_URL, { method: 'POST', headers: { 'Content-Type': 'text/plain;charset=utf-8' },
        body: JSON.stringify({ name: name, pages: pages, pdf: b64(buf) }) });
      var j = await r.json();
      $('msg').textContent += j.ok ? ' 元PDFを保存・記録しました。' : ' 保存に失敗: ' + j.error;
    } catch (e) { $('msg').textContent += ' 保存に失敗: ' + e; }
  }
  var drop = $('drop'), inp = $('file');
  drop.onclick = function () { inp.click(); };
  inp.onchange = function () { handle(inp.files[0]); inp.value = ''; };
  ['dragover', 'dragenter'].forEach(function (t) { drop.addEventListener(t, function (e) { e.preventDefault(); drop.classList.add('over'); }); });
  ['dragleave', 'drop'].forEach(function (t) { drop.addEventListener(t, function (e) { e.preventDefault(); drop.classList.remove('over'); }); });
  drop.addEventListener('drop', function (e) { handle(e.dataTransfer.files[0]); });
  loadMaster();
})();
