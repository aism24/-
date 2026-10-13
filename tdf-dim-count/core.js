// TDF(実寸法師)バイナリから、指定レイヤの「斜めの数値テキスト」と「同じ長さの斜めの線」を数える(読み取り専用)。
// 解析で判明したこと(2026-10-13、レイヤ違い・GEN抽出ファイルとの比較で検証):
//  - 14MB級のTDFはOLE複合ファイルで、中の "Contents" ストリームがTDF本体
//  - レイヤ名表: 先頭付近の "03 00 00 00"+名前 が並ぶ。各項目の先頭にサイズ語(項目全体の長さ)。レイヤ番号 = 表の並び順(0始まり)+1
//  - 要素のレイヤ印: 先頭2バイトが 07 6c / 05 10 / 07 b4 の4バイト語で、3バイト目がレイヤ番号
//      テキスト: テキスト記録の先頭から900バイト内で最初に出る印 / 線: 線記録の+88バイトにある印
(function (root) {
  var SIZE_LINE = -2147483592;
  var DEFAULT_LAYER = 'GEN';

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
    var texts = [], lines = [];
    for (var i = 52; i < n - 80; i++) {
      // 線
      if (u8[i] === 0x38 && u8[i + 3] === 0x80 && dv.getInt32(i, true) === SIZE_LINE && dv.getInt32(i + 4, true) === 1) {
        var x1 = dv.getFloat64(i + 24, true), y1 = dv.getFloat64(i + 32, true);
        var x2 = dv.getFloat64(i + 40, true), y2 = dv.getFloat64(i + 48, true);
        if (Math.abs(x1) < 1e6 && Math.abs(y1) < 1e6 && Math.abs(x2) < 1e6 && Math.abs(y2) < 1e6) {
          lines.push({ length: Math.hypot(x2 - x1, y2 - y1), angle: Math.atan2(y2 - y1, x2 - x1) * 180 / Math.PI,
            layer: isTag(u8, i + 88) ? u8[i + 90] : -1 });
        }
      }
      // テキスト(マーカー 00 N 2N 00)
      var b1 = u8[i + 1];
      if (u8[i] === 0 && u8[i + 3] === 0 && b1 >= 1 && b1 <= 63 && u8[i + 2] === b1 * 2) {
        var rs = i - 52, val1 = dv.getInt32(i + 4, true), len = val1 - 8, st = i + 12;
        if (len > 0 && len <= 200 && st + len <= n) {
          var e = st; while (e < st + len && u8[e] !== 0) e++;
          if (e > st) {
            var tx = dec.decode(u8.subarray(st, e));
            var lay = -1;
            for (var k = rs; k < rs + 900 && k < n - 3; k++) { if (isTag(u8, k)) { lay = u8[k + 2]; break; } }
            texts.push({ text: tx, rot: dv.getFloat64(rs + 36, true) * 180 / Math.PI, layer: lay });
          }
        }
      }
    }
    return { layers: layers, texts: texts, lines: lines };
  }

  var NUM = /^[0-9]+(\.[0-9]+)?$/;
  function slanted(deg) { var m = ((deg % 90) + 90) % 90; return Math.min(m, 90 - m) > 1; }

  // 斜めの数値テキストを持つレイヤ一覧(選択肢用)
  function layerChoices(parsed) {
    var cnt = {};
    parsed.texts.forEach(function (t) { if (NUM.test(t.text) && slanted(t.rot) && t.layer >= 0) cnt[t.layer] = (cnt[t.layer] || 0) + 1; });
    return parsed.layers.filter(function (l) { return cnt[l.no]; })
      .map(function (l) { return { no: l.no, name: l.name, count: cnt[l.no] }; });
  }

  function summarize(parsed, layerNo) {
    var lines = parsed.lines.filter(function (l) { return l.layer === layerNo && slanted(l.angle); });
    var rows = [], seen = {};
    parsed.texts.forEach(function (t) {
      if (t.layer !== layerNo || !NUM.test(t.text) || !slanted(t.rot)) return;
      var v = parseFloat(t.text), tol = Math.max(0.5, v * 0.002), c = 0;
      lines.forEach(function (l, idx) {
        if (Math.abs(l.length - v) <= tol) { c++; seen[idx] = 1; }
      });
      rows.push({ text: t.text, angle: t.rot, count: c });
    });
    rows.sort(function (a, b) { return parseFloat(a.text) - parseFloat(b.text); });
    return { rows: rows, total: Object.keys(seen).length, textCount: rows.length }; // total=重複なしの線の本数
  }

  var api = { parse: parse, summarize: summarize, layerChoices: layerChoices, extractContents: extractContents, readLayers: readLayers, DEFAULT_LAYER: DEFAULT_LAYER };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else root.TdfDim = api;
})(typeof self !== 'undefined' ? self : this);
