/* 実行予算抽出: 取り込んだ実行予算(GASの budget)を、実行予算まとめと同じ列で表にする。完了・年度は工事データの設定を使う */
(function () {
  'use strict';
  const esc = s => String(s === null || s === undefined ? '' : s).replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
  // 横スクロールしても固定する列(契約総重量・契約金額・参照シート)
  const STICKY = { weight: 'c-w', amount: 'c-a', sheet: 'c-s' };
  let view = null, filter = { done: false, years: [] };

  const yearTag = y => { const m = /^R(\d+)$/.exec(y || ''); return m ? ' y' + (Number(m[1]) % 4) : ''; };
  const cellText = c => c.kind === 't' ? JY.fmt('t1', c.v) : c.text;

  function build() {
    const d = state.data, works = (d.settings && d.settings.works) || {};
    const map = {};
    Object.keys(works).forEach(no => { map[no] = { done: JY.normDone(works[no].done), year: JY.normYear(works[no].year) }; });
    view = JY.buildView(d.budget ? { today: d.budget } : null, map);
  }

  function renderFilters() {
    const years = JY.yearsInRows(view.rows);
    filter.years = filter.years.filter(y => years.indexOf(y) >= 0);
    let h = '<button data-f="all" class="' + (JY.isFiltered(filter) ? '' : 'on') + '">全て表示</button>' +
      '<button data-f="done" class="' + (filter.done ? 'on' : '') + '">完了のみ表示</button><span>年度:</span>';
    years.forEach(y => { h += '<button data-f="year" data-y="' + esc(y) + '" class="' + (filter.years.indexOf(y) >= 0 ? 'on' : '') + '">' + esc(y) + '</button>'; });
    document.getElementById('ex-filters').innerHTML = h;
  }

  function render() {
    const meta = document.getElementById('ex-meta'), tbl = document.getElementById('ex-tbl');
    if (!view.rows.length) {
      meta.textContent = 'まだ実行予算を取り込んでいません(ホームの「実行予算取込」を実行してください)';
      tbl.innerHTML = '';
      document.getElementById('ex-filters').innerHTML = '';
      return;
    }
    renderFilters();
    const rows = JY.filterRows(view.rows, filter);
    meta.textContent = '最終取込: ' + JY.fmt('date', view.todayAt) + ' / ' + (rows.length === view.rows.length ? rows.length + '件' : rows.length + '件(全' + view.rows.length + '件)');
    let h = '<thead><tr><th rowspan="2" class="c-y">年度</th><th rowspan="2" class="c-d">完了</th><th rowspan="2" class="c-no">工事No</th><th rowspan="2" class="c-name">工事名</th>' +
      '<th rowspan="2" class="c-w">契約総重量(t)</th><th rowspan="2" class="c-a">契約金額(円)</th><th rowspan="2" class="c-s">参照シート</th>';
    JY.PROFITS.forEach(p => { h += '<th colspan="2" class="grp">' + esc(p.label) + '</th>'; });
    JY.CATS.forEach(c => { h += '<th colspan="3" class="grp">' + esc(c) + '</th>'; });
    h += '<th rowspan="2">前回の保存者</th><th rowspan="2">保存日時</th></tr><tr>';
    JY.PROFITS.forEach(() => { h += '<th class="grp-l">予算</th><th>実際</th>'; });
    JY.CATS.forEach(() => { h += '<th class="grp-l">予算</th><th>実際</th><th>割合</th>'; });
    h += '</tr>';
    if (JY.isFiltered(filter)) {
      const tot = JY.computeTotals(rows);
      h += '<tr class="total"><th class="c-y" colspan="3">合計（' + tot.count + '件）</th><th class="c-name"></th>';
      tot.cells.forEach(c => { h += '<th class="' + (STICKY[c.id] ? STICKY[c.id] + ' ' : '') + (c.kind === 'str' || c.kind === 'date' ? '' : 'num') + (c.over ? ' over' : '') + (c.id.endsWith(':b') ? ' grp-l' : '') + '">' + esc(cellText(c)) + '</th>'; });
      h += '</tr>';
    }
    h += '</thead><tbody>';
    rows.forEach(r => {
      h += '<tr class="' + r.rowClass + '"><td class="c-y' + yearTag(r.year) + '">' + esc(r.year || JY.UNSET) + '</td><td class="c-d">' + (r.done ? '完了' : '') + '</td>' +
        '<td class="c-no">' + esc(r.no) + '</td><td class="c-name">' + esc(r.name) + '</td>';
      r.cells.forEach(c => {
        const cls = [c.kind === 'str' || c.kind === 'date' ? 'txt' : 'num'];
        if (c.id.endsWith(':b')) cls.push('grp-l');
        if (STICKY[c.id]) cls.push(STICKY[c.id]);
        if (c.id === 'author') cls.push('ctr');
        if (c.over) cls.push('over');
        if (c.zero) cls.push('zero');
        h += '<td class="' + cls.join(' ') + '">' + esc(cellText(c)) + '</td>';
      });
      h += '</tr>';
    });
    if (!rows.length) h += '<tr><td class="txt" colspan="7">条件に合う工事がありません</td></tr>';
    tbl.innerHTML = h + '</tbody>';
    // 見出し2行目・合計行の固定位置(上の行の高さの合計)
    let top = 0;
    tbl.querySelectorAll('thead tr').forEach((tr, i) => {
      if (i) tr.querySelectorAll('th').forEach(th => { th.style.top = top + 'px'; });
      top += i ? tr.offsetHeight : tr.querySelector('th:not([rowspan])').offsetHeight;
    });
  }

  document.getElementById('ex-filters').addEventListener('click', e => {
    const b = e.target.closest('button[data-f]');
    if (!b) return;
    if (b.dataset.f === 'all') filter = { done: false, years: [] };
    else if (b.dataset.f === 'done') filter.done = !filter.done;
    else { const i = filter.years.indexOf(b.dataset.y); if (i >= 0) filter.years.splice(i, 1); else filter.years.push(b.dataset.y); }
    render();
  });
  // 行をクリックで強調(もう一度で解除)
  document.getElementById('ex-tbl').addEventListener('click', e => {
    const tr = e.target.closest('tbody tr');
    if (!tr) return;
    const cur = document.querySelector('#ex-tbl tr.sel');
    if (cur) cur.classList.remove('sel');
    if (cur !== tr) tr.classList.add('sel');
  });

  window.ExtractView = { show() { build(); render(); } };
})();
