// 一時テスト(使用後に削除)。リグレッション: 期待値 expected.json と比較
const fs=require('fs'),vm=require('vm'),cp=require('child_process'),path=require('path');
const nm='/tmp/nt/node_modules/';
const code=fs.readFileSync(__dirname+'/../gas/Code.gs','utf8');
const ctx={String,Object,Array,parseInt,JSON,Number};vm.createContext(ctx);vm.runInContext(code,ctx);
function xl(file){const d=fs.mkdtempSync('/tmp/x');cp.execSync(`unzip -q -o "${file}" -d ${d}`);
 const g=n=>fs.existsSync(d+'/'+n)?fs.readFileSync(d+'/'+n,'utf8'):'';
 const p=ctx.findSheetPath_(g('xl/workbook.xml'),g('xl/_rels/workbook.xml.rels'));
 const rel=p.replace(/([^\/]+)$/,'_rels/$1.rels');
 return ctx.extractLinks_(g(p),g(rel),g('xl/sharedStrings.xml'));}
(async()=>{
 const pdfjs=require(nm+'pdfjs-dist/legacy/build/pdf.js'),PDFLib=require(nm+'pdf-lib'),core=require('../core.js');
 const L={osr:xl('/tmp/osr.xlsx'),itm:xl('/tmp/itm.xlsx'),tdr:xl('/tmp/a.xlsx')};
 const res={master:Object.fromEntries(Object.entries(L).map(([k,v])=>[k,Object.keys(v).length]))};
 const merged=ctx.mergeLinks_(Object.values(L));res.master.merged=Object.keys(merged).length;
 const g=require('child_process').execSync('ls /root/.claude/uploads/*/*.pdf').toString().trim().split('\n');
 const osrPdf=g.find(x=>x.includes('OSR')),itmPdf=g.find(x=>x.includes('ITM'));
 for(const [name,pdf] of [['osr',osrPdf],['itm',itmPdf]]){
  const r=await core.linkPdf(pdfjs,PDFLib,fs.readFileSync(pdf),merged);
  fs.writeFileSync(`/tmp/out_${name}.pdf`,r.bytes);
  res[name]={pages:r.stats.pages,linked:r.stats.linked,dup:r.stats.dup,partial:r.stats.partial.length};
 }
 console.log(JSON.stringify(res));
 const exp=process.argv[2]&&JSON.parse(fs.readFileSync(process.argv[2]));
 if(exp){const ok=JSON.stringify(exp)===JSON.stringify(res);console.log(ok?'REGRESSION OK':'REGRESSION NG');process.exit(ok?0:1)}
})();
