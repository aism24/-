/*
 * コストインサイト - 計算ロジック(画面描画から独立した純粋関数のみ)
 * ブラウザ(window.CICalc)とNode(require)の両方から読み込める。
 *
 * ■ 用語(生産損益分析 production-profit/calc.js と同じ)
 *   月度 : 20日締め。'2026-10' = 2026/09/21〜2026/10/20。実行予算Excelの月度「2026.10」と同じ
 *   期   : 11/21始まり。期の開始年で表す(2025 = 2025/11/21〜2026/11/20)
 *
 * ■ 3つの単価(工事ごとに決め、日付×工場×工事のセルに掛けて合算する)
 *   加工単価(円/t) = 契約金額 ÷ 契約総重量(契約総重量が空欄なら生産実績の総重量。0なら単価なし。旧 生産損益分析 と同じ)
 *   仕入単価(円/t) = 仕入 ÷ 契約総重量。仕入 = 実行予算の 計 − 労務費(工場労務費+事務図面労務費+現場労務費)
 *                    完了の工事は実際(請求計)、未完の工事は予算の値(「見込み」)
 *   時間単価(円/h) = 労務費 ÷ 工数(労務費の締めまで)
 *     - 労務費は実行予算Excelの月度ごとの労務費(laborByMonth)。締め = 労務費がある最後の月度(laborCutoff)
 *     - 工数は日報。共通の工数(基本設定の共通扱い工事No・工事No不明)は、同じ工場・同じ月度の
 *       各工事の工数比で按分して足す(その工場・月度の工事の工数を (工事+共通)/工事 倍する)
 *     - 日報のデータが始まる前の月度の労務費は、対応する工数が無いため割り算に入れない
 *     - 締めより後の工数は、その工事の時間単価 × 工数 で労務費を見込む(「見込み」)
 *   損益 = 生産重量 ×(加工単価 − 仕入単価)− 工数 × 時間単価
 *   (生産重量・工数は生産管理・日報の実績だけを使う。実行予算Excelの加工重量・工数は使わない)
 *
 * ■ 分析できる期間
 *   生産重量は生産管理の値と履歴(工事マスタの工事は全期間)。期間別・工場別・損益は analysisFrom
 *   (生産重量と日報の工数の両方が揃っている最初の月度の初日)以降に限る
 *   (画面で強制)。時間単価の計算には、それより前の工数・労務費も使う。
 *   analysisFrom より前に工数がある工事で、生産重量が契約総重量に届かないものは dataShort(生産重量のデータ不足)。
 *   単価が無い工事(実行予算なし・契約金額なし等)のセルは、損益(profit)の合計に入れない。
 */
(function (root) {
  'use strict';

  var COMMON = '共通';
  var LABOR_KEYS = ['工場労務費', '事務図面労務費', '現場労務費'];

  /* ===================== 日付・月度 ===================== */

  function pad2(n) { return (n < 10 ? '0' : '') + n; }
  function shiftPeriod(key, delta) {
    var p = key.split('-');
    var idx = Number(p[0]) * 12 + (Number(p[1]) - 1) + delta;
    return Math.floor(idx / 12) + '-' + pad2(idx % 12 + 1);
  }
  /* 日付(YYYY-MM-DD)が属する月度キー。21日以降は翌月度。 */
  function periodKeyOf(ymd) {
    var p = ymd.split('-');
    var key = p[0] + '-' + p[1];
    return Number(p[2]) >= 21 ? shiftPeriod(key, 1) : key;
  }
  function periodRange(key) { return { from: shiftPeriod(key, -1) + '-21', to: key + '-20' }; }
  function periodLabel(key) { var p = key.split('-'); return p[0] + '年' + Number(p[1]) + '月度'; }
  /* 実行予算Excelの月度「2026.6」→ '2026-06'(読めなければ '') */
  function periodFromBudget(s) {
    var m = /^(\d{4})\.(\d{1,2})$/.exec(String(s || '').trim());
    return m ? m[1] + '-' + pad2(Number(m[2])) : '';
  }
  /* 月度が属する期(開始年)。12月度(11/21〜12/20)が期の最初の月度。 */
  function fiscalYearOf(key) { var p = key.split('-'); return Number(p[1]) === 12 ? Number(p[0]) : Number(p[0]) - 1; }
  function fiscalRange(fy) { return { from: fy + '-11-21', to: (fy + 1) + '-11-20' }; }

  function num(v) { return (v === null || v === undefined || v === '' || isNaN(Number(v))) ? null : Number(v); }

  function commonSet(settings) {
    var set = {};
    String((settings || {}).commonWorkNos || '').split(/[,、\s]+/).forEach(function (w) { if (w) set[w] = true; });
    return set;
  }
  function isCommon(no, set) { return !no || !!set[no]; }

  /* ===================== 実行予算(工事ごと) ===================== */

  /* 受信した実行予算(_cache_budget.json の rows: key→1ファイル)を工事No→1件にする。
     対象外: 読み取りエラーで前回値も無い・一覧に未登録・工事No無し。同じ工事Noが複数あれば保存日時の新しい方。 */
  function budgetByWork(budget) {
    var rows = (budget && budget.rows) || {};
    var out = {};
    Object.keys(rows).forEach(function (k) {
      var r = rows[k];
      if (!r || !r.no || r.matchedBy === '一覧に未登録' || !r.cats || !r.cats['計']) return;
      var prev = out[r.no];
      if (prev && String(prev.saved || '') >= String(r.saved || '')) return;
      out[r.no] = r;
    });
    return out;
  }

  function laborSum(r, side) {
    var bd = r.breakdown || {};
    return LABOR_KEYS.reduce(function (t, k) { return t + (num((bd[k] || [])[side]) || 0); }, 0);
  }

  /* 月度ごとの労務費(3つの合計)を { '2026-06': 円 } で返す */
  function laborByPeriod(r) {
    var out = {};
    var by = r.laborByMonth || {};
    LABOR_KEYS.forEach(function (k) {
      Object.keys(by[k] || {}).forEach(function (m) {
        var p = periodFromBudget(m);
        if (p) out[p] = (out[p] || 0) + (num(by[k][m]) || 0);
      });
    });
    return out;
  }

  /* ===================== 全体の計算 ===================== */

  /* data = { cache: _cache_production.json, settings: readSettings_ の結果, budget: _cache_budget.json(無ければnull) }
     戻り値 model = {
       works: { 工事No: 工事ごとの値(下の w) },
       cells: [{ ymd, period, site, no, weight, hours(共通の按分込み), hoursOwn, sales, purchase, labor, laborEst, purchaseEst }],
       firstPeriod: 日報・生産データが月度の初日から揃っている最初の月度,
       unallocated: [{ period, site, hours }](同じ工場・月度に工事の工数が無く、按分できなかった共通の工数),
     } */
  function build(data) {
    var cache = data.cache || {}, settings = data.settings || {}, sw = settings.works || {};
    var cset = commonSet(settings);
    var rec = cache.rec || [];
    var budget = budgetByWork(data.budget);

    // 日報(工数)が揃っている最初の月度(最初の日が月度の初日=21日ならその月度、途中からなら次の月度)。
    // 生産重量は履歴で日報より前の日付もあるため、工数のある日だけで決める(労務費の割り算の開始に使う)
    var minYmd = rec.reduce(function (m, r) { return r[4] > 0 && (!m || r[0] < m) ? r[0] : m; }, '');
    var firstPeriod = minYmd ? (periodRange(periodKeyOf(minYmd)).from === minYmd ? periodKeyOf(minYmd) : shiftPeriod(periodKeyOf(minYmd), 1)) : '';

    // 生産重量のデータが月度の初日から揃っている最初の月度の初日(これより前は重量が無い)
    var minW = rec.reduce(function (m, r) { return r[3] > 0 && (!m || r[0] < m) ? r[0] : m; }, '');
    var wp = minW ? periodKeyOf(minW) : '';
    if (wp && periodRange(wp).from !== minW) wp = shiftPeriod(wp, 1);
    if (wp && firstPeriod && wp < firstPeriod) wp = firstPeriod; // 工数(日報)が無い期間は分析しない
    var analysisFrom = wp ? periodRange(wp).from : '';

    // 1) 共通の工数の按分: 工場×月度ごとに 工事の工数 と 共通の工数 を集計
    var ps = {};
    rec.forEach(function (r) {
      var key = periodKeyOf(r[0]) + '|' + r[1];
      var c = ps[key] || (ps[key] = { work: 0, common: 0 });
      if (isCommon(r[2], cset)) c.common += r[4] || 0; else c.work += r[4] || 0;
    });
    var unallocated = [];
    Object.keys(ps).sort().forEach(function (key) {
      var c = ps[key];
      c.factor = c.work > 0 ? (c.work + c.common) / c.work : 1;
      if (c.work <= 0 && c.common > 0) unallocated.push({ period: key.split('|')[0], site: key.split('|')[1], hours: c.common });
    });

    // 2) 工事ごとの値
    var works = {};
    function work(no) {
      if (works[no]) return works[no];
      var m = sw[no] || {}, info = (cache.works || {})[no] || {};
      var contract = num(m.contract), tw = num(m.totalWeight);
      var total = tw !== null ? tw : (num(info.totalWeight) || 0);
      var w = works[no] = {
        no: no, name: m.name || info.name || '', done: !!m.done, year: m.year || '',
        contract: contract, totalWeight: total,
        procUnit: contract !== null && total > 0 ? contract / total : null,
        hasBudget: false, purchaseActual: null, purchaseBudget: null, purchase: null, purchaseEst: !m.done, purchaseUnit: null,
        laborUsed: 0, laborBeforeData: 0, cutoff: '', hoursToCutoff: 0, hourRate: null,
        weight: 0, hours: 0, hoursBeforeAnalysis: 0, coverage: null, dataShort: false, notes: [],
      };
      var b = budget[no];
      if (b) {
        w.hasBudget = true;
        w.purchaseActual = num(b.cats['計'][1]) - laborSum(b, 1);
        w.purchaseBudget = num(b.cats['計'][0]) - laborSum(b, 0);
        w.purchase = w.done ? w.purchaseActual : w.purchaseBudget;
        w.purchaseUnit = total > 0 ? w.purchase / total : null;
        w.cutoff = periodFromBudget(b.laborCutoff);
        w.laborByPeriod = laborByPeriod(b);
        if (b.missing) w.notes.push('実行予算のファイルが見つからないため前回の値');
        if (b.status === 'error') w.notes.push('実行予算の読み取りエラーのため前回の値');
      } else w.notes.push('実行予算のデータなし');
      if (contract === null) w.notes.push('契約金額なし');
      else if (tw === null) w.notes.push('契約総重量が無いため生産実績の総重量で加工単価を計算');
      else if (!(tw > 0)) w.notes.push('契約総重量が0のため単価なし(実行予算Excelの入力が未完了の可能性)');
      return w;
    }
    Object.keys(sw).forEach(work);

    // 3) セル(日付×工場×工事)。共通の工数は工事の工数に按分済みなのでセルにしない
    var cells = [];
    rec.forEach(function (r) {
      var no = r[2];
      if (isCommon(no, cset)) return;
      var period = periodKeyOf(r[0]);
      var f = ps[period + '|' + r[1]].factor;
      var w = work(no);
      var cell = { ymd: r[0], period: period, site: r[1], no: no, weight: r[3] || 0, hoursOwn: r[4] || 0, hours: (r[4] || 0) * f };
      w.weight += cell.weight; w.hours += cell.hours;
      if (analysisFrom && cell.ymd < analysisFrom) w.hoursBeforeAnalysis += cell.hours;
      if (w.cutoff && period >= firstPeriod && period <= w.cutoff) w.hoursToCutoff += cell.hours;
      cells.push(cell);
    });

    // 4) 時間単価(締めまでの労務費 ÷ 締めまでの工数。日報が始まる前の月度の労務費は除く)
    Object.keys(works).forEach(function (no) {
      var w = works[no];
      if (!w.hasBudget) return;
      Object.keys(w.laborByPeriod).forEach(function (p) {
        var v = w.laborByPeriod[p];
        if (p < firstPeriod) w.laborBeforeData += v;
        else if (w.cutoff && p <= w.cutoff) w.laborUsed += v;
      });
      if (w.laborBeforeData) w.notes.push('日報のデータが始まる前の労務費 ' + Math.round(w.laborBeforeData).toLocaleString('ja-JP') + '円は時間単価に入れていません');
      if (w.hoursToCutoff > 0 && w.laborUsed > 0) w.hourRate = w.laborUsed / w.hoursToCutoff;
      else if (w.laborUsed > 0) w.notes.push('労務費の締めまでの工数が無いため時間単価なし');
    });

    // 生産重量の割合と、データ不足の判定
    Object.keys(works).forEach(function (no) {
      var w = works[no];
      w.coverage = w.totalWeight > 0 ? w.weight / w.totalWeight : null;
      w.dataShort = w.hoursBeforeAnalysis > 0 && (w.coverage === null || w.coverage < 0.95);
      if (w.dataShort) w.notes.push('生産重量のデータ不足(' + analysisFrom.replace(/-/g, '/') + 'より前の生産重量が無い)');
    });

    // 5) セルの金額
    cells.forEach(function (c) {
      var w = works[c.no];
      c.sales = w.procUnit !== null ? c.weight * w.procUnit : null;
      c.purchase = w.purchaseUnit !== null ? c.weight * w.purchaseUnit : null;
      c.purchaseEst = w.purchaseEst;
      c.labor = w.hourRate !== null ? c.hours * w.hourRate : null;
      c.laborEst = !w.cutoff || c.period > w.cutoff;
      c.ok = c.sales !== null && c.purchase !== null && c.labor !== null;
    });

    return { works: works, cells: cells, firstPeriod: firstPeriod, analysisFrom: analysisFrom, unallocated: unallocated };
  }

  /* ===================== 集計(画面の絞り込み) ===================== */

  /* opt = { from, to(YYYY-MM-DD・省略可), sites:[…](省略=全部), doneOnly, works:{工事No:true}(省略=全部) } */
  function filterCells(model, opt) {
    opt = opt || {};
    var siteSet = null;
    if (opt.sites) { siteSet = {}; opt.sites.forEach(function (s) { siteSet[s] = true; }); }
    return model.cells.filter(function (c) {
      if (opt.from && c.ymd < opt.from) return false;
      if (opt.to && c.ymd > opt.to) return false;
      if (siteSet && !siteSet[c.site]) return false;
      if (opt.works && !opt.works[c.no]) return false;
      if (opt.doneOnly && !model.works[c.no].done) return false;
      return true;
    });
  }

  /* セルの合計と単価。金額が分からないセル(単価が無い工事)は件数を数え、金額の合計には入れない。
     単価 = 金額 ÷ (金額が分かるセルの)重量・工数。
     損益(profit)・利益率は、3つの金額がすべて分かるセルだけで計算する(分からないセルの重量・工数は ngWeight・ngHours) */
  function summarize(cells) {
    var t = { weight: 0, hours: 0, sales: 0, purchase: 0, labor: 0, profit: 0, profitSales: 0, ngWeight: 0, ngHours: 0,
      wSales: 0, wPurchase: 0, hLabor: 0, purchaseEst: false, laborEst: false };
    cells.forEach(function (c) {
      t.weight += c.weight; t.hours += c.hours;
      if (c.sales !== null) { t.sales += c.sales; t.wSales += c.weight; }
      if (c.purchase !== null) { t.purchase += c.purchase; t.wPurchase += c.weight; if (c.purchaseEst && c.weight) t.purchaseEst = true; }
      if (c.labor !== null) { t.labor += c.labor; t.hLabor += c.hours; if (c.laborEst && c.hours) t.laborEst = true; }
      if (c.ok) { t.profit += c.sales - c.purchase - c.labor; t.profitSales += c.sales; } else { t.ngWeight += c.weight; t.ngHours += c.hours; }
    });
    t.procUnit = t.wSales > 0 ? t.sales / t.wSales : null;
    t.purchaseUnit = t.wPurchase > 0 ? t.purchase / t.wPurchase : null;
    t.hourRate = t.hLabor > 0 ? t.labor / t.hLabor : null;
    t.profitRate = t.profitSales > 0 ? t.profit / t.profitSales : null;
    return t;
  }

  /* cellsをキーごとに分けて集計する(keyFn: セル→キー) */
  function groupBy(cells, keyFn) {
    var g = {};
    cells.forEach(function (c) { var k = keyFn(c); (g[k] || (g[k] = [])).push(c); });
    var out = {};
    Object.keys(g).forEach(function (k) { out[k] = summarize(g[k]); });
    return out;
  }

  var api = {
    COMMON: COMMON, LABOR_KEYS: LABOR_KEYS,
    shiftPeriod: shiftPeriod, periodKeyOf: periodKeyOf, periodRange: periodRange, periodLabel: periodLabel,
    periodFromBudget: periodFromBudget, fiscalYearOf: fiscalYearOf, fiscalRange: fiscalRange,
    budgetByWork: budgetByWork, build: build, filterCells: filterCells, summarize: summarize, groupBy: groupBy,
  };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else root.CICalc = api;
})(this);
