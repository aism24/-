/* 車番連絡 取込 - 画面。表示はすべてテーブル。照合ロジックは logic.js(TruckLogic)。 */
(function () {
  'use strict';
  var L = window.TruckLogic;

  // デプロイ済みGAS WebアプリのURL(/exec で終わるURL)。デプロイ後にここへ設定する。
  var GAS_API_URL = 'https://script.google.com/macros/s/AKfycbyfyFEJn4alzJGmbWIhKwKeRvJ2OlkgyM4wZFk7ldUVCs5Yx-khi5FOWLen6cvvIYQ/exec';
  function gasUrl() { return window.__GAS_URL__ || GAS_API_URL; }

  // 利用記録(GAS「記録」シート。A=アプリ起動日時 / B=ダウンロード日時 / C=ファイル名)。利用者に分からないよう、画面には何も出さず、結果は待たず、失敗しても無視する
  var launchAt = ''; // GASが返した起動日時。ダウンロードの記録を同じ起動と結びつける目印
  function logStart() {
    try {
      fetch(gasUrl() + '?action=logStart', { credentials: 'omit' })
        .then(function (r) { return r.json(); })
        .then(function (res) { if (res && res.status === 'success' && res.data) launchAt = res.data.at || ''; })
        .catch(function () {});
    } catch (e) { /* 記録の失敗は無視 */ }
  }
  function logDownload(fileName) {
    try {
      fetch(gasUrl() + '?action=logDownload&file=' + encodeURIComponent(fileName) + '&start=' + encodeURIComponent(launchAt), { credentials: 'omit', keepalive: true }).catch(function () {});
    } catch (e) { /* 記録の失敗は無視 */ }
  }
  // Excelのダウンロード(記録つき)。ダウンロードの4か所はすべてここを通す
  function downloadXlsx(fileName, sheetName, heads, rows, struck) {
    TruckXlsx.download(fileName, sheetName, heads, rows, struck);
    logDownload(fileName);
  }

  var IMPORT_HEADERS = ['タイムスタンプ', 'ファイル名', '工事番号', '現場名', '手配業者', '積日', '卸日', '行先', '着時間', '運送業者', '車種', '車番', '氏名', '携帯番号', '追加変更', '備考'];
  var PAIR_COLS = ['手配業者', '運送業者', '車種', '車番', '氏名', '携帯番号', '備考']; // 車両・運転手情報(シート「車両運転手情報」)。1行=車と運転手の1組
  var IMPORTS_LIMIT = 3000; // 絞り込みのために読み込む件数(表に出すのは最新100件まで)
  var IMPORTS_SHOW = 100;
  var VIEW_HEADERS = IMPORT_HEADERS.filter(function (k) { return k !== 'タイムスタンプ'; }); // 画面・Excelに出す列
  var TABLE_HEADERS = VIEW_HEADERS.filter(function (k) { return k !== '工事番号'; }); // 取込一覧の表に出す列(工事番号は出さず、現場名=工事名を出す。Excelには両方入る)
  var LEFT_COLS = ['ファイル名', '現場名', '備考']; // 取込一覧の表で左揃えにする列(備考は、見出しだけ中央揃え)。他の列は中央揃え(列の幅は、どれも中身に合わせて詰める。2026-10-23、ユーザー指示)
  var OTHER = 'その他'; // 工事に該当しないもの。工事番号・現場名の両方に「その他」と記録する
  var MAX_BYTES = 10 * 1024 * 1024;

  var S = { initSeq: 0, reloadP: null, senders: [], vehicles: [], drivers: [], pairs: [], projects: [], importKeyList: [], destMap: {}, cards: [], importsFile: null, tab: 'import',
    imports: null, importsFy: null, importsCm: null, importsSite: 'all', editing: null };
  var seq = 0;

  // ---------- 小物 ----------
  function h(tag, attrs) {
    var e = document.createElement(tag);
    if (attrs) Object.keys(attrs).forEach(function (k) {
      var v = attrs[k];
      if (v == null || v === false) return;
      if (k === 'class') e.className = v;
      else if (k === 'text') e.textContent = v;
      else if (k === 'value') e.value = v;
      else if (k.indexOf('on') === 0) e.addEventListener(k.slice(2), v);
      else e.setAttribute(k, v === true ? '' : v);
    });
    for (var i = 2; i < arguments.length; i++) add(e, arguments[i]);
    return e;
  }
  function add(parent, c) {
    if (c == null || c === false) return;
    if (Array.isArray(c)) c.forEach(function (x) { add(parent, x); });
    else parent.appendChild(typeof c === 'string' ? document.createTextNode(c) : c);
  }
  function $(id) { return document.getElementById(id); }
  function showBanner(msg) { var b = $('banner'); b.textContent = msg || ''; b.hidden = !msg; }

  // ---------- GAS通信 ----------
  async function apiGet(action, params) {
    var url = new URL(gasUrl());
    url.searchParams.set('action', action);
    Object.keys(params || {}).forEach(function (k) { url.searchParams.set(k, params[k]); });
    var res = await fetch(url.toString(), { method: 'GET' });
    if (!res.ok) throw new Error('サーバーエラー(HTTP ' + res.status + ')');
    var json = await res.json();
    if (json.status !== 'success') throw new Error(json.message || '取得に失敗しました');
    return json.data;
  }
  // text/plain でCORSプリフライトを避ける(GASはOPTIONS未対応)
  async function apiPost(action, payload, timeoutMs) {
    var ctl = new AbortController();
    var timer = setTimeout(function () { ctl.abort(); }, timeoutMs || 60000);
    try {
      var res = await fetch(gasUrl(), { method: 'POST', headers: { 'Content-Type': 'text/plain;charset=utf-8' }, body: JSON.stringify(Object.assign({ action: action }, payload)), signal: ctl.signal });
      if (!res.ok) throw new Error('サーバーエラー(HTTP ' + res.status + ')');
      var json = await res.json();
      if (json.status !== 'success') throw new Error(json.message || '処理に失敗しました');
      return json.data;
    } catch (e) {
      if (e.name === 'AbortError') throw new Error('時間がかかりすぎたため中断しました。もう一度お試しください。');
      throw e;
    } finally { clearTimeout(timer); }
  }

  /** 取込一覧(新しい順)を読み込む。同じ読み込みを、取込一覧タブ・再取込の判定・先読みで使い回す。force=true で必ず読み直す。 */
  function loadImports(force) {
    if (force || !S.importsP) {
      var p = apiGet('listImports', { limit: IMPORTS_LIMIT }).then(function (d) { if (S.importsP === p) S.imports = d; return d; });
      p.catch(function () { if (S.importsP === p) S.importsP = null; });
      S.importsP = p;
    }
    return S.importsP;
  }

  async function loadInit(keepImports) {
    var seq = ++S.initSeq;
    var d = await apiGet('init');
    if (seq !== S.initSeq) return; // もっと新しい読み込みが始まっている(古い応答で、新しい内容を戻さない)
    S.pairs = d.pairs || []; // 車両運転手情報の全行(画面の表)
    S.vehicles = d.vehicles || []; S.drivers = d.drivers || []; // 照合用(車番ごと・運転手ごとに1件)
    S.projects = d.projects || []; S.senders = d.senders || [];
    S.importKeyList = (d.importKeys || []).map(function (r) { return L.importKey({ 積日: r.積日, 車番: r.車番 }); });
    S.destMap = L.buildDestMap(d.pastDest || []);
    if (!keepImports) { S.imports = null; S.importsP = null; }
    renderTabs();
  }

  /** 保存・記録のあと、最新のデータ(照合用の一覧など)を、画面を止めずに裏で読み直す。読み直しの間に新しいFAXの照合が始まらないよう、S.reloadP で待てる */
  function reloadInit() {
    var p = loadInit().then(function () {
      refreshReadyCards();
      if (S.tab === 'pairs' && S.editing === null) renderPairs(); // 編集中の行は、入力が消えないよう、描き直さない
    }).catch(function (e) { showBanner('最新のデータを読み込めませんでした(保存は済んでいます): ' + e.message); });
    S.reloadP = p;
    p.then(function () { if (S.reloadP === p) S.reloadP = null; });
    return p;
  }

  // ---------- タブ ----------
  function renderTabs() {
    var labels = { import: 'PDF取込', imports: '取込一覧', pairs: '車両・運転手情報' };
    // アプリ名の右に、押されているボタン名を出す(【】ごと濃い緑・太字・80%の大きさ)
    $('appname').innerHTML = '車番連絡　管理＿<span class="mode">【' + labels[S.tab] + 'モード】</span>';
    document.querySelectorAll('#tabs button').forEach(function (b) {
      b.textContent = labels[b.dataset.tab];
      b.classList.toggle('on', b.dataset.tab === S.tab);
    });
  }
  function showTab(t) {
    S.tab = t;
    document.querySelector('main').classList.toggle('wide', t === 'imports' || t === 'pairs'); // 取込一覧・車両・運転手情報は画面いっぱいに広げる
    ['import', 'imports', 'pairs'].forEach(function (x) { $('tab-' + x).hidden = x !== t; });
    renderTabs();
    if (t === 'imports') renderImports();
    if (t === 'pairs') renderPairs();
  }

  // ---------- 取込(PDF → 内容抽出 → 確認の表 → 記録) ----------
  function fileToBase64(file) {
    return new Promise(function (resolve, reject) {
      var r = new FileReader();
      r.onload = function () { resolve(String(r.result).split(',')[1] || ''); };
      r.onerror = function () { reject(new Error('ファイルを読み込めませんでした。')); };
      r.readAsDataURL(file);
    });
  }

  function addFiles(files) { // 1回に取り込めるのは1ファイル(複数入れたときは最初の1つ)
    Array.prototype.slice.call(files, 0, 1).forEach(function (file) {
      var card = { id: ++seq, mode: 'normal', kind: '新規', res: null, records: null, items: [], file: file, orig: file, rotate: 0, name: file.name, mime: file.type || 'application/pdf', status: 'reading', rows: [], decisions: [], findings: [], warnings: [], msg: '', url: '', busy: false };
      S.cards.unshift(card);
      card.el = h('div', { class: 'card' });
      $('cards').insertBefore(card.el, $('cards').firstChild);
      if (file.size > MAX_BYTES) { card.status = 'error'; card.msg = '10MBを超えています。'; renderCard(card); return; }
      if (['application/pdf', 'image/png', 'image/jpeg'].indexOf(card.mime) < 0) { card.status = 'error'; card.msg = 'PDF・PNG・JPEGのみ取り込めます。'; renderCard(card); return; }
      card.url = URL.createObjectURL(file);
      renderCard(card);
      extract(card);
    });
  }

  async function extract(card) {
    card.status = 'reading'; renderCard(card);
    try {
      var recsP = loadImports(true).catch(function () { return null; }); // OCRと同時に取込一覧を読み込む(待ち時間を重ねる)
      // 横倒し・逆さまの原本は、読み取りの前に正しい向きに回す(表示・保存も)。Geminiは向きを正しく返さず、横倒しのままだと車番を読み違えた(い→し。2026-10-23 実測)
      if (!card.rotate) { var deg = await TruckViewer.detectRotation(card.orig, card.mime).catch(function () { return 0; }); if (deg) await setCardRotation(card, deg, true); }
      if (!card.b64) card.b64 = await fileToBase64(card.file);
      var d = await apiPost('ocr', { filename: card.name, mimeType: card.mime, base64: card.b64 }, 180000);
      var res = L.sanitizeOcr(d.raw, { today: new Date(), senders: S.senders });
      res.rows.forEach(function (r) { r.運送業者 = L.canonCarrier(r.運送業者, S.pairs); }); // 登録済みの運送業者は、その書き方にそろえる(「ロジステイクス」→「ロジスティクス」など)
      card.res = res; card.warnings = res.warnings;
      var recs = await recsP; // 取れなかったときは null: 再取込のチェックを省く
      if (recs && L.alreadyImported(res, recs)) { // 既に取り込んだ内容と全く同じ: 取込をやめる
        S.cards = S.cards.filter(function (c) { return c !== card; }); card.el.remove(); if (card.url) URL.revokeObjectURL(card.url); syncDrop();
        noticeDialog('同じ内容のものです。取込をキャンセルしました');
        return;
      }
      if (recs) card.records = recs.slice(0, 500);
      if (S.reloadP) await S.reloadP; // 直前の記録・保存の読み直しが終わってから照合する
      var g = L.guessKind(res, recs); // 「再」の印が無い変更の再送は「変更」、当てはまる記録が無い「変更」は「新規」と、取込一覧から判断する
      if (g.rows) res.rows = g.rows; // 取消線の読み誤りを直した行
      if (g.reason) card.warnings = card.warnings.concat([g.reason + '違うときは「このFAXは」で選び直してください。']);
      if (g.kind !== '新規') await enterKind(card, g.kind);
      else enterNormal(card);
      card.status = 'ready';
    } catch (e) { card.status = 'error'; card.msg = e.message; }
    renderCard(card);
  }

  /** 行先から、過去に選んだ工事を初期値にする(②)。 */
  function applyProjectDefault(row) {
    if (row.工事番号 && !row._suggest) return;
    var s = L.suggestProject(S.destMap, row.行先);
    if (s) { row.工事番号 = s.工事番号; row.現場名 = s.工事番号 === OTHER ? OTHER : (L.projectName(S.projects, s.工事番号) || s.現場名); row._suggest = true; }
    else { row.工事番号 = ''; row.現場名 = ''; row._suggest = false; }
  }

  function ctx() { return { vehicles: S.vehicles, drivers: S.drivers, importKeys: S.importKeyList }; }
  function evalCard(card) { if (card.mode === 'change') evalChange(card); else card.findings = L.evaluateBatch(card.rows, ctx()); }

  function results(card) {
    return card.rows.map(function (r, i) { return L.resolveRow(r, card.findings[i] || [], card.decisions[i] || {}); });
  }

  var FIELDS = [
    ['業者', '手配業者', 'w-co'], ['積日', '積日', 'w-date'], ['卸日', '卸日', 'w-date'], ['行先', '行先', 'w-dest'], ['着時間', '着時間', 'w-time'],
    ['運送業者', '運送業者', 'w-co'], ['車種', '車種', 'w-type'], ['車番', '車番', 'w-plate'], ['氏名', '氏名', 'w-name'], ['携帯番号', '携帯番号', 'w-tel'], ['備考', '備考(入力)', 'w-note']
  ];

  function projectSelect(card, row) {
    var sel = h('select', { class: 'w-no', 'aria-label': '工事番号' });
    sel.appendChild(h('option', { value: '', text: '(選択してください)' }));
    sel.appendChild(h('option', { value: OTHER, text: OTHER })); // リストの一番上
    var found = row.工事番号 === OTHER;
    S.projects.forEach(function (p) {
      if (p.工事番号 === row.工事番号) found = true;
      sel.appendChild(h('option', { value: p.工事番号, text: p.工事番号 + '  ' + p.工事名 }));
    });
    if (row.工事番号 && !found) sel.appendChild(h('option', { value: row.工事番号, text: row.工事番号 + '  ' + (row.現場名 || '') }));
    sel.value = row.工事番号 || '';
    sel.addEventListener('change', function () {
      row.工事番号 = sel.value; row._suggest = false;
      row.現場名 = row.工事番号 === OTHER ? OTHER : L.projectName(S.projects, row.工事番号);
      if (row.工事番号) card.rows.forEach(function (o) {
        if (o !== row && !o.工事番号 && L.nameKey(o.行先) === L.nameKey(row.行先)) { o.工事番号 = row.工事番号; o.現場名 = row.現場名; o._suggest = false; }
      });
      evalCard(card);
      renderCard(card);
    });
    return sel;
  }

  /** 工事番号を、過去と同じ工事で初期選択した行があるときだけ、見出しの横に緑の注意書きを出す(行の中には出さない) */
  function sugNote(rows) {
    return rows.some(function (r) { return r._suggest; }) ? h('span', { class: 'sug-note', text: '※過去と同じ工事を選択' }) : null;
  }

  function normField(name, v) {
    if (name === '車番') return L.fmtPlate(v);
    if (name === '車種') return L.fmtType(v);
    if (name === '氏名') return L.nameKey(v);
    if (name === '携帯番号') return L.fmtPhone(v);
    if (name === '積日' || name === '卸日') return L.normDate(v, new Date().getFullYear()) || v;
    if (name === '着時間') return L.normTime(v);
    return v;
  }

  function rowsTable(card) {
    var head = h('tr', null, h('th', { text: '#' }), h('th', { text: '工事番号' }), h('th', { text: '現場名' }));
    FIELDS.forEach(function (f) { head.appendChild(h('th', { text: f[1] })); });
    var body = h('tbody');
    card.rows.forEach(function (row, i) {
      var tr = h('tr');
      tr.appendChild(h('td', { class: 'num', text: String(i + 1) }));
      tr.appendChild(h('td', null, projectSelect(card, row)));
      tr.appendChild(h('td', { class: 'w-site', text: row.現場名 || '' }));
      FIELDS.forEach(function (f) {
        var inp = h('input', { value: row[f[0]] || '', class: f[2], 'aria-label': f[1] });
        inp.addEventListener('input', function () { row[f[0]] = inp.value; scheduleEval(card); });
        inp.addEventListener('change', function () {
          var v = normField(f[0], inp.value);
          inp.value = v; row[f[0]] = v;
          if (f[0] === '行先') { applyProjectDefault(row); evalCard(card); renderCard(card); return; }
          scheduleEval(card, true);
        });
        tr.appendChild(h('td', null, inp));
      });
      body.appendChild(tr);
    });
    return h('div', { class: 'scroll' }, h('table', { class: 't fit' }, h('thead', null, head), body));
  }

  var LEVEL = { error: '要修正', warn: '要確認', info: '自動' };
  /** 食い違う部分だけを「〜か？〜か？」で見せる(例: 運送業者: …ス「ティ」クス か「テイ」か)。登録済み=左、今回=右 */
  function diffLines(diffs) {
    if (!diffs || !diffs.length) return null;
    var box = h('div', { class: 'difflines' });
    diffs.forEach(function (d) {
      var p = L.diffPart(d.a, d.b);
      box.appendChild(h('div', null, '違い(' + d.label + '): ',
        h('span', { class: 'diff-ctx', text: p.pre }), h('mark', { class: 'diff-a', text: p.a || '(なし)' }), h('span', { class: 'diff-ctx', text: p.suf }), ' か ',
        h('span', { class: 'diff-ctx', text: p.pre }), h('mark', { class: 'diff-b', text: p.b || '(なし)' }), h('span', { class: 'diff-ctx', text: p.suf }), ' か?',
        h('span', { class: 'diff-note', text: '(左=登録済み、右=今回)' })));
    });
    return box;
  }
  function findingsTable(card) {
    var body = h('tbody'), n = 0;
    card.findings.forEach(function (fs, i) {
      fs.forEach(function (f) {
        if (f.level !== 'warn' || f.id === 'missing-project') return; // 画面に出すのは、人が選ぶ必要がある確認だけ(自動・表の修正・工事番号未選択は、下のメッセージで足りる)
        n++;
        var cur = card.decisions[i] && card.decisions[i][f.id] != null ? card.decisions[i][f.id] : f.defaultValue;
        var act;
        if (f.level === 'error') act = h('span', { text: '表の入力を修正してください' });
        else {
          act = h('select', { 'aria-label': '対応' });
          if (cur == null) act.appendChild(h('option', { value: '', text: '(選択してください)' }));
          f.options.forEach(function (o) { act.appendChild(h('option', { value: o.value, text: o.label })); });
          act.value = cur == null ? '' : cur;
          if (cur == null) act.classList.add('need');
          act.addEventListener('change', function () { card.decisions[i][f.id] = act.value || null; act.classList.toggle('need', !act.value); renderFoot(card); });
        }
        body.appendChild(h('tr', null,
          h('td', { class: 'num', text: String(card.rowLabels ? card.rowLabels[i] : i + 1) }),
          h('td', { class: 'nowrap' }, h('span', { class: 'badge ' + f.level, text: LEVEL[f.level] })),
          h('td', { class: 'pre' }, h('strong', { text: f.title }), f.detail ? '\n' + f.detail : '', diffLines(f.diffs)),
          h('td', null, act)));
      });
    });
    if (!n) return null;
    return h('div', { class: 'scroll' }, h('table', { class: 't' },
      h('thead', null, h('tr', null, h('th', { text: '行' }), h('th', { text: '区分' }), h('th', { text: '内容' }), h('th', { text: '対応' }))), body));
  }

  var evalTimer = null;
  function scheduleEval(card, immediate) {
    clearTimeout(evalTimer);
    evalTimer = setTimeout(function () { evalCard(card); renderFindings(card); renderFoot(card); }, immediate ? 0 : 300);
  }

  /** カードを描く。確認の表・記録ボタンが上、取り込んだ原本(拡大・移動できる表示)が下。取込中・確認待ちの間は、取込枠を隠す。 */
  function renderCard(card) {
    renderCardBody(card);
    if (card.url && card.status !== 'saved') {
      if (!card.viewer) card.viewer = TruckViewer.create(card.file, card.mime, card.url, { onRotate: function (d) { setCardRotation(card, card.rotate + d); } }); // 原本の上に、左右90°回すボタン
      card.el.appendChild(card.viewer);
    }
    syncDrop();
  }
  /** 取り込んだ原本を、元のファイルから時計回りに deg 回したものにする。表示と、Driveに保存する原本(card.b64)の両方を差し替える */
  async function setCardRotation(card, deg, quiet) {
    deg = ((deg % 360) + 360) % 360;
    try {
      var f = await TruckViewer.rotateFile(card.orig, card.mime, deg);
      card.rotate = deg; card.file = f; card.b64 = await fileToBase64(f);
      if (card.url) URL.revokeObjectURL(card.url);
      card.url = URL.createObjectURL(f); card.viewer = null;
    } catch (e) { if (!quiet) toast('原本を回せませんでした: ' + e.message); return; }
    if (!quiet) renderCard(card);
  }
  function syncDrop() { $('drop').hidden = S.cards.some(function (c) { return c.status === 'reading' || c.status === 'ready'; }); }

  function renderCardBody(card) {
    var el = card.el;
    el.textContent = '';
    var chip = { reading: ['読み取り中…', 'chip'], ready: ['確認待ち', 'chip'], saved: ['記録済み', 'chip ok'], error: ['エラー', 'chip bad'] }[card.status];
    var head = h('div', { class: 'card-head' }, h('span', { class: 'name', text: card.name }), h('span', { class: chip[1], text: chip[0] }), card.status === 'ready' ? kindBox(card) : null, h('span', { class: 'spacer' }));
    el.appendChild(head);
    if (card.status === 'reading') { el.appendChild(h('div', { class: 'reading-note', text: 'FAXの内容を読み取っています(10〜30秒ほどかかります)…' })); return; }
    if (card.status === 'error') {
      el.appendChild(h('div', { class: 'foot' }, h('span', { class: 'msg bad', text: card.msg }),
        card.url ? h('button', { class: 'btn', type: 'button', text: 'もう一度読み取る', onclick: function () { extract(card); } }) : null,
        h('button', { class: 'btn', type: 'button', text: '破棄する', onclick: function () { discardCard(card); } }))); // エラーのときも、取込枠に戻せるようにする
      return;
    }
    if (card.status === 'saved') { el.appendChild(h('div', { class: 'foot' }, h('span', { class: 'msg', text: card.msg }))); return; }
    card.warnings.forEach(function (w) { el.appendChild(h('div', { class: 'foot' }, h('span', { class: 'badge warn', text: '注意' }), h('span', { class: 'msg', text: w }))); });
    if (card.mode === 'change') { renderChangeBody(card); return; }
    card.footHost = h('div'); // 「記録する」「破棄する」は、見出しの行の右端に置く
    el.appendChild(h('div', { class: 'sub-row' }, h('div', { class: 'sub-h' }, '読み取り結果(間違いがあれば表の中で直せます)', sugNote(card.rows)), h('span', { class: 'spacer' }), card.footHost));
    card.rowsHost = h('div'); card.rowsHost.appendChild(rowsTable(card)); el.appendChild(card.rowsHost);
    card.findHost = h('div'); el.appendChild(card.findHost);
    renderFindings(card); renderFoot(card);
  }
  /** 記入か選択が必要な欄を、黄色にする(読み取り結果の表)。入力のたびに付け外しする。 */
  var NEED_BY = { 'missing-project': '工事番号', 'missing-plate': '車番', 'bad-date': '積日|卸日', 'missing-carrier': '運送業者', 'missing-name': '氏名', 'missing-phone': '携帯番号', 'phone-format': '携帯番号' };
  function markNeeds(card) {
    if (!card.rowsHost) return;
    var trs = card.rowsHost.querySelectorAll('tbody tr');
    card.rows.forEach(function (row, i) {
      var need = {};
      (card.findings[i] || []).forEach(function (f) { if (NEED_BY[f.id]) NEED_BY[f.id].split('|').forEach(function (k) { need[k] = true; }); });
      if (need.積日 && row.積日 && row.卸日) { delete need.積日; delete need.卸日; }
      else { if (need.積日 && row.積日) delete need.積日; if (need.卸日 && row.卸日) delete need.卸日; }
      if (!trs[i]) return;
      trs[i].querySelectorAll('input, select').forEach(function (el) { el.classList.toggle('need', !!need[el.getAttribute('aria-label')]); });
    });
  }

  function renderFindings(card) {
    markNeeds(card);
    if (!card.findHost) return;
    card.findHost.textContent = '';
    var t = findingsTable(card);
    if (!t) return;
    card.findHost.appendChild(h('div', { class: 'sub-h', text: '確認が必要な項目' }));
    card.findHost.appendChild(t);
  }

  /** 下部(ボタン+メッセージ)は、最初に1回だけ作り、その後はその場で更新する。
   *  作り直すと、入力欄から離れた瞬間の再描画でボタンが置き換わり、最初のクリックが効かなくなる。 */
  function footParts(card, discardText, onDiscard) {
    var host = card.footHost;
    if (!host._f) {
      var btn = h('button', { class: 'btn primary', type: 'button' }), msg = h('span', { class: 'msg' }), disc = h('button', { class: 'btn', type: 'button' });
      host.textContent = '';
      host.appendChild(h('div', { class: 'foot-btns' }, btn, disc)); // msg は画面に出さない(ボタンのヒントに入れる)
      host._f = { btn: btn, msg: msg, disc: disc };
    }
    host._f.disc.textContent = discardText; host._f.disc.onclick = onDiscard;
    host._f.hint = function () { host._f.btn.title = host._f.msg.textContent; };
    return host._f;
  }
  /** 記録・反映が終わったカードは消して、取込枠を元の状態に戻す。結果は、画面下に少しの間だけ知らせる。 */
  function finishCard(card) {
    S.cards = S.cards.filter(function (c) { return c !== card; });
    card.el.remove(); if (card.url) URL.revokeObjectURL(card.url);
    syncDrop();
    toast(card.msg);
  }
  /** 画面下に、結果を少しの間だけ知らせる(クリックで消える) */
  function toast(msg) {
    var t = h('div', { class: 'toast', text: msg, onclick: function () { t.remove(); } });
    document.body.appendChild(t);
    setTimeout(function () { t.remove(); }, 8000);
  }

  function discardCard(card) { S.cards = S.cards.filter(function (c) { return c !== card; }); card.el.remove(); syncDrop(); }

  function renderFoot(card) {
    if (!card.footHost) return;
    if (card.mode === 'change') { renderChangeFoot(card); return; }
    var rs = results(card);
    var blockers = 0, keep = 0;
    rs.forEach(function (r) { blockers += r.blockers.length; if (!r.skip) keep++; });
    var todo = [];
    rs.forEach(function (r, i) {
      r.blockers.forEach(function (id) {
        var f = (card.findings[i] || []).filter(function (x) { return x.id === id; })[0];
        todo.push((card.rows.length > 1 ? (i + 1) + '行目: ' : '') + (f ? f.title : id));
      });
    });
    var msg = blockers > 0 ? '記録するには、あと ' + blockers + ' 件の対応が必要です → ' + todo.slice(0, 3).join(' / ') + (todo.length > 3 ? ' ほか' : '') : (keep === 0 ? '記録する行がありません。' : '準備OKです。内容を確認して「記録する」を押してください。');
    var f = footParts(card, '破棄する', function () { discardCard(card); });
    f.btn.textContent = '記録する'; f.btn.disabled = blockers > 0 || keep === 0 || !!card.busy; f.btn.onclick = function () { commitCard(card); };
    f.msg.textContent = msg; f.hint();
  }

  /** 1件記録したあと、確認待ちの他のFAXにも、最新の記録(行先ごとの工事番号の初期値・取込済みの重複)を反映する。 */
  function refreshReadyCards() {
    S.cards.forEach(function (c) {
      if (c.status !== 'ready') return;
      var rows = c.mode === 'change' ? c.items.filter(function (it) { return it.newRow; }).map(function (it) { return it.newRow; }) : c.rows;
      rows.forEach(function (r) { if (!r.工事番号) applyProjectDefault(r); });
      evalCard(c); renderCard(c);
    });
  }

  /** 「データ記録中」のポップアップ(進行バーつき)を出し、閉じる関数を返す。終わるまで他の操作はできない。 */
  function busyDialog(text) {
    var dlg = h('dialog', { class: 'dlg busy' }, h('p', { class: 'dlg-title', text: text }),
      h('div', { class: 'progress', role: 'progressbar', 'aria-label': text }, h('div', { class: 'progress-bar' })));
    dlg.addEventListener('cancel', function (e) { e.preventDefault(); }); // Escで閉じさせない
    document.body.appendChild(dlg);
    dlg.showModal();
    return function () { if (dlg.open) dlg.close(); dlg.remove(); };
  }

  /** 記録のあとの「車と運転手の組み合わせ」の追加の結果を、記録完了のメッセージに足す文 */
  function pairText(out) {
    var p = out && out.pairs;
    if (!p) return '';
    if (!p.ok) return ' ※車両・運転手情報への組み合わせの追加に失敗しました(取込一覧には記録済み): ' + p.error;
    var n = (p.added || 0) + (p.filled || 0);
    return '(車両・運転手情報: ' + (n ? '車と運転手の組み合わせを' + n + '件追加' : '追加なし') + (p.noted ? '・手配業者違いの備考を' + p.noted + '件記入' : '') + ')';
  }

  async function commitCard(card) {
    var close = busyDialog('データ記録中');
    try { await commitCardBody(card); } finally { close(); }
  }
  async function commitCardBody(card) {
    var rs = results(card);
    var keep = rs.filter(function (r) { return !r.skip; });
    var ops = L.mergeOps(keep.map(function (r) { return r.ops; }));
    var rows = keep.map(function (r) { var o = {}; L.ROW_FIELDS.forEach(function (k) { o[k] = r.row[k] || ''; }); o.noPair = !!r.row.noPair; return o; }); // noPair=「登録しない」「今回だけこの値」を選んだ行(車両・運転手情報に組み合わせを追加しない)
    card.busy = true; renderFoot(card);
    try {
      var body = { filename: card.name, rows: rows, ops: ops };
      if (card.b64) { body.fileBase64 = card.b64; body.fileMime = card.mime; } // 原本をDriveに保存し、取込一覧のファイルURLに入れる
      var out = await apiPost('commit', body, 180000);
      card.status = 'saved';
      card.msg = rows.length + '件を取込一覧に記録しました' + pairText(out) + '。' + (out && out.fileWarn ? ' ※原本はDriveに保存できませんでした: ' + out.fileWarn : '');
      rows.forEach(function (r) { S.importKeyList.push(L.importKey({ 積日: r.積日, 車番: r.車番 })); }); // 重複の判定は、記録した分をその場で足す(読み直しを待たない)
      reloadInit();
    } catch (e) { card.busy = false; showBanner('記録に失敗しました: ' + e.message); renderFoot(card); return; }
    card.busy = false; showBanner(''); finishCard(card);
  }

  // ---------- 変更・追加・取消(一度受領した連絡の続報) ----------
  var KINDS = ['新規', '変更', '追加', '取消'];
  var KIND_HELP = { 新規: '新しい連絡', 変更: '車・運転手・日付などの変更', 追加: '台数の追加', 取消: '取消' };

  function kindBox(card) {
    var sel = h('select', { 'aria-label': 'FAXの区分' });
    KINDS.forEach(function (k) { sel.appendChild(h('option', { value: k, text: k + '(' + KIND_HELP[k] + ')' })); });
    sel.value = card.mode === 'change' ? card.kind : '新規';
    sel.addEventListener('change', async function () {
      sel.disabled = true;
      try { await enterKind(card, sel.value); showBanner(''); } catch (e) { showBanner('取込一覧を読み込めませんでした: ' + e.message); }
      renderCard(card);
    });
    return h('label', { class: 'kindbox' }, 'このFAXは: ', sel);
  }

  function enterNormal(card) {
    card.mode = 'normal'; card.kind = '新規';
    card.rows = card.res.rows.filter(function (r) { return !r.struck; }).map(function (r) { return Object.assign({}, r); });
    card.rows.forEach(applyProjectDefault);
    card.decisions = card.rows.map(function () { return {}; });
    card.rowLabels = null;
    evalCard(card);
  }

  async function enterKind(card, kind) {
    if (S.reloadP) await S.reloadP;
    if (kind === '新規') { enterNormal(card); return; }
    if (!card.records) card.records = (await loadImports(true)).slice(0, 500);
    var plan = L.buildChangePlan(card.res, card.records, kind);
    card.mode = 'change'; card.kind = kind; card.items = plan.items;
    card.items.forEach(function (it) { if (it.newRow && !it.newRow.工事番号) applyProjectDefault(it.newRow); });
    evalCard(card);
  }

  function pickedRec(it) { return it.pick != null && it.candidates[it.pick] ? it.candidates[it.pick].rec : null; }

  function syncChange(card) {
    var k = 0;
    card.rows = []; card.decisions = []; card.rowLabels = [];
    card.items.forEach(function (it, i) {
      if (!it.newRow) { it.rowIdx = -1; return; }
      it.rowIdx = k++; card.rows.push(it.newRow); card.decisions.push(it.decisions); card.rowLabels.push(i + 1);
    });
  }

  function evalChange(card) {
    syncChange(card);
    var skip = {};
    card.items.forEach(function (it) { // 差し替える元の記録は、重複の判定から外す
      var rec = pickedRec(it);
      if (rec && it.type === 'update' && it.action === 'apply') skip[L.importKey({ 積日: rec.積日, 車番: rec.車番 })] = true;
    });
    card.findings = L.evaluateBatch(card.rows, { vehicles: S.vehicles, drivers: S.drivers, importKeys: S.importKeyList.filter(function (k) { return !skip[k]; }) });
    card.items.forEach(function (it) { if (it.action === 'skip' && it.rowIdx >= 0) card.findings[it.rowIdx] = []; }); // 記録しない行は、確認を出さない
  }

  function changeResults(card) {
    return card.items.map(function (it, i) {
      var o = { item: it, no: i + 1, blockers: [], active: false, res: null };
      if (it.action == null) { o.blockers.push('対応を選んでください'); return o; }
      if (it.action === 'skip') return o;
      if (it.newRow) {
        var r = L.resolveRow(it.newRow, card.findings[it.rowIdx] || [], it.decisions);
        if (r.skip) return o;
        o.res = r; o.blockers = r.blockers.map(function (id) {
          var f = (card.findings[it.rowIdx] || []).filter(function (x) { return x.id === id; })[0];
          return f ? f.title : id;
        });
      }
      o.active = true; return o;
    });
  }

  var TYPE_LABEL = { update: '変更', add: '追加', cancel: '取消' };
  var ACTION_LABEL = {
    update: { apply: 'この記録を「変更前」にして、今回の内容を「変更後」として追加する', asnew: '変更前にはせず、別の1台として追加する', skip: '変更なし(記録しない)' },
    add: { apply: '1台追加して記録する', skip: '反映しない' },
    cancel: { apply: 'この記録を「中止」にする', record: '元の記録が無いので、このFAXの内容を「中止」として追加する', skip: '反映しない' }
  };

  function recLabel(c) { var r = c.rec; return (r.積日 || '') + ' ' + (r.車番 || '') + ' ' + (r.氏名 || '') + '(' + (r.運送業者 || '') + ') 行' + r._row; }

  function changeTable(card) {
    var heads = ['#', '', '工事番号', '現場名'].concat(FIELDS.map(function (f) { return f[1]; }));
    var tbody = h('tbody');
    card.items.forEach(function (it, idx) {
      var rec = pickedRec(it), recRow = rec ? L.recToRow(rec) : null, trs = [];
      if (it.type !== 'add') {
        var cells = [h('td', { class: 'num cur', text: '現在' })];
        if (rec) {
          cells.push(h('td', { class: 'cur', text: recRow.工事番号 }), h('td', { class: 'cur w-site', text: recRow.現場名 }));
          FIELDS.forEach(function (f) { cells.push(h('td', { class: 'cur nowrap', text: recRow[f[0]] || '' })); });
        } else cells.push(h('td', { class: 'cur', colspan: FIELDS.length + 2, text: it.candidates.length ? '(元の記録を選んでください)' : '該当する元の記録が見つかりません' }));
        trs.push(cells);
      }
      if (it.type === 'cancel' && it.faxRow) {
        var fx = it.faxRow, cells4 = [h('td', { class: 'num new', text: 'FAX' }), h('td', { class: 'cur', text: '' }), h('td', { class: 'cur', text: '' })];
        FIELDS.forEach(function (f) { cells4.push(h('td', { class: 'cur nowrap', text: f[0] === '備考' ? '' : (fx[f[0]] || '') })); });
        trs.push(cells4);
      }
      if (it.newRow) {
        var row = it.newRow, cells2 = [h('td', { class: 'num new', text: it.type === 'add' ? '追加' : '今回' })];
        cells2.push(h('td', null, projectSelect(card, row)), h('td', { class: 'w-site', text: row.現場名 || '' }));
        FIELDS.forEach(function (f) {
          var inp = h('input', { value: row[f[0]] || '', class: f[2], 'aria-label': f[1] });
          inp.addEventListener('input', function () { row[f[0]] = inp.value; scheduleEval(card); });
          var td = h('td', { class: recRow && f[0] !== '備考' && L.fieldDiffers(f[0], row[f[0]], recRow[f[0]]) ? 'chg' : '' }, inp);
          inp.addEventListener('change', function () {
            var v = normField(f[0], inp.value); inp.value = v; row[f[0]] = v;
            td.className = recRow && f[0] !== '備考' && L.fieldDiffers(f[0], v, recRow[f[0]]) ? 'chg' : '';
            evalCard(card); renderFindings(card); renderFoot(card);
          });
          cells2.push(td);
        });
        trs.push(cells2);
      }
      // 元の記録の選択(1行目に縦結合)
      var pick = h('select', { 'aria-label': '元の記録' });
      pick.appendChild(h('option', { value: '', text: it.type === 'add' ? '(新しい1台)' : '(該当する記録なし)' }));
      it.candidates.forEach(function (c, i) { pick.appendChild(h('option', { value: String(i), text: recLabel(c) })); });
      pick.value = it.pick == null ? '' : String(it.pick);
      pick.addEventListener('change', function () { L.setPick(it, pick.value === '' ? null : +pick.value); evalCard(card); renderCard(card); });
      // 対応の選択
      var act = h('select', { 'aria-label': '対応' });
      if (it.action == null) act.appendChild(h('option', { value: '', text: '(選択してください)' }));
      Object.keys(ACTION_LABEL[it.type]).forEach(function (k) {
        if (k === 'apply' && it.type !== 'add' && !rec) return; // 元の記録が無いと、変更前・中止の印は付けられない
        if (k === 'record' && rec) return;
        if (k === 'asnew' && !it.newRow) return;
        act.appendChild(h('option', { value: k, text: ACTION_LABEL[it.type][k] }));
      });
      act.value = it.action == null ? '' : it.action;
      act.addEventListener('change', function () { it.action = act.value || null; evalCard(card); renderFindings(card); renderFoot(card); });
      var span = trs.length + 1; // 現在・今回の行+操作の行
      trs[0].unshift(h('td', { class: 'num', rowspan: span }, String(idx + 1), h('div', null, h('span', { class: 'badge ' + (it.type === 'cancel' ? 'error' : it.type === 'add' ? 'info' : 'warn'), text: TYPE_LABEL[it.type] }))));
      trs.forEach(function (cells3, k) { tbody.appendChild(h('tr', { class: k === 0 ? 'grp' : '' }, cells3)); });
      tbody.appendChild(h('tr', { class: 'ctl' }, h('td', { colspan: FIELDS.length + 3 },
        h('label', { class: 'ctlitem' }, it.type === 'add' ? '元の記録: ' : '元の記録(取込一覧): ', pick), h('label', { class: 'ctlitem' }, '対応: ', act),
        it.same && it.action === 'skip' ? h('span', { class: 'ctlitem', text: '※取込一覧の記録と同じ内容のため、記録しません' }) : null,
        it.type === 'cancel' ? h('label', { class: 'ctlitem' }, '備考: ', (function () { var n = h('input', { value: it.note || '', placeholder: '中止の理由など(任意)', 'aria-label': '備考' }); n.addEventListener('input', function () { it.note = n.value; }); return n; })()) : null)));
    });
    return h('div', { class: 'scroll' }, h('table', { class: 't change' }, h('thead', null, h('tr', null, heads.map(function (t) { return h('th', { text: t }); }))), tbody));
  }

  function renderChangeBody(card) {
    var el = card.el;
    if (card.res.memo) el.appendChild(h('div', { class: 'foot' }, h('span', { class: 'badge info', text: 'FAXの連絡' }), h('span', { class: 'msg', text: card.res.memo })));
    card.footHost = h('div');
    el.appendChild(h('div', { class: 'sub-row' }, h('div', { class: 'sub-h' }, '変更内容(現在の記録と、今回のFAXを並べています。違う項目は色が付きます)', sugNote(card.items.map(function (it) { return it.newRow; }).filter(Boolean))), h('span', { class: 'spacer' }), card.footHost));
    if (!card.items.length) el.appendChild(h('div', { class: 'empty', text: '変更・追加・取消の対象が見つかりませんでした。FAXの区分を選び直してください。' }));
    else el.appendChild(changeTable(card));
    card.findHost = h('div'); el.appendChild(card.findHost);
    renderFindings(card); renderFoot(card);
  }

  function renderChangeFoot(card) {
    var rs = changeResults(card), blockers = 0, active = 0, todo = [];
    rs.forEach(function (r) { blockers += r.blockers.length; if (r.active) active++; r.blockers.forEach(function (b) { todo.push(r.no + '件目: ' + b); }); });
    var msg = blockers > 0 ? '反映するには、あと ' + blockers + ' 件の対応が必要です → ' + todo.slice(0, 3).join(' / ') + (todo.length > 3 ? ' ほか' : '') : (active === 0 ? (card.items.length && card.items.every(function (it) { return it.same && it.action === 'skip'; }) ? 'すべての行が、取込一覧の記録と同じです(変更なし)。「破棄する」で閉じてください。' : '反映する内容がありません。') : '準備OKです。内容を確認して「反映する」を押してください。');
    var f = footParts(card, '破棄する', function () { discardCard(card); });
    f.btn.textContent = '反映する'; f.btn.disabled = blockers > 0 || active === 0 || !!card.busy; f.btn.onclick = function () { commitChange(card); };
    f.msg.textContent = msg; f.hint();
  }

  async function commitChange(card) {
    var close = busyDialog('データ記録中');
    try { await commitChangeBody(card); } finally { close(); }
  }
  async function commitChangeBody(card) {
    // 他のFAXを先に記録した場合など、取込一覧が変わっていたら、最新で照合し直してやり直す(古い照合のまま反映しない)
    card.busy = true; renderFoot(card);
    try {
      var fresh = (await loadImports(true)).slice(0, 500);
      var sig = function (a) { return JSON.stringify(a.map(function (r) { return [r._row, r.積日, r.車番, r.氏名, r.携帯番号, r.手配業者, r.追加変更]; })); };
      if (sig(fresh) !== sig(card.records || [])) {
        card.records = fresh;
        var plan = L.buildChangePlan(card.res, fresh, card.kind);
        card.items = plan.items;
        card.items.forEach(function (it) { if (it.newRow && !it.newRow.工事番号) applyProjectDefault(it.newRow); });
        evalCard(card); card.busy = false;
        showBanner('取込一覧が更新されていたため、最新の内容で照合し直しました。表の内容を確認して、もう一度「反映する」を押してください。');
        renderCard(card); return;
      }
    } catch (e) { card.busy = false; showBanner('取込一覧を確認できませんでした: ' + e.message); renderFoot(card); return; }
    card.busy = false;
    var rs = changeResults(card), items = [], opsList = [];
    rs.forEach(function (r) {
      if (!r.active) return;
      var it = r.item, rec = pickedRec(it);
      if (it.type === 'cancel') {
        if (it.action === 'record') { // 元の記録が無いので、FAXの内容を「中止」の行として残す
          var cr = Object.assign({}, it.faxRow); if (!cr.工事番号) applyProjectDefault(cr); cr.備考 = it.note || '';
          var cd = {}; L.ROW_FIELDS.forEach(function (k) { cd[k] = cr[k] || ''; });
          items.push({ mode: 'add', label: '中止', data: cd });
        } else items.push({ mode: 'mark', label: '中止', row: rec._row, before: L.recFields(rec), note: it.note || '' });
        return;
      }
      var data = {}; L.ROW_FIELDS.forEach(function (k) { data[k] = r.res.row[k] || ''; }); data.noPair = !!r.res.row.noPair;
      opsList.push(r.res.ops);
      if (it.type === 'update' && it.action === 'apply') { // 元の記録は「変更前」として残し、今回の内容を「変更後」の行として追加する
        items.push({ mode: 'mark', label: '変更前', row: rec._row, before: L.recFields(rec) });
        items.push({ mode: 'add', label: it.label || '変更後', data: data });
      } else items.push({ mode: 'add', label: it.type === 'update' ? '' : (it.label || ''), data: data });
    });
    var ops = L.mergeOps(opsList);
    card.busy = true; renderFoot(card);
    try {
      var cbody = { filename: card.name, items: items, ops: ops };
      if (card.b64) { cbody.fileBase64 = card.b64; cbody.fileMime = card.mime; }
      var out = await apiPost('applyChanges', cbody, 180000);
      card.status = 'saved';
      card.msg = '取込一覧に反映しました(行を追加' + out.added + '件・「変更前」「中止」の印' + out.marked + '件)。取り込んだ行は、取込一覧に残っています。' + pairText(out) + (out.fileWarn ? ' ※原本はDriveに保存できませんでした: ' + out.fileWarn : '');
      items.forEach(function (it) { if (it.mode === 'add' && it.label !== '中止' && it.label !== '変更前') S.importKeyList.push(L.importKey({ 積日: it.data.積日, 車番: it.data.車番 })); });
      reloadInit();
    } catch (e) { card.busy = false; showBanner('反映に失敗しました: ' + e.message); renderFoot(card); return; }
    card.busy = false; showBanner(''); finishCard(card);
  }

  // ---------- 取込一覧(読み取り専用の表) ----------
  async function renderImports() {
    var host = $('tab-imports');
    if (S.imports == null) {
      host.textContent = '';
      host.appendChild(h('div', { class: 'empty', text: '読み込み中…' }));
      try { S.imports = await loadImports(); }
      catch (e) { host.textContent = ''; host.appendChild(h('div', { class: 'empty', text: '取得に失敗しました: ' + e.message })); return; }
    }
    host.textContent = '';
    if (S.importsFile) { host.appendChild(S.importsFile.el); S.importsFile.fit(); return; } // 1つの原本の行だけに絞っている(openImportFile)
    if (S.importsFy == null) { // 初期値は、本日の年度・締め月
      var n = new Date(), now = L.closingOf(n.getFullYear(), n.getMonth() + 1, n.getDate());
      S.importsFy = String(now.fy); S.importsCm = String(now.cm);
    }
    var cl = S.imports.map(function (r) { return L.rowClosing(r); });
    var undated = cl.filter(function (c) { return !c; }).length;
    var fys = {}; cl.forEach(function (c) { if (c) fys[c.fy] = 1; }); if (S.importsFy !== 'all') fys[S.importsFy] = 1;
    var fyList = Object.keys(fys).sort(function (a, b) { return b - a; });
    var rows = S.imports.filter(function (r, i) {
      var c = cl[i];
      if (S.importsFy !== 'all' && !(c && String(c.fy) === S.importsFy)) return false;
      if (S.importsCm !== 'all' && !(c && String(c.cm) === S.importsCm)) return false;
      return S.importsSite === 'all' || r.現場名 === S.importsSite;
    });
    var sites = {}; sites[OTHER] = 1; // 現場名リスト: 「その他」、情報シートの工事名、取込一覧にある現場名
    S.projects.forEach(function (p) { if (p.工事名) sites[p.工事名] = 1; });
    S.imports.forEach(function (r) { if (r.現場名) sites[r.現場名] = 1; });
    var siteList = Object.keys(sites).sort(function (a, b) { return a.localeCompare(b, 'ja'); });
    function sel(label, value, opts, onchange) {
      var s = h('select', { 'aria-label': label }, opts.map(function (o) { return h('option', { value: o[0], text: o[1] }); }));
      s.value = value; s.addEventListener('change', function () { onchange(s.value); renderImports(); });
      return s;
    }
    var haveCl = {}; cl.forEach(function (c) { if (c) haveCl[c.fy + '-' + c.cm] = 1; }); // データのある 年度-締め月
    var fySel = sel('年度', S.importsFy, [['all', 'すべての年度']].concat(fyList.map(function (y) { return [String(y), y + '年度']; })), function (v) {
      S.importsFy = v;
      var ms = closingMonthsWithData(haveCl, v); // 年度を変えたとき、選んでいた締め月がその年度に無ければ、データのある一番新しい月にする
      if (v !== 'all' && S.importsCm !== 'all' && ms.length && ms.indexOf(+S.importsCm) < 0) S.importsCm = String(ms[ms.length - 1]);
    });
    // 締め月のリストには、データのある月だけを出す(選んでいる月は、データが無くても残す)
    var cmMonths = closingMonthsWithData(haveCl, S.importsFy);
    if (S.importsCm !== 'all' && cmMonths.indexOf(+S.importsCm) < 0) cmMonths = L.CLOSING_MONTH_ORDER.filter(function (m) { return cmMonths.indexOf(m) >= 0 || m === +S.importsCm; });
    var cmSel = sel('締め月', S.importsCm, [['all', 'すべての締め月']].concat(cmMonths.map(function (m) { return [String(m), m + '/20〆']; })), function (v) { S.importsCm = v; });
    // 締め月のリストの左右に ◀▶。1か月前・後へ移動する。データが無い月・「すべて」のときは押せない(グレーアウト)
    function goCm(to) { S.importsFy = String(to.fy); S.importsCm = String(to.cm); renderImports(); }
    var prevBtn = cmStepButton(-1, '◀', '1か月前の締め月', goCm), nextBtn = cmStepButton(1, '▶', '1か月後の締め月', goCm);
    prevBtn.update(S.importsFy, S.importsCm, haveCl); nextBtn.update(S.importsFy, S.importsCm, haveCl);
    var cmNav = h('span', { class: 'cm-nav' }, prevBtn, cmSel, nextBtn);
    requestAnimationFrame(function () { fitSelect(fySel); fitSelect(cmSel); }); // 年度・締め月のリストの幅を、選んでいる文字に合わせる(左右の空白を同じに)
    var siteSel = sel('現場名', S.importsSite, [['all', '全て(現場名)']].concat(siteList.map(function (n) { return [n, n]; })), function (v) { S.importsSite = v; });
    var shown = L.sortImportRows(rows.slice(0, IMPORTS_SHOW)); // 新しい100件を、ファイルごと・卸日の早い順に並べる
    var cnt = 'ファイルごと・卸日の早い順・該当' + rows.length + '件のうち最新' + shown.length + '件を表示(最大' + IMPORTS_SHOW + '件)' + (undated && (S.importsFy !== 'all' || S.importsCm !== 'all') ? ' ・ 日付のない' + undated + '件は「すべて」で表示' : '');
    var wrap = h('div', { class: 'imp-wrap' }); host.appendChild(wrap); // 上の絞り込み・ボタンの行と表を、表の幅に合わせて中央に置く
    wrap.appendChild(h('div', { class: 'tool' }, fySel, cmNav, siteSel, h('button', { class: 'btn sm', type: 'button', text: '再読み込み', onclick: function () { S.imports = null; S.importsP = null; renderImports(); } }), h('span', { class: 'sub', text: cnt }), h('span', { class: 'spacer' }),
      h('button', { class: 'btn excel', type: 'button', text: '全件ダウンロード', onclick: downloadAllImports }), ' ',
      h('button', { class: 'btn excel', type: 'button', text: '締め月ダウンロード', onclick: openClosingDownload }), ' ',
      h('button', { class: 'btn excel', type: 'button', text: '積日指定でダウンロード', onclick: openDateDownload })));
    var head = h('tr'); TABLE_HEADERS.forEach(function (k) { head.appendChild(h('th', { class: 'c', text: k })); }); // 見出しは、どの列も中央揃え(2026-10-23、ユーザー指示)。「操作」の列は無い(行を押すと編集できる)
    var body = h('tbody');
    shown.forEach(function (r) { body.appendChild(importRow(r)); });
    var tbox = shown.length ? h('div', { class: 'scroll fitcols listbox' }, h('table', { class: 't zebra' }, h('thead', null, head), body)) : h('div', { class: 'empty', text: '該当する記録はありません。' });
    wrap.appendChild(tbox);
    if (shown.length) requestAnimationFrame(fitListHeight); // 上の行(絞り込み・ボタン)と表の見出しは動かさず、表の中だけをスクロールする
    TruckViewer.preload(); prefetchFaxes(shown); // 原本をすぐ開けるよう、pdf.js と表の上の原本を先に読む
  }

  /** リストの幅を、選んでいる項目の文字の幅+左右同じ余白+▼の幅にする(長い項目「すべての締め月」に引っぱられて、広くなりすぎないように) */
  function fitSelect(sel) {
    if (!sel.isConnected) return;
    var cs = getComputedStyle(sel), cv = fitSelect.cv || (fitSelect.cv = document.createElement('canvas')), ctx = cv.getContext('2d');
    ctx.font = cs.fontWeight + ' ' + cs.fontSize + ' ' + cs.fontFamily;
    var opt = sel.options[sel.selectedIndex], tw = ctx.measureText(opt ? opt.text : '').width;
    sel.style.width = Math.ceil(tw + 2 * 14 + 22) + 'px'; // 左右の余白14pxずつ+▼の場所22px
  }
  /** データのある締め月(12,1,…,11の順)。fy='all' のときは、どの年度かにデータのある月 */
  function closingMonthsWithData(haveCl, fy) {
    return L.CLOSING_MONTH_ORDER.filter(function (m) {
      if (fy !== 'all') return !!haveCl[fy + '-' + m];
      return Object.keys(haveCl).some(function (k) { return k.split('-')[1] === String(m); });
    });
  }

  /** 締め月のリストの左右に置く ◀▶ ボタン(delta=-1:1か月前、+1:1か月後)。update(年度, 締め月, データのある月の表)で、移動先にデータが無いとき(「すべて」のときも)グレーにして押せなくする。押すと apply(移動先{fy,cm}) を呼ぶ */
  function cmStepButton(delta, text, label, apply) {
    var to = null;
    var b = h('button', { class: 'btn sm cm-step', type: 'button', text: text, 'aria-label': label, disabled: true, onclick: function () { if (to) apply(to); } });
    b.update = function (fy, cm, have) {
      var raw = fy && cm && fy !== 'all' && cm !== 'all' ? L.closingNeighbor(fy, cm, delta) : null;
      to = raw && have[raw.fy + '-' + raw.cm] ? raw : null;
      b.disabled = !to;
      b.title = to ? to.fy + '年度 ' + to.cm + '/20〆へ' : (raw ? raw.fy + '年度 ' + raw.cm + '/20〆はデータがありません' : '年度・締め月を選ぶと使えます');
    };
    return b;
  }

  // ---------- 取込一覧の行の編集(行をクリック→その原本の行だけに絞った表で編集し、下に原本を出す) ----------
  var IMPORT_LABELS = ['', '変更前', '変更後', '中止'];
  function importDraftOf(r) { var d = {}; VIEW_HEADERS.forEach(function (k) { if (k !== 'ファイル名') d[k] = r[k] || ''; }); return d; }

  /** 取込一覧の表の表示用の文字: ファイル名は拡張子を除く、積日・卸日は m/d */
  function importCellText(r, k) {
    var v = r[k] || '';
    if (k === 'ファイル名') return v.replace(/\.(pdf|png|jpe?g)$/i, '');
    if (k === '積日' || k === '卸日') { var d = L.dateKey(v); return d ? (+d.slice(5, 7)) + '/' + (+d.slice(8, 10)) : v; }
    return v;
  }
  /** 取込一覧の「変更前」の行か(表とExcelで、赤字・取り消し線にする) */
  function isBeforeRow(r) { return String(r && r.追加変更 != null ? r.追加変更 : '').trim() === '変更前'; }
  function struckOf(list) { return { struck: list.map(isBeforeRow), leftCols: LEFT_COLS.concat(['ファイルURL']), centerHeads: LEFT_COLS.concat(['ファイルURL']) }; } // Excelも、ファイル名・現場名・備考(とファイルURL)の中身は左揃え、他は中央揃え。見出しはすべて中央揃え
  /** 取込一覧の表の高さを、画面の下端までにする(表の中だけがスクロールし、見出しの行は上に残る) */
  function fitListHeight() {
    var box = document.querySelector('#tab-imports .listbox'); if (!box || !box.isConnected) return;
    box.style.maxHeight = Math.max(240, window.innerHeight - box.getBoundingClientRect().top - 16) + 'px';
  }
  window.addEventListener('resize', fitListHeight);

  /** 入力欄の幅を、その列(同じ列の入力欄)でいちばん長い中身に合わせる。全角は1文字=1em、半角は0.6em。左右の余白は同じ。空欄でも3em */
  function textEm(v) { var w = 0; String(v || '').split('').forEach(function (c) { w += c.charCodeAt(0) > 0xff ? 1 : 0.6; }); return w; }
  function fitInput(inp) {
    var td = inp.closest('td'), table = inp.closest('table');
    var list = [inp];
    if (td && table) { var col = td.cellIndex; list = Array.prototype.slice.call(table.querySelectorAll('tbody tr')).map(function (tr) { return tr.cells[col] && tr.cells[col].querySelector('input'); }).filter(Boolean); }
    var w = Math.max.apply(null, list.map(function (x) { return textEm(x.value || x.placeholder); }));
    var css = 'calc(' + Math.max(3, w + 1.2).toFixed(1) + 'em + 12px)';
    list.forEach(function (x) { x.style.width = css; });
  }
  /** 表の中の入力欄・リストの幅を、列ごとにそろえる(表を画面に出したあとに呼ぶ) */
  function fitTableControls(table) {
    table.querySelectorAll('tbody tr:first-child input').forEach(fitInput);
    var heads = table.querySelectorAll('tbody tr:first-child select');
    heads.forEach(function (s0) {
      var col = s0.closest('td').cellIndex;
      var sels = Array.prototype.slice.call(table.querySelectorAll('tbody tr')).map(function (tr) { return tr.cells[col] && tr.cells[col].querySelector('select'); }).filter(Boolean);
      sels.forEach(function (x) { x.style.width = ''; });
      var w = Math.max.apply(null, sels.map(function (x) { return x.offsetWidth; }));
      if (w > 0) sels.forEach(function (x) { x.style.width = w + 'px'; });
    });
  }
  /** 取込一覧の1つのセルの編集用の入力欄。d=その行の編集中の内容。内容が変わったら onChange を呼ぶ */
  function importEditControl(k, d, onChange) {
    if (k === '現場名') { // 現場名(工事名)の欄で、工事を選び直せる。選ぶと、工事番号も合わせて保存する
      var ps = h('select', { 'aria-label': '現場名(工事名)' });
      ps.appendChild(h('option', { value: '', text: '(なし)' }));
      ps.appendChild(h('option', { value: OTHER, text: OTHER }));
      var found = d.工事番号 === '' || d.工事番号 === OTHER;
      S.projects.forEach(function (p) { if (p.工事番号 === d.工事番号) found = true; ps.appendChild(h('option', { value: p.工事番号, text: p.工事名 })); });
      if (!found) ps.appendChild(h('option', { value: d.工事番号, text: d.現場名 || d.工事番号 }));
      ps.value = d.工事番号;
      ps.addEventListener('change', function () { d.工事番号 = ps.value; d.現場名 = !ps.value ? '' : ps.value === OTHER ? OTHER : (L.projectName(S.projects, ps.value) || d.現場名); onChange(); });
      return ps;
    }
    if (k === '追加変更') {
      var ls = h('select', { 'aria-label': k });
      (IMPORT_LABELS.indexOf(d.追加変更) < 0 ? IMPORT_LABELS.concat([d.追加変更]) : IMPORT_LABELS).forEach(function (v) { ls.appendChild(h('option', { value: v, text: v || '(なし)' })); });
      ls.value = d.追加変更;
      ls.addEventListener('change', function () { d.追加変更 = ls.value; onChange(); });
      return ls;
    }
    if (k === '積日' || k === '卸日') { // m/d で表示・入力する(年は元の値の年。保存するのは 2026/10/20 の形)
      var year = (L.dateKey(d[k]) || L.dateKey(d.積日) || String(new Date().getFullYear())).slice(0, 4);
      var di = h('input', { value: importCellText(d, k), 'aria-label': k + '(m/d)', placeholder: 'm/d' });
      fitInput(di);
      di.addEventListener('input', function () { d[k] = L.normDate(di.value, +year) || di.value; fitInput(di); onChange(); });
      di.addEventListener('change', function () { if (L.dateKey(d[k])) di.value = importCellText(d, k); fitInput(di); onChange(); });
      return di;
    }
    var inp = h('input', { value: d[k], 'aria-label': k });
    fitInput(inp);
    inp.addEventListener('input', function () { d[k] = inp.value; fitInput(inp); onChange(); });
    inp.addEventListener('change', function () { var v = normField(k, inp.value); inp.value = v; d[k] = v; fitInput(inp); onChange(); });
    return inp;
  }

  // 原本(getFile)は、ファイルURLごとに1回だけ読み、覚えておく(2回目からはすぐ開く)。GASの1回の応答に3〜4秒かかるため(2026-10-23に実測)、
  // 取込一覧を出したら、表の上から原本を先に読み、行にマウスを乗せたときも読み始める
  var FAX_CACHE = {}; // ファイルURL → Promise<Blob>
  var FAX_PREFETCH = 10; // 取込一覧を出したときに先に読む原本の数(表の上から、違う原本を)
  function fetchFax(url) {
    if (!FAX_CACHE[url]) {
      FAX_CACHE[url] = apiGet('getFile', { url: url }).then(function (d) {
        var bin = atob(d.base64), bytes = new Uint8Array(bin.length);
        for (var i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
        return new Blob([bytes], { type: d.mime });
      });
      FAX_CACHE[url].catch(function () { delete FAX_CACHE[url]; }); // 失敗したものは覚えない(次に押したとき読み直す)
    }
    return FAX_CACHE[url];
  }
  var faxQueue = [], faxQueueBusy = 0;
  /** 表の上の行から、まだ読んでいない原本を2つずつ順に読む */
  function prefetchFaxes(list) {
    var seen = {};
    faxQueue = list.map(function (r) { return r.ファイルURL; }).filter(function (u) { if (!u || seen[u]) return false; seen[u] = 1; return true; })
      .slice(0, FAX_PREFETCH).filter(function (u) { return !FAX_CACHE[u]; }); // 上から10個の原本のうち、まだ読んでいないもの(描き直しのたびに先へ広げない)
    function next() {
      var u = faxQueue.shift(); if (!u) return;
      faxQueueBusy++;
      (FAX_CACHE[u] || fetchFax(u)).catch(function () {}).then(function () { faxQueueBusy--; next(); });
    }
    while (faxQueueBusy < 2 && faxQueue.length) next();
  }

  /** 取込一覧の行を押したとき: 表を、その行と同じ原本から記録した行だけに絞り(その場で編集できる)、下に原本(PDF・画像)を出す。
   *  何か編集すると「編集内容を保存」が出る。「すべての行に戻す」「画像を閉じる」で元の一覧に戻る(編集したままなら、破棄してよいか確認する)。
   *  画面(表・原本)は S.importsFile.el に1回だけ作り、取込一覧を描き直しても同じものを出す(原本のズーム・編集中の内容を保つ) */
  function openImportFile(r) {
    var same = r.ファイルURL ? (S.imports || []).filter(function (x) { return x.ファイルURL && x.ファイルURL === r.ファイルURL; }).slice().reverse() : [r];
    if (!same.some(function (x) { return x._row === r._row; })) same = [r];
    var cols = ['現場名', '手配業者', '積日', '卸日', '行先', '着時間', '運送業者', '車種', '車番', '氏名', '携帯番号', '追加変更', '備考'];
    var drafts = same.map(function (x) { var d = importDraftOf(x); return { row: x, d: d, orig: JSON.stringify(d) }; });
    function changed(e) { return JSON.stringify(e.d) !== e.orig; }
    function dirty() { return drafts.some(changed); }
    var status = h('span', { class: 'faxdlg-status' });
    var saveBtn = h('button', { class: 'btn sm save-edit', type: 'button', text: '編集内容を保存', onclick: function () { saveEdits(); } });
    saveBtn.style.display = 'none';
    function onChange() { saveBtn.style.display = dirty() ? '' : 'none'; if (dirty()) status.textContent = ''; }

    var thead = h('tr'); thead.appendChild(h('th', { class: 'c', text: '#' })); cols.forEach(function (k) { thead.appendChild(h('th', { class: 'c', text: k })); }); // 見出しは、どの列も中央揃え
    var tbody = h('tbody');
    drafts.forEach(function (e, i) {
      var tr = h('tr', { class: e.row._row === r._row ? 'hit' : null });
      tr.appendChild(h('td', { class: 'num', text: String(i + 1) }));
      cols.forEach(function (k) { tr.appendChild(h('td', { class: 'nowrap' + (k === '現場名' || k === '備考' ? '' : ' c') }, importEditControl(k, e.d, onChange))); }); // 現場名・備考は左揃え、他は中央揃え
      tbody.appendChild(tr);
    });
    var rowsTable = h('div', { class: 'scroll faxrows' }, h('table', { class: 't' }, h('thead', null, thead), tbody));
    var holder = h('div', { class: 'faxview' }, h('div', { class: 'reading-note', text: r.ファイルURL ? '原本を読み込んでいます…' : 'この記録には原本がありません(PDFで取り込んだ記録ではありません)。' }));
    var tool = h('div', { class: 'tool' }, h('button', { class: 'btn sm back-list', type: 'button', text: 'すべての行に戻す', onclick: function () { tryClose(); } }),
      h('strong', { class: 'file-name', text: importCellText(r, 'ファイル名') }), h('span', { class: 'sub', text: 'この原本から記録した' + drafts.length + '行(押した行は水色)。表の中で直せます' }),
      status, saveBtn);
    var paneHead = h('div', { class: 'faxpane-head' }, h('strong', { text: '原本: ' + importCellText(r, 'ファイル名') }), h('span', { class: 'spacer' }),
      h('button', { class: 'btn sm back-list', type: 'button', text: '画像を閉じる', onclick: function () { tryClose(); } }));
    var url = '';
    var el = h('div', { class: 'impfile' }, h('div', { class: 'imp-wrap' }, tool, rowsTable), h('div', { class: 'faxpane' }, paneHead, holder)); // 上の行と表は、取込一覧と同じく中央に置く
    var me = { el: el, fit: fitPane };
    S.importsFile = me;

    /** 原本の表示の高さを、画面の下端までにする */
    function fitPane() {
      if (!el.isConnected) return;
      if (!me.fitted) { fitTableControls(rowsTable.querySelector('table')); me.fitted = true; } // 画面に出してから、列ごとに幅をそろえる(1回だけ)
      var v = holder.querySelector('.viewer'); if (!v) return;
      v.style.height = Math.max(340, window.innerHeight - v.getBoundingClientRect().top - 16) + 'px';
    }
    async function tryClose() {
      if (dirty() && !(await confirmDialog('編集内容は破棄されますが閉じますか?', '保存していない編集内容は消えます。', 'OK'))) return;
      if (url) URL.revokeObjectURL(url);
      if (S.importsFile === me) S.importsFile = null;
      renderImports();
    }
    async function saveEdits() {
      var todo = drafts.filter(changed);
      for (var i = 0; i < todo.length; i++) {
        var d = todo[i].d;
        if (!String(d.車番).trim()) { status.textContent = '車番は空にできません。'; status.className = 'faxdlg-status err'; return; }
        if ((d.積日 && !L.dateKey(d.積日)) || (d.卸日 && !L.dateKey(d.卸日))) { status.textContent = '積日・卸日は 2026/10/20 の形で入力してください。'; status.className = 'faxdlg-status err'; return; }
      }
      var close = busyDialog('データ記録中');
      try {
        for (var j = 0; j < todo.length; j++) {
          var e = todo[j];
          await apiPost('updateImport', { row: e.row._row, before: L.recFields(e.row), data: e.d }, 60000);
          Object.keys(e.d).forEach(function (k) { e.row[k] = e.d[k]; });
          e.orig = JSON.stringify(e.d);
        }
        status.textContent = '保存しました(' + todo.length + '行)。'; status.className = 'faxdlg-status ok';
        saveBtn.style.display = 'none';
        loadInit(true).catch(function () {}); // 重複の判定などに使う最新の記録を読み直す(一覧の表は、戻したときに描き直す)
      } catch (err) { status.textContent = '保存に失敗しました: ' + err.message; status.className = 'faxdlg-status err'; }
      finally { close(); }
    }

    renderImports();
    window.scrollTo(0, 0);
    if (!r.ファイルURL) return;
    fetchFax(r.ファイルURL).then(function (blob) {
      if (S.importsFile !== me) return; // 読み込みの間に、一覧へ戻した
      url = URL.createObjectURL(blob);
      holder.textContent = '';
      holder.appendChild(TruckViewer.create(blob, blob.type, url));
      fitPane();
    }).catch(function (err) { holder.textContent = ''; holder.appendChild(h('div', { class: 'empty', text: '原本を開けませんでした: ' + err.message })); });
  }

  window.addEventListener('resize', function () { if (S.importsFile) S.importsFile.fit(); });

  function importRow(r) {
    var tr = h('tr', { class: 'pick' + (isBeforeRow(r) ? ' before' : '') }); // 行を押すと、その原本の行だけに絞り、下に原本を出す(ファイル名はリンクにしない)
    TABLE_HEADERS.forEach(function (k) { tr.appendChild(h('td', { class: 'nowrap' + (LEFT_COLS.indexOf(k) >= 0 ? '' : ' c') }, importCellText(r, k))); });
    tr.addEventListener('click', function () { openImportFile(r); });
    if (r.ファイルURL) { // マウスを0.15秒止めたら、押す前に原本を読み始める(表の上を通り過ぎただけの行は読まない)
      var hoverT = 0;
      tr.addEventListener('mouseenter', function () { hoverT = setTimeout(function () { fetchFax(r.ファイルURL).catch(function () {}); }, 150); });
      tr.addEventListener('mouseleave', function () { clearTimeout(hoverT); });
    }
    return tr;
  }

  /** スプレッドシートに記録されている取込一覧の全件(中止・変更前の行も、タイムスタンプ・ファイルURLの列も含む)を、記録した順にExcelでダウンロードする */
  async function downloadAllImports() {
    var close = busyDialog('全件を読み込み中');
    try {
      var all = await apiGet('listImports', { limit: 1000000 }); // 新しい順で、シートの全行
      var heads = IMPORT_HEADERS.concat(['ファイルURL']);
      var ordered = L.sortImportRows(all); // 取込一覧の「すべての締め月」と同じ並び(ファイルごと→卸日の早い順→大上→ナミツー→取込順。2026-10-26、ユーザー指示)
      var rows = ordered.map(function (r) { return heads.map(function (k) { return r[k] || ''; }); });
      close(); close = function () {};
      if (!rows.length) { toast('取込一覧に記録がありません。'); return; }
      downloadXlsx('過去全件一覧' + todayIso().replace(/-/g, '') + '.xlsx', '取込一覧', heads, rows, struckOf(ordered));
      toast('全件(' + rows.length + '件)をダウンロードしました。');
    } catch (e) { showBanner('全件の読み込みに失敗しました: ' + e.message); }
    finally { close(); }
  }

  function todayIso() { var n = new Date(); return n.getFullYear() + '-' + ('0' + (n.getMonth() + 1)).slice(-2) + '-' + ('0' + n.getDate()).slice(-2); }

  /** 年度・締め月を指定して、取込一覧の該当行をExcelでダウンロードする(中止・変更前の行も含める。中止でも請求があるため、数に入れる)。シートの全行を読み直して、締め月で選ぶ */
  async function openClosingDownload() {
    var now = new Date(), cur = L.closingOf(now.getFullYear(), now.getMonth() + 1, now.getDate());
    var fy0 = S.importsFy !== 'all' && S.importsFy != null ? S.importsFy : String(cur.fy), cm0 = S.importsCm !== 'all' && S.importsCm != null ? S.importsCm : String(cur.cm);
    var fySel = h('select', { 'aria-label': '年度' }), cmSel = h('select', { 'aria-label': '締め月' });
    function fillCm(want) { // 締め月のリストは、選んだ年度のデータのある月だけ。選んでいた月が無ければ、一番新しい月にする(データが全く無い年度は、want だけ)
      var ms = closingMonthsWithData(haveCl, fySel.value || fy0), pick = want;
      if (!ms.length) ms = [+want]; else if (ms.indexOf(+want) < 0) pick = String(ms[ms.length - 1]);
      cmSel.textContent = '';
      ms.forEach(function (m) { cmSel.appendChild(h('option', { value: String(m), text: m + '/20〆' })); });
      cmSel.value = pick;
    }
    var haveCl = {};
    L.CLOSING_MONTH_ORDER.forEach(function (m) { cmSel.appendChild(h('option', { value: String(m), text: m + '/20〆' })); }); // 読み込み前は全部(読み込み後に、データのある月だけにする)
    cmSel.value = cm0;
    function goCm(to) { fySel.value = String(to.fy); fillCm(String(to.cm)); refresh(); } // 移動先にはデータがあるので、その年度は年度のリストにある
    var prevBtn = cmStepButton(-1, '◀', '1か月前の締め月', goCm), nextBtn = cmStepButton(1, '▶', '1か月後の締め月', goCm);
    var info = h('p', { class: 'dlg-detail', text: '記録を読み込んでいます…' }), tableHost = h('div', { class: 'dlg-table' });
    var cancel = h('button', { class: 'btn', type: 'button', text: 'キャンセル' });
    var ok = h('button', { class: 'btn excel', type: 'button', text: 'この内容でExcelをダウンロード', disabled: true });
    var dlg = h('dialog', { class: 'dlg wide' }, h('p', { class: 'dlg-title' }, '締め月ダウンロード', h('span', { style: 'white-space:pre;color:#c62828;font-weight:700', text: '   卸日を基準として２０日〆期間判定とする' })), // タイトルの右に、スペース3つ+赤太字の注記(2026-10-26、ユーザー指示)
      h('div', { class: 'dlg-row' }, h('label', { text: '年度・締め月を選択:' }), fySel, h('span', { class: 'cm-nav' }, prevBtn, cmSel, nextBtn)), info, tableHost, h('div', { class: 'dlg-btns' }, cancel, ok));
    var all = [], shown = [], open = true;
    function refresh() {
      var fy = fySel.value, cm = cmSel.value;
      prevBtn.update(fy, cm, haveCl); nextBtn.update(fy, cm, haveCl);
      shown = L.sortImportRows(all.filter(function (r) { var c = L.rowClosing(r); return c && String(c.fy) === fy && String(c.cm) === cm; })); // 取込一覧と同じ並び(画面の表もExcelも。2026-10-26、ユーザー指示)
      info.textContent = fy + '年度 ' + cm + '/20〆の記録: ' + shown.length + '件(中止・変更前の行も含みます)。この内容でよければダウンロードしてください。';
      tableHost.textContent = '';
      if (shown.length) {
        var head = h('tr'); VIEW_HEADERS.forEach(function (k) { head.appendChild(h('th', { text: k })); });
        var body = h('tbody');
        shown.forEach(function (r) { var tr = h('tr'); VIEW_HEADERS.forEach(function (k) { tr.appendChild(h('td', { class: 'nowrap', text: r[k] || '' })); }); body.appendChild(tr); });
        tableHost.appendChild(h('div', { class: 'scroll dlg-scroll' }, h('table', { class: 't zebra' }, h('thead', null, head), body)));
      } else tableHost.appendChild(h('div', { class: 'empty', text: 'この締め月の記録はありません。' }));
      ok.disabled = !shown.length;
    }
    fySel.addEventListener('change', function () { fillCm(cmSel.value); refresh(); }); cmSel.addEventListener('change', refresh);
    cancel.addEventListener('click', function () { dlg.close(); });
    ok.addEventListener('click', function () {
      if (!shown.length) return;
      downloadXlsx(cmSel.value + '月20日〆車番一覧.xlsx', '取込一覧', VIEW_HEADERS, shown.map(function (r) { return VIEW_HEADERS.map(function (k) { return r[k] || ''; }); }), struckOf(shown));
      dlg.close();
    });
    dlg.addEventListener('close', function () { open = false; dlg.remove(); });
    document.body.appendChild(dlg);
    dlg.showModal();
    try {
      all = (await apiGet('listImports', { limit: 1000000 })).slice().reverse(); // シートの全行を、記録した順に
      if (!open) return;
      var fys = {}; fys[cur.fy] = 1; fys[fy0] = 1;
      all.forEach(function (r) { var c = L.rowClosing(r); if (c) { fys[c.fy] = 1; haveCl[c.fy + '-' + c.cm] = 1; } });
      Object.keys(fys).sort(function (a, b) { return b - a; }).forEach(function (y) { fySel.appendChild(h('option', { value: y, text: y + '年度' })); });
      fySel.value = fy0;
      fillCm(cmSel.value);
      refresh();
    } catch (e) { if (open) info.textContent = '読み込めませんでした: ' + e.message; }
  }


  // ---------- 追加変更依頼(ヘッダーのボタン→「AIに変更指示」。GASがシート・Drive・メールへ回す。画面には「記録した」等は出さない) ----------
  var REQ_KINDS = ['新規ボタンの追加', '既存ボタンの修正', '既存ボタンの削除'];
  var REQ_BUTTONS = ['全件ダウンロード', '締め月ダウンロード', '積日指定でダウンロード', 'Excelでダウンロード(車両・運転手情報)']; // 変更するときは、GAS(Code.gs)の REQUEST_BUTTONS も同じにする
  function openChangeRequest() {
    var kindBoxes = REQ_KINDS.map(function (k) { return h('label', { class: 'opt' }, h('input', { type: 'radio', name: 'reqKind', value: k }), ' ' + k); });
    var btnSel = h('select', null, h('option', { value: '', text: '選んでください' }), REQ_BUTTONS.map(function (b) { return h('option', { value: b, text: b }); }));
    var btnWrap = h('div', { hidden: true }, h('label', { class: 'f', text: '対象のボタン' }), btnSel);
    var content = h('textarea', { placeholder: 'どう変えたいか、今困っていることを書いてください' });
    var file = h('input', { type: 'file' });
    var nameIn = h('input', { type: 'text', maxlength: '50' });
    var msg = h('p', { class: 'bad', hidden: true });
    var cancel = h('button', { class: 'btn', type: 'button', text: 'キャンセル' });
    var send = h('button', { class: 'btn primary', type: 'button', text: 'AIに変更指示' });
    var dlg = h('dialog', { class: 'dlg req-form', style: 'width:min(92vw,520px)' },
      h('p', { class: 'dlg-title', text: 'AIに変更指示' }),
      h('p', { class: 'dlg-detail', text: '④のExcelダウンロードなど、アプリの追加・変更したい点を教えてください。' }),
      h('label', { class: 'f', text: '依頼の種類' }), kindBoxes, btnWrap,
      h('label', { class: 'f', text: '内容' }), content,
      h('label', { class: 'f', text: '集計したExcelなどの資料(あれば1ファイル・10MBまで)' }), file,
      h('label', { class: 'f', text: 'お名前(任意)' }), nameIn, h('p', { class: 'note', text: '※匿名の場合は、内容を充実させてください' }),
      msg, h('div', { class: 'dlg-btns', style: 'margin-top:14px' }, cancel, send));
    function kind() { var c = dlg.querySelector('input[name=reqKind]:checked'); return c ? c.value : ''; }
    function syncKind() { btnWrap.hidden = !(kind() === REQ_KINDS[1] || kind() === REQ_KINDS[2]); }
    kindBoxes.forEach(function (l) { l.firstChild.addEventListener('change', syncKind); });
    function fail(t) { msg.textContent = t; msg.hidden = false; }
    cancel.addEventListener('click', function () { dlg.close(); });
    dlg.addEventListener('close', function () { dlg.remove(); });
    send.addEventListener('click', async function () {
      msg.hidden = true;
      var k = kind();
      if (!k) return fail('依頼の種類を選んでください。');
      if (k !== REQ_KINDS[0] && !btnSel.value) return fail('対象のボタンを選んでください。');
      if (!content.value.trim()) return fail('内容を入力してください。');
      var f = file.files[0];
      if (f && f.size > MAX_BYTES) return fail('ファイルは10MB以内にしてください。');
      send.disabled = true; cancel.disabled = true; send.textContent = '送信中…';
      try {
        var payload = { kind: k, button: k === REQ_KINDS[0] ? '' : btnSel.value, content: content.value, name: nameIn.value };
        if (f) { payload.filename = f.name; payload.fileMime = f.type || 'application/octet-stream'; payload.fileBase64 = await fileToBase64(f); }
        await apiPost('changeRequest', payload, 120000);
        dlg.close();
        var done = h('dialog', { class: 'dlg' }, h('p', { class: 'dlg-detail', text: 'アプリの追加変更対応は、数日必要な場合があります' }),
          h('div', { class: 'dlg-btns' }, h('button', { class: 'btn primary', type: 'button', text: 'OK', onclick: function () { done.close(); } })));
        done.addEventListener('close', function () { done.remove(); });
        document.body.appendChild(done); done.showModal();
      } catch (e) {
        fail(e.message || '送信できませんでした。もう一度お試しください。');
        send.disabled = false; cancel.disabled = false; send.textContent = 'AIに変更指示';
      }
    });
    document.body.appendChild(dlg); dlg.showModal();
  }

  /** 積日を指定して、取込一覧の該当行をExcelでダウンロードする。①ボタン→②日付を選ぶ→③表で確認→④OKでダウンロード */
  function openDateDownload() {
    var input = h('input', { type: 'date', value: todayIso(), 'aria-label': '積日' });
    var info = h('p', { class: 'dlg-detail' }), tableHost = h('div', { class: 'dlg-table' });
    var cancel = h('button', { class: 'btn', type: 'button', text: 'キャンセル' });
    var ok = h('button', { class: 'btn excel', type: 'button', text: 'この内容でExcelをダウンロード' });
    // 積日の左右に ◀▶(記録のある、前・後ろの日へ移動。記録の無い日は選ばれない。前後に記録が無いときはグレーで押せない)
    function recordDays() { var set = {}; all.forEach(function (r) { var k = L.dateKey(r.積日); if (k) set[k] = true; }); return Object.keys(set).sort(); }
    function neighborDay(delta) {
      var key = input.value; if (!key) return null;
      var days = recordDays();
      if (delta < 0) { for (var i = days.length - 1; i >= 0; i--) if (days[i] < key) return days[i]; }
      else { for (var j = 0; j < days.length; j++) if (days[j] > key) return days[j]; }
      return null;
    }
    function stepDay(delta) { var to = neighborDay(delta); if (to) { input.value = to; refresh(); } }
    var prevBtn = h('button', { class: 'btn sm cm-step', type: 'button', text: '◀', 'aria-label': '前の記録のある積日', disabled: true, onclick: function () { stepDay(-1); } });
    var nextBtn = h('button', { class: 'btn sm cm-step', type: 'button', text: '▶', 'aria-label': '次の記録のある積日', disabled: true, onclick: function () { stepDay(1); } });
    var dlg = h('dialog', { class: 'dlg wide' }, h('p', { class: 'dlg-title', text: '積日指定でダウンロード' }),
      h('div', { class: 'dlg-row' }, h('label', { text: '積日を選択:' }), h('span', { class: 'cm-nav' }, prevBtn, input, nextBtn)), info, tableHost, h('div', { class: 'dlg-btns' }, cancel, ok));
    var cur = [], all = [], loaded = false;
    function refresh() {
      var key = input.value;
      if (!loaded) { info.textContent = '記録を読み込んでいます…'; ok.disabled = true; return; }
      cur = key ? L.sortImportRows(all.filter(function (r) { return L.dateKey(r.積日) === key; })) : []; // 取込一覧と同じ並び(画面の表もExcelも。2026-10-26、ユーザー指示)
      var pt = neighborDay(-1), nt = neighborDay(1);
      prevBtn.disabled = !pt; nextBtn.disabled = !nt;
      prevBtn.title = pt ? pt.replace(/-/g, '/') + ' へ' : '前に記録のある日はありません'; nextBtn.title = nt ? nt.replace(/-/g, '/') + ' へ' : '後ろに記録のある日はありません';
      info.textContent = !key ? '積日を選んでください。' : (cur.length ? '積日 ' + key.replace(/-/g, '/') + ' の記録: ' + cur.length + '件(中止・変更前の行も含みます)。この内容でよければダウンロードしてください。' : '積日 ' + key.replace(/-/g, '/') + ' の記録: 0件');
      tableHost.textContent = '';
      if (cur.length) {
        var head = h('tr'); VIEW_HEADERS.forEach(function (k) { head.appendChild(h('th', { text: k })); });
        var body = h('tbody');
        cur.forEach(function (r) { var tr = h('tr'); VIEW_HEADERS.forEach(function (k) { tr.appendChild(h('td', { class: 'nowrap', text: r[k] || '' })); }); body.appendChild(tr); });
        tableHost.appendChild(h('div', { class: 'scroll dlg-scroll' }, h('table', { class: 't zebra' }, h('thead', null, head), body)));
      } else if (key) tableHost.appendChild(h('div', { class: 'empty', style: 'color:#b3261e;font-weight:700', text: '輸送記録がありません' }));
      ok.disabled = !cur.length;
    }
    input.addEventListener('change', refresh);
    cancel.addEventListener('click', function () { dlg.close(); });
    ok.addEventListener('click', function () {
      if (!cur.length) return;
      downloadXlsx((+input.value.slice(5, 7)) + '月' + (+input.value.slice(8, 10)) + '日積車番一覧.xlsx', '取込一覧', VIEW_HEADERS, cur.map(function (r) { return VIEW_HEADERS.map(function (k) { return r[k] || ''; }); }), struckOf(cur));
      dlg.close();
    });
    dlg.addEventListener('close', function () { dlg.remove(); });
    document.body.appendChild(dlg);
    refresh();
    dlg.showModal();
    apiGet('listImports', { limit: 1000000 }).then(function (d) { all = d.slice().reverse(); loaded = true; if (dlg.isConnected) refresh(); }) // シートの全行から選ぶ(古い積日も出る)
      .catch(function (e) { if (dlg.isConnected) info.textContent = '読み込めませんでした: ' + e.message; });
  }

  // ---------- 車両・運転手情報の表と編集(シート「車両運転手情報」。1行=車と運転手の1組) ----------
  function normPair(d) {
    var o = {};
    PAIR_COLS.forEach(function (k) { o[k] = String(d[k] == null ? '' : d[k]).trim(); });
    o.車番 = L.fmtPlate(o.車番); o.車種 = L.fmtType(o.車種); o.氏名 = L.nameKey(o.氏名); o.携帯番号 = L.fmtPhone(o.携帯番号);
    return o;
  }
  /** 編集した行が、他の行と「同じ車・同じ運転手」の重複になるときの注意文(無ければ '') */
  function pairDupMessage(d, selfRow) {
    var p = L.phoneDigits(d.携帯番号), n = L.nameKey(d.氏名);
    var hit = S.pairs.some(function (r) {
      if (r._row === selfRow || L.plateKey(r.車番) !== L.plateKey(d.車番)) return false;
      var rp = L.phoneDigits(r.携帯番号);
      return p && rp ? p === rp : (L.nameKey(r.氏名) === n);
    });
    return hit ? '同じ車番・同じ運転手の行が、既にあります。' : '';
  }
  async function savePair(mode, row, before, data) {
    try {
      await apiPost('masterSave', { kind: 'pair', mode: mode, row: row, before: before, data: data });
      if (mode === 'update') { var r = S.pairs.filter(function (x) { return x._row === row; })[0]; if (r) Object.keys(data).forEach(function (k) { r[k] = data[k]; }); }
      else { S.pairs = S.pairs.filter(function (x) { return x._row !== row; }); S.pairs.forEach(function (x) { if (x._row > row) x._row--; }); } // 行を削除すると、下の行の番号が1つ上がる
      S.editing = null; renderPairs(); showBanner(''); // 保存した内容は、その場で表に反映し、照合用の一覧などは裏で読み直す
      reloadInit();
    } catch (e) { showBanner('保存に失敗しました: ' + e.message); }
  }

  /** 画面中央のポップアップでお知らせする(OKボタンで閉じる) */
  function noticeDialog(message) {
    var dlg = h('dialog', { class: 'dlg' }, h('p', { class: 'dlg-title', text: message }),
      h('div', { class: 'dlg-btns' }, h('button', { class: 'btn primary', type: 'button', text: 'OK', onclick: function () { dlg.close(); } })));
    dlg.addEventListener('close', function () { dlg.remove(); });
    document.body.appendChild(dlg);
    dlg.showModal();
  }

  /** 画面中央のポップアップで確認する(ブラウザ標準の確認ダイアログは使わない)。OKならtrue */
  function confirmDialog(title, detail, okText) {
    return new Promise(function (resolve) {
      var dlg = h('dialog', { class: 'dlg' },
        h('p', { class: 'dlg-title', text: title }),
        h('p', { class: 'dlg-detail', text: detail }),
        h('div', { class: 'dlg-btns' },
          h('button', { class: 'btn', type: 'button', text: 'キャンセル', onclick: function () { dlg.close('no'); } }),
          h('button', { class: 'btn del', type: 'button', text: okText || 'OK', onclick: function () { dlg.close('yes'); } })));
      dlg.addEventListener('close', function () { var yes = dlg.returnValue === 'yes'; dlg.remove(); resolve(yes); });
      document.body.appendChild(dlg);
      dlg.showModal();
    });
  }

  /** 備考に、手配業者の名前が2つ以上ある(「大上/ナミツー」=同じ車・運転手を、別の手配業者も手配した)か。その場合だけ、備考を赤太文字で出す */
  function isDualNote(note) {
    var t = L.nameKey(note);
    return S.senders.filter(function (c) { return t.indexOf(L.nameKey(c)) >= 0; }).length >= 2;
  }

  function renderPairs() {
    var host = $('tab-pairs');
    host.textContent = '';
    var cols = PAIR_COLS;
    var rows = L.sortPairs(S.pairs); // 手配業者(大上→ナミツー→その他)→運送業者→車種(4t→10t→15t→TR→その他)→車番→氏名の順(表示だけで、シートの行順は変えない)
    var wrap = h('div', { class: 'pairs-wrap' }); // 表の幅は中身に合わせ、画面の中央に置く(見出しの行・表とも同じ幅)
    host.appendChild(wrap);
    wrap.appendChild(h('div', { class: 'tool' }, h('span', { class: 'sub', text: rows.length + '件(1行=車と運転手の1組。同じ車に別の運転手、同じ運転手が別の車に乗る場合は、別の行)' }), h('span', { class: 'spacer' }),
      h('button', { class: 'btn sm excel', type: 'button', text: 'Excelでダウンロード', onclick: function () {
        downloadXlsx('車両運転手情報_' + todayIso().replace(/-/g, '') + '.xlsx', '車両運転手情報', cols, rows.map(function (r) { return cols.map(function (k) { return r[k] || ''; }); }));
      } })));
    var head = h('tr'); cols.forEach(function (k) { head.appendChild(h('th', { text: k })); }); head.appendChild(h('th', { text: '操作' }));
    var body = h('tbody');
    function rowColor(r) { var rk = L.senderRank(r.手配業者); return rk === 0 ? '#dff3e0' : (rk === 1 ? '#fff7cc' : ''); } // 行の色: 手配業者(大上=薄い緑・ナミツー=薄い黄)
    rows.forEach(function (r) {
      var editing = S.editing === r._row; // 編集中の行(シートの行番号)
      var tr = h('tr', { style: rowColor(r) ? 'background:' + rowColor(r) : null });
      function beforeOf() { var before = {}; cols.forEach(function (k) { before[k] = r[k] || ''; }); return before; }
      if (editing) {
        var inputs = {};
        cols.forEach(function (k) { inputs[k] = h('input', { value: r[k] || '', 'aria-label': k }); tr.appendChild(h('td', null, inputs[k])); });
        tr.appendChild(h('td', { class: 'nowrap' },
          h('button', { class: 'btn sm primary', type: 'button', text: '保存', onclick: async function () {
            var d = normPair(Object.fromEntries(cols.map(function (k) { return [k, inputs[k].value]; })));
            if (!d.車番 && !d.氏名 && !d.携帯番号) { showBanner('車番か、氏名・携帯番号のどちらかは必要です。'); return; }
            var dm = pairDupMessage(d, r._row);
            if (dm && !(await confirmDialog(dm, 'それでも保存しますか?', '保存する'))) return;
            savePair('update', r._row, beforeOf(), d);
          } }), ' ',
          h('button', { class: 'btn sm', type: 'button', text: '取消', onclick: function () { S.editing = null; renderPairs(); } })));
      } else {
        cols.forEach(function (k) { tr.appendChild(h('td', { class: 'nowrap' + (k === '備考' && isDualNote(r[k]) ? ' dual' : ''), text: r[k] || '' })); });
        tr.appendChild(h('td', { class: 'nowrap' },
          h('button', { class: 'btn sm edit', type: 'button', text: '編集', onclick: function () { S.editing = r._row; renderPairs(); } }), ' ',
          h('button', { class: 'btn sm del', type: 'button', text: '削除', onclick: function () {
            confirmDialog('この行を削除しますか?', cols.map(function (k) { return r[k]; }).filter(Boolean).join(' / '), '削除する').then(function (yes) { if (yes) savePair('delete', r._row, beforeOf(), null); });
          } })));
      }
      body.appendChild(tr);
    });
    wrap.appendChild(h('div', { class: 'scroll' }, h('table', { class: 't pairs' }, h('thead', null, head), body)));
    if (!rows.length) wrap.appendChild(h('div', { class: 'empty', text: 'まだ登録がありません。FAXを取り込むと、車と運転手の組み合わせが自動で登録されます。' }));
  }

  // ---------- 起動 ----------
  function wireDrop() {
    var input = $('file'), depth = 0;
    function hasFiles(e) { return !!(e.dataTransfer && Array.prototype.indexOf.call(e.dataTransfer.types || [], 'Files') >= 0); }
    // 画面内のどこにドロップしてもよい(ブラウザがファイルを開いてしまわないよう、画面全体で受ける)
    document.addEventListener('dragenter', function (e) { if (hasFiles(e)) { depth++; document.body.classList.add('dragging'); } });
    document.addEventListener('dragleave', function (e) { if (hasFiles(e) && --depth <= 0) { depth = 0; document.body.classList.remove('dragging'); } });
    document.addEventListener('dragover', function (e) { if (hasFiles(e)) e.preventDefault(); });
    document.addEventListener('drop', function (e) {
      if (!hasFiles(e)) return;
      e.preventDefault(); depth = 0; document.body.classList.remove('dragging');
      if (e.dataTransfer.files.length) { showTab('import'); addFiles(e.dataTransfer.files); }
    });
    input.addEventListener('change', function () { if (input.files.length) addFiles(input.files); input.value = ''; });
    $('drop').addEventListener('keydown', function (e) { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); input.click(); } });
  }

  async function start() {
    document.querySelectorAll('#tabs button').forEach(function (b) { b.addEventListener('click', function () { showTab(b.dataset.tab); }); });
    wireDrop();
    if (!gasUrl()) {
      ['import', 'imports', 'pairs'].forEach(function (x) { $('tab-' + x).hidden = true; });
      $('tabs').hidden = true; $('setup').hidden = false; return;
    }
    var rb = $('reqBtn'); if (rb) rb.addEventListener('click', openChangeRequest);
    logStart();
    // 起動時は、スプレッドシートのデータを読み終わるまで、ポップアップとデータバーを出して他の操作を止める。取込一覧は、初期データと同時に先読みする
    var close = busyDialog('データ読み込み中');
    var preload = loadImports(); preload.catch(function () {});
    try { await Promise.all([loadInit(true), preload.catch(function () { return null; })]); } // 取込一覧だけ失敗したときは、タブを開いたときに改めて読み込む
    catch (e) { showBanner('スプレッドシートの読み込みに失敗しました: ' + e.message + '(GASのURL・公開設定を確認してください)'); }
    finally { close(); }
  }
  start();
})();
