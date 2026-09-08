// デプロイ済みGAS WebアプリのURL(/exec で終わるURL)。デプロイ後にここへ差し替えてください。
const GAS_API_URL = "https://script.google.com/macros/s/AKfycbyfWI3ZAvn_L7pdBvX1Sz9xAhJuPuxsZMbJxJW2fQnulLyLOMjf84A17f5cqUsLB1la/exec";

const MAX_DISPLAY_ROWS = 500; // 一致件数がこれを超えたら、上位だけ表示して件数を案内する
const NO_DRAWING_NOTE = '図面作成未完'; // 図番セルにCAD起動リンクが無い行の備考表示・クリック時ポップアップ

let state = {
  records: [],
  generatedAt: '',
};

// ---------- GAS API ----------
async function apiGet(action) {
  const url = new URL(GAS_API_URL);
  url.searchParams.set('action', action);
  const res = await fetch(url.toString(), { method: 'GET' });
  if (!res.ok) throw new Error('サーバーエラー(HTTP ' + res.status + ')');
  const json = await res.json();
  if (json.status === 'busy') {
    const busyErr = new Error(json.message || '他の人が更新中です。しばらく待ってから再度お試しください。');
    busyErr.busy = true;
    throw busyErr;
  }
  if (json.status !== 'success') throw new Error(json.message || '取得に失敗しました');
  return json.data;
}

function showMessage(text, kind) {
  const el = document.getElementById('msgArea');
  el.textContent = text;
  el.className = 'msg' + (kind ? ' ' + kind : '');
}

// 全角英数字・記号を半角に、大文字を小文字に揃える(検索クエリ・製品マーク双方に適用する
// ことで、案件によって全角/半角が混ざっていても一致させる)。
function normalize_(s) {
  return String(s || '')
    .replace(/[Ａ-Ｚａ-ｚ０-９]/g, function (c) { return String.fromCharCode(c.charCodeAt(0) - 0xFEE0); })
    .toLowerCase();
}

async function loadData(forceRefresh) {
  const btn = document.getElementById('btnRefresh');
  btn.disabled = true;
  showMessage(forceRefresh ? '最新のExcelを読み込んで再集計しています…(数十秒かかる場合があります)' : '読み込み中…', forceRefresh ? 'loading' : '');
  try {
    if (GAS_API_URL.indexOf('PASTE_YOUR_GAS_WEB_APP_URL_HERE') >= 0) {
      throw new Error('app.js の GAS_API_URL がまだ設定されていません。');
    }
    const data = await apiGet(forceRefresh ? 'refresh' : 'getData');
    state.records = (data.records || []).map(function (r) {
      return Object.assign({}, r, { markNorm: normalize_(r.mark) });
    });
    state.generatedAt = data.generatedAt || '';
    document.getElementById('updatedAt').textContent = state.generatedAt
      ? ('最終更新: ' + state.generatedAt.replace('T', ' ').slice(0, 19) + '(' + state.records.length + '件)')
      : '';
    showMessage(forceRefresh ? '最新化しました。' : '', 'ok');

    const warnEl = document.getElementById('warningsArea');
    warnEl.textContent = (data.warnings && data.warnings.length) ? data.warnings.join('\n') : '';

    renderProjectsList_(data.searchableProjects);
    renderResults();
  } catch (err) {
    console.error(err);
    showMessage((err.busy ? '' : 'エラー: ') + err.message, err.busy ? 'warn' : 'err');
  } finally {
    btn.disabled = false;
  }
}

// 「検索可能な工事一覧」(ヘッダー内)を描画する。
function renderProjectsList_(projects) {
  const body = document.getElementById('projectsBody');
  body.innerHTML = '';
  const frag = document.createDocumentFragment();
  (projects || []).forEach(function (p) {
    const tr = document.createElement('tr');
    tr.innerHTML = '<td>' + escapeHtml_(p.workNo) + '</td><td>' + escapeHtml_(p.workName) + '</td>';
    frag.appendChild(tr);
  });
  body.appendChild(frag);
  syncStickyOffsets_();
}

// .search-panel(検索欄の行)をヘッダーのすぐ下に固定表示するため、ヘッダー(ロゴ・アプリ名・
// 最新化ボタン・検索可能な工事一覧まで)の実際の高さをCSSカスタムプロパティに反映する
// (style.css: .search-panelのtopで参照)。あわせて、ヘッダー+検索欄が占める高さを
// --above-table-heightに反映し、結果テーブル(.table-wrap)の残り画面高さをmax-heightとして
// 使う(table-wrap内部でスクロールさせ、その中でtheadをtop:0のposition:stickyにすることで、
// 該当件数が多くてもスクロールしながら項目行(th)が見え続けるようにするため)。ヘッダーの
// 工事一覧の件数や検索結果件数の表示によって高さが変わるため、その都度呼び直す。
function syncStickyOffsets_() {
  const header = document.querySelector('.app-header');
  const searchPanel = document.querySelector('.search-panel');
  const headerH = header ? header.offsetHeight : 0;
  const searchH = searchPanel ? searchPanel.offsetHeight : 0;
  document.documentElement.style.setProperty('--app-header-height', headerH + 'px');
  document.documentElement.style.setProperty('--above-table-height', (headerH + searchH) + 'px');
}

function escapeHtml_(s) {
  return String(s)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

// リンクがある場合、セルの中身を本物の<a>タグで包む(JSのlocation.hrefによる遷移は
// ブラウザにブロックされることがあるため、ブラウザ標準のリンク遷移に任せることで、
// 社内共有フォルダ(file://)へのリンクをより確実に開けるようにする)。
function linkWrapCell_(innerHtml, link) {
  if (!link) return innerHtml;
  return '<a class="row-link" href="' + escapeHtml_(link) + '">' + innerHtml + '</a>';
}

// 一致した部分だけを<mark>で強調する(表示は元の文字列のまま、正規化後の位置で判定する)。
function highlightMark_(mark, markNorm, queryNorm) {
  if (!queryNorm) return escapeHtml_(mark);
  const idx = markNorm.indexOf(queryNorm);
  if (idx < 0) return escapeHtml_(mark);
  return escapeHtml_(mark.slice(0, idx)) + '<mark>' + escapeHtml_(mark.slice(idx, idx + queryNorm.length)) + '</mark>' + escapeHtml_(mark.slice(idx + queryNorm.length));
}

// 「備考」欄のテキストを組み立てる: 図番にCAD起動リンクが無い/建方日・加工日が実際の
// 日付になっていない場合、それぞれの案内文を追記する。
function buildNote_(r, hasLink) {
  const notes = [];
  if (!hasLink) notes.push(NO_DRAWING_NOTE);
  if (r.erectionDateUnclear) notes.push('建方日の日付不明');
  if (r.processedDateUnclear) notes.push('加工日の日付不明');
  return notes.join(' / ');
}

const MAX_MATCHED_FILES_SHOWN = 5; // ヒット元マスタファイルの一覧表示を、これを超えたら省略する

// ヒットした行がどのマスタファイル(マスタ場所/ファイル名)から来たかを、重複を除いて
// 「(鳥取/ITM_マスタのまま.xlsx、姫路/LP京都_マスタのまま.xlsx)」のように組み立てる。
function buildMatchedFilesLabel_(matches) {
  const seen = [];
  const seenKeys = {};
  matches.forEach(function (r) {
    const key = r.masterLocation + ' ' + r.fileName;
    if (seenKeys[key]) return;
    seenKeys[key] = true;
    seen.push(r.masterLocation + '/' + r.fileName);
  });
  const shown = seen.slice(0, MAX_MATCHED_FILES_SHOWN);
  const suffix = seen.length > MAX_MATCHED_FILES_SHOWN ? '、他' + (seen.length - MAX_MATCHED_FILES_SHOWN) + '件' : '';
  return '(' + shown.join('、') + suffix + ')';
}

function renderResults() {
  const query = document.getElementById('searchInput').value.trim();
  const queryNorm = normalize_(query);
  const body = document.getElementById('resultBody');
  const emptyNote = document.getElementById('emptyNote');
  const table = document.getElementById('resultTable');
  const countEl = document.getElementById('searchCount');
  body.innerHTML = '';

  if (!queryNorm) {
    table.hidden = true;
    emptyNote.textContent = '製品マークを入力して「検索」を押すと、該当する部材が一覧表示されます。行をクリックすると実寸法師(CAD)で図面が開きます。';
    emptyNote.hidden = false;
    countEl.textContent = '';
    syncStickyOffsets_(); // 件数テキストの有無で検索欄の高さが変わるため、都度thead位置を再計算する
    return;
  }

  const matches = state.records.filter(function (r) { return r.markNorm.indexOf(queryNorm) >= 0; });

  if (matches.length === 0) {
    table.hidden = true;
    emptyNote.textContent = '「' + query + '」に一致する製品マークは見つかりませんでした。';
    emptyNote.hidden = false;
    countEl.textContent = '';
    syncStickyOffsets_();
    return;
  }

  emptyNote.hidden = true;
  table.hidden = false;
  countEl.textContent = matches.length + '件ヒット' + (matches.length > MAX_DISPLAY_ROWS ? '(先頭' + MAX_DISPLAY_ROWS + '件のみ表示。絞り込んでください)' : '')
    + '　' + buildMatchedFilesLabel_(matches);
  syncStickyOffsets_();

  const shown = matches.slice(0, MAX_DISPLAY_ROWS);
  const frag = document.createDocumentFragment();
  shown.forEach(function (r) {
    const tr = document.createElement('tr');
    const hasLink = !!r.drawingLink;
    const link = r.drawingLink || '';
    tr.className = hasLink ? 'clickable' : 'no-drawing';
    tr.dataset.hasLink = hasLink ? '1' : '';
    tr.innerHTML =
      '<td>' + linkWrapCell_(escapeHtml_(r.masterLocation), link) + '</td>' +
      '<td>' + linkWrapCell_(escapeHtml_(r.workNo), link) + '</td>' +
      '<td>' + linkWrapCell_(escapeHtml_(r.workName), link) + '</td>' +
      '<td class="col-drawing">' + linkWrapCell_(escapeHtml_(r.drawingNo), link) + '</td>' +
      '<td class="col-mark">' + linkWrapCell_(highlightMark_(r.mark, r.markNorm, queryNorm), link) + '</td>' +
      '<td class="col-date' + (r.erectionDateUnclear ? ' date-unclear' : '') + '">' + linkWrapCell_(escapeHtml_(r.erectionDate), link) + '</td>' +
      '<td>' + linkWrapCell_(escapeHtml_(r.block), link) + '</td>' +
      '<td class="col-date' + (r.processedDateUnclear ? ' date-unclear' : '') + '">' + linkWrapCell_(escapeHtml_(r.processedDate), link) + '</td>' +
      '<td class="col-note">' + linkWrapCell_(escapeHtml_(buildNote_(r, hasLink)), link) + '</td>';
    frag.appendChild(tr);
  });
  body.appendChild(frag);
}

function showNoDrawingPopup_() {
  document.getElementById('noDrawingOverlay').hidden = false;
}
function hideNoDrawingPopup_() {
  document.getElementById('noDrawingOverlay').hidden = true;
}

// 図面が未作成(リンク無し)の行をクリックした時だけポップアップで案内する。リンクが
// ある行は各セルが本物の<a href="file://...">で覆われているため、ブラウザ標準の
// リンク遷移がそのまま働き(JSでの遷移操作は不要)、社内ネットワークに接続され、
// かつ対象の拡張子(.tdf等)に実寸法師が関連付けられた端末でのみ開ける。
function onResultRowClick_(e) {
  const tr = e.target.closest('tr[data-has-link]');
  if (!tr || tr.dataset.hasLink) return;
  showNoDrawingPopup_();
}

document.addEventListener('DOMContentLoaded', function () {
  syncStickyOffsets_();
  window.addEventListener('resize', syncStickyOffsets_);
  document.getElementById('btnSearch').addEventListener('click', renderResults);
  document.getElementById('searchInput').addEventListener('keydown', function (e) {
    if (e.key === 'Enter') renderResults();
  });
  document.getElementById('resultBody').addEventListener('click', onResultRowClick_);
  document.getElementById('btnRefresh').addEventListener('click', function () {
    loadData(true);
  });
  document.getElementById('noDrawingClose').addEventListener('click', hideNoDrawingPopup_);
  // オーバーレイ自身(背景の半透明部分)をクリックした時だけ閉じる。
  document.getElementById('noDrawingOverlay').addEventListener('click', function (e) {
    if (e.target === e.currentTarget) hideNoDrawingPopup_();
  });
  loadData(false);
});
