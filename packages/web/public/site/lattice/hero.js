/* The wafer: loose claims lock into a lattice, every die (one per GPU) is probed, and the fleet
   folds into one 256-byte proof. Physics: fast expo into grid cells, state changes in steps.
   Signature: probe the wafer yourself by dragging across it (tap on touch). */
(function () {
  var stage = document.getElementById('stage'), box = document.getElementById('dies');
  if (!stage || !box || !window.gsap) return;
  var reduce = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
  var wafer = document.getElementById('wafer'), chip = document.getElementById('chip');
  var status = document.getElementById('press-status'), count = document.getElementById('probe-count'), all = document.getElementById('probe-all');
  var N = 12, cells = [], live = [], lit = 0, mode = 'intro';

  for (var r = 0; r < N; r++) for (var c = 0; c < N; c++) {
    var d = document.createElement('div'), dx = c + .5 - N / 2, dy = r + .5 - N / 2;
    d.className = 'd'; d.appendChild(document.createElement('i'));
    if (dx * dx + dy * dy > (N / 2 - .2) * (N / 2 - .2)) d.classList.add('out'); else live.push(d);
    box.appendChild(d); cells.push(d);
  }
  function setCount() { count.textContent = lit + ' / ' + live.length + ' GPUs probed'; }
  function light(d) {
    if (!d || d.classList.contains('out') || d.classList.contains('lit')) return;
    d.classList.add('lit'); lit++; setCount();
    if (mode === 'probe' && lit === live.length) proven();
  }
  function clear() { live.forEach(function (d) { d.classList.remove('lit'); }); lit = 0; setCount(); }
  function proven() {
    mode = 'done'; status.textContent = 'Every GPU tested. One 256-byte proof covers the fleet.';
    gsap.fromTo(chip, { scale: .7, opacity: 0 }, { scale: 1, opacity: 1, duration: .32, ease: 'expo.out' });
  }
  function invite() {
    mode = 'probe'; clear(); gsap.to(chip, { opacity: 0, duration: .12 });
    count.hidden = false; all.hidden = false;
    status.textContent = 'Your turn: drag across the wafer to probe each GPU.';
  }

  if (reduce) {
    live.forEach(function (d) { d.classList.add('lit'); }); lit = live.length; setCount();
    count.hidden = false; all.hidden = false; mode = 'done';
    status.textContent = 'Every GPU tested. One 256-byte proof covers the fleet.';
  } else {
    gsap.set(chip, { opacity: 0 });
    gsap.set(live, { x: function () { return gsap.utils.random(-140, 140); }, y: function () { return gsap.utils.random(-140, 140); },
      rotation: function () { return gsap.utils.random(-90, 90); }, opacity: 0 });
    var tl = gsap.timeline({ delay: .5 });
    tl.to(live, { opacity: 1, duration: .12, ease: 'steps(2)', stagger: .004 })
      .to(live, { x: 0, y: 0, rotation: 0, duration: .32, ease: 'expo.out', stagger: { each: .006, from: 'center' } }, .25)
      .add(function () { status.textContent = 'Locked into a lattice. Probing each GPU…'; });
    live.forEach(function (d, i) { tl.call(light, [d], 1.3 + i * .012); });
    tl.call(function () { mode = 'auto'; proven(); status.textContent = 'Struck: PASS, in 256 bytes for the whole fleet.'; }, null, 1.4 + live.length * .012)
      .call(invite, null, '+=2.2');
  }

  /* Probing: the die under the pointer and its neighbours light. */
  function hit(e, radius) {
    if (mode !== 'probe') return;
    var rect = box.getBoundingClientRect(), c = Math.floor((e.clientX - rect.left) / rect.width * N), r = Math.floor((e.clientY - rect.top) / rect.height * N);
    for (var y = -radius; y <= radius; y++) for (var x = -radius; x <= radius; x++) {
      var cc = c + x, rr = r + y; if (cc >= 0 && cc < N && rr >= 0 && rr < N) light(cells[rr * N + cc]);
    }
  }
  wafer.addEventListener('pointermove', function (e) { if (e.pointerType === 'mouse') hit(e, 0); });
  wafer.addEventListener('pointerdown', function (e) { hit(e, 1); });
  all.addEventListener('click', function () {
    if (mode !== 'probe') invite();
    live.forEach(function (d, i) { if (reduce) light(d); else gsap.delayedCall(i * .01, light, [d]); });
  });

  /* Cursor-reactive depth: the wafer tilts under the probe. */
  if (!reduce && window.matchMedia('(pointer: fine)').matches) {
    var rx = gsap.quickTo(wafer, 'rotationX', { duration: .32, ease: 'expo.out' }), ry = gsap.quickTo(wafer, 'rotationY', { duration: .32, ease: 'expo.out' });
    stage.addEventListener('pointermove', function (e) {
      var b = stage.getBoundingClientRect(); ry(((e.clientX - b.left) / b.width - .5) * 16); rx(-((e.clientY - b.top) / b.height - .5) * 16);
    });
    stage.addEventListener('pointerleave', function () { rx(0); ry(0); });
  }
})();
