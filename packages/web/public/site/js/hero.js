/* The press: megabytes of evidence are struck into one 256-byte proof.
   Physics: things gather weight slowly (expo.in), land in one hard frame, recoil 2px, then hold. */
(function () {
  var stage = document.getElementById('stage');
  if (!stage || !window.gsap) return;
  var reduce = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
  var die = document.getElementById('die'), coin = document.getElementById('coin'), flash = document.getElementById('flash');
  var frags = [].slice.call(document.querySelectorAll('#frags li'));
  var shine = coin.querySelector('.coin-shine'), status = document.getElementById('press-status');
  var btn = document.getElementById('strike'), canvas = document.getElementById('ore'), ctx = canvas.getContext('2d');
  var state = { pull: 0, sparks: 0 }, visible = true, busy = false;

  /* Ore dust on canvas: cheap, one draw call per speck, paused offscreen. */
  var specks = [], W = 0, H = 0, dpr = Math.min(window.devicePixelRatio || 1, 2);
  function size() {
    var r = stage.getBoundingClientRect(); W = r.width; H = r.height;
    canvas.width = W * dpr; canvas.height = H * dpr; ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  }
  function seed() {
    specks = [];
    for (var i = 0; i < 150; i++) specks.push({ x: Math.random(), y: .3 + Math.random() * .7, r: .6 + Math.random() * 1.8,
      a: Math.random() * 6.28, v: .0006 + Math.random() * .0012, g: Math.random() < .12, dx: Math.random() * 2 - 1, dy: -Math.random() });
  }
  function draw() {
    if (!visible) return;
    ctx.clearRect(0, 0, W, H);
    var p = state.pull, cx = W / 2, cy = H / 2, s = state.sparks;
    for (var i = 0; i < specks.length; i++) {
      var k = specks[i]; k.a += k.v * 8;
      var x = (k.x + Math.sin(k.a) * .01) * W, y = (k.y + Math.cos(k.a * .7) * .008) * H;
      x += (cx - x) * p; y += (cy - y) * p;
      var alpha = (1 - p) * .55;
      if (k.g && s > 0) { x = cx + k.dx * s * W * .45; y = cy + k.dy * s * H * .45; alpha = 1 - s; }
      if (alpha <= .01) continue;
      ctx.globalAlpha = alpha; ctx.fillStyle = k.g && s > 0 ? '#ecd29a' : '#6d6253';
      ctx.fillRect(x, y, k.r, k.r);
    }
    ctx.globalAlpha = 1;
  }
  size(); seed();
  if (!reduce) gsap.ticker.add(draw);
  window.addEventListener('resize', function () { size(); draw(); });
  new IntersectionObserver(function (e) { visible = e[0].isIntersecting; }).observe(stage);

  function centerOffset(el) {
    var s = stage.getBoundingClientRect(), r = el.getBoundingClientRect();
    return { x: s.left + s.width / 2 - (r.left + r.width / 2), y: s.top + s.height / 2 - (r.top + r.height / 2) };
  }
  function reset() {
    gsap.set(frags, { x: 0, y: 0, scale: 1, opacity: 1 });
    gsap.set(coin, { scale: .3, opacity: 0, y: 0 });
    gsap.set(die, { yPercent: -105 });
    state.pull = 0; state.sparks = 0;
    status.textContent = 'Megabytes of evidence, waiting to be proven.';
  }
  function settled() {
    gsap.set(frags, { opacity: 0 }); gsap.set(die, { yPercent: -105 }); gsap.set(coin, { scale: 1, opacity: 1 });
    status.textContent = 'Struck: PASS, in 256 bytes. Anyone can check it onchain.';
  }

  /* One strike. from = how far the hold already pressed (0..1). */
  function strike(from) {
    busy = true;
    var t = gsap.timeline({ onComplete: function () { busy = false; status.textContent = 'Struck: PASS, in 256 bytes. Anyone can check it onchain.'; } });
    var rest = 1 - (from || 0);
    t.to(frags, { x: function (i, el) { return centerOffset(el).x + gsap.getProperty(el, 'x'); },
                  y: function (i, el) { return centerOffset(el).y + gsap.getProperty(el, 'y'); },
                  scale: .15, opacity: 0, duration: .5 + .6 * rest, ease: 'expo.in', stagger: .05 }, 0)
     .to(state, { pull: 1, duration: .6 + .6 * rest, ease: 'expo.in' }, 0)
     .to(die, { yPercent: 66, duration: .5 + .5 * rest, ease: 'expo.in' }, .25)
     .addLabel('impact')
     .set(coin, { opacity: 1, scale: 1.06 }, 'impact')
     .fromTo(flash, { opacity: .9 }, { opacity: 0, duration: .5, ease: 'expo.out' }, 'impact')
     .fromTo(stage, { y: 2 }, { y: 0, duration: .25, ease: 'expo.out' }, 'impact')
     .to(coin, { scale: 1, duration: .6, ease: 'expo.out' }, 'impact')
     .to(state, { sparks: 1, duration: 1.1, ease: 'expo.out' }, 'impact')
     .to(die, { yPercent: -105, duration: 1, ease: 'expo.out' }, 'impact+=.12');
    status.textContent = 'Striking the proof…';
    return t;
  }

  if (reduce) { settled(); return; }

  reset();
  gsap.delayedCall(1, function () { strike(0).eventCallback('onComplete', function () { busy = false; btn.hidden = false; settled(); }); });

  /* Hold to strike: the die descends while held; release strikes. */
  var hold = null, held = 0;
  function down(e) {
    if (busy || hold) return;
    if (e && e.type === 'keydown' && e.key !== ' ' && e.key !== 'Enter') return;
    if (e && e.type === 'keydown') { if (e.repeat) return; e.preventDefault(); }
    reset(); stage.classList.add('holding'); status.textContent = 'Pressing… release to strike.';
    held = 0;
    hold = gsap.timeline()
      .to(die, { yPercent: 20, duration: 1.4, ease: 'expo.in' }, 0)
      .to(state, { pull: .55, duration: 1.4, ease: 'expo.in' }, 0)
      .to(frags, { scale: .8, x: function (i, el) { return centerOffset(el).x * .35; }, y: function (i, el) { return centerOffset(el).y * .35; }, duration: 1.4, ease: 'expo.in' }, 0)
      .eventCallback('onUpdate', function () { held = this.progress(); });
  }
  function up(e) {
    if (!hold) return;
    if (e && e.type === 'keyup' && e.key !== ' ' && e.key !== 'Enter') return;
    hold.kill(); hold = null; stage.classList.remove('holding');
    strike(Math.max(held * .7, .2));
  }
  btn.addEventListener('pointerdown', down); btn.addEventListener('keydown', down);
  window.addEventListener('pointerup', up); btn.addEventListener('keyup', up); btn.addEventListener('pointercancel', up);
  btn.addEventListener('click', function (e) { if (e.detail === 0 && !hold && !busy) { reset(); strike(0); } });

  /* Cursor-reactive depth: the coin tilts toward the pointer and the light slides across it. */
  if (window.matchMedia('(pointer: fine)').matches) {
    var press = document.getElementById('press');
    var rx = gsap.quickTo(coin, 'rotationX', { duration: .6, ease: 'expo.out' }), ry = gsap.quickTo(coin, 'rotationY', { duration: .6, ease: 'expo.out' });
    var sx = gsap.quickTo(shine, 'x', { duration: .6, ease: 'expo.out' }), sy = gsap.quickTo(shine, 'y', { duration: .6, ease: 'expo.out' });
    press.addEventListener('pointermove', function (e) {
      var r = stage.getBoundingClientRect(), nx = (e.clientX - r.left) / r.width - .5, ny = (e.clientY - r.top) / r.height - .5;
      ry(nx * 28); rx(-ny * 28); sx(nx * r.width * .35); sy(ny * r.height * .35);
    });
    press.addEventListener('pointerleave', function () { rx(0); ry(0); sx(0); sy(0); });
  }
})();
