/* 質問チャット部品(共通)。<script src="chat/chat-widget.js"> の1行で右下に「？」が出る。
 * 1) faq.json をブラウザ内で検索して即答(無料・無制限・画像可)
 * 2) 見つからない質問だけ GAS(askAI) 経由で Gemini に質問(モデルは固定)
 * 既存アプリのコード・スタイルには触れない(要素・CSSは cw- 接頭辞で隔離)。 */
(function () {
  "use strict";
  var GAS_URL = (typeof GAS_API_URL !== "undefined") ? GAS_API_URL : "";
  var BASE = (document.currentScript && document.currentScript.src || "").replace(/[^\/]*$/, "");
  var data = null, busy = false;

  var css = ".cw-btn{position:fixed;right:16px;bottom:16px;z-index:99998;width:52px;height:52px;border-radius:50%;border:0;background:#2563eb;color:#fff;font-size:24px;box-shadow:0 2px 8px #0004;cursor:pointer}" +
    ".cw-box{position:fixed;right:16px;bottom:78px;z-index:99999;width:min(360px,calc(100vw - 32px));height:min(520px,70vh);background:#fff;color:#111;border-radius:12px;box-shadow:0 4px 20px #0005;display:none;flex-direction:column;font:14px/1.5 sans-serif}" +
    ".cw-box.cw-open{display:flex}.cw-head{padding:10px 12px;background:#2563eb;color:#fff;border-radius:12px 12px 0 0;font-weight:bold;display:flex;justify-content:space-between}" +
    ".cw-head span{cursor:pointer}.cw-log{flex:1;overflow:auto;padding:10px;display:flex;flex-direction:column;gap:8px}" +
    ".cw-m{max-width:85%;padding:8px 10px;border-radius:10px;white-space:pre-wrap;word-break:break-word}.cw-u{align-self:flex-end;background:#dbeafe}.cw-b{align-self:flex-start;background:#f1f5f9}" +
    ".cw-m img{max-width:100%;display:block;margin-top:6px;border-radius:6px}.cw-form{display:flex;gap:6px;padding:8px;border-top:1px solid #ddd}" +
    ".cw-form input{flex:1;padding:8px;border:1px solid #ccc;border-radius:6px;font-size:16px}.cw-form button{padding:8px 12px;border:0;border-radius:6px;background:#2563eb;color:#fff}";
  var st = document.createElement("style"); st.textContent = css; document.head.appendChild(st);

  var btn = el("button", "cw-btn", "？"); btn.title = "質問する";
  var box = el("div", "cw-box");
  var head = el("div", "cw-head"); head.appendChild(el("div", "", "使い方を質問")); var x = el("span", "", "✕"); head.appendChild(x);
  var log = el("div", "cw-log");
  var form = el("form", "cw-form"); var inp = el("input"); inp.placeholder = "質問を入力"; inp.maxLength = 300;
  var send = el("button", "", "送信"); send.type = "submit"; form.appendChild(inp); form.appendChild(send);
  box.appendChild(head); box.appendChild(log); box.appendChild(form);
  document.body.appendChild(btn); document.body.appendChild(box);

  function el(t, c, txt) { var e = document.createElement(t); if (c) e.className = c; if (txt) e.textContent = txt; return e; }
  function say(text, who, imgs) {
    var m = el("div", "cw-m " + (who === "u" ? "cw-u" : "cw-b"), text);
    (imgs || []).forEach(function (f) { var i = el("img"); i.src = BASE + "img/" + encodeURIComponent(f); i.alt = f; m.appendChild(i); });
    log.appendChild(m); log.scrollTop = log.scrollHeight; return m;
  }
  btn.onclick = function () { box.classList.toggle("cw-open"); if (box.classList.contains("cw-open")) { load(); inp.focus(); } };
  window.cwOpen = function () { box.classList.add("cw-open"); load(); inp.focus(); };
  x.onclick = function () { box.classList.remove("cw-open"); };

  function load() {
    if (data) return Promise.resolve(data);
    return fetch(BASE + "faq.json").then(function (r) { return r.json(); }).then(function (d) {
      data = d; if (!log.children.length) say("こんにちは。" + d.appName + "の使い方を質問してください。", "b"); return d;
    });
  }
  function grams(s) { s = (s || "").toLowerCase().replace(/\s+/g, ""); var g = {}; for (var i = 0; i < s.length - 1; i++) g[s.substr(i, 2)] = 1; return g; }
  function best(q) {
    var qg = grams(q), qn = Object.keys(qg).length, top = null, sc = 0;
    data.faq.forEach(function (f) {
      var fg = grams(f.q), hit = 0; for (var k in qg) if (fg[k]) hit++;
      var s = qn ? hit / qn : 0; if (s > sc) { sc = s; top = f; }
    });
    return sc >= 0.34 ? top : null;
  }
  /* ===== アプリ内データへの質問(データはGeminiに送らない。意図の解釈だけ依頼し、集計はブラウザ内で行う) ===== */
  function G(n) { try { return (0, eval)(n); } catch (e) { return undefined; } } // app.jsのグローバルlet参照
  function pad(n) { return String(n).padStart(2, "0"); }
  function fmt(d) { return d.getFullYear() + "/" + pad(d.getMonth() + 1) + "/" + pad(d.getDate()); }
  function parseDate(q) {
    var t = new Date(), m;
    if (/今日|本日|現在/.test(q)) return fmt(t);
    if (/昨日/.test(q)) { t.setDate(t.getDate() - 1); return fmt(t); }
    if (/明日/.test(q)) { t.setDate(t.getDate() + 1); return fmt(t); }
    if ((m = q.match(/(\d{4})[\/年.-](\d{1,2})[\/月.-](\d{1,2})/))) return m[1] + "/" + pad(m[2]) + "/" + pad(m[3]);
    if ((m = q.match(/(\d{1,2})月(\d{1,2})日?/))) {
      var y = t.getFullYear(), d = new Date(y, m[1] - 1, m[2]); if (d > t) y--;
      return y + "/" + pad(m[1]) + "/" + pad(m[2]);
    }
    return "";
  }
  function factoryOf(q) { var m = q.match(/本社|夢前|鳥取|総務建築/); return m ? m[0] : ""; }
  function regexIntent(q) {
    var date = parseDate(q), factory = factoryOf(q);
    if (/在職|人数|何人|在籍/.test(q)) return { intent: "headcount", factory: factory };
    if (/有給|届/.test(q) && date && /一覧|出し|教え|誰|確認|見せ/.test(q)) return { intent: "leave_list", date: date };
    if (/日報/.test(q) && date) {
      var m = q.replace(/\s/g, "").match(/(?:\d{1,2}月\d{1,2}日?|\d{4}[\/年.-]\d{1,2}[\/月.-]\d{1,2}日?|今日|昨日|本日)の?(.+?)の日報/);
      return { intent: "daily_report", date: date, person: m ? m[1] : "" };
    }
    return null;
  }
  function table(h, rows) {
    var t = el("table"); t.style.cssText = "border-collapse:collapse;font-size:12px;margin-top:4px";
    var add = function (cells, tag) { var tr = el("tr"); cells.forEach(function (c) { var e = el(tag, "", String(c)); e.style.cssText = "border:1px solid #cbd5e1;padding:2px 6px;text-align:left"; tr.appendChild(e); }); t.appendChild(tr); };
    add(h, "th"); rows.forEach(function (r) { add(r, "td"); }); return t;
  }
  function reply(text, tbl) { var m = say(text, "b"); if (tbl) m.appendChild(tbl); log.scrollTop = log.scrollHeight; }
  function norm(s) { return String(s || "").replace(/[\s\u3000]/g, "").replace(/さん$/, ""); }

  function runIntent(it) {
    var rows = G("ALL_ROWS"), master = G("MASTER");
    if (!master || !rows || !master.operators.length) return reply("データを読み込み中です。ホーム画面のボタンが押せるようになってから、もう一度質問してください。");
    if (it.intent === "headcount") {
      var fs = it.factory && it.factory !== "総務建築" ? [it.factory] : ["本社", "夢前", "鳥取"], tot = 0, out = [];
      fs.forEach(function (f) {
        var ops = master.operators.filter(function (o) { return o.factory === f && o.active; }); tot += ops.length;
        var depts = {}; ops.forEach(function (o) { depts[o.dept || "-"] = (depts[o.dept || "-"] || 0) + 1; });
        out.push([f, ops.length + "名", Object.keys(depts).map(function (k) { return k + depts[k]; }).join(" / ")]);
      });
      return reply((it.factory === "総務建築" ? "総務建築は在職者数の集計に未対応です。" : "") + "現在(最新の社員マスタ)の在職者数: 計" + tot + "名", table(["拠点", "在職者", "内訳(部署)"], out));
    }
    if (!it.date) return reply("日付が読み取れませんでした。「10月5日の…」のように日付を入れてください。");
    if (it.intent === "leave_list") {
      var abs = G("ABSENTEEISM_DETAIL") || [], nm = G("OPERATOR_NAME") || {};
      var list = abs.filter(function (a) { return it.date >= a.from && it.date <= a.to; })
        .sort(function (a, b) { return Number(a.operatorNo) - Number(b.operatorNo); })
        .map(function (a) { return [a.factory, nm[a.operatorNo] || a.operatorNo, a.type, a.reason || "", a.from === a.to ? a.from : a.from + "〜" + a.to]; });
      if (!list.length) return reply(it.date + " の有給等届けはありません(本社・夢前・鳥取。総務建築は「② 有給等届けの確認」画面で確認してください)。");
      return reply(it.date + " の有給等届け: " + list.length + "件(本社・夢前・鳥取)", table(["拠点", "氏名", "申請項目", "事由", "日付"], list));
    }
    if (it.intent === "daily_report") {
      var p = norm(it.person), nm2 = G("OPERATOR_NAME") || {}, wm = G("WORK_META") || {}, cl = G("CONSTRUCTION_LABEL") || {};
      var day = rows.filter(function (r) { return r.workDate === it.date; });
      var ops = p ? master.operators.filter(function (o) { return norm(o.name).indexOf(p) >= 0 || p.indexOf(norm(o.name)) >= 0; }) : [];
      var sel, title;
      if (ops.length) { var nos = {}; ops.forEach(function (o) { nos[o.no] = 1; }); sel = day.filter(function (r) { return nos[r.operatorNo]; }); title = ops.map(function (o) { return o.name; }).join("・"); }
      else if (p) { sel = day.filter(function (r) { return (cl[r.constructionId] || "").indexOf(p) >= 0; }); title = "工事「" + p + "」"; }
      else return reply("誰(または何)の日報かが読み取れませんでした。「10月5日の山田さんの日報は?」のように聞いてください。");
      if (!sel.length) return reply(it.date + " の " + title + " の日報データはありません(未提出・休日・名前違いの可能性)。");
      var sum = 0, rs = sel.map(function (r) { sum += Number(r.hours) || 0; return [nm2[r.operatorNo] || r.operatorNo, cl[r.constructionId] || r.constructionId, wm[r.workCode] || r.workCode, r.hours]; });
      return reply(it.date + " の " + title + " の日報: " + sel.length + "件・合計" + (Math.round(sum * 100) / 100) + "時間", table(["氏名", "工事", "作業内容", "時間"], rs));
    }
  }
  function ask(q, mode) {
    if (!GAS_URL) return Promise.reject(new Error("no-gas"));
    var manual = data.faq.map(function (f) { return "Q:" + f.q + "\nA:" + f.a; }).join("\n\n");
    return fetch(GAS_URL, { method: "POST", headers: { "Content-Type": "text/plain;charset=utf-8" },
      body: JSON.stringify({ action: "askAI", params: { question: q, appName: data.appName, manual: manual, mode: mode || "howto", today: fmt(new Date()) } }) })
      .then(function (r) { return r.json(); })
      .then(function (j) { if (j.status !== "success") throw new Error(j.message || "error"); return j.data.answer; });
  }
  form.onsubmit = function (e) {
    e.preventDefault(); var q = inp.value.trim(); if (!q || busy) return; inp.value = ""; say(q, "u");
    load().then(function () {
      var it = regexIntent(q); if (it) return runIntent(it);
      var f = best(q); if (f) { say(f.a, "b", f.img); return; }
      busy = true; var w = say("考え中…", "b");
      return ask(q, "route").then(function (a) {
        var j = {}; try { j = JSON.parse(a); } catch (x) { }
        if (j.intent && j.intent !== "howto" && j.intent !== "other") { w.remove(); var d2 = parseDate(q); if (d2) j.date = d2; runIntent(j); } else w.textContent = j.answer || "すみません、答えられませんでした。管理者に確認してください。";
      }, function () { w.textContent = "すみません、この質問には答えられませんでした(AI回答は未設定、または混雑中)。言い方を変えるか、管理者に確認してください。"; })
        .then(function () { busy = false; });
    });
  };
})();
