// Minimal Solana JSON-RPC over fetch: getProgramAccounts (base64), getAccountInfo, getSlot.
import { b58encode, b64decode, decodeBounty, decodeScore, DISC, fromHex, OFFSETS } from './layout.js';

let id = 0;
export async function rpc(url, method, params) {
  const r = await fetch(url, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ jsonrpc: '2.0', id: ++id, method, params }) });
  if (!r.ok) throw new Error(`RPC ${method}: HTTP ${r.status}`);
  const j = await r.json();
  if (j.error) throw new Error(`RPC ${method}: ${j.error.message}`);
  return j.result;
}

const memcmp = (offset, bytes) => ({ memcmp: { offset, bytes: b58encode(bytes) } });

async function programAccounts(url, program, filters) {
  const res = await rpc(url, 'getProgramAccounts', [program, { encoding: 'base64', commitment: 'confirmed', filters }]);
  return res.map((a) => ({ pubkey: a.pubkey, lamports: a.account.lamports, data: b64decode(a.account.data[0]) }));
}

export const getSlot = (url) => rpc(url, 'getSlot', [{ commitment: 'confirmed' }]);

export async function listBounties(url, ids) {
  const rows = await programAccounts(url, ids.bounty, [memcmp(0, Uint8Array.from(DISC.Bounty))]);
  return rows.flatMap((a) => { try { return [decodeBounty(a.pubkey, a.data, a.lamports)]; } catch { return []; } });
}

export async function getBounty(url, ids, address) {
  const r = await rpc(url, 'getAccountInfo', [address, { encoding: 'base64', commitment: 'confirmed' }]);
  if (!r.value) return null;
  if (r.value.owner !== ids.bounty) throw new Error('that account is not owned by the Plumbline bounty program');
  return decodeBounty(address, b64decode(r.value.data[0]), r.value.lamports);
}

export async function scoresForSuite(url, ids, suiteHex) {
  const rows = await programAccounts(url, ids.registry, [memcmp(0, Uint8Array.from(DISC.VerifiedScore)), memcmp(OFFSETS.scoreSuite, fromHex(suiteHex))]);
  return rows.flatMap((a) => { try { return [decodeScore(a.pubkey, a.data)]; } catch { return []; } });
}

export async function scoreForStatement(url, ids, statementHex) {
  const rows = await programAccounts(url, ids.registry, [memcmp(0, Uint8Array.from(DISC.VerifiedScore)), memcmp(OFFSETS.scoreStatement, fromHex(statementHex))]);
  return rows.length ? decodeScore(rows[0].pubkey, rows[0].data) : null;
}
