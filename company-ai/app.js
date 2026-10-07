'use strict';
(function () {
  var CFG = window.AI_CONFIG || {};
  var DEMO = /[?&]demo=1/.test(location.search);
  var token = '';
  var $ = function (id) { return document.getElementById(id); };

  function tokenGet() { try { return sessionStorage.getItem('ai_token') || ''; } catch (e) { return ''; } }
  function tokenSet(t) { try { if (t) sessionStorage.setItem('ai_token', t); else sessionStorage.removeItem('ai_token'); } catch (e) {} }

  // GASへ。text/plainで送ると事前確認(CORS preflight)が要らない。
  // GASの応答は、Google側の事情で数十秒かかったり、途中で失われたりする(404・HTML)ことがある。
  // そこで、同じ要求を少しずつ時間をずらして最大4回まで送り、最初に成功した結果を使う(要求IDが同じなので、サーバー側で二重に実行されない)。
  var HEDGE_MS = CFG.HEDGE_MS || 7000, TRY_TIMEOUT_MS = CFG.TRY_TIMEOUT_MS || 25000, MAX_TRIES = 4;
  function rid() { return (window.crypto && crypto.randomUUID) ? crypto.randomUUID().replace(/-/g, '').slice(0, 24) : String(Date.now()) + Math.random().toString(36).slice(2, 10); }
  function postJson(body, onTry) {
    return new Promise(function (resolve, reject) {
      var started = 0, failed = 0, done = false, timer = null;
      function finish(fn, v) { if (done) return; done = true; clearTimeout(timer); fn(v); }
      function launch() {
        if (done || started >= MAX_TRIES) return;
        started++; if (onTry) onTry(started);
        var ac = new AbortController(), t = setTimeout(function () { ac.abort(); }, TRY_TIMEOUT_MS);
        fetch(CFG.GAS_URL, { method: 'POST', headers: { 'Content-Type': 'text/plain;charset=utf-8' }, body: JSON.stringify(body), signal: ac.signal })
          .then(function (r) { return r.text(); })
          .then(function (txt) { return JSON.parse(txt); })
          .then(function (j) { clearTimeout(t); finish(resolve, j); })
          .catch(function () {
            clearTimeout(t); failed++;
            if (failed >= MAX_TRIES) finish(reject, Object.assign(new Error('通信がうまくいきませんでした。Google側の応答が不安定なことがあります。もう一度お試しください。'), { code: 'net' }));
            else launch(); // 失敗したら、待たずに次を送る
          });
        clearTimeout(timer); if (started < MAX_TRIES) timer = setTimeout(launch, HEDGE_MS);
      }
      launch();
    });
  }
  function api(action, payload, onTry) {
    if (DEMO) return demoApi(action, payload);
    var body = Object.assign({ action: action, idToken: token, rid: rid() }, payload || {});
    return postJson(body, onTry).then(function (j) { if (!j.ok) { var e = new Error(j.message || '失敗しました'); e.code = j.error; throw e; } return j; });
  }

  function showLogin(msg) {
    $('loginCard').style.display = ''; $('chatCard').style.display = 'none'; $('who').textContent = '';
    var el = $('loginErr'); el.style.display = msg ? '' : 'none'; el.textContent = msg || '';
  }
  function showChat(me) {
    $('loginCard').style.display = 'none'; $('chatCard').style.display = '';
    $('who').textContent = me.name + ' さん' + (me.isAdmin ? '(管理者)' : '');
  }

  // ログイン確認中の表示(Google側が遅いと30秒ほどかかることがあるため、待っていることを伝える)
  function loginBusy(on, tries) {
    var el = $('loginBusy'); el.style.display = on ? '' : 'none';
    if (on) el.textContent = 'ログインを確認しています…' + (tries > 1 ? '(混み合っているため再試行しています ' + tries + '/' + MAX_TRIES + ')' : '(最大30秒ほどかかることがあります)');
    $('gsiBtn').style.display = on ? 'none' : '';
  }
  function checkMe() {
    showLogin(''); loginBusy(true, 1);
    return api('me', null, function (n) { loginBusy(true, n); }).then(function (me) { loginBusy(false); showChat(me); })
      .catch(function (e) { loginBusy(false); tokenSet(''); token = ''; showLogin(e.message); renderBtn(); });
  }
  function onCredential(resp) { token = resp.credential; tokenSet(token); checkMe(); }

  function initLogin() {
    if (DEMO) { showChat({ name: 'デモ', isAdmin: false }); return; }
    if (!CFG.GAS_URL || !CFG.CLIENT_ID) { $('setupNote').style.display = ''; showLogin(''); return; }
    var saved = tokenGet();
    if (saved) { token = saved; checkMe(); }
    else { showLogin(''); renderBtn(); }
  }
  // Googleのログインボタンを出す(読み込めないときは10秒で諦めて案内を出す)
  var btnTimer = null;
  function renderBtn() {
    if (btnTimer) return;
    var waited = 0;
    btnTimer = setInterval(function () {
      waited += 200;
      if (window.google && google.accounts && google.accounts.id) {
        clearInterval(btnTimer); btnTimer = null;
        google.accounts.id.initialize({ client_id: CFG.CLIENT_ID, callback: onCredential, auto_select: true });
        $('gsiBtn').textContent = '';
        google.accounts.id.renderButton($('gsiBtn'), { theme: 'outline', size: 'large', text: 'signin_with', locale: 'ja' });
      } else if (waited >= 10000) {
        clearInterval(btnTimer); btnTimer = null;
        showLogin('Googleのログインを読み込めませんでした。ページを再読み込みしてください。');
      }
    }, 200);
  }

  // ---------- 質問と回答の表示(回答文はtextContentで入れる) ----------
  function el(tag, cls, text) { var e = document.createElement(tag); if (cls) e.className = cls; if (text != null) e.textContent = text; return e; }

  function addMessage(question) {
    var wrap = el('div', 'msg'); wrap.appendChild(el('div', 'q', question));
    var a = el('div', 'a', '考え中…'); wrap.appendChild(a);
    $('log').appendChild(wrap); wrap.scrollIntoView({ block: 'end', behavior: 'smooth' });
    return { wrap: wrap, a: a };
  }
  function renderAnswer(m, r) {
    m.a.textContent = '';
    if (r.answerable) {
      m.a.appendChild(el('div', '', r.answer));
      m.a.appendChild(el('div', 'src', '根拠: ' + r.sources.join(' / ') + (r.asOf ? '\nデータ: ' + r.asOf : '')));
      m.a.querySelector('.src').style.whiteSpace = 'pre-wrap';
    } else {
      m.a.classList.add('ng');
      m.a.appendChild(el('div', '', 'この質問には答えられませんでした。担当者に届けました。確認後、答えられるようになります。'));
    }
    var fb = el('div', 'fb'), thanks = el('span', 'thanks');
    var good = el('button', 'btn', '👍 役に立った'), bad = el('button', 'btn', '👎 間違っている');
    var box = el('div'); box.style.display = 'none';
    var ta = el('textarea'); ta.rows = 2; ta.maxLength = 300; ta.placeholder = 'どこが違うか(任意)';
    var send = el('button', 'btn primary', '送信'); send.type = 'button';
    function done(rating, comment) {
      good.disabled = bad.disabled = send.disabled = true;
      api('feedback', { qid: r.qid, rating: rating, comment: comment }).then(function () {
        thanks.textContent = rating === 'bad' ? '報告しました。担当者が確認します。' : 'ありがとうございます。';
        box.style.display = 'none';
      }).catch(function (e) { good.disabled = bad.disabled = send.disabled = false; thanks.textContent = '送れませんでした: ' + e.message; });
    }
    good.type = bad.type = 'button';
    good.onclick = function () { good.classList.add('on'); done('good', ''); };
    bad.onclick = function () { bad.classList.add('on'); box.style.display = ''; ta.focus(); };
    send.onclick = function () { done('bad', ta.value); };
    fb.appendChild(good); fb.appendChild(bad); fb.appendChild(thanks);
    box.appendChild(ta); box.appendChild(send);
    m.a.appendChild(fb); m.a.appendChild(box);
  }

  function onSubmit(ev) {
    ev.preventDefault();
    var q = $('q').value.trim(); if (!q) return;
    $('q').value = ''; $('qcnt').textContent = '0/300'; $('sendBtn').disabled = true;
    var m = addMessage(q), t0 = Date.now(), tries = 1;
    var tick = setInterval(function () {
      m.a.textContent = '考え中…' + Math.round((Date.now() - t0) / 1000) + '秒' + (tries > 1 ? '(混み合っているため再試行しています ' + tries + '/' + MAX_TRIES + ')' : '');
    }, 1000);
    api('ask', { question: q }, function (n) { tries = n; }).then(function (r) { clearInterval(tick); renderAnswer(m, r); })
      .catch(function (e) {
        clearInterval(tick);
        m.a.classList.add('ng'); m.a.textContent = e.message;
        if (e.code === 'auth') { tokenSet(''); token = ''; showLogin(e.message); renderBtn(); }
      })
      .then(function () { $('sendBtn').disabled = false; });
  }

  // ---------- 画面確認用のダミー(?demo=1) ----------
  function demoApi(action, p) {
    return new Promise(function (resolve) {
      setTimeout(function () {
        if (action === 'me') return resolve({ ok: true, name: 'デモ', isAdmin: false });
        if (action === 'feedback') return resolve({ ok: true });
        var known = /有給|休暇/.test(p.question);
        resolve(known
          ? { ok: true, qid: 'demo0001', answerable: true, answer: '(デモ表示)年次有給休暇は、法令どおり勤続年数に応じて付与されます。', sources: ['就業規則 第33条(年次有給休暇)'], asOf: 'デモ', ms: { total: 1 } }
          : { ok: true, qid: 'demo0002', answerable: false, answer: '', sources: [], asOf: 'デモ', ms: { total: 1 } });
      }, 400);
    });
  }

  $('askForm').addEventListener('submit', onSubmit);
  $('q').addEventListener('input', function () { $('qcnt').textContent = $('q').value.length + '/300'; });
  $('q').addEventListener('keydown', function (e) { if ((e.ctrlKey || e.metaKey) && e.key === 'Enter') $('askForm').requestSubmit(); });
  initLogin();
})();
