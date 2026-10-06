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
  function ask(q) {
    if (!GAS_URL) return Promise.reject(new Error("no-gas"));
    var manual = data.faq.map(function (f) { return "Q:" + f.q + "\nA:" + f.a; }).join("\n\n");
    return fetch(GAS_URL, { method: "POST", headers: { "Content-Type": "text/plain;charset=utf-8" },
      body: JSON.stringify({ action: "askAI", params: { question: q, appName: data.appName, manual: manual } }) })
      .then(function (r) { return r.json(); })
      .then(function (j) { if (j.status !== "success") throw new Error(j.message || "error"); return j.data.answer; });
  }
  form.onsubmit = function (e) {
    e.preventDefault(); var q = inp.value.trim(); if (!q || busy) return; inp.value = ""; say(q, "u");
    load().then(function () {
      var f = best(q); if (f) { say(f.a, "b", f.img); return; }
      busy = true; var w = say("考え中…", "b");
      return ask(q).then(function (a) { w.textContent = a; }, function () { w.textContent = "すみません、この質問には答えられませんでした(AI回答は未設定、または混雑中)。言い方を変えるか、管理者に確認してください。"; })
        .then(function () { busy = false; });
    });
  };
})();
