/* 質問チャット部品(共通)。<script src="chat/chat-widget.js"> の1行で右下に「？」が出る。
 * 1) faq.json をブラウザ内で検索して即答(無料・無制限・画像可)
 * 2) 見つからない質問だけ GAS(askAI) 経由で Gemini に質問(モデルは固定)
 * 既存アプリのコード・スタイルには触れない(要素・CSSは cw- 接頭辞で隔離)。 */
(function () {
  "use strict";
  var GAS_URL = (typeof GAS_API_URL !== "undefined") ? GAS_API_URL : "";
  var BASE = (document.currentScript && document.currentScript.src || "").replace(/[^\/]*$/, "");
  var data = null, busy = false;

  /* 窓は画面中央に出す。開くボタンはホームの「⑥ AIに質問」と、各画面のリセットボタンの右(ユーザー指定)。 */
  var css = ".cw-hbtn{padding:6px 14px;font-size:13px;border:1px solid #2563eb;border-radius:16px;background:#2563eb;color:#fff;cursor:pointer;white-space:nowrap}.cw-hbtn:hover{background:#1d4ed8}" +
    ".cw-box{position:fixed;left:50%;top:50%;transform:translate(-50%,-50%);z-index:99999;width:min(640px,calc(100vw - 32px));max-height:calc(100vh - 64px);background:#fff;color:#111;border-radius:12px;box-shadow:0 8px 32px #0006;display:none;flex-direction:column;font:14px/1.5 sans-serif}" +
    ".cw-box.cw-open{display:flex}.cw-m{font-size:15px}.cw-copy{margin-top:6px;padding:4px 10px;border:1px solid #2563eb;border-radius:6px;background:#fff;color:#2563eb;cursor:pointer;font-size:13px}.cw-head{padding:10px 12px;background:#2563eb;color:#fff;border-radius:12px 12px 0 0;font-weight:bold;display:flex;justify-content:space-between}" +
    ".cw-head span{cursor:pointer}.cw-log{flex:0 1 auto;min-height:60px;overflow:auto;padding:10px;display:flex;flex-direction:column;gap:8px}" +
    ".cw-m{max-width:36em;width:fit-content;padding:8px 10px;border-radius:10px;white-space:pre-wrap;word-break:break-word}.cw-u{align-self:flex-end;background:#dbeafe}.cw-b{align-self:flex-start;background:#f1f5f9}" +
    ".cw-m.cw-wide{max-width:none}.cw-m img{max-width:100%;display:block;margin-top:6px;border-radius:6px}.cw-form{display:flex;gap:6px;padding:8px;border-top:1px solid #ddd}" +
    ".cw-form input{flex:1;padding:8px;border:1px solid #ccc;border-radius:6px;font-size:16px}.cw-form button{padding:8px 12px;border:0;border-radius:6px;background:#2563eb;color:#fff}";
  var st = document.createElement("style"); st.textContent = css; document.head.appendChild(st);

  var box = el("div", "cw-box");
  var head = el("div", "cw-head"); head.appendChild(el("div", "", "AIに質問")); var x = el("span", "", "✕ 閉じる"); head.appendChild(x);
  var log = el("div", "cw-log");
  var form = el("form", "cw-form"); var inp = el("input"); inp.placeholder = "質問を入力"; inp.maxLength = 300;
  var send = el("button", "", "送信"); send.type = "submit"; form.appendChild(inp); form.appendChild(send);
  box.appendChild(head); box.appendChild(log); box.appendChild(form);
  document.body.appendChild(box);
  // 各画面のリセットボタンの右に「AIに質問」ボタンを置く
  Array.prototype.forEach.call(document.querySelectorAll(".resetBtn"), function (rb) {
    var b = el("button", "cw-hbtn", "💬 AIに質問"); b.type = "button"; b.setAttribute("data-cw-open", "1");
    b.onclick = function () { window.cwOpen(); };
    rb.insertAdjacentElement("afterend", b);
  });

  function el(t, c, txt) { var e = document.createElement(t); if (c) e.className = c; if (txt) e.textContent = txt; return e; }
  function say(text, who, imgs) {
    var m = el("div", "cw-m " + (who === "u" ? "cw-u" : "cw-b"), text);
    (imgs || []).forEach(function (f) { var i = el("img"); i.src = BASE + "img/" + encodeURIComponent(f); i.alt = f; m.appendChild(i); });
    log.appendChild(m); log.scrollTop = log.scrollHeight; return m;
  }
  function close() { box.classList.remove("cw-open"); }
  window.cwOpen = function () { box.classList.add("cw-open"); load(); inp.focus(); };
  x.onclick = close;
  // 窓の外をクリック(フィルタ等の通常の操作を含む)すると閉じる。開くボタン自体は除く。
  document.addEventListener("mousedown", function (e) {
    if (!box.classList.contains("cw-open") || box.contains(e.target)) return;
    if (e.target.closest && e.target.closest("[data-cw-open], .homeBtnAI")) return;
    close();
  }, true);
  document.addEventListener("keydown", function (e) { if (e.key === "Escape") close(); });
  function load() {
    if (data) return Promise.resolve(data);
    return fetch(BASE + "faq.json").then(function (r) { return r.json(); }).then(function (d) {
      data = d; if (!log.children.length) say("こんにちは。" + d.appName + "の使い方を質問してください。", "b"); return d;
    });
  }
  function grams(s) { s = (s || "").toLowerCase().replace(/\s+/g, ""); var g = {}; for (var i = 0; i < s.length - 1; i++) g[s.substr(i, 2)] = 1; return g; }
  var bestScore = 0;
  function best(q) {
    var qg = grams(q), qn = Object.keys(qg).length, top = null, sc = 0;
    data.faq.forEach(function (f) {
      var fg = grams(f.q), hit = 0; for (var k in qg) if (fg[k]) hit++;
      var s = qn ? hit / qn : 0; if (s > sc) { sc = s; top = f; }
    });
    bestScore = sc;
    return sc >= 0.34 ? top : null;
  }
  /* ===== アプリ内データへの質問(データはGeminiに送らない。意図の解釈だけ依頼し、集計はブラウザ内で行う) =====
     流れ: ①ブラウザ内で読み取れた(種類・日付・人/工事がそろった)らすぐ集計 → ②足りなければGeminiに意図だけ聞く
     (Vercel中継api/ask→失敗時GAS直接) → ③それも失敗したら、ブラウザ内で読み取れた分で答えるか、聞き方の例を返す。 */
  function G(n) { try { return (0, eval)(n); } catch (e) { return undefined; } } // app.jsのグローバルlet参照
  function pad(n) { return String(n).padStart(2, "0"); }
  function fmt(d) { return d.getFullYear() + "/" + pad(d.getMonth() + 1) + "/" + pad(d.getDate()); }
  function z2h(s) { return String(s || "").replace(/[０-９]/g, function (c) { return String.fromCharCode(c.charCodeAt(0) - 0xFEE0); }).replace(/[／]/g, "/").replace(/[～〜]/g, "~"); }
  function ymd(y, m, d) { return y + "/" + pad(m) + "/" + pad(d); }
  function nearestYear(m, d) { var t = new Date(), y = t.getFullYear(); if (new Date(y, m - 1, d) > t) y--; return y; }
  function monthRange(y, m) { var last = new Date(y, m, 0).getDate(), t = new Date(); var to = ymd(y, m, last); if (to > fmt(t)) to = fmt(t); return { from: ymd(y, m, 1), to: to }; }
  /* 質問文から日付・期間を読み取る({from,to} または null)。 */
  function parseDates(q0) {
    var q = z2h(q0), t = new Date(), m, days = [];
    var shift = function (n) { var d = new Date(); d.setDate(d.getDate() + n); return fmt(d); };
    var re = /(\d{4})[\/年.-](\d{1,2})[\/月.-](\d{1,2})日?|(\d{1,2})\/(\d{1,2})|(\d{1,2})月(\d{1,2})日/g;
    while ((m = re.exec(q))) {
      if (m[1]) days.push(ymd(m[1], m[2], m[3]));
      else { var mm = Number(m[4] || m[6]), dd = Number(m[5] || m[7]); if (mm >= 1 && mm <= 12 && dd >= 1 && dd <= 31) days.push(ymd(nearestYear(mm, dd), mm, dd)); }
    }
    if (days.length >= 2) { days.sort(); return { from: days[0], to: days[days.length - 1] }; }
    if (days.length === 1) return { from: days[0], to: days[0] };
    if (/一昨日|おととい/.test(q)) { var d2 = shift(-2); return { from: d2, to: d2 }; }
    if (/昨日|きのう/.test(q)) { var d1 = shift(-1); return { from: d1, to: d1 }; }
    if (/今日|本日|きょう/.test(q)) return { from: fmt(t), to: fmt(t) };
    if (/明日|あした/.test(q)) { var d3 = shift(1); return { from: d3, to: d3 }; }
    if (/先月|前月/.test(q)) { var pm = new Date(t.getFullYear(), t.getMonth() - 1, 1); return monthRange(pm.getFullYear(), pm.getMonth() + 1); }
    if (/今月/.test(q)) return monthRange(t.getFullYear(), t.getMonth() + 1);
    if (/先週|前週/.test(q)) { var w = (t.getDay() + 6) % 7; return { from: shift(-w - 7), to: shift(-w - 1) }; }
    if (/今週/.test(q)) { var w2 = (t.getDay() + 6) % 7; return { from: shift(-w2), to: fmt(t) }; }
    if (/去年|昨年/.test(q)) return { from: (t.getFullYear() - 1) + "/01/01", to: (t.getFullYear() - 1) + "/12/31" };
    if (/今年/.test(q)) return { from: t.getFullYear() + "/01/01", to: fmt(t) };
    if ((m = q.match(/(?:(\d{4})年)?(\d{1,2})月(?!\d)/))) { var mo = Number(m[2]); if (mo >= 1 && mo <= 12) return monthRange(m[1] ? Number(m[1]) : nearestYear(mo, 1), mo); }
    return null;
  }
  function factoryOf(q) { var m = q.match(/本社|夢前|鳥取|総務建築/); return m ? m[0] : ""; }
  function norm(s) { return String(s || "").replace(/[\s　]/g, "").replace(/(さん|君|くん|様|氏)$/, ""); }
  function surname(name) { var p = String(name || "").trim().split(/[\s　]+/); return p.length > 1 ? p[0] : ""; }
  /* 社員名で探す(フルネーム・姓・部分一致)。 */
  function findOps(person) {
    var master = G("MASTER"), p = norm(person); if (!master || !p) return [];
    var hit = master.operators.filter(function (o) { var n = norm(o.name); return n && (n === p || n.indexOf(p) >= 0 || p.indexOf(n) >= 0); });
    if (!hit.length && /^\d+$/.test(p)) hit = master.operators.filter(function (o) { return String(o.no) === p; });
    return hit;
  }
  /* 質問文の中に出てくる社員名を探す(AIなしでも語順に関係なく人を特定するため)。姓は2文字以上で一致させる。 */
  function opsInText(q) {
    var master = G("MASTER"), qn = norm(q).replace(/(さん|君|くん|様|氏)/g, ""); if (!master) return [];
    var full = master.operators.filter(function (o) { var n = norm(o.name); return n.length >= 2 && qn.indexOf(n) >= 0; });
    if (full.length) return full;
    var bySur = master.operators.filter(function (o) { var s = surname(o.name); return s.length >= 2 && qn.indexOf(s) >= 0; });
    if (bySur.length) return bySur;
    // 姓と名の間に空白が無い氏名もあるため、「○○さん」等の呼び方から名前の先頭一致で探す
    var re = /([一-龥々ァ-ヶー]{1,5})(?:さん|君|くん|様|氏)/g, m, hit = [];
    while ((m = re.exec(String(q).replace(/[\s\u3000]/g, "")))) {
      var tk = m[1].replace(/^.*[のはがをにで]/, ""); if (tk.length < 2) continue;
      master.operators.forEach(function (o) { if (norm(o.name).indexOf(tk) === 0 && hit.indexOf(o) < 0) hit.push(o); });
    }
    return hit;
  }
  function findCons(text) {
    var cl = G("CONSTRUCTION_LABEL") || {}, p = norm(text).toLowerCase(); if (!p) return [];
    return Object.keys(cl).filter(function (id) { var l = norm(cl[id]).toLowerCase(); return String(id).toLowerCase() === p || (l && (l.indexOf(p) >= 0 || (l.length >= 3 && p.indexOf(l) >= 0))); });
  }
  function consInText(q) {
    var cl = G("CONSTRUCTION_LABEL") || {}, qn = norm(q).toLowerCase();
    return Object.keys(cl).filter(function (id) { var l = norm(cl[id]).toLowerCase(); return (l.length >= 3 && qn.indexOf(l) >= 0) || (String(id).length >= 5 && qn.indexOf(String(id).toLowerCase()) >= 0); });
  }
  /* ブラウザ内だけで質問の種類を読み取る。足りない項目はneedに入れる(Geminiに回す判断に使う)。 */
  function localIntent(q) {
    var dr = parseDates(q), factory = factoryOf(q), ops = opsInText(q), cons = ops.length ? [] : consInText(q), it;
    if (/未提出|出して(い)?ない|出てない|出ていない|未入力|入力して(い)?ない|書いて(い)?ない|提出して(い)?ない|漏れ/.test(q)) it = { intent: "not_submitted" };
    else if (/有給|休み|休暇|欠勤|届け?|代休|遅刻|早退|休んだ/.test(q)) it = { intent: ops.length ? "leave_person" : "leave_list" };
    else if (/在職|在籍|社員数|従業員数|何人いる|人数/.test(q)) it = { intent: "headcount" };
    else if (/合計|何時間|時間数|工数|人工|集計|内訳|トータル|累計|まとめ|稼働/.test(q) && (ops.length || cons.length)) it = { intent: "hours_summary" };
    else if (/日報|作業|仕事|何をし|何して|入力内容|実績/.test(q) && (ops.length || cons.length)) it = { intent: "daily_report" };
    else if (/日報|作業|集計|合計|時間|実績|稼働/.test(q) && (dr || /全て|全部|全体|すべて|全員|みんな/.test(q))) it = { intent: "hours_summary", all: true }; // 人・工事の指定なし=全体の集計
    else return null;
    it.from = dr ? dr.from : ""; it.to = dr ? dr.to : ""; it.factory = factory; it.ops = ops; it.cons = cons;
    it.dateGiven = !!dr;
    it.complete = it.intent === "headcount" || it.intent === "leave_list" || it.intent === "not_submitted" || it.all ? true : !!(ops.length || cons.length);
    return it;
  }
  /* Geminiの答え(新旧どちらの形式でも)を共通の形に直す。人・工事の特定はブラウザ内で行う。 */
  function fromAI(j, q) {
    var it = { intent: j.intent, factory: j.factory || factoryOf(q), from: j.dateFrom || j.date || "", to: j.dateTo || j.date || "" };
    var dr = parseDates(q); if (dr) { it.from = dr.from; it.to = dr.to; } // 明示された日付はブラウザ側の読み取りを優先
    if (it.from && !it.to) it.to = it.from;
    it.ops = j.person ? findOps(j.person) : []; if (!it.ops.length) it.ops = opsInText(q);
    it.cons = it.ops.length ? [] : (j.construction ? findCons(j.construction) : []);
    if (!it.ops.length && !it.cons.length && j.person && !j.construction) it.cons = findCons(j.person); // 旧形式は工事名もpersonに入る
    if (!it.ops.length && !it.cons.length) it.cons = consInText(q);
    it.personText = j.person || j.construction || "";
    it.dateGiven = !!(it.from);
    return it;
  }
  function table(h, rows) {
    var t = el("table"); t.style.cssText = "border-collapse:collapse;font-size:14px;margin-top:4px";
    var add = function (cells, tag) { var tr = el("tr"); cells.forEach(function (c) { var e = el(tag, "", String(c)); e.style.cssText = "border:1px solid #cbd5e1;padding:2px 6px;text-align:left"; tr.appendChild(e); }); t.appendChild(tr); };
    add(h, "th"); rows.forEach(function (r) { add(r, "td"); }); return t;
  }
  function copyText(t, b) {
    var done = function () { var o = b.textContent; b.textContent = "コピーしました ✓"; setTimeout(function () { b.textContent = o; }, 1500); };
    var fb = function () { var ta = el("textarea"); ta.value = t; ta.style.cssText = "position:fixed;opacity:0"; document.body.appendChild(ta); ta.select(); try { document.execCommand("copy"); done(); } catch (e) { b.textContent = "コピー失敗(表を選択してCtrl+C)"; } ta.remove(); };
    if (navigator.clipboard && navigator.clipboard.writeText) navigator.clipboard.writeText(t).then(done, fb); else fb();
  }
  function reply(text, tbl) {
    var m = say(text, "b");
    if (tbl) {
      m.classList.add("cw-wide"); m.appendChild(tbl);
      var tsv = Array.prototype.map.call(tbl.rows, function (r) { return Array.prototype.map.call(r.cells, function (c) { return c.textContent.replace(/[\t\r\n]+/g, " "); }).join("\t"); }).join("\n");
      var b = el("button", "cw-copy", "📋 表をコピー(Excelに貼り付け可)"); b.type = "button"; b.onclick = function () { copyText(tsv, b); }; m.appendChild(b);
    }
    log.scrollTop = log.scrollHeight;
  }
  var EXAMPLES = "次のように聞けます(語順・言い方は自由です):\n・今日の日報の集計全て\n・山田さんの10月5日の日報\n・先月の山田さんの作業時間の合計\n・○○工事の鳥取の工数(期間なしは工事全体)\n・昨日 日報を出していない人(本社)\n・10/5に有給を取っている人\n・山田さんの今年の有給\n・夢前の在職者数";
  var MAX_ROWS = 300;
  function range(it) { return it.allPeriod ? "全期間" : it.from === it.to ? it.from : it.from + "〜" + it.to; }
  function round2(n) { return Math.round(n * 100) / 100; }
  function sumBy(rows, keyFn) { var m = {}; rows.forEach(function (r) { var k = keyFn(r); m[k] = (m[k] || 0) + (Number(r.hours) || 0); }); return Object.keys(m).map(function (k) { return [k, round2(m[k])]; }).sort(function (a, b) { return b[1] - a[1]; }); }
  function daysBetween(from, to) { var out = [], d = new Date(from.split("/").join("-") + "T00:00:00"), e = new Date(to.split("/").join("-") + "T00:00:00"); while (d <= e && out.length < 400) { out.push(fmt(d)); d.setDate(d.getDate() + 1); } return out; }
  function targetFactories(it) { return it.factory && it.factory !== "総務建築" ? [it.factory] : ["本社", "夢前", "鳥取"]; }
  function kenchikuNote(it) { return it.factory === "総務建築" ? "総務建築はこの質問に未対応のため、本社・夢前・鳥取で答えます。総務建築は①②の画面で確認してください。\n" : ""; }

  function runIntent(it) {
    var rows = G("ALL_ROWS"), master = G("MASTER");
    if (!master || !rows || !master.operators.length) return reply("データを読み込み中です。ホーム画面のボタンが押せるようになってから、もう一度質問してください。");
    var today = fmt(new Date());
    if (!it.from) {
      // 工事の工数は、期間の指定が無ければ工事全体(全期間)で集計する
      if ((it.intent === "hours_summary" || it.intent === "daily_report") && !(it.ops && it.ops.length) && it.cons && it.cons.length) { it.from = "0000/00/00"; it.to = today; it.allPeriod = true; it.defaulted = true; }
      else if (it.intent === "hours_summary" || it.intent === "leave_person") { var mr = monthRange(new Date().getFullYear(), new Date().getMonth() + 1); it.from = mr.from; it.to = mr.to; it.defaulted = true; }
      else if (it.intent !== "headcount") { it.from = it.to = today; it.defaulted = true; }
    }
    var dnote = it.defaulted ? "(期間の指定が無かったため " + range(it) + " で集計)\n" : "";
    var nm = G("OPERATOR_NAME") || {}, wm = G("WORK_META") || {}, cl = G("CONSTRUCTION_LABEL") || {};
    var who = it.ops && it.ops.length ? it.ops.map(function (o) { return o.name; }).join("・") : (it.cons && it.cons.length ? it.cons.map(function (c) { return cl[c] || c; }).join("・") : "");
    var nos = {}; (it.ops || []).forEach(function (o) { nos[o.no] = 1; });
    var consSet = {}; (it.cons || []).forEach(function (c) { consSet[c] = 1; });
    // 工場(本社・夢前・鳥取)の指定があれば、人・工事の集計もその工場の行だけにする
    var onlyF = it.factory && it.factory !== "総務建築" ? it.factory : "";
    if (onlyF && who) who += "(" + onlyF + ")";
    var pick = function () {
      return rows.filter(function (r) { return r.workDate >= it.from && r.workDate <= it.to && (!onlyF || r.factory === onlyF) && (it.ops && it.ops.length ? nos[r.operatorNo] : consSet[r.constructionId]); });
    };

    if (it.intent === "headcount") {
      var fs = targetFactories(it), tot = 0, out = [];
      fs.forEach(function (f) {
        var ops = master.operators.filter(function (o) { return o.factory === f && o.active; }); tot += ops.length;
        var depts = {}; ops.forEach(function (o) { depts[o.dept || "-"] = (depts[o.dept || "-"] || 0) + 1; });
        out.push([f, ops.length + "名", Object.keys(depts).map(function (k) { return k + depts[k]; }).join(" / ")]);
      });
      return reply(kenchikuNote(it) + "現在(最新の社員マスタ)の在職者数: 計" + tot + "名", table(["拠点", "在職者", "内訳(部署)"], out));
    }
    if (it.intent === "leave_list" || it.intent === "leave_person") {
      var abs = G("ABSENTEEISM_DETAIL") || [], fset = {}; targetFactories(it).forEach(function (f) { fset[f] = 1; });
      var list = abs.filter(function (a) { return a.from <= it.to && a.to >= it.from && (it.intent === "leave_person" ? nos[a.operatorNo] : fset[a.factory]); })
        .sort(function (a, b) { return a.from < b.from ? -1 : a.from > b.from ? 1 : Number(a.operatorNo) - Number(b.operatorNo); });
      if (it.intent === "leave_person" && !(it.ops && it.ops.length)) return reply("誰の届けかが分かりませんでした。社員名を入れてください。\n" + EXAMPLES);
      var title = (it.intent === "leave_person" ? who + " の" : "") + range(it) + " の有給等届け" + (it.intent === "leave_list" ? "(" + targetFactories(it).join("・") + ")" : "");
      if (!list.length) return reply(dnote + title + "はありません。");
      var lr = list.slice(0, MAX_ROWS).map(function (a) { return [a.factory, nm[a.operatorNo] || a.operatorNo, a.type, a.reason || "", a.from === a.to ? a.from : a.from + "〜" + a.to]; });
      return reply(kenchikuNote(it) + dnote + title + ": " + list.length + "件" + (list.length > MAX_ROWS ? "(先頭" + MAX_ROWS + "件を表示)" : ""), table(["拠点", "氏名", "申請項目", "事由", "日付"], lr));
    }
    if (it.intent === "not_submitted") {
      var cal = G("CALENDAR_MAP") || {}, absd = G("ABSENTEEISM_DETAIL") || [], days = daysBetween(it.from, it.to > today ? today : it.to).filter(function (d) { return cal[d] !== "休日"; });
      if (days.length > 31) return reply("期間が長すぎます(31日以内にしてください)。長い期間は「① 日報入力チェック」画面で確認できます。");
      if (!days.length) return reply(range(it) + " は休日(または未来の日付)のため、確認する日がありません。");
      var fs2 = targetFactories(it), ops2 = master.operators.filter(function (o) { return o.active && fs2.indexOf(o.factory) >= 0; });
      var has = {}; rows.forEach(function (r) { if (r.workDate >= days[0] && r.workDate <= days[days.length - 1]) has[r.workDate + "|" + r.operatorNo] = 1; });
      var leave = function (no, d) { for (var i = 0; i < absd.length; i++) { var a = absd[i]; if (a.operatorNo === no && d >= a.from && d <= a.to && (a.type === "有給" || a.type === "欠勤")) return true; } return false; };
      var miss = [];
      days.forEach(function (d) { ops2.forEach(function (o) { if (!has[d + "|" + o.no] && !leave(o.no, d)) miss.push([d, o.factory, o.name, o.dept || ""]); }); });
      var head = kenchikuNote(it) + dnote + range(it) + " に日報が無い在職者(" + fs2.join("・") + "、休日と終日の有給・欠勤を除く簡易判定。正式な確認は「① 日報入力チェック」)";
      if (!miss.length) return reply(head + ": いません。");
      return reply(head + ": " + miss.length + "件" + (miss.length > MAX_ROWS ? "(先頭" + MAX_ROWS + "件を表示)" : ""), table(["日付", "拠点", "氏名", "部署"], miss.slice(0, MAX_ROWS)));
    }
    if (!who && !it.personText) return replyAll(it, rows, dnote);
    if (!who) return reply("誰(または何の工事)についての質問かが分かりませんでした" + (it.personText ? "(「" + it.personText + "」に一致する社員・工事が見つかりません)" : "") + "。\n" + EXAMPLES);
    var sel = pick();
    if (!sel.length) return reply(dnote + range(it) + " の " + who + " の日報データはありません(未提出・休日・名前違いの可能性)。");
    var total = round2(sel.reduce(function (s, r) { return s + (Number(r.hours) || 0); }, 0));
    if (it.intent === "hours_summary" || sel.length > MAX_ROWS) {
      var byWork = sumBy(sel, function (r) { return wm[r.workCode] || r.workCode; });
      var other = it.ops && it.ops.length ? sumBy(sel, function (r) { return cl[r.constructionId] || r.constructionId; }) : sumBy(sel, function (r) { return nm[r.operatorNo] || r.operatorNo; });
      var t2 = table(["作業内容", "時間"], byWork);
      var m2 = reply(dnote + range(it) + " の " + who + ": 合計" + total + "時間(" + sel.length + "件)" + (it.intent !== "hours_summary" ? "\n件数が多いため内訳で表示します。" : ""), t2);
      if (!onlyF) { // 工場の指定が無いときは工場別の内訳も出す
        var byFac = sumBy(sel, function (r) { return r.factory || "-"; });
        if (byFac.length > 1) reply("工場別の内訳", table(["工場", "時間"], byFac));
      }
      reply((it.ops && it.ops.length ? "工事別" : "社員別") + "の内訳", table([it.ops && it.ops.length ? "工事" : "氏名", "時間"], other.slice(0, MAX_ROWS)));
      return m2;
    }
    sel.sort(function (a, b) { return a.workDate < b.workDate ? -1 : a.workDate > b.workDate ? 1 : 0; });
    var rs = sel.map(function (r) { return [r.workDate, nm[r.operatorNo] || r.operatorNo, cl[r.constructionId] || r.constructionId, wm[r.workCode] || r.workCode, r.hours]; });
    return reply(dnote + range(it) + " の " + who + " の日報: " + sel.length + "件・合計" + total + "時間", table(["日付", "氏名", "工事", "作業内容", "時間"], rs));
  }
  /* 人・工事の指定が無いときは、期間内の全体を集計する(拠点別・工事別・作業内容別)。 */
  function replyAll(it, rows, dnote) {
    var nm = G("OPERATOR_NAME") || {}, wm = G("WORK_META") || {}, cl = G("CONSTRUCTION_LABEL") || {};
    var fs = targetFactories(it), sel = rows.filter(function (r) { return r.workDate >= it.from && r.workDate <= it.to && fs.indexOf(r.factory) >= 0; });
    if (!sel.length) return reply(kenchikuNote(it) + dnote + range(it) + " の日報データはありません(" + fs.join("・") + ")。");
    var total = round2(sel.reduce(function (s, r) { return s + (Number(r.hours) || 0); }, 0));
    var byF = fs.map(function (f) {
      var rs = sel.filter(function (r) { return r.factory === f; }), ppl = {};
      rs.forEach(function (r) { ppl[r.operatorNo] = 1; });
      return [f, Object.keys(ppl).length + "名", rs.length, round2(rs.reduce(function (s, r) { return s + (Number(r.hours) || 0); }, 0))];
    });
    reply(kenchikuNote(it) + dnote + range(it) + " の日報の集計(" + fs.join("・") + "): 合計" + total + "時間・" + sel.length + "件", table(["拠点", "入力した人", "件数", "時間"], byF));
    var byC = sumBy(sel, function (r) { return cl[r.constructionId] || r.constructionId; });
    reply("工事別(時間の多い順" + (byC.length > 50 ? "・上位50件" : "") + ")", table(["工事", "時間"], byC.slice(0, 50)));
    var byW = sumBy(sel, function (r) { return wm[r.workCode] || r.workCode; });
    reply("作業内容別" + (byW.length > 50 ? "(上位50件)" : ""), table(["作業内容", "時間"], byW.slice(0, 50)));
    if (it.from === it.to) {
      var byP = sumBy(sel, function (r) { return (nm[r.operatorNo] || r.operatorNo) + "\t" + r.factory; }).map(function (x) { var a = x[0].split("\t"); return [a[1], a[0], x[1]]; });
      reply("社員別" + (byP.length > MAX_ROWS ? "(先頭" + MAX_ROWS + "名)" : ""), table(["拠点", "氏名", "時間"], byP.slice(0, MAX_ROWS)));
    }
  }
  function askVia(url, payload) {
    return fetch(url, { method: "POST", headers: { "Content-Type": url === GAS_URL ? "text/plain;charset=utf-8" : "application/json" }, body: JSON.stringify(payload) })
      .then(function (r) { return r.json(); })
      .then(function (j) { if (j.status !== "success") throw new Error(j.message || "error"); return j.data.answer; });
  }
  function ask(q, mode) {
    var manual = data.faq.map(function (f) { return "Q:" + f.q + "\nA:" + f.a; }).join("\n\n");
    var wd = "日月火水木金土".charAt(new Date().getDay());
    var payload = { action: "askAI", params: { question: q, appName: data.appName, manual: manual, mode: mode || "howto", today: fmt(new Date()) + "(" + wd + ")" } };
    // 通常はVercel中継(サーバー側で再試行)。確認用URL等で中継が無い場合だけGASへ直接
    return askVia("api/ask", payload).catch(function (e) { if (!GAS_URL) throw e; return askVia(GAS_URL, payload); });
  }
  form.onsubmit = function (e) {
    e.preventDefault(); var q = inp.value.trim(); if (!q || busy) return; inp.value = ""; say(q, "u");
    load().then(function () {
      var loc = localIntent(q);
      if (loc && loc.complete) return runIntent(loc);
      var f = best(q);
      if (!loc && f && bestScore >= 0.6) { say(f.a, "b", f.img); return; }
      busy = true; var w = say("考え中…", "b");
      return ask(q, "route").then(function (a) {
        var j = {}; try { j = JSON.parse(a); } catch (x) { }
        if (j.intent && j.intent !== "howto" && j.intent !== "other") { w.remove(); runIntent(fromAI(j, q)); }
        else if (j.intent === "howto" && j.answer) w.textContent = j.answer;
        else if (loc) { w.remove(); runIntent(loc); }
        else if (f) { w.remove(); say(f.a, "b", f.img); }
        else w.textContent = j.answer || ("すみません、質問の内容を読み取れませんでした。\n" + EXAMPLES);
      }, function () {
        // AIに聞けなかった場合も、ブラウザ内で読み取れた分・マニュアルで答える
        if (loc) { w.remove(); runIntent(loc); }
        else if (f) { w.remove(); say(f.a, "b", f.img); }
        else w.textContent = "すみません、AIに接続できず、質問の内容を読み取れませんでした。\n" + EXAMPLES;
      }).then(function () { busy = false; });
    });
  };
})();
