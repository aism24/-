// デプロイ済みGAS WebアプリのURL(/exec で終わるURL)。デプロイ後にここへ差し替えてください。
const GAS_API_URL = "PASTE_YOUR_GAS_WEB_APP_URL_HERE";

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

    renderResults();
  } catch (err) {
    console.error(err);
    showMessage((err.busy ? '' : 'エラー: ') + err.message, err.busy ? 'warn' : 'err');
  } finally {
    btn.disabled = false;
  }
}

function escapeHtml_(s) {
  return String(s)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
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
    return;
  }

  const matches = state.records.filter(function (r) { return r.markNorm.indexOf(queryNorm) >= 0; });

  if (matches.length === 0) {
    table.hidden = true;
    emptyNote.textContent = '「' + query + '」に一致する製品マークは見つかりませんでした。';
    emptyNote.hidden = false;
    countEl.textContent = '';
    return;
  }

  emptyNote.hidden = true;
  table.hidden = false;
  countEl.textContent = matches.length + '件ヒット' + (matches.length > MAX_DISPLAY_ROWS ? '(先頭' + MAX_DISPLAY_ROWS + '件のみ表示。絞り込んでください)' : '');

  const shown = matches.slice(0, MAX_DISPLAY_ROWS);
  const frag = document.createDocumentFragment();
  shown.forEach(function (r) {
    const tr = document.createElement('tr');
    const hasLink = !!r.drawingLink;
    tr.className = hasLink ? 'clickable' : 'no-drawing';
    tr.dataset.link = r.drawingLink || '';
    tr.innerHTML =
      '<td>' + escapeHtml_(r.masterLocation) + '</td>' +
      '<td>' + escapeHtml_(r.workNo) + '</td>' +
      '<td>' + escapeHtml_(r.workName) + '</td>' +
      '<td class="col-drawing">' + escapeHtml_(r.drawingNo) + '</td>' +
      '<td class="col-mark">' + highlightMark_(r.mark, r.markNorm, queryNorm) + '</td>' +
      '<td class="col-date' + (r.erectionDateUnclear ? ' date-unclear' : '') + '">' + escapeHtml_(r.erectionDate) + '</td>' +
      '<td>' + escapeHtml_(r.block) + '</td>' +
      '<td class="col-date' + (r.processedDateUnclear ? ' date-unclear' : '') + '">' + escapeHtml_(r.processedDate) + '</td>' +
      '<td class="col-note">' + escapeHtml_(buildNote_(r, hasLink)) + '</td>';
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

// 該当行のクリックで実寸法師(CAD)の図面ファイルを開く。図面が未作成(リンク無し)の行は
// ポップアップで案内する。file://(社内LANの共有フォルダ)へのリンクのため、社内ネットワーク
// に接続され、かつ対象の拡張子(.tdf等)に実寸法師が関連付けられた端末でのみ開ける。
function onResultRowClick_(e) {
  const tr = e.target.closest('tr[data-link]');
  if (!tr) return;
  const link = tr.dataset.link;
  if (!link) {
    showNoDrawingPopup_();
    return;
  }
  window.location.href = link;
}

document.addEventListener('DOMContentLoaded', function () {
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
