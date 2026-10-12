// Writes two forged "VerifiedScore" accounts for solana-test-validator --account, so the claim tests can
// show that the bounty program rejects them. Both carry a perfect 6/6 score for the fixture model and suite,
// and the fixture proof's payout.
//   not-registry.json : at the correct registry PDA ["verified", fake_statement], but owned by another program.
//   wrong-pda.json    : owned by the registry (only possible via genesis), at an address that is not the PDA.
// Usage: yarn ts-node scripts/make-forged.ts <outdir>
import { BorshAccountsCoder, BN } from "@coral-xyz/anchor";
import { Keypair, PublicKey } from "@solana/web3.js";
import * as crypto from "crypto";
import * as fs from "fs";

const REGISTRY = new PublicKey("Eicw3HXxXN7kckn5XB4WDGQG2c61BLf7X7QpGehLTgAW");
const out = process.argv[2] ?? "tests/fixtures/forged";
fs.mkdirSync(out, { recursive: true });

(async () => {
  const idl = JSON.parse(fs.readFileSync("target/idl/plumbline_registry.json", "utf8"));
  const coder = new BorshAccountsCoder(idl);
  const proof = JSON.parse(fs.readFileSync("tests/fixtures/synthetic-payout-groth16.json", "utf8"));
  const j = Buffer.from(proof.journal.slice(2), "hex");
  const stmt = crypto.createHash("sha256").update("plumbline:forged-score").digest();
  const [pda, bump] = PublicKey.findProgramAddressSync([Buffer.from("verified"), stmt], REGISTRY);
  const arr = (b: Buffer) => Array.from(b);
  const data = await coder.encode("VerifiedScore", {
    statementHash: arr(stmt),
    modelIdHash: arr(j.subarray(32, 64)),
    suiteCommitment: arr(j.subarray(64, 96)),
    quoteHash: arr(j.subarray(96, 128)),
    mrTd: arr(j.subarray(128, 176)),
    rtmrsHash: arr(j.subarray(176, 208)),
    teeTcbSvn: arr(j.subarray(208, 224)),
    composeHash: arr(j.subarray(266, 298)),
    correct: 6,
    total: 6,
    bindingVersion: 1,
    imageId: arr(Buffer.from(proof.imageId.slice(2), "hex")),
    suiteRegistered: true,
    submitter: Keypair.generate().publicKey,
    slot: new BN(1_000_000_000),
    unixTimestamp: new BN(0),
    payout: new PublicKey(j.subarray(298, 330)), // the real payout, so only owner / PDA checks can stop it
    bump,
  });
  const write = (name: string, pubkey: PublicKey, owner: PublicKey) =>
    fs.writeFileSync(`${out}/${name}.json`, JSON.stringify({
      pubkey: pubkey.toBase58(),
      account: { lamports: 10_000_000, data: [data.toString("base64"), "base64"], owner: owner.toBase58(),
        executable: false, rentEpoch: 0, space: data.length },
    }));
  const attackerProgram = Keypair.generate().publicKey;
  const offPda = Keypair.generate().publicKey;
  write("not-registry", pda, attackerProgram);
  write("wrong-pda", offPda, REGISTRY);
  console.log(`forged: not-registry ${pda.toBase58()} (owner ${attackerProgram.toBase58()}), wrong-pda ${offPda.toBase58()}`);
})();
