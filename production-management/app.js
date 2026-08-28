// デプロイ済みGAS WebアプリのURL(/exec で終わるURL)。デプロイ後にここへ差し替えてください。
const GAS_API_URL = "https://script.google.com/macros/s/AKfycbya0wgwbTuBN1laM8tWFGTJhJw--pTAOBAYVyrsOoXbrOXZgs9q3ZsErTSQZwJFT2c2/exec";

Chart.defaults.color = '#e7ebf3'; // 軸目盛り・タイトル・ツールチップ本文の既定色(グレーは見にくいため白系に)
Chart.register(ChartDataLabels); // 累積実績の折れ線上に数値を出すためのプラグイン(グラフ全体の既定はplugins.datalabels.display:falseにし、累積実績データセットだけで個別に有効化する)

const SITES = ['本社', '夢前', '鳥取'];
const SITE_CLASS = { 本社: 'honsha', 夢前: 'yumesaki', 鳥取: 'tottori' };
const SITE_COLOR = { 本社: '#4da3ff', 夢前: '#ffb454', 鳥取: '#35c98b' };
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
  dayDetail: null, // 生産結果明細ポップアップで開いている{site, dateKey}(PDF出力のファイル名生成用)
};

// 工程表で現在ハイライト中の列({table, dateKey})。setScheduleColumnHover_でのみ更新する。
let scheduleHoverCell = null;

// PDFキャプチャ用にグラフを再描画している間だけtrueにする(downloadPdf内でのみ切り替える)。
// body.pdf-exportクラスの有無で判定すると、クラスが外れるタイミングとの前後関係次第で
// 通常表示に戻す最後の再描画までツールチップが無効なままになりかねないため、専用のフラグにする。
let pdfCaptureMode = false;

// 「工場別PDF」出力中だけtrueにする(buildPdf_内でのみ切り替える)。trueの間、
// renderChartはグラフ上部(Chart.jsのtitle領域)に選択中拠点の合計生産重量を表示し、
// 日次実績の各棒の上にもその日の生産重量を表示する(いずれも3工場PDF・通常表示では出さない)。
let isSitePdfExport = false;

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
// html2canvasは<select>/<input>の中身(選択中のテキストや入力値)を正しく描画できず、
// 見えなくなったり途切れたりすることがある。PDFキャプチャ中だけ、同じ内容を表示する
// 読み取り専用のspanに差し替え、キャプチャ後に元へ戻す。
function swapControlsForCapture_() {
  const swaps = [];
  function swap(el, text) {
    if (!el) return;
    const mirror = document.createElement('span');
    mirror.className = 'pdf-control-mirror';
    mirror.textContent = text;
    el.style.display = 'none';
    el.parentNode.insertBefore(mirror, el);
    swaps.push({ el: el, mirror: mirror });
  }
  const periodSelect = document.getElementById('periodSelect');
  swap(periodSelect, periodSelect.options[periodSelect.selectedIndex].textContent);
  SITES.forEach(function (site) {
    const input = document.getElementById('target' + site);
    swap(input, input.value);
  });
  return swaps;
}
function restoreControlsAfterCapture_(swaps) {
  swaps.forEach(function (s) {
    s.mirror.remove();
    s.el.style.display = '';
  });
}

// 印刷用と同じ明るい配色・ボタン非表示にして読みやすい見た目にする。
// opts.includeHeaderToolbar: アプリ行・ツールバー(拠点/締日/目標日産量)を含めるか
// opts.scheduleAlwaysNewPage: 工程表を新しいページから始めるか(3工場PDFはtrue、
//   工場別PDFはグラフと同じページに続けたいのでfalse)
// opts.filenameTag: ファイル名の先頭【】内に入れる拠点名(3工場PDFは'全て'固定)
async function buildPdf_(btn, opts) {
  const originalLabel = btn.textContent;
  btn.disabled = true;
  btn.textContent = 'PDF作成中…';
  document.body.classList.add('pdf-export');
  // クラス切り替えによるレイアウト確定を待つ
  await new Promise(function (r) { requestAnimationFrame(function () { requestAnimationFrame(r); }); });
  const controlSwaps = swapControlsForCapture_();

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

    async function addElementImage(el, imgOpts) {
      if (!el) return;
      const canvas = await html2canvas(el, { scale: 2, backgroundColor: '#ffffff' });
      const imgData = canvas.toDataURL('image/jpeg', 0.95);
      let w = maxW;
      let h = (canvas.height / canvas.width) * w;
      const needsNewPage = (imgOpts && imgOpts.alwaysNewPage) || h > maxH || (!isFirstImage && cursorY + h > pageH - margin);
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

    if (opts.includeHeaderToolbar) {
      await addElementImage(document.querySelector('.app-header'));
      await addElementImage(document.querySelector('.toolbar'));
    }

    // Chart.jsのcanvasは描画時の文字色がそのままピクセルに焼き込まれるため、
    // 通常表示用の明るい文字色のままキャプチャすると白背景のPDF上でほぼ見えなくなる。
    // 濃い色で一時的に再描画してキャプチャし、直後に元の色へ戻す(失敗時も必ず戻す)。
    const originalAnimation = Chart.defaults.animation;
    let chartCanvas;
    try {
      Chart.defaults.color = '#111111';
      // アニメーション有効のままだと、再描画直後はcanvasにまだ何も描かれていない(または
      // 描画途中)の状態でhtml2canvasがキャプチャしてしまい、グラフが真っ白になることが
      // あったため、キャプチャ用の再描画はアニメーション無しにする。
      Chart.defaults.animation = false;
      pdfCaptureMode = true;
      // 「工場別PDF」だけ、グラフ上部(Chart.jsのtitle領域。凡例と重ならない専用の
      // レイアウト枠)に選択中拠点の合計生産重量をテキストで入れる。
      isSitePdfExport = !!opts.isSitePdfExport;
      renderChart();
      // Chart.jsの描画自体もrequestAnimationFrameで行われるため、再描画呼び出し直後では
      // なく数フレーム後にキャプチャする。
      await new Promise(function (r) { requestAnimationFrame(function () { requestAnimationFrame(r); }); });
      if (opts.combineChartAndSchedule) {
        chartCanvas = await html2canvas(document.querySelectorAll('.panel')[0], { scale: 2, backgroundColor: '#ffffff' });
      } else {
        await addElementImage(document.querySelectorAll('.panel')[0]); // 生産量グラフ
      }
    } finally {
      Chart.defaults.color = '#e7ebf3';
      Chart.defaults.animation = originalAnimation;
      pdfCaptureMode = false;
      isSitePdfExport = false;
      renderChart();
    }

    if (opts.combineChartAndSchedule) {
      // 工場別PDF: グラフと工程表を必ず同じ1ページに収める。それぞれ独立にaddElementImage
      // すると、2つ目(工程表)が入り切らない時に自動で2ページ目へ送られてしまうため、
      // ここでは2枚をまとめて採寸し、収まらない場合は2枚まとめて同じ比率で縮小する。
      const scheduleCanvas = await html2canvas(document.getElementById('scheduleArea'), { scale: 2, backgroundColor: '#ffffff' });
      const gap = 14;
      const chartH = (chartCanvas.height / chartCanvas.width) * maxW;
      const scheduleH = (scheduleCanvas.height / scheduleCanvas.width) * maxW;
      const scale = Math.min(1, maxH / (chartH + gap + scheduleH));
      const w = maxW * scale;
      const chartHFinal = chartH * scale;
      const scheduleHFinal = scheduleH * scale;
      doc.addImage(chartCanvas.toDataURL('image/jpeg', 0.95), 'JPEG', margin, cursorY, w, chartHFinal);
      doc.addImage(scheduleCanvas.toDataURL('image/jpeg', 0.95), 'JPEG', margin, cursorY + chartHFinal + gap * scale, w, scheduleHFinal);
    } else {
      await addElementImage(document.getElementById('scheduleArea'), { alwaysNewPage: opts.scheduleAlwaysNewPage });
    }

    // ファイル名は「【拠点名】ダウンロード日付_締め日_時刻」の順
    // (例: 【全て】20260828_R8年9月20日〆_103618 / 【本社】20260828_R8年9月20日〆_103618)。
    // 拠点名を先頭にすることでどちらのPDFかひと目で分かり、日付・時刻は従来通り
    // 日付順に並び同じ締め日を何度出力しても重複しないようにする。
    const now = new Date();
    const datePart = now.getFullYear() + pad2(now.getMonth() + 1) + pad2(now.getDate());
    const timePart = pad2(now.getHours()) + pad2(now.getMinutes()) + pad2(now.getSeconds());
    const fname = '【' + opts.filenameTag + '】' + datePart + '_' + eraLabel(state.period.end) + '_' + timePart + '.pdf';
    doc.save(fname);
  } catch (err) {
    console.error(err);
    showMessage('PDF作成でエラーが発生しました: ' + err.message, 'err');
  } finally {
    restoreControlsAfterCapture_(controlSwaps);
    document.body.classList.remove('pdf-export');
    btn.disabled = false;
    btn.textContent = originalLabel;
  }
}

// 「3工場PDF」: これまで通りアプリ行・ツールバーを含み、工程表は新しいページにまとめる。
function downloadPdfAll() {
  return buildPdf_(document.getElementById('btnPdfAll'), {
    includeHeaderToolbar: true,
    scheduleAlwaysNewPage: true,
    filenameTag: '全て',
  });
}

// 「工場別PDF」: アプリ行・ツールバー(拠点/締日/目標日産量)は含めず、選択中の1拠点の
// グラフと工程表を必ず同じ1ページに収める(収まらなければ2枚まとめて縮小する)。
function downloadPdfSite() {
  const site = Array.from(state.selectedSites)[0];
  return buildPdf_(document.getElementById('btnPdfSite'), {
    includeHeaderToolbar: false,
    combineChartAndSchedule: true,
    isSitePdfExport: true,
    filenameTag: site,
  });
}

function showMessage(text, kind) {
  const el = document.getElementById('msgArea');
  el.textContent = text;
  el.className = 'msg' + (kind ? ' ' + kind : '');
}

// ブラウザ標準のalert()は画面上部に出て見落としやすいため、案内メッセージは
// 画面中央のポップアップ(#alertOverlay)で表示する。
function showCenterAlert(message) {
  document.getElementById('alertBody').textContent = message;
  document.getElementById('alertOverlay').hidden = false;
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
// 締め日を和暦(令和)表記にする。アプリが扱う期間は常に令和(2019/5/1〜)の範囲内。
function eraLabel(d) {
  return 'R' + (d.getFullYear() - 2018) + '年' + (d.getMonth() + 1) + '月' + d.getDate() + '日〆';
}
// 年度(11月21日始まり・翌年11月20日決算)。11月20日締めまでが前年度、
// 12月20日締め以降が新年度。
function fiscalYear(d) {
  return (d.getMonth() + 1) >= 12 ? d.getFullYear() : d.getFullYear() - 1;
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
  // 「3工場PDF」は拠点が全て選択中、「工場別PDF」は拠点が1つだけ選択中の時だけ有効。
  // 見た目だけグレーにして、押されたときにポップアップで案内する(クリック自体は塞がない)。
  document.getElementById('btnPdfAll').classList.toggle('soft-disabled', sites.length !== SITES.length);
  document.getElementById('btnPdfSite').classList.toggle('soft-disabled', sites.length !== 1);
}

// .toolbar(拠点・期間・目標日産量の行)をapp-headerのすぐ下に貼り付けて固定するため、
// app-headerの実際の高さ(ウィンドウ幅によって折り返して変わりうる)を
// CSSカスタムプロパティに反映する(style.css側の.toolbarのtopで参照)。
function syncHeaderHeight_() {
  const header = document.querySelector('.app-header');
  if (header) document.documentElement.style.setProperty('--app-header-height', header.offsetHeight + 'px');
}

// ---------- 初期化 ----------
document.addEventListener('DOMContentLoaded', function () {
  syncHeaderHeight_();
  window.addEventListener('resize', syncHeaderHeight_);

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
  const periodPrevBtn = document.getElementById('periodPrev');
  const periodNextBtn = document.getElementById('periodNext');
  const currentFiscalYear = fiscalYear(periodForOffset(0).end);
  PERIOD_OFFSETS.forEach(function (offset) {
    const period = periodForOffset(offset);
    const opt = document.createElement('option');
    opt.value = String(offset);
    opt.textContent = eraLabel(period.end);
    // 1年分のリストのうち、当年度より前(前年度)の締めはオレンジ文字で区別する。
    if (fiscalYear(period.end) < currentFiscalYear) opt.classList.add('prev-fy');
    periodSelect.appendChild(opt);
  });

  // PERIOD_OFFSETSは[0, -1, ..., -11]の順(先頭が最新月、末尾が最も古い月)。
  // ▼(1ヶ月前)は末尾方向、▲(翌月)は先頭方向へ1つ進む。リストの端に達したら
  // その方向のボタンをグレーアウトする。
  function selectPeriodOffset(offset) {
    periodSelect.value = String(offset);
    state.period = periodForOffset(offset);
    const idx = PERIOD_OFFSETS.indexOf(offset);
    periodPrevBtn.disabled = (idx >= PERIOD_OFFSETS.length - 1);
    periodNextBtn.disabled = (idx <= 0);
    renderAll();
  }

  periodSelect.addEventListener('change', function () {
    selectPeriodOffset(Number(periodSelect.value));
  });
  periodPrevBtn.addEventListener('click', function () {
    const idx = PERIOD_OFFSETS.indexOf(Number(periodSelect.value));
    if (idx < PERIOD_OFFSETS.length - 1) selectPeriodOffset(PERIOD_OFFSETS[idx + 1]);
  });
  periodNextBtn.addEventListener('click', function () {
    const idx = PERIOD_OFFSETS.indexOf(Number(periodSelect.value));
    if (idx > 0) selectPeriodOffset(PERIOD_OFFSETS[idx - 1]);
  });

  selectPeriodOffset(0);

  SITES.forEach(function (site) {
    document.getElementById('target' + site).addEventListener('input', function (e) {
      state.targets[site] = Number(e.target.value) || 0;
      renderChart();
    });
  });

  document.getElementById('btnRefresh').addEventListener('click', function () {
    loadData(true);
  });

  document.getElementById('btnPdfAll').addEventListener('click', function () {
    if (state.selectedSites.size !== SITES.length) {
      showCenterAlert('拠点を「全て」に選択してください');
      return;
    }
    downloadPdfAll();
  });
  document.getElementById('btnPdfSite').addEventListener('click', function () {
    if (state.selectedSites.size !== 1) {
      showCenterAlert('拠点を1つ選択してください');
      return;
    }
    downloadPdfSite();
  });

  document.getElementById('mismatchClose').addEventListener('click', function () {
    document.getElementById('mismatchOverlay').hidden = true;
  });
  document.getElementById('alertClose').addEventListener('click', function () {
    document.getElementById('alertOverlay').hidden = true;
  });

  // 工程表の日付列(部位の行・生産重量の行・合計行・日付見出し、いずれのセルでも)を
  // クリックすると、その拠点・その日の生産結果明細ポップアップを開く。工程表全体は
  // renderScheduleのたびに作り直されるため、要素を毎回個別にbindするのではなく
  // #scheduleArea自体に1回だけイベント委譲で仕込む。
  document.getElementById('scheduleArea').addEventListener('click', function (e) {
    const cell = e.target.closest('[data-date]');
    if (!cell) return;
    const table = cell.closest('table.schedule-table');
    if (!table) return;
    showDayDetail(table.dataset.site, cell.dataset.date);
  });
  // クリックできる列であることが分かるよう、カーソルを合わせたセルと同じ日付の列全体
  // (日付見出し〜合計行まで)を水色でハイライトする。工程表は複数の拠点ブロックに分かれて
  // 独立したtableを持つため、拠点をまたいで同じ日付を誤ってハイライトしないようtable単位で
  // 管理する。
  document.getElementById('scheduleArea').addEventListener('mouseover', function (e) {
    const cell = e.target.closest('[data-date]');
    const table = cell && cell.closest('table.schedule-table');
    if (table) {
      setScheduleColumnHover_(table, cell.dataset.date);
    } else {
      setScheduleColumnHover_(null, null);
    }
  });
  document.getElementById('scheduleArea').addEventListener('mouseleave', function () {
    setScheduleColumnHover_(null, null);
  });
  document.getElementById('dayDetailClose').addEventListener('click', function () {
    document.getElementById('dayDetailOverlay').hidden = true;
  });
  // モーダル本体(.day-detail-modal)の外側、背景の半透明部分をクリックした時だけ閉じる。
  // e.target === e.currentTargetで「オーバーレイ自身がクリックされた」場合に限定することで、
  // モーダル内のクリックがバブリングしてきても誤って閉じないようにする。
  document.getElementById('dayDetailOverlay').addEventListener('click', function (e) {
    if (e.target === e.currentTarget) e.currentTarget.hidden = true;
  });
  document.getElementById('dayDetailPdf').addEventListener('click', downloadDayDetailPdf);

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

    renderNameMismatchPopup(data.nameMismatches);
  } catch (err) {
    console.error(err);
    showMessage('エラー: ' + err.message, 'err');
  } finally {
    btn.disabled = false;
  }
}

// 索引シートのD列(ファイル名)と、実際にドライブ上にあるファイルの名前が食い違っている
// 案件があれば、工事が差し替わったのに索引シートの更新が漏れている可能性が高いのでポップアップ表示する。
function renderNameMismatchPopup(nameMismatches) {
  const overlay = document.getElementById('mismatchOverlay');
  if (!nameMismatches || !nameMismatches.length) {
    overlay.hidden = true;
    return;
  }
  const body = document.getElementById('mismatchBody');
  body.textContent = nameMismatches.map(function (m) {
    return '工事番号「' + m.workNo + '」: 索引シートのファイル名は「' + m.indexFileName +
      '」ですが、実際のファイル名は「' + m.actualFileName + '」になっています。' +
      '工事が差し替わっている可能性があるため、管理者に工事更新依頼をしてください。';
  }).join('\n\n');
  overlay.hidden = false;
}

function renderAll() {
  if (!state.data) return;
  renderChart();
  renderSchedule();
  renderWorkdayBadge();
  document.getElementById('periodEndBadge').textContent = eraLabel(state.period.end);
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
  selected.forEach(function (site, siteIndex) {
    const dailyMap = {};
    (data.dailyBySite[site] || []).forEach(function (r) { dailyMap[r.date] = r.weight; });
    const color = SITE_COLOR[site];
    // PDF印刷時は、拠点ごとの色分けではなくグラフ(棒・折れ線)を黒一色にする指定のため、
    // データセットの色はこちらを使う(cumStats・上部カードの色は従来通りcolorのまま)。
    const chartColor = pdfCaptureMode ? '#000000' : color;

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
      backgroundColor: chartColor, borderColor: chartColor, yAxisID: 'yDaily', order: 3,
      tooltipLabel: site + '本日', // ツールチップ表示専用の短い名前(凡例フィルタ等ではlabelを使うため別に持つ)
      // 「工場別PDF」ダウンロード時だけ、各棒の上にその日の生産重量を数値で入れる
      // (アプリ画面上・3工場PDFでは出さない。拠点数×日数ぶん並ぶと逆に見にくくなるため)。
      // 実績0の日は表示しない。
      datalabels: {
        display: function (ctx) { return isSitePdfExport && ctx.dataset.data[ctx.dataIndex] > 0; },
        color: chartColor, align: 'top', anchor: 'end',
        font: { size: 9 }, formatter: function (v) { return v.toFixed(1) + 't'; },
      },
    });
    datasets.push({
      type: 'line', label: site + '(t)', data: cumActual,
      borderColor: chartColor, backgroundColor: chartColor, borderWidth: 2, pointRadius: 0,
      yAxisID: 'yCum', order: 1,
      tooltipLabel: site + '累積',
      // 累積実績の数値をグラフ上にも直接表示する(アプリ画面・PDFの両方)。他のデータセット
      // (棒・目標ライン・目標日産量)には出さないよう、チャート全体の既定はdisplay:falseにし、
      // ここだけ個別にtrueで上書きする。
      datalabels: {
        // 毎日分表示すると数字同士が重なって見づらいため、期間最終日(締め日)の
        // 1点だけに絞って表示する。複数拠点の最終値が近いと、線・ラベル同士が重なって
        // 読めなくなるため、拠点ごとに線を挟んで上下交互に、かつ少しずつ離す位置へずらす
        // (siteIndex: 0番目は線の上、1番目は線の下、2番目は0番目よりさらに上)。
        display: function (ctx) { return ctx.dataIndex === ctx.dataset.data.length - 1; },
        color: chartColor,
        align: siteIndex % 2 === 0 ? 'top' : 'bottom',
        anchor: 'end',
        offset: 6 + Math.floor(siteIndex / 2) * 16,
        // 最終日はプロット領域の右端ぴったりの位置になるため、clampなしだとラベルの
        // 右半分がグラフ領域の外へはみ出して見切れる。chart area内に収まるよう
        // 自動的に位置調整させる。
        clamp: true,
        font: { size: 10, weight: 'bold' },
        formatter: function (v) { return site + '　' + v.toFixed(1) + 't'; },
      },
    });
    datasets.push({
      type: 'line', label: site + ' 目標ライン(t)', data: cumTargetArr,
      borderColor: chartColor, borderDash: [4, 3], borderWidth: 1, pointRadius: 0,
      yAxisID: 'yCum', order: 2,
    });
    // 日次の実績棒がこの目標日産量を上回っているかどうかをひと目で分かるように、
    // 累積目標ライン(yCum、破線)とは別に、日次実績と同じyDaily軸上へ目標日産量の
    // 一点鎖線を引く。xAxisIDを専用のxLine(offset:false)にすることで、通常のx軸
    // (offset:trueで各日付の中心に寄せている)とは違い、グラフの左端から右端まで
    // 隙間なく伸びるようにする。
    if (target > 0) {
      datasets.push({
        type: 'line', label: site + ' 目標日産量(t)', data: dates.map(function () { return target; }),
        borderColor: chartColor, borderWidth: 1, borderDash: [16, 6, 2, 6], pointRadius: 0,
        yAxisID: 'yDaily', xAxisID: 'xLine', order: 4,
      });
    }
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
      // 折れ線はpointRadius:0で通常時は点を描いていないが、カーソルを合わせた位置の
      // 点だけはChart.jsの既定(hoverRadius:4)でハイライト表示されてしまう。ツールチップは
      // 残しつつ、この●表示だけは不要(PDFキャプチャ時にカーソル位置が残っていると
      // そのまま画像に写り込むこともある)なので、ホバー時の点半径も0にして無効化する。
      elements: { point: { hoverRadius: 0 } },
      // 累積実績の最終日ラベル(拠点名+数値)がプロット領域の右端ぎりぎりに乗るため、
      // 余白が無いとラベルの右側がキャンバス外に切れてしまう。右側にラベル分の
      // 余白を確保しておく(datalabelsのclampだけではラベルの描画幅までは
      // 考慮されず、はみ出しを防ぎきれなかったため)。
      layout: { padding: { right: 64 } },
      scales: {
        yDaily: {
          position: 'left', title: { display: true, text: '日次生産量(t)' },
          // PDF出力時は白背景なので、通常表示用の暗色グリッド(黒っぽく見える)ではなく
          // 明るいグレーにする。
          grid: { color: pdfCaptureMode ? '#cccccc' : '#2a3348' },
          afterFit: function (scale) { scale.width = TABLE_LEAD_WIDTH; },
        },
        // 右側の累積軸は表示せず(現在値は上部の数値カードで確認できる)、その分の幅を
        // 日付の描画エリアに回す。これにより工程表(左のリード列だけを引いた残りを
        // 日数で等分)と、グラフの1日あたりの幅がほぼ一致する。
        yCum: { position: 'right', display: false },
        x: { grid: { color: pdfCaptureMode ? '#cccccc' : '#1d2436' }, offset: true },
        // 目標日産量の一点鎖線専用のx軸。offset:falseにすることで、日付ごとの中心に
        // 寄せる通常のx軸と違い、プロットエリアの左端から右端までぴったり伸びる。
        xLine: { type: 'category', display: false, offset: false },
      },
      plugins: {
        // chartjs-plugin-datalabelsの既定はここでオフにし、累積実績のデータセットだけ
        // dataset.datalabels.display:trueで個別に上書きする(棒・目標系には出さない)。
        datalabels: { display: false },
        // 「工場別PDF」出力時だけ、選択中拠点の合計生産重量をグラフ上部に表示する。
        // Chart.js自身のtitle領域を使うことで、凡例(legend)と場所が重ならないように
        // レイアウトが自動調整される(HTML要素を重ねる方式だと凡例と衝突しやすいため)。
        title: {
          display: isSitePdfExport && cumStats.length > 0,
          text: cumStats.length ? '合計生産重量　' + cumStats[0].value.toFixed(1) + 't' : '',
          color: '#111111',
          font: { size: 15, weight: 'bold' },
          padding: { bottom: 10 },
        },
        legend: {
          // colorを指定せずChart.defaults.colorに委ねる。PDF出力時はここを一時的に
          // 濃い色へ切り替えるため、固定色にすると凡例だけ反映されず薄いままになる。
          labels: {
            boxWidth: 14,
            // 日次実績(棒)と目標日産量(一点鎖線)は色・形でグラフ上から判別できるため、
            // 凡例には出さない(目標ラインの累積系だけ凡例に残す)。
            filter: function (item) {
              return item.text.indexOf('日次実績') === -1 && item.text.indexOf('目標日産量') === -1;
            },
          },
        },
        tooltip: {
          // PDFキャプチャ中はマウスカーソルがグラフ上にあるとツールチップが開いたまま
          // 画像に写り込んでしまうことがあるため、その間は無効化する。
          enabled: !pdfCaptureMode,
          // interaction.mode:'index'により、その日付にある全データセットがツールチップに
          // 並ぶ。拠点を複数選択していると「日次実績・累積実績・目標ライン・目標日産量」の
          // 4種類×拠点数ぶん並んで非常に見にくいため、tooltipLabelを持つデータセット
          // (日次実績・累積実績)だけに絞り、目標系(目標ライン・目標日産量)は出さない。
          filter: function (item) {
            return !!item.dataset.tooltipLabel;
          },
          callbacks: {
            // 表示は「日付(ツールチップ見出し)・{拠点}本日・{拠点}累積」だけのシンプルな
            // 表記に統一する(dataset.label自体は凡例フィルタ等で使うため書き換えない)。
            label: function (item) {
              return item.dataset.tooltipLabel + ': ' + item.parsed.y.toFixed(1) + 't';
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
    // その拠点・その日付の生産結果明細ポップアップ(クリック時のイベント委譲)で参照する。
    table.dataset.site = site;

    const headTr = document.createElement('tr');
    headTr.appendChild(th('工事', 'work-name-col'));
    headTr.appendChild(th('', 'part-label'));
    dates.forEach(function (d) {
      const headCell = th(dayLabel(d), 'date-th' + (data.calendar[d] === false ? ' holiday' : ''));
      headCell.dataset.date = d;
      headTr.appendChild(headCell);
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
          td.dataset.date = d;
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
      td.dataset.date = d;
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

// クリックできる列であることが一目で分かるよう、カーソルを合わせたセルと同じ日付の
// td/th(日付見出し〜合計行まで)全体に.date-col-hoverを付け外しする。table/dateKeyが
// nullなら現在のハイライトを解除するだけ。同じ列に留まっている間は無駄にDOMを
// 触らないよう、直前とtable・dateKeyが同じ場合は何もしない。
function setScheduleColumnHover_(table, dateKey) {
  if (scheduleHoverCell && scheduleHoverCell.table === table && scheduleHoverCell.dateKey === dateKey) return;
  if (scheduleHoverCell) {
    scheduleHoverCell.table.querySelectorAll('.date-col-hover').forEach(function (el) {
      el.classList.remove('date-col-hover');
    });
  }
  scheduleHoverCell = (table && dateKey) ? { table: table, dateKey: dateKey } : null;
  if (scheduleHoverCell) {
    table.querySelectorAll('[data-date="' + dateKey + '"]').forEach(function (el) {
      el.classList.add('date-col-hover');
    });
  }
}

// 1列あたりの目安行数(工事見出し1行・製品1行をそれぞれ1行として数える)。これを超えたら
// 次の列(隣)に続ける。本数が多い日でも、1列に縦長へ詰め込んでPDFで極端に文字が
// 小さくなるのを避けるための調整値。
const DAY_DETAIL_ROWS_PER_COLUMN = 32;

// ---------- 生産結果明細ポップアップ(工程表のセルクリック) ----------
// data.works[].bySite[site].itemsByDate[dateKey] は [{part, mark, weight}, ...] の配列
// (案件マスターの1行=1製品=1本の前提で、合算せず行の出現順のまま保持している)。
function showDayDetail(site, dateKey) {
  const works = (state.data.works || []).filter(function (w) {
    const items = w.bySite && w.bySite[site] && w.bySite[site].itemsByDate;
    return items && items[dateKey] && items[dateKey].length > 0;
  });
  if (works.length === 0) {
    showCenterAlert('この日の生産データはありません。');
    return;
  }

  state.dayDetail = { site: site, dateKey: dateKey };

  const d = parseDateKey(dateKey);
  document.getElementById('dayDetailTitle').textContent =
    site + ' ' + (d.getMonth() + 1) + '月' + d.getDate() + '日 生産結果明細';

  const body = document.getElementById('dayDetailBody');
  body.innerHTML = '';
  buildDayDetailColumns(works, site, dateKey).forEach(function (col) { body.appendChild(col); });

  document.getElementById('dayDetailOverlay').hidden = false;
}

// 全工事の「工事名 合計＝○本、○t」見出し+部位(柱→大梁→小梁→他の順)ごとの
// 「製品マーク　重量」を、DAY_DETAIL_ROWS_PER_COLUMN行を超えるごとに新しい列
// (.day-detail-column)に分けて並べる。1つの工事の途中で列をまたぐ場合は、続きの列の
// 先頭に「工事名(続き)」という小見出しを入れて、どの工事の続きか分かるようにする。
function buildDayDetailColumns(works, site, dateKey) {
  const columns = [];
  let column, table, rowsInColumn;

  function startColumn() {
    column = document.createElement('div');
    column.className = 'day-detail-column';
    columns.push(column);
    table = null;
    rowsInColumn = 0;
  }
  function addHeading(text, isContinuation) {
    const block = document.createElement('div');
    block.className = 'day-detail-work';
    const titleEl = document.createElement('div');
    titleEl.className = 'day-detail-work-title' + (isContinuation ? ' day-detail-continued' : '');
    titleEl.textContent = text;
    block.appendChild(titleEl);
    table = document.createElement('table');
    table.className = 'day-detail-table';
    block.appendChild(table);
    column.appendChild(block);
    rowsInColumn += 1;
  }

  startColumn();
  works.forEach(function (w) {
    const items = w.bySite[site].itemsByDate[dateKey];
    const totalWeight = items.reduce(function (sum, it) { return sum + it.weight; }, 0);

    // 見出し行だけ書いて製品が1行も続けられないと空振りになるため、残り行数が
    // 「見出し+製品1行」の2行に満たない場合は先に次の列へ送る。
    if (rowsInColumn > 0 && rowsInColumn + 2 > DAY_DETAIL_ROWS_PER_COLUMN) startColumn();
    addHeading(w.workName + '　合計＝' + items.length + '本、' + totalWeight.toFixed(1) + 't', false);

    PARTS.forEach(function (part) {
      items.filter(function (it) { return it.part === part; }).forEach(function (it) {
        if (rowsInColumn >= DAY_DETAIL_ROWS_PER_COLUMN) {
          startColumn();
          addHeading(w.workName + '(続き)', true);
        }
        const tr = document.createElement('tr');
        const partTd = document.createElement('td');
        partTd.className = 'day-detail-part-col';
        partTd.textContent = part;
        const markTd = document.createElement('td');
        markTd.textContent = it.mark || '-';
        const weightTd = document.createElement('td');
        weightTd.className = 'day-detail-weight-col';
        weightTd.textContent = it.weight.toFixed(1) + 't';
        tr.appendChild(partTd);
        tr.appendChild(markTd);
        tr.appendChild(weightTd);
        table.appendChild(tr);
        rowsInColumn += 1;
      });
    });
  });

  return columns;
}

// 生産結果明細ポップアップの中身(#dayDetailContent。PDF出力/閉じるボタンは含まない)だけを
// 縦向きA4 1枚に収まるよう縮小してPDF化する。
async function downloadDayDetailPdf() {
  const btn = document.getElementById('dayDetailPdf');
  const originalLabel = btn.textContent;
  btn.disabled = true;
  btn.textContent = 'PDF作成中…';
  document.body.classList.add('pdf-export');

  // 画面表示用のスクロール制限(day-detail-body の max-height/overflow、および
  // day-detail-modal の max-width)を外し、縦横どちらの方向にスクロールで隠れている分も
  // 含めた全内容を1枚の画像としてキャプチャできるようにする。overflow-yだけでなく
  // overflow-x(列が多くて画面幅からはみ出す場合)も見えるようにする必要がある。
  const bodyEl = document.getElementById('dayDetailBody');
  const modalEl = document.querySelector('.day-detail-modal');
  const prevMaxHeight = bodyEl.style.maxHeight;
  const prevOverflow = bodyEl.style.overflow;
  const prevModalMaxWidth = modalEl.style.maxWidth;
  bodyEl.style.maxHeight = 'none';
  bodyEl.style.overflow = 'visible';
  modalEl.style.maxWidth = 'none';
  await new Promise(function (r) { requestAnimationFrame(function () { requestAnimationFrame(r); }); });

  try {
    const { jsPDF } = window.jspdf;
    const doc = new jsPDF({ orientation: 'portrait', unit: 'pt', format: 'a4' });
    const margin = 24;
    const maxW = doc.internal.pageSize.getWidth() - margin * 2;
    const maxH = doc.internal.pageSize.getHeight() - margin * 2;

    const canvas = await html2canvas(document.getElementById('dayDetailContent'), { scale: 2, backgroundColor: '#ffffff' });
    // 常にページ幅いっぱいに引き伸ばすと、明細が短い日でも文字だけ不自然に巨大化して
    // かえって見づらくなる。html2canvasはscale:2でCSS px の2倍の解像度で描いているため、
    // canvas.width/2 が元のCSS px幅。それをpt換算(96dpi→72dpi=0.75倍)した「画面表示と
    // 同じ等倍サイズ」を基準にし、ページに収まらない場合だけ縮小する(拡大はしない)。
    const naturalW = canvas.width * 0.375; // canvas.width/2(CSS px) * 0.75(px→pt)
    const naturalH = canvas.height * 0.375;
    let w = naturalW, h = naturalH;
    if (w > maxW || h > maxH) {
      const scale = Math.min(maxW / w, maxH / h);
      w *= scale;
      h *= scale;
    }
    const x = margin + (maxW - w) / 2;
    doc.addImage(canvas.toDataURL('image/jpeg', 0.95), 'JPEG', x, margin, w, h);

    const site = state.dayDetail.site;
    const d = parseDateKey(state.dayDetail.dateKey);
    const now = new Date();
    const timePart = pad2(now.getHours()) + pad2(now.getMinutes()) + pad2(now.getSeconds());
    doc.save('【' + site + '】' + (d.getMonth() + 1) + '月' + d.getDate() + '日生産結果明細_' + timePart + '.pdf');
  } catch (err) {
    console.error(err);
    showMessage('PDF作成でエラーが発生しました: ' + err.message, 'err');
  } finally {
    bodyEl.style.maxHeight = prevMaxHeight;
    bodyEl.style.overflow = prevOverflow;
    modalEl.style.maxWidth = prevModalMaxWidth;
    document.body.classList.remove('pdf-export');
    btn.disabled = false;
    btn.textContent = originalLabel;
  }
}
