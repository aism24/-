const fs=require('fs'),vm=require('vm'),assert=require('assert');
const ctx={};vm.createContext(ctx);vm.runInContext(fs.readFileSync('gas/Code.gs','utf8').replace(/^const /gm,'var '),ctx);
const A=require('./app.js');const dse=(a,b)=>assert.strictEqual(JSON.stringify(a),JSON.stringify(b));
// pure functions
assert.strictEqual(ctx.parseHms_('1:02:03'),3723);
assert.strictEqual(ctx.parseYmd_('24/07/24'),'2024-07-24');
assert.strictEqual(ctx.normMark_(' ２g1-y5x14 '),'2G1-Y5X14');
const works=[{workNo:'25-11',names:[ctx.normName_('エスロジ'),ctx.normName_('エスロジ松原')]},{workNo:'24-12A',names:[ctx.normName_('GLP尼崎倉庫')]},{workNo:'25-14',names:[ctx.normName_('KIX')]}];
dse(ctx.matchWorkNos_('GLP',works,{}),['24-12A']);
dse(ctx.matchWorkNos_('エスロジ',works,{}),['25-11']);
dse(ctx.matchWorkNos_('ランドポート',works,{}),[]);
dse(ctx.matchWorkNos_('ランドポート',works,{[ctx.normName_('ランドポート')]:'25-14'}),['25-14']);
const mi={'25-11':{byMark:{'2G11-X4Y6':{m:'2G11-X4Y6',w:1.7}},marks:[{key:'2G11-X4Y6',mark:'2G11-X4Y6'}]}};
let r=ctx.resolveRow_({wn:'エスロジ',mk:'2g11-x4y6'},works,{},mi);assert.strictEqual(r.status,'ok');
r=ctx.resolveRow_({wn:'エスロジ',mk:'2G11-X4Y7'},works,{},mi);assert.strictEqual(r.status,'suggest');dse(r.suggestions,['2G11-X4Y6']);
r=ctx.resolveRow_({wn:'エスロジ',mk:'ZZZZ'},works,{},mi);assert.strictEqual(r.status,'nomark');
// 月区切り
assert.strictEqual(A.monthKey('2026-07-20','close20'),'2026-07');assert.strictEqual(A.monthKey('2026-07-21','close20'),'2026-08');
assert.strictEqual(A.monthKey('2026-12-25','close20'),'2027-01');assert.strictEqual(A.monthKey('2026-07-31','calendar'),'2026-07');
// 集計: 重量は製品ごと1回、非アーク=経過-アーク
const S=JSON.parse(fs.readFileSync('sample.json','utf8'));
const rows=S.rows.filter(x=>x.s==='ok');
const agg=A.aggregate(rows,S.products,'calendar');
const t=agg.total;
assert.ok(Math.abs(t.weight-(0.9+1.7+2.2))<1e-9,'weight once per product '+t.weight);
assert.ok(Math.abs(t.elapsedMin-(600+1200+1800+3000)/60)<1e-9);
assert.ok(Math.abs(t.nonArcMin-(t.elapsedMin-t.arcMin))<1e-9);
const g=A.groupByProduct(rows,S.products);assert.strictEqual(g.length,3);assert.strictEqual(g.find(x=>x.count===2).count,2);
// 上書き
const ov=A.applyOverride(S.rows.find(x=>x.s==='suggest'),S.products,{'1|エスロジ|2G11-X4Y7':'2G11-X4Y6'});
assert.strictEqual(ov.s,'ok');
// 実データ(ローカルのみ): 2号機 2026/07 の非アーク/経過
const p=require('child_process');
console.log('unit tests passed');
