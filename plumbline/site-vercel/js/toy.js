/* Toy: drag the coverage ratio. At or above the 1.15x floor the bob settles true (PASS);
   below it the line hangs off true by how far coverage falls short (WATCH). */
(function () {
  var input = document.getElementById('ratio');
  var out = document.getElementById('ratio-out');
  var verdict = document.getElementById('verdict');
  var FLOOR = 1.15;
  var hasGsap = !!window.gsap;
  var reduce = matchMedia('(prefers-reduced-motion: reduce)').matches;
  var pend = document.querySelector('.toy-pend');
  var last = null;

  function angleFor(r) { return r >= FLOOR - 1e-9 ? 0 : Math.max(-26, -(FLOOR - r) * 180 - 4); }

  function update() {
    var r = +input.value, pass = r >= FLOOR - 1e-9, a = angleFor(r);
    out.textContent = r.toFixed(2) + 'x';
    input.setAttribute('aria-valuetext', r.toFixed(2) + 'x, ' + (pass ? 'pass' : 'watch'));
    verdict.className = 'verdict ' + (pass ? 'pass' : 'watch');
    verdict.textContent = pass ? 'PASS · next draw opens' : 'WATCH · draw refused (CovenantBreached)';
    if (!hasGsap || reduce) {
      pend.setAttribute('transform', 'rotate(' + a + ' 150 20)');
    } else {
      /* Crossing the floor gives the bob a kick, then it settles like a real line. */
      var crossed = last !== null && last !== pass;
      gsap.to(pend, { rotation: a, svgOrigin: '150 20', duration: crossed ? 1.6 : .8, ease: crossed ? 'elastic.out(1, 0.3)' : 'expo.out', overwrite: true });
      if (crossed) gsap.fromTo(verdict, { y: -6 }, { y: 0, duration: .6, ease: 'elastic.out(1, 0.4)' });
    }
    last = pass;
  }
  input.addEventListener('input', update);
  update();
})();
