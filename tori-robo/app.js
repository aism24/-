/**
 * 鳥取梁ロボ管理アプリ(画面ロジック)。
 * 役割は「指定期間の状況をまとめる」→「OKならExcelでダウンロード」だけ。
 * 実寸法師はアプリ内では開かず、ダウンロードしたExcelの図番ハイパーリンクからローカルで開く。
 */

// GASのウェブアプリURL(デプロイ後に設定する)。空のあいだは sample.json(ダミーデータ)を表示する。
const GAS_API_URL = 'https://script.google.com/macros/s/AKfycbzLhyh3XzvJ-95n-VV7r7Upx_0AfGsqoPAaySmFSpwKdsqfP_EwjOTNzuyJgdTQvMxS/exec';
const HOURLY_COST_DEFAULT = 4000;
const LS_KEY = 'tori-robo-overrides-v1';
const DATA_CACHE_KEY = 'tori-robo-data-v1'; // 前回の読み込み結果。次回の表示を即時にするため(裏で最新を取得して差し替える)

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
    const st = { editing: {}, data: null, overrides: {}, selected: null, mode: 'calendar', multi: false, y: 0, m: 0, y2: 0, m2: 0, start: '', end: '', cost: HOURLY_COST_DEFAULT, sample: false };

    function loadOverrides() {
      try { st.overrides = JSON.parse(localStorage.getItem(LS_KEY) || '{}'); } catch (e) { st.overrides = {}; }
    }
    function saveOverrides() {
      try { localStorage.setItem(LS_KEY, JSON.stringify(st.overrides)); } catch (e) { /* 保存できなくても動作は続ける */ }
    }

    function fetchJson(url) {
      return fetch(url, { credentials: 'omit' }).then(function (r) {
        if (!r.ok) throw new Error('サーバーエラー(HTTP ' + r.status + ')');
        return r.json();
      });
    }

    function loadCachedData() {
      try { return JSON.parse(localStorage.getItem(DATA_CACHE_KEY) || 'null'); } catch (e) { return null; }
    }
    function saveCachedData(data) {
      try { localStorage.setItem(DATA_CACHE_KEY, JSON.stringify(data)); } catch (e) { /* 保存できなくても動作は続ける */ }
    }

    // refresh=true: 元データを読み直す。fresh=true: 前回の結果を使わず最新を待つ(登録直後など)
    function load(refresh, fresh) {
      const useSample = !GAS_API_URL || /[?&]sample=1/.test(location.search);
      st.sample = useSample;
      const cached = !useSample && !refresh && !fresh && !st.data ? loadCachedData() : null;
      if (cached) { st.data = cached; init(); } // 前回の結果をまず表示し、裏で最新を取得する
      else setStatus(refresh === true ? '最新のデータを確認中…(数十秒かかることがあります)' : 'データを読み込み中…', false, !useSample && !refresh && !fresh); // 前回の結果が無い初回だけ注意書きを出す
      const p = useSample
        ? fetchJson('sample.json').then(function (d) { return { status: 'success', data: d }; })
        : (refresh === true || fresh) ? fetchJson(GAS_API_URL + '?action=' + (refresh === true ? 'refresh' : 'getData'))
          : fetchJson('api/data').catch(function () { return fetchJson(GAS_API_URL + '?action=getData'); }); // 通常はVercel中継(CDNキャッシュ)。失敗時はGASへ直接
      p.then(function (res) {
        if (res.status !== 'success') throw new Error(res.message || '読み込みに失敗しました');
        if (!useSample) saveCachedData(res.data);
        if (cached && cached.generatedAt === res.data.generatedAt) return; // 変更なし
        st.data = res.data;
        init();
      }).catch(function (err) {
        if (!cached) setStatus('読み込みに失敗しました: ' + err.message, true);
      });
    }

    // 説明書(ページ画像 manual/p-1.jpg〜)。読込中のポップアップからも、読込後のヘッダーからも開ける。読込が終わっても開いたまま
    (function () {
      const MANUAL_PAGES = 9;
      let page = 1;
      function show() {
        $('manualImg').src = 'manual/p-' + page + '.jpg?v=2';
        $('manualPage').textContent = page + ' / ' + MANUAL_PAGES;
        $('manualPrev').disabled = page <= 1; // 1ページ目は「前ページ」をグレーアウト
        $('manualNext').disabled = page >= MANUAL_PAGES; // 最終ページは「次ページ」をグレーアウト
        if (page < MANUAL_PAGES) new Image().src = 'manual/p-' + (page + 1) + '.jpg?v=2';
      }
      function open() { page = 1; $('manual').style.display = 'flex'; show(); }
      function close() { $('manual').style.display = 'none'; }
      function move(d) { const n = page + d; if (n >= 1 && n <= MANUAL_PAGES) { page = n; show(); } }
      $('manualBtnLoad').addEventListener('click', open);
      $('manualBtnHdr').addEventListener('click', open);
      $('manualClose').addEventListener('click', close);
      $('manualPrev').addEventListener('click', function () { move(-1); });
      $('manualNext').addEventListener('click', function () { move(1); });
      document.addEventListener('keydown', function (e) {
        if ($('manual').style.display === 'none') return;
        if (e.key === 'ArrowLeft') move(-1);
        else if (e.key === 'ArrowRight') move(1);
        else if (e.key === 'Escape') close();
      });
    })();

    // 固定ヘッダーの高さを CSS 変数に反映(5.の見出し(高さ36px固定)・列見出しをその下に固定するため)
    function updateStick() {
      const s = document.querySelector('.sticky-top');
      if (!s) return;
      document.documentElement.style.setProperty('--stkH', Math.ceil(s.getBoundingClientRect().height) + 'px');
      const th = document.querySelector('#detail th');
      if (th) document.documentElement.style.setProperty('--thH', Math.ceil(th.getBoundingClientRect().height) + 'px');
    }
    window.addEventListener('resize', updateStick);
    if (window.ResizeObserver) {
      const ro = new ResizeObserver(updateStick);
      ro.observe(document.querySelector('.sticky-top'));
    }
    updateStick();

    function setStatus(msg, isErr, first) {
      const el = $('status');
      const busy = !!msg && !isErr;
      // 読込中などの進行メッセージは、画面をグレーアウトして中央のポップアップ(進行バー付き)で表示。エラーだけ帯で表示
      $('loading').style.display = busy ? 'flex' : 'none';
      $('loadingMsg').textContent = busy ? msg : '';
      $('loadingFirst').style.display = busy && first ? 'block' : 'none';
      el.textContent = isErr ? msg : '';
      el.className = 'status' + (isErr ? ' err' : '');
      el.style.display = isErr && msg ? 'block' : 'none';
    }

    function init() {
      const d = st.data;
      if (!st.selected) st.selected = new Set();
      d.works.forEach(function (w) { if (!st.known || !st.known[w.workNo]) st.selected.add(w.workNo); }); // 新しい工事は選択状態で追加
      st.known = {};
      d.works.forEach(function (w) { st.known[w.workNo] = true; });
      if (!st.y) {
        const ym = defaultYearMonth(new Date());
        st.y = ym.y;
        st.m = ym.m;
        st.y2 = ym.y;
        st.m2 = ym.m;
      }
      const y0 = Number((d.calendarMin || '2024-11-21').slice(0, 4));
      const y1 = Math.max(Number((d.calendarMax || '2027-01-04').slice(0, 4)), st.y);
      let yo = '';
      for (let y = y0; y <= y1; y++) yo += '<option value="' + y + '">' + y + '年</option>';
      $('yearSel').innerHTML = yo;
      $('yearSel2').innerHTML = yo;
      const cmin = (d.calendarMin || '2024-11-21').split('-'); // 選べる月の範囲: カレンダーの最初の月〜今日の月
      const now = new Date();
      st.minIdx = Number(cmin[0]) * 12 + Number(cmin[1]) - 1;
      st.maxIdx = Math.max(now.getFullYear() * 12 + now.getMonth(), st.minIdx);
      let mo = '';
      for (let m = 1; m <= 12; m++) mo += '<option value="' + m + '">' + m + '月</option>';
      $('monthSel').innerHTML = mo;
      $('monthSel2').innerHTML = mo;
      syncPeriod();
      setCostText();
      $('updatedAt').textContent = (st.sample ? '【サンプルデータ】 ' : '') + '更新: ' + (d.generatedAt || '').replace('T', ' ').slice(0, 16);
      setStatus('');
      render();
    }

    // 年・月・20日〆ボタンの状態から期間を決め、画面に反映する。
    function syncPeriod() {
      const mi = st.minIdx || 0, ma = st.maxIdx || 99999;
      function clampIdx(y, m) { const i = Math.min(ma, Math.max(mi, y * 12 + m - 1)); return { y: Math.floor(i / 12), m: i % 12 + 1 }; }
      let c = clampIdx(st.y, st.m); st.y = c.y; st.m = c.m;
      c = clampIdx(st.y2, st.m2); st.y2 = c.y; st.m2 = c.m;
      if (!st.multi || st.y2 * 12 + st.m2 < st.y * 12 + st.m) { st.y2 = st.y; st.m2 = st.m; } // 終了月は開始月以降
      const p = periodFor(st.y, st.m, st.mode === 'close20');
      const pe = periodFor(st.multi ? st.y2 : st.y, st.multi ? st.m2 : st.m, st.mode === 'close20');
      p.end = pe.end;
      st.start = p.start;
      st.end = p.end;
      $('yearSel2').value = String(st.y2);
      $('monthSel2').value = String(st.m2);
      ['multiTo', 'yearSel2', 'mnav2'].forEach(function (id) { $(id).style.display = st.multi ? '' : 'none'; });
      $('modeMulti').setAttribute('aria-pressed', st.multi ? 'true' : 'false');
      $('yearSel').value = String(st.y);
      $('monthSel').value = String(st.m);
      updateMonthNav();
      $('modeCalendar').setAttribute('aria-pressed', st.mode === 'calendar' ? 'true' : 'false');
      $('modeClose').setAttribute('aria-pressed', st.mode === 'close20' ? 'true' : 'false');
      $('periodText').textContent = '期間: ' + p.start.replace(/-/g, '/') + ' 〜 ' + p.end.replace(/-/g, '/');
    }

    // 範囲外の年・月はグレーアウト(選べない)。◀▶は範囲の端でグレーアウト。
    function updateMonthNav() {
      const mi = st.minIdx || 0, ma = st.maxIdx || 99999;
      [['yearSel', 'monthSel', 'mPrev', 'mNext', st.y, st.m, mi, ma], ['yearSel2', 'monthSel2', 'mPrev2', 'mNext2', st.y2, st.m2, st.y * 12 + st.m - 1, ma]].forEach(function (r) {
        const lo = r[6], hi = r[7], y = r[4], idx = r[4] * 12 + r[5] - 1;
        Array.prototype.forEach.call($(r[0]).options, function (o) { const v = Number(o.value); o.disabled = v * 12 + 11 < lo || v * 12 > hi; });
        Array.prototype.forEach.call($(r[1]).options, function (o) { const i = y * 12 + Number(o.value) - 1; o.disabled = i < lo || i > hi; });
        $(r[2]).disabled = idx <= lo;
        $(r[3]).disabled = idx >= hi;
      });
    }
    function stepMonth(which, delta) {
      const k = which === 2 ? ['y2', 'm2'] : ['y', 'm'];
      const i = st[k[0]] * 12 + st[k[1]] - 1 + delta;
      st[k[0]] = Math.floor(i / 12);
      st[k[1]] = i % 12 + 1;
      syncPeriod();
      render();
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
      const inPeriod = currentRows();
      renderWorks(inPeriod);
      const rows = inPeriod.filter(function (r) { return r.no && st.selected.has(r.no); });
      renderSummary(rows);
      renderDetail(rows);
      $('dlBtn').disabled = rows.length === 0;
    }

    // 2. 梁ロボ入力工事の工事名確認: 入力名ごとに正式工事名を選んで保存(スプレッドシートの別名表へ記録)
    function renderWorks(inPeriod) {
      const d = st.data;
      const names = {};
      inPeriod.forEach(function (r) {
        const o = names[r.wn] || (names[r.wn] = { n: 0, no: '', al: false });
        o.n++;
        if (!o.no && r.no) o.no = r.no;
        if (r.al) o.al = true;
      });
      const keys = Object.keys(names);
      const hasAl = inPeriod.some(function (r) { return r.al !== undefined; });
      const works = {};
      d.works.forEach(function (w) { works[w.workNo] = w.workName; });
      const optBase = d.works.map(function (w) { return '<option value="' + esc(w.workNo) + '">' + esc(w.workName) + '</option>'; });
      if (!keys.length) { $('works').innerHTML = '<p class="hint">この期間のデータがありません。</p>'; return; }
      const head = '<tr><th>梁ロボ入力工事名</th><th>工事番号</th><th>正式工事名</th><th>保存</th></tr>';
      const body = keys.map(function (k) {
        const o = names[k];
        const saved = !!o.no && (hasAl ? o.al : true) && !st.editing[k]; // 別名表に登録済み(al)だけ確定表示。未登録は自動判定でも選択式(旧GASデータにalが無い場合は従来どおり)
        const opts = '<option value="">工事を選択…</option>' + (saved ? '' : d.works.map(function (w, i) {
          return o.no && w.workNo === o.no ? optBase[i].replace('<option ', '<option selected ') : optBase[i];
        }).join(''));
        return '<tr class="' + (saved ? '' : 'warn') + '"><td class="ctr"><b>' + esc(k || '(空欄)') + '</b> <span class="cnt">' + o.n + '件</span></td>' +
          '<td class="ctr wkno" data-wkno="' + esc(k) + '">' + esc(o.no || '未判定') + '</td>' +
          '<td>' + (saved ? esc(works[o.no] || '') : '<select data-name="' + esc(k) + '">' + opts + '</select>') + '</td>' +
          '<td class="ctr">' + (saved ? '<button class="btn small" data-edit="' + esc(k) + '">再編集</button>' : '<button class="btn small" data-alias="' + esc(k) + '">保存</button>') + '</td></tr>';
      }).join('');
      $('works').innerHTML = '<table>' + head + body + '</table>';
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
          body += '<tr><td class="ctr">' + (i === 0 || st.multi ? esc(monthLabel(m.key, st.mode)) : '') + '</td><td class="ctr">' + r.robot + '号機</td>' + line(r.v) + '</tr>';
        });
        body += '<tr class="sub"><td class="ctr" colspan="2">' + esc(monthLabel(m.key, st.mode)) + ' 集計</td>' + line(m.sub) + '</tr>';
      });
      body += '<tr class="total"><td class="ctr" colspan="2">総計</td>' + line(agg.total) + '</tr>';
      $('summary').innerHTML = rows.length ? '<table>' + head + body + '</table>' : '<p class="hint">この期間・工事のデータがありません。</p>';
      const hours = agg.total.elapsedMin / 60;
      $('costLine').textContent = rows.length ? '稼動時間 ' + fmt(hours, 1) + ' 時間 × ' + fmt(st.cost) + ' 円/時間 = ' + fmt(Math.round(hours * st.cost)) + ' 円' : '';
    }

    // 日付(YYYY-MM-DD…)を m/d 表示にする(Excelの「全て抽出」と同じ)
    function md(v) {
      const m = /^\d{4}-(\d{2})-(\d{2})/.exec(v || '');
      return m ? (+m[1]) + '/' + (+m[2]) : '';
    }

    function renderDetail(rows) {
      const groups = groupByProduct(rows, st.data.products);
      st.groups = groups;
      const works = {};
      st.data.works.forEach(function (w) { works[w.workNo] = w.workName; });
      const bad = groups.filter(function (g) { return g.status !== 'ok'; }).length;
      $('detailInfo').textContent = groups.length + '製品' + (bad ? '(要確認 ' + bad + '件)' : '');
      const head = '<tr><th>工事番号</th><th>工事名</th><th>図面番号</th><th>製品名</th><th>サイズ</th><th>重量(t)</th><th>ロボ</th><th>溶接回数</th><th>加工日</th><th>溶接日</th><th>経過(分)</th><th>アーク(分)</th><th>ワイヤ(kg)</th><th>溶接長(m)</th></tr>';
      const body = groups.map(function (g, i) {
        const p = g.product;
        let cls = '';
        let tip = '';
        if (g.status === 'suggest') cls = 'warn';
        else if (g.status === 'nomark') cls = 'bad';
        else if (g.corrected) { cls = 'fixed'; tip = esc(g.enteredMark) + ' → ' + esc(p ? p.m : ''); }
        return '<tr class="' + cls + '"' + (tip ? ' data-tip="' + tip + '"' : '') + '><td class="ctr">' + esc(g.workNo) + '</td><td>' + esc(works[g.workNo] || g.enteredName) + '</td><td class="ctr">' + esc(p ? p.d : '') + '</td><td>' + esc(p ? p.m : g.enteredMark) + '</td><td>' + esc(p ? p.s : '') + '</td><td class="num">' + (p ? fmt(p.w, 1) : '') + '</td><td class="ctr">' + g.robot + '号機</td><td class="ctr">' + (g.count > 1 ? g.count : '') + '</td><td class="ctr">' + md(p ? p.k : '') + '</td><td class="ctr">' + md(g.last) + '</td><td class="num">' + fmt(g.run / 60) + '</td><td class="num">' + fmt(g.arc / 60) + '</td><td class="num">' + fmt(g.wire, 1) + '</td><td class="num">' + fmt(g.len) + '</td></tr>';
      }).join('');
      $('detail').innerHTML = groups.length ? '<table>' + head + body + '</table>' : ''; updateStick();
      renderMarkCheck(groups, works);
    }

    // 4. 製品名誤入力の確認: 工事名|製品名|確認(候補から選択)。選択結果は5.へ反映される
    function renderMarkCheck(groups, works) {
      const items = [];
      groups.forEach(function (g, i) { if (g.status !== 'ok' || g.corrected) items.push(i); });
      $('markCheckInfo').textContent = items.length ? '(' + items.length + '件)' : '＝指定月無し';
      $('markCheckHint').style.display = items.length ? '' : 'none';
      if (!items.length) { $('markCheck').innerHTML = ''; return; }
      const head = '<tr><th>工事名</th><th>製品名</th><th>確認</th></tr>';
      const body = items.map(function (i) {
        const g = st.groups[i];
        let cell;
        if (g.status === 'suggest' || g.corrected) {
          const cands = g.corrected ? [g.product && g.product.m].concat(g.suggestions || []) : g.suggestions;
          cell = '<select data-fix="' + i + '"><option value="">' + (g.corrected ? '元の入力に戻す' : '確認してください…') + '</option>' +
            cands.filter(function (c, k) { return c && cands.indexOf(c) === k && c !== g.enteredMark; }).map(function (c) {
              return '<option value="' + esc(c) + '"' + (g.corrected && g.product && g.product.m === c ? ' selected' : '') + '>' + esc(c) + '</option>';
            }).join('') + '</select>';
          if (g.corrected && g.product) cell += ' <span class="cnt">修正済: ' + esc(g.product.m) + '</span>';
        } else cell = 'マスタに無い製品名(候補なし)';
        return '<tr class="' + (g.corrected ? 'fixed' : g.status === 'suggest' ? 'warn' : 'bad') + '"><td class="ctr">' + esc(works[g.workNo] || g.enteredName) + '</td><td class="ctr">' + esc(g.enteredMark) + '</td><td>' + cell + '</td></tr>';
      }).join('');
      $('markCheck').innerHTML = '<table>' + head + body + '</table>';
    }

    // ===== イベント =====
    const tipEl = document.createElement('div');
    tipEl.className = 'tip';
    document.body.appendChild(tipEl);
    document.addEventListener('mousemove', function (e) {
      const tr = e.target.closest ? e.target.closest('tr[data-tip]') : null;
      if (!tr) { tipEl.style.display = 'none'; return; }
      tipEl.innerHTML = '入力: ' + tr.dataset.tip.replace(' → ', '<br>修正: ');
      tipEl.style.display = 'block';
      tipEl.style.left = (e.clientX + 14) + 'px';
      tipEl.style.top = (e.clientY + 14) + 'px';
    });
    document.addEventListener('change', function (e) {
      const t = e.target;
      if (t.dataset && t.dataset.fix !== undefined && t.tagName === 'SELECT') {
        const g = st.groups[Number(t.dataset.fix)];
        if (t.value) st.overrides[g.overrideKey] = t.value; else delete st.overrides[g.overrideKey];
        saveOverrides();
        render();
        return;
      }
      if (t.dataset && t.dataset.name !== undefined && t.tagName === 'SELECT') {
        const cell = document.querySelector('td[data-wkno="' + CSS.escape(t.dataset.name) + '"]');
        if (cell) cell.textContent = t.value || '未判定';
      }
      if (t.dataset && t.dataset.wk) {
        if (t.checked) st.selected.add(t.dataset.wk); else st.selected.delete(t.dataset.wk);
        render();
      }
    });
    document.addEventListener('click', function (e) {
      const t = e.target;
      if (!t.dataset) return;
      if (t.dataset.edit !== undefined) {
        st.editing[t.dataset.edit] = true;
        render();
      } else if (t.dataset.alias !== undefined) {
        const sel = document.querySelector('select[data-name="' + CSS.escape(t.dataset.alias) + '"]');
        if (!sel || !sel.value) { alert('工事を選択してください。'); return; }
        delete st.editing[t.dataset.alias];
        registerAlias(t.dataset.alias, sel.value);
      }
    });

    function registerAlias(name, workNo) {
      if (st.sample) { alert('サンプル表示中のため登録できません。'); return; }
      setStatus('登録中…');
      fetchJson(GAS_API_URL + '?action=saveAlias&name=' + encodeURIComponent(name) + '&workNo=' + encodeURIComponent(workNo))
        .then(function (res) {
          if (res.status !== 'success') throw new Error(res.message);
          load(false, true);
        }).catch(function (err) { setStatus('登録に失敗しました: ' + err.message, true); });
    }

    $('yearSel').addEventListener('change', function () { st.y = Number(this.value); syncPeriod(); render(); });
    $('monthSel').addEventListener('change', function () { st.m = Number(this.value); syncPeriod(); render(); });
    $('yearSel2').addEventListener('change', function () { st.y2 = Number(this.value); syncPeriod(); render(); });
    $('monthSel2').addEventListener('change', function () { st.m2 = Number(this.value); syncPeriod(); render(); });
    $('mPrev').addEventListener('click', function () { stepMonth(1, -1); });
    $('mNext').addEventListener('click', function () { stepMonth(1, 1); });
    $('mPrev2').addEventListener('click', function () { stepMonth(2, -1); });
    $('mNext2').addEventListener('click', function () { stepMonth(2, 1); });
    $('modeMulti').addEventListener('click', function () { st.multi = !st.multi; syncPeriod(); render(); });
    $('modeCalendar').addEventListener('click', function () { st.mode = 'calendar'; syncPeriod(); render(); });
    $('modeClose').addEventListener('click', function () { st.mode = 'close20'; syncPeriod(); render(); });
    // 時間単価: 「￥ 4,000」表示(#,##0)、▲▼・↑↓キーは50円単位
    function setCostText() { $('costInput').value = '￥ ' + st.cost.toLocaleString('ja-JP'); }
    function setCost(v) { st.cost = Math.max(0, Math.round(v) || 0); setCostText(); render(); }
    $('costInput').addEventListener('change', function () { setCost(Number(this.value.replace(/[^0-9]/g, ''))); });
    $('costInput').addEventListener('keydown', function (e) {
      if (e.key === 'ArrowUp') { e.preventDefault(); setCost(st.cost + 50); }
      else if (e.key === 'ArrowDown') { e.preventDefault(); setCost(st.cost - 50); }
    });
    $('costUp').addEventListener('click', function () { setCost(st.cost + 50); });
    $('costDown').addEventListener('click', function () { setCost(st.cost - 50); });
    $('reloadBtn').addEventListener('click', function () { load(true); });
    $('dlBtn').addEventListener('click', function () {
      try { downloadExcel(); } catch (err) { setStatus('Excelの作成に失敗しました: ' + err.message, true); }
    });

    // ダウンロード後のお知らせポップアップ
    function showDlNotice() {
      if ($('dlNotice')) return;
      const ov = document.createElement('div');
      ov.id = 'dlNotice'; ov.className = 'dl-notice'; ov.setAttribute('role', 'dialog');
      ov.innerHTML = '<div class="dl-notice-box"><p>「出力用」シートで加工実績を印刷できます。</p><p>「全て抽出」シートで実寸法師が開けます(C列をクリック)。</p><button type="button" class="btn primary">OK</button></div>';
      const close = function () { ov.remove(); document.removeEventListener('keydown', onKey); };
      const onKey = function (e) { if (e.key === 'Escape' || e.key === 'Enter') close(); };
      ov.addEventListener('click', function (e) { if (e.target === ov || e.target.tagName === 'BUTTON') close(); });
      document.addEventListener('keydown', onKey);
      document.body.appendChild(ov);
    }

    // Excelダウンロードを記録(GAS action=logDownload)。サンプル時は送らない。結果は待たず、失敗しても無視する
    function logDownload() {
      if (st.sample || !GAS_API_URL) return;
      const period = st.start.replace(/-/g, '/') + ' 〜 ' + st.end.replace(/-/g, '/');
      try {
        fetch(GAS_API_URL + '?action=logDownload&period=' + encodeURIComponent(period), { credentials: 'omit', keepalive: true }).catch(function () {});
      } catch (e) { /* 記録の失敗は無視 */ }
    }

    // ===== Excel出力(ExcelJS) =====
    function downloadExcel() {
      if (typeof ExcelJS === 'undefined') throw new Error('ExcelJSの読み込みに失敗しています。ネットワークを確認してください。');
      const wb = new ExcelJS.Workbook();
      const title = st.start.replace(/-/g, '/') + ' 〜 ' + st.end.replace(/-/g, '/') + ' 加工実績';
      const blue = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FFDDEBF7' } };
      const thin = { style: 'thin', color: { argb: 'FF999999' } };

      // --- 出力用(A4横) ---
      const ws = wb.addWorksheet('出力用', {
        pageSetup: { paperSize: 9, orientation: 'landscape', fitToPage: true, fitToWidth: 1, fitToHeight: 1, margins: { left: 0.4, right: 0.4, top: 0.6, bottom: 0.6, header: 0.3, footer: 0.3 } },
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
        m.robots.forEach(function (rb, i) { put(i === 0 || st.multi ? monthLabel(m.key, st.mode) : '', rb.robot + '号機', rb.v, false); });
        put(monthLabel(m.key, st.mode) + ' 集計', '', m.sub, true);
      });
      put('総計', '', st.agg.total, true);
      const hours = st.agg.total.elapsedMin / 60;
      ws.getCell('H' + (r + 1)).value = Math.round(hours * 10) / 10;
      ws.getCell('G' + (r + 1)).value = '稼動時間(時間)';
      ws.getCell('G' + (r + 2)).value = '単価(円/時間)';
      ws.getCell('H' + (r + 2)).value = st.cost;
      ws.getCell('H' + (r + 2)).numFmt = '#,##0';
      ws.getCell('G' + (r + 3)).value = '費用(円)';
      ws.getCell('H' + (r + 3)).value = Math.round(hours * st.cost);
      ws.getCell('H' + (r + 3)).numFmt = '#,##0';
      [14, 8, 14, 11, 16, 18, 16, 14].forEach(function (w, i) { ws.getColumn(i + 1).width = w; });
      ws.getRow(3).height = 32;
      ws.pageSetup.printArea = 'A1:H' + (r + 3); // 印刷範囲はA:H・A4横1ページに収める

      // --- 全て抽出(製品ごと1行) ---
      const wd = wb.addWorksheet('全て抽出', { views: [{ state: 'frozen', ySplit: 1 }], pageSetup: { paperSize: 9, orientation: 'landscape', fitToPage: true, fitToWidth: 1, fitToHeight: 0 } });
      const dh = ['工事番号', '工事名', '図面番号', '製品名', 'サイズ', '重量(t)', 'ロボット', '溶接回数', '加工日', '溶接日', '初回開始', '最終終了', '経過時間(分)', 'アークタイム(分)', '非アークタイム(分)', 'ワイヤ使用量(kg)', '換算溶接長(m)', '確認'];
      const dr = wd.getRow(1);
      dh.forEach(function (h, i) { const c = dr.getCell(i + 1); c.value = h; c.fill = blue; c.font = { bold: true }; c.alignment = { wrapText: true, vertical: 'middle' }; });
      const works = {};
      st.data.works.forEach(function (w) { works[w.workNo] = w.workName; });
      // 日付列(I:L)は実際の日付値にして m/d 表示にする(時刻は表示しない)
      const toDate = function (v) {
        const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(v || '');
        return m ? new Date(Date.UTC(+m[1], +m[2] - 1, +m[3])) : '';
      };
      st.groups.forEach(function (g, i) {
        const p = g.product;
        const row = wd.getRow(i + 2);
        const note = g.status === 'suggest' ? '要確認: 製品名候補 ' + g.suggestions.join(' / ') : g.status === 'nomark' ? '要確認: マスタに無い製品名' : g.corrected ? '修正済(入力: ' + g.enteredMark + ')' : '';
        const vals = [g.workNo, works[g.workNo] || g.enteredName, p ? p.d : '', p ? p.m : g.enteredMark, p ? p.s : '', p ? Math.round(p.w * 100) / 100 : '', g.robot + '号機', g.count, toDate(p ? p.k : ''), toDate(g.last), toDate(g.first), toDate(g.last),
          Math.round(g.run / 60), Math.round(g.arc / 60), Math.max(0, Math.round((g.run - g.arc) / 60)), Math.round(g.wire * 10) / 10, Math.round(g.len), note];
        vals.forEach(function (v, j) { row.getCell(j + 1).value = v; });
        for (let j = 9; j <= 12; j++) row.getCell(j).numFmt = 'm/d';
        [1, 3, 7, 8, 9, 10, 11, 12].forEach(function (j) { row.getCell(j).alignment = { horizontal: "center" }; }); // 工事番号・図面番号・ロボ・溶接回数・日付列は中央揃え
        if (p && p.l) { row.getCell(3).value = { text: p.d || p.m, hyperlink: p.l }; row.getCell(3).font = { color: { argb: 'FF0563C1' }, underline: true }; }
        if (g.status !== 'ok') for (let j = 1; j <= dh.length; j++) row.getCell(j).fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: g.status === 'suggest' ? 'FFFFF2CC' : 'FFF8CBAD' } };
      });
      [10, 22, 16, 18, 20, 9, 9, 9, 11, 11, 11, 11, 11, 11, 12, 11, 11, 30].forEach(function (w, i) { wd.getColumn(i + 1).width = w; });
      wd.autoFilter = { from: { row: 1, column: 1 }, to: { row: 1, column: dh.length } };
      // 罫線: 画面のテーブルと同じく、見出し・データの全セルに黒の細線。データ行(2行目以降)の高さは20
      const lineBorder = { style: 'thin', color: { argb: 'FF000000' } };
      for (let ri = 1; ri <= st.groups.length + 1; ri++) {
        const rw = wd.getRow(ri);
        if (ri >= 2) rw.height = 20;
        for (let j = 1; j <= dh.length; j++) {
          const c = rw.getCell(j);
          c.border = { top: lineBorder, left: lineBorder, bottom: lineBorder, right: lineBorder };
          if (ri >= 2) c.alignment = Object.assign({}, c.alignment, { vertical: 'middle' });
        }
      }

      // Excelの文字はすべて黒の太字(図面番号のリンクは下線だけ残す)
      wb.eachSheet(function (sheet) {
        sheet.eachRow({ includeEmpty: false }, function (row) {
          row.eachCell({ includeEmpty: false }, function (c) {
            // 図面番号のハイパーリンク付きセルは青・18pt(行の高さ・列幅は下で文字に合わせる)
            const link = sheet === wd && c.col === 3 && c.value && c.value.hyperlink;
            c.font = Object.assign({}, c.font, link ? { bold: true, size: 18, color: { argb: 'FF0000FF' }, underline: true } : { bold: true, color: { argb: 'FF000000' } });
          });
        });
      });
      // C列(図面番号)をリンク文字(18pt)に合わせて自動調整し、行の高さも全体が見えるように広げる
      let cw = 10;
      wd.eachRow({ includeEmpty: false }, function (row, ri) {
        const v = row.getCell(3).value;
        if (ri >= 2 && v && v.hyperlink) {
          const t = String(v.text || '');
          // 文字ごとの幅の重み(広い文字M/Wは大きく、細い文字I/1/-は小さく)で合計し、最も広い文字列に列幅を合わせる(細い文字で凸凹にならないよう、幅は最大値で決める)
          let len = 0;
          for (let k = 0; k < t.length; k++) {
            const ch = t.charAt(k);
            len += t.charCodeAt(k) > 255 ? 2.1 : /[MW]/.test(ch) ? 1.5 : /[Iilj.\s]/.test(ch) ? 0.6 : ch === '-' ? 0.7 : /[A-Z]/.test(ch) ? 1.2 : 1.1;
          }
          cw = Math.max(cw, len * 1.75 + 3); // 18pt は 11pt の約1.64倍(太字ぶん余裕)
          row.height = 26;
        }
      });
      wd.getColumn(3).width = Math.min(Math.ceil(cw), 80);
      wb.xlsx.writeBuffer().then(function (buf) {
        const blob = new Blob([buf], { type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' });
        const a = document.createElement('a');
        a.href = URL.createObjectURL(blob);
        a.download = '梁ロボ加工実績_' + st.start.replace(/-/g, '') + '-' + st.end.replace(/-/g, '') + '.xlsx';
        document.body.appendChild(a);
        a.click();
        setTimeout(function () { URL.revokeObjectURL(a.href); a.remove(); }, 1000);
        showDlNotice();
        logDownload(); // スプレッドシート「記録」へ日時と期間を記録(失敗してもダウンロードには影響しない)
      });
    }

    loadOverrides();
    load();
  })();
}
