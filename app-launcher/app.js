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

// 分類ラベルの表示用HTMLを組み立てる。分類名にアンダースコアが2つ以上ある
// (例:「Excel_マスタ_実寸法師」)場合、最後のアンダースコアの位置で改行して
// 2行に収める(左の固定幅列「★★調整中★★」基準の幅に収まるようにするため)。
// それ以外はそのまま1行で表示する。
function categoryLabelHtml(text) {
  const parts = String(text).split('_');
  if (parts.length >= 3) {
    const last = parts.pop();
    return escapeHtml(parts.join('_')) + '<br>' + escapeHtml(last);
  }
  return escapeHtml(text);
}

// マウスホバーに対応する環境か(PC等)。タッチ専用環境(iPad等)ではfalseになる。
// falseの場合、タップを「1回目=ホバー相当の表示」「同じカードへの2回目=
// 起動」という2段階の挙動に切り替える(通常のタップは長押ししないと:hoverが
// 有効にならず、かつタップ即起動してしまうため、ホバー時の名前・説明の表示を
// 確認する間がない、また別カードへの切り替えもしにくい問題への対応)。
const supportsHover = window.matchMedia('(hover: hover)').matches;

// タッチ環境向け: カードDOM要素 -> アプリ情報。タップ時の起動・ログ送信に使う。
const cardApps = new WeakMap();

function openApp(card) {
  const app = cardApps.get(card);
  if (!app) return;
  if (/^https?:\/\//i.test(app.url)) {
    window.open(app.url, '_blank');
  } else {
    // jissun://等の独自プロトコルは、ブラウザが実際にページ遷移するわけではなく
    // OSのハンドラーに引き渡すだけなので、_blankで新規タブを開くと空白タブが
    // 残ってしまう。同じタブでlocationを変更すればランチャー画面はそのまま残る。
    window.location.href = app.url;
  }
  // 検索中にアプリを開いたら、その検索語を履歴に残す。
  saveSearchHistory(document.getElementById('search').value);
  // クリックログの送信は失敗してもアプリ起動自体は妨げない(ベストエフォート)。
  apiPost('logAppOpen', { appName: app.name }).catch(function () {});
}

// カード外側のタップで、開いたままの.active表示をすべて閉じる。
document.addEventListener('click', function (e) {
  if (!e.target.closest('.card')) {
    document.querySelectorAll('.card.active').forEach(function (c) {
      c.classList.remove('active');
    });
  }
});

if (!supportsHover) {
  // タッチ環境: タップの当たり判定を「拡大表示された見た目」ではなく、常に
  // 各カードの実サイズのアイコン範囲を基準に判定し直す。ホバー中(active)の
  // カードの拡大パネルが隣の本来のボタン位置に視覚的に重なっていても、実際に
  // 押した座標がどのカードの実サイズ範囲に入っているかで対象を決めるため、
  // 別のボタンへ1タップで直接切り替えられる(拡大パネルの見た目の重なり順に
  // 引きずられて、覆われた奥のカードが誤って開いてしまうことがない)。
  // キャプチャフェーズで先取りし、通常のクリック伝播(カード自身のリスナーや
  // 外側クリックでの解除)より先に判定・処理する。
  document.addEventListener('click', function (e) {
    const icons = document.querySelectorAll('.card > .icon');
    let hitCard = null;
    for (let i = 0; i < icons.length; i++) {
      const r = icons[i].getBoundingClientRect();
      if (e.clientX >= r.left && e.clientX <= r.right && e.clientY >= r.top && e.clientY <= r.bottom) {
        hitCard = icons[i].parentElement;
        break;
      }
    }

    // 実サイズのアイコン範囲に当たらなくても、タップ位置がすでにactiveな
    // カードの拡大パネル(名前・説明を含む)の内側であれば、そのカードへの
    // タップとして扱う(2回目のタップで開く操作は、拡大表示のどこを押しても
    // 反応してよいため)。
    if (!hitCard) {
      const activeAncestor = e.target.closest('.card.active');
      if (activeAncestor) hitCard = activeAncestor;
    }

    if (!hitCard) return; // 本当に何もない背景 → 外側クリック扱いのまま

    e.stopPropagation();
    e.preventDefault();

    const wasActive = hitCard.classList.contains('active');
    document.querySelectorAll('.card.active').forEach(function (c) {
      if (c !== hitCard) c.classList.remove('active');
    });

    if (wasActive) {
      openApp(hitCard);
      hitCard.classList.remove('active');
    } else {
      hitCard.classList.add('active');
    }
  }, true);
}

// GAS側のgetAppGroups()がすでに分類ごとにグループ化し、カードの色(color)・
// 文字色(textColor)・アイコン文字(initial)も計算済みで返すため、ここでは
// 受け取った通りに描画するだけ。カードは通常時はロゴアイコンのみのボタンで、
// ホバー時にアイコンの下へ名前・説明を含む枠を繋げて2倍サイズで展開する。
function renderGroups(groups) {
  const root = document.getElementById('groups');
  root.innerHTML = '';
  lastGroups = groups;

  if (!groups || groups.length === 0) {
    root.innerHTML = '<div class="empty">登録されたアプリがありません。</div>';
    return;
  }

  groups.forEach(function (group) {
    const row = document.createElement('div');
    row.className = 'category-row';

    const h2 = document.createElement('h2');
    h2.className = 'category';
    h2.innerHTML = categoryLabelHtml(group.category);
    row.appendChild(h2);

    const grid = document.createElement('div');
    grid.className = 'grid';

    group.apps.forEach(function (app) {
      const card = document.createElement('div');
      card.className = 'card';
      card.style.setProperty('--accent', app.color);
      card.style.setProperty('--text', app.textColor || '#fff');
      card.innerHTML =
        '<div class="icon">' + escapeHtml(app.initial) + '</div>' +
        '<div class="details">' +
          '<div class="icon">' + escapeHtml(app.initial) + '</div>' +
          '<div class="name">' + escapeHtml(app.name) + '</div>' +
          (app.description ? '<div class="desc">' + escapeHtml(app.description) + '</div>' : '') +
        '</div>';
      cardApps.set(card, app);
      if (supportsHover) {
        // マウス環境: ホバーで詳細が見えるので、クリックはそのまま即起動でよい
        // (タッチ環境の2段階タップ処理は上のdocument委譲リスナーが担当する)。
        card.addEventListener('click', function () {
          openApp(card);
        });
      }
      grid.appendChild(card);
    });

    row.appendChild(grid);
    root.appendChild(row);
  });
  applySearch();
}

/* ---------------------------------------------------------------------
 * アプリ検索。名前・説明・分類・アイコン文字を、全角半角・大小文字を区別せず
 * スペース区切りのAND条件で絞り込む。検索履歴はブラウザ(localStorage)ごとに保存。
 * ------------------------------------------------------------------ */
let lastGroups = null;
const SEARCH_HISTORY_KEY = 'appLauncherSearchHistory_v1';
const SEARCH_HISTORY_MAX = 10;

function normalizeText(s) {
  return String(s == null ? '' : s).normalize('NFKC').toLowerCase();
}

function loadSearchHistory() {
  try {
    const arr = JSON.parse(localStorage.getItem(SEARCH_HISTORY_KEY) || '[]');
    return Array.isArray(arr) ? arr.filter(function (x) { return typeof x === 'string'; }) : [];
  } catch (e) {
    return [];
  }
}

function storeSearchHistory(list) {
  try {
    localStorage.setItem(SEARCH_HISTORY_KEY, JSON.stringify(list));
  } catch (e) {}
}

function saveSearchHistory(query) {
  const q = String(query || '').trim();
  if (!q) return;
  const list = loadSearchHistory().filter(function (x) { return x !== q; });
  list.unshift(q);
  storeSearchHistory(list.slice(0, SEARCH_HISTORY_MAX));
  renderSearchHistory();
}

// 検索履歴のドロップダウンを描画する。入力中は、入力語を含む履歴だけに絞る。
function renderSearchHistory() {
  const box = document.getElementById('search-history');
  const input = document.getElementById('search');
  const typed = normalizeText(input.value).trim();
  const list = loadSearchHistory().filter(function (q) {
    return !typed || normalizeText(q).indexOf(typed) !== -1;
  });
  box.innerHTML = '';
  if (list.length === 0 || document.activeElement !== input) {
    box.hidden = true;
    return;
  }
  box.hidden = false;
  const head = document.createElement('div');
  head.className = 'head';
  head.textContent = '検索履歴(クリックで再検索)';
  box.appendChild(head);
  list.forEach(function (q) {
    const item = document.createElement('div');
    item.className = 'item';
    const use = document.createElement('button');
    use.type = 'button';
    use.className = 'q';
    use.textContent = q;
    use.addEventListener('click', function () {
      input.value = q;
      applySearch();
      saveSearchHistory(q); // 使った履歴を先頭へ
      box.hidden = true;
    });
    const del = document.createElement('button');
    del.type = 'button';
    del.className = 'x';
    del.textContent = '×';
    del.setAttribute('aria-label', '「' + q + '」を履歴から削除');
    del.addEventListener('click', function () {
      storeSearchHistory(loadSearchHistory().filter(function (x) { return x !== q; }));
      renderSearchHistory();
    });
    item.appendChild(use);
    item.appendChild(del);
    box.appendChild(item);
  });
  const clear = document.createElement('button');
  clear.type = 'button';
  clear.className = 'clear-all';
  clear.textContent = '履歴を全て削除';
  clear.addEventListener('click', function () {
    storeSearchHistory([]);
    renderSearchHistory();
  });
  box.appendChild(clear);
}

// 現在の検索語で、カードと分類行の表示/非表示を切り替える。
function applySearch() {
  const terms = normalizeText(document.getElementById('search').value).split(/\s+/).filter(Boolean);
  const root = document.getElementById('groups');
  const note = document.getElementById('search-empty');
  if (note) note.remove();
  if (!lastGroups) return;

  let shown = 0;
  root.querySelectorAll('.category-row').forEach(function (row) {
    const category = row.querySelector('h2.category').textContent;
    let rowShown = 0;
    row.querySelectorAll('.card').forEach(function (card) {
      const app = cardApps.get(card);
      const hay = normalizeText([app.name, app.description, app.initial, category].join(' '));
      const hit = terms.every(function (t) { return hay.indexOf(t) !== -1; });
      card.classList.toggle('search-hide', !hit);
      if (hit) rowShown++;
    });
    row.classList.toggle('search-hide', rowShown === 0);
    shown += rowShown;
  });

  if (terms.length && shown === 0 && lastGroups.length) {
    const div = document.createElement('div');
    div.id = 'search-empty';
    div.className = 'empty';
    div.textContent = '該当するアプリがありません。';
    root.appendChild(div);
  }
}

(function initSearch() {
  const input = document.getElementById('search');
  const box = document.getElementById('search-history');
  input.addEventListener('input', function () {
    applySearch();
    renderSearchHistory();
  });
  // 検索欄のクリック・フォーカスで履歴を表示する(マウスだけで再検索できる)。
  input.addEventListener('focus', renderSearchHistory);
  input.addEventListener('click', renderSearchHistory);
  // 履歴ボタン操作で検索欄のフォーカスが外れて閉じてしまわないようにする。
  box.addEventListener('mousedown', function (e) { e.preventDefault(); });
  // 履歴は、Enter・入力欄から離れた時・アプリを開いた時に保存する。
  input.addEventListener('keydown', function (e) {
    if (e.key === 'Enter') {
      saveSearchHistory(input.value);
      box.hidden = true;
    } else if (e.key === 'Escape') {
      box.hidden = true;
    }
  });
  input.addEventListener('blur', function () {
    saveSearchHistory(input.value);
    box.hidden = true;
  });
})();

// アプリ一覧はGAS Web Appの起動オーバーヘッドで毎回2〜3秒程度かかるため、
// 直近の取得結果をブラウザに保存しておき、次回以降は先にそれを表示しつつ
// 裏で最新データを取りに行く(stale-while-revalidate)。データが変わって
// いれば取得完了時に静かに差し替える。GAS側(Code.gs)の変更は不要。
const GROUPS_CACHE_KEY = 'appLauncherGroupsCache_v1';

function loadCachedGroups() {
  try {
    const raw = localStorage.getItem(GROUPS_CACHE_KEY);
    return raw ? JSON.parse(raw) : null;
  } catch (e) {
    return null;
  }
}

function saveCachedGroups(groups) {
  try {
    localStorage.setItem(GROUPS_CACHE_KEY, JSON.stringify(groups));
  } catch (e) {}
}

function loadGroups() {
  const root = document.getElementById('groups');
  const cached = loadCachedGroups();

  if (cached) {
    renderGroups(cached);
  } else {
    root.innerHTML = '<div class="empty">読み込み中...</div>';
  }

  apiPost('getAppGroups')
    .then(function (groups) {
      saveCachedGroups(groups);
      renderGroups(groups);
    })
    .catch(function (err) {
      // キャッシュを表示できている場合は、裏の更新が失敗しても画面はそのまま維持する。
      if (!cached) {
        root.innerHTML = '<div class="empty">読み込みに失敗しました: ' + escapeHtml(err.message) + '</div>';
      }
    });
}

loadGroups();
