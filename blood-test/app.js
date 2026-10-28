(function () {
  'use strict';

  var CFG = window.APP_CONFIG || {};
  var CACHE_KEY = 'bt_cache_v1';
  var NOTES = CFG.DATE_NOTES || {};

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
  function noteOf(date) { return NOTES[date] || ''; }
  function warn(text, small) { return '<span class="warn"' + (small ? ' style="font-weight:600"' : '') + '>' + esc(text) + '</span>'; }
  function glossBody(name) {
    var g = (window.GLOSSARY || {})[name];
    var mi = S.minfo[name] || {};
    var rng = mi.lo != null && mi.hi != null ? mi.lo + '〜' + mi.hi : mi.lo != null ? mi.lo + '以上' : mi.hi != null ? mi.hi + '以下' : '';
    if (!g) return '<div>この項目の説明は、まだ登録されていません。</div>';
    return '<dl><dt>何の数値か</dt><dd>' + esc(g.w) + '</dd>' +
      '<dt>何のための検査か</dt><dd>' + esc(g.y) + '</dd>' +
      '<dt>どうなれば正常か</dt><dd>' + (rng ? '<b>基準範囲 ' + esc(rng) + (mi.unit ? ' ' + esc(mi.unit) : '') + '</b><br>' : '') + esc(g.o) + '</dd></dl>';
  }
  function glossTitle(name) {
    var g = (window.GLOSSARY || {})[name];
    return esc(name) + (g && g.a && g.a !== name ? '<small>(' + esc(g.a) + ')</small>' : '');
  }
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

  // GASへの問い合わせ。合言葉が設定されているときは入力を求めて、このブラウザに覚える
  function post(payload) {
    var send = function (pass) {
      payload.pass = pass;
      return fetch(CFG.GAS_URL, { method: 'POST', body: JSON.stringify(payload) }).then(function (r) { return r.json(); });
    };
    var saved = '';
    try { saved = localStorage.getItem('bt_pass') || ''; } catch (e) { /* 使えなくても動く */ }
    return send(saved).then(function (d) {
      if (!d || d.error !== 'AUTH') return d;
      var p = window.prompt('合言葉を入力してください');
      if (p == null) throw new Error('合言葉が必要です');
      return send(p).then(function (d2) {
        if (d2 && d2.error === 'AUTH') {
          try { localStorage.removeItem('bt_pass'); } catch (e) { /* 使えなくても動く */ }
          throw new Error('合言葉が違います');
        }
        try { localStorage.setItem('bt_pass', p); } catch (e) { /* 使えなくても動く */ }
        return d2;
      });
    });
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
    post({ action: 'all' })
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
      var nt = cur.flag ? noteOf(cur.date) : '';  // 異常値(H・L)の項目だけ注意書きを出す
      var h = '<div class="card" data-item="' + esc(name) + '" title="' + esc(nt) + '"><h3><span class="tipn" data-tip="' + esc(name) + '">' + esc(name) + '</span><span>' + esc(cur.date) + '</span></h3>';
      var valText = cur.qual && cur.v === 0 ? cur.qual : fmt(cur.v, dec) + (cur.qual && cur.v !== 0 ? '<small>(' + esc(cur.qual) + ')</small>' : '');
      h += '<div class="val">' + valText + '<small>' + esc(mi.unit || '') + '</small>' +
        (cur.flag ? '<span class="badge ' + cur.flag + '">' + cur.flag + '</span>' : '') + '</div>';
      if (nt) h += '<div class="warn">' + esc(nt) + '</div>';
      if (n >= 2) {
        var prev = arr[n - 2], jp = judge(name, cur.v, prev.v);
        cnt[jp.cls]++;
        h += '<div class="cmp"><span class="k">前回 ' + fmt(prev.v, dec) + (nt && noteOf(prev.date) ? ' ' + warn('(' + noteOf(prev.date) + ')', true) : '') + '</span><span class="j-' + jp.cls + '">' + jp.label + ' (' + (jp.d > 0 ? '+' : '') + fmt(jp.d, dec) + ')</span></div>';
      }
      if (n >= 3) {
        var prior = arr.slice(Math.max(0, n - 4), n - 1).map(function (p) { return p.v; });
        var avg = mean(prior), ja = judge(name, cur.v, avg);
        cntAvg[ja.cls]++;
        var priorNote = arr.slice(Math.max(0, n - 4), n - 1).some(function (p) { return noteOf(p.date); });
        h += '<div class="cmp"><span class="k">直近' + prior.length + '回平均 ' + fmt(avg, dec) + (nt && priorNote ? ' ' + warn('(大腸検査日を含む)', true) : '') + '</span><span class="j-' + ja.cls + '">' + ja.label + ' (' + (ja.d > 0 ? '+' : '') + fmt(ja.d, dec) + ')</span></div>';
      }
      var rng = mi.lo != null && mi.hi != null ? mi.lo + '〜' + mi.hi : mi.lo != null ? mi.lo + '以上' : mi.hi != null ? mi.hi + '以下' : '';
      if (rng) h += '<div class="rng">基準 ' + esc(rng) + (mi.dir ? '　/　' + esc(mi.dir) : '') + '</div>';
      cards.push(h + '</div>');
    });
    var head = '<div class="headline"><div class="d">' + (latestDate ? esc(latestDate) + ' の結果' : '結果なし') + '</div>' +
      (noteOf(latestDate) ? '<div class="warn">' + esc(noteOf(latestDate)) + '(この日の数値は参考。比較は注意して見てください)</div>' : '') +
      '<div class="counts"><span class="pill">前回と比べて</span><span class="pill good">▲改善 ' + cnt.good + '</span><span class="pill bad">▼悪化 ' + cnt.bad + '</span><span class="pill flat">―横ばい ' + cnt.flat + '</span></div>' +
      '<div class="counts"><span class="pill">直近3回平均と比べて</span><span class="pill good">▲改善 ' + cntAvg.good + '</span><span class="pill bad">▼悪化 ' + cntAvg.bad + '</span><span class="pill flat">―横ばい ' + cntAvg.flat + '</span></div></div>';
    box.innerHTML = head + '<div class="cards">' + cards.join('') + '</div>';
    Array.prototype.forEach.call(box.querySelectorAll('.card'), function (el) {
      el.addEventListener('click', function (e) {
        if (e.target.closest && e.target.closest('.tipn')) return;
        S.selA = el.getAttribute('data-item'); showTab('graph');
      });
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
    return arr.map(function (p) { return { x: p.t, y: p.v, date: p.date, flag: p.flag, qual: p.qual, note: noteOf(p.date) }; });
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
    var noteColor = function (ctx) { return ctx.raw && ctx.raw.note ? cssv('--bad') : flagColor(ctx); };
    var noteWidth = function (ctx) { return ctx.raw && ctx.raw.note ? 3 : 1; };
    var noteRadius = function (ctx) { return ctx.raw && ctx.raw.note ? 7 : 4; };
    var ds = [{
      label: a + (S.minfo[a].unit ? ' (' + S.minfo[a].unit + ')' : ''), data: pts(a), yAxisID: 'y', borderColor: accent,
      backgroundColor: accent, pointBackgroundColor: flagColor, pointBorderColor: noteColor, pointBorderWidth: noteWidth, pointRadius: noteRadius, borderWidth: 2, tension: 0.15
    }];
    var scales = {
      x: { type: 'linear', ticks: { color: muted, callback: tickLabel, maxTicksLimit: 8 }, grid: { color: line } },
      y: { position: 'left', ticks: { color: muted }, grid: { color: line }, title: { display: true, text: a, color: muted } }
    };
    if (b && S.series[b]) {
      var c2 = '#e08a00';
      ds.push({
        label: b + (S.minfo[b].unit ? ' (' + S.minfo[b].unit + ')' : ''), data: pts(b), yAxisID: 'y1', borderColor: c2, backgroundColor: c2,
        pointBorderColor: function (ctx) { return ctx.raw && ctx.raw.note ? cssv('--bad') : c2; }, pointBorderWidth: noteWidth,
        pointRadius: function (ctx) { return ctx.raw && ctx.raw.note ? 6 : 3.5; }, borderWidth: 2, borderDash: [5, 3], tension: 0.15
      });
      scales.y1 = { position: 'right', ticks: { color: muted }, grid: { drawOnChartArea: false }, title: { display: true, text: b, color: muted } };
    }
    // 基準範囲の帯が軸の範囲外で見えなくならないよう、基準値までを軸に含める(片側だけの基準は、その外側にも少し余白)
    var mia = S.minfo[a], ys = pts(a).map(function (p) { return p.y; }).filter(isNum);
    if (ys.length && (mia.lo != null || mia.hi != null)) {
      var ymin = Math.min.apply(null, ys), ymax = Math.max.apply(null, ys);
      [mia.lo, mia.hi].forEach(function (e) { if (e != null) { ymin = Math.min(ymin, e); ymax = Math.max(ymax, e); } });
      var ySpan = (ymax - ymin) || Math.abs(ymax) || 1;
      scales.y.suggestedMin = ymin - ySpan * 0.05;
      scales.y.suggestedMax = ymax + ySpan * (mia.hi == null ? 0.3 : 0.05);
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
            footerColor: '#ff7b7b',
            callbacks: {
              footer: function (items) {
                var n = items.map(function (i) { return i.raw.note; }).filter(Boolean)[0];
                return n || '';
              },
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
    $('graphTip').innerHTML = [a, b].filter(function (n) { return n && S.series[n]; }).map(function (n) {
      return '<div class="gl"><h4>' + glossTitle(n) + '</h4>' + glossBody(n) + '</div>';
    }).join('');
    var noted = {};
    ds.forEach(function (d) { d.data.forEach(function (p) { if (p.note) noted[p.date] = p.note; }); });
    var nd = Object.keys(noted).sort();
    $('chartNote').innerHTML = esc('緑の帯 = 基準範囲(' + rng + ')。赤=基準より高い(H)、青=基準より低い(L)。良い方向: ' + (mi.dir || '設定なし') + '。') +
      (nd.length ? '<div class="warn">赤い輪の点 = ' + esc(noted[nd[0]]) + '(' + esc(nd.join('、')) + ')。点に触れる/タップすると表示されます。</div>' : '');
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
      URINE_COLS.map(function (c) { return '<th><span class="tipn" data-tip="' + esc(c) + '">' + esc(c.replace('U-TPテイリョ', '尿蛋白(定量)')) + '</span></th>'; }).join('') + '</tr></thead><tbody>';
    keys.forEach(function (k) {
      var kd = k.split(' ')[0];
      h += '<tr><td title="' + esc(noteOf(kd)) + '">' + esc(kd) + (noteOf(kd) ? '<div class="warn">' + esc(noteOf(kd)) + '</div>' : '') + '</td>' + URINE_COLS.map(function (c) {
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
    S.recMap = {};
    S.rows.forEach(function (r) {
      var k = r['検査日'] + ' ' + r['到着時間'];
      keys[k] = 1;
      S.recMap[k + '|' + r['項目名']] = r;
    });
    S.listKeys = Object.keys(keys).sort().reverse();
    var cur = $('selDate').value;
    $('selDate').innerHTML = S.listKeys.map(function (k) { return '<option>' + esc(k) + '</option>'; }).join('');
    if (cur && S.listKeys.indexOf(cur) >= 0) $('selDate').value = cur;
    renderList();
  }
  // 前回の検査: 選んだ検査より前で、その項目がある一番近い検査
  function prevRecord(k, name) {
    for (var i = S.listKeys.indexOf(k) + 1; i < S.listKeys.length; i++) {
      var r = S.recMap[S.listKeys[i] + '|' + name];
      if (r) return r;
    }
    return null;
  }
  // ◀=前回(一つ古い検査) ▶=次回(一つ新しい検査)。該当がなければ押せない(グレーアウト)
  function updateDateNav() {
    var i = S.listKeys.indexOf($('selDate').value);
    $('datePrev').disabled = i < 0 || i >= S.listKeys.length - 1;
    $('dateNext').disabled = i <= 0;
  }
  function moveDate(step) {
    var i = S.listKeys.indexOf($('selDate').value) + step;
    if (i < 0 || i >= S.listKeys.length) return;
    $('selDate').value = S.listKeys[i];
    renderList();
  }
  function renderList() {
    var k = $('selDate').value;
    updateDateNav();
    if (!k) { $('listBody').innerHTML = ''; return; }
    var parts = k.split(' ');
    var rows = S.rows.filter(function (r) { return r['検査日'] === parts[0] && r['到着時間'] === parts[1]; });
    rows.sort(function (a, b) { return ((S.minfo[a['項目名']] || {}).idx || 0) - ((S.minfo[b['項目名']] || {}).idx || 0); });
    var pk = S.listKeys[S.listKeys.indexOf(k) + 1] || '';
    var pdate = pk.split(' ')[0];
    var h = (noteOf(parts[0]) ? '<div class="warn" style="margin:6px 0">' + esc(noteOf(parts[0])) + '</div>' : '') +
      '<div class="tablewrap"><table><thead><tr><th>項目</th><th>今回<br><small>' + esc(parts[0]) + '</small></th>' +
      '<th class="pc">前回検査分<br><small>' + esc(pdate || 'なし') + '</small>' + (pdate && noteOf(pdate) ? '<div class="warn">' + esc(noteOf(pdate)) + '</div>' : '') + '</th>' +
      '<th>前回との差</th></tr></thead><tbody>';
    var lastCat = '';
    rows.forEach(function (r) {
      var name = r['項目名'];
      if (r['区分'] !== lastCat) { lastCat = r['区分']; h += '<tr><td colspan="4" style="text-align:left;font-weight:700;background:var(--bg)">' + esc(lastCat) + '</td></tr>'; }
      var lo = r['基準下限'], hi = r['基準上限'];
      var rng = isNum(lo) && isNum(hi) ? lo + '〜' + hi : isNum(lo) ? lo + '以上' : isNum(hi) ? hi + '以下' : '';
      var pr = prevRecord(k, name);
      var pcell = '', diff = '';
      if (pr) {
        var pcls = pr['判定'] || (pr['定性'] === '(-)' ? 'neg' : '');
        pcell = esc(cellText(pr)) + (pr['検査日'] !== pdate ? '<div class="pd">' + esc(pr['検査日']) + '</div>' : '');
        pcell = '<td class="pc ' + pcls + '">' + pcell + '</td>';
        var cv = isNum(r['値']) ? r['値'] : (ZERO_NEG[name] && r['定性'] === '(-)' ? 0 : null);
        var pv = isNum(pr['値']) ? pr['値'] : (ZERO_NEG[name] && pr['定性'] === '(-)' ? 0 : null);
        if (cv !== null && pv !== null) {
          var j = judge(name, cv, pv), dec = decimals(name);
          diff = '<span class="j-' + j.cls + '">' + j.label + ' (' + (j.d > 0 ? '+' : '') + fmt(j.d, dec) + ')</span>';
        } else if (cellText(r) !== cellText(pr)) diff = '<span class="j-flat">変化あり</span>';
        else diff = '<span class="j-flat">―同じ</span>';
      } else pcell = '<td class="pc"></td>';
      h += '<tr><td><span class="tipn" data-tip="' + esc(name) + '" tabindex="0">' + esc(name) + '</span><div class="pd">' + esc(r['単位'] || '') + (rng ? '　基準 ' + esc(rng) : '') + '</div></td><td class="' + (r['判定'] || (r['定性'] === '(-)' ? 'neg' : '')) + '">' + esc(cellText(r)) + (r['判定'] ? ' ' + esc(r['判定']) : '') + '</td>' +
        pcell + '<td>' + diff + '</td></tr>';
    });
    $('listBody').innerHTML = h + '</tbody></table></div>' +
      '<div class="note">項目名を押す(パソコンはマウスを合わせる)と、その項目の説明が出ます。色つきの列が「前回検査分」です。差の判定は、その項目の「良い方向」と基準範囲から出した目安です。</div>';
  }

  // ---- 画面切り替え -----------------------------------------------------
  function showTab(name) {
    Array.prototype.forEach.call($('tabs').querySelectorAll('button'), function (b) {
      b.classList.toggle('on', b.getAttribute('data-tab') === name);
    });
    ['summary', 'graph', 'urine', 'list', 'import'].forEach(function (t) { $('tab-' + t).hidden = t !== name; });
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

  // ---- 項目の説明(ポップアップ) ------------------------------------------
  var tipEl = null, tipFor = null, tipTimer = null;
  var canHover = window.matchMedia && window.matchMedia('(hover: hover)').matches;
  function hideTip() {
    clearTimeout(tipTimer);
    if (tipEl) tipEl.hidden = true;
    tipFor = null;
  }
  function showTip(anchor) {
    var name = anchor.getAttribute('data-tip');
    if (!tipEl) {
      tipEl = document.createElement('div');
      tipEl.className = 'tip';
      tipEl.setAttribute('role', 'tooltip');
      document.body.appendChild(tipEl);
      tipEl.addEventListener('mouseenter', function () { clearTimeout(tipTimer); });
      tipEl.addEventListener('mouseleave', function () { tipTimer = setTimeout(hideTip, 200); });
      tipEl.addEventListener('click', function (e) { if (e.target.className === 'x') hideTip(); });
    }
    clearTimeout(tipTimer);
    tipFor = anchor;
    tipEl.innerHTML = '<button class="x" type="button" aria-label="閉じる">×</button><h4>' + glossTitle(name) + '</h4>' + glossBody(name) +
      '<div class="tipfoot">一般的な説明です。数値の判断は主治医に確認してください。</div>';
    tipEl.hidden = false;
    tipEl.style.left = tipEl.style.top = '';
    if (window.innerWidth > 640) {
      var r = anchor.getBoundingClientRect(), w = tipEl.offsetWidth, h = tipEl.offsetHeight;
      var left = Math.max(8, Math.min(r.left, window.innerWidth - w - 8));
      var top = r.bottom + 6;
      if (top + h > window.innerHeight - 8) top = Math.max(8, r.top - h - 6);
      tipEl.style.left = left + 'px';
      tipEl.style.top = top + 'px';
    }
  }
  document.addEventListener('click', function (e) {
    var a = e.target.closest && e.target.closest('.tipn');
    if (a) { if (tipFor === a && !tipEl.hidden) hideTip(); else showTip(a); return; }
    if (tipEl && !tipEl.hidden && !(e.target.closest && e.target.closest('.tip'))) hideTip();
  });
  document.addEventListener('keydown', function (e) {
    if (e.key === 'Escape') hideTip();
    else if (e.key === 'Enter' && e.target.classList && e.target.classList.contains('tipn')) showTip(e.target);
  });
  window.addEventListener('scroll', function () { if (window.innerWidth > 640) hideTip(); }, true);
  if (canHover) {
    document.addEventListener('mouseover', function (e) {
      var a = e.target.closest && e.target.closest('.tipn');
      if (a && a !== tipFor) showTip(a); else if (a) clearTimeout(tipTimer);
    });
    document.addEventListener('mouseout', function (e) {
      var a = e.target.closest && e.target.closest('.tipn');
      if (a) { clearTimeout(tipTimer); tipTimer = setTimeout(hideTip, 250); }
    });
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
  $('datePrev').addEventListener('click', function () { moveDate(1); });
  $('dateNext').addEventListener('click', function () { moveDate(-1); });
  window.BT = { S: S, post: post, load: load, esc: esc, decimals: decimals, noteOf: noteOf, isNum: isNum, ZERO_NEG: ZERO_NEG };
  load();
})();
