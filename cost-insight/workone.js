/* 工事別結果分析: 工事をリストから選び、その工事だけの結果(工事情報・単価と損益・実行予算・月度ごとの推移)を表示する */
(function () {
  'use strict';
  let sel = null, rows = [];

  const budgetRow = no => {
    const d = state.data, works = (d.settings && d.settings.works) || {}, map = {};
    Object.keys(works).forEach(k => { map[k] = { done: JY.normDone(works[k].done), year: JY.normYear(works[k].year) }; });
    const v = JY.buildView(d.budget ? { today: d.budget } : null, map);
    return v.rows.filter(r => String(r.no).trim() === no).sort((x, y) => String(y.saved).localeCompare(String(x.saved)))[0] || null;
  };

  function list() {
    const m = state.model, q = document.getElementById('wo-search').value.trim().toLowerCase();
    // 生産実績か実行予算がある工事だけ(工事No順)
    rows = Object.keys(m.works).sort().map(no => m.works[no]).filter(w => w.weight > 0 || w.hours > 0 || w.hasBudget);
    const shown = rows.filter(w => !q || (w.no + ' ' + w.name).toLowerCase().indexOf(q) >= 0);
    document.getElementById('wo-list').innerHTML = shown.map(w =>
      '<button type="button" class="wo-item' + (w.no === sel ? ' on' : '') + '" data-no="' + esc(w.no) + '">' + esc(w.no) + ' ' + esc(w.name) +
      '<small>' + (w.done ? '完了' : '未完') + ' / ' + esc(w.year || '年度未設定') + '</small></button>').join('') || '<p class="note">該当する工事がありません</p>';
  }

  function result() {
    const el = document.getElementById('wo-result');
    if (!sel) { el.innerHTML = '<div class="card wo-empty">左のリストから工事を選んでください</div>'; return; }
    const m = state.model, w = m.works[sel];
    if (!w) { el.innerHTML = '<div class="card wo-empty">工事が見つかりません</div>'; return; }
    const cells = CICalc.filterCells(m, { works: { [sel]: true } });
    const t = CICalc.summarize(cells);
    const info = (l, v) => '<div>' + l + '<b>' + v + '</b></div>';
    let h = '<div class="card"><h2>' + esc(w.no) + ' ' + esc(w.name) + '<span class="wo-tag">' + (w.done ? '完了' : '未完') + '</span><span class="wo-tag">' + esc(w.year || '年度未設定') + '</span></h2><div class="wo-info">' +
      info('契約総重量', fmt(w.totalWeight, 1) + ' t') + info('契約金額', fmt(w.contract) + ' 円') + info('生産重量(累計)', fmt(w.weight, 1) + ' t') +
      info('生産割合', pct(w.coverage)) + info('工数(累計)', fmt(w.hours) + ' h') + info('労務費の締め', esc(w.cutoff ? CICalc.periodLabel(w.cutoff) : '—')) + '</div></div>';
    h += '<div class="card"><h2>結果(全期間)</h2><div id="kpis">' + kpiHtml(t) + '</div></div>';

    // 実行予算(実行予算抽出と同じ項目)
    const b = budgetRow(sel);
    if (b) {
      const c = {}; b.cells.forEach(x => { c[x.id] = x; });
      const txt = id => c[id] ? esc(c[id].text) : '';
      let th = '<tr><th>項目</th><th class="n">予算</th><th class="n">実際</th><th class="n">割合</th></tr>';
      JY.PROFITS.forEach(p => { th += '<tr><td>' + esc(p.label) + '</td><td class="n">' + txt(p.key + ':b') + '</td><td class="n">' + txt(p.key + ':a') + '</td><td></td></tr>'; });
      JY.CATS.forEach(k => { th += '<tr' + (k === '計' ? ' class="total"' : '') + '><td>' + esc(k) + '</td><td class="n">' + txt(k + ':b') + '</td><td class="n">' + txt(k + ':a') + '</td><td class="n">' + txt(k + ':r') + '</td></tr>'; });
      h += '<div class="card"><h2>実行予算</h2><div class="tbl-wrap"><table>' + th + '</table></div><p class="note">取込: ' + esc(JY.fmt('date', b.saved)) + '</p></div>';
    } else h += '<div class="card"><h2>実行予算</h2><p class="note">実行予算のデータがありません</p></div>';

    // 月度ごとの推移
    const g = {};
    cells.forEach(x => { (g[x.period] || (g[x.period] = [])).push(x); });
    const ps = Object.keys(g).sort();
    let pt = '<tr><th>月度</th><th class="n">生産重量(t)</th><th class="n">工数(h)</th><th class="n">人工/t</th><th class="n">売上(万円)</th><th class="n">仕入(万円)</th><th class="n">労務費(万円)</th><th class="n">損益(万円)</th><th class="n">利益率</th></tr>';
    ps.forEach(p => {
      const s = CICalc.summarize(g[p]), ok = s.profitSales > 0;
      pt += '<tr><td>' + esc(CICalc.periodLabel(p)) + '</td><td class="n">' + fmt(s.weight, 1) + '</td><td class="n">' + fmt(s.hours) + '</td><td class="n">' + (s.weight > 0 ? (s.hours / 8 / s.weight).toFixed(2) : '—') +
        '</td><td class="n">' + man(s.sales) + '</td><td class="n">' + man(s.purchase) + '</td><td class="n">' + man(s.labor) + '</td><td class="n">' + (ok ? man(s.profit) : '—') + '</td><td class="n">' + (ok ? pct(s.profitRate) : '—') + '</td></tr>';
    });
    h += '<div class="card"><h2>月度ごとの推移</h2>' + (ps.length ? '<div class="tbl-wrap"><table>' + pt + '</table></div>' : '<p class="note">生産実績がありません</p>') + '</div>';
    if (w.notes.length) h += '<div class="card"><h2>注意</h2><ul id="notes">' + w.notes.map(n => '<li>' + esc(n) + '</li>').join('') + '</ul></div>';
    el.innerHTML = h;
  }

  document.getElementById('wo-search').addEventListener('input', list);
  document.getElementById('wo-list').addEventListener('click', e => {
    const b = e.target.closest('.wo-item');
    if (!b) return;
    sel = b.dataset.no;
    list(); result();
  });
  window.WorkView = { show() { list(); result(); } };
})();
