# 短管リストの説明書用の画面撮影(金物リストの shoot.js と同じやり方。Python の playwright + Edge)。
# 使い方: python shoot.py <jissun-tankan-list のフォルダ(説明書ボタン入り)> <大組図(.tdf)のフォルダ> <注文書キャッシュ(<工事番号>.csv)>
# 大組図・注文書は公開リポジトリに入れない。工事名は見本の「26-01 ○○ビル新築工事」にして写す。Excel は sample.xlsx に保存する
# GAS は撮影用の返事(見本の工事)、利用記録は送らない。フォルダ・ファイルを選ぶ画面は撮影用の図面を返す。
import asyncio, sys, os, json, mimetypes
from playwright.async_api import async_playwright

APP, FX, ORD = [os.path.abspath(p) for p in sys.argv[1:4]]
HERE = os.path.dirname(os.path.abspath(__file__))
OUT = os.path.join(HERE, 'shots'); os.makedirs(OUT, exist_ok=True)
FILES = sorted(f for f in os.listdir(FX) if f.lower().endswith('.tdf'))
KOJI = [{'no': '26-01', 'name': '○○ビル新築工事'}, {'no': '26-02', 'name': '△△工場増築工事'}, {'no': '26-03', 'name': '□□倉庫新築工事'}]
SETTINGS = {'status': 'success', 'koji': KOJI, 'servers': [{'name': '本社', 'path': '\\\\server\\①進行中工事'}, {'name': '鳥取', 'path': '\\\\server2\\①進行中工事'}]}
ORDERS = {'status': 'success', 'koji': '26-01', 'name': '26-01.csv', 'updated': '2026/11/26 07:41', 'csv': open(ORD, encoding='utf-8-sig').read()}
rects = {}
TYPES = {'.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css', '.png': 'image/png', '.svg': 'image/svg+xml', '.py': 'text/plain; charset=utf-8', '.xlsx': 'application/octet-stream', '.jpg': 'image/jpeg'}

INIT = """files => {
  const REL = ['26-01 ○○ビル新築工事', '詳細図', '柱詳細図'];
  const root = { kind: 'directory', name: '①進行中工事',
    async *values() { yield { kind: 'file', name: '_鳥取サーバー.txt' }; },
    async resolve(h) { return h && h.__rel || null; }, async isSameEntry(o) { return o === this; },
    async queryPermission() { return 'granted'; }, async requestPermission() { return 'granted'; } };
  window.showDirectoryPicker = async () => root;
  window.showOpenFilePicker = async () => files.map(n => ({ kind: 'file', name: n, __rel: REL.concat(n),
    async getFile() { return new File([await (await fetch('/fx/' + encodeURIComponent(n))).arrayBuffer()], n); },
    async isSameEntry(o) { return o === this; }, async queryPermission() { return 'granted'; }, async requestPermission() { return 'granted'; } }));
  const put0 = IDBObjectStore.prototype.put; IDBObjectStore.prototype.put = function (v, k) { try { return put0.call(this, v, k); } catch (e) { return put0.call(this, null, k); } };
}"""


async def main():
    async with async_playwright() as p:
        b = await p.chromium.launch(channel='msedge')
        ctx = await b.new_context(viewport={'width': 1440, 'height': 810}, device_scale_factor=1.5, locale='ja-JP', accept_downloads=True)
        pg = await ctx.new_page()
        pg.on('pageerror', lambda e: print('画面のエラー', e))

        async def local(route):
            from urllib.parse import urlparse, unquote
            u = unquote(urlparse(route.request.url).path)
            f = os.path.join(FX, u[4:]) if u.startswith('/fx/') else os.path.join(APP, u[1:] or 'index.html')
            if not os.path.isfile(f): return await route.fulfill(status=404, body='')
            await route.fulfill(content_type=TYPES.get(os.path.splitext(f)[1], 'application/octet-stream'), body=open(f, 'rb').read())
        await pg.route('http://tk.local/**', local)

        async def gas(route):
            u = route.request.url
            if route.request.method == 'POST': return await route.fulfill(content_type='application/json', body='{"status":"success"}')
            body = ORDERS if 'action=orders' in u else SETTINGS
            await route.fulfill(content_type='application/json', body=json.dumps(body, ensure_ascii=False))
        await pg.route('**/script.google.com/**', gas)
        await pg.add_init_script(f"({INIT})({json.dumps(FILES, ensure_ascii=False)})")

        async def shot(name, sels, keep_toast=False, full=False):
            await pg.wait_for_timeout(500)
            if not keep_toast: await pg.evaluate("() => { const t = document.getElementById('toast'); if (t) t.className = ''; }")
            await pg.wait_for_timeout(300)
            await pg.screenshot(path=os.path.join(OUT, name + '.png'), full_page=full)
            r = {}
            for k, sel in sels.items():
                bb = await pg.locator(sel).first.bounding_box() if await pg.locator(sel).count() else None
                if bb: r[k] = bb
            rects[name] = r; print('撮影', name, ','.join(r))

        await pg.goto('http://tk.local/index.html')
        await pg.wait_for_function("document.querySelectorAll('#koji-select option').length > 1")
        await pg.evaluate('localStorage.clear()')
        await pg.click('.factory-btn[data-factory="鳥取"]')
        await pg.select_option('#koji-select', '26-01')
        await shot('02_selected', {'manual': '#manual-btn', 'factory': '#factory-btns', 'koji': '#koji-select', 'start': '#start-btn', 'box': '#start-box'})
        await pg.click('#start-btn'); await pg.wait_for_timeout(1500)
        await shot('04_started', {'label': '#koji-label', 'change': '#btn-change', 'manual': '#manual-btn', 'server': '#server-btns button', 'files': '#btn-files', 'reset': '#btn-reset', 'excel': '#btn-excel'})
        await pg.click('#server-btns button:has-text("鳥取")')
        await pg.wait_for_selector('#notice-modal.open')
        await shot('05_root', {'box': '#notice-modal .dialog', 'ok': '#notice-ok'})
        await pg.click('#notice-ok'); await pg.wait_for_timeout(700)
        await shot('06_server', {'server': '#server-btns button.selected', 'files': '#btn-files', 'repick': '#repick-root'}, keep_toast=True)
        await pg.click('#btn-files')
        got = False
        for k in range(1200):
            await pg.wait_for_timeout(250)
            pct = await pg.evaluate("() => document.getElementById('status-overlay').classList.contains('open') ? parseInt(document.getElementById('status-pct').textContent) : -1")
            if not got and pct >= 35 and '図面を読んでいます' in (await pg.text_content('#status-text')):
                await shot('07_progress', {'box': '#status-overlay .status-box'}); got = True
            if await pg.locator('#notice-modal.open').count() or (k > 20 and pct < 0): break
        n = 0
        while await pg.locator('#notice-modal.open').count():
            print('お知らせ', await pg.text_content('#notice-title'), '/', (await pg.text_content('#notice-body'))[:1500])
            await shot('08_notice' + (str(n) if n else ''), {'box': '#notice-modal .dialog', 'ok': '#notice-ok', 'dl': '#notice-dl'})
            n += 1
            await pg.click('#notice-ok'); await pg.wait_for_timeout(500)
        await pg.evaluate('window.scrollTo(0, 0)')
        await shot('09_list', {'summary': '.sum-card', 'card': '.prod-card', 'fl': '.prod-card .fl-title', 'head': '.prod-card tr.lhead', 'row': '.prod-card tr:nth-child(2)', 'dwg': '.prod-card tr:nth-child(2) td:nth-child(3)', 'state': '.prod-card tr:nth-child(2) td.note', 'excel': '#btn-excel', 'reset': '#btn-reset', 'change': '#btn-change', 'manual': '#manual-btn'})
        warn = pg.locator('.prod-card tr.warn')
        print('要確認の行', await warn.count())
        if await warn.count():
            await warn.first.scroll_into_view_if_needed(); await pg.evaluate('window.scrollBy(0, -150)')
            await shot('09_warn', {'warn': '.prod-card tr.warn'})
            await pg.evaluate('window.scrollTo(0, 0)')
        async with pg.expect_download(timeout=180000) as dl:
            await pg.click('#btn-excel')
        d = await dl.value
        await d.save_as(os.path.join(HERE, 'sample.xlsx')); print('ダウンロード名', d.suggested_filename)
        await pg.wait_for_timeout(800)
        await pg.click('#btn-reset'); await pg.wait_for_selector('#notice-modal.open')
        await shot('13_reset', {'box': '#notice-modal .dialog', 'ok': '#notice-ok', 'cancel': '#notice-cancel'})
        await pg.click('#notice-cancel'); await pg.wait_for_timeout(400)
        await pg.click('#btn-change'); await pg.wait_for_timeout(500)
        await shot('11_change', {'box': '#start-box', 'cancel': '#start-cancel-btn', 'start': '#start-btn'})
        json.dump(rects, open(os.path.join(HERE, 'rects.json'), 'w', encoding='utf-8'), ensure_ascii=False, indent=1)
        await b.close(); print('完了')

asyncio.run(main())
