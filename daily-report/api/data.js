// 起動時データ(GASの getInitialData)と総務建築データ(getKenchikuCheckData)を、
// Vercelのサーバー側で取得してCDNにキャッシュする中継API。
// ブラウザからGASへ直接POSTすると、Google側の2段階応答(受取URL echo)が一定割合で
// 404/CORS errorになり起動できないため(2026-10-06実測)。サーバー側なら失敗しても再試行できる。
// 日報の行データは約18MBあるため、辞書+列形式に詰めて(約2.4MB)、gzipして返す(約0.5MB)。
// Vercel関数の応答上限(4.5MB)に収めるため。
const zlib = require('zlib');

const { gasPostHedged } = require('./_gas');

const DEADLINE_MS = 240000; // vercel.json の maxDuration(300秒)より手前で打ち切る
const ROW_KEYS = ['operatorNo', 'factory', 'dept', 'workDate', 'constructionId', 'workCode', 'hours'];

// 同時に最大3本・合計最大6回、20秒ごとに次の試行を並行して始める
function gasPostRetry(action, started) {
  return gasPostHedged(action, {}, { started: started, deadlineMs: DEADLINE_MS, maxTotal: 6, maxParallel: 3, intervalMs: 20000 });
}

// 行データを「列ごとの番号配列+重複を除いた値の辞書」に詰める(hoursは数値のまま)。
function compactRows(rows) {
  const dict = {}, cols = {};
  ROW_KEYS.forEach(function (k) {
    if (k === 'hours') { cols[k] = rows.map(function (r) { return r[k]; }); return; }
    const index = new Map(), values = [];
    cols[k] = rows.map(function (r) {
      const v = r[k];
      if (!index.has(v)) { index.set(v, values.length); values.push(v); }
      return index.get(v);
    });
    dict[k] = values;
  });
  return { format: 'compact1', n: rows.length, dict: dict, cols: cols };
}

async function loadInit(started) {
  let data;
  try {
    data = await gasPostRetry('getInitialData', started);
  } catch (e) {
    if (!e.unknownAction) throw e;
    // GAS側にgetInitialDataが未反映(Code.gs貼り替え前)の場合は、従来の5件を並行取得する
    const r = await Promise.all(['getMasterData', 'getAllDailyReportRows', 'getCompanyCalendarData',
      'getAbsenteeismData', 'getAbsenteeismDetail'].map(function (a) { return gasPostRetry(a, started); }));
    data = { master: r[0], rows: r[1], calendar: r[2], absenteeism: r[3], absenteeismDetail: r[4], fetchedAt: Date.now() };
  }
  data.rows = compactRows(data.rows);
  return data;
}

module.exports = async function handler(req, res) {
  const started = Date.now();
  const kind = (req.query && req.query.kind) || 'init';
  try {
    let data;
    if (kind === 'init') data = await loadInit(started);
    else if (kind === 'kenchiku') data = await gasPostRetry('getKenchikuCheckData', started);
    else throw new Error('不明なkind: ' + kind);
    const gz = zlib.gzipSync(JSON.stringify({ status: 'success', data: data }));
    // 5分は即返し、その後1日は古い結果を返しつつ裏で更新(待たされない)
    res.setHeader('Cache-Control', 'public, s-maxage=300, stale-while-revalidate=86400');
    res.setHeader('Content-Type', 'application/json; charset=utf-8');
    res.setHeader('Content-Encoding', 'gzip');
    res.status(200).send(gz);
  } catch (e) {
    res.setHeader('Cache-Control', 'no-store');
    res.status(502).json({ status: 'error', message: 'GAS取得に失敗: ' + String(e && e.message || e) });
  }
};
