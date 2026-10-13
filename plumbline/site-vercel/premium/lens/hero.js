/* The lens: scattered evidence (diffuse light) is focused into one bright point, the proof.
   Physics: sine. Light drifts, converges and brightens; the lens glides, it never snaps.
   Signature: the cursor is the lens. Inside it, self-reported claims resolve into what the proof checks. */
(function () {
  var stage = document.getElementById('stage');
  if (!stage || !window.gsap) return;
  var reduce = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
  var lens = document.getElementById('lens'), proven = document.getElementById('proven'), focus = document.getElementById('focus');
  var status = document.getElementById('press-status'), again = document.getElementById('refocus');
  var canvas = document.getElementById('light'), ctx = canvas.getContext('2d');
  var W = 0, H = 0, L = 0, dpr = Math.min(window.devicePixelRatio || 1, 2), visible = true;
  var pos = { x: 0, y: 0 }, state = { pull: 0 };
  var colors = ['#8fd8ff', '#b6a4ff', '#ffe9b0', '#d4f0ff'], pts = [];

  function size() {
    var r = stage.getBoundingClientRect(); W = r.width; H = r.height; L = lens.offsetWidth;
    canvas.width = W * dpr; canvas.height = H * dpr; ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    proven.style.width = W + 'px'; proven.style.height = H + 'px';
    place();
  }
  for (var i = 0; i < 220; i++) pts.push({ x: Math.random(), y: Math.random(), r: .4 + Math.random() * 1.6, a: Math.random() * 6.28,
    v: .002 + Math.random() * .004, c: colors[i % 4], o: .25 + Math.random() * .6 });

  /* Keep the readout inside the lens fixed to the stage: lens moves +x, its contents move -x. Transform only. */
  function place() {
    gsap.set(lens, { x: pos.x - L / 2, y: pos.y - L / 2 });
    gsap.set(proven, { x: -(pos.x - L / 2), y: -(pos.y - L / 2) });
  }
  function draw() {
    if (!visible) return;
    ctx.clearRect(0, 0, W, H);
    var p = state.pull, cx = W / 2, cy = H / 2;
    ctx.globalCompositeOperation = 'lighter';
    for (var i = 0; i < pts.length; i++) {
      var k = pts[i]; k.a += k.v;
      var x = (k.x + Math.sin(k.a) * .015) * W, y = (k.y + Math.cos(k.a * .8) * .015) * H;
      x += (cx - x) * p; y += (cy - y) * p;
      var al = k.o * (1 - p * .85);
      if (al < .02) continue;
      ctx.globalAlpha = al; ctx.fillStyle = k.c;
      ctx.beginPath(); ctx.arc(x, y, k.r * (1 - p * .5), 0, 6.283); ctx.fill();
    }
    ctx.globalAlpha = 1; ctx.globalCompositeOperation = 'source-over';
  }
  size();
  window.addEventListener('resize', size);
  new IntersectionObserver(function (e) { visible = e[0].isIntersecting; }).observe(stage);

  function focused() { status.textContent = 'In focus: PASS, in 256 bytes. Move the lens to see what the proof checks.'; }
  if (reduce) {
    pos.x = W / 2; pos.y = H * .42; place(); state.pull = .7; draw(); stage.classList.add('dimmed'); focused();
  } else {
    gsap.ticker.add(draw);
    var run = function () {
      following = false; gsap.killTweensOf([state, focus]);
      stage.classList.remove('dimmed'); again.hidden = true;
      pos.x = -L; pos.y = H / 2; place(); state.pull = 0;
      gsap.set(focus, { opacity: 0, scale: .6 });
      status.textContent = 'Scattered evidence, coming into focus…';
      gsap.timeline({ onComplete: function () { focused(); again.hidden = false; following = true; } })
        .to(pos, { x: W / 2, duration: 2.2, ease: 'sine.inOut', onUpdate: place }, .4)
        .to(state, { pull: .82, duration: 1.8, ease: 'sine.inOut' }, 1.6)
        .add(function () { stage.classList.add('dimmed'); }, 2.4)
        .to(focus, { opacity: 1, scale: 1, duration: 1.2, ease: 'sine.out' }, 2.8);
    };
    gsap.delayedCall(.6, run);
    again.addEventListener('click', run);
  }

  /* Move the lens: pointer follows on desktop, drag on touch, arrow keys from the keyboard. */
  var following = reduce, gx = gsap.quickTo(pos, 'x', { duration: reduce ? 0 : .9, ease: 'sine.out', onUpdate: place });
  var gy = gsap.quickTo(pos, 'y', { duration: reduce ? 0 : .9, ease: 'sine.out', onUpdate: place });
  function to(x, y) { gx(Math.max(0, Math.min(W, x))); gy(Math.max(0, Math.min(H, y))); }
  var dragging = false;
  stage.addEventListener('pointerdown', function (e) { if (e.pointerType !== 'mouse') dragging = true; following = true; });
  window.addEventListener('pointerup', function () { dragging = false; });
  stage.addEventListener('pointermove', function (e) {
    if (!following || (e.pointerType !== 'mouse' && !dragging)) return;
    var r = stage.getBoundingClientRect(); to(e.clientX - r.left, e.clientY - r.top);
  });
  stage.addEventListener('keydown', function (e) {
    var d = { ArrowLeft: [-1, 0], ArrowRight: [1, 0], ArrowUp: [0, -1], ArrowDown: [0, 1] }[e.key];
    if (!d) return; e.preventDefault(); following = true; to(pos.x + d[0] * W * .08, pos.y + d[1] * H * .08);
  });
})();
