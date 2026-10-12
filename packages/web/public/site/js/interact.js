/* Interactive pieces: before/after plate, pricing calculator, lead form. Work without GSAP. */
(function () {
  var reduce = window.matchMedia('(prefers-reduced-motion: reduce)').matches;

  /* Before / after: the "with one proof" plate slides over "today". Transform only. */
  var cmp = document.getElementById('cmp'), range = document.getElementById('cmp-range');
  if (cmp && range) {
    var knob = document.createElement('span'); knob.className = 'knob'; knob.setAttribute('aria-hidden', 'true'); knob.textContent = '⇆';
    cmp.querySelector('.cmp-handle').appendChild(knob);
    cmp.classList.add('live');
    range.setAttribute('aria-valuetext', 'Showing half of each');
    var set = function () {
      var v = +range.value;
      cmp.style.setProperty('--split', v + '%');
      cmp.style.setProperty('--px', (cmp.clientWidth * v / 100) + 'px');
      range.setAttribute('aria-valuetext', v < 15 ? 'Showing with one proof' : v > 85 ? 'Showing today' : v + ' percent today, the rest with one proof');
    };
    range.addEventListener('input', set);
    new ResizeObserver(set).observe(cmp);
    set();
    /* A one-time hint: the plate slides open as it scrolls into view. */
    if (!reduce) {
      var hinted = false;
      new IntersectionObserver(function (es, o) {
        if (hinted || !es[0].isIntersecting) return; hinted = true; o.disconnect();
        var v = { x: 50 };
        if (window.gsap) gsap.to(v, { x: 22, duration: 1.4, ease: 'expo.inOut', delay: .3, yoyo: true, repeat: 1,
          onUpdate: function () { range.value = v.x; set(); } });
      }, { threshold: .6 }).observe(cmp);
    }
  }

  /* Pricing (planned, lender pays; the program charges a flat fee per proof today): onboarding from $15k per facility, then 10 bps a year on outstanding principal, minimum $1 per GPU per month. Shown at 10 bps next to USD.AI's published 150 bps warranty. Slider is in $M. */
  var loan = document.getElementById('loan');
  if (loan) {
    var usd = new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD', maximumFractionDigits: 0 });
    var stack = document.getElementById('stack'), coins = [];
    for (var i = 0; i < 16; i++) { var c = document.createElement('i'); stack.appendChild(c); coins.push(c); }
    var calc = function () {
      var m = +loan.value, dollars = Math.round(m * 1e6);
      document.getElementById('loan-out').textContent = '$' + m.toFixed(1) + 'M';
      document.getElementById('bps').textContent = usd.format(dollars * .001);
      var war = document.getElementById('war'); if (war) war.textContent = usd.format(dollars * .015);
      var on = Math.max(1, Math.ceil(16 * Math.sqrt(m / 100)));
      coins.forEach(function (c, k) { c.classList.toggle('off', k >= on); });
    };
    loan.addEventListener('input', calc); calc();
  }

  /* Lead form: POST /api/lead with {email, fleetGpus, lender, note}. */
  var form = document.getElementById('lead');
  /* A plain form post (JavaScript off at submit time) comes back as ?lead=thanks or ?lead=error. */
  var back = /[?&]lead=(thanks|error)\b/.exec(location.search), backMsg = document.getElementById('lead-msg');
  if (back && backMsg) backMsg.textContent = back[1] === 'thanks'
    ? 'Received. You get a reply with the terms, and we walk the first proof with you.'
    : 'Could not send the request. Check the email address and try again.';
  if (form) form.addEventListener('submit', function (e) {
    e.preventDefault();
    var msg = document.getElementById('lead-msg'), btn = document.getElementById('lead-submit');
    var email = form.email.value.trim();
    if (email.indexOf('@') < 1) {
      form.email.setAttribute('aria-invalid', 'true'); form.email.focus();
      msg.textContent = 'Add an email address so we can send the terms.'; return;
    }
    form.email.removeAttribute('aria-invalid');
    var body = { email: email, fleetGpus: Number(form.fleetGpus.value || 0), lender: form.lender.value.trim(), note: form.note.value.trim() };
    btn.disabled = true; msg.textContent = 'Sending…';
    fetch('/api/lead', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) })
      .then(function (r) {
        if (!r.ok) throw new Error(r.status);
        msg.textContent = 'Received. You get a reply with the terms, and we walk the first proof with you.';
        btn.textContent = 'Requested'; form.reset();
        form.closest('.plate').classList.add('struck');
      })
      .catch(function () { msg.textContent = 'Could not send from this page. Open an issue on the repository instead.'; btn.disabled = false; });
  });
})();
