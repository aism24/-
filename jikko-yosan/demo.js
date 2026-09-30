/* 動作確認用のダミーデータ(?demo=1 のときだけ使う。工事名・金額はすべて架空) */
(function (root) {
  const CATS = ['材料費', '工場加工費', '事務図面費', '外注加工費', 'メッキ費', '運送費', '塗装費', '現場費', 'その他'];
  function row(key, no, name, weight, amount, sheet, base, rate, extra) {
    const cats = {};
    let tb = 0, ta = 0;
    CATS.forEach((c, i) => {
      const b = Math.round(base * (9 - i) / 45) * 1000;
      const a = Math.round(b * rate * (i % 3 === 0 ? 1.05 : 0.9) / 1000) * 1000;
      cats[c] = [b, a]; tb += b; ta += a;
    });
    cats['計'] = [tb, ta];
    const gb = amount - tb, ga = amount - ta, pr = v => amount ? v / amount : null;
    const profit = { '粗利益': [gb, ga], '営業利益': [gb - amount * 0.1, ga - amount * 0.1] };
    const profitRate = { '粗利益': [pr(gb), pr(ga)], '営業利益': [pr(profit['営業利益'][0]), pr(profit['営業利益'][1])] };
    // 労務/外注の仕訳(工場加工費の8割・事務図面費の7割・現場費の5割を労務とする)
    const split = (c, k) => cats[c].map(v => Math.round(v * k));
    const breakdown = { '工場労務費': split('工場加工費', 0.8), '事務図面労務費': split('事務図面費', 0.7), '現場労務費': split('現場費', 0.5) };
    breakdown['工場外注費'] = cats['工場加工費'].map((v, i) => v - breakdown['工場労務費'][i]);
    breakdown['図面外注費'] = cats['事務図面費'].map((v, i) => v - breakdown['事務図面労務費'][i]);
    breakdown['現場費'] = cats['現場費'].map((v, i) => v - breakdown['現場労務費'][i]);
    return calc(Object.assign({ key, folder: 'R8', fileNo: no, no, name, matchedBy: '工事名', c2: name, sheet, weight, amount,
      cats, profit, profitRate, breakdown, laborCheck: [], author: '担当A', saved: '2026-09-28T17:30:00+09:00', mtimeMs: 0, locked: false, status: 'ok', warn: '' }, extra || {}));
  }
  // 正しい計算(PC側と同じ): 粗利益 = 契約金額 − 計 + 労務 / 営業利益 = 粗利益 − 労務
  function calc(r) {
    const pr = v => r.amount ? v / r.amount : null;
    const lab = i => ['工場労務費', '事務図面労務費', '現場労務費'].reduce((s, k) => s + r.breakdown[k][i], 0);
    const g = [0, 1].map(i => r.amount - r.cats['計'][i] + lab(i));
    r.profitCalc = { '粗利益': g, '営業利益': g.map((v, i) => v - lab(i)) };
    r.profitCalcRate = { '粗利益': r.profitCalc['粗利益'].map(pr), '営業利益': r.profitCalc['営業利益'].map(pr) };
    return r;
  }
  const b1 = row('90-11サンプル工事A　実行予算.xlsx', '90-11', 'サンプル工事A', 1234.5678, 456000000, '8.9.1', 400000, 0.5);
  const b2 = row('90-12サンプル工事B　実行予算.xlsx', '90-12', 'サンプル工事B', 800, 250000000, '8.8.20', 220000, 0.8);
  // 予算超過の例(運送費の実際を予算+30万円にする)
  const over = b2.cats['運送費'][0] + 300000 - b2.cats['運送費'][1];
  b2.cats['運送費'][1] += over; b2.cats['計'][1] += over; calc(b2);
  const b3 = row('90-13サンプル工事C　実行予算.xlsx', '90-13', 'サンプル工事C', 300, 90000000, '8.7.1', 80000, 1.0);
  const b4 = row('90-14サンプル工事D　実行予算.xlsx', '90-14', 'サンプル工事D', 150, 40000000, '8.6.1', 35000, 0.3);
  // Dは労務の仕訳が無い古いデータの例(粗利はシートの値、試算は従来の分け方)
  ['breakdown', 'profitCalc', 'profitCalcRate', 'laborCheck'].forEach(k => { delete b4[k]; });

  // 当日: Aは実際・参照シート・保存者が変更、Bは変更なし(編集中)、Cは元ファイルなし、Dは読み取りエラー、E・Fは新規
  const t1 = JSON.parse(JSON.stringify(b1));
  t1.sheet = '8.9.28'; t1.cats['材料費'][1] += 5000000; t1.cats['計'][1] += 5000000; t1.weight = 1240.001;
  ['粗利益', '営業利益'].forEach(p => { t1.profit[p][1] -= 5000000; t1.profitRate[p][1] = t1.profit[p][1] / t1.amount; });
  calc(t1);
  t1.author = '担当B'; t1.saved = '2026-09-29T09:12:00+09:00';
  // Bは編集中+Excelの式の警告(laborCheck の warn)の例
  const t2 = Object.assign(JSON.parse(JSON.stringify(b2)), { locked: true,
    laborCheck: [{ level: 'warn', msg: '粗利益(実際)の式に労務の行(L56)が含まれていません' }] });
  const t3 = Object.assign(JSON.parse(JSON.stringify(b3)), { missing: true });
  const t4 = Object.assign(JSON.parse(JSON.stringify(b4)), { status: 'error', warn: 'シートが見つかりません' });
  const t5 = row('90-15サンプル工事E　実行予算.xlsx', '90-15', 'サンプル工事E', 0, 0, '8.9.29', 0, 0);
  const t6 = row('99-99サンプル工事F　実行予算.xlsx', '99-99', '', 50, 10000000, '8.9.29', 9000, 0.1,
    { matchedBy: '一覧に未登録', c2: 'サンプル工事F(未登録)' });

  function rows(list) { const o = {}; list.forEach(r => { o[r.key] = r; }); return o; }
  root.JY_DEMO = {
    baseline: { day: '2026-09-28', at: '2026-09-28T08:05:00+09:00', rows: rows([b1, b2, b3, b4]) },
    today: { day: '2026-09-29', at: '2026-09-29T08:03:00+09:00', rows: rows([t1, t2, t3, t4, t5, t6]) },
  };
  // 「情報」シートの完了・年度(A 工事No / C 完了 / D 年度)。表記ゆれ(r9・令和8)も入れておく。99-99 は一覧に無い
  root.JY_DEMO_SETTINGS = [
    ['90-11', '完了', 'R8'], ['90-12', '', 'r9'], ['90-13', '', ''], ['90-14', '完了', '令和8'], ['90-15', '', 'R9'],
  ];
})(typeof window !== 'undefined' ? window : this);
