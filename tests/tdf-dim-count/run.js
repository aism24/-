// tdf-dim-count 回帰テスト: node tests/tdf-dim-count/run.js [--update]
// fixtures/ のTDF(gzip)を読み、expected.json の正解値と一致するか確認する。悪化(不一致)があれば終了コード1。
// --update は、正解値を人が確認したうえで更新するときだけ使う。
const fs = require('fs'), path = require('path'), zlib = require('zlib');
const C = require('../../tdf-dim-count/core.js');
const dir = __dirname, upd = process.argv.includes('--update');
const exp = JSON.parse(fs.readFileSync(path.join(dir, 'expected.json'), 'utf8'));
const out = {};
let ng = 0;
function load(f) {
  const b = zlib.gunzipSync(fs.readFileSync(path.join(dir, 'fixtures', f)));
  return C.parse(b.buffer.slice(b.byteOffset, b.byteOffset + b.length));
}
function actual(f, layer) {
  const p = load(f);
  const L = C.allLayers(p).find(l => l.name === layer);
  const s = C.summarize(p, L.no);
  const r = { layerNo: L.no, types: s.textCount, total: s.total, rows: s.rows.map(x => x.text + ':' + x.count), ng: s.ng.map(x => x.text + ':' + x.textCount + '/' + x.lineCount) };
  [10, 20, 30].forEach(n => { const g = C.groupLengths(p, L.no, n); r['group' + n] = g.groups.length + '/' + g.total; });
  return r;
}
for (const key of Object.keys(exp)) {
  const e = exp[key], a = actual(e.file, e.layer);
  out[key] = Object.assign({ file: e.file, layer: e.layer, note: e.note }, a);
  const keys = ['layerNo', 'types', 'total', 'group10', 'group20', 'group30'];
  const bad = keys.filter(k => String(a[k]) !== String(e[k]));
  if (JSON.stringify(a.rows) !== JSON.stringify(e.rows)) bad.push('rows');
  if (JSON.stringify(a.ng) !== JSON.stringify(e.ng)) bad.push('ng');
  console.log((bad.length ? 'NG ' : 'OK ') + key + '  ' + e.layer + '  種類' + a.types + ' 合計' + a.total + (bad.length ? '  ← 不一致: ' + bad.join(',') : ''));
  if (bad.length) ng++;
}
if (upd) { fs.writeFileSync(path.join(dir, 'expected.json'), JSON.stringify(out, null, 1) + '\n'); console.log('expected.json を更新しました'); }
process.exit(ng && !upd ? 1 : 0);
