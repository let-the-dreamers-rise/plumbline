/* Scroll motion. One easing family (expo); fast .18s, medium .6s, slow 1.4s.
   Everything is readable before this runs; motion only animates from a visible end state. */
(function () {
  if (!window.gsap) return;
  gsap.registerPlugin(ScrollTrigger, SplitText);
  /* Each direction sets its own physics on <html>: data-ease, data-ease-in-out, data-speed. */
  var D = document.documentElement.dataset, K = +(D.speed || 1), EIO = D.easeInOut || 'expo.inOut';
  gsap.defaults({ ease: D.ease || 'expo.out', duration: .9 * K });

  /* Pause CSS loops (marquee, bento micro-animations, footer sweep) while offscreen. */
  var io = new IntersectionObserver(function (es) {
    es.forEach(function (e) { e.target.classList.toggle('is-off', !e.isIntersecting); });
  }, { rootMargin: '80px' });
  document.querySelectorAll('.marquee, .tile, .foot').forEach(function (el) { io.observe(el); });

  /* Page progress: a thin gold rule under the header, scrubbed by scroll. */
  var bar = document.createElement('i');
  bar.setAttribute('aria-hidden', 'true');
  bar.style.cssText = 'position:absolute;left:0;right:0;bottom:-1px;height:1px;background:var(--ingot);transform-origin:left;transform:scaleX(0)';
  document.querySelector('.nav').appendChild(bar);

  var mm = gsap.matchMedia();
  mm.add('(prefers-reduced-motion: no-preference)', function () {
    gsap.to(bar, { scaleX: 1, ease: 'none', scrollTrigger: { start: 0, end: 'max', scrub: .3 } });

    /* Masked line reveals on every headline: lines rise out of their own line box. */
    document.fonts.ready.then(function () {
      document.querySelectorAll('.reveal').forEach(function (h) {
        var split = SplitText.create(h, { type: 'lines', mask: 'lines', linesClass: 'line' });
        var hero = h.id === 'hero-h';
        gsap.from(split.lines, { yPercent: 110, duration: (hero ? 1.4 : 1) * K, stagger: .09, delay: hero ? .15 : 0,
          scrollTrigger: hero ? null : { trigger: h, start: 'top 88%', once: true } });
      });
      /* Footer: the program address is engraved character by character. */
      var pid = document.getElementById('pid');
      if (pid) gsap.from(SplitText.create(pid, { type: 'chars' }).chars, { opacity: .12, duration: (.3) * K, stagger: .025, ease: 'none',
        scrollTrigger: { trigger: pid, start: 'top 95%', once: true } });
      ScrollTrigger.refresh();
    });

    /* Staggered entrances: content settles up into place, like plates being laid down. */
    gsap.from('.hero-copy > :not(h1)', { y: 24, opacity: 0, duration: (1) * K, stagger: .08, delay: .5 });
    [['.cmp-side', .12], ['.tile', .07], ['.stat-grid li', .06], ['.faq details', .05], ['.calc', 0], ['.plate', 0]].forEach(function (g) {
      ScrollTrigger.batch(g[0], { start: 'top 90%', once: true,
        onEnter: function (els) { gsap.from(els, { y: 36, opacity: 0, duration: (1) * K, stagger: g[1] }); } });
    });

    /* Count-ups: numbers run, then land with a 2% strike. */
    document.querySelectorAll('.num').forEach(function (el) {
      var to = +el.dataset.to, from = +(el.dataset.from || 0), dec = +(el.dataset.dec || 0);
      var pre = el.dataset.prefix || '', suf = el.dataset.suffix || '', o = { v: from };
      ScrollTrigger.create({ trigger: el, start: 'top 90%', once: true, onEnter: function () {
        gsap.timeline()
          .to(o, { v: to, duration: (1.4) * K, ease: EIO, onUpdate: function () { el.textContent = pre + o.v.toFixed(dec) + suf; } })
          .fromTo(el, { scale: 1.04 }, { scale: 1, duration: (.4) * K, transformOrigin: 'left bottom' });
      } });
    });

  });

  /* The story: pinned step-by-step stage on wide screens, scrubbed rule everywhere. */
  var story = document.getElementById('story');
  var steps = [].slice.call(story.querySelectorAll('.step')), seals = [].slice.call(story.querySelectorAll('.seal-step'));
  var fill = document.getElementById('story-fill');
  function setStep(i) {
    steps.forEach(function (s, k) { s.classList.toggle('on', k === i); });
    seals.forEach(function (s, k) { s.classList.toggle('on', k === i); });
  }
  mm.add('(min-width: 900px) and (prefers-reduced-motion: no-preference)', function () {
    story.classList.add('pinned'); setStep(0);
    ScrollTrigger.create({ trigger: story.querySelector('.story-pin'), start: 'center center', end: '+=150%', pin: true, scrub: true,
      onUpdate: function (st) { setStep(Math.min(2, Math.floor(st.progress * 3))); gsap.set(fill, { scaleX: st.progress }); } });
    return function () { story.classList.remove('pinned'); setStep(-1); gsap.set(fill, { scaleX: 1 }); };
  });
  mm.add('(max-width: 899px), (prefers-reduced-motion: reduce)', function () {
    gsap.set(fill, { scaleX: 0 });
    gsap.to(fill, { scaleX: 1, ease: 'none', scrollTrigger: { trigger: story, start: 'top 70%', end: 'bottom 60%', scrub: true } });
    steps.forEach(function (s, k) {
      ScrollTrigger.create({ trigger: s, start: 'top 70%', end: 'bottom 30%', onToggle: function (st) { if (st.isActive) setStep(k); } });
    });
  });

  /* Cursor-reactive depth in the bento: each tile's loop drifts toward the pointer. */
  if (window.matchMedia('(pointer: fine) and (prefers-reduced-motion: no-preference)').matches) {
    document.querySelectorAll('.tile').forEach(function (t) {
      var loop = t.querySelector('.loop'); if (!loop) return;
      var x = gsap.quickTo(loop, 'x', { duration: .8 }), y = gsap.quickTo(loop, 'y', { duration: .8 });
      t.addEventListener('pointermove', function (e) {
        var r = t.getBoundingClientRect(); x(((e.clientX - r.left) / r.width - .5) * 18); y(((e.clientY - r.top) / r.height - .5) * 12);
      });
      t.addEventListener('pointerleave', function () { x(0); y(0); });
    });
  }
})();
