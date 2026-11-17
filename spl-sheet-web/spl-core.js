// 継手基準図(.tdf)からSPLシートの値を読み、取り込んだExcelのSPLシートと突き合わせる(画面に依存しない部分)。
// ブラウザでは window.splCore、Node(確認用)では require で使う。
//
// SPLシートの列: A図番 B継手名 C1セット重量(式) D〜H Fr外(重量式・板厚・幅・長さ・枚数)
// I〜M Fr内 N〜R Web S フィラープレート T 丁番 U SPL V ボルト
//
// 図面の読み方(25-19 の J-01〜J-12 で確認、2026-11-17):
// - 継手名 = 図面の中でいちばん大きい英数字の文字(例 GJ194)。名前1つを1区画とし、区画の大きさは名前の並びの間隔で決める
// - 「FLG」の行の「1 SPL-9x150x290」→ Fr外、その下の行 → Fr内、「WEB」の行 → Web
// - 枚数はフランジが図の数字×2(上下)、Webは図の数字のまま
// - 「2fill.PL-1.6x200x80」→ S列「PL1.6」。SPLがある継手は U列「有」
// - GPL(ガセット)だけの継手は継手名だけの行
(function (root) {
  'use strict';

  const VALUE_COLS = ['A', 'B', 'E', 'F', 'G', 'H', 'J', 'K', 'L', 'M', 'O', 'P', 'Q', 'R', 'S', 'T', 'U', 'V'];
  // 図面と比べる列(T丁番・Vボルトは最後に調整するので比べない。ユーザー指示 2026-11-17)
  const CMP_COLS = ['E', 'F', 'G', 'H', 'J', 'K', 'L', 'M', 'O', 'P', 'Q', 'R', 'S', 'U'];
  const GROUP_COLS = { 'Fr外': ['E', 'F', 'G', 'H'], 'Fr内': ['J', 'K', 'L', 'M'], 'Web': ['O', 'P', 'Q', 'R'] };
  const COL_LABEL = {
    A: '図番', B: '継手名',
    E: 'Fr外 板厚', F: 'Fr外 幅', G: 'Fr外 長さ', H: 'Fr外 枚数',
    J: 'Fr内 板厚', K: 'Fr内 幅', L: 'Fr内 長さ', M: 'Fr内 枚数',
    O: 'Web 板厚', P: 'Web 幅', Q: 'Web 長さ', R: 'Web 枚数',
    S: 'フィラー', T: '丁番', U: 'SPL', V: 'ボルト',
  };

  // 継手名(NFKC で揃えてから見る)。英字か□で始まり、数字を含む。
  // 26-16 の形(zGJ70・b2・zb3G・V3z・B24-16・CG1000A・TB587AGP・□100・EP□100)も受ける(2026-11-17)
  const NAME_RE = /^[A-Za-z□][A-Za-z]{0,5}□?[0-9]{1,4}[A-Za-z]{0,4}(?:-[0-9]{1,2})?$/;
  // 継手名の形でも、材質・ボルトの文字は継手名にしない(26-16 J-01A の BCP325・STKN490B、26-17 の SN490C・M16 など)
  const NOT_NAME_RE = /^(?:SN|SM|SS|STK|STKN|STKR|BCP|BCR|TMCP|SNR|SHN|SWH|SD)[0-9]{3}[A-Z]{0,2}$|^M[0-9]{2}$/;
  const isName = s => { const t = String(s).normalize('NFKC'); return NAME_RE.test(t) && !NOT_NAME_RE.test(t); };
  const SPL_RE = /^(\d+)\s*SPL-(\d+(?:\.\d+)?)x(\d+(?:\.\d+)?)x(\d+(?:\.\d+)?)$/;
  const FILL_RE = /^(\d+)\s*fill\.PL-(\d+(?:\.\d+)?)x(\d+(?:\.\d+)?)x(\d+(?:\.\d+)?)$/;
  const BOLT_RE = /^(\d+)-M(\d+)$/;
  const ZUBAN_RE = /([A-Z]{1,2}-\d+[A-Z]?)\s*[(（]/;

  // ---------------------------------------------------------------- 値の扱い

  const nfkc = s => String(s == null ? '' : s).normalize('NFKC');
  const normName = s => nfkc(s).trim();

  // 比べるための値。空は null、数値は数、文字は前後の空白を除く(数字だけの文字は数にする)
  function normVal(v) {
    if (v == null) return null;
    if (typeof v === 'number') return v;
    const s = nfkc(v).trim();
    if (s === '') return null;
    if (/^[-+]?(\d+\.?\d*|\.\d+)(e[-+]?\d+)?$/i.test(s)) return Number(s);
    return s;
  }

  function fmt(v) {
    if (v == null) return '';
    if (typeof v === 'number') return String(Number.isInteger(v) ? v : Number(v.toPrecision(12)));
    return String(v);
  }

  // ---------------------------------------------------------------- .tdf の文字を読む
  // (tdf-master-web/scripts/tdf_binary.py の _parse_texts と同じ読み方。文字だけ使う)
  //   マーカー「00 N (2*N) 00」(N=1〜63)の52バイト前からが文字の記録:
  //   [4][X,Y,H,W,回転: double×5][4][id:4] マーカー(4) val1,val2(4×2) 文字(cp932)
  //   文字を持たない「参照」は id で同じ文字の「本体」を指す

  let sjis = null;
  function decodeSjis(bytes) {
    if (!sjis) sjis = new TextDecoder('shift_jis', { fatal: true });
    try { return sjis.decode(bytes); } catch (_) { return null; }
  }

  function parseTdfTexts(data) {
    const dv = new DataView(data.buffer, data.byteOffset, data.byteLength);
    const recs = [];
    const len = data.length;
    for (let idx = 0; idx + 3 < len; idx++) {
      if (data[idx] !== 0 || data[idx + 3] !== 0) continue;
      const n = data[idx + 1];
      if (n < 1 || n > 63 || data[idx + 2] !== n * 2) continue;
      const st = idx - 52;
      if (st < 0 || idx + 12 > len) continue;
      const x = dv.getFloat64(st + 4, true), y = dv.getFloat64(st + 12, true), h = dv.getFloat64(st + 20, true);
      const rot = dv.getFloat64(st + 36, true);
      const id = dv.getUint32(st + 48, true);
      const val1 = dv.getInt32(idx + 4, true);
      let text = null;
      const tl = val1 - 8, ts = idx + 12;
      if (tl > 0 && tl <= 200 && ts + tl <= len) {
        let raw = data.subarray(ts, ts + tl);
        const nul = raw.indexOf(0);
        if (nul !== -1) raw = raw.subarray(0, nul);
        if (raw.length) text = decodeSjis(raw);
      }
      recs.push({ x, y, h, rot, id, text });
    }
    const body = new Map();
    for (const r of recs) if (r.text != null && !body.has(r.id)) body.set(r.id, r.text);
    const out = [];
    for (const r of recs) {
      const s = r.text != null ? r.text : body.get(r.id);
      if (s && s.trim()) out.push({ x: r.x, y: -r.y, s: s.trim(), h: r.h });
    }
    return out; // y は下向き(図の上の方が小さい)
  }

  // ---------------------------------------------------------------- 継手基準図を読む

  // 名前の並び(x または y)から1区画の大きさを求める。いちばん多い間隔を使う。
  // 名前が1列(1行)だけで間隔が無いときは、区切らない(Infinity)。
  // 26-14 は1行だけの図面が多く、表の文字が名前の4,650下にあって、25-19 の大きさ(3,453)では区画の外になっていた
  function step(values, typical) {
    const vs = [...new Set(values.map(v => Math.round(v)))].sort((a, b) => a - b);
    const cnt = new Map();
    for (let i = 1; i < vs.length; i++) {
      const g = vs[i] - vs[i - 1];
      if (g > typical * 0.3) {
        const k = Math.round(g / 10) * 10;
        cnt.set(k, (cnt.get(k) || 0) + 1);
      }
    }
    let best = null, bc = 0;
    for (const [k, c] of cnt) if (c > bc) { best = k; bc = c; }
    return best == null ? Infinity : best;
  }

  // ファイル名から図番。「24.J-03(継手基準図).tdf」→ J-03、「70CJ-01.tdf」→ CJ-01(26-17)
  function zubanOf(fileName) {
    const m = String(fileName).match(ZUBAN_RE);
    if (m) return m[1];
    const stem = String(fileName).replace(/\.[^.]*$/, '');
    const m2 = stem.match(/^\d+\.?([A-Z]{1,3}-\d+[A-Z]?)$/);
    return m2 ? m2[1] : stem;
  }

  // 図面の中に書かれた図番(いちばん大きい「CJ-01」の形の文字。本文より大きいものだけ)
  const DRAWING_NO_RE = /^[A-Z]{1,3}-\d+[A-Z]?$/;
  function zubanInDrawing(ts, bodyH) {
    let best = null;
    for (const t of ts) {
      const s = nfkc(t.s);
      if (!DRAWING_NO_RE.test(s) || /^G?PL-/.test(s) || t.h <= bodyH * 1.2) continue;
      if (!best || t.h > best.h) best = { s, h: t.h };
    }
    return best ? best.s : null;
  }

  function sortDrawings(names) {
    const key = n => {
      const z = zubanOf(n);
      const m = z.match(/^([A-Z]+)-(\d+)([A-Z]?)/);
      return m ? [m[1], Number(m[2]), m[3]] : [z, 0, ''];
    };
    return names.slice().sort((a, b) => {
      const ka = key(a), kb = key(b);
      for (let i = 0; i < 3; i++) if (ka[i] !== kb[i]) return ka[i] < kb[i] ? -1 : 1;
      return 0;
    });
  }

  // 1枚の継手基準図から継手の一覧を作る。path は図面の場所(リンク用。無くてもよい)
  function extractDrawing(fileName, bytes, path) {
    const ts = parseTdfTexts(bytes);
    // 本文の文字の高さ(いちばん多い高さ。SPL の無い GPL だけの図面もあるので全部の文字で見る)
    const hc = new Map();
    for (const t of ts) { const k = Math.round(t.h); hc.set(k, (hc.get(k) || 0) + 1); }
    let bodyH = 0, bc = 0;
    for (const [k, c] of hc) if (c > bc) { bodyH = k; bc = c; }
    // 継手名が表の文字より大きい図面(25-19・26-14・26-16)は、いちばん大きい名前の形の文字を継手名にする。
    // 全部同じ大きさの図面(26-17 阪和)は大きさで見分けられないので、名前に「J」を含むものだけを継手名にする
    // (同じ区画に部材名「P17」と継手名「PJ17」が並ぶため)
    let cand = ts.filter(t => isName(t.s));
    if (!cand.length) return [];
    let hmax = Math.max(...cand.map(t => t.h));
    if (bodyH && hmax <= bodyH * 1.05) {
      cand = ts.filter(t => { const s = nfkc(t.s); return (isName(s) || /^[A-Z]{1,4}J[A-Z]{1,2}$/.test(s)) && s.includes('J'); });
      if (!cand.length) return [];
      hmax = Math.max(...cand.map(t => t.h));
    }
    const scale = hmax / 80;
    // 同じ継手名が1枚に2回以上あるときは、いちばん上(左)の区画の見出しだけを使う
    // (26-17 の DCJ1 などは、区画の見出しと、その中の図の書き込みに同じ名前がある)
    const seen = new Set();
    const names = cand.filter(t => t.h >= hmax * 0.99).sort((a, b) => a.y - b.y || a.x - b.x)
      .filter(t => { const k = nfkc(t.s); if (seen.has(k)) return false; seen.add(k); return true; });
    const cw = step(names.map(n => n.x), 3148 * scale);
    const ch = step(names.map(n => n.y), 3453 * scale);
    const left = 450 * scale; // 表の文字は名前より少し右から始まる。この分だけ左へ余裕を持たせる

    const owner = (x, y) => {
      let best = null;
      for (const n of names) {
        if (!(n.x - left <= x && x < n.x - left + cw && n.y - 20 * scale <= y && y < n.y + ch - 20 * scale)) continue;
        if (!best || (y - n.y) < (y - best.y) || ((y - n.y) === (y - best.y) && (x - n.x) < (x - best.x))) best = n;
      }
      return best;
    };

    const zuban = zubanInDrawing(ts, bodyH || hmax) || zubanOf(fileName);
    const order = names.slice().sort((a, b) => a.y - b.y || a.x - b.x);
    const joints = new Map();
    for (const n of order) joints.set(n, { A: zuban, B: n.s, tdf: path || '', file: fileName, bolts: [], warn: [] });
    // 「上FLG」「下FLG」(上下でSPLを分けた継手。26-14 NJ-05)も FLG として見る
    const labels = ts.filter(t => /^(上|下)?FLG$/.test(t.s) || t.s === 'WEB');
    // 上の行から順に見る(「FLG の行の下の行 = Fr内」を、ファイル内の文字の順番に左右されずに決めるため)
    const byPos = ts.slice().sort((a, b) => a.y - b.y || a.x - b.x);
    const splInfo = new Map(); // 継手ごとの SPL の行数と、FLG/WEB の見出しがあったか
    for (const t of byPos) {
      const ms = t.s.match(SPL_RE), mf = t.s.match(FILL_RE), mb = t.s.match(BOLT_RE);
      if (!ms && !mf && !mb) continue;
      const n = owner(t.x, t.y);
      if (!n) continue;
      const j = joints.get(n);
      if (mb) { j.bolts.push(t.s); continue; }
      if (mf) { j.S = 'PL' + fmt(Number(mf[2])); continue; }
      const cnt = Number(ms[1]), th = Number(ms[2]), a = Number(ms[3]), b = Number(ms[4]);
      const lab = labels.find(l => Math.abs(l.y - t.y) < 20 * scale && t.x - l.x > 0 && t.x - l.x < 400 * scale);
      const info = splInfo.get(j) || { lines: 0, labeled: false, side: null, split: null };
      info.lines++; if (lab) info.labeled = true;
      splInfo.set(j, info);
      // SPL分割(「上FLG」「下FLG」の見出し。26-14 NGF488DK など): 上下のフランジの行を別にためて、下でまとめる
      if (lab) info.side = /^(上|下)FLG$/.test(lab.s) ? lab.s[0] : null;
      if (info.side) {
        if (!info.split) info.split = { 上: [], 下: [] };
        info.split[info.side].push({ cnt, th, a, b });
        continue;
      }
      let kind;
      if (lab) kind = lab.s === 'WEB' ? 'Web' : 'Fr外';
      else kind = 'E' in j ? 'Fr内' : 'Web';
      const cols = GROUP_COLS[kind];
      if (cols[0] in j) { j.warn.push(`${kind}が2つあります: ${t.s}`); continue; }
      [th, a, b, cnt].forEach((v, i) => { j[cols[i]] = v; }); // フランジの枚数は下で決める
    }
    return order.map(n => {
      const j = joints.get(n);
      // 柱のエレクションピース: FLG/WEB の見出しが無く SPL が1行だけの区画(26-16 J-01 CJ1「2 SPL-12x100x455」)。
      // 4方向に付き、図の数字は1か所ぶんなので、Fr外 に 図の数字×4 を入れる(Excel の書き方。2026-11-17 ユーザー確認)
      const info = splInfo.get(j);
      if (info && !info.labeled && info.lines === 1 && 'O' in j) {
        [['E', 'O'], ['F', 'P'], ['G', 'Q'], ['H', 'R']].forEach(([to, from]) => { j[to] = j[from]; delete j[from]; });
        j.H *= 4;
        j.warn.push('エレクションピース(4方向)として読みました: Fr外 枚数 = 図の数字×4');
      }
      // SPL分割: 行は上から重なる順(上FLG は 外→内、下FLG は 内→外)。
      // 外が内と同じ寸法なら「分割した外」。分割した外は Fr内 に数え、Fr外 には大きい外だけを入れる
      // (DK・UK: Fr外 300x1 / Fr内 110x6、UDK: Fr外 なし / Fr内 110x8。2026-11-17 ユーザー指示)
      const sp = info && info.split;
      if (sp && sp.上.length && sp.下.length) {
        const up = sp.上, lo = sp.下;
        const outers = [up[0], lo[lo.length - 1]];
        const inners = up.slice(1).concat(lo.slice(0, -1));
        const same = (p, q) => p && q && p.th === q.th && p.a === q.a && p.b === q.b;
        const inner = inners[0];
        const splitOuter = outers.filter(o => same(o, inner));
        const bigOuter = outers.filter(o => !same(o, inner));
        const sum = list => list.reduce((s, p) => s + p.cnt, 0);
        const put = (cols, p, n) => { if (p) [p.th, p.a, p.b, n].forEach((v, i) => { j[cols[i]] = v; }); };
        if (bigOuter.length === 2 && !same(bigOuter[0], bigOuter[1])) j.warn.push('上下の外のSPLの寸法が違います');
        if (bigOuter.length) put(GROUP_COLS['Fr外'], bigOuter[0], sum(bigOuter));
        put(GROUP_COLS['Fr内'], inner, sum(inners) + sum(splitOuter));
        j.warn.push('SPL分割として読みました(上下の枚数を合計)');
      }
      // フランジの枚数: 図の数字が片側1か所ぶん(外1枚・内2枚。25-19)なら上下で×2、
      // 上下の合計(外2枚・内4枚。26-16)ならそのまま。外の数字が1か(外が無ければ内が2以下か)で見分ける
      // (SPL分割は上下を足した枚数なのでそのまま)
      if (!(sp && sp.上.length && sp.下.length) && ('H' in j || 'M' in j)) {
        const perFlange = 'H' in j ? j.H === 1 : j.M <= 2;
        if (perFlange) { if ('H' in j) j.H *= 2; if ('M' in j) j.M *= 2; }
      }
      if ('E' in j || 'J' in j || 'O' in j) j.U = '有';
      return j;
    });
  }

  // ---------------------------------------------------------------- 突き合わせ

  // フィラー列の「PL6取付」等の書き込み(図面に無いメモ)は比べない
  function isNote(v) {
    const s = normVal(v);
    return typeof s === 'string' && !/^PL\d+(\.\d+)?$/.test(s);
  }

  function diffOf(row) {
    const j = row.drawing;
    if (!j) return {};
    const out = {};
    for (const c of CMP_COLS) {
      if (c === 'S' && j.S == null && isNote(row.S)) continue;
      const a = normVal(row[c]), b = normVal(j[c]);
      if (a !== b) out[c] = [row[c], j[c]];
    }
    const a = normVal(row.A), b = normVal(j.A);
    if (a != null && a !== b) out.A = [row.A, j.A];
    return out;
  }

  function refreshStatus(row) {
    if (!row.drawing) { row.status = '手入力'; row.diff = {}; return row; }
    row.diff = diffOf(row);
    if (row.xrow == null) row.status = '新規';
    else row.status = Object.keys(row.diff).length ? '違い' : '一致';
    return row;
  }

  // 図面の値を表に入れる(T丁番・Vボルトは触らない)
  function applyDrawing(row) {
    const j = row.drawing;
    for (const c of CMP_COLS) {
      if (c === 'S' && j.S == null && isNote(row.S)) continue;
      row[c] = j[c] == null ? null : j[c];
    }
    row.A = j.A;
    row.applied = true;
    return refreshStatus(row);
  }

  // Excelの並びはそのまま残し、図面にしか無い継手は図面の順で直前の継手の行の後ろへ差し込む。
  // 組み方: 1回目は図番と継手名が両方合う行どうし、2回目は残りを継手名だけで(同じ名前は上から順)
  function merge(excelRows, joints) {
    joints.forEach((j, i) => { j.dorder = i; });
    const rows = excelRows.map(x => Object.assign({}, x, { drawing: null }));
    const used = new Set();
    const pair = (keyRow, keyJoint) => {
      const free = new Map();
      for (const j of joints) {
        if (used.has(j)) continue;
        const k = keyJoint(j);
        if (!free.has(k)) free.set(k, []);
        free.get(k).push(j);
      }
      for (const r of rows) {
        if (r.drawing) continue;
        const k = keyRow(r);
        if (k == null || !free.get(k) || !free.get(k).length) continue;
        const j = free.get(k).shift();
        r.drawing = j;
        used.add(j);
      }
    };
    pair(r => (normVal(r.A) != null && normVal(r.B) != null) ? normName(r.A) + '|' + normName(r.B) : null,
      j => normName(j.A) + '|' + normName(j.B));
    pair(r => normName(r.B) || null, j => normName(j.B));
    for (const r of rows) {
      if (r.drawing && normVal(r.A) == null) r.A = r.drawing.A; // 図番が空なら図面から入れる
      refreshStatus(r);
    }
    for (const j of joints) {
      if (used.has(j)) continue;
      const nw = { xrow: null, drawing: j };
      for (const c of VALUE_COLS) nw[c] = j[c] == null ? null : j[c];
      refreshStatus(nw);
      let pos = -1;
      rows.forEach((r, i) => {
        const d = r.drawing;
        if (d && d.dorder < j.dorder && (pos < 0 || d.dorder >= rows[pos].drawing.dorder)) pos = i;
      });
      if (pos < 0) {
        const first = rows.findIndex(r => r.drawing);
        pos = first >= 0 ? first - 1 : rows.length - 1;
      }
      rows.splice(pos + 1, 0, nw);
    }
    return rows;
  }

  function counts(rows) {
    const c = { '一致': 0, '違い': 0, '新規': 0, '手入力': 0 };
    for (const r of rows) c[r.status] = (c[r.status] || 0) + 1;
    return c;
  }

  // 違いの一覧(ポップアップ用)。[{row, items:[{col,label,excel,drawing}]}]
  function diffList(rows) {
    return rows.filter(r => r.status === '違い').map(r => ({
      row: r,
      items: Object.keys(r.diff).map(k => ({ col: k, label: COL_LABEL[k], excel: r.diff[k][0], drawing: r.diff[k][1] })),
    }));
  }

  const api = {
    VALUE_COLS, CMP_COLS, COL_LABEL, nfkc, normName, normVal, fmt,
    parseTdfTexts, extractDrawing, zubanOf, sortDrawings,
    diffOf, refreshStatus, applyDrawing, merge, counts, diffList,
  };
  if (typeof module !== 'undefined' && module.exports) module.exports = api; else root.splCore = api;
})(typeof window !== 'undefined' ? window : globalThis);
