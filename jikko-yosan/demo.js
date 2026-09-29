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
    return Object.assign({ key, folder: 'R8', fileNo: no, no, name, matchedBy: '工事名', c2: name, sheet, weight, amount,
      cats, author: '担当A', saved: '2026-09-28T17:30:00+09:00', mtimeMs: 0, locked: false, status: 'ok', warn: '' }, extra || {});
  }
  const b1 = row('90-11サンプル工事A　実行予算.xlsx', '90-11', 'サンプル工事A', 1234.5678, 456000000, '8.9.1', 400000, 0.5);
  const b2 = row('90-12サンプル工事B　実行予算.xlsx', '90-12', 'サンプル工事B', 800, 250000000, '8.8.20', 220000, 0.8);
  // 予算超過の例(運送費の実際を予算+30万円にする)
  const over = b2.cats['運送費'][0] + 300000 - b2.cats['運送費'][1];
  b2.cats['運送費'][1] += over; b2.cats['計'][1] += over;
  const b3 = row('90-13サンプル工事C　実行予算.xlsx', '90-13', 'サンプル工事C', 300, 90000000, '8.7.1', 80000, 1.0);
  const b4 = row('90-14サンプル工事D　実行予算.xlsx', '90-14', 'サンプル工事D', 150, 40000000, '8.6.1', 35000, 0.3);

  // 当日: Aは実際・参照シート・保存者が変更、Bは変更なし(編集中)、Cは元ファイルなし、Dは読み取りエラー、E・Fは新規
  const t1 = JSON.parse(JSON.stringify(b1));
  t1.sheet = '8.9.28'; t1.cats['材料費'][1] += 5000000; t1.cats['計'][1] += 5000000; t1.weight = 1240.001;
  t1.author = '担当B'; t1.saved = '2026-09-29T09:12:00+09:00';
  const t2 = Object.assign(JSON.parse(JSON.stringify(b2)), { locked: true });
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
})(typeof window !== 'undefined' ? window : this);
