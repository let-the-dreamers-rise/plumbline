// TEST ONLY, localnet only. Seeds a fresh validator with real Plumbline state for the demo screenshots, from the
// repo's existing test-root Groth16 proofs (nothing is proved here): registry config + suite, three bounties,
// both fixture VerifiedScores recorded through the registry, and one bounty claimed to the proven payout.
// Prints one JSON line {paid, open, otherSuite, payout, statement} for demo-screens.mjs.
//   bash demo-localnet.sh screens <out-dir>   (wrapper: validator, deploy, this file, then screenshots)
import * as crypto from "crypto";
import {
  bountyPda, claim, conn, createBounty, funded, good, nopay, PAYOUT, recordVerifiedScore, regSuite, setupRegistry,
  slot, STATEMENT, SUITE, verifiedPda,
} from "../programs/tests/common";

const t = () => new Date().toISOString().slice(11, 19);
const LAMPORTS_PER_SOL = 1_000_000_000;
const say = (s: string) => console.error(`[${t()}] ${s}`);

(async () => {
  if (!/127\.0\.0\.1|localhost/.test(conn.rpcEndpoint)) throw new Error("localnet only");
  const [sponsor, sponsor2, relayer] = await Promise.all([funded(20), funded(20), funded()]);
  await setupRegistry();
  const far = (await slot()) + 216_000;
  const other = crypto.createHash("sha256").update("plumbline-demo:other-suite").digest();
  await createBounty(sponsor, { nonce: 1, minCorrect: 2, minTotal: 3, amount: 1 * LAMPORTS_PER_SOL, deadline: far, grace: 1500, requireSuite: true, suiteAcct: regSuite });
  await createBounty(sponsor2, { nonce: 1, minCorrect: 5, minTotal: 6, amount: 2 * LAMPORTS_PER_SOL, deadline: far, grace: 1500 });
  await createBounty(sponsor2, { nonce: 2, suite: other, minCorrect: 9, minTotal: 10, amount: 0.75 * LAMPORTS_PER_SOL, deadline: far, grace: 1500 });
  const paid = bountyPda(sponsor.publicKey, SUITE, 1), open = bountyPda(sponsor2.publicKey, SUITE, 1), otherB = bountyPda(sponsor2.publicKey, other, 2);
  say(`bounties: ${paid.toBase58()} (1 SOL, 2/3), ${open.toBase58()} (2 SOL, 5/6), ${otherB.toBase58()} (0.75 SOL, 9/10, other suite)`);
  const s = await recordVerifiedScore(good);
  await recordVerifiedScore(nopay);
  say(`recorded VerifiedScores: 4/6 payout ${s.payout.toBase58()}, 4/6 no payout`);
  const sig = await claim(paid, verifiedPda, PAYOUT, relayer);
  say(`claim ${sig}: payout balance ${(await conn.getBalance(PAYOUT)) / LAMPORTS_PER_SOL} SOL`);
  console.log(JSON.stringify({ paid: paid.toBase58(), open: open.toBase58(), otherSuite: otherB.toBase58(), payout: PAYOUT.toBase58(),
    statement: STATEMENT.toString("hex"), claimTx: sig }));
  process.exit(0);
})().catch((e) => { console.error(e); process.exit(1); });
