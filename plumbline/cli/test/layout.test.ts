// The IDL-driven decoder (cli/src/chain) and the hand-written browser decoder (app/js/layout.js) must agree,
// and both must match the IDLs built from plumbline/programs.
import anchorPkg from "@coral-xyz/anchor";
import { Keypair, PublicKey } from "@solana/web3.js";
import { randomBytes } from "node:crypto";
import { describe, expect, it } from "vitest";
import { bountyView, Connection, loadIdls, PlumblineChain, scoreView } from "../src/chain/index.js";
// @ts-ignore
import * as layout from "../../app/js/layout.js";
// @ts-ignore
import { PROGRAMS } from "../../app/js/config.js";

const { BN } = anchorPkg as any;
const idls = loadIdls();
// the same (camelCased) coders the CLI and relayer use; constructing them makes no RPC calls
const chain = new PlumblineChain(new Connection("http://127.0.0.1:8899"), undefined, loadIdls());
const reg = chain.registry.coder.accounts;
const bty = chain.bounty.coder.accounts;
const arr = (n: number) => Array.from(randomBytes(n));

describe("account layouts (programs/target/idl)", () => {
  it("app program ids match the IDL addresses", () => {
    expect(PROGRAMS.registry).toBe(idls.registry.address);
    expect(PROGRAMS.bounty).toBe(idls.bounty.address);
  });

  it("VerifiedScore: browser decoder == Anchor coder, payout included", async () => {
    const payout = Keypair.generate().publicKey;
    const v = { statementHash: arr(32), modelIdHash: arr(32), suiteCommitment: arr(32), quoteHash: arr(32), mrTd: arr(48), rtmrsHash: arr(32),
      teeTcbSvn: arr(16), composeHash: arr(32), correct: 5, total: 6, bindingVersion: 1, imageId: arr(32), suiteRegistered: true,
      submitter: Keypair.generate().publicKey, slot: new BN(123456789), unixTimestamp: new BN(1760000000), payout, bump: 254 };
    const data: Buffer = await reg.encode("verifiedScore", v);
    expect(Array.from(data.subarray(0, 8))).toEqual(layout.DISC.VerifiedScore);
    const addr = Keypair.generate().publicKey;
    const fromIdl = scoreView(addr, reg.decode("verifiedScore", data));
    const fromApp = layout.decodeScore(addr.toBase58(), new Uint8Array(data));
    for (const k of Object.keys(fromIdl) as (keyof typeof fromIdl)[]) expect([k, fromApp[k]]).toEqual([k, fromIdl[k]]);
    expect(fromApp.payout).toBe(payout.toBase58());
    expect(Buffer.from(data.subarray(layout.OFFSETS.scoreSuite, layout.OFFSETS.scoreSuite + 32))).toEqual(Buffer.from(v.suiteCommitment));
    expect(Buffer.from(data.subarray(layout.OFFSETS.scoreStatement, layout.OFFSETS.scoreStatement + 32))).toEqual(Buffer.from(v.statementHash));
  });

  it("Bounty: browser decoder == Anchor coder (open and paid)", async () => {
    for (const status of [0, 1]) {
      const b = { sponsor: Keypair.generate().publicKey, nonce: new BN(42), suiteCommitment: arr(32), minCorrect: 2, minTotal: 3,
        amount: new BN("1500000000"), mint: null, deadlineSlot: new BN(9_000_000), claimGraceSlots: new BN(150), requireRegisteredSuite: true,
        requiredComposeHash: arr(32), requiredImageId: new Array(32).fill(0), createdSlot: new BN(77), status, winnerStatementHash: arr(32),
        winnerModelIdHash: arr(32), winnerPayout: Keypair.generate().publicKey, paidSlot: new BN(status ? 88 : 0), bump: 253 };
      const data: Buffer = await bty.encode("bounty", b);
      expect(Array.from(data.subarray(0, 8))).toEqual(layout.DISC.Bounty);
      const addr = Keypair.generate().publicKey;
      const fromIdl = bountyView(addr, bty.decode("bounty", data));
      const fromApp = layout.decodeBounty(addr.toBase58(), new Uint8Array(data));
      for (const k of Object.keys(fromIdl) as (keyof typeof fromIdl)[]) if (k !== "lamports") expect([k, fromApp[k]]).toEqual([k, fromIdl[k]]);
      expect(Buffer.from(data.subarray(layout.OFFSETS.bountySuite, layout.OFFSETS.bountySuite + 32))).toEqual(Buffer.from(b.suiteCommitment));
    }
  });

  it("claim instruction takes exactly bounty, verified_score, payout, cranker (no entrant, no payout argument)", () => {
    const claim = idls.bounty.instructions.find((i: any) => i.name === "claim");
    expect(claim.accounts.map((a: any) => a.name)).toEqual(["bounty", "verified_score", "payout", "cranker"]);
    expect(claim.args).toEqual([]);
    expect(idls.bounty.instructions.map((i: any) => i.name)).not.toContain("register_entrant");
    const errs = idls.bounty.errors.map((e: any) => e.name);
    expect(errs).toEqual(expect.arrayContaining(["NoPayout", "ScoreBeforeBounty", "BadPayout"]));
  });

  it("base58 matches web3.js", () => {
    for (const bytes of [new Uint8Array(32), Uint8Array.from([0, 0, 1, ...arr(29)]), Uint8Array.from(arr(32))]) {
      const pk = new PublicKey(bytes);
      expect(layout.b58encode(bytes)).toBe(pk.toBase58());
      expect(Buffer.from(layout.b58decode(pk.toBase58()))).toEqual(Buffer.from(bytes));
    }
  });
});
