import { cliCluster, clusterQuery, explorer, programIds } from './config.js';
import { claimable, rank, REASONS } from './layout.js';
import { getBounty, getSlot, scoresForSuite } from './rpc.js';
import { $, chrome, cmd, esc, pct, rpcProblem, short, sol } from './ui.js';

const cluster = chrome('bounties');
const ids = programIds();
const address = new URLSearchParams(location.search).get('address');
const link = (kind, id, text) => `<a href="${explorer(kind, id, cluster)}" target="_blank" rel="noopener">${text}</a>`;

(async () => {
  if (cluster.error) { $('#status').innerHTML = `<div class="banner bad">${esc(cluster.error)}</div>`; return; }
  if (!address) { $('#status').innerHTML = '<div class="banner">No bounty address given. Pick one from <a href="index.html">the list</a>.</div>'; return; }
  $('#status').innerHTML = '<p class="muted">Loading…</p>';
  let b, scores, slot;
  try {
    b = await getBounty(cluster.url, ids, address);
    if (!b) { $('#status').innerHTML = `<div class="banner">No bounty account at <span class="mono">${esc(address)}</span> on ${esc(cluster.name)}. A refunded bounty is closed and disappears.</div>`; return; }
    [scores, slot] = await Promise.all([scoresForSuite(cluster.url, ids, b.suiteCommitment), getSlot(cluster.url).catch(() => null)]);
  } catch (e) { $('#status').innerHTML = rpcProblem(cluster, e); return; }
  $('#status').innerHTML = '';
  document.title = `Plumbline Bounty ${short(b.address)}`;

  const Z = '0'.repeat(64);
  const refundAt = b.deadlineSlot + b.claimGraceSlots;
  $('#terms').innerHTML = `
    <h1>${sol(b.amount)} for ${b.minCorrect}/${b.minTotal} <span class="pill ${b.status}">${b.status}</span></h1>
    <p class="lede">Paid in full to the first verified score on this suite that reaches ${b.minCorrect}/${b.minTotal}
      (${pct(b.minCorrect, b.minTotal)}) over at least ${b.minTotal} items, recorded between slot ${b.createdSlot} and slot ${b.deadlineSlot}.</p>
    <dl class="kv">
      <dt>Bounty</dt><dd class="mono">${link('address', b.address, esc(b.address))}</dd>
      <dt>Sponsor</dt><dd class="mono">${esc(b.sponsor)}</dd>
      <dt>Suite commitment</dt><dd class="mono">${esc(b.suiteCommitment)}</dd>
      <dt>Escrow</dt><dd>${b.lamports !== undefined ? `${sol(b.lamports)} held by the bounty account (reward + rent)` : '–'}</dd>
      <dt>Window</dt><dd>slot ${b.createdSlot} → ${b.deadlineSlot}${slot !== null ? ` (now ${slot})` : ''}; sponsor refund possible after slot ${refundAt}</dd>
      <dt>Enclave pin</dt><dd>${b.requiredComposeHash === Z ? 'any compose the registry approves' : `<span class="mono">${esc(b.requiredComposeHash)}</span>`}</dd>
      <dt>Guest pin</dt><dd>${b.requiredImageId === Z ? 'any guest image the registry approves' : `<span class="mono">${esc(b.requiredImageId)}</span>`}</dd>
      ${b.status === 'paid' ? `<dt>Paid to</dt><dd class="mono">${link('address', b.winnerPayout, esc(b.winnerPayout))} at slot ${b.paidSlot}</dd>
        <dt>Winning statement</dt><dd class="mono">${esc(b.winnerStatementHash)}</dd>` : ''}
    </dl>`;

  scores.sort(rank);
  $('#board-section').hidden = false;
  $('#board').innerHTML = scores.length ? `<table class="board"><thead><tr><th>#</th><th>Score</th><th>Payout</th><th>Slot</th><th>Can claim this bounty</th><th>Proof</th></tr></thead><tbody>
    ${scores.map((s, i) => {
      const why = claimable(b, s);
      const winner = b.status === 'paid' && s.statementHash === b.winnerStatementHash;
      return `<tr class="${winner ? 'winner' : ''}" data-statement="${esc(s.statementHash)}">
        <td data-label="Rank" class="num">${i + 1}</td>
        <td data-label="Score" class="num"><strong>${s.correct}/${s.total}</strong> <span class="muted">${pct(s.correct, s.total)}</span></td>
        <td data-label="Payout" class="mono">${link('address', s.payout, esc(short(s.payout, 6)))}</td>
        <td data-label="Slot" class="num">${s.slot}</td>
        <td data-label="Claim">${winner ? '<span class="pill paid">winner</span>' : why ? `<span class="muted">${esc(REASONS[why] || why)}</span>` : '<span class="pill open">yes</span>'}</td>
        <td data-label="Proof">${link('address', s.address, 'VerifiedScore')} · <a href="verify.html?statement=${s.statementHash}&${clusterQuery(cluster)}">check a bundle</a></td>
      </tr>`;
    }).join('')}</tbody></table>`
    : '<div class="card"><strong>No verified scores on this suite yet.</strong><span class="meta">Entrants submit with <span class="mono">plumbline enter</span>; the relayer proves and records the score.</span></div>';

  const c = cliCluster(cluster);
  const best = scores.find((s) => !claimable(b, s));
  $('#actions').hidden = false;
  $('#cmds').innerHTML = `
    <h3>Enter a model</h3>
    <p class="muted">Get the sponsor's <span class="mono">sealed-suite.json</span> for this suite, then (<a href="howto.html#entrant">full steps</a>):</p>
    ${cmd(`plumbline${c} enter --enclave <enclave-url> --sealed sealed-suite.json \\
  --model <org/name> --revision <40-hex commit> \\
  --shard model.safetensors=<sha256> --payout <your Solana address>`)}
    <h3>Claim</h3>
    <p class="muted">Anyone may send the claim; the money only goes to the payout inside the proven score.</p>
    ${cmd(`plumbline${c} claim ${b.address} --statement ${best ? best.statementHash : '<statement hash>'}`)}
    ${b.status === 'open' ? `<h3>Refund (sponsor only, after slot ${refundAt})</h3>${cmd(`plumbline${c} bounty refund ${b.address}`)}` : ''}`;
})();
