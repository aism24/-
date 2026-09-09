/* =====================================================================
 * 実寸法師 マスタ情報入力 - 起動ランチャー フロントエンド(GitHub Pages版)
 *
 * スプレッドシート1枚目のシート(ボタン一覧)に並べた項目(①実寸法師インストール確認・
 * ②実寸法師アプリ本体へのjissun://リンク)を、番号付きの実際の<a href>ボタンとして
 * 描画する。項目を増減したい場合もこのファイルの変更は不要で、そのシートの行を
 * 追加・編集するだけでよい(他アプリ(open_jissun・production-management等)と
 * 同じGAS API + GitHub Pages構成)。
 * ===================================================================== */

// デプロイ済みGAS WebアプリのURL(/exec で終わるURL)。
const GAS_API_URL = "https://script.google.com/macros/s/AKfycby4NAU59n7EHzwri_gg6qdEm9Ly-QSHPqU8suCoG6xIuhWYJ43w_BW_YxZAwbD5xIgejg/exec";

// GAS APIへのPOSTリクエスト共通処理。
// Content-Type は "text/plain" にすることでCORSプリフライト(OPTIONS)を回避している
// (他アプリと同じ方式。GASはOPTIONSに対応していないため)。
async function apiPost(action, params) {
  const res = await fetch(GAS_API_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'text/plain;charset=utf-8' },
    body: JSON.stringify({ action: action, params: params || {} }),
  });
  if (!res.ok) throw new Error('サーバーエラー（HTTP ' + res.status + '）');
  const json = await res.json();
  if (json.status !== 'success') throw new Error(json.message || '読み込みに失敗しました');
  return json.data;
}

function escapeHtml(str) {
  return String(str)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

function renderItems(items) {
  const root = document.getElementById('items');
  root.innerHTML = '';

  if (!items || items.length === 0) {
    root.innerHTML = '<div class="empty">登録された項目がありません。</div>';
    return;
  }

  items.forEach(function (item, index) {
    // jissun://等の独自プロトコルは、実際の<a href>タグのクリックとしてブラウザ標準の
    // リンク遷移に任せた方が確実に動く(location.hrefへのJS代入はブロックされることが
    // ある。open_jissunでの知見と同じ)。ページ遷移自体は発生しない
    // (OSのハンドラーに引き渡されるだけ)ため、target指定は不要でこの画面はそのまま残る。
    const a = document.createElement('a');
    a.className = 'item-button';
    a.href = item.url;
    a.innerHTML =
      '<span class="step">' + (index + 1) + '</span>' +
      '<span class="text">' +
        '<span class="name">' + escapeHtml(item.name) + '</span>' +
        (item.description ? '<span class="desc">' + escapeHtml(item.description) + '</span>' : '') +
      '</span>';
    // クリックログの送信はページ遷移を止めず、失敗してもボタンの動作自体は妨げない
    // (ベストエフォート)。
    a.addEventListener('click', function () {
      apiPost('logOpen', { name: item.name }).catch(function () {});
    });
    root.appendChild(a);
  });
}

apiPost('getItems')
  .then(renderItems)
  .catch(function (err) {
    document.getElementById('items').innerHTML =
      '<div class="empty">読み込みに失敗しました: ' + escapeHtml(err.message) + '</div>';
  });
