/* Scroll scenes. Everything enters by settling: a short drop past true, then rest. */
(function () {
  var reduce = matchMedia('(prefers-reduced-motion: reduce)').matches;
  var settle = 'expo.out';

  /* Lead form: POST /api/lead with {email, fleetGpus, lender, note}. */
  var form = document.getElementById('lead');
  form.addEventListener('submit', function (e) {
    e.preventDefault();
    var msg = document.getElementById('lead-msg'), btn = document.getElementById('lead-submit');
    var email = form.email.value.trim();
    if (email.indexOf('@') < 1) {
      form.email.setAttribute('aria-invalid', 'true'); form.email.focus();
      msg.textContent = 'Add an email address so we can reply.'; return;
    }
    form.email.removeAttribute('aria-invalid');
    var body = { email: email, fleetGpus: Number(form.fleetGpus.value || 0), lender: form.lender.value.trim(), note: form.note.value.trim() };
    btn.disabled = true; msg.textContent = 'Sending…';
    fetch('/api/lead', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) })
      .then(function (r) {
        if (!r.ok) throw new Error(r.status);
        msg.textContent = 'Received. We will reply to book the pilot.';
        btn.textContent = 'Requested'; form.reset();
      })
      .catch(function () { msg.textContent = 'Could not send from this page. Open an issue on the repository instead.'; btn.disabled = false; });
  });

  /* Loops pause offscreen (marquee, bento micro-animations). */
  var io = new IntersectionObserver(function (es) {
    es.forEach(function (e) { e.target.classList.toggle(e.target.classList.contains('marquee') ? 'paused' : 'off', !e.isIntersecting); });
  });
  document.querySelectorAll('.marquee, .cell').forEach(function (el) { io.observe(el); });

  /* Marquee: duplicate the row so the drift loops seamlessly. */
  var track = document.querySelector('.marquee-track');
  var dup = track.firstElementChild.cloneNode(true);
  dup.setAttribute('aria-hidden', 'true');
  dup.querySelectorAll('a').forEach(function (a) { a.tabIndex = -1; });
  track.appendChild(dup);

  if (!window.gsap) return;
  if (reduce) {
    gsap.set('.cmp-card, .cell, .stat-grid > div, .faq details, .lead > *', { opacity: 1 });
    gsap.set('.cmp-line span, .foot-line span, .track-fill', { scaleY: 1, scaleX: 1 });
    document.querySelectorAll('.step, .ring').forEach(function (s) { s.classList.add('is-on'); });
    return;
  }

  /* Masked line reveals on every section headline. */
  var splitHeads = function () {
    gsap.utils.toArray('.reveal-h').forEach(function (h) {
      if (h.id === 'hero-h') return;
      var s = SplitText.create(h, { type: 'lines', mask: 'lines' });
      gsap.from(s.lines, { yPercent: 105, duration: 1, ease: settle, stagger: .08, scrollTrigger: { trigger: h, start: 'top 85%' } });
    });
    ScrollTrigger.refresh();
  };
  if (document.fonts && document.fonts.status !== 'loaded') {
    var done = false, go = function () { if (!done) { done = true; splitHeads(); } };
    document.fonts.ready.then(go); setTimeout(go, 1500);
  } else splitHeads();

  /* Staggered entrances. */
  [['.live-list li', '.live-list'], ['.app-card', '.app-grid'], ['.cell', '.bento'], ['.stat-grid > div', '.stat-grid'], ['.faq details', '.faq'], ['.lead > *', '.lead']].forEach(function (p) {
    gsap.fromTo(p[0], { opacity: 0, y: 28 }, { opacity: 1, y: 0, duration: .9, ease: settle, stagger: .08, scrollTrigger: { trigger: p[1], start: 'top 80%' } });
  });


  /* Pinned pipeline: six stations. A packet of evidence travels the rail, each station
     clamps it (a stepped, mechanical beat) and lights up, then the draw gate. */
  var mm = gsap.matchMedia();
  mm.add('(min-width: 861px)', function () {
    var steps = gsap.utils.toArray('.step'), rings = gsap.utils.toArray('.ring'), n = steps.length;
    var st = gsap.timeline({
      scrollTrigger: {
        trigger: '.story', start: 'top top', end: '+=2400', pin: true, scrub: .6,
        onUpdate: function (s) {
          var i = Math.min(n - 1, Math.floor(s.progress * n * 1.0001));
          steps.forEach(function (el, k) { el.classList.toggle('is-on', k === i); el.classList.toggle('is-done', k < i); });
          rings.forEach(function (el, k) { el.classList.toggle('is-on', k <= i); });
        }
      }
    });
    st.to('.track-fill', { scaleY: 1, ease: 'none', duration: n }, 0);
    rings.forEach(function (r, k) {
      st.to('.packet', { y: 30 + 64 * k, duration: .6, ease: 'power3.in' }, k)
        .to('.packet', { scaleX: 1.35, scaleY: .7, transformOrigin: '50% 50%', duration: .12, ease: 'steps(2)' }, k + .6)
        .to('.packet', { scaleX: 1, scaleY: 1, duration: .28, ease: 'back.out(3)' }, k + .72);
    });
    st.to('.packet', { y: 384, duration: .5, ease: 'power3.in' }, n - .1);
    return function () { steps.forEach(function (el, k) { el.classList.toggle('is-on', k === 0); el.classList.remove('is-done'); }); };
  });
  mm.add('(max-width: 860px)', function () {
    gsap.utils.toArray('.step').forEach(function (el) {
      ScrollTrigger.create({ trigger: el, start: 'top 70%', end: 'bottom 30%', toggleClass: 'is-on' });
    });
  });

  /* Count-ups: numbers roll and settle on the exact value. */
  gsap.utils.toArray('.count').forEach(function (el) {
    var to = +el.dataset.to, dec = +(el.dataset.dec || 0), o = { v: 0 };
    var fmt = new Intl.NumberFormat('en-US', { minimumFractionDigits: dec, maximumFractionDigits: dec });
    el.textContent = fmt.format(0);
    gsap.to(o, {
      v: to, duration: 1.6, ease: 'expo.out',
      scrollTrigger: { trigger: el, start: 'top 90%' },
      onUpdate: function () { el.textContent = fmt.format(o.v); }
    });
  });

  /* Footer: a brass line is drawn across as you arrive. */
  gsap.to('.foot-line span', { scaleX: 1, ease: 'none', scrollTrigger: { trigger: '.foot', start: 'top bottom', end: 'bottom bottom', scrub: .5 } });
  gsap.from('.foot-grid > *', { y: 16, opacity: 0, duration: .8, ease: settle, stagger: .1, scrollTrigger: { trigger: '.foot', start: 'top 95%' } });

})();
