# 説明書用の画面撮影。main と同じ画面(作業用ブランチのフォルダ)を Chrome で開き、操作しながら撮る。
# GAS は本物を使う(利用記録に「アプリを開いた」が1行入る)。Excelダウンロードは押さない(保存の記録は書かない)。
# ファイルを選ぶ画面はブラウザの外なので、選ぶ部分だけ撮影用のデータ(data フォルダ)を返すようにする。
import json, mimetypes, sys
from pathlib import Path
from urllib.parse import unquote
from playwright.sync_api import sync_playwright

HERE = Path(__file__).parent
APP = HERE.parent.parent / 'spl-sheet-web'
DATA = HERE / 'data'
SHOTS = HERE / 'shots'
SHOTS.mkdir(exist_ok=True)
LIST = json.loads((DATA / 'list.json').read_text(encoding='utf-8'))
JOB = '26-14 心斎橋スクエア建替計画（清水）'
REL = {'N': [JOB, '①-正光施工図', '01.一般図', '01.N棟'], 'S': [JOB, '①-正光施工図', '01.一般図', '02.S棟']}

STUB = r'''
(() => {
  const root = { kind: 'directory', name: '①進行中工事',
    async *values() { yield { kind: 'file', name: '_本社サーバー.txt' }; },
    async resolve(h) { return h.__rel || null; },
    async queryPermission() { return 'granted'; }, async requestPermission() { return 'granted'; } };
  window.showDirectoryPicker = async () => root;
  window.showOpenFilePicker = async () => {
    const q = window.__next; window.__next = null;
    if (!q) throw new DOMException('撮影用', 'AbortError');
    return q.map(it => ({ kind: 'file', name: it.name, __rel: it.rel,
      async getFile() { const b = await (await fetch('/data/' + it.folder + '/' + encodeURIComponent(it.name))).blob(); return new File([b], it.name); },
      async isSameEntry(o) { return o === this; },
      async queryPermission() { return 'granted'; }, async requestPermission() { return 'granted'; } }));
  };
})();
'''

rects = {}

def serve(route, request):
    url = request.url.split('://', 1)[1].split('/', 1)[1]
    url = unquote(url.split('?', 1)[0])
    p = (DATA / url[len('data/'):]) if url.startswith('data/') else (APP / (url or 'index.html'))
    if not p.is_file():
        return route.fulfill(status=404, body='not found')
    ct = mimetypes.guess_type(p.name)[0] or 'application/octet-stream'
    route.fulfill(status=200, body=p.read_bytes(), headers={'Content-Type': ct + ('; charset=utf-8' if ct.startswith(('text/', 'application/javascript')) else '')})

def shot(page, name, sels):
    page.wait_for_timeout(400)
    # 図面の場所(サーバーのパス)を写さない。前の操作の通知(トースト)も消してから撮る
    page.evaluate("() => { const d = document.getElementById('detail'); if (d) d.hidden = true; const t = document.getElementById('toast'); if (t) t.className = ''; }")
    page.wait_for_timeout(350)
    page.screenshot(path=str(SHOTS / f'{name}.png'))
    r = {}
    for key, sel in sels.items():
        b = page.locator(sel).first.bounding_box()
        if b: r[key] = b
    rects[name] = r
    print('撮影', name, list(r))

def modal_btn(page, label):
    page.locator('#modal-btns button', has_text=label).first.click()

def files(folder):
    return [{'name': n, 'folder': folder, 'rel': REL[folder] + [n]} for n in LIST[folder]]

with sync_playwright() as p:
    br = p.chromium.launch(channel='chrome', headless=True)
    ctx = br.new_context(viewport={'width': 1440, 'height': 810}, device_scale_factor=1.5, locale='ja-JP')
    ctx.route('http://spl.local/**', serve)
    ctx.add_init_script(STUB)
    page = ctx.new_page()
    page.on('pageerror', lambda e: print('画面のエラー', e, file=sys.stderr))
    page.goto('http://spl.local/index.html')
    page.wait_for_function("() => !document.body.classList.contains('loading-settings') && document.querySelectorAll('#server-btns button').length > 0", timeout=60000)
    shot(page, '01_start', {'koji': '#koji-select', 'excel': '#btn-excel', 'server': '#server-btns', 'reset': '#btn-reset', 'save': '#btn-save', 'brand': '#header-brand'})

    page.select_option('#koji-select', '26-14')
    page.set_input_files('#excel-input', str(DATA / LIST['excel']))
    page.wait_for_selector('#excel-done:not([hidden])')
    shot(page, '02_excel', {'done': '#excel-done', 'server': '#server-btns'})

    page.locator('#server-btns button', has_text='本社').click()
    page.wait_for_selector('#modal.open')
    shot(page, '03_root', {'box': '.modal-box', 'go': '#modal-btns button.primary'})
    modal_btn(page, '「①進行中工事」を選ぶ')
    page.wait_for_function("() => document.querySelector('#modal-title').textContent.includes('2回目')")
    shot(page, '04_tdf', {'box': '.modal-box', 'go': '#modal-btns button.primary'})

    page.evaluate('f => { window.__next = f; }', files('N'))
    modal_btn(page, 'TDFファイルを選ぶ')
    page.wait_for_function("() => document.querySelector('#modal-title').textContent === '選んだ図面の確認'")
    shot(page, '05_confirm1', {'box': '.modal-box', 'ok': '#modal-btns button.primary', 'add': "#modal-btns button:has-text('別のフォルダ')", 'back': "#modal-btns button:has-text('選び直す')"})

    modal_btn(page, '別のフォルダの図面を追加')
    page.wait_for_function("() => document.querySelector('#modal-title').textContent.includes('追加する')")
    shot(page, '06_add', {'box': '.modal-box', 'go': '#modal-btns button.primary'})
    page.evaluate('f => { window.__next = f; }', files('S'))
    modal_btn(page, 'TDFファイルを選ぶ')
    page.wait_for_function("() => document.querySelector('#modal-title').textContent === '選んだ図面の確認'")
    shot(page, '07_confirm2', {'box': '.modal-box', 'ok': '#modal-btns button.primary'})

    modal_btn(page, 'この図面で抽出する')
    page.wait_for_function("() => document.querySelector('#modal-title').textContent === '最新図との食い違い'", timeout=60000)
    shot(page, '08_diff', {'box': '.modal-box'})
    modal_btn(page, '閉じる')
    page.wait_for_timeout(300)

    shot(page, '09_table', {'summary': '#summary-line', 'chips': '#count-chips', 'only': 'label.chk', 'diffbtn': '#btn-diff',
                            'applysel': '#btn-apply-sel', 'applyall': '#btn-apply-all', 'save': '#btn-save', 'reset': '#btn-reset',
                            'rowdiff': 'tr.st-違い', 'rownew': 'tr.st-新規', 'rowman': 'tr.st-手入力', 'link': 'tr.st-違い td[data-c=B] a',
                            'diffcell': 'tr.st-違い td.diff', 'origrow': 'tr.st-違い td.c-row', 'check': 'tr.st-違い input.sel'})

    page.locator('label.chk input').check()
    shot(page, '10_only', {'only': 'label.chk', 'table': '#table-wrap'})
    page.locator('label.chk input').uncheck()

    page.locator('tr.st-違い td[data-c=H]').dblclick()
    page.wait_for_selector('tr.st-違い td[data-c=H] input')
    shot(page, '11_edit', {'cell': 'tr.st-違い td[data-c=H]'})
    page.keyboard.press('Escape')

    page.locator('tr.st-違い input.sel').check()
    shot(page, '12_select', {'check': 'tr.st-違い input.sel', 'applysel': '#btn-apply-sel', 'applyall': '#btn-apply-all'})
    page.locator('#btn-apply-all').click()
    page.wait_for_selector('#modal.open')
    shot(page, '13_applyall', {'box': '.modal-box'})
    modal_btn(page, 'やめる')

    page.locator('#btn-reset').click()
    page.wait_for_selector('#modal.open')
    shot(page, '14_reset', {'box': '.modal-box', 'reset': '#btn-reset'})
    modal_btn(page, 'やめる')

    (HERE / 'rects.json').write_text(json.dumps(rects, ensure_ascii=False, indent=1), encoding='utf-8')
    br.close()
print('完了')
