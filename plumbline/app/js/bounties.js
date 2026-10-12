import { programIds, cliCluster, clusterQuery } from './config.js';
import { listBounties, getSlot } from './rpc.js';
import { $, chrome, cmd, esc, rpcProblem, short, sol } from './ui.js';

const cluster = chrome('bounties');
const ids = programIds();
$('#sponsor-cmd').innerHTML = cmd(`plumbline${cliCluster(cluster)} seal suite-file.json --enclave-pubkey <hex> --enclave <enclave-url>
plumbline${cliCluster(cluster)} bounty create --suite sealed-suite.json --reward 1 --target 2/3`);

let all = [], slot = null;

function render() {
  const showPaid = $('#show-paid').checked;
  const rows = all.filter((b) => showPaid || b.status === 'open').sort((a, b) => (a.amount < b.amount ? 1 : a.amount > b.amount ? -1 : 0));
  $('#slot').textContent = slot !== null ? `current slot ${slot}` : '';
  if (!rows.length) {
    $('#list').innerHTML = `<div class="card"><strong>No ${showPaid ? '' : 'open '}bounties on ${esc(cluster.name)} yet.</strong>
      <span class="meta">Bounties appear here as soon as a sponsor runs <span class="mono">plumbline bounty create</span>.</span></div>`;
    return;
  }
  $('#list').innerHTML = rows.map((b) => {
    const left = slot !== null ? Number(b.deadlineSlot) - slot : null;
    const timing = b.status === 'paid' ? `paid at slot ${b.paidSlot}` : left !== null && left < 0 ? `deadline passed ${-left} slots ago` : left !== null ? `${left.toLocaleString()} slots left (≈${Math.max(1, Math.round(left * 0.4 / 3600))} h)` : `deadline slot ${b.deadlineSlot}`;
    return `<article class="card" data-bounty="${esc(b.address)}">
      <div style="display:flex;justify-content:space-between;align-items:center;gap:.5rem"><span class="reward">${sol(b.amount)}</span>
        <span class="pill ${b.status}">${b.status}</span></div>
      <div>target <strong>${b.minCorrect}/${b.minTotal}</strong> correct</div>
      <div class="meta">suite <span class="mono" title="${esc(b.suiteCommitment)}">${short(b.suiteCommitment, 8)}</span></div>
      <div class="meta">${esc(timing)}</div>
      ${b.requiredComposeHash !== '0'.repeat(64) || b.requiredImageId !== '0'.repeat(64) ? '<div class="meta">pins a specific enclave build</div>' : ''}
      <a class="stretch" href="bounty.html?address=${encodeURIComponent(b.address)}&${clusterQuery(cluster)}">Leaderboard and details →</a>
    </article>`;
  }).join('');
}

$('#show-paid').addEventListener('change', render);

(async () => {
  if (cluster.error) { $('#status').innerHTML = `<div class="banner bad">${esc(cluster.error)}</div>`; return; }
  $('#status').innerHTML = '<p class="muted">Loading bounties…</p>';
  try {
    [all, slot] = await Promise.all([listBounties(cluster.url, ids), getSlot(cluster.url).catch(() => null)]);
    $('#status').innerHTML = '';
    render();
  } catch (e) {
    $('#status').innerHTML = rpcProblem(cluster, e);
  }
})();
