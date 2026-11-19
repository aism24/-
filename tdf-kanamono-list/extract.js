// TDF(実寸法師)の鉄骨詳細図から、製品ごとの金物(切板・形鋼)を拾い出す(読み取り専用。ブラウザとNode.jsの両方で動く)。
// 拾い出しのルールは docs/apps/tdf-kanamono-list.md(ユーザーと決めたもの)。要点:
//  - 製品 = 図面下の「製品名 符号 N台」の行(符号が無い行=現場付けの製品は拾わない)
//  - 切板 = 断面図(「A SEC」など)と立面図の「GPL-9 / KG1」のような表記。断面図の表記は、立面図の断面記号(旗)の数だけ数える
//    同じ場所を複数の断面で描いているときは、その場所で一番少ない枚数(反対側がガセットなら片側)
//    立面図で同じ板厚の板が描かれていて旗が無い場所は、同じ板厚の旗のある場所と同じ断面とみなす
//  - FB = 表記の寸法の□を図形の数で数える / 山形鋼・溝形鋼の受材 = 線の長さで数える
//  - 除外(スプライスPL・フィラーPL・吊りピース・ネット受けピース・サヤ管・現場付け)は拾わず、見つけた種類を返す
// TDFの読み方(OLE・テキスト・線)は tdf-dim-count/core.js と同じ(2026-10-13〜14に解析)。
(function (root) {
  'use strict';
  var SIZE_LINE = -2147483592;

  // ---------- TDFの読み取り(tdf-dim-count/core.js から必要な部分を移植) ----------
  function okHeader(dv, rs) {
    var x = dv.getFloat64(rs + 4, true), y = dv.getFloat64(rs + 12, true), h = dv.getFloat64(rs + 20, true),
      w = dv.getFloat64(rs + 28, true), r = dv.getFloat64(rs + 36, true);
    return Math.abs(x) < 1e7 && Math.abs(y) < 1e7 && h > 0 && h < 5000 && Math.abs(w) < 5000 && Math.abs(r) < 10;
  }
  function extractContents(buf) {
    var u8 = new Uint8Array(buf);
    var sig = [0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1];
    for (var k = 0; k < 8; k++) if (u8[k] !== sig[k]) return buf;
    var dv = new DataView(buf);
    var ss = 1 << dv.getUint16(30, true);
    var nFat = dv.getUint32(44, true), dirStart = dv.getUint32(48, true);
    var difStart = dv.getUint32(68, true), nDif = dv.getUint32(72, true);
    var END = 0xfffffffe;
    function secOff(s) { return (s + 1) * ss; }
    var fatSecs = [];
    for (var i = 0; i < 109 && fatSecs.length < nFat; i++) fatSecs.push(dv.getUint32(76 + i * 4, true));
    var d = difStart;
    for (var n = 0; n < nDif && d < END; n++) {
      var o = secOff(d), per = ss / 4 - 1;
      for (var j = 0; j < per && fatSecs.length < nFat; j++) fatSecs.push(dv.getUint32(o + j * 4, true));
      d = dv.getUint32(o + per * 4, true);
    }
    var perFat = ss / 4, fat = new Uint32Array(fatSecs.length * perFat);
    fatSecs.forEach(function (s, idx) { for (var j = 0; j < perFat; j++) fat[idx * perFat + j] = dv.getUint32(secOff(s) + j * 4, true); });
    function chain(start) { var out = [], s = start, g = 0; while (s < END && g++ < 1e7) { out.push(s); s = fat[s]; } return out; }
    var dirSecs = chain(dirStart), found = null;
    outer: for (var di = 0; di < dirSecs.length; di++) {
      for (var e = 0; e < ss / 128; e++) {
        var p = secOff(dirSecs[di]) + e * 128, nl = dv.getUint16(p + 64, true);
        if (nl < 2) continue;
        var nm = '';
        for (var c = 0; c < nl / 2 - 1; c++) nm += String.fromCharCode(dv.getUint16(p + c * 2, true));
        if (nm === 'Contents' && u8[p + 66] === 2) { found = { start: dv.getUint32(p + 116, true), size: dv.getUint32(p + 120, true) }; break outer; }
      }
    }
    if (!found) throw new Error('Contents ストリームが見つかりません');
    if (found.size < 4096) throw new Error('小さなストリームには未対応です');
    var out = new Uint8Array(found.size), pos = 0;
    chain(found.start).forEach(function (s) {
      var n = Math.min(ss, found.size - pos);
      if (n > 0) { out.set(u8.subarray(secOff(s), secOff(s) + n), pos); pos += n; }
    });
    return out.buffer;
  }
  function readLayers(u8) {
    var dv = new DataView(u8.buffer, u8.byteOffset, u8.byteLength);
    var dec = new TextDecoder('shift_jis');
    var m0 = -1;
    for (var i = 1000; i < Math.min(u8.length - 4, 8000); i++) {
      if (u8[i] === 3 && u8[i + 1] === 0 && u8[i + 2] === 0 && u8[i + 3] === 0) { m0 = i; break; }
    }
    var layers = [];
    if (m0 < 0) return layers;
    var p = m0 - 28;
    while (p + 32 < u8.length) {
      var S = dv.getUint32(p, true);
      if (S < 8 || S > 400 || dv.getUint32(p + 28, true) !== 3) break;
      var end = p + 32;
      while (end < p + S && u8[end] !== 0) end++;
      layers.push(dec.decode(u8.subarray(p + 32, end)));
      p += S;
    }
    return layers;
  }
  // テキスト(座標つき)と線(座標つき)を読む
  function parse(buf) {
    buf = extractContents(buf);
    var u8 = new Uint8Array(buf), dv = new DataView(buf), n = u8.length;
    var dec = new TextDecoder('shift_jis');
    var texts = [], lines = [], cands = [], bodyById = {};
    for (var i = 52; i < n - 80; i++) {
      if (u8[i] === 0x38 && u8[i + 3] === 0x80 && dv.getInt32(i, true) === SIZE_LINE && dv.getInt32(i + 4, true) === 1) {
        var x1 = dv.getFloat64(i + 24, true), y1 = dv.getFloat64(i + 32, true);
        var x2 = dv.getFloat64(i + 40, true), y2 = dv.getFloat64(i + 48, true);
        if (Math.abs(x1) < 1e6 && Math.abs(y1) < 1e6 && Math.abs(x2) < 1e6 && Math.abs(y2) < 1e6) lines.push([x1, y1, x2, y2]);
      }
      var b1 = u8[i + 1];
      if (u8[i + 3] === 0 && b1 >= 1 && b1 <= 63 && u8[i + 2] === b1 * 2 && (u8[i] === 0 || okHeader(dv, i - 52))) {
        var rs = i - 52, val1 = dv.getInt32(i + 4, true), len = val1 - 8, st = i + 12;
        var tx = null;
        if (len > 0 && len <= 200 && st + len <= n) {
          var e = st; while (e < st + len && u8[e] !== 0) e++;
          if (e > st) tx = dec.decode(u8.subarray(st, e));
        }
        var rec = { text: tx, id: dv.getUint32(rs + 48, true), x: dv.getFloat64(rs + 4, true), y: dv.getFloat64(rs + 12, true) };
        if (tx !== null) { texts.push(rec); if (!(rec.id in bodyById)) bodyById[rec.id] = tx; } else cands.push(rec);
      }
    }
    cands.forEach(function (r) { if (r.id in bodyById) { r.text = bodyById[r.id]; texts.push(r); } });
    texts = texts.filter(function (t) { return t.text && t.text.trim() !== ''; });
    texts.forEach(function (t) { t.text = t.text.trim(); });
    // 同じ文字・同じ位置の重複を除く
    var seen = {};
    texts = texts.filter(function (t) { var k = t.text + '@' + Math.round(t.x) + ',' + Math.round(t.y); if (seen[k]) return false; seen[k] = 1; return true; });
    // 同じ線の重複を除く
    var lseen = {};
    lines = lines.filter(function (l) {
      var a = [l[0], l[1], l[2], l[3]].map(function (v) { return Math.round(v * 10); });
      if (a[0] > a[2] || (a[0] === a[2] && a[1] > a[3])) a = [a[2], a[3], a[0], a[1]];
      var k = a.join(','); if (lseen[k]) return false; lseen[k] = 1; return true;
    });
    return { texts: texts, lines: lines, layers: readLayers(u8) };
  }

  // ---------- 小道具 ----------
  var RE_PLATE = /^(G?PL)-([0-9.]+)(x[0-9.]+)?$/;      // GPL-9 / PL-12 / PL-12x199
  // 板の符号: KG1・KGR63・KGEVG1(阪和)/ KK-5・PRG14(別の書き方)。小梁・継手などの名前(SB588・BJ35・PJ25・J588 など)は除く
  var RE_MARK = /^(?:KG[0-9A-Z]+|[A-Z]{2,4}-?[0-9]+[A-Z]?)$/;
  var RE_NOT_MARK = /^(?:SB|BJ|THJ?|TS?PJ|EPJ?|PJ|DCJ|GJ|CL|BT|BTJ?B?|RB|KB|BCR|BCP|SN|SM|SS|STK|TMCP)[0-9]/;
  var RE_SHAPE = /^([LC])-[0-9.]+x[0-9.x]+$/;           // L-50x50x6 / C-60x30x10x2.3
  var RE_FB = /^FB-([0-9.]+)x([0-9.]+)x([0-9.]+)$/;     // FB-6x65x255
  var RE_FUGO = /^[0-9]+G[0-9]+[A-Z]*$/;                // 2G2 / 3G1B
  var RE_DAI = /^([0-9]+)台$/;
  var RE_MAIN = /^S?H-[0-9]+(～[0-9]+)?x[0-9]+x[0-9.]+x[0-9.]+$/;
  var RE_ZUBAN = /^(?=[A-Z0-9-]*[A-Z])[A-Z0-9]+(?:-[A-Z0-9]+)+$/;   // B1M2G-001 / WR-2G-1
  var RE_JOINT = /J[0-9]/;                              // PJ25・TSPJ9・DCJ1・J588(継手・ボルト接合の部材)
  function near(a, b, dx, dy) { return Math.abs(a.x - b.x) <= dx && Math.abs(a.y - b.y) <= dy; }
  function dist(a, b) { return Math.hypot(a.x - b.x, a.y - b.y); }
  function thickOf(size) { var m = /-([0-9.]+)/.exec(size); return m ? parseFloat(m[1]) : 0; }
  function stripParen(s) { return s.replace(/^[(（]/, '').replace(/[)）]$/, ''); }

  // ---------- 図面全体の情報 ----------
  function titleInfo(texts) {
    var koji = '';
    texts.forEach(function (t) { if (/工事$/.test(t.text) && t.text.length > koji.length && !/^工事/.test(t.text)) koji = t.text; });
    var zuban = '', best = -Infinity;
    // 表題欄(右下)にあるもの。工事番号(26-11)・形鋼・板の表記は除く
    texts.forEach(function (t) { if (RE_ZUBAN.test(t.text) && !/^[0-9]+-[0-9]+$/.test(t.text) && !RE_PLATE.test(t.text) && !/^(?:S?H|BT|FB|L|C)-/.test(t.text)) { var s = t.x - t.y; if (s > best) { best = s; zuban = t.text; } } });
    // 工事番号(表題欄にある図面だけ。例 26-11)
    // 「工事番号」の文字は線で描かれていて読めない図面があるので、表題欄(図面の右下の隅)にある「26-11」の形の文字を使う
    var kojiNo = '', corner = -Infinity;
    texts.forEach(function (t) { corner = Math.max(corner, t.x - t.y); });
    var kc = texts.filter(function (t) { return /^[0-9]{2}-[0-9]{1,3}$/.test(t.text) && t.x - t.y > corner - 3000; }).sort(function (a, b) { return (b.x - b.y) - (a.x - a.y); })[0];
    if (kc) kojiNo = kc.text;
    return { koji: koji, zuban: zuban, kojiNo: kojiNo };
  }

  // 「製品名 符号 N台」の行。符号が無い行(現場付けの製品)は onSite に入れる
  // 製品名: B1M2GJ9・B1M2G001-1・2G21-W9・2G31-W内9 など(英字を含む、記号は - だけ。- の後ろは漢字も可=「内」「外」)
  var RE_PNAME = /^(?=[A-Z0-9-]*[A-Z])[A-Z0-9]+(?:-[A-Z0-9\u4E00-\u9FFF]+)*$/;
  function productRows(texts) {
    var rows = [], onSite = [];
    texts.forEach(function (t) {
      var m = RE_DAI.exec(t.text); if (!m) return;
      var same = texts.filter(function (u) { return Math.abs(u.y - t.y) < 15 && u.x < t.x && t.x - u.x < 6000; })
        .sort(function (a, b) { return b.x - a.x; });
      // 左隣の「N台」より左は別の製品
      var stop = same.find(function (u) { return RE_DAI.test(u.text); });
      if (stop) same = same.filter(function (u) { return u.x > stop.x; });
      var fugo = same.find(function (u) { return RE_FUGO.test(u.text); });
      var name = same.find(function (u) { return RE_PNAME.test(u.text) && !RE_FUGO.test(u.text) && !RE_MAIN.test(u.text) && (!fugo || u.x < fugo.x); });
      if (!name) return;
      var main = same.find(function (u) { return RE_MAIN.test(u.text) && u.x > name.x; });
      var rec = { name: name.text, fugo: fugo ? fugo.text : '', dai: parseInt(m[1], 10), x: name.x, xr: t.x, y: t.y, main: main ? main.text : '' };
      if (fugo) rows.push(rec); else onSite.push(rec);
    });
    return { rows: rows, onSite: onSite };
  }

  // 断面の見出し「A SEC」
  function sectionTitles(texts) {
    var out = [];
    texts.forEach(function (t) {
      if (t.text !== 'SEC') return;
      var l = texts.find(function (u) { return /^[A-Za-z]$/.test(u.text) && Math.abs(u.y - t.y) < 10 && t.x - u.x > 80 && t.x - u.x < 260; });
      if (l) out.push({ letter: l.text, x: l.x, y: t.y, sx: t.x });
    });
    return out;
  }
  // 断面図の中の表記がどの断面かを決める(見出しは図の下にある)
  // t.text があれば文字の中央(左端+文字数×18)で測る
  function sectionOf(t, titles) {
    var best = null, bs = Infinity, cx = t.x + (t.text ? 18 * t.text.length : 0);
    titles.forEach(function (s) {
      var dy = t.y - s.y, dx = Math.abs(cx - (s.x + s.sx) / 2);
      if (dy <= 0 || dy > 2600 || dx > 1900) return;
      var sc = dy + 2 * dx;
      if (sc < bs) { bs = sc; best = s; }
    });
    return best;
  }

  // 板の表記(GPL-9 と KG1 の組)。表記は引出線の上にあり、符号は線の下か線の端の近くにある。
  // 線(なければ表記の位置)と符号の中心の距離が近いもの同士を1対1で組にする。(めっき)は線の下にあればその板
  function plateLabels(texts, hlines) {
    function leader(s) {
      var c = hlines.filter(function (h) { return s.y - h.y >= 3 && s.y - h.y <= 40 && h.x0 <= s.x + 25 && h.x1 >= s.x + 25; })
        .sort(function (a, b) { return (s.y - a.y) - (s.y - b.y); });
      return c[0] || null;
    }
    function center(t) { return { x: t.x + 18 * t.text.length, y: t.y }; }
    function dSeg(p, h, s) {
      if (!h) return dist(p, s);
      var cx = Math.max(h.x0, Math.min(h.x1, p.x));
      return Math.hypot(p.x - cx, p.y - h.y);
    }
    var sizes = texts.filter(function (t) { return RE_PLATE.test(t.text); }).map(function (s) { return { t: s, h: leader(s) }; });
    var marks = texts.filter(function (t) { return RE_MARK.test(t.text) && !RE_NOT_MARK.test(t.text) && !RE_PLATE.test(t.text); });
    var mekkis = texts.filter(function (t) { return /めっき/.test(t.text); });
    var pairs = [];
    sizes.forEach(function (s) { marks.forEach(function (m) { var d = dSeg(center(m), s.h, s.t); if (d < 420) pairs.push({ s: s, m: m, d: d }); }); });
    pairs.sort(function (a, b) { return a.d - b.d; });
    var us = new Set(), um = new Set(), out = [];
    pairs.forEach(function (p) {
      if (us.has(p.s) || um.has(p.m)) return;
      us.add(p.s); um.add(p.m);
      var h = p.s.h, mek;
      if (h) mek = mekkis.some(function (k) { var dy = h.y - k.y; return (dy > 0 ? dy < 160 : -dy <= 155) && k.x >= h.x0 - 30 && k.x <= h.x1; });
      else mek = mekkis.some(function (k) { return dist(k, p.m) < 150; });
      out.push({ size: p.s.t.text, mark: p.m.text, x: p.m.x, y: p.m.y, sx: p.s.t.x, sy: p.s.t.y, mekki: mek });
    });
    return out;
  }

  // ---------- メイン ----------
  function extract(buf, fileName) {
    var P = parse(buf), T = P.texts, L = P.lines;
    var info = titleInfo(T);
    var titles = sectionTitles(T);
    var pr = productRows(T);
    // 製品の行を、図(立面図・平面図)ごとにまとめる。行の高さが近く(600以内)、横にも近い(5000以内)ものは同じ図。
    // 図の範囲: 縦 = 製品の行より上で、上の図の行まで。横 = 左右に並ぶ図の間で分け、右に断面図があればその手前まで
    var prods = pr.rows.slice().sort(function (a, b) { return b.y - a.y || a.x - b.x; });
    var views = [];
    // ただし同じ高さの行で、別の製品の「N台」より右にある製品は、左右に並ぶ別の図(図の間が5000より狭い図面がある。WR-2G-9)
    prods.forEach(function (p) {
      var v = views.find(function (v) {
        if (v.products.some(function (q) { return Math.abs(q.y - p.y) < 15 && (p.x > q.xr || q.x > p.xr); })) return false;
        return Math.abs(v.labelY - p.y) < 600 && p.x - v.xr < 5000 && v.x - p.xr < 5000;
      });
      if (v) { v.products.push(p); v.labelY = Math.min(v.labelY, p.y); v.labelTop = Math.max(v.labelTop, p.y); v.x = Math.min(v.x, p.x); v.xr = Math.max(v.xr, p.xr); }
      else views.push({ products: [p], labelY: p.y, labelTop: p.y, x: p.x, xr: p.xr });
    });
    views.forEach(function (v) {
      var above = views.filter(function (u) { return u !== v && u.labelY > v.labelTop + 600 && u.x < v.xr + 5000 && u.xr > v.x - 5000; });
      v.yMin = v.labelTop; v.yMax = above.length ? Math.min.apply(null, above.map(function (u) { return u.labelY; })) : Infinity;
      var row = views.filter(function (u) { return Math.abs(u.labelY - v.labelY) < 600; }).sort(function (a, b) { return a.x - b.x; });
      var i = row.indexOf(v);
      v.x0 = i > 0 ? (row[i - 1].xr + v.x) / 2 : -Infinity;
      v.x1 = i < row.length - 1 ? (v.xr + row[i + 1].x) / 2 : Infinity;
      titles.forEach(function (s) { if (s.y > v.yMin && s.y < v.yMax && s.x > v.xr) v.x1 = Math.min(v.x1, s.x - 1200); });
    });
    // 上の段から順、同じ段(高さの差600以内)は左から
    views.sort(function (a, b) { return Math.abs(a.labelY - b.labelY) >= 600 ? b.labelY - a.labelY : a.x - b.x; });
    var inView = function (v, o) { return o.y > v.yMin && o.y < v.yMax && o.x > v.x0 && o.x < v.x1; };
    var isLeft = function (o) { return views.some(function (v) { return inView(v, o); }); };

    // 断面の副題「(EV鉄骨取合)」
    titles.forEach(function (s) {
      var sub = T.find(function (t) { return s.y - t.y > 60 && s.y - t.y < 320 && Math.abs(t.x - (s.x + s.sx) / 2) < 400 && !/^[A-Za-z]$/.test(t.text) && t.text !== 'SEC'; });
      s.sub = sub ? stripParen(sub.text) : '';
    });

    // 断面ごとの板の表記・形鋼の表記・継手の表記・寸法の数字
    var vlines = L.filter(function (l) { return Math.abs(l[0] - l[2]) < 0.5 && Math.abs(l[1] - l[3]) > 20; })
      .map(function (l) { return { x: l[0], y0: Math.min(l[1], l[3]), y1: Math.max(l[1], l[3]) }; });
    var hlines = L.filter(function (l) { return Math.abs(l[1] - l[3]) < 0.5 && Math.abs(l[0] - l[2]) > 20; })
      .map(function (l) { return { y: l[1], x0: Math.min(l[0], l[2]), x1: Math.max(l[0], l[2]) }; });
    var labels = plateLabels(T, hlines);
    var secInfo = {};
    titles.forEach(function (s) { secInfo[s.letter] = { title: s, plates: {}, plateT: new Set(), shapes: [], joint: false, dims: [], nested: [] }; });
    var elevLabels = [];
    labels.forEach(function (lb) {
      if (isLeft(lb) && isLeft({ x: lb.sx, y: lb.sy })) { elevLabels.push(lb); return; }
      var s = sectionOf({ x: lb.x, y: lb.y, text: lb.mark }, titles); if (!s) return;
      var si = secInfo[s.letter];
      si.plates[lb.mark] = si.plates[lb.mark] || { size: lb.size, n: 0, mekki: false };
      si.plates[lb.mark].n++;
      si.plateT.add(thickOf(lb.size));
      if (lb.mekki) si.plates[lb.mark].mekki = true;
    });
    T.forEach(function (t) {
      if (isLeft(t)) return;
      var s = sectionOf(t, titles); if (!s) return;
      var si = secInfo[s.letter];
      if (RE_SHAPE.test(t.text)) si.shapes.push(t.text);
      if (RE_JOINT.test(t.text) && /^[A-Z]+J[0-9]/.test(t.text)) si.joint = true;
      if (/^[0-9]+$/.test(t.text) && parseInt(t.text, 10) >= 100) si.dims.push(parseInt(t.text, 10));
      // 断面図の中の断面記号(例: C断面の中の E)
      if (/^[A-Za-z]$/.test(t.text) && secInfo[t.text] && t.text !== s.letter && !titles.some(function (x) { return x.letter === t.text && Math.abs(x.y - t.y) < 10; })) si.nested.push(t.text);
    });

    // 旗(断面記号): 文字の右に縦線(長さ250〜450)がある
    // 旗の縦線(梁が傾いた図面では少し傾いている。傾き2割まで。WR-2G-9 は勾配12.9%)
    var flagLines = L.filter(function (l) { var dx = Math.abs(l[0] - l[2]), dy = Math.abs(l[1] - l[3]); return dy > 200 && dy < 500 && dx <= dy * 0.2; })
      .map(function (l) { return { x: (l[0] + l[2]) / 2, y0: Math.min(l[1], l[3]), y1: Math.max(l[1], l[3]) }; });
    function flagLineX(t) {
      var c = flagLines.filter(function (v) { return v.x - t.x > 50 && v.x - t.x < 180 && v.y0 <= t.y + 20 && v.y1 >= t.y; });
      return c.length ? c[0].x : null;
    }

    var excluded = new Set();
    if (pr.onSite.length || T.some(function (t) { return /現場付/.test(t.text); })) excluded.add('現場付けの製品');
    if (T.some(function (t) { return /フィラー/.test(t.text); })) excluded.add('フィラーPL');
    if (T.some(function (t) { return /吊り?ピース/.test(t.text); })) excluded.add('吊りピース');
    if (T.some(function (t) { return /ネット受け|^K8\s*[(（]/.test(t.text); })) excluded.add('ネット受けピース');
    if (T.some(function (t) { return /サヤ管/.test(t.text); })) excluded.add('サヤ管');
    if (T.some(function (t) { return /^G?J[0-9]+[A-Z]?$/.test(t.text) || /スプライス/.test(t.text); })) excluded.add('スプライスPL');

    var fbDims = [];
    T.forEach(function (t) { var m = RE_FB.exec(t.text); if (m) { var k = m[1] + 'x' + m[2] + 'x' + m[3]; if (!fbDims.some(function (f) { return f.key === k; })) fbDims.push({ key: k, t: m[1], w: parseFloat(m[2]), l: parseFloat(m[3]) }); } });

    var result = { fileName: fileName || '', koji: info.koji, kojiNo: info.kojiNo, zuban: info.zuban, products: [], excluded: [], warnings: [] };

    views.forEach(function (v) {
      var items = {};   // key → {size, name, n, notes:Set}
      function add(size, name, n, note) {
        var k = size + '|' + name;
        items[k] = items[k] || { size: size, name: name, n: 0, notes: [] };
        items[k].n += n;
        if (note !== undefined) items[k].notes.push(note);
      }
      // 本体の鋼材(左に「B」の文字があるもの=柱側のブラケットは除く)
      var mains = T.filter(function (t) { return inView(v, t) && RE_MAIN.test(t.text) && !T.some(function (u) { return u.text === 'B' && Math.abs(u.y - t.y) < 15 && t.x - u.x > 0 && t.x - u.x < 300; }); });
      var main = (v.products[0] && v.products[0].main) || (mains[0] ? mains[0].text : '');
      var depth = main ? parseFloat(/H-([0-9]+)/.exec(main)[1]) : 0;
      // 長さ: 寸法の行で「10」(柱との隙間)2つの間にある一番大きい数。梁が傾いていると寸法の行も傾くので、2つの「10」を結ぶ線のそばで探す
      var length = 0;
      var tens = T.filter(function (t) { return inView(v, t) && t.text === '10'; });
      tens.forEach(function (a) {
        // 右で一番近い「10」(傾き2割以内)だけを相手にする(通り芯の番号「10」と組にしない)
        var b = tens.filter(function (c) { return c.x > a.x + 1000 && Math.abs(c.y - a.y) <= (c.x - a.x) * 0.2; }).sort(function (p, q) { return p.x - q.x; })[0];
        if (!b) return;
        T.forEach(function (u) {
          if (!inView(v, u) || !/^[0-9]+(\.[0-9]+)?$/.test(u.text) || u.x <= a.x || u.x >= b.x) return;
          var yl = a.y + (b.y - a.y) * (u.x - a.x) / (b.x - a.x);
          if (Math.abs(u.y - yl) < 40) { var n = parseFloat(u.text); if (n > length && n < 30000) length = n; }
        });
      });

      // 立面図の梁(フランジの線の間隔=梁成)
      var elev = null;
      if (depth) {
        var longH = hlines.filter(function (h) { return inView(v, { x: (h.x0 + h.x1) / 2, y: h.y }) && h.x1 - h.x0 > 3000; });
        for (var i = 0; i < longH.length && !elev; i++) for (var j = 0; j < longH.length; j++) {
          var a = longH[i], b = longH[j];
          if (Math.abs(a.y - b.y - depth) < 1.5 && Math.min(a.x1, b.x1) - Math.max(a.x0, b.x0) > 2000) { elev = { top: a.y, bot: b.y, x0: Math.max(a.x0, b.x0), x1: Math.min(a.x1, b.x1) }; break; }
        }
      }
      // 立面図の梁が見つからない(傾いた梁など)ときは、旗の数×断面の表記の数で数える(お知らせは出さない。2026-11-19)

      // 立面図で、梁の中に描かれた板(縦線の組。間隔=板厚)
      var positions = [];
      if (elev) {
        var inner = vlines.filter(function (l) {
          if (l.x < elev.x0 || l.x > elev.x1) return false;
          var ov = Math.min(l.y1, elev.top) - Math.max(l.y0, elev.bot);
          return ov > (elev.top - elev.bot) * 0.5 && l.y1 - l.y0 < (elev.top - elev.bot) * 2;
        }).sort(function (a, b) { return a.x - b.x; });
        var groups = [];
        inner.forEach(function (l) { var g = groups[groups.length - 1]; if (g && l.x - g.x1 <= 20) g.x1 = l.x; else groups.push({ x0: l.x, x1: l.x }); });
        groups.forEach(function (g) { var t = g.x1 - g.x0; if (t >= 4 && t <= 40) positions.push({ x: (g.x0 + g.x1) / 2, t: t, secs: [] }); });
        // 150以内の板は同じ場所(例: 小梁2本の取合い)
        var merged = [];
        positions.forEach(function (p) { var m = merged[merged.length - 1]; if (m && p.x - m.xs[m.xs.length - 1] < 150) { m.xs.push(p.x); m.ts.push(p.t); } else merged.push({ xs: [p.x], ts: [p.t], secs: [] }); });
        positions = merged.map(function (m) { return { x: m.xs[0], x1: m.xs[m.xs.length - 1], ts: m.ts, secs: [] }; });
      }
      function tMatch(p, set) { return p.ts.some(function (t) { return Array.from(set).some(function (u) { return Math.abs(t - u) <= 1.6; }); }); }

      // 旗 → 場所。旗は左向き(左の板を見る)を優先し、板厚が断面の表記と合う板だけ
      var flagsBySec = {};
      T.forEach(function (t) {
        if (!inView(v, t) || !/^[A-Za-z]$/.test(t.text) || !secInfo[t.text]) return;
        var fx = flagLineX(t); if (fx === null) return;
        var si = secInfo[t.text];
        flagsBySec[t.text] = flagsBySec[t.text] || { matched: [], unmatched: 0 };
        var hit = null;
        if (si.plateT.size && positions.length) {
          var cand = positions.filter(function (p) { return tMatch(p, si.plateT); });
          var left = cand.filter(function (p) { return p.x1 <= fx && fx - p.x1 <= 800; }).sort(function (a, b) { return b.x1 - a.x1; })[0];
          var right = cand.filter(function (p) { return p.x >= fx && p.x - fx <= 400; }).sort(function (a, b) { return a.x - b.x; })[0];
          hit = left || right || null;
        }
        if (hit) { if (hit.secs.indexOf(t.text) < 0) hit.secs.push(t.text); if (flagsBySec[t.text].matched.indexOf(hit) < 0) flagsBySec[t.text].matched.push(hit); }
        else flagsBySec[t.text].unmatched++;
      });
      // 旗の無い板 → 同じ板厚で旗のある場所の断面を引き継ぐ
      positions.forEach(function (p) {
        if (p.secs.length) return;
        var same = positions.filter(function (q) { return q.secs.length && q.ts.length === p.ts.length && q.ts.every(function (t, i) { return Math.abs(t - p.ts[i]) <= 1.6; }); });
        if (same.length) p.secs = same[0].secs.slice();
      });

      // 板の数
      // 同じ場所を描いた断面(letters)の板を足す。各符号は、それを描いた断面の中で一番少ない枚数
      function addSecPlatesOnce(letters, mult) {
        var marks = {};
        letters.forEach(function (L1) {
          var si = secInfo[L1]; if (!si) return;
          Object.keys(si.plates).forEach(function (m) {
            var p = si.plates[m];
            if (!(m in marks)) marks[m] = { size: p.size, n: p.n, notes: [] };
            else if (p.n < marks[m].n) marks[m].n = p.n;
            marks[m].notes.push((si.title.sub || '') + (p.mekki ? '|めっき' : ''));
          });
        });
        Object.keys(marks).forEach(function (m) {
          var x = marks[m];
          add(x.size, m, x.n * mult);
          var it = items[x.size + '|' + m]; x.notes.forEach(function (nt) { it.notes.push(nt); });
        });
      }
      positions.forEach(function (p) { if (p.secs.length) addSecPlatesOnce(p.secs, 1); });
      var secCount = {};   // 断面ごとの場所の数(入れ子の断面の数に使う)
      Object.keys(flagsBySec).forEach(function (L1) {
        var f = flagsBySec[L1];
        secCount[L1] = f.matched.length + f.unmatched;
        if (f.unmatched) addSecPlatesOnce([L1], f.unmatched);
      });
      // 断面図の中の断面記号(例: C断面の中の E断面)
      Object.keys(secInfo).forEach(function (L1) {
        secInfo[L1].nested.forEach(function (N) { if (secCount[L1]) addSecPlatesOnce([N], secCount[L1]); });
      });
      // 立面図に直接書かれた板の表記(例: PL-12 / KGR64)
      elevLabels.forEach(function (lb) { if (inView(v, lb)) add(lb.size, lb.mark, 1, ''); });

      // FB: 表記の寸法の□(長さ×幅)を数える。梁が傾いていると□も傾くので、向きを問わず「長さLの平行な2本の線が幅Wだけ離れている」組を数える
      fbDims.forEach(function (fb) {
        var ls = L.filter(function (l) { return Math.abs(Math.hypot(l[2] - l[0], l[3] - l[1]) - fb.l) < 0.6 && inView(v, { x: (l[0] + l[2]) / 2, y: (l[1] + l[3]) / 2 }); });
        var cnt = 0, used = new Set();
        ls.forEach(function (a) {
          if (used.has(a)) return;
          var ux = (a[2] - a[0]) / fb.l, uy = (a[3] - a[1]) / fb.l, mx = (a[0] + a[2]) / 2, my = (a[1] + a[3]) / 2;
          var b = ls.find(function (c) {
            if (c === a || used.has(c)) return false;
            var vx = (c[2] - c[0]) / fb.l, vy = (c[3] - c[1]) / fb.l;
            if (Math.abs(ux * vy - uy * vx) > 0.01) return false;              // 平行
            var cx = (c[0] + c[2]) / 2 - mx, cy = (c[1] + c[3]) / 2 - my;
            var along = cx * ux + cy * uy, across = Math.abs(cx * uy - cy * ux);
            return Math.abs(along) < 1 && Math.abs(across - fb.w) < 0.8;
          });
          if (b) { used.add(a); used.add(b); cnt++; }
        });
        if (cnt) add('FB-' + fb.t + 'x' + fb.w, fb.l, cnt, 'デッキ受け');
      });

      // 形鋼の受材(継手の表記がある断面=別の部材は除く)
      var doneShape = {};
      Object.keys(secInfo).forEach(function (L1) {
        var si = secInfo[L1];
        if (!si.shapes.length || si.joint) return;
        Array.from(new Set(si.shapes)).forEach(function (shape) {
          if (doneShape[shape]) return;
          if (shape.charAt(0) === 'L' && elev && flagsBySec[L1]) {
            doneShape[shape] = 1;
            // 山形鋼: 立面図の梁の中で、同じ高さに3本以上並ぶ水平の線
            var segs = hlines.filter(function (h) { return h.x0 >= elev.x0 - 1 && h.x1 <= elev.x1 + 1 && h.y < elev.top + 450 && h.y > elev.bot && h.x1 - h.x0 >= 100 && h.x1 - h.x0 <= 1000; });
            var rows = {};
            segs.forEach(function (h) { var k = h.y.toFixed(1); (rows[k] = rows[k] || []).push(h); });
            Object.keys(rows).forEach(function (k) {
              var r = rows[k]; if (r.length < 3) return;
              var seen = {};
              r.forEach(function (h) { var kk = h.x0.toFixed(0) + '-' + h.x1.toFixed(0); if (seen[kk]) return; seen[kk] = 1; add(shape, Math.round(h.x1 - h.x0), 1, si.title.sub || ''); });
            });
          } else if (shape.charAt(0) === 'C') {
            // 溝形鋼: 平面図で、断面の寸法と同じ長さの縦線の組
            si.dims.forEach(function (len) {
              if (doneShape[shape + '@' + len]) return; doneShape[shape + '@' + len] = 1;
              var vs = vlines.filter(function (l) { return inView(v, { x: l.x, y: (l.y0 + l.y1) / 2 }) && Math.abs(l.y1 - l.y0 - len) < 0.6; }).sort(function (a, b) { return a.x - b.x; });
              var used = new Set(), cnt = 0;
              vs.forEach(function (a) { if (used.has(a)) return; var b = vs.find(function (l) { return l !== a && !used.has(l) && l.x - a.x > 0 && l.x - a.x <= 40 && Math.abs(l.y0 - a.y0) < 0.6; }); if (b) { used.add(a); used.add(b); cnt++; } });
              if (cnt) add(shape, len, cnt, si.title.sub || '');
            });
          }
        });
      });

      var list = Object.keys(items).map(function (k) {
        var it = items[k];
        var subs = new Set(), mekki = false;
        it.notes.forEach(function (nt) { var p = nt.split('|'); subs.add(p[0]); if (p[1]) mekki = true; });
        var parts = [];
        if (subs.size === 1 && Array.from(subs)[0]) parts.push(Array.from(subs)[0]);
        if (mekki) parts.push('めっき');
        return { size: it.size, name: it.name, n: it.n, note: parts.join('・') };
      });
      v.products.forEach(function (p) {
        result.products.push({ view: views.indexOf(v), zuban: info.zuban, name: p.name, fugo: p.fugo, dai: p.dai, size: main, length: length, y: p.y, x: p.x,
          items: list.map(function (it) { return { size: it.size, name: it.name, n: it.n, note: it.note }; }) });
      });
    });
    // 図面の上段の図から順(チェックしやすい)。同じ図の製品は製品名の番号順(GJ9→GJ10→GJ12)
    result.products.sort(function (a, b) { return a.view - b.view || cmpNat(a.name, b.name); });
    result.excluded = Array.from(excluded);
    return result;
  }

  // ---------- 並べ替え(Excel・画面共通) ----------
  function kindOf(size) { return /^GPL-/.test(size) ? 'GPL' : (/^PL-/.test(size) ? 'PL' : 'STEEL'); }
  function natKey(v) { return String(v).match(/\d+|\D+/g).map(function (t) { return /^\d+$/.test(t) ? [0, parseInt(t, 10)] : [1, t]; }); }
  function cmpNat(a, b) {
    var x = natKey(a), y = natKey(b);
    for (var i = 0; i < Math.min(x.length, y.length); i++) {
      if (x[i][0] !== y[i][0]) return x[i][0] - y[i][0];
      if (x[i][1] < y[i][1]) return -1; if (x[i][1] > y[i][1]) return 1;
    }
    return x.length - y.length;
  }
  var KORD = { GPL: 0, PL: 1, STEEL: 2 };
  function cmpItem(a, b) {
    var ka = kindOf(a.size), kb = kindOf(b.size);
    if (ka !== kb) return KORD[ka] - KORD[kb];
    if (ka === 'STEEL') {
      var fa = /^FB-/.test(a.size) ? 0 : 1, fb = /^FB-/.test(b.size) ? 0 : 1;
      if (fa !== fb) return fa - fb;
      if (a.size !== b.size) return a.size < b.size ? -1 : 1;
      return cmpNat(a.name, b.name);
    }
    var ta = thickOf(a.size), tb = thickOf(b.size);
    if (ta !== tb) return ta - tb;
    if (a.size !== b.size) return a.size < b.size ? -1 : 1;
    return cmpNat(a.name, b.name);
  }

  var api = { parse: parse, extract: extract, kindOf: kindOf, cmpItem: cmpItem, cmpNat: cmpNat };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else root.KanamonoExtract = api;
})(typeof window !== 'undefined' ? window : this);
