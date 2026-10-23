// TDF(実寸法師)バイナリから、指定レイヤの「数値テキスト」と「同じ長さの線」を数える(読み取り専用)。
// 解析で判明したこと(2026-10-13、レイヤ違い・GEN抽出ファイルとの比較で検証):
//  - 14MB級のTDFはOLE複合ファイルで、中の "Contents" ストリームがTDF本体
//  - レイヤ名表: 先頭付近の "03 00 00 00"+名前 が並ぶ。各項目の先頭にサイズ語(項目全体の長さ)。レイヤ番号 = 表の並び順(0始まり)+1
//  - 要素のレイヤ印: 先頭2バイトが 07 6c / 05 10 / 07 b4 の4バイト語で、3バイト目がレイヤ番号
//      テキスト: テキスト記録のヘッダー(52バイト。座標のdoubleが印に似るため除く)の後、900バイト内で最初に出る印(なければ直前100バイト内の最後の印)
//      線: lineLayer のとおり(線記録の+8〜+11の語の下位2バイトが 0x0003/0x0043 なら+10バイト目、そうでなければ+56〜+200で最初の印。
//          以前の「+88バイト固定」は正解率88%だったため2026-10-14に置き換え)
(function (root) {
  var SIZE_LINE = -2147483592;
  var DEFAULT_LAYER = 'GEN';

  function okHeader(dv, rs) {
    if (rs < 0) return false;
    var x = dv.getFloat64(rs + 4, true), y = dv.getFloat64(rs + 12, true), h = dv.getFloat64(rs + 20, true),
      w = dv.getFloat64(rs + 28, true), r = dv.getFloat64(rs + 36, true);
    return Math.abs(x) < 1e7 && Math.abs(y) < 1e7 && h > 0 && h < 5000 && Math.abs(w) < 5000 && Math.abs(r) < 10;
  }

  // 線のレイヤ: ref0(線記録の+8〜+11の語)の下位2バイトが 0x0003/0x0043(バイト列 03 00 yy ?? / 43 00 yy ??)なら yy(+10バイト目)、
  // そうでなければ線記録の直後(+56〜+200)の最初の印
  function lineLayer(u8, dv, i) {
    var w = dv.getUint32(i + 8, true), lo = w & 0xffff;
    if (lo === 0x0003 || lo === 0x0043) return (w >>> 16) & 0xff;
    for (var k = i + 56; k < i + 200; k++) { if (isTag(u8, k)) return u8[k + 2]; }
    return -1;
  }

  function isTag(u8, i) {
    var a = u8[i], b = u8[i + 1];
    return (a === 0x07 && (b === 0x6c || b === 0xb4)) || (a === 0x05 && b === 0x10);
  }

  // OLE複合ファイルなら Contents ストリームを取り出す。そうでなければそのまま返す
  function extractContents(buf) {
    var u8 = new Uint8Array(buf);
    var sig = [0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1];
    for (var k = 0; k < 8; k++) if (u8[k] !== sig[k]) return buf;
    var dv = new DataView(buf);
    var ss = 1 << dv.getUint16(30, true), mss = 1 << dv.getUint16(32, true);
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
    // ディレクトリから Contents を探す
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

  // レイヤ名表 → [{no, name}]
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
      var name = dec.decode(u8.subarray(p + 32, end));
      var bad = !name || name.indexOf('�') >= 0 || /[\u0000-\u001f]/.test(name);
      layers.push({ no: layers.length + 1, name: bad ? '(名前なし)' : name, raw: bad });
      p += S;
    }
    return layers;
  }

  function parse(buf) {
    buf = extractContents(buf);
    var u8 = new Uint8Array(buf), dv = new DataView(buf), n = u8.length;
    var dec = new TextDecoder('shift_jis');
    var layers = readLayers(u8);
    var texts = [], lines = [], cands = [], bodyById = {};
    for (var i = 52; i < n - 80; i++) {
      // 線
      if (u8[i] === 0x38 && u8[i + 3] === 0x80 && dv.getInt32(i, true) === SIZE_LINE && dv.getInt32(i + 4, true) === 1) {
        var x1 = dv.getFloat64(i + 24, true), y1 = dv.getFloat64(i + 32, true);
        var x2 = dv.getFloat64(i + 40, true), y2 = dv.getFloat64(i + 48, true);
        if (Math.abs(x1) < 1e6 && Math.abs(y1) < 1e6 && Math.abs(x2) < 1e6 && Math.abs(y2) < 1e6) {
          lines.push({ length: Math.hypot(x2 - x1, y2 - y1), angle: Math.atan2(y2 - y1, x2 - x1) * 180 / Math.PI,
            layer: lineLayer(u8, dv, i) });
        }
      }
      // テキスト(マーカー 00 N 2N 00)。文字列を持つ「本体」と、同じid_fieldを指すだけの「参照」がある
      var b1 = u8[i + 1];
      // 先頭1バイトは0とは限らない(0x02/0x20/0x60など。2026-10-14、4547.6が漏れた原因)。0以外はヘッダーの座標・高さが妥当なものだけ採用
      if (u8[i + 3] === 0 && b1 >= 1 && b1 <= 63 && u8[i + 2] === b1 * 2 && (u8[i] === 0 || okHeader(dv, i - 52))) {
        var rs = i - 52, val1 = dv.getInt32(i + 4, true), len = val1 - 8, st = i + 12;
        var tx = null;
        if (len > 0 && len <= 200 && st + len <= n) {
          var e = st; while (e < st + len && u8[e] !== 0) e++;
          if (e > st) tx = dec.decode(u8.subarray(st, e));
        }
        var lay = -1;
        for (var k = rs + 52; k < rs + 900 && k < n - 3; k++) { if (isTag(u8, k)) { lay = u8[k + 2]; break; } }
        // 後方に印がない(ファイル末尾に近い)場合は、直前100バイト内の最後の印を使う(2026-10-14、TBの7020.2で確認)
        if (lay < 0) { for (var q = rs - 4; q >= rs - 100 && q >= 0; q--) { if (isTag(u8, q)) { lay = u8[q + 2]; break; } } }
        var rec = { text: tx, rot: dv.getFloat64(rs + 36, true) * 180 / Math.PI, layer: lay, id: dv.getUint32(rs + 48, true),
          x: dv.getFloat64(rs + 4, true), y: dv.getFloat64(rs + 12, true) };
        if (tx !== null) { texts.push(rec); if (!(rec.id in bodyById)) bodyById[rec.id] = tx; } else cands.push(rec);
      }
    }
    // 参照(文字列なし)は、同じid_fieldを持つ本体の文字列を引き継ぐ
    cands.forEach(function (r) { if (r.id in bodyById) { r.text = bodyById[r.id]; texts.push(r); } });
    return { layers: layers, texts: texts, lines: lines };
  }

  var NUM = /^[0-9]+(\.[0-9]+)?$/;
  // 線の長さの許容: テキストの小数桁に応じて 0.5×10^-桁(+0.005)。整数なら±0.5、小数1桁なら±0.05
  function tolOfText(text) { var d = (text.split('.')[1] || '').length; return 0.5 * Math.pow(10, -d) + 0.005; }

  // TDFにある全レイヤ(選択肢用)。count=そのレイヤの数値テキストの数。同名・名前なしは番号を付けて区別する
  function allLayers(parsed) {
    var cnt = {}, nm = {};
    parsed.texts.forEach(function (t) { if (NUM.test(t.text) && t.layer >= 0) cnt[t.layer] = (cnt[t.layer] || 0) + 1; });
    parsed.layers.forEach(function (l) { nm[l.name] = (nm[l.name] || 0) + 1; });
    return parsed.layers.map(function (l) {
      return { no: l.no, name: (l.raw || nm[l.name] > 1) ? l.name + ' (#' + l.no + ')' : l.name, count: cnt[l.no] || 0 };
    });
  }

  // 選んだレイヤの数値テキスト(参照を含む)を値ごとに数え、各線を最も近い値に割り当てる(許容は tolOfText: 整数なら±0.505mm、小数1桁なら±0.055mm)。
  // テキストの数 = 線の本数 の値だけを「抽出する本数」とする。不一致の値は対象外
  function analyze(parsed, layerNo) {
    var vals = {};
    parsed.texts.forEach(function (t) {
      if (t.layer !== layerNo || !NUM.test(t.text)) return;
      var k = String(parseFloat(t.text));
      if (!vals[k]) vals[k] = { v: parseFloat(t.text), text: t.text, tol: tolOfText(t.text), t: 0, l: 0, lens: [] };
      vals[k].t++;
    });
    var list = Object.keys(vals).map(function (k) { return vals[k]; });
    parsed.lines.forEach(function (ln) {
      if (ln.layer !== layerNo) return;
      var best = null, bd = Infinity;
      list.forEach(function (x) { var d = Math.abs(ln.length - x.v); if (d <= x.tol && d < bd) { bd = d; best = x; } });
      if (best) { best.l++; best.lens.push(ln.length); }
    });
    list.sort(function (a, b) { return a.v - b.v; });
    return list.map(function (x) { return { text: x.text, v: x.v, textCount: x.t, lineCount: x.l, ok: x.t === x.l && x.l > 0, lens: x.lens }; });
  }

  function summarize(parsed, layerNo) {
    var all = analyze(parsed, layerNo);
    var rows = all.filter(function (x) { return x.ok; }).map(function (x) { return { text: x.text, count: x.lineCount }; });
    var ng = all.filter(function (x) { return !x.ok; }).map(function (x) { return { text: x.text, textCount: x.textCount, lineCount: x.lineCount }; });
    var total = rows.reduce(function (a, r) { return a + r.count; }, 0);
    return { rows: rows, ng: ng, total: total, textCount: rows.length };
  }

  // 長さを±N(mm)でまとめる。代表の長さ=本数が最も多い長さ(0.1mm単位。同数なら±N内の本数が多い方、さらに小さい方)。
  // 代表から±N以内の未割当の線を1グループにし、残りで繰り返す。対象は「テキスト数=線の本数」の値の線
  function groupLengths(parsed, layerNo, N) {
    var items = [];
    analyze(parsed, layerNo).forEach(function (x) { if (x.ok) x.lens.forEach(function (len) { items.push({ len: len, texts: [x.text] }); }); });
    var left = items.slice().sort(function (a, b) { return a.len - b.len; });
    var groups = [];
    while (left.length) {
      var cnt = {};
      left.forEach(function (it) { var k = Math.round(it.len * 10); cnt[k] = (cnt[k] || 0) + 1; });
      var best = null;
      Object.keys(cnt).forEach(function (k) {
        var rep = parseInt(k, 10) / 10, c = cnt[k];
        var win = left.filter(function (it) { return Math.abs(it.len - rep) <= N; }).length;
        if (!best || c > best.c || (c === best.c && (win > best.win || (win === best.win && rep < best.rep)))) best = { rep: rep, c: c, win: win };
      });
      var mem = [], rest = [];
      left.forEach(function (it) { (Math.abs(it.len - best.rep) <= N ? mem : rest).push(it); });
      if (!mem.length) { mem = [left[0]]; rest = left.slice(1); best.rep = Math.round(left[0].len * 10) / 10; }
      var tx = {};
      mem.forEach(function (it) { it.texts.forEach(function (t) { tx[t] = 1; }); });
      groups.push({ rep: best.rep, min: mem[0].len, max: mem[mem.length - 1].len, count: mem.length,
        texts: Object.keys(tx).sort(function (a, b) { return parseFloat(a) - parseFloat(b); }) });
      left = rest;
    }
    groups.sort(function (a, b) { return a.rep - b.rep; });
    return { groups: groups, total: items.length };
  }

  // ②ブロック分け製品名: 集計対象(テキスト数=線の本数)の寸法値テキストと、同じレイヤの数値でないテキスト(製品名)を、
  // 互いに最も近いもの同士で1対1に組にする(どちらかに、より近い相手がいれば組にしない)。
  // 製品名は最初の「_」で分け、左=製品名・右=ブロック。「_」の無い製品名と、組にならない寸法は出さない。
  // 並び: ブロックの昇順、同じブロック内はブロック入り製品名の昇順(数字は数として比べる。2026-10-23 ユーザー指定)
  // 2026-10-23、別工事の図面(TB)で、組の距離は200〜206、2番目に近い製品名は1820以上離れていた(224本すべて1対1)
  function blockNames(parsed, layerNo) {
    var ok = {};
    analyze(parsed, layerNo).forEach(function (x) { if (x.ok) ok[String(x.v)] = 1; });
    var dims = [], names = [];
    parsed.texts.forEach(function (t) {
      if (t.layer !== layerNo || !t.text) return;
      if (NUM.test(t.text)) { if (ok[String(parseFloat(t.text))]) dims.push(t); } else names.push(t);
    });
    function nearest(a, list) {
      var best = -1, bd = Infinity;
      list.forEach(function (b, k) { var d = Math.hypot(b.x - a.x, b.y - a.y); if (d < bd) { bd = d; best = k; } });
      return best;
    }
    var nameToDim = names.map(function (m) { return nearest(m, dims); });
    var byName = {};
    dims.forEach(function (d, di) {
      var ni = nearest(d, names);
      if (ni < 0 || nameToDim[ni] !== di) return;
      var nm = names[ni].text, u = nm.indexOf('_');
      if (u < 0) return;
      if (!byName[nm]) byName[nm] = { name: nm, product: nm.slice(0, u), block: nm.slice(u + 1), count: 0, lens: {} };
      byName[nm].count++; byName[nm].lens[d.text] = 1;
    });
    var rows = Object.keys(byName).map(function (k) {
      var r = byName[k];
      r.lengths = Object.keys(r.lens).sort(function (a, b) { return parseFloat(a) - parseFloat(b); });
      delete r.lens; return r;
    });
    rows.sort(function (a, b) {
      return a.block.localeCompare(b.block, 'ja', { numeric: true }) || a.name.localeCompare(b.name, 'ja', { numeric: true });
    });
    return { rows: rows, total: rows.reduce(function (a, r) { return a + r.count; }, 0) };
  }

  var api = { blockNames: blockNames, groupLengths: groupLengths, allLayers: allLayers, analyze: analyze, parse: parse, summarize: summarize, extractContents: extractContents, readLayers: readLayers, DEFAULT_LAYER: DEFAULT_LAYER };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else root.TdfDim = api;
})(typeof self !== 'undefined' ? self : this);
