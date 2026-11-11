// 鳥取工場 生産状況(前日出来高・生産遅れリスト)
// データはGAS(gas/Code.gs)の JSON API から取得する。GASのURLが未設定、または ?demo=1 のときはサンプル表示。
(function () {
  'use strict';

  // GAS WebアプリのURL(デプロイ後に設定する)
  const GAS_URL = '';
  const CACHE_KEY = 'tottori-production-status:last';

  const params = new URLSearchParams(location.search);
  const DEMO = !GAS_URL || params.get('demo') === '1';
  const $ = function (id) { return document.getElementById(id); };
  const WD = ['日', '月', '火', '水', '木', '金', '土'];

  const COLS = {
    yesterday: [
      { label: '工事名', i: 0, cls: 'work' },
      { label: '製品名', i: 1 },
      { label: '図番', i: 2 },
      { label: '重量(t)', i: 3, cls: 'num', fmt: fmtWeight },
      { label: '生産日', i: 4, fmt: fmtDate },
    ],
    late: [
      { label: '工事名', i: 0, cls: 'work' },
      { label: '製品名', i: 1 },
      { label: '図番', i: 2 },
      { label: '重量(t)', i: 3, cls: 'num', fmt: fmtWeight },
      { label: '生産予定日', i: 4, fmt: fmtDate },
      { label: '遅れ日数(営業日)', i: 5, cls: 'num', html: daysBadge, days: true },
    ],
  };

  const st = { data: null, tab: 'yesterday', work: '' };

  function esc(s) {
    return String(s == null ? '' : s).replace(/[&<>"]/g, function (c) { return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]; });
  }
  function fmtWeight(v) { return (Number(v) || 0).toFixed(3); }
  function parts(key) { const p = String(key || '').split('-'); return p.length === 3 ? { y: +p[0], m: +p[1], d: +p[2] } : null; }
  function fmtDate(key) {
    const p = parts(key);
    if (!p) return '';
    return p.m + '/' + p.d + '(' + WD[new Date(Date.UTC(p.y, p.m - 1, p.d)).getUTCDay()] + ')';
  }
  function fmtDateY(key) { const p = parts(key); return p ? p.y + '/' + p.m + '/' + p.d + '(' + WD[new Date(Date.UTC(p.y, p.m - 1, p.d)).getUTCDay()] + ')' : ''; }
  function daysBadge(v) {
    const n = Number(v) || 0;
    const c = n >= 5 ? 'd3' : n >= 3 ? 'd2' : 'd1'; // 営業日: 5日(約1週間)以上=赤、3日以上=橙
    return '<span class="days ' + c + '">' + n + '日</span>';
  }
  function sumWeight(rows) { return rows.reduce(function (s, r) { return s + (Number(r[3]) || 0); }, 0); }

  let toastTimer = 0;
  function toast(msg) {
    const t = $('toast');
    t.textContent = msg;
    t.hidden = false;
    clearTimeout(toastTimer);
    toastTimer = setTimeout(function () { t.hidden = true; }, 3500);
  }

  // ---- 利用記録(画面には何も出さない・失敗は無視) ----
  function sendLog(kind, detail) {
    if (DEMO) return;
    try {
      fetch(GAS_URL, { method: 'POST', mode: 'no-cors', keepalive: true, headers: { 'Content-Type': 'text/plain;charset=utf-8' }, body: JSON.stringify({ action: 'log', kind: kind, detail: detail || '' }) }).catch(function () {});
    } catch (e) { /* 無視 */ }
  }

  // ---- 取得 ----
  function fetchJson(url) {
    return fetch(url, { credentials: 'omit', cache: 'no-store' }).then(function (r) {
      if (!r.ok) throw new Error('サーバーエラー(HTTP ' + r.status + ')');
      return r.json();
    });
  }

  function load() {
    if (DEMO) {
      $('banner').hidden = false;
      $('banner').textContent = GAS_URL ? 'サンプル表示です(?demo=1)。実際のデータではありません。' : 'サンプル表示です(GASのURLが未設定のため)。実際のデータではありません。';
      $('refreshBtn').disabled = true;
      return fetchJson('sample.json?v=20261111a').then(function (d) { setData(d); }).catch(function (e) { showError('サンプルの読み込みに失敗しました: ' + e.message); });
    }
    try {
      const cached = JSON.parse(localStorage.getItem(CACHE_KEY) || 'null');
      if (cached && cached.late) setData(cached, true);
    } catch (e) { /* 無視 */ }
    return fetchJson(GAS_URL + '?action=getData').then(function (res) {
      if (res.status !== 'success') throw new Error(res.message || '取得に失敗しました');
      setData(res.data);
      try { localStorage.setItem(CACHE_KEY, JSON.stringify(res.data)); } catch (e) { /* 無視 */ }
    }).catch(function (e) {
      showError('データの取得に失敗しました: ' + e.message + (st.data ? '\n(前回取得した内容を表示しています)' : ''));
    });
  }

  function refresh() {
    if (DEMO) return;
    const btn = $('refreshBtn');
    btn.disabled = true;
    btn.textContent = '取得中…';
    toast('案件マスターを読み直しています(数十秒かかることがあります)');
    fetchJson(GAS_URL + '?action=refresh').then(function (res) {
      if (res.status === 'busy') { toast(res.message); return; }
      if (res.status !== 'success') throw new Error(res.message || '更新に失敗しました');
      setData(res.data);
      try { localStorage.setItem(CACHE_KEY, JSON.stringify(res.data)); } catch (e) { /* 無視 */ }
      toast(res.pending ? '一部の案件は読み込み中です。1〜2分後にもう一度開いてください。' : '最新のデータにしました');
    }).catch(function (e) {
      showError('更新に失敗しました: ' + e.message);
    }).then(function () {
      btn.disabled = false;
      btn.textContent = '最新データを取得';
    });
  }

  function showError(msg) {
    const w = $('warn');
    w.hidden = false;
    w.classList.add('error');
    w.textContent = msg;
    if (!st.data) { $('meta').textContent = '読み込めませんでした'; renderEmpty('データがありません'); }
  }

  // ---- 表示 ----
  function setData(d, fromCache) {
    st.data = d;
    $('meta').innerHTML = '基準日 <b>' + esc(fmtDateY(d.baseDate)) + '</b>・前の営業日 <b>' + esc(fmtDateY(d.prevDate)) + '</b>・更新 ' + esc(d.updatedAt || '') + (fromCache ? '(前回の表示)' : '');
    const w = $('warn');
    if (!fromCache) { w.classList.remove('error'); w.hidden = !(d.warnings && d.warnings.length); w.textContent = (d.warnings || []).join('\n'); }
    $('subYesterday').textContent = fmtDate(d.prevDate) + '・' + d.yesterday.length + '件・' + sumWeight(d.yesterday).toFixed(1) + 't';
    $('subLate').textContent = d.late.length + '件・' + sumWeight(d.late).toFixed(1) + 't';
    $('subLate').classList.toggle('has-late', d.late.length > 0);
    buildWorkFilter();
    render();
  }

  function currentRows() {
    if (!st.data) return [];
    const rows = st.data[st.tab] || [];
    return st.work ? rows.filter(function (r) { return r[0] === st.work; }) : rows;
  }

  function buildWorkFilter() {
    const sel = $('workFilter');
    const names = {};
    (st.data[st.tab] || []).forEach(function (r) { names[r[0]] = (names[r[0]] || 0) + 1; });
    const keys = Object.keys(names).sort();
    if (st.work && !names[st.work]) st.work = '';
    sel.innerHTML = '<option value="">すべて</option>' + keys.map(function (k) { return '<option value="' + esc(k) + '"' + (k === st.work ? ' selected' : '') + '>' + esc(k) + '(' + names[k] + ')</option>'; }).join('');
  }

  function renderEmpty(msg) {
    $('thead').innerHTML = '';
    $('tbody').innerHTML = '';
    $('empty').hidden = false;
    $('empty').textContent = msg;
    $('summary').textContent = '';
    $('dlBtn').disabled = true;
  }

  function render() {
    ['yesterday', 'late'].forEach(function (t) { $(t === 'yesterday' ? 'tabYesterday' : 'tabLate').setAttribute('aria-selected', String(st.tab === t)); });
    const cols = COLS[st.tab];
    const rows = currentRows();
    const d = st.data;
    $('summary').innerHTML = (st.tab === 'yesterday'
      ? esc(fmtDateY(d.prevDate)) + ' の出来高 '
      : esc(fmtDateY(d.baseDate)) + ' 時点の遅れ' + (d.lateFrom ? '(予定日 ' + esc(fmtDate(d.lateFrom)) + '以降)' : '') + ' ')
      + '<b>' + rows.length + '件</b>・合計 <b>' + sumWeight(rows).toFixed(3) + 't</b>';
    $('thead').innerHTML = '<tr>' + cols.map(function (c) { return '<th' + (c.cls === 'num' ? ' class="num"' : '') + '>' + esc(c.label) + '</th>'; }).join('') + '</tr>';
    $('tbody').innerHTML = rows.map(function (r) {
      return '<tr>' + cols.map(function (c) {
        const v = r[c.i];
        const inner = c.html ? c.html(v) : esc(c.fmt ? c.fmt(v) : v);
        return '<td' + (c.cls ? ' class="' + c.cls + '"' : '') + '>' + inner + '</td>';
      }).join('') + '</tr>';
    }).join('');
    $('empty').hidden = rows.length > 0;
    $('empty').textContent = st.tab === 'yesterday' ? '前の営業日の出来高はありません' : '生産が遅れている製品はありません';
    $('dlBtn').disabled = rows.length === 0;
  }

  // ---- Excel ----
  // 文字の幅のめやす(全角2・細い文字0.6・他1.1)で列幅を決める
  function textWidth(s) {
    let w = 0;
    String(s == null ? '' : s).split('').forEach(function (ch) {
      w += /[^\x00-\xff]/.test(ch) ? 2 : /[il1.,:;'|!()\-]/.test(ch) ? 0.6 : /[MW]/.test(ch) ? 1.4 : 1.1;
    });
    return w;
  }

  function download() {
    if (typeof ExcelJS === 'undefined') { toast('Excelの部品を読み込み中です。少し待ってからもう一度押してください。'); return; }
    const d = st.data;
    const rows = currentRows();
    const isLate = st.tab === 'late';
    const cols = COLS[st.tab];
    const title = isLate ? '鳥取工場 生産遅れリスト(' + fmtDateY(d.baseDate) + ' 時点)' : '鳥取工場 前日出来高(' + fmtDateY(d.prevDate) + ')';
    const stamp = (isLate ? d.baseDate : d.prevDate).replace(/-/g, '');
    const fileName = '鳥取_' + (isLate ? '遅れリスト' : '前日出来高') + '_' + stamp + (st.work ? '_' + st.work.replace(/[\\\/:*?"<>|]/g, '_') : '') + '.xlsx';

    const wb = new ExcelJS.Workbook();
    const ws = wb.addWorksheet(isLate ? '遅れリスト' : '前日出来高', { views: [{ state: 'frozen', ySplit: 3 }] });
    ws.getCell('A1').value = title;
    ws.getCell('A1').font = { bold: true, size: 14 };
    ws.getCell('A2').value = (st.work ? '工事: ' + st.work + '  ' : '') + (isLate && d.lateFrom ? '生産予定日 ' + fmtDateY(d.lateFrom) + '以降  ' : '') + rows.length + '件  合計 ' + sumWeight(rows).toFixed(3) + 't  (データ更新 ' + (d.updatedAt || '') + ')';
    ws.getRow(3).values = cols.map(function (c) { return c.label; });
    ws.getRow(3).eachCell(function (cell) {
      cell.font = { bold: true };
      cell.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FFE8EEF7' } };
      cell.border = { bottom: { style: 'thin', color: { argb: 'FF9AA8B8' } } };
    });
    rows.forEach(function (r) {
      const vals = cols.map(function (c) {
        const v = r[c.i];
        if (c.fmt === fmtDate) { const p = parts(v); return p ? new Date(Date.UTC(p.y, p.m - 1, p.d)) : ''; }
        if (c.cls === 'num') return Number(v) || 0;
        return v == null ? '' : String(v);
      });
      ws.addRow(vals);
    });
    const total = ws.addRow(cols.map(function (c, i) { return i === 0 ? '合計' : c.label === '重量(t)' ? sumWeight(rows) : ''; }));
    total.font = { bold: true };
    total.eachCell(function (cell) { cell.border = { top: { style: 'thin', color: { argb: 'FF9AA8B8' } } }; });
    cols.forEach(function (c, i) {
      const col = ws.getColumn(i + 1);
      if (c.label === '重量(t)') col.numFmt = '0.000';
      if (c.fmt === fmtDate) col.numFmt = 'yyyy/m/d';
      if (c.days) col.numFmt = '0"日"';
      let w = textWidth(c.label);
      rows.forEach(function (r) { w = Math.max(w, textWidth(c.fmt === fmtDate ? '2026/11/11' : c.cls === 'num' ? fmtWeight(r[c.i]) : r[c.i])); });
      col.width = Math.min(60, Math.max(8, w + 2));
    });
    ws.pageSetup = { orientation: 'portrait', fitToPage: true, fitToWidth: 1, fitToHeight: 0, paperSize: 9, printTitlesRow: '3:3' };

    wb.xlsx.writeBuffer().then(function (buf) {
      const blob = new Blob([buf], { type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' });
      const a = document.createElement('a');
      a.href = URL.createObjectURL(blob);
      a.download = fileName;
      document.body.appendChild(a);
      a.click();
      setTimeout(function () { URL.revokeObjectURL(a.href); a.remove(); }, 1000);
      sendLog('ダウンロード', fileName);
    }).catch(function (e) { toast('Excelの作成に失敗しました: ' + e.message); });
  }

  // ---- 操作 ----
  ['tabYesterday', 'tabLate'].forEach(function (id) {
    $(id).addEventListener('click', function () {
      st.tab = this.getAttribute('data-tab');
      st.work = '';
      if (st.data) { buildWorkFilter(); render(); }
    });
  });
  $('workFilter').addEventListener('change', function () { st.work = this.value; render(); });
  $('dlBtn').addEventListener('click', download);
  $('refreshBtn').addEventListener('click', refresh);

  load();
  sendLog('起動', '');
})();
