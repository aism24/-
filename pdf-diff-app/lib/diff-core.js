// PDF差分解析コアロジック
// ページ整合(挿入/削除ページの自動検出)を行い、表/文章/図面それぞれの
// セル・文字・ピクセル単位の差分検出そのものは、必ずVercelのPython
// サーバーレス関数(ユーザー正解版のPythonスクリプトをそのまま実行)に
// 委譲する。ブラウザ内(JS)での差分計算は行わない(全角スペースの扱い等で
// Python版と結果が食い違う実害バグが確認され撤去した)。
(function (global) {
  'use strict';

  const ROW_Y_TOLERANCE = 3;
  const RENDER_SCALE = 2.0;
  const THUMB_SIZE = 48;

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

  // ---------- サーバーAPI経由の差分計算(Pythonオリジナルコードをそのまま使用) ----------
  //
  // pdf.js経由の推定(charWeightによる文字幅近似・全角スペースの単語分割等)は
  // PyMuPDF(page.get_text等)の実測値と細かく食い違い、誤ハイライトなどの実害が
  // 確認されたため、表/文章/図面の3方式とも、ブラウザ内では計算せず必ず
  // VercelのPythonサーバーレス関数(api/table-diff.py・text-diff.py・
  // image-diff.py、pdfの3スクリプトをそれぞれそのまま実行)にPDFを送って
  // 結果画像を受け取る。ブラウザ内(JS)での差分計算は行わない
  // (バックエンドが無い環境では動作しない。githackプレビュー等での確認には
  // 使えないので、確認時は必ずVercelにデプロイすること)。

  function arrayBufferToBase64(buf) {
    const bytes = new Uint8Array(buf);
    let binary = '';
    const chunkSize = 0x8000;
    for (let i = 0; i < bytes.length; i += chunkSize) {
      binary += String.fromCharCode.apply(null, bytes.subarray(i, i + chunkSize));
    }
    return btoa(binary);
  }

  function base64PngToImage(b64) {
    return new Promise((resolve, reject) => {
      const img = new Image();
      img.onload = () => resolve(img);
      img.onerror = () => reject(new Error('サーバーから返された画像の読み込みに失敗しました'));
      img.src = `data:image/png;base64,${b64}`;
    });
  }

  async function diffViaApi(apiUrl, oldPdfBase64, newPdfBase64, oldPage, newPage) {
    const res = await fetch(apiUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ oldPdfBase64, newPdfBase64, oldPage, newPage }),
    });
    if (!res.ok) {
      const detail = await res.text().catch(() => res.statusText);
      throw new Error(`APIエラー(${res.status}): ${detail}`);
    }
    const data = await res.json();
    const [oldImg, newImg] = await Promise.all([
      base64PngToImage(data.oldPngBase64),
      base64PngToImage(data.newPngBase64),
    ]);
    return { oldImg, newImg, oldBoxesCount: data.oldBoxesCount, newBoxesCount: data.newBoxesCount };
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

  async function preparePage(doc, num, scale, onLog, manualCategory) {
    const page = await doc.getPage(num);
    const viewport = page.getViewport({ scale });
    const { canvas, promise } = renderToCanvas(page, viewport);
    await promise;
    const words = await extractWords(page, viewport);
    const rows = clusterRows(words);
    // 種類(表/文章/図面)はユーザーが必ず選択してから解析するため、
    // ここでは常にmanualCategoryを使う(自動判定は行わない)。
    const category = manualCategory;
    const text = words.map((w) => w.text).join('');
    const thumb = text.length < 20 ? downsampleCanvas(canvas, THUMB_SIZE) : null;
    if (onLog) onLog(`ページ${num}: ${CATEGORY_LABEL[category] || category}(指定)`);
    return { canvas, words, rows, category, sig: { text, thumb } };
  }

  async function runDiff(oldArrayBuffer, newArrayBuffer, opts = {}) {
    const scale = opts.scale || RENDER_SCALE;
    const onLog = opts.onLog || (() => {});
    const manualCategory = opts.manualCategory;
    // 各方式(表/文章/図面)ごとのサーバーAPI URL。{ table: '/api/table-diff', ... }
    // 差分計算は必ずこのAPI(Python正解版)で行う。ブラウザ内計算への
    // フォールバックは行わない(結果がPython版とズレるため撤去済み)。
    const apiUrls = opts.apiUrls || {};
    if (!manualCategory) throw new Error('種類(表/文章/図面)が指定されていません');
    if (!apiUrls[manualCategory]) throw new Error(`「${CATEGORY_LABEL[manualCategory]}」モードのAPI URLが設定されていません`);

    // pdf.jsはワーカーへの転送でArrayBufferをdetach(内容を空に)することがあるため、
    // API送信用の生バイト列は、pdf.jsに渡す前にコピーしてbase64化しておく。
    const oldPdfBase64ForApi = arrayBufferToBase64(oldArrayBuffer.slice(0));
    const newPdfBase64ForApi = arrayBufferToBase64(newArrayBuffer.slice(0));

    onLog('PDFを読み込み中...');
    const oldDoc = await pdfjsLib.getDocument({ data: oldArrayBuffer }).promise;
    const newDoc = await pdfjsLib.getDocument({ data: newArrayBuffer }).promise;

    onLog(`旧: 全${oldDoc.numPages}ページ / 新: 全${newDoc.numPages}ページ`);

    const oldPages = [];
    for (const i of range(oldDoc.numPages)) oldPages.push(await preparePage(oldDoc, i + 1, scale, onLog, manualCategory));
    const newPages = [];
    for (const i of range(newDoc.numPages)) newPages.push(await preparePage(newDoc, i + 1, scale, onLog, manualCategory));

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

        const labelOld = `旧 p.${p.oldIdx + 1}`, labelNew = `新 p.${p.newIdx + 1}`;

        onLog(`${CATEGORY_LABEL[category]}モード: サーバー(Python)で比較中...`);
        const r = await diffViaApi(apiUrls[category], oldPdfBase64ForApi, newPdfBase64ForApi, p.oldIdx, p.newIdx);
        const composed = composeSideBySide(r.oldImg, r.newImg, labelOld, labelNew);
        results.push({
          composed, category, labelOld, labelNew,
          oldCanvas: r.oldImg, newCanvas: r.newImg,
          changed: r.oldBoxesCount + r.newBoxesCount > 0,
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
    _internal: { clusterRows, extractWords, alignPages, pairChanges },
  };
})(window);
