/* 「← アプリ一覧へ」ボタン(アプリ一覧=ランチャーへ戻る)。
 * 使い方: <script src="to-launcher.js?v=..." data-target="CSSセレクタ" data-mode="in|before|beforePrev"></script>
 *   in         … target要素の先頭にボタンを入れる
 *   before     … target要素の直前に入れる
 *   beforePrev … target要素の直前の兄弟がロゴ(img/svg/小さいdiv)ならその前、違えばtargetの直前に入れる
 *   after      … target要素の直後(右側)に入れる(truck-fax。会社名の右側。2026-10-28)
 * 正本は docs/to-launcher/to-launcher.js。各アプリのフォルダへ同じファイルをコピーして使う(Vercelはフォルダ単位で配信するため)。
 * - 背景が暗いアプリ: 明るいボタン+濃い文字+金色の光 / 明るいアプリ: 暗いボタン+明るい文字+濃い赤・ピンクの光
 * - 背景色(7秒周期)と文字色(3秒周期)は別のリズムで変化。どの組み合わせもコントラスト比6.7以上
 * - 画面内の他のボタンの色相から40°以上離れた色だけを使う */
(function () {
  var LAUNCHER_URL = 'https://app-launcher-ashy.vercel.app/';
  var cur = document.currentScript;
  var TARGET = cur && cur.getAttribute('data-target');
  var MODE = (cur && cur.getAttribute('data-mode')) || 'in';
  if (!TARGET) return;

  var css = [
    '.to-launcher{box-sizing:border-box!important;flex:none!important;display:inline-flex!important;align-items:center;vertical-align:middle;position:relative;z-index:50;',
    'height:30px!important;margin:0 12px 0 0!important;padding:0 14px!important;',
    'font:700 13px/1 "Hiragino Sans","Yu Gothic",Meiryo,sans-serif!important;letter-spacing:0!important;text-transform:none!important;text-shadow:none!important;',
    'color:#1a1030;background:#ffd54a;border:2px solid var(--glow-edge);border-radius:999px;text-decoration:none!important;white-space:nowrap;cursor:pointer;',
    '--glow:255,200,40;--glow-edge:#ffd54a;',
    'box-shadow:0 0 6px 1px rgba(var(--glow),.7),0 0 14px 3px rgba(var(--glow),.45);',
    'animation:to-launcher-bg 7s linear infinite,to-launcher-fg-dark 3s linear infinite,to-launcher-glow 1.8s ease-in-out infinite}',
    '.to-launcher.on-light{--glow:220,20,90;--glow-edge:#e0145a;--bg0:#8f0c2b;--bg1:#163a8a;--bg2:#085233;--bg3:#4d1d85;--bg4:#7a3800;color:#fff;background:#8f0c2b;',
    'animation-name:to-launcher-bg,to-launcher-fg,to-launcher-glow}',
    '.to-launcher.after{margin:0 0 0 4px!important}',
    '.to-launcher:hover{filter:brightness(1.15)}',
    '.to-launcher:focus-visible{outline:3px solid #fff;outline-offset:2px}',
    '@keyframes to-launcher-bg{0%,100%{background-color:var(--bg0,#ffd54a)}20%{background-color:var(--bg1,#8fe3ff)}40%{background-color:var(--bg2,#ffb3d1)}60%{background-color:var(--bg3,#b8f5c0)}80%{background-color:var(--bg4,#d9c2ff)}}',
    '@keyframes to-launcher-fg{0%,100%{color:#fff}25%{color:#fff59d}50%{color:#b9f6ff}75%{color:#ffd6e8}}',
    '@keyframes to-launcher-fg-dark{0%,100%{color:#1a1030}25%{color:#3a0a1a}50%{color:#0a2a3a}75%{color:#2a1a00}}',
    '@keyframes to-launcher-glow{0%,100%{box-shadow:0 0 4px 0 rgba(var(--glow),.55),0 0 10px 2px rgba(var(--glow),.3)}50%{box-shadow:0 0 9px 2px rgba(var(--glow),.95),0 0 22px 6px rgba(var(--glow),.6)}}',
    '@media (max-width:480px){.to-launcher{height:28px!important;padding:0 10px!important;font-size:12px!important;margin-right:8px!important}}',
    '@media (prefers-reduced-motion:reduce){.to-launcher{animation:none!important}}',
    '@media print{.to-launcher{display:none!important}}'
  ].join('');
  var st = document.createElement('style');
  st.textContent = css;
  (document.head || document.documentElement).appendChild(st);

  function parse(c) { var m = c.match(/[\d.]+/g); return m ? m.map(Number) : null; }
  function lin(v) { v /= 255; return v <= 0.03928 ? v / 12.92 : Math.pow((v + 0.055) / 1.055, 2.4); }
  function hsl(r, g, b) {
    r /= 255; g /= 255; b /= 255;
    var mx = Math.max(r, g, b), mn = Math.min(r, g, b), l = (mx + mn) / 2, d = mx - mn, h = 0, s = 0;
    if (d) {
      s = d / (1 - Math.abs(2 * l - 1));
      h = mx === r ? ((g - b) / d) % 6 : mx === g ? (b - r) / d + 2 : (r - g) / d + 4;
      h = (h * 60 + 360) % 360;
    }
    return { h: h, s: s, l: l };
  }
  function hex(c) { var n = parseInt(c.slice(1), 16); return [n >> 16, (n >> 8) & 255, n & 255]; }
  function visible(el) { return !!(el.offsetWidth || el.offsetHeight || el.getClientRects().length); }

  function colorize(b) {
    var bg = [255, 255, 255];
    for (var e = b.parentElement; e; e = e.parentElement) {
      var m = parse(getComputedStyle(e).backgroundColor);
      if (m && (m.length < 4 || m[3] > 0.5)) { bg = m.slice(0, 3); break; }
    }
    var light = 0.2126 * lin(bg[0]) + 0.7152 * lin(bg[1]) + 0.0722 * lin(bg[2]) > 0.4;
    if (light) b.classList.add('on-light');
    var used = [];
    var els = document.querySelectorAll('button, a, input[type=button], input[type=submit], [role=button], [class*=btn], [class*=button]');
    for (var i = 0; i < els.length; i++) {
      var el = els[i];
      if (el === b || !visible(el)) continue;
      var c = parse(getComputedStyle(el).backgroundColor);
      if (!c || (c.length > 3 && c[3] < 0.5)) continue;
      var k = hsl(c[0], c[1], c[2]);
      if (k.s > 0.25 && k.l > 0.12 && k.l < 0.92) used.push(k.h);
    }
    var cand = light
      ? ['#8f0c2b', '#163a8a', '#085233', '#4d1d85', '#7a3800', '#094a57', '#4a4800', '#741a5b']
      : ['#ffd54a', '#8fe3ff', '#ffb3d1', '#b8f5c0', '#d9c2ff', '#ffb27a', '#e6ff7a', '#7affd9'];
    function dist(col) {
      var x = hex(col), h = hsl(x[0], x[1], x[2]).h, d = 360;
      used.forEach(function (u) { d = Math.min(d, Math.min(Math.abs(h - u), 360 - Math.abs(h - u))); });
      return d;
    }
    var ok = cand.filter(function (col) { return dist(col) >= 40; });
    if (ok.length < 3) ok = cand.slice().sort(function (a, c) { return dist(c) - dist(a); }).slice(0, 4);
    for (var j = 0; j < 5; j++) b.style.setProperty('--bg' + j, ok[j % ok.length]);
  }

  function insert() {
    if (document.querySelector('.to-launcher')) return true;
    var el = null, list = document.querySelectorAll(TARGET);
    for (var i = 0; i < list.length; i++) { if (visible(list[i])) { el = list[i]; break; } }
    if (!el) return false;
    var a = document.createElement('a');
    a.className = 'to-launcher';
    a.href = LAUNCHER_URL;
    a.textContent = '← アプリ一覧へ';
    if (MODE === 'in') el.insertBefore(a, el.firstChild);
    else if (MODE === 'beforePrev') {
      var pv = el.previousElementSibling;
      var logo = pv && /^(img|svg|div)$/i.test(pv.tagName) && pv.getBoundingClientRect().width < 250;
      el.parentNode.insertBefore(a, logo ? pv : el);
    } else if (MODE === 'after') { a.classList.add('after'); el.parentNode.insertBefore(a, el.nextSibling); }
    else el.parentNode.insertBefore(a, el);
    colorize(a);
    return true;
  }

  function start() {
    insert();
    var pending = false;
    new MutationObserver(function () {
      if (pending) return;
      pending = true;
      requestAnimationFrame(function () { pending = false; if (!document.querySelector('.to-launcher')) insert(); });
    }).observe(document.body, { childList: true, subtree: true });
  }
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', start); else start();
})();
