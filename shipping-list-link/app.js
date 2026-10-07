(function () {
  // GAS(Webアプリ)のURL。未設定の間は sample/links.json(動作確認用)を使い、PDF保存・記録は行わない
  var GAS_URL = 'https://script.google.com/macros/s/AKfycbw0NvmN8vjr4g0TNx1TQ8DffC6FWwK6GfBOZb32N0mTp3CrcYXLNOpkxhXo2ce1PwE6/exec';
  // PDFに埋め込むリンクの形式。'web'=Webページ(open.html)経由で jissun:// 起動(Acrobatの「ファイルを起動」警告を回避)
  //                              'file'=マスタのfile://を直接埋め込む(従来形式。Acrobatの警告が2回出る)
  var LINK_MODE = 'file';
  var OPEN_BASE = 'https://shipping-list-link.vercel.app/open.html';
  var $ = function (id) { return document.getElementById(id); };
  var links = null, working = false, cur = null, refreshing = false;
  pdfjsLib.GlobalWorkerOptions.workerSrc = 'vendor/pdf.worker.min.js?v=20261007b';

  // 日時は日本時間の「10/7 06:55」形式で表示する
  var jst = new Intl.DateTimeFormat('ja-JP', { timeZone: 'Asia/Tokyo', month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit', hour12: false });
  function fmt(iso) { var d = new Date(iso); return iso && !isNaN(d) ? jst.format(d) : '-'; }
  function excelMod(m) { return (m.sources || []).reduce(function (a, s) { return s.modified > a ? s.modified : a; }, ''); }
  function showMaster(m, note) {
    var changed = cur && cur.updated !== m.updated;
    links = m.links; cur = m;
    $('master').innerHTML = 'マスタ: ' + Object.keys(m.links).length + '件 / 更新 <b id="mUpd"' + (changed ? ' class="flash"' : '') + '>' + esc(fmt(m.updated)) + '</b>' +
      ' / Excel最終更新 ' + esc(fmt(excelMod(m))) + (note ? ' / ' + esc(note) : '');
  }
  // 取得経路: Vercelの中継API(CDNキャッシュ・gzip)を優先。失敗時だけGASを直接呼ぶ(GitHub上の確認用URLには中継APIが無いのでこちらになる)
  // bust=true: 「最新を取得」ボタン用。URLに時刻を付けてCDNキャッシュを避ける
  async function fetchMaster(bust) {
    var q = bust ? 't=' + Date.now() : '';
    try {
      var r = await fetch('api/links' + (q ? '?' + q : ''));
      if (r.ok) { var m = await r.json(); if (m && m.links) return { m: m, via: '中継API' }; }
    } catch (e) {}
    var r2 = await fetch(GAS_URL ? GAS_URL + '?action=links' + (q ? '&' + q : '') : 'sample/links.json', { cache: 'no-store' });
    return { m: await r2.json(), via: GAS_URL ? 'GAS直接' : '動作確認用サンプル' };
  }
  async function loadMaster() {
    try {
      var t0 = Date.now(), got = await fetchMaster();
      showMaster(got.m, got.via + ' ' + ((Date.now() - t0) / 1000).toFixed(1) + '秒');
    } catch (e) { if (!links) $('master').textContent = 'マスタの取得に失敗しました: ' + e; }
  }
  function sleep(ms) { return new Promise(function (r) { setTimeout(r, ms); }); }
  // 「最新のリンク付きマスタを取得」: GASにマスタExcel→リンク表JSONの再生成を依頼し、画面のマスタを読み直す。
  // GAS直接の応答は不安定(失敗・数十秒)なので、応答が取れなかったときは軽い状態確認(action=info)で更新を待つ
  async function waitRebuilt(prevUpdated, startedAt) {
    for (var i = 0; i < 30; i++) {
      await sleep(4000);
      try {
        var r = await fetch(GAS_URL + '?action=info', { cache: 'no-store' }), j = await r.json();
        if (j.rejected && j.rejected.at >= startedAt) return { ok: false, rejected: j.rejected };
        if (j.updated && j.updated !== prevUpdated) return { ok: true };
      } catch (e) {}
    }
    return null;
  }
  async function refreshMaster() {
    if (refreshing || working) return;
    refreshing = true;
    var btn = $('refresh'), msg = $('refreshMsg'), prev = cur, startedAt = new Date().toISOString();
    btn.disabled = true; msg.className = 'small'; msg.textContent = '最新のマスタを取得中…(数十秒かかることがあります)';
    try {
      var j = null;
      try { j = await (await fetch(GAS_URL + '?action=rebuild', { cache: 'no-store' })).json(); } catch (e) { j = null; }
      if (j && j.links) { msg.className = 'small warn'; msg.textContent = 'GAS側が未更新のため、再生成できません(管理者へ連絡してください)。'; return; }   // 旧GASは action=rebuild を知らず、リンク表そのものを返す
      if (!j || (j.ok === undefined)) j = await waitRebuilt(prev && prev.updated, startedAt);
      if (!j) { msg.className = 'small warn'; msg.textContent = '取得できませんでした。少し待ってからもう一度押してください。'; return; }
      if (j.rejected) {
        msg.className = 'small warn';
        msg.textContent = '件数が大きく減るため更新を中止しました(旧' + j.rejected.oldCount.toLocaleString() + '件 → 新' + j.rejected.newCount.toLocaleString() + '件)。マスタExcelを確認してください。いまのマスタはそのままです。';
        return;
      }
      if (j.ok === false) { msg.className = 'small warn'; msg.textContent = '取得できませんでした: ' + (j.error || '不明なエラー'); return; }
      if (j.busy) { msg.className = 'small warn'; msg.textContent = '他の更新が実行中です。少し待ってからもう一度押してください。'; return; }
      var got = await fetchMaster(true), m = got.m, oldN = prev ? Object.keys(prev.links).length : 0, newN = Object.keys(m.links).length;
      var was = prev ? fmt(prev.updated) : '-', changedAt = prev && prev.updated !== m.updated;
      var sameData = prev && oldN === newN && excelMod(prev) === excelMod(m);
      showMaster(m, got.via);
      msg.className = 'small ok';
      if (j.throttled) msg.textContent = '1分以内に更新済みです(更新 ' + fmt(m.updated) + ')。';
      else if (sameData) msg.textContent = '変更はありませんでした(最新です。更新 ' + was + ' → ' + fmt(m.updated) + ')。';
      else msg.textContent = '最新を取得しました(更新 ' + was + ' → ' + fmt(m.updated) + '、件数 ' + oldN.toLocaleString() + ' → ' + newN.toLocaleString() + ')。';
    } catch (e) {
      msg.className = 'small warn'; msg.textContent = '取得できませんでした: ' + e;
    } finally { btn.disabled = false; refreshing = false; }
  }
  function esc(s) { return String(s).replace(/[&<>]/g, function (c) { return { '&': '&amp;', '<': '&lt;', '>': '&gt;' }[c]; }); }
  function b64(buf) {
    var u = new Uint8Array(buf), s = '', i;
    for (i = 0; i < u.length; i += 0x8000) s += String.fromCharCode.apply(null, u.subarray(i, i + 0x8000));
    return btoa(s);
  }
  // 結果ポップアップ。「OK」でアプリをリセット(開いたときの状態に戻す)
  var modalOpen = false;
  function ngTable(partial) {
    return '<table><tr><th>頁</th><th>図番</th><th>製品名</th><th>理由</th></tr>' + partial.map(function (p) {
      return '<tr><td>' + esc(p.page) + '</td><td>' + esc(p.zuban) + '</td><td>' + esc(p.name || '-') + '</td><td>' +
        esc(p.reason === '重複' ? 'マスタに複数リンクあり(重複)' : p.reason) + '</td></tr>';
    }).join('') + '</table>';
  }
  function popup(lines, ok, partial) {
    modalOpen = true;
    $('modalText').innerHTML = lines.map(function (l) { return '<div>' + esc(l) + '</div>'; }).join('');
    $('modalNote').textContent = '';
    var has = partial && partial.length;
    $('ngToggle').style.display = has ? '' : 'none';
    $('ngToggle').textContent = 'NG一覧を見る(' + (has ? partial.length : 0) + '件)';
    $('ngList').innerHTML = has ? ngTable(partial) : '';
    $('ngList').style.display = 'none'; $('mbox').classList.remove('wide');
    $('modal').className = 'show ' + (ok ? 'mok' : 'mng');
    $('modalOk').focus();
  }
  function resetApp() {
    modalOpen = false;
    $('modal').className = '';
    $('msg').textContent = '';
    $('stage').classList.remove('busy');
    inp.value = '';
    $('ngList').style.display = 'none'; $('mbox').classList.remove('wide');
  }
  $('modalOk').onclick = resetApp;
  $('ngToggle').onclick = function () {
    var open = $('ngList').style.display === 'none';
    $('ngList').style.display = open ? '' : 'none';
    $('mbox').classList.toggle('wide', open);
    this.textContent = (open ? 'NG一覧を閉じる' : 'NG一覧を見る') + this.textContent.replace(/^NG一覧を(見る|閉じる)/, '');
  };
  if (GAS_URL) $('refresh').onclick = refreshMaster; else $('refresh').style.display = 'none';

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
        popup(['ダウンロードしました', 'リンク付与できた図番' + s.linked + '件', '付与できなかった図番' + s.ng + '件'], true, s.partial);
      } else {
        popup(['リンクが付与できず、ダウンロードしていません', 'マスタには無い図番と製品名の可能性あり'], false, s.partial);
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
