// 入力データー(○○).xlsm の「SPL」シートを読む・書く。
// マクロ(vbaProject.bin)・他のシートは触らない。SheetJS で保存し直さず、sheet XML を直接書き換える
// (tdf-master-web/input-append.js と同じやり方)。
//
// 書き方: 4行目から表の行を上から順に全部書き直す(図面にだけある継手を途中に差し込むため)。
//   - 各セルの書式(s=)は、書き込む行に元からあるセルの書式を使う(4〜284行目は同じ形)
//   - C・D・I・N 列の式は、元の式の行番号だけを書き換えて全行に入れる(計算はExcelを開いたときに行う)
//   - 図番・継手名には図面(.tdf)へのハイパーリンク(青の下線)を付ける
(function (root) {
  'use strict';

  const SHEET = 'SPL';
  const DATA_SHEET = 'データ'; // 「ﾃﾞｰﾀ」(半角)を NFKC で揃えて比べる
  const FIRST_ROW = 4;
  const ALL_COLS = 'ABCDEFGHIJKLMNOPQRSTUV'.split('');
  const FORMULA_COLS = ['C', 'D', 'I', 'N'];
  const VALUE_COLS = ['A', 'B', 'E', 'F', 'G', 'H', 'J', 'K', 'L', 'M', 'O', 'P', 'Q', 'R', 'S', 'T', 'U', 'V'];
  const NS_HYPERLINK = 'http://schemas.openxmlformats.org/officeDocument/2006/relationships/hyperlink';

  const nfkc = s => String(s == null ? '' : s).normalize('NFKC');
  const unescXml = s => s.replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&apos;/g, "'").replace(/&amp;/g, '&');
  const escXml = s => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
  const colNum = c => c.split('').reduce((n, ch) => n * 26 + ch.charCodeAt(0) - 64, 0);

  async function findSheet(zip, wanted) {
    const wb = await zip.file('xl/workbook.xml').async('string');
    const rels = await zip.file('xl/_rels/workbook.xml.rels').async('string');
    let rid = null;
    for (const m of wb.matchAll(/<sheet\b[^>]*>/g)) {
      const name = (m[0].match(/\bname="([^"]*)"/) || [])[1];
      if (name != null && nfkc(unescXml(name)).trim() === wanted) rid = (m[0].match(/\br:id="([^"]*)"/) || [])[1];
    }
    if (!rid) return null;
    for (const m of rels.matchAll(/<Relationship\b[^>]*>/g)) {
      if ((m[0].match(/\bId="([^"]*)"/) || [])[1] === rid) {
        const t = (m[0].match(/\bTarget="([^"]*)"/) || [])[1];
        return 'xl/' + t.replace(/^\/?(xl\/)?/, '');
      }
    }
    return null;
  }

  async function readSharedStrings(zip) {
    const f = zip.file('xl/sharedStrings.xml');
    if (!f) return [];
    const xml = await f.async('string');
    return [...xml.matchAll(/<si\b[^>]*>([\s\S]*?)<\/si>/g)].map(m =>
      unescXml([...m[1].replace(/<rPh\b[\s\S]*?<\/rPh>/g, '').matchAll(/<t\b[^>]*>([\s\S]*?)<\/t>/g)].map(t => t[1]).join('')));
  }

  function splitRows(xml) {
    const a = xml.indexOf('<sheetData>'), b = xml.indexOf('</sheetData>');
    if (a < 0 || b < 0) throw new Error('シートの形式が想定と違います');
    const head = xml.slice(0, a + 11), tail = xml.slice(b);
    const rows = [...xml.slice(a + 11, b).matchAll(/<row\b[^>]*?r="(\d+)"[^>]*?(?:\/>|>[\s\S]*?<\/row>)/g)]
      .map(m => ({ n: Number(m[1]), xml: m[0] }));
    return { head, tail, rows };
  }

  const cellRe = /<c\b[^>]*?\br="([A-Z]+)\d+"[^>]*?(?:\/>|>[\s\S]*?<\/c>)/g;
  function cellsOf(rowXml) {
    return [...rowXml.matchAll(cellRe)].map(m => ({ col: m[1], xml: m[0] }));
  }
  function cellStyle(cell) {
    return cell ? (cell.xml.match(/^<c\b[^>]*?\bs="(\d+)"/) || [])[1] : undefined;
  }
  // セルの値(数は数、文字は文字、空は null)
  function cellValue(cell, sst) {
    if (!cell) return null;
    const x = cell.xml;
    const t = (x.match(/^<c\b[^>]*?\bt="([^"]*)"/) || [])[1];
    if (t === 'inlineStr') {
      const s = unescXml([...x.matchAll(/<t\b[^>]*>([\s\S]*?)<\/t>/g)].map(m => m[1]).join(''));
      return s === '' ? null : s;
    }
    const v = (x.match(/<v>([\s\S]*?)<\/v>/) || [])[1];
    if (v == null || v === '') return null;
    if (t === 's') { const s = sst[Number(v)]; return s == null || s === '' ? null : s; }
    if (t === 'str' || t === 'e') return unescXml(v);
    if (t === 'b') return v === '1';
    const n = Number(v);
    return Number.isFinite(n) ? n : unescXml(v);
  }

  // SPLシートを読む: { rows: [{xrow, A..V}], kojiNo, lastRow }
  async function read(JSZip, buf) {
    const zip = await JSZip.loadAsync(buf);
    const path = await findSheet(zip, SHEET);
    if (!path) throw new Error('「SPL」シートが見つかりません(入力データーのExcelではない可能性があります)');
    const sst = await readSharedStrings(zip);
    const { rows } = splitRows(await zip.file(path).async('string'));
    const out = [];
    let lastRow = FIRST_ROW - 1;
    for (const r of rows) {
      if (r.n < FIRST_ROW) continue;
      lastRow = Math.max(lastRow, r.n);
      const cs = cellsOf(r.xml), by = c => cs.find(x => x.col === c);
      const rec = { xrow: r.n };
      let any = false;
      for (const c of VALUE_COLS) {
        let v = cellValue(by(c), sst);
        if (typeof v === 'string' && v.trim() === '') v = null;
        rec[c] = v;
        if (v != null) any = true;
      }
      if (any) out.push(rec);
    }
    // 工事番号: 「ﾃﾞｰﾀ」シートの E1(年)・F1(番号) → 25-19
    let kojiNo = '';
    const dpath = await findSheet(zip, DATA_SHEET);
    if (dpath) {
      const dxml = await zip.file(dpath).async('string');
      const r1 = (dxml.match(/<row\b[^>]*?r="1"[^>]*?(?:\/>|>[\s\S]*?<\/row>)/) || [])[0];
      if (r1) {
        const cs = cellsOf(r1), by = c => cs.find(x => x.col === c);
        const e = cellValue(by('E'), sst), f = cellValue(by('F'), sst);
        const two = v => (typeof v === 'number' ? String(v) : nfkc(v).trim()).padStart(2, '0');
        if (e != null && f != null && /^\d+$/.test(two(e)) && /^\d+$/.test(two(f))) kojiNo = two(e) + '-' + two(f);
      }
    }
    return { rows: out, kojiNo, lastRow };
  }

  // 式の行番号を tmplRow → n に置き換える($の付いた行・他のシートの列全体の参照は変えない)
  function shiftFormula(f, tmplRow, n) {
    return f.replace(/(?<![A-Za-z0-9_$.!])(\$?)([A-Z]{1,3})(\$?)(\d+)(?![\d(A-Za-z_])/g, (m, d1, col, d2, row) => {
      if (d2) return m;
      return d1 + col + (Number(row) - tmplRow + n);
    });
  }

  // styles.xml: 指定の書式番号ごとに「同じ書式+青の下線」の書式を足し、元→新の対応を返す
  function addLinkStyles(stylesXml, baseIds) {
    const fontsM = stylesXml.match(/<fonts\b[^>]*>([\s\S]*?)<\/fonts>/);
    const xfsM = stylesXml.match(/<cellXfs\b[^>]*>([\s\S]*?)<\/cellXfs>/);
    if (!fontsM || !xfsM) return { xml: stylesXml, map: {} };
    const fonts = [...fontsM[1].matchAll(/<font\b[^>]*?(?:\/>|>[\s\S]*?<\/font>)/g)].map(m => m[0]);
    const xfs = [...xfsM[1].matchAll(/<xf\b[^>]*?(?:\/>|>[\s\S]*?<\/xf>)/g)].map(m => m[0]);
    const newFonts = [], newXfs = [], map = {};
    const fontMap = {};
    for (const id of baseIds) {
      const xf = xfs[Number(id)];
      if (!xf) continue;
      const fid = Number((xf.match(/\bfontId="(\d+)"/) || [, '0'])[1]);
      if (!(fid in fontMap)) {
        let f = fonts[fid] || '<font><sz val="11"/><name val="ＭＳ Ｐゴシック"/></font>';
        if (/^<font\b[^>]*\/>$/.test(f)) f = f.replace(/\/>$/, '></font>');
        f = f.replace(/<u\b[^>]*\/>/g, '').replace(/<color\b[^>]*\/>/g, '');
        f = f.replace(/^<font\b([^>]*)>/, '<font$1><u/>');
        // 色は sz の後ろ(スキーマの順番: b i strike … u … sz color name)
        if (/<sz\b[^>]*\/>/.test(f)) f = f.replace(/(<sz\b[^>]*\/>)/, '$1<color rgb="FF0000FF"/>');
        else f = f.replace(/<\/font>$/, '<color rgb="FF0000FF"/></font>');
        fontMap[fid] = fonts.length + newFonts.length;
        newFonts.push(f);
      }
      let nx = xf.replace(/\bfontId="\d+"/, `fontId="${fontMap[fid]}"`);
      if (!/\bfontId=/.test(nx)) nx = nx.replace(/^<xf\b/, `<xf fontId="${fontMap[fid]}"`);
      nx = /\bapplyFont="/.test(nx) ? nx.replace(/\bapplyFont="\d"/, 'applyFont="1"') : nx.replace(/^<xf\b/, '<xf applyFont="1"');
      map[id] = String(xfs.length + newXfs.length);
      newXfs.push(nx);
    }
    let xml = stylesXml.replace(/<fonts\b([^>]*)>[\s\S]*?<\/fonts>/, (m, attrs) =>
      `<fonts${attrs.replace(/\bcount="\d+"/, `count="${fonts.length + newFonts.length}"`)}>${fonts.join('')}${newFonts.join('')}</fonts>`);
    xml = xml.replace(/<cellXfs\b([^>]*)>[\s\S]*?<\/cellXfs>/, (m, attrs) =>
      `<cellXfs${attrs.replace(/\bcount="\d+"/, `count="${xfs.length + newXfs.length}"`)}>${xfs.join('')}${newXfs.join('')}</cellXfs>`);
    return { xml, map };
  }

  function valueCell(ref, s, v) {
    const sa = s != null ? ` s="${s}"` : '';
    if (v == null || v === '') return `<c r="${ref}"${sa}/>`;
    if (typeof v === 'number' && Number.isFinite(v)) return `<c r="${ref}"${sa}><v>${v}</v></c>`;
    return `<c r="${ref}"${sa} t="inlineStr"><is><t xml:space="preserve">${escXml(v)}</t></is></c>`;
  }

  // 表の行を書き込んだ .xlsm を返す。
  //   rows: [{A..V}] 書き込む順。linkOf(row) → 図面のファイルURL(file:///…)か null
  async function write(JSZip, buf, rows, linkOf) {
    const zip = await JSZip.loadAsync(buf);
    const path = await findSheet(zip, SHEET);
    if (!path) throw new Error('「SPL」シートが見つかりません');
    const xml = await zip.file(path).async('string');
    const { head, tail, rows: oldRows } = splitRows(xml);
    const byNum = new Map(oldRows.map(r => [r.n, r]));
    const dataRows = oldRows.filter(r => r.n >= FIRST_ROW);
    const oldLast = dataRows.length ? Math.max(...dataRows.map(r => r.n)) : FIRST_ROW - 1;
    const lastRow = Math.max(oldLast, FIRST_ROW - 1 + rows.length);
    const tmplRow = byNum.get(oldLast) || dataRows[dataRows.length - 1];
    if (!tmplRow) throw new Error('SPLシートの4行目以降が見つかりません');

    // 式のひな形: 4行目から下で、式の文字が書かれている最初のセル
    const formula = {};
    for (const c of FORMULA_COLS) {
      for (const r of dataRows) {
        const cell = cellsOf(r.xml).find(x => x.col === c);
        const m = cell && cell.xml.match(/<f\b[^>]*>([\s\S]*?)<\/f>/);
        if (m && m[1].trim()) { formula[c] = { text: m[1], row: r.n }; break; }
      }
    }

    // リンクの書式(元の書式+青の下線)
    const links = []; // [{ref, url}]
    const linkStyleIds = new Set();
    const plan = [];
    const tcs = cellsOf(tmplRow.xml); // ひな形の行のセル(行ごとに読み直さない)
    for (let n = FIRST_ROW; n <= lastRow; n++) {
      const base = byNum.get(n) || tmplRow;
      const cs = base === tmplRow ? tcs : cellsOf(base.xml);
      const sOf = c => { const s = cellStyle(cs.find(x => x.col === c)); return s != null ? s : cellStyle(tcs.find(x => x.col === c)); };
      const rec = rows[n - FIRST_ROW] || null;
      const url = rec && linkOf ? linkOf(rec) : null;
      plan.push({ n, base, cs, sOf, rec, url });
      if (url) for (const c of ['A', 'B']) {
        if (rec[c] == null || rec[c] === '') continue;
        const s = sOf(c);
        if (s != null) linkStyleIds.add(s);
      }
    }
    let linkStyle = {};
    if (linkStyleIds.size) {
      const sf = zip.file('xl/styles.xml');
      const st = addLinkStyles(await sf.async('string'), [...linkStyleIds]);
      zip.file('xl/styles.xml', st.xml);
      linkStyle = st.map;
    }

    const out = [];
    for (const p of plan) {
      const { n, base, cs, sOf, rec, url } = p;
      const cells = [];
      for (const c of ALL_COLS) {
        const ref = c + n;
        let s = sOf(c);
        if (FORMULA_COLS.includes(c)) {
          const f = formula[c];
          cells.push(f ? `<c r="${ref}"${s != null ? ` s="${s}"` : ''}><f>${shiftFormula(f.text, f.row, n)}</f></c>` : valueCell(ref, s, null));
          continue;
        }
        const v = rec ? rec[c] : null;
        if (url && (c === 'A' || c === 'B') && v != null && v !== '') {
          if (s != null && linkStyle[s]) s = linkStyle[s];
          links.push({ ref, url });
        }
        cells.push(valueCell(ref, s, v));
      }
      // V列より右に元から何かあれば残す
      for (const x of cs) if (colNum(x.col) > 22) cells.push(x.xml);
      let attrs = (base.xml.match(/^<row\b([^>]*?)\/?>/) || [, ''])[1].replace(/\/$/, '').replace(/\s*\br="\d+"/, '');
      out.push(`<row r="${n}"${attrs}>${cells.join('')}</row>`);
    }
    const before = oldRows.filter(r => r.n < FIRST_ROW).map(r => r.xml);
    const after = oldRows.filter(r => r.n > lastRow).map(r => r.xml);
    let sheet = head + before.join('') + out.join('') + after.join('') + tail;

    // 範囲を広げる(dimension・オートフィルター)
    const widen = (m, pre, a, b, c, d, post) => Number(d) >= lastRow ? m : `${pre}${a}${b}:${c}${lastRow}${post}`;
    sheet = sheet.replace(/(<dimension ref=")([A-Z]+)(\d+):([A-Z]+)(\d+)(")/, widen);
    sheet = sheet.replace(/(<autoFilter\b[^>]*?\bref=")([A-Z]+)(\d+):([A-Z]+)(\d+)(")/, widen);

    // ハイパーリンク: 前に付けたもの(このシートの分)を外してから付け直す
    const relPath = path.replace(/worksheets\/([^/]+)$/, 'worksheets/_rels/$1.rels');
    const relFile = zip.file(relPath);
    let relXml = relFile ? await relFile.async('string')
      : '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"></Relationships>';
    relXml = relXml.replace(new RegExp(`<Relationship\\b[^>]*Type="${NS_HYPERLINK.replace(/[/.]/g, '\\$&')}"[^>]*/>`, 'g'), '');
    sheet = sheet.replace(/<hyperlinks>[\s\S]*?<\/hyperlinks>/, '');
    if (links.length) {
      const used = new Set([...relXml.matchAll(/\bId="([^"]+)"/g)].map(m => m[1]));
      let k = 1;
      const nextId = () => { while (used.has('rIdSpl' + k)) k++; used.add('rIdSpl' + k); return 'rIdSpl' + k; };
      const relAdd = [], hl = [];
      for (const l of links) {
        const id = nextId();
        relAdd.push(`<Relationship Id="${id}" Type="${NS_HYPERLINK}" Target="${escXml(l.url)}" TargetMode="External"/>`);
        hl.push(`<hyperlink ref="${l.ref}" r:id="${id}"/>`);
      }
      relXml = relXml.replace('</Relationships>', relAdd.join('') + '</Relationships>');
      // 置く場所: printOptions / pageMargins / pageSetup … の前(スキーマの順番)
      const at = sheet.search(/<(printOptions|pageMargins|pageSetup|headerFooter|rowBreaks|colBreaks|customProperties|cellWatches|ignoredErrors|smartTags|drawing|legacyDrawing|picture|oleObjects|controls|webPublishItems|tableParts|extLst)\b/);
      const block = `<hyperlinks>${hl.join('')}</hyperlinks>`;
      sheet = at >= 0 ? sheet.slice(0, at) + block + sheet.slice(at) : sheet.replace('</worksheet>', block + '</worksheet>');
    }
    zip.file(relPath, relXml);
    zip.file(path, sheet);

    // 式を書き換えたので、計算の順番の記録(calcChain)を消し、開いたときに全部計算させる
    if (zip.file('xl/calcChain.xml')) {
      zip.remove('xl/calcChain.xml');
      const ct = await zip.file('[Content_Types].xml').async('string');
      zip.file('[Content_Types].xml', ct.replace(/<Override\b[^>]*PartName="\/xl\/calcChain\.xml"[^>]*\/>/, ''));
      const wr = await zip.file('xl/_rels/workbook.xml.rels').async('string');
      zip.file('xl/_rels/workbook.xml.rels', wr.replace(/<Relationship\b[^>]*Target="[^"]*calcChain\.xml"[^>]*\/>/, ''));
    }
    let wb = await zip.file('xl/workbook.xml').async('string');
    if (/<calcPr\b/.test(wb)) {
      wb = wb.replace(/<calcPr\b([^>]*?)\/>/, (m, a) => `<calcPr${a.replace(/\s*\bfullCalcOnLoad="[^"]*"/, '')} fullCalcOnLoad="1"/>`);
    } else {
      wb = wb.replace(/(<\/sheets>(?:\s*<definedNames>[\s\S]*?<\/definedNames>)?)/, '$1<calcPr fullCalcOnLoad="1"/>');
    }
    zip.file('xl/workbook.xml', wb);

    const bytes = await zip.generateAsync({ type: 'uint8array', compression: 'DEFLATE', compressionOptions: { level: 6 } });
    return { bytes, lastRow, links: links.length };
  }

  // UNCパス(\\server\share\…)→ Excel のハイパーリンク用URL
  function fileUrl(unc) {
    return 'file:///' + String(unc).replace(/ /g, '%20');
  }

  const api = { read, write, fileUrl, shiftFormula };
  if (typeof module !== 'undefined' && module.exports) module.exports = api; else root.splXlsm = api;
})(typeof window !== 'undefined' ? window : globalThis);
