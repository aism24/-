// GAS(JSON API)の getData を、Vercelのサーバー側で取得してCDNにキャッシュする中継API。
// ブラウザからGASへ直接つなぐと、Google側の転送(302)の連鎖で遅い/失敗することがあるため。
const GAS_API_URL = 'https://script.google.com/macros/s/AKfycbzLhyh3XzvJ-95n-VV7r7Upx_0AfGsqoPAaySmFSpwKdsqfP_EwjOTNzuyJgdTQvMxS/exec';

module.exports = async function handler(req, res) {
  let lastErr = '';
  for (let i = 0; i < 3; i++) {
    try {
      const r = await fetch(GAS_API_URL + '?action=getData', { redirect: 'follow' });
      const text = await r.text();
      const json = JSON.parse(text);
      if (!r.ok || json.status !== 'success') throw new Error(json.message || 'HTTP ' + r.status);
      // 5分は即返し、その後1日は古い結果を返しつつ裏で更新(待たされない)
      res.setHeader('Cache-Control', 'public, s-maxage=300, stale-while-revalidate=86400');
      res.setHeader('Content-Type', 'application/json; charset=utf-8');
      res.status(200).send(text);
      return;
    } catch (e) {
      lastErr = String(e && e.message || e);
    }
  }
  res.setHeader('Cache-Control', 'no-store');
  res.status(502).json({ status: 'error', message: 'GAS取得に失敗: ' + lastErr });
};
