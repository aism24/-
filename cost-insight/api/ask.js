// 「AIに質問」の中継API。ブラウザ→GAS(askAI)の直接POSTはGoogle側の受取URL(echo)で
// 失敗することがあるため、サーバー側で再試行する。キャッシュはしない(質問ごとに内容が違う)。
// Geminiへ送るのは質問文と今日の日付だけで、予算・工数・重量・工事名等の実データは送らない(集計はブラウザ内)。
const { gasPostHedged } = require('./_gas');

module.exports = async function handler(req, res) {
  res.setHeader('Cache-Control', 'no-store');
  if (req.method !== 'POST') return res.status(405).json({ status: 'error', message: 'POSTのみ' });
  try {
    let body = req.body;
    if (typeof body === 'string') body = JSON.parse(body || '{}');
    const p = (body && body.params) || {};
    const params = {
      question: String(p.question || '').slice(0, 300),
      today: String(p.today || '').slice(0, 20),
    };
    if (!params.question) throw new Error('質問が空です');
    const data = await gasPostHedged('askAI', params, { started: Date.now(), deadlineMs: 60000, maxTotal: 3, maxParallel: 2, intervalMs: 15000 });
    res.status(200).json({ status: 'success', data: data });
  } catch (e) {
    res.status(502).json({ status: 'error', message: String(e && e.message || e) });
  }
};
