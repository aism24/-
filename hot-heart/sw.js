// ホーム画面に追加(Androidのインストール確認)に必要な最小限のService Worker。
// キャッシュはせず、画面の読み込みはそのままネットワークへ流す(常に最新版を表示するため)。
self.addEventListener('install', function() { self.skipWaiting(); });
self.addEventListener('activate', function(e) { e.waitUntil(self.clients.claim()); });
self.addEventListener('fetch', function(e) {
  if (e.request.mode !== 'navigate') return; // GAS APIや画像などは触らない
  e.respondWith(fetch(e.request));
});
