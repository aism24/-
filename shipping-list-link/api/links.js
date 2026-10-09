// マスタ(リンク表JSON)の中継API。GASをサーバー側で取得(1回8秒で打ち切り・最大2回)し、gzipしてCDNにキャッシュさせる。
// ブラウザからGASを直接呼ぶと転送(302)の連鎖等で遅い/失敗するため。画面側は失敗時だけGAS直接へフォールバックする。
const zlib = require('zlib');
const GAS_URL = process.env.GAS_URL ||
  'https://script.google.com/macros/s/AKfycbw0NvmN8vjr4g0TNx1TQ8DffC6FWwK6GfBOZb32N0mTp3CrcYXLNOpkxhXo2ce1PwE6/exec';

// GASが遅いときに待ち続けない: 1回の取得は8秒で打ち切り、最大2回(合計約16秒)。失敗は502で返し、CDNは stale-if-error で古いデータを出し続ける
const TRY_MS = 8000, TRIES = 2;

module.exports = async (req, res) => {
  let body = null, err = '';
  for (let i = 0; i < TRIES && !body; i++) {
    try {
      const r = await fetch(GAS_URL + '?action=links', { redirect: 'follow', signal: AbortSignal.timeout(TRY_MS) });
      const t = await r.text();
      if (r.ok && t.startsWith('{') && t.includes('"links"')) body = t; else err = 'HTTP ' + r.status;
    } catch (e) { err = String(e); }
  }
  if (!body) {
    res.statusCode = 502;
    res.setHeader('Cache-Control', 'no-store');
    return res.end(JSON.stringify({ error: err }));
  }
  const gz = zlib.gzipSync(Buffer.from(body, 'utf8'), { level: 9 });   // 6.5MB → 数百KB(関数の応答上限4.5MB対策も兼ねる)
  res.statusCode = 200;
  res.setHeader('Content-Type', 'application/json; charset=utf-8');
  res.setHeader('Content-Encoding', 'gzip');
  res.setHeader('Cache-Control', 'public, s-maxage=300, stale-while-revalidate=86400, stale-if-error=86400');
  res.end(gz);
};
