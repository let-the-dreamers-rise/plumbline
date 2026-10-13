/* Run a draw: four steps from the lender's seat, every value real.
   Step 2 verifies the Oct 13 TDX quote in this tab; steps 3 and 4 read devnet live. */
import { verifyQuote, fromHex, toHex } from './tessera-verify.js';
import { QUOTE } from './score-quote.js';

const RPC = 'https://api.devnet.solana.com';
const TX = {
  proof115: '41ZoCoxTFb1MqUQKu5Qa1bRwEUch77nEUXmihPCCckvDjR52mhnAvgAQ4LqtnJZ7sjHjLFwg2Zb6yfat6RUJ7Nb7',
  pass: '5DWV6UU7jTPem7HDUtrHrmLqeGvM3x7UzMe1XHALoXdT6ZTEoKGYS5BbbfKicrfJZLhuWbo4fpa16hUhhCyFs1er',
  breach: '5kV48qNZNwMfrVrxsq33qtj3QQSPtkRLqmZegw9QxoxoEDuW2birgnDJMaUnsN5U9cvN32tJZDcB7YdjRs7g1AYA',
  replay: '4W46GmRQ5YWZj6HsGe4jz5KKUvDDwxyeBXLSdo1eP4zf9NT25QGH5y783RZDHpXFPJYK19JQMKBYzYRUJzHnvFvq'
};
const CASES = {
  pass: { v: 'Draw opens. Coverage 1.15x meets the floor.', cls: 'ok' },
  breach: { v: 'Draw refused. 1.14x is under the floor (CovenantBreached).', cls: 'no' },
  replay: { v: 'Draw refused. That challenge was already used (ZkStaleChallenge).', cls: 'no' }
};
const NAMES = { 6019: 'CovenantBreached', 6027: 'ZkStaleChallenge' };
const $ = s => document.querySelector(s);
const hx = v => (typeof v === 'string' ? v : toHex(v));
const short = s => s.slice(0, 8) + '…' + s.slice(-6);
const explorer = s => 'https://explorer.solana.com/tx/' + s + '?cluster=devnet';
const reduce = matchMedia('(prefers-reduced-motion: reduce)').matches;

/* Tabs */
const tabs = [...document.querySelectorAll('.run-steps [role=tab]')];
const panels = tabs.map(t => document.getElementById(t.getAttribute('aria-controls')));
const bar = $('.run-bar span');
let cur = 0;
function show(i, focus) {
  cur = Math.max(0, Math.min(tabs.length - 1, i));
  tabs.forEach((t, k) => { t.setAttribute('aria-selected', k === cur); t.tabIndex = k === cur ? 0 : -1; panels[k].hidden = k !== cur; });
  bar.style.transform = 'scaleX(' + (cur + 1) / tabs.length + ')';
  if (focus) tabs[cur].focus();
  if (window.gsap && !reduce) gsap.fromTo(panels[cur].children, { y: 14, opacity: 0 }, { y: 0, opacity: 1, duration: .6, ease: 'expo.out', stagger: .08 });
  document.querySelector('[data-nav="1"]').textContent = cur === tabs.length - 1 ? 'Start over' : 'Next step';
}
tabs.forEach((t, k) => {
  t.addEventListener('click', () => show(k));
  t.addEventListener('keydown', e => {
    if (e.key === 'ArrowRight') show(cur + 1, true);
    if (e.key === 'ArrowLeft') show(cur - 1, true);
  });
});
document.querySelectorAll('[data-nav]').forEach(b => b.addEventListener('click', () => {
  const d = +b.dataset.nav; show(d > 0 && cur === tabs.length - 1 ? 0 : cur + d);
}));
show(0);

/* Devnet status, read-only. */
async function status(sigs) {
  const ctl = new AbortController(); setTimeout(() => ctl.abort(), 8000);
  const r = await fetch(RPC, { method: 'POST', signal: ctl.signal, headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'getSignatureStatuses', params: [sigs, { searchTransactionHistory: true }] }) });
  if (!r.ok) throw new Error('RPC ' + r.status);
  const j = await r.json();
  return (j.result && j.result.value) || [];
}
function describe(v) {
  if (!v) return 'not returned by the RPC';
  if (!v.err) return 'succeeded · ' + (v.confirmationStatus || 'confirmed');
  let c = null; try { c = v.err.InstructionError[1].Custom; } catch (e) { /* other error shape */ }
  return 'failed with ' + (NAMES[c] || JSON.stringify(v.err)) + ' · ' + (v.confirmationStatus || 'confirmed');
}

const actions = {
  challenge() {
    const b = crypto.getRandomValues(new Uint8Array(16));
    $('#chal').textContent = toHex(b) + '  (example)';
  },
  async verify(forge) {
    const out = $('#out2'); const bytes = fromHex(QUOTE);
    if (forge) bytes[700] ^= 1;
    out.className = 'out'; out.textContent = forge ? 'Checking a copy with one byte changed…' : 'Checking…';
    const t0 = performance.now();
    try {
      const q = await verifyQuote(bytes);
      out.className = 'out ok';
      out.textContent = 'PASS in ' + Math.round(performance.now() - t0) + ' ms: signed by a genuine Intel TDX machine\n' +
        'chain ends at Intel SGX Root CA 44a0196b…74d3\nenclave measurement ' + hx(q.mr_td).slice(0, 16) + '…';
    } catch (e) {
      out.className = 'out no';
      out.textContent = 'REFUSED: ' + e.message + '\nOne changed byte and the evidence is worthless.';
    }
  },
  forge() { return actions.verify(true); },
  async chain() {
    const out = $('#out3'); out.className = 'out'; out.textContent = 'Asking devnet…';
    try {
      const [v] = await status([TX.proof115]);
      out.className = v && !v.err ? 'out ok' : 'out';
      out.innerHTML = '';
      out.append('1.15x proof verified onchain: ' + describe(v) + '\n');
      const a = document.createElement('a'); a.href = explorer(TX.proof115); a.textContent = 'Open ' + short(TX.proof115) + ' in the explorer';
      out.append(a);
    } catch (e) {
      out.innerHTML = 'Could not reach devnet from this browser. <a href="' + explorer(TX.proof115) + '">Open the transaction in the explorer</a>.';
    }
  }
};
document.querySelectorAll('[data-act]').forEach(b => b.addEventListener('click', () => actions[b.dataset.act]()));

/* Step 4: each case reads its own devnet transaction. */
const segs = [...document.querySelectorAll('.seg [data-case]')];
async function pick(c) {
  segs.forEach(s => s.setAttribute('aria-pressed', s.dataset.case === c));
  const v4 = $('#v4'), out = $('#out4');
  v4.textContent = CASES[c].v; v4.className = 'verdict-big ' + CASES[c].cls;
  if (window.gsap && !reduce) gsap.fromTo(v4, { y: -8 }, { y: 0, duration: .9, ease: 'elastic.out(1, 0.4)' });
  out.textContent = 'Reading the devnet transaction…';
  try {
    const [v] = await status([TX[c]]);
    out.innerHTML = '';
    out.append('Devnet: ' + describe(v) + '\n');
    const a = document.createElement('a'); a.href = explorer(TX[c]); a.textContent = 'Open ' + short(TX[c]) + ' in the explorer'; out.append(a);
  } catch (e) {
    out.innerHTML = 'Could not reach devnet from this browser. <a href="' + explorer(TX[c]) + '">Open the transaction in the explorer</a>.';
  }
}
segs.forEach(s => s.addEventListener('click', () => pick(s.dataset.case)));
let picked = false;
tabs[3].addEventListener('click', () => { if (!picked) { picked = true; pick('pass'); } });
document.querySelector('[data-nav="1"]').addEventListener('click', () => { if (cur === 3 && !picked) { picked = true; pick('pass'); } });
