/* Live: ask Solana devnet for each transaction's status straight from the browser.
   Refused draws are expected failures, so a matching program error counts as a pass. */
(function () {
  var list = document.querySelector('.live-list');
  if (!list) return;
  var rows = Array.prototype.slice.call(list.querySelectorAll('li'));
  var note = document.getElementById('live-note');
  var names = { 6019: 'CovenantBreached', 6027: 'ZkStaleChallenge' };

  rows.forEach(function (li) {
    var a = document.createElement('a');
    a.href = 'https://explorer.solana.com/tx/' + li.dataset.sig + '?cluster=devnet';
    a.className = 'sig'; a.textContent = li.dataset.sig.slice(0, 6) + '…' + li.dataset.sig.slice(-6);
    a.setAttribute('aria-label', 'Open ' + li.querySelector('.what').textContent + ' in the Solana explorer');
    li.appendChild(a);
    li.querySelector('.state').textContent = 'Asking devnet…';
  });

  function customCode(err) {
    try { return err.InstructionError[1].Custom; } catch (e) { return null; }
  }

  var ctl = new AbortController();
  setTimeout(function () { ctl.abort(); }, 8000);
  fetch(list.dataset.rpc, {
    method: 'POST', signal: ctl.signal, headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'getSignatureStatuses',
      params: [rows.map(function (li) { return li.dataset.sig; }), { searchTransactionHistory: true }] })
  }).then(function (r) { if (!r.ok) throw new Error(r.status); return r.json(); })
    .then(function (j) {
      var vals = (j.result && j.result.value) || [];
      var good = 0;
      rows.forEach(function (li, i) {
        var v = vals[i], st = li.querySelector('.state'), want = li.dataset.expect;
        if (!v) { st.textContent = 'Not returned by RPC; open the explorer'; li.className = 'unknown'; return; }
        var code = v.err ? customCode(v.err) : null;
        var ok = want === 'ok' ? !v.err : String(code) === want;
        st.textContent = (v.err ? 'Refused · ' + (names[code] || ('error ' + code)) : 'Succeeded') + ' · ' + (v.confirmationStatus || 'confirmed');
        li.className = ok ? (v.err ? 'refused' : 'ok') : 'unknown';
        if (ok) good++;
      });
      note.textContent = good + ' of ' + rows.length + ' match what this page claims, read from devnet at ' + new Date().toLocaleTimeString() + '.';
    })
    .catch(function () {
      rows.forEach(function (li) { li.querySelector('.state').textContent = 'Open in explorer'; li.className = 'unknown'; });
      note.textContent = 'Your browser could not reach devnet just now. Each row still links to the Solana explorer.';
    });
})();
