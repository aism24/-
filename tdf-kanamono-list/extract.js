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
        if (Math.abs(x1) < 1e6 && Math.abs(y1) < 1e6 && Math.abs(x2) < 1e6 && Math.abs(y2) < 1e6) lines.push([x1, y1, x2, y2, u8[i + 10]]);   // 5つ目 = レイヤの番号(レイヤ名の表の並び順+1。2026-11-20、1G-01 で確認)
      }
      var b1 = u8[i + 1];
      if (u8[i + 3] === 0 && b1 >= 1 && b1 <= 63 && u8[i + 2] === b1 * 2 && (u8[i] === 0 || okHeader(dv, i - 52))) {
        var rs = i - 52, val1 = dv.getInt32(i + 4, true), len = val1 - 8, st = i + 12;
        var tx = null;
        if (len > 0 && len <= 200 && st + len <= n) {
          var e = st; while (e < st + len && u8[e] !== 0) e++;
          if (e > st) tx = dec.decode(u8.subarray(st, e));
        }
        // lay = 文字のレイヤの番号(記録の10バイト前。その2バイト前が 1 のときだけ。線と同じくレイヤ名の表の並び順+1。2026-11-20、EB1-0C-04 の GEN で確認)
        var rec = { text: tx, id: dv.getUint32(rs + 48, true), x: dv.getFloat64(rs + 4, true), y: dv.getFloat64(rs + 12, true), lay: rs >= 12 && u8[rs - 12] === 1 ? u8[rs - 10] : -1 };
        if (tx !== null) { texts.push(rec); if (!(rec.id in bodyById)) bodyById[rec.id] = tx; } else cands.push(rec);
      }
    }
    cands.forEach(function (r) { if (r.id in bodyById) { r.text = bodyById[r.id]; texts.push(r); } });
    texts = texts.filter(function (t) { return t.text && t.text.trim() !== ''; });
    // 文字は全角・半角を区別しない(ＰＬ－９ も PL-9)。読んだ文字はすべて半角にそろえてから判別・出力する(NFKC。2026-11-19 ユーザー指示)
    texts.forEach(function (t) { t.text = t.text.normalize('NFKC').trim(); });
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
  var RE_PLATE = /^(?:[0-9]+)?(G?PL)-([0-9.]+)((?:x[0-9.]+){0,2})$/;      // GPL-9 / PL-12 / PL-12x199 / PL-9x456x456(1G-01) / 2PL-9(2枚)
  // 断面の記号: A・B…(英字1文字)、ア・イ…(カタカナ1文字)、DK1…(英字+数字)。2026-11-19、2G-01(C断面の中にア・イ・ウ、アの中にエ)
  var RE_SECKEY = /^(?:[A-Za-z]|[ァ-ヶ]|[ぁ-ゖ]|[A-Z]{1,3}[0-9]{1,2})$/;   // ひらがな(「あ SEC」LGS下地。EA1-3G-01)は 2026-11-20
  // 「2PL-9」の 2 = 枚数。無ければ1枚
  function plateCount(t) { var m = /^([0-9]+)(?=G?PL-)/.exec(t); return m ? parseInt(m[1], 10) : 1; }
  function plateSize(t) { return t.replace(/^[0-9]+(?=G?PL-)/, ''); }
  // 板の符号: KG1・KGR63・KGEVG1(阪和)/ KK-5・PRG14(別の書き方)。小梁・継手などの名前(SB588・BJ35・PJ25・J588 など)は除く
  // 「MGR156切断流用」(別の板を切って使う。2026-11-21 WB1-3G-06 の す断面)も符号
  // 番号のあとの「MK」(めっき+K)も符号(2026-11-21、EA1-RG-01 の「GPL-25 NHG143MK」)
  // 「NG-D1」(腰折れの梁のダイアフラム。2026-11-21 ユーザー指示、EA1-RG-05)= 英字2〜5文字-英字1文字+番号
  var RE_MARK = /^(?:KG[0-9A-Z]+|[A-Z]{2,5}-?[0-9]+(?:M[A-Z]|[A-Z])?|[A-Z]{2,5}-[A-Z][0-9]+|[A-Z]-[A-Z]{1,4}[0-9]+[A-Z]?)(?:切断流用)?$/;   // OGALR7(英字5文字。2026-11-19)・O-KZ109(1G-01)
  var RE_NOT_MARK = /^(?:SB|BJ|THJ?|TS?PJ|EPJ?|PJ|DCJ|GJ|CL|BT|BTJ?B?|RB|KB|BCR|BCP|SN|SM|SS|STK|TMCP|EHB)[0-9]/;   // EHB250 = EV の梁の名前(2026-11-21、WB3-3G-12)
  var RE_SHAPE = /^([LC])-[0-9.]+x[0-9.x]+$/;           // L-50x50x6 / C-60x30x10x2.3
  var RE_CHAN = /^\[-[0-9.]+x[0-9.x]+$/;                // [-100x50x5x7.5(溝形鋼の別の書き方。断面図の表記だけで使う。2026-11-21 WB1-3G-05)
  var RE_FB = /^FB-([0-9.]+)x([0-9.]+)x([0-9.]+)$/;     // FB-6x65x255
  var RE_FUGO = /^[0-9]+G[0-9]+[A-Z]*$/;                // 2G2 / 3G1B
  var RE_DAI = /^([0-9]+)台$/;
  var RE_MAIN = /^S?H-[0-9]+([～~][0-9]+)?x[0-9]+x[0-9.]+x[0-9.]+$/;
  var RE_ZUBAN = /^(?=[A-Z0-9-]*[A-Z])[A-Z0-9]+(?:-[A-Z0-9]+)+$/;   // B1M2G-001 / WR-2G-1
  var RE_JOINT = /J[0-9]/;                              // PJ25・TSPJ9・DCJ1・J588(継手・ボルト接合の部材)
  function dist(a, b) { return Math.hypot(a.x - b.x, a.y - b.y); }
  function thickOf(size) { var m = /-([0-9.]+)/.exec(size); return m ? parseFloat(m[1]) : 0; }
  function stripParen(s) { return s.replace(/^[(（]/, '').replace(/[)）]$/, ''); }

  // ---------- 図面全体の情報 ----------
  function titleInfo(texts) {
    var koji = '';
    texts.forEach(function (t) { if (/工事$/.test(t.text) && t.text.length > koji.length && !/^工事/.test(t.text)) koji = t.text; });
    // 「〜工事」が無い図面(2026-11-20、EA1-3G-01 等の阪和の表題欄): 見出し「工事名称」(1文字ずつ・または続けて)の下に書かれた値を工事名にする。
    // 値 = 見出しの左端-200より右・見出しの下600以内の文字のうち、見出しに一番近いもの(見出しの文字・「図面番号」などの見出しは除く)
    if (!koji) {
      var heads = [];
      texts.forEach(function (t) {
        if (t.text === '工事名称') heads.push({ x: t.x, y: t.y, x1: t.x + 400 });
        if (t.text !== '工') return;
        var seq = ['事', '名', '称'], cur = t, ok = true;
        seq.forEach(function (ch) { if (!ok) return; var n = texts.find(function (u) { return u.text === ch && Math.abs(u.y - cur.y) < 5 && u.x > cur.x && u.x - cur.x < 200; }); if (n) cur = n; else ok = false; });
        if (ok) heads.push({ x: t.x, y: t.y, x1: cur.x });
      });
      heads.forEach(function (h) {
        if (koji) return;
        var c = texts.filter(function (u) { return u.text.length > 1 && u.y < h.y - 30 && h.y - u.y < 600 && u.x > h.x - 200 && u.x < h.x1 + 3000 && !/名称|番号/.test(u.text); })
          .sort(function (p, q) { return (h.y - p.y) + Math.abs(p.x - h.x) * 0.2 - ((h.y - q.y) + Math.abs(q.x - h.x) * 0.2); })[0];
        if (c) koji = c.text;
      });
    }
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
  // 製品名: B1M2GJ9・B1M2G001-1・2G21-W9 など(英字を含む、記号は - だけ)
  var RE_PNAME = /^(?=[A-Z0-9-]*[A-Z])[A-Z0-9]+(?:-[A-Z0-9]+)*$/;
  function productRows(texts, lines) {
    var rows = [], onSite = [], pending = [];
    texts.forEach(function (t) {
      var m = RE_DAI.exec(t.text); if (!m) return;
      var same = texts.filter(function (u) { return Math.abs(u.y - t.y) < 15 && u.x < t.x && t.x - u.x < 6000; })
        .sort(function (a, b) { return b.x - a.x; });
      // 左隣の「N台」より左は別の製品
      var stop = same.find(function (u) { return RE_DAI.test(u.text); });
      if (stop) same = same.filter(function (u) { return u.x > stop.x; });
      var fugo = same.find(function (u) { return RE_FUGO.test(u.text); });
      var name = same.find(function (u) { return RE_PNAME.test(u.text) && !RE_FUGO.test(u.text) && !RE_MAIN.test(u.text) && (!fugo || u.x < fugo.x); });
      if (!name) {
        // 上の読み方で製品名が見つからない行は、tdf-master-web(製品情報の抽出)と同じ読み方で読み直す(2026-11-19)
        var mw = masterWebRow(same, t, parseInt(m[1], 10));
        if (mw) rows.push(mw); else pending.push({ dai: t, n: parseInt(m[1], 10), same: same, onSite: null });
        return;
      }
      // 同じ高さに符号が無い行は、現場付けとする前に、tdf-master-web と同じ読み方(下の pending)で読み直す(2026-11-20)
      // 本体: H形鋼の表記。無ければ組立H(BH-)・SH(tdf-master-web のサイズの形)も本体とする(2026-11-20、EA1-3G-01 の BH-1300x450x25x40)
      var main = same.find(function (u) { return RE_MAIN.test(u.text) && u.x > name.x; }) ||
        same.find(function (u) { return /^(BH|SH|H)-[0-9]+x[0-9]+x[0-9.]+x[0-9.]+$/.test(u.text) && u.x > name.x; });
      var rec = { name: name.text, fugo: fugo ? fugo.text : '', dai: parseInt(m[1], 10), x: name.x, xr: t.x, y: t.y, main: main ? main.text : '' };
      if (fugo) rows.push(rec); else pending.push({ dai: t, n: rec.dai, same: same, onSite: rec });
    });
    // 読めなかった行は tdf-master-web と同じ順で読み直す(2026-11-20): ① 複数行で設計符号・サイズを共有する表(find_product_rows_shared_group)
    // → ② 製品マーク・設計符号・サイズが上下にずれた行(find_product_rows_offset_mark)。どちらでも読めなければ、製品名があれば現場付け
    var xm = xMarks(lines || []);
    var inX = function (x, y) { return xm.some(function (b) { return x >= b[0] && x <= b[1] && y >= b[2] && y <= b[3]; }); };
    // ×印で消した表の行は、ふつうに読めた行でも除く(2026-11-21 ユーザー指摘「E,F断面が読めていない?」、WB3-3G-10: 3G-X11Y5 の表を大きな×で消して
    // 「WB3-3G-12図へ移動」。製品として読み、D・E・F断面(EV)の板をその製品の立面図の板にしていた)
    rows = rows.filter(function (r) { return !(inX(r.x, r.y) && inX(r.xr, r.y)); });
    // ⓪ 柱の表「設計符号 | 製品マーク | 図示 | N台」(tdf-master-web の柱モード find_rows と同じ。2026-11-20、EB1-0C-04「C1B|HRB130|0C-X16Y3|図示|1台」):
    //    「N台」の左の3つ。3つ目が「図示」なら、図の中の「□-」のサイズの文字のすぐ上に書かれている方が設計符号(どちらにも無ければ並びのとおり 左=設計符号)
    var boxes = texts.filter(function (u) { return /^□\s*[-‐]?\s*[0-9.]+\s*[xX×]\s*[0-9.]+/.test(u.text); });
    var sizeLabels = new Set();
    boxes.forEach(function (r) { texts.forEach(function (q) { if (q !== r && q.y - r.y > 0 && q.y - r.y <= 300 && Math.abs(q.x - r.x) <= 450) sizeLabels.add(q.text); }); });
    pending.forEach(function (p) {
      var left = p.same.slice().reverse();   // 左から
      var cells = left.slice(-3);
      if (cells.length < 3 || cells[2].text.replace(/\s/g, '') !== '図示') return;
      var a = cells[0], b = cells[1], code = a, mark = b;
      if (!(sizeLabels.has(a.text) || !sizeLabels.has(b.text))) { code = b; mark = a; }
      p.done = true;
      if (inX(mark.x, mark.y) || inX(p.dai.x, p.dai.y)) return;
      rows.push({ name: mark.text, fugo: code.text, dai: p.n, x: Math.min(a.x, b.x), xr: p.dai.x, y: p.dai.y, main: boxes.length ? boxes[0].text : '', column: true });
    });
    var groups = {};
    pending.forEach(function (p) {
      if (p.done) return;
      var mk = p.same.filter(function (u) { return !RE_DAI.test(u.text); })[0];   // same は右から並ぶ → 一番右 = 製品マーク
      if (!mk || (p.same.length >= 3 && RE_MW_SIZE.test(p.same[0].text))) return;
      p.mark = mk;
      var k = mk.x.toFixed(1) + '|' + p.dai.x.toFixed(1);
      (groups[k] = groups[k] || []).push(p);
    });
    Object.keys(groups).forEach(function (k) {
      var g = groups[k].sort(function (a, b) { return a.dai.y - b.dai.y; }), clusters = [[g[0]]];
      g.slice(1).forEach(function (p) { var c = clusters[clusters.length - 1]; if (p.dai.y - c[c.length - 1].dai.y > 3000) clusters.push([p]); else c.push(p); });
      clusters.forEach(function (c) {
        var mx = c[0].mark.x, dx = c[0].dai.x, ys = c.map(function (p) { return p.dai.y; });
        var lo = Math.min.apply(null, ys) - 2, hi = Math.max.apply(null, ys) + 2;
        var line = texts.filter(function (u) { return u.x > mx && u.x < dx && u.y >= lo && u.y <= hi; }).sort(function (a, b) { return a.x - b.x; });
        if (line.length < 2) return;
        var size = line[line.length - 1], code = line[line.length - 2];
        if (!RE_MW_SIZE.test(size.text)) return;
        c.forEach(function (p) {
          p.done = true;
          if (inX(p.mark.x, p.mark.y) || inX(p.dai.x, p.dai.y)) return;   // ×印で消した行
          rows.push({ name: p.mark.text, fugo: code.text, dai: p.n, x: p.mark.x, xr: p.dai.x, y: p.dai.y, main: size.text });
        });
      });
    });
    pending.forEach(function (p) {
      if (p.done) return;
      var om = offsetMarkRow(texts, p.dai, p.n);
      if (om && !inX(om.x, om.y) && !inX(om.xr, om.y)) rows.push(om);
      else if (!om && p.onSite) onSite.push(p.onSite);
    });
    return { rows: rows, onSite: onSite };
  }
  // ×印(削除マーク)の範囲 [x0, x1, y0, y1]: 同じ長方形の対角線になる斜めの線2本(tdf-master-web の find_x_marks と同じ。角の誤差2)
  function xMarks(lines) {
    var diag = lines.filter(function (l) { var a = Math.atan2(l[3] - l[1], l[2] - l[0]) * 180 / Math.PI; a = ((a % 180) + 180) % 180; return !(a < 5 || a > 175 || Math.abs(a - 90) < 5); });
    var used = new Set(), out = [], close = function (p, q) { return Math.abs(p[0] - q[0]) < 2 && Math.abs(p[1] - q[1]) < 2; };
    diag.forEach(function (a, i) {
      if (used.has(i)) return;
      var c1 = [a[0], a[3]], c2 = [a[2], a[1]];
      for (var j = i + 1; j < diag.length; j++) {
        if (used.has(j)) continue;
        var b = diag[j], p = [b[0], b[1]], q = [b[2], b[3]];
        if ((close(p, c1) && close(q, c2)) || (close(p, c2) && close(q, c1))) {
          used.add(i); used.add(j);
          out.push([Math.min(a[0], a[2]), Math.max(a[0], a[2]), Math.min(a[1], a[3]), Math.max(a[1], a[3])]);
          break;
        }
      }
    });
    return out;
  }

  // tdf-master-web の find_product_rows と同じ読み方(index.html の py-tdf-master-extractor):
  // 「N台」の左の直近3つを、左から 製品マーク・設計符号・サイズ とみなす。サイズだけは形で確かめる(SIZE_PATTERN)。
  // 設計符号とサイズの間に1文字の書き込みがあれば飛ばす。製品マークの文字の形は問わない(2Gc41A-CX1CY8・2G31-W内9 など)
  var RE_MW_SIZE = /^(2LS|2L|BBOX|BCP|BCR|BOX|BH|BT|CT|C|MHY|HFT|HYT|HF|HY|H|I|LH|L|P|SH|TH|[0-9]+φ|\[|角|□)[\-‐]?\s*[0-9]/;
  function masterWebRow(sameDesc, dai, nDai) {
    var row = sameDesc.slice().sort(function (a, b) { return a.x - b.x; });
    if (row.length < 3) return null;
    var sizeT = row[row.length - 1], codeT = row[row.length - 2], markT = row[row.length - 3];
    var before = row.slice(0, -1).filter(function (u) { return u.text.trim().length > 1; });
    if (before.length >= 2 && before.length < row.length - 1) { codeT = before[before.length - 1]; markT = before[before.length - 2]; }
    if (!RE_MW_SIZE.test(sizeT.text.normalize('NFKC').trim())) return null;
    if (RE_DAI.test(markT.text.normalize('NFKC').trim())) return null;
    return { name: markT.text, fugo: codeT.text, dai: nDai, x: markT.x, xr: dai.x, y: dai.y, main: sizeT.text };
  }

  // tdf-master-web の find_product_rows_offset_mark と同じ読み方(2026-11-20、EA1-1B-01):
  // 製品マークが「N台」の行から上下にずれた行や、2行の製品で設計符号・サイズを共有して2行の真ん中に書いた行。
  // 「N台」から左へ(同じ高さの直前の「N台」より右)、上下130以内の文字を見る。サイズとその左の設計符号(サイズと同じ高さ)があり、
  // さらに左で一番近い製品マークらしい文字を製品マークにする。製品マークは、同じ列の「N台」のうちこの「N台」に一番近いこと
  var RE_MARK_LIKE = /^[A-Za-z0-9]+(?:-[A-Za-z0-9]+)+$/;
  function offsetMarkRow(texts, dai, nDai) {
    var dais = texts.filter(function (u) { return RE_DAI.test(u.text); });
    var prev = dais.filter(function (d) { return d.x < dai.x && Math.abs(d.y - dai.y) < 15; }).reduce(function (a, d) { return a === null || d.x > a ? d.x : a; }, null);
    var win = texts.filter(function (u) { return u.x < dai.x && (prev === null || u.x > prev) && Math.abs(u.y - dai.y) <= 130 && !RE_DAI.test(u.text); });
    var sizes = win.filter(function (u) { return RE_MW_SIZE.test(u.text); });
    if (!sizes.length) return null;
    var size = sizes.slice().sort(function (a, b) { return Math.abs(a.y - dai.y) - Math.abs(b.y - dai.y) || b.x - a.x; })[0];
    var codes = win.filter(function (u) { return u.x < size.x && Math.abs(u.y - size.y) < 15; });
    if (!codes.length) return null;
    var code = codes.sort(function (a, b) { return b.x - a.x; })[0];
    var marks = win.filter(function (u) { return u.x < code.x && u !== size && RE_MARK_LIKE.test(u.text) && !RE_MW_SIZE.test(u.text); });
    if (!marks.length) return null;
    var mark = marks.sort(function (a, b) { return b.x - a.x; })[0];
    var col = dais.filter(function (d) { return Math.abs(d.x - dai.x) < 1; });
    var nearest = col.sort(function (a, b) { return Math.abs(a.y - mark.y) - Math.abs(b.y - mark.y); })[0];
    if (nearest !== dai) return null;
    return { name: mark.text, fugo: code.text, dai: nDai, x: mark.x, xr: dai.x, y: dai.y, main: size.text };
  }

  // 断面の見出し「A SEC」
  function sectionTitles(texts) {
    var out = [];
    texts.forEach(function (t) {
      if (t.text !== 'SEC') return;
      var l = texts.find(function (u) { return RE_SECKEY.test(u.text) && Math.abs(u.y - t.y) < 10 && t.x - u.x > 80 && t.x - u.x < 260; });
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
      if (dy <= 0 || dy > 2800 || dx > 1900) return;   // 2600 → 2800(2026-11-21、WB3-3G-10 の E・F断面(EV)の上の「GPL-12 MG220」は見出しから2697上。ユーザー指摘「MG220は4枚」)
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
      out.push({ size: plateSize(p.s.t.text), cnt: plateCount(p.s.t.text), mark: p.m.text, x: p.m.x, y: p.m.y, sx: p.s.t.x, sy: p.s.t.y, mekki: mek });
    });
    // 組にならなかった表記: 符号が板の表記の右横(同じ高さ)に書かれている形(2G-01 の「PL-9  OGAR63」。2026-11-19)
    sizes.forEach(function (sz) {
      if (us.has(sz)) return;
      var right = sz.t.x + 18 * sz.t.text.length * 2;
      // 引出線が文字より右へ長く伸びているときは、引出線の右端から測る(2026-11-21、WB3-3G-12 の「PL-12 ── MGR168A」「PL-12 ── MGR170A」)
      if (sz.h && sz.h.x1 > right) right = sz.h.x1;
      var m = marks.filter(function (k) { return !um.has(k) && Math.abs(k.y - sz.t.y) < 80 && k.x > right && k.x - right < 400; }).sort(function (p, q) { return p.x - q.x; })[0];
      if (!m) return;
      us.add(sz); um.add(m);
      out.push({ size: plateSize(sz.t.text), cnt: plateCount(sz.t.text), mark: m.text, x: m.x, y: m.y, sx: sz.t.x, sy: sz.t.y, mekki: false });
    });
    return out;
  }

  // ---------- メイン ----------
  function extract(buf, fileName) {
    var P = parse(buf), T = P.texts, L = P.lines;
    var info = titleInfo(T);
    var titles = sectionTitles(T);
    var pr = productRows(T, L);
    // 製品の行を、図(立面図・平面図)ごとにまとめる。行の高さが近く(600以内)、横にも近い(5000以内)ものは同じ図。
    // 図の範囲: 縦 = 製品の行より上で、上の図の行まで。横 = 左右に並ぶ図の間で分け、右に断面図があればその手前まで
    var prods = pr.rows.slice().sort(function (a, b) { return b.y - a.y || a.x - b.x; });
    var views = [];
    // 同じ高さの行で、別の製品の行から1500より離れて並ぶ製品は、左右に並ぶ別の図(図の間が5000より狭い図面がある。WR-2G-9 は間隔約3450。2026-11-20)
    // 1つの図の下に製品の行が横に並ぶ図面(検証図面A の J9・J12。間隔約390)は同じ図のまま
    prods.forEach(function (p) {
      var v = views.find(function (v) {
        var gaps = v.products.filter(function (q) { return Math.abs(q.y - p.y) < 15; }).map(function (q) { return Math.max(p.x - q.xr, q.x - p.xr); });
        if (gaps.length && Math.min.apply(null, gaps) > 1500) return false;   // 一番近い行との間隔で決める
        // 高さの違う行でも、横に重ならず1500より離れていれば別の図(2026-11-20、EA1-3B-02: 下の段の左の図の表 -16・-9 と中央の図の表 -8 が
        // 高さ約500違いで横に約2900離れて並び、1つの図にまとめて A・B 両方の板を3製品に入れていた)
        var hg = v.products.map(function (q) { return Math.max(p.x - q.xr, q.x - p.xr); });
        if (Math.min.apply(null, hg) > 1500) return false;
        return Math.abs(v.labelY - p.y) < 600 && p.x - v.xr < 5000 && v.x - p.xr < 5000;
      });
      if (v) { v.products.push(p); v.labelY = Math.min(v.labelY, p.y); v.labelTop = Math.max(v.labelTop, p.y); v.x = Math.min(v.x, p.x); v.xr = Math.max(v.xr, p.xr); }
      else views.push({ products: [p], labelY: p.y, labelTop: p.y, x: p.x, xr: p.xr });
    });
    views.forEach(function (v) {
      var above = views.filter(function (u) { return u !== v && u.labelY > v.labelTop + 600 && u.x < v.xr + 5000 && u.xr > v.x - 5000; });
      v.yMin = v.labelTop; v.yMax = above.length ? Math.min.apply(null, above.map(function (u) { return u.labelY; })) : Infinity;
      // 同じ段 = 行の高さの差600以内。または表の上下の範囲が600以内に近いもの(2026-11-20、EA1-3B-02: 2行の表と1行の表が下端で720ずれていた)
      var row = views.filter(function (u) { return Math.abs(u.labelY - v.labelY) < 600 || (u.labelY <= v.labelTop + 600 && v.labelY <= u.labelTop + 600 && (u.labelTop > u.labelY || v.labelTop > v.labelY)); }).sort(function (a, b) { return a.x - b.x; });
      var i = row.indexOf(v);
      v.x0 = i > 0 ? (row[i - 1].xr + v.x) / 2 : -Infinity;
      v.x1 = i < row.length - 1 ? (v.xr + row[i + 1].x) / 2 : Infinity;
      // 図の右端は英字1文字の断面(A SEC など)で決める(DK・カタカナの断面は2026-11-19に追加したもので、図の範囲は今までどおり)
      titles.forEach(function (s) { if (/^[A-Za-z]$/.test(s.letter) && s.y > v.yMin && s.y < v.yMax && s.x > v.xr) v.x1 = Math.min(v.x1, s.x - 1200); });
      // すべての断面(DK・カタカナも)で決めた右端。名前だけの断面図(外装ALC下地)を探すときだけ使う
      v.x1s = v.x1;
      titles.forEach(function (s) { if (s.y > v.yMin && s.y < v.yMax && s.x > v.xr) v.x1s = Math.min(v.x1s, s.x - 1200); });
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
    // 形鋼の表記の引出線の先: 表記のすぐ下の横線の端から出る斜めの線の、もう一方の端(無ければ表記の位置)
    function shapeAnchor(t) {
      // 表記と引出線の間は40までが多いが、69 離れた図面もある(2026-11-21、WB3-3G-08 の「[-100x50x5x7.5」)
      var h = hlines.filter(function (h) { return t.y - h.y >= 3 && t.y - h.y <= 80 && h.x0 <= t.x + 50 && h.x1 >= t.x - 50; })
        .sort(function (a, b) { return (t.y - a.y) - (t.y - b.y); })[0];
      if (!h) return t;
      var best = null;
      [[h.x0, h.y], [h.x1, h.y]].forEach(function (e) {
        L.forEach(function (l) {
          if (Math.abs(l[1] - l[3]) < 0.5) return;
          var o = Math.hypot(l[0] - e[0], l[1] - e[1]) < 1 ? [l[2], l[3]] : Math.hypot(l[2] - e[0], l[3] - e[1]) < 1 ? [l[0], l[1]] : null;
          if (o && Math.abs(o[0] - t.x) > 50 && (!best || Math.abs(o[0] - t.x) > Math.abs(best.x - t.x))) best = { x: o[0], y: o[1], text: '' };
        });
      });
      return best || t;
    }
    var secInfo = {};
    titles.forEach(function (s) { secInfo[s.letter] = { title: s, plates: {}, plateT: new Set(), shapes: [], joint: false, dims: [], nested: [] }; });
    var elevLabels = [];
    labels.forEach(function (lb) {
      if (isLeft(lb) && isLeft({ x: lb.sx, y: lb.sy })) { elevLabels.push(lb); return; }
      var s = sectionOf({ x: lb.x, y: lb.y, text: lb.mark }, titles); if (!s) return;
      var si = secInfo[s.letter];
      si.plates[lb.mark] = si.plates[lb.mark] || { size: lb.size, n: 0, mekki: false };
      si.plates[lb.mark].n += lb.cnt;
      si.cntMin = Math.min(si.cntMin || Infinity, lb.cnt);
      si.plateT.add(thickOf(lb.size));
      if (lb.mekki) si.plates[lb.mark].mekki = true;
      // 「MGR156切断流用」: 備考は断面図の「切断」の書き込みのそばの寸法(WB1-3G-06 す断面: 15 → 「15mm切断」。2026-11-21 ユーザー指示)
      if (/切断流用$/.test(lb.mark)) {
        var cut = T.filter(function (u) { return u.text === '切断' && (sectionOf(u, titles) || {}).letter === s.letter; })[0];
        var num = cut && T.filter(function (u) { return /^[0-9]+(\.[0-9]+)?$/.test(u.text) && dist(u, cut) < 400; }).sort(function (a, b) { return dist(a, cut) - dist(b, cut); })[0];
        si.plates[lb.mark].note = num ? num.text + 'mm切断' : '切断';
      }
    });
    // 符号の無い「支給品」の板(2026-11-21 ユーザー指示、EA1-RG-10 の か断面「避雷針プレート」の「PL-6 / 支給品」): 符号なしで入れる。
    // 枚数は断面の数(旗の数)×表記の枚数、備考は断面の副題と「支給品」
    T.forEach(function (t) {
      if (!RE_PLATE.test(t.text) || isLeft(t)) return;
      if (labels.some(function (lb) { return Math.abs(lb.sx - t.x) < 1 && Math.abs(lb.sy - t.y) < 1; })) return;
      if (!T.some(function (u) { return u.text === '支給品' && t.y - u.y > 0 && t.y - u.y < 250 && Math.abs(u.x - t.x) < 300; })) return;
      var s3 = sectionOf(t, titles); if (!s3) return;
      var si3 = secInfo[s3.letter];
      if (si3.plates['']) return;
      si3.plates[''] = { size: plateSize(t.text), n: plateCount(t.text), mekki: false, note: (s3.sub ? s3.sub + '・' : '') + '支給品' };
      si3.plateT.add(thickOf(plateSize(t.text)));
    });
    // 断面図の中の、板の表記と組にならなかった符号は、同じ符号がほかで組になっていればそのサイズで1枚(2026-11-21 ユーザー確認、WB3-3G-12:
    // G断面は「BH-250x250x12x12 / MGR166」、H断面は「PL-12 / MGR166」→ G にも PL-12 MGR166 1枚)
    var knownSize = {};
    labels.forEach(function (lb) { if (!(lb.mark in knownSize)) knownSize[lb.mark] = lb.size; });
    T.forEach(function (t) {
      if (!RE_MARK.test(t.text) || RE_NOT_MARK.test(t.text) || !(t.text in knownSize) || isLeft(t)) return;
      if (labels.some(function (lb) { return lb.mark === t.text && Math.abs(lb.x - t.x) < 1 && Math.abs(lb.y - t.y) < 1; })) return;
      // 符号のすぐ上に板ではない部材のサイズ(BH-250x250x12x12 など)が書いてあるものだけ(2G-01 の入れ子の断面の符号は除く)
      if (!T.some(function (u) { return /^(BH|SH|H)-[0-9]/.test(u.text) && u.y - t.y > 0 && u.y - t.y < 250 && Math.abs(u.x - t.x) < 400; })) return;
      var s2 = sectionOf(t, titles); if (!s2) return;
      var si2 = secInfo[s2.letter];
      if (si2.plates[t.text]) return;
      si2.plates[t.text] = { size: knownSize[t.text], n: 1, mekki: false };
      si2.plateT.add(thickOf(knownSize[t.text]));
    });
    // 立面図(平面図)で、部材のサイズ(BH-250 など)の引出線の下に符号だけが並ぶもの(2026-11-21 ユーザー確認、WB3-3G-12:
    // 「BH-250 / MGR165 / MGR163K」= G 側の BH-250 の下フランジ MGR165 と上フランジ MGR163K)。サイズは同じ符号がほかで組になっていればそのサイズ、
    // 無ければ一緒に並ぶ符号のサイズ(MGR163K = PL-12 → MGR165 も PL-12)。1枚ずつ
    T.filter(function (u) { return /^(BH|SH|H)-[0-9]+$/.test(u.text) && isLeft(u); }).forEach(function (u) {
      var ms = T.filter(function (t) {
        return RE_MARK.test(t.text) && !RE_NOT_MARK.test(t.text) && u.y - t.y > 0 && u.y - t.y < 450 && Math.abs(t.x - u.x) < 300 &&
          !labels.some(function (lb) { return lb.mark === t.text && Math.abs(lb.x - t.x) < 1 && Math.abs(lb.y - t.y) < 1; });
      });
      var sz0 = ms.map(function (t) { return knownSize[t.text]; }).filter(Boolean)[0];
      if (!sz0) return;
      ms.forEach(function (t) { elevLabels.push({ size: knownSize[t.text] || sz0, mark: t.text, cnt: 1, x: t.x, y: t.y, sx: u.x, sy: u.y }); });
    });
    // 最後に1つずつ残った板の表記と符号の組(2026-11-21 ユーザー説明、WB3-3G-12: 上の平面図の右の「GPL-12」は、右の小さな図(下FLG面)で説明していて、
    // そちらには「MG225」だけが書いてある)。同じ種類(GPL / PL)の符号の頭の英字(MG・MGR)が、組になった符号と同じものだけ
    var usedAt = function (t) { return labels.some(function (lb) { return (Math.abs(lb.x - t.x) < 1 && Math.abs(lb.y - t.y) < 1) || (Math.abs(lb.sx - t.x) < 1 && Math.abs(lb.sy - t.y) < 1); }) ||
      elevLabels.some(function (lb) { return Math.abs(lb.x - t.x) < 1 && Math.abs(lb.y - t.y) < 1; }); };
    var pre = function (m) { return (/^[A-Z]+/.exec(m) || [''])[0]; };
    var preKind = {};
    labels.forEach(function (lb) { var k = kindOf(lb.size); (preKind[pre(lb.mark)] = preKind[pre(lb.mark)] || {})[k] = 1; });
    ['GPL', 'PL'].forEach(function (kind) {
      var sz1 = T.filter(function (t) { return RE_PLATE.test(t.text) && kindOf(plateSize(t.text)) === kind && !usedAt(t) && isLeft(t); });
      var mk1 = T.filter(function (t) {
        if (!RE_MARK.test(t.text) || RE_NOT_MARK.test(t.text) || usedAt(t) || t.text in knownSize) return false;
        var pk = preKind[pre(t.text)]; return pk && pk[kind] && Object.keys(pk).length === 1;
      });
      if (sz1.length !== 1 || mk1.length !== 1 || !isLeft(mk1[0])) return;
      elevLabels.push({ size: plateSize(sz1[0].text), mark: mk1[0].text, cnt: plateCount(sz1[0].text), x: mk1[0].x, y: mk1[0].y, sx: sz1[0].x, sy: sz1[0].y });
    });
    var outsideStrict = function (o) { return !views.some(function (v) { return o.y > v.yMin && o.y < v.yMax && o.x > v.x0 && o.x < v.x1s; }); };
    T.forEach(function (t) {
      // DK・カタカナの断面に入る文字は、図の範囲の中でも断面の文字として読む(英字1文字の断面は今までどおり)
      if (isLeft(t) && /^[A-Za-z]$/.test((sectionOf(t, titles) || {}).letter || 'A')) return;
      var s = sectionOf(t, titles); if (!s) return;
      var si = secInfo[s.letter];
      // 形鋼の表記は引出線の先(断面図の中)で断面を決める(2026-11-21、WB1-3G-05: あ断面の「C-75x45x15x2.3」が右の さ断面の近くに書かれていた)。
      // 溝形鋼は「[-100x50x5x7.5」の書き方も(WB1-3G-05 の さ・す断面。ユーザー指摘「長さ295の21本は [-100x50x5x7.5」)
      if (RE_SHAPE.test(t.text) || RE_CHAN.test(t.text)) {
        var an = shapeAnchor(t);
        // 「[-」は引出線のあるものだけ(2G-01: 旗 ウ・カ のそばの「Sb25C」「[-250x90x11x14.5」は取り付く小梁の名前とサイズで金物ではない)
        if (RE_CHAN.test(t.text) && an === t) return;
        var sa = sectionOf(an, titles);
        var sI = secInfo[(sa || s).letter];
        sI.shapes.push(t.text);
        if (an !== t) (sI.anchors = sI.anchors || {})[t.text] = an;
      }
      if (RE_JOINT.test(t.text) && /^[A-Z]+J[0-9]/.test(t.text)) si.joint = true;
      if (/^[0-9]+$/.test(t.text) && parseInt(t.text, 10) >= 100) { si.dims.push(parseInt(t.text, 10)); (si.dimT = si.dimT || []).push(t); }
      // LGS下地の長さ用(小数も。EA1-3B-05「あ」: 87.5+87.5=175。2026-11-20)
      if (/^[0-9]+(\.[0-9]+)?$/.test(t.text) && parseFloat(t.text) >= 10) (si.dimT2 = si.dimT2 || []).push(t);
      // 断面図の中の断面記号(例: C断面の中の E)
    });
    // 断面図の中の断面記号 → どの断面図の中か(親)。2026-11-19 ユーザー説明(2G-01)で見直し:
    //  - 見出しから上へ3500まで探す(C断面の上の H・J は見出しから約3060上、G断面の上の L は約2660上)
    //  - 左に棒がある旗(ア・ク・ケ・コ。棒の上から右へ横線)は右向き = 断面図は旗の右。親は記号より右に見出しがある断面だけ
    //    (これが無いと、G断面の左のケ・コを左隣の DK3断面のものとしていた)
    // 記号は断面図の右に書かれることもある(検証図面B の C の中の E)ので、右向きの旗でなければ左右の条件は付けない
    function rightFlag(t) {
      return L.some(function (l) {
        var x0 = Math.min(l[0], l[2]) - t.x, x1 = Math.max(l[0], l[2]) - t.x, y0 = Math.min(l[1], l[3]) - t.y, y1 = Math.max(l[1], l[3]) - t.y;
        return x1 - x0 < 1 && x0 > -260 && x0 < -100 && y0 < 10 && y1 > 60 && L.some(function (h) {
          return Math.abs(h[1] - h[3]) < 1 && Math.abs(Math.min(h[0], h[2]) - t.x - x0) < 2 && Math.max(h[0], h[2]) - t.x > 100 && Math.abs(h[1] - t.y - y1) < 2;
        });
      });
    }
    T.forEach(function (t) {
      if (isLeft(t) || !RE_SECKEY.test(t.text) || !secInfo[t.text] || titles.some(function (x) { return x.letter === t.text && Math.abs(x.y - t.y) < 10; })) return;
      // 鋼材の印「N B」「N C」「T C」(SN490B など)の B・C は断面記号ではない(2026-11-21、EA2-RG-07: C断面の「N B GPL-25」の B を入れ子の B断面と読み、NG21・NG22 を5枚にしていた)
      if (T.some(function (u) { return /^[NT]$/.test(u.text) && Math.abs(u.y - t.y) < 15 && t.x - u.x > 0 && t.x - u.x < 120; })) return;
      var best = null, bs = Infinity, cx = t.x + 18 * t.text.length, rf = rightFlag(t);
      titles.forEach(function (s) {
        var c = (s.x + s.sx) / 2, dy = t.y - s.y, dx = Math.abs(cx - c);
        if (dy <= 0 || dy > 3500 || dx > 1900 || s.letter === t.text || (rf && c < t.x)) return;
        var sc = dy + 2 * dx;
        if (sc < bs) { bs = sc; best = s; }
      });
      if (best) secInfo[best.letter].nested.push(t.text);
    });

    // 断面の中の組立H(BH-396x199x9x16)。そばに符号が3つ縦に並んでいれば、上から 上フランジ・ウェブ・下フランジ(2026-11-19 ユーザー説明。2G-01 の OGAR3K・OGAR5・OGAR4K)。
    // ウェブは BH のウェブ厚の板で拾う。フランジは、ほかの断面図(ア・イなど)で板として拾えていれば重ねない(拾えていなければフランジ厚の板)
    var labeled = new Set(labels.map(function (lb) { return lb.mark + '@' + Math.round(lb.x) + ',' + Math.round(lb.y); }));
    var plateMarks = new Set();
    Object.keys(secInfo).forEach(function (k) { Object.keys(secInfo[k].plates).forEach(function (m) { plateMarks.add(m); }); });
    T.forEach(function (t) {
      var bh = /^BH-([0-9.]+)x([0-9.]+)x([0-9.]+)x([0-9.]+)$/.exec(t.text);
      if (!bh || isLeft(t)) return;
      var s = sectionOf(t, titles); if (!s) return;
      var si = secInfo[s.letter];
      var ms = T.filter(function (u) {
        // 符号は BH の表記の近く(1500以内)で探す(断面の見出しとの距離では隣の断面に入ることがある)
        return RE_MARK.test(u.text) && !RE_NOT_MARK.test(u.text) && !RE_PLATE.test(u.text) && !labeled.has(u.text + '@' + Math.round(u.x) + ',' + Math.round(u.y)) &&
          !isLeft(u) && dist(u, t) < 1500;
      });
      var best = null, bd = Infinity;
      ms.forEach(function (a) {
        var g = ms.filter(function (b) { return Math.abs(b.x - a.x) < 80 && b.y <= a.y && a.y - b.y < 400; }).sort(function (p, q) { return q.y - p.y; });
        if (g.length !== 3) return;
        var d = dist(g[1], t);
        if (d < bd) { bd = d; best = g; }
      });
      if (!best) return;
      var tw = bh[3], tf = bh[4];
      [[best[0], tf], [best[1], tw], [best[2], tf]].forEach(function (x, i) {
        var m = x[0].text;
        if (i !== 1 && plateMarks.has(m)) return;
        if (!si.plates[m]) si.plates[m] = { size: 'PL-' + x[1], n: 1, mekki: false };
      });
    });

    // 名前だけの断面図(「A SEC」の見出しが無く、図の下に「外装ALC下地」とだけ書いた図。2G-01)を1つだけ探す。
    // 使うのは、旗がなくどの断面か決められない板があるときだけ(上の views の中で判断)
    var named = null;
    (function () {
      var cands = [];
      T.forEach(function (t) {
        if (!/[ぁ-んァ-ヶ一-龠]/.test(t.text) || /[0-9\s]/.test(t.text) || t.text.length < 3 || /SEC/.test(t.text) || !outsideStrict(t)) return;
        if (titles.some(function (s) { return s.y - t.y > 60 && s.y - t.y < 320 && Math.abs(t.x - (s.x + s.sx) / 2) < 400; })) return;   // 断面の副題
        // 断面図の名前は単独で書かれている。すぐ近くに文字がある注記(「デッキ受け」の横の BT-640… など)は除く
        if (T.some(function (u) { return u !== t && Math.abs(u.y - t.y) < 150 && Math.abs(u.x - t.x) < 600; })) return;
        var cx = t.x + 18 * t.text.length;
        var mine = function (o) {
          var dy = o.y - t.y, dx = Math.abs(o.x + 18 * (o.text || '').length - cx);
          if (dy < 100 || dy > 2600 || dx > 1900 || !outsideStrict(o)) return false;
          var s = sectionOf(o, titles); if (!s) return true;
          var sdy = o.y - s.y, sdx = Math.abs(o.x + 18 * (o.text || '').length - (s.x + s.sx) / 2);
          return dy + 2 * dx < sdy + 2 * sdx;
        };
        var lbs = labels.filter(function (lb) { return mine({ x: lb.x, y: lb.y, text: lb.mark }); });
        if (lbs.length < 2) return;
        cands.push({ t: t, mine: mine, lbs: lbs });
      });
      if (cands.length !== 1) return;
      var c = cands[0], seen = {};
      var sizesIn = T.filter(function (u) { return RE_PLATE.test(u.text) && c.mine(u); });
      var ms = [];
      T.forEach(function (u) {
        if (!RE_MARK.test(u.text) || RE_NOT_MARK.test(u.text) || RE_PLATE.test(u.text) || !c.mine(u) || seen[u.text]) return;
        var lb = c.lbs.find(function (l) { return l.mark === u.text; });
        var size, cnt = 1;
        if (lb) { size = lb.size; cnt = lb.cnt; }
        else {   // 表記を2つの符号で共用している(PL-9 に OGALR3・OGALR2)→ 一番近い板の表記
          var near1 = sizesIn.slice().sort(function (a, b) { return dist(a, u) - dist(b, u); })[0];
          if (!near1 || dist(near1, u) > 600) return;
          size = plateSize(near1.text); cnt = plateCount(near1.text);
        }
        seen[u.text] = 1; ms.push({ mark: u.text, size: size, cnt: cnt });
      });
      // 形鋼の表記は1つずつ見る(L-90X90X7 が2つ: L=110 の横材と、長さ313の縦材。2026-11-19 ユーザー説明)
      //  - そばに「L=110」があればその長さ(箱の数で数える)
      //  - 無ければ、断面図の寸法のうち、立面図に同じ長さの山形鋼(脚・厚さの3本組)が描かれているもの(その組の数で数える)
      var lts = T.filter(function (w) { return /^L=[0-9.]+$/.test(w.text) && c.mine(w); });
      var shapeLabels = T.filter(function (u) { return RE_SHAPE.test(u.text.replace(/X/g, 'x')) && c.mine(u); });
      var dims = T.filter(function (w) { return /^[0-9]+(\.[0-9]+)?$/.test(w.text) && c.mine(w); }).map(function (w) { return parseFloat(w.text); })
        .filter(function (d, i, a) { return d >= 50 && d <= 3000 && a.indexOf(d) === i; });
      var shapes = [];
      shapeLabels.forEach(function (u) {
        var sz = u.text.replace(/X/g, 'x'), m = /^L-([0-9.]+)x([0-9.]+)x([0-9.]+)$/.exec(sz);
        var lt = lts.filter(function (w) { return dist(w, u) < 600 && shapeLabels.every(function (o) { return dist(w, u) <= dist(w, o); }); })
          .sort(function (a, b) { return dist(a, u) - dist(b, u); })[0];
        if (lt) { shapes.push({ size: sz, len: parseFloat(lt.text.slice(2)), leg: parseFloat(/-([0-9.]+)/.exec(sz)[1]), kind: 'box' }); return; }
        if (!m) return;
        shapes.push({ size: sz, dims: dims, leg: parseFloat(m[1]), th: parseFloat(m[3]), kind: 'angle' });
      });
      named = { title: c.t.text, marks: ms, shapes: shapes, used: new Set(c.lbs) };
    })();

    // レイヤと同じ名前の詳細図(1G-01 の左下「かんざし受け」。2026-11-20 ユーザー指示「O-KZ109 も拾って」):
    // 図の名前の上(100〜2600)にある板の表記を、そのレイヤで図に描かれた「板厚だけ離れた平行な2本の線」の数だけ拾う
    // (1G-01: 平面図に 75×9 の板が3か所×両側 = 6枚。詳細図・断面図の中のものは数えない)
    var layerDetails = [];
    T.forEach(function (t) {
      if (isLeft(t) || /[0-9]/.test(t.text) || t.text.length < 2) return;
      var no = P.layers.indexOf('_' + t.text); if (no < 0) no = P.layers.indexOf(t.text);
      if (no < 0) return;
      var lbs = labels.filter(function (lb) {
        var dy = lb.y - t.y, dx = Math.abs(lb.x - t.x);
        return dy > 100 && dy < 2600 && dx < 1900 && !isLeft(lb) && !sectionOf({ x: lb.x, y: lb.y, text: lb.mark }, titles);
      });
      if (lbs.length) layerDetails.push({ title: t.text, layer: no + 1, labels: lbs });
    });

    // サヤ管(2026-11-20 ユーザー指示): サイズ・長さ・本数がすべて図面から分かるときは金物リストに入れる。1つでも分からなければ除外のまま
    //  - サイズ: 「サヤ管」という名前の詳細図の管の表記(P-60.5φx3.2)
    //  - 長さ: 凡例の <TS190> の数字、または管の表記のそばの L=…
    //  - 本数: 図の中のサヤ管のレイヤで、外径だけ離れた長さの同じ平行な2本の線(1本の管)の数(数えるのは下の views の中で)
    var saya = null;
    (function () {
      // 名前は「サヤ管」。無ければ「さや管」(EA1-3B-03。管の表記は名前のすぐ下)も(2026-11-20 ユーザー指示「さや管は拾えない？」)
      var title = T.filter(function (t) { return t.text === 'サヤ管' && !isLeft(t) && !sectionOf(t, titles); })[0];
      var below = false;
      if (!title) { title = T.filter(function (t) { return /^(さや管|サヤ管|サヤ菅)$/.test(t.text) && !isLeft(t) && !sectionOf(t, titles); })[0]; below = true; }
      // 図の右に断面図が無く、図の範囲が右端まで広がって詳細図も図の中になる図面(2026-11-21、EA1-RG-05): 名前のすぐ下(400以内)に管の表記がある「サヤ管」
      if (!title) title = T.filter(function (t) { return /^(さや管|サヤ管|サヤ菅)$/.test(t.text) && !sectionOf(t, titles) && T.some(function (u) { return /^P-([0-9.]+)φ?x([0-9.]+)$/.test(u.text) && t.y - u.y > 0 && t.y - u.y < 400 && Math.abs(u.x - t.x) < 1900; }); })[0];
      if (!title) return;
      var pipe = T.filter(function (u) { return /^P-([0-9.]+)φ?x([0-9.]+)$/.test(u.text) && (below ? title.y - u.y > 0 && title.y - u.y < 400 : u.y - title.y > 100 && u.y - title.y < 2600) && Math.abs(u.x - title.x) < 1900; })
        .sort(function (a, b) { return dist(a, title) - dist(b, title); })[0];
      // 「サヤ管」(カタカナ)でも管の表記が名前のすぐ下の図面がある(2026-11-20 ユーザー指摘「さや管漏れ」、EA1-3G-05)
      if (!pipe && !below) { below = true; pipe = T.filter(function (u) { return /^P-([0-9.]+)φ?x([0-9.]+)$/.test(u.text) && title.y - u.y > 0 && title.y - u.y < 400 && Math.abs(u.x - title.x) < 1900; }).sort(function (a, b) { return dist(a, title) - dist(b, title); })[0]; }
      if (!pipe) return;
      var m = /^P-([0-9.]+)φ?x([0-9.]+)$/.exec(pipe.text);
      var len = null;
      var lt = T.filter(function (w) { return /^L=[0-9.]+$/.test(w.text) && dist(w, pipe) < 300; })[0];
      if (lt) len = parseFloat(lt.text.slice(2));
      // 図の中の「サヤ管 K11」(「菅」の字も)の書き込みのすぐ上か下の L=…(EA1-3B-03 は上、EA1-3G-05 は下の「L＝220」)
      else if ((lt = T.filter(function (w) { return /^L=[0-9.]+$/.test(w.text) && T.some(function (k) { return /^(サヤ管|さや管|サヤ菅)/.test(k.text) && k !== title && Math.abs(k.x - w.x) < 300 && Math.abs(w.y - k.y) > 0 && Math.abs(w.y - k.y) < 300; }); })[0])) len = parseFloat(lt.text.slice(2));
      else { var ts = T.filter(function (w) { return /^<TS[0-9.]+>$/.test(w.text); }).map(function (w) { return parseFloat(w.text.slice(3)); }); if (ts.length && ts.every(function (x) { return x === ts[0]; })) len = ts[0]; }
      if (!len) return;
      var lays = [];
      P.layers.forEach(function (n, i) { if (/サヤ管/.test(n) && !/非表示/.test(n)) lays.push(i + 1); });
      saya = { size: pipe.text, od: parseFloat(m[1]), len: len, layers: lays };
    })();
    var sayaCounted = false;

    // 旗(断面記号): 文字の右に縦線(長さ250〜450)がある
    // 旗の縦線(梁が傾いた図面では少し傾いている)
    // 傾き2割まで(WR-2G-9 は勾配12.9%。tdf-master-web もこの図面を斜め梁として読めている。2026-11-20)
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

    function onPt(l, p) { return Math.hypot(l[0] - p[0], l[1] - p[1]) < 3 ? [l[2], l[3]] : (Math.hypot(l[2] - p[0], l[3] - p[1]) < 3 ? [l[0], l[1]] : null); }
    function segDist(p, l) {
      var dx = l[2] - l[0], dy = l[3] - l[1], len2 = dx * dx + dy * dy;
      var k = len2 ? Math.max(0, Math.min(1, ((p[0] - l[0]) * dx + (p[1] - l[1]) * dy) / len2)) : 0;
      return Math.hypot(p[0] - (l[0] + k * dx), p[1] - (l[1] + k * dy));
    }
    function lineLen(l) { return Math.hypot(l[2] - l[0], l[3] - l[1]); }
    var notes = T.filter(function (t) { return /^(現場取付|デッキ受け)$/.test(t.text); });
    function leaderShapes(v) {
      var labs = T.filter(function (t) { return inView(v, t) && RE_SHAPE.test(t.text); });
      var leads = [];
      labs.forEach(function (t) {
        var p = [t.x, t.y];
        // 引出線 = 表記の左下から左へ伸びる、横に近い線
        var lead = L.filter(function (l) { var o = onPt(l, p); return o && o[0] < t.x - 200 && Math.abs(o[1] - t.y) < (t.x - o[0]) * 0.25; })
          .sort(function (a, b) { return lineLen(b) - lineLen(a); })[0];
        if (!lead) return;
        var far = onPt(lead, p);
        // 指示線の先
        var ptr = null;
        L.forEach(function (l) {
          if (l === lead || ptr) return;
          var o = onPt(l, p) || onPt(l, far);
          if (o && lineLen(l) > 50 && lineLen(l) < 1500) ptr = o;
        });
        if (!ptr) return;
        leads.push({ t: t, lead: lead, ptr: ptr, notes: [] });
      });
      // 「現場取付」「デッキ受け」は一番近い引出線のもの(250以内)
      notes.forEach(function (n) {
        var best = null, bd = 250;
        leads.forEach(function (o) { var d = segDist([n.x, n.y], o.lead); if (d < bd) { bd = d; best = o; } });
        if (best) best.notes.push(n.text);
      });
      var out = [];
      leads.forEach(function (o) {
        // 指示線の先に一番近い線と、それと同じ長さで平行・近くの線が合わせて3本以上
        var cand = L.filter(function (l) { var n = lineLen(l); return n >= 100 && n <= 15000 && segDist(o.ptr, l) < 60; })
          .sort(function (a, b) { return segDist(o.ptr, a) - segDist(o.ptr, b); });
        for (var i = 0; i < cand.length; i++) {
          var a = cand[i], n = lineLen(a), ux = (a[2] - a[0]) / n, uy = (a[3] - a[1]) / n;
          var mates = L.filter(function (c) {
            if (Math.abs(lineLen(c) - n) > 0.5) return false;
            var vx = (c[2] - c[0]) / n, vy = (c[3] - c[1]) / n;
            if (Math.abs(ux * vy - uy * vx) > 0.01) return false;
            var cx = (c[0] + c[2]) / 2 - (a[0] + a[2]) / 2, cy = (c[1] + c[3]) / 2 - (a[1] + a[3]) / 2;
            return Math.abs(cx * ux + cy * uy) < 5 && Math.abs(cx * uy - cy * ux) < 150;
          });
          if (mates.length >= 3) { out.push({ shape: o.t.text, len: n, onSite: o.notes.indexOf('現場取付') >= 0, note: o.notes.indexOf('デッキ受け') >= 0 ? 'デッキ受け' : '' }); break; }
        }
      });
      return out;
    }

    var fbDims = [];
    T.forEach(function (t) { var m = RE_FB.exec(t.text); if (m) { var k = m[1] + 'x' + m[2] + 'x' + m[3]; if (!fbDims.some(function (f) { return f.key === k; })) fbDims.push({ key: k, t: m[1], w: parseFloat(m[2]), l: parseFloat(m[3]) }); } });

    var result = { fileName: fileName || '', koji: info.koji, kojiNo: info.kojiNo, zuban: info.zuban, products: [], excluded: [], included: [], warnings: [] };

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
      var dm = /H-([0-9]+)/.exec(main), depth = dm ? parseFloat(dm[1]) : 0;   // H形鋼以外(BT・□など)は梁成なし
      // 長さ: 寸法の行で「10」(柱との隙間)2つの間にある一番大きい数。梁が傾いていると寸法の行も傾くので、2つの「10」を結ぶ線のそばで探す
      var length = 0;
      var tens = T.filter(function (t) { return inView(v, t) && t.text === '10'; });
      // 右で一番近い「10」(傾き1割以内)だけを相手にする(通り芯の番号「10」と組にしない)。
      // 見つからなければ傾き2割まで広げる(WR-2G-9 は勾配12.9%。初めから2割にすると別の行の「10」と組になる図面がある。2026-11-20)
      [0.1, 0.2].forEach(function (slope) {
        if (length) return;
        tens.forEach(function (a) {
          var b = tens.filter(function (c) { return c.x > a.x + 1000 && Math.abs(c.y - a.y) <= (c.x - a.x) * slope; }).sort(function (p, q) { return p.x - q.x; })[0];
          if (!b) return;
          T.forEach(function (u) {
            if (!inView(v, u) || !/^[0-9]+(\.[0-9]+)?$/.test(u.text) || u.x <= a.x || u.x >= b.x) return;
            var yl = a.y + (b.y - a.y) * (u.x - a.x) / (b.x - a.x);
            if (Math.abs(u.y - yl) < 40) { var n = parseFloat(u.text); if (n > length && n < 30000) length = n; }
          });
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
      var looseFlags = [];   // 立面図の板に当たらなかった旗 {L1, fx}
      T.forEach(function (t) {
        if (!inView(v, t) || !RE_SECKEY.test(t.text) || !secInfo[t.text]) return;
        var fx = flagLineX(t); if (fx === null) return;
        // 梁の長さの外の旗(拡大図の旗)は数えない(2026-11-21、WB3-3G-12: EV の拡大図にも旗 G・H があり、2倍に数えていた)
        if (elev && (fx < elev.x0 - 500 || fx > elev.x1 + 500)) return;
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
        // 旗の記号の上の「x19」= その旗の場所の数(2026-11-21、WB1-3G-05・06 の ALC下地: さ x19・す x1)。書いてあれば平面図で数え直さない
        var mul = T.filter(function (u) { var mm = /^x([0-9]+)$/.exec(u.text); return mm && u.y - t.y > 0 && u.y - t.y < 400 && Math.abs(u.x - t.x) < 150; })[0];
        // 「x2」はその記号の旗ぜんぶの場所の数(WB1-3G-05: 左端の「す x2」と右端の「す」で2。2026-11-21 ユーザー確認)
        if (mul) { var fm = flagsBySec[t.text]; fm.mul = Math.max(fm.mul || 0, parseInt(mul.text.slice(1), 10)); fm.explicit = true; }
        looseFlags.push({ L1: t.text, fx: fx });
      });
      Object.keys(flagsBySec).forEach(function (L1) {
        var f = flagsBySec[L1];
        if (f.mul && f.mul > f.matched.length + f.unmatched) f.unmatched = f.mul - f.matched.length;
      });
      // 平面図で数える(2026-11-20 ユーザー指示「実際の絵を見て判断してほしい」。EA1-3B-03 のコン止め き・か):
      // 旗のそば(左右300以内)の平面図に、その断面の板厚だけ離れた平行な縦線2本(=板)があり、長さが断面図の寸法とほぼ同じ(1.5%以内)なら、
      // 同じ長さ・同じ高さ・同じ板厚の板が平面図に何か所あるかを数え、旗の数より多ければその数を断面の数にする
      // (き: 6離れた285の線(断面図 285)→ 6か所。か: 9離れた538.2の線(断面図 545)→ 4か所。旗は1つずつ。C の板(143.3・断面図に無い長さ)は数えない)
      if (elev && looseFlags.length) {
        var planV = vlines.filter(function (l) { return l.y0 > elev.top + 300 && inView(v, { x: l.x, y: (l.y0 + l.y1) / 2 }); });
        var pairsOf = function (tt) {
          var out = [], seen = {};
          planV.forEach(function (a) {
            planV.forEach(function (b) {
              if (b.x - a.x < tt - 0.3 || b.x - a.x > tt + 0.3 || Math.abs(a.y0 - b.y0) > 0.5 || Math.abs(a.y1 - b.y1) > 0.5) return;
              var k = a.x.toFixed(1) + '|' + a.y0.toFixed(0); if (seen[k]) return; seen[k] = 1;
              out.push({ x: (a.x + b.x) / 2, len: a.y1 - a.y0, y0: a.y0 });
            });
          });
          return out;
        };
        // 同じ板の組(長さ・高さが同じ)に別の断面の旗もあるときは、組の数から、ほかの断面の数(旗の数か「x2」)を引いた残りをその断面の数にする
        // (2026-11-21 ユーザー確認、WB1-3G-05: ALC下地の板 21か所 = す 2(x2)+ さ 19。さ の旗の「x18」より平面図の数を正とする。WB1-3G-06: 20 = す 1 + さ 19)
        var hits = {}, order = [];
        looseFlags.forEach(function (lf) {
          if (hits[lf.L1]) return;
          var si = secInfo[lf.L1];
          Array.from(si.plateT).some(function (tt) {
            var ps = pairsOf(tt);
            var dimOk = function (q) { return si.dims.some(function (d) { return Math.abs(q.len - d) <= d * 0.015; }); };
            var near = ps.filter(function (q) { return Math.abs(q.x - lf.fx) <= 300 && dimOk(q); }).sort(function (a, b) { return Math.abs(a.x - lf.fx) - Math.abs(b.x - lf.fx); })[0];
            if (!near) return false;
            var n = ps.filter(function (q) { return Math.abs(q.len - near.len) <= 0.5 && Math.abs(q.y0 - near.y0) <= 1; }).length;
            hits[lf.L1] = { n: n, key: tt + '|' + near.len.toFixed(0) + '|' + near.y0.toFixed(0) }; order.push(lf.L1);
            return true;
          });
        });
        var cntOf = function (L1) { var f = flagsBySec[L1]; return f.matched.length + f.unmatched; };
        order.forEach(function (L1) {
          var h = hits[L1], f = flagsBySec[L1];
          // 立面図の板に当たった旗の断面(スチフナなど)は、同じ板の組を旗だけの断面(ALC下地の さ など)が持っていれば数え直さない
          // (2026-11-21 ユーザー指摘「MG125・MGR92 の枚数が違う」、WB3-3G-04: A断面の旗2つ(立面図のスチフナ2枚)が、そばの ALC下地の板14か所で14になっていた)
          if (f.matched.length && order.some(function (L2) { return L2 !== L1 && hits[L2].key === h.key && !flagsBySec[L2].matched.length; })) return;
          // 競うのは旗に「x2」などが書いてある断面どうしだけ(同じ場所に付くスチフナ(A・E など)は別の板なので引かない)
          if (f.explicit) {
            var others = order.filter(function (L2) { return L2 !== L1 && flagsBySec[L2].explicit && hits[L2].key === h.key; });
            if (!others.length) return;
            // 組の中で一番多い断面だけが残りを受け取る(ほかの断面は旗の数・「x2」のまま)
            if (others.some(function (L2) { return cntOf(L2) > cntOf(L1) || (cntOf(L2) === cntOf(L1) && order.indexOf(L2) < order.indexOf(L1)); })) return;
            var rest = h.n - others.reduce(function (a, L2) { return a + cntOf(L2); }, 0);
            if (rest > cntOf(L1)) f.unmatched = rest - f.matched.length;
          } else if (h.n > cntOf(L1)) f.unmatched = h.n - f.matched.length;
        });
      }
      // 旗の無い板 → 同じ板厚で旗のある場所の断面を引き継ぐ
      positions.forEach(function (p) {
        if (p.secs.length) return;
        var same = positions.filter(function (q) { return q.secs.length && q.ts.length === p.ts.length && q.ts.every(function (t, i) { return Math.abs(t - p.ts[i]) <= 1.6; }); });
        // 同じ板厚の旗の場所が別々の断面なら、どの断面か決められないので当てはめない
        // (2G-01: 厚さ9の断面が C・D・E・F・DK1 とあり、方杖の取り付きの板を C とみなしていた。2026-11-19)
        if (same.length && same.every(function (q) { return q.secs.join(',') === same[0].secs.join(','); })) {
          // 断面の表記がすべて「2PL-16」のように2枚以上で、すぐそば(1000以内)に旗のある同じ断面の板があるときは、旗の無い板はその「2」に含まれる
          // (2026-11-21 ユーザー指摘、EA2-RG-05: 柱の両フランジの下の補強板2か所に旗 B が1つ、B断面は左右に「2PL-16 NGR8K」→ 4枚。8枚にしていた)
          var inPair = same[0].secs.every(function (L) { return (secInfo[L].cntMin || 1) >= 2; }) &&
            same.some(function (q) { return Math.min(Math.abs(q.x - p.x1), Math.abs(p.x - q.x1)) <= 1000; });
          if (!inPair) p.secs = same[0].secs.slice();
        }
        else if (same.length) {
          // 決められないときは、描かれている線の形(縦線の位置と上下の範囲)がまったく同じ旗のある板の断面にする
          // (2G-02: 旗のない x≈8202 の板が DK1 の板と同じ形。2026-11-20)
          var sig = function (q) {
            return vlines.filter(function (l) { return Math.abs(l.x - q.x) < 30 && l.y1 - l.y0 >= 60 && l.y1 > elev.bot - 100 && l.y0 < elev.top + 1500; })
              .map(function (l) { return [Math.round((l.x - q.x) * 2) / 2, Math.round(l.y0), Math.round(l.y1)]; })
              .sort(function (a, b) { return a[0] - b[0] || a[1] - b[1] || a[2] - b[2]; });
          };
          var sp = sig(p);
          var eq = function (a, b) { return a.length === b.length && a.every(function (x, i) { return Math.abs(x[0] - b[i][0]) <= 1 && Math.abs(x[1] - b[i][1]) <= 1 && Math.abs(x[2] - b[i][2]) <= 1; }); };
          var twins = same.filter(function (q) { return eq(sp, sig(q)); });
          if (twins.length && twins.every(function (q) { return q.secs.join(',') === twins[0].secs.join(','); })) p.secs = twins[0].secs.slice();
          else p.ambiguous = true;
        }
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
            marks[m].notes.push((p.note || si.title.sub || '') + (p.mekki ? '|めっき' : ''));
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
      // 入れ子の中の入れ子も数える(C断面の中のア、アの中のエ)。数 = 親の断面の数 × 中の記号の数(2026-11-19 ユーザー決定)
      function addNested(L1, cnt, depth) {
        if (depth > 5) return;
        secInfo[L1].nested.forEach(function (N) { addSecPlatesOnce([N], cnt); addNested(N, cnt, depth + 1); });
      }
      Object.keys(secInfo).forEach(function (L1) { if (secCount[L1]) addNested(L1, secCount[L1], 0); });
      // 跳ね出しの山形鋼(2G-01 の DK2・DK3・DK4 の L-65x65x6。2026-11-19 ユーザー説明):
      // 旗は一部の山形鋼にしか無いので、平面図・立面図に描かれた山形鋼(長さ d の平行な3本 = 0・厚さ・脚 か 0・脚-厚さ・脚)をすべて数え、
      // 旗のある山形鋼から各断面の「長さ」と「背の向き」を覚えて、旗のない山形鋼を長さと向きが同じ断面に入れる
      var angleSecs = {}, doneShapeAngles = {};
      // 断面 L1 の山形鋼の表記から引出線(表記の下の横線)→ 指示線 → 指す線、とたどり、その線の長さ(小数第1位)を返す。main と同じ長さは除く
      function angleOthers(L1, main) {
        var segD = function (pt, l) {
          var dx = l[2] - l[0], dy = l[3] - l[1], nn = dx * dx + dy * dy, k = nn ? ((pt[0] - l[0]) * dx + (pt[1] - l[1]) * dy) / nn : 0;
          k = Math.max(0, Math.min(1, k)); return Math.hypot(pt[0] - l[0] - k * dx, pt[1] - l[1] - k * dy);
        };
        var lenOf = function (l) { return Math.hypot(l[2] - l[0], l[3] - l[1]); };
        var out = [];
        T.forEach(function (t) {
          if (!/^L-/.test(t.text) || !RE_SHAPE.test(t.text.replace(/X/g, 'x')) || (sectionOf(t, titles) || {}).letter !== L1) return;
          var lead = L.filter(function (l) { return Math.abs(l[1] - l[3]) < 0.5 && Math.abs(l[1] - t.y) < 3 && Math.min(l[0], l[2]) < t.x + 5 && Math.min(l[0], l[2]) > t.x - 60; })
            .sort(function (a, b) { return lenOf(b) - lenOf(a); })[0];
          if (!lead) return;
          [[lead[0], lead[1]], [lead[2], lead[3]]].forEach(function (e) {
            L.forEach(function (m) {
              if (m === lead) return;
              var o = Math.hypot(m[0] - e[0], m[1] - e[1]) < 3 ? [m[2], m[3]] : (Math.hypot(m[2] - e[0], m[3] - e[1]) < 3 ? [m[0], m[1]] : null);
              if (!o) return;
              var tg = L.filter(function (z) { return z !== m && lenOf(z) > 100 && lenOf(z) < 3000; }).sort(function (a, b) { return segD(o, a) - segD(o, b); })[0];
              if (!tg || segD(o, tg) > 5) return;
              var len2 = Math.round(lenOf(tg) * 10) / 10;
              if (Math.abs(len2 - main) > 1 && out.indexOf(len2) < 0) out.push(len2);
            });
          });
        });
        return out;
      }
      Object.keys(secInfo).forEach(function (L1) {
        var si = secInfo[L1];
        if (si.joint || !flagsBySec[L1]) return;
        var sh = si.shapes.map(function (x) { return /^L-([0-9.]+)x([0-9.]+)x([0-9.]+)$/.exec(x); }).filter(Boolean)[0];
        if (!sh || doneShapeAngles[L1]) return;
        angleSecs[L1] = { size: sh[0], leg: parseFloat(sh[1]), th: parseFloat(sh[3]), dims: si.dims };
      });
      if (Object.keys(angleSecs).length) {
        var pieces = [];   // {x, len, dir}
        var addPieces = function (ls, pos, s0, s1, mid) {
          ls.forEach(function (a) {
            Object.keys(angleSecs).forEach(function (L1) {
              var A = angleSecs[L1], d = s1(a) - s0(a);
              if (A.dims.indexOf(Math.round(d)) < 0 || Math.abs(d - Math.round(d)) > 0.6) return;
              var same = function (off) { return ls.some(function (b) { return Math.abs(pos(b) - pos(a) - off) < 1 && Math.abs(s0(b) - s0(a)) < 1 && Math.abs(s1(b) - s1(a)) < 1; }); };
              var dir = same(A.leg) ? (same(A.th) ? 'A' : (same(A.leg - A.th) ? 'B' : null)) : null;
              if (!dir) return;
              var c = mid(a);
              if (!pieces.some(function (q) { return Math.abs(q.c - c) < 50 && q.len === Math.round(d) && q.size === A.size; })) pieces.push({ c: c, len: Math.round(d), dir: dir, size: A.size });
            });
          });
        };
        addPieces(vlines.filter(function (l) { return inView(v, { x: l.x, y: (l.y0 + l.y1) / 2 }); }), function (l) { return l.x; }, function (l) { return l.y0; }, function (l) { return l.y1; }, function (l) { return l.x + 32; });
        // 旗のある山形鋼 → 断面の長さと向き
        var learned = {};
        T.forEach(function (t) {
          if (!inView(v, t) || !angleSecs[t.text]) return;
          var fx = flagLineX(t); if (fx === null) return;
          var near1 = pieces.slice().sort(function (a, b) { return Math.abs(a.c - fx) - Math.abs(b.c - fx); })[0];
          if (!near1 || Math.abs(near1.c - fx) > 400) return;
          // 旗のそばに同じくらい近い材が複数あるときは、図にたくさん並ぶ長さの材にする(2026-11-21 ユーザー指示「L-50x5x6 は長さ640で6本」、
          // WB3-3G-10: 旗「い」のそばに PL-6x100 の板(同じ線の並びで 100 の材に見える)が 640 の山形鋼より 6 近くにあった)
          var freq = function (q) { return pieces.filter(function (r) { return r.len === q.len && r.size === q.size && r.dir === q.dir; }).length; };
          var d0 = Math.abs(near1.c - fx);
          near1 = pieces.filter(function (q) { return Math.abs(q.c - fx) <= d0 + 50; }).sort(function (a, b) { return freq(b) - freq(a) || Math.abs(a.c - fx) - Math.abs(b.c - fx); })[0];
          near1.sec = t.text;
          learned[t.text] = learned[t.text] || { len: near1.len, dir: near1.dir };
        });
        pieces.forEach(function (q) {
          if (q.sec) return;
          var cand = Object.keys(learned).filter(function (L1) { return learned[L1].len === q.len && learned[L1].dir === q.dir; });
          if (cand.length === 1) q.sec = cand[0];
        });
        Object.keys(learned).forEach(function (L1) {
          var n = pieces.filter(function (q) { return q.sec === L1; }).length;
          if (!n) return;
          add(angleSecs[L1].size, learned[L1].len, n, secInfo[L1].title.sub || ''); doneShapeAngles[L1] = 1;
          // 断面図の山形鋼の表記が指す材が跳ね出し材と別の長さなら、それも同じ本数ずつ(DK の 290.5。平面図では梁に隠れて数えにくい。2026-11-19 ユーザー説明)
          angleOthers(L1, learned[L1].len).forEach(function (len2) { add(angleSecs[L1].size, len2, n, secInfo[L1].title.sub || ''); });
        });
      }

      layerDetails.forEach(function (dt) {
        var ls = L.filter(function (l) { return l[4] === dt.layer && inView(v, { x: (l[0] + l[2]) / 2, y: (l[1] + l[3]) / 2 }); });
        var hs = ls.filter(function (l) { return Math.abs(l[1] - l[3]) < 0.5; }).map(function (l) { return { p: l[1], a: Math.min(l[0], l[2]), b: Math.max(l[0], l[2]) }; });
        var vs = ls.filter(function (l) { return Math.abs(l[0] - l[2]) < 0.5; }).map(function (l) { return { p: l[0], a: Math.min(l[1], l[3]), b: Math.max(l[1], l[3]) }; });
        dt.labels.forEach(function (lb) {
          var th = thickOf(lb.size), n = 0;
          [hs, vs].forEach(function (g) {
            g.forEach(function (a) { if (g.some(function (b2) { return Math.abs(b2.p - a.p - th) < 0.6 && Math.abs(b2.a - a.a) < 0.6 && Math.abs(b2.b - a.b) < 0.6; })) n++; });
          });
          if (n) add(lb.size, lb.mark, n * lb.cnt, dt.title);
        });
      });
      if (saya) {
        // サヤ管のレイヤが無い図面(EA1-3B-03)は、図の中のすべての線で数える(外径だけ離れた・長さ L の平行な2本 = 1本の管。上フランジの上に立つ 60.5×220 の長方形)
        var sl = L.filter(function (l) { return (!saya.layers.length || saya.layers.indexOf(l[4]) >= 0) && inView(v, { x: (l[0] + l[2]) / 2, y: (l[1] + l[3]) / 2 }) && Math.abs(Math.hypot(l[2] - l[0], l[3] - l[1]) - saya.len) < 0.6; });
        if (!saya.layers.length) {   // 同じ線が重ねて描かれていても1本に
          var seenL = {}; sl = sl.filter(function (l) { var k = [l[0], l[1], l[2], l[3]].map(function (x) { return x.toFixed(1); }).join(','); if (seenL[k]) return false; seenL[k] = 1; return true; });
        }
        var gs = [sl.filter(function (l) { return Math.abs(l[0] - l[2]) < 0.5; }).map(function (l) { return { p: l[0], a: Math.min(l[1], l[3]), b: Math.max(l[1], l[3]) }; }),
          sl.filter(function (l) { return Math.abs(l[1] - l[3]) < 0.5; }).map(function (l) { return { p: l[1], a: Math.min(l[0], l[2]), b: Math.max(l[0], l[2]) }; })];
        var nSaya = 0;
        gs.forEach(function (g) { g.forEach(function (a) { if (g.some(function (b2) { return Math.abs(b2.p - a.p - saya.od) < 0.6 && Math.abs(b2.a - a.a) < 0.6 && Math.abs(b2.b - a.b) < 0.6; })) nSaya++; }); });
        if (nSaya) { add(saya.size, saya.len, nSaya, 'サヤ管'); sayaCounted = true; }
      }
      // 管(スリーブ管 P-318.5x6 と L=1310。1G-01。2026-11-20 ユーザー指示): 図の中の表記1つにつき1本
      T.forEach(function (t) {
        if (!inView(v, t) || !/^P-[0-9.]+x[0-9.]+$/.test(t.text)) return;
        var lt = T.filter(function (w) { return /^L=[0-9.]+$/.test(w.text) && Math.abs(w.x - t.x) < 60 && t.y - w.y > 0 && t.y - w.y < 120; })[0];
        if (lt) add(t.text, parseFloat(lt.text.slice(2)), 1, '');
      });
      // 立面図に直接書かれた板の表記(例: PL-12 / KGR64)
      // 旗がなく、どの断面か決められない板がある場所 → 名前だけの断面図(例「外装ALC下地」)があれば、その断面とみなす(2026-11-19 ユーザー説明、2G-01)
      // 切板は符号ごとに 場所の数 だけ。形鋼(L-90X90X7 と L=110)は、図に並ぶ「長さ×脚」の箱の数
      var amb = positions.filter(function (p) { return p.ambiguous; }).length;
      if (amb && named) {
        named.marks.forEach(function (m) { add(m.size, m.mark, m.cnt * amb, named.title); });
        named.shapes.forEach(function (sh) {
          if (sh.kind === 'angle') {
            // 立面図の山形鋼: 長さ d の平行な線が 0・厚さ・脚 の位置に3本(縦でも横でも)
            var best = null;
            sh.dims.forEach(function (d) {
              var vs = vlines.filter(function (l) { return Math.abs(l.y1 - l.y0 - d) < 0.6 && inView(v, { x: l.x, y: (l.y0 + l.y1) / 2 }); });
              var hs2 = hlines.filter(function (h) { return Math.abs(h.x1 - h.x0 - d) < 0.6 && inView(v, { x: (h.x0 + h.x1) / 2, y: h.y }); });
              function groups(ls, pos, s0, s1) {
                var cnt = 0;
                ls.forEach(function (a) {
                  var same = function (off) { return ls.some(function (b) { return Math.abs(pos(b) - pos(a) - off) < 1 && Math.abs(s0(b) - s0(a)) < 1 && Math.abs(s1(b) - s1(a)) < 1; }); };
                  if (same(sh.th) && same(sh.leg)) cnt++;
                });
                return cnt;
              }
              var n = groups(vs, function (l) { return l.x; }, function (l) { return l.y0; }, function (l) { return l.y1; }) +
                groups(hs2, function (h) { return h.y; }, function (h) { return h.x0; }, function (h) { return h.x1; });
              if (n && (!best || n > best.n)) best = { d: d, n: n };
            });
            if (best) add(sh.size, best.d, best.n, named.title);
            return;
          }
          var hs = hlines.filter(function (h) { return inView(v, { x: (h.x0 + h.x1) / 2, y: h.y }) && Math.abs(h.x1 - h.x0 - sh.len) < 0.6; });
          var byY = {};
          hs.forEach(function (a) {
            if (!hs.some(function (b) { return Math.abs(b.y - a.y - sh.leg) < 1 && Math.abs(b.x0 - a.x0) < 1 && Math.abs(b.x1 - a.x1) < 1; })) return;
            var k = a.y.toFixed(0); byY[k] = (byY[k] || 0) + 1;
          });
          var n = Math.max.apply(null, [0].concat(Object.keys(byY).map(function (k) { return byY[k]; })));
          add(sh.size, sh.len, n || amb, named.title);
        });
      }
      elevLabels.forEach(function (lb) { if (inView(v, lb) && !(named && amb && named.used.has(lb))) add(lb.size, lb.mark, lb.cnt, ''); });

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

      // 長さの無い「FB-6x50」(2026-11-21 ユーザー指摘「FB-6x50も拾えるのでは？」、EA2-RG-05 の平面図「FB-6x50 (上FLG付き)」):
      // 引出線の先の □(幅 = 表記の幅だけ離れた、同じ範囲の平行な横線2本)の長さを切板名に、表記1つにつき1本。備考は表記のそばの(〜)
      T.forEach(function (t) {
        var m = /^FB-([0-9.]+)x([0-9.]+)$/.exec(t.text);
        if (!m || !inView(v, t)) return;
        var w = parseFloat(m[2]), a0 = shapeAnchor(t);
        if (a0 === t) return;
        var hs = hlines.filter(function (h) { return Math.abs(h.y - a0.y) < 2 && h.x0 - 2 <= a0.x && h.x1 + 2 >= a0.x; });
        var len = null;
        hs.some(function (h) {
          var mate = hlines.find(function (g) { return g !== h && Math.abs(Math.abs(g.y - h.y) - w) < 0.8 && Math.abs(g.x0 - h.x0) < 1 && Math.abs(g.x1 - h.x1) < 1; });
          if (mate) { len = Math.round((h.x1 - h.x0) * 10) / 10; return true; }
          return false;
        });
        if (!len) return;
        var nt = T.filter(function (u) { return /^[(（].+[)）]$/.test(u.text) && t.y - u.y > 0 && t.y - u.y < 200 && t.x - u.x > 0 && t.x - u.x < 800; })[0];
        add('FB-' + m[1] + 'x' + m[2], len, 1, nt ? stripParen(nt.text) : '');
      });

      // 形鋼の受材(継手の表記がある断面=別の部材は除く)
      var doneShape = {};
      Object.keys(secInfo).forEach(function (L1) {
        var si = secInfo[L1];
        if (!si.shapes.length || si.joint) return;
        Array.from(new Set(si.shapes)).forEach(function (shape) {
          if (doneShape[shape]) return;
          if (shape.charAt(0) === 'L' && elev && flagsBySec[L1] && !doneShapeAngles[L1]) {
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
          } else if (shape.charAt(0) === 'C' || shape.charAt(0) === '[') {
            // 溝形鋼: 平面図で、断面の寸法と同じ長さの縦線の組
            // 断面の寸法のうち、溝形鋼そのものの大きさ(「[-100x50x5x7.5」の 100・50)は長さではない(2026-11-21、WB1-3G-05: 100×40 を拾っていた)
            var secSz = (/^[C\[]-([0-9.x]+)$/.exec(shape) || [, ''])[1].split('x').slice(0, 2).map(parseFloat);
            var crossC = function () {
              var fl0 = flagsBySec[L1]; if (si.title.sub !== 'LGS下地' || !fl0 || !(fl0.matched.length + fl0.unmatched)) return false;
              var rows = {}, mx = 0;
              (si.dimT2 || []).forEach(function (d) { var k = Math.round(d.y / 20); rows[k] = (rows[k] || 0) + parseFloat(d.text); });
              Object.keys(rows).forEach(function (k) { mx = Math.max(mx, rows[k]); });
              return mx >= 100;
            };
            si.dims.forEach(function (len) {
              if (shape.charAt(0) === '[' && secSz.indexOf(len) >= 0) return;
              // 同じ形鋼・同じ長さをほかの断面ですでに平面図で数えていれば、この断面も数え済み(WB1-3G-06 の さ・す の [-100x50x5x7.5 295)
              if (doneShape[shape + '@' + len]) { if (doneShape[shape + '@' + len + '#cnt']) doneShape[shape + '#plan' + L1] = 1; return; }
              doneShape[shape + '@' + len] = 1;
              var vs = vlines.filter(function (l) { return inView(v, { x: l.x, y: (l.y0 + l.y1) / 2 }) && Math.abs(l.y1 - l.y0 - len) < 0.6; }).sort(function (a, b) { return a.x - b.x; });
              var used = new Set(), cnt = 0;
              vs.forEach(function (a) { if (used.has(a)) return; var b = vs.find(function (l) { return l !== a && !used.has(l) && l.x - a.x > 0 && l.x - a.x <= 40 && Math.abs(l.y0 - a.y0) < 0.6; }); if (b) { used.add(a); used.add(b); cnt++; } });
              // 「C-」の LGS下地で、立面図に旗があり断面図の寸法の合計が100以上(梁を横切る部材)のときは、下面図の線では数えず下の①で数える
              // (2026-11-21 ユーザー指示「650 1本」、WB3-3G-07: 下面図は1本の C を4本の線で描き2組に見える。本数は立面図の旗・端面の数)
              if (cnt && shape.charAt(0) === 'C' && crossC()) { doneShape[shape + '@' + len] = 0; return; }
              if (cnt) add(shape, len, cnt, si.title.sub || '');
              if (cnt) { doneShape[shape + '#plan' + L1] = 1; doneShape[shape + '@' + len + '#cnt'] = 1; }   // 断面ごと(2026-11-21、WB3-3G-06: あ を平面図で数えたため、同じ C の い(梁に沿う 1433)を読んでいなかった)
            });
            // 平面図で数えられないとき(梁の下に付く LGS下地。EA1-3G-01・EA1-3B-01、2026-11-20 ユーザー指示「サイズと長さと本数が図面より見れる」):
            // 長さ = 断面図の寸法の、同じ高さに並ぶ数の合計の一番大きいもの(EA1-3G-01「あ」: 225+225=450 と 450 → 450、EA1-3B-01: 150+150=300)
            // 本数 = 立面図の旗の数 × 断面図の表記の数
            var fl = flagsBySec[L1], nFlag = fl ? fl.matched.length + fl.unmatched : 0;
            if (!doneShape[shape + '#plan' + L1] && nFlag) {
              // 断面図の寸法の、同じ高さに並ぶ数の合計の一番大きいもの(小数も)
              var nLab = si.shapes.filter(function (x) { return x === shape; }).length, byRow = {}, len = 0;
              (si.dimT2 || []).forEach(function (d) { var k = Math.round(d.y / 20); byRow[k] = (byRow[k] || 0) + parseFloat(d.text); });
              Object.keys(byRow).forEach(function (k) { len = Math.max(len, byRow[k]); });
              if (len >= 100) {
                // ① 梁を横切る溝形鋼(梁の下に付く LGS下地。EA1-3G-01・EA1-3B-01、2026-11-20 ユーザー指示「サイズと長さと本数が図面より見れる」):
                //    長さ = その合計(EA1-3G-01: 225+225=450、EA1-3B-01: 150+150=300、EA1-3B-05: 87.5+87.5=175)、本数 = 立面図の旗の数 × 断面図の表記の数
                //    旗が無い所にも同じ部材があるとき(WB1-3G-03: 旗「あ」は1つ、取付位置は 1803・4913 の2か所。2026-11-21 ユーザー指摘「旗が無いところの分が拾えていない」):
                //    立面図の梁の下の端から見た溝形鋼(C-75x45x15x2.3 なら 幅75の両端に板厚2.3離れた縦線の組)を数え、旗の数より多ければその数にする
                //    断面図で溝形鋼が梁幅の一部だけのとき(2G-01 の M断面: 寸法 160・80・160 で溝形鋼は真ん中の80。2026-11-21 ユーザー説明「長さは80」):
                //    引出線の先の溝形鋼の横線の長さと同じ寸法があれば、それを長さにする
                var anc = si.anchors && si.anchors[shape];
                if (anc) {
                  var segL = hlines.filter(function (h) { return anc.x >= h.x0 - 5 && anc.x <= h.x1 + 5 && Math.abs(h.y - anc.y) < 60; }).map(function (h) { return h.x1 - h.x0; });
                  var hit = (si.dimT2 || []).map(function (d) { return parseFloat(d.text); }).filter(function (d) { return segL.some(function (w) { return Math.abs(w - d) < 1; }); });
                  if (hit.length) len = Math.max.apply(null, hit);
                }
                var nPos = nFlag, cH = parseFloat((/^[C\[]-([0-9.]+)x/.exec(shape) || [])[1]), cT = parseFloat((/x([0-9.]+)$/.exec(shape) || [])[1]) || 0;
                var cB = parseFloat((/^[C\[]-[0-9.]+x([0-9.]+)/.exec(shape) || [])[1]);
                if (shape.charAt(0) === '[') cT = parseFloat((/^\[-[0-9.]+x[0-9.]+x([0-9.]+)/.exec(shape) || [])[1]) || 0;
                if (elev && cH && cT) {
                  var cv = vlines.filter(function (l) { return l.x >= elev.x0 - 1 && l.x <= elev.x1 + 1 && l.y1 <= elev.bot + 1 && l.y0 >= elev.bot - 300; });
                  var hasV = function (x, a) { return cv.some(function (l) { return Math.abs(l.x - x) < 0.3 && Math.abs(l.y0 - a.y0) < 0.6 && Math.abs(l.y1 - a.y1) < 0.6; }); };
                  var seenC = {}, nC = 0;
                  cv.forEach(function (a) {
                    if (!hasV(a.x + cT, a) || !hasV(a.x + cH - cT, a) || !hasV(a.x + cH, a)) return;
                    var k = Math.round(a.x); if (seenC[k]) return; seenC[k] = 1; nC++;
                  });
                  // 向きの違う書き方(2G-01: 「[-75x40x5x7」の端面 = 長さ75の縦線の上下の端から長さ40の横線)
                  if (cB) cv.forEach(function (a) {
                    if (Math.abs(a.y1 - a.y0 - cH) > 0.6) return;
                    var fl2 = function (y) { return hlines.some(function (h) { return Math.abs(h.y - y) < 0.3 && Math.abs(h.x1 - h.x0 - cB) < 0.6 && (Math.abs(h.x0 - a.x) < 0.3 || Math.abs(h.x1 - a.x) < 0.3); }); };
                    if (!fl2(a.y0) || !fl2(a.y1)) return;
                    var k = Math.round(a.x); if (seenC[k] || seenC[k - 1] || seenC[k + 1]) return; seenC[k] = 1; nC++;
                  });
                  // 同じ C の梁を横切る LGS下地の断面がほかにもあれば、その旗の数を引いた残り(2026-11-21 ユーザー確認、WB3-3G-12: あ・い 各1、端面2つ → 112.5×2)
                  var othersF = 0;
                  Object.keys(secInfo).forEach(function (L2) {
                    if (L2 === L1 || secInfo[L2].shapes.indexOf(shape) < 0 || !flagsBySec[L2]) return;
                    var rw = {}, mx2 = 0;
                    (secInfo[L2].dimT2 || []).forEach(function (d) { var k = Math.round(d.y / 20); rw[k] = (rw[k] || 0) + parseFloat(d.text); });
                    Object.keys(rw).forEach(function (k) { mx2 = Math.max(mx2, rw[k]); });
                    if (mx2 >= 100) othersF += flagsBySec[L2].matched.length + flagsBySec[L2].unmatched;
                  });
                  if (nC - othersF > nPos) nPos = nC - othersF;
                }
                add(shape, Math.round(len * 10) / 10, nPos * nLab, si.title.sub || '');
              } else {
                // ② 合計が100未満 = 梁に沿って長く付く溝形鋼を端から見た断面(EA1-3B-04「あ」: 37.5+37.5=75。2026-11-20 ユーザー指示「長さ2968は拾えない？」):
                //    立面図で、溝形鋼の幅(C-75x45… の 45)だけ離れた同じ長さの平行な横線の組を部材とし、その範囲に旗があるものを拾う(長さ = 線の長さ)。
                //    短いものもある(EA1-3B-06「あ」: 43×45 の四角・寸法43。2026-11-20 ユーザー指摘「あ断面のLGSが拾えていない」)
                var bw = parseFloat((/^[C\[]-[0-9.]+x([0-9.]+)/.exec(shape) || [])[1]), ct = parseFloat((/x([0-9.]+)$/.exec(shape) || [])[1]) || 0;
                var fxs = looseFlags.filter(function (f) { return f.L1 === L1; }).map(function (f) { return f.fx; });
                if (bw && fxs.length) {
                  var hh = L.filter(function (l) { return Math.abs(l[1] - l[3]) < 0.5 && Math.abs(l[0] - l[2]) >= 20; }).map(function (l) { return { y: l[1], x0: Math.min(l[0], l[2]), x1: Math.max(l[0], l[2]) }; })
                    .filter(function (h) { return inView(v, { x: (h.x0 + h.x1) / 2, y: h.y }); });
                  var seenM = {};
                  hh.forEach(function (a) {
                    // 間隔 = 幅(45)。片方の辺が梁のフランジの線と重なる図面は、板厚だけ内側の線(45-2.3=42.7。EA1-3B-06)
                    var b2 = hh.find(function (h) { var dy = h.y - a.y; return h !== a && (Math.abs(dy - bw) < 0.3 || (ct && Math.abs(dy - (bw - ct)) < 0.3)) && Math.abs(h.x0 - a.x0) < 0.6 && Math.abs(h.x1 - a.x1) < 0.6; });
                    if (!b2) return;
                    // 同じ部材の線(幅・板厚の線)が何組もあっても1本(左右の端が同じで上下が幅の範囲内)
                    var k = a.x0.toFixed(0) + '-' + a.x1.toFixed(0);
                    if ((seenM[k] || []).some(function (y) { return Math.abs(y - a.y) <= bw + 1; })) return; (seenM[k] = seenM[k] || []).push(a.y);
                    if (!fxs.some(function (fx) { return fx >= a.x0 - 100 && fx <= a.x1 + 100; })) return;
                    // 立面図の梁の下の線だけ(下面図の同じ長さの線は数えない。2026-11-21、WB3-3G-12 の う 3021: 2 → 1)
                    if (elev && (a.y < elev.bot - 300 || a.y > elev.top + 300)) return;
                    add(shape, Math.round((a.x1 - a.x0) * 10) / 10, 1, si.title.sub || '');
                  });
                }
              }
            }
          }
        });
      });

      // 図に引出線で直接書かれた形鋼(別の書き方の図面。例 WR-2G-2 の「デッキ受け L-65x65x6」。2026-11-19)
      // 表記の左下が引出線の端。引出線のどちらかの端から出る線(指示線)の先にある形鋼を1本と数える。
      // 形鋼 = 同じ長さの平行な線が3本以上(梁が傾いていてもよい)。長さ = その線の長さ(小数第2位を四捨五入)
      // 引出線のそばに「現場取付」とあるものは拾わない(お知らせに出す)
      leaderShapes(v).forEach(function (o) {
        if (o.onSite) { excluded.add('現場取付の形鋼'); return; }
        if (doneShape[o.shape]) return;   // 断面図の表記から拾った形鋼とは重ねない
        add(o.shape, Math.round(o.len * 10) / 10, 1, o.note);
      });

      // スリーブの金物(2026-11-20 ユーザー指示)。そばに孔の書き込み(φ)があるものだけ。「(150φ)」「(下孔205φ)」は孔の大きさで金物ではない。サイズ欄は表記のまま、備考は「スリーブ」
      //  - 「150S」(EA1-3B-01): ウェブの片側の孔の上下に1つずつ付く → 1か所につき2個
      //  - 「150B」(EA1-3G-01): 1か所につき1個
      T.forEach(function (t) {
        //  - 「150R」「200R」(WB3-3G-05。そばに「(下孔195φ)」)も1か所につき1個(2026-11-21 ユーザー指示)
        var m = /^[0-9]+([SBR])$/.exec(t.text);
        if (!m || !inView(v, t)) return;
        if (!T.some(function (u) { return /φ/.test(u.text) && Math.abs(u.x - t.x) < 300 && Math.abs(u.y - t.y) < 300; })) return;
        add(t.text, '', m[1] === 'S' ? 2 : 1, 'スリーブ');
      });
      var list = Object.keys(items).map(function (k) {
        var it = items[k];
        var subs = new Set(), mekki = false;
        it.notes.forEach(function (nt) { var p = nt.split('|'); subs.add(p[0]); if (p[1]) mekki = true; });
        // 符号の末尾の M(番号のすぐあと。MK の M も)= めっき(2026-11-21 ユーザー指示、EA1-RG-01: NG121M・NHG143MK はめっき)
        if (typeof it.name === 'string' && /[0-9]M[A-Z]?$/.test(it.name)) mekki = true;
        var parts = [];
        if (subs.size === 1 && Array.from(subs)[0]) parts.push(Array.from(subs)[0]);
        if (mekki) parts.push('めっき');
        return { size: it.size, name: it.name, n: it.n, note: parts.join('・') };
      });
      // 「(EA12-3TB888-2梁取付)」の書き込みのすぐ下の見出し(LGS下地)の金物は、その製品だけに付ける(2026-11-20 ユーザー指示、EA1-3B-03: -2 だけ LGS下地あり)
      var onlyFor = {};   // 見出し → 製品名の一覧
      T.forEach(function (u) {
        var mm = /^[(（]?(.+?)梁?取付[)）]?$/.exec(u.text); if (!mm) return;
        var who = v.products.filter(function (p) { return mm[1].trim() === p.name; }); if (!who.length) return;
        var lab = T.filter(function (w) { return w !== u && u.y - w.y > 0 && u.y - w.y < 300 && Math.abs(w.x - u.x) < 1500 && !/取付/.test(w.text); })
          .sort(function (a, b) { return (u.y - a.y) - (u.y - b.y); })[0];
        if (!lab) return;
        var key = stripParen(lab.text);
        onlyFor[key] = (onlyFor[key] || []).concat(who.map(function (p) { return p.name; }));
      });
      v.products.forEach(function (p) {
        result.products.push({ view: views.indexOf(v), zuban: info.zuban, name: p.name, fugo: p.fugo, dai: p.dai, size: main, length: length, y: p.y, x: p.x,
          items: list.filter(function (it) { return !(it.note && onlyFor[it.note]) || onlyFor[it.note].indexOf(p.name) >= 0; })
            .map(function (it) { return { size: it.size, name: it.name, n: it.n, note: it.note }; }) });
      });
    });
    // 図面の上段の図から順(チェックしやすい)。同じ図の製品は製品名の番号順(GJ9→GJ10→GJ12)
    result.products.sort(function (a, b) { return a.view - b.view || cmpNat(a.name, b.name); });
    // 柱の詳細図(「図示」の行)は製品だけ読む。柱の金物の拾い出しのルールはまだ決めていない(2026-11-20、EB1-0C-04)
    // columnDrawing: 長さを tdf-master-web の柱モード(py/tdf_column.py)で求める目印(梁の図面には付けない)
    if (pr.rows.some(function (r) { return r.column; })) {
      result.columnDrawing = true;
      var colItems = columnItems();
      result.products.forEach(function (p) { if (pr.rows.some(function (r) { return r.column && r.name === p.name; })) p.items = colItems; });
      if (!colItems.length) result.warnings.push('柱の詳細図です。製品は読みましたが、GENレイヤのマークが見つからないため金物は抽出していません');
    }
    // ---------- 柱の金物(2026-11-20 ユーザー指示、EB1-0C-04): レイヤ GEN のマークとその数量 ----------
    //  - マーク = GEN レイヤの文字(ND9H・N-R61K など。L-270 のような寸法の書き方は除く)。サイズ = マークのそば(800以内)で一番近い板の表記(PL-50・R.PL-28・PL-36・PL-50xφ1750・FB-90x12x4面)
    //  - 数量 = GEN レイヤに書かれたそのマークの数(十文字補強: N-R10BK・N-R70BK は2か所、N-R10AK・N-R70AK は1か所 = ユーザー確認)。「FB-90x12x4面」は ×4(NCKE1 = 4枚、ユーザー確認)
    //  - マークが断面図(E・F)の中にあり、その断面の旗が図(A断面のベースプレートの平面図)にあるときは、図に描かれた同じ板
    //    (板厚だけ離れた平行な2本の線で、長さが断面図の寸法と1.5%以内)の数(E=328.6 が8か所、F=200.9 が4か所 = ユーザー確認)
    function columnItems() {
      var pairCache = {};
      var genNo = P.layers.indexOf('GEN') + 1; if (!genNo) return [];
      var gen = T.filter(function (t) { return t.lay === genNo && /^[A-Z][A-Z0-9]*(-[A-Z0-9]+)*$/.test(t.text) && !/^(L|C|H|PL|FB|G?PL)-/.test(t.text) && /[0-9]/.test(t.text); });
      var sizesT = T.filter(function (t) { return /(^|[ .])(G?PL|FB)-[0-9]/.test(t.text) || /^(G?PL|FB)-[0-9]/.test(t.text); });
      var byMark = {};
      gen.forEach(function (t) { (byMark[t.text] = byMark[t.text] || []).push(t); });
      var out = [];
      Object.keys(byMark).forEach(function (mk) {
        var occ = byMark[mk];
        // 同じ高さ(±60)に書かれた表記を優先(十文字補強の「N BPL-36 (十文字補強)  N-R70AK」。そばの F.PL-40x450 と取り違えない)、無ければ一番近いもの
        var o0 = occ[0];
        var sameRow = sizesT.filter(function (a) { return Math.abs(a.y - o0.y) <= 60 && dist(a, o0) <= 800; }).sort(function (a, b) { return dist(a, o0) - dist(b, o0); });
        var sz = sameRow[0] || sizesT.slice().sort(function (a, b) { return dist(a, o0) - dist(b, o0); })[0];
        // 800以内に無いときは、同じ高さ(±60)の1200以内まで見る(EB2-1C-03 の NCKE1 は「FB-90x12x4面」と同じ高さで970離れている。2026-11-20 ユーザー指摘「NCKE1の漏れ」)
        if (!sz || dist(sz, o0) > 800) sz = sizesT.filter(function (a) { return Math.abs(a.y - o0.y) <= 60 && dist(a, o0) <= 1200; }).sort(function (a, b) { return dist(a, o0) - dist(b, o0); })[0];
        if (!sz) return;
        var st = sz.text.replace(/^.*?((?:G?PL|FB)-)/, '$1'), mult = 1;
        var mm2 = /x([0-9]+)面/.exec(st); if (mm2) { mult = parseInt(mm2[1], 10); st = st.replace(/x[0-9]+面.*$/, ''); }   // 「FB-90x12x4面」= 4枚
        var m = /^((?:G?PL|FB)-[0-9.]+(?:x[φ0-9.]+)*)/.exec(st);
        if (!m) return;
        var size = m[1];
        var n = occ.length * mult;
        // 断面図の中のマーク → その断面の旗がある図で、同じ板の数を数える
        var sec = sectionOf(occ[0], titles);
        if (sec) {
          // 柱の図面の旗は文字のそばに縦線が無い(A断面の E・F)。断面の記号と同じ1文字で、見出しではなく、その断面の図の外にあり、同じ行のすぐ横(250以内)にほかの文字が無いもの
          var flags = T.filter(function (t) {
            if (t.text !== sec.letter || titles.some(function (x) { return x.letter === t.text && Math.abs(x.y - t.y) < 10; })) return false;
            if ((sectionOf(t, titles) || {}).letter === sec.letter) return false;
            return !T.some(function (u) { return u !== t && Math.abs(u.y - t.y) < 60 && Math.abs(u.x - t.x) < 250; });
          });
          var th = parseFloat((/-([0-9.]+)/.exec(size) || [])[1]);
          var dims = (secInfo[sec.letter] && secInfo[sec.letter].dimT2 || []).map(function (d) { return parseFloat(d.text); });
          if (flags.length && th && dims.length) {
            // 板 = 板厚だけ離れた平行な同じ長さの2本の線(長さ50以上)。その断面(E・F)自身の図の線は除く
            // 平行な同じ長さの2本の線の組は、断面の記号と板厚ごとに1回だけ求める(マークごとに作り直さない)。長さ順に並べ、長さの差が1を超えたら打ち切る
            var pk = sec.letter + '|' + th;
            var allPairs = pairCache[pk];
            if (!allPairs) {
              var cand = L.map(function (l) { return { l: l, len: Math.hypot(l[2] - l[0], l[3] - l[1]) }; })
                .filter(function (c) { return c.len >= 50 && (sectionOf({ x: (c.l[0] + c.l[2]) / 2, y: (c.l[1] + c.l[3]) / 2 }, titles) || {}).letter !== sec.letter; });
              cand.forEach(function (c, k) { c.k = k; });
              var byLen = cand.slice().sort(function (p, q) { return p.len - q.len; });
              var found = [];
              for (var ia = 0; ia < byLen.length; ia++) {
                var A = byLen[ia], a = A.l, la = A.len, ux = (a[2] - a[0]) / la, uy = (a[3] - a[1]) / la;
                for (var ib = ia + 1; ib < byLen.length && byLen[ib].len - la <= 1; ib++) {
                  var B = byLen[ib], b = B.l, lb = B.len;
                  if (Math.abs(ux * (b[3] - b[1]) / lb - uy * (b[2] - b[0]) / lb) > 0.01) continue;   // 平行
                  var mx = (b[0] + b[2] - a[0] - a[2]) / 2, my = (b[1] + b[3] - a[1] - a[3]) / 2;
                  if (Math.abs(Math.abs(mx * uy - my * ux) - th) > 1 || Math.abs(mx * ux + my * uy) > 5) continue;
                  // 前と同じ組・同じ向き(元の線の順で前にある線を a とする)で値を作る
                  var P = A.k < B.k ? A : B, Q = A.k < B.k ? B : A, pl = P.l, ql = Q.l;
                  found.push({ k1: P.k, k2: Q.k, x: (pl[0] + pl[2] + ql[0] + ql[2]) / 4, y: (pl[1] + pl[3] + ql[1] + ql[3]) / 4, len: Math.round(P.len * 10) / 10 });
                }
              }
              found.sort(function (p, q) { return p.k1 - q.k1 || p.k2 - q.k2; });   // 前と同じ順番(元の線の順)
              allPairs = pairCache[pk] = found;
            }
            // 数える板は長さが断面図の寸法と1.5%以内のもの
            var pairs = allPairs.filter(function (q) { return dims.some(function (d) { return Math.abs(q.len - d) <= d * 0.015; }); });
            // 旗に一番近い板の長さの板をすべて数える(旗が指す図の中の同じ板)
            var near = pairs.slice().sort(function (a, b) { return Math.min.apply(null, flags.map(function (f) { return dist(f, a); })) - Math.min.apply(null, flags.map(function (f) { return dist(f, b); })); })[0];
            if (near && Math.min.apply(null, flags.map(function (f) { return dist(f, near); })) < 1500) {
              // 同じ図の板だけ: 旗に一番近い板から、800以内に続いて並ぶ同じ長さの板(B断面の図にも同じリブが描かれているので、そちらは数えない)
              //   つながりは長さに関係なくすべての板でたどり(角の短いリブ F は互いに離れているが、長いリブ E がつなぐ)、その中の同じ長さの板を数える
              var grp = [near], added = true;
              while (added) { added = false; allPairs.forEach(function (q) { if (grp.indexOf(q) < 0 && grp.some(function (g) { return dist(g, q) <= 800; })) { grp.push(q); added = true; } }); }
              var cnt = grp.filter(function (q) { return Math.abs(q.len - near.len) <= 0.5; }).length;
              if (cnt > n) n = cnt * mult;
            }
          }
        }
        out.push({ size: size, name: mk, n: n, note: '' });
      });
      // 柱の図面の形鋼の断面(ア・イ の L-75x75x6。2026-11-20 ユーザー指示「アイ断面があるのでそちらのL-75も拾って欲しい」):
      // 本数 = 図の中のその断面の旗の数 × 断面図の表記の数。長さ = 断面図に長さの寸法が無いので、旗のそば(1000以内)に描かれた線(300〜3000)で一番多い長さ(C断面の八角形の斜めの辺 707.1)
      Object.keys(secInfo).forEach(function (L1) {
        var si = secInfo[L1];
        Array.from(new Set(si.shapes.filter(function (x) { return /^L-/.test(x); }))).forEach(function (shape) {
          var flags = T.filter(function (t) {
            if (t.text !== L1 || titles.some(function (x) { return x.letter === t.text && Math.abs(x.y - t.y) < 10; })) return false;
            if ((sectionOf(t, titles) || {}).letter === L1) return false;
            return !T.some(function (u) { return u !== t && Math.abs(u.y - t.y) < 60 && Math.abs(u.x - t.x) < 250; });
          });
          if (!flags.length) return;
          var cnt = {};
          L.forEach(function (l) {
            var len = Math.hypot(l[2] - l[0], l[3] - l[1]); if (len < 300 || len > 3000) return;
            var mid = { x: (l[0] + l[2]) / 2, y: (l[1] + l[3]) / 2 };
            if (!flags.some(function (f) { return dist(f, mid) <= 1000; })) return;
            var k = (Math.round(len * 10) / 10).toFixed(1); cnt[k] = (cnt[k] || 0) + 1;
          });
          var best = Object.keys(cnt).sort(function (a, b) { return cnt[b] - cnt[a]; })[0];
          if (!best) return;
          var nLab = si.shapes.filter(function (x) { return x === shape; }).length;
          out.push({ size: shape, name: parseFloat(best), n: flags.length * nLab, note: si.title.sub || '' });
        });
      });
      // GEN レイヤの「L-270」(2026-11-20 ユーザー説明、EB1-0C-04): 親綱掛けフックの断面の K-9 が2本、長さ270。
      // 書き方は形鋼と同じ: サイズ = そば(1500以内)の「K-9」、切板名(長さ)= 270、本数 = その図の中の「K-9」の数、備考 = そばの見出し(「…フック」など。1000以内)
      T.filter(function (t) { return t.lay === genNo && /^L-[0-9.]+$/.test(t.text); }).forEach(function (t) {
        var bar = T.filter(function (u) { return /^[A-Z]{1,2}-[0-9.]+$/.test(u.text) && !/^(L|C|H|PL|FB)-/.test(u.text) && dist(u, t) <= 1500; }).sort(function (a, b) { return dist(a, t) - dist(b, t); })[0];
        if (!bar) return;
        var ttl = T.filter(function (u) { return /フック|ピース|金物/.test(u.text) && dist(u, t) <= 1000; }).sort(function (a, b) { return dist(a, t) - dist(b, t); })[0];
        // 本数 = その図(見出しの上 2500・左右 1500 以内)の中の「K-9」の数(柱の立面図の K-9 は数えない)。見出しが無ければ L-270 から1500以内
        var nBar = T.filter(function (u) { return u.text === bar.text && (ttl ? u.y > ttl.y && u.y - ttl.y < 2500 && Math.abs(u.x - ttl.x) < 1500 : dist(u, t) <= 1500); }).length;
        out.push({ size: bar.text, name: parseFloat(t.text.slice(2)), n: nBar, note: ttl ? ttl.text : '' });
      });
      // 仕口の上フランジの上に立つさや管(2026-11-20 ユーザー説明、EB2-0C-05): 立面図に縦書きの「K-11」とそばの長さの寸法「190」。
      // サイズの表記は無いので、サイズ = K-11、切板名(長さ)= そば(400以内)の数字だけの寸法、本数 = 図面の中のその「K-11」の数、備考 = サヤ管。
      // 親綱掛けフックの K-9(上の L-270 の部材と同じ記号)は数えない。レイヤは見ない(図面では「-親綱ピース」になっているが間違い = ユーザー説明)
      var hookBars = out.filter(function (it) { return /フック/.test(it.note); }).map(function (it) { return it.size; });
      var kMarks = T.filter(function (t) { return /^K-[0-9]+$/.test(t.text) && hookBars.indexOf(t.text) < 0; });
      Array.from(new Set(kMarks.map(function (t) { return t.text; }))).forEach(function (mk) {
        var occ = kMarks.filter(function (t) { return t.text === mk; });
        var lens = occ.map(function (t) { var d = T.filter(function (u) { return /^[0-9]+(\.[0-9]+)?$/.test(u.text) && dist(u, t) <= 400; }).sort(function (a, b) { return dist(a, t) - dist(b, t); })[0]; return d ? parseFloat(d.text) : null; });
        if (lens.some(function (x) { return !x; }) || lens.some(function (x) { return x !== lens[0]; })) return;   // 長さが分からない・食い違うときは拾わない
        out.push({ size: mk, name: lens[0], n: occ.length, note: 'サヤ管' });
      });
      // 同じサイズ・切板名(長さ)・備考は1行に(ア・イ の L-75x75x6 707.1 → 4本)
      var merged = [];
      out.forEach(function (it) { var m = merged.find(function (x) { return x.size === it.size && x.name === it.name && x.note === it.note; }); if (m) m.n += it.n; else merged.push(it); });
      return merged;
    }
    if (sayaCounted) { excluded.delete('サヤ管'); result.included.push('サヤ管'); }   // サイズ・長さ・本数が分かったので金物リストに入れた(お知らせで「抽出しました」と出す)
    result.excluded = Array.from(excluded);
    return result;
  }

  // ---------- 並べ替え(Excel・画面共通) ----------
  function kindOf(size) { return /^GPL-/.test(size) ? 'GPL' : (/^PL-/.test(size) ? 'PL' : 'STEEL'); }
  // 空の文字(スリーブ 150S のように切板名が空欄)でも止まらないように(2026-11-21。以前は空欄どうしを比べると match が null で止まった)
  function natKey(v) { return (String(v).match(/\d+|\D+/g) || []).map(function (t) { return /^\d+$/.test(t) ? [0, parseInt(t, 10)] : [1, t]; }); }
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
