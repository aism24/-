/*
 * 生産損益分析 - 計算ロジック(画面描画から独立した純粋関数のみ)
 * ブラウザ(window.PPCalc)とNode(require)の両方から使えるようにしてある
 * (Nodeからはリグレッションテストで読み込む)。
 *
 * ■ 用語
 *   月度 : 20日締め。'2026-10' = 2026/09/21〜2026/10/20
 *   期   : 11/21始まり。期の開始年で表す(2025 = 2025/11/21〜2026/11/20)
 *   人工 : 作業時間(h) ÷ 8
 *
 * ■ 費用モデル(工場×月度のセルごとに計算し、表示範囲で合算する)
 *   基準売上 = 実績売上(目標は利益目標額=売上×利益率のみ。月間目標は使わない)
 *   人件費単価(円/人工) = 実額入力があればそれ、無ければ 人件費率×基準売上÷基準人工
 *   固定費(円)         = 実額(月額)入力があればそれ、無ければ 固定費率×基準売上
 *   変動費単価(円/t)   = 実額入力があればそれ、無ければ 変動費率×基準トン単価
 *   損益 = 売上 − 人件費(人工×人件費単価) − 変動費(重量×変動費単価) − 固定費
 *   損益分岐点トン数 = 固定費 ÷ (トン単価 − 変動費単価 − 人工/t×人件費単価)
 *   利益目標達成トン数 = 固定費 ÷ (トン単価×(1−利益率) − 変動費単価 − 人工/t×人件費単価)
 *   (目標シミュレーター(simulate)だけは人件費を固定費に含め、
 *    損益分岐点トン数 = (固定費 + 人件費) ÷ (トン単価 − 変動費単価) とする)
 */
(function (root) {
  'use strict';

  var HOURS_PER_NINKU = 8;
  var COMMON_WORK = '共通';
  var DEFAULT_SITES = ['本社', '夢前', '鳥取'];

  function defaultSettings() {
    return {
      rates: { labor: 30, variable: 40, fixed: 15, profit: 15 },
      commonWorkNos: '00-00', // 共通(工事なし)として扱う工事No(カンマ区切り)
      works: {},   // workNo -> { totalWeight: number|null(上書き), contract: number|null }
      costs: {},   // site -> { laborRate, fixedMonthly, variablePerTon } (いずれもnull=未入力)
    };
  }

  /* ===================== 日付・月度 ===================== */

  function pad2(n) { return (n < 10 ? '0' : '') + n; }
  function ymdToUtc(ymd) {
    var p = ymd.split('-');
    return Date.UTC(Number(p[0]), Number(p[1]) - 1, Number(p[2]));
  }
  function utcToYmd(t) {
    var d = new Date(t);
    return d.getUTCFullYear() + '-' + pad2(d.getUTCMonth() + 1) + '-' + pad2(d.getUTCDate());
  }
  function daysInclusive(from, to) { return Math.round((ymdToUtc(to) - ymdToUtc(from)) / 86400000) + 1; }

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

  function periodRange(key) {
    var prev = shiftPeriod(key, -1);
    return { from: prev + '-21', to: key + '-20' };
  }

  function periodLabel(key) {
    var p = key.split('-');
    return p[0] + '年' + Number(p[1]) + '月度';
  }

  /* 月度が属する期(開始年)。12月度(11/21〜12/20)が期の最初の月度。 */
  function fiscalYearOf(key) {
    var p = key.split('-');
    return Number(p[1]) === 12 ? Number(p[0]) : Number(p[0]) - 1;
  }
  function fiscalRange(fy) { return { from: fy + '-11-21', to: (fy + 1) + '-11-20' }; }
  function fiscalLabel(fy) { return fy + '/11/21〜' + (fy + 1) + '/11/20期'; }

  /* 範囲[from,to]に掛かる月度と、その月度のうち範囲に含まれる日数の割合(frac)。 */
  function periodsInRange(from, to) {
    if (from > to) return [];
    var list = [];
    var key = periodKeyOf(from);
    var last = periodKeyOf(to);
    while (key <= last) {
      var r = periodRange(key);
      var s = r.from > from ? r.from : from;
      var e = r.to < to ? r.to : to;
      list.push({ key: key, frac: daysInclusive(s, e) / daysInclusive(r.from, r.to) });
      key = shiftPeriod(key, 1);
    }
    return list;
  }

  /* ===================== 単価 ===================== */

  function num(v) { return (v === null || v === undefined || v === '' || isNaN(Number(v))) ? null : Number(v); }

  /* 工事ごとのトン単価。契約金額÷契約総重量(契約総重量が未入力なら、代わりに生産実績の総重量)。
     契約金額が無い工事は単価0(売上0円)として扱い、画面で警告する。 */
  function unitPriceOf(workNo, data, settings) {
    var w = (settings.works || {})[workNo] || {};
    var info = (data.works || {})[workNo] || {};
    var total = num(w.totalWeight) !== null ? num(w.totalWeight) : (info.totalWeight || 0);
    var contract = num(w.contract);
    if (contract !== null && total > 0) return { price: contract / total, source: 'contract', totalWeight: total };
    return { price: 0, source: 'none', totalWeight: total };
  }

  /* ===================== 集計 ===================== */

  function commonWorkSet(settings) {
    var set = {};
    String(settings.commonWorkNos || '').split(/[,、\s]+/).forEach(function (w) { if (w) set[w] = true; });
    set[COMMON_WORK] = true;
    return set;
  }

  function emptyAgg() { return { weight: 0, hours: 0, sales: 0 }; }
  function addAgg(a, w, h, s) { a.weight += w; a.hours += h; a.sales += s; }

  /* data.rec: [ymd, site, workNo, weight(t), hours(h)] の配列。
     返り値 cells: 'period|site' -> { weight, hours, sales, byWork: {workNo: agg} } */
  function aggregate(data, settings, from, to, sites) {
    var siteSet = {};
    (sites || data.sites || DEFAULT_SITES).forEach(function (s) { siteSet[s] = true; });
    var commonSet = commonWorkSet(settings);
    var priceCache = {};
    var cells = {};
    (data.rec || []).forEach(function (r) {
      var ymd = r[0], site = r[1];
      if (ymd < from || ymd > to || !siteSet[site]) return; // 範囲外は先に除外(大半の行がここで抜ける)
      var workNo = r[2], w = r[3] || 0, h = r[4] || 0;
      if (!workNo || commonSet[workNo]) workNo = COMMON_WORK;
      if (!priceCache[workNo]) priceCache[workNo] = workNo === COMMON_WORK ? { price: 0 } : unitPriceOf(workNo, data, settings);
      var s = w * priceCache[workNo].price;
      var key = periodKeyOf(ymd) + '|' + site;
      var cell = cells[key] || (cells[key] = { weight: 0, hours: 0, sales: 0, byWork: {} });
      addAgg(cell, w, h, s);
      addAgg(cell.byWork[workNo] || (cell.byWork[workNo] = emptyAgg()), w, h, s);
    });
    return cells;
  }

  /* 工場×月度1セル分の費用モデル。actualはaggregateのセル(無ければ0扱い)。
     費用の基準は実績売上・実績人工・実績トン単価(実額が入力された項目は実額)。 */
  function cellModel(site, periodKey, frac, actual, settings) {
    var rates = settings.rates || {};
    var cost = (settings.costs || {})[site] || {};
    var W = actual ? actual.weight : 0;
    var N = actual ? actual.hours / HOURS_PER_NINKU : 0;
    var S = actual ? actual.sales : 0;
    var basePrice = W > 0 ? S / W : 0;

    var laborRate = num(cost.laborRate) !== null ? num(cost.laborRate) : (N > 0 ? (rates.labor / 100) * S / N : 0);
    var fixed = num(cost.fixedMonthly) !== null ? num(cost.fixedMonthly) * frac : (rates.fixed / 100) * S;
    var varPerTon = num(cost.variablePerTon) !== null ? num(cost.variablePerTon) : (rates.variable / 100) * basePrice;

    var labor = N * laborRate;
    var variable = W * varPerTon;
    return {
      site: site, period: periodKey, frac: frac,
      weight: W, hours: N * HOURS_PER_NINKU, ninku: N, sales: S,
      laborRate: laborRate, fixed: fixed, varPerTon: varPerTon,
      labor: labor, variable: variable, profit: S - labor - variable - fixed,
      byWork: actual ? actual.byWork : {},
      estimated: {
        labor: num(cost.laborRate) === null, fixed: num(cost.fixedMonthly) === null,
        variable: num(cost.variablePerTon) === null,
      },
    };
  }

  /* 複数セルの合算と、合算後の指標(人工/t・トン単価・損益分岐点など)。 */
  function summarize(models, settings) {
    var s = { weight: 0, hours: 0, ninku: 0, sales: 0, labor: 0, variable: 0, fixed: 0, profit: 0, estimated: false };
    models.forEach(function (m) {
      s.weight += m.weight; s.hours += m.hours; s.ninku += m.ninku; s.sales += m.sales;
      s.labor += m.labor; s.variable += m.variable; s.fixed += m.fixed; s.profit += m.profit;
      if (m.estimated.labor || m.estimated.fixed || m.estimated.variable) s.estimated = true;
    });
    var rates = settings.rates || {};
    var p = (rates.profit || 0) / 100;
    s.ninkuPerTon = s.weight > 0 ? s.ninku / s.weight : null;
    s.unitPrice = s.weight > 0 ? s.sales / s.weight : null;
    // 1t当たりの変動費・人件費。実績が無い範囲では基準値(セルの平均)を使う。
    var baseVarPerTon = avg(models, 'varPerTon');
    s.varPerTon = s.weight > 0 ? s.variable / s.weight : baseVarPerTon;
    s.laborPerTon = s.weight > 0 ? s.labor / s.weight : null;
    s.laborRate = s.ninku > 0 ? s.labor / s.ninku : avg(models, 'laborRate');
    s.profitRate = s.sales > 0 ? s.profit / s.sales : null;
    s.profitGoal = s.sales * p;
    var be = breakEven({ fixed: s.fixed, unitPrice: s.unitPrice, varPerTon: s.varPerTon, laborPerTon: s.laborPerTon, profitRate: p });
    s.breakEvenTons = be.breakEvenTons;
    s.goalTons = be.goalTons;
    s.goalSales = be.goalSales;
    return s;
  }

  function avg(models, key) {
    if (!models.length) return 0;
    var sum = 0;
    models.forEach(function (m) { sum += m[key]; });
    return sum / models.length;
  }

  /* 損益分岐点トン数と、利益目標(売上×利益率)を達成するトン数・売上額。
     1t当たりの限界利益が0以下なら到達不能としてnullを返す。 */
  function breakEven(o) {
    var price = o.unitPrice || 0;
    var perTonCost = (o.varPerTon || 0) + (o.laborPerTon || 0);
    var margin = price - perTonCost;
    var goalMargin = price * (1 - (o.profitRate || 0)) - perTonCost;
    var r = { margin: margin, breakEvenTons: null, goalTons: null, goalSales: null };
    if (margin > 0) r.breakEvenTons = o.fixed / margin;
    if (goalMargin > 0) { r.goalTons = o.fixed / goalMargin; r.goalSales = r.goalTons * price; }
    return r;
  }

  /* 範囲・工場を指定した分析。月度×工場のセルを作り(実績が無い月でも固定費を
     反映するため、範囲内の全月度×全工場分を作る)、合計・月度別・工場別を返す。 */
  /* workNoを指定すると、その工事だけに絞った分析になる。人件費単価・変動費単価は工場×月度の値を
     そのまま使い、固定費は工場×月度の固定費を売上比で工事へ配賦する(workBreakdownと同じ考え方)。
  */
  function analyze(data, settings, from, to, sites, workNo) {
    sites = sites || data.sites || DEFAULT_SITES;
    var cells = aggregate(data, settings, from, to, sites);
    var models = [];
    periodsInRange(from, to).forEach(function (p) {
      sites.forEach(function (site) {
        var m = cellModel(site, p.key, p.frac, cells[p.key + '|' + site], settings);
        models.push(workNo ? scopeToWork(m, workNo) : m);
      });
    });
    var byPeriod = {}, bySite = {};
    models.forEach(function (m) {
      (byPeriod[m.period] = byPeriod[m.period] || []).push(m);
      (bySite[m.site] = bySite[m.site] || []).push(m);
    });
    var outPeriod = Object.keys(byPeriod).sort().map(function (k) {
      var s = summarize(byPeriod[k], settings); s.period = k; return s;
    });
    var outSite = sites.map(function (site) {
      var s = summarize(bySite[site] || [], settings); s.site = site; return s;
    });
    return { models: models, total: summarize(models, settings), byPeriod: outPeriod, bySite: outSite };
  }

  function scopeToWork(m, workNo) {
    var a = m.byWork[workNo] || emptyAgg();
    var share = m.sales > 0 ? a.sales / m.sales : 0;
    var N = a.hours / HOURS_PER_NINKU;
    var labor = N * m.laborRate, variable = a.weight * m.varPerTon, fixed = m.fixed * share;
    var byWork = {}; byWork[workNo] = a;
    return {
      site: m.site, period: m.period, frac: m.frac,
      weight: a.weight, hours: a.hours, ninku: N, sales: a.sales,
      laborRate: m.laborRate, fixed: fixed, varPerTon: m.varPerTon,
      labor: labor, variable: variable, profit: a.sales - labor - variable - fixed,
      byWork: byWork, estimated: m.estimated,
    };
  }

  /* 工事別の内訳。共通工数はセル内の重量比で各工事へ按分した値も併せて返す。
     固定費はセル内の売上比で各工事へ配賦する(売上が無いセルの固定費は共通に残す)。 */
  function workBreakdown(analysis, data) {
    var rows = {};
    function row(wn) {
      return rows[wn] || (rows[wn] = { workNo: wn, name: wn === COMMON_WORK ? '共通(工事なし)' : (((data.works || {})[wn] || {}).name || ''),
        weight: 0, hours: 0, allocHours: 0, sales: 0, labor: 0, variable: 0, fixed: 0 });
    }
    analysis.models.forEach(function (m) {
      var common = m.byWork[COMMON_WORK];
      var commonHours = common ? common.hours : 0;
      var fixedLeft = m.fixed;
      Object.keys(m.byWork).forEach(function (wn) {
        var a = m.byWork[wn];
        var r = row(wn);
        r.weight += a.weight; r.hours += a.hours; r.sales += a.sales;
        r.labor += a.hours / HOURS_PER_NINKU * m.laborRate;
        r.variable += a.weight * m.varPerTon;
        if (wn === COMMON_WORK) return;
        var share = m.weight > 0 ? a.weight / m.weight : 0;
        r.allocHours += a.hours + commonHours * share;
        if (m.sales > 0) { var f = m.fixed * a.sales / m.sales; r.fixed += f; fixedLeft -= f; }
      });
      var c = row(COMMON_WORK);
      if (m.weight <= 0) c.allocHours += commonHours; // 重量の無いセルの共通工数は按分先が無い
      c.fixed += fixedLeft;
    });
    return Object.keys(rows).map(function (wn) {
      var r = rows[wn];
      r.ninku = r.hours / HOURS_PER_NINKU;
      r.allocNinku = r.allocHours / HOURS_PER_NINKU;
      r.ninkuPerTon = r.weight > 0 ? r.ninku / r.weight : null;
      r.allocNinkuPerTon = r.weight > 0 ? r.allocNinku / r.weight : null;
      r.unitPrice = r.weight > 0 ? r.sales / r.weight : null;
      r.marginal = r.sales - r.labor - r.variable;
      r.profit = r.marginal - r.fixed;
      return r;
    }).filter(function (r) { return r.weight > 0 || r.hours > 0 || r.fixed > 0; })
      .sort(function (a, b) {
        if (a.workNo === COMMON_WORK) return 1;
        if (b.workNo === COMMON_WORK) return -1;
        return a.workNo < b.workNo ? -1 : a.workNo > b.workNo ? 1 : 0;
      });
  }

  /* シミュレーション。base は analyze().total(選択した期間・工場・工事の実績)。
     重量W・人工/t n・トン単価Pを変えたときの損益。人件費単価・固定費・変動費単価は
     基準値に固定する(売値を変えても材料費は変わらない前提)。 */
  function simulate(base, settings, W, n, P) {
    var p = ((settings.rates || {}).profit || 0) / 100;
    var laborRate = base.laborRate || 0;
    var varPerTon = base.varPerTon || 0;
    var sales = W * P, ninku = W * n;
    var labor = ninku * laborRate, variable = W * varPerTon, fixed = base.fixed;
    var profit = sales - labor - variable - fixed;
    // 試算では人件費を固定費に含める(試算の生産重量での人件費の額を固定とみなす)。
    // 損益分岐・目標トン数 = (その他固定費 + 人件費) ÷ (トン単価(×(1−利益率)) − 変動費単価)
    var be = breakEven({ fixed: fixed + labor, unitPrice: P, varPerTon: varPerTon, laborPerTon: 0, profitRate: p });
    return {
      weight: W, ninkuPerTon: n, unitPrice: P, sales: sales, ninku: ninku, hours: ninku * HOURS_PER_NINKU,
      labor: labor, variable: variable, fixed: fixed, profit: profit,
      profitRate: sales > 0 ? profit / sales : null, profitGoal: sales * p,
      breakEvenTons: be.breakEvenTons, goalTons: be.goalTons, goalSales: be.goalSales,
      laborRate: laborRate, varPerTon: varPerTon,
    };
  }

  /* 実績データ(rec)の最終日。固定費は期間の終わりではなく、この日までの日数分で計算する
     (期・月度の途中で、まだ来ていない月の固定費が入って損益が悪く見えないように)。 */
  function lastDataYmd(data) {
    var last = null;
    (data.rec || []).forEach(function (r) { if (!last || r[0] > last) last = r[0]; });
    return last;
  }

  /* 現状分析: シミュレーション結果rで、目標利益率(売上×利益率)に届くには何をどれだけ変えればよいか。
     ほかの条件は同じとして1つずつ変えた場合。値が0以下なら既に達成(余裕の量)。
       生産量: 工数(人件費)は同じまま増産 → simulateの目標生産量(goalTons)
       時間  : 生産量・トン単価は同じまま、不足額 ÷ 1h当たり人件費
       変動費: 生産量・トン単価は同じまま、不足額 ÷ 生産重量
     見積もりの目安単価: 今の生産量・工数・費用のままで目標利益率/損益0になるトン単価。 */
  function advise(r, settings) {
    var p = ((settings.rates || {}).profit || 0) / 100;
    var W = r.weight || 0;
    var cost = r.labor + r.variable + r.fixed;
    var gap = r.profitGoal - r.profit; // 目標までの不足額(マイナスなら余裕)
    var perHour = (r.laborRate || 0) / HOURS_PER_NINKU;
    return {
      gap: gap,
      addTons: r.goalTons !== null ? r.goalTons - W : null,
      cutHours: perHour > 0 ? gap / perHour : null,
      cutVarPerTon: W > 0 ? gap / W : null,
      perTon: r.unitPrice - (r.varPerTon || 0), // 工数そのままで1t多く作ったときの利益増
      perHour: perHour,                         // 1h減らしたときの利益増
      perVar1000: W * 1000,                     // 変動費を1,000円/t下げたときの利益増
      goalPrice: W > 0 && p < 1 ? cost / (W * (1 - p)) : null,
      bePrice: W > 0 ? cost / W : null,
    };
  }

  /* 残り期間の必要生産量。actual=実績の日までの分析(total)、full=期間全体の分析(total、固定費が全月分)。
     残りの生産は実績と同じトン単価・変動費単価・1t当たり人件費で行う前提で、期間全体の損益が
     売上×利益率に届く生産量を返す。1t当たりの利益が0以下なら到達不能(null)。 */
  function remainingNeed(actual, full, settings) {
    var p = ((settings.rates || {}).profit || 0) / 100;
    var margin = (actual.unitPrice || 0) * (1 - p) - (actual.varPerTon || 0) - (actual.laborPerTon || 0);
    var extraFixed = full.fixed - actual.fixed;
    var need = p * actual.sales - actual.profit + extraFixed;
    return { extraFixed: extraFixed, tons: margin > 0 ? need / margin : null };
  }

  /* 会社カレンダー(settings.calendar: {'YYYY-MM-DD': 1=出勤 / 0=休日})で出勤日を数える。
     カレンダーに無い日は日曜だけ休日とみなす。 */
  function isWorkDay(calendar, ymd) {
    var v = (calendar || {})[ymd];
    if (v === 1 || v === 0) return v === 1;
    return new Date(ymdToUtc(ymd)).getUTCDay() !== 0;
  }
  function workDaysIn(calendar, from, to) {
    var n = 0;
    for (var t = ymdToUtc(from), e = ymdToUtc(to); t <= e; t += 86400000) if (isWorkDay(calendar, utcToYmd(t))) n++;
    return n;
  }

  /* 月度の途中の見込み: 範囲[from,to]の実績(重量・工数)を factor 倍したデータを返す(元のdataは変えない)。
     期間全体(月度の最後まで)で analyze すると、固定費は1か月分・売上/変動費/人件費は見込みの量になる。 */
  function scaleRange(data, from, to, factor) {
    var out = {};
    Object.keys(data).forEach(function (k) { out[k] = data[k]; });
    out.rec = (data.rec || []).map(function (r) {
      return r[0] < from || r[0] > to ? r : [r[0], r[1], r[2], (r[3] || 0) * factor, (r[4] || 0) * factor];
    });
    return out;
  }

  var api = {
    HOURS_PER_NINKU: HOURS_PER_NINKU, COMMON_WORK: COMMON_WORK, DEFAULT_SITES: DEFAULT_SITES,
    defaultSettings: defaultSettings,
    periodKeyOf: periodKeyOf, periodRange: periodRange, periodLabel: periodLabel, shiftPeriod: shiftPeriod,
    fiscalYearOf: fiscalYearOf, fiscalRange: fiscalRange, fiscalLabel: fiscalLabel,
    periodsInRange: periodsInRange, daysInclusive: daysInclusive, utcToYmd: utcToYmd,
    unitPriceOf: unitPriceOf, commonWorkSet: commonWorkSet, aggregate: aggregate, cellModel: cellModel, summarize: summarize,
    breakEven: breakEven, analyze: analyze, workBreakdown: workBreakdown, simulate: simulate,
    lastDataYmd: lastDataYmd, advise: advise, remainingNeed: remainingNeed,
    isWorkDay: isWorkDay, workDaysIn: workDaysIn, scaleRange: scaleRange,
  };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else root.PPCalc = api;
})(this);
