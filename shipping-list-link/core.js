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

  // 加工予定表: 1行に日付ごとの列(製品名・台数・重量・図番)が並ぶ。同じ列の「製品名 台数 重量 図番」だけを組にして照合し、
  // 付かなかった列(図番らしい語があるのにマスタに完全一致が無い)を列単位でNGに数える。図番が空・「バリ取り」等は対象外
  // ページが回転(/Rotate 90等)していても、表示上の座標(viewport)で行・列を判定し、リンクは元のページ座標に置く
  function schedTokens(items, vp) {
    var T = vp.transform, toks = [];
    function disp(x, y) { return { X: T[0] * x + T[2] * y + T[4], Y: T[1] * x + T[3] * y + T[5] }; }
    items.forEach(function (it) {
      if (!it.str || !it.str.trim()) return;
      var m = it.transform, a = m[0], b = m[1], c = m[2], d = m[3];
      var ul = Math.sqrt(a * a + b * b) || 1, vl = Math.sqrt(c * c + d * d) || 1;
      var ux = a / ul, uy = b / ul, vx = c / vl, vy = d / vl, h = it.height || vl;
      var re = /[A-Za-z0-9][A-Za-z0-9\-_.\/]*/g, mt;
      while ((mt = re.exec(it.str))) {
        // spanX は水平前提のため、item の向きに沿った長さ(0〜width)を文字幅の重みで按分する
        var w = it.width || 0, tot = 0, p0 = 0, p1 = 0, i;
        for (i = 0; i < it.str.length; i++) { if (i === mt.index) p0 = tot; tot += charWeight(it.str[i]); if (i + 1 === mt.index + mt[0].length) p1 = tot; }
        var s0 = w * p0 / tot, s1 = w * p1 / tot;
        var lo = -0.25 * h, hi = 0.85 * h;
        var pts = [[s0, lo], [s1, lo], [s0, hi], [s1, hi]].map(function (q) { return [m[4] + ux * q[0] + vx * q[1], m[5] + uy * q[0] + vy * q[1]]; });
        var xs = pts.map(function (q) { return q[0]; }), ys = pts.map(function (q) { return q[1]; });
        var ds = disp(m[4] + ux * s0, m[5] + uy * s0), de = disp(m[4] + ux * s1, m[5] + uy * s1);
        toks.push({ text: mt[0], X0: Math.min(ds.X, de.X), X1: Math.max(ds.X, de.X), Y: ds.Y, h: h,
          rect: [Math.min.apply(null, xs), Math.min.apply(null, ys), Math.max.apply(null, xs), Math.max.apply(null, ys)],
          ul: [m[4] + ux * s0 + vx * lo, m[5] + uy * s0 + vy * lo, m[4] + ux * s1 + vx * lo, m[5] + uy * s1 + vy * lo] });
      }
    });
    return toks;
  }
  function schedRows(toks) {
    toks.sort(function (p, q) { return p.Y - q.Y; });
    var rows = [], cur = null;
    toks.forEach(function (t) {
      if (cur && Math.abs(cur.Y - t.Y) <= Math.max(1, t.h * 0.4)) cur.toks.push(t);
      else { cur = { Y: t.Y, toks: [t] }; rows.push(cur); }
    });
    rows.forEach(function (r) { r.toks.sort(function (p, q) { return p.X0 - q.X0; }); });
    return rows;
  }
  function scheduleRows(items, vp, links, shapes, zset, stats, annots, pn, mapUri) {
    schedRows(schedTokens(items, vp)).forEach(function (row) {
      var u = row.toks;
      stats.rows++;
      for (var i = 0; i + 3 < u.length; i++) {
        var n = u[i], q = u[i + 1], w = u[i + 2], z = u[i + 3];
        if (!/^\d+$/.test(q.text) || !/^\d+\.\d+$/.test(w.text) || z.X0 - w.X1 > 45) continue;   // 同じ列の「製品名 台数 重量 図番」だけ
        if (z.text.indexOf('-') < 0 || !shapes[shape(z.text)]) continue;
        var v = links[z.text + '\t' + n.text];
        if (Array.isArray(v)) { stats.dup++; stats.partial.push({ page: pn, zuban: z.text, name: n.text, reason: '重複' }); continue; }
        if (v) { annots.push({ rect: n.rect, ul: n.ul, uri: mapUri(v) }); stats.linked++; continue; }
        stats.ng++;
        stats.partial.push({ page: pn, zuban: z.text, name: n.text, reason: zset[z.text] ? '製品名が不一致' : 'マスタに無い図番' });
      }
    });
  }

  // links: { "図番\t製品名": url | [url,...](重複) }
  // opts.mapUri(url): PDFに埋め込むリンク先の変換(省略時はマスタのURLそのまま)
  async function linkPdf(pdfjsLib, PDFLib, data, links, opts) {
    var mapUri = (opts && opts.mapUri) || function (u) { return u; };
    var doc = await pdfjsLib.getDocument({ data: new Uint8Array(data.slice(0)) }).promise;
    var out = await PDFLib.PDFDocument.load(data, { ignoreEncryption: true });
    var zset = {}, shapes = {};
    Object.keys(links).forEach(function (k) { var z = k.split('\t')[0]; zset[z] = 1; shapes[shape(z)] = 1; });
    var stats = { pages: doc.numPages, linked: 0, dup: 0, ng: 0, partial: [], rows: 0 };
    var tcs = [], vps = [], sched = [], anySched = false;
    try {
    var qs = [];
    for (var q0 = 1; q0 <= doc.numPages; q0++) qs.push(q0);
    await Promise.all(qs.map(async function (q) {   // 全ページのテキスト取得を並列化(結果は添字で格納するので順序は不変)
      var pj = await doc.getPage(q); vps[q] = pj.getViewport({ scale: 1 }); tcs[q] = await pj.getTextContent();
      sched[q] = tcs[q].items.map(function (it) { return it.str; }).join('').replace(/\s/g, '').indexOf('加工予定表') >= 0;   // タイトルは1文字ずつ分かれている場合がある
    }));
    for (var q1 = 1; q1 <= doc.numPages; q1++) if (sched[q1]) anySched = true;
    for (var pn = 1; pn <= doc.numPages; pn++) {
      if (anySched && !sched[pn]) continue;   // 「加工予定表」のタイトルがあるPDFは、そのページだけを対象にする
      var tc = tcs[pn];
      var page = out.getPage(pn - 1), annots = [];
      var rows = sched[pn] ? [] : clusterRows(tc.items);
      if (sched[pn]) scheduleRows(tc.items, vps[pn], links, shapes, zset, stats, annots, pn, mapUri);
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
          annots.push({ rect: rect, ul: [rect[0], rect[1] + 0.5, rect[2], rect[1] + 0.5], uri: mapUri(v) });
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
        // リンクが付いた製品名は、青い下線で示す(文字色・背景は変えない)
        page.drawLine({ start: { x: a.ul[0], y: a.ul[1] }, end: { x: a.ul[2], y: a.ul[3] },
          thickness: 0.9, color: PDFLib.rgb(0, 0.2, 0.9) });
      });
    }
    } finally { doc.destroy(); }   // pdf.js のworker・ページ資源を解放(処理のたびに残らないように)
    return { bytes: await out.save(), stats: stats };
  }

  // マスタのリンク(file://192.168.1.2/share/….tdf)を、Webページ経由の起動リンク(open.html?p=…)に変換する
  function toOpenUrl(base, fileUrl) {
    var m = /^file:\/\/(.+)$/i.exec(fileUrl);
    if (!m) return fileUrl;
    var path;
    try { path = decodeURIComponent(m[1]); } catch (e) { path = m[1]; }
    return base + '?p=' + encodeURIComponent(path);
  }

  // 圧縮形式のリンク表({d:[フォルダ…], links:{キー:"番号|ファイル名"}})を、従来の {キー:URL} に戻す。従来形式はそのまま返す
  function expandMaster(m) {
    if (!m || !m.d) return m;
    var links = {}, k, v, i;
    for (k in m.links) {
      v = m.links[k]; i = v.indexOf('|');
      links[k] = (i > 0 ? m.d[+v.slice(0, i)] : '') + v.slice(i + 1);
    }
    return { updated: m.updated, sources: m.sources, links: links };
  }

  var api = { expandMaster: expandMaster, linkPdf: linkPdf, encodeUri: encodeUri, toOpenUrl: toOpenUrl };
  if (typeof module !== 'undefined' && module.exports) module.exports = api; else root.ShippingCore = api;
})(typeof window !== 'undefined' ? window : this);
