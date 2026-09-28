/* ?demo=1 用のダミーデータ(詳細版・シンプル版で共用) */
'use strict';
var PPDemo = (function () {
function makeDemoCache(C) {
  let seed = 7;
  const rnd = () => (seed = (seed * 16807) % 2147483647) / 2147483647;
  const sites = ['本社', '夢前', '鳥取'];
  const works = {};
  for (let i = 1; i <= 12; i++) works['26-' + String(i).padStart(2, '0')] = { name: 'デモ工事' + i, totalWeight: 0 };
  const rec = [];
  const start = Date.UTC(2025, 10, 21), end = Date.now();
  for (let t = start; t < end; t += 86400000) {
    const ymd = C.utcToYmd(t);
    if (new Date(t).getUTCDay() === 0) continue;
    sites.forEach((site, si) => {
      const wn = Object.keys(works)[Math.floor(rnd() * 12)];
      const w = (4 + si * -1 + rnd() * 3);
      rec.push([ymd, site, wn, +w.toFixed(3), +(w * (3 + rnd() * 2) * 8).toFixed(2)]);
      rec.push([ymd, site, '00-00', 0, +(8 + rnd() * 16).toFixed(2)]);
      works[wn].totalWeight += w;
    });
  }
  return { generatedAt: new Date().toISOString(), sites, works, rec, warnings: ['デモデータで表示しています(?demo=1)'] };
}
  return { makeDemoCache: makeDemoCache };
})();
