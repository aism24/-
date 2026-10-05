/* 照合・リンク付与のコア処理(ブラウザ/Node共通)。
 * 行の中の英数字トークンを総当たりし、(図番, 製品名)がマスタと完全一致したら製品名にリンクを付ける。 */
(function (root) {
  var TOKEN_RE = /[A-Za-z0-9][A-Za-z0-9\-_.\/]*/g;
  var TOKEN_JP_RE = /[A-Za-z0-9][A-Za-z0-9\-_.\/]*[぀-ヿ一-鿿]+/g;

  function charWeight(ch) {
    var c = ch.charCodeAt(0);
    if (c < 0x80 || (c >= 0xff61 && c <= 0xff9f)) return 0.55;
    return 1;
  }

  // item内の[start,end)に対応するx範囲を、全角1/半角0.55の重みで按分して求める
  function spanX(item, start, end) {
    var s = item.str, tot = 0, a = 0, b = 0, i;
    for (i = 0; i < s.length; i++) {
      var w = charWeight(s[i]);
      if (i === start) a = tot;
      tot += w;
      if (i + 1 === end) b = tot;
    }
    var x = item.transform[4], width = item.width || 0;
    return { x0: x + width * (a / tot), x1: x + width * (b / tot) };
  }

  function clusterRows(items) {
    var arr = items.filter(function (it) { return it.str && it.str.trim(); })
      .sort(function (p, q) { return q.transform[5] - p.transform[5]; });
    var rows = [], cur = null;
    arr.forEach(function (it) {
      var y = it.transform[5], h = it.height || 8;
      if (cur && Math.abs(cur.y - y) <= Math.max(2, h * 0.4)) cur.items.push(it);
      else { cur = { y: y, items: [it] }; rows.push(cur); }
    });
    return rows;
  }

  function rowTokens(row) {
    var toks = [];
    row.items.forEach(function (it) {
      [TOKEN_RE, TOKEN_JP_RE].forEach(function (re) {
        re.lastIndex = 0;
        var m;
        while ((m = re.exec(it.str))) {
          var sp = spanX(it, m.index, m.index + m[0].length);
          toks.push({ text: m[0], x0: sp.x0, x1: sp.x1, y: it.transform[5], h: it.height || 8 });
        }
      });
    });
    return toks;
  }

  // 図番の「形」(数字→9, 英大文字→A, 英小文字→a)。マスタの図番と同じ形のトークンを図番らしいとみなす
  function shape(t) { return t.replace(/[0-9]/g, '9').replace(/[A-Z]/g, 'A').replace(/[a-z]/g, 'a'); }

  function encodeUri(u) {
    return u.replace(/[^\x21-\x7e]/g, function (c) { return encodeURIComponent(c); })
      .replace(/\(/g, '%28').replace(/\)/g, '%29');
  }

  // links: { "図番\t製品名": url | [url,...](重複) }
  async function linkPdf(pdfjsLib, PDFLib, data, links) {
    var doc = await pdfjsLib.getDocument({ data: new Uint8Array(data.slice(0)) }).promise;
    var out = await PDFLib.PDFDocument.load(data, { ignoreEncryption: true });
    var zset = {}, shapes = {};
    Object.keys(links).forEach(function (k) { var z = k.split('\t')[0]; zset[z] = 1; shapes[shape(z)] = 1; });
    var stats = { pages: doc.numPages, linked: 0, dup: 0, ng: 0, partial: [], rows: 0 };
    for (var pn = 1; pn <= doc.numPages; pn++) {
      var tc = await (await doc.getPage(pn)).getTextContent();
      var page = out.getPage(pn - 1), annots = [];
      var rows = clusterRows(tc.items);
      for (var r = 0; r < rows.length; r++) {
        var toks = rowTokens(rows[r]), done = {}, hasAny = false;
        stats.rows++;
        var rowStartLinked = stats.linked;
        for (var i = 0; i < toks.length; i++) for (var j = 0; j < toks.length; j++) {
          if (i === j || toks[i].text === toks[j].text) continue;
          var key = toks[i].text + '\t' + toks[j].text, v = links[key];
          if (!v) continue;
          hasAny = true;
          var t = toks[j], id = key + '@' + Math.round(t.x0) + ',' + Math.round(t.y);
          if (done[id]) continue;
          done[id] = 1;
          if (Array.isArray(v)) { stats.dup++; stats.partial.push({ page: pn, zuban: toks[i].text, name: t.text, reason: '重複' }); continue; }
          var rect = [t.x0, t.y - t.h * 0.25, t.x1, t.y + t.h * 0.85];
          annots.push({ rect: rect, uri: v });
          stats.linked++;
        }
        if (stats.linked === rowStartLinked) {
          // 図番らしい(マスタの図番と同じ形の)トークンがあるのにリンクが付かなかった行 = NG
          var z = toks.filter(function (t) { return shapes[shape(t.text)] && t.text.indexOf('-') >= 0; })[0];
          if (z) {
            stats.ng++;
            if (!hasAny) stats.partial.push({ page: pn, zuban: z.text, name: '', reason: zset[z.text] ? '製品名が不一致' : 'マスタに無い図番' });
          }
        }
      }
      annots.forEach(function (a) {
        var ctx = out.context, rect = a.rect;
        var act = ctx.obj({ S: 'URI', URI: PDFLib.PDFString.of(encodeUri(a.uri)) });
        var ann = ctx.obj({ Type: 'Annot', Subtype: 'Link', Rect: rect, Border: [0, 0, 0], A: act });
        page.node.addAnnot(ctx.register(ann));
        page.drawLine({ start: { x: rect[0], y: rect[1] + 1 }, end: { x: rect[2], y: rect[1] + 1 },
          thickness: 0.6, color: PDFLib.rgb(0, 0, 1) });
      });
    }
    return { bytes: await out.save(), stats: stats };
  }

  var api = { linkPdf: linkPdf, encodeUri: encodeUri };
  if (typeof module !== 'undefined' && module.exports) module.exports = api; else root.ShippingCore = api;
})(typeof window !== 'undefined' ? window : this);
