'use strict';
(function () {
  var CFG = window.AI_CONFIG || {};
  var DEMO = /[?&]demo=1/.test(location.search);
  var token = '';
  var $ = function (id) { return document.getElementById(id); };

  function tokenGet() { try { return sessionStorage.getItem('ai_token') || ''; } catch (e) { return ''; } }
  function tokenSet(t) { try { if (t) sessionStorage.setItem('ai_token', t); else sessionStorage.removeItem('ai_token'); } catch (e) {} }

  // GASへ。text/plainで送ると事前確認(CORS preflight)が要らない
  function api(action, payload) {
    if (DEMO) return demoApi(action, payload);
    var body = Object.assign({ action: action, idToken: token }, payload || {});
    return fetch(CFG.GAS_URL, { method: 'POST', headers: { 'Content-Type': 'text/plain;charset=utf-8' }, body: JSON.stringify(body) })
      .then(function (r) { return r.json(); })
      .then(function (j) { if (!j.ok) { var e = new Error(j.message || '失敗しました'); e.code = j.error; throw e; } return j; });
  }

  function showLogin(msg) {
    $('loginCard').style.display = ''; $('chatCard').style.display = 'none'; $('who').textContent = '';
    var el = $('loginErr'); el.style.display = msg ? '' : 'none'; el.textContent = msg || '';
  }
  function showChat(me) {
    $('loginCard').style.display = 'none'; $('chatCard').style.display = '';
    $('who').textContent = me.name + ' さん' + (me.isAdmin ? '(管理者)' : '');
  }

  function onCredential(resp) {
    token = resp.credential; tokenSet(token);
    api('me').then(showChat).catch(function (e) { tokenSet(''); token = ''; showLogin(e.message); });
  }

  function initLogin() {
    if (DEMO) { showChat({ name: 'デモ', isAdmin: false }); return; }
    if (!CFG.GAS_URL || !CFG.CLIENT_ID) { $('setupNote').style.display = ''; showLogin(''); return; }
    var saved = tokenGet();
    if (saved) { token = saved; api('me').then(showChat).catch(function () { tokenSet(''); token = ''; renderBtn(); }); }
    else renderBtn();
  }
  function renderBtn() {
    showLogin('');
    var t = setInterval(function () {
      if (!(window.google && google.accounts && google.accounts.id)) return;
      clearInterval(t);
      google.accounts.id.initialize({ client_id: CFG.CLIENT_ID, callback: onCredential, auto_select: true });
      google.accounts.id.renderButton($('gsiBtn'), { theme: 'outline', size: 'large', text: 'signin_with', locale: 'ja' });
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
    var m = addMessage(q);
    api('ask', { question: q }).then(function (r) { renderAnswer(m, r); })
      .catch(function (e) {
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
