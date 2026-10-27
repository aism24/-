(function () {
  // GAS(Webアプリ)のURL。必須(マスタの取得・元PDFの保存・記録に使う)。未設定ならマスタを取得できない
  var GAS_URL = 'https://script.google.com/macros/s/AKfycbw0NvmN8vjr4g0TNx1TQ8DffC6FWwK6GfBOZb32N0mTp3CrcYXLNOpkxhXo2ce1PwE6/exec';
  // PDFに埋め込むリンクの形式。'web'=Webページ(open.html)経由で jissun:// 起動(Acrobatの「ファイルを起動」警告を回避)
  //                              'file'=マスタのfile://を直接埋め込む(従来形式。Acrobatの警告が2回出る)
  var LINK_MODE = 'file';
  var OPEN_BASE = 'https://shipping-list-link.vercel.app/open.html';
  var $ = function (id) { return document.getElementById(id); };
  var links = null, working = false, cur = null, refreshing = false;
  pdfjsLib.GlobalWorkerOptions.workerSrc = 'vendor/pdf.worker.min.js?v=20261015a';

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
  function sec(t0) { return ((Date.now() - t0) / 1000).toFixed(1) + '秒'; }
  // 取得経路: Vercelの中継API(CDNキャッシュ・gzip)を優先。失敗時だけGASを直接呼ぶ(GitHub上の確認用URLには中継APIが無いのでこちらになる)
  // o.bust=true: 「最新を取得」ボタン用。CDNキャッシュを避ける(失敗時はCDNに残っている古いリンク表も試す)
  // o.ver: 取りに行く版(リンク表の更新日時)。URLに付けるので、CDNには版ごとに保存され、2人目以降は速く取れる
  // 戻り値の raw はGASが返した圧縮形式のまま(このPCに保存する用)
  async function fetchMaster(o) {
    o = o || {};
    var q = o.ver ? 'v=' + encodeURIComponent(o.ver) : o.bust ? 't=' + Date.now() : '';
    // 中継APIは10秒で打ち切る(o.wait で変更可)。GASが遅いときは待ち続けず、CDNに残っている古いリンク表(最大1日前)を使う
    var urls = q ? ['api/links?' + q] : ['api/links'];
    if (o.bust) urls.push('api/links');
    for (var u = 0; u < urls.length; u++) {
      try {
        var r = await fetch(urls[u], { signal: AbortSignal.timeout(o.wait || 10000) });
        if (r.ok) { var m = await r.json(); if (m && m.links) return { raw: m, m: ShippingCore.expandMaster(m), via: u ? '中継API(古いデータ)' : '中継API' }; }
      } catch (e) {}
    }
    if (!GAS_URL) throw new Error('GAS_URL が未設定です');
    var r2 = await fetch(GAS_URL + '?action=links' + (q ? '&' + q : ''), { cache: 'no-store' }), raw = await r2.json();
    return { raw: raw, m: ShippingCore.expandMaster(raw), via: 'GAS直接' };
  }
  // このPCのブラウザに保存したリンク表(IndexedDB)。開いたときはこれをすぐ使い、裏でGASの更新日時と比べて新しければ取り直す
  // 使えない環境(シークレットウィンドウ等)では null を返し、従来どおり毎回取得する
  function localDb(mode, fn) {
    return new Promise(function (ok, ng) {
      var rq = indexedDB.open('shipping-list-link', 1);
      rq.onupgradeneeded = function () { rq.result.createObjectStore('kv'); };
      rq.onerror = function () { ng(rq.error); };
      rq.onsuccess = function () {
        var db = rq.result, tx = db.transaction('kv', mode), req = fn(tx.objectStore('kv'));
        tx.oncomplete = function () { db.close(); ok(req.result); };
        tx.onerror = tx.onabort = function () { db.close(); ng(tx.error); };
      };
      setTimeout(function () { ng(new Error('timeout')); }, 3000);
    });
  }
  async function localGet() {
    try { var raw = await localDb('readonly', function (st) { return st.get('master'); }); return raw && raw.links && raw.updated ? raw : null; }
    catch (e) { return null; }
  }
  function localPut(raw) {
    try { localDb('readwrite', function (st) { return st.put(raw, 'master'); }).catch(function () {}); } catch (e) {}
  }
  // 「マスタ更新分確認中」ポップアップ。取得中は流れるバー、終了時はバーを100%にしてから閉じる
  var busyTimer = null;
  // text=表示文(省略時は「マスタ更新分確認中」)、ratio(0〜1)を渡すと流れるバーの代わりに進捗バーにする
  function busy(on, text, ratio) {
    var m = $('busyModal'), bar = $('busyBar');
    clearTimeout(busyTimer);
    if (on) {
      $('busyText').textContent = text || 'マスタ更新分確認中';
      bar.classList.remove('full'); bar.classList.toggle('det', typeof ratio === 'number');
      if (typeof ratio === 'number') bar.style.setProperty('--p', Math.round(ratio * 100) + '%');
      m.classList.add('show'); return;
    }
    bar.classList.remove('det'); bar.classList.add('full');
    busyTimer = setTimeout(function () { m.classList.remove('show'); bar.classList.remove('full'); }, 500);
  }
  // 開いたとき: このPCに保存したリンク表があれば、それを表示してすぐポップアップを閉じ、最新かどうかは裏で確認する
  async function loadMaster() {
    busy(true);
    var t0 = Date.now(), raw = await localGet();
    if (raw) {
      var s0 = sec(t0);
      showMaster(ShippingCore.expandMaster(raw), 'このPCの保存分 ' + s0 + '・最新か確認中');
      busy(false);
      if (GAS_URL) checkLatest(s0);
      return;
    }
    try {
      var got = await fetchMaster();
      showMaster(got.m, got.via + ' ' + sec(t0));
      localPut(got.raw);
    } catch (e) { if (!links) $('master').textContent = 'マスタの取得に失敗しました: ' + e; }
    finally { busy(false); }
  }
  // 裏で最新か確認: GASの軽い状態確認(action=info)の更新日時が、表示中のリンク表と違えば取り直して差し替え・保存する
  async function checkLatest(s0) {
    var mine = cur, base = 'このPCの保存分 ' + s0;
    try {
      var j = await (await fetch(GAS_URL + '?action=info', { cache: 'no-store', signal: AbortSignal.timeout(30000) })).json();
      if (!j.updated || j.updated === mine.updated) { if (cur === mine) showMaster(mine, base + '・最新を確認済み'); return; }
      var t0 = Date.now(), got = await fetchMaster({ ver: j.updated, wait: 20000 });
      if (cur !== mine) return;   // 確認中に「最新を取得」ボタンで差し替わっていたら、そちらを優先
      showMaster(got.m, got.via + ' ' + sec(t0) + '・新しいマスタに更新');
      localPut(got.raw);
    } catch (e) { if (cur === mine) showMaster(mine, base + '・最新か確認できませんでした'); }
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
    busy(true);
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
      if (j.unchanged && prev && j.updated === prev.updated) {   // Excelに変更が無く、画面のマスタも最新: 再生成も読み直しも不要
        msg.className = 'small ok'; msg.textContent = '最新です。';
        return;
      }
      var got = await fetchMaster({ bust: true, ver: j.updated }), m = got.m, oldN = prev ? Object.keys(prev.links).length : 0, newN = Object.keys(m.links).length;
      var was = prev ? fmt(prev.updated) : '-';
      var sameData = prev && oldN === newN && excelMod(prev) === excelMod(m);
      showMaster(m, got.via);
      localPut(got.raw);   // 次に開いたときは、このPCに保存したこのリンク表をすぐ使う
      msg.className = 'small ok';
      if (j.unchanged) msg.textContent = '最新です。';
      else if (j.throttled) msg.textContent = '1分以内に更新済みです(更新 ' + fmt(m.updated) + ')。';
      else if (sameData) msg.textContent = '最新です。';
      else msg.textContent = '最新を取得しました(更新 ' + was + ' → ' + fmt(m.updated) + '、件数 ' + oldN.toLocaleString() + ' → ' + newN.toLocaleString() + ')。';
    } catch (e) {
      msg.className = 'small warn'; msg.textContent = '取得できませんでした: ' + e;
    } finally { busy(false); btn.disabled = false; refreshing = false; }
  }
  function esc(s) { return String(s).replace(/[&<>]/g, function (c) { return { '&': '&amp;', '<': '&lt;', '>': '&gt;' }[c]; }); }
  function b64(buf) {
    var u = new Uint8Array(buf), s = '', i;
    for (i = 0; i < u.length; i += 0x8000) s += String.fromCharCode.apply(null, u.subarray(i, i + 0x8000));
    return btoa(s);
  }
  // 結果ポップアップ。「OK」でアプリをリセット(開いたときの状態に戻す)
  var modalOpen = false;
  function ngTable(partial, place) {
    return '<table><tr><th>' + (place || '頁') + '</th><th>図番</th><th>製品名</th><th>理由</th></tr>' + partial.map(function (p) {
      return '<tr><td>' + esc(p.page) + '</td><td>' + esc(p.zuban) + '</td><td>' + esc(p.name || '-') + '</td><td>' +
        esc(p.reason === '重複' ? 'マスタに複数リンクあり(重複)' : p.reason) + '</td></tr>';
    }).join('') + '</table>';
  }
  function popup(lines, ok, partial, place) {
    modalOpen = true;
    $('modalText').innerHTML = lines.map(function (l) { return '<div>' + esc(l) + '</div>'; }).join('');
    var has = partial && partial.length;
    $('ngToggle').style.display = has ? '' : 'none';
    $('ngToggle').textContent = 'NG一覧を見る(' + (has ? partial.length : 0) + '件)';
    $('ngList').innerHTML = has ? ngTable(partial, place) : '';
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

  // 図面の読み取り(GASがGeminiを呼ぶ)。画像1枚ずつ送る。通信・応答の失敗は {ok:false, error} で返す
  async function askGas(kind, image) {
    try {
      var r = await fetch(GAS_URL, { method: 'POST', headers: { 'Content-Type': 'text/plain;charset=utf-8' }, body: JSON.stringify({ action: 'ocr', kind: kind, image: image }) });
      return await r.json();
    } catch (e) { return { ok: false, error: '通信に失敗しました: ' + e }; }
  }
  function mapOpt() { return LINK_MODE === 'web' ? { mapUri: function (u) { return ShippingCore.toOpenUrl(OPEN_BASE, u); } } : null; }
  async function handle(file) {
    if (!file || modalOpen || working) return;
    if (/\.xls$/i.test(file.name)) { $('msg').textContent = '古い形式(.xls)は未対応です。Excelで「.xlsx」として保存し直してください。'; return; }
    if (!links) { $('msg').textContent = 'マスタが未取得です。少し待って再実行してください。'; return; }
    working = true;   // 処理中の追加ドロップは無視(二重処理・二重記録の防止)
    $('msg').textContent = ''; $('stage').classList.add('busy');
    busy(true, 'ファイルを処理中…');   // ダウンロードが終わるまで、画面を操作できないポップアップを出す
    try {
      var buf = await file.arrayBuffer(), isXlsx = /\.xls[xm]$/i.test(file.name);
      var r = isXlsx ? await ShippingXlsx.linkXlsx(JSZip, buf, links, mapOpt()) : await ShippingCore.linkPdf(pdfjsLib, PDFLib, buf, links, mapOpt());
      // 詳細図(図番・製品名が線で描かれたCAD図面。寸法などの文字データだけ入っていることもある): 文字から図番らしい語が1つも見つからないときだけ、画像として読み取る
      if (!isXlsx && GAS_URL && r.stats.linked === 0 && r.stats.ng === 0) {
        var po = mapOpt() || {}, pt = '図面を画像として読み取り中…';
        busy(true, pt, 0);
        po.onProgress = function (done, total) { busy(true, pt + '\n' + done + '/' + total + 'ページ', done / (total + 1)); };
        r = await ShippingDrawing.linkDrawing(pdfjsLib, PDFLib, buf, links, askGas, po);
      }
      var s = r.stats;
      $('msg').textContent = '';
      if (s.linked > 0) {
        var base = file.name.replace(/\.(pdf|xls[xm])$/i, '');
        var a = document.createElement('a');
        a.href = URL.createObjectURL(new Blob([r.bytes], { type: isXlsx ? 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' : 'application/pdf' }));
        a.download = base + '_リンク付き.' + (isXlsx ? (/\.xlsm$/i.test(file.name) ? 'xlsm' : 'xlsx') : 'pdf'); a.style.display = 'none'; document.body.appendChild(a); a.click();
        setTimeout(function () { a.remove(); URL.revokeObjectURL(a.href); }, 10000);
        popup(['ダウンロードしました', 'リンク付与できた図番' + s.linked + '件', '付与できなかった図番' + s.ng + '件'], true, s.partial, isXlsx ? 'シート!行' : '');
      } else {
        popup(['リンクが付与できず、ダウンロードしていません', 'マスタには無い図番と製品名の可能性あり'], false, s.partial, isXlsx ? 'シート!行' : '');
      }
      if (GAS_URL) save(file.name, s, buf, isXlsx);   // 元ファイルの保存(PDFは記録も)はバックグラウンドで実施
    } catch (e) {
      $('stage').classList.remove('busy');
      $('msg').textContent = '失敗しました: ' + e;
    } finally { working = false; busy(false); }
  }
  async function save(name, s, buf, isXlsx) {
    try {
      var r = await fetch(GAS_URL, { method: 'POST', headers: { 'Content-Type': 'text/plain;charset=utf-8' },
        body: JSON.stringify(isXlsx ? { name: name, xlsx: b64(buf) } : { name: name, pages: s.pages, linked: s.linked, ng: s.ng, pdf: b64(buf) }) });
      var j = await r.json();
      if (!j.ok) throw new Error(j.error);
    } catch (e) { /* 保存・記録の失敗は画面に出さない(利用者の作業には影響しない) */ }
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
