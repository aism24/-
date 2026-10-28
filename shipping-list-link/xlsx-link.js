/* Excel(.xlsx)への製品名リンク付与(ブラウザ/Node共通)。
 * 同じ行の中で、(図番, 製品名)がマスタと完全一致したセットの製品名セルにハイパーリンクを付ける。
 * 列の位置・見出しは指定しない。同じ行に複数セットがあるときは、列が近い図番と製品名を組にする。
 * 元のブックはXMLを直接書き換える(書式・結合セル・数式などは変えない)。 */
(function (root) {
  var NS_R = 'http://schemas.openxmlformats.org/officeDocument/2006/relationships';

  function decodeXml(s) {
    return String(s).replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"')
      .replace(/&apos;/g, "'").replace(/&#x([0-9a-fA-F]+);/g, function (m, h) { return String.fromCharCode(parseInt(h, 16)); })
      .replace(/&#(\d+);/g, function (m, d) { return String.fromCharCode(parseInt(d, 10)); }).replace(/&amp;/g, '&');
  }
  function encodeXml(s) { return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;'); }
  function attrs(tag) {
    var o = {}, re = /([A-Za-z_:][\w:.\-]*)="([^"]*)"/g, m;
    while ((m = re.exec(tag))) o[m[1]] = decodeXml(m[2]);
    return o;
  }
  function textOf(xml) {   // <t>の中身を連結(ふりがな<rPh>は除く)
    var t = '', re = /<t(?:\s[^>]*)?>([\s\S]*?)<\/t>/g, n;
    xml = xml.replace(/<rPh\b[\s\S]*?<\/rPh>/g, '');
    while ((n = re.exec(xml))) t += n[1];
    return decodeXml(t);
  }
  function parseSharedStrings(xml) {
    var out = [], re = /<si\b[^>]*?(?:\/>|>([\s\S]*?)<\/si>)/g, m;
    while ((m = re.exec(xml || ''))) out.push(m[1] ? textOf(m[1]) : '');
    return out;
  }
  function colIndex(ref) {
    var s = /^[A-Z]+/.exec(ref)[0], n = 0, i;
    for (i = 0; i < s.length; i++) n = n * 26 + s.charCodeAt(i) - 64;
    return n;
  }
  // 比較用: 前後の空白を除き、全角半角などをそろえる
  function norm(s) { return String(s).normalize('NFKC').replace(/\s+/g, ' ').trim(); }
  function shape(t) { return t.replace(/[0-9]/g, '9').replace(/[A-Z]/g, 'A').replace(/[a-z]/g, 'a'); }

  function inRange(ref, rng) {
    if (rng.indexOf(':') < 0) return false;
    var pr = rng.split(':'), c = colIndex(ref), r = +/\d+/.exec(ref)[0], c0 = colIndex(pr[0]), c1 = colIndex(pr[1]), r0 = +/\d+/.exec(pr[0])[0], r1 = +/\d+/.exec(pr[1])[0];
    return c >= c0 && c <= c1 && r >= r0 && r <= r1;
  }

  // シートの行ごとのセル(文字のあるものだけ)を読む
  function readRows(xml, sst) {
    var rows = [], sd = /<sheetData\b[^>]*>([\s\S]*?)<\/sheetData>/.exec(xml);
    if (!sd) return rows;
    var rre = /<row\b([^>]*?)(?:\/>|>([\s\S]*?)<\/row>)/g, rm;
    while ((rm = rre.exec(sd[1]))) {
      if (!rm[2]) continue;
      var cells = [], cre = /<c\b([^>]*?)(?:\/>|>([\s\S]*?)<\/c>)/g, cm;
      while ((cm = cre.exec(rm[2]))) {
        var a = attrs(cm[1]), body = cm[2] || '', v = '';
        if (!a.r || a.t === 'e' || a.t === 'b') continue;
        if (a.t === 'inlineStr') v = textOf(body);
        else {
          var vm = /<v>([\s\S]*?)<\/v>/.exec(body);
          if (!vm) continue;
          v = a.t === 's' ? (sst[+vm[1]] || '') : decodeXml(vm[1]);
        }
        v = norm(v);
        if (v) cells.push({ ref: a.r, col: colIndex(a.r), text: v, s: a.s });
      }
      var rn = attrs(rm[1]).r || (cells[0] && /\d+/.exec(cells[0].ref)[0]);
      if (cells.length) rows.push({ row: +rn, cells: cells });
    }
    return rows;
  }

  // 1行の中で、(図番, 製品名)がマスタと完全一致するセットを、列が近い順に1対1で組にする
  // idx: { z: {図番の文字:1}, n: {製品名の文字:1} }(マスタにある文字だけを候補にして、全セルの総当たりを避ける)
  // lookup(図番, 製品名) → マスタの値(URL。重複なら配列)/ なければ undefined
  function pairRow(cells, idx, lookup) {
    var zs = cells.filter(function (c) { return idx.z[c.text]; }), ns = cells.filter(function (c) { return idx.n[c.text]; }), cand = [];
    if (!zs.length || !ns.length) return [];
    zs.forEach(function (z) {
      ns.forEach(function (n) {
        if (z.text === n.text) return;
        var v = lookup(z.text, n.text);
        if (v) cand.push({ z: z, n: n, d: Math.abs(z.col - n.col), v: v });
      });
    });
    cand.sort(function (p, q) { return p.d - q.d || p.n.col - q.n.col || p.z.col - q.z.col; });
    var used = {}, out = [];
    cand.forEach(function (c) {
      if (used[c.z.ref] || used[c.n.ref]) return;
      used[c.z.ref] = used[c.n.ref] = 1;
      out.push(c);
    });
    return out;
  }

  // links: { "図番\t製品名": url | [url,...](重複) }
  // 戻り値 { bytes, stats:{ sheets, rows, linked, dup, ng, partial:[{page,zuban,name,reason}] } }
  async function linkXlsx(JSZip, data, links, opts) {
    var mapUri = (opts && opts.mapUri) || function (u) { return u; };
    var zip = await JSZip.loadAsync(data);
    var rd = async function (p) { var f = zip.file(p); return f ? f.async('string') : null; };
    var wb = await rd('xl/workbook.xml');
    if (!wb) throw new Error('Excel(.xlsx)として読めません');
    var rels = {}, relsXml = await rd('xl/_rels/workbook.xml.rels') || '', m, re = /<Relationship\b[^>]*>/g;
    while ((m = re.exec(relsXml))) { var ra = attrs(m[0]); if (ra.Id) rels[ra.Id] = ra.Target; }
    var sst = parseSharedStrings(await rd('xl/sharedStrings.xml'));

    // マスタの索引。比較は全角半角・空白をそろえた形で行う(nidx: 「図番\t製品名」→ 値、zset/nset: 図番・製品名として存在する文字、shapes: 図番の「形」)
    var nidx = {}, zset = {}, nset = {}, shapes = {};
    Object.keys(links).forEach(function (key) {
      var p0 = key.split('\t'), z = norm(p0[0]), n = norm(p0[1]);
      nidx[z + '\t' + n] = links[key];
      zset[z] = 1; nset[n] = 1; shapes[shape(z)] = 1;
    });
    var idx = { z: zset, n: nset };
    function lookup(z, n) { return nidx[z + '\t' + n]; }
    function zubanLike(t) { return t.indexOf('-') >= 0 && shapes[shape(t)]; }

    var stats = { sheets: 0, rows: 0, linked: 0, dup: 0, ng: 0, partial: [] };
    var sre = /<sheet\b[^>]*>/g, sm;
    var styleCache = {}, styles = await rd('xl/styles.xml'), stylesChanged = false, fontsAdded = [], xfsAdded = [];
    var fontList = null, xfList = null;
    if (styles) {
      var fm = /<fonts\b[^>]*>([\s\S]*?)<\/fonts>/.exec(styles), xm = /<cellXfs\b[^>]*>([\s\S]*?)<\/cellXfs>/.exec(styles);
      if (fm && xm) {
        fontList = fm[1].match(/<font\b[^>]*?(?:\/>|>[\s\S]*?<\/font>)/g) || [];
        xfList = xm[1].match(/<xf\b[^>]*?(?:\/>|>[\s\S]*?<\/xf>)/g) || [];
      }
    }
    // リンクの見た目: 元のセルの書式はそのままに、青い下線だけを足した書式を作る
    function linkStyle(s) {
      if (!fontList) return null;
      s = s === undefined ? 0 : +s;
      if (styleCache[s] !== undefined) return styleCache[s];
      var xf = xfList[s] || xfList[0];
      if (!xf) return (styleCache[s] = null);
      var fid = +(/fontId="(\d+)"/.exec(xf) || [0, 0])[1], font = fontList[fid] || '<font/>';
      var inner = /\/>$/.test(font) && font.indexOf('</font>') < 0 ? '' : font.replace(/^<font\b[^>]*>/, '').replace(/<\/font>$/, '');
      inner = inner.replace(/<u\b[^>]*\/>/g, '').replace(/<color\b[^>]*\/>/g, '') + '<u/><color rgb="FF0033E6"/>';
      var nf = '<font>' + orderFont(inner) + '</font>';
      var fi = fontList.length + fontsAdded.length;
      fontsAdded.push(nf);
      var nx = xf.replace(/fontId="\d+"/, 'fontId="' + fi + '"');
      if (!/fontId=/.test(nx)) nx = nx.replace(/^<xf/, '<xf fontId="' + fi + '"');
      nx = /applyFont=/.test(nx) ? nx.replace(/applyFont="\d"/, 'applyFont="1"') : nx.replace(/^<xf/, '<xf applyFont="1"');
      var xi = xfList.length + xfsAdded.length;
      xfsAdded.push(nx);
      stylesChanged = true;
      return (styleCache[s] = xi);
    }
    var ORDER = ['b', 'i', 'strike', 'condense', 'extend', 'outline', 'shadow', 'u', 'vertAlign', 'sz', 'color', 'name', 'family', 'charset', 'scheme'];
    function orderFont(inner) {
      var parts = inner.match(/<(\w+)\b[^>]*?(?:\/>|>[\s\S]*?<\/\1>)/g) || [];
      parts.sort(function (a, b) { return ORDER.indexOf(/^<(\w+)/.exec(a)[1]) - ORDER.indexOf(/^<(\w+)/.exec(b)[1]); });
      return parts.join('');
    }

    while ((sm = sre.exec(wb))) {
      var sa = attrs(sm[0]), target = rels[sa['r:id']];
      if (!target) continue;
      var path = target.charAt(0) === '/' ? target.slice(1) : 'xl/' + target.replace(/^\.\//, '');
      if (!/\/worksheets\/[^/]+\.xml$/.test(path)) continue;
      var xml = await rd(path);
      if (!xml) continue;
      stats.sheets++;
      var adds = [];   // adds: {ref, uri, s}
      // 既存のハイパーリンク(同じセルは置き換え。範囲リンクの中のセルは触らない)
      var existing = [], hre = /<hyperlink\b[^>]*?\/>/g, hm;
      while ((hm = hre.exec(xml))) existing.push({ tag: hm[0], a: attrs(hm[0]) });
      var rangeRefs = existing.filter(function (e) { return e.a.ref && e.a.ref.indexOf(':') >= 0; }).map(function (e) { return e.a.ref; });   // 範囲リンクだけ(単一セルのリンクは inRange が常に false)
      readRows(xml, sst).forEach(function (row) {
        stats.rows++;
        var pairs = pairRow(row.cells, idx, lookup), linkedHere = 0, loc = sa.name + '!' + row.row;
        pairs.forEach(function (c) {
          if (Array.isArray(c.v)) { stats.dup++; stats.partial.push({ page: loc, zuban: c.z.text, name: c.n.text, reason: '重複' }); return; }
          if (rangeRefs.some(function (rg) { return inRange(c.n.ref, rg); })) {
            stats.partial.push({ page: loc, zuban: c.z.text, name: c.n.text, reason: '既存のリンク範囲内のため付けず' }); return;
          }
          adds.push({ ref: c.n.ref, uri: mapUri(c.v), s: c.n.s });
          linkedHere++; stats.linked++;
        });
        if (!linkedHere) {
          var z = row.cells.filter(function (c) { return zubanLike(c.text); })[0];
          if (z) {
            stats.ng++;
            if (!pairs.length) stats.partial.push({ page: loc, zuban: z.text, name: '', reason: zset[z.text] ? '製品名が不一致' : 'マスタに無い図番' });
          }
        }
      });
      if (!adds.length) continue;

      // セルの書式(青い下線)
      var addRef = {}; adds.forEach(function (a) { addRef[a.ref] = a; });
      xml = xml.replace(/<c\b([^>]*?)(\/?)>/g, function (all, at, sl) {
        var r = /\br="([A-Z]+\d+)"/.exec(at);
        if (!r || !addRef[r[1]]) return all;
        var ns = linkStyle(addRef[r[1]].s);
        if (ns === null) return all;
        var at2 = /\bs="\d+"/.test(at) ? at.replace(/\bs="\d+"/, 's="' + ns + '"') : at + ' s="' + ns + '"';
        return '<c' + at2 + sl + '>';
      });
      // 同じセルの既存リンクを外す
      existing.forEach(function (e) { if (addRef[e.a.ref]) xml = xml.replace(e.tag, ''); });
      // リレーション(外部リンク)
      var rp = path.replace(/([^/]+)$/, '_rels/$1.rels'), rx = await rd(rp), n = 0, hl = '';
      if (!rx) rx = '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"></Relationships>';
      var rl = '';
      adds.forEach(function (a) {
        var id = 'rIdSL' + (++n);
        rl += '<Relationship Id="' + id + '" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/hyperlink" Target="' + encodeXml(a.uri) + '" TargetMode="External"/>';
        hl += '<hyperlink ref="' + a.ref + '" r:id="' + id + '"/>';
      });
      rx = rx.replace('</Relationships>', rl + '</Relationships>');
      zip.file(rp, rx);
      if (!/<worksheet\b[^>]*\sxmlns:r=/.test(xml)) xml = xml.replace(/<worksheet\b/, '<worksheet xmlns:r="' + NS_R + '"');
      if (/<hyperlinks>/.test(xml)) xml = xml.replace('</hyperlinks>', hl + '</hyperlinks>');
      else {
        var after = xml.indexOf('</sheetData>'), tail = xml.slice(after),
          nx = /<(printOptions|pageMargins|pageSetup|headerFooter|rowBreaks|colBreaks|customProperties|cellWatches|ignoredErrors|smartTags|drawing|legacyDrawing|legacyDrawingHF|drawingHF|picture|oleObjects|controls|webPublishItems|tableParts|extLst)[\s>\/]/.exec(tail);
        var at3 = nx ? after + nx.index : xml.lastIndexOf('</worksheet>');
        xml = xml.slice(0, at3) + '<hyperlinks>' + hl + '</hyperlinks>' + xml.slice(at3);
      }
      zip.file(path, xml);
    }
    if (stylesChanged) {
      var fc = fontList.length + fontsAdded.length, xc = xfList.length + xfsAdded.length;
      styles = styles.replace(/(<fonts\b[^>]*?)count="\d+"([^>]*>[\s\S]*?)<\/fonts>/, function (a, p, q) { return p + 'count="' + fc + '"' + q + fontsAdded.join('') + '</fonts>'; });
      styles = styles.replace(/(<cellXfs\b[^>]*?)count="\d+"([^>]*>[\s\S]*?)<\/cellXfs>/, function (a, p, q) { return p + 'count="' + xc + '"' + q + xfsAdded.join('') + '</cellXfs>'; });
      zip.file('xl/styles.xml', styles);
    }
    var bytes = await zip.generateAsync({ type: 'uint8array', compression: 'DEFLATE' });
    return { bytes: bytes, stats: stats };
  }

  var api = { linkXlsx: linkXlsx };
  if (typeof module !== 'undefined' && module.exports) module.exports = api; else root.ShippingXlsx = api;
})(typeof window !== 'undefined' ? window : this);
