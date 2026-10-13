/* Replay this morning's real run (Oct 13, Google Cloud Intel TDX, run r38a18f) from its own logs:
   status.txt, client-status.txt and summary.txt in plumbline-gcp/run-2. Times are real (UTC);
   the player only compresses them. */
(function () {
  var root = document.querySelector('.replay');
  if (!root) return;
  var T = function (hms) { var p = hms.split(':'); return (+p[0] * 3600 + +p[1] * 60 + +p[2]) - (3 * 3600 + 35 * 60 + 28); };
  var PH = ['Cloud', 'Enclave', 'Score', 'Verify', 'Prove', 'Onchain'];
  var EV = [
    ['03:35:28', 0, 'run-2 start: reading inputs'],
    ['03:36:26', 0, 'run id r38a18f; dstack project prepared'],
    ['03:36:48', 0, 'dstack bucket created; deploying the confidential VM'],
    ['03:43:55', 0, 'relay bucket created, challenge.txt uploaded'],
    ['03:44:02', 1, 'TDX VM deployed (c3-standard-4, us-central1-a)'],
    ['03:44:24', 1, 'client VM created'],
    ['03:49:03', 1, 'client: challenge received by the enclave'],
    ['03:49:07', 1, 'client: health ready, mode competition'],
    ['03:49:11', 1, 'client: attestation HTTP 200, 24,225 bytes'],
    ['03:50:24', 1, 'attest checks passed: binding, PCK chain, RTMR3 replay, compose 76834b60…4b19'],
    ['03:50:39', 2, 'sealed suite (quote check: intel), commitment 91fbc321…a0c8; scoring starts'],
    ['03:54:46', 2, 'local validator up, programs deployed, registry pinned to prod image + Intel root'],
    ['04:01:00', 2, 'client: /enter HTTP 200, signed score returned'],
    ['04:02:45', 3, 'score 22/30, bundle verified: Intel chain, both quotes bound, same enclave'],
    ['04:05:50', 3, 'cleanup verified: nothing of the run remains in the cloud'],
    ['04:05:50', 4, 'PROVING: Groth16 over the bundle (RISC Zero, production image 0x6804…14c6)'],
    ['04:06:42', 4, 'bounty created on the local validator: 1 SOL at 22/30, pinned compose + image'],
    ['04:42:01', 4, 'proof done in 2,136 s (3,641,071 cycles): bound=1, payout DuW6…VETc, root 44a0196b…74d3'],
    ['04:42:24', 5, 'record_verified_score + claim: 1 SOL paid to the wallet inside the proof (local validator)']
  ].map(function (e) { return { t: T(e[0]), at: e[0], ph: e[1], msg: e[2] }; });
  var END = EV[EV.length - 1].t;
  var log = root.querySelector('.rp-log'), clock = root.querySelector('.rp-clock'), fill = root.querySelector('.rp-fill');
  var phs = Array.prototype.slice.call(root.querySelectorAll('.rp-ph li'));
  var play = root.querySelector('[data-rp=play]');
  var live = document.createElement('li'); live.className = 'rp-live';
  var speed = 60, t = 0, shown = 0, raf = null, last = 0;

  function fmt(s) { s = Math.floor(s); return String(Math.floor(s / 60)).padStart(2, '0') + ':' + String(s % 60).padStart(2, '0'); }
  function render() {
    while (shown < EV.length && EV[shown].t <= t) {
      var e = EV[shown++], li = document.createElement('li');
      li.innerHTML = '<span class="ts"></span><span class="ph"></span><span class="m"></span>';
      li.children[0].textContent = e.at + 'Z'; li.children[1].textContent = PH[e.ph]; li.children[2].textContent = e.msg;
      log.insertBefore(li, live.parentNode ? live : null); log.scrollTop = log.scrollHeight;
    }
    var cur = shown ? EV[shown - 1].ph : -1;
    /* While the Groth16 prover runs (04:05:50 to 04:42:01), show it working. */
    var p0 = T('04:05:50'), p1 = T('04:42:01');
    if (t > p0 && t < p1) {
      if (!live.parentNode) log.appendChild(live);
      live.textContent = 'proving… ' + Math.floor(t - p0).toLocaleString('en-US') + ' s of 2,136 s · ' + Math.round(3641071 * (t - p0) / (p1 - p0)).toLocaleString('en-US') + ' cycles';
      log.scrollTop = log.scrollHeight;
    } else if (live.parentNode) live.remove();
    phs.forEach(function (p, k) { p.className = k < cur ? 'done' : (k === cur ? 'on' : ''); });
    clock.textContent = fmt(t) + ' of ' + fmt(END) + ' real time';
    fill.style.transform = 'scaleX(' + Math.min(1, t / END) + ')';
  }
  function tick(now) {
    t = Math.min(END, t + (now - last) / 1000 * speed); last = now; render();
    if (t >= END) { stop(); play.textContent = 'Replay again'; return; }
    raf = requestAnimationFrame(tick);
  }
  function stop() { cancelAnimationFrame(raf); raf = null; play.textContent = 'Play'; play.setAttribute('aria-pressed', 'false'); }
  function start() {
    if (t >= END) { t = 0; shown = 0; log.innerHTML = ''; }
    last = performance.now(); raf = requestAnimationFrame(tick);
    play.textContent = 'Pause'; play.setAttribute('aria-pressed', 'true');
  }
  play.addEventListener('click', function () { raf ? stop() : start(); });
  root.querySelectorAll('[data-speed]').forEach(function (b) {
    b.addEventListener('click', function () {
      speed = +b.dataset.speed;
      root.querySelectorAll('[data-speed]').forEach(function (x) { x.setAttribute('aria-pressed', x === b); });
    });
  });
  root.querySelector('[data-rp=end]').addEventListener('click', function () { stop(); t = END; render(); play.textContent = 'Replay again'; });
  /* Pause when scrolled away. */
  new IntersectionObserver(function (es) { if (!es[0].isIntersecting && raf) stop(); }).observe(root);
  log.innerHTML = ''; render();
})();
