// 入力データ様式(.xlsm)の「ﾃﾞｰﾀ」シートの末尾に、抽出結果のテキストを書き込む(本社・夢前の梁・柱モード)。
// 書き込む列: H 加工先 / I 図番 / J 製品名 / K サイズ / L 全長(mm) / M 本数 / Y J若番 / AB J老番
// マクロ(vbaProject.bin)・他のシート・書式は触らない。SheetJS では保存し直さず、sheet XML を直接書き換える。
// 計算式は書かない(数式化マクロの担当。ユーザー指示)。
(function (root) {
  const COLS = ['H', 'I', 'J', 'K', 'L', 'M', 'Y', 'AB'];
  const HEAD_ROW = 4; // 見出しの行。データは5行目から
  const DATA_SHEET = 'データ'; // 「ﾃﾞｰﾀ」(半角)を NFKC で揃えて比べる

  const nfkc = s => String(s ?? '').normalize('NFKC');
  const unescXml = s => s.replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&apos;/g, "'").replace(/&amp;/g, '&');
  const escXml = s => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
  const colNum = c => c.split('').reduce((n, ch) => n * 26 + ch.charCodeAt(0) - 64, 0);

  // 「ﾃﾞｰﾀ」シートのファイル名を workbook.xml と rels から探す
  async function findDataSheet(zip) {
    const wb = await zip.file('xl/workbook.xml').async('string');
    const rels = await zip.file('xl/_rels/workbook.xml.rels').async('string');
    let rid = null;
    for (const m of wb.matchAll(/<sheet\b[^>]*>/g)) {
      const name = (m[0].match(/\bname="([^"]*)"/) || [])[1];
      if (name != null && nfkc(unescXml(name)) === DATA_SHEET) rid = (m[0].match(/\br:id="([^"]*)"/) || [])[1];
    }
    if (!rid) throw new Error('「ﾃﾞｰﾀ」シートが見つかりません(入力データ様式のExcelではない可能性があります)');
    for (const m of rels.matchAll(/<Relationship\b[^>]*>/g)) {
      if ((m[0].match(/\bId="([^"]*)"/) || [])[1] === rid) {
        const t = (m[0].match(/\bTarget="([^"]*)"/) || [])[1];
        return 'xl/' + t.replace(/^\/?(xl\/)?/, '');
      }
    }
    throw new Error('「ﾃﾞｰﾀ」シートの場所が分かりません');
  }

  async function readSharedStrings(zip) {
    const f = zip.file('xl/sharedStrings.xml');
    if (!f) return [];
    const xml = await f.async('string');
    return [...xml.matchAll(/<si\b[^>]*>([\s\S]*?)<\/si>/g)].map(m =>
      unescXml([...m[1].matchAll(/<t\b[^>]*>([\s\S]*?)<\/t>/g)].map(t => t[1]).join('')));
  }

  // sheetData を行ごとに分ける
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
  function cellText(cell, sst) {
    if (!cell) return '';
    const x = cell.xml;
    const t = (x.match(/\bt="([^"]*)"/) || [])[1];
    if (t === 'inlineStr') return unescXml([...x.matchAll(/<t\b[^>]*>([\s\S]*?)<\/t>/g)].map(m => m[1]).join(''));
    const v = (x.match(/<v>([\s\S]*?)<\/v>/) || [])[1];
    if (v == null || v === '') return '';
    if (t === 's') return sst[Number(v)] ?? '';
    return unescXml(v);
  }

  // 既存の内容を読む: 最終行(J列=製品名が入っている最後の行)と、図番+製品名の一覧(重複の確認用)
  async function inspect(JSZip, buf) {
    const zip = await JSZip.loadAsync(buf);
    const path = await findDataSheet(zip);
    const sst = await readSharedStrings(zip);
    const { rows } = splitRows(await zip.file(path).async('string'));
    let lastRow = HEAD_ROW;
    const keys = new Set();
    for (const r of rows) {
      if (r.n <= HEAD_ROW) continue;
      const cs = cellsOf(r.xml), by = c => cs.find(x => x.col === c);
      const j = cellText(by('J'), sst);
      if (j.trim() !== '') {
        lastRow = Math.max(lastRow, r.n);
        keys.add(nfkc(cellText(by('I'), sst)).replace(/\s/g, '') + '|' + nfkc(j).replace(/\s/g, ''));
      }
    }
    return { lastRow, keys, path };
  }

  // rows: [{ H, I, J, K, L, M, Y, AB }]。L・M は数、ほかは文字。空は書かない。
  async function append(JSZip, buf, rowsToAdd) {
    const zip = await JSZip.loadAsync(buf);
    const path = await findDataSheet(zip);
    const sst = await readSharedStrings(zip);
    const xml = await zip.file(path).async('string');
    const { head, tail, rows } = splitRows(xml);

    // 最終行: 下から上へ見て、最初に製品名(J)が入っている行
    let lastRow = HEAD_ROW, styleRow = null;
    for (const r of rows) {
      if (r.n <= HEAD_ROW) continue;
      const cs = cellsOf(r.xml);
      if (cellText(cs.find(x => x.col === 'J'), sst).trim() !== '' && r.n >= lastRow) { lastRow = r.n; styleRow = cs; }
    }
    // 書式は最終行の同じ列のセルから借りる(無ければ書式なし)
    const style = {};
    for (const c of COLS) {
      const cell = styleRow && styleRow.find(x => x.col === c);
      const s = cell && (cell.xml.match(/\bs="(\d+)"/) || [])[1];
      if (s != null) style[c] = s;
    }

    const byNum = new Map(rows.map(r => [r.n, r]));
    let maxRow = rows.length ? Math.max(...rows.map(r => r.n)) : 0;
    rowsToAdd.forEach((rec, i) => {
      const n = lastRow + 1 + i;
      const mine = [];
      for (const c of COLS) {
        const v = rec[c];
        if (v == null || v === '') continue;
        const s = style[c] != null ? ` s="${style[c]}"` : '';
        mine.push({
          col: c,
          xml: typeof v === 'number'
            ? `<c r="${c}${n}"${s}><v>${v}</v></c>`
            : `<c r="${c}${n}"${s} t="inlineStr"><is><t xml:space="preserve">${escXml(v)}</t></is></c>`,
        });
      }
      const old = byNum.get(n);
      let attrs = ' spans="4:50"', cells = [];
      if (old) {
        attrs = (old.xml.match(/^<row\b([^>]*?)\/?>/) || [, attrs])[1].replace(/\/$/, '');
        cells = cellsOf(old.xml).filter(x => !mine.some(m => m.col === x.col));
      }
      const all = cells.concat(mine).sort((a, b) => colNum(a.col) - colNum(b.col));
      const rowXml = `<row${attrs.includes(' r="') ? '' : ` r="${n}"`}${attrs}>${all.map(x => x.xml).join('')}</row>`
        .replace(/^<row r="(\d+)" r="\d+"/, '<row r="$1"');
      if (old) old.xml = rowXml; else { const o = { n, xml: rowXml }; rows.push(o); byNum.set(n, o); }
      if (n > maxRow) maxRow = n;
    });
    rows.sort((a, b) => a.n - b.n);

    let out = head + rows.map(r => r.xml).join('') + tail;
    // 末尾が既存の範囲(dimension)を越えたら広げる
    out = out.replace(/<dimension ref="([A-Z]+)(\d+):([A-Z]+)(\d+)"\/>/, (m, a, b, c, d) =>
      Number(d) >= maxRow ? m : `<dimension ref="${a}${b}:${c}${maxRow}"/>`);
    zip.file(path, out, { createFolders: false });
    const bytes = await zip.generateAsync({ type: 'uint8array', compression: 'DEFLATE', compressionOptions: { level: 6 } });
    return { bytes, firstRow: lastRow + 1, lastRowBefore: lastRow, count: rowsToAdd.length };
  }

  const api = { inspect, append, COLS };
  if (typeof module !== 'undefined' && module.exports) module.exports = api; else root.inputXlsm = api;
})(typeof window !== 'undefined' ? window : globalThis);
