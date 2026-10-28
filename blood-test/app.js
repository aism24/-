(function () {
  'use strict';

  var CFG = window.APP_CONFIG || {};
  var CACHE_KEY = 'bt_cache_v1';

  // サマリーに出す項目(項目名)。グラフ・サマリーの「良い方向」は項目マスタの列を使う
  var FOCUS = ['eGFR', 'クレアチニン', '尿素窒素', 'カリウム', '尿酸', '無機リン', 'カルシウム',
    'ヘモグロビン', '尿中蛋白/Cre比', '尿蛋白', '尿潜血', '尿比重'];
  // 「横ばい」とみなす変化の大きさ(これ未満は横ばい)。無い項目は基準値の5%
  var THRESH = {
    'eGFR': 2, 'クレアチニン': 0.05, '尿素窒素': 1.5, 'カリウム': 0.2, '尿酸': 0.4, '無機リン': 0.2,
    'カルシウム': 0.2, 'ヘモグロビン': 0.4, '尿中蛋白/Cre比': 0.03, '尿蛋白': 20, '尿潜血': 1,
    '尿比重': 0.003, 'アルブミン': 0.2
  };
  // 数値が空で定性が (-) のとき 0 として扱う項目(グラフ・比較用)
  var ZERO_NEG = { '尿蛋白': 1, '尿糖': 1, 'ケトン体': 1, '尿潜血': 1 };
  var URINE_COLS = ['尿比重', '尿pH', '尿蛋白', '尿糖', '尿潜血', 'ケトン体', 'RBC/F', 'WBC/F', '尿中蛋白/Cre比', 'U-TPテイリョ'];

  var S = { rows: [], master: [], series: {}, minfo: {}, order: [], latestT: 0, chart: null, selA: 'eGFR', selB: '', period: 'all' };

  function $(id) { return document.getElementById(id); }
  function esc(s) { return String(s).replace(/[&<>"]/g, function (c) { return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]; }); }
  function cssv(name) { return getComputedStyle(document.documentElement).getPropertyValue(name).trim(); }
  function isNum(v) { return typeof v === 'number' && isFinite(v); }

  // ---- 読み込み -------------------------------------------------------
  function showMsg(text, info) {
    var m = $('msg');
    m.textContent = text;
    m.className = 'msg' + (info ? ' info' : '');
    m.hidden = !text;
  }

  function loadCache() {
    try { return JSON.parse(localStorage.getItem(CACHE_KEY)); } catch (e) { return null; }
  }
  function saveCache(d) {
    try { localStorage.setItem(CACHE_KEY, JSON.stringify(d)); } catch (e) { /* 保存できなくても動く */ }
  }

  function load() {
    if (!CFG.GAS_URL) {
      showMsg('config.js の GAS_URL が空です。GASのウェブアプリURLを設定してください。', true);
      $('sub').textContent = '未設定';
      return;
    }
    var cached = loadCache();
    if (cached && !S.rows.length) { apply(cached); $('sub').textContent = '保存済みデータを表示中。更新しています…'; }
    else $('sub').textContent = '更新しています…';
    fetch(CFG.GAS_URL, { method: 'POST', body: JSON.stringify({ action: 'all' }) })
      .then(function (r) { return r.json(); })
      .then(function (d) {
        if (!d.ok) throw new Error(d.error || '読み込みに失敗しました');
        saveCache(d);
        apply(d);
        showMsg('');
      })
      .catch(function (e) {
        showMsg('読み込みに失敗しました: ' + e.message + '\n「更新」を押して再試行してください。');
        if (!S.rows.length) $('sub').textContent = '読み込めませんでした';
      });
  }

  function apply(d) {
    S.rows = d.rows || [];
    S.master = d.master || [];
    build();
    renderAll();
  }

  // ---- データ整形 -----------------------------------------------------
  function build() {
    S.minfo = {};
    S.order = [];
    S.master.forEach(function (m, i) {
      var name = m['項目名'];
      S.minfo[name] = {
        cat: m['区分'], unit: m['単位'], lo: isNum(m['基準下限']) ? m['基準下限'] : null,
        hi: isNum(m['基準上限']) ? m['基準上限'] : null, dir: m['良い方向'] || '', kidney: m['腎臓重点'] === '◎', idx: i
      };
      S.order.push(name);
    });
    S.series = {};
    S.latestT = 0;
    S.rows.forEach(function (r) {
      var name = r['項目名'];
      var t = new Date(r['検査日'] + 'T00:00:00').getTime();
      if (t > S.latestT) S.latestT = t;
      var v = null;
      if (isNum(r['値'])) v = r['値'];
      else if (ZERO_NEG[name] && r['定性'] === '(-)') v = 0;
      if (v === null) return;
      (S.series[name] = S.series[name] || []).push({ t: t, date: r['検査日'], time: r['到着時間'], v: v, flag: r['判定'] || '', qual: r['定性'] || '' });
    });
    Object.keys(S.series).forEach(function (k) {
      S.series[k].sort(function (a, b) { return a.t - b.t || (a.time < b.time ? -1 : a.time > b.time ? 1 : 0); });
    });
  }

  function decimals(name) {
    var max = 0;
    (S.series[name] || []).forEach(function (p) {
      var s = String(p.v), i = s.indexOf('.');
      if (i >= 0) max = Math.max(max, s.length - i - 1);
    });
    return Math.min(max, 3);
  }
  function fmt(v, dec) { return isNum(v) ? v.toFixed(dec) : '-'; }
  function mean(a) { return a.reduce(function (x, y) { return x + y; }, 0) / a.length; }

  // 良い方向と基準範囲から、base → cur を判定する
  function judge(name, cur, base) {
    var mi = S.minfo[name] || {};
    var th = THRESH[name] != null ? THRESH[name] : Math.abs(base) * 0.05;
    var d = cur - base;
    var res = function (cls, label) { return { cls: cls, label: label, d: d }; };
    if (mi.dir === '高いほど良い') {
      if (Math.abs(d) < th) return res('flat', '―横ばい');
      return d > 0 ? res('good', '▲改善') : res('bad', '▼悪化');
    }
    if (mi.dir === '低いほど良い') {
      if (Math.abs(d) < th) return res('flat', '―横ばい');
      return d < 0 ? res('good', '▲改善') : res('bad', '▼悪化');
    }
    if (mi.lo == null && mi.hi == null) return res('flat', '―');
    var dist = function (x) { return mi.lo != null && x < mi.lo ? mi.lo - x : (mi.hi != null && x > mi.hi ? x - mi.hi : 0); };
    var dc = dist(cur), db = dist(base);
    if (dc === 0 && db === 0) return res('flat', '―基準内');
    var dd = dc - db;
    if (Math.abs(dd) < th) return res('flat', '―横ばい');
    return dd < 0 ? res('good', '▲改善') : res('bad', '▼悪化');
  }

  // ---- サマリー -------------------------------------------------------
  function renderSummary() {
    var box = $('tab-summary');
    var cards = [], cnt = { good: 0, bad: 0, flat: 0 }, cntAvg = { good: 0, bad: 0, flat: 0 };
    var latestDate = '';
    FOCUS.forEach(function (name) {
      var arr = S.series[name];
      if (!arr || !arr.length) return;
      var n = arr.length, cur = arr[n - 1];
      if (cur.date > latestDate) latestDate = cur.date;
      var dec = decimals(name), mi = S.minfo[name] || {};
      var h = '<div class="card" data-item="' + esc(name) + '"><h3><span>' + esc(name) + '</span><span>' + esc(cur.date) + '</span></h3>';
      var valText = cur.qual && cur.v === 0 ? cur.qual : fmt(cur.v, dec) + (cur.qual && cur.v !== 0 ? '<small>(' + esc(cur.qual) + ')</small>' : '');
      h += '<div class="val">' + valText + '<small>' + esc(mi.unit || '') + '</small>' +
        (cur.flag ? '<span class="badge ' + cur.flag + '">' + cur.flag + '</span>' : '') + '</div>';
      if (n >= 2) {
        var prev = arr[n - 2], jp = judge(name, cur.v, prev.v);
        cnt[jp.cls]++;
        h += '<div class="cmp"><span class="k">前回 ' + fmt(prev.v, dec) + '</span><span class="j-' + jp.cls + '">' + jp.label + ' (' + (jp.d > 0 ? '+' : '') + fmt(jp.d, dec) + ')</span></div>';
      }
      if (n >= 3) {
        var prior = arr.slice(Math.max(0, n - 4), n - 1).map(function (p) { return p.v; });
        var avg = mean(prior), ja = judge(name, cur.v, avg);
        cntAvg[ja.cls]++;
        h += '<div class="cmp"><span class="k">直近' + prior.length + '回平均 ' + fmt(avg, dec) + '</span><span class="j-' + ja.cls + '">' + ja.label + ' (' + (ja.d > 0 ? '+' : '') + fmt(ja.d, dec) + ')</span></div>';
      }
      var rng = mi.lo != null && mi.hi != null ? mi.lo + '〜' + mi.hi : mi.lo != null ? mi.lo + '以上' : mi.hi != null ? mi.hi + '以下' : '';
      if (rng) h += '<div class="rng">基準 ' + esc(rng) + (mi.dir ? '　/　' + esc(mi.dir) : '') + '</div>';
      cards.push(h + '</div>');
    });
    var head = '<div class="headline"><div class="d">' + (latestDate ? esc(latestDate) + ' の結果' : '結果なし') + '</div>' +
      '<div class="counts"><span class="pill">前回と比べて</span><span class="pill good">▲改善 ' + cnt.good + '</span><span class="pill bad">▼悪化 ' + cnt.bad + '</span><span class="pill flat">―横ばい ' + cnt.flat + '</span></div>' +
      '<div class="counts"><span class="pill">直近3回平均と比べて</span><span class="pill good">▲改善 ' + cntAvg.good + '</span><span class="pill bad">▼悪化 ' + cntAvg.bad + '</span><span class="pill flat">―横ばい ' + cntAvg.flat + '</span></div></div>';
    box.innerHTML = head + '<div class="cards">' + cards.join('') + '</div>';
    Array.prototype.forEach.call(box.querySelectorAll('.card'), function (el) {
      el.addEventListener('click', function () { S.selA = el.getAttribute('data-item'); showTab('graph'); });
    });
    var dates = {};
    S.rows.forEach(function (r) { dates[r['検査日']] = 1; });
    $('sub').textContent = '検査 ' + Object.keys(dates).length + '日分 / 最新 ' + (latestDate || '-');
  }

  // ---- グラフ ---------------------------------------------------------
  function optionList(sel, withNone) {
    var html = withNone ? '<option value="">(なし)</option>' : '';
    var cats = [], byCat = {};
    S.order.forEach(function (name) {
      if (!S.series[name]) return;
      var c = S.minfo[name].cat;
      if (!byCat[c]) { byCat[c] = []; cats.push(c); }
      byCat[c].push(name);
    });
    cats.forEach(function (c) {
      html += '<optgroup label="' + esc(c) + '">' + byCat[c].map(function (n) { return '<option>' + esc(n) + '</option>'; }).join('') + '</optgroup>';
    });
    sel.innerHTML = html;
  }

  function renderGraphControls() {
    optionList($('selA'), false);
    optionList($('selB'), true);
    if (!S.series[S.selA]) S.selA = Object.keys(S.series)[0];
    $('selA').value = S.selA;
    $('selB').value = S.selB;
    $('chips').innerHTML = FOCUS.filter(function (n) { return S.series[n]; }).map(function (n) {
      return '<button type="button" data-item="' + esc(n) + '"' + (n === S.selA ? ' class="on"' : '') + '>' + esc(n) + '</button>';
    }).join('');
  }

  var bandPlugin = {
    id: 'refband',
    beforeDatasetsDraw: function (chart) {
      var o = chart.options.plugins.refband;
      if (!o || (o.lo == null && o.hi == null)) return;
      var y = chart.scales.y, a = chart.chartArea, ctx = chart.ctx;
      var top = o.hi != null ? y.getPixelForValue(o.hi) : a.top;
      var bot = o.lo != null ? y.getPixelForValue(o.lo) : a.bottom;
      top = Math.max(a.top, Math.min(a.bottom, top));
      bot = Math.max(a.top, Math.min(a.bottom, bot));
      if (bot <= top) return;
      ctx.save();
      ctx.fillStyle = cssv('--band');
      ctx.fillRect(a.left, top, a.right - a.left, bot - top);
      ctx.restore();
    }
  };

  function pts(name) {
    var arr = (S.series[name] || []).slice();
    if (S.period !== 'all') {
      var from = S.latestT - Number(S.period) * 86400000;
      arr = arr.filter(function (p) { return p.t >= from; });
    }
    return arr.map(function (p) { return { x: p.t, y: p.v, date: p.date, flag: p.flag, qual: p.qual }; });
  }

  function pad2(n) { return n < 10 ? '0' + n : '' + n; }
  function tickLabel(t) { var d = new Date(t); return String(d.getFullYear()).slice(2) + '/' + pad2(d.getMonth() + 1); }

  function renderChart() {
    if (!window.Chart) { $('chartNote').textContent = 'グラフ部品を読み込めませんでした(ネットワークを確認してください)。'; return; }
    var a = S.selA, b = S.selB;
    var text = cssv('--text'), muted = cssv('--muted'), line = cssv('--line'), accent = cssv('--accent');
    var flagColor = function (ctx) {
      var f = ctx.raw && ctx.raw.flag;
      return f === 'H' ? cssv('--hi') : f === 'L' ? cssv('--lo') : accent;
    };
    var ds = [{
      label: a + (S.minfo[a].unit ? ' (' + S.minfo[a].unit + ')' : ''), data: pts(a), yAxisID: 'y', borderColor: accent,
      backgroundColor: accent, pointBackgroundColor: flagColor, pointBorderColor: flagColor, pointRadius: 4, borderWidth: 2, tension: 0.15
    }];
    var scales = {
      x: { type: 'linear', ticks: { color: muted, callback: tickLabel, maxTicksLimit: 8 }, grid: { color: line } },
      y: { position: 'left', ticks: { color: muted }, grid: { color: line }, title: { display: true, text: a, color: muted } }
    };
    if (b && S.series[b]) {
      var c2 = '#e08a00';
      ds.push({
        label: b + (S.minfo[b].unit ? ' (' + S.minfo[b].unit + ')' : ''), data: pts(b), yAxisID: 'y1', borderColor: c2, backgroundColor: c2,
        pointRadius: 3.5, borderWidth: 2, borderDash: [5, 3], tension: 0.15
      });
      scales.y1 = { position: 'right', ticks: { color: muted }, grid: { drawOnChartArea: false }, title: { display: true, text: b, color: muted } };
    }
    var xs = [];
    ds.forEach(function (d) { d.data.forEach(function (p) { xs.push(p.x); }); });
    if (xs.length) {
      var pad = Math.max(86400000 * 3, (Math.max.apply(null, xs) - Math.min.apply(null, xs)) * 0.03);
      scales.x.min = Math.min.apply(null, xs) - pad;
      scales.x.max = Math.max.apply(null, xs) + pad;
    }
    if (S.chart) S.chart.destroy();
    S.chart = new window.Chart($('chart').getContext('2d'), {
      type: 'line', data: { datasets: ds }, plugins: [bandPlugin],
      options: {
        responsive: true, maintainAspectRatio: false, animation: false, parsing: false,
        interaction: { mode: 'nearest', intersect: true },
        scales: scales,
        plugins: {
          legend: { labels: { color: text } },
          refband: { lo: S.minfo[a].lo, hi: S.minfo[a].hi },
          tooltip: {
            callbacks: {
              title: function (items) { return items[0].raw.date; },
              label: function (c) {
                var r = c.raw;
                return c.dataset.label + ': ' + r.y + (r.qual && r.y !== 0 ? ' (' + r.qual + ')' : '') + (r.flag ? ' ' + r.flag : '');
              }
            }
          }
        }
      }
    });
    var mi = S.minfo[a], rng = mi.lo != null && mi.hi != null ? mi.lo + '〜' + mi.hi : mi.lo != null ? mi.lo + '以上' : mi.hi != null ? mi.hi + '以下' : 'なし';
    $('chartNote').textContent = '緑の帯 = 基準範囲(' + rng + ')。赤=基準より高い(H)、青=基準より低い(L)。良い方向: ' + (mi.dir || '設定なし') + '。';
  }

  // ---- 検尿 -----------------------------------------------------------
  function cellText(r) {
    var v = r['値'], q = r['定性'];
    if (isNum(v)) return v.toFixed(decimals(r['項目名'])) + (q ? '(' + q + ')' : '');
    return q || '';
  }
  function renderUrine() {
    var byKey = {};
    S.rows.forEach(function (r) {
      if (URINE_COLS.indexOf(r['項目名']) < 0) return;
      var k = r['検査日'] + ' ' + r['到着時間'];
      (byKey[k] = byKey[k] || {})[r['項目名']] = r;
    });
    var keys = Object.keys(byKey).sort().reverse();
    var h = '<h2>検尿・尿の検査(新しい順)</h2><div class="tablewrap"><table><thead><tr><th>検査日</th>' +
      URINE_COLS.map(function (c) { return '<th>' + esc(c.replace('U-TPテイリョ', '尿蛋白(定量)')) + '</th>'; }).join('') + '</tr></thead><tbody>';
    keys.forEach(function (k) {
      h += '<tr><td>' + esc(k.split(' ')[0]) + '</td>' + URINE_COLS.map(function (c) {
        var r = byKey[k][c];
        if (!r) return '<td></td>';
        var cls = r['判定'] || (r['定性'] === '(-)' ? 'neg' : '');
        return '<td class="' + cls + '">' + esc(cellText(r)) + '</td>';
      }).join('') + '</tr>';
    });
    $('tab-urine').innerHTML = h + '</tbody></table></div><div class="note">尿蛋白・尿糖・尿潜血・ケトン体は mg/dL(括弧は定性の段階)。赤=基準より高い、青=低い。「グラフ」タブで推移を見られます。</div>';
  }

  // ---- 一覧 -----------------------------------------------------------
  function renderListControls() {
    var keys = {};
    S.rows.forEach(function (r) { keys[r['検査日'] + ' ' + r['到着時間']] = 1; });
    var arr = Object.keys(keys).sort().reverse();
    var cur = $('selDate').value;
    $('selDate').innerHTML = arr.map(function (k) { return '<option>' + esc(k) + '</option>'; }).join('');
    if (cur && arr.indexOf(cur) >= 0) $('selDate').value = cur;
    renderList();
  }
  function renderList() {
    var k = $('selDate').value;
    if (!k) { $('listBody').innerHTML = ''; return; }
    var parts = k.split(' ');
    var rows = S.rows.filter(function (r) { return r['検査日'] === parts[0] && r['到着時間'] === parts[1]; });
    rows.sort(function (a, b) { return ((S.minfo[a['項目名']] || {}).idx || 0) - ((S.minfo[b['項目名']] || {}).idx || 0); });
    var h = '<div class="tablewrap"><table><thead><tr><th>項目</th><th>値</th><th>単位</th><th>基準</th><th>判定</th></tr></thead><tbody>';
    var lastCat = '';
    rows.forEach(function (r) {
      if (r['区分'] !== lastCat) { lastCat = r['区分']; h += '<tr><td colspan="5" style="text-align:left;font-weight:700;background:var(--bg)">' + esc(lastCat) + '</td></tr>'; }
      var lo = r['基準下限'], hi = r['基準上限'];
      var rng = isNum(lo) && isNum(hi) ? lo + '〜' + hi : isNum(lo) ? lo + '以上' : isNum(hi) ? hi + '以下' : '';
      h += '<tr><td>' + esc(r['項目名']) + '</td><td class="' + (r['判定'] || '') + '">' + esc(cellText(r)) + '</td><td>' + esc(r['単位']) + '</td><td>' + esc(rng) + '</td><td class="' + (r['判定'] || '') + '">' + esc(r['判定']) + '</td></tr>';
    });
    $('listBody').innerHTML = h + '</tbody></table></div>';
  }

  // ---- 画面切り替え -----------------------------------------------------
  function showTab(name) {
    Array.prototype.forEach.call($('tabs').querySelectorAll('button'), function (b) {
      b.classList.toggle('on', b.getAttribute('data-tab') === name);
    });
    ['summary', 'graph', 'urine', 'list'].forEach(function (t) { $('tab-' + t).hidden = t !== name; });
    if (name === 'graph') { renderGraphControls(); renderChart(); }
  }

  function renderAll() {
    renderSummary();
    renderUrine();
    renderListControls();
    renderGraphControls();
    var on = $('tabs').querySelector('button.on');
    if (on && on.getAttribute('data-tab') === 'graph') renderChart();
  }

  // ---- 起動 -----------------------------------------------------------
  $('tabs').addEventListener('click', function (e) {
    var t = e.target.getAttribute && e.target.getAttribute('data-tab');
    if (t) showTab(t);
  });
  $('reload').addEventListener('click', load);
  $('selA').addEventListener('change', function () { S.selA = this.value; renderGraphControls(); renderChart(); });
  $('selB').addEventListener('change', function () { S.selB = this.value; renderChart(); });
  $('chips').addEventListener('click', function (e) {
    var n = e.target.getAttribute && e.target.getAttribute('data-item');
    if (n) { S.selA = n; renderGraphControls(); renderChart(); }
  });
  $('period').addEventListener('click', function (e) {
    var p = e.target.getAttribute && e.target.getAttribute('data-p');
    if (!p) return;
    S.period = p;
    Array.prototype.forEach.call($('period').querySelectorAll('button'), function (b) { b.classList.toggle('on', b.getAttribute('data-p') === p); });
    renderChart();
  });
  $('selDate').addEventListener('change', renderList);
  load();
})();
