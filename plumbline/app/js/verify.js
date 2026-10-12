import * as tv from '../tessera-verify.js';
import { explorer, programIds } from './config.js';
import { b58encode, claimable, fromHex, hex, REASONS } from './layout.js';
import { listBounties, scoreForStatement } from './rpc.js';
import { $, chrome, esc, sol } from './ui.js';

const cluster = chrome('verify');
const ids = programIds();
const wantStatement = new URLSearchParams(location.search).get('statement');
if (wantStatement) $('#want').innerHTML = `Looking for the bundle of statement <span class="mono">${esc(wantStatement)}</span> (from the leaderboard).`;

const te = new TextEncoder();
const sha = async (alg, b) => new Uint8Array(await crypto.subtle.digest(alg, b));
const cat = (...p) => { const o = new Uint8Array(p.reduce((n, x) => n + x.length, 0)); let i = 0; for (const x of p) { o.set(x, i); i += x.length; } return o; };
const RT = 0x08000001;

/** dstack-cloud strips RTMR3 runtime digests; the plumbline guest recomputes them. Do the same before verifyBundle. */
async function fillDigests(log) {
  if (log === undefined || log === null) return { log, filled: 0 };
  const arr = typeof log === 'string' ? JSON.parse(log) : log;
  if (!Array.isArray(arr)) return { log, filled: 0 };
  let filled = 0;
  for (const e of arr) {
    if (e && e.imr === 3 && e.event_type === RT && !e.digest) {
      const t = new Uint8Array(4); new DataView(t.buffer).setUint32(0, RT, true);
      e.digest = hex(await sha('SHA-384', cat(t, te.encode(':'), te.encode(String(e.event)), te.encode(':'), fromHex(e.event_payload || ''))));
      filled++;
    }
  }
  return { log: typeof log === 'string' ? JSON.stringify(arr) : arr, filled };
}

const row = (state, name, detail = '') => `<li class="${state}"><span class="mark">${state === 'ok' ? 'PASS' : state === 'fail' ? 'FAIL' : 'n/a'}</span>
  <span><span>${esc(name)}</span>${detail ? `<br><span class="detail">${detail}</span>` : ''}</span></li>`;

async function check(text, label) {
  const out = $('#result');
  out.innerHTML = `<p class="muted">Checking ${esc(label)}…</p>`;
  const rows = [];
  let st, stHash, payoutB58 = null, payoutHex = null;
  try {
    const py = tv.pyJsonLoads(text);
    st = py.get('statement');
    if (!(st instanceof Map)) throw new Error('no statement object');
    const canon = tv.canonical(st);
    stHash = hex(await sha('SHA-256', canon));
    const plain = JSON.parse(text);
    rows.push(row(stHash === plain.statement_sha256 ? 'ok' : 'fail', 'statement_sha256 is the hash of the canonical statement', `<span class="mono">${stHash}</span>`));
    const p = st.get('payout');
    if (typeof p === 'string' && /^[0-9a-f]{64}$/.test(p) && !/^0+$/.test(p)) {
      payoutHex = p; payoutB58 = b58encode(fromHex(p));
      rows.push(row('ok', 'statement carries a payout address', `<span class="mono">${esc(payoutB58)}</span>`));
    } else {
      rows.push(row('fail', 'statement carries a payout address', p === undefined ? 'no payout field: this score proves with payout = 0 and no bounty will pay it' : 'payout is malformed or all zero'));
    }
    const q = fromHex(String(plain.score?.quote ?? ''));
    const want = await sha('SHA-256', cat(te.encode('tessera:score:v1'), canon));
    const rd = q.slice(48 + 520, 48 + 552);
    rows.push(row(rd.length === 32 && hex(rd) === hex(want) ? 'ok' : 'fail', 'score quote report_data = sha256("tessera:score:v1" ‖ statement)'));

    // full verification with the unchanged browser verifier
    let filled = 0;
    for (const part of ['score', 'key_release']) if (plain[part]) { const f = await fillDigests(plain[part].event_log); plain[part].event_log = f.log; filled += f.filled; }
    const marker = '"__PLUMBLINE_STATEMENT__"';
    const rebuilt = JSON.stringify({ ...plain, statement: '__PLUMBLINE_STATEMENT__' }).replace(marker, new TextDecoder().decode(canon));
    let current = '';
    try {
      const r = await tv.verifyBundle(rebuilt, { steps: { begin: (l) => { current = l; }, done() {} } });
      rows.push(row('ok', 'TDX quotes verify to Intel\'s root; key release and score bound; RTMR3 replayed; same enclave',
        `compose hash <span class="mono">${esc(r.quotes[0].compose_hash ?? '–')}</span>${filled ? ` · ${filled} stripped event digest(s) recomputed` : ''}`));
    } catch (e) {
      rows.push(row('fail', 'TDX quotes verify to Intel\'s root (full check)', `failed at “${esc(current)}”: ${esc(e?.message || e?.name || e)}${
        /root|chain|signed|header/i.test(current) ? '<br>Bundles from a local test enclave use a stub quote and stop here; real Phala bundles pass.' : ''}`));
    }
  } catch (e) {
    out.innerHTML = `<div class="banner bad"><strong>Not a readable bundle.</strong> ${esc(e?.message ?? e)}</div>`;
    return;
  }

  const g = (k) => { const v = st.get(k); return v instanceof tv.PyInt ? Number(v.v) : v; };
  let html = `<h2>${g('correct')}/${g('n')} for <span class="mono">${esc(g('model_id'))}</span></h2>
    <dl class="kv"><dt>Revision</dt><dd class="mono">${esc(g('model_revision'))}</dd><dt>Suite</dt><dd class="mono">${esc(g('suite_commitment'))}</dd>
    <dt>Statement hash</dt><dd class="mono">${esc(stHash)}</dd><dt>Payout</dt><dd class="mono">${esc(payoutB58 ?? '(none)')}</dd></dl>
    <ol class="steps">${rows.join('')}</ol>`;

  const expect = $('#expect').value.trim();
  const matches = [];
  if (wantStatement) matches.push(wantStatement === stHash ? ['ok', 'this is the statement you came from'] : ['fail', 'this bundle is for a different statement than the leaderboard row']);
  if (expect) matches.push(expect === payoutB58 ? ['ok', 'statement payout matches the address you entered'] : ['fail', `statement payout ${payoutB58 ?? '(none)'} is not ${expect}`]);

  if (cluster.error) matches.push(['skip', `onchain lookup skipped: ${cluster.error}`]);
  else {
    try {
      const s = await scoreForStatement(cluster.url, ids, stHash);
      if (!s) matches.push(['skip', `no VerifiedScore for this statement on ${cluster.name} yet (the relayer records it after proving)`]);
      else {
        const link = `<a href="${explorer('address', s.address, cluster)}" target="_blank" rel="noopener">VerifiedScore ${esc(s.address)}</a>`;
        matches.push([s.payout === payoutB58 ? 'ok' : 'fail', s.payout === payoutB58 ? 'onchain payout matches the statement' : `onchain payout ${s.payout} differs from the statement`, `${link} · slot ${s.slot}`]);
        const bounties = (await listBounties(cluster.url, ids)).filter((b) => b.suiteCommitment === s.suiteCommitment);
        for (const b of bounties) {
          const why = claimable(b, s);
          const won = b.status === 'paid' && b.winnerStatementHash === s.statementHash;
          matches.push([won || !why ? 'ok' : 'skip', `bounty ${b.address.slice(0, 8)}… (${sol(b.amount)}, ${b.minCorrect}/${b.minTotal}): ${won ? 'paid to this payout' : why ? REASONS[why] || why : 'claimable now'}`]);
        }
      }
    } catch (e) { matches.push(['skip', `onchain lookup failed on ${cluster.name}: ${e?.message ?? e}`]); }
  }
  html += `<h3>Payout and onchain record</h3><ol class="steps">${matches.map(([s, n, d]) => row(s, n, d || '')).join('')}</ol>`;
  out.innerHTML = html;
}

const drop = $('#drop');
const readFile = (f) => f.text().then((t) => check(t, f.name));
$('#file').addEventListener('change', (e) => { const f = e.target.files[0]; if (f) readFile(f); e.target.value = ''; });
drop.addEventListener('dragover', (e) => { e.preventDefault(); drop.classList.add('over'); });
drop.addEventListener('dragleave', () => drop.classList.remove('over'));
drop.addEventListener('drop', (e) => { e.preventDefault(); drop.classList.remove('over'); if (e.dataTransfer.files[0]) readFile(e.dataTransfer.files[0]); });
$('#check-paste').addEventListener('click', () => check($('#paste').value, 'pasted bundle'));
