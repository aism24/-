/* 実行予算まとめ - 変更判定・表示用の整形・Excel書き出し(ブラウザ/Node共通) */
(function (root) {
  'use strict';

  // 利益項目: key = PC側データ(profit)の名前、label = 画面・Excelの表示名
  const PROFITS = [{ key: '粗利益', label: '粗利益' }, { key: '営業利益', label: '営業損益' }];
  const CATS = ['材料費', '工場加工費', '事務図面費', '外注加工費', 'メッキ費', '運送費', '塗装費', '現場費', 'その他', '計'];

  // 黄色判定の対象(表示・Excelの列順と同じ)
  const FIELDS = [
    { id: 'weight', label: '契約総重量(t)', kind: 't', get: r => r.weight },
    { id: 'amount', label: '契約金額(円)', kind: 'yen', get: r => r.amount },
    { id: 'sheet', label: '参照シート', kind: 'str', get: r => r.sheet },
  ];
  // 粗利益・営業損益: 額はシートのF列(予算)/L列(実際)。割合は出さない
  PROFITS.forEach(({ key: p, label: l }) => {
    FIELDS.push({ id: p + ':b', profit: p, label: l + ' 予算', kind: 'yen', get: r => prof(r, p)[0] });
    FIELDS.push({ id: p + ':a', profit: p, label: l + ' 実際', kind: 'yen', get: r => prof(r, p)[1] });
  });
  CATS.forEach(c => {
    FIELDS.push({ id: c + ':b', cat: c, label: c + ' 予算', kind: 'yen', get: r => pair(r, c)[0] });
    FIELDS.push({ id: c + ':a', cat: c, label: c + ' 実際', kind: 'yen', get: r => pair(r, c)[1] });
    FIELDS.push({ id: c + ':r', cat: c, label: c + ' 割合', kind: 'pct', get: r => ratio(pair(r, c)) });
  });
  FIELDS.push({ id: 'author', label: '前回の保存者', kind: 'str', get: r => r.author });
  FIELDS.push({ id: 'saved', label: '保存日時', kind: 'date', get: r => r.saved });

  function pair(r, c) {
    const p = r && r.cats && r.cats[c];
    return Array.isArray(p) ? p : [null, null];
  }
  function prof(r, p) {
    const v = r && r.profit && r.profit[p];
    return Array.isArray(v) ? v : [null, null];
  }
  function num(v) { return v === null || v === undefined || v === '' || !isFinite(Number(v)) ? null : Number(v); }
  function ratio(p) {
    const b = num(p[0]), a = num(p[1]);
    return b ? (a || 0) / b : null;
  }

  function norm(kind, v) {
    if (kind === 'str') return v === null || v === undefined ? '' : String(v).trim();
    if (kind === 'date') return v ? String(Math.floor(new Date(v).getTime() / 60000)) : '';
    const n = num(v);
    if (n === null) return '';
    if (kind === 't') return n.toFixed(3);
    if (kind === 'pct') return n.toFixed(6);
    return String(Math.round(n));
  }

  function jst(v) {
    const t = new Date(v).getTime();
    return isFinite(t) ? new Date(t + 9 * 3600000) : null;
  }
  function pad(n) { return String(n).padStart(2, '0'); }

  const NF0 = new Intl.NumberFormat('ja-JP', { maximumFractionDigits: 0 });
  const NF3 = new Intl.NumberFormat('ja-JP', { minimumFractionDigits: 3, maximumFractionDigits: 3 });

  function fmt(kind, v) {
    if (kind === 'str') return v === null || v === undefined ? '' : String(v);
    if (kind === 'date') {
      const d = v ? jst(v) : null;
      return d ? d.getUTCFullYear() + '/' + pad(d.getUTCMonth() + 1) + '/' + pad(d.getUTCDate()) + ' ' +
        pad(d.getUTCHours()) + ':' + pad(d.getUTCMinutes()) : '';
    }
    const n = num(v);
    if (n === null) return '';
    if (kind === 't') return NF3.format(n);
    if (kind === 'pct') return Math.round(n * 100) + '%';
    return NF0.format(Math.round(n));
  }

  /* ===================== 完了・年度 ===================== */

  const UNSET = '未設定';

  // 年度の表記を「R8」に揃える(r8・R８・令和8・令和８年度 など)。読めない値はそのまま
  function normYear(v) {
    const s = String(v === null || v === undefined ? '' : v).trim()
      .replace(/[０-９]/g, c => String.fromCharCode(c.charCodeAt(0) - 0xFEE0));
    if (!s) return '';
    const m = s.match(/^(?:[rR]|令和)\s*(\d{1,3})\s*(?:年度?)?$/);
    return m ? 'R' + Number(m[1]) : s;
  }
  function normDone(v) { return v === true || String(v === null || v === undefined ? '' : v).trim() === '完了'; }

  // 会社の年度: 11/21始まり・11/20決算。決算の年で呼ぶ(2025/11/21〜2026/11/20 = R8)
  function fiscalYearOf(t) {
    const d = jst(t);
    const y = d.getUTCFullYear(), m = d.getUTCMonth() + 1, day = d.getUTCDate();
    return 'R' + ((m > 11 || (m === 11 && day >= 21) ? y + 1 : y) - 2018);
  }
  function yearNum(y) { const m = /^R(\d+)$/.exec(y); return m ? Number(m[1]) : Infinity; }
  function sortYears(list) { return list.slice().sort((a, b) => yearNum(a) - yearNum(b) || a.localeCompare(b, 'ja')); }

  // GASの settings.rows([[工事No, 完了, 年度], …])→ { 工事No: {done, year} }。同じ工事Noは上の行
  function buildSettings(list) {
    const map = {};
    (Array.isArray(list) ? list : []).forEach(v => {
      const no = String(v && v[0] || '').trim();
      if (no && !map[no]) map[no] = { done: normDone(v[1]), year: normYear(v[2]) };
    });
    return map;
  }

  // 設定画面の年度の選択肢: シートにある年度 + 今年度 + 来年度(未設定は画面側で最後に付ける)
  function yearOptions(settings, now) {
    const set = {};
    Object.keys(settings || {}).forEach(no => { if (settings[no].year) set[settings[no].year] = true; });
    const cur = fiscalYearOf(now === undefined ? Date.now() : now);
    set[cur] = true;
    set['R' + (yearNum(cur) + 1)] = true;
    return sortYears(Object.keys(set));
  }

  function cmpNo(a, b) {
    return String(a || '').localeCompare(String(b || ''), 'ja', { numeric: true });
  }

  // GASの {baseline, today} と完了・年度の設定から画面・Excel用の行を作る
  function buildView(payload, settings) {
    const today = payload && payload.today;
    const baseline = payload && payload.baseline;
    if (!today || !today.rows) return { rows: [], todayAt: null, baselineAt: null };
    const baseRows = baseline && baseline.rows ? baseline.rows : null;
    settings = settings || {};
    const noCount = {};
    Object.keys(today.rows).forEach(key => {
      const no = String(today.rows[key].no || today.rows[key].fileNo || '').trim();
      if (no) noCount[no] = (noCount[no] || 0) + 1;
    });

    const rows = Object.keys(today.rows).map(key => {
      const r = today.rows[key];
      const base = baseRows ? baseRows[key] : undefined;
      const isNew = !!baseRows && !base && !r.missing;
      const compare = !!base && !r.missing && r.status !== 'error';
      let changed = 0;
      const cells = FIELDS.map(f => {
        const v = f.get(r);
        const cell = { id: f.id, kind: f.kind, v: v, text: fmt(f.kind, v), changed: false, prev: null, over: false };
        // 赤字: 費目は予算超過(実際 > 予算)で「実際」「割合」、利益は予算未達(実際 < 予算)で「実際」
        if (f.cat && !f.id.endsWith(':b')) {
          const p = pair(r, f.cat), b = num(p[0]), a = num(p[1]);
          cell.over = b !== null && a !== null && a > b;
        } else if (f.profit && f.id.endsWith(':a')) {
          const p = prof(r, f.profit), b = num(p[0]), a = num(p[1]);
          cell.over = b !== null && a !== null && a < b;
        }
        // 未完成: 契約総重量・契約金額が0(空欄も)。元ファイルなし・読み取りエラーは対象外
        if ((f.id === 'weight' || f.id === 'amount') && !r.missing && r.status !== 'error' && !num(v)) cell.zero = true;
        if (compare) {
          const pv = f.get(base);
          if (norm(f.kind, v) !== norm(f.kind, pv)) {
            cell.changed = true;
            cell.prev = fmt(f.kind, pv) || '(空欄)';
            changed++;
          }
        }
        return cell;
      });
      let status;
      if (r.missing) status = '元ファイルなし';
      else if (r.status === 'error') status = '読み取りエラー';
      else if (r.matchedBy === '一覧に未登録') status = '一覧に未登録';
      else if (isNew) status = '新規';
      else if (changed) status = '変更あり';
      else status = '変更なし';
      const no = r.no || r.fileNo || '';
      const incomplete = cells.some(c => c.zero);
      const tags = [];
      if (incomplete) tags.push('未完成');
      if (r.locked && !r.missing) tags.push('編集中');
      if (noCount[String(no).trim()] > 1) tags.push('同じ工事Noあり');
      if (tags.length) status += '（' + tags.join('・') + '）';
      const st = settings[String(no).trim()] || { done: false, year: '' };
      return {
        key: key, no: no, name: r.name || r.c2 || key,
        rowClass: r.missing ? 'missing' : isNew ? 'new' : '',
        status: status, warn: r.warn || '', changed: changed, cells: cells,
        incomplete: incomplete, unlisted: r.matchedBy === '一覧に未登録',
        done: st.done, year: st.year, saved: r.saved || '',
      };
    });
    rows.sort((a, b) => cmpNo(a.no, b.no) || cmpNo(a.key, b.key));
    return { rows: rows, todayAt: today.at || null, baselineAt: baseline ? baseline.at : null };
  }

  /* ===================== 絞り込み・合計 ===================== */

  // filter: { done: true/false, years: ['R8', '未設定', …] }。どちらも無ければ全て表示
  function isFiltered(filter) { return !!(filter && (filter.done || (filter.years && filter.years.length))); }
  function filterRows(rows, filter) {
    if (!isFiltered(filter)) return rows;
    const years = filter.years || [];
    return rows.filter(r => (!filter.done || r.done) && (!years.length || years.indexOf(r.year || UNSET) >= 0));
  }
  function filterLabel(filter) {
    if (!isFiltered(filter)) return '全て';
    const parts = [];
    if (filter.done) parts.push('完了');
    if (filter.years && filter.years.length) parts.push(sortYears(filter.years.filter(y => y !== UNSET)).concat(filter.years.indexOf(UNSET) >= 0 ? [UNSET] : []).join('・'));
    return parts.join('_');
  }
  // 抽出画面の年度ボタン: データにある年度 + 未設定
  function yearsInRows(rows) {
    const set = {};
    rows.forEach(r => { if (r.year) set[r.year] = true; });
    return sortYears(Object.keys(set)).concat([UNSET]);
  }

  // 合計行(表示中の行すべて)。割合は 合計の実際 ÷ 合計の予算
  function computeTotals(rows) {
    const sums = FIELDS.map(() => null);
    rows.forEach(r => r.cells.forEach((c, i) => {
      if (c.kind !== 'yen' && c.kind !== 't') return;
      const n = num(c.v);
      if (n !== null) sums[i] = (sums[i] || 0) + n;
    }));
    const byId = {};
    FIELDS.forEach((f, i) => { byId[f.id] = sums[i]; });
    const cells = FIELDS.map((f, i) => {
      let v = sums[i];
      if (f.kind === 'pct') v = ratio([byId[f.cat + ':b'], byId[f.cat + ':a']]);
      else if (f.kind === 'str' || f.kind === 'date') v = null;
      const cell = { id: f.id, kind: f.kind, v: v, text: fmt(f.kind, v), over: false };
      const b = f.cat ? byId[f.cat + ':b'] : f.profit ? byId[f.profit + ':b'] : null;
      const a = f.cat ? byId[f.cat + ':a'] : f.profit ? byId[f.profit + ':a'] : null;
      if (f.cat && !f.id.endsWith(':b')) cell.over = b !== null && a !== null && a > b;
      else if (f.profit && f.id.endsWith(':a')) cell.over = b !== null && a !== null && a < b;
      return cell;
    });
    return { count: rows.length, cells: cells };
  }

  // 設定画面の行: 工事Noごとに1行(同じ工事Noが複数なら保存日時の新しい方の値)
  function settingRows(rows) {
    const byNo = {};
    rows.forEach(r => {
      const no = String(r.no || '').trim();
      if (!no) return;
      const prev = byNo[no];
      if (prev && String(prev.saved) >= String(r.saved)) { prev.unlisted = prev.unlisted && r.unlisted; return; }
      byNo[no] = { no: no, name: r.name, done: r.done, year: r.year, saved: r.saved,
        unlisted: prev ? prev.unlisted && r.unlisted : r.unlisted,
        cells: r.cells.filter(c => c.id === 'weight' || c.id === 'amount' || c.id === '粗利益:a' || c.id === '営業利益:a') };
    });
    return Object.keys(byNo).sort(cmpNo).map(no => byNo[no]);
  }

  /* ===================== Excel書き出し(ExcelJS) ===================== */

  const FILL = { changed: 'FFFFFF00', new: 'FFCCFFFF', missing: 'FFD9D9D9' };
  const OVER_FONT = 'FFFF0000';

  function colName(n) {
    let s = '';
    while (n > 0) { const m = (n - 1) % 26; s = String.fromCharCode(65 + m) + s; n = Math.floor((n - 1) / 26); }
    return s;
  }

  // Excelのシート名: 使えない文字を除いて31文字まで
  function sheetName(label) {
    return String(label || '').replace(/[\\/?*[\]:]/g, '・').slice(0, 31);
  }
  // 絞り込み中は「まとめ_完了_R8・R9」のように条件を付ける
  function sheetTitle(base, filter) {
    return isFiltered(filter) ? sheetName(base + '_' + filterLabel(filter)) : base;
  }

  // opts: { filter } 絞り込み中なら 2行目に合計行(SUBTOTAL)を入れ、シート名に条件を入れる
  function buildWorkbook(ExcelJS, view, opts) {
    const filter = opts && opts.filter;
    const filtered = isFiltered(filter);
    const rows = filterRows(view.rows, filter);
    const wb = new ExcelJS.Workbook();
    // 列: A 状態 / B 年度 / C 完了 / D 工事No / E 工事名 / F〜 FIELDS(参照シートまでの A〜H列と見出し・合計行を固定)
    const FIRST = 6; // FIELDS の先頭列
    const top = filtered ? 3 : 2; // 最初の工事の行
    const ws = wb.addWorksheet(sheetTitle('まとめ', filter), { views: [{ state: 'frozen', xSplit: 8, ySplit: top - 1 }] });
    const head = ['状態', '年度', '完了', '工事No', '工事名'].concat(FIELDS.map(f => f.label));
    ws.addRow(head);
    ws.getRow(1).font = { bold: true };
    ws.getRow(1).alignment = { vertical: 'middle', horizontal: 'center', wrapText: true };
    ws.getColumn(1).width = 12;
    ws.getColumn(2).width = 7;
    ws.getColumn(3).width = 6;
    ws.getColumn(4).width = 9;
    ws.getColumn(5).width = 26;
    FIELDS.forEach((f, i) => {
      ws.getColumn(i + FIRST).width = f.kind === 'pct' ? 8 : f.kind === 'date' ? 17 : f.id === 'sheet' ? 10 : f.kind === 'str' ? 14 : 13;
    });

    if (filtered) {
      const tot = computeTotals(rows);
      const row = ws.getRow(2);
      const last = top + rows.length - 1;
      row.getCell(1).value = '合計（' + tot.count + '件）';
      row.getCell(1).alignment = { horizontal: 'center' };
      tot.cells.forEach((c, i) => {
        const col = colName(i + FIRST), cell = row.getCell(i + FIRST);
        if (c.kind === 'pct') {
          const bCol = colName(i + FIRST - 2), aCol = colName(i + FIRST - 1);
          cell.value = { formula: 'IF(' + bCol + '2=0,"",' + aCol + '2/' + bCol + '2)', result: c.v === null ? '' : c.v };
          cell.numFmt = '0%';
        } else if (c.kind === 'yen' || c.kind === 't') {
          const res = c.v === null ? 0 : c.kind === 't' ? Math.round(c.v * 1000) / 1000 : c.v;
          cell.value = rows.length ? { formula: 'SUBTOTAL(109,' + col + top + ':' + col + last + ')', result: res } : 0;
          cell.numFmt = c.kind === 't' ? '#,##0.000' : '#,##0';
        }
        if (c.over) cell.font = { bold: true, color: { argb: OVER_FONT } };
      });
      for (let col = 1; col <= head.length; col++) {
        const cell = row.getCell(col);
        if (!cell.font) cell.font = { bold: true };
        cell.border = { bottom: { style: 'double' } };
      }
    }

    rows.forEach((vr, idx) => {
      const rn = idx + top;
      const row = ws.getRow(rn);
      row.getCell(1).value = statusValue(vr.status);
      row.getCell(1).alignment = { horizontal: 'center' };
      if (vr.status.startsWith('変更あり')) row.getCell(1).fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: FILL.changed } };
      row.getCell(2).value = vr.year || UNSET;
      row.getCell(2).alignment = { horizontal: 'center' };
      row.getCell(3).value = vr.done ? '完了' : '未完';
      row.getCell(3).alignment = { horizontal: 'center' };
      row.getCell(4).value = vr.no;
      row.getCell(4).alignment = { horizontal: 'center' };
      row.getCell(5).value = vr.name;
      vr.cells.forEach((c, i) => {
        const cell = row.getCell(i + FIRST);
        const n = num(c.v);
        if (c.kind === 'pct') {
          const bCol = colName(i + FIRST - 2), aCol = colName(i + FIRST - 1); // 同じ費目の予算・実際
          cell.value = { formula: 'IF(' + bCol + rn + '=0,"",' + aCol + rn + '/' + bCol + rn + ')', result: n === null ? '' : n };
          cell.numFmt = '0%';
        } else if (c.kind === 'yen') {
          cell.value = n; cell.numFmt = '#,##0';
        } else if (c.kind === 't') {
          cell.value = n === null ? null : Math.round(n * 1000) / 1000; cell.numFmt = '#,##0.000';
        } else if (c.kind === 'date') {
          cell.value = c.v ? jst(c.v) : null; cell.numFmt = 'yyyy/mm/dd hh:mm';
        } else {
          cell.value = c.v === undefined ? null : c.v;
        }
        if (c.id === 'sheet' || c.id === 'author') cell.alignment = { horizontal: 'center' };
        if (c.over || c.zero) cell.font = { color: { argb: OVER_FONT } };
        if (c.zero) cell.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: FILL.changed } };
        if (c.changed) {
          cell.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: FILL.changed } };
          cell.note = '前回：' + c.prev;
        }
      });
      if (vr.rowClass) {
        for (let col = 1; col <= head.length; col++) {
          const cell = row.getCell(col);
          if (!cell.fill || !cell.fill.fgColor || cell.fill.fgColor.argb !== FILL.changed) {
            cell.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: FILL[vr.rowClass] } };
          }
        }
      }
    });
    addTrialSheet(wb, rows, filter);
    return wb;
  }

  // 「試算」シート: 工事ごとに 売上・仕入・労務費等・粗利・営業損益(すべて実際)、一番下に合計
  //   売上=契約金額 / 労務費等=工場加工費+事務図面費 / 仕入=その他の費目(材料費・外注加工費・メッキ費・運送費・塗装費・現場費・その他)
  //   粗利・営業損益は表の「粗利益」「営業損益」の実際をそのまま使う
  const LABOR = ['工場加工費', '事務図面費'];
  const PURCHASE = CATS.filter(c => c !== '計' && LABOR.indexOf(c) < 0);
  function trialValues(vr) {
    const v = {};
    vr.cells.forEach(c => { v[c.id] = num(c.v); });
    const sum = cats => cats.reduce((acc, c) => v[c + ':a'] === null || v[c + ':a'] === undefined ? acc : (acc || 0) + v[c + ':a'], null);
    return [v.amount, sum(PURCHASE), sum(LABOR), v['粗利益:a'], v['営業利益:a']];
  }
  function addTrialSheet(wb, rows, filter) {
    const ws = wb.addWorksheet(sheetTitle('試算', filter), { views: [{ state: 'frozen', ySplit: 1 }] });
    ws.addRow(['工事No', '工事名', '売上', '仕入', '労務費等', '粗利', '営業損益']);
    ws.getRow(1).font = { bold: true };
    ws.getRow(1).alignment = { vertical: 'middle', horizontal: 'center' };
    [9, 26, 15, 15, 15, 15, 15].forEach((w, i) => { ws.getColumn(i + 1).width = w; });
    const FMT = '#,##0;[Red]-#,##0';
    const sums = [0, 0, 0, 0, 0];
    rows.forEach(vr => {
      const vals = trialValues(vr);
      const row = ws.addRow([vr.no, vr.name].concat(vals));
      row.getCell(1).alignment = { horizontal: 'center' };
      vals.forEach((n, i) => { row.getCell(i + 3).numFmt = FMT; if (n !== null) sums[i] += n; });
    });
    const last = rows.length + 1;
    const tot = ws.addRow(['合計（' + rows.length + '件）', '']);
    tot.font = { bold: true };
    tot.getCell(1).alignment = { horizontal: 'center' };
    sums.forEach((n, i) => {
      const col = colName(i + 3), cell = tot.getCell(i + 3);
      cell.value = rows.length ? { formula: 'SUM(' + col + '2:' + col + last + ')', result: n } : 0;
      cell.numFmt = FMT;
    });
    for (let col = 1; col <= 7; col++) tot.getCell(col).border = { top: { style: 'double' } };
  }

  // 状態欄の「未完成」は赤字(リッチテキスト)
  function statusValue(status) {
    const i = status.indexOf('未完成');
    if (i < 0) return status;
    return { richText: [{ text: status.slice(0, i) }, { text: '未完成', font: { color: { argb: OVER_FONT } } }, { text: status.slice(i + 3) }] };
  }

  const api = { CATS, PROFITS, UNSET, buildView, buildWorkbook, trialValues, fmt, normYear, normDone, fiscalYearOf, buildSettings, yearOptions,
    isFiltered, filterRows, filterLabel, yearsInRows, computeTotals, settingRows };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else root.JY = api;
})(typeof window !== 'undefined' ? window : this);
