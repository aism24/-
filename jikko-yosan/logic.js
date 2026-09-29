/* 実行予算まとめ - 変更判定・表示用の整形・Excel書き出し(ブラウザ/Node共通) */
(function (root) {
  'use strict';

  const CATS = ['材料費', '工場加工費', '事務図面費', '外注加工費', 'メッキ費', '運送費', '塗装費', '現場費', 'その他', '計'];

  // 黄色判定の対象(表示・Excelの列順と同じ)
  const FIELDS = [
    { id: 'weight', label: '契約総重量(t)', kind: 't', get: r => r.weight },
    { id: 'amount', label: '契約金額(円)', kind: 'yen', get: r => r.amount },
    { id: 'sheet', label: '参照シート', kind: 'str', get: r => r.sheet },
  ];
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

  function fmt(kind, v) {
    if (kind === 'str') return v === null || v === undefined ? '' : String(v);
    if (kind === 'date') {
      const d = v ? jst(v) : null;
      return d ? d.getUTCFullYear() + '/' + pad(d.getUTCMonth() + 1) + '/' + pad(d.getUTCDate()) + ' ' +
        pad(d.getUTCHours()) + ':' + pad(d.getUTCMinutes()) : '';
    }
    const n = num(v);
    if (n === null) return '';
    if (kind === 't') return n.toLocaleString('ja-JP', { minimumFractionDigits: 3, maximumFractionDigits: 3 });
    if (kind === 'pct') return Math.round(n * 100) + '%';
    return Math.round(n).toLocaleString('ja-JP');
  }

  function cmpNo(a, b) {
    return String(a || '').localeCompare(String(b || ''), 'ja', { numeric: true });
  }

  // GASの {baseline, today} から画面・Excel用の行を作る
  function buildView(payload) {
    const today = payload && payload.today;
    const baseline = payload && payload.baseline;
    if (!today || !today.rows) return { rows: [], todayAt: null, baselineAt: null };
    const baseRows = baseline && baseline.rows ? baseline.rows : null;

    const rows = Object.keys(today.rows).map(key => {
      const r = today.rows[key];
      const base = baseRows ? baseRows[key] : undefined;
      const isNew = !!baseRows && !base && !r.missing;
      const compare = !!base && !r.missing && r.status !== 'error';
      let changed = 0;
      const cells = FIELDS.map(f => {
        const v = f.get(r);
        const cell = { id: f.id, kind: f.kind, v: v, text: fmt(f.kind, v), changed: false, prev: null };
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
      if (r.locked && !r.missing) status += '（編集中）';
      return {
        key: key, no: r.no || r.fileNo || '', name: r.name || r.c2 || key,
        rowClass: r.missing ? 'missing' : isNew ? 'new' : '',
        status: status, warn: r.warn || '', changed: changed, cells: cells, src: r,
      };
    });
    rows.sort((a, b) => cmpNo(a.no, b.no) || cmpNo(a.key, b.key));
    return { rows: rows, todayAt: today.at || null, baselineAt: baseline ? baseline.at : null };
  }

  /* ===================== Excel書き出し(ExcelJS) ===================== */

  const FILL = { changed: 'FFFFFF00', new: 'FFCCFFFF', missing: 'FFD9D9D9' };

  function colName(n) {
    let s = '';
    while (n > 0) { const m = (n - 1) % 26; s = String.fromCharCode(65 + m) + s; n = Math.floor((n - 1) / 26); }
    return s;
  }

  function buildWorkbook(ExcelJS, view) {
    const wb = new ExcelJS.Workbook();
    const ws = wb.addWorksheet('Sheet1', { views: [{ state: 'frozen', xSplit: 5, ySplit: 1 }] });
    const head = ['工事No', '工事名'].concat(FIELDS.map(f => f.label), ['状態']);
    ws.addRow(head);
    ws.getRow(1).font = { bold: true };
    ws.getRow(1).alignment = { vertical: 'middle', horizontal: 'center', wrapText: true };
    ws.getColumn(1).width = 9;
    ws.getColumn(2).width = 26;
    FIELDS.forEach((f, i) => {
      ws.getColumn(i + 3).width = f.kind === 'pct' ? 8 : f.kind === 'date' ? 17 : f.id === 'sheet' ? 10 : f.kind === 'str' ? 14 : 13;
    });
    ws.getColumn(head.length).width = 16;

    view.rows.forEach((vr, idx) => {
      const rn = idx + 2;
      const row = ws.getRow(rn);
      row.getCell(1).value = vr.no;
      row.getCell(2).value = vr.name;
      vr.cells.forEach((c, i) => {
        const cell = row.getCell(i + 3);
        const n = num(c.v);
        if (c.kind === 'pct') {
          const bCol = colName(i + 1), aCol = colName(i + 2);
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
        if (c.changed) {
          cell.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: FILL.changed } };
          cell.note = '前回：' + c.prev;
        }
      });
      row.getCell(head.length).value = vr.status;
      if (vr.rowClass) {
        for (let col = 1; col <= head.length; col++) {
          const cell = row.getCell(col);
          if (!cell.fill || !cell.fill.fgColor || cell.fill.fgColor.argb !== FILL.changed) {
            cell.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: FILL[vr.rowClass] } };
          }
        }
      }
    });
    return wb;
  }

  const api = { CATS, FIELDS, buildView, buildWorkbook, fmt, colName };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else root.JY = api;
})(typeof window !== 'undefined' ? window : this);
