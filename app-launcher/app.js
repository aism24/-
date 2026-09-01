/* =====================================================================
 * アプリ一覧ポータル - フロントエンド(GitHub Pages版)
 *
 * GAS側の新規JSON API(doPost)を叩いてアプリ一覧を取得し、クリック時に
 * 「記録」シートへのログ追記(logAppOpen)を送信する。既存のGAS Webアプリ
 * (doGet、HtmlServiceのテンプレートレンダリング方式)とは別のデプロイ
 * (GAS_API_URL)を使う。既存デプロイ・既存の動作には一切影響しない。
 * ===================================================================== */

// デプロイ済みGAS Webアプリの新規デプロイURL(/exec で終わるURL)。
// 既存のGAS Webアプリ(doGet方式)のデプロイとは別物。
const GAS_API_URL = "https://script.google.com/macros/s/AKfycbyxMghWMRPE7ZSSV0-1RHn9YuzodsjvBFIRDTlYMPvkO3Li6ejDGUE9IXDi5uqJFAdOkA/exec";

// GAS APIへのPOSTリクエスト共通処理。
// Content-Type は "text/plain" にすることでCORSプリフライト(OPTIONS)を回避している
// (hot-heart等、他アプリと同じ方式。GASはOPTIONSに対応していないため)。
async function apiPost(action, params) {
  const res = await fetch(GAS_API_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'text/plain;charset=utf-8' },
    body: JSON.stringify({ action: action, params: params || {} }),
  });
  if (!res.ok) throw new Error('サーバーエラー（HTTP ' + res.status + '）');
  const json = await res.json();
  if (json.status !== 'success') throw new Error(json.message || 'データの取得に失敗しました');
  return json.data;
}

function escapeHtml(str) {
  return String(str)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

// GAS側のgetAppGroups()がすでに分類ごとにグループ化し、カードの色(color)と
// アイコン文字(initial)も計算済みで返すため、ここでは受け取った通りに描画するだけ。
function renderGroups(groups) {
  const root = document.getElementById('groups');
  root.innerHTML = '';

  if (!groups || groups.length === 0) {
    root.innerHTML = '<div class="empty">登録されたアプリがありません。</div>';
    return;
  }

  groups.forEach(function (group) {
    const h2 = document.createElement('h2');
    h2.className = 'category';
    h2.textContent = group.category;
    root.appendChild(h2);

    const grid = document.createElement('div');
    grid.className = 'grid';

    group.apps.forEach(function (app) {
      const card = document.createElement('div');
      card.className = 'card';
      card.style.setProperty('--accent', app.color);
      card.innerHTML =
        '<div class="icon">' + escapeHtml(app.initial) + '</div>' +
        '<div class="name">' + escapeHtml(app.name) + '</div>' +
        (app.description ? '<div class="desc">' + escapeHtml(app.description) + '</div>' : '');
      card.addEventListener('click', function () {
        window.open(app.url, '_blank');
        // クリックログの送信は失敗してもアプリ起動自体は妨げない(ベストエフォート)。
        apiPost('logAppOpen', { appName: app.name }).catch(function () {});
      });
      grid.appendChild(card);
    });

    root.appendChild(grid);
  });
}

function loadGroups() {
  const root = document.getElementById('groups');
  root.innerHTML = '<div class="empty">読み込み中...</div>';
  apiPost('getAppGroups')
    .then(renderGroups)
    .catch(function (err) {
      root.innerHTML = '<div class="empty">読み込みに失敗しました: ' + escapeHtml(err.message) + '</div>';
    });
}

loadGroups();
