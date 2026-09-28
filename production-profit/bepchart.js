/* 損益分岐生産量グラフ(SVG)。詳細版(app.js)・シンプル版(simple.js)で共用。
   書式関数 fmt / yen / ton / npt は読み込む側(app.js・simple.js)で定義する。 */
'use strict';

/* o.hideMoney=true で金額(縦軸の目盛り・固定費の額・内訳の額・売上高・トン単価・目標利益額)を出さない(シンプル版)。
   損益分岐生産量グラフ(SVG。横軸=生産トン数、縦軸=金額)。
   o: {fixed, unitPrice, laborPerTon, varPerTon, profitRate, x(つまみの初期位置t), beTons, goalTons, handleLabel, onMove(t)}
   面の塗り分け: 固定費帯 / 人件費帯 / 変動費帯 / 損失域(分岐点の左、売上線と総費用線の間) / 利益域(右)。
   つまみ(縦の点線)をドラッグすると、その重量での内訳(固定費・人件費・変動費・利益or損失)を積み上げバーで表示する。 */
const bepState = {};
function niceStep(range, count) {
  const raw = range / Math.max(count, 1), mag = Math.pow(10, Math.floor(Math.log10(raw || 1)));
  const n = raw / mag;
  return (n <= 1 ? 1 : n <= 2 ? 2 : n <= 5 ? 5 : 10) * mag;
}
/* 1億円以上は「7.6億円」(小数1桁)、未満は万円表示 */
function oku(v) { return Math.abs(v) >= 1e8 ? fmt(v / 1e8, 1) + '億円' : man(v); }
function man(v) { return Math.abs(v) >= 10000 ? fmt(v / 10000, 0) + '万円' : yen(v) + '円'; }

function drawBep(id, o) {
  const box = document.getElementById(id);
  const prev = bepState[id];
  // 同じ条件の再描画(ドラッグ中など)ではつまみ位置を保つ。条件が変わったら初期位置に戻す。
  const sig = o.sig || [o.fixed, o.unitPrice, o.laborPerTon, o.varPerTon, o.profitRate].join('|');
  const keep = prev && prev.sig === sig && !o.forceX && !o.fixedX; // 実績に固定のグラフ(fixedX)は毎回実績の位置に置く
  const st = bepState[id] = { o, x: keep ? prev.x : (o.x || 0), sig, padL: prev && prev.sig === sig ? prev.padL : undefined, maxX: keep ? prev.maxX : null }; // ドラッグ中以外は縮尺を取り直す
  if (!st.maxX) st.maxX = Math.max(o.x || 0, o.beTons || 0, o.goalTons || 0, 1) * 1.35;
  box.classList.toggle('fixedX', !!o.fixedX); // fixedX: つまみを動かせない(実績の損益分岐生産量タブ)
  renderBepSvg(id);
  if (!box.dataset.bound) {
    box.dataset.bound = '1';
    // 点線(現在・試算)の上(つまみ〜横軸、左右12px)にマウスが来たら手のカーソルにし、そこからだけドラッグで動かせる
    // (グラフの他の場所をクリックしても動かない)。つかんだ位置と点線のずれを保って動かす
    let dragging = false, grabDx = 0;
    const NEAR = 12;
    const toX = (e) => {
      const s = bepState[id], g = s.geom, r = box.getBoundingClientRect();
      return Math.min(s.maxX, Math.max(0, (e.clientX - r.left + grabDx - g.l) / g.w * s.maxX));
    };
    const onLine = (e) => {
      const s = bepState[id], g = s && s.geom, r = box.getBoundingClientRect();
      if (!s || s.o.fixedX || !g || s.cursorX === undefined) return false;
      const px = e.clientX - r.left, py = e.clientY - r.top;
      return Math.abs(px - s.cursorX) <= NEAR && py >= g.t - 50 && py <= g.t + g.h + 4;
    };
    box.addEventListener('pointerdown', (e) => {
      if (!onLine(e)) return;
      const s = bepState[id];
      grabDx = s.cursorX - (e.clientX - box.getBoundingClientRect().left);
      dragging = true; box.setPointerCapture(e.pointerId);
      box.classList.add('grabbing');
      e.preventDefault();
    });
    box.addEventListener('pointermove', (e) => {
      if (!dragging) { box.classList.toggle('canGrab', onLine(e)); return; }
      const s = bepState[id]; s.x = toX(e); if (s.o.onMove) s.o.onMove(s.x); else renderBepSvg(id); // onMoveの先で描き直すので二重に描かない
    });
    const end = (e) => { dragging = false; box.classList.remove('grabbing'); box.classList.toggle('canGrab', !!(e && onLine(e))); };
    box.addEventListener('pointerup', end); box.addEventListener('pointercancel', end);
    window.addEventListener('resize', () => bepState[id] && box.clientWidth && renderBepSvg(id)); // 非表示のタブのグラフは表示時に描く
  }
}

function renderBepSvg(id) {
  const box = document.getElementById(id), st = bepState[id], o = st.o;
  const W = box.clientWidth || 600, H = box.clientHeight || 380;
  const g = st.geom = { l: st.padL || 76, r: 16, t: o.dragHint ? 74 : 54, b: 36 }; // 上の余白につまみ(dragHintのときはその上に操作説明)、左の余白に固定費ラベルを置く
  g.w = W - g.l - g.r; g.h = H - g.t - g.b;
  // グラフ内の文字・間隔の倍率(幅1080×高さ600程度のグラフを1倍とし、グラフの大きさに合わせて拡大縮小)
  const k = Math.min(1.3, Math.max(0.55, Math.min(g.w / 1080, g.h / 600)));
  const P = o.unitPrice || 0, lab = o.laborPerTon || 0, vr = o.varPerTon || 0, F = o.fixed || 0;
  const maxX = st.maxX;
  const cost = (x) => F + (lab + vr) * x, sales = (x) => P * x;
  const maxY = Math.max(sales(maxX), cost(maxX), F, 1) * 1.05;
  const X = (x) => g.l + x / maxX * g.w, Y = (y) => g.t + g.h - y / maxY * g.h;
  const pts = (arr) => arr.map((p) => X(p[0]).toFixed(1) + ',' + Y(p[1]).toFixed(1)).join(' ');
  const be = o.beTons !== null && o.beTons !== undefined && o.beTons <= maxX ? o.beTons : null;
  let h = '';
  // グリッドと目盛
  const xs = niceStep(maxX, Math.max(3, Math.floor(g.w / 90))), ys = niceStep(maxY, 5);
  for (let v = 0; v <= maxY + 1e-9; v += ys) {
    h += `<line class="bg" x1="${g.l}" x2="${g.l + g.w}" y1="${Y(v)}" y2="${Y(v)}"/>`;
    // 左余白の固定費ラベル(2行)と重なる目盛りの数字は出さない
    if (!o.hideMoney && Math.abs(Y(v) - Y(F)) > (o.fixedLabel ? 34 : 22) * Math.max(1, k)) h += `<text class="ax" x="${g.l - 6}" y="${Y(v) + 4}" text-anchor="end">${fmt(v / 10000, 0)}万</text>`;
  }
  for (let v = 0; v <= maxX + 1e-9; v += xs) h += `<line class="bg" y1="${g.t}" y2="${g.t + g.h}" x1="${X(v)}" x2="${X(v)}"/><text class="ax" x="${X(v)}" y="${g.t + g.h + 16}" text-anchor="middle">${fmt(v, 0)}</text>`;
  h += `<text class="ax" x="${g.l + g.w}" y="${H - 4}" text-anchor="end">生産重量(t)</text>`;
  // 面: 固定費帯・人件費帯・変動費帯
  h += `<polygon class="fFixed" points="${pts([[0, 0], [maxX, 0], [maxX, F], [0, F]])}"/>`;
  h += `<polygon class="fLabor" points="${pts([[0, F], [maxX, F + lab * maxX], [maxX, F]])}"/>`;
  h += `<polygon class="fVar" points="${pts([[0, F], [maxX, cost(maxX)], [maxX, F + lab * maxX]])}"/>`;
  // 損失域・利益域
  if (be !== null) {
    h += `<polygon class="fLoss" points="${pts([[0, 0], [0, F], [be, sales(be)]])}"/>`;
    h += `<polygon class="fProfit" points="${pts([[be, sales(be)], [maxX, sales(maxX)], [maxX, cost(maxX)]])}"/>`;
  } else {
    h += `<polygon class="fLoss" points="${pts([[0, 0], [0, F], [maxX, cost(maxX)], [maxX, sales(maxX)]])}"/>`;
  }
  // 線
  h += `<line class="lFixed" x1="${X(0)}" x2="${X(maxX)}" y1="${Y(F)}" y2="${Y(F)}"/>`;
  h += `<text class="lbl fixedLbl" x="${g.l - 6}" y="${Y(F) - 3}" text-anchor="end">${(o.fixedLabel || ['その他固定費']).map((t, i) => i ? `<tspan x="${g.l - 6}" dy="${13 * Math.max(1, k)}">${t}</tspan>` : t).join('')}${o.hideMoney ? '' : `<tspan x="${g.l - 6}" dy="${14 * Math.max(1, k)}">${man(F)}</tspan>`}</text>`;
  h += `<line class="lCost" x1="${X(0)}" y1="${Y(F)}" x2="${X(maxX)}" y2="${Y(cost(maxX))}"/>`;
  h += `<line class="lSales" x1="${X(0)}" y1="${Y(0)}" x2="${X(maxX)}" y2="${Y(sales(maxX))}"/>`;
  h += `<text class="lbl lineLbl" data-line="sales" x="${X(maxX) - 4}" y="${Y(sales(maxX)) + 26 * k}" text-anchor="end">売上</text>`;
  h += `<text class="lbl cost lineLbl" data-line="cost" x="${X(maxX) - 4}" y="${Y(cost(maxX)) + 26 * k}" text-anchor="end">総費用</text>`;
  // 損益分岐生産量(軸への補助線付き)
  let beLbl = '';
  if (be !== null) {
    const bx = X(be), by = Y(sales(be));
    h += `<line class="lBe" x1="${bx}" x2="${bx}" y1="${by}" y2="${g.t + g.h}"/><line class="lBe" x1="${g.l}" x2="${bx}" y1="${by}" y2="${by}"/>`;
    h += `<circle class="mBeHalo" cx="${bx}" cy="${by}" r="11"/><circle class="mBe" cx="${bx}" cy="${by}" r="7"/>`;
    // 損益分岐の5項目(引き出し線で左上の空白へ。位置は描画後に文字の大きさを測って決める)。
    // トン単価・人工数・工数は、つまみ位置の生産重量で損益0になる値。
    const w = st.x, lr = o.laborRate || 0, oF = o.otherFixed !== undefined ? o.otherFixed : F;
    const nBe = w > 0 && lr > 0 ? (P - vr - oF / w) / lr : null;
    // [項目, 数値, 単位]。数値は右端をそろえる(描画後に列幅を測って配置)
    const lines = [
      ['生産量', ton(be), 't'],
      ['売上高', fmt(sales(be) / 10000, 0), '万円'],
      ['トン単価', w > 0 ? yen(F / w + vr + lab) : '—', '円/t'],
      ['人工数', nBe !== null ? npt(nBe) : '—', '人工'],
      ['工数', nBe !== null ? fmt(nBe * w * C.HOURS_PER_NINKU, 0) : '—', 'h'],
    ].filter((l) => !(o.hideMoney && (l[0] === '売上高' || l[0] === 'トン単価'))); // hideMoney: 金額の項目は出さない
    st.beLh = 22 * k;
    beLbl = `<line class="beLead"/><rect class="beBg" rx="6"/><g class="beInfo"><text class="lbl be bT" text-anchor="middle">損益分岐値</text>${lines.map(([a, b, c]) =>
      `<text class="lbl be bL">${a}</text><text class="lbl be bN" text-anchor="end">${b}</text><text class="lbl be bU">${c}</text>`).join('')}</g>`; // 文字は最前面に描く
    st.beAt = { bx, by };
  } else st.beAt = null;
  // つまみ位置の内訳バー
  const x = st.x, cx = X(x), bw = 8;
  st.cursorX = cx;
  st.lineY = { sales: (v) => Y(sales(v)), cost: (v) => Y(cost(v)) }; st.toVal = (px) => (px - g.l) / g.w * maxX;
  // 人件費は固定費に含めて1つの帯で表示する
  const segs = [['固定費(人件費込み)', 0, F + lab * x, 'bFixed'], ['変動費', F + lab * x, cost(x), 'bVar']];
  const profit = sales(x) - cost(x);
  if (profit >= 0) segs.push(['利益', cost(x), sales(x), 'bProfit']); else segs.push(['損失', sales(x), cost(x), 'bLoss']);
  h += `<line class="lCursor" x1="${cx}" x2="${cx}" y1="${g.t - 10}" y2="${g.t + g.h}"/>`;
  const labels = [];
  segs.forEach(([name, y0, y1, cls]) => {
    if (y1 - y0 <= 0) return;
    h += `<rect class="${cls}" x="${cx - bw / 2}" width="${bw}" y="${Y(y1)}" height="${Math.max(1, Y(y0) - Y(y1))}"/>`;
    labels.push({ text: o.hideMoney ? name : `${name} ${man(y1 - y0)}`, y: (Y(y0) + Y(y1)) / 2 + 6 * k, cls });
  });
  // ラベルの重なりを避ける(下から順に最低24px×倍率の間隔)
  labels.sort((a, b) => b.y - a.y);
  const gap = 24 * k;
  for (let i = 1; i < labels.length; i++) if (labels[i - 1].y - labels[i].y < gap) labels[i].y = labels[i - 1].y - gap;
  const right = cx < g.l + g.w * 0.62;
  labels.forEach((lb) => { h += `<text class="lbl seg ${lb.cls}" x="${right ? cx + 10 : cx - 10}" y="${lb.y}" text-anchor="${right ? 'start' : 'end'}">${lb.text}</text>`; });
  // つまみ(グラフの上端。左右の端でははみ出さないように寄せる)
  // 2行(ラベル / 重量)・中央揃え
  const hl1 = o.handleLabel || '生産重量', hl2 = `${ton(x)}t`;
  const hw = Math.max(hl1.length * 13, hl2.length * 7.5) + 22;
  const hx = Math.min(W - 4 - hw / 2, Math.max(4 + hw / 2, cx));
  h += `<g class="handle"><rect x="${hx - hw / 2}" y="${g.t - 50}" width="${hw}" height="40" rx="10"/><text x="${hx}" y="${g.t - 34}" text-anchor="middle">${hl1}<tspan x="${hx}" dy="16">${hl2}</tspan></text></g>`;
  // 操作説明「ドラッグで移動可能」: つまみの上に中央揃え。つまみと一緒に動き、点滅は再描画しても途切れないよう位相を合わせる
  if (o.dragHint) {
    const dw = 128, dx = Math.min(W - 4 - dw / 2, Math.max(4 + dw / 2, cx));
    h += `<text class="dragHint" x="${dx}" y="${g.t - 58}" text-anchor="middle" style="animation-delay:-${((performance.now() % 4800) / 1000).toFixed(2)}s">ドラッグで移動可能</text>`;
  }
  h += beLbl;
  // 利益目標達成点(★・目標表示は最前面に描く。試算の破線やバーは裏側を通る)
  if (o.goalTons !== null && o.goalTons !== undefined && o.goalTons <= maxX) {
    const gx = X(o.goalTons), gy = Y(sales(o.goalTons));
    st.goalAt = { gx, gy };
    // ★印(2倍)と「目標生産量/目標利益額」(2倍・黄色背景がゆっくり点滅。背景の大きさは描画後に文字に合わせる)
    const star = Array.from({ length: 10 }, (_, i) => {
      const r = (i % 2 ? 6 : 15) * k, a = -Math.PI / 2 + i * Math.PI / 5;
      return `${(gx + r * Math.cos(a)).toFixed(1)},${(gy + r * Math.sin(a)).toFixed(1)}`;
    }).join(' ');
    const left = gx > g.l + 290 * k, up = gy - 76 * k > g.t;
    const tx = left ? gx - 22 * k : gx + 22 * k, ty = up ? gy - 44 * k : gy + 34 * k;
    h += `<rect class="goalBg" rx="6"/><text class="lbl good goalLbl" x="${tx}" y="${ty}" text-anchor="${left ? 'end' : 'start'}">目標生産量 ${ton(o.goalTons)}t${o.hideMoney ? '' : `<tspan x="${tx}" dy="${28 * k}">目標利益額 ${oku(sales(o.goalTons) * (o.profitRate || 0))}</tspan>`}</text>`;
    h += `<circle class="goalBg" cx="${gx}" cy="${gy}" r="${22.5 * k}"/><polygon class="mGoal" points="${star}"/>`; // ★の背景に1.5倍の〇(黄色・点滅)
  }
  box.innerHTML = `<svg class="bepSvg" style="--k:${k.toFixed(3)}" width="${W}" height="${H}" viewBox="0 0 ${W} ${H}" role="img" aria-label="損益分岐生産量グラフ">${h}</svg>`;
  // 左余白の文字(縦軸の目盛り・固定費ラベル)が左端で切れるときは、左余白を広げて描き直す(1回だけ)
  const leftMin = Math.min(...[...box.querySelectorAll('text.ax, text.fixedLbl')].map((el) => el.getBBox().x));
  if (leftMin < 2 && !st.padRetry && box.clientWidth) { // 非表示のタブ(大きさ0)では測れないので何もしない
    st.padL = g.l + Math.ceil(2 - leftMin) + 4;
    st.padRetry = true;
    renderBepSvg(id);
    st.padRetry = false;
    return;
  }
  // 文字の重なりを避ける(描画後に実際の大きさを測って配置を決める)
  const rectOf = (el) => { const b = el.getBBox(); return { x: b.x, y: b.y, w: b.width, h: b.height }; };
  const overlap = (a, b, m = 3) => a.x - m < b.x + b.w && a.x + a.w + m > b.x && a.y - m < b.y + b.h && a.y + a.h + m > b.y;
  const area = (a, b) => Math.max(0, Math.min(a.x + a.w, b.x + b.w) - Math.max(a.x, b.x)) * Math.max(0, Math.min(a.y + a.h, b.y + b.h) - Math.max(a.y, b.y));
  const gl = box.querySelector('.goalLbl'), gb = box.querySelector('rect.goalBg'), star = box.querySelector('circle.goalBg');
  const segEls = [...box.querySelectorAll('.lbl.seg')];
  // ①内訳の文字(利益など)が★と重なるときはバーの反対側へ移す
  if (star) {
    const sr = rectOf(star);
    segEls.forEach((el) => {
      if (!overlap(rectOf(el), sr)) return;
      const toLeft = el.getAttribute('text-anchor') === 'start', w = rectOf(el).w;
      if (toLeft ? st.cursorX - 10 - w < g.l : st.cursorX + 10 + w > W - 2) { // 反対側だとはみ出すときは★の下へずらす
        el.setAttribute('y', sr.y + sr.h + rectOf(el).h * 0.85);
        return;
      }
      el.setAttribute('text-anchor', toLeft ? 'end' : 'start');
      el.setAttribute('x', st.cursorX + (toLeft ? -10 : 10));
    });
  }
  // ②「売上」「総費用」: 右端を基本に、試算の縦線・内訳・★・もう一方の文字と重なるときは線に沿って左へずらす
  //   (上側の線は線の上、下側の線は線の下に置く)
  const curR = { x: st.cursorX - 8, y: g.t, w: 16, h: g.h };
  const lineObst = segEls.map(rectOf).concat([curR]);
  if (star) lineObst.push(rectOf(star));
  box.querySelectorAll('.lbl.lineLbl').forEach((el) => {
    const other = el.dataset.line === 'sales' ? 'cost' : 'sales';
    let best = null;
    [1, 0.9, 0.8, 0.7, 0.6, 0.5, 0.4, 0.3].forEach((f) => {
      if (best && best.score === 0) return;
      const xr = f === 1 ? g.l + g.w - 4 : g.l + g.w * f;
      el.setAttribute('x', xr);
      const w = rectOf(el).w, v = st.toVal(xr - w / 2);
      const above = st.lineY[el.dataset.line](v) <= st.lineY[other](v);
      el.setAttribute('y', st.lineY[el.dataset.line](v) + (above ? -8 * k : 26 * k));
      const r = rectOf(el);
      const score = lineObst.reduce((a2, o) => a2 + area(r, o), 0) + (r.y < g.t ? 1e6 : 0);
      if (!best || score < best.score) best = { score, x: el.getAttribute('x'), y: el.getAttribute('y') };
    });
    el.setAttribute('x', best.x); el.setAttribute('y', best.y);
    lineObst.push(rectOf(el));
  });
  // ③「目標生産量/目標利益額」は★の左上・右上・左下・右下のうち、ほかの文字と重ならずグラフ内に収まる位置へ
  if (gl && gb && st.goalAt) {
    const obst = segEls.concat([...box.querySelectorAll('.lbl.lineLbl')]).map(rectOf);
    if (star) obst.push(rectOf(star));
    const { gx, gy } = st.goalAt, dx = 22 * k, tsp = gl.querySelector('tspan');
    const cands = [['end', -dx, -44 * k], ['start', dx, -44 * k], ['end', -dx, 34 * k], ['start', dx, 34 * k]];
    let best = null;
    cands.forEach(([anc, ox, oy]) => {
      gl.setAttribute('text-anchor', anc); gl.setAttribute('x', gx + ox); gl.setAttribute('y', gy + oy); if (tsp) tsp.setAttribute('x', gx + ox);
      const r = rectOf(gl);
      const out = Math.max(0, g.l - r.x) + Math.max(0, r.x + r.w - (W - 2)) + Math.max(0, g.t - r.y) + Math.max(0, r.y + r.h - (g.t + g.h));
      const score = out * 1000 + obst.reduce((a, o) => a + area(r, o), 0);
      if (!best || score < best.score) best = { score, anc, ox, oy };
    });
    gl.setAttribute('text-anchor', best.anc); gl.setAttribute('x', gx + best.ox); gl.setAttribute('y', gy + best.oy); if (tsp) tsp.setAttribute('x', gx + best.ox);
    const bb = gl.getBBox();
    gb.setAttribute('x', bb.x - 6); gb.setAttribute('y', bb.y - 3);
    gb.setAttribute('width', bb.width + 12); gb.setAttribute('height', bb.height + 6);
  }
  // ④ 内訳の文字(利益など)がまだ★・目標表示・つまみ・ほかの内訳と重なるときは、縦線の左右 × (元の高さ・★の下・★の上)から
  //   重なりが最も少なくグラフ内に収まる位置へ移す(★が縦線のすぐ近くにあるとき用)
  if (star) {
    const fixedObst = [star, gb, box.querySelector('.handle rect')].filter(Boolean).map(rectOf);
    const sr = rectOf(star);
    segEls.forEach((el) => {
      const others = segEls.filter((e) => e !== el).map(rectOf);
      const obst = fixedObst.concat(others);
      const hit = (r) => obst.reduce((a2, o) => a2 + area(r, o), 0);
      if (hit(rectOf(el)) === 0) return;
      const y0 = Number(el.getAttribute('y')), hgt = rectOf(el).h;
      let best = null;
      [['start', 10], ['end', -10]].forEach(([anc, ox]) => [y0, sr.y + sr.h + hgt * 0.85, sr.y - 4].forEach((y) => {
        el.setAttribute('text-anchor', anc); el.setAttribute('x', st.cursorX + ox); el.setAttribute('y', y);
        const r = rectOf(el);
        const out = Math.max(0, g.l - r.x) + Math.max(0, r.x + r.w - (W - 2)) + Math.max(0, g.t - r.y) + Math.max(0, r.y + r.h - (g.t + g.h));
        const score = out * 1000 + hit(r) + Math.abs(y - y0) * 0.01; // 同じくらいなら元の高さに近い方
        if (!best || score < best.score) best = { score, anc, x: st.cursorX + ox, y };
      }));
      el.setAttribute('text-anchor', best.anc); el.setAttribute('x', best.x); el.setAttribute('y', best.y);
    });
  }
  // 損益分岐値: グラフの左上に置き、点から引き出し線を引く
  const bi = box.querySelector('.beInfo');
  if (bi && st.beAt) {
    // 列幅(項目・数値・単位)を測り、3列に並べる
    const col = (sel) => [...bi.querySelectorAll(sel)];
    const wmax = (els) => Math.max(0, ...els.map((e) => e.getBBox().width));
    const Ls = col('.bL'), Ns = col('.bN'), Us = col('.bU');
    const lw = wmax(Ls), nw = wmax(Ns), uw = wmax(Us), lh = st.beLh, asc = lh * 0.78;
    const T = bi.querySelector('.bT'), tw = T.getBBox().width; // 見出し「損益分岐値」(1行目・中央揃え)
    const cw = lw + 10 + nw + 3 + uw, bw = Math.max(cw, tw);
    const bb = { width: bw, height: lh * (Ls.length + 1) }, pad = 6;
    // 候補: ①グラフの左上(既定) ②点の左上 ③左端に寄せる。目標表示(黄色)と重ならない最初の候補を使う
    const gr = gb && gb.getAttribute('width') ? { x: +gb.getAttribute('x'), y: +gb.getAttribute('y'), w: +gb.getAttribute('width'), h: +gb.getAttribute('height') } : null;
    const hit = (l, t) => gr && l - pad < gr.x + gr.w && l + bb.width + pad > gr.x && t - pad < gr.y + gr.h && t + bb.height + pad > gr.y;
    const cands = [[g.l + pad + 2, g.t + pad], [st.beAt.bx - 40 - bb.width, st.beAt.by - 40 - bb.height], [g.l + pad + 2, st.beAt.by - 40 - bb.height]]
      .map(([l, t]) => [Math.max(g.l + pad + 2, l), Math.max(g.t + pad, t)]);
    let pick = cands.find(([l, t]) => !hit(l, t));
    if (!pick && gl && st.goalAt) {
      // どこに置いても目標表示と重なるときは、目標表示を★の下へ移してから置き直す
      const ny = st.goalAt.gy + 40 * k;
      gl.setAttribute('y', ny);
      const b2 = gl.getBBox();
      gb.setAttribute('x', b2.x - 6); gb.setAttribute('y', b2.y - 3);
      gr.x = b2.x - 6; gr.y = b2.y - 3; gr.w = b2.width + 12; gr.h = b2.height + 6;
      pick = cands.find(([l, t]) => !hit(l, t));
    }
    const [left, top] = pick || cands[cands.length - 1];
    T.setAttribute('x', left + bw / 2); T.setAttribute('y', top + asc);
    Ls.forEach((e, i) => {
      const y = top + asc + (i + 1) * lh;
      e.setAttribute('x', left); e.setAttribute('y', y);
      Ns[i].setAttribute('x', left + lw + 10 + nw); Ns[i].setAttribute('y', y);
      Us[i].setAttribute('x', left + lw + 10 + nw + 3); Us[i].setAttribute('y', y);
    });
    const rb = box.querySelector('.beBg');
    rb.setAttribute('x', left - pad); rb.setAttribute('y', top - pad / 2);
    rb.setAttribute('width', bb.width + pad * 2); rb.setAttribute('height', bb.height + pad);
    const ln = box.querySelector('.beLead');
    ln.setAttribute('x1', st.beAt.bx); ln.setAttribute('y1', st.beAt.by);
    ln.setAttribute('x2', left + bb.width + pad); ln.setAttribute('y2', top + bb.height + pad / 2);
  }
}
