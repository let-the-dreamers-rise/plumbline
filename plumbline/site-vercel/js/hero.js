/* Hero: a crooked stack settles true under a swinging plumb bob; the draw unlocks.
   Physics: damped pendulum. Big swing, smaller swings, rest at true vertical. */
(function () {
  if (window.gsap && document.fonts && document.fonts.status !== 'loaded') {
    var once = false, go = arguments.callee;
    var run = function () { if (!once) { once = true; go.ready = 1; go(); } };
    if (!go.ready) { document.fonts.ready.then(run); setTimeout(run, 1500); return; }
  }
  if (!window.gsap) { document.documentElement.classList.remove('js'); return; }
  gsap.registerPlugin(ScrollTrigger, SplitText);
  var reduce = matchMedia('(prefers-reduced-motion: reduce)').matches;
  var blocks = gsap.utils.toArray('.hero .blk');
  var gate = document.querySelector('.hero .gate');

  function finalState() {
    gsap.set('.hero-copy > *', { opacity: 1 });
    gsap.set('.hero .gate-t.locked', { opacity: 0 });
    gsap.set('.hero .gate-t.open', { opacity: 1 });
    gate.classList.add('is-open');
  }
  if (reduce) { finalState(); return; }

  /* Crooked start: each block offset and tilted from true. */
  blocks.forEach(function (b) {
    gsap.set(b, { x: +b.dataset.off, rotation: +b.dataset.rot, transformOrigin: '50% 100%' });
  });
  gsap.set('.hero .pendulum', { rotation: 28, svgOrigin: '200 10' });

  /* Headline: masked line reveal. */
  var split = SplitText.create('#hero-h', { type: 'lines', mask: 'lines' });
  var tl = gsap.timeline({ delay: .15 });
  gsap.set('#hero-h', { opacity: 1 });
  tl.from(split.lines, { yPercent: 105, duration: 1, ease: 'expo.out', stagger: .08 })
    .fromTo('.hero-copy > :not(h1)', { y: 18, opacity: 0 }, { y: 0, opacity: 1, duration: .9, ease: 'expo.out', stagger: .1 }, .25)
    /* Damped swing: each half-swing smaller, then rest. */
    .to('.hero .pendulum', {
      keyframes: [
        { rotation: -18, duration: .55, ease: 'sine.inOut' },
        { rotation: 11, duration: .5, ease: 'sine.inOut' },
        { rotation: -6, duration: .45, ease: 'sine.inOut' },
        { rotation: 3, duration: .4, ease: 'sine.inOut' },
        { rotation: 0, duration: .5, ease: 'sine.out' }
      ]
    }, .2)
    /* Blocks follow the line: settle true from the bottom up. */
    .to(blocks, { x: 0, rotation: 0, duration: 1.3, ease: 'elastic.out(1, 0.55)', stagger: .14 }, .9)
    .to('.hero .gate-t.locked', { opacity: 0, duration: .25 }, 2.4)
    .to('.hero .gate-t.open', { opacity: 1, duration: .4, ease: 'expo.out' }, 2.5)
    .add(function () { gate.classList.add('is-open'); }, 2.5);

  /* Idle breathing: the bob never quite stops, like a real line. Paused offscreen. */
  var idle = gsap.to('.hero .pendulum', { rotation: 1.2, duration: 2.6, ease: 'sine.inOut', yoyo: true, repeat: -1, paused: true });
  tl.add(function () { gsap.set('.hero .pendulum', { rotation: -1.2 }); idle.play(); });
  ScrollTrigger.create({
    trigger: '.hero', start: 'top top', end: 'bottom top',
    onToggle: function (s) { if (tl.progress() === 1) s.isActive ? idle.play() : idle.pause(); }
  });

  /* Cursor-reactive depth: layers drift by depth, the bob leans toward the cursor. */
  var stage = document.querySelector('.hero-stage');
  if (matchMedia('(pointer: fine)').matches) {
    var layers = [['.hero .depth-0', 6], ['.hero .depth-1', 14], ['.hero .depth-2', 22]].map(function (d) {
      return { x: gsap.quickTo(d[0], 'x', { duration: .9, ease: 'expo.out' }), y: gsap.quickTo(d[0], 'y', { duration: .9, ease: 'expo.out' }), k: d[1] };
    });
    stage.addEventListener('pointermove', function (e) {
      var r = stage.getBoundingClientRect();
      var nx = (e.clientX - r.left) / r.width - .5, ny = (e.clientY - r.top) / r.height - .5;
      layers.forEach(function (l) { l.x(nx * l.k); l.y(ny * l.k); });
    });
    stage.addEventListener('pointerleave', function () { layers.forEach(function (l) { l.x(0); l.y(0); }); });
  }
})();
