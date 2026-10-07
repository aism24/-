// GAS(JSON API)へのPOST共通処理(先頭が「_」のファイルはVercelの関数にならず、ask.jsから読み込むだけ)。
// ブラウザからGASへ直接POSTすると、Google側の2段階応答(受取URL echo)が一定割合で
// 404/CORS errorになるため(2026-10-06実測)、サーバー側で再試行する。
const GAS_API_URL = 'https://script.google.com/macros/s/AKfycbwDhzAWpmCmwrLoFM6gS1GDWYWcc7OvqjdGa7HNObCTednh-FttOPdF3JZlOQVe-Y3Q0A/exec';

async function gasPost(action, params) {
  const r = await fetch(GAS_API_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'text/plain;charset=utf-8' },
    body: JSON.stringify({ action: action, params: params || {} }),
    redirect: 'follow',
  });
  const text = await r.text();
  let json;
  try { json = JSON.parse(text); } catch (e) { throw new Error('HTTP ' + r.status + '(JSONでない応答)'); }
  if (json.status !== 'success') {
    const err = new Error(json.message || 'HTTP ' + r.status);
    err.unknownAction = /不明なaction/.test(json.message || '');
    err.final = true; // GAS側の処理自体のエラー(再試行しても同じ)
    throw err;
  }
  return json.data;
}

// 受取URL(echo)の失敗は1回あたり15〜80秒待たされてから分かるため、順番に再試行すると
// 時間切れになりやすい。成功を待たずに一定間隔で次の試行を並行して始め、最初の成功を使う。
// opt: { started, deadlineMs, maxTotal, maxParallel, intervalMs }
function gasPostHedged(action, params, opt) {
  return new Promise(function (resolve, reject) {
    let launched = 0, running = 0, done = false, lastErr = null, timer = null;
    const finish = function (fn, v) { if (done) return; done = true; clearInterval(timer); fn(v); };
    const launch = function () {
      if (done || launched >= opt.maxTotal || running >= opt.maxParallel || Date.now() - opt.started > opt.deadlineMs) return;
      launched++; running++;
      gasPost(action, params).then(function (d) { finish(resolve, d); }, function (e) {
        running--; lastErr = e;
        if (e.final) return finish(reject, e);
        if (launched >= opt.maxTotal && running === 0) return finish(reject, e);
        launch();
      });
    };
    launch();
    timer = setInterval(function () {
      if (Date.now() - opt.started > opt.deadlineMs) return finish(reject, lastErr || new Error('時間切れ'));
      launch();
    }, opt.intervalMs);
  });
}

module.exports = { gasPost: gasPost, gasPostHedged: gasPostHedged };
