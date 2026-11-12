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
    yesterday: { part: 5, qty: 6, no: 7, sub: '結果合計', total: '総結果合計', extra: [{ label: '備考', i: 8, note: true }] },
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
  // 前日出来高の備考(2026-11-12 ユーザー指定): 予定日より後に加工した(=遅れていた分を加工した)行だけ「11/5予定分対応」。それ以外は空欄
  // 行の形: [物件名, 製品名, 図番, 重量, 生産日, 部位, 数量, 工事番号, 予定日]
  // 前日出来高の備考。マスタに無い製品(PDFの結果の表からそのまま入れた行)は赤字で「マスタに無い製品」
  function noteOf(r) { return r[9] === 'nomaster' ? 'マスタに無い製品' : catchUp(r); }
  // PDFの結果重量の表にあるのに案件マスターに見つからない製品を、PDFの数値・結果の日のまま結果の表に入れる(2026-11-12 ユーザー指定)。
  // 行の形: [物件名, 製品名, 図番, 重量, 生産日, 部位, 数量, 工事番号, 予定日, 'nomaster']。並びは物件名ごと(同じ物件名の行のあと)。
  // 入れた製品は「マスターデータに日付が入ってません」のポップアップからは外す(マスターにあって日付が無いものだけ出す)
  function mergeNoMaster(d, rc) {
    if (!d || !rc || !rc.missing) return rc;
    const nf = {};
    rc.missing.forEach(function (m) { if (!m.row) nf[m.name + '\t' + m.mark] = true; });
    const add = (st.results || []).filter(function (x) { return nf[x.name + '\t' + x.mark]; });
    if (add.length) {
      const rows = (d.yesterday || []).concat(add.map(function (x) { return [x.name, x.mark, '', x.weight, x.date, x.part, x.qty, '', '', 'nomaster']; }));
      d.yesterday = rows.map(function (r, i) { return [r, i]; }).sort(function (a, b) { return (a[0][0] < b[0][0] ? -1 : a[0][0] > b[0][0] ? 1 : 0) || (a[1] - b[1]); }).map(function (x) { return x[0]; });
    }
    return Object.assign({}, rc, { missing: rc.missing.filter(function (m) { return m.row; }) });
  }
  function catchUp(r) {
    const plan = r[8], p = parts(plan);
    return p && r[4] && plan < r[4] ? p.m + '/' + p.d + '予定分対応' : '';
  }
  const CATCHUP_FILL = '#d9f2d9'; // 薄い緑
  // 遅れのうち、予定表で台数のセルが黄色(=次の加工予定)の製品は、遅れの表の行も黄色にする(2026-11-12 ユーザー指定)。
  // st.next は予定表のページを塗るとき(paintRow)に台数のセルの元の色から作る(物件名+TAB+製品名 → true)
  const NEXT_FILL = '#ffff00';
  function isNext(r) { return !!(st.next && st.next[r[0] + '\t' + r[1]]); }
  // 遅れの並び: 工事(物件名)ごとに、次の加工予定(黄色)の行を先頭に。それ以外と黄色の行どうしは今までの並び(予定日の古い順→部位→案件マスターの行)のまま(2026-11-12 ユーザー指定)
  function sortLateNext() {
    const d = st.data;
    if (!d || !d.late || !st.next) return;
    d.late = d.late.map(function (r, i) { return [r, i]; }).sort(function (a, b) {
      return (a[0][0] < b[0][0] ? -1 : a[0][0] > b[0][0] ? 1 : 0) || ((isNext(a[0]) ? 0 : 1) - (isNext(b[0]) ? 0 : 1)) || (a[1] - b[1]);
    }).map(function (x) { return x[0]; });
  }
  function isYellow(c) { return c[0] >= 200 && c[1] >= 200 && c[2] <= 100; } // 予定表の黄色(255,255,0)。橙(255,192,0)・薄い黄(255,255,204)は含めない

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
    $('dateNote').textContent = fmtDateY(rc.date) + 'の加工結果のうち、案件マスターに加工日が無い製品です。マスターに日付を入れてください。';
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
      const rc = mergeNoMaster(res.data, res.resultCheck);
      setData(res.data);
      toast('略称の対応を保存しました');
      showResultCheck(rc);
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
        const note = kind === 'yesterday' ? noteOf(r) : '', nm = r[9] === 'nomaster';
        const cls = note && !nm ? 'catchup' : kind === 'late' && isNext(r) ? 'next' : '';
        html += '<tr' + (cls ? ' class="' + cls + '"' : '') + '><td class="work">' + (i === 0 ? esc(g.name) : '') + '</td><td class="part">' + esc(r[k.part]) + '</td><td class="mark">' + esc(r[1]) + '</td>'
          + '<td class="num">' + esc(r[k.qty]) + '</td><td class="num">' + fmtW(r[3]) + '</td>';
        k.extra.forEach(function (e) {
          if (e.date) html += '<td class="date">' + esc(fmtDate(r[e.i])) + '</td>';
          if (e.note) html += '<td class="note' + (nm ? ' nomaster' : '') + '">' + esc(note) + '</td>';
          if (e.days) { const n = Number(r[e.i]) || 0; html += '<td class="days-cell"><span class="days ' + daysClass(n) + '">' + n + '日</span></td>'; }
        });
        html += '</tr>';
      });
      html += subRow(subLabel(g.name, k.sub), g.qty, g.weight, head.length, 'sub');
    });
    html += '</tbody>';
    if (gs.length) html += '<tfoot>' + subRow(k.total, t.qty, t.weight, head.length, 'total') + '</tfoot>'; // 総合計は tfoot(表の枠の最下部に固定するため)
    $(kind + 'Table').innerHTML = gs.length ? html : '';
    $(kind + 'Empty').hidden = gs.length > 0;
  }

  // 見出しの行(物件名…)と総合計の行の固定は CSS(表の枠の中で sticky)で行う(2026-11-12 ユーザー指定)

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
            return c.items.map(function (t) { const m = pdfjsLib.Util.transform(vt, t.transform); return { str: t.str, x: m[4], y: m[5], w: t.width, h: Math.hypot(m[2], m[3]) }; });
          });
        }));
      }
      return Promise.all(pages);
    }).then(function (contents) {
      const tx = contents.map(textLines);
      const found = tx.map(function (t, i) { const r = planFromText(t); if (r) { r.page = i; r.items.forEach(function (it) { it.cell.page = i; }); } return r; }).filter(function (r) { return r && r.items.length; });
      if (!found.length) throw new Error('このPDFに「鳥取工場 加工予定表」が見つかりませんでした(文字の読めるPDFが必要です。スキャンした画像のPDFは読めません)。');
      const ym = pdfYearMonth(fileName, tx.map(function (t) { return t.all; }).join(''));
      const results = tx.map(function (t) { return resultFromText(t, ym); }).filter(Boolean).reduce(function (a, r) { return a.concat(r); }, []);
      let resultDate = '';
      tx.forEach(function (t) {
        const r = t.all.match(/(\d{1,2})\.(\d{1,2})結果重量/);
        if (r && !resultDate) resultDate = mdKey(ym, +r[1], +r[2]);
      });
      const all = found.reduce(function (a, r) { return a.concat(r.items); }, []);
      const cells = all.map(function (it) { return it.cell; });
      const items = all.map(function (it) { const o = Object.assign({}, it); delete o.cell; return o; });
      return { items: items, results: results, resultDate: resultDate, planPages: found.map(function (r) { return r.page; }), cells: cells };
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
        else words.push({ s: String(t.str).trim(), x: t.x, w: t.w, y: t.y, h: t.h });
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
        const q = ts[i + 1], w = ts[i + 2];
        if (q && w && /-/.test(t.s) && /^\d+$/.test(q.s) && /^\d+(\.\d+)?$/.test(w.s)) {
          // 物件名|部位|製品名… の行は、製品名の2つ左が物件名(「LP京都」のように日本語を含むこともある。2026-11-12 修正)。部位から始まる行は前の物件名のまま
          if (i >= 2) cur = ts[i - 2].s;
          // 部位・数量・重量も控える(マスタに無い製品を結果の表にそのまま入れるため。2026-11-12)
          out.push({ date: date, name: cur, mark: t.s, part: i >= 1 ? ts[i - 1].s : '', qty: +q.s, weight: +w.s }); i += 2;
        }
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
        // cell: PDFの色付けに使う位置(台数・製品名・重量・図番の文字の位置。GASへは送らない)
        items.push({ date: h.date, name: curName[h.date] || '', mark: t.s, qty: +q.s, weight: +w.s, drawing: dw,
          cell: { y: t.y, h: t.h || 6, qty: { x: q.x, w: q.w }, mark: t.s, dw: dw, name: curName[h.date] || '',
            paint: [[t, 'mark'], [w, 'weight']].concat(dw ? [[ts[i + 3], 'dw']] : []).map(function (z) { return { x: z[0].x, w: z[0].w, role: z[1] }; }) } });
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
    st.data = null; st.src = null; st.next = null; st.shown = false; st.noticeOk = null;
    ['noticeModal', 'dateModal', 'abbrModal', 'warn', 'toast'].forEach(function (id) { $(id).hidden = true; });
    ['lateTable', 'yesterdayTable', 'meta', 'planInfo'].forEach(function (id) { $(id).innerHTML = ''; });
    $('resultView').hidden = true;
    $('landing').hidden = false;
    document.body.classList.add('landing-mode');
    landingState(false, '加工結果を送ってください', 'PDFを画面のどこかにドロップするか、フォルダから選んでください', '');
    progress(null);
    $('landingNote').hidden = true;
    window.scrollTo(0, 0);
  }
  // 進捗バー(2026-11-12 ユーザー指定)。段階: PDFの読み取り 0〜15% → 照らし合わせ(GAS)15〜80% → PDF作成 80〜100%。
  // GASの処理は途中経過が分からないので、待ち時間に応じて80%の手前まで少しずつ進める
  let progTimer = 0;
  function progress(pct, label) {
    $('progress').hidden = pct == null;
    if (pct == null) { clearInterval(progTimer); return; }
    st.prog = Math.max(st.prog || 0, pct);
    $('progressFill').style.width = st.prog.toFixed(1) + '%';
    $('progressText').textContent = Math.floor(st.prog) + '%' + (label ? '　' + label : '');
  }
  function progressWait(from, to, label) {
    clearInterval(progTimer);
    const t0 = Date.now();
    progress(from, label);
    progTimer = setInterval(function () { progress(from + (to - from) * (1 - Math.exp(-(Date.now() - t0) / 15000)), label); }, 300);
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
    st.prog = 0;
    $('landingNote').hidden = true;
    if (!st.shown) { landingState(true, '読み取っています…', '「' + file.name + '」', ''); progress(3, 'PDFを読み取り中'); }
    else toast('「' + file.name + '」を読み取っています…');
    let bytes = null, planPages = [], cells = [];
    loadPdfLib().catch(function () {}); // ダウンロード用の部品を先に読み込んでおく
    loadLinks().catch(function () {}); // 実寸リンク表もGASの照らし合わせと並行して読んでおく(2026-11-12)
    file.arrayBuffer().then(function (buf) { bytes = buf.slice(0); return parsePlanPdf(buf, file.name); }).then(function (r) {
      planPages = r.planPages;
      cells = r.cells;
      st.results = r.results;
      if (!st.shown) {
        landingState(true, '処理を実行中\n塗りつぶし＆ハイパーリンク付与', // 2行・中央揃え(2026-11-12 ユーザー指定)
          '予定表 ' + r.items.length + ' 件を案件マスターと照らし合わせています', '');
        $('landingNote').hidden = false;
        progressWait(15, 80, '案件マスターと照らし合わせ中');
      }
      else toast('予定表から ' + r.items.length + ' 件を読み取りました。案件マスターと照らし合わせています…');
      return fetch(GAS_URL, { method: 'POST', headers: { 'Content-Type': 'text/plain;charset=utf-8' }, body: JSON.stringify({ action: 'schedule', fileName: file.name, items: r.items, results: r.results, resultDate: r.resultDate }) }).then(function (x) { return x.json(); });
    }).then(function (res) {
      if (res.status !== 'success') throw new Error(res.message || '保存に失敗しました');
      clearInterval(progTimer);
      progress(80, 'PDFを作成中(塗りつぶし・リンク)');
      st.src = { bytes: bytes, planPages: planPages, cells: cells, name: file.name };
      const rc = mergeNoMaster(res.data, res.resultCheck);
      setData(res.data); // 一覧は裏で作り、PDFができてから画面を切り替える(進捗バーを最後まで見せるため)
      const mt = missingText(res.data.plan);
      // 取込のお知らせは画面中央に出し、OKを押すまで消さない(2026-11-12 ユーザー指定)。OKの後に加工結果の確認を出す
      // 一覧が出たら、そのままPDFをダウンロード。お知らせはPDFを作ったあとに出す(マスタで完了を確認して塗り直した件数を添えるため)
      return downloadPdf().then(function () {
        progress(100, '完了');
        showResult();
        progress(null);
        if (!DEMO && (res.data.unknown || []).length && $('abbrModal').hidden) openAbbr(true); // 新しい略称があれば工事番号を選ぶ画面
        const fixed = st.linkStat ? st.linkStat.fixed : 0;
        notice('予定表を読み込みました(' + res.saved + '件)' + (mt ? '。' + mt : '') + (fixed ? '\nマスタで完了を確認：' + fixed + '件' : ''), function () { showResultCheck(rc); });
      });
    }).catch(function (e) {
      progress(null);
      $('landingNote').hidden = true;
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
  // 行が多いときは SUMMARY_ROWS 行(見出しの行を除く。合計行を含む)ごとに次のページへ分ける。
  // 2ページ目以降も、見出し(アプリ名・結果の日・基準日)・表の題名と合計重量・列の見出し(物件名…)は同じように入れる(2026-11-12 ユーザー指定)
  const SUMMARY_ROWS = 60;
  function drawSummaryPages() {
    const d = st.data, PX = 300 / 25.4, W = 210, H = 297, M = 10, GAP = 5, top = M + 8;
    const FONT = '"Hiragino Sans","Hiragino Kaku Gothic ProN","Yu Gothic","Meiryo","Noto Sans JP","Noto Sans CJK JP",sans-serif';
    // 2つの表の列(mm)。遅れ: 物件名|部位|製品名|数量|重量|予定日|遅れ  結果: 物件名|部位|製品名|数量|重量|備考
    const colsL = [12, 9, 27, 8, 13, 15, 10], colsR = [12, 9, 27, 8, 13, 28];
    const sum = function (a) { return a.reduce(function (x, y) { return x + y; }, 0); };
    const k = (W - 2 * M - GAP) / (sum(colsL) + sum(colsR));
    const wl = colsL.map(function (v) { return v * k; }), wr = colsR.map(function (v) { return v * k; });
    const tables = [{ kind: 'late', x: M, w: wl }, { kind: 'yesterday', x: M + sum(wl) + GAP, w: wr }];
    // 表ごとの行の並び(製品の行・工事別の合計・総合計)
    tables.forEach(function (t) {
      t.gs = groups(d[t.kind] || [], KIND[t.kind]);
      t.items = [];
      t.gs.forEach(function (g) {
        g.rows.forEach(function (r) { t.items.push({ type: 'row', r: r, g: g }); });
        t.items.push({ type: 'sub', g: g });
      });
      if (t.gs.length) t.items.push({ type: 'total' });
    });
    const most = Math.max(1, tables[0].items.length, tables[1].items.length);
    const nPages = Math.ceil(most / SUMMARY_ROWS);
    const perPage = Math.min(most, SUMMARY_ROWS);
    const rh = Math.min(5.2, (H - M - top - 9) / (perPage + 1)), fs = Math.min(3.1, rh * 0.62); // +1 = 列の見出し
    const FILL = { late: '#cfe8f7', yesterday: '#fff2a8' }, FILL_TOTAL = { late: '#7fbbe6', yesterday: '#ffd23f' }; // 総合計は工事別合計より濃く
    const pages = [];
    for (let pi = 0; pi < nPages; pi++) {
      const cv = document.createElement('canvas');
      cv.width = Math.round(W * PX); cv.height = Math.round(H * PX);
      const c = cv.getContext('2d');
      c.scale(PX, PX);
      c.fillStyle = '#fff'; c.fillRect(0, 0, W, H);
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
      // 見出し(どのページにも同じものを入れる)
      text('鳥取工場 生産状況', M, M + 3, 100, 'left', 5.2, true);
      text('結果の日 ' + fmtDateY(d.prevDate) + '・基準日 ' + fmtDateY(d.baseDate) + (nPages > 1 ? '(' + (pi + 1) + '/' + nPages + ')' : ''), W - M - 110, M + 3, 110, 'right', 3.2, false, '#5d6b7a');
      // 「…予定通り完了したものと考えます」はPDFに入れない(2026-11-12 ユーザー指定。読み込み時のお知らせにだけ出す)
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
        const slice = t.items.slice(pi * SUMMARY_ROWS, (pi + 1) * SUMMARY_ROWS);
        slice.forEach(function (it, j) {
          if (it.type === 'sub') return subLine(subLabel(it.g.name, kd.sub), it.g.qty, it.g.weight);
          if (it.type === 'total') return subLine(kd.total, tt.qty, tt.weight, true);
          const r = it.r, prev = j > 0 ? slice[j - 1] : null;
          const showName = !prev || prev.type !== 'row' || prev.g !== it.g; // 工事の最初の行と、ページの最初の行には物件名を出す
          const cells = [{ i: 0, v: showName ? it.g.name : '', bold: true }, { i: 1, v: r[kd.part] }, { i: 2, v: r[1] }, { i: 3, v: r[kd.qty] }, { i: 4, v: fmtW(r[3]), align: 'right' }];
          const note = t.kind === 'yesterday' ? noteOf(r) : '', nm = r[9] === 'nomaster';
          kd.extra.forEach(function (e, jj) {
            if (e.note) cells.push(nm ? { i: 5 + jj, v: note, bold: true, color: '#d00000' } : { i: 5 + jj, v: note });
            if (e.date) cells.push({ i: 5 + jj, v: fmtDate(r[e.i]) });
            if (e.days) { const n = Number(r[e.i]) || 0; cells.push({ i: 5 + jj, v: n + '日', bold: n >= 3, color: n >= 5 ? '#a3121c' : n >= 3 ? '#8a3d00' : '#1d2733' }); }
          });
          line(cells, note && !nm ? CATCHUP_FILL : t.kind === 'late' && isNext(r) ? NEXT_FILL : null);
        });
        if (!t.gs.length && pi === 0) text(t.kind === 'late' ? '遅れている製品はありません' : '結果の日の出来高はありません', t.x, y + rh / 2, tw, 'center', fs, false, '#5d6b7a');
      });
      pages.push(cv);
    }
    return pages;
  }

  // 予定表のページを絵にして、製品ごとに「台数」のセルの色を 製品名・重量・図番 のセルにも塗る(2026-11-12 ユーザー指定。どの製品がまだかを分かりやすく)。
  // セルの枠は絵の上で文字の左右・上下を枠線まで探して決める。文字(黒・赤など)は残し、背景の色だけを塗り替える。
  const PAINT_SCALE = 3; // 216dpi
  function paintedPlanPages(src) {
    paintRow.fixed = 0;
    st.next = {};
    if (!src.cells || !src.cells.length) return Promise.resolve(null);
    return pdfjsLib.getDocument({ data: src.bytes.slice(0) }).promise.then(function (pdf) {
      return src.planPages.reduce(function (pr, pi) {
        return pr.then(function (acc) {
          return pdf.getPage(pi + 1).then(function (pg) {
            const vp = pg.getViewport({ scale: PAINT_SCALE }), v1 = pg.getViewport({ scale: 1 });
            const cv = document.createElement('canvas');
            cv.width = Math.round(vp.width); cv.height = Math.round(vp.height);
            const ctx = cv.getContext('2d');
            return pg.render({ canvasContext: ctx, viewport: vp }).promise.then(function () {
              const im = ctx.getImageData(0, 0, cv.width, cv.height);
              const orig = new Uint8ClampedArray(im.data); // 色・枠は塗る前の絵で測る(先に塗った行に引きずられないように)
              const pd = (st.data && st.data.planDone) || {};
              src.cells.forEach(function (c) { c.done = pd[c.name + '\t' + c.mark] || ''; });
              src.cells.filter(function (c) { return c.page === pi; }).forEach(function (c) { paintRow(im, c, orig); });
              ctx.putImageData(im, 0, 0);
              // リンクの範囲をPDFの座標(左下が原点、単位pt)に直す
              const rects = [];
              src.cells.filter(function (c) { return c.page === pi && c.rects; }).forEach(function (c) {
                c.rects.forEach(function (k) { rects.push({ key: (c.dw || '') + '\t' + c.mark, rect: [k.x0 / PAINT_SCALE, v1.height - k.y1 / PAINT_SCALE, k.x1 / PAINT_SCALE, v1.height - k.y0 / PAINT_SCALE] }); });
              });
              acc.push({ jpg: cv.toDataURL('image/jpeg', 0.92), w: v1.width, h: v1.height, rects: rects });
              if (!st.shown) progress(80 + 17 * acc.length / src.planPages.length, 'PDFを作成中(塗りつぶし・リンク)');
              return acc;
            });
          });
        });
      }, Promise.resolve([]));
    }).catch(function () { return null; });
  }
  function paintRow(im, c, o) {
    const S = PAINT_SCALE, W = im.width, H = im.height, d = im.data;
    const px = function (x, y) { x = Math.round(x); y = Math.round(y); if (x < 0 || y < 0 || x >= W || y >= H) return null; const i = (y * W + x) * 4; return [o[i], o[i + 1], o[i + 2]]; };
    const dist = function (a, b) { return Math.abs(a[0] - b[0]) + Math.abs(a[1] - b[1]) + Math.abs(a[2] - b[2]); };
    const lum = function (a) { return 0.299 * a[0] + 0.587 * a[1] + 0.114 * a[2]; };
    // (x0,y0)から dx,dy の向きに、背景と違う暗い線(枠線)まで進む
    const edge = function (x0, y0, dx, dy, bg) {
      for (let k = 1; k < 80 * S; k++) {
        const p = px(x0 + dx * k, y0 + dy * k);
        if (!p) return null;
        if (dist(p, bg) > 60 && lum(p) < lum(bg) * 0.75) return { x: x0 + dx * k, y: y0 + dy * k }; // 背景よりはっきり暗い=枠線(濃い青の背景でも見つかるように比で見る)
      }
      return null;
    };
    // 背景を測る高さ: 文字の上下のすき間の候補のうち、周り(左右・上下)が同じ色の所(=枠線や文字の上ではない)
    const bgAt = function (x) {
      const cand = [0.9, 1.0, 0.95, 0.85, 1.05, 0.8, 1.1, 0.7, -0.25, -0.3, -0.35, -0.2, -0.15]; // 行の間が狭い表もあるので細かく試す
      for (let n = 0; n < cand.length; n++) {
        const y = (c.y - c.h * cand[n]) * S, p = px(x, y);
        if (!p) continue;
        const ok = [[-4, 0], [4, 0], [0, -1], [0, 1], [-4, -1], [4, 1]].every(function (o) { const z = px(x + o[0], y + o[1]); return z && dist(z, p) < 30; });
        if (ok) return { y: y, bg: p };
      }
      return null;
    };
    // セルの枠と背景色。row があれば上下はその行に合わせる(図番の列は行の間に横線が無いため)
    const cellOf = function (t, row) {
      const xc = (t.x + t.w / 2) * S, s0 = bgAt(xc);
      if (!s0) return null;
      const bg = s0.bg, y = s0.y;
      const l = edge(xc, y, -1, 0, bg), r = edge(xc, y, 1, 0, bg);
      if (!l || !r) return null;
      let u, b;
      if (row) { u = { y: row.y0 }; b = { y: row.y1 }; }
      else {
        const xs = Math.max(l.x + 2, t.x * S - 3); // 文字の左(文字に重ならない縦の線)で上下を探す
        u = edge(xs, y, 0, -1, bg); b = edge(xs, y, 0, 1, bg);
      }
      if (!u || !b) return null;
      return { x0: l.x, x1: r.x, y0: u.y, y1: b.y, bg: bg };
    };
    // リンクを付ける範囲(製品名・図番)。セルの枠が見つからなければ文字の範囲(単位は絵のpx)
    c.rects = c.paint.filter(function (t) { return t.role !== 'weight'; }).map(function (t) { return { role: t.role, x0: t.x * S - 2, x1: (t.x + t.w) * S + 2, y0: (c.y - c.h) * S, y1: (c.y + c.h * 0.25) * S }; });
    const q = cellOf(c.qty);
    if (!q || q.x1 - q.x0 > 25 * S || q.y1 - q.y0 > 15 * S) { paintRow.miss = (paintRow.miss || 0) + 1; return; } // 台数のセルが大きすぎる=枠を取り違えた
    let col = q.bg; // 台数のセルの色
    if (isYellow(q.bg)) st.next[c.name + '\t' + c.mark] = true; // 次の加工予定(黄色)
    // マスタでは加工済み(結果の日まで)なのに台数が青くない行は、台数も含めて薄い青で塗る(予定表の色付けの不足を補う。2026-11-12 ユーザー指定)
    const fixDone = !!(c.done && dist(col, BLUE_LIGHT) > 80 && dist(col, BLUE_DARK) > 80);
    if (fixDone) { col = BLUE_LIGHT; paintRow.fixed = (paintRow.fixed || 0) + 1; fill(q); }
    // 台数が色なし(白)なら 製品名・重量・図番 も白にする(重量・図番の元の色は消える)
    c.paint.forEach(function (t) {
      const r = cellOf(t, q);
      if (!r || r.x1 - r.x0 > 60 * S || r.y1 - r.y0 > 20 * S) { paintRow.miss = (paintRow.miss || 0) + 1; return; } // 枠が見つからない・大きすぎるときは塗らない
      paintRow.done = (paintRow.done || 0) + 1;
      c.rects.forEach(function (k) { if (k.role === t.role) { k.x0 = r.x0; k.x1 = r.x1; k.y0 = r.y0; k.y1 = r.y1; } });
      fill(r);
    });
    function fill(r) {
      const lb = Math.max(1, lum(r.bg));
      for (let y = Math.round(r.y0) + 1; y < Math.round(r.y1); y++) {
        for (let x = Math.round(r.x0) + 1; x < Math.round(r.x1); x++) {
          const i = (y * W + x) * 4, p = [o[i], o[i + 1], o[i + 2]];
          // 背景と文字(インク)の混ざり具合 a(0=背景、1=文字)。背景の分だけ色を差し替える: 新 = 今 + (台数の色 - 元の背景) × (1 - a)
          const a = Math.min(1, Math.max(0, 1 - lum(p) / lb));
          if (a > 0.97) continue;
          for (let ch = 0; ch < 3; ch++) d[i + ch] = Math.min(255, Math.max(0, p[ch] + (col[ch] - r.bg[ch]) * (1 - a)));
        }
      }
    }
  }
  const BLUE_LIGHT = [0, 176, 240], BLUE_DARK = [0, 112, 192]; // 予定表の青(薄い青・濃い青。PDFの実際の色)

  // 実寸法師へのリンク表(shipping-list-link のマスタ。図番+TAB+製品名 → file://…tdf)を読む(2026-11-12 ユーザー指定)。
  // 読むだけ(向こうのアプリの記録・保存は動かない)。重複(リンクが複数)は付けない
  const LINK_GAS_URL = 'https://script.google.com/macros/s/AKfycbw0NvmN8vjr4g0TNx1TQ8DffC6FWwK6GfBOZb32N0mTp3CrcYXLNOpkxhXo2ce1PwE6/exec';
  function loadLinks() {
    if (st.links) return Promise.resolve(st.links);
    if (st.linksP) return st.linksP; // 読み込み中なら同じものを待つ
    st.linksP = fetch(LINK_GAS_URL + '?action=links', { cache: 'no-store' }).then(function (r) { return r.json(); }).then(function (m) {
      if (!m || !m.links) throw new Error('リンク表がありません');
      const links = {};
      Object.keys(m.links).forEach(function (k) {
        const v = m.links[k];
        if (typeof v !== 'string') return; // 重複
        const i = v.indexOf('|');
        links[k] = m.d ? (i > 0 ? m.d[+v.slice(0, i)] : '') + v.slice(i + 1) : v;
      });
      st.links = links;
      return links;
    });
    st.linksP.catch(function () { st.linksP = null; }); // 失敗したら次は読み直す
    return st.linksP;
  }
  // shipping-list-link と同じ書き方(ASCII以外と括弧をエンコード)
  function encodeUri(u) {
    return u.replace(/[^\x21-\x7e]/g, function (c) { return encodeURIComponent(c); }).replace(/\(/g, '%28').replace(/\)/g, '%29');
  }
  function addLinks(out, page, rects, links) {
    let n = 0;
    const P = PDFLib, ctx = out.context;
    rects.forEach(function (k) {
      const uri = links[k.key];
      if (!uri) return;
      const act = ctx.obj({ S: 'URI', URI: P.PDFString.of(encodeUri(uri)) });
      page.node.addAnnot(ctx.register(ctx.obj({ Type: 'Annot', Subtype: 'Link', Rect: k.rect, Border: [0, 0, 0], A: act })));
      n++;
    });
    return n;
  }

  function buildPdf() {
    const src = st.src;
    if (!src) return Promise.reject(new Error('取り込んだPDFがありません'));
    const linksP = loadLinks().catch(function () { return null; }); // 読めなければリンクなし
    st.linkStat = null;
    return loadPdfLib().then(function () {
      const P = PDFLib;
      return Promise.all([P.PDFDocument.create(), P.PDFDocument.load(src.bytes, { ignoreEncryption: true })]).then(function (docs) {
        const out = docs[0], org = docs[1];
        let imgs = null;
        // 先に予定表のページを塗る(台数の色から、遅れのうち次の加工予定=黄色の製品が分かる)→ 遅れの表(画面・1ページ目)を黄色付きで作る
        return paintedPlanPages(src).then(function (x) {
          imgs = x;
          if (st.data) { sortLateNext(); render('late'); }
          // 遅れ・結果の表のページ(A4縦。行が多ければ複数ページ)
          return drawSummaryPages().reduce(function (pr, cv) {
            return pr.then(function () { return out.embedPng(cv.toDataURL('image/png')); }).then(function (img) {
              const pg = out.addPage([595.28, 841.89]);
              pg.drawImage(img, { x: 0, y: 0, width: 595.28, height: 841.89 });
            });
          }, Promise.resolve());
        }).then(function () {
          // 予定表のページ: 台数の色を 製品名・重量・図番 にも塗った絵(元のページの向き=A4横)。塗れなければ元のページをそのまま
          if (!imgs) return out.copyPages(org, src.planPages).then(function (pages) { pages.forEach(function (p) { out.addPage(p); }); });
          return linksP.then(function (links) {
            const stat = { linked: 0, cells: 0, ok: !!links };
            return imgs.reduce(function (pr, im) {
              return pr.then(function () { return out.embedJpg(im.jpg); }).then(function (e) {
                const pg = out.addPage([im.w, im.h]);
                pg.drawImage(e, { x: 0, y: 0, width: im.w, height: im.h });
                stat.cells += im.rects.length;
                if (links) stat.linked += addLinks(out, pg, im.rects, links); // 図番・製品名のセルにリンク(見た目は変えない)
              });
            }, Promise.resolve()).then(function () { stat.fixed = paintRow.fixed || 0; st.linkStat = stat; });
          });
        }).then(function () {
          out.setTitle(title('late') + '・' + title('yesterday'));
          return out.save();
        });
      });
    });
  }

  function downloadPdf() {
    if (!st.data || !st.src) return Promise.resolve();
    // ファイル名: 取り込んだファイル名 + 「_新_」 + ダウンロードした日時(秒まで。重複を防ぐ)。例: 261110_加工結果_新_20261112_091530.pdf(2026-11-12 ユーザー指定)
    const z = function (n) { return ('0' + n).slice(-2); }, now = new Date();
    const base = String(st.src.name || '加工結果').replace(/\.pdf$/i, '').replace(/[\\/:*?"<>|]/g, '_');
    const fileName = base + '_新_' + now.getFullYear() + z(now.getMonth() + 1) + z(now.getDate()) + '_' + z(now.getHours()) + z(now.getMinutes()) + z(now.getSeconds()) + '.pdf';
    return buildPdf().then(function (bytes) {
      const blob = new Blob([bytes], { type: 'application/pdf' });
      const a = document.createElement('a');
      a.href = URL.createObjectURL(blob);
      a.download = fileName;
      document.body.appendChild(a);
      a.click();
      setTimeout(function () { URL.revokeObjectURL(a.href); a.remove(); }, 60000);
      sendLog('ダウンロード', fileName);
      if (st.linkStat && !st.linkStat.ok) toast('図番・製品名のリンク表を読み込めなかったため、リンクなしでダウンロードしました');
    }).catch(function (e) { toast('PDFの作成に失敗しました: ' + e.message); });
  }

  $('pdfInput').addEventListener('change', function () { onPdf(this.files && this.files[0]); });
  $('resetBtn').addEventListener('click', reset);
  $('abbrBtn').addEventListener('click', function () { openAbbr(false); });
  $('abbrCancel').addEventListener('click', function () { $('abbrModal').hidden = true; });
  $('abbrSave').addEventListener('click', saveAbbr);
  $('noticeOk').addEventListener('click', closeNotice);
  $('dateClose').addEventListener('click', function () { $('dateModal').hidden = true; });

  // ---- ダウンロードPDFの説明書をアプリの中で開く(2026-11-12 ユーザー指定) ----
  // iPadのSafariは埋め込んだPDFを1ページ目しか出さないことがあるので、pdf.js で各ページを絵にする(一度描いたら使い回す)。
  // 1ページずつ画面いっぱいに出し、ホイール(スクロール)・2本指でズーム、ドラッグで移動。「前へ」「次へ」でめくる
  const MZ_Q = 3, MZ_MAX = 5; // 絵の細かさ(PDFの1ptあたりの画素)・ズームの上限(画面に合わせた大きさの何倍まで)
  const mz = { page: 0, s: 1, fit: 1, x: 0, y: 0, ptrs: {}, pinch: null };
  function mzPages() { return Array.prototype.slice.call($('manualPages').querySelectorAll('.manual-page')); }
  function mzApply() {
    const cv = mzPages()[mz.page];
    if (!cv) return;
    const st0 = $('manualPages'), W = st0.clientWidth, H = st0.clientHeight, w = cv.mzW * mz.s, h = cv.mzH * mz.s;
    // はみ出さないように: 画面より小さければ中央、大きければ端が画面の内側に来ないように
    mz.x = w <= W ? (W - w) / 2 : Math.min(0, Math.max(W - w, mz.x));
    mz.y = h <= H ? (H - h) / 2 : Math.min(0, Math.max(H - h, mz.y));
    cv.style.transform = 'translate(' + mz.x + 'px,' + mz.y + 'px) scale(' + mz.s + ')';
  }
  function mzFit() {
    const cv = mzPages()[mz.page];
    if (!cv) return;
    const st0 = $('manualPages'), pad = 16;
    mz.fit = Math.min((st0.clientWidth - pad * 2) / cv.mzW, (st0.clientHeight - pad * 2) / cv.mzH);
    mz.s = mz.fit; mz.x = 0; mz.y = 0;
    mzApply();
  }
  function mzShow(i) {
    const pages = mzPages();
    if (!pages.length) return;
    mz.page = Math.max(0, Math.min(pages.length - 1, i));
    pages.forEach(function (cv, k) { cv.hidden = k !== mz.page; });
    $('manualPrev').classList.toggle('off', mz.page === 0);
    $('manualNext').classList.toggle('off', mz.page >= pages.length - 1);
    mzFit();
  }
  // (cx, cy) の点を動かさずに倍率を変える
  function mzZoom(ns, cx, cy) {
    ns = Math.max(mz.fit, Math.min(mz.fit * MZ_MAX, ns));
    mz.x = cx - (cx - mz.x) * ns / mz.s;
    mz.y = cy - (cy - mz.y) * ns / mz.s;
    mz.s = ns;
    mzApply();
  }
  (function () {
    const st0 = $('manualPages');
    const local = function (e) { const r = st0.getBoundingClientRect(); return { x: e.clientX - r.left, y: e.clientY - r.top }; };
    st0.addEventListener('wheel', function (e) {
      e.preventDefault();
      const p = local(e), dy = e.deltaMode === 1 ? e.deltaY * 16 : e.deltaY;
      mzZoom(mz.s * Math.exp(-dy * 0.0015), p.x, p.y);
    }, { passive: false });
    st0.addEventListener('pointerdown', function (e) {
      if (!mzPages().length) return;
      st0.setPointerCapture(e.pointerId);
      mz.ptrs[e.pointerId] = local(e);
      const ids = Object.keys(mz.ptrs);
      if (ids.length === 2) {
        const a = mz.ptrs[ids[0]], b = mz.ptrs[ids[1]];
        mz.pinch = { d: Math.hypot(a.x - b.x, a.y - b.y) || 1, s: mz.s };
      }
      st0.classList.add('dragging');
    });
    st0.addEventListener('pointermove', function (e) {
      const prev = mz.ptrs[e.pointerId];
      if (!prev) return;
      const p = local(e);
      mz.ptrs[e.pointerId] = p;
      const ids = Object.keys(mz.ptrs);
      if (ids.length >= 2 && mz.pinch) { // 2本指: 指の間の距離でズーム(中心はそのまま)
        const a = mz.ptrs[ids[0]], b = mz.ptrs[ids[1]];
        mzZoom(mz.pinch.s * Math.hypot(a.x - b.x, a.y - b.y) / mz.pinch.d, (a.x + b.x) / 2, (a.y + b.y) / 2);
      } else if (ids.length === 1) { // 1本指・マウス: 移動
        mz.x += p.x - prev.x; mz.y += p.y - prev.y;
        mzApply();
      }
    });
    const up = function (e) {
      delete mz.ptrs[e.pointerId];
      if (Object.keys(mz.ptrs).length < 2) mz.pinch = null;
      if (!Object.keys(mz.ptrs).length) st0.classList.remove('dragging');
    };
    st0.addEventListener('pointerup', up);
    st0.addEventListener('pointercancel', up);
    st0.addEventListener('dblclick', function () { mzFit(); }); // ダブルクリックで元の大きさ
    window.addEventListener('resize', function () { if (!$('manualView').hidden) mzFit(); });
    document.addEventListener('keydown', function (e) {
      if ($('manualView').hidden) return;
      if (e.key === 'ArrowRight') mzShow(mz.page + 1);
      if (e.key === 'ArrowLeft') mzShow(mz.page - 1);
    });
  })();
  function openManual(ev) {
    if (ev) ev.preventDefault();
    if (st.busy) return;
    $('manualView').hidden = false;
    document.body.classList.add('manual-open');
    if (st.manualDone) { mzShow(0); return; }
    $('manualPrev').classList.add('off'); $('manualNext').classList.add('off');
    if (st.manualBusy) return;
    if (typeof pdfjsLib === 'undefined') { $('manualLoading').textContent = '部品を読み込み中です。少し待ってからもう一度開いてください。'; return; }
    st.manualBusy = true;
    pdfjsLib.GlobalWorkerOptions.workerSrc = 'https://cdnjs.cloudflare.com/ajax/libs/pdf.js/3.11.174/pdf.worker.min.js';
    pdfjsLib.getDocument($('manualBtn').getAttribute('href')).promise.then(function (pdf) {
      const list = [];
      for (let i = 1; i <= pdf.numPages; i++) list.push(i);
      return list.reduce(function (pr, i) {
        return pr.then(function () { return pdf.getPage(i); }).then(function (pg) {
          const vp0 = pg.getViewport({ scale: 1 }), vp = pg.getViewport({ scale: MZ_Q });
          const cv = document.createElement('canvas');
          cv.width = Math.round(vp.width); cv.height = Math.round(vp.height);
          cv.mzW = vp0.width; cv.mzH = vp0.height; // 画面上の大きさ(倍率1のとき)
          cv.style.width = vp0.width + 'px'; cv.style.height = vp0.height + 'px';
          cv.className = 'manual-page';
          cv.hidden = true;
          $('manualPages').appendChild(cv);
          return pg.render({ canvasContext: cv.getContext('2d'), viewport: vp }).promise;
        });
      }, Promise.resolve());
    }).then(function () { st.manualDone = true; $('manualLoading').hidden = true; if (!$('manualView').hidden) mzShow(0); })
      .catch(function (e) { $('manualLoading').textContent = '説明書を開けませんでした: ' + e.message; })
      .then(function () { st.manualBusy = false; });
  }
  function closeManual() {
    $('manualView').hidden = true;
    document.body.classList.remove('manual-open');
  }
  $('manualPrev').addEventListener('click', function () { mzShow(mz.page - 1); });
  $('manualNext').addEventListener('click', function () { mzShow(mz.page + 1); });
  $('manualBtn').addEventListener('click', openManual);
  $('manualBtnHdr').addEventListener('click', openManual); // 一覧の画面ではヘッダーの左端のボタンから開く(2026-11-12 ユーザー指定)
  $('manualClose').addEventListener('click', closeManual);

  init();
  sendLog('起動', '');
})();
