/* 文字データの無い詳細図PDF(文字が線で描かれたCAD図面)へのリンク付与。
 * 画像にして Gemini(GAS経由)で「右下の図面番号」と「製品表のセル」を読み、
 * 読んだ図番のマスタ上の製品名と、製品表のいずれかのセルが一致したら、そのセルにリンクを付ける。
 * 梁詳細図(製品名|設計符号|部材サイズ|台数)・柱詳細図(設計符号|設計符号|製品名|図示|台数)のどちらも、セルの位置は決め打ちしない。
 * 読み取りの誤りでリンクを付けないよう、マスタとの一致だけを根拠にする(CADの文字ではOと0・Iと1の見分けがつかないので、比較時だけ同一視)。
 * 製品表が見つからないページ(手書き・スキャンの一覧表など)は、書かれた英数字の語を行ごとに読み(kind=list)、同じ行の(図番, 製品名)がマスタと一致したら製品名に下線とリンクを付ける(2026-11-02〜)。
 * list の読み取りに失敗したとき・マスタの語が1つも無いときは、従来どおり「製品表が見つかりません」にする。
 * 一覧表を読む前に、文字が正しく読める向きを小さな画像で聞き(kind=orient)、横倒し・逆さなら回してから読む(2026-11-02〜)。聞けないとき(旧GAS等)・回転不要のときは従来どおり。
 * 向きは、ページを 0/90/180/270 度に回した4枚を1枚に並べて「正しい向きはどれか」を聞く(kind=orient4、2026-11-02〜。回転量を答えさせるより安定する)。旧GAS(orient4 を知らない)・答えが不正なときは orient で聞く。 */
(function (root) {
  var LOCATE_SIDE = 2000;   // 場所を探すための全体画像の長辺(px)
  var READ_DPI = 300;       // 読み取り用の切り出し画像の解像度
  var CORNER_SIDE = 2000;   // 右下(図面番号欄のあたり)だけを拡大して図面番号の位置を探すときの、その画像の横幅(px)
  var MAX_CALLS_PER_MIN = 12;   // Geminiの無料枠は1分あたりの呼び出し回数に上限がある(429)ので、それを超えないよう間隔をあける
  var TABLE_TRIES = 2;          // 製品表の読み取りで製品名が一致しなかったとき、同じ画像を読む回数の上限(最初の1回を含む)
  var RETRY_429 = 3;            // 429が返ったときの再試行の回数(そのつど少し待つ)
  var HALF_SIDE = 2400;     // 製品表を見落としたとき、上下に分けて探し直す画像の横幅(px)
  var ORIENT_SIDE = 1000;   // 一覧表の向きを聞くための画像の長辺(px)。文字の向きが分かれば足りるので小さくする
  var ORIENT4_CELL = 800, ORIENT4_LABEL = 70, ORIENT4_GAP = 20;   // 4つの向きを並べた画像: 1枚の枠(正方形、px)・番号を書く帯の高さ・すき間
  // 細かい一覧表(1枚で読むと文字が小さい)は、重なりのある数枚に分けて高い解像度で読み直す(2026-11-02〜)
  var DENSE_MIN_ITEMS = 15, DENSE_BOX_PX = 30, TILE_BOX_PX = 36;   // 語が15個以上で、語の高さ(中央値)が30px未満なら細かいとみなし、語の高さが約36pxになる解像度で読む
  var TILE_W = 2000, TILE_H = 1600, TILE_OVX = 0.09, TILE_OVY = 0.04, TILE_PAR = 3;   // 1枚の大きさの目安・重なり(ページ幅・高さに対する割合、片側)・同時に読む枚数

  function fold(s) { return String(s).normalize('NFKC').replace(/\s+/g, '').toUpperCase().replace(/O/g, '0').replace(/[IL]/g, '1'); }

  // ページの一部を描いた canvas を返す。(x0,y0,w,h)はそのscaleでのページ画像上の範囲(px)。rotation(省略可)を渡すと、その向きで描く(省略時はページの向きのまま)
  async function renderRegion(page, scale, x0, y0, w, h, rotation) {
    var vp = rotation === undefined ? page.getViewport({ scale: scale }) : page.getViewport({ scale: scale, rotation: rotation }), c = document.createElement('canvas');
    c.width = Math.max(1, Math.round(w)); c.height = Math.max(1, Math.round(h));
    var ctx = c.getContext('2d');
    ctx.fillStyle = '#fff'; ctx.fillRect(0, 0, c.width, c.height);
    await page.render({ canvasContext: ctx, viewport: vp, transform: [1, 0, 0, 1, -x0, -y0] }).promise;
    return { canvas: c, vp: vp };
  }
  // canvas の画素を手放す(複数ページを並行して読むとき、メモリを使い続けないように)
  function release(c) { if (c && c.canvas) { c.canvas.width = 0; c.canvas.height = 0; } }
  // 向きの確認用: ページを時計回りに 0/90/180/270 度回した4枚を、番号 1〜4 を付けて 2×2 に並べた画像。W,H はページの向きのままの大きさ(scale 1)
  async function orientSheet(page, W, H) {
    var C = ORIENT4_CELL, L = ORIENT4_LABEL, g = ORIENT4_GAP, c = document.createElement('canvas');
    c.width = 2 * C + 3 * g; c.height = 2 * (C + L) + 3 * g;
    var ctx = c.getContext('2d');
    ctx.fillStyle = '#fff'; ctx.fillRect(0, 0, c.width, c.height);
    for (var k = 0; k < 4; k++) {
      var r = k * 90, w = r % 180 ? H : W, h = r % 180 ? W : H, s = C / Math.max(w, h);
      var im = await renderRegion(page, s, 0, 0, w * s, h * s, ((page.rotate || 0) + r) % 360);
      var x = g + (k % 2) * (C + g), y = g + Math.floor(k / 2) * (C + L + g);
      ctx.fillStyle = '#d00'; ctx.font = 'bold ' + Math.round(L * 0.8) + 'px sans-serif'; ctx.textBaseline = 'middle';
      ctx.fillText(String(k + 1), x, y + L / 2);
      var ix = x + (C - im.canvas.width) / 2, iy = y + L + (C - im.canvas.height) / 2;
      ctx.drawImage(im.canvas, ix, iy);
      ctx.strokeStyle = '#888'; ctx.lineWidth = 2; ctx.strokeRect(ix, iy, im.canvas.width, im.canvas.height);
      release(im);
    }
    return { canvas: c };
  }
  // 切り出し画像上の範囲({x0,y0,x1,y1}。切り出し画像の左上が (ox,oy))→ PDFのページ座標の矩形 [x0,y0,x1,y1]
  function pdfRect(vp, ox, oy, r) {
    var a = vp.convertToPdfPoint(ox + r.x0, oy + r.y0), b = vp.convertToPdfPoint(ox + r.x1, oy + r.y1);
    return [Math.min(a[0], b[0]), Math.min(a[1], b[1]), Math.max(a[0], b[0]), Math.max(a[1], b[1])];
  }
  function sleep(ms) { return new Promise(function (r) { setTimeout(r, ms); }); }
  // 図面番号欄のあたりの画像(box は 0〜1000 のページ全体の位置)。着色の範囲を求める・読み直し(遅い道)に使う
  function renderAround(page, sH, PW, PH, box) {
    var nb = boxPx(box, PW, PH);
    if (!nb) return Promise.resolve(null);
    var padx = (nb.x1 - nb.x0) * 0.6 + 40, pady = (nb.y1 - nb.y0) * 3 + 60;   // 欄の罫線(上は「図面番号」の文字の上)まで入る広さ
    var rx0 = clamp(nb.x0 - padx, 0, PW), ry0 = clamp(nb.y0 - pady, 0, PH), rx1 = clamp(nb.x1 + padx, 0, PW), ry1 = clamp(nb.y1 + pady, 0, PH);
    return renderRegion(page, sH, rx0, ry0, rx1 - rx0, ry1 - ry0).then(function (r) { return { r: r, nb: nb, rx0: rx0, ry0: ry0 }; });
  }
  function jpeg(canvas) { return canvas.toDataURL('image/jpeg', 0.9).replace(/^data:image\/jpeg;base64,/, ''); }
  function clamp(v, a, b) { return Math.max(a, Math.min(b, v)); }
  // [ymin,xmin,ymax,xmax](0〜1000)→ 範囲 {x0,y0,x1,y1}(px)。不正なら null
  function boxPx(box, w, h) {
    if (!box || box.length !== 4 || box.some(function (n) { return typeof n !== 'number' || isNaN(n); })) return null;
    var r = { x0: box[1] / 1000 * w, y0: box[0] / 1000 * h, x1: box[3] / 1000 * w, y1: box[2] / 1000 * h };
    if (r.x1 <= r.x0 || r.y1 <= r.y0) return null;
    return r;
  }
  // 製品表の罫線からセルの範囲を求める(Geminiが返す文字の枠は上下・左右にずれることがあるため、枠の大きさや横位置には頼らない)
  // tbl: 製品表の範囲(canvas上のpx)/ cb: 読み取ったセルの文字の範囲(使うのは中心の位置だけ)
  // opt.idx(省略可): 読み取った表の中で左から何番目のセルか
  // 1. 文字の中心から上下にいちばん近い、ほぼ全幅に渡る横線 → セルの上端・下端
  // 2. 上端〜下端のほぼ全高に渡る縦線 → 列の区切り。opt.idx があれば、上の罫線をたどって見つけた表の端から数えて idx 番目と次の区切りを左右の端にする
  //    (無ければ、文字の中心を挟む2本)
  function cellFromLines(canvas, tbl, cb, opt) {
    var w = canvas.width, h = canvas.height, d = canvas.getContext('2d').getImageData(0, 0, w, h).data;
    function dark(x, y) { x = clamp(Math.round(x), 0, w - 1); y = clamp(Math.round(y), 0, h - 1); var i = (y * w + x) * 4; return (d[i] + d[i + 1] + d[i + 2]) / 3 < 170; }
    var xc = (cb.x0 + cb.x1) / 2, yc = (cb.y0 + cb.y1) / 2, tw = tbl.x1 - tbl.x0, T = null, B = null;
    function hFrac(y, xa, xb) { var n = 0, t = 0, x; for (x = xa; x <= xb; x += 2) { t++; if (dark(x, y - 1) || dark(x, y) || dark(x, y + 1)) n++; } return t ? n / t : 0; }
    function vFrac(x, ya, yb) { var n = 0, t = 0, y; for (y = ya; y <= yb; y += 2) { t++; if (dark(x - 1, y) || dark(x, y) || dark(x + 1, y)) n++; } return n / t; }
    // 上端・下端: 先に、そのセルの文字のあたり(横幅は文字の範囲)で探す。表の枠の外に文字(重量など)がはみ出す表でも見つかるように。だめなら表の中央80%で探す
    var ranges = [[cb.x0, cb.x1], [tbl.x0 + tw * 0.1, tbl.x1 - tw * 0.1]], ri, y;
    for (ri = 0; ri < ranges.length && (T === null || B === null); ri++) {
      T = null; B = null;
      for (y = yc; y >= Math.max(0, yc - h * 0.5); y--) if (hFrac(y, ranges[ri][0], ranges[ri][1]) >= 0.85) { T = y; break; }
      for (y = yc; y <= Math.min(h - 1, yc + h * 0.5); y++) if (hFrac(y, ranges[ri][0], ranges[ri][1]) >= 0.85) { B = y; break; }
    }
    if (T !== null && B !== null && B - T >= 8) {
      var lines = [], x, last = -99;
      for (x = 0; x < w; x++) if (vFrac(x, T + 3, B - 3) >= 0.85) { if (x - last > 3) lines.push([x, x]); else lines[lines.length - 1][1] = x; last = x; }
      var L = null, R = null;
      if (opt && opt.idx >= 0) {
        // 上の罫線をたどって表の左右の端を見つけ、その中の縦線で区切られた「左から idx 番目」のセルにする
        // (Geminiの横位置は1セル近くずれることがあるので、横位置ではなく順番で決める)
        var dk = function (xx) { return dark(xx, T - 1) || dark(xx, T) || dark(xx, T + 1); }, Lx = clamp(xc, 0, w - 1), Rx = Lx, gp = 0, xx;
        for (xx = Lx, gp = 0; xx >= 0; xx--) { if (dk(xx)) { gp = 0; Lx = xx; } else if (++gp > 4) break; }
        for (xx = Rx, gp = 0; xx < w; xx++) { if (dk(xx)) { gp = 0; Rx = xx; } else if (++gp > 4) break; }
        var inner = lines.filter(function (l) { var c = (l[0] + l[1]) / 2; return c >= Lx - 4 && c <= Rx + 4; });
        if (inner.length > opt.idx + 1) {
          var l0 = (inner[opt.idx][0] + inner[opt.idx][1]) / 2, l1 = (inner[opt.idx + 1][0] + inner[opt.idx + 1][1]) / 2;
          if (l1 - l0 >= 8) return { x0: l0, y0: T, x1: l1, y1: B, snapped: true };
        }
      }
      lines.forEach(function (l) { var c = (l[0] + l[1]) / 2; if (c <= xc) L = c; else if (R === null) R = c; });
      if (L !== null && R !== null && R - L >= 8) return { x0: L, y0: T, x1: R, y1: B, snapped: true };
    }
    var m = (cb.y1 - cb.y0) * 0.5;
    return { x0: cb.x0 - m, y0: cb.y0 - m, x1: cb.x1 + m, y1: cb.y1 + m, snapped: false };
  }

  // 一覧表のリンク位置の補正(2026-11-02〜)。細かい表では Gemini が返す文字の縦の位置が1〜数行ずれることがある(下の行ほど大きくずれる)ので、
  // 画像から同じ列の実際の文字の行(インクのある帯)を探し、読んだ語を上から順に対応させる(行の間隔の比で縮尺を合わせ、上下のずれ量は全体で一番合うものを選ぶ)。
  // 罫線のある表だけが対象(手書き・写真は変えない)。boxes: [{x0,y0,x1,y1}](canvas上のpx)。書き換えたら true
  var snapSeq = 0;   // あいまいな段に付ける番号(同じ段の語をまとめて動かすため)
  function snapRows(canvas, boxes) {
    var w = canvas.width, h = canvas.height, d = canvas.getContext('2d').getImageData(0, 0, w, h).data, changed = false;
    function med(a) { a = a.slice().sort(function (p, q) { return p - q; }); return a.length ? a[a.length >> 1] : 0; }
    // 列ごと(横の範囲が半分以上重なるもの)に分ける
    var groups = [];
    boxes.slice().sort(function (p, q) { return p.x0 - q.x0; }).forEach(function (b) {
      var g = groups.filter(function (g) { var ov = Math.min(g.x1, b.x1) - Math.max(g.x0, b.x0); return ov >= 0.5 * Math.min(g.x1 - g.x0, b.x1 - b.x0); })[0];
      if (g) { g.items.push(b); g.x0 = Math.min(g.x0, b.x0); g.x1 = Math.max(g.x1, b.x1); } else groups.push({ x0: b.x0, x1: b.x1, items: [b] });
    });
    groups.forEach(function (g) {
      var it = g.items, n = it.length;
      var xa = clamp(Math.round(med(it.map(function (b) { return b.x0; }))), 0, w - 1), xb = clamp(Math.round(med(it.map(function (b) { return b.x1; }))), xa + 1, w);
      // その列の行ごとのインクの割合(罫線のようにほぼ全幅が黒い行は除く)→ インクのある帯
      var bands = [], cur = -1, last = -9, y, x;
      // 縦の罫線(上から下までほぼ黒い列)は除く(残すと、文字の無い空き行まで「文字の行」になってしまう)
      var colOk = [], nOk = 0;
      for (x = xa; x < xb; x++) {
        var dc = 0;
        for (y = 0; y < h; y += 2) { var i0 = (y * w + x) * 4; if ((d[i0] + d[i0 + 1] + d[i0 + 2]) / 3 < 150) dc++; }
        colOk[x - xa] = dc / Math.ceil(h / 2) < 0.5;
        if (colOk[x - xa]) nOk++;
      }
      if (!nOk) return;
      for (y = 0; y < h; y++) {
        var dk = 0;
        for (x = xa; x < xb; x++) { if (!colOk[x - xa]) continue; var i = (y * w + x) * 4; if ((d[i] + d[i + 1] + d[i + 2]) / 3 < 150) dk++; }
        var f = dk / nOk, on = f > 0.02 && f <= 0.6;
        if (on) { if (cur < 0) cur = y; last = y; }
        else if (cur >= 0 && y - last > 2) { if (last - cur + 1 >= 3) bands.push([cur, last + 1]); cur = -1; }
      }
      if (cur >= 0 && last - cur + 1 >= 3) bands.push([cur, last + 1]);
      // 罫線の表だけを補正する(写真・手書きの紙は行の帯がはっきりしないので、Gemini の位置のまま)
      var rules = 0, inR = false;
      for (y = 0; y < h; y++) {
        var dk2 = 0;
        for (x = xa; x < xb; x += 2) { var i3 = (y * w + x) * 4; if ((d[i3] + d[i3 + 1] + d[i3 + 2]) / 3 < 150) dk2++; }
        var full = dk2 / Math.ceil((xb - xa) / 2) > 0.6;
        if (full && !inR) rules++;
        inR = full;
      }
      if (rules < 3) return;
      var m = bands.length;
      if (m < n) return;
      var bc = bands.map(function (b) { return (b[0] + b[1]) / 2; });
      // 各行の文字の横幅(インクの左端〜右端)。読んだ語の幅と比べ、見出し(「製品名」など短い文字)や別の行に対応させにくくする
      var bw = bands.map(function (b) {
        var mn = Infinity, mx = -Infinity, yy, xx;
        // 文字は、その行の背景(いちばん多い色)と大きく違う濃い画素だけ(2026-11-04〜)。セルの塗り(青・水色など)を文字として数えると、その行の幅が列の幅いっぱいになり、別の行に対応してしまう。赤字・青字は数える
        var hist = {}, bgk = null, bgn = 0, bg = [255, 255, 255];
        for (yy = b[0]; yy < b[1]; yy++) for (xx = xa; xx < xb; xx += 2) { if (!colOk[xx - xa]) continue; var i5 = (yy * w + xx) * 4, key = (d[i5] >> 5) + ',' + (d[i5 + 1] >> 5) + ',' + (d[i5 + 2] >> 5); hist[key] = (hist[key] || 0) + 1; if (hist[key] > bgn) { bgn = hist[key]; bgk = key; } }
        if (bgk) bg = bgk.split(',').map(function (v) { return (+v << 5) + 16; });
        // 線のように横いっぱい(半分超)に濃い画素が並ぶ高さ(帯の端にかかった罫線)も除く
        var lineY = {};
        for (yy = b[0]; yy < b[1]; yy++) { var nl = 0; for (xx = xa; xx < xb; xx++) { if (!colOk[xx - xa]) continue; var i6 = (yy * w + xx) * 4; if ((d[i6] + d[i6 + 1] + d[i6 + 2]) / 3 < 150) nl++; } if (nl > 0.5 * nOk) lineY[yy] = 1; }
        // 黒・灰色の文字の幅を使う(色の付いた塗りのセルを数えない)。黒・灰色の文字が無い行(赤字だけ等)は、背景と大きく違う濃い画素で測る
        var gmn = Infinity, gmx = -Infinity;
        for (yy = b[0]; yy < b[1]; yy++) for (xx = xa; xx < xb; xx++) {
          if (!colOk[xx - xa] || lineY[yy]) continue;
          var i4 = (yy * w + xx) * 4, r4 = d[i4], g4 = d[i4 + 1], b4 = d[i4 + 2];
          if ((r4 + g4 + b4) / 3 >= 150) continue;
          if (Math.max(r4, g4, b4) - Math.min(r4, g4, b4) < 80) { if (xx < gmn) gmn = xx; if (xx > gmx) gmx = xx; }
          if (Math.abs(r4 - bg[0]) + Math.abs(g4 - bg[1]) + Math.abs(b4 - bg[2]) > 150) { if (xx < mn) mn = xx; if (xx > mx) mx = xx; }
        }
        if (gmx >= gmn) { mn = gmn; mx = gmx; }
        return mx >= mn ? mx - mn : 0;
      });
      var ord = it.slice().sort(function (p, q) { return (p.y0 + p.y1) - (q.y0 + q.y1); }), c = ord.map(function (b) { return (b.y0 + b.y1) / 2; });
      var dif = function (a) { var r = []; for (var k = 1; k < a.length; k++) r.push(a[k] - a[k - 1]); return r; };
      var spb = m > 1 ? med(dif(bc)) : 20, spp = n > 2 ? med(dif(c)) : spb, sc = spp > 0 ? spb / spp : 1;
      var cs = null, O = n <= 2 ? Math.round(0.6 * spb) : Math.round(h * 0.3), bestO = 0, bestS = sc, bestC = Infinity, j, i2, o, CAP = 3 * spb;   // 外れの上限は3行分(遠い行ほど外れを大きく数える)
      // 幅の食い違いの重み。Gemini の語の幅は実際の文字の幅と一定の比になるので、その比(中央値どうし)でそろえてから比べる。文字数が1つ違えば約1割の差になる
      var iws = ord.map(function (b) { return Math.max(1, b.x1 - b.x0); }), kx = med(bw.filter(function (v) { return v > 0; })) / Math.max(1, med(iws));
      var wc = iws.map(function (iw) { var ew = kx * iw; return bw.map(function (v) { return 2 * spb * Math.min(1, Math.abs(v - ew) / ew); }); });
      var prev = new Float64Array(m + 1), curA = new Float64Array(m + 1);
      for (var sk = n <= 2 ? 0 : -6; sk <= (n <= 2 ? 0 : 6); sk++) {   // 縦の縮尺は、行の間隔の比を中心に ±6% の範囲でも探す。語が2つ以下の列は、ずれを0.6行分まで・縮尺は変えない(語が少ないと、どこへでも合ってしまうため。2026-11-04〜)
        var scs = sc * (1 + sk / 100), cv2 = c.map(function (v) { return v * scs; });
        for (o = -O; o <= O; o++) {   // 上下のずれ量ごとに、上から順の対応(行は飛ばしてよい)の合計の外れを最小にする
          prev.fill(0);
          for (i2 = 0; i2 < n; i2++) {
            curA[0] = Infinity;
            for (j = 1; j <= m; j++) { var cst = Math.min(Math.abs(cv2[i2] + o - bc[j - 1]), CAP) + wc[i2][j - 1]; curA[j] = Math.min(curA[j - 1], prev[j - 1] + cst); }
            var t = prev; prev = curA; curA = t;
          }
          if (prev[m] < bestC) { bestC = prev[m]; bestO = o; bestS = scs; }
        }
      }
      cs = c.map(function (v) { return v * bestS; });
      // 対応を取り出す
      var dp = [], a2, b2;
      for (a2 = 0; a2 <= n; a2++) { dp.push(new Float64Array(m + 1)); if (a2) dp[a2][0] = Infinity; }
      for (a2 = 1; a2 <= n; a2++) for (b2 = 1; b2 <= m; b2++) dp[a2][b2] = Math.min(dp[a2][b2 - 1], dp[a2 - 1][b2 - 1] + Math.min(Math.abs(cs[a2 - 1] + bestO - bc[b2 - 1]), CAP) + wc[a2 - 1][b2 - 1]);
      // 段ごとの対応(表が空き行・見出しで段に分かれ、Gemini が段と段のすき間を実際と違う大きさで返すとき用)。
      // Gemini の行の間が大きく空いた所(行の間隔の中央値の1.8倍超)で段に分け、段の中では「行の間隔」と「文字の横幅」が合うように、
      // 段どうしは上から順(位置は自由)に、実際の行(インクの帯)へ対応させる。段の中の間隔の外れの平均が行間隔の0.25倍以下のときだけ使う
      function segAlign() {
        var g0 = dif(c), sp = med(g0), brk = g0.map(function (g) { return g > 1.8 * sp; });
        if (!brk.some(function (b) { return b; }) || sp <= 0) return null;
        var s0 = spb / sp, F = [], P = [], a, b, q;
        for (a = 0; a < n; a++) { F.push(new Float64Array(m).fill(Infinity)); P.push(new Int32Array(m).fill(-1)); }
        // 位置そのものの外れはごく弱く数える(同じ形の並びが2か所に合うときに、近い方を選ぶため)
        var near = function (a, b) { return 0.02 * Math.min(Math.abs(c[a] * bestS + bestO - bc[b]), 10 * spb); };
        for (b = 0; b < m; b++) F[0][b] = wc[0][b] + near(0, b);
        for (a = 1; a < n; a++) for (b = 1; b < m; b++) {
          var best = Infinity, arg = -1;
          for (q = 0; q < b; q++) {
            if (F[a - 1][q] === Infinity) continue;
            var t = brk[a - 1] ? 0 : Math.min(Math.abs(g0[a - 1] * s0 - (bc[b] - bc[q])), CAP);
            if (F[a - 1][q] + t < best) { best = F[a - 1][q] + t; arg = q; }
          }
          if (arg >= 0) { F[a][b] = best + wc[a][b] + near(a, b); P[a][b] = arg; }
        }
        var bb = -1, bv = Infinity;
        for (b = 0; b < m; b++) if (F[n - 1][b] < bv) { bv = F[n - 1][b]; bb = b; }
        if (bb < 0) return null;
        var res = new Array(n); for (a = n - 1; a >= 0; a--) { res[a] = bb; bb = P[a][bb]; }
        var e = 0, k = 0;
        for (a = 1; a < n; a++) if (!brk[a - 1]) { e += Math.min(Math.abs(g0[a - 1] * s0 - (bc[res[a]] - bc[res[a - 1]])), spb); k++; }
        if (!k || e / k > 0.25 * spb) return null;
        return res;
      }
      var asg = new Array(n); a2 = n; b2 = m;
      while (a2 > 0) { if (dp[a2][b2] === dp[a2][b2 - 1]) b2--; else { asg[a2 - 1] = b2 - 1; a2--; b2--; } }
      var pc2 = 0; for (a2 = 0; a2 < n; a2++) pc2 += Math.min(Math.abs(cs[a2] + bestO - bc[asg[a2]]), spb);
      // Gemini の行の間が大きく空いた所がある(表が段に分かれている)ときは、段ごとに合わせた対応を使う(2026-11-04〜)。
      // 全体を1つの縮尺・ずれで合わせると、行の少ない段が隣の行(合計の行など)へずれることがあるため。段ごとに合わせられないときは従来どおり
      var sa = segAlign();
      if (sa) asg = sa;
      else if (pc2 / n > 0.35 * spb) return;   // 位置の対応がはっきりしないときは変えない
      // 位置があいまいな語の印(2026-11-04〜): Gemini の行の間が大きく空いた所で分けたまとまりごとに、まとめて1行上か下にずらしても
      // 「行の間隔」と「文字の横幅」の合い方がほとんど変わらない(差が行間隔の0.5倍未満)、またはまとまりの中に対応しない行がはさまるときは、
      // 語が1行ずれて対応しているおそれがある。重なった部分を別の1枚でも読んでいれば、そちらで決める(listPage)
      var gid = ++snapSeq, gg = dif(c), gsp = med(gg), cl = [0], amb = {};
      for (j = 1; j < n; j++) cl.push(cl[j - 1] + (gg[j - 1] > 1.8 * gsp ? 1 : 0));
      var s1 = gsp > 0 ? spb / gsp : 1, ncl = cl[n - 1] + 1;
      var costOf = function (ids, bs) {
        var t = 0, k2;
        for (k2 = 0; k2 < ids.length; k2++) { t += wc[ids[k2]][bs[k2]]; if (k2) t += Math.min(Math.abs(gg[ids[k2] - 1] * s1 - (bc[bs[k2]] - bc[bs[k2 - 1]])), spb); }
        return t;
      };
      for (var ci = 0; ci < ncl; ci++) {
        var ids = [], bs0 = [];
        for (a2 = 0; a2 < n; a2++) if (cl[a2] === ci) { ids.push(a2); bs0.push(asg[a2]); }
        var lo = bs0[0], hi = bs0[bs0.length - 1];
        var prevHi = -1, nextLo = m;
        for (a2 = 0; a2 < n; a2++) { if (cl[a2] < ci) prevHi = Math.max(prevHi, asg[a2]); if (cl[a2] > ci) nextLo = Math.min(nextLo, asg[a2]); }
        if (hi - lo + 1 > ids.length) { amb[ci] = true; continue; }
        var base = costOf(ids, bs0);
        [-1, 1].forEach(function (dl) {
          if (lo + dl <= prevHi || hi + dl >= nextLo || lo + dl < 0 || hi + dl >= m) return;
          if (costOf(ids, bs0.map(function (v) { return v + dl; })) - base < 0.5 * spb) amb[ci] = true;
        });
      }
      for (a2 = 0; a2 < n; a2++) {
        ord[a2].y0 = bands[asg[a2]][0]; ord[a2].y1 = bands[asg[a2]][1]; ord[a2].snapped = true;
        if (amb[cl[a2]]) { ord[a2].amb = true; ord[a2].ambG = gid + ':' + cl[a2]; }
        // 横幅が列の範囲(この列の語の左端・右端の中央値)から大きくはみ出す語は、列の範囲に収める(隣の欄まで下線が伸びないように)
        if (ord[a2].x1 - ord[a2].x0 > 1.4 * (xb - xa)) { ord[a2].x0 = Math.max(ord[a2].x0, xa); ord[a2].x1 = Math.min(ord[a2].x1, xb); }
      }
      changed = true;
    });
    return changed;
  }

  // links: { "図番\t製品名": url | [url,...] } / ask(kind, base64Jpeg) → Promise<{ok, data|error}> / opts.mapUri(url): PDFに入れるリンク先の変換(省略可) / opts.onProgress(済ページ数, 全ページ数): 進捗(省略可)
  async function linkDrawing(pdfjsLib, PDFLib, data, links, ask, opts) {
    var mapUri = (opts && opts.mapUri) || function (u) { return u; };
    var doc = await pdfjsLib.getDocument({ data: new Uint8Array(data.slice(0)) }).promise;
    var out = await PDFLib.PDFDocument.load(data, { ignoreEncryption: true });
    var stats = { pages: doc.numPages, linked: 0, dup: 0, ng: 0, partial: [] };
    // 図番 → その図番の製品名の一覧(比較用にそろえた形)
    var byZ = {}, byName = {};   // byName: 製品名(比較用の形) → その製品名が登録されている図番の一覧
    Object.keys(links).forEach(function (k) {
      var p = k.split('\t'), z = fold(p[0]), fn = fold(p[1]);
      (byZ[z] = byZ[z] || []).push({ zuban: p[0], name: p[1], f: fn, v: links[k] });
      (byName[fn] = byName[fn] || []).push(p[0]);
    });
    var sent = [];   // 直近1分に送った時刻
    async function throttle() {   // 1分あたりの回数を超えないよう、空くまで待つ
      for (;;) {
        var now = Date.now();
        sent = sent.filter(function (t) { return now - t < 60000; });
        if (sent.length < MAX_CALLS_PER_MIN) { sent.push(now); return; }
        await sleep(60000 - (now - sent[0]) + 200);
      }
    }
    async function call(kind, r, keep) {   // keep=true: 送ったあとも画像を使い続けるので手放さない
      var img = jpeg(r.canvas);
      if (!keep) release(r);
      for (var attempt = 0; ; attempt++) {
        await throttle();
        var res = await ask(kind, img);
        if (res && res.ok) return res.data;
        var msg = (res && res.error) || '読み取りに失敗しました';
        if (attempt < RETRY_429 && /429|quota/i.test(msg)) { await sleep(8000 * (attempt + 1)); continue; }   // 上限に当たったときは待って再試行
        throw new Error(msg);
      }
    }
    // 読み取ったセルの中から、図番 z の製品名(まだ使っていないもの)と一致する最初のセルを探す。seen には読み取った文字を集める
    function pick(cells, z, used, seen) {
      var fz = fold(z), es = byZ[fz];
      for (var ci = 0; ci < (cells || []).length; ci++) {
        var c = cells[ci];
        if (!c.text) continue;
        seen.push(c.text);
        var fc = fold(c.text);
        for (var ei = 0; ei < es.length; ei++) if (!used[fz + '#' + ei] && es[ei].f === fc) return { e: es[ei], k: fz + '#' + ei, c: c };
      }
      return null;
    }
    // 読み取ったセルの中に、マスタにある製品名で、ページの図番(fz)ではなく別の図番に登録されているものがあれば返す。
    // 読み違いではなく「この図番の製品名ではない」ことが分かるので、読み直し(Geminiの呼び出し)をしない
    function otherZuban(cells, fz) {
      for (var ci = 0; ci < (cells || []).length; ci++) {
        var t = cells[ci].text, zs = t && byName[fold(t)];
        if (zs && !zs.some(function (z) { return fold(z) === fz; })) return { text: t, zubans: zs.filter(function (z, i) { return zs.indexOf(z) === i; }).slice(0, 3) };
      }
      return null;
    }
    // 右下の隅(ページの右半分・下から2割)だけを拡大して locate で読む。図面番号の読み直しと、図面番号欄の位置探しに使う
    async function cornerLocate(pg) {
      var v = pg.getViewport({ scale: 1 }), sc = CORNER_SIDE / (v.width * 0.5);
      return call('locate', await renderRegion(pg, sc, v.width * sc * 0.5, v.height * sc * 0.8, v.width * sc * 0.5, v.height * sc * 0.2));
    }
    function otherNg(pn, z, o) { return { page: pn, zuban: z, name: o.text, reason: '製品名はマスタの別の図番(' + o.zubans.join('・') + ')に登録されています' }; }
    // リンク(クリックできる範囲)と、セル全体の薄い青の着色を、ページに付ける
    function addLink(pdfPage, a) {
      var ctx = out.context, act = ctx.obj({ S: 'URI', URI: PDFLib.PDFString.of(root.ShippingCore.encodeUri(a.uri)) });
      pdfPage.node.addAnnot(ctx.register(ctx.obj({ Type: 'Annot', Subtype: 'Link', Rect: a.rect, Border: [0, 0, 0], A: act })));
      // 図面は文字が細かく下線だと文字に重なるので、セル全体を薄い青で塗る(乗算なので文字はそのまま見える)
      pdfPage.drawRectangle({ x: a.rect[0], y: a.rect[1], width: a.rect[2] - a.rect[0], height: a.rect[3] - a.rect[1],
        color: PDFLib.rgb(0.62, 0.78, 1), blendMode: PDFLib.BlendMode.Multiply });
    }
    // 1枚で読んだ結果が細かい表か(語が多く、語の高さが小さい)。細かければ、読み直す解像度の倍率を返す(そうでなければ 0)
    function denseFactor(lines, ch) {
      var hs = [];
      lines.forEach(function (l) { ((l && l.items) || []).forEach(function (x) { if (x && x.box && x.box.length === 4) hs.push((x.box[2] - x.box[0]) / 1000 * ch); }); });
      if (hs.length < DENSE_MIN_ITEMS) return 0;
      hs.sort(function (p, q) { return p - q; });
      var mh = hs[hs.length >> 1];
      return mh > 0 && mh < DENSE_BOX_PX ? clamp(TILE_BOX_PX / mh, 1.5, 3) : 0;
    }
    // 細かいページを、重なりのある数枚(1枚 約2000×1600px)に分けて高い解像度(scale sc、向き R)で読む。1枚でも読めなければ null(1枚で読んだ結果を使う)
    async function readTiles(page, R, v1, sc) {
      var Wt = v1.width * sc, Ht = v1.height * sc, cols = Math.ceil(Wt / TILE_W), rows = Math.ceil(Ht / TILE_H), cw = Wt / cols, chh = Ht / rows;
      var ox = cols > 1 ? TILE_OVX * Wt : 0, oy = rows > 1 ? TILE_OVY * Ht : 0, specs = [], r, c;
      for (r = 0; r < rows; r++) for (c = 0; c < cols; c++) {
        var x0 = Math.max(0, c * cw - ox), y0 = Math.max(0, r * chh - oy), x1 = Math.min(Wt, (c + 1) * cw + ox), y1 = Math.min(Ht, (r + 1) * chh + oy);
        specs.push({ x0: x0, y0: y0, x1: x1, y1: y1, core: { x0: c * cw / sc, y0: r * chh / sc, x1: (c + 1) * cw / sc, y1: (r + 1) * chh / sc } });
      }
      var out3 = new Array(specs.length), next = 0, failed = false;
      async function worker() {
        while (next < specs.length && !failed) {
          var k = next++, sp = specs[k], cv = await renderRegion(page, sc, sp.x0, sp.y0, sp.x1 - sp.x0, sp.y1 - sp.y0, R), rr;
          try { rr = await call('list', cv, true); } catch (e) { release(cv); failed = true; return; }
          (function (sp, cv) {
            out3[k] = { lines: (rr && rr.lines) || [], cv: cv, sc: sc, ox: sp.x0, oy: sp.y0, core: sp.core,
              toPage: function (bx) { var b = boxPx(bx, cv.canvas.width, cv.canvas.height); return b && { x0: (b.x0 + sp.x0) / sc, y0: (b.y0 + sp.y0) / sc, x1: (b.x1 + sp.x0) / sc, y1: (b.y1 + sp.y0) / sc }; } };
          })(sp, cv);
        }
      }
      var ws = []; for (var q = 0; q < Math.min(TILE_PAR, specs.length); q++) ws.push(worker());
      await Promise.all(ws);
      if (failed) { out3.forEach(function (p) { if (p) release(p.cv); }); return null; }
      return out3;
    }
    // 一覧表の製品名の比べる形。漢字などが続く語(「2CSb582-2付BT」)は、マスタに無ければ漢字の手前の英数字で比べる(文字データのあるPDFの照合と同じ。2026-11-04〜)
    function fname(t) {
      var f = fold(t);
      if (byName[f]) return f;
      var m = String(t).match(/^[A-Za-z0-9][A-Za-z0-9\-_.\/]*(?=[^\x00-\x7f])/);
      return m ? fold(m[0]) : f;
    }
    // 一覧表(手書き・スキャン)の読み取り。製品表が見つからないページだけで使う。扱えたら true(リンクまたはNGを付けた)、扱えなければ false
    async function listPage(page, pn, pdfPage, W, H, s0) {
      var res, rot = 0;
      // 向きの確認: 文字が正しく読める向きにするには時計回りに何度回すか(0/90/180/270)。聞けなければ回さない(従来どおり)
      // まず4つの向きを並べて「正しい向きはどれか」を聞く(orient4)。旧GAS・通信エラー・答えが 1〜4 でないときは、従来の orient で聞く
      var got = false;
      try {
        var o4 = await call('orient4', await orientSheet(page, W, H));
        if (o4 && [1, 2, 3, 4].indexOf(o4.panel) >= 0) { rot = (o4.panel - 1) * 90; got = true; }
      } catch (e) { got = false; }
      if (!got) try {
        var so = ORIENT_SIDE / Math.max(W, H), o = await call('orient', await renderRegion(page, so, 0, 0, W * so, H * so));
        if (o && [90, 180, 270].indexOf(o.rotate) >= 0) rot = o.rotate;
      } catch (e) { rot = 0; }
      var R = ((page.rotate || 0) + rot) % 360, v1 = page.getViewport({ scale: 1, rotation: R });   // rot=0 のときはページの向きのまま(従来と同じ)
      var lr = await renderRegion(page, s0, 0, 0, v1.width * s0, v1.height * s0, R);
      try { res = await call('list', lr, true); } catch (e) { release(lr); return false; }   // 旧GAS(kind=list を知らない)・通信エラーなど
      var any = false, annots = [], hitsAll = [], ngs = [];
      // 読み取りの単位(piece)。ふつうはページ全体の1枚。細かいときは分けた数枚(tiled)。toPage: 読んだ位置(0〜1000)→ ページの座標(scale 1)
      var pieces = [{ lines: (res && res.lines) || [], cv: lr, sc: s0, ox: 0, oy: 0, core: null,
        toPage: function (bx) { return boxPx(bx, v1.width, v1.height); } }];
      var whole = pieces[0];   // ページ全体を1枚で読んだ結果(分けて読んだとき、1枚の境目をまたぐ組を探すのに使う)
      var dense = denseFactor(pieces[0].lines, lr.canvas.height);
      if (dense) {
        var tiles = await readTiles(page, R, v1, s0 * dense);
        if (tiles) { release(lr); pieces = tiles; }
      }
      pieces.forEach(function (pc, pi) {
        if (pc.core) { pairNear(pc, pi); return; }   // 分けて読んだ1枚は、行ではなく位置の近さで組を作る
        pc.lines.forEach(function (line) {
          var it = ((line && line.items) || []).filter(function (x) { return x && x.text; });
          var zs = it.filter(function (x) { return byZ[fold(x.text)]; }), ns = it.filter(function (x) { return byName[fname(x.text)]; });
          if (!zs.length && !ns.length) return;   // マスタの語が無い行(見出し・メモなど)は数えない
          any = true;
          var usedItem = [], hits = 0, show = it.map(function (x) { return x.text; }).join(' '), rep0 = pc.toPage((zs[0] || ns[0]).box);
          zs.forEach(function (z) {
            var es = byZ[fold(z.text)];
            it.forEach(function (n, ni) {
              if (n === z || usedItem[ni]) return;
              var fn = fname(n.text), e = es.filter(function (x) { return x.f === fn; })[0];
              if (!e) return;
              usedItem[ni] = 1; hits++;
              var b = pc.toPage(n.box);
              if (Array.isArray(e.v)) { ngs.push({ pi: pi, at: b, ng: { page: pn, zuban: e.zuban, name: e.name, reason: '重複' }, dup: true }); return; }
              if (!b) { ngs.push({ pi: pi, at: rep0, ng: { page: pn, zuban: e.zuban, name: n.text, reason: 'セルの位置を読み取れません' } }); return; }
              hitsAll.push({ b: b, uri: mapUri(e.v), pi: pi, name: e.name });
            });
          });
          if (hits) return;
          if (zs.length) ngs.push({ pi: pi, at: rep0, z: zs[0].text, ng: { page: pn, zuban: zs[0].text, name: show, reason: '製品名が不一致(読み取った行の文字を表示)' } });
          else ngs.push({ pi: pi, at: rep0, ng: { page: pn, zuban: '', name: show, reason: '図番が見つかりません(読み取った行の文字を表示)' } });
        });
      });
      // 分けて読んだ1枚の組の作り方: 各図番に、縦の位置が近く(語の高さの1.2倍以内)、マスタでその図番の製品名になっている語を、近い順に1対1で選ぶ
      // (細かい表では Gemini の縦の位置が列ごとに少しずつ違い、行にまとめると同じ行が分かれてしまうため)
      function pairNear(pc, pi) {
        var it = [];
        pc.lines.forEach(function (l) { ((l && l.items) || []).forEach(function (x) { if (x && x.text && x.box && x.box.length === 4) it.push(x); }); });
        if (!it.length) return;
        pc.items = it;
        var cy = function (x) { return (x.box[0] + x.box[2]) / 2; }, cx = function (x) { return (x.box[1] + x.box[3]) / 2; };
        var hs2 = it.map(function (x) { return x.box[2] - x.box[0]; }).sort(function (p, q) { return p - q; }), mh = Math.max(1, hs2[hs2.length >> 1]);
        var Zs = it.filter(function (x) { return byZ[fold(x.text)]; }), Ns = it.filter(function (x) { return byName[fname(x.text)]; });
        if (!Zs.length && !Ns.length) return;
        any = true;
        var cands = [];
        Zs.forEach(function (z) {
          var es = byZ[fold(z.text)];
          Ns.forEach(function (n) {
            if (n === z) return;
            var fn = fname(n.text), e = es.filter(function (x) { return x.f === fn; })[0], dy = Math.abs(cy(n) - cy(z));
            if (e && dy <= 1.2 * mh) cands.push({ z: z, n: n, e: e, cost: dy / mh + Math.abs(cx(n) - cx(z)) / 1000 });
          });
        });
        cands.sort(function (p, q) { return p.cost - q.cost; });
        var usedZ = [], usedN = [];
        cands.forEach(function (c) {
          if (usedZ.indexOf(c.z) >= 0 || usedN.indexOf(c.n) >= 0) return;
          usedZ.push(c.z); usedN.push(c.n);
          var b = pc.toPage(c.n.box);
          if (!b) { ngs.push({ pi: pi, at: pc.toPage(c.z.box), ng: { page: pn, zuban: c.e.zuban, name: c.n.text, reason: 'セルの位置を読み取れません' } }); return; }   // 幅・高さが0などの位置はリンクにしない(1枚で読むときと同じ。2026-11-04〜)
          if (Array.isArray(c.e.v)) { ngs.push({ pi: pi, at: b, ng: { page: pn, zuban: c.e.zuban, name: c.e.name, reason: '重複' }, dup: true }); return; }
          hitsAll.push({ b: b, item: c.n, uri: mapUri(c.e.v), pi: pi, name: c.e.name });
        });
        // 組にならなかった図番・製品名は NG(近くの語を「読み取った文字」として出す)
        var near = function (x) { return it.filter(function (y) { return Math.abs(cy(y) - cy(x)) <= 0.6 * mh && Math.abs(cx(y) - cx(x)) <= 300; })
          .sort(function (p, q) { return p.box[1] - q.box[1]; }).map(function (y) { return y.text; }).join(' '); };
        Zs.forEach(function (z) { if (usedZ.indexOf(z) < 0 && usedN.indexOf(z) < 0) ngs.push({ pi: pi, at: pc.toPage(z.box), ng: { page: pn, zuban: z.text, name: near(z), reason: '製品名が不一致(読み取った行の文字を表示)' } }); });
        Ns.forEach(function (n) { if (usedN.indexOf(n) < 0 && usedZ.indexOf(n) < 0) ngs.push({ pi: pi, at: pc.toPage(n.box), ng: { page: pn, zuban: '', name: near(n), reason: '図番が見つかりません(読み取った行の文字を表示)' } }); });
      }
      // 位置の補正(細かい表で Gemini の縦の位置がずれるとき)。補正は読み取り画像の上で行い、ページの座標(scale 1)に戻す
      var snapAll = [];   // 位置の補正ができ、あいまいでない語(別の1枚の語も含む): { pi, f(比べる形の文字), b(ページの座標) }
      pieces.forEach(function (pc, pi) {
        var hs = hitsAll.filter(function (h) { return h.pi === pi; });
        if (hs.length) {
          var toPx = function (b) { return { x0: b.x0 * pc.sc - pc.ox, y0: b.y0 * pc.sc - pc.oy, x1: b.x1 * pc.sc - pc.ox, y1: b.y1 * pc.sc - pc.oy }; };
          var toPt = function (q) { return { x0: (q.x0 + pc.ox) / pc.sc, y0: (q.y0 + pc.oy) / pc.sc, x1: (q.x1 + pc.ox) / pc.sc, y1: (q.y1 + pc.oy) / pc.sc }; };
          var px = hs.map(function (h) { return toPx(h.b); });
          // 分けて読んだ1枚では、リンクを付けない語(マスタに無い品名・数字など)も一緒に行へ対応させる。各行がその語自身の行に収まるので、リンクが隣の行へずれにくい
          var oIt = !pc.core ? [] : (pc.items || []).filter(function (x) { return !hs.some(function (h) { return h.item === x; }) && pc.toPage(x.box); });
          var others = oIt.map(function (x) { return toPx(pc.toPage(x.box)); });
          if (snapRows(pc.cv.canvas, px.concat(others))) {
            px.forEach(function (q, k) { if (q.snapped) hs[k].snapped = true; if (q.amb) { hs[k].amb = true; hs[k].ambG = q.ambG; } hs[k].b = toPt(q); });
            // リンクにしない語も、位置の補正ができたものは残す(別の1枚で位置があいまいになったリンクの位置を決めるのに使う)
            others.forEach(function (q, k) { if (q.snapped && !q.amb) snapAll.push({ pi: pi, f: fname(oIt[k].text), b: toPt(q) }); });
          }
          hs.forEach(function (h) { if (h.snapped && !h.amb && h.item) snapAll.push({ pi: pi, f: fname(h.item.text), b: h.b }); });
          if (pc.core && hs.length >= 3) {   // 横幅がほかの製品名(中央値)の1.4倍を超える語は、中央値の幅に縮める(隣の欄まで下線が伸びないように)
            var ws = hs.map(function (h) { return h.b.x1 - h.b.x0; }).sort(function (p, q) { return p - q; }), mw = ws[ws.length >> 1];
            hs.forEach(function (h) { if (h.b.x1 - h.b.x0 > 1.4 * mw) h.b = { x0: h.b.x0, y0: h.b.y0, x1: h.b.x0 + mw, y1: h.b.y1 }; });
          }
        }
        release(pc.cv);
      });
      // 分けて読んだときは、重なった部分で同じ製品名が2回読めることがあるので1つにまとめる(別の1枚で、同じ製品名が約2.5行以内にあれば同じものとみなし、
      // 位置の補正ができた方、その中では読んだ1枚の中心に近い方を残す。同じ1枚の中で同じ製品名が続く行はまとめない)。
      // NG は、その行が読んだ1枚の担当範囲(重なりを除いた範囲)にあり、同じ行にリンクが無いものだけを残す
      if (pieces.length > 1) {
        // 位置があいまいなリンクは、別の1枚で同じ文字が近く(約2.5行以内・横が重なる)にあいまいでなく補正できていれば、その位置にする(2026-11-04〜)
        hitsAll.forEach(function (h) {
          if (!h.amb || !h.item) return;
          var f = fname(h.item.text), hh = h.b.y1 - h.b.y0, cy0 = (h.b.y0 + h.b.y1) / 2, best = null, bd = Infinity;
          snapAll.forEach(function (s2) {
            if (s2.pi === h.pi || s2.f !== f || Math.min(s2.b.x1, h.b.x1) <= Math.max(s2.b.x0, h.b.x0)) return;
            var dy = Math.abs((s2.b.y0 + s2.b.y1) / 2 - cy0);
            if (dy < 4 * hh && dy < bd) { bd = dy; best = s2; }
          });
          if (best) { h.fixDy = best.b.y0 - h.b.y0; h.b = { x0: h.b.x0, y0: best.b.y0, x1: h.b.x1, y1: best.b.y1 }; h.amb = false; }
        });
        // 1枚の境目をまたいで、どの1枚でも組にならなかった製品名(図番と製品名が別々の1枚に入った)は、ページ全体を1枚で読んだ結果の同じ行の組で補う。
        // 位置は、その製品名を位置の補正ができた1枚の位置(全体の読み取りの位置から約6行以内・横が重なる、いちばん近いもの)。見つからなければ付けない(2026-11-04〜)
        var hh0 = (function () { var a = hitsAll.map(function (h) { return h.b.y1 - h.b.y0; }).sort(function (p, q) { return p - q; }); return a.length ? a[a.length >> 1] : 0; })();
        if (hh0 > 0) (whole.lines || []).forEach(function (line) {
          var it = ((line && line.items) || []).filter(function (x) { return x && x.text; });
          it.forEach(function (z) {
            var es = byZ[fold(z.text)];
            if (!es) return;
            it.forEach(function (n) {
              if (n === z) return;
              var fn = fname(n.text), e = es.filter(function (x) { return x.f === fn; })[0];
              if (!e || Array.isArray(e.v)) return;
              var wb = whole.toPage(n.box);
              if (!wb) return;
              var wy = (wb.y0 + wb.y1) / 2, uri = mapUri(e.v);
              if (hitsAll.some(function (h) { return h.uri === uri && h.name === e.name && Math.abs((h.b.y0 + h.b.y1) / 2 - wy) < 12 * hh0 && Math.min(h.b.x1, wb.x1) > Math.max(h.b.x0, wb.x0); })) return;
              var best = null, bd = Infinity;
              snapAll.forEach(function (s2) {
                if (s2.f !== fn || Math.min(s2.b.x1, wb.x1) <= Math.max(s2.b.x0, wb.x0)) return;
                var dy = Math.abs((s2.b.y0 + s2.b.y1) / 2 - wy);
                if (dy < 12 * hh0 && dy < bd) { bd = dy; best = s2; }
              });
              if (best) hitsAll.push({ b: best.b, uri: uri, pi: best.pi, name: e.name, snapped: true });
            });
          });
        });
        // 同じ段のほかの語も、照らし合わせられた語がそろって同じだけずれていれば(差が0.3行分以内)、同じだけ動かす
        var byG = {};
        hitsAll.forEach(function (h) { if (h.ambG) (byG[h.ambG] = byG[h.ambG] || []).push(h); });
        Object.keys(byG).forEach(function (k) {
          var g = byG[k], ds = g.filter(function (h) { return h.fixDy !== undefined; }).map(function (h) { return h.fixDy; }).sort(function (p, q) { return p - q; });
          if (!ds.length) return;
          var md = ds[ds.length >> 1], hh = g[0].b.y1 - g[0].b.y0;
          if (ds[ds.length - 1] - ds[0] > 0.6 * hh) return;
          g.forEach(function (h) { if (h.fixDy === undefined && h.amb) { h.b = { x0: h.b.x0, y0: h.b.y0 + md, x1: h.b.x1, y1: h.b.y1 + md }; h.amb = false; } });
        });
        var center = function (h) { var c = pieces[h.pi].core, x = (h.b.x0 + h.b.x1) / 2, y = (h.b.y0 + h.b.y1) / 2;
          return Math.min((x - c.x0) / (c.x1 - c.x0), (c.x1 - x) / (c.x1 - c.x0), (y - c.y0) / (c.y1 - c.y0), (c.y1 - y) / (c.y1 - c.y0)); };
        var keep = [];
        hitsAll.slice().sort(function (p, q) { return (q.snapped && !q.amb ? 1 : 0) - (p.snapped && !p.amb ? 1 : 0) || (q.snapped ? 1 : 0) - (p.snapped ? 1 : 0) || center(q) - center(p); }).forEach(function (h) {
          var hh = h.b.y1 - h.b.y0;   // 文字の高さ(行の間隔の約半分)
          var same = keep.some(function (k) { return k.pi !== h.pi && k.uri === h.uri && k.name === h.name && Math.abs((k.b.y0 + k.b.y1) - (h.b.y0 + h.b.y1)) / 2 < 4 * hh && Math.min(k.b.x1, h.b.x1) > Math.max(k.b.x0, h.b.x0); });
          if (!same) keep.push(h);
        });
        hitsAll = hitsAll.filter(function (h) { return keep.indexOf(h) >= 0; });
        ngs = ngs.filter(function (g) {
          // 位置を読み取れなかった語は、同じ製品名に(別の1枚で)リンクが付いていれば NG にしない(2026-11-04〜)
          if (g.ng.reason === 'セルの位置を読み取れません' && hitsAll.some(function (h) { return h.name === g.ng.name || h.name === g.ng.name.replace(/[^\x00-\x7f].*$/, ''); })) return false;
          var c = pieces[g.pi].core, a = g.at;
          if (!a) return true;
          var x = (a.x0 + a.x1) / 2, y = (a.y0 + a.y1) / 2;
          if (x < c.x0 || x >= c.x1 || y < c.y0 || y >= c.y1) return false;
          return !hitsAll.some(function (h) { return Math.abs((h.b.y0 + h.b.y1) / 2 - y) < 0.8 * (h.b.y1 - h.b.y0) && Math.abs((h.b.x0 + h.b.x1) / 2 - x) < 0.15 * v1.width; });   // 同じ行・近くの列にリンクがあれば NG にしない
        });
      }
      ngs.forEach(function (g) { if (g.dup) stats.dup++; stats.ng++; stats.partial.push(g.ng); });
      stats.linked += hitsAll.length;
      hitsAll.forEach(function (h) {
        var b = h.b, m = (b.y1 - b.y0) * 0.15;
        // 下線は、読んだ向きでの文字の下辺(回した画像でも文字の下になるよう、両端をPDFの座標に直す)
        annots.push({ rect: pdfRect(v1, 0, 0, { x0: b.x0 - m, y0: b.y0 - m, x1: b.x1 + m, y1: b.y1 + m }), uri: h.uri,
          ul: [v1.convertToPdfPoint(b.x0 - m, b.y1 + m), v1.convertToPdfPoint(b.x1 + m, b.y1 + m)], th: Math.max(0.9, (b.y1 - b.y0 + 2 * m) * 0.06) });
      });
      // 一覧表のリンクは、出荷リストと同じく製品名の下に青い下線を引く(着色はしない)
      annots.forEach(function (a) {
        var ctx = out.context, act = ctx.obj({ S: 'URI', URI: PDFLib.PDFString.of(root.ShippingCore.encodeUri(a.uri)) }), r = a.rect;
        pdfPage.node.addAnnot(ctx.register(ctx.obj({ Type: 'Annot', Subtype: 'Link', Rect: r, Border: [0, 0, 0], A: act })));
        pdfPage.drawLine({ start: { x: a.ul[0][0], y: a.ul[0][1] }, end: { x: a.ul[1][0], y: a.ul[1][1] }, thickness: a.th, color: PDFLib.rgb(0, 0.2, 0.9) });
      });
      return any;
    }
    var numCands = [];   // 製品名にリンクを付けたページ(図面番号欄の着色の候補): { pn, fz(図番), uri }
    // ページごとの処理。ページは並行して読む(Geminiの待ち時間が重ならないように)。結果の順序は最後に頁順に整える
    async function pageJob(pn) {
      var page = await doc.getPage(pn), v1 = page.getViewport({ scale: 1 }), W = v1.width, H = v1.height;
      var s0 = LOCATE_SIDE / Math.max(W, H), sH = READ_DPI / 72, PW = W * sH, PH = H * sH, pdfPage = out.getPage(pn - 1), annots = [];
      var loc = await call('locate', await renderRegion(page, s0, 0, 0, W * s0, H * s0));
      // 製品表を見落としたときだけ: ページを上下2つ(少し重ねる)に分け、拡大して探し直す。位置はページ全体の0〜1000に直して使う
      if (!(loc.tables || []).length) {
        var sh = HALF_SIDE / W, found = await Promise.all([[0, 0.55], [0.45, 0.55]].map(async function (h) {
          try {
            var r2 = await call('locate', await renderRegion(page, sh, 0, H * sh * h[0], W * sh, H * sh * h[1])), off = h[0] * 1000;
            var mapBox = function (b) { return b && b.length === 4 ? [off + b[0] * h[1], b[1], off + b[2] * h[1], b[3]] : b; };
            return (r2.tables || []).map(function (t) {
              return { box: mapBox(t.box), cells: (t.cells || []).map(function (c) { return { text: c.text, box: mapBox(c.box) }; }) };
            });
          } catch (e) { return []; }
        }));
        loc.tables = [].concat.apply([], found);
      }
      var tables = loc.tables || [];
      if (!tables.length) {
        if (await listPage(page, pn, pdfPage, W, H, s0)) return;   // 手書き・スキャンの一覧表として読めたら、そちらの結果にする
        stats.ng++; stats.partial.push({ page: pn, zuban: loc.drawingNumber || '', name: '', reason: '製品表が見つかりません' }); return;
      }

      // 読み直し(遅い道)用の、図面番号欄のあたりの画像。必要になったときだけ描く
      var numMemo = null, numRead = null;
      function numberImage() { return numMemo || (numMemo = renderAround(page, sH, PW, PH, loc.drawingNumberBox)); }
      async function readNumber() {   // 図面番号を高解像度で読み直し、マスタにある方を採る(場所探しで読んだ値も候補)
        if (numRead) return numRead;
        var cs = [], im = await numberImage();
        if (im) { try { cs.push((await call('number', im.r, true)).text); } catch (e) { /* 読み直しに失敗しても、場所探しの値で続ける */ } }
        if (loc.drawingNumber) cs.push(loc.drawingNumber);
        // どれもマスタに無いときだけ、右下の隅を広めに切り出して読み直す(図面番号が「WR」だけなど途中までしか読めないことがあるため)
        if (!cs.some(function (t) { return byZ[fold(t)]; })) {
          try {
            var cn = await cornerLocate(page);
            if (cn.drawingNumber) cs.push(cn.drawingNumber);
          } catch (e) { /* 読み直しに失敗しても、ここまでの値で続ける */ }
        }
        cs = cs.filter(function (t, i) { return t && cs.indexOf(t) === i; });
        return (numRead = { z: cs.filter(function (t) { return byZ[fold(t)]; })[0], show: cs.join(' / ') });
      }

      // 速い道: 全体画像の1回の読み取りで、図面番号がマスタにあり、製品表のセルがその図番の製品名と一致すればそこで確定する(Geminiの呼び出し1回)。
      // 遅い道(確定できなかったときだけ): 図面番号欄と製品表を高解像度で切り出して読み直す(最大2回追加)
      var used = {}, zMsg = false, zFast = loc.drawingNumber && byZ[fold(loc.drawingNumber)] ? loc.drawingNumber : null;
      for (var ti = 0; ti < tables.length; ti++) {
        var tb = boxPx(tables[ti].box, PW, PH);
        if (!tb) { stats.ng++; stats.partial.push({ page: pn, zuban: loc.drawingNumber || '', name: '', reason: '製品表の位置を読み取れません' }); continue; }
        var px = Math.max((tb.x1 - tb.x0) * 0.03 + 24, PW * 0.04), py = (tb.y1 - tb.y0) * 0.3 + 24;   // 横はGeminiの位置のずれ(最大でページ幅の数%)を見込んで広く
        var cx0 = clamp(tb.x0 - px, 0, PW), cy0 = clamp(tb.y0 - py, 0, PH), cx1 = clamp(tb.x1 + px, 0, PW), cy1 = clamp(tb.y1 + py, 0, PH);
        var tr = await renderRegion(page, sH, cx0, cy0, cx1 - cx0, cy1 - cy0);
        var hit = null, seen = [], zUse = zFast, tbx = null, cellOpt = null;
        if (zFast && tables[ti].cells) {
          hit = pick(tables[ti].cells, zFast, used, seen);
          var fb = hit && boxPx(hit.c.box, PW, PH);
          if (fb) { tbx = { x0: fb.x0 - cx0, y0: fb.y0 - cy0, x1: fb.x1 - cx0, y1: fb.y1 - cy0 }; cellOpt = { idx: tables[ti].cells.indexOf(hit.c) }; }
          else hit = null;
          var oz = !hit && otherZuban(tables[ti].cells, fold(zFast));
          if (oz) { stats.ng++; stats.partial.push(otherNg(pn, zFast, oz)); release(tr); continue; }   // 別の図番の製品名: 遅い道(読み直し)に進まない
        }
        if (!hit) {
          seen = [];
          var zn = await readNumber();
          zUse = zn.z;
          if (!zUse) {
            release(tr); stats.ng++;
            if (!zMsg) { zMsg = true; stats.partial.push({ page: pn, zuban: zn.show, name: '', reason: 'マスタに無い図番(読み取り: ' + (zn.show || '読めず') + ')' }); }
            continue;
          }
          // 製品名が一致しなかったときだけ、同じ画像をもう1回読み直す(CADの小さな文字「外」などをGeminiが読み落とすことがあり、読み取りは毎回少し変わる)
          var other = null;
          for (var tryN = 0; tryN < TABLE_TRIES && !hit && !other; tryN++) {
            var tbl = await call('table', tr, true);
            seen = [];
            hit = pick(tbl.cells, zUse, used, seen);
            if (hit) { tbx = boxPx(hit.c.box, tr.canvas.width, tr.canvas.height); cellOpt = { idx: tbl.cells.indexOf(hit.c) }; }
            else other = otherZuban(tbl.cells, fold(zUse));   // 別の図番の製品名なら、読み直さない
          }
        }
        var ng = null;
        if (!hit && other) ng = otherNg(pn, zUse, other);
        else if (!hit) ng = { zuban: zUse, name: seen.join(' | '), reason: '製品名が不一致(読み取った表の文字を表示)' };
        else if (Array.isArray(hit.e.v)) { stats.dup++; ng = { zuban: hit.e.zuban, name: hit.e.name, reason: '重複' }; }
        else if (!tbx) ng = { zuban: zUse, name: hit.c.text, reason: 'セルの位置を読み取れません' };
        if (hit) used[hit.k] = 1;
        if (ng) { stats.ng++; ng.page = pn; stats.partial.push(ng); release(tr); continue; }
        var cell = cellFromLines(tr.canvas, { x0: tb.x0 - cx0, y0: tb.y0 - cy0, x1: tb.x1 - cx0, y1: tb.y1 - cy0 }, tbx, cellOpt);
        annots.push({ rect: pdfRect(tr.vp, cx0, cy0, cell), uri: mapUri(hit.e.v), fz: fold(hit.e.zuban) });
        stats.linked++;
        release(tr);
      }
      if (annots.length) numCands.push({ pn: pn, fz: annots[0].fz, uri: annots[0].uri });   // 図面番号欄の着色は、全ページ処理のあとでまとめて行う
      var imEnd = numMemo && await numMemo;
      if (imEnd) release(imEnd.r);
      annots.forEach(function (a) { addLink(pdfPage, a); });
    }
    // 図面番号(右下)にも、製品名と同じリンクと着色を付ける。全体画像では、Geminiが図面番号の位置を隣のセル(工事番号・図面名称など)と取り違えることがあるので、
    // 右下だけを拡大して探し直し、読んだ図面番号が、製品名にリンクを付けた図番と一致したときだけ位置を採る。同じ図面セットなら表題欄の位置は全ページで同じなので、
    // 探し直しはPDF全体で最大3回(1回で確定すれば1回)にして、Geminiの呼び出し回数を増やさない。一致しなければ、位置が違う疑いがあるので塗らない
    async function markNumberCells(cands) {
      cands.sort(function (a, b) { return a.pn - b.pn; });
      var tpl = null;
      for (var ci = 0; ci < Math.min(3, cands.length) && !tpl; ci++) {
        var pg = await doc.getPage(cands[ci].pn);
        try {
          var cn = await cornerLocate(pg), cb = cn.drawingNumberBox;
          if (cn.drawingNumber && fold(cn.drawingNumber) === cands[ci].fz && cb && cb.length === 4) tpl = [800 + cb[0] * 0.2, 500 + cb[1] * 0.5, 800 + cb[2] * 0.2, 500 + cb[3] * 0.5];
        } catch (e) { /* 探し直しに失敗しても、製品名のリンクはそのまま */ }
      }
      if (!tpl) return;
      for (var k = 0; k < cands.length; k++) {
        var page = await doc.getPage(cands[k].pn), vp1 = page.getViewport({ scale: 1 }), sH = READ_DPI / 72;
        var im = await renderAround(page, sH, vp1.width * sH, vp1.height * sH, tpl);
        if (!im) continue;
        var nl = { x0: im.nb.x0 - im.rx0, y0: im.nb.y0 - im.ry0, x1: im.nb.x1 - im.rx0, y1: im.nb.y1 - im.ry0 }, nc = cellFromLines(im.r.canvas, nl, nl);
        if (nc.snapped) addLink(out.getPage(cands[k].pn - 1), { rect: pdfRect(im.r.vp, im.rx0, im.ry0, nc), uri: cands[k].uri });
        release(im.r);
      }
    }
    try {
      var nextPage = 1, donePages = 0;
      var worker = async function () {
        while (nextPage <= doc.numPages) {
          var pn = nextPage++;
          try { await pageJob(pn); } catch (e) {   // 1ページの読み取りが失敗しても、ほかのページは続け、そのページはNG一覧に理由を出す
            stats.ng++; stats.partial.push({ page: pn, zuban: '', name: '', reason: '読み取りに失敗しました(' + String(e && e.message || e).slice(0, 80) + ')' });
          }
          if (opts && opts.onProgress) opts.onProgress(++donePages, doc.numPages);
        }
      };
      await Promise.all([worker(), worker(), worker()]);
      stats.partial.sort(function (a, b) { return a.page - b.page; });
      await markNumberCells(numCands);
    } finally { doc.destroy(); }   // pdf.js のworker・ページ資源を解放
    return { bytes: await out.save(), stats: stats };
  }

  var api = { linkDrawing: linkDrawing };
  if (typeof module !== 'undefined' && module.exports) module.exports = api; else root.ShippingDrawing = api;
})(typeof window !== 'undefined' ? window : this);
