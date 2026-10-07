(function () {
  // GAS(Webアプリ)のURL。未設定の間は sample/links.json(動作確認用)を使い、PDF保存・記録は行わない
  var GAS_URL = 'https://script.google.com/macros/s/AKfycbw0NvmN8vjr4g0TNx1TQ8DffC6FWwK6GfBOZb32N0mTp3CrcYXLNOpkxhXo2ce1PwE6/exec';
  // PDFに埋め込むリンクの形式。'web'=Webページ(open.html)経由で jissun:// 起動(Acrobatの「ファイルを起動」警告を回避)
  //                              'file'=マスタのfile://を直接埋め込む(従来形式。Acrobatの警告が2回出る)
  var LINK_MODE = 'file';
  var OPEN_BASE = 'https://shipping-list-link.vercel.app/open.html';
  var $ = function (id) { return document.getElementById(id); };
  var links = null, working = false;
  pdfjsLib.GlobalWorkerOptions.workerSrc = 'vendor/pdf.worker.min.js?v=20261007a';

  function showMaster(m, note) {
    links = m.links;
    $('master').textContent = 'マスタ: ' + Object.keys(m.links).length + '件 / 更新 ' + (m.updated || '') + (note ? ' / ' + note : '');
  }
  // 取得経路: Vercelの中継API(CDNキャッシュ・gzip)を優先。失敗時だけGASを直接呼ぶ(GitHub上の確認用URLには中継APIが無いのでこちらになる)
  async function fetchMaster() {
    try {
      var r = await fetch('api/links');
      if (r.ok) { var m = await r.json(); if (m && m.links) return { m: m, via: '中継API' }; }
    } catch (e) {}
    var r2 = await fetch(GAS_URL ? GAS_URL + '?action=links' : 'sample/links.json', { cache: 'no-store' });
    return { m: await r2.json(), via: GAS_URL ? 'GAS直接' : '動作確認用サンプル' };
  }
  async function loadMaster() {
    try {
      var t0 = Date.now(), got = await fetchMaster();
      showMaster(got.m, got.via + ' ' + ((Date.now() - t0) / 1000).toFixed(1) + '秒');
    } catch (e) { if (!links) $('master').textContent = 'マスタの取得に失敗しました: ' + e; }
  }
  function esc(s) { return String(s).replace(/[&<>]/g, function (c) { return { '&': '&amp;', '<': '&lt;', '>': '&gt;' }[c]; }); }
  function b64(buf) {
    var u = new Uint8Array(buf), s = '', i;
    for (i = 0; i < u.length; i += 0x8000) s += String.fromCharCode.apply(null, u.subarray(i, i + 0x8000));
    return btoa(s);
  }
  // 結果ポップアップ。「OK」でアプリをリセット(開いたときの状態に戻す)
  var modalOpen = false;
  function popup(lines, ok) {
    modalOpen = true;
    $('modalText').innerHTML = lines.map(function (l) { return '<div>' + esc(l) + '</div>'; }).join('');
    $('modalNote').textContent = '';
    $('modal').className = 'show ' + (ok ? 'mok' : 'mng');
    $('modalOk').focus();
  }
  function resetApp() {
    modalOpen = false;
    $('modal').className = '';
    $('msg').textContent = '';
    $('stage').classList.remove('busy');
    inp.value = '';
  }
  $('modalOk').onclick = resetApp;

  async function handle(file) {
    if (!file || modalOpen || working) return;
    if (!links) { $('msg').textContent = 'マスタが未取得です。少し待って再実行してください。'; return; }
    working = true;   // 処理中の追加ドロップは無視(二重処理・二重記録の防止)
    $('msg').textContent = '処理中…'; $('stage').classList.add('busy');
    try {
      var buf = await file.arrayBuffer();
      var r = await ShippingCore.linkPdf(pdfjsLib, PDFLib, buf, links,
        LINK_MODE === 'web' ? { mapUri: function (u) { return ShippingCore.toOpenUrl(OPEN_BASE, u); } } : null);
      var s = r.stats;
      $('msg').textContent = '';
      if (s.linked > 0) {
        var base = file.name.replace(/\.pdf$/i, '');
        var a = document.createElement('a');
        a.href = URL.createObjectURL(new Blob([r.bytes], { type: 'application/pdf' }));
        a.download = base + '_リンク付き.pdf'; a.style.display = 'none'; document.body.appendChild(a); a.click();
        setTimeout(function () { a.remove(); URL.revokeObjectURL(a.href); }, 10000);
        popup(['ダウンロードしました', 'リンク付与できた図番' + s.linked + '件', '付与できなかった図番' + s.ng + '件'], true);
      } else {
        popup(['リンクが付与できず、ダウンロードしていません', 'マスタには無い図番と製品名の可能性あり'], false);
      }
      if (GAS_URL) save(file.name, s, buf);   // 元PDFの保存・記録はバックグラウンドで実施
    } catch (e) {
      $('stage').classList.remove('busy');
      $('msg').textContent = '失敗しました: ' + e;
    } finally { working = false; }
  }
  async function save(name, s, buf) {
    try {
      var r = await fetch(GAS_URL, { method: 'POST', headers: { 'Content-Type': 'text/plain;charset=utf-8' },
        body: JSON.stringify({ name: name, pages: s.pages, linked: s.linked, ng: s.ng, pdf: b64(buf) }) });
      var j = await r.json();
      if (!j.ok) throw new Error(j.error);
    } catch (e) { if (modalOpen) $('modalNote').textContent = '(元PDFの保存・記録に失敗しました)'; }
  }
  var drop = $('drop'), inp = $('file');
  drop.onclick = function () { inp.click(); };
  inp.onchange = function () { handle(inp.files[0]); inp.value = ''; };
  // 画面全体でドロップを受け付ける(PDF以外の場所でも、ブラウザがPDFを開いてしまわないよう常にpreventDefault)
  var depth = 0;
  function dragOn(on) { document.body.classList.toggle('dragging', on); drop.classList.toggle('over', on); }
  document.addEventListener('dragenter', function (e) { e.preventDefault(); depth++; dragOn(true); });
  document.addEventListener('dragover', function (e) { e.preventDefault(); });
  document.addEventListener('dragleave', function (e) { e.preventDefault(); depth = Math.max(0, depth - 1); if (!depth) dragOn(false); });
  document.addEventListener('drop', function (e) {
    e.preventDefault(); depth = 0; dragOn(false);
    var f = e.dataTransfer && e.dataTransfer.files[0];
    if (f) handle(f);
  });
  loadMaster();
})();
