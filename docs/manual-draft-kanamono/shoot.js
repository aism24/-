// 金物リストの説明書用の画面撮影(Playwright)。使い方: node shoot.js <tdf-kanamono-list のフォルダ> <図面(.tdf)のフォルダ>
// GAS は撮影用の返事(工事リストは見本の工事)にし、利用記録は送らない。フォルダ・ファイルを選ぶ画面はブラウザの外なので、選ぶ所だけ撮影用の図面を返す。
const { chromium } = require('playwright');
const fs = require('fs'), path = require('path');
const [APP, FX] = process.argv.slice(2).map(p => path.resolve(p));
const OUT = path.join(__dirname, 'shots'); fs.mkdirSync(OUT, { recursive: true });
const FILES = ['EA1-3B-04.tdf', 'EA1-RG-01.tdf'];
const TYPES = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css', '.png': 'image/png', '.jpg': 'image/jpeg', '.svg': 'image/svg+xml' };
const KOJI = [{ no: '26-01', name: '○○ビル新築工事' }, { no: '26-02', name: '△△工場増築工事' }, { no: '26-03', name: '□□倉庫新築工事' }];
const rects = {};

(async () => {
  const b = await chromium.launch();
  const ctx = await b.newContext({ viewport: { width: 1440, height: 810 }, deviceScaleFactor: 1.5, locale: 'ja-JP' });
  const pg = await ctx.newPage();
  pg.on('pageerror', e => console.log('画面のエラー', e.message));
  await pg.route('http://km.local/**', r => {
    const u = decodeURIComponent(new URL(r.request().url()).pathname);
    const p = u.startsWith('/fx/') ? path.join(FX, u.slice(4)) : path.join(APP, u.slice(1) || 'index.html');
    if (!fs.existsSync(p)) return r.fulfill({ status: 404, body: '' });
    r.fulfill({ contentType: TYPES[path.extname(p)] || 'application/octet-stream', body: fs.readFileSync(p) });
  });
  await pg.route(/script\.google\.com/, r => r.request().method() === 'POST' ? r.fulfill({ contentType: 'application/json', body: '{"status":"success"}' })
    : r.fulfill({ contentType: 'application/json', body: JSON.stringify({ status: 'success', koji: KOJI, servers: [{ name: '本社', path: '\\\\server\\①進行中工事' }, { name: '鳥取', path: '\\\\server2\\①進行中工事' }] }) }));
  await pg.addInitScript(files => {
    const REL = ['26-01 ○○ビル新築工事', '詳細図', '小梁'];
    const root = { kind: 'directory', name: '①進行中工事',
      async *values() { yield { kind: 'file', name: '_本社サーバー.txt' }; },
      async resolve(h) { return h && h.__rel || null; }, async isSameEntry(o) { return o === this; },
      async queryPermission() { return 'granted'; }, async requestPermission() { return 'granted'; } };
    window.showDirectoryPicker = async () => root;
    window.showOpenFilePicker = async () => files.map(n => ({ kind: 'file', name: n, __rel: REL.concat(n),
      async getFile() { return new File([await (await fetch('/fx/' + n)).arrayBuffer()], n); },
      async isSameEntry(o) { return o === this; }, async queryPermission() { return 'granted'; }, async requestPermission() { return 'granted'; } }));
    const put0 = IDBObjectStore.prototype.put; IDBObjectStore.prototype.put = function (v, k) { try { return put0.call(this, v, k); } catch (e) { return put0.call(this, null, k); } };
    HTMLAnchorElement.prototype.click = function () { if (this.download) { window.__dl = this.download; return; } };
  }, FILES);

  async function shot(name, sels, opt = {}) {
    await pg.waitForTimeout(500);
    // 図面の工事名は見本の名前にして写す(公開のリポジトリに置くため)
    await pg.evaluate(() => { document.querySelectorAll('#tdf-list tr td:nth-child(2)').forEach(td => { td.textContent = '○○ビル新築工事'; }); });
    if (!opt.keepToast) await pg.evaluate(() => { const t = document.getElementById('toast'); if (t) t.className = ''; });
    await pg.waitForTimeout(300);
    await pg.screenshot({ path: path.join(OUT, name + '.png'), fullPage: !!opt.full });
    const r = {};
    for (const [k, sel] of Object.entries(sels)) { const bb = await pg.locator(sel).first().boundingBox().catch(() => null); if (bb) r[k] = bb; }
    rects[name] = r; console.log('撮影', name, Object.keys(r).join(','));
  }

  await pg.goto('http://km.local/index.html');
  await pg.waitForFunction(() => document.querySelectorAll('#koji-select option').length > 1);
  await pg.evaluate(() => { localStorage.clear(); });
  await shot('01_start', { manual: '#manual-btn', factory: '#factory-btns', koji: '#koji-select', start: '#start-btn', box: '#start-box' });
  await pg.click('.factory-btn[data-factory="本社"]');
  await pg.selectOption('#koji-select', '26-01');
  await shot('02_selected', { manual: '#manual-btn', factory: '#factory-btns', koji: '#koji-select', start: '#start-btn', box: '#start-box' });
  // 説明書を開いたところ
  await pg.click('#manual-btn'); await pg.waitForTimeout(800);
  await shot('03_manual', { prev: '#manual-prev', next: '#manual-next', close: '#manual-close' });
  await pg.click('#manual-close');
  await pg.click('#start-btn'); await pg.waitForTimeout(1200);
  await shot('04_started', { label: '#koji-label', change: '#btn-change', manual: '#manual-btn', server: '#server-btns button', files: '#btn-files', reset: '#btn-reset', excel: '#btn-excel', empty: '.empty-msg' });
  // ① サーバー
  await pg.click('#server-btns button:has-text("本社")');
  await pg.waitForSelector('#notice-modal.open');
  await shot('05_root', { box: '#notice-modal .dialog', ok: '#notice-ok' });
  await pg.click('#notice-ok'); await pg.waitForTimeout(700);
  await shot('06_server', { server: '#server-btns button', files: '#btn-files', repick: '#repick-root' }, { keepToast: true });
  // ② ファイル選択
  await pg.click('#btn-files');
  for (let k = 0; k < 240; k++) { await pg.waitForTimeout(500); if (await pg.$('#notice-modal.open')) break; if (k > 6 && !(await pg.$('#status-overlay.open')) && await pg.$('.prod-card')) break; }
  let n = 0;
  while (await pg.$('#notice-modal.open')) {
    console.log('お知らせ', await pg.textContent('#notice-title'), '/', await pg.textContent('#notice-body'));
    await shot('07_notice' + (n++ || ''), { box: '#notice-modal .dialog', ok: '#notice-ok' });
    await pg.click('#notice-ok'); await pg.waitForTimeout(500);
  }
  await pg.evaluate(() => window.scrollTo(0, 0));
  await shot('08_list', { tdflist: '#tdf-list', rm: '.rm-btn', card: '.prod-card', pval: '.prod-card tr.pval', zuban: '.prod-card tr.pval td:first-child', items: '.prod-card tr.item', sub: '.prod-card tr.sub', qty: '.prod-card input.qty', note: '.prod-card input.note-in', excel: '#btn-excel', reset: '#btn-reset', change: '#btn-change', manual: '#manual-btn', files: '#btn-files' });
  // 枚数・備考を直す
  const q = pg.locator('.prod-card input.qty').first(); await q.fill('3'); await q.press('Tab');
  const nt = pg.locator('.prod-card input.note-in').first(); await nt.fill('現場確認'); await nt.press('Tab');
  await pg.mouse.click(5, 300);
  await shot('09_edit', { qty: '.prod-card input.qty', note: '.prod-card input.note-in', sub: '.prod-card tr.sub' });
  // 総まとめ
  await pg.locator('#sum-area').scrollIntoViewIfNeeded(); await pg.evaluate(() => { const s = document.querySelector('.sum-title'); window.scrollTo(0, s.getBoundingClientRect().top + window.scrollY - 90); });
  await shot('10_summary', { title: '.sum-title', cat: '.cat-title' });
  await pg.evaluate(() => window.scrollTo(0, 0));
  // Excel
  await pg.click('#btn-excel'); await pg.waitForTimeout(4000);
  console.log('ダウンロード名', await pg.evaluate(() => window.__dl));
  // リセットは確認(confirm)を出すだけ
  pg.once('dialog', d => { console.log('確認', d.message()); d.dismiss(); });
  await pg.click('#btn-reset'); await pg.waitForTimeout(500);
  // 工場・工事の変更
  await pg.click('#btn-change'); await pg.waitForTimeout(500);
  await shot('11_change', { box: '#start-box', cancel: '#start-cancel-btn', start: '#start-btn' });
  fs.writeFileSync(path.join(__dirname, 'rects.json'), JSON.stringify(rects, null, 1));
  await b.close(); console.log('完了');
})();
