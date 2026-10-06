// 「AIに質問」の中継API。ブラウザ→GAS(askAI)の直接POSTはGoogle側の受取URL(echo)で
// 失敗することがあるため、サーバー側で再試行する。キャッシュはしない(質問ごとに内容が違う)。
// Geminiへ送るのは質問文とマニュアル(faq.json)だけで、日報等の実データは送らない。
const { gasPostHedged } = require('./_gas');

module.exports = async function handler(req, res) {
  res.setHeader('Cache-Control', 'no-store');
  if (req.method !== 'POST') return res.status(405).json({ status: 'error', message: 'POSTのみ' });
  try {
    let body = req.body;
    if (typeof body === 'string') body = JSON.parse(body || '{}');
    const p = (body && body.params) || {};
    const mode = p.mode === 'route' ? 'route' : 'howto';
    const params = {
      question: String(p.question || '').slice(0, 300),
      appName: String(p.appName || '').slice(0, 50),
      manual: String(p.manual || '').slice(0, 8000),
      today: String(p.today || '').slice(0, 20),
      mode: mode,
    };
    if (!params.question) throw new Error('質問が空です');
    // 1本目が15秒で返らなければ2本目を並行(合計最大3回・最大60秒)
    const data = await gasPostHedged('askAI', params, { started: Date.now(), deadlineMs: 60000, maxTotal: 3, maxParallel: 2, intervalMs: 15000 });
    res.status(200).json({ status: 'success', data: data });
  } catch (e) {
    res.status(502).json({ status: 'error', message: String(e && e.message || e) });
  }
};
