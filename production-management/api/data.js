// GAS(JSON API)の getData を、Vercelのサーバー側で取得してCDNに保存して返す中継API。
// ブラウザからGASへ直接つなぐと、Google側の処理と転送(302)で毎回2〜4秒かかるため、
// CDNに保存した結果を返して待ち時間を減らす(index.htmlの<head>から使う。失敗時はGASへ直接)。
// GASのURLは index.html の PM_GAS_API_URL と同じ値にすること。
const GAS_API_URL = 'https://script.google.com/macros/s/AKfycbya0wgwbTuBN1laM8tWFGTJhJw--pTAOBAYVyrsOoXbrOXZgs9q3ZsErTSQZwJFT2c2/exec';
const ATTEMPTS = 2;
const TIMEOUT_MS = 7000; // 画面側は8秒で見切ってGASへ直接つなぐ(ここは裏で続けてCDNの保存を作る)

module.exports = async function handler(req, res) {
  let lastErr = '';
  for (let i = 0; i < ATTEMPTS; i++) {
    const ac = new AbortController();
    const timer = setTimeout(function () { ac.abort(); }, TIMEOUT_MS);
    try {
      const r = await fetch(GAS_API_URL + '?action=getData', { redirect: 'follow', signal: ac.signal });
      const text = await r.text();
      const json = JSON.parse(text);
      if (!r.ok || json.status !== 'success') throw new Error(json.message || 'HTTP ' + r.status);
      // 5分は保存した結果をすぐ返し、その後1日は古い結果を返しつつ裏で取り直す(待たされない)。
      // 他の人が「現時点のデータを取得」した直後は、最大5分(その後も1回)古い結果が届くことがある。
      res.setHeader('Cache-Control', 'public, s-maxage=300, stale-while-revalidate=86400');
      res.setHeader('Content-Type', 'application/json; charset=utf-8');
      res.status(200).send(text);
      return;
    } catch (e) {
      lastErr = String((e && e.message) || e);
    } finally {
      clearTimeout(timer);
    }
  }
  res.setHeader('Cache-Control', 'no-store');
  res.status(502).json({ status: 'error', message: 'GASの取得に失敗しました: ' + lastErr });
};
