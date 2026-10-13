import { Keypair, PublicKey } from "@solana/web3.js";
import * as fs from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { run } from "../src/cli.js";
import {
  COMPOSE_PLACEHOLDER, configProblems, INTEL_SGX_ROOT_SHA256, initConfigArgs, proofInfo, parseHexN, PRODUCTION_IMAGE_ID, programDataAddress, setConfigArgs,
} from "../src/registry-admin.js";

const REGISTRY_ID = new PublicKey("Eicw3HXxXN7kckn5XB4WDGQG2c61BLf7X7QpGehLTgAW");

/** A chain stub whose registry.methods record the instruction name, args and accounts. */
function fakeChain(config: any = null) {
  const sent: any[] = [];
  const payer = Keypair.generate();
  const builder = (name: string) => (...args: any[]) => {
    const rec: any = { name, args };
    const b = { accountsPartial: (acc: any) => { rec.accounts = acc; return b; }, rpc: async () => { sent.push(rec); return "SIG" + sent.length; } };
    return b;
  };
  return {
    sent, payer,
    chain: {
      payer, registryId: REGISTRY_ID, bountyId: Keypair.generate().publicKey,
      configPda: () => PublicKey.findProgramAddressSync([Buffer.from("config")], REGISTRY_ID)[0],
      fetchConfig: async () => config,
      registry: { methods: { initConfig: builder("initConfig"), setConfig: builder("setConfig") } },
    },
  };
}
function harness(chain?: any) {
  const out: string[] = [], err: string[] = [];
  let calls = 0;
  const deps = { out: (s: string) => out.push(s), err: (s: string) => err.push(s),
    chain: async () => { calls++; if (!chain) throw new Error("chain not expected"); return chain; } };
  return { out, err, calls: () => calls, cli: (...a: string[]) => run(a, deps) };
}
const bytes = (h: string) => Array.from(Buffer.from(h, "hex"));

describe("registry config argument parsing", () => {
  it("parses hex of the right length, with or without 0x", () => {
    expect(parseHexN("0x" + PRODUCTION_IMAGE_ID, 32, "x").toString("hex")).toBe(PRODUCTION_IMAGE_ID);
    expect(parseHexN("AB".repeat(48), 48, "x").length).toBe(48);
    expect(() => parseHexN("ab".repeat(31), 32, "--image-id")).toThrow(/--image-id must be 64 hex/);
    expect(() => parseHexN("zz".repeat(32), 32, "x")).toThrow();
    expect(() => parseHexN("ab".repeat(32), 48, "--mr-td")).toThrow(/96 hex/);
  });
  it("init-config: image and root required, compose defaults to the placeholder, mr_td to any", () => {
    const a = initConfigArgs({ imageId: "0x" + PRODUCTION_IMAGE_ID, rootSha: INTEL_SGX_ROOT_SHA256 });
    expect(a.composeHash.toString("hex")).toBe(COMPOSE_PLACEHOLDER);
    expect(a.composePlaceholder).toBe(true);
    expect(a.mrTd.equals(Buffer.alloc(48))).toBe(true);
    expect(() => initConfigArgs({ rootSha: INTEL_SGX_ROOT_SHA256 })).toThrow(/--image-id/);
    expect(() => initConfigArgs({ imageId: PRODUCTION_IMAGE_ID })).toThrow(/--root-sha/);
    expect(() => initConfigArgs({ imageId: PRODUCTION_IMAGE_ID, rootSha: INTEL_SGX_ROOT_SHA256, composeHash: "00".repeat(32) })).toThrow(/all zero/);
    const b = initConfigArgs({ imageId: PRODUCTION_IMAGE_ID, rootSha: INTEL_SGX_ROOT_SHA256, composeHash: "cc".repeat(32), mrTd: "dd".repeat(48) });
    expect(b.composePlaceholder).toBe(false);
    expect(b.mrTd.toString("hex")).toBe("dd".repeat(48));
  });
  it("set-config keeps the fields not given, and --mr-td any clears the pin", () => {
    const cur = { imageId: "11".repeat(32), root: "22".repeat(32), compose: COMPOSE_PLACEHOLDER, mrTd: "33".repeat(48) };
    const a = setConfigArgs(cur, { composeHash: "cc".repeat(32) });
    expect([a.imageId, a.rootSha256, a.composeHash, a.mrTd].map((x) => x.toString("hex"))).toEqual(["11".repeat(32), "22".repeat(32), "cc".repeat(32), "33".repeat(48)]);
    expect(setConfigArgs(cur, { mrTd: "any" }).mrTd.equals(Buffer.alloc(48))).toBe(true);
    expect(() => setConfigArgs(cur, {})).toThrow(/nothing to change/);
    expect(() => setConfigArgs(cur, { composeHash: "00".repeat(32) })).toThrow(/all zero/);
  });
  it("program data address is the upgradeable loader PDA of the program id", () => {
    // the same address the IDL pins for init_config.program_data under the localnet registry id
    const [want] = PublicKey.findProgramAddressSync([REGISTRY_ID.toBuffer()], new PublicKey("BPFLoaderUpgradeab1e11111111111111111111111"));
    expect(programDataAddress(REGISTRY_ID).equals(want)).toBe(true);
  });
});

describe("registry commands", () => {
  it("init-config sends the production values with the placeholder compose hash", async () => {
    const f = fakeChain();
    const h = harness(f.chain);
    expect(await h.cli("--cluster", "devnet", "registry", "init-config", "--image-id", "0x" + PRODUCTION_IMAGE_ID, "--root-sha", INTEL_SGX_ROOT_SHA256)).toBe(0);
    expect(f.sent).toHaveLength(1);
    const [s] = f.sent;
    expect(s.name).toBe("initConfig");
    expect(s.args).toEqual([bytes(PRODUCTION_IMAGE_ID), bytes(INTEL_SGX_ROOT_SHA256), bytes(COMPOSE_PLACEHOLDER), Array(48).fill(0)]);
    expect(s.accounts.admin.equals(f.payer.publicKey)).toBe(true);
    expect(s.accounts.programData.equals(programDataAddress(REGISTRY_ID))).toBe(true);
    const out = h.out.join("\n");
    expect(out).toMatch(/production guest/);
    expect(out).toMatch(/Intel SGX Root CA/);
    expect(out).toMatch(/PLACEHOLDER/);
    expect(out).toMatch(/explorer\.solana\.com\/tx\/SIG1\?cluster=devnet/);
  });
  it("init-config with bad hex fails before touching the chain", async () => {
    const h = harness();
    expect(await h.cli("registry", "init-config", "--image-id", "abc", "--root-sha", INTEL_SGX_ROOT_SHA256)).toBe(1);
    expect(h.calls()).toBe(0);
    expect(h.err.join("\n")).toMatch(/--image-id must be 64 hex/);
  });
  it("set-config changes only the compose hash", async () => {
    const f = fakeChain({ admin: "x", imageId: PRODUCTION_IMAGE_ID, root: INTEL_SGX_ROOT_SHA256, compose: COMPOSE_PLACEHOLDER, mrTd: "00".repeat(48) });
    const h = harness(f.chain);
    expect(await h.cli("--json", "registry", "set-config", "--compose-hash", "cc".repeat(32))).toBe(0);
    expect(f.sent[0].name).toBe("setConfig");
    expect(f.sent[0].args).toEqual([bytes(PRODUCTION_IMAGE_ID), bytes(INTEL_SGX_ROOT_SHA256), bytes("cc".repeat(32)), Array(48).fill(0)]);
    expect(JSON.parse(h.out.join("\n")).compose).toBe("cc".repeat(32));
  });
  it("set-config without an existing config says to run init-config", async () => {
    const h = harness(fakeChain(null).chain);
    expect(await h.cli("registry", "set-config", "--compose-hash", "cc".repeat(32))).toBe(1);
    expect(h.err.join("\n")).toMatch(/init-config first/);
  });
  it("show-config reports the placeholder and an uninitialised config", async () => {
    let h = harness(fakeChain({ admin: "A", imageId: PRODUCTION_IMAGE_ID, root: INTEL_SGX_ROOT_SHA256, compose: COMPOSE_PLACEHOLDER, mrTd: "00".repeat(48) }).chain);
    expect(await h.cli("registry", "show-config")).toBe(0);
    expect(h.out.join("\n")).toMatch(/PLACEHOLDER[\s\S]*mr_td +any/);
    h = harness(fakeChain(null).chain);
    expect(await h.cli("--json", "registry", "show-config")).toBe(0);
    expect(JSON.parse(h.out.join("\n")).config).toBeNull();
  });
  it("refuses mainnet before touching the chain or the wallet", async () => {
    for (const c of [["init-config", "--image-id", PRODUCTION_IMAGE_ID, "--root-sha", INTEL_SGX_ROOT_SHA256], ["set-config", "--compose-hash", "cc".repeat(32)], ["show-config"]]) {
      for (const cl of ["mainnet-beta", "https://api.mainnet-beta.solana.com"]) {
        const h = harness();
        expect(await h.cli("--cluster", cl, "registry", ...c)).toBe(3);
        expect(h.calls()).toBe(0);
        expect(h.err.join("\n")).toMatch(/refusing mainnet/);
      }
    }
  });
});

const PROOF = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../programs/tests/fixtures/synthetic-payout-groth16.json");

describe("proof inspect", () => {
  const info = proofInfo(JSON.parse(fs.readFileSync(PROOF, "utf8")));
  it("reads the journal of the payout fixture", () => {
    expect(info.correct).toBe(4);
    expect(info.total).toBe(6);
    expect(info.payout).toBe("G86RoeNmR7dTKjxsqhZZBnh15mvQgfU7W3BCnCcS3dfk");
    expect(info.suiteCommitment).toMatch(/^7c61b2c5/);
    expect(info.bound).toBe(1);
  });
  it("names each config mismatch and the fix", () => {
    const ok = { imageId: info.imageId, root: info.root, compose: info.composeHash, mrTd: "00".repeat(48) };
    expect(configProblems(ok, info)).toEqual([]);
    const prod = { imageId: PRODUCTION_IMAGE_ID, root: INTEL_SGX_ROOT_SHA256, compose: COMPOSE_PLACEHOLDER, mrTd: "00".repeat(48) };
    const p = configProblems(prod, info).join("\n");
    expect(p).toMatch(/BadProof/);
    expect(p).toMatch(/WrongRoot/);
    expect(p).toMatch(new RegExp(`placeholder.*set-config --compose-hash ${info.composeHash}`));
  });
  it("runs offline, and --check-config reads the chain", async () => {
    let h = harness();
    expect(await h.cli("--json", "proof", "inspect", PROOF)).toBe(0);
    expect(h.calls()).toBe(0);
    expect(JSON.parse(h.out.join("\n")).statementHash).toBe(info.statementHash);
    h = harness(fakeChain({ admin: "A", imageId: info.imageId, root: info.root, compose: info.composeHash, mrTd: "00".repeat(48) }).chain);
    expect(await h.cli("proof", "inspect", PROOF, "--check-config")).toBe(0);
    expect(h.out.join("\n")).toMatch(/matches, record should be accepted/);
  });
});
