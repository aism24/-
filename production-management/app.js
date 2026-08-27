// デプロイ済みGAS WebアプリのURL(/exec で終わるURL)。デプロイ後にここへ差し替えてください。
const GAS_API_URL = "https://script.google.com/macros/s/AKfycbya0wgwbTuBN1laM8tWFGTJhJw--pTAOBAYVyrsOoXbrOXZgs9q3ZsErTSQZwJFT2c2/exec";

const SITES = ['本社', '夢前', '鳥取'];
const SITE_CLASS = { 本社: 'honsha', 夢前: 'yumesaki', 鳥取: 'tottori' };
const SITE_COLOR = { 本社: '#4da3ff', 夢前: '#35c98b', 鳥取: '#ffb454' };
const PARTS = ['柱', '大梁', '小梁', '他'];
const PERIOD_OFFSETS = [0, -1, -2, -3, -4];

// グラフの左右軸幅を、工程表のリード列幅(style.css: .work-name-col + .part-label)に
// 近い値で固定しておくため。
const TABLE_LEAD_WIDTH = 90; // work-name-col(64) + part-label(26)
const CHART_RIGHT_AXIS_WIDTH = 60;

let state = {
  data: null,
  selectedSites: new Set(SITES),
  period: null,
  targets: {},
  chart: null,
};

// ---------- GAS API ----------
async function apiGet(action) {
  const url = new URL(GAS_API_URL);
  url.searchParams.set('action', action);
  const res = await fetch(url.toString(), { method: 'GET' });
  if (!res.ok) throw new Error('サーバーエラー(HTTP ' + res.status + ')');
  const json = await res.json();
  if (json.status !== 'success') throw new Error(json.message || '取得に失敗しました');
  return json.data;
}

function showMessage(text, kind) {
  const el = document.getElementById('msgArea');
  el.textContent = text;
  el.className = 'msg' + (kind ? ' ' + kind : '');
}

// ---------- 期間(前月21日〜当月20日)の計算 ----------
function periodForOffset(offsetMonths) {
  const now = new Date();
  let endMonth = now.getMonth();
  let endYear = now.getFullYear();
  if (now.getDate() > 20) {
    endMonth += 1;
    if (endMonth > 11) { endMonth = 0; endYear++; }
  }
  endMonth += offsetMonths;
  while (endMonth < 0) { endMonth += 12; endYear--; }
  while (endMonth > 11) { endMonth -= 12; endYear++; }
  const end = new Date(endYear, endMonth, 20);
  let startMonth = endMonth - 1, startYear = endYear;
  if (startMonth < 0) { startMonth = 11; startYear--; }
  const start = new Date(startYear, startMonth, 21);
  return { start, end };
}

function dateKey(d) {
  return d.getFullYear() + '-' + pad2(d.getMonth() + 1) + '-' + pad2(d.getDate());
}
function pad2(n) { return n < 10 ? '0' + n : '' + n; }
function mdLabel(key) {
  const parts = key.split('-');
  return Number(parts[1]) + '/' + Number(parts[2]);
}
function parseDateKey(key) {
  const [y, m, d] = key.split('-').map(Number);
  return new Date(y, m - 1, d);
}
function periodLabel(period) {
  const fmt = (d) => (d.getMonth() + 1) + '/' + d.getDate();
  return fmt(period.start) + '〜' + fmt(period.end) + '（' + period.end.getFullYear() + '年' + (period.end.getMonth() + 1) + '月締め）';
}
function datesInPeriod(period) {
  const dates = [];
  const cur = new Date(period.start);
  while (cur <= period.end) {
    dates.push(dateKey(cur));
    cur.setDate(cur.getDate() + 1);
  }
  return dates;
}

// ---------- 初期化 ----------
document.addEventListener('DOMContentLoaded', function () {
  document.querySelectorAll('.site-btn').forEach(function (btn) {
    btn.classList.add('on');
    btn.addEventListener('click', function () {
      const site = btn.dataset.site;
      if (state.selectedSites.has(site)) {
        if (state.selectedSites.size === 1) return; // 最低1拠点は表示する
        state.selectedSites.delete(site);
        btn.classList.remove('on');
      } else {
        state.selectedSites.add(site);
        btn.classList.add('on');
      }
      renderAll();
    });
  });

  const periodSelect = document.getElementById('periodSelect');
  PERIOD_OFFSETS.forEach(function (offset) {
    const period = periodForOffset(offset);
    const opt = document.createElement('option');
    opt.value = String(offset);
    opt.textContent = periodLabel(period);
    periodSelect.appendChild(opt);
  });
  periodSelect.addEventListener('change', function () {
    state.period = periodForOffset(Number(periodSelect.value));
    renderAll();
  });
  state.period = periodForOffset(0);

  SITES.forEach(function (site) {
    document.getElementById('target' + site).addEventListener('input', function (e) {
      state.targets[site] = Number(e.target.value) || 0;
      renderChart();
    });
  });

  document.getElementById('btnRefresh').addEventListener('click', function () {
    loadData(true);
  });

  loadData(false);
});

async function loadData(forceRefresh) {
  const btn = document.getElementById('btnRefresh');
  btn.disabled = true;
  showMessage(forceRefresh ? '最新のExcelを読み込んで再集計しています…(数十秒かかる場合があります) ボタン操作などは現状の記録で操作反映できます' : '読み込み中…', forceRefresh ? 'loading' : '');
  try {
    if (GAS_API_URL.indexOf('PASTE_YOUR_GAS_WEB_APP_URL_HERE') >= 0) {
      throw new Error('app.js の GAS_API_URL がまだ設定されていません。');
    }
    const data = await apiGet(forceRefresh ? 'refresh' : 'getData');
    state.data = data;
    SITES.forEach(function (site) {
      if (state.targets[site] === undefined) {
        state.targets[site] = (data.targets && data.targets[site] !== undefined) ? data.targets[site] : 0;
        document.getElementById('target' + site).value = state.targets[site];
      }
    });
    document.getElementById('updatedAt').textContent = data.generatedAt ? ('最終更新: ' + data.generatedAt.replace('T', ' ').slice(0, 19)) : '';
    renderAll();
    showMessage(forceRefresh ? '最新化しました。' : '', 'ok');

    const warnEl = document.getElementById('warningsArea');
    warnEl.textContent = (data.warnings && data.warnings.length) ? data.warnings.join('\n') : '';
  } catch (err) {
    console.error(err);
    showMessage('エラー: ' + err.message, 'err');
  } finally {
    btn.disabled = false;
  }
}

function renderAll() {
  if (!state.data) return;
  renderChart();
  renderSchedule();
}

// ---------- グラフ ----------
function renderChart() {
  const data = state.data;
  const period = state.period;
  const dates = datesInPeriod(period);
  const selected = SITES.filter(function (s) { return state.selectedSites.has(s); });

  const datasets = [];
  const cumStats = [];
  selected.forEach(function (site) {
    const dailyMap = {};
    (data.dailyBySite[site] || []).forEach(function (r) { dailyMap[r.date] = r.weight; });
    const color = SITE_COLOR[site];

    const dailyValues = dates.map(function (d) { return dailyMap[d] || 0; });

    let cum = 0;
    const cumActual = dailyValues.map(function (v) { cum += v; return Math.round(cum * 100) / 100; });
    cumStats.push({ site: site, color: color, value: cumActual.length ? cumActual[cumActual.length - 1] : 0 });

    const target = state.targets[site] || 0;
    let cumTarget = 0;
    const cumTargetArr = dates.map(function (d) {
      const isWorkday = data.calendar[d] === true;
      if (isWorkday) cumTarget += target;
      return Math.round(cumTarget * 100) / 100;
    });

    datasets.push({
      type: 'bar', label: site + ' 日次実績(t)', data: dailyValues,
      backgroundColor: color, borderColor: color, yAxisID: 'yDaily', order: 3,
    });
    datasets.push({
      type: 'line', label: site + '(t)', data: cumActual,
      borderColor: color, backgroundColor: color, borderWidth: 2, pointRadius: 0,
      yAxisID: 'yCum', order: 1,
    });
    datasets.push({
      type: 'line', label: site + ' 目標ライン(t)', data: cumTargetArr,
      borderColor: color, borderDash: [4, 3], borderWidth: 1, pointRadius: 0,
      yAxisID: 'yCum', order: 2,
    });
  });

  // グラフ自体は横スクロールさせず、常にコンテナ幅いっぱいに収める。左右の軸幅だけは
  // 工程表のリード列幅・右側余白に近い値で固定し、日付の位置がおおまかに揃うようにする。
  const ctx = document.getElementById('prodChart').getContext('2d');
  if (state.chart) state.chart.destroy();
  state.chart = new Chart(ctx, {
    data: { labels: dates.map(mdLabel), datasets: datasets },
    options: {
      responsive: true, maintainAspectRatio: false,
      interaction: { mode: 'index', intersect: false },
      scales: {
        yDaily: {
          position: 'left', title: { display: true, text: '日次生産量(t)' }, grid: { color: '#2a3348' },
          afterFit: function (scale) { scale.width = TABLE_LEAD_WIDTH; },
        },
        yCum: {
          position: 'right', title: { display: true, text: '累積生産量(t)' }, grid: { display: false },
          afterFit: function (scale) { scale.width = CHART_RIGHT_AXIS_WIDTH; },
        },
        x: { grid: { color: '#1d2436' }, offset: true },
      },
      plugins: {
        legend: {
          labels: {
            color: '#e7ebf3', boxWidth: 14,
            filter: function (item) { return item.text.indexOf('日次実績') === -1; },
          },
        },
        tooltip: {
          callbacks: {
            label: function (item) {
              return item.dataset.label + ': ' + item.parsed.y.toFixed(1) + 't';
            },
          },
        },
      },
    },
  });

  renderCumStats(cumStats);
}

// その時点までの累積生産重量を、拠点ごとに数値で表示する(小数第1位で四捨五入)。
function renderCumStats(cumStats) {
  const el = document.getElementById('cumStats');
  el.innerHTML = '';
  cumStats.forEach(function (s) {
    const card = document.createElement('div');
    card.className = 'cum-stat-card';
    const label = document.createElement('div');
    label.className = 'label';
    label.innerHTML = '<span class="site-dot ' + SITE_CLASS[s.site] + '"></span>' + s.site + '生産重量';
    const value = document.createElement('div');
    value.className = 'value';
    value.innerHTML = (Math.round(s.value * 10) / 10).toFixed(1) + '<span class="unit">t</span>';
    card.appendChild(label);
    card.appendChild(value);
    el.appendChild(card);
  });
}

// ---------- 工程表 ----------
function th(text, cls) {
  const el = document.createElement('th');
  el.textContent = text;
  if (cls) el.className = cls;
  return el;
}

// テキストをchunkSize文字ごとに改行したdiv群にする。
function wrapText(text, chunkSize, cls) {
  const wrap = document.createElement('div');
  if (cls) wrap.className = cls;
  const s = text || '';
  for (let i = 0; i < s.length; i += chunkSize) {
    const lineDiv = document.createElement('div');
    lineDiv.textContent = s.slice(i, i + chunkSize);
    wrap.appendChild(lineDiv);
  }
  return wrap;
}

// 「工事番号」+改行+「工事名」(4文字ごとに改行)のラベルを組み立てる。
function buildWorkLabel(workNo, workName) {
  const frag = document.createDocumentFragment();
  const noDiv = document.createElement('div');
  noDiv.className = 'work-no';
  noDiv.textContent = workNo;
  frag.appendChild(noDiv);
  frag.appendChild(wrapText(workName, 4, 'work-name'));
  return frag;
}

function renderSchedule() {
  const data = state.data;
  const period = state.period;
  const dates = datesInPeriod(period);
  const container = document.getElementById('scheduleArea');
  container.innerHTML = '';

  const selected = SITES.filter(function (s) { return state.selectedSites.has(s); });

  selected.forEach(function (site) {
    const worksForSite = (data.works || []).filter(function (w) {
      if (!w.bySite || !w.bySite[site]) return false;
      const wd = w.bySite[site].weightByDate || {};
      return dates.some(function (d) { return wd[d] !== undefined; });
    });

    const block = document.createElement('div');
    block.className = 'schedule-site-block';
    const title = document.createElement('div');
    title.className = 'schedule-site-title';
    title.innerHTML = '<span class="site-dot ' + SITE_CLASS[site] + '"></span>' + site;
    block.appendChild(title);

    if (worksForSite.length === 0) {
      const p = document.createElement('div');
      p.className = 'empty-note';
      p.textContent = 'この期間・拠点に該当する工事データはありません。';
      block.appendChild(p);
      container.appendChild(block);
      return;
    }

    const scrollWrap = document.createElement('div');
    scrollWrap.className = 'table-scroll';
    const table = document.createElement('table');
    table.className = 'schedule-table';

    const headTr = document.createElement('tr');
    headTr.appendChild(th('工事', 'work-name-col'));
    headTr.appendChild(th('', 'part-label'));
    dates.forEach(function (d) {
      headTr.appendChild(th(mdLabel(d), 'date-th' + (data.calendar[d] === false ? ' holiday' : '')));
    });
    table.appendChild(headTr);

    worksForSite.forEach(function (w) {
      const siteData = w.bySite[site];
      const rowKeys = PARTS.concat(['生産重量']);
      rowKeys.forEach(function (rowKey, ri) {
        const tr = document.createElement('tr');
        if (rowKey === '生産重量') tr.classList.add('weight-row');
        if (ri === 0) {
          const nameTd = document.createElement('td');
          nameTd.className = 'work-name-col';
          nameTd.rowSpan = rowKeys.length;
          nameTd.appendChild(buildWorkLabel(w.workNo, w.workName));
          tr.appendChild(nameTd);
        }
        const labelTd = document.createElement('td');
        labelTd.className = 'part-label';
        labelTd.appendChild(wrapText(rowKey, 2));
        tr.appendChild(labelTd);

        dates.forEach(function (d) {
          const td = document.createElement('td');
          if (data.calendar[d] === false) td.classList.add('holiday');
          let val;
          if (rowKey === '生産重量') {
            val = siteData.weightByDate ? siteData.weightByDate[d] : undefined;
          } else {
            val = (siteData.byPart && siteData.byPart[rowKey]) ? siteData.byPart[rowKey][d] : undefined;
          }
          if (val === undefined) {
            td.classList.add('empty');
          } else if (val === 0) {
            td.classList.add('zero');
            td.textContent = rowKey === '生産重量' ? '0.0' : '0';
          } else {
            td.textContent = rowKey === '生産重量' ? val.toFixed(1) : val;
          }
          tr.appendChild(td);
        });
        table.appendChild(tr);
      });
    });

    const dailyMap = {};
    (data.dailyBySite[site] || []).forEach(function (r) { dailyMap[r.date] = r.weight; });
    const totalTr = document.createElement('tr');
    totalTr.className = 'total-row';
    const totalLabelTd = document.createElement('td');
    totalLabelTd.className = 'work-name-col';
    totalLabelTd.colSpan = 2;
    totalLabelTd.textContent = site + ' 合計';
    totalTr.appendChild(totalLabelTd);
    dates.forEach(function (d) {
      const td = document.createElement('td');
      if (data.calendar[d] === false) td.classList.add('holiday');
      const val = dailyMap[d];
      td.textContent = (val !== undefined) ? val.toFixed(1) : '0.0';
      totalTr.appendChild(td);
    });
    table.appendChild(totalTr);

    scrollWrap.appendChild(table);
    block.appendChild(scrollWrap);
    container.appendChild(block);
  });
}
