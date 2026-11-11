// 鳥取工場 生産状況(左=生産遅れリスト、右=前日出来高。見本のPDFと同じ並び・合計行。2026-11-11 ユーザー指定)
// データはGAS(gas/Code.gs)の JSON API から取得する。GASのURLが未設定、または ?demo=1 のときはサンプル表示。
// 行の形: 前日出来高 [物件名, 製品名, 図番, 重量, 生産日, 部位, 数量]
//         遅れリスト [物件名, 製品名, 図番, 重量, 生産予定日, 遅れ日数(営業日), 部位, 数量]
// 並び(物件名 → 部位 → 案件マスターの行の順)はGASが決める。画面は物件ごとに合計行を挟むだけ。
(function () {
  'use strict';

  // GAS WebアプリのURL
  const GAS_URL = 'https://script.google.com/macros/s/AKfycby82K8BtvFOn5dHnlFMVB4-gYsVQNBCyaarn5ZjgcuCRK5knLSJ4rzTKu_T4vBuezlL/exec';
  const CACHE_KEY = 'tottori-production-status:last2';

  const params = new URLSearchParams(location.search);
  const DEMO = !GAS_URL || params.get('demo') === '1';
  const $ = function (id) { return document.getElementById(id); };
  const WD = ['日', '月', '火', '水', '木', '金', '土'];

  // 表の列(見本: 物件名|部位|製品名|数量|重量。遅れリストは右に 予定日|遅れ を足す)
  const KIND = {
    late: { part: 6, qty: 7, sub: '遅れ合計', total: '総遅れ合計', extra: [{ label: '予定日', i: 4, date: true }, { label: '遅れ', i: 5, days: true }] },
    yesterday: { part: 5, qty: 6, sub: '結果合計', total: '総結果合計', extra: [] },
  };

  const st = { data: null, live: '' };

  function esc(s) {
    return String(s == null ? '' : s).replace(/[&<>"]/g, function (c) { return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]; });
  }
  // 重量は小数第3位を四捨五入して2桁(合計は、四捨五入した値を足す=表の数字を足した値と一致させる)
  function r2(v) { return Math.round((Number(v) || 0) * 100 + 1e-7) / 100; }
  function fmtW(v) { return r2(v).toFixed(2); }
  function parts(key) { const p = String(key || '').split('-'); return p.length === 3 ? { y: +p[0], m: +p[1], d: +p[2] } : null; }
  function wd(p) { return WD[new Date(Date.UTC(p.y, p.m - 1, p.d)).getUTCDay()]; }
  function fmtDate(key) { const p = parts(key); return p ? p.m + '/' + p.d + '(' + wd(p) + ')' : ''; }
  function fmtMD(key) { const p = parts(key); return p ? p.m + '.' + p.d : ''; }
  function fmtDateY(key) { const p = parts(key); return p ? p.y + '/' + p.m + '/' + p.d + '(' + wd(p) + ')' : ''; }
  function daysClass(n) { return n >= 5 ? 'd3' : n >= 3 ? 'd2' : 'd1'; } // 営業日: 5日以上=赤、3日以上=橙
  function prevDay(key) { const p = parts(key); return p ? new Date(Date.UTC(p.y, p.m - 1, p.d - 1)).toISOString().slice(0, 10) : ''; }

  // 物件ごとにまとめる(行の順はそのまま)
  function groups(rows, k) {
    const out = [];
    rows.forEach(function (r) {
      let g = out[out.length - 1];
      if (!g || g.name !== r[0]) { g = { name: r[0], rows: [], qty: 0, weight: 0 }; out.push(g); }
      g.rows.push(r);
      g.qty += Number(r[k.qty]) || 0;
      g.weight = r2(g.weight + r2(r[3]));
    });
    return out;
  }
  function totals(gs) {
    return gs.reduce(function (t, g) { return { qty: t.qty + g.qty, weight: r2(t.weight + g.weight) }; }, { qty: 0, weight: 0 });
  }

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
  function saveCache(d) { try { localStorage.setItem(CACHE_KEY, JSON.stringify(d)); } catch (e) { /* 無視 */ } }

  // 開いたら: 前回の表示 → 保存済みの一覧(すぐ出る)→ 裏で案件マスターの最新を確認(変わった分だけGASが読み直す)
  // 備考①(予定日)などは担当者がいつでも書き換えるため、開くたびに最新を確認する(2026-11-11 ユーザー指示)
  function load() {
    if (DEMO) {
      $('banner').hidden = false;
      $('banner').textContent = GAS_URL ? 'サンプル表示です(?demo=1)。実際のデータではありません。' : 'サンプル表示です(GASのURLが未設定のため)。実際のデータではありません。';
      $('refreshBtn').disabled = true;
      return fetchJson('sample.json?v=20261111c').then(function (d) { setData(d); }).catch(function (e) { showError('サンプルの読み込みに失敗しました: ' + e.message); });
    }
    try {
      const cached = JSON.parse(localStorage.getItem(CACHE_KEY) || 'null');
      if (cached && cached.late) setData(cached, true);
    } catch (e) { /* 無視 */ }
    setLive('最新を確認中…');
    return fetchJson(GAS_URL + '?action=getData').then(function (res) {
      if (res.status !== 'success') throw new Error(res.message || '取得に失敗しました');
      setData(res.data);
      saveCache(res.data);
    }).catch(function (e) {
      showError('データの取得に失敗しました: ' + e.message + (st.data ? '\n(前回取得した内容を表示しています)' : ''));
    }).then(function () { refresh(true); });
  }

  // silent=true は開いたときの自動確認(トーストを出さない)。false は「最新データを取得」ボタン。
  function refresh(silent) {
    if (DEMO) return;
    const btn = $('refreshBtn');
    btn.disabled = true;
    btn.textContent = '確認中…';
    setLive('最新を確認中…');
    if (!silent) toast('案件マスターの変更を確認しています(変更があれば数十秒かかることがあります)');
    fetchJson(GAS_URL + '?action=refresh').then(function (res) {
      if (res.status === 'busy') {
        // 他の人(または自動更新)が更新中。終わるころに保存済みの一覧を取り直す
        setLive('他の人が更新中…');
        if (!silent) toast(res.message);
        return new Promise(function (r) { setTimeout(r, 20000); }).then(function () { return fetchJson(GAS_URL + '?action=getData'); }).then(function (g) {
          if (g.status === 'success') { setData(g.data); saveCache(g.data); }
          setLive('');
        });
      }
      if (res.status !== 'success') throw new Error(res.message || '更新に失敗しました');
      setData(res.data);
      saveCache(res.data);
      setLive(res.pending ? '一部の案件を読み込み中(1〜2分後にもう一度開いてください)' : '');
      if (!silent) toast(res.pending ? '一部の案件は読み込み中です。1〜2分後にもう一度開いてください。' : '最新のデータにしました');
    }).catch(function (e) {
      setLive('最新の確認に失敗しました');
      if (!silent) showError('更新に失敗しました: ' + e.message);
    }).then(function () {
      btn.disabled = false;
      btn.textContent = '最新データを取得';
    });
  }

  // ヘッダーの「最新を確認中…」などの表示
  function setLive(msg) {
    st.live = msg;
    const el = $('live');
    if (el) el.textContent = msg ? '・' + msg : '';
  }

  function showError(msg) {
    const w = $('warn');
    w.hidden = false;
    w.classList.add('error');
    w.textContent = msg;
    if (!st.data) $('meta').textContent = '読み込めませんでした';
  }

  // ---- 表示 ----
  function setData(d, fromCache) {
    st.data = d;
    $('meta').innerHTML = '基準日 <b>' + esc(fmtDateY(d.baseDate)) + '</b>・前の営業日 <b>' + esc(fmtDateY(d.prevDate)) + '</b>・更新 ' + esc(d.updatedAt || '') + (fromCache ? '(前回の表示)' : '') + '<span id="live" class="live"></span>';
    setLive(st.live || '');
    const w = $('warn');
    if (!fromCache) { w.classList.remove('error'); w.hidden = !(d.warnings && d.warnings.length); w.textContent = (d.warnings || []).join('\n'); }
    render('late');
    render('yesterday');
    $('dlBtn').disabled = false;
  }

  function title(kind) {
    const d = st.data;
    return kind === 'late' ? '鳥取工場' + fmtMD(d.baseDate) + '生産遅れ' : '鳥取工場' + fmtMD(d.prevDate) + '結果重量';
  }

  function render(kind) {
    const d = st.data, k = KIND[kind];
    const gs = groups(d[kind] || [], k), t = totals(gs);
    $(kind + 'Title').textContent = title(kind);
    $(kind + 'Total').textContent = fmtW(t.weight) + 't';
    $(kind + 'Note').textContent = kind === 'late'
      ? '生産予定日(備考①)が ' + fmtDate(d.lateFrom) + '〜' + fmtDate(prevDay(d.baseDate)) + ' で、加工日が未記入の製品(遅れは営業日)'
      : '加工日が ' + fmtDateY(d.prevDate) + ' の製品';
    const head = ['物件名', '部位', '製品名', '数量', '重量'].concat(k.extra.map(function (e) { return e.label; }));
    let html = '<thead><tr>' + head.map(function (h, i) { return '<th' + (i === 3 || i === 4 ? ' class="num"' : '') + '>' + esc(h) + '</th>'; }).join('') + '</tr></thead><tbody>';
    gs.forEach(function (g) {
      g.rows.forEach(function (r, i) {
        html += '<tr><td class="work">' + (i === 0 ? esc(g.name) : '') + '</td><td class="part">' + esc(r[k.part]) + '</td><td class="mark">' + esc(r[1]) + '</td>'
          + '<td class="num">' + esc(r[k.qty]) + '</td><td class="num">' + fmtW(r[3]) + '</td>';
        k.extra.forEach(function (e) {
          if (e.date) html += '<td class="date">' + esc(fmtDate(r[e.i])) + '</td>';
          if (e.days) { const n = Number(r[e.i]) || 0; html += '<td class="num"><span class="days ' + daysClass(n) + '">' + n + '日</span></td>'; }
        });
        html += '</tr>';
      });
      html += subRow(k.sub, g.qty, g.weight, head.length, 'sub');
    });
    if (gs.length) html += subRow(k.total, t.qty, t.weight, head.length, 'total');
    html += '</tbody>';
    $(kind + 'Table').innerHTML = gs.length ? html : '';
    $(kind + 'Empty').hidden = gs.length > 0;
  }

  function subRow(label, qty, weight, cols, cls) {
    return '<tr class="' + cls + '"><td colspan="3" class="label">' + esc(label) + '</td><td class="num">' + qty + '</td><td class="num">' + fmtW(weight) + '</td>' + (cols > 5 ? '<td colspan="' + (cols - 5) + '"></td>' : '') + '</tr>';
  }

  // ---- Excel(見本と同じく、左=生産遅れ・右=結果重量を1枚に並べる) ----
  function textWidth(s) {
    let w = 0;
    String(s == null ? '' : s).split('').forEach(function (ch) { w += /[^\x00-\xff]/.test(ch) ? 2 : /[il1.,:;'|!()\-]/.test(ch) ? 0.6 : /[MW]/.test(ch) ? 1.4 : 1.1; });
    return w;
  }

  function download() {
    if (typeof ExcelJS === 'undefined') { toast('Excelの部品を読み込み中です。少し待ってからもう一度押してください。'); return; }
    const d = st.data;
    const fileName = '鳥取_生産状況_' + d.baseDate.replace(/-/g, '') + '.xlsx';
    const wb = new ExcelJS.Workbook();
    const ws = wb.addWorksheet('生産状況');
    const thin = { style: 'thin', color: { argb: 'FF808080' } };
    const box = { top: thin, left: thin, bottom: thin, right: thin };
    const FILL = { late: 'FFCFE8F7', yesterday: 'FFFFF2A8' };
    const widths = {};
    function put(row, col, v, opt) {
      opt = opt || {};
      const c = ws.getCell(row, col);
      c.value = v;
      if (opt.border !== false) c.border = box;
      if (opt.fill) c.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: opt.fill } };
      if (opt.fmt) c.numFmt = opt.fmt;
      if (opt.align) c.alignment = { horizontal: opt.align };
      if (opt.size) c.font = { size: opt.size };
      if (!opt.noWidth) widths[col] = Math.max(widths[col] || 0, textWidth(opt.wtext != null ? opt.wtext : v));
      return c;
    }
    function sumRow(r, col0, last, label, qty, weight, fill) {
      for (let c = col0; c <= last; c++) put(r, c, '', { fill: fill, noWidth: true });
      ws.mergeCells(r, col0, r, col0 + 2);
      put(r, col0, label, { fill: fill, align: 'center', noWidth: true });
      put(r, col0 + 3, qty, { fill: fill, align: 'center' });
      put(r, col0 + 4, weight, { fill: fill, fmt: '0.00', wtext: fmtW(weight) });
      return r + 1;
    }
    function table(kind, col0) {
      const k = KIND[kind], gs = groups(d[kind] || [], k), t = totals(gs);
      const head = ['物件名', '部位', '製品名', '数量', '重量'].concat(k.extra.map(function (e) { return e.label; }));
      const last = col0 + head.length - 1;
      put(1, col0, title(kind), { border: false, noWidth: true, size: 14 });
      put(1, last, fmtW(t.weight) + 't', { border: false, align: 'right', noWidth: true, size: 14 });
      head.forEach(function (h, i) { put(2, col0 + i, h, { align: 'center' }); });
      let r = 3;
      gs.forEach(function (g) {
        g.rows.forEach(function (x, i) {
          put(r, col0, i === 0 ? g.name : '', { align: 'center' });
          put(r, col0 + 1, x[k.part], { align: 'center' });
          put(r, col0 + 2, x[1], { align: 'center' });
          put(r, col0 + 3, x[k.qty] === '' ? '' : Number(x[k.qty]), { align: 'center' });
          put(r, col0 + 4, r2(x[3]), { fmt: '0.00', wtext: fmtW(x[3]) });
          k.extra.forEach(function (e, j) {
            if (e.date) { const p = parts(x[e.i]); put(r, col0 + 5 + j, p ? new Date(Date.UTC(p.y, p.m - 1, p.d)) : '', { fmt: 'm/d', align: 'center', wtext: '10/13' }); }
            if (e.days) put(r, col0 + 5 + j, Number(x[e.i]) || 0, { fmt: '0"日"', align: 'center', wtext: '000日' });
          });
          r++;
        });
        r = sumRow(r, col0, last, k.sub, g.qty, g.weight, FILL[kind]);
      });
      if (gs.length) sumRow(r, col0, last, k.total, t.qty, t.weight, FILL[kind]);
    }
    table('late', 1);       // A〜G
    table('yesterday', 9);  // I〜M(Hは空ける)
    Object.keys(widths).forEach(function (c) { ws.getColumn(Number(c)).width = Math.min(40, Math.max(6, widths[c] + 2)); });
    ws.getColumn(8).width = 2;
    ws.views = [{ state: 'frozen', ySplit: 2 }];
    ws.pageSetup = { orientation: 'portrait', paperSize: 9, fitToPage: true, fitToWidth: 1, fitToHeight: 0, printTitlesRow: '1:2' };
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

  $('dlBtn').addEventListener('click', download);
  $('refreshBtn').addEventListener('click', function () { refresh(false); });

  load();
  sendLog('起動', '');
})();
