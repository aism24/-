const { chromium } = require('/opt/node22/lib/node_modules/playwright');
(async()=>{
 const b=await chromium.launch({executablePath:'/opt/pw-browsers/chromium'}).catch(()=>chromium.launch());
 const p=await b.newPage();const errs=[];p.on('pageerror',e=>errs.push(e.message));
 await p.route('**/exceljs*',r=>r.abort());
 await p.goto('http://localhost:8765/index.html');await p.waitForSelector('#summary table');
 console.log(await p.$$eval('#summary tr',t=>t.length),await p.$$eval('#detail tr',t=>t.length),await p.textContent('#detailInfo'));
 console.log(await p.textContent('#costLine'));
 await p.click('[data-fix]');console.log(await p.textContent('#detailInfo'));
 await p.click('input[value=close20]');console.log((await p.textContent('#summary')).slice(0,80));
 await p.screenshot({path:'_shot.png',fullPage:true});
 console.log('errors',errs);await b.close();
})();
