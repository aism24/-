/* 車番連絡 取込 - 画面。表示はすべてテーブル。照合ロジックは logic.js(TruckLogic)。 */
(function () {
  'use strict';
  var L = window.TruckLogic;

  // デプロイ済みGAS WebアプリのURL(/exec で終わるURL)。デプロイ後にここへ設定する。
  var GAS_API_URL = 'https://script.google.com/macros/s/AKfycbyfyFEJn4alzJGmbWIhKwKeRvJ2OlkgyM4wZFk7ldUVCs5Yx-khi5FOWLen6cvvIYQ/exec';
  function gasUrl() { return window.__GAS_URL__ || GAS_API_URL; }

  var IMPORT_HEADERS = ['タイムスタンプ', 'ファイル名', '工事番号', '現場名', '手配業者', '積日', '卸日', '行先', '着時間', '運送業者', '車種', '車番', '氏名', '携帯番号'];
  var MASTER_COLS = { vehicle: ['手配業者', '運送業者', '車種', '車番'], driver: ['運送業者', '氏名', '携帯番号'] };
  var MAX_BYTES = 10 * 1024 * 1024;

  var S = { vehicles: [], drivers: [], projects: [], importKeyList: [], destMap: {}, model: '', keyOk: false, cards: [], tab: 'import',
    imports: null, importsQ: '', q: { vehicle: '', driver: '' }, editing: null };
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

  async function loadInit() {
    var d = await apiGet('init');
    S.vehicles = d.vehicles || []; S.drivers = d.drivers || []; S.projects = d.projects || [];
    S.importKeyList = (d.importKeys || []).map(function (r) { return L.importKey({ 積日: r.積日, 車番: r.車番 }); });
    S.destMap = L.buildDestMap(d.pastDest || []);
    S.model = d.model || ''; S.keyOk = !!d.keyOk; S.version = d.version || '(古い版)';
    S.imports = null;
    renderStatus(); renderTabs();
  }

  function renderStatus() {
    var el = $('status');
    var ok = S.model && S.keyOk;
    el.textContent = 'モデル: ' + (S.model || '(未設定)') + ' ・ APIキー: ' + (S.keyOk ? '設定済み' : '未設定') + ' ・ GAS版: ' + S.version;
    el.className = 'status' + (ok ? '' : ' bad');
  }

  // ---------- タブ ----------
  function dupCount(kind) {
    var d = L.findMasterDups(S.vehicles, S.drivers);
    if (kind === 'vehicle') return Object.keys(d.vehiclePlate).length;
    return Object.keys(d.driverName).length + Object.keys(d.driverPhone).length;
  }
  function renderTabs() {
    var labels = { import: '① 取込', imports: '取込一覧', vehicles: '車両情報', drivers: '運転手' };
    var vd = dupCount('vehicle'), dd = dupCount('driver');
    document.querySelectorAll('#tabs button').forEach(function (b) {
      var t = b.dataset.tab, extra = '';
      if (t === 'vehicles' && vd) extra = '(重複' + vd + ')';
      if (t === 'drivers' && dd) extra = '(重複' + dd + ')';
      b.textContent = labels[t] + extra;
      b.classList.toggle('on', t === S.tab);
    });
  }
  function showTab(t) {
    S.tab = t;
    ['import', 'imports', 'vehicles', 'drivers'].forEach(function (x) { $('tab-' + x).hidden = x !== t; });
    renderTabs();
    if (t === 'imports') renderImports();
    if (t === 'vehicles') renderMaster('vehicle');
    if (t === 'drivers') renderMaster('driver');
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

  function addFiles(files) {
    Array.prototype.forEach.call(files, function (file) {
      var card = { id: ++seq, file: file, name: file.name, mime: file.type || 'application/pdf', status: 'reading', rows: [], decisions: [], findings: [], warnings: [], msg: '', url: '', showPreview: false, busy: false };
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
      var b64 = await fileToBase64(card.file);
      var d = await apiPost('ocr', { filename: card.name, mimeType: card.mime, base64: b64 }, 180000);
      var res = L.sanitizeOcr(d.raw, { today: new Date() });
      card.warnings = res.warnings; card.rows = res.rows; card.model = d.model;
      card.rows.forEach(applyProjectDefault);
      card.decisions = card.rows.map(function () { return {}; });
      card.status = 'ready';
      evalCard(card);
    } catch (e) { card.status = 'error'; card.msg = e.message; }
    renderCard(card);
  }

  /** 行先から、過去に選んだ工事を初期値にする(②)。 */
  function applyProjectDefault(row) {
    if (row.工事番号 && !row._suggest) return;
    var s = L.suggestProject(S.destMap, row.行先);
    if (s) { row.工事番号 = s.工事番号; row.現場名 = L.projectName(S.projects, s.工事番号) || s.現場名; row._suggest = true; }
    else { row.工事番号 = ''; row.現場名 = ''; row._suggest = false; }
  }

  function ctx() { return { vehicles: S.vehicles, drivers: S.drivers, importKeys: S.importKeyList }; }
  function evalCard(card) { card.findings = L.evaluateBatch(card.rows, ctx()); }

  function results(card) {
    return card.rows.map(function (r, i) { return L.resolveRow(r, card.findings[i] || [], card.decisions[i] || {}); });
  }

  var FIELDS = [
    ['業者', '手配業者', 'w-co'], ['積日', '積日', 'w-date'], ['卸日', '卸日', 'w-date'], ['行先', '行先', 'w-dest'], ['着時間', '着時間', 'w-time'],
    ['運送業者', '運送業者', 'w-co'], ['車種', '車種', 'w-type'], ['車番', '車番', 'w-plate'], ['氏名', '氏名', 'w-name'], ['携帯番号', '携帯番号', 'w-tel']
  ];

  function projectSelect(card, row) {
    var sel = h('select', { class: 'w-no', 'aria-label': '工事番号' });
    sel.appendChild(h('option', { value: '', text: '(選択してください)' }));
    var found = false;
    S.projects.forEach(function (p) {
      if (p.工事番号 === row.工事番号) found = true;
      sel.appendChild(h('option', { value: p.工事番号, text: p.工事番号 + '  ' + p.工事名 }));
    });
    if (row.工事番号 && !found) sel.appendChild(h('option', { value: row.工事番号, text: row.工事番号 + '  ' + (row.現場名 || '') }));
    sel.value = row.工事番号 || '';
    sel.addEventListener('change', function () {
      row.工事番号 = sel.value; row._suggest = false;
      row.現場名 = L.projectName(S.projects, row.工事番号);
      if (row.工事番号) card.rows.forEach(function (o) {
        if (o !== row && !o.工事番号 && L.nameKey(o.行先) === L.nameKey(row.行先)) { o.工事番号 = row.工事番号; o.現場名 = row.現場名; o._suggest = false; }
      });
      evalCard(card);
      renderCard(card, true);
    });
    return sel;
  }

  function rowsTable(card) {
    var head = h('tr', null, h('th', { text: '#' }), h('th', { text: '工事番号' }), h('th', { text: '現場名' }));
    FIELDS.forEach(function (f) { head.appendChild(h('th', { text: f[1] })); });
    head.appendChild(h('th', { text: '' }));
    var body = h('tbody');
    card.rows.forEach(function (row, i) {
      var tr = h('tr');
      tr.appendChild(h('td', { class: 'num', text: String(i + 1) }));
      tr.appendChild(h('td', null, projectSelect(card, row), row._suggest ? h('div', { class: 'sug', text: '過去と同じ工事を選択' }) : null));
      tr.appendChild(h('td', { class: 'w-site', text: row.現場名 || '' }));
      FIELDS.forEach(function (f) {
        var inp = h('input', { value: row[f[0]] || '', class: f[2], 'aria-label': f[1] });
        inp.addEventListener('input', function () { row[f[0]] = inp.value; scheduleEval(card); });
        inp.addEventListener('change', function () {
          var v = inp.value;
          if (f[0] === '車番') v = L.fmtPlate(v);
          if (f[0] === '氏名') v = L.nameKey(v);
          if (f[0] === '携帯番号') v = L.fmtPhone(v);
          if (f[0] === '積日' || f[0] === '卸日') v = L.normDate(v, new Date().getFullYear()) || v;
          if (f[0] === '着時間') v = L.normTime(v);
          inp.value = v; row[f[0]] = v;
          if (f[0] === '行先') { applyProjectDefault(row); evalCard(card); renderCard(card, true); return; }
          scheduleEval(card, true);
        });
        tr.appendChild(h('td', null, inp));
      });
      tr.appendChild(h('td', null, h('button', { class: 'btn sm', type: 'button', text: '行を削除', onclick: function () {
        card.rows.splice(i, 1); card.decisions.splice(i, 1); evalCard(card); renderCard(card, true);
      } })));
      body.appendChild(tr);
    });
    return h('div', { class: 'scroll' }, h('table', { class: 't' }, h('thead', null, head), body));
  }

  var LEVEL = { error: '要修正', warn: '要確認', info: '自動' };
  function findingsTable(card) {
    var body = h('tbody'), n = 0;
    card.findings.forEach(function (fs, i) {
      fs.forEach(function (f) {
        n++;
        var cur = card.decisions[i] && card.decisions[i][f.id] != null ? card.decisions[i][f.id] : f.defaultValue;
        var act;
        if (f.level === 'error') act = h('span', { text: '表の入力を修正してください' });
        else {
          act = h('select', { 'aria-label': '対応' });
          if (cur == null) act.appendChild(h('option', { value: '', text: '(選択してください)' }));
          f.options.forEach(function (o) { act.appendChild(h('option', { value: o.value, text: o.label })); });
          act.value = cur == null ? '' : cur;
          act.addEventListener('change', function () { card.decisions[i][f.id] = act.value || null; renderFoot(card); });
        }
        body.appendChild(h('tr', null,
          h('td', { class: 'num', text: String(i + 1) }),
          h('td', { class: 'nowrap' }, h('span', { class: 'badge ' + f.level, text: LEVEL[f.level] })),
          h('td', { class: 'pre' }, h('strong', { text: f.title }), f.detail ? '\n' + f.detail : ''),
          h('td', null, act)));
      });
    });
    if (!n) return h('div', { class: 'empty', text: '指摘はありません。内容を確認して記録できます。' });
    return h('div', { class: 'scroll' }, h('table', { class: 't' },
      h('thead', null, h('tr', null, h('th', { text: '行' }), h('th', { text: '区分' }), h('th', { text: '内容' }), h('th', { text: '対応' }))), body));
  }

  var evalTimer = null;
  function scheduleEval(card, immediate) {
    clearTimeout(evalTimer);
    evalTimer = setTimeout(function () { evalCard(card); renderFindings(card); renderFoot(card); }, immediate ? 0 : 300);
  }

  function renderCard(card, keepPreview) {
    var el = card.el;
    el.textContent = '';
    var chip = { reading: ['読み取り中…', 'chip'], ready: ['確認待ち', 'chip'], saved: ['記録済み', 'chip ok'], error: ['エラー', 'chip bad'] }[card.status];
    var head = h('div', { class: 'card-head' }, h('span', { class: 'name', text: card.name }), h('span', { class: chip[1], text: chip[0] }), h('span', { class: 'spacer' }));
    if (card.url) head.appendChild(h('button', { class: 'btn sm', type: 'button', text: card.showPreview ? '原本を閉じる' : '原本を見る', onclick: function () { card.showPreview = !card.showPreview; renderCard(card); } }));
    head.appendChild(h('button', { class: 'btn sm', type: 'button', text: '閉じる', onclick: function () { S.cards = S.cards.filter(function (c) { return c !== card; }); el.remove(); } }));
    el.appendChild(head);
    if (card.showPreview && card.url) {
      el.appendChild(h('div', { class: 'preview' }, card.mime === 'application/pdf' ? h('iframe', { src: card.url, title: '原本' }) : h('img', { src: card.url, alt: '原本' })));
    }
    if (card.status === 'reading') { el.appendChild(h('div', { class: 'empty', text: 'FAXの内容を読み取っています(10〜30秒ほどかかります)…' })); return; }
    if (card.status === 'error') {
      el.appendChild(h('div', { class: 'foot' }, h('span', { class: 'msg bad', text: card.msg }),
        card.url ? h('button', { class: 'btn', type: 'button', text: 'もう一度読み取る', onclick: function () { extract(card); } }) : null));
      return;
    }
    if (card.status === 'saved') { el.appendChild(h('div', { class: 'foot' }, h('span', { class: 'msg', text: card.msg }))); return; }
    card.warnings.forEach(function (w) { el.appendChild(h('div', { class: 'foot' }, h('span', { class: 'badge warn', text: '注意' }), h('span', { class: 'msg', text: w }))); });
    el.appendChild(h('div', { class: 'sub-h', text: '読み取り結果(間違いがあれば表の中で直せます)' }));
    card.rowsHost = h('div'); card.rowsHost.appendChild(rowsTable(card)); el.appendChild(card.rowsHost);
    el.appendChild(h('div', { class: 'sub-h', text: 'マスタとの照合・確認事項' }));
    card.findHost = h('div'); el.appendChild(card.findHost);
    card.footHost = h('div'); el.appendChild(card.footHost);
    renderFindings(card); renderFoot(card);
  }
  function renderFindings(card) { if (!card.findHost) return; card.findHost.textContent = ''; card.findHost.appendChild(findingsTable(card)); }

  function renderFoot(card) {
    if (!card.footHost) return;
    var rs = results(card);
    var blockers = 0, keep = 0;
    rs.forEach(function (r) { blockers += r.blockers.length; if (!r.skip) keep++; });
    var host = card.footHost; host.textContent = '';
    var btn = h('button', { class: 'btn primary', type: 'button', text: keep + '件を記録する', disabled: blockers > 0 || keep === 0 || card.busy, onclick: function () { commitCard(card); } });
    var todo = [];
    rs.forEach(function (r, i) {
      r.blockers.forEach(function (id) {
        var f = (card.findings[i] || []).filter(function (x) { return x.id === id; })[0];
        todo.push((card.rows.length > 1 ? (i + 1) + '行目: ' : '') + (f ? f.title : id));
      });
    });
    var msg = blockers > 0 ? '記録するには、あと ' + blockers + ' 件の対応が必要です → ' + todo.slice(0, 3).join(' / ') + (todo.length > 3 ? ' ほか' : '') : (keep === 0 ? '記録する行がありません。' : '準備OKです。内容を確認して「記録する」を押してください。');
    host.appendChild(h('div', { class: 'foot' }, btn, h('span', { class: 'msg' + (blockers > 0 ? ' bad' : ' okmsg'), text: msg }),
      h('span', { class: 'spacer' }),
      h('button', { class: 'btn', type: 'button', text: '記録せず破棄', onclick: function () { S.cards = S.cards.filter(function (c) { return c !== card; }); card.el.remove(); } })));
  }

  async function commitCard(card) {
    var rs = results(card);
    var keep = rs.filter(function (r) { return !r.skip; });
    var ops = L.mergeOps(keep.map(function (r) { return r.ops; }));
    var rows = keep.map(function (r) { var o = {}; L.ROW_FIELDS.forEach(function (k) { o[k] = r.row[k] || ''; }); return o; });
    card.busy = true; renderFoot(card);
    try {
      await apiPost('commit', { filename: card.name, rows: rows, ops: ops }, 120000);
      var adds = ops.filter(function (o) { return o.mode === 'add'; }).length, ups = ops.length - adds;
      card.status = 'saved';
      card.msg = rows.length + '件を取込一覧に記録しました(マスタ: 新規' + adds + '件・更新' + ups + '件)。';
      await loadInit();
      S.cards.forEach(function (c) { if (c.status === 'ready') { evalCard(c); renderFindings(c); renderFoot(c); } });
    } catch (e) { card.busy = false; showBanner('記録に失敗しました: ' + e.message); renderFoot(card); return; }
    card.busy = false; showBanner(''); renderCard(card);
  }

  // ---------- 取込一覧(読み取り専用の表) ----------
  async function renderImports() {
    var host = $('tab-imports');
    if (S.imports == null) {
      host.textContent = '';
      host.appendChild(h('div', { class: 'empty', text: '読み込み中…' }));
      try { S.imports = await apiGet('listImports', { limit: 300 }); }
      catch (e) { host.textContent = ''; host.appendChild(h('div', { class: 'empty', text: '取得に失敗しました: ' + e.message })); return; }
    }
    host.textContent = '';
    var q = L.nameKey(S.importsQ).toLowerCase();
    var rows = S.imports.filter(function (r) { return !q || IMPORT_HEADERS.some(function (k) { return L.nameKey(r[k]).toLowerCase().indexOf(q) >= 0; }); });
    var search = h('input', { type: 'search', placeholder: '検索(車番・氏名・現場名など)', value: S.importsQ, 'aria-label': '検索' });
    search.addEventListener('input', function () { S.importsQ = search.value; var pos = search.selectionStart; renderImports().then(function () { var s = $('tab-imports').querySelector('input'); if (s) { s.focus(); s.setSelectionRange(pos, pos); } }); });
    host.appendChild(h('div', { class: 'tool' }, search, h('button', { class: 'btn sm', type: 'button', text: '再読み込み', onclick: function () { S.imports = null; renderImports(); } }), h('span', { class: 'sub', text: '新しい順・最大300件(' + rows.length + '件表示)' })));
    var head = h('tr'); IMPORT_HEADERS.forEach(function (k) { head.appendChild(h('th', { text: k })); });
    var body = h('tbody');
    rows.forEach(function (r) { var tr = h('tr'); IMPORT_HEADERS.forEach(function (k) { tr.appendChild(h('td', { class: 'nowrap', text: r[k] || '' })); }); body.appendChild(tr); });
    host.appendChild(rows.length ? h('div', { class: 'scroll' }, h('table', { class: 't' }, h('thead', null, head), body)) : h('div', { class: 'empty', text: '該当する記録はありません。' }));
  }

  // ---------- マスタ(車両情報・運転手)の表と編集 ----------
  function masterRows(kind) { return kind === 'vehicle' ? S.vehicles : S.drivers; }

  function normMaster(kind, d) {
    var o = {};
    MASTER_COLS[kind].forEach(function (k) { o[k] = String(d[k] == null ? '' : d[k]).trim(); });
    if (kind === 'vehicle') o.車番 = L.fmtPlate(o.車番);
    else { o.氏名 = L.nameKey(o.氏名); o.携帯番号 = L.fmtPhone(o.携帯番号); }
    return o;
  }
  function dupMessage(kind, d, selfRow) {
    var others = masterRows(kind).filter(function (r) { return r._row !== selfRow; });
    if (kind === 'vehicle') {
      return others.some(function (r) { return L.plateKey(r.車番) === L.plateKey(d.車番); }) ? '同じ車番が既に登録されています。' : '';
    }
    var k = L.companyKey(d.運送業者) + '|' + L.nameKey(d.氏名), p = L.phoneDigits(d.携帯番号);
    if (others.some(function (r) { return L.companyKey(r.運送業者) + '|' + L.nameKey(r.氏名) === k; })) return '同じ運送業者・氏名が既に登録されています。';
    if (p && others.some(function (r) { return L.phoneDigits(r.携帯番号) === p; })) return '同じ携帯番号が別の人に登録されています。';
    return '';
  }
  async function saveMaster(kind, mode, row, before, data) {
    try {
      await apiPost('masterSave', { kind: kind, mode: mode, row: row, before: before, data: data });
      S.editing = null; await loadInit(); renderMaster(kind); showBanner('');
    } catch (e) { showBanner('保存に失敗しました: ' + e.message); }
  }

  function renderMaster(kind) {
    var host = $(kind === 'vehicle' ? 'tab-vehicles' : 'tab-drivers');
    host.textContent = '';
    var cols = MASTER_COLS[kind];
    var dups = L.findMasterDups(S.vehicles, S.drivers);
    function isDup(r, k) {
      if (kind === 'vehicle') return k === '車番' && !!dups.vehiclePlate[L.plateKey(r.車番)];
      if (k === '氏名' || k === '運送業者') return !!dups.driverName[L.companyKey(r.運送業者) + '|' + L.nameKey(r.氏名)];
      return k === '携帯番号' && !!dups.driverPhone[L.phoneDigits(r.携帯番号)];
    }
    var q = L.nameKey(S.q[kind]).toLowerCase();
    var rows = masterRows(kind).filter(function (r) { return !q || cols.some(function (k) { return L.nameKey(r[k]).toLowerCase().indexOf(q) >= 0; }); });
    var search = h('input', { type: 'search', placeholder: '検索', value: S.q[kind], 'aria-label': '検索' });
    search.addEventListener('input', function () { S.q[kind] = search.value; var pos = search.selectionStart; renderMaster(kind); var s = host.querySelector('input[type=search]'); s.focus(); s.setSelectionRange(pos, pos); });
    var nd = kind === 'vehicle' ? Object.keys(dups.vehiclePlate).length : Object.keys(dups.driverName).length + Object.keys(dups.driverPhone).length;
    host.appendChild(h('div', { class: 'tool' }, search, h('span', { class: 'sub', text: masterRows(kind).length + '件' + (nd ? ' ・ 重複 ' + nd + ' 組(赤)。確認して、不要な行を削除するか修正してください。' : '') })));

    var head = h('tr'); cols.forEach(function (k) { head.appendChild(h('th', { text: k })); }); head.appendChild(h('th', { text: '操作' }));
    var body = h('tbody');

    // 追加行
    var addInputs = {};
    var addTr = h('tr', { class: 'addrow' });
    cols.forEach(function (k) { addInputs[k] = h('input', { placeholder: k, 'aria-label': k + '(追加)' }); addTr.appendChild(h('td', null, addInputs[k])); });
    addTr.appendChild(h('td', null, h('button', { class: 'btn sm primary', type: 'button', text: '追加', onclick: function () {
      var d = normMaster(kind, Object.fromEntries(cols.map(function (k) { return [k, addInputs[k].value]; })));
      var need = kind === 'vehicle' ? d.車番 : (d.氏名 && d.運送業者);
      if (!need) { showBanner(kind === 'vehicle' ? '車番を入力してください。' : '運送業者と氏名を入力してください。'); return; }
      var dm = dupMessage(kind, d, -1);
      if (dm && !window.confirm(dm + '\nそれでも追加しますか?')) return;
      saveMaster(kind, 'add', null, null, d);
    } })));
    body.appendChild(addTr);

    rows.forEach(function (r) {
      var editing = S.editing && S.editing.kind === kind && S.editing.row === r._row;
      var tr = h('tr');
      if (editing) {
        var inputs = {};
        cols.forEach(function (k) { inputs[k] = h('input', { value: r[k] || '', 'aria-label': k }); tr.appendChild(h('td', null, inputs[k])); });
        tr.appendChild(h('td', { class: 'nowrap' },
          h('button', { class: 'btn sm primary', type: 'button', text: '保存', onclick: function () {
            var d = normMaster(kind, Object.fromEntries(cols.map(function (k) { return [k, inputs[k].value]; })));
            var need = kind === 'vehicle' ? d.車番 : (d.氏名 && d.運送業者);
            if (!need) { showBanner('必須項目が空です。'); return; }
            var dm = dupMessage(kind, d, r._row);
            if (dm && !window.confirm(dm + '\nそれでも保存しますか?')) return;
            var before = {}; cols.forEach(function (k) { before[k] = r[k] || ''; });
            saveMaster(kind, 'update', r._row, before, d);
          } }), ' ',
          h('button', { class: 'btn sm', type: 'button', text: '取消', onclick: function () { S.editing = null; renderMaster(kind); } })));
      } else {
        cols.forEach(function (k) { tr.appendChild(h('td', { class: 'nowrap' + (isDup(r, k) ? ' dup' : ''), text: r[k] || '' })); });
        tr.appendChild(h('td', { class: 'nowrap' },
          h('button', { class: 'btn sm', type: 'button', text: '編集', onclick: function () { S.editing = { kind: kind, row: r._row }; renderMaster(kind); } }), ' ',
          h('button', { class: 'btn sm', type: 'button', text: '削除', onclick: function () {
            if (!window.confirm('この行を削除しますか?\n' + cols.map(function (k) { return r[k]; }).join(' / '))) return;
            var before = {}; cols.forEach(function (k) { before[k] = r[k] || ''; });
            saveMaster(kind, 'delete', r._row, before, null);
          } })));
      }
      body.appendChild(tr);
    });
    host.appendChild(h('div', { class: 'scroll' }, h('table', { class: 't' }, h('thead', null, head), body)));
    if (!rows.length) host.appendChild(h('div', { class: 'empty', text: masterRows(kind).length ? '該当する行はありません。' : 'まだ登録がありません。FAXを取り込むと、確認のうえ自動で登録できます。' }));
  }

  // ---------- 起動 ----------
  function wireDrop() {
    var drop = $('drop'), input = $('file');
    drop.addEventListener('dragover', function (e) { e.preventDefault(); drop.classList.add('over'); });
    drop.addEventListener('dragleave', function () { drop.classList.remove('over'); });
    drop.addEventListener('drop', function (e) { e.preventDefault(); drop.classList.remove('over'); if (e.dataTransfer && e.dataTransfer.files.length) addFiles(e.dataTransfer.files); });
    input.addEventListener('change', function () { if (input.files.length) addFiles(input.files); input.value = ''; });
    drop.addEventListener('keydown', function (e) { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); input.click(); } });
  }

  async function start() {
    document.querySelectorAll('#tabs button').forEach(function (b) { b.addEventListener('click', function () { showTab(b.dataset.tab); }); });
    wireDrop();
    if (!gasUrl()) {
      ['import', 'imports', 'vehicles', 'drivers'].forEach(function (x) { $('tab-' + x).hidden = true; });
      $('tabs').hidden = true; $('setup').hidden = false; return;
    }
    try { await loadInit(); }
    catch (e) { showBanner('スプレッドシートの読み込みに失敗しました: ' + e.message + '(GASのURL・公開設定を確認してください)'); }
  }
  start();
})();
