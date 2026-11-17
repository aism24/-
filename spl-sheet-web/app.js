// 継手基準図からSPLシート作成(画面)。
// 流れ: ① 入力データーの .xlsm を取り込む → ② サーバーを押して継手基準図のフォルダを選ぶ
//       → 最新図と違いがあればポップアップ → ③ 表で直して Excel に保存(ダウンロード)
// 図面の場所: ブラウザは選んだフォルダの場所を教えてくれないので、サーバーごとに「①進行中工事」を
//   1回だけ選んで覚え(目印ファイルでサーバーを確認。tdf-master-web の帳票チェックと同じ)、
//   継手基準図のフォルダはその中から選ぶ。①進行中工事からの道筋(resolve)とサーバーのパス
//   (スプレッドシートの設定シート)をつないで、図面の場所(リンク・実寸法師を開く)を作る。
(function () {
  'use strict';

  // GAS ウェブアプリの URL(スプレッドシート「SPLシート作成」の Apps Script をデプロイして得た /exec)
  const GAS_API_URL = 'https://script.google.com/macros/s/AKfycbz1zfHjlpatacJ-dwlDOV1-sj6hJjV5Q4UfZvzodAkK-PAFlYSWBm-TBRflGO4SE4n9/exec';
  const API_TIMEOUT_MS = 15000;
  const DEFAULT_SERVERS = [['本社', ''], ['鳥取', '']]; // 設定シートを読めなかったとき(リンクは付かない)

  const sc = window.splCore;
  const $ = id => document.getElementById(id);
  const NUM_COLS = new Set('EFGHJKLMOPQR'.split(''));
  const TABLE_COLS = ['A', 'B', 'E', 'F', 'G', 'H', 'J', 'K', 'L', 'M', 'O', 'P', 'Q', 'R', 'S', 'T', 'U', 'V'];
  const LEFT_COLS = new Set(['A', 'B', 'S', 'T', 'U', 'V']);

  const state = {
    excel: null,     // { name, buf, rows, kojiNo }
    servers: null,   // [[名前, パス]]
    folder: null,    // { server, dir, rel:[...], unc }
    joints: null,
    rows: [],
    selected: new Set(),
    dirty: false,
    kojiList: null,  // [[工事番号, 工事名]](設定シート)。読めなければ null
    koji: '',        // リストから選んだ工事番号
  };

  // ------------------------------------------------------------ 共通の部品

  function toast(msg, kind) {
    const t = $('toast');
    t.textContent = msg;
    t.className = 'show' + (kind === 'error' ? ' error' : '');
    clearTimeout(toast._t);
    toast._t = setTimeout(() => { t.className = ''; }, kind === 'error' ? 5000 : 2500);
  }
  function busy(on, text) {
    $('busy-text').textContent = text || '処理中…';
    $('busy').classList.toggle('open', !!on);
  }
  const esc = s => String(s == null ? '' : s).replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));

  // ダイアログ。buttons: [{label, value, cls}] → 押したボタンの value を返す
  function dialog(title, html, buttons) {
    return new Promise(resolve => {
      $('modal-title').textContent = title;
      $('modal-body').innerHTML = html;
      const box = $('modal-btns');
      box.innerHTML = '';
      (buttons || [{ label: '閉じる', value: true }]).forEach(b => {
        const el = document.createElement('button');
        el.type = 'button';
        el.className = 'btn ' + (b.cls || '');
        el.textContent = b.label;
        el.onclick = () => { $('modal').classList.remove('open'); resolve(b.value); };
        box.appendChild(el);
      });
      $('modal').classList.add('open');
    });
  }

  // ------------------------------------------------------------ GAS
  async function fetchWithTimeout(url, opts, ms) {
    const ctl = new AbortController();
    const timer = setTimeout(() => ctl.abort(), ms || API_TIMEOUT_MS);
    try { return await fetch(url, Object.assign({ signal: ctl.signal }, opts)); } finally { clearTimeout(timer); }
  }
  async function apiGet(action) {
    if (!GAS_API_URL) throw new Error('GASのURLが未設定です');
    const res = await fetchWithTimeout(GAS_API_URL + '?action=' + encodeURIComponent(action), { method: 'GET' });
    const json = await res.json();
    if (json.status !== 'success') throw new Error(json.message || '取得に失敗しました');
    return json.data;
  }
  // Content-Type: text/plain でプリフライトを避ける(GAS は OPTIONS に答えない)
  async function apiPost(action, payload) {
    if (!GAS_API_URL) throw new Error('GASのURLが未設定です');
    const res = await fetchWithTimeout(GAS_API_URL, {
      method: 'POST', headers: { 'Content-Type': 'text/plain;charset=utf-8' },
      body: JSON.stringify(Object.assign({ action }, payload)),
    }, 30000);
    const json = await res.json();
    if (json.status !== 'success') throw new Error(json.message || '処理に失敗しました');
    return json.data;
  }

  // ------------------------------------------------------------ IndexedDB(覚えたフォルダ)
  let dbp = null;
  function db() {
    if (!dbp) dbp = new Promise((res, rej) => {
      if (!window.indexedDB) { rej(new Error('IndexedDB が使えません')); return; }
      const r = window.indexedDB.open('spl-sheet-web', 1);
      r.onupgradeneeded = () => r.result.createObjectStore('kv');
      r.onsuccess = () => res(r.result);
      r.onerror = () => rej(r.error);
    });
    return dbp;
  }
  async function idbGet(key) {
    try {
      const d = await db();
      return await new Promise((res, rej) => { const q = d.transaction('kv').objectStore('kv').get(key); q.onsuccess = () => res(q.result); q.onerror = () => rej(q.error); });
    } catch (_) { return undefined; }
  }
  async function idbSet(key, val) {
    try {
      const d = await db();
      await new Promise((res, rej) => { const t = d.transaction('kv', 'readwrite'); t.objectStore('kv').put(val, key); t.oncomplete = res; t.onerror = () => rej(t.error); });
    } catch (_) { /* 覚えられなくても、次回もう一度選べばよい */ }
  }

  // ------------------------------------------------------------ ① Excel の取り込み

  async function loadExcel(file) {
    if (!file) return;
    if (!/\.xls[xm]$/i.test(file.name)) { toast('.xlsm か .xlsx を選んでください', 'error'); return; }
    if (state.dirty && !(await dialog('取り込み直しますか?', '表で直した内容はまだ保存していません。取り込み直すと消えます。',
      [{ label: '取り込み直す', value: true, cls: 'primary' }, { label: 'やめる', value: false }]))) return;
    busy(true, 'Excelを読んでいます…');
    try {
      const buf = await file.arrayBuffer();
      const rd = await window.splXlsm.read(window.JSZip, buf);
      state.excel = { name: file.name, buf, rows: rd.rows, kojiNo: rd.kojiNo };
    } catch (e) {
      busy(false);
      await dialog('Excelを読めませんでした', esc(e.message));
      return;
    }
    busy(false);
    renderExcelInfo();
    await reconcileKoji();
    if (state.joints) buildRows();
    else {
      state.rows = state.excel.rows.map(r => sc.refreshStatus(Object.assign({}, r, { drawing: null })));
      state.selected.clear();
      state.dirty = false;
      render();
    }
  }

  function kojiNameOf(no) {
    const hit = (state.kojiList || []).find(k => k[0] === no);
    return hit ? hit[1] : '';
  }
  function renderExcelInfo() {
    const ex = state.excel;
    if (!ex) return;
    const k = ex.kojiNo ? `Excelの工事番号 ${ex.kojiNo}` : 'Excelの工事番号: 読めませんでした(ﾃﾞｰﾀシートのE1・F1)';
    $('excel-info').innerHTML = `${esc(ex.name)}<br>${esc(k)} / SPLシート ${ex.rows.length}行`;
    $('step-excel').classList.toggle('done', !!currentKoji());
  }

  // ------------------------------------------------------------ 工事名(設定シートの一覧から選ぶ。2026-11-17 ユーザー指示)

  // 今の工事番号。一覧を読めなかったときだけ Excel の工事番号を使う
  function currentKoji() {
    if (state.kojiList) return state.koji;
    return state.excel ? state.excel.kojiNo : '';
  }
  const kojiLabel = no => no ? `${no}${kojiNameOf(no) ? ' ' + kojiNameOf(no) : ''}` : '';

  function renderKojiSelect() {
    const sel = $('koji-select');
    if (!state.kojiList) {
      sel.innerHTML = '<option value="">工事の一覧を読めませんでした(Excelの工事番号を使います)</option>';
      sel.disabled = true;
      sel.classList.remove('unset');
      return;
    }
    sel.disabled = false;
    sel.innerHTML = '<option value="">選択してください</option>'
      + state.kojiList.map(k => `<option value="${esc(k[0])}">${esc(k[0] + ' ' + k[1])}</option>`).join('');
    sel.value = state.koji;
    sel.classList.toggle('unset', !state.koji);
  }

  function setKoji(no) {
    state.koji = no || '';
    renderKojiSelect();
    renderExcelInfo();
  }

  // 選んだ工事と Excel の工事番号(ﾃﾞｰﾀ E1・F1)を合わせる。未選択なら Excel の工事を選ぶ。
  // 違うときはどちらにするか聞く
  async function reconcileKoji() {
    const ex = state.excel;
    if (!ex || !state.kojiList || !ex.kojiNo) { renderExcelInfo(); return; }
    const inList = state.kojiList.some(k => k[0] === ex.kojiNo);
    if (!state.koji) {
      if (inList) setKoji(ex.kojiNo);
      else await dialog('工事名を選んでください', `Excelの工事番号 ${esc(ex.kojiNo)} は工事の一覧にありません。工事名をリストから選んでください。`);
      return;
    }
    if (state.koji === ex.kojiNo) return;
    const v = await dialog('工事番号が違います',
      `選んだ工事は <b>${esc(kojiLabel(state.koji))}</b> です。<br>取り込んだExcelの工事番号(ﾃﾞｰﾀシートのE1・F1)は <b>${esc(ex.kojiNo)}</b> です。`,
      [{ label: '選んだ工事のまま進める', value: 'keep', cls: 'primary' }].concat(inList ? [{ label: `${ex.kojiNo} にする`, value: 'excel' }] : []));
    if (v === 'excel') setKoji(ex.kojiNo);
  }

  async function onKojiChange() {
    const prev = state.koji;
    const no = $('koji-select').value;
    setKoji(no);
    const ex = state.excel;
    if (no && ex && ex.kojiNo && no !== ex.kojiNo) {
      const ok = await dialog('工事番号が違います',
        `選んだ工事は <b>${esc(kojiLabel(no))}</b> です。<br>取り込んだExcelの工事番号(ﾃﾞｰﾀシートのE1・F1)は <b>${esc(ex.kojiNo)}</b> です。この工事で進めますか?`,
        [{ label: 'この工事で進める', value: true, cls: 'primary' }, { label: '元に戻す', value: false }]);
      if (!ok) setKoji(prev);
    }
  }

  // ------------------------------------------------------------ ② サーバーとフォルダ

  const serverLabel = n => /サーバー$/.test(n) ? n : n + 'サーバー';
  const serverPath = n => { const s = (state.servers || []).find(x => x[0] === n); return s ? s[1] : ''; };
  const kojiOfName = name => { const m = String(name).normalize('NFKC').match(/^(\d{2}-\d{2})(?![0-9])/); return m ? m[1] : null; };

  async function renderServerButtons() {
    // 覚えたフォルダを読み終えてから一度に入れ替える(描き直しが重なってもボタンが二重にならない)
    const saved = {};
    for (const [name] of state.servers) saved[name] = await idbGet('root:' + name);
    const box = $('server-btns');
    box.innerHTML = '';
    for (const [name] of state.servers) {
      const b = document.createElement('button');
      b.type = 'button';
      b.className = 'btn server';
      b.innerHTML = `<span></span><span class="sub"></span>`;
      b.firstChild.textContent = '📁 ' + serverLabel(name);
      b.lastChild.textContent = 'ファイルのあるフォルダを指定します';
      b.onclick = () => chooseFolder(name);
      box.appendChild(b);
    }
  }

  async function readMarks(dir) {
    const out = [];
    try {
      for await (const e of dir.values()) {
        if (e.kind !== 'file') continue;
        const m = e.name.normalize('NFKC').match(/^_(.+?)サーバー/);
        if (m && !out.includes(m[1])) out.push(m[1]);
      }
    } catch (_) { /* 読めなければ目印なし */ }
    return out;
  }

  async function hasPermission(h, ask) {
    try {
      if ((await h.queryPermission({ mode: 'read' })) === 'granted') return true;
      if (ask === false) return false;
      return (await h.requestPermission({ mode: 'read' })) === 'granted';
    } catch (_) { return false; }
  }

  async function pickDir(opts) {
    try {
      return await window.showDirectoryPicker(Object.assign({ mode: 'read' }, opts));
    } catch (e) {
      if (e.name === 'AbortError') return null;
      throw e;
    }
  }

  // サーバーの「①進行中工事」を選んで覚える(目印ファイルで確認)
  async function registerRoot(server) {
    for (;;) {
      const go = await dialog(`${serverLabel(server)}の「①進行中工事」を1回だけ選んでください`,
        '図面へのリンクと、実寸法師で開く機能のために、図面の場所を知る必要があります。<br>'
        + 'ブラウザは選んだフォルダの場所を教えてくれないので、最初の1回だけサーバーの「①進行中工事」を選んでください(このブラウザに覚えます)。<br>'
        + '<b>「①進行中工事」の中を探すことはしません。</b>図面は、このあと指定するフォルダの中から選んだファイルだけを読みます。',
        [{ label: '「①進行中工事」を選ぶ', value: true, cls: 'primary' }, { label: '今回はリンク無しで進める', value: false }]);
      if (!go) return null;
      // フォルダ選択の id は英数字だけ(日本語のサーバー名を入れると showDirectoryPicker がエラーになる)
      const h = await pickDir({ id: 'spl-root-' + Math.max(0, state.servers.findIndex(x => x[0] === server)) });
      if (!h) return null;
      if (kojiOfName(h.name) || h.name.includes('一般図')) {
        if (await dialog('「①進行中工事」を選んでください', `選んだのは「${esc(h.name)}」です。工事フォルダより1つ上の「①進行中工事」を選んでください。`,
          [{ label: '選び直す', value: true, cls: 'primary' }, { label: 'やめる', value: false }])) continue;
        return null;
      }
      const marks = await readMarks(h);
      if (marks.length && !marks.includes(server)) {
        if (await dialog('サーバーが違います', `選んだフォルダは${esc(marks.map(serverLabel).join('・'))}の「${esc(h.name)}」です(目印ファイルで確認)。${esc(serverLabel(server))}の「①進行中工事」を選び直してください。`,
          [{ label: '選び直す', value: true, cls: 'primary' }, { label: 'やめる', value: false }])) continue;
        return null;
      }
      if (!marks.length) {
        const v = await dialog('サーバーを確認できません', `選んだフォルダ「${esc(h.name)}」に目印ファイル(「_${esc(serverLabel(server))}…」で始まるファイル)がありません。${esc(serverLabel(server))}の「①進行中工事」で合っていますか?`,
          [{ label: 'このフォルダを使う', value: 'ok', cls: 'primary' }, { label: '選び直す', value: 'again' }, { label: 'やめる', value: 'stop' }]);
        if (v === 'again') continue;
        if (v === 'stop') return null;
      }
      await idbSet('root:' + server, h);
      toast(`${serverLabel(server)}の「${h.name}」を覚えました`);
      renderServerButtons();
      return h;
    }
  }

  async function chooseFolder(server) {
    if (!state.excel) { await dialog('先にExcelを取り込んでください', '① 入力データーのExcelを取り込んでから、フォルダを選んでください。'); return; }
    if (!currentKoji()) { await dialog('工事名を選んでください', '① の「工事名」をリストから選んでから、フォルダを選んでください。'); return; }
    if (!window.showDirectoryPicker) { await dialog('このブラウザでは使えません', 'Edge か Chrome で開いてください(フォルダを選ぶ機能を使います)。'); return; }
    if (state.dirty && !(await dialog('読み直しますか?', '表で直した内容はまだ保存していません。図面を読み直すと消えます。',
      [{ label: '読み直す', value: true, cls: 'primary' }, { label: 'やめる', value: false }]))) return;
    try {
      let root = await idbGet('root:' + server);
      if (root && !(await hasPermission(root))) {
        const v = await dialog('フォルダを読む許可がありません', `覚えている${esc(serverLabel(server))}の「${esc(root.name)}」を読む許可がありませんでした。もう一度許可するか、選び直してください。`,
          [{ label: 'もう一度許可する', value: 'retry', cls: 'primary' }, { label: '選び直す', value: 'repick' }, { label: 'やめる', value: 'stop' }]);
        if (v === 'stop') return;
        if (v === 'retry' && !(await hasPermission(root))) return;
        if (v === 'repick') root = null;
      }
      if (!root) root = await registerRoot(server); // 選ばなければ null(リンク無しで進める)

      // 前回この工事で選んだフォルダ
      const koji = currentKoji();
      const key = 'jf:' + server + ':' + koji;
      const last = await idbGet(key);
      let dir = null, rel = null;
      if (last && last.dir) {
        const v = await dialog('ファイルのあるフォルダ', `前回 ${esc(kojiLabel(koji))} で指定したフォルダ<br><b>${esc(last.rel.join('\\'))}</b><br>を使いますか?`,
          [{ label: 'このフォルダを使う', value: 'use', cls: 'primary' }, { label: '別のフォルダを選ぶ', value: 'pick' }, { label: 'やめる', value: 'stop' }]);
        if (v === 'stop') return;
        if (v === 'use' && (await hasPermission(last.dir))) { dir = last.dir; rel = last.rel; }
      }
      while (!dir) {
        const h = await pickDir(root ? { id: 'spl-joint', startIn: root } : { id: 'spl-joint' });
        if (!h) return;
        let r = null;
        if (root) { try { r = await root.resolve(h); } catch (_) { r = null; } }
        if (root && !r) {
          const v = await dialog('「①進行中工事」の中のフォルダではありません',
            `選んだ「${esc(h.name)}」は、${esc(serverLabel(server))}の「${esc(root.name)}」の中のフォルダとして確認できませんでした。<br>このままだと、図面へのリンクと実寸法師で開く機能が使えません。`,
            [{ label: '選び直す', value: 'again', cls: 'primary' }, { label: 'リンク無しで使う', value: 'nolink' }, { label: 'やめる', value: 'stop' }]);
          if (v === 'again') continue;
          if (v === 'stop') return;
        }
        dir = h; rel = r;
      }
      await loadFolder(server, dir, rel);
      if (rel) idbSet(key, { dir, rel });
    } catch (e) {
      busy(false);
      console.error(e);
      await dialog('フォルダを読めませんでした', esc(e.message));
    }
  }

  async function loadFolder(server, dir, rel) {
    const all = [];
    for await (const e of dir.values()) if (e.kind === 'file' && /\.tdf$/i.test(e.name)) all.push(e);
    if (!all.length) {
      await dialog('図面がありません', `「${esc(dir.name)}」には .tdf がありません。ファイルのあるフォルダを指定してください。`);
      return;
    }
    const chosen = await chooseFiles(dir.name, sc.sortDrawings(all.map(f => f.name)));
    if (!chosen) return;
    const files = all.filter(f => chosen.includes(f.name));
    const base = serverPath(server);
    const unc = rel && base ? base.replace(/[\\/]+$/, '') + '\\' + rel.join('\\') : '';
    busy(true, `図面を読んでいます…(${files.length}枚)`);
    const names = sc.sortDrawings(files.map(f => f.name));
    let joints = [];
    const failed = [];
    for (const name of names) {
      const fh = files.find(f => f.name === name);
      try {
        const bytes = new Uint8Array(await (await fh.getFile()).arrayBuffer());
        joints = joints.concat(sc.extractDrawing(name, bytes, unc ? unc + '\\' + name : ''));
      } catch (e) {
        console.error(name, e);
        failed.push(name);
      }
    }
    busy(false);
    state.folder = { server, dir, rel, unc, names };
    state.joints = joints;
    $('step-folder').classList.add('done');
    const zs = names.map(sc.zubanOf);
    $('folder-info').innerHTML = `${esc(serverLabel(server))}: ${esc(rel ? rel.join('\\') : dir.name)}<br>${names.length}枚(${esc(zs[0])}〜${esc(zs[zs.length - 1])}) ${joints.length}継手`
      + (unc ? '' : '<br><span class="warn">図面の場所が分からないため、リンクは付きません</span>');
    $('folder-info').classList.toggle('warn', !unc);
    if (failed.length) await dialog('読めなかった図面', esc(failed.join('\n')).replace(/\n/g, '<br>'));
    buildRows();
  }

  // 抽出するファイルを選ぶ。名前に「継手基準図」を含むものに最初から印を付ける。選んだ名前の配列(やめたら null)
  async function chooseFiles(folderName, names) {
    for (;;) {
      const items = names.map((n, i) => `<label class="file-item"><input type="checkbox" class="file-chk" data-i="${i}"${sc.isJointDrawing(n) ? ' checked' : ''}> ${esc(n)}</label>`).join('');
      const html = `<p>「${esc(folderName)}」の図面(${names.length}ファイル)から、抽出するファイルを選んでください。</p>`
        + '<div class="file-tools"><button type="button" class="btn" data-files="all">全部選ぶ</button><button type="button" class="btn" data-files="none">全部外す</button><button type="button" class="btn" data-files="joint">継手基準図だけ</button></div>'
        + `<div class="file-list">${items}</div>`;
      const ok = await dialog('抽出するファイルを選ぶ', html, [{ label: '抽出する', value: true, cls: 'primary' }, { label: 'やめる', value: false }]);
      if (!ok) return null;
      const picked = [...$('modal-body').querySelectorAll('.file-chk')].filter(c => c.checked).map(c => names[Number(c.dataset.i)]);
      if (picked.length) return picked;
      await dialog('ファイルを選んでください', '抽出するファイルを1つ以上選んでください。');
    }
  }

  // ------------------------------------------------------------ 突き合わせと表

  function buildRows() {
    state.rows = sc.merge(state.excel.rows, state.joints);
    state.selected.clear();
    state.dirty = false;
    render();
    const c = sc.counts(state.rows);
    if (c['違い'] || c['新規']) showDiffList();
    else dialog('最新図との照合', '最新図との食い違いはありませんでした。');
  }

  function jissunHref(path) {
    return 'jissun://' + encodeURIComponent(path);
  }

  function cellHtml(r, c) {
    let v = sc.fmt(r[c]);
    if ((c === 'A' || c === 'B') && r.drawing && r.drawing.tdf && v) {
      v = `<a href="${esc(jissunHref(r.drawing.tdf))}" title="実寸法師で ${esc(r.drawing.file)} を開く">${esc(v)}</a>`;
    } else v = esc(v);
    if (r.diff && c in r.diff) {
      v = (v || '空') + `<span class="dw">≠図 ${esc(sc.fmt(r.diff[c][1]) || '空')}</span>`;
    }
    return v;
  }

  function rowHtml(r, i) {
    const tds = [`<td class="c-sel"><input type="checkbox" class="sel" ${state.selected.has(i) ? 'checked' : ''}></td>`,
      `<td class="st-cell">${esc(r.status)}</td>`];
    for (const c of TABLE_COLS) {
      const cls = [LEFT_COLS.has(c) ? 'l' : '', r.diff && c in r.diff ? 'diff' : ''].filter(Boolean).join(' ');
      tds.push(`<td data-c="${c}"${cls ? ` class="${cls}"` : ''}>${cellHtml(r, c)}</td>`);
    }
    return `<tr data-i="${i}" class="st-${r.status}${state.selected.has(i) ? ' sel' : ''}">${tds.join('')}</tr>`;
  }

  function render() {
    const has = state.rows.length > 0;
    $('empty-state').hidden = has;
    $('table-wrap').hidden = !has;
    $('toolbar').hidden = !has;
    $('legend').hidden = !has;
    $('detail').hidden = true;
    const only = $('only-diff').checked;
    const html = [];
    state.rows.forEach((r, i) => {
      if (only && r.status !== '違い' && r.status !== '新規') return;
      html.push(rowHtml(r, i));
    });
    $('spl-table').tBodies[0].innerHTML = html.join('');
    renderCounts();
  }

  function rerenderRow(i) {
    const tr = $('spl-table').querySelector(`tr[data-i="${i}"]`);
    if (tr) tr.outerHTML = rowHtml(state.rows[i], i);
    renderCounts();
  }

  function renderCounts() {
    const c = sc.counts(state.rows);
    const chips = [['一致', c['一致']], ['違い', c['違い']], ['新規', c['新規']], ['手入力', c['手入力']]]
      .map(([k, n]) => `<span class="chip st-${k}">${k} ${n}</span>`);
    chips.unshift(`<span class="chip">全${state.rows.length}行</span>`);
    if (state.dirty) chips.push('<span class="chip" style="border-color:#c0392b;color:#c0392b">未保存の変更あり</span>');
    $('count-chips').innerHTML = chips.join('');
    $('btn-apply-sel').disabled = ![...state.selected].some(i => state.rows[i] && Object.keys(state.rows[i].diff || {}).length);
    $('btn-apply-all').disabled = !state.rows.some(r => r.drawing && Object.keys(r.diff || {}).length);
    $('btn-save').disabled = !state.excel || !state.rows.length;
    $('step-save').classList.toggle('done', !!state.excel && !!state.joints);
  }

  function showDetail(i) {
    const r = state.rows[i];
    if (!r) return;
    const lines = [`${sc.fmt(r.A)} ${sc.fmt(r.B)}  [${r.status}]` + (r.xrow ? `  Excel ${r.xrow}行目` : '  (新しく追加する行)')];
    if (r.drawing) {
      lines.push('図面: ' + (r.drawing.tdf || r.drawing.file));
      if (r.drawing.bolts.length) lines.push('図面のボルト: ' + r.drawing.bolts.join(' / '));
      if (r.drawing.warn.length) lines.push('読み取りで気になった所: ' + r.drawing.warn.join(' / '));
    }
    for (const k of Object.keys(r.diff || {})) lines.push(`  ${sc.COL_LABEL[k]}: 表 ${sc.fmt(r.diff[k][0]) || '空'} / 図面 ${sc.fmt(r.diff[k][1]) || '空'}`);
    $('detail-text').textContent = lines.join('\n');
    $('detail').hidden = false;
  }

  function showDiffList() {
    const c = sc.counts(state.rows);
    let html = `<p>一致 ${c['一致']}件 / <span class="dv">違い ${c['違い']}件</span> / 図面にだけある ${c['新規']}件 / 手入力(図面に無い・そのまま残す) ${c['手入力']}件</p>`;
    const dl = sc.diffList(state.rows);
    if (dl.length) {
      html += '<h3>最新図と違う継手(表の値はExcelのまま。「図面の値にする」で入れ替えできます)</h3><table><tr><th>図番</th><th>継手名</th><th>項目</th><th>Excel</th><th>最新図</th></tr>';
      for (const d of dl) d.items.forEach((it, k) => {
        html += `<tr>${k === 0 ? `<td rowspan="${d.items.length}">${esc(sc.fmt(d.row.A))}</td><td rowspan="${d.items.length}">${esc(sc.fmt(d.row.B))}</td>` : ''}`
          + `<td>${esc(it.label)}</td><td>${esc(sc.fmt(it.excel) || '空')}</td><td class="dv">${esc(sc.fmt(it.drawing) || '空')}</td></tr>`;
      });
      html += '</table>';
    }
    const nw = state.rows.filter(r => r.status === '新規');
    if (nw.length) html += '<h3>図面にあってExcelに無い継手(図面の値で行を追加しました)</h3><p>' + nw.map(r => esc(`${sc.fmt(r.A)} ${sc.fmt(r.B)}`)).join('、') + '</p>';
    const warns = state.rows.filter(r => r.drawing && r.drawing.warn.length);
    if (warns.length) html += '<h3>図面の読み取りで気になった所</h3><p>' + warns.map(r => esc(`${sc.fmt(r.A)} ${sc.fmt(r.B)}: ${r.drawing.warn.join(' / ')}`)).join('<br>') + '</p>';
    return dialog('最新図との食い違い', html, [{ label: '閉じる', value: true, cls: 'primary' }]);
  }

  // ------------------------------------------------------------ 編集

  function startEdit(td, i, c) {
    const r = state.rows[i];
    if (td.querySelector('input')) return;
    const inp = document.createElement('input');
    inp.value = sc.fmt(r[c]);
    td.innerHTML = '';
    td.appendChild(inp);
    inp.focus();
    inp.select();
    let done = false;
    const finish = save => {
      if (done) return;
      done = true;
      if (save) {
        const txt = inp.value.trim();
        let v = txt === '' ? null : txt;
        if (v != null && NUM_COLS.has(c)) {
          const n = Number(v.normalize('NFKC'));
          if (!Number.isFinite(n)) { toast(`${sc.COL_LABEL[c]} には数字を入れてください`, 'error'); rerenderRow(i); return; }
          v = n;
        }
        if (sc.normVal(v) !== sc.normVal(r[c])) {
          r[c] = v;
          sc.refreshStatus(r);
          state.dirty = true;
        }
      }
      rerenderRow(i);
      showDetail(i);
    };
    inp.addEventListener('keydown', e => {
      if (e.key === 'Enter' || e.key === 'Tab') { e.preventDefault(); finish(true); }
      else if (e.key === 'Escape') finish(false);
    });
    inp.addEventListener('blur', () => finish(true));
  }

  function applyRows(list) {
    let n = 0;
    for (const i of list) {
      const r = state.rows[i];
      if (r && r.drawing && Object.keys(r.diff || {}).length) { sc.applyDrawing(r); n++; }
    }
    if (n) state.dirty = true;
    render();
    return n;
  }

  // ------------------------------------------------------------ ③ 保存

  function stamp() {
    const d = new Date(), p = n => String(n).padStart(2, '0');
    return `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}_${p(d.getHours())}${p(d.getMinutes())}`;
  }

  async function save() {
    if (!state.excel || !state.rows.length) return;
    if (!state.joints && !(await dialog('図面をまだ読んでいません', '継手基準図をまだ読んでいません(リンクも付きません)。このまま保存しますか?',
      [{ label: '保存する', value: true, cls: 'primary' }, { label: 'やめる', value: false }]))) return;
    busy(true, 'Excelを作っています…');
    try {
      const w = await window.splXlsm.write(window.JSZip, state.excel.buf, state.rows,
        r => r.drawing && r.drawing.tdf ? window.splXlsm.fileUrl(r.drawing.tdf) : null);
      const base = state.excel.name.replace(/\.[^.]+$/, '');
      const fname = `${base}_SPL作成_${stamp()}.xlsm`;
      const blob = new Blob([w.bytes], { type: 'application/vnd.ms-excel.sheet.macroEnabled.12' });
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url; a.download = fname;
      document.body.appendChild(a); a.click(); a.remove();
      setTimeout(() => URL.revokeObjectURL(url), 2000);
      busy(false);
      state.dirty = false;
      renderCounts();
      toast('ダウンロードしました: ' + fname);
      record();
    } catch (e) {
      busy(false);
      console.error(e);
      await dialog('Excelを作れませんでした', esc(e.message));
    }
  }

  // 保存の中身をスプレッドシートへ(画面には何も出さない)
  function record() {
    const ex = state.excel;
    const zs = state.folder ? state.folder.names.map(sc.zubanOf) : [];
    const rows = state.rows.map(r => {
      const vals = {};
      for (const c of TABLE_COLS) vals[c] = r[c] == null ? '' : r[c];
      const note = Object.keys(r.diff || {}).map(k => `${sc.COL_LABEL[k]} 図面${sc.fmt(r.diff[k][1]) || '空'}`).join(' / ');
      return { status: r.status, diff: Object.keys(r.diff || {}), vals, note };
    });
    apiPost('onSave', {
      kojiNo: currentKoji(), excelName: ex.name, zubanRange: zs.length ? `${zs[0]}〜${zs[zs.length - 1]}(${zs.length}枚)` : '',
      counts: sc.counts(state.rows), applied: state.rows.filter(r => r.applied).length, rows,
    }).catch(() => {});
  }

  // ------------------------------------------------------------ イベント

  function bind() {
    // ファイル選択のダイアログの「全部選ぶ」「全部外す」「継手基準図だけ」
    $('modal-body').addEventListener('click', e => {
      const t = e.target.closest('[data-files]');
      if (!t) return;
      const box = $('modal-body');
      const names = [...box.querySelectorAll('.file-item')].map(l => l.textContent.trim());
      box.querySelectorAll('.file-chk').forEach((c, i) => {
        c.checked = t.dataset.files === 'all' || (t.dataset.files === 'joint' && sc.isJointDrawing(names[i]));
      });
    });
    $('btn-excel').onclick = () => $('excel-input').click();
    $('excel-input').onchange = e => { loadExcel(e.target.files[0]); e.target.value = ''; };
    $('btn-save').onclick = save;
    $('btn-diff').onclick = showDiffList;
    $('only-diff').onchange = render;
    $('btn-apply-sel').onclick = () => {
      const n = applyRows([...state.selected]);
      toast(n ? `${n}行を図面の値にしました` : '図面と違う行を選んでください', n ? '' : 'error');
    };
    $('btn-apply-all').onclick = async () => {
      const list = state.rows.map((r, i) => i).filter(i => state.rows[i].drawing && Object.keys(state.rows[i].diff || {}).length);
      if (!list.length) return;
      const names = list.map(i => esc(`${sc.fmt(state.rows[i].A)} ${sc.fmt(state.rows[i].B)}`)).join('<br>');
      if (!(await dialog('図面の値にします', `次の${list.length}行を最新図の値にします(丁番・ボルトは変えません)。<br><br>${names}`,
        [{ label: '図面の値にする', value: true, cls: 'primary' }, { label: 'やめる', value: false }]))) return;
      toast(`${applyRows(list)}行を図面の値にしました`);
    };

    const tbody = $('spl-table').tBodies[0];
    tbody.addEventListener('click', e => {
      const tr = e.target.closest('tr[data-i]');
      if (!tr) return;
      const i = Number(tr.dataset.i);
      if (e.target.classList.contains('sel')) {
        if (e.target.checked) state.selected.add(i); else state.selected.delete(i);
        tr.classList.toggle('sel', e.target.checked);
        renderCounts();
      }
      if (!e.target.closest('input[type=text], td input:not(.sel)')) showDetail(i);
    });
    tbody.addEventListener('dblclick', e => {
      const td = e.target.closest('td[data-c]');
      if (!td || e.target.closest('a')) return;
      const i = Number(td.parentElement.dataset.i), c = td.dataset.c;
      const r = state.rows[i];
      if ((c === 'A' || c === 'B') && r.drawing) { toast('図番・継手名は図面から入るので、ここでは変えられません'); return; }
      startEdit(td, i, c);
    });

    // ドロップで Excel を取り込む
    let depth = 0;
    window.addEventListener('dragenter', e => { if ([...(e.dataTransfer.types || [])].includes('Files')) { depth++; $('drop-overlay').classList.add('active'); } });
    window.addEventListener('dragleave', () => { if (--depth <= 0) { depth = 0; $('drop-overlay').classList.remove('active'); } });
    window.addEventListener('dragover', e => e.preventDefault());
    window.addEventListener('drop', e => {
      e.preventDefault();
      depth = 0;
      $('drop-overlay').classList.remove('active');
      const f = e.dataTransfer.files && e.dataTransfer.files[0];
      if (f) loadExcel(f);
    });
    window.addEventListener('beforeunload', e => { if (state.dirty) { e.preventDefault(); e.returnValue = ''; } });
  }

  async function init() {
    bind();
    // サーバー一覧・工事一覧(設定シート)
    try {
      const list = await apiGet('getServerPaths');
      state.servers = Array.isArray(list) && list.length ? list : DEFAULT_SERVERS;
    } catch (e) {
      state.servers = DEFAULT_SERVERS;
    }
    renderServerButtons();
    $('koji-select').onchange = onKojiChange;
    apiGet('getKojiList').then(l => {
      state.kojiList = Array.isArray(l) && l.length ? l : null;
    }).catch(() => { state.kojiList = null; }).then(() => {
      renderKojiSelect();
      reconcileKoji();
    });
    apiPost('logUsageStart', {}).catch(() => {});
  }

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', init); else init();
})();
