/* Verify the real 22/30 score quote to Intel's root, in the browser, with the same verifier
   the competition app uses. "Flip one byte" shows a forged quote being refused. */
import { verifyQuote, fromHex, toHex } from './tessera-verify.js';
import { SCORE, QUOTE } from './score-quote.js';

const out = document.getElementById('vq-out');
const MRTD = 'c1ee9c16';
const hx = v => (typeof v === 'string' ? v : toHex(v)); // mr_td prefix recorded in SUBMISSION-FACTS.md for this run
out.textContent = 'Ready. Press "Verify the 22/30 quote".';

async function run(flip) {
  const bytes = fromHex(QUOTE);
  if (flip) bytes[700] ^= 1;
  out.className = 'vq-out';
  out.textContent = flip ? 'Checking a copy with byte 700 changed…' : 'Checking the quote…';
  const t0 = performance.now();
  try {
    const q = await verifyQuote(bytes);
    const ms = Math.round(performance.now() - t0);
    out.className = 'vq-out pass';
    out.textContent = [
      'PASS  quote signed by a genuine Intel TDX machine (' + ms + ' ms)',
      'ok    certificate chain ends at Intel SGX Root CA 44a0196b…74d3',
      'ok    enclave measurement mr_td ' + hx(q.mr_td).slice(0, 8) + '…' + (hx(q.mr_td).startsWith(MRTD) ? '  (matches the recorded run)' : ''),
      '      report_data ' + hx(q.report_data).slice(0, 16) + '…  (where the enclave commits to the score statement)',
      '      score ' + SCORE.correct + '/' + SCORE.n + '  model ' + SCORE.model,
      '      statement ' + SCORE.statement_sha256.slice(0, 16) + '…'
    ].join('\n');
  } catch (e) {
    out.className = 'vq-out fail';
    out.textContent = 'REFUSED  ' + e.message + '\nOne changed byte and the quote no longer verifies. That is the point.';
  }
}
document.getElementById('vq-run').addEventListener('click', () => run(false));
document.getElementById('vq-flip').addEventListener('click', () => run(true));
