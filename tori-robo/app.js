/**
 * 鳥取梁ロボ管理アプリ(画面ロジック)。
 * 役割は「指定期間の状況をまとめる」→「OKならExcelでダウンロード」だけ。
 * 実寸法師はアプリ内では開かず、ダウンロードしたExcelの図番ハイパーリンクからローカルで開く。
 */

// GASのウェブアプリURL(デプロイ後に設定する)。空のあいだは sample.json(ダミーデータ)を表示する。
const GAS_API_URL = 'https://script.google.com/macros/s/AKfycbzLhyh3XzvJ-95n-VV7r7Upx_0AfGsqoPAaySmFSpwKdsqfP_EwjOTNzuyJgdTQvMxS/exec';
const HOURLY_COST_DEFAULT = 4000;
const LS_KEY = 'tori-robo-overrides-v1';

// ========== 純粋関数(テストでも使う) ==========

function pad2(n) { return n < 10 ? '0' + n : String(n); }

// 月の区切り。mode: 'calendar'=一般の月 / 'close20'=20日〆(前月21日〜当月20日を当月とする)
function monthKey(ymd, mode) {
  let y = Number(ymd.slice(0, 4));
  let m = Number(ymd.slice(5, 7));
  const d = Number(ymd.slice(8, 10));
  if (mode === 'close20' && d >= 21) {
    m += 1;
    if (m > 12) { m = 1; y += 1; }
  }
  return y + '-' + pad2(m);
}

function monthLabel(key, mode) {
  const y = key.slice(0, 4);
  const m = Number(key.slice(5, 7));
  return y + '年' + m + '月' + (mode === 'close20' ? '度(20日〆)' : '');
}

// 製品の確定(上書きを反映)。戻り値の status: ok / suggest / nomark / nowork
function applyOverride(row, products, overrides) {
  const key = row.r + '|' + row.wn + '|' + row.mk;
  const chosen = overrides[key];
  if (chosen && row.no && products[row.no + '|' + chosen]) {
    return Object.assign({}, row, { s: 'ok', fixedMark: chosen, pk: row.no + '|' + chosen, corrected: true });
  }
  return Object.assign({}, row, { fixedMark: row.s === 'ok' ? row.mk : '', corrected: false });
}

// 出力用の集計。rows: 期間・工事で絞り込み済みの稼動実績(1回の溶接=1行)。
// 時間・ワイヤ・溶接長は各行の開始日の月へ、重量は「ロボ×製品」ごとに1回だけ(最初の行の月へ)加算する。
function aggregate(rows, products, mode) {
  const months = {};
  const seen = {};
  const sorted = rows.slice().sort(function (a, b) { return (a.sd + a.st) < (b.sd + b.st) ? -1 : 1; });
  sorted.forEach(function (row) {
    const mk = monthKey(row.sd, mode);
    const mo = months[mk] || (months[mk] = {});
    const t = mo[row.r] || (mo[row.r] = { len: 0, weight: 0, arc: 0, run: 0, wire: 0 });
    t.len += row.len;
    t.arc += row.arc;
    t.run += row.run;
    t.wire += row.wire;
    if (row.s === 'ok' && row.pk) {
      const sk = row.r + '|' + row.pk;
      if (!seen[sk]) {
        seen[sk] = true;
        const p = products[row.pk];
        if (p) t.weight += p.w;
      }
    }
  });
  const keys = Object.keys(months).sort();
  const total = { len: 0, weight: 0, arc: 0, run: 0, wire: 0 };
  const out = keys.map(function (k) {
    const sub = { len: 0, weight: 0, arc: 0, run: 0, wire: 0 };
    const robots = Object.keys(months[k]).map(Number).sort().map(function (r) {
      const t = months[k][r];
      Object.keys(sub).forEach(function (f) { sub[f] += t[f]; total[f] += t[f]; });
      return { robot: r, v: finish(t) };
    });
    return { key: k, robots: robots, sub: finish(sub) };
  });
  return { months: out, total: finish(total) };
}

// 秒→分などの表示用の値にそろえる。非アークタイム=経過時間−アークタイム。
function finish(t) {
  const elapsedMin = t.run / 60;
  const arcMin = t.arc / 60;
  return {
    len: t.len,
    weight: t.weight,
    arcMin: arcMin,
    nonArcMin: Math.max(0, elapsedMin - arcMin),
    wire: t.wire,
    elapsedMin: elapsedMin,
  };
}

// 1つの製品を複数回溶接した記録を、ロボ×製品の1行にまとめる(表・Excelの「全て抽出」用)。
function groupByProduct(rows, products) {
  const map = {};
  rows.forEach(function (row) {
    const gk = row.r + '|' + (row.pk || (row.no + '|?' + row.mk)) + '|' + row.wn;
    let g = map[gk];
    if (!g) {
      const p = row.pk ? products[row.pk] : null;
      g = map[gk] = {
        robot: row.r, workNo: row.no, enteredName: row.wn, enteredMark: row.mk, status: row.s,
        corrected: row.corrected, suggestions: row.sg || [], product: p,
        count: 0, first: row.sd + ' ' + row.st, last: row.ed + ' ' + row.et,
        len: 0, arc: 0, run: 0, wire: 0, overrideKey: row.r + '|' + row.wn + '|' + row.mk,
      };
    }
    g.count += 1;
    g.len += row.len; g.arc += row.arc; g.run += row.run; g.wire += row.wire;
    if (row.sd + ' ' + row.st < g.first) g.first = row.sd + ' ' + row.st;
    if (row.ed + ' ' + row.et > g.last) g.last = row.ed + ' ' + row.et;
  });
  return Object.keys(map).map(function (k) { return map[k]; }).sort(function (a, b) {
    return a.workNo === b.workNo ? (a.first < b.first ? -1 : 1) : (a.workNo < b.workNo ? -1 : 1);
  });
}

// 年・月と20日〆の指定から期間を求める。close20=trueなら前月21日〜指定月20日、falseなら1日〜末日。
function periodFor(y, m, close20) {
  const last = new Date(y, m, 0).getDate();
  if (!close20) return { start: y + '-' + pad2(m) + '-01', end: y + '-' + pad2(m) + '-' + pad2(last) };
  const py = m === 1 ? y - 1 : y;
  const pm = m === 1 ? 12 : m - 1;
  return { start: py + '-' + pad2(pm) + '-21', end: y + '-' + pad2(m) + '-20' };
}

// 既定の指定月=今日の前月
function defaultYearMonth(today) {
  let y = today.getFullYear();
  let m = today.getMonth(); // 0始まりなので、これが前月の1始まり
  if (m === 0) { m = 12; y -= 1; }
  return { y: y, m: m };
}

if (typeof module !== 'undefined') module.exports = { periodFor, defaultYearMonth, monthKey, monthLabel, aggregate, groupByProduct, applyOverride, finish };

// ========== 画面 ==========

if (typeof document !== 'undefined') {
  (function () {
    const $ = function (id) { return document.getElementById(id); };
    const st = { data: null, overrides: {}, selected: null, mode: 'calendar', y: 0, m: 0, start: '', end: '', cost: HOURLY_COST_DEFAULT, sample: false };

    function loadOverrides() {
      try { st.overrides = JSON.parse(localStorage.getItem(LS_KEY) || '{}'); } catch (e) { st.overrides = {}; }
    }
    function saveOverrides() {
      try { localStorage.setItem(LS_KEY, JSON.stringify(st.overrides)); } catch (e) { /* 保存できなくても動作は続ける */ }
    }

    function fetchJson(url) {
      return fetch(url).then(function (r) {
        if (!r.ok) throw new Error('サーバーエラー(HTTP ' + r.status + ')');
        return r.json();
      });
    }

    function load(refresh) {
      setStatus(refresh === true ? '最新のデータを確認中…(数十秒かかることがあります)' : 'データを読み込み中…');
      const useSample = !GAS_API_URL || /[?&]sample=1/.test(location.search);
      st.sample = useSample;
      const p = useSample
        ? fetchJson('sample.json').then(function (d) { return { status: 'success', data: d }; })
        : fetchJson(GAS_API_URL + '?action=' + (refresh === true ? 'refresh' : 'getData'));
      p.then(function (res) {
        if (res.status !== 'success') throw new Error(res.message || '読み込みに失敗しました');
        st.data = res.data;
        init();
      }).catch(function (err) {
        setStatus('読み込みに失敗しました: ' + err.message, true);
      });
    }

    function setStatus(msg, isErr) {
      const el = $('status');
      el.textContent = msg;
      el.className = 'status' + (isErr ? ' err' : '');
      el.style.display = msg ? 'block' : 'none';
    }

    function init() {
      const d = st.data;
      if (!st.selected) st.selected = new Set(d.works.map(function (w) { return w.workNo; }));
      if (!st.y) {
        const ym = defaultYearMonth(new Date());
        st.y = ym.y;
        st.m = ym.m;
      }
      const y0 = Number((d.calendarMin || '2024-11-21').slice(0, 4));
      const y1 = Math.max(Number((d.calendarMax || '2027-01-04').slice(0, 4)), st.y);
      let yo = '';
      for (let y = y0; y <= y1; y++) yo += '<option value="' + y + '">' + y + '年</option>';
      $('yearSel').innerHTML = yo;
      let mo = '';
      for (let m = 1; m <= 12; m++) mo += '<option value="' + m + '">' + m + '月</option>';
      $('monthSel').innerHTML = mo;
      syncPeriod();
      $('costInput').value = st.cost;
      $('updatedAt').textContent = (st.sample ? '【サンプルデータ】 ' : '') + '更新: ' + (d.generatedAt || '').replace('T', ' ').slice(0, 16);
      const w = (d.warnings || []).filter(Boolean);
      $('warnings').innerHTML = w.length ? w.map(function (x) { return '<div>⚠ ' + esc(x) + '</div>'; }).join('') : '';
      setStatus('');
      render();
    }

    // 年・月・20日〆ボタンの状態から期間を決め、画面に反映する。
    function syncPeriod() {
      const p = periodFor(st.y, st.m, st.mode === 'close20');
      st.start = p.start;
      st.end = p.end;
      $('yearSel').value = String(st.y);
      $('monthSel').value = String(st.m);
      $('modeCalendar').setAttribute('aria-pressed', st.mode === 'calendar' ? 'true' : 'false');
      $('modeClose').setAttribute('aria-pressed', st.mode === 'close20' ? 'true' : 'false');
      $('periodText').textContent = '期間: ' + p.start.replace(/-/g, '/') + ' 〜 ' + p.end.replace(/-/g, '/');
    }

    function esc(s) {
      return String(s == null ? '' : s).replace(/[&<>"]/g, function (c) { return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]; });
    }

    // 期間で絞り込み、上書きを反映した稼動実績
    function currentRows() {
      const d = st.data;
      return d.rows
        .filter(function (r) { return r.sd >= st.start && r.sd <= st.end; })
        .map(function (r) { return applyOverride(r, d.products, st.overrides); });
    }

    function render() {
      const d = st.data;
      const inPeriod = currentRows();
      renderWorks(inPeriod);
      renderUnknown(inPeriod);
      const rows = inPeriod.filter(function (r) { return r.no && st.selected.has(r.no); });
      renderSummary(rows);
      renderDetail(rows);
      $('dlBtn').disabled = rows.length === 0;
    }

    function renderWorks(inPeriod) {
      const d = st.data;
      const counts = {};
      inPeriod.forEach(function (r) { if (r.no) counts[r.no] = (counts[r.no] || 0) + 1; });
      $('works').innerHTML = d.works.map(function (w) {
        const c = counts[w.workNo] || 0;
        return '<label class="chip' + (c ? '' : ' dim') + '"><input type="checkbox" data-wk="' + esc(w.workNo) + '"' + (st.selected.has(w.workNo) ? ' checked' : '') + '> ' +
          esc(w.workNo) + ' ' + esc(w.workName) + ' <span class="cnt">' + c + '件</span></label>';
      }).join('');
    }

    function renderUnknown(inPeriod) {
      const d = st.data;
      const names = {};
      inPeriod.forEach(function (r) { if (r.s === 'nowork') names[r.wn] = (names[r.wn] || 0) + 1; });
      const keys = Object.keys(names);
      const box = $('unknown');
      if (!keys.length) { box.style.display = 'none'; return; }
      box.style.display = 'block';
      const opts = '<option value="">工事を選択…</option>' + d.works.map(function (w) {
        return '<option value="' + esc(w.workNo) + '">' + esc(w.workNo) + ' ' + esc(w.workName) + '</option>';
      }).join('');
      box.innerHTML = '<h3>工事名が判定できないデータ(集計から除外中)</h3>' +
        '<p class="hint">略称などで同じ工事なら、工事を選んで「登録」してください(次回から自動で判定されます)。工事が違うものは、そのまま除外されます。</p>' +
        keys.map(function (k) {
          return '<div class="unk-row"><b>' + esc(k || '(空欄)') + '</b> <span class="cnt">' + names[k] + '件</span> ' +
            '<select data-name="' + esc(k) + '">' + opts + '</select> <button class="btn small" data-alias="' + esc(k) + '">登録</button></div>';
        }).join('');
    }

    function fmt(n, dec) {
      return Number(n).toLocaleString('ja-JP', { minimumFractionDigits: dec || 0, maximumFractionDigits: dec || 0 });
    }

    function renderSummary(rows) {
      const agg = aggregate(rows, st.data.products, st.mode);
      st.agg = agg;
      const head = '<tr><th>月</th><th>ロボ</th><th>換算溶接長(m)</th><th>重量(t)</th><th>アークタイム(分)</th><th>非アークタイム(分)</th><th>ワイヤ使用量(kg)</th><th>経過時間(分)</th></tr>';
      const line = function (v) {
        return '<td class="num">' + fmt(v.len) + '</td><td class="num">' + fmt(v.weight, 1) + '</td><td class="num">' + fmt(v.arcMin) + '</td><td class="num">' + fmt(v.nonArcMin) + '</td><td class="num">' + fmt(v.wire, 1) + '</td><td class="num">' + fmt(v.elapsedMin) + '</td>';
      };
      let body = '';
      agg.months.forEach(function (m) {
        m.robots.forEach(function (r, i) {
          body += '<tr><td>' + (i === 0 ? esc(monthLabel(m.key, st.mode)) : '') + '</td><td>' + r.robot + '号機</td>' + line(r.v) + '</tr>';
        });
        body += '<tr class="sub"><td colspan="2">' + esc(monthLabel(m.key, st.mode)) + ' 集計</td>' + line(m.sub) + '</tr>';
      });
      body += '<tr class="total"><td colspan="2">総計</td>' + line(agg.total) + '</tr>';
      $('summary').innerHTML = rows.length ? '<table>' + head + body + '</table>' : '<p class="hint">この期間・工事のデータがありません。</p>';
      const hours = agg.total.elapsedMin / 60;
      $('costLine').textContent = rows.length ? '稼動時間 ' + fmt(hours, 1) + ' 時間 × ' + fmt(st.cost) + ' 円/時間 = ' + fmt(Math.round(hours * st.cost)) + ' 円' : '';
    }

    function renderDetail(rows) {
      const groups = groupByProduct(rows, st.data.products);
      st.groups = groups;
      const works = {};
      st.data.works.forEach(function (w) { works[w.workNo] = w.workName; });
      const bad = groups.filter(function (g) { return g.status !== 'ok'; }).length;
      $('detailInfo').textContent = groups.length + '製品' + (bad ? '(要確認 ' + bad + '件)' : '');
      const head = '<tr><th>工事番号</th><th>工事名</th><th>図面番号</th><th>製品名</th><th>サイズ</th><th>重量(t)</th><th>ロボ</th><th>溶接回数</th><th>加工日</th><th>溶接日</th><th>経過(分)</th><th>アーク(分)</th><th>ワイヤ(kg)</th><th>溶接長(m)</th><th>確認</th></tr>';
      const body = groups.map(function (g, i) {
        const p = g.product;
        let note = '';
        let cls = '';
        if (g.status === 'suggest') {
          cls = 'warn';
          note = 'この製品名では? ' + g.suggestions.map(function (s) { return '<button class="btn small" data-fix="' + i + '" data-mark="' + esc(s) + '">' + esc(s) + '</button>'; }).join(' ');
        } else if (g.status === 'nomark') { cls = 'bad'; note = 'マスタに無い製品名(誤入力の可能性)'; }
        else if (g.corrected) { cls = 'fixed'; note = '修正済 (入力: ' + esc(g.enteredMark) + ') <button class="btn small" data-undo="' + i + '">元に戻す</button>'; }
        return '<tr class="' + cls + '"><td>' + esc(g.workNo) + '</td><td>' + esc(works[g.workNo] || g.enteredName) + '</td><td>' + esc(p ? p.d : '') + '</td><td>' + esc(p ? p.m : g.enteredMark) + (g.count > 1 ? ' <span class="times">×' + g.count + '回</span>' : '') + '</td><td>' + esc(p ? p.s : '') + '</td><td class="num">' + (p ? fmt(p.w, 1) : '') + '</td><td>' + g.robot + '号機</td><td class="num">' + g.count + '</td><td>' + esc(p ? p.k : '') + '</td><td>' + esc(p ? p.v : '') + '</td><td class="num">' + fmt(g.run / 60) + '</td><td class="num">' + fmt(g.arc / 60) + '</td><td class="num">' + fmt(g.wire, 1) + '</td><td class="num">' + fmt(g.len) + '</td><td>' + note + '</td></tr>';
      }).join('');
      $('detail').innerHTML = groups.length ? '<table>' + head + body + '</table>' : '';
    }

    // ===== イベント =====
    document.addEventListener('change', function (e) {
      const t = e.target;
      if (t.dataset && t.dataset.wk) {
        if (t.checked) st.selected.add(t.dataset.wk); else st.selected.delete(t.dataset.wk);
        render();
      }
    });
    document.addEventListener('click', function (e) {
      const t = e.target;
      if (!t.dataset) return;
      if (t.dataset.fix !== undefined) {
        const g = st.groups[Number(t.dataset.fix)];
        st.overrides[g.overrideKey] = t.dataset.mark;
        saveOverrides();
        render();
      } else if (t.dataset.undo !== undefined) {
        delete st.overrides[st.groups[Number(t.dataset.undo)].overrideKey];
        saveOverrides();
        render();
      } else if (t.dataset.alias !== undefined) {
        const sel = document.querySelector('select[data-name="' + CSS.escape(t.dataset.alias) + '"]');
        if (!sel || !sel.value) { alert('工事を選択してください。'); return; }
        registerAlias(t.dataset.alias, sel.value);
      }
    });

    function registerAlias(name, workNo) {
      if (st.sample) { alert('サンプル表示中のため登録できません。'); return; }
      setStatus('登録中…');
      fetchJson(GAS_API_URL + '?action=saveAlias&name=' + encodeURIComponent(name) + '&workNo=' + encodeURIComponent(workNo))
        .then(function (res) {
          if (res.status !== 'success') throw new Error(res.message);
          load();
        }).catch(function (err) { setStatus('登録に失敗しました: ' + err.message, true); });
    }

    $('yearSel').addEventListener('change', function () { st.y = Number(this.value); syncPeriod(); render(); });
    $('monthSel').addEventListener('change', function () { st.m = Number(this.value); syncPeriod(); render(); });
    $('modeCalendar').addEventListener('click', function () { st.mode = 'calendar'; syncPeriod(); render(); });
    $('modeClose').addEventListener('click', function () { st.mode = 'close20'; syncPeriod(); render(); });
    $('costInput').addEventListener('change', function () { st.cost = Number(this.value) || 0; render(); });
    $('reloadBtn').addEventListener('click', function () { load(true); });
    $('dlBtn').addEventListener('click', function () {
      try { downloadExcel(); } catch (err) { setStatus('Excelの作成に失敗しました: ' + err.message, true); }
    });

    // ===== Excel出力(ExcelJS) =====
    function downloadExcel() {
      if (typeof ExcelJS === 'undefined') throw new Error('ExcelJSの読み込みに失敗しています。ネットワークを確認してください。');
      const wb = new ExcelJS.Workbook();
      const title = st.start.replace(/-/g, '/') + ' 〜 ' + st.end.replace(/-/g, '/') + ' 加工実績';
      const blue = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FFDDEBF7' } };
      const thin = { style: 'thin', color: { argb: 'FF999999' } };

      // --- 出力用(A4横) ---
      const ws = wb.addWorksheet('出力用', {
        pageSetup: { paperSize: 9, orientation: 'landscape', fitToPage: true, fitToWidth: 1, fitToHeight: 0, margins: { left: 0.4, right: 0.4, top: 0.6, bottom: 0.6, header: 0.3, footer: 0.3 } },
      });
      ws.getCell('A1').value = title;
      ws.getCell('A1').font = { size: 14, bold: true };
      const heads = ['月', 'ロボ', '換算溶接長(m)', '重量(t)', 'アークタイム(分)', '非アークタイム(分)', 'ワイヤ使用量(kg)', '経過時間(分)'];
      const hr = ws.getRow(3);
      heads.forEach(function (h, i) { const c = hr.getCell(i + 1); c.value = h; c.fill = blue; c.font = { bold: true }; c.alignment = { horizontal: 'center', vertical: 'middle', wrapText: true }; c.border = { bottom: thin }; });
      let r = 4;
      const put = function (label, robot, v, cls) {
        const row = ws.getRow(r++);
        row.getCell(1).value = label;
        row.getCell(2).value = robot;
        [v.len, v.weight, v.arcMin, v.nonArcMin, v.wire, v.elapsedMin].forEach(function (x, i) {
          const c = row.getCell(i + 3);
          c.value = i === 1 || i === 4 ? Math.round(x * 10) / 10 : Math.round(x);
          c.numFmt = i === 1 || i === 4 ? '#,##0.0' : '#,##0';
        });
        if (cls) for (let i = 1; i <= 8; i++) { const c = row.getCell(i); c.fill = blue; c.font = { bold: true }; c.border = { top: thin }; }
      };
      st.agg.months.forEach(function (m) {
        m.robots.forEach(function (rb, i) { put(i === 0 ? monthLabel(m.key, st.mode) : '', rb.robot + '号機', rb.v, false); });
        put(monthLabel(m.key, st.mode) + ' 集計', '', m.sub, true);
      });
      put('総計', '', st.agg.total, true);
      const hours = st.agg.total.elapsedMin / 60;
      ws.getCell('H' + (r + 1)).value = Math.round(hours * 10) / 10;
      ws.getCell('G' + (r + 1)).value = '稼動時間(時間)';
      ws.getCell('G' + (r + 2)).value = '単価(円/時間)';
      ws.getCell('H' + (r + 2)).value = st.cost;
      ws.getCell('G' + (r + 3)).value = '費用(円)';
      ws.getCell('H' + (r + 3)).value = Math.round(hours * st.cost);
      ws.getCell('H' + (r + 3)).numFmt = '#,##0';
      [14, 8, 14, 11, 16, 18, 16, 14].forEach(function (w, i) { ws.getColumn(i + 1).width = w; });
      ws.getRow(3).height = 32;

      // --- 全て抽出(製品ごと1行) ---
      const wd = wb.addWorksheet('全て抽出', { views: [{ state: 'frozen', ySplit: 1 }], pageSetup: { paperSize: 9, orientation: 'landscape', fitToPage: true, fitToWidth: 1, fitToHeight: 0 } });
      const dh = ['工事番号', '工事名', '図面番号', '製品名', 'サイズ', '重量(t)', 'ロボット', '溶接回数', '加工日', '溶接日', '初回開始', '最終終了', '経過時間(分)', 'アークタイム(分)', '非アークタイム(分)', 'ワイヤ使用量(kg)', '換算溶接長(m)', '確認'];
      const dr = wd.getRow(1);
      dh.forEach(function (h, i) { const c = dr.getCell(i + 1); c.value = h; c.fill = blue; c.font = { bold: true }; c.alignment = { wrapText: true, vertical: 'middle' }; });
      const works = {};
      st.data.works.forEach(function (w) { works[w.workNo] = w.workName; });
      st.groups.forEach(function (g, i) {
        const p = g.product;
        const row = wd.getRow(i + 2);
        const note = g.status === 'suggest' ? '要確認: 製品名候補 ' + g.suggestions.join(' / ') : g.status === 'nomark' ? '要確認: マスタに無い製品名' : g.corrected ? '修正済(入力: ' + g.enteredMark + ')' : '';
        const vals = [g.workNo, works[g.workNo] || g.enteredName, p ? p.d : '', p ? p.m : g.enteredMark, p ? p.s : '', p ? Math.round(p.w * 100) / 100 : '', g.robot + '号機', g.count, p ? p.k : '', p ? p.v : '', g.first, g.last,
          Math.round(g.run / 60), Math.round(g.arc / 60), Math.max(0, Math.round((g.run - g.arc) / 60)), Math.round(g.wire * 10) / 10, Math.round(g.len), note];
        vals.forEach(function (v, j) { row.getCell(j + 1).value = v; });
        if (p && p.l) { row.getCell(3).value = { text: p.d || p.m, hyperlink: p.l }; row.getCell(3).font = { color: { argb: 'FF0563C1' }, underline: true }; }
        if (g.status !== 'ok') for (let j = 1; j <= dh.length; j++) row.getCell(j).fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: g.status === 'suggest' ? 'FFFFF2CC' : 'FFF8CBAD' } };
      });
      [10, 22, 16, 18, 20, 9, 9, 9, 11, 11, 18, 18, 11, 11, 12, 11, 11, 30].forEach(function (w, i) { wd.getColumn(i + 1).width = w; });
      wd.autoFilter = { from: { row: 1, column: 1 }, to: { row: 1, column: dh.length } };

      wb.xlsx.writeBuffer().then(function (buf) {
        const blob = new Blob([buf], { type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' });
        const a = document.createElement('a');
        a.href = URL.createObjectURL(blob);
        a.download = '梁ロボ加工実績_' + st.start.replace(/-/g, '') + '-' + st.end.replace(/-/g, '') + '.xlsx';
        document.body.appendChild(a);
        a.click();
        setTimeout(function () { URL.revokeObjectURL(a.href); a.remove(); }, 1000);
      });
    }

    loadOverrides();
    load();
  })();
}
