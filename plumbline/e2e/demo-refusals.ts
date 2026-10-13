// TEST ONLY, localnet only. A readable, live walk through the refusals for the demo video.
// It uses the repo's existing test-root Groth16 proofs (programs/tests/fixtures, nothing is proved here) and the
// test helpers in programs/tests/common.ts, against a fresh validator that demo-localnet.sh starts with the two
// forged score accounts from scripts/make-forged.ts preloaded. Every refusal below is a real transaction the
// programs reject; the script checks the error name and fails if any attempt goes through.
//   bash demo-localnet.sh refusals       (wrapper: validator, deploy, then this file from programs/)
import * as crypto from "crypto";
import * as fs from "fs";
import {
  bountyPda, claim, conn, createBounty, funded, good, MODEL, nopay, PAYOUT, recordVerifiedScore, registry,
  regSuite, rpda, setupRegistry, slot, SUITE, verifiedOf, verifiedPda,
} from "../programs/tests/common";

// web3.js classes come through common.ts (this file sits outside the programs/ package)
type PublicKey = typeof PAYOUT;
const PublicKey = PAYOUT.constructor as new (s: string) => PublicKey;

const t = () => new Date().toISOString().slice(11, 19);
const say = (s = "") => console.log(`[${t()}] ${s}`);
const SOL = 1_000_000_000;
const short = (k: PublicKey | string) => { const s = k.toString(); return `${s.slice(0, 6)}…${s.slice(-6)}`; };
const forged = (n: string) => new PublicKey(JSON.parse(fs.readFileSync(`tests/fixtures/forged/${n}.json`, "utf8")).pubkey);
let failures = 0;

function reason(e: any): string {
  const code = e?.error?.errorCode?.code;
  if (code) return `${code}: ${e.error.errorMessage}`;
  const logs: string[] = e?.logs ?? e?.transactionLogs ?? [];
  const inUse = logs.find((l) => l.includes("already in use"));
  if (inUse) return `account already in use (${inUse.replace(/^Program log: /, "").trim()})`;
  return String(e?.message ?? e).split("\n")[0];
}

async function refuse(n: number, what: string, p: Promise<any>, expected: string) {
  say(`${n}. ${what}`);
  try {
    const sig = await p;
    failures++;
    say(`   !! WENT THROUGH (tx ${sig}) — expected ${expected}`);
  } catch (e: any) {
    const r = reason(e);
    const ok = r.includes(expected);
    if (!ok) failures++;
    say(`   ${ok ? "REFUSED" : "!! WRONG ERROR"}  ${r}`);
  }
}

(async () => {
  const rpc = conn.rpcEndpoint;
  if (!/127\.0\.0\.1|localhost/.test(rpc)) throw new Error("localnet only");
  say(`Plumbline refusals, live on solana-test-validator ${rpc}`);
  say(`programs: registry ${registry.programId.toBase58()}`);
  say("");
  say("== setup");
  const [sponsor, relayer, cranker] = await Promise.all([funded(20), funded(), funded()]);
  await setupRegistry();
  say(`registry config: test-root guest image ${Buffer.from(good.imageId).toString("hex").slice(0, 16)}…, suite ${SUITE.toString("hex").slice(0, 16)}… registered`);
  say(`sponsor ${sponsor.publicKey.toBase58()}`);
  say(`relayer ${relayer.publicKey.toBase58()} (cranks claims, pays fees)`);
  say(`entrant payout ${PAYOUT.toBase58()} (inside the proven statement; balance ${await conn.getBalance(PAYOUT)} lamports)`);
  const far = (await slot()) + 100_000;
  const B = (nonce: number) => bountyPda(sponsor.publicKey, SUITE, nonce);
  await createBounty(sponsor, { nonce: 1, minCorrect: 2, minTotal: 3, deadline: far, requireSuite: true, suiteAcct: regSuite });
  say(`bounty A ${B(1).toBase58()}  1 SOL for 2/3`);
  await createBounty(sponsor, { nonce: 2, minCorrect: 5, minTotal: 6, deadline: far });
  say(`bounty B ${B(2).toBase58()}  1 SOL for 5/6`);
  await createBounty(sponsor, { nonce: 3, minCorrect: 1, minTotal: 2, deadline: far });
  say(`bounty C ${B(3).toBase58()}  1 SOL for 1/2`);
  say("");
  say("== the relayer records the real Groth16 proofs (test-root guest, synthetic quote) through the registry");
  const s = await recordVerifiedScore(good);
  say(`VerifiedScore ${verifiedPda.toBase58()}  ${s.correct}/${s.total}  payout ${s.payout.toBase58()}  slot ${s.slot}`);
  const n = await recordVerifiedScore(nopay);
  say(`VerifiedScore ${verifiedOf(nopay).toBase58()}  ${n.correct}/${n.total}  payout ${n.payout.toBase58()} (statement had no payout field)`);
  say("");
  say("== refusals: each is a real transaction the programs reject");
  await refuse(1, `relayer claims bounty A but names ITSELF as the payout (${short(relayer.publicKey)})`,
    claim(B(1), verifiedPda, relayer.publicKey, relayer), "BadPayout");
  await refuse(2, `relayer claims bounty A but names the SPONSOR as the payout (${short(sponsor.publicKey)})`,
    claim(B(1), verifiedPda, sponsor.publicKey, relayer), "BadPayout");
  await refuse(3, "forged 6/6 score at the right PDA address, owned by another program",
    claim(B(3), forged("not-registry"), PAYOUT, cranker), "ScoreNotFromRegistry");
  await refuse(4, "registry-owned forged 6/6 score that is not at its [verified, statement_hash] PDA (planted in genesis)",
    claim(B(3), forged("wrong-pda"), PAYOUT, cranker), "BadScorePda");
  const stmt = crypto.randomBytes(32);
  const rec = rpda(Buffer.from("score"), stmt);
  await registry.methods.recordScore(Array.from(stmt), Array.from(MODEL), Array.from(SUITE), Array.from(crypto.randomBytes(32)),
    Array.from(good.journal.subarray(128, 176)), 6, 6, 1).accountsPartial({ score: rec, suite: null }).rpc();
  await refuse(5, `a self-reported 6/6 registry ScoreRecord with no proof behind it (${short(rec)})`,
    claim(B(3), rec, PAYOUT, cranker), "NotAVerifiedScore");
  await refuse(6, "the 4/6 score claims bounty B, which needs 5/6",
    claim(B(2), verifiedPda, PAYOUT, cranker), "BelowTarget");
  await refuse(7, "the 4/6 score whose statement carries no payout claims bounty C",
    claim(B(3), verifiedOf(nopay), cranker.publicKey, cranker), "NoPayout");
  await refuse(8, "replay: record the same proof a second time",
    recordVerifiedScore(good), "already in use");
  say("");
  say("== the one claim that pays: bounty A to the payout inside the proof");
  const before = await conn.getBalance(PAYOUT);
  const sig = await claim(B(1), verifiedPda, PAYOUT, relayer);
  const after = await conn.getBalance(PAYOUT);
  say(`claim tx ${sig}`);
  say(`payout ${PAYOUT.toBase58()}: ${before / SOL} -> ${after / SOL} SOL`);
  say("");
  await refuse(9, "replay: claim bounty A again with the relayer",
    claim(B(1), verifiedPda, PAYOUT, relayer), "AlreadyPaid");
  await refuse(10, "replay: claim bounty A again from another wallet",
    claim(B(1), verifiedPda, PAYOUT, cranker), "AlreadyPaid");
  say(`payout balance still ${(await conn.getBalance(PAYOUT)) / SOL} SOL`);
  say("");
  say(failures ? `DEMO FAIL (${failures} unexpected results)` : "DEMO OK: 10 refusals, 1 payout, all to the proven address");
  process.exit(failures ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
