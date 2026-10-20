/* 車番連絡 取込 - 画面。表示はすべてテーブル。照合ロジックは logic.js(TruckLogic)。 */
(function () {
  'use strict';
  var L = window.TruckLogic;

  // デプロイ済みGAS WebアプリのURL(/exec で終わるURL)。デプロイ後にここへ設定する。
  var GAS_API_URL = 'https://script.google.com/macros/s/AKfycbyfyFEJn4alzJGmbWIhKwKeRvJ2OlkgyM4wZFk7ldUVCs5Yx-khi5FOWLen6cvvIYQ/exec';
  function gasUrl() { return window.__GAS_URL__ || GAS_API_URL; }

  var IMPORT_HEADERS = ['タイムスタンプ', 'ファイル名', '工事番号', '現場名', '手配業者', '積日', '卸日', '行先', '着時間', '運送業者', '車種', '車番', '氏名', '携帯番号', '追加変更', '備考'];
  var MASTER_COLS = { vehicle: ['手配業者', '運送業者', '車種', '車番'], driver: ['運送業者', '氏名', '携帯番号'] };
  var IMPORTS_LIMIT = 3000;
  var MAX_BYTES = 10 * 1024 * 1024;

  var S = { senders: [], vehicles: [], drivers: [], projects: [], importKeyList: [], destMap: {}, model: '', keyOk: false, cards: [], tab: 'import',
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

  async function loadInit() {
    var d = await apiGet('init');
    S.vehicles = d.vehicles || []; S.drivers = d.drivers || []; S.projects = d.projects || []; S.senders = d.senders || [];
    S.importKeyList = (d.importKeys || []).map(function (r) { return L.importKey({ 積日: r.積日, 車番: r.車番 }); });
    S.destMap = L.buildDestMap(d.pastDest || []);
    S.imports = null;
    renderTabs();
  }

  // ---------- タブ ----------
  function dupCount(kind) {
    var d = L.findMasterDups(S.vehicles, S.drivers);
    if (kind === 'vehicle') return Object.keys(d.vehiclePlate).length;
    return Object.keys(d.driverName).length + Object.keys(d.driverPhone).length;
  }
  function renderTabs() {
    var labels = { import: 'PDF取込', imports: '取込一覧', vehicles: '車両情報', drivers: '運転手' };
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

  function addFiles(files) { // 1回に取り込めるのは1ファイル(複数入れたときは最初の1つ)
    Array.prototype.slice.call(files, 0, 1).forEach(function (file) {
      var card = { id: ++seq, mode: 'normal', kind: '新規', res: null, records: null, items: [], file: file, name: file.name, mime: file.type || 'application/pdf', status: 'reading', rows: [], decisions: [], findings: [], warnings: [], msg: '', url: '', showPreview: false, busy: false };
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
      var res = L.sanitizeOcr(d.raw, { today: new Date(), senders: S.senders });
      card.res = res; card.warnings = res.warnings;
      if (L.isChange(res)) await enterKind(card, L.effectiveKind(res));
      else enterNormal(card);
      card.status = 'ready';
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
      renderCard(card);
    });
    return sel;
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
      tr.appendChild(h('td', null, projectSelect(card, row), row._suggest ? h('div', { class: 'sug', text: '過去と同じ工事を選択' }) : null));
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
          h('td', { class: 'pre' }, h('strong', { text: f.title }), f.detail ? '\n' + f.detail : ''),
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

  function renderCard(card) {
    var el = card.el;
    el.textContent = '';
    var chip = { reading: ['読み取り中…', 'chip'], ready: ['確認待ち', 'chip'], saved: ['記録済み', 'chip ok'], error: ['エラー', 'chip bad'] }[card.status];
    var head = h('div', { class: 'card-head' }, h('span', { class: 'name', text: card.name }), h('span', { class: chip[1], text: chip[0] }), card.status === 'ready' ? kindBox(card) : null, h('span', { class: 'spacer' }));
    if (card.url) head.appendChild(h('button', { class: 'btn sm', type: 'button', text: card.showPreview ? '原本を閉じる' : '原本を見る', onclick: function () { card.showPreview = !card.showPreview; renderCard(card); } }));
    head.appendChild(h('button', { class: 'btn sm', type: 'button', text: '閉じる', onclick: function () { S.cards = S.cards.filter(function (c) { return c !== card; }); el.remove(); } }));
    el.appendChild(head);
    if (card.showPreview && card.url) {
      el.appendChild(h('div', { class: 'preview' }, card.mime === 'application/pdf' ? h('iframe', { src: card.url + '#navpanes=0&view=FitH', title: '原本' }) : h('img', { src: card.url, alt: '原本' })));
    }
    if (card.status === 'reading') { el.appendChild(h('div', { class: 'empty', text: 'FAXの内容を読み取っています(10〜30秒ほどかかります)…' })); return; }
    if (card.status === 'error') {
      el.appendChild(h('div', { class: 'foot' }, h('span', { class: 'msg bad', text: card.msg }),
        card.url ? h('button', { class: 'btn', type: 'button', text: 'もう一度読み取る', onclick: function () { extract(card); } }) : null));
      return;
    }
    if (card.status === 'saved') { el.appendChild(h('div', { class: 'foot' }, h('span', { class: 'msg', text: card.msg }))); return; }
    card.warnings.forEach(function (w) { el.appendChild(h('div', { class: 'foot' }, h('span', { class: 'badge warn', text: '注意' }), h('span', { class: 'msg', text: w }))); });
    if (card.mode === 'change') { renderChangeBody(card); return; }
    el.appendChild(h('div', { class: 'sub-h', text: '読み取り結果(間違いがあれば表の中で直せます)' }));
    card.rowsHost = h('div'); card.rowsHost.appendChild(rowsTable(card)); el.appendChild(card.rowsHost);
    card.findHost = h('div'); el.appendChild(card.findHost);
    card.footHost = h('div'); el.appendChild(card.footHost);
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
      host.appendChild(h('div', { class: 'foot' }, btn, msg, h('span', { class: 'spacer' }), disc));
      host._f = { btn: btn, msg: msg, disc: disc };
    }
    host._f.disc.textContent = discardText; host._f.disc.onclick = onDiscard;
    return host._f;
  }
  function discardCard(card) { S.cards = S.cards.filter(function (c) { return c !== card; }); card.el.remove(); }

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
    var f = footParts(card, '記録せず破棄', function () { discardCard(card); });
    f.btn.textContent = keep + '件を記録する'; f.btn.disabled = blockers > 0 || keep === 0 || !!card.busy; f.btn.onclick = function () { commitCard(card); };
    f.msg.textContent = msg; f.msg.className = 'msg' + (blockers > 0 ? ' bad' : ' okmsg');
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
      refreshReadyCards();
    } catch (e) { card.busy = false; showBanner('記録に失敗しました: ' + e.message); renderFoot(card); return; }
    card.busy = false; showBanner(''); renderCard(card);
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
    if (kind === '新規') { enterNormal(card); return; }
    if (!card.records) card.records = await apiGet('listImports', { limit: 500 });
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
    update: { apply: 'この記録を「変更前」にして、今回の内容を「変更後」として追加する', asnew: '変更前にはせず、別の1台として追加する', skip: '反映しない' },
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
        it.type === 'cancel' ? h('label', { class: 'ctlitem' }, '備考: ', (function () { var n = h('input', { value: it.note || '', placeholder: '中止の理由など(任意)', 'aria-label': '備考' }); n.addEventListener('input', function () { it.note = n.value; }); return n; })()) : null)));
    });
    return h('div', { class: 'scroll' }, h('table', { class: 't change' }, h('thead', null, h('tr', null, heads.map(function (t) { return h('th', { text: t }); }))), tbody));
  }

  function renderChangeBody(card) {
    var el = card.el;
    if (card.res.memo) el.appendChild(h('div', { class: 'foot' }, h('span', { class: 'badge info', text: 'FAXの連絡' }), h('span', { class: 'msg', text: card.res.memo })));
    el.appendChild(h('div', { class: 'sub-h', text: '変更内容(現在の記録と、今回のFAXを並べています。違う項目は色が付きます)' }));
    if (!card.items.length) el.appendChild(h('div', { class: 'empty', text: '変更・追加・取消の対象が見つかりませんでした。FAXの区分を選び直してください。' }));
    else el.appendChild(changeTable(card));
    card.findHost = h('div'); el.appendChild(card.findHost);
    card.footHost = h('div'); el.appendChild(card.footHost);
    renderFindings(card); renderFoot(card);
  }

  function renderChangeFoot(card) {
    var rs = changeResults(card), blockers = 0, active = 0, todo = [];
    rs.forEach(function (r) { blockers += r.blockers.length; if (r.active) active++; r.blockers.forEach(function (b) { todo.push(r.no + '件目: ' + b); }); });
    var msg = blockers > 0 ? '反映するには、あと ' + blockers + ' 件の対応が必要です → ' + todo.slice(0, 3).join(' / ') + (todo.length > 3 ? ' ほか' : '') : (active === 0 ? '反映する内容がありません。' : '準備OKです。内容を確認して「反映する」を押してください。');
    var f = footParts(card, '反映せず破棄', function () { discardCard(card); });
    f.btn.textContent = active + '件を反映する'; f.btn.disabled = blockers > 0 || active === 0 || !!card.busy; f.btn.onclick = function () { commitChange(card); };
    f.msg.textContent = msg; f.msg.className = 'msg' + (blockers > 0 ? ' bad' : ' okmsg');
  }

  async function commitChange(card) {
    // 他のFAXを先に記録した場合など、取込一覧が変わっていたら、最新で照合し直してやり直す(古い照合のまま反映しない)
    card.busy = true; renderFoot(card);
    try {
      var fresh = await apiGet('listImports', { limit: 500 });
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
      var data = {}; L.ROW_FIELDS.forEach(function (k) { data[k] = r.res.row[k] || ''; });
      opsList.push(r.res.ops);
      if (it.type === 'update' && it.action === 'apply') { // 元の記録は「変更前」として残し、今回の内容を「変更後」の行として追加する
        items.push({ mode: 'mark', label: '変更前', row: rec._row, before: L.recFields(rec) });
        items.push({ mode: 'add', label: it.label || '変更後', data: data });
      } else items.push({ mode: 'add', label: it.type === 'update' ? '' : (it.label || ''), data: data });
    });
    var ops = L.mergeOps(opsList);
    card.busy = true; renderFoot(card);
    try {
      var out = await apiPost('applyChanges', { filename: card.name, items: items, ops: ops }, 120000);
      card.status = 'saved';
      card.msg = '取込一覧に反映しました(行を追加' + out.added + '件・「変更前」「中止」の印' + out.marked + '件)。取り込んだ行は、取込一覧に残っています。';
      await loadInit();
      refreshReadyCards();
    } catch (e) { card.busy = false; showBanner('反映に失敗しました: ' + e.message); renderFoot(card); return; }
    card.busy = false; showBanner(''); renderCard(card);
  }

  // ---------- 取込一覧(読み取り専用の表) ----------
  async function renderImports() {
    var host = $('tab-imports');
    if (S.imports == null) {
      host.textContent = '';
      host.appendChild(h('div', { class: 'empty', text: '読み込み中…' }));
      try { S.imports = await apiGet('listImports', { limit: IMPORTS_LIMIT }); }
      catch (e) { host.textContent = ''; host.appendChild(h('div', { class: 'empty', text: '取得に失敗しました: ' + e.message })); return; }
    }
    host.textContent = '';
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
    var sites = {}; // 現場名リスト: 情報シートの工事名と、取込一覧にある現場名
    S.projects.forEach(function (p) { if (p.工事名) sites[p.工事名] = 1; });
    S.imports.forEach(function (r) { if (r.現場名) sites[r.現場名] = 1; });
    var siteList = Object.keys(sites).sort(function (a, b) { return a.localeCompare(b, 'ja'); });
    function sel(label, value, opts, onchange) {
      var s = h('select', { 'aria-label': label }, opts.map(function (o) { return h('option', { value: o[0], text: o[1] }); }));
      s.value = value; s.addEventListener('change', function () { onchange(s.value); renderImports(); });
      return s;
    }
    var fySel = sel('年度', S.importsFy, [['all', 'すべての年度']].concat(fyList.map(function (y) { return [String(y), y + '年度']; })), function (v) { S.importsFy = v; });
    var cmSel = sel('締め月', S.importsCm, [['all', 'すべての締め月']].concat(L.CLOSING_MONTH_ORDER.map(function (m) { return [String(m), m + '月20日締め(' + L.closingPeriod(m) + ')']; })), function (v) { S.importsCm = v; });
    var siteSel = sel('現場名', S.importsSite, [['all', '全て(現場名)']].concat(siteList.map(function (n) { return [n, n]; })), function (v) { S.importsSite = v; });
    var cnt = '新しい順・' + rows.length + '件表示(最大' + IMPORTS_LIMIT + '件を読み込み)' + (undated && (S.importsFy !== 'all' || S.importsCm !== 'all') ? ' ・ 日付のない' + undated + '件は「すべて」で表示' : '');
    host.appendChild(h('div', { class: 'tool' }, fySel, cmSel, siteSel, h('button', { class: 'btn sm', type: 'button', text: '再読み込み', onclick: function () { S.imports = null; renderImports(); } }), h('span', { class: 'sub', text: cnt })));
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
    if (kind === 'vehicle') { o.車番 = L.fmtPlate(o.車番); o.車種 = L.fmtType(o.車種); }
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
    var rows = masterRows(kind);
    var nd = kind === 'vehicle' ? Object.keys(dups.vehiclePlate).length : Object.keys(dups.driverName).length + Object.keys(dups.driverPhone).length;
    host.appendChild(h('div', { class: 'tool' }, h('span', { class: 'sub', text: rows.length + '件' + (nd ? ' ・ 重複 ' + nd + ' 組(赤)。確認して、不要な行を削除するか修正してください。' : '') })));

    var head = h('tr'); cols.forEach(function (k) { head.appendChild(h('th', { text: k })); }); head.appendChild(h('th', { text: '操作' }));
    var body = h('tbody');

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
          h('button', { class: 'btn sm edit', type: 'button', text: '編集', onclick: function () { S.editing = { kind: kind, row: r._row }; renderMaster(kind); } }), ' ',
          h('button', { class: 'btn sm del', type: 'button', text: '削除', onclick: function () {
            confirmDialog('この行を削除しますか?', cols.map(function (k) { return r[k]; }).join(' / '), '削除する').then(function (yes) {
              if (!yes) return;
              var before = {}; cols.forEach(function (k) { before[k] = r[k] || ''; });
              saveMaster(kind, 'delete', r._row, before, null);
            });
          } })));
      }
      body.appendChild(tr);
    });
    host.appendChild(h('div', { class: 'scroll' }, h('table', { class: 't' }, h('thead', null, head), body)));
    if (!rows.length) host.appendChild(h('div', { class: 'empty', text: masterRows(kind).length ? '該当する行はありません。' : 'まだ登録がありません。FAXを取り込むと、確認のうえ自動で登録できます。' }));
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
      ['import', 'imports', 'vehicles', 'drivers'].forEach(function (x) { $('tab-' + x).hidden = true; });
      $('tabs').hidden = true; $('setup').hidden = false; return;
    }
    try { await loadInit(); }
    catch (e) { showBanner('スプレッドシートの読み込みに失敗しました: ' + e.message + '(GASのURL・公開設定を確認してください)'); }
  }
  start();
})();
