// TEST ONLY, localnet only. Two helpers for run-e2e.sh, on the CLI's own chain client:
//   init-config <rpc> <admin-keypair> <image-id-hex> <root-sha256-hex> <compose-hash-hex>
//   check <rpc> <bounty> <bundle.json> <payout-pubkey> <relayer-pubkey> <balances-before.json>
//   balances <rpc> <pubkey>...      -> JSON {pubkey: lamports}
// Run with ../cli/node_modules/.bin/tsx.
import * as fs from "node:fs";
import { createHash } from "node:crypto";
import { Connection, PlumblineChain, PublicKey } from "../cli/src/chain/index.js";
import { assertNotMainnet, resolveCluster } from "../cli/src/cluster.js";
import { loadKeypair } from "../cli/src/wallet.js";

const [cmd, rpc, ...rest] = process.argv.slice(2);
const cluster = resolveCluster(rpc);
if (cluster.name !== "localnet") throw new Error("e2e helpers run on localnet only");
const conn = new Connection(cluster.url, "confirmed");
const hex32 = (h: string) => { const b = Buffer.from(h.replace(/^0x/, ""), "hex"); if (b.length !== 32) throw new Error(`not 32 bytes: ${h}`); return Array.from(b); };
const fail = (m: string) => { console.log(`FAIL ${m}`); process.exitCode = 1; };
const ok = (m: string) => console.log(`  ok  ${m}`);

async function main() {
  await assertNotMainnet(conn);
  if (cmd === "init-config") {
    const [admin, imageId, root, compose] = rest;
    const chain = new PlumblineChain(conn, loadKeypair(admin));
    const programData = PublicKey.findProgramAddressSync([chain.registryId.toBuffer()],
      new PublicKey("BPFLoaderUpgradeab1e11111111111111111111111"))[0];
    const sig = await (chain.registry.methods as any).initConfig(hex32(imageId), hex32(root), hex32(compose), Array(48).fill(0))
      .accountsPartial({ config: chain.configPda(), admin: chain.payer.publicKey, programData }).rpc();
    const c = await chain.fetchConfig();
    console.log(JSON.stringify({ tx: sig, config: chain.configPda().toBase58(), ...c }, (_k, v) => (typeof v === "bigint" ? v.toString() : v)));
    return;
  }
  if (cmd === "balances") {
    const out: Record<string, number> = {};
    for (const k of rest) out[k] = await conn.getBalance(new PublicKey(k), "confirmed");
    console.log(JSON.stringify(out));
    return;
  }
  if (cmd === "check") {
    const [bountyAddr, bundleFile, payout, relayer, beforeFile] = rest;
    const before = JSON.parse(fs.readFileSync(beforeFile, "utf8"));
    const chain = new PlumblineChain(conn);
    const bundle = JSON.parse(fs.readFileSync(bundleFile, "utf8"));
    const canon = JSON.stringify(sortKeys(bundle.statement));
    const statementHash = createHash("sha256").update(canon).digest("hex");
    const score = await chain.scoreByStatement(statementHash);
    const b = await chain.fetchBounty(bountyAddr);
    if (!score) return fail(`no VerifiedScore for statement ${statementHash}`);
    if (!b) return fail(`no bounty ${bountyAddr}`);
    console.log(`VerifiedScore ${score.address}`);
    console.log(`  statement ${score.statementHash}  ${score.correct}/${score.total}  payout ${score.payout}`);
    console.log(`  image ${score.imageId}  compose ${score.composeHash}  slot ${score.slot}  submitter ${score.submitter}`);
    console.log(`Bounty ${b.address}`);
    console.log(`  status ${b.status}  amount ${b.amount} lamports  target ${b.minCorrect}/${b.minTotal}`);
    console.log(`  winner statement ${b.winnerStatementHash}  winner payout ${b.winnerPayout}  paid slot ${b.paidSlot}`);
    score.statementHash === statementHash ? ok("VerifiedScore is for the entrant's statement") : fail("statement hash");
    score.payout === payout ? ok("VerifiedScore.payout = entrant's fresh payout key") : fail(`score payout ${score.payout} != ${payout}`);
    b.status === "paid" ? ok("bounty status paid") : fail(`bounty status ${b.status}`);
    b.winnerPayout === payout ? ok("bounty winner payout = entrant's payout key") : fail(`winner payout ${b.winnerPayout}`);
    b.winnerStatementHash === statementHash ? ok("bounty winner statement = entrant's statement") : fail("winner statement");
    const after = { payout: await conn.getBalance(new PublicKey(payout), "confirmed"), relayer: await conn.getBalance(new PublicKey(relayer), "confirmed") };
    const gained = BigInt(after.payout) - BigInt(before[payout]);
    console.log(`payout ${payout}: ${before[payout]} -> ${after.payout} lamports (+${gained})`);
    console.log(`relayer ${relayer}: ${before[relayer]} -> ${after.relayer} lamports (${after.relayer - before[relayer]})`);
    gained === b.amount ? ok(`payout wallet gained exactly the bounty amount (${b.amount} lamports)`) : fail(`payout gained ${gained}, bounty ${b.amount}`);
    after.relayer < before[relayer] ? ok("relayer wallet only paid fees (balance went down)") : fail("relayer balance did not go down");
    // the claim transaction: which accounts gained lamports
    const sigs = await conn.getSignaturesForAddress(new PublicKey(payout), {}, "confirmed");
    for (const s of sigs) {
      const tx = await conn.getTransaction(s.signature, { commitment: "confirmed", maxSupportedTransactionVersion: 0 });
      if (!tx?.meta) continue;
      const keys = tx.transaction.message.getAccountKeys().staticAccountKeys.map((k) => k.toBase58());
      const deltas = keys.map((k, i) => [k, tx.meta!.postBalances[i] - tx.meta!.preBalances[i]] as const).filter(([, d]) => d !== 0);
      console.log(`claim tx ${s.signature} (slot ${tx.slot}, signer ${keys[0]})`);
      for (const [k, d] of deltas) console.log(`  ${k}  ${d > 0 ? "+" : ""}${d}`);
      const rel = deltas.find(([k]) => k === relayer)?.[1] ?? 0;
      rel <= 0 ? ok("claim tx: relayer received nothing") : fail("relayer received lamports in the claim tx");
      deltas.find(([k]) => k === payout)?.[1] === Number(b.amount) ? ok("claim tx: payout +amount") : fail("claim tx payout delta");
    }
    if (!process.exitCode) console.log("ONCHAIN CHECKS OK");
    return;
  }
  throw new Error(`unknown command ${cmd}`);
}

function sortKeys(v: any): any {
  if (Array.isArray(v)) return v.map(sortKeys);
  if (v && typeof v === "object") return Object.fromEntries(Object.keys(v).sort().map((k) => [k, sortKeys(v[k])]));
  return v;
}

main().catch((e) => { console.error(e?.message ?? e); process.exit(1); });
