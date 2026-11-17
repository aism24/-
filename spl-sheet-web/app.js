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
  const LEFT_COLS = new Set(['S', 'T', 'U', 'V']);
  const CENTER_COLS = new Set(['A', 'B']); // 図番・継手名は中央揃え(2026-11-17 ユーザー指示)

  const state = {
    excel: null,     // { name, buf, rows, kojiNo }
    servers: null,   // [[名前, パス]]
    folder: null,    // { server, names:[選んだファイル名], unc:全部の場所が分かったか, summary:帯の1行 }
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

  // 設定シート(工事・サーバーの一覧)を読み込み中か。読み込み中は他の操作を受け付けない
  const settingsLoading = () => document.body.classList.contains('loading-settings');

  async function loadExcel(file) {
    if (!file || settingsLoading()) return;
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
  // ① 工事名と Excel がそろったら、選ぶ部品を隠して文字だけにする(2026-11-17 ユーザー指示。変えるときはリセット)
  function renderExcelInfo() {
    const ex = state.excel;
    const done = !!ex && !!currentKoji();
    $('excel-body').hidden = done;
    $('excel-done').hidden = !done;
    $('step-excel').classList.toggle('done', done);
    if (!ex) { $('excel-info').textContent = ''; return; }
    const k = ex.kojiNo ? `Excelの工事番号 ${ex.kojiNo}` : 'Excelの工事番号: 読めませんでした(ﾃﾞｰﾀシートのE1・F1)';
    $('excel-info').innerHTML = `${esc(ex.name)}<br>${esc(k)} / SPLシート ${ex.rows.length}行`;
    if (done) {
      $('excel-done').innerHTML = `工事名: <b>${esc(kojiLabel(currentKoji()))}</b><br>Excel: ${esc(ex.name)}(SPLシート ${ex.rows.length}行)`;
    }
  }

  // ------------------------------------------------------------ 工事名(設定シートの一覧から選ぶ。2026-11-17 ユーザー指示)

  // 今の工事番号。一覧を読めなかったときだけ Excel の工事番号を使う
  function currentKoji() {
    if (state.kojiList) return state.koji;
    return state.excel ? state.excel.kojiNo : '';
  }
  const kojiLabel = no => { const nm = no ? kojiNameOf(no) : ''; return no ? no + (nm ? ' ' + nm : '') : ''; };

  function renderKojiSelect() {
    const sel = $('koji-select');
    sel.classList.remove('loading');
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

  // 前回選んだ工事(このブラウザに覚える)を、次に開いたとき・リセットしたときの初期値にする(2026-11-17 ユーザー指示)
  const LAST_KOJI_KEY = 'spl-sheet-web:lastKoji';
  function lastKoji() {
    let no = '';
    try { no = localStorage.getItem(LAST_KOJI_KEY) || ''; } catch (_) { /* 覚えられない環境では初期値なし */ }
    return (state.kojiList || []).some(k => k[0] === no) ? no : '';
  }

  function setKoji(no) {
    state.koji = no || '';
    if (state.koji) { try { localStorage.setItem(LAST_KOJI_KEY, state.koji); } catch (_) { /* 覚えられなくてもよい */ } }
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
      b.lastChild.textContent = saved[name] ? '図面(TDF)を選びます' : '初回は「①進行中工事」→ 図面(TDF)';
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

  // サーバーの「①進行中工事」を選んで覚える(サーバーの確認と、図面の場所を知るためだけ。中は探さない)。
  // そのサーバーを覚えていないときだけ聞く(サーバーごとに1回。2026-11-17 ユーザー確定)。
  // 選ぶ前に注意のポップアップ、間違えたらもう一度「①進行中工事」を選ぶよう催促する(2026-11-17 ユーザー指示)。
  // 戻り値: フォルダ / null(リンク無しで進める) / 'cancel'(やめる)
  async function registerRoot(server) {
    const sv = esc(serverLabel(server));
    const go = await dialog(`⚠ 1回目は「①進行中工事」を選んでください(${sv}・初回だけ)`,
      `<div class="warn-box">次の画面では、<b>${sv}の「①進行中工事」</b>のフォルダを選んでください。<br>`
      + '<b>工事フォルダや「01.一般図」など、図面のあるフォルダではありません。</b></div>'
      + 'サーバーの確認と、図面へのリンク・実寸法師で開く機能のために使います(中を探すことはしません)。<br>'
      + `2回目に、図面(TDF)のあるフォルダまで下がってTDFファイルを選びます。次からは${sv}のボタンを押すと、TDFファイルを選ぶだけになります。`,
      [{ label: '「①進行中工事」を選ぶ', value: 'go', cls: 'primary' }, { label: '今回はリンク無しで進める', value: 'nolink' }, { label: 'やめる', value: 'cancel' }]);
    if (go === 'nolink') return null;
    if (go !== 'go') return 'cancel';
    for (;;) {
      // フォルダ選択の id は英数字だけ(日本語のサーバー名を入れると showDirectoryPicker がエラーになる)
      const h = await pickDir({ id: 'spl-root-' + Math.max(0, state.servers.findIndex(x => x[0] === server)) });
      if (!h) return 'cancel';
      // 間違えたときの催促
      const again = async msg => (await dialog('⚠ 「①進行中工事」ではありません',
        `<div class="warn-box">${msg}</div>もう一度、${sv}の「①進行中工事」を選んでください。`,
        [{ label: '「①進行中工事」を選び直す', value: true, cls: 'primary' }, { label: 'やめる', value: false }]));
      let hasTdf = false;
      try { for await (const e of h.values()) if (e.kind === 'file' && /\.tdf$/i.test(e.name)) { hasTdf = true; break; } } catch (_) { /* 読めなければ確かめない */ }
      if (kojiOfName(h.name) || hasTdf || h.name.includes('一般図')) {
        if (await again(`選んだのは「${esc(h.name)}」です。${kojiOfName(h.name) ? '工事フォルダ' : '図面のあるフォルダ'}ではなく、その上の階層にある「①進行中工事」を選んでください。`)) continue;
        return 'cancel';
      }
      const marks = await readMarks(h);
      if (marks.length && !marks.includes(server)) {
        if (await again(`選んだのは${esc(marks.map(serverLabel).join('・'))}の「${esc(h.name)}」です(目印ファイルで確認)。押したボタンは${sv}です。`)) continue;
        return 'cancel';
      }
      if (!marks.length) {
        const v = await dialog('サーバーを確認できません', `選んだフォルダ「${esc(h.name)}」に目印ファイル(「_${sv}…」で始まるファイル)がありません。${sv}の「①進行中工事」で合っていますか?`,
          [{ label: 'このフォルダを使う', value: 'ok', cls: 'primary' }, { label: '「①進行中工事」を選び直す', value: 'again' }, { label: 'やめる', value: 'stop' }]);
        if (v === 'again') continue;
        if (v !== 'ok') return 'cancel';
      }
      await idbSet('root:' + server, h);
      toast(`${serverLabel(server)}の「${h.name}」を覚えました`);
      return h;
    }
  }

  async function pickFiles(opts) {
    try {
      return await window.showOpenFilePicker(Object.assign({
        multiple: true,
        types: [{ description: '実寸法師の図面(.tdf)', accept: { 'application/octet-stream': ['.tdf'] } }],
      }, opts));
    } catch (e) {
      if (e.name === 'AbortError') return null;
      throw e;
    }
  }

  // サーバーのボタン: (覚えていなければ「①進行中工事」→)図面のあるフォルダまで下がって TDF ファイルを選ぶ
  async function chooseFolder(server) {
    if (!state.excel) { await dialog('先にExcelを取り込んでください', '① 入力データーのExcelを取り込んでから、図面を選んでください。'); return; }
    if (!currentKoji()) { await dialog('工事名を選んでください', '① の「工事名」をリストから選んでから、図面を選んでください。'); return; }
    if (!window.showOpenFilePicker || !window.showDirectoryPicker) { await dialog('このブラウザでは使えません', 'Chrome か Edge で開いてください(ファイルを選ぶ機能を使います)。'); return; }
    if (state.dirty && !(await dialog('読み直しますか?', '表で直した内容はまだ保存していません。図面を読み直すと消えます。',
      [{ label: '読み直す', value: true, cls: 'primary' }, { label: 'やめる', value: false }]))) return;
    try {
      const sv = esc(serverLabel(server));
      const saved = await idbGet('root:' + server);
      let root = saved && (await hasPermission(saved)) ? saved : null; // 許可が無ければ、場所の確認には使わない
      let first = false;
      if (!saved) {
        const r = await registerRoot(server);
        if (r === 'cancel') return;
        root = r;
        first = true;
      }

      // 選ぶ画面は、この工事で前回選んだ図面のフォルダ → ①進行中工事 の順に始める
      const key = 'jf:' + server + ':' + currentKoji();
      const last = await idbGet(key);
      const idx = Math.max(0, state.servers.findIndex(x => x[0] === server));
      let startIn = (last && last.file) || root || undefined;
      for (;;) {
        // 下層フォルダ(TDFのある場所)を選ぶ前の案内(2026-11-17 ユーザー指示)
        const go = await dialog(`${first ? '2回目: ' : ''}図面(TDF)ファイルを選んでください(${sv})`,
          '<div class="info-box">次の画面で、<b>図面(TDF)のあるフォルダ</b>(例: 工事フォルダ\\①-正光施工図\\01.一般図)<b>まで下がって</b>、'
          + '抽出するTDFファイルを選び「開く」を押してください。</div>'
          + '複数選ぶときは Ctrl+A(全部)か、Ctrl を押しながらクリックします。<br>選んだあとに確認が出るので、間違えたら「フォルダ選択に戻る」で選び直せます。',
          [{ label: 'TDFファイルを選ぶ', value: true, cls: 'primary' }, { label: 'やめる', value: false }]);
        if (!go) return;
        const files = await pickFiles(startIn ? { id: 'spl-files-' + idx, startIn } : { id: 'spl-files-' + idx });
        if (!files || !files.length) return;
        startIn = files[0]; // 戻ったときは、今選んだフォルダから始める
        // ①進行中工事から各ファイルまでの道筋(図面の場所)
        let rels = [];
        if (root) for (const f of files) { let r = null; try { r = await root.resolve(f); } catch (_) { r = null; } rels.push(r); }
        if (root && rels.some(r => !r)) {
          const v = await dialog(`${sv}のファイルではありません`,
            `選んだファイルは、${sv}の「${esc(root.name)}」の中にありませんでした(別のサーバーの図面かもしれません)。<br>サーバーのボタンを確かめてください。このまま使うと、図面へのリンクと実寸法師で開く機能が使えません。`,
            [{ label: 'フォルダ選択に戻る', value: 'again', cls: 'primary' }, { label: 'リンク無しで使う', value: 'nolink' }, { label: 'やめる', value: 'stop' }]);
          if (v === 'again') continue;
          if (v !== 'nolink') return;
          rels = [];
        }
        // 選んだファイルの確認(間違えたら「フォルダ選択に戻る」。2026-11-17 ユーザー指示)
        // ファイル名に「継手基準図」が入っていることは珍しいので、名前では確かめない(2026-11-17 ユーザー指示)
        const names = sc.sortDrawings(files.map(f => f.name));
        const folder = rels.length ? rels[0].slice(0, -1).join('\\') : '';
        const v = await dialog('選んだ図面の確認',
          (folder ? `フォルダ: <b>${esc(folder)}</b><br>` : '')
          + `${names.length}ファイル`
          + `<div class="name-list">${names.map(n => esc(n)).join('<br>')}</div>`,
          [{ label: 'この図面で抽出する', value: 'ok', cls: 'primary' }, { label: 'フォルダ選択に戻る', value: 'back' }, { label: 'やめる', value: 'stop' }]);
        if (v === 'back') continue;
        if (v !== 'ok') return;
        await loadFiles(server, files, rels.length ? rels : null);
        if (rels.length) idbSet(key, { file: files[0] });
        return;
      }
    } catch (e) {
      busy(false);
      console.error(e);
      await dialog('図面を読めませんでした', esc(e.message));
    }
  }

  // 選んだ TDF ファイルを読む。rels: ①進行中工事から各ファイルまでの道筋(分からなければ null)
  async function loadFiles(server, handles, rels) {
    const base = serverPath(server).replace(/[\\/]+$/, '');
    const items = handles.map((h, i) => ({ h, name: h.name, rel: rels ? rels[i] : null }));
    const pathOf = it => (it.rel && base ? base + '\\' + it.rel.join('\\') : '');
    const names = sc.sortDrawings(items.map(it => it.name));
    busy(true, `図面を読んでいます…(${names.length}枚)`);
    const joints = [];
    const failed = [];
    const byName = new Map(items.map(it => [it.name, it]));
    for (const name of names) {
      const it = byName.get(name);
      try {
        const bytes = new Uint8Array(await (await it.h.getFile()).arrayBuffer());
        joints.push(...sc.extractDrawing(name, bytes, pathOf(it)));
      } catch (e) {
        console.error(name, e);
        failed.push(name);
      }
    }
    busy(false);
    const folders = [...new Set(items.map(it => it.rel ? it.rel.slice(0, -1).join('\\') : ''))];
    const unc = items.every(it => pathOf(it));
    state.folder = { server, names, unc };
    state.joints = joints;
    // ② 選び終わったら文字だけにする(変えるときはリセット)
    $('step-folder').classList.add('done');
    $('folder-body').hidden = true;
    $('folder-done').hidden = false;
    const zs = names.map(sc.zubanOf);
    const where = folders[0] ? folders.join(' / ') : '(場所は不明)';
    $('folder-done').innerHTML = `<b>${esc(serverLabel(server))}</b>: ${esc(where)}<br>${names.length}枚(${esc(zs[0])}〜${esc(zs[zs.length - 1])}) ${joints.length}継手`
      + (unc ? '' : '<br><span class="warn">図面の場所が分からないため、リンクは付きません</span>');
    // 表の上の1行用
    state.folder.summary = `${serverLabel(server)}: ${where} ${names.length}枚(${zs[0]}〜${zs[zs.length - 1]}) ${joints.length}継手` + (unc ? '' : '(リンク無し)');
    if (failed.length) await dialog('読めなかった図面', esc(failed.join('\n')).replace(/\n/g, '<br>'));
    if (!joints.length) {
      await dialog('継手が見つかりませんでした', '選んだ図面から継手を読めませんでした。継手基準図(J-01 など)を選んでいるか確かめてください。');
    }
    buildRows();
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
    // 元の行: 取り込んだExcelのSPLシートの行番号(図面から足した行は空。どの行が違うかを見るため。2026-11-17 ユーザー指示)
    const tds = [`<td class="c-sel"><input type="checkbox" class="sel" ${state.selected.has(i) ? 'checked' : ''}></td>`,
      `<td class="c-row">${r.xrow || ''}</td>`,
      `<td class="st-cell">${esc(r.status)}</td>`];
    for (const c of TABLE_COLS) {
      const cls = [LEFT_COLS.has(c) ? 'l' : CENTER_COLS.has(c) ? 'c' : '', r.diff && c in r.diff ? 'diff' : ''].filter(Boolean).join(' ');
      tds.push(`<td data-c="${c}"${cls ? ` class="${cls}"` : ''}>${cellHtml(r, c)}</td>`);
    }
    return `<tr data-i="${i}" class="st-${r.status}${state.selected.has(i) ? ' sel' : ''}">${tds.join('')}</tr>`;
  }

  function render() {
    const has = state.rows.length > 0;
    $('empty-state').hidden = has;
    $('table-wrap').hidden = !has;
    $('toolbar').hidden = !has;
    // ①②がそろって表が出たら、枠を隠して1行にまとめる
    const compact = has && !!state.excel && !!state.joints && !!currentKoji();
    $('steps').hidden = compact;
    $('summary-line').hidden = !compact;
    if (compact) {
      const t = `① ${state.excel.name}　② ${state.folder ? state.folder.summary : ''}`;
      $('summary-line').textContent = t;
      $('summary-line').title = `工事名: ${kojiLabel(currentKoji())}
${t}`;
    }
    $('detail').hidden = true;
    const only = $('only-diff').checked;
    const html = [];
    state.rows.forEach((r, i) => {
      if (only && r.status !== '違い' && r.status !== '新規') return;
      html.push(rowHtml(r, i));
    });
    $('spl-table').tBodies[0].innerHTML = html.join('');
    // 見出し2段目(板厚・幅…)は、1段目の実際の高さの下で止める(1段目に注記が入り2行になったため)
    const h1 = $('spl-table').querySelector('.head1');
    if (h1 && h1.offsetHeight) $('spl-table').querySelectorAll('.head2 th').forEach(th => { th.style.top = h1.offsetHeight + 'px'; });
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
      html += '<h3>最新図と違う継手(表の値はExcelのまま。「図面の値にする」で入れ替えできます)</h3><table><tr><th>元の行</th><th>図番</th><th>継手名</th><th>項目</th><th>Excel</th><th>最新図</th></tr>';
      for (const d of dl) d.items.forEach((it, k) => {
        html += `<tr>${k === 0 ? `<td rowspan="${d.items.length}">${d.row.xrow || ''}</td><td rowspan="${d.items.length}">${esc(sc.fmt(d.row.A))}</td><td rowspan="${d.items.length}">${esc(sc.fmt(d.row.B))}</td>` : ''}`
          + `<td>${esc(it.label)}</td><td>${esc(sc.fmt(it.excel) || '空')}</td><td class="dv">${esc(sc.fmt(it.drawing) || '空')}</td></tr>`;
      });
      html += '</table>';
    }
    const nw = state.rows.filter(r => r.status === '新規');
    if (nw.length) html += '<h3>図面にあってExcelに無い継手(図面の値で行を追加しました)</h3><p>' + nw.map(r => esc(`${sc.fmt(r.A)} ${sc.fmt(r.B)}`)).join('、') + '</p>';
    const warns = state.rows.filter(r => r.drawing && r.drawing.warn.length);
    if (warns.length) html += '<h3>図面の読み取りで気になった所</h3><p>' + warns.map(r => esc(`${r.xrow ? r.xrow + '行 ' : ''}${sc.fmt(r.A)} ${sc.fmt(r.B)}:${r.drawing.warn.join(' / ')}`)).join('<br>') + '</p>';
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

  // ------------------------------------------------------------ リセット(初期状態に戻る。覚えたサーバーのフォルダはそのまま)

  async function resetAll() {
    const any = state.excel || state.joints || state.koji;
    if (!any) return;
    const msg = state.dirty ? '表で直した内容はまだ保存していません。リセットすると消えます。' : '取り込んだExcelと図面を外して、最初の状態に戻します。';
    if (!(await dialog('リセットしますか?', msg, [{ label: 'リセットする', value: true, cls: 'primary' }, { label: 'やめる', value: false }]))) return;
    state.excel = null;
    state.folder = null;
    state.joints = null;
    state.rows = [];
    state.selected.clear();
    state.dirty = false;
    state.koji = lastKoji();
    $('only-diff').checked = false;
    renderKojiSelect();
    renderExcelInfo();
    $('folder-body').hidden = false;
    $('folder-done').hidden = true;
    $('folder-done').textContent = '';
    $('step-folder').classList.remove('done');
    render();
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
        r => r.drawing && r.drawing.tdf ? window.splXlsm.fileUrl(r.drawing.tdf) : null,
        r => r.xrow || null); // W列「元の行」
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
    $('btn-excel').onclick = () => $('excel-input').click();
    $('excel-input').onchange = e => { loadExcel(e.target.files[0]); e.target.value = ''; };
    $('btn-save').onclick = save;
    $('btn-reset').onclick = resetAll;
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
    window.addEventListener('dragenter', e => { if (!settingsLoading() && [...(e.dataTransfer.types || [])].includes('Files')) { depth++; $('drop-overlay').classList.add('active'); } });
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

  // ------------------------------------------------------------ 設定シート(サーバー一覧・工事一覧)
  // 前回読んだ一覧をこのブラウザに覚えておき、開いた瞬間に出す。裏で読み直して、変わっていれば入れ替える。
  // 覚えた一覧が無い(初めて)ときだけ、読み終えるまでグレーアウトする(2026-11-17 ユーザー承認)
  const SETTINGS_KEY = 'spl-sheet-web:settings';
  const validSettings = s => !!s && Array.isArray(s.servers) && s.servers.length > 0 && Array.isArray(s.koji) && s.koji.length > 0;

  function cachedSettings() {
    try { const s = JSON.parse(localStorage.getItem(SETTINGS_KEY) || 'null'); return validSettings(s) ? s : null; } catch (_) { return null; }
  }

  // { servers, koji }。読めなければ null
  async function fetchSettings() {
    try {
      const d = await apiGet('getSettings');
      return d && Array.isArray(d.servers) && Array.isArray(d.koji) ? d : null;
    } catch (e) {
      // GAS が前の版(getSettings が無い)のときだけ、前の2つを同時に読む
      if (!/不明なaction/.test(e.message)) return null;
      const [servers, koji] = await Promise.all(['getServerPaths', 'getKojiList'].map(a => apiGet(a).catch(() => null)));
      return { servers: Array.isArray(servers) ? servers : [], koji: Array.isArray(koji) ? koji : [] };
    }
  }

  function applySettings(s) {
    state.servers = s && s.servers.length ? s.servers : DEFAULT_SERVERS;
    state.kojiList = s && s.koji.length ? s.koji : null;
    if (state.koji && !(state.kojiList || []).some(k => k[0] === state.koji)) state.koji = '';
    if (!state.koji) state.koji = lastKoji();
    renderServerButtons();
    renderKojiSelect();
    renderExcelInfo();
  }

  async function init() {
    bind();
    $('koji-select').onchange = onKojiChange;
    const cached = cachedSettings();
    if (cached) {
      applySettings(cached);
      document.body.classList.remove('loading-settings');
    }
    apiPost('logUsageStart', {}).catch(() => {});
    const fresh = await fetchSettings();
    if (validSettings(fresh)) { try { localStorage.setItem(SETTINGS_KEY, JSON.stringify(fresh)); } catch (_) { /* 覚えられなくてもよい */ } }
    if (cached) {
      // 読み直せなかった・変わっていなければそのまま
      if (fresh && (fresh.servers.length || fresh.koji.length) && JSON.stringify(fresh) !== JSON.stringify(cached)) applySettings(fresh);
      return;
    }
    applySettings(fresh);
    document.body.classList.remove('loading-settings'); // 読み終えた(読めなかったときも)ので操作できるようにする
    reconcileKoji();
  }

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', init); else init();
})();
