/* 実行予算まとめ - 画面 */
'use strict';

// GAS WebアプリのURL(gas/Code.gs をデプロイしたURL)
const GAS_API_URL = 'https://script.google.com/macros/s/AKfycbyun0FKHcFSvu5j8RRYpevoZfMC3F2WUkd3vC7_PopGvuv3i2ecwfRy3aiPOaXb9K1G3A/exec';
// ?demo=1 でダミーデータ表示(動作確認用。実データは使わない)
const DEMO = new URLSearchParams(location.search).get('demo') === '1';

const EXCELJS_URL = 'https://cdnjs.cloudflare.com/ajax/libs/exceljs/4.4.0/exceljs.min.js';

let view = null;

function loadScript(src) {
  return new Promise((resolve, reject) => {
    const s = document.createElement('script');
    s.src = src;
    s.onload = resolve;
    s.onerror = () => reject(new Error(src + ' を読み込めませんでした'));
    document.head.appendChild(s);
  });
}

async function load() {
  let payload;
  if (DEMO) {
    await loadScript('demo.js');
    payload = window.JY_DEMO;
  } else {
    if (!GAS_API_URL) throw new Error('GAS_API_URLが未設定です(app.js)。動作確認は URL の末尾に ?demo=1 を付けてください');
    const res = await fetch(GAS_API_URL + '?t=' + Date.now());
    const body = await res.json();
    if (body.status !== 'success') throw new Error(body.message || 'エラー');
    payload = body.data;
  }
  view = JY.buildView(payload);
  render();
}

function esc(s) {
  return String(s === null || s === undefined ? '' : s).replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
}

// 横スクロールしても固定する列(工事No・工事名に加えて参照シートまで。Excelの固定範囲と同じ)
const STICKY = { weight: 'c-w', amount: 'c-a', sheet: 'c-s' };

function render() {
  const meta = document.getElementById('meta');
  if (!view.rows.length) {
    meta.textContent = 'まだデータがありません(会社PCで「実行予算更新.bat」を実行すると表示されます)';
    document.getElementById('tbl').innerHTML = '';
    return;
  }
  meta.innerHTML = (DEMO ? '<b class="demo">デモ表示</b> ' : '') +
    '最終更新: ' + esc(JY.fmt('date', view.todayAt)) +
    ' / 比較の基準: ' + esc(view.baselineAt ? JY.fmt('date', view.baselineAt) : 'なし(初回)') +
    ' / ' + view.rows.length + '件';

  let h = '<thead><tr><th rowspan="2" class="c-no">工事No</th><th rowspan="2" class="c-name">工事名</th>' +
    '<th rowspan="2" class="c-w">契約総重量(t)</th><th rowspan="2" class="c-a">契約金額(円)</th><th rowspan="2" class="c-s">参照シート</th>';
  JY.PROFITS.forEach(p => { h += '<th colspan="4" class="grp">' + esc(p.label) + '</th>'; });
  JY.CATS.forEach(c => { h += '<th colspan="3" class="grp">' + esc(c) + '</th>'; });
  h += '<th rowspan="2">前回の保存者</th><th rowspan="2">保存日時</th><th rowspan="2">状態</th></tr><tr>';
  JY.PROFITS.forEach(() => { h += '<th class="grp-l">予算</th><th>予算率</th><th>実際</th><th>実際率</th>'; });
  JY.CATS.forEach(() => { h += '<th class="grp-l">予算</th><th>実際</th><th>割合</th>'; });
  h += '</tr></thead><tbody>';

  view.rows.forEach(r => {
    h += '<tr class="' + r.rowClass + '"><td class="c-no">' + esc(r.no) + '</td><td class="c-name">' + esc(r.name) + '</td>';
    r.cells.forEach(c => {
      const cls = [c.kind === 'str' || c.kind === 'date' ? 'txt' : 'num'];
      if (c.id.endsWith(':b')) cls.push('grp-l');
      if (STICKY[c.id]) cls.push(STICKY[c.id]);
      if (c.changed) cls.push('chg');
      if (c.over) cls.push('over');
      h += '<td class="' + cls.join(' ') + '"' + (c.changed ? ' title="前回：' + esc(c.prev) + '"' : '') + '>' + esc(c.text) +
        (c.changed ? '<div class="prev">前回：' + esc(c.prev) + '</div>' : '') + '</td>';
    });
    h += '<td class="txt st"' + (r.warn ? ' title="' + esc(r.warn) + '"' : '') + '>' + esc(r.status) + '</td></tr>';
  });
  document.getElementById('tbl').innerHTML = h + '</tbody>';
  document.getElementById('btn-xlsx').disabled = false;
}

async function downloadXlsx() {
  if (!window.ExcelJS) await loadScript(EXCELJS_URL);
  const wb = JY.buildWorkbook(ExcelJS, view);
  const buf = await wb.xlsx.writeBuffer();
  const d = new Date(Date.now() + 9 * 3600000);
  const name = '実行予算まとめ_' + d.getUTCFullYear() + String(d.getUTCMonth() + 1).padStart(2, '0') +
    String(d.getUTCDate()).padStart(2, '0') + '.xlsx';
  const a = document.createElement('a');
  a.href = URL.createObjectURL(new Blob([buf], { type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' }));
  a.download = name;
  document.body.appendChild(a);
  a.click();
  setTimeout(() => { URL.revokeObjectURL(a.href); a.remove(); }, 1000);
}

document.getElementById('btn-xlsx').addEventListener('click', () => {
  const btn = document.getElementById('btn-xlsx');
  btn.disabled = true;
  btn.textContent = '作成中…';
  downloadXlsx()
    .catch(err => alert('Excelの作成に失敗しました: ' + err.message))
    .finally(() => { btn.disabled = false; btn.textContent = 'Excelダウンロード'; });
});

load().catch(err => {
  document.getElementById('meta').textContent = '';
  const m = document.getElementById('msg');
  m.textContent = '読み込みに失敗しました: ' + err.message;
  m.hidden = false;
});
