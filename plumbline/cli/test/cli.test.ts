import { createHash } from "node:crypto";
import * as fs from "node:fs";
import * as http from "node:http";
import * as os from "node:os";
import * as path from "node:path";
import { Keypair, PublicKey } from "@solana/web3.js";
import sodium from "libsodium-wrappers";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { checkBundle, fillEmptyDigests, payoutToHex } from "../src/bundle.js";
import { parseSol, parseShard, parseTarget, rank, run } from "../src/cli.js";
import { assertNotMainnet, MAINNET_GENESIS, resolveCluster } from "../src/cluster.js";
import { claimable, type BountyView, type ScoreView } from "../src/chain/index.js";
import { keyReleaseReportData, suiteCommitment } from "../src/seal.js";
import { fakeQuote, makeBundle } from "./fixtures.js";

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "plumbline-cli-"));
afterAll(() => fs.rmSync(tmp, { recursive: true, force: true }));

function harness(chain?: any) {
  const out: string[] = [], err: string[] = [];
  let chainCalls = 0;
  const deps = {
    out: (s: string) => out.push(s), err: (s: string) => err.push(s),
    chain: async () => { chainCalls++; if (!chain) throw new Error("chain not expected"); return chain; },
  };
  return { deps, out, err, calls: () => chainCalls, cli: (...a: string[]) => run(a, deps) };
}

const Z = "00".repeat(32);
function bountyRow(over: Partial<BountyView> = {}): BountyView {
  return { address: Keypair.generate().publicKey.toBase58(), sponsor: Keypair.generate().publicKey.toBase58(), nonce: 1n, suiteCommitment: "7c".repeat(32),
    minCorrect: 2, minTotal: 3, amount: 1_000_000_000n, mint: null, deadlineSlot: 1000n, claimGraceSlots: 10n, requireRegisteredSuite: false,
    requiredComposeHash: Z, requiredImageId: Z, createdSlot: 100n, status: "open", winnerStatementHash: Z, winnerModelIdHash: Z,
    winnerPayout: PublicKey.default.toBase58(), paidSlot: 0n, ...over };
}
function scoreRow(over: Partial<ScoreView> = {}): ScoreView {
  return { address: Keypair.generate().publicKey.toBase58(), statementHash: "aa".repeat(32), modelIdHash: "bb".repeat(32), suiteCommitment: "7c".repeat(32),
    quoteHash: Z, mrTd: "00".repeat(48), composeHash: "cc".repeat(32), imageId: "11".repeat(32), correct: 4, total: 6, bindingVersion: 1,
    suiteRegistered: true, submitter: Keypair.generate().publicKey.toBase58(), slot: 500n, unixTimestamp: 0n,
    payout: Keypair.generate().publicKey.toBase58(), ...over };
}

describe("cluster selection and the mainnet refusal", () => {
  it("defaults to localnet and accepts devnet", () => {
    expect(resolveCluster()).toEqual({ name: "localnet", url: "http://127.0.0.1:8899" });
    expect(resolveCluster("devnet").name).toBe("devnet");
    expect(resolveCluster("http://localhost:8899").name).toBe("localnet");
    expect(resolveCluster("https://my-devnet.example.com").name).toBe("devnet");
  });
  it("refuses mainnet by name, by URL, and unknown public RPCs", () => {
    for (const c of ["mainnet", "mainnet-beta", "MAINNET-BETA", "https://api.mainnet-beta.solana.com", "https://rpc.example.com/mainnet"]) {
      expect(() => resolveCluster(c)).toThrow(/mainnet/i);
    }
    expect(() => resolveCluster("https://rpc.example.com")).toThrow(/refusing/);
    expect(() => resolveCluster("testnet")).toThrow(/unknown cluster/);
  });
  it("refuses an RPC that reports the mainnet-beta genesis hash", async () => {
    await expect(assertNotMainnet({ getGenesisHash: async () => MAINNET_GENESIS } as any)).rejects.toThrow(/mainnet/);
    await expect(assertNotMainnet({ getGenesisHash: async () => "EtWTRABZaYq6iMfeYKouRu166VU2xqa1wcaWoxPkrZBG" } as any)).resolves.toBeUndefined();
  });
  it("every command exits 3 on mainnet before touching the chain or the wallet", async () => {
    const cmds = [["bounty", "list"], ["bounty", "show", "x"], ["bounty", "refund", "x"], ["claim", "--score", "x"],
      ["bounty", "create", "--suite", "7c".repeat(32), "--reward", "1", "--target", "2/3"], ["suite", "register", "7c".repeat(32)]];
    for (const c of cmds) {
      for (const cl of ["mainnet-beta", "https://api.mainnet-beta.solana.com"]) {
        const h = harness();
        expect(await h.cli("--cluster", cl, ...c)).toBe(3);
        expect(h.calls()).toBe(0);
        expect(h.err.join("\n")).toMatch(/refusing mainnet/);
      }
    }
  });
});

describe("argument parsing", () => {
  it("parses SOL exactly, targets and shards", () => {
    expect(parseSol("1")).toBe(1_000_000_000n);
    expect(parseSol("0.000000001")).toBe(1n);
    expect(parseSol("2.5")).toBe(2_500_000_000n);
    expect(() => parseSol("0")).toThrow();
    expect(() => parseSol("1e9")).toThrow();
    expect(() => parseSol("0.0000000001")).toThrow();
    expect(parseTarget("2/3")).toEqual({ minCorrect: 2, minTotal: 3 });
    expect(parseTarget("80%")).toEqual({ minCorrect: 80, minTotal: 100 });
    expect(() => parseTarget("4/3")).toThrow();
    expect(() => parseTarget("0/0")).toThrow();
    expect(parseShard(`model.safetensors=${"ab".repeat(32)}:123`, false)).toEqual({ file: "model.safetensors", sha256: "ab".repeat(32), size: 123 });
    expect(parseShard(`https://huggingface.co/o/m/resolve/x/a.safetensors=${"ab".repeat(32)}`, true).url).toMatch(/^https:/);
    expect(() => parseShard(`http://x/a=${"ab".repeat(32)}`, true)).toThrow(/https/);
    expect(() => parseShard("a=xyz", false)).toThrow();
  });
  it("rejects bad options before any chain call", async () => {
    const h = harness();
    expect(await h.cli("bounty", "create", "--suite", "nothex", "--reward", "1", "--target", "2/3")).toBe(1);
    expect(await h.cli("bounty", "create", "--suite", "7c".repeat(32), "--reward", "abc", "--target", "2/3")).toBe(1);
    expect(await h.cli("bounty", "create", "--suite", "7c".repeat(32), "--reward", "1")).toBe(1); // missing --target
    expect(await h.cli("verify", "x.json", "--quote-check", "none")).toBe(1);
    expect(h.calls()).toBe(0);
  });
  it("bounty create passes exact terms to the chain", async () => {
    let got: any;
    const chain = { slot: async () => 1000, createBounty: async (a: any) => { got = a; return { signature: "sig", bounty: "B" }; } };
    const h = harness(chain);
    expect(await h.cli("--json", "bounty", "create", "--suite", "7C".repeat(32), "--reward", "1.25", "--target", "2/3", "--deadline-slots", "500",
      "--grace-slots", "20", "--nonce", "7", "--pin-compose", "cc".repeat(32))).toBe(0);
    expect(got.lamports).toBe(1_250_000_000n);
    expect([got.minCorrect, got.minTotal, got.deadlineSlot, got.claimGraceSlots, got.nonce]).toEqual([2, 3, 1500n, 20n, 7n]);
    expect(got.suiteCommitment.toString("hex")).toBe("7c".repeat(32));
    expect(got.requiredComposeHash.toString("hex")).toBe("cc".repeat(32));
    expect(got.requiredImageId).toBeUndefined();
    expect(JSON.parse(h.out.join("")).bounty).toBe("B");
  });
});

describe("seal", () => {
  let pk: Uint8Array, sk: Uint8Array;
  const secretMarker = "SECRET-QUESTION-zebra-quartz";
  const suiteFile = path.join(tmp, "test-suite-input.json");
  beforeAll(async () => {
    await sodium.ready;
    ({ publicKey: pk, privateKey: sk } = sodium.crypto_box_keypair());
    fs.writeFileSync(suiteFile, JSON.stringify({ suite_id: "t1", items: [{ q: secretMarker, a: "B" }], "é": 1.5 }));
  });

  it("seals to the enclave key, never prints the suite, and the enclave can open it", async () => {
    const h = harness();
    const out = path.join(tmp, "sealed.json");
    expect(await h.cli("seal", suiteFile, "--enclave-pubkey", Buffer.from(pk).toString("hex"), "-o", out)).toBe(0);
    const all = h.out.join("\n") + h.err.join("\n");
    expect(all).not.toContain(secretMarker);
    expect(all).toContain("no attestation");
    const s = JSON.parse(fs.readFileSync(out, "utf8"));
    expect(JSON.stringify(s)).not.toContain(secretMarker);
    const opened = Buffer.from(sodium.crypto_box_seal_open(Buffer.from(s.sealed, "base64"), pk, sk));
    expect(opened.equals(fs.readFileSync(suiteFile))).toBe(true);
    // commitment = sha256(json.dumps(suite, sort_keys=True, separators=(',',':'), ensure_ascii=False))
    const canon = '{"items":[{"a":"B","q":"' + secretMarker + '"}],"suite_id":"t1","é":1.5}';
    expect(s.suite_commitment).toBe(createHash("sha256").update(canon).digest("hex"));
    expect(suiteCommitment(fs.readFileSync(suiteFile))).toBe(s.suite_commitment);
  });

  it("checks the attestation binding; a stub quote passes only with --skip-intel-check on localnet", async () => {
    const pkHex = Buffer.from(pk).toString("hex"), challenge = "ab".repeat(32);
    const rd = keyReleaseReportData(pkHex, challenge);
    const att = { enclave_pubkey: pkHex, challenge, report_data: rd + "00".repeat(32), quote: fakeQuote(Buffer.from(rd, "hex")).toString("hex"), event_log: "[]" };
    const attFile = path.join(tmp, "attest.json");
    fs.writeFileSync(attFile, JSON.stringify(att));
    const out = path.join(tmp, "sealed2.json");
    let h = harness();
    expect(await h.cli("seal", suiteFile, "--enclave-pubkey", pkHex, "--attestation", attFile, "-o", out)).toBe(1); // Intel check fails
    h = harness();
    expect(await h.cli("--cluster", "devnet", "seal", suiteFile, "--enclave-pubkey", pkHex, "--attestation", attFile, "--skip-intel-check", "-o", out)).toBe(1);
    expect(h.err.join()).toMatch(/localnet only/);
    h = harness();
    expect(await h.cli("seal", suiteFile, "--enclave-pubkey", pkHex, "--attestation", attFile, "--skip-intel-check", "-o", out)).toBe(0);
    const s = JSON.parse(fs.readFileSync(out, "utf8"));
    expect([s.challenge, s.quote_checked, s.key_release.quote]).toEqual([challenge, "binding-only", att.quote]);
    // wrong key
    fs.writeFileSync(attFile, JSON.stringify({ ...att, enclave_pubkey: "11".repeat(32) }));
    h = harness();
    expect(await h.cli("seal", suiteFile, "--enclave-pubkey", pkHex, "--attestation", attFile, "--skip-intel-check", "-o", out)).toBe(1);
    expect(h.err.join()).toMatch(/different enclave key/);
    expect(h.out.join() + h.err.join()).not.toContain(secretMarker);
  });

  it("refuses to overwrite the suite file", async () => {
    const h = harness();
    expect(await h.cli("seal", suiteFile, "--enclave-pubkey", Buffer.from(pk).toString("hex"), "-o", suiteFile)).toBe(1);
    expect(fs.readFileSync(suiteFile, "utf8")).toContain(secretMarker);
  });
});

describe("enter (against a local stand-in for POST /enter)", () => {
  let server: http.Server, url = "", lie: "none" | "payout" = "none", lastBody: any;
  beforeAll(async () => {
    server = http.createServer((req, res) => {
      let body = ""; req.on("data", (c) => (body += c)); req.on("end", () => {
        lastBody = JSON.parse(body);
        const payout = lie === "payout" ? Keypair.generate().publicKey.toBase58() : new PublicKey(Buffer.from(lastBody.payout, "hex")).toBase58();
        const rebuilt = makeBundle({ payout, model: lastBody.model_id, extra: { model_revision: lastBody.revision } });
        res.writeHead(200, { "content-type": "application/json" });
        res.end(JSON.stringify({ statement: rebuilt.bundle.statement, quote: rebuilt.bundle.score.quote, event_log: rebuilt.bundle.score.event_log, report_data: rebuilt.bundle.score.report_data }));
      });
    });
    await new Promise<void>((r) => server.listen(0, "127.0.0.1", () => r()));
    url = `http://127.0.0.1:${(server.address() as any).port}`;
  });
  afterAll(() => server.close());

  const sealedFile = path.join(tmp, "sealed-enter.json");
  fs.writeFileSync(sealedFile, JSON.stringify({ format: "plumbline-sealed-suite-1", suite_commitment: "7c".repeat(32), enclave_pubkey: "0a".repeat(32),
    challenge: "e6".repeat(32), sealed: "AAAA", key_release: { quote: "00", event_log: "[]", report_data: "00" }, quote_checked: "intel" }));

  it("sends the payout as 64 hex, saves the bundle and checks the statement payout", async () => {
    const payout = Keypair.generate().publicKey.toBase58();
    const out = path.join(tmp, "bundle-enter.json");
    const h = harness();
    lie = "none";
    expect(await h.cli("enter", "--enclave", url, "--sealed", sealedFile, "--model", "org/m", "--revision", "ab".repeat(20),
      "--payout", payout, "--shard", `model.safetensors=${"cd".repeat(32)}`, "-o", out)).toBe(0);
    expect(lastBody.payout).toBe(payoutToHex(payout));
    expect(lastBody.challenge).toBe("e6".repeat(32));
    expect(lastBody.weights).toEqual([{ file: "model.safetensors", sha256: "cd".repeat(32) }]);
    const saved = JSON.parse(fs.readFileSync(out, "utf8"));
    expect(saved.key_release.report_data).toBe("00");
    expect((await checkBundle(fs.readFileSync(out, "utf8"))).payout).toBe(payout);
  });

  it("fails loudly when the enclave's statement names another payout", async () => {
    const h = harness();
    lie = "payout";
    expect(await h.cli("enter", "--enclave", url, "--sealed", sealedFile, "--model", "org/m", "--revision", "ab".repeat(20),
      "--payout", Keypair.generate().publicKey.toBase58(), "--shard", `model.safetensors=${"cd".repeat(32)}`, "-o", path.join(tmp, "b2.json"))).toBe(1);
    expect(h.err.join()).toMatch(/payout is not the address you asked for/);
  });

  it("rejects a malformed or zero payout before calling the enclave", async () => {
    const h = harness();
    expect(await h.cli("enter", "--enclave", "http://127.0.0.1:1", "--sealed", sealedFile, "--model", "m", "--revision", "ab".repeat(20),
      "--payout", PublicKey.default.toBase58(), "--shard", `a=${"cd".repeat(32)}`)).toBe(1);
    expect(await h.cli("enter", "--enclave", "http://127.0.0.1:1", "--sealed", sealedFile, "--model", "m", "--revision", "ab".repeat(20),
      "--payout", "not-a-key", "--shard", `a=${"cd".repeat(32)}`)).toBe(1);
  });
});

describe("verify", () => {
  it("binding mode accepts a bound bundle and shows the payout; full mode fails at the Intel check", async () => {
    const b = makeBundle();
    const f = path.join(tmp, "v1.json"); fs.writeFileSync(f, b.text);
    let h = harness();
    expect(await h.cli("verify", f, "--quote-check", "binding")).toBe(0);
    expect(h.out.join()).toContain(`payout ${b.payout}`);
    h = harness();
    expect(await h.cli("verify", f)).toBe(1);
    expect(h.out.join()).toMatch(/FAIL full quote verification/);
  });
  it("accepts dstack-cloud's stripped runtime digests and fills them for the browser verifier", async () => {
    const b = makeBundle({ strip: true });
    const r = await checkBundle(b.text, { quoteCheck: "binding" });
    expect(r.ok).toBe(true);
    expect(r.emptyDigests).toBe(1);
    const filled = fillEmptyDigests(b.bundle.score.event_log);
    expect(filled.filled).toBe(1);
    expect(JSON.parse(filled.log as string)[1].digest).toHaveLength(96);
  });
  it("rejects a broken binding, a missing payout and a tampered statement", async () => {
    expect((await checkBundle(makeBundle({ breakBinding: true }).text)).ok).toBe(false);
    const np = await checkBundle(makeBundle({ payout: null }).text);
    expect(np.ok).toBe(false);
    expect(np.checks.find((c) => /payout/.test(c.name))!.detail).toMatch(/no payout/);
    const t = makeBundle(); (t.bundle.statement as any).correct = 6;
    expect((await checkBundle(JSON.stringify(t.bundle))).ok).toBe(false);
  });
});

describe("claim", () => {
  it("claims only the bounties the score meets and never takes a payout argument", async () => {
    const score = scoreRow({ correct: 4, total: 6, slot: 500n });
    const good = bountyRow({ minCorrect: 2, minTotal: 3 });
    const high = bountyRow({ minCorrect: 5, minTotal: 6 });
    const late = bountyRow({ createdSlot: 600n });
    const claimed: string[] = [];
    const chain = {
      scoreByStatement: async () => score, fetchScore: async () => score,
      listBounties: async () => [good, high, late],
      claim: async (b: string, s: string) => { claimed.push(b); expect(s).toBe(score.address); return { signature: "sig-" + b, payout: score.payout }; },
    };
    const h = harness(chain);
    expect(await h.cli("--json", "claim", "--statement", "aa".repeat(32))).toBe(0);
    expect(claimed).toEqual([good.address]);
    const res = JSON.parse(h.out.join(""));
    expect(res.find((r: any) => r.bounty === high.address).skipped).toBe("BelowTarget");
    expect(res.find((r: any) => r.bounty === late.address).skipped).toBe("ScoreBeforeBounty");
    const h2 = harness(chain);
    expect(await h2.cli("claim", "--statement", "aa".repeat(32), "--payout", "x")).toBe(1); // unknown option
  });
  it("claimable mirrors the program's checks", () => {
    const s = scoreRow();
    expect(claimable(bountyRow(), s).ok).toBe(true);
    expect(claimable(bountyRow({ status: "paid" }), s)).toEqual({ ok: false, reason: "AlreadyPaid" });
    expect(claimable(bountyRow({ suiteCommitment: "00".repeat(32) }), s)).toEqual({ ok: false, reason: "WrongSuite" });
    expect(claimable(bountyRow({ requiredComposeHash: "dd".repeat(32) }), s)).toEqual({ ok: false, reason: "WrongEnclave" });
    expect(claimable(bountyRow({ requiredImageId: "11".repeat(32) }), s).ok).toBe(true);
    expect(claimable(bountyRow({ deadlineSlot: 499n }), s)).toEqual({ ok: false, reason: "ScoreAfterDeadline" });
    expect(claimable(bountyRow({ minCorrect: 667, minTotal: 1000 }), s)).toEqual({ ok: false, reason: "BelowTarget" }); // total 6 < 1000
    expect(claimable(bountyRow(), scoreRow({ payout: PublicKey.default.toBase58() }))).toEqual({ ok: false, reason: "NoPayout" });
  });
  it("ranks by accuracy without floats, earlier slot first on ties", () => {
    const rows = [scoreRow({ correct: 2, total: 3, slot: 9n }), scoreRow({ correct: 4, total: 6, slot: 5n }), scoreRow({ correct: 5, total: 6, slot: 7n })];
    expect(rows.sort(rank).map((r) => `${r.correct}/${r.total}@${r.slot}`)).toEqual(["5/6@7", "4/6@5", "2/3@9"]);
  });
});
