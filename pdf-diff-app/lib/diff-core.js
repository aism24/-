// PDF差分解析コアロジック
// ページ整合(挿入/削除ページの自動検出)・ページ種別自動分類・
// 表/画像(図面)/文章の3方式それぞれの差分検出を行う。
// 元になったPythonツール(pdf_table_diff.py / pdf_image_diff.py / pdf_text_diff.py)の
// アルゴリズムをブラウザ内で完結するJavaScript(pdf.js + jsdiff)に移植したもの。
(function (global) {
  'use strict';

  const ROW_Y_TOLERANCE = 3;
  const RENDER_SCALE = 2.0;
  const THUMB_SIZE = 48;

  const COLOR_OLD = { fill: 'rgba(230,30,30,0.35)', stroke: '#e61e1e' };
  const COLOR_NEW = { fill: 'rgba(30,150,60,0.35)', stroke: '#1e9633' };

  const range = (n) => Array.from({ length: n }, (_, i) => i);

  // ---------- ページ描画 ----------

  function renderToCanvas(page, viewport) {
    const canvas = document.createElement('canvas');
    canvas.width = Math.ceil(viewport.width);
    canvas.height = Math.ceil(viewport.height);
    const ctx = canvas.getContext('2d');
    const task = page.render({ canvasContext: ctx, viewport });
    return { canvas, promise: task.promise };
  }

  function downsampleCanvas(srcCanvas, size) {
    const scale = size / Math.max(srcCanvas.width, srcCanvas.height);
    const w = Math.max(1, Math.round(srcCanvas.width * scale));
    const h = Math.max(1, Math.round(srcCanvas.height * scale));
    const c = document.createElement('canvas');
    c.width = w; c.height = h;
    const ctx = c.getContext('2d');
    ctx.drawImage(srcCanvas, 0, 0, w, h);
    const data = ctx.getImageData(0, 0, w, h).data;
    const gray = new Float32Array(w * h);
    for (let i = 0; i < w * h; i++) {
      const o = i * 4;
      gray[i] = data[o] * 0.299 + data[o + 1] * 0.587 + data[o + 2] * 0.114;
    }
    return { w, h, gray };
  }

  // ---------- テキスト抽出(座標付き単語) ----------
  //
  // item.width(pdf.jsのテキスト項目の幅)は、PDF生成元によってCIDフォントの
  // 幅指標が想定と異なる単位で入っており、日本語の複数文字を含む項目で
  // 実測値と大きくズレる(桁違いに広い/狭い)ケースが確認された。
  // そのため幅はitem.widthに頼らず、「全角文字はほぼ正方形(幅≒フォント高さ)、
  // 半角文字はその半分」という一般的な組版の目安から近似する
  // (ハイライト用の位置決めが目的で、pdf.jsの生テキストレイヤーのような
  // ピクセル完全一致は必要ないため、この近似で十分)。

  function charWeight(ch) {
    const code = ch.codePointAt(0);
    // ASCII/Latin-1に加え、半角カタカナ(U+FF61-FF9F)・半角句読点等の
    // 半角形(U+FF61-FFDC)も見た目は半角幅なので、0xff以下だけを見る判定では
    // 半角カタカナ(フリガナ等で多用)が全角扱いになり幅を約2倍に見積もって
    // しまっていた(実測より大きく右にズレる)。これが原因で、フリガナ欄の
    // 推定終端位置が隣接する別欄の文字と前後してしまい、行内の単語の並び順が
    // 新旧PDFでズレる(=文字単位diffの対応がおかしくなる)ケースがあった。
    const isHalfWidth = code <= 0xff || (code >= 0xff61 && code <= 0xffdc);
    return isHalfWidth ? 0.55 : 1.0;
  }

  async function extractWords(page, viewport) {
    const content = await page.getTextContent();
    const words = [];
    for (const item of content.items) {
      if (!item.str || !item.str.trim()) continue;
      const tx = pdfjsLib.Util.transform(viewport.transform, item.transform);
      const fontHeight = Math.hypot(tx[2], tx[3]) || 10 * (viewport.scale || 1);
      const x0 = tx[4];
      const y1 = tx[5];
      const y0 = y1 - fontHeight;
      const chars = Array.from(item.str);
      const totalWeight = chars.reduce((s, ch) => s + charWeight(ch), 0) || 1;
      const totalWidth = totalWeight * fontHeight;
      splitItemIntoWords(item.str, x0, y0, x0 + totalWidth, y1).forEach((w) => words.push(w));
    }
    return words;
  }

  function splitItemIntoWords(text, x0, y0, x1, y1) {
    const out = [];
    const chars = Array.from(text);
    if (chars.length === 0) return out;
    const weights = chars.map(charWeight);
    const totalWeight = weights.reduce((a, b) => a + b, 0) || 1;
    const width = x1 - x0;
    const parts = text.split(/(\s+)/);
    let offset = 0;
    for (const part of parts) {
      const partWeight = Array.from(part).reduce((a, ch) => a + charWeight(ch), 0);
      if (part.trim().length > 0) {
        const wx0 = x0 + (offset / totalWeight) * width;
        const wx1 = x0 + ((offset + partWeight) / totalWeight) * width;
        out.push({ x0: wx0, y0, x1: wx1, y1, text: part });
      }
      offset += partWeight;
    }
    return out;
  }

  function clusterRows(words, tol = ROW_Y_TOLERANCE) {
    const sorted = [...words].sort((a, b) => a.y0 - b.y0 || a.x0 - b.x0);
    const rows = [];
    let cur = [];
    let curY = null;
    for (const w of sorted) {
      if (curY === null || Math.abs(w.y0 - curY) <= tol) {
        cur.push(w);
        curY = curY === null ? w.y0 : curY;
      } else {
        rows.push(cur);
        cur = [w];
        curY = w.y0;
      }
    }
    if (cur.length) rows.push(cur);
    rows.forEach((r) => r.sort((a, b) => a.x0 - b.x0));
    return rows;
  }

  // ---------- ページ種別の自動分類 ----------
  // 判定順: テキスト無し→図面 / 行の語数が揃う(グリッド)→表 /
  // 段落状に幅広く流れる行が多い→文章 / それ以外(ラベル・値が散らばる帳票)→図面(画像方式)

  function classifyPage(words, rows) {
    if (words.length === 0 || rows.length < 2) return 'image';

    const counts = rows.map((r) => r.length);
    const freq = {};
    counts.forEach((c) => { freq[c] = (freq[c] || 0) + 1; });
    const modeCount = Object.keys(freq).reduce((a, b) => (freq[a] >= freq[b] ? a : b));
    const modeRatio = freq[modeCount] / rows.length;
    if (rows.length >= 3 && Number(modeCount) >= 2 && modeRatio >= 0.5) return 'table';

    // 文章判定: 見出し・箇条書き番号などが混じると行の左端は揃わないため、
    // 行揃えではなく「ある程度長い(=文章が流れている)行がどれだけあるか」
    // で判定する(契約書・規程類はほぼ全行が長文、帳票は短い行の寄せ集め)。
    const rowCharCounts = rows.map((r) => r.reduce((s, w) => s + w.text.length, 0));
    const longRowRatio = rowCharCounts.filter((c) => c >= 15).length / rows.length;
    const totalChars = rowCharCounts.reduce((a, b) => a + b, 0);

    if (rows.length >= 3 && (longRowRatio >= 0.4 || totalChars >= 80)) {
      return 'text';
    }
    return 'image';
  }

  // ---------- LCSベースの整列(difflib.SequenceMatcher相当、jsdiffで実装) ----------
  // removed直後にaddedが続くブロックは、重なる件数だけ1:1ペアとして扱い、
  // 余りをdelete/insertとする(行挿入・ページ挿入どちらにも使う共通ロジック)。

  function pairChanges(changes) {
    const result = [];
    let oi = 0, ni = 0;
    for (let idx = 0; idx < changes.length; idx++) {
      const part = changes[idx];
      if (!part.added && !part.removed) {
        part.value.forEach(() => { result.push({ type: 'equal', oldIdx: oi, newIdx: ni }); oi++; ni++; });
      } else if (part.removed) {
        const next = changes[idx + 1];
        if (next && next.added) {
          const n = Math.min(part.value.length, next.value.length);
          for (let k = 0; k < n; k++) result.push({ type: 'pair', oldIdx: oi + k, newIdx: ni + k });
          for (let k = n; k < part.value.length; k++) result.push({ type: 'delete', oldIdx: oi + k, newIdx: null });
          for (let k = n; k < next.value.length; k++) result.push({ type: 'insert', oldIdx: null, newIdx: ni + k });
          oi += part.value.length;
          ni += next.value.length;
          idx++; // addedパートは消費済み
        } else {
          part.value.forEach(() => { result.push({ type: 'delete', oldIdx: oi, newIdx: null }); oi++; });
        }
      } else if (part.added) {
        part.value.forEach(() => { result.push({ type: 'insert', oldIdx: null, newIdx: ni }); ni++; });
      }
    }
    return result;
  }

  function textSimilarity(a, b) {
    if (!a && !b) return 1;
    if (!a || !b) return 0;
    const changes = Diff.diffChars(a, b);
    let common = 0;
    changes.forEach((c) => { if (!c.added && !c.removed) common += c.value.length; });
    return (2 * common) / (a.length + b.length);
  }

  function thumbSimilarity(t1, t2) {
    if (!t1 || !t2 || t1.w !== t2.w || t1.h !== t2.h) return 0;
    let diffSum = 0;
    for (let i = 0; i < t1.gray.length; i++) diffSum += Math.abs(t1.gray[i] - t2.gray[i]);
    const meanDiff = diffSum / t1.gray.length;
    return Math.max(0, 1 - meanDiff / 255);
  }

  function pageSimilarity(a, b) {
    if (a.text.length >= 20 || b.text.length >= 20) return textSimilarity(a.text, b.text);
    return thumbSimilarity(a.thumb, b.thumb);
  }

  // ページ単位の整列は、行や文字の整列と違って「完全一致」を前提にできない
  // (同じページでも1箇所値が変わっただけで別物になる)。かといって単純な
  // 類似度しきい値によるLCS(jsdiffのcomparator)では、同一書式のページ同士が
  // 見出しや列名などの共通部分のせいで「別ページなのに類似度が閾値を超えて
  // しまう」誤対応が起きる(実測済み)。そこで類似度を得点とした
  // Needleman-Wunsch型の大域アライメントDPを使い、ページ列全体で
  // 合計類似度が最大になる対応関係を求める。これなら「新2ページ目に
  // 無関係な1ページが挿入された」ようなケースでも、挿入ページの前後の
  // 本来の対応関係(旧1↔新1、旧2↔新3、旧3↔新4 等)を正しく保てる。
  const GAP_PENALTY = 0.35;

  function alignPages(oldSigs, newSigs) {
    const n = oldSigs.length, m = newSigs.length;
    const simCache = [];
    for (let i = 0; i < n; i++) {
      simCache.push([]);
      for (let j = 0; j < m; j++) simCache[i][j] = pageSimilarity(oldSigs[i], newSigs[j]);
    }

    const dp = Array.from({ length: n + 1 }, () => new Float64Array(m + 1));
    const bt = Array.from({ length: n + 1 }, () => new Int8Array(m + 1)); // 0=match 1=delete 2=insert
    for (let i = 1; i <= n; i++) { dp[i][0] = dp[i - 1][0] - GAP_PENALTY; bt[i][0] = 1; }
    for (let j = 1; j <= m; j++) { dp[0][j] = dp[0][j - 1] - GAP_PENALTY; bt[0][j] = 2; }

    for (let i = 1; i <= n; i++) {
      for (let j = 1; j <= m; j++) {
        const matchScore = dp[i - 1][j - 1] + (simCache[i - 1][j - 1] - GAP_PENALTY);
        const delScore = dp[i - 1][j] - GAP_PENALTY;
        const insScore = dp[i][j - 1] - GAP_PENALTY;
        let best = matchScore, dir = 0;
        if (delScore > best) { best = delScore; dir = 1; }
        if (insScore > best) { best = insScore; dir = 2; }
        dp[i][j] = best;
        bt[i][j] = dir;
      }
    }

    const pairs = [];
    let i = n, j = m;
    while (i > 0 || j > 0) {
      const dir = i > 0 && j > 0 ? bt[i][j] : (i > 0 ? 1 : 2);
      if (dir === 0) {
        pairs.push({ type: 'pair', oldIdx: i - 1, newIdx: j - 1 });
        i--; j--;
      } else if (dir === 1) {
        pairs.push({ type: 'delete', oldIdx: i - 1, newIdx: null });
        i--;
      } else {
        pairs.push({ type: 'insert', oldIdx: null, newIdx: j - 1 });
        j--;
      }
    }
    pairs.reverse();
    return pairs;
  }

  // ---------- 表方式 ----------

  function boxOf(w) { return { x0: w.x0, y0: w.y0, x1: w.x1, y1: w.y1 }; }

  function diffTable(oldRows, newRows) {
    const oldSig = oldRows.map((r) => r.map((w) => w.text).join(' '));
    const newSig = newRows.map((r) => r.map((w) => w.text).join(' '));
    const changes = Diff.diffArrays(oldSig, newSig);
    const pairs = pairChanges(changes);
    const oldBoxes = [], newBoxes = [];
    for (const p of pairs) {
      if (p.type === 'equal') continue;
      if (p.type === 'pair') {
        const orow = oldRows[p.oldIdx], nrow = newRows[p.newIdx];
        const otok = orow.map((w) => w.text), ntok = nrow.map((w) => w.text);
        const tchanges = Diff.diffArrays(otok, ntok);
        const tpairs = pairChanges(tchanges);
        for (const tp of tpairs) {
          if (tp.type === 'equal') continue;
          if (tp.oldIdx != null) oldBoxes.push(boxOf(orow[tp.oldIdx]));
          if (tp.newIdx != null) newBoxes.push(boxOf(nrow[tp.newIdx]));
        }
      } else if (p.type === 'delete') {
        oldRows[p.oldIdx].forEach((w) => oldBoxes.push(boxOf(w)));
      } else if (p.type === 'insert') {
        newRows[p.newIdx].forEach((w) => newBoxes.push(boxOf(w)));
      }
    }
    return { oldBoxes, newBoxes };
  }

  // ---------- 文章方式(1文字単位) ----------

  // 単語(セル)の境目に挟む不可視の区切り文字。新旧どちらの行にも同じ位置に
  // 入るため、Diff.diffCharsは必ずこれを「一致」とみなし、変更範囲が
  // 隣接する無関係な単語(例: フリガナ欄と契約金額欄が同じ行にある場合)まで
  // 誤って巻き込むのを防ぐ。表示上は使われないので画面には影響しない。
  const WORD_SEP = '\u0000';

  function buildCharStream(row) {
    // 1行分の単語を対象に、区切り文字を挟みながら読み順に連結する。
    // 行をまたぐ連結は行わない(diffTextが行単位で対応付けてから
    // この関数を呼ぶため。行の折り返し位置は新旧でズレうるが、
    // それは行単位アライメント側で吸収する)。
    let text = '';
    const map = [];
    row.forEach((w, idx) => {
      if (idx > 0) {
        text += WORD_SEP;
        map.push(null);
      }
      const chars = Array.from(w.text);
      const weights = chars.map(charWeight);
      const totalWeight = weights.reduce((a, b) => a + b, 0) || 1;
      const width = w.x1 - w.x0;
      let offset = 0;
      chars.forEach((ch, i) => {
        text += ch;
        map.push({
          x0: w.x0 + (offset / totalWeight) * width,
          x1: w.x0 + ((offset + weights[i]) / totalWeight) * width,
          y0: w.y0, y1: w.y1,
        });
        offset += weights[i];
      });
    });
    return { text, map };
  }

  function mergeConsecutiveBoxes(boxes, tol = 4) {
    if (!boxes.length) return [];
    const sorted = [...boxes].sort((a, b) => a.y0 - b.y0 || a.x0 - b.x0);
    const merged = [{ ...sorted[0] }];
    for (let i = 1; i < sorted.length; i++) {
      const last = merged[merged.length - 1];
      const cur = sorted[i];
      if (Math.abs(cur.y0 - last.y0) <= tol && cur.x0 - last.x1 <= tol * 4) {
        last.x1 = Math.max(last.x1, cur.x1);
        last.y1 = Math.max(last.y1, cur.y1);
        last.y0 = Math.min(last.y0, cur.y0);
      } else {
        merged.push({ ...cur });
      }
    }
    return merged;
  }

  // 「表」方式(diffTable)と同じく、まず行単位でDiff.diffArraysによる対応付け
  // (Needleman-Wunsch型ではなくLCSだが、行が完全に一致するかどうかで判定する
  // 点は同じ)を行い、対応の取れた行同士だけをさらに文字単位で比較する。
  // ページ全体を1本の文字列にして文字単位diffにかけていた以前の実装では、
  // 「台」のような短い繰り返し文字が原因で、新規追加された行の文字が
  // ページ内の離れた場所にある同じ文字と誤って対応付けられ、追加として
  // 検出されないことがあった。行単位で先に対応を確定させることでこれを防ぐ。
  function diffText(oldRows, newRows) {
    const oldStreams = oldRows.map(buildCharStream);
    const newStreams = newRows.map(buildCharStream);
    const rowChanges = Diff.diffArrays(oldStreams.map((s) => s.text), newStreams.map((s) => s.text));
    const rowPairs = pairChanges(rowChanges);
    const oldBoxes = [], newBoxes = [];

    const pushAll = (map, boxes) => map.forEach((b) => { if (b) boxes.push(b); });

    rowPairs.forEach((rp) => {
      if (rp.type === 'equal') return;
      if (rp.type === 'delete') {
        pushAll(oldStreams[rp.oldIdx].map, oldBoxes);
        return;
      }
      if (rp.type === 'insert') {
        pushAll(newStreams[rp.newIdx].map, newBoxes);
        return;
      }
      // 'pair': 対応は取れたが内容が異なる行同士を、さらに文字単位で比較する
      const oldStream = oldStreams[rp.oldIdx];
      const newStream = newStreams[rp.newIdx];
      const changes = Diff.diffChars(oldStream.text, newStream.text);
      let oi = 0, ni = 0;
      changes.forEach((part) => {
        const len = part.value.length;
        if (!part.added && !part.removed) { oi += len; ni += len; return; }
        if (part.removed) {
          for (let k = 0; k < len; k++) { const b = oldStream.map[oi + k]; if (b) oldBoxes.push(b); }
          oi += len;
        }
        if (part.added) {
          for (let k = 0; k < len; k++) { const b = newStream.map[ni + k]; if (b) newBoxes.push(b); }
          ni += len;
        }
      });
    });

    return { oldBoxes: mergeConsecutiveBoxes(oldBoxes), newBoxes: mergeConsecutiveBoxes(newBoxes) };
  }

  // ---------- 画像(図面)方式 ----------

  function grayscale(imgData) {
    const { data, width, height } = imgData;
    const gray = new Float32Array(width * height);
    for (let i = 0; i < width * height; i++) {
      const o = i * 4;
      gray[i] = data[o] * 0.299 + data[o + 1] * 0.587 + data[o + 2] * 0.114;
    }
    return gray;
  }

  function dilateMask(mask, w, h, iterations) {
    let cur = mask;
    for (let it = 0; it < iterations; it++) {
      const next = new Uint8Array(w * h);
      for (let y = 0; y < h; y++) {
        for (let x = 0; x < w; x++) {
          const idx = y * w + x;
          if (cur[idx]) { next[idx] = 1; continue; }
          let hit = 0;
          for (let dy = -1; dy <= 1 && !hit; dy++) {
            for (let dx = -1; dx <= 1; dx++) {
              const nx = x + dx, ny = y + dy;
              if (nx < 0 || ny < 0 || nx >= w || ny >= h) continue;
              if (cur[ny * w + nx]) { hit = 1; break; }
            }
          }
          next[idx] = hit;
        }
      }
      cur = next;
    }
    return cur;
  }

  function labelBoxes(mask, w, h, minPixels) {
    const visited = new Uint8Array(w * h);
    const boxes = [];
    const stack = new Int32Array(w * h);
    for (let start = 0; start < w * h; start++) {
      if (!mask[start] || visited[start]) continue;
      let sp = 0;
      stack[sp++] = start;
      visited[start] = 1;
      let x0 = w, y0 = h, x1 = 0, y1 = 0, count = 0;
      while (sp > 0) {
        const cur = stack[--sp];
        const cy = (cur / w) | 0, cx = cur - cy * w;
        count++;
        if (cx < x0) x0 = cx; if (cx > x1) x1 = cx;
        if (cy < y0) y0 = cy; if (cy > y1) y1 = cy;
        for (let dy = -1; dy <= 1; dy++) {
          for (let dx = -1; dx <= 1; dx++) {
            if (!dx && !dy) continue;
            const nx = cx + dx, ny = cy + dy;
            if (nx < 0 || ny < 0 || nx >= w || ny >= h) continue;
            const nidx = ny * w + nx;
            if (mask[nidx] && !visited[nidx]) { visited[nidx] = 1; stack[sp++] = nidx; }
          }
        }
      }
      if (count >= minPixels) boxes.push({ x0, y0, x1: x1 + 1, y1: y1 + 1 });
    }
    return boxes;
  }

  function fitCanvas(srcCanvas, targetW, targetH) {
    if (srcCanvas.width === targetW && srcCanvas.height === targetH) return srcCanvas;
    const c = document.createElement('canvas');
    c.width = targetW; c.height = targetH;
    const ctx = c.getContext('2d');
    ctx.fillStyle = '#fff';
    ctx.fillRect(0, 0, targetW, targetH);
    const scale = Math.min(targetW / srcCanvas.width, targetH / srcCanvas.height);
    const w = srcCanvas.width * scale, h = srcCanvas.height * scale;
    ctx.drawImage(srcCanvas, (targetW - w) / 2, (targetH - h) / 2, w, h);
    return c;
  }

  function diffImagePixels(canvasOld, canvasNew) {
    const w = canvasOld.width, h = canvasOld.height;
    const fittedNew = fitCanvas(canvasNew, w, h);
    const dOld = canvasOld.getContext('2d').getImageData(0, 0, w, h);
    const dNew = fittedNew.getContext('2d').getImageData(0, 0, w, h);
    const gOld = grayscale(dOld), gNew = grayscale(dNew);
    const THRESHOLD = 40;
    let mask = new Uint8Array(w * h);
    for (let i = 0; i < w * h; i++) mask[i] = Math.abs(gOld[i] - gNew[i]) > THRESHOLD ? 1 : 0;
    mask = dilateMask(mask, w, h, 4);
    const boxes = labelBoxes(mask, w, h, 60);
    return { boxes };
  }

  // ---------- ハイライト描画 ----------

  // 表/図面/文章のいずれの方式でも、枠線は文字や図形に重なって見づらくなるため
  // 使わず、半透明の塗りつぶしのみでハイライトする。
  function withHighlights(srcCanvas, boxes, color, scale = 1) {
    const c = document.createElement('canvas');
    c.width = srcCanvas.width; c.height = srcCanvas.height;
    const ctx = c.getContext('2d');
    ctx.drawImage(srcCanvas, 0, 0);
    const pad = 2;
    ctx.fillStyle = color.fill;
    boxes.forEach((b) => {
      const x0 = b.x0 * scale - pad, y0 = b.y0 * scale - pad;
      const x1 = b.x1 * scale + pad, y1 = b.y1 * scale + pad;
      ctx.fillRect(x0, y0, x1 - x0, y1 - y0);
    });
    return c;
  }

  function composeSideBySide(canvasOld, canvasNew, labelOld, labelNew) {
    const gap = 20, headerH = 56;
    const w = canvasOld.width + canvasNew.width + gap;
    const h = headerH + Math.max(canvasOld.height, canvasNew.height);
    const out = document.createElement('canvas');
    out.width = w; out.height = h;
    const ctx = out.getContext('2d');
    ctx.fillStyle = '#ffffff'; ctx.fillRect(0, 0, w, h);
    ctx.fillStyle = '#fdecea'; ctx.fillRect(0, 0, canvasOld.width, headerH);
    ctx.fillStyle = '#e9f7ef'; ctx.fillRect(canvasOld.width + gap, 0, canvasNew.width, headerH);
    ctx.fillStyle = '#333'; ctx.font = 'bold 22px sans-serif';
    ctx.fillText(labelOld, 16, 36);
    ctx.fillText(labelNew, canvasOld.width + gap + 16, 36);
    ctx.drawImage(canvasOld, 0, headerH);
    ctx.drawImage(canvasNew, canvasOld.width + gap, headerH);
    ctx.strokeStyle = '#999'; ctx.lineWidth = 2;
    ctx.beginPath();
    ctx.moveTo(canvasOld.width + gap / 2, 0);
    ctx.lineTo(canvasOld.width + gap / 2, h);
    ctx.stroke();
    return out;
  }

  function composePlaceholder(canvasOld, canvasNew, labelOld, labelNew, message) {
    const w1 = canvasOld ? canvasOld.width : 500, h1 = canvasOld ? canvasOld.height : 700;
    const w2 = canvasNew ? canvasNew.width : 500, h2 = canvasNew ? canvasNew.height : 700;
    const gap = 20, headerH = 56;
    const w = w1 + w2 + gap, h = headerH + Math.max(h1, h2);
    const out = document.createElement('canvas');
    out.width = w; out.height = h;
    const ctx = out.getContext('2d');
    ctx.fillStyle = '#ffffff'; ctx.fillRect(0, 0, w, h);
    ctx.fillStyle = '#fdecea'; ctx.fillRect(0, 0, w1, headerH);
    ctx.fillStyle = '#e9f7ef'; ctx.fillRect(w1 + gap, 0, w2, headerH);
    ctx.fillStyle = '#333'; ctx.font = 'bold 22px sans-serif';
    ctx.fillText(labelOld, 16, 36);
    ctx.fillText(labelNew, w1 + gap + 16, 36);
    const drawSide = (canvas, x, w0, h0, color) => {
      if (canvas) { ctx.drawImage(canvas, x, headerH); return; }
      ctx.fillStyle = '#f5f5f5'; ctx.fillRect(x, headerH, w0, h0);
      ctx.strokeStyle = color; ctx.lineWidth = 6; ctx.strokeRect(x + 3, headerH + 3, w0 - 6, h0 - 6);
      ctx.fillStyle = color; ctx.font = 'bold 24px sans-serif';
      ctx.fillText(message, x + 24, headerH + h0 / 2);
    };
    drawSide(canvasOld, 0, w1, h1, '#e61e1e');
    drawSide(canvasNew, w1 + gap, w2, h2, '#1e9633');
    return out;
  }

  // ---------- 全体処理 ----------

  const CATEGORY_LABEL = { table: '表', text: '文章', image: '図面' };

  function pickOverallCategory(votes) {
    let best = null, bestN = -1;
    for (const k of Object.keys(votes)) { if (votes[k] > bestN) { best = k; bestN = votes[k]; } }
    return best ? CATEGORY_LABEL[best] : '不明';
  }

  async function preparePage(doc, num, scale, onLog) {
    const page = await doc.getPage(num);
    const viewport = page.getViewport({ scale });
    const { canvas, promise } = renderToCanvas(page, viewport);
    await promise;
    const words = await extractWords(page, viewport);
    const rows = clusterRows(words);
    const category = classifyPage(words, rows);
    const text = words.map((w) => w.text).join('');
    const thumb = text.length < 20 ? downsampleCanvas(canvas, THUMB_SIZE) : null;
    if (onLog) onLog(`ページ${num}: ${CATEGORY_LABEL[category] || category}と判定`);
    return { canvas, words, rows, category, sig: { text, thumb } };
  }

  async function runDiff(oldArrayBuffer, newArrayBuffer, opts = {}) {
    const scale = opts.scale || RENDER_SCALE;
    const onLog = opts.onLog || (() => {});

    onLog('PDFを読み込み中...');
    const oldDoc = await pdfjsLib.getDocument({ data: oldArrayBuffer }).promise;
    const newDoc = await pdfjsLib.getDocument({ data: newArrayBuffer }).promise;

    onLog(`旧: 全${oldDoc.numPages}ページ / 新: 全${newDoc.numPages}ページ`);

    const oldPages = [];
    for (const i of range(oldDoc.numPages)) oldPages.push(await preparePage(oldDoc, i + 1, scale, onLog));
    const newPages = [];
    for (const i of range(newDoc.numPages)) newPages.push(await preparePage(newDoc, i + 1, scale, onLog));

    onLog('新旧ページの対応関係を解析中...');
    const pairs = alignPages(oldPages.map((p) => p.sig), newPages.map((p) => p.sig));

    const results = [];
    const votes = {};
    let pageOut = 0;

    for (const p of pairs) {
      pageOut++;
      if (p.type === 'equal' || p.type === 'pair') {
        const op = oldPages[p.oldIdx], np = newPages[p.newIdx];
        const category = op.category;
        votes[category] = (votes[category] || 0) + 1;
        onLog(`p${pageOut}: 旧${p.oldIdx + 1} ⇔ 新${p.newIdx + 1}(${CATEGORY_LABEL[category]})を比較中...`);

        let oldBoxes = [], newBoxes = [];
        if (category === 'table') {
          const r = diffTable(op.rows, np.rows);
          oldBoxes = r.oldBoxes; newBoxes = r.newBoxes;
        } else if (category === 'text') {
          const r = diffText(op.rows, np.rows);
          oldBoxes = r.oldBoxes; newBoxes = r.newBoxes;
        } else {
          const r = diffImagePixels(op.canvas, np.canvas);
          oldBoxes = r.boxes; newBoxes = r.boxes;
        }
        const labelOld = `旧 p.${p.oldIdx + 1}`, labelNew = `新 p.${p.newIdx + 1}`;
        const cOld = withHighlights(op.canvas, oldBoxes, COLOR_OLD);
        const cNew = withHighlights(np.canvas, newBoxes, COLOR_NEW);
        const composed = composeSideBySide(cOld, cNew, labelOld, labelNew);
        results.push({
          composed, category, labelOld, labelNew,
          oldCanvas: cOld, newCanvas: cNew,
          changed: oldBoxes.length + newBoxes.length > 0,
        });
      } else if (p.type === 'delete') {
        const op = oldPages[p.oldIdx];
        onLog(`p${pageOut}: 旧${p.oldIdx + 1}は新版に対応ページなし(削除)`);
        const labelOld = `旧 p.${p.oldIdx + 1}`, labelNew = '(新版になし)';
        const composed = composePlaceholder(op.canvas, null, labelOld, labelNew, 'このページは削除されました');
        results.push({
          composed, category: 'delete', labelOld, labelNew,
          oldCanvas: op.canvas, newCanvas: null, placeholderMessage: 'このページは削除されました',
        });
      } else if (p.type === 'insert') {
        const np = newPages[p.newIdx];
        onLog(`p${pageOut}: 新${p.newIdx + 1}は旧版に対応ページなし(新規追加)`);
        const labelOld = '(旧版になし)', labelNew = `新 p.${p.newIdx + 1}`;
        const composed = composePlaceholder(null, np.canvas, labelOld, labelNew, 'このページは新規追加されました');
        results.push({
          composed, category: 'insert', labelOld, labelNew,
          oldCanvas: null, newCanvas: np.canvas, placeholderMessage: 'このページは新規追加されました',
        });
      }
    }

    const overallCategory = pickOverallCategory(votes);
    onLog(`分類: ${overallCategory}`);
    return { results, category: overallCategory };
  }

  global.PdfDiffCore = {
    runDiff,
    // テスト用に一部関数も公開
    _internal: { classifyPage, clusterRows, extractWords, alignPages, pairChanges, diffText, buildCharStream, mergeConsecutiveBoxes },
  };
})(window);
