// TDF(実寸法師)バイナリから、指定レイヤの寸法線の長さと本数を数える(読み取り専用)。
// 仕組み(2026-10-13 同一図面のレイヤ名違い2ファイルの比較で特定):
//  - 線レコード: サイズ 0x80000038 / val=1 / 座標 double×4 (+24)
//  - 寸法型の線: 直前8バイトが 00 00 11 00 05 00 00 00、直後(+56)の記録の +4 が 00 00 12 00
//  - レイヤ番号 = 寸法型の線の +66 バイト目。レイヤ名表(先頭付近 "03 00 00 00"+名前)の並び順(0始まり)+2
(function (root) {
  var SIZE_LINE = -2147483592;
  var DEFAULT_LAYER = 'TB';

  function readLayerNames(u8) {
    var names = [];
    var end = Math.min(u8.length, 8000);
    var dec = new TextDecoder('shift_jis');
    var i = 1000;
    while (i < end - 5) {
      if (u8[i] === 3 && u8[i + 1] === 0 && u8[i + 2] === 0 && u8[i + 3] === 0 && u8[i + 4] >= 0x20) {
        var j = i + 4;
        while (j < end && u8[j] !== 0 && j - (i + 4) < 31) j++;
        if (u8[j] === 0 && j > i + 4) {
          names.push(dec.decode(u8.subarray(i + 4, j)));
          i = j;
          continue;
        }
      }
      i++;
    }
    return names;
  }

  function parse(buf) {
    var u8 = new Uint8Array(buf);
    var dv = new DataView(buf);
    var names = readLayerNames(u8);
    var lines = [];
    var n = u8.length;
    for (var i = 24; i < n - 80; i++) {
      if (u8[i] !== 0x38 || u8[i + 3] !== 0x80) continue;
      if (dv.getInt32(i, true) !== SIZE_LINE || dv.getInt32(i + 4, true) !== 1) continue;
      var x1 = dv.getFloat64(i + 24, true), y1 = dv.getFloat64(i + 32, true);
      var x2 = dv.getFloat64(i + 40, true), y2 = dv.getFloat64(i + 48, true);
      if (!(Math.abs(x1) < 1e6 && Math.abs(y1) < 1e6 && Math.abs(x2) < 1e6 && Math.abs(y2) < 1e6)) continue;
      // 寸法型か
      if (dv.getUint32(i - 24, true) !== 0x00110000 || dv.getUint32(i - 20, true) !== 5) continue;
      if (dv.getUint32(i + 60, true) !== 0x00120000) continue;
      lines.push({ length: Math.hypot(x2 - x1, y2 - y1), layer: u8[i + 66] });
    }
    return { names: names, lines: lines };
  }

  // 名前 → レイヤ番号(見つからなければ -1)
  function layerNo(names, name) {
    var idx = names.indexOf(name);
    return idx < 0 ? -1 : idx + 2;
  }

  function summarize(parsed, layerName) {
    var no = layerNo(parsed.names, layerName);
    var map = {};
    var total = 0;
    if (no >= 0) {
      parsed.lines.forEach(function (l) {
        if (l.layer !== no) return;
        var k = l.length.toFixed(2);
        map[k] = (map[k] || 0) + 1;
        total++;
      });
    }
    var rows = Object.keys(map).map(Number).sort(function (a, b) { return a - b; })
      .map(function (v) { var k = v.toFixed(2); return { length: k, count: map[k] }; });
    return { layerName: layerName, layerNo: no, found: no >= 0, rows: rows, total: total };
  }

  var api = { parse: parse, summarize: summarize, readLayerNames: readLayerNames, layerNo: layerNo, DEFAULT_LAYER: DEFAULT_LAYER };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else root.TdfDim = api;
})(typeof self !== 'undefined' ? self : this);
