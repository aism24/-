// 鳥取工場 生産状況(左=生産遅れリスト、右=前日出来高。見本のPDFと同じ並び・合計行。2026-11-11 ユーザー指定)
// データはGAS(gas/Code.gs)の JSON API から取得する。GASのURLが未設定、または ?demo=1 のときはサンプル表示。
// 行の形: 前日出来高 [物件名, 製品名, 図番, 重量, 生産日, 部位, 数量]
//         遅れリスト [物件名, 製品名, 図番, 重量, 生産予定日, 遅れ日数(営業日), 部位, 数量]
// 並び(物件名 → 部位 → 案件マスターの行の順)はGASが決める。画面は物件ごとに合計行を挟むだけ。
(function () {
  'use strict';

  // GAS WebアプリのURL
  const GAS_URL = 'https://script.google.com/macros/s/AKfycby82K8BtvFOn5dHnlFMVB4-gYsVQNBCyaarn5ZjgcuCRK5knLSJ4rzTKu_T4vBuezlL/exec';

  const params = new URLSearchParams(location.search);
  const DEMO = !GAS_URL || params.get('demo') === '1';
  const $ = function (id) { return document.getElementById(id); };
  const WD = ['日', '月', '火', '水', '木', '金', '土'];

  // 表の列(見本: 物件名|部位|製品名|数量|重量。遅れリストは右に 予定日|遅れ を足す)
  const KIND = {
    late: { part: 6, qty: 7, no: 8, sub: '遅れ合計', total: '総遅れ合計', extra: [{ label: '予定日', i: 4, date: true }, { label: '遅れ', i: 5, days: true }] },
    yesterday: { part: 5, qty: 6, no: 7, sub: '結果合計', total: '総結果合計', extra: [] },
  };

  const st = { data: null, shown: false, busy: false };

  function esc(s) {
    return String(s == null ? '' : s).replace(/[&<>"]/g, function (c) { return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]; });
  }
  // 重量は小数第3位を四捨五入して2桁(合計は、四捨五入した値を足す=表の数字を足した値と一致させる)
  function r2(v) { return Math.round((Number(v) || 0) * 100 + 1e-7) / 100; }
  function fmtW(v) { return r2(v).toFixed(2); }
  function parts(key) { const p = String(key || '').split('-'); return p.length === 3 ? { y: +p[0], m: +p[1], d: +p[2] } : null; }
  function wd(p) { return WD[new Date(Date.UTC(p.y, p.m - 1, p.d)).getUTCDay()]; }
  function fmtDate(key) { const p = parts(key); return p ? p.m + '/' + p.d + '(' + wd(p) + ')' : ''; }
  function fmtMD(key) { const p = parts(key); return p ? p.m + '.' + p.d : ''; }
  function fmtDateY(key) { const p = parts(key); return p ? p.y + '/' + p.m + '/' + p.d + '(' + wd(p) + ')' : ''; }
  function daysClass(n) { return n >= 5 ? 'd3' : n >= 3 ? 'd2' : 'd1'; } // 営業日: 5日以上=赤、3日以上=橙

  // 物件ごとにまとめる(行の順はそのまま)
  // 工事別の合計行の見出し: 【ITM】　遅れ合計(2026-11-12 ユーザー指定)
  function subLabel(name, label) { return '【' + (name || '') + '】\u3000' + label; }
  function groups(rows, k) {
    const out = [];
    rows.forEach(function (r) {
      let g = out[out.length - 1];
      if (!g || g.name !== r[0]) { g = { name: r[0], no: r[k.no] || '', rows: [], qty: 0, weight: 0 }; out.push(g); }
      g.rows.push(r);
      g.qty += Number(r[k.qty]) || 0;
      g.weight = r2(g.weight + r2(r[3]));
    });
    return out;
  }
  function totals(gs) {
    return gs.reduce(function (t, g) { return { qty: t.qty + g.qty, weight: r2(t.weight + g.weight) }; }, { qty: 0, weight: 0 });
  }

  let toastTimer = 0;
  function toast(msg) {
    const t = $('toast');
    t.textContent = msg;
    t.hidden = false;
    clearTimeout(toastTimer);
    toastTimer = setTimeout(function () { t.hidden = true; }, 3500);
  }

  // ---- 利用記録(画面には何も出さない・失敗は無視) ----
  function sendLog(kind, detail) {
    if (DEMO) return;
    try {
      fetch(GAS_URL, { method: 'POST', mode: 'no-cors', keepalive: true, headers: { 'Content-Type': 'text/plain;charset=utf-8' }, body: JSON.stringify({ action: 'log', kind: kind, detail: detail || '' }) }).catch(function () {});
    } catch (e) { /* 無視 */ }
  }

  // ---- 取得 ----
  function fetchJson(url) {
    return fetch(url, { credentials: 'omit', cache: 'no-store' }).then(function (r) {
      if (!r.ok) throw new Error('サーバーエラー(HTTP ' + r.status + ')');
      return r.json();
    });
  }
  // 開いた直後は「加工結果を送ってください」だけ(2026-11-11 ユーザー指定)。一覧はPDFを読み込んだときにGASが作る
  // (最新の加工日の確認もそのときに行うので、開いた時点ではGASを呼ばない)
  function init() {
    if (!DEMO) return;
    $('banner').hidden = false;
    $('banner').textContent = GAS_URL ? 'サンプル表示です(?demo=1)。実際のデータではありません。' : 'サンプル表示です(GASのURLが未設定のため)。実際のデータではありません。';
    showResult();
    fetchJson('sample.json?v=20261111d').then(function (d) { setData(d); }).catch(function (e) { showError('サンプルの読み込みに失敗しました: ' + e.message); });
  }

  function showError(msg) {
    const w = $('warn');
    w.hidden = false;
    w.classList.add('error');
    w.textContent = msg;
  }

  // ---- 表示 ----
  function setData(d) {
    // 遅れの並び: 工事(物件名)ごと → 予定日の古い順。同じ予定日はGASの並び(部位→案件マスターの行)のまま(2026-11-12 ユーザー指定)
    if (d && d.late) d.late = d.late.map(function (r, i) { return [r, i]; }).sort(function (a, b) {
      return (a[0][0] < b[0][0] ? -1 : a[0][0] > b[0][0] ? 1 : 0) || (a[0][4] < b[0][4] ? -1 : a[0][4] > b[0][4] ? 1 : 0) || (a[1] - b[1]);
    }).map(function (x) { return x[0]; });
    st.data = d;
    $('meta').innerHTML = '基準日 <b>' + esc(fmtDateY(d.baseDate)) + '</b>・結果の日 <b>' + esc(fmtDateY(d.prevDate)) + '</b>';
    const w = $('warn');
    w.classList.remove('error'); w.hidden = !(d.warnings && d.warnings.length); w.textContent = (d.warnings || []).join('\n');
    render('late');
    render('yesterday');
    const p = d.plan;
    if (p && p.count) $('planInfo').innerHTML = '読み込んだ予定表: <b>' + esc(p.fileName || '(名前なし)') + '</b>(' + esc(fmtDate(p.from)) + '〜' + esc(fmtDate(p.to)) + '、読込 ' + esc(String(p.loadedAt).slice(0, 16)) + ')・保存済みの予定 ' + p.count + '件';
    const mt = missingText(p);
    $('abbrBtn').disabled = DEMO || !((d.unknown || []).length || Object.keys(d.abbr || {}).length);
    // 新しい略称があれば、工事番号を選ぶ画面を出す(前回の表示からは出さない)
    if (st.shown && !DEMO && (d.unknown || []).length && $('abbrModal').hidden) openAbbr(true);
  }

  function missingText(p) {
    if (!p || !p.missing || !p.missing.length) return '';
    return p.missing.map(fmtDate).join('と') + 'の予定が含まれていないので、予定通り完了したものと考えます';
  }

  // ---- 略称の対応(新しい略称が出たら、工事番号を選んでもらう) ----
  function openAbbr(auto) {
    const d = st.data;
    if (!d) return;
    const known = d.abbr || {}, unknown = d.unknown || [];
    const names = Object.keys(known).concat(unknown.filter(function (u) { return !known[u]; })).sort();
    if (!names.length) { toast('まだ予定表を読み込んでいないので、略称がありません'); return; }
    $('abbrNote').textContent = auto
      ? '新しい略称があります。週間予定表の件名(略称)が、どの工事番号の案件マスターかを選んでください。'
      : '週間予定表の件名(略称)が、どの工事番号の案件マスターかを選んでください。';
    const opts = (d.workList || []).map(function (w) { return '<option value="' + esc(w[0]) + '">' + esc(w[0] + ' ' + w[1]) + '</option>'; }).join('');
    $('abbrList').innerHTML = names.map(function (n) {
      return '<div class="abbr-row"><span class="ab">' + esc(n) + (known[n] ? '' : '<span class="new">新規</span>') + '</span><select data-abbr="' + esc(n) + '"><option value="">(選んでください)</option>' + opts + '</select></div>';
    }).join('');
    Array.prototype.forEach.call($('abbrList').querySelectorAll('select'), function (sel) { sel.value = known[sel.getAttribute('data-abbr')] || ''; });
    $('abbrModal').hidden = false;
  }
  // 加工結果(PDFの結果重量の表)の製品で、作業用データを読み直してもマスターに加工日が無いものを出す
  // 画面中央のお知らせ(ピンク背景・黒の太字。OKを押すまで消えない)
  function notice(msg, onOk) {
    $('noticeText').textContent = msg;
    $('noticeModal').hidden = false;
    st.noticeOk = onOk || null;
    $('noticeOk').focus();
  }
  function closeNotice() {
    $('noticeModal').hidden = true;
    const f = st.noticeOk; st.noticeOk = null;
    if (f) f();
  }

  function showResultCheck(rc) {
    if (!rc || !rc.missing || !rc.missing.length) return;
    if (!$('abbrModal').hidden) return; // 略称の選択が先(保存すると改めて確認する)
    const by = {};
    rc.missing.forEach(function (m) { (by[m.name || '(件名なし)'] = by[m.name || '(件名なし)'] || []).push(m); });
    $('dateNote').textContent = fmtDateY(rc.date) + 'の加工結果のうち、案件マスターに加工日が無い製品です' + (rc.reread ? '(作業用データを' + rc.reread + '件読み直して確認しました)' : '') + '。マスターに日付を入れてください。';
    $('dateList').innerHTML = Object.keys(by).map(function (n) {
      return '<div class="date-group"><div class="date-name">' + esc(n) + '</div><table class="sheet"><thead><tr><th>製品名</th><th>行数</th></tr></thead><tbody>'
        + by[n].map(function (m) { return '<tr><td>' + esc(m.mark) + '</td><td class="num">' + (m.row ? esc(m.row) : 'マスターに無し') + '</td></tr>'; }).join('') + '</tbody></table></div>';
    }).join('');
    $('dateModal').hidden = false;
  }

  function saveAbbr() {
    const map = {};
    Array.prototype.forEach.call($('abbrList').querySelectorAll('select'), function (sel) { map[sel.getAttribute('data-abbr')] = sel.value; });
    const btn = $('abbrSave');
    btn.disabled = true;
    fetch(GAS_URL, { method: 'POST', headers: { 'Content-Type': 'text/plain;charset=utf-8' }, body: JSON.stringify({ action: 'mapNames', map: map }) }).then(function (x) { return x.json(); }).then(function (res) {
      if (res.status !== 'success') throw new Error(res.message || '保存に失敗しました');
      $('abbrModal').hidden = true;
      setData(res.data);
      toast('略称の対応を保存しました');
      showResultCheck(res.resultCheck);
    }).catch(function (e) { toast('保存に失敗しました: ' + e.message); }).then(function () { btn.disabled = false; });
  }

  function title(kind) {
    const d = st.data;
    return kind === 'late' ? '鳥取工場' + fmtMD(d.baseDate) + '生産遅れ' : '鳥取工場' + fmtMD(d.prevDate) + '結果重量';
  }

  function render(kind) {
    const d = st.data, k = KIND[kind];
    const gs = groups(d[kind] || [], k), t = totals(gs);
    $(kind + 'Title').textContent = title(kind);
    $(kind + 'Total').textContent = fmtW(t.weight) + 't';
    $(kind + 'Note').hidden = true; // 表の説明文は出さない(2026-11-12 ユーザー指定)
    const head = ['物件名', '部位', '製品名', '数量', '重量'].concat(k.extra.map(function (e) { return e.label; }));
    let html = '<thead><tr>' + head.map(function (h, i) { return '<th' + (i === 3 || i === 4 ? ' class="num"' : '') + '>' + esc(h) + '</th>'; }).join('') + '</tr></thead><tbody>';
    gs.forEach(function (g) {
      g.rows.forEach(function (r, i) {
        html += '<tr><td class="work">' + (i === 0 ? esc(g.name) : '') + '</td><td class="part">' + esc(r[k.part]) + '</td><td class="mark">' + esc(r[1]) + '</td>'
          + '<td class="num">' + esc(r[k.qty]) + '</td><td class="num">' + fmtW(r[3]) + '</td>';
        k.extra.forEach(function (e) {
          if (e.date) html += '<td class="date">' + esc(fmtDate(r[e.i])) + '</td>';
          if (e.days) { const n = Number(r[e.i]) || 0; html += '<td class="days-cell"><span class="days ' + daysClass(n) + '">' + n + '日</span></td>'; }
        });
        html += '</tr>';
      });
      html += subRow(subLabel(g.name, k.sub), g.qty, g.weight, head.length, 'sub');
    });
    if (gs.length) html += subRow(k.total, t.qty, t.weight, head.length, 'total');
    html += '</tbody>';
    $(kind + 'Table').innerHTML = gs.length ? html : '';
    $(kind + 'Empty').hidden = gs.length > 0;
    $(kind + 'Sticky').removeAttribute('data-src');
    setTimeout(updateStickyTotals, 0);
  }

  // 総合計の行(総遅れ合計・総結果合計)が画面の下に隠れているときは、画面の最下部に写しを固定する。
  // スクロールして本物の行が見えたら写しを消す(=本物がスクロールに合わせて動く)(2026-11-12 ユーザー指定)
  function updateStickyTotals() {
    ['late', 'yesterday'].forEach(function (kind) {
      const bar = $(kind + 'Sticky'), row = $(kind + 'Table').querySelector('tr.total');
      const wrap = $(kind + 'Table').parentNode;
      if (!row || $('resultView').hidden) { bar.hidden = true; return; }
      const vh = window.innerHeight, rr = row.getBoundingClientRect(), wr = wrap.getBoundingClientRect();
      const show = rr.bottom > vh && wr.top < vh - rr.height * 2; // 本物が画面の下にあり、表は画面に入っている
      bar.hidden = !show;
      if (!show) return;
      const cells = row.children;
      if (bar.getAttribute('data-src') !== row.textContent + '|' + wrap.clientWidth) {
        const t = document.createElement('table');
        t.className = 'sheet';
        const tr = row.cloneNode(true);
        Array.prototype.forEach.call(tr.children, function (td, i) { td.style.width = td.style.minWidth = td.style.maxWidth = cells[i].getBoundingClientRect().width + 'px'; td.style.boxSizing = 'border-box'; });
        t.appendChild(document.createElement('tbody')).appendChild(tr);
        t.style.width = row.parentNode.parentNode.getBoundingClientRect().width + 'px';
        t.style.tableLayout = 'fixed';
        bar.innerHTML = '';
        bar.appendChild(t);
        bar.setAttribute('data-src', row.textContent + '|' + wrap.clientWidth);
      }
      bar.style.left = wr.left + 'px';
      bar.style.width = wr.width + 'px';
      bar.firstChild.style.transform = 'translateX(' + (-wrap.scrollLeft) + 'px)';
    });
  }
  window.addEventListener('scroll', updateStickyTotals, { passive: true });
  window.addEventListener('resize', function () { ['lateSticky', 'yesterdaySticky'].forEach(function (id) { $(id).removeAttribute('data-src'); }); updateStickyTotals(); });
  ['lateTable', 'yesterdayTable'].forEach(function (id) { $(id).parentNode.addEventListener('scroll', updateStickyTotals, { passive: true }); });

  function subRow(label, qty, weight, cols, cls) {
    return '<tr class="' + cls + '"><td colspan="3" class="label">' + esc(label) + '</td><td class="num">' + qty + '</td><td class="num">' + fmtW(weight) + '</td>' + (cols > 5 ? '<td colspan="' + (cols - 5) + '"></td>' : '') + '</tr>';
  }

  // ---- 加工結果PDF(週間予定表)の読み取り ----
  // 「鳥取工場 加工予定表」のページから、曜日ごとの列(N月N日(曜)加工予定)にある 件名|製品名|台数|重量|図番 の行を読む。
  // 製品の行 = 「製品名」の右に、同じ高さで 台数(整数)→重量(小数)が並ぶ行。件名(物件名)は列の左端の英数字の見出し(ITM・OSR など)。
  // 台数セルの色は読まない(完了・未完は案件マスターの加工日で判定する。色と116行すべて一致することを確認済み)。
  // PDFの年: ファイル名の先頭 YYMMDD(例: 261110_加工結果.pdf)→ 予定表の「更新日:2026/11/10」→ 今日 の順で決める
  function pdfYearMonth(fileName, all) {
    const f = String(fileName || '').match(/^(\d{2})(\d{2})(\d{2})/);
    if (f && +f[2] >= 1 && +f[2] <= 12) return { y: 2000 + +f[1], m: +f[2] };
    const up = String(all || '').match(/更新日[:：]\s*(\d{4})\/(\d{1,2})\/(\d{1,2})/);
    if (up) return { y: +up[1], m: +up[2] };
    const now = new Date();
    return { y: now.getFullYear(), m: now.getMonth() + 1 };
  }
  function mdKey(ym, mm, dd) {
    let y = ym.y;
    if (mm - ym.m > 6) y--; else if (ym.m - mm > 6) y++;
    return y + '-' + ('0' + mm).slice(-2) + '-' + ('0' + dd).slice(-2);
  }

  // 戻り値: items=予定表の行、results=結果重量の表の製品、resultDate=「鳥取工場MM.DD結果重量」の日
  // 何日の結果を出すかは resultDate で決める(2026-11-11 ユーザー指定。基準日はGASでその次の営業日にする)
  function parsePlanPdf(buf, fileName) {
    if (typeof pdfjsLib === 'undefined') return Promise.reject(new Error('PDFの部品を読み込み中です。少し待ってからもう一度選んでください。'));
    pdfjsLib.GlobalWorkerOptions.workerSrc = 'https://cdnjs.cloudflare.com/ajax/libs/pdf.js/3.11.174/pdf.worker.min.js';
    return pdfjsLib.getDocument({ data: buf }).promise.then(function (pdf) {
      const pages = [];
      // 用紙を回転させたPDF(横向きのExcelから書き出したもの)もあるので、表示上の座標(左上が原点)に直して使う
      for (let i = 1; i <= pdf.numPages; i++) {
        pages.push(pdf.getPage(i).then(function (pg) {
          const vt = pg.getViewport({ scale: 1 }).transform;
          return pg.getTextContent().then(function (c) {
            return c.items.map(function (t) { const m = pdfjsLib.Util.transform(vt, t.transform); return { str: t.str, x: m[4], y: m[5], w: t.width }; });
          });
        }));
      }
      return Promise.all(pages);
    }).then(function (contents) {
      const tx = contents.map(textLines);
      const found = tx.map(function (t, i) { const r = planFromText(t); if (r) r.page = i; return r; }).filter(function (r) { return r && r.items.length; });
      if (!found.length) throw new Error('このPDFに「鳥取工場 加工予定表」が見つかりませんでした(文字の読めるPDFが必要です。スキャンした画像のPDFは読めません)。');
      const ym = pdfYearMonth(fileName, tx.map(function (t) { return t.all; }).join(''));
      const results = tx.map(function (t) { return resultFromText(t, ym); }).filter(Boolean).reduce(function (a, r) { return a.concat(r); }, []);
      let resultDate = '';
      tx.forEach(function (t) {
        const r = t.all.match(/(\d{1,2})\.(\d{1,2})結果重量/);
        if (r && !resultDate) resultDate = mdKey(ym, +r[1], +r[2]);
      });
      return { items: found.reduce(function (a, r) { return a.concat(r.items); }, []), results: results, resultDate: resultDate, planPages: found.map(function (r) { return r.page; }) };
    });
  }

  // 同じ高さ(±2pt)の文字を左から並べ、すき間の無い文字どうしは1語につなぐ
  function textLines(raw) {
    // 同じ高さ(±2pt)の文字を左から並べ、すき間の無い文字どうしは1語につなぐ(漢字や「ITM」が1文字ずつ分かれて入っているため)
    const lines = [];
    raw.filter(function (t) { return String(t.str).trim(); }).sort(function (a, b) { return a.y - b.y || a.x - b.x; }).forEach(function (t) {
      let ln = lines.find(function (l) { return Math.abs(l.y - t.y) <= 2; });
      if (!ln) { ln = { y: t.y, ts: [] }; lines.push(ln); }
      ln.ts.push(t);
    });
    lines.sort(function (a, b) { return a.y - b.y; });
    lines.forEach(function (ln) {
      ln.ts.sort(function (a, b) { return a.x - b.x; });
      const words = [];
      ln.ts.forEach(function (t) {
        const last = words[words.length - 1];
        if (last && t.x - (last.x + last.w) < 1.5) { last.s += String(t.str).trim(); last.w = t.x + t.w - last.x; }
        else words.push({ s: String(t.str).trim(), x: t.x, w: t.w });
      });
      ln.ts = words;
    });
    const its = lines.reduce(function (a, l) { return a.concat(l.ts); }, []);
    return { lines: lines, its: its, all: its.map(function (t) { return t.s; }).join('') };
  }

  // 2ページ目の「鳥取工場11.10結果重量」の表(右側)から、加工済みのはずの製品を読む(物件名|部位|製品名|数量|重量)
  function resultFromText(tx, ym) {
    const head = tx.its.find(function (t) { return /(\d{1,2})\.(\d{1,2})結果重量/.test(t.s); });
    if (!head) return null;
    const m = head.s.match(/(\d{1,2})\.(\d{1,2})結果重量/);
    const date = mdKey(ym, +m[1], +m[2]);
    const x0 = head.x - 5;
    const out = [];
    let cur = '';
    tx.lines.forEach(function (ln) {
      const ts = ln.ts.filter(function (t) { return t.x >= x0; });
      for (let i = 0; i < ts.length; i++) {
        const t = ts[i];
        if (i === 0 && /^[A-Za-z][A-Za-z0-9]{1,9}$/.test(t.s)) { cur = t.s; continue; }
        const q = ts[i + 1], w = ts[i + 2];
        if (q && w && /-/.test(t.s) && /^\d+$/.test(q.s) && /^\d+(\.\d+)?$/.test(w.s)) { out.push({ date: date, name: cur, mark: t.s }); i += 2; }
      }
    });
    return out;
  }

  function planFromText(tx) {
    const lines = tx.lines, its = tx.its, all = tx.all;
    if (all.indexOf('加工予定表') < 0) return null;
    // 年: 「更新日:2026/11/10」から(無ければ今年)
    const up = all.match(/更新日[:：]\s*(\d{4})\/(\d{1,2})\/(\d{1,2})/);
    const baseY = up ? +up[1] : new Date().getFullYear(), baseM = up ? +up[2] : new Date().getMonth() + 1;
    const heads = [];
    its.forEach(function (t) {
      const m = t.s.match(/^(\d{1,2})月(\d{1,2})日\(.\)加工予定$/);
      if (!m) return;
      let y = baseY;
      if (+m[1] - baseM > 6) y--; else if (baseM - +m[1] > 6) y++;
      heads.push({ date: y + '-' + ('0' + m[1]).slice(-2) + '-' + ('0' + m[2]).slice(-2), cx: t.x + t.w / 2 });
    });
    if (!heads.length) return null;
    heads.sort(function (a, b) { return a.cx - b.cx; });
    const span = heads.length > 1 ? (heads[heads.length - 1].cx - heads[0].cx) / (heads.length - 1) : 1e9;
    const colOf = function (x) { let best = null; heads.forEach(function (h) { if (Math.abs(x - h.cx) <= span / 2 + 1 && (!best || Math.abs(x - h.cx) < Math.abs(x - best.cx))) best = h; }); return best; };
    const items = [], curName = {};
    lines.forEach(function (ln) {
      const ts = ln.ts;
      for (let i = 0; i < ts.length; i++) {
        const t = ts[i], h = colOf(t.x);
        if (!h) continue;
        // 件名の見出し(英数字だけの短い語。例: ITM、OSR)
        if (/^[A-Za-z][A-Za-z0-9]{1,9}$/.test(t.s) && ts[i + 1] && colOf(ts[i + 1].x) === h && /-/.test(ts[i + 1].s)) curName[h.date] = t.s;
        const q = ts[i + 1], w = ts[i + 2];
        if (!q || !w || colOf(q.x) !== h || colOf(w.x) !== h) continue;
        if (!/-/.test(t.s) || !/^\d+$/.test(q.s) || !/^\d+(\.\d+)?$/.test(w.s)) continue;
        const dw = ts[i + 3] && colOf(ts[i + 3].x) === h && /-/.test(ts[i + 3].s) ? ts[i + 3].s : '';
        items.push({ date: h.date, name: curName[h.date] || '', mark: t.s, qty: +q.s, weight: +w.s, drawing: dw });
        i += dw ? 3 : 2;
      }
    });
    return { items: items };
  }

  // 開いた直後の「加工結果を送ってください」から、一覧の画面へ切り替える
  function showResult() {
    st.shown = true;
    $('landing').hidden = true;
    $('resultView').hidden = false;
    document.body.classList.remove('landing-mode');
  }
  // リセット: 一覧を消して、開いた直後の「加工結果を送ってください」に戻す(2026-11-12 ユーザー指定。GASのデータには触れない)
  function reset() {
    if (st.busy) return;
    st.data = null; st.src = null; st.shown = false; st.noticeOk = null;
    ['noticeModal', 'dateModal', 'abbrModal', 'warn', 'toast'].forEach(function (id) { $(id).hidden = true; });
    ['lateTable', 'yesterdayTable', 'meta', 'planInfo'].forEach(function (id) { $(id).innerHTML = ''; });
    $('resultView').hidden = true;
    updateStickyTotals();
    $('landing').hidden = false;
    document.body.classList.add('landing-mode');
    landingState(false, '加工結果を送ってください', 'PDFを画面のどこかにドロップするか、フォルダから選んでください', '');
    window.scrollTo(0, 0);
  }
  function landingState(busy, title, sub, err) {
    $('landing').classList.toggle('busy', busy);
    $('landingTitle').textContent = title;
    $('landingSub').textContent = sub;
    $('landingErr').hidden = !err;
    $('landingErr').textContent = err || '';
  }

  function onPdf(file) {
    if (!file || st.busy) return;
    if (DEMO) { toast('サンプル表示では読み込めません'); return; }
    if (!/\.pdf$/i.test(file.name) && file.type !== 'application/pdf') { toast('PDFを送ってください'); return; }
    st.busy = true;
    if (!st.shown) landingState(true, '読み取っています…', '「' + file.name + '」', '');
    else toast('「' + file.name + '」を読み取っています…');
    let bytes = null, planPages = [];
    loadPdfLib().catch(function () {}); // ダウンロード用の部品を先に読み込んでおく
    file.arrayBuffer().then(function (buf) { bytes = buf.slice(0); return parsePlanPdf(buf, file.name); }).then(function (r) {
      planPages = r.planPages;
      if (!st.shown) landingState(true, '照らし合わせています…', '予定表 ' + r.items.length + ' 件を案件マスターと照らし合わせています(しばらくかかることがあります)', '');
      else toast('予定表から ' + r.items.length + ' 件を読み取りました。案件マスターと照らし合わせています…');
      return fetch(GAS_URL, { method: 'POST', headers: { 'Content-Type': 'text/plain;charset=utf-8' }, body: JSON.stringify({ action: 'schedule', fileName: file.name, items: r.items, results: r.results, resultDate: r.resultDate }) }).then(function (x) { return x.json(); });
    }).then(function (res) {
      if (res.status !== 'success') throw new Error(res.message || '保存に失敗しました');
      showResult();
      st.src = { bytes: bytes, planPages: planPages, name: file.name };
      setData(res.data);
      const mt = missingText(res.data.plan);
      // 取込のお知らせは画面中央に出し、OKを押すまで消さない(2026-11-12 ユーザー指定)。OKの後に加工結果の確認を出す
      notice('予定表を読み込みました(' + res.saved + '件)' + (mt ? '。' + mt : ''), function () { showResultCheck(res.resultCheck); });
      return downloadPdf(); // 一覧が出たら、そのままPDFをダウンロード
    }).catch(function (e) {
      if (!st.shown) landingState(false, '加工結果を送ってください', 'PDFを画面のどこかにドロップするか、フォルダから選んでください', '読み込めませんでした: ' + e.message);
      else showError('加工結果PDFの読み込みに失敗しました: ' + e.message);
    }).then(function () { st.busy = false; $('pdfInput').value = ''; });
  }

  // 画面のどこにドロップしても受け付ける
  (function () {
    let depth = 0;
    const hasFile = function (e) { return e.dataTransfer && Array.prototype.indexOf.call(e.dataTransfer.types || [], 'Files') >= 0; };
    document.addEventListener('dragenter', function (e) { if (!hasFile(e)) return; e.preventDefault(); depth++; $('dropOverlay').hidden = false; });
    document.addEventListener('dragover', function (e) { if (!hasFile(e)) return; e.preventDefault(); e.dataTransfer.dropEffect = 'copy'; });
    document.addEventListener('dragleave', function (e) { if (!hasFile(e)) return; depth = Math.max(0, depth - 1); if (!depth) $('dropOverlay').hidden = true; });
    document.addEventListener('drop', function (e) {
      if (!hasFile(e)) return;
      e.preventDefault();
      depth = 0;
      $('dropOverlay').hidden = true;
      const f = Array.prototype.find.call(e.dataTransfer.files || [], function (x) { return /\.pdf$/i.test(x.name) || x.type === 'application/pdf'; });
      if (f) onPdf(f); else toast('PDFを送ってください');
    });
  })();

  // ---- ダウンロードするPDF(2026-11-12 ユーザー指定。Excelはやめた) ----
  // 1ページ目: A4縦に、画面と同じ 左=生産遅れ・右=結果重量 の表。2ページ目以降: 取り込んだPDFの「加工予定表」のページ(元のまま=A4横)。
  // グラフのページと「予定重量・結果重量」のページは入れない。PDFを読み込んで一覧が出たら自動でダウンロードする。
  function loadPdfLib() {
    if (typeof PDFLib !== 'undefined') return Promise.resolve();
    if (st.pdfLibLoading) return st.pdfLibLoading;
    st.pdfLibLoading = new Promise(function (ok, ng) {
      const sc = document.createElement('script');
      sc.src = 'https://cdnjs.cloudflare.com/ajax/libs/pdf-lib/1.17.1/pdf-lib.min.js';
      sc.onload = function () { ok(); };
      sc.onerror = function () { st.pdfLibLoading = null; ng(new Error('PDFの部品を読み込めませんでした')); };
      document.head.appendChild(sc);
    });
    return st.pdfLibLoading;
  }

  // 1ページ目の絵(A4縦・300dpi)。単位はmm(ctx.scale で px に直す)
  function drawSummaryPage() {
    const d = st.data, PX = 300 / 25.4, W = 210, H = 297, M = 10, GAP = 5;
    const cv = document.createElement('canvas');
    cv.width = Math.round(W * PX); cv.height = Math.round(H * PX);
    const c = cv.getContext('2d');
    c.scale(PX, PX);
    c.fillStyle = '#fff'; c.fillRect(0, 0, W, H);
    const FONT = '"Hiragino Sans","Hiragino Kaku Gothic ProN","Yu Gothic","Meiryo","Noto Sans JP","Noto Sans CJK JP",sans-serif';
    const font = function (size, bold) { c.font = (bold ? 'bold ' : '') + size + 'px ' + FONT; };
    // 文字が枠に入らなければ横に縮める
    const text = function (s, x, y, w, align, size, bold, color) {
      s = String(s == null ? '' : s);
      font(size, bold);
      c.fillStyle = color || '#1d2733';
      c.textBaseline = 'middle';
      const tw = c.measureText(s).width, room = w - 1.2;
      c.save();
      let x0 = align === 'left' ? x + 0.6 : align === 'right' ? x + w - 0.6 : x + w / 2;
      if (tw > room && room > 0) { const k = room / tw; c.translate(x0, y); c.scale(k, 1); x0 = 0; y = 0; }
      c.textAlign = align || 'center';
      c.fillText(s, x0, y);
      c.restore();
    };
    // 見出し
    text('鳥取工場 生産状況', M, M + 3, 100, 'left', 5.2, true);
    text('結果の日 ' + fmtDateY(d.prevDate) + '・基準日 ' + fmtDateY(d.baseDate), W - M - 100, M + 3, 100, 'right', 3.2, false, '#5d6b7a');
    let top = M + 8;
    // 「…予定通り完了したものと考えます」はPDFに入れない(2026-11-12 ユーザー指定。読み込み時のお知らせにだけ出す)
    // 2つの表の列(mm)。遅れ: 物件名|部位|製品名|数量|重量|予定日|遅れ  結果: 物件名|部位|製品名|数量|重量
    const colsL = [13, 10, 29, 9, 13, 15, 11], colsR = [13, 10, 29, 9, 13];
    const sum = function (a) { return a.reduce(function (x, y) { return x + y; }, 0); };
    const k = (W - 2 * M - GAP) / (sum(colsL) + sum(colsR));
    const wl = colsL.map(function (v) { return v * k; }), wr = colsR.map(function (v) { return v * k; });
    const tables = [{ kind: 'late', x: M, w: wl }, { kind: 'yesterday', x: M + sum(wl) + GAP, w: wr }];
    tables.forEach(function (t) { t.gs = groups(d[t.kind] || [], KIND[t.kind]); t.rows = t.gs.reduce(function (a, g) { return a + g.rows.length + 1; }, 0) + (t.gs.length ? 1 : 0); });
    const maxRows = Math.max(1, tables[0].rows, tables[1].rows) + 1; // +見出し
    const rh = Math.min(5.2, (H - M - top - 9) / maxRows), fs = Math.min(3.1, rh * 0.62);
    const FILL = { late: '#cfe8f7', yesterday: '#fff2a8' }, FILL_TOTAL = { late: '#7fbbe6', yesterday: '#ffd23f' }; // 総合計は工事別合計より濃く
    tables.forEach(function (t) {
      const kd = KIND[t.kind], tw = sum(t.w), tt = totals(t.gs);
      text(title(t.kind), t.x, top + 3.5, tw * 0.75, 'left', 4.2, true);
      text(fmtW(tt.weight) + 't', t.x + tw * 0.6, top + 3.5, tw * 0.4, 'right', 4.2, true);
      let y = top + 7;
      const line = function (cells, fill, bold) {
        let x = t.x;
        if (fill) { c.fillStyle = fill; c.fillRect(t.x, y, tw, rh); }
        c.strokeStyle = '#808080'; c.lineWidth = 0.15;
        cells.forEach(function (cell) {
          const w = cell.span ? t.w.slice(cell.i, cell.i + cell.span).reduce(function (a, b) { return a + b; }, 0) : t.w[cell.i];
          c.strokeRect(x, y, w, rh);
          text(cell.v, x, y + rh / 2, w, cell.align, fs, bold || cell.bold, cell.color);
          x += w;
        });
        y += rh;
      };
      const head = ['物件名', '部位', '製品名', '数量', '重量'].concat(kd.extra.map(function (e) { return e.label; }));
      line(head.map(function (h, i) { return { i: i, v: h }; }), '#eef2f7', true);
      const subLine = function (label, qty, weight, isTotal) {
        const cells = [{ i: 0, span: 3, v: label }, { i: 3, v: qty }, { i: 4, v: fmtW(weight), align: 'right' }];
        if (t.w.length > 5) cells.push({ i: 5, span: t.w.length - 5, v: '' });
        line(cells, (isTotal ? FILL_TOTAL : FILL)[t.kind], true);
      };
      t.gs.forEach(function (g) {
        g.rows.forEach(function (r, i) {
          const cells = [{ i: 0, v: i === 0 ? g.name : '', bold: true }, { i: 1, v: r[kd.part] }, { i: 2, v: r[1] }, { i: 3, v: r[kd.qty] }, { i: 4, v: fmtW(r[3]), align: 'right' }];
          kd.extra.forEach(function (e, j) {
            if (e.date) cells.push({ i: 5 + j, v: fmtDate(r[e.i]) });
            if (e.days) { const n = Number(r[e.i]) || 0; cells.push({ i: 5 + j, v: n + '日', bold: n >= 3, color: n >= 5 ? '#a3121c' : n >= 3 ? '#8a3d00' : '#1d2733' }); }
          });
          line(cells);
        });
        subLine(subLabel(g.name, kd.sub), g.qty, g.weight);
      });
      if (t.gs.length) subLine(kd.total, tt.qty, tt.weight, true);
      else text(t.kind === 'late' ? '遅れている製品はありません' : '結果の日の出来高はありません', t.x, y + rh / 2, tw, 'center', fs, false, '#5d6b7a');
    });
    return cv;
  }

  function buildPdf() {
    const src = st.src;
    if (!src) return Promise.reject(new Error('取り込んだPDFがありません'));
    return loadPdfLib().then(function () {
      const P = PDFLib;
      return Promise.all([P.PDFDocument.create(), P.PDFDocument.load(src.bytes, { ignoreEncryption: true })]).then(function (docs) {
        const out = docs[0], org = docs[1];
        const png = drawSummaryPage().toDataURL('image/png');
        return out.embedPng(png).then(function (img) {
          const pg = out.addPage([595.28, 841.89]); // A4縦
          pg.drawImage(img, { x: 0, y: 0, width: 595.28, height: 841.89 });
          return out.copyPages(org, src.planPages);
        }).then(function (pages) {
          pages.forEach(function (p) { out.addPage(p); }); // 予定表のページ(元のPDFのまま。A4横)
          out.setTitle(title('late') + '・' + title('yesterday'));
          return out.save();
        });
      });
    });
  }

  function downloadPdf() {
    if (!st.data || !st.src) return Promise.resolve();
    const fileName = '鳥取_生産状況_' + String(st.data.baseDate).replace(/-/g, '') + '.pdf';
    return buildPdf().then(function (bytes) {
      const blob = new Blob([bytes], { type: 'application/pdf' });
      const a = document.createElement('a');
      a.href = URL.createObjectURL(blob);
      a.download = fileName;
      document.body.appendChild(a);
      a.click();
      setTimeout(function () { URL.revokeObjectURL(a.href); a.remove(); }, 60000);
      sendLog('ダウンロード', fileName);
    }).catch(function (e) { toast('PDFの作成に失敗しました: ' + e.message); });
  }

  $('pdfInput').addEventListener('change', function () { onPdf(this.files && this.files[0]); });
  $('resetBtn').addEventListener('click', reset);
  $('abbrBtn').addEventListener('click', function () { openAbbr(false); });
  $('abbrCancel').addEventListener('click', function () { $('abbrModal').hidden = true; });
  $('abbrSave').addEventListener('click', saveAbbr);
  $('noticeOk').addEventListener('click', closeNotice);
  $('dateClose').addEventListener('click', function () { $('dateModal').hidden = true; });

  init();
  sendLog('起動', '');
})();
