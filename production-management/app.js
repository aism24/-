// デプロイ済みGAS WebアプリのURL(/exec で終わるURL)。デプロイ後にここへ差し替えてください。
const GAS_API_URL = "https://script.google.com/macros/s/AKfycbya0wgwbTuBN1laM8tWFGTJhJw--pTAOBAYVyrsOoXbrOXZgs9q3ZsErTSQZwJFT2c2/exec";

Chart.defaults.color = '#e7ebf3'; // 軸目盛り・タイトル・ツールチップ本文の既定色(グレーは見にくいため白系に)

const SITES = ['本社', '夢前', '鳥取'];
const SITE_CLASS = { 本社: 'honsha', 夢前: 'yumesaki', 鳥取: 'tottori' };
const SITE_COLOR = { 本社: '#4da3ff', 夢前: '#35c98b', 鳥取: '#ffb454' };
const PARTS = ['柱', '大梁', '小梁', '他'];
// カレンダーが1年前の分まで用意されたので、期間セレクトも当月を含む過去12ヶ月分(1年)を選べるようにする。
const PERIOD_OFFSETS = Array.from({ length: 12 }, function (_, i) { return -i || 0; });

// グラフの左軸幅を、工程表のリード列幅(style.css: .work-name-col + .part-label)に
// 固定しておくため。
const TABLE_LEAD_WIDTH = 112; // work-name-col(64) + part-label(48)

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

// 現在の画面表示(ヘッダー・ツールバー・グラフ・拠点ごとの工程表)を、そのままPDFとして
// ダウンロードする。jsPDF単体は日本語フォントを持たないため、html2canvasで各セクションを
// 画像化してPDFに貼り付ける方式にしている。キャプチャ中だけ.pdf-exportクラスを付け、
// 印刷用と同じ明るい配色・ボタン非表示にして読みやすい見た目にする。
async function downloadPdf() {
  const btn = document.getElementById('btnPdfDownload');
  const originalLabel = btn.textContent;
  btn.disabled = true;
  btn.textContent = 'PDF作成中…';
  document.body.classList.add('pdf-export');
  // クラス切り替えによるレイアウト確定を待つ
  await new Promise(function (r) { requestAnimationFrame(function () { requestAnimationFrame(r); }); });

  try {
    const { jsPDF } = window.jspdf;
    const doc = new jsPDF({ orientation: 'landscape', unit: 'pt', format: 'a4' });
    const margin = 24;
    const pageW = doc.internal.pageSize.getWidth();
    const pageH = doc.internal.pageSize.getHeight();
    const maxW = pageW - margin * 2;
    const maxH = pageH - margin * 2;

    let cursorY = margin;
    let isFirstImage = true;

    async function addElementImage(el, opts) {
      if (!el) return;
      const canvas = await html2canvas(el, { scale: 2, backgroundColor: '#ffffff' });
      const imgData = canvas.toDataURL('image/jpeg', 0.95);
      let w = maxW;
      let h = (canvas.height / canvas.width) * w;
      const needsNewPage = (opts && opts.alwaysNewPage) || h > maxH || (!isFirstImage && cursorY + h > pageH - margin);
      if (needsNewPage) {
        if (!isFirstImage) doc.addPage();
        cursorY = margin;
      }
      if (h > maxH) {
        w = w * (maxH / h);
        h = maxH;
      }
      doc.addImage(imgData, 'JPEG', margin, cursorY, w, h);
      cursorY += h + 14;
      isFirstImage = false;
    }

    await addElementImage(document.querySelector('.app-header'));
    await addElementImage(document.querySelector('.toolbar'));

    // Chart.jsのcanvasは描画時の文字色がそのままピクセルに焼き込まれるため、
    // 通常表示用の明るい文字色のままキャプチャすると白背景のPDF上でほぼ見えなくなる。
    // 濃い色で一時的に再描画してキャプチャし、直後に元の色へ戻す(失敗時も必ず戻す)。
    try {
      Chart.defaults.color = '#111111';
      renderChart();
      await addElementImage(document.querySelectorAll('.panel')[0]); // 生産量グラフ
    } finally {
      Chart.defaults.color = '#e7ebf3';
      renderChart();
    }

    const blocks = document.querySelectorAll('.schedule-site-block');
    for (let i = 0; i < blocks.length; i++) {
      await addElementImage(blocks[i], { alwaysNewPage: true }); // 拠点ごとに新しいページ
    }

    const now = new Date();
    const fname = '生産管理ダッシュボード_' + now.getFullYear() + pad2(now.getMonth() + 1) + pad2(now.getDate()) + '.pdf';
    doc.save(fname);
  } catch (err) {
    console.error(err);
    showMessage('PDF作成でエラーが発生しました: ' + err.message, 'err');
  } finally {
    document.body.classList.remove('pdf-export');
    btn.disabled = false;
    btn.textContent = originalLabel;
  }
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
// 工程表の日付見出し用。期間が「前月21日〜当月20日」に固定されているため、
// 日の数字(1〜31)だけで月をまたいでも重複しない。月はブロック見出し側の
// 「〆」表記(renderSchedule内のtitle生成)で示す。
function dayLabel(key) {
  return Number(key.split('-')[2]);
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

// 拠点ボタンの選択状態(state.selectedSitesとボタンの見た目)をまとめて切り替える。
function applySiteSelection(sites) {
  state.selectedSites = new Set(sites);
  document.querySelectorAll('.site-btn').forEach(function (btn) {
    const site = btn.dataset.site;
    const on = (site === '__all__') ? (sites.length === SITES.length) : sites.length === 1 && sites[0] === site;
    btn.classList.toggle('on', on);
  });
}

// ---------- 初期化 ----------
document.addEventListener('DOMContentLoaded', function () {
  // 拠点ボタンは「全て」or「1拠点だけ」のラジオ的な排他選択。
  applySiteSelection(SITES);
  document.querySelectorAll('.site-btn').forEach(function (btn) {
    btn.addEventListener('click', function () {
      const site = btn.dataset.site;
      applySiteSelection(site === '__all__' ? SITES : [site]);
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

  document.getElementById('btnPdfDownload').addEventListener('click', downloadPdf);

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
  renderWorkdayBadge();
}

// 選択中の締め期間について、カレンダー(会社カレンダーの出勤/休日)から
// 営業日数を数えて期間セレクトの横に表示する。
function renderWorkdayBadge() {
  const dates = datesInPeriod(state.period);
  const count = dates.filter(function (d) { return state.data.calendar[d] === true; }).length;
  document.getElementById('workdayBadge').textContent = '営業日数＝' + count + '日';
}

// ---------- グラフ ----------
function renderChart() {
  const data = state.data;
  const period = state.period;
  const dates = datesInPeriod(period);
  const selected = SITES.filter(function (s) { return state.selectedSites.has(s); });

  // 平均生産重量の分母(営業日数)。進行中の期間(今日を含む/未来)は「経過営業日数
  // (今日を含まない)」、既に終わった期間は「期間全体の営業日数」で割る。
  const today = new Date();
  today.setHours(0, 0, 0, 0);
  const isOngoingPeriod = !(period.end < today);
  const workdays = dates.filter(function (d) { return data.calendar[d] === true; });
  const avgDenom = isOngoingPeriod
    ? workdays.filter(function (d) { return parseDateKey(d) < today; }).length
    : workdays.length;

  const datasets = [];
  const cumStats = [];
  selected.forEach(function (site) {
    const dailyMap = {};
    (data.dailyBySite[site] || []).forEach(function (r) { dailyMap[r.date] = r.weight; });
    const color = SITE_COLOR[site];

    const dailyValues = dates.map(function (d) { return dailyMap[d] || 0; });

    let cum = 0;
    const cumActual = dailyValues.map(function (v) { cum += v; return Math.round(cum * 100) / 100; });
    const totalWeight = cumActual.length ? cumActual[cumActual.length - 1] : 0;

    const target = state.targets[site] || 0;
    const avg = avgDenom > 0 ? totalWeight / avgDenom : 0;
    const belowTarget = target > 0 && avg < target;
    cumStats.push({ site: site, color: color, value: totalWeight, avg: avg, belowTarget: belowTarget });

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
        // 右側の累積軸は表示せず(現在値は上部の数値カードで確認できる)、その分の幅を
        // 日付の描画エリアに回す。これにより工程表(左のリード列だけを引いた残りを
        // 日数で等分)と、グラフの1日あたりの幅がほぼ一致する。
        yCum: { position: 'right', display: false },
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
    card.className = 'cum-stat-card ' + SITE_CLASS[s.site] + (s.belowTarget ? ' below-target' : '');
    const label = document.createElement('div');
    label.className = 'label';
    label.textContent = s.site + '生産重量';
    const value = document.createElement('div');
    value.className = 'value';
    value.innerHTML = (Math.round(s.value * 10) / 10).toFixed(1) + '<span class="unit">t</span>';
    const avg = document.createElement('div');
    avg.className = 'avg' + (s.belowTarget ? ' warn' : '');
    avg.innerHTML = '平均生産重量＝' + (Math.round(s.avg * 10) / 10).toFixed(1) + '<span class="unit">t/日</span>';
    card.appendChild(label);
    card.appendChild(value);
    card.appendChild(avg);
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
    // 日付見出しを日だけにした分、この行で「何月何日締めか」を示す(例: 本社「9/20〆工程表」)。
    title.innerHTML = '<span class="site-dot ' + SITE_CLASS[site] + '"></span>' +
      site + '「' + mdLabel(dateKey(period.end)) + '〆工程表」';
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
    scrollWrap.className = 'table-scroll ' + SITE_CLASS[site];
    const table = document.createElement('table');
    table.className = 'schedule-table';
    table.style.setProperty('--num-dates', dates.length);

    const headTr = document.createElement('tr');
    headTr.appendChild(th('工事', 'work-name-col'));
    headTr.appendChild(th('', 'part-label'));
    dates.forEach(function (d) {
      headTr.appendChild(th(dayLabel(d), 'date-th' + (data.calendar[d] === false ? ' holiday' : '')));
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
        labelTd.textContent = rowKey;
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
      const text = (val !== undefined) ? val.toFixed(1) : '0.0';
      // 合計がゼロの日は数値を背景色に同化させて見えなくする(ゼロが並ぶ見た目のノイズを消す)。
      if (text === '0.0') td.classList.add('zero-total');
      td.textContent = text;
      totalTr.appendChild(td);
    });
    table.appendChild(totalTr);

    scrollWrap.appendChild(table);
    block.appendChild(scrollWrap);
    container.appendChild(block);
  });
}
