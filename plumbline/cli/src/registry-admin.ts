// `plumbline registry init-config | set-config | show-config`: the registry's trust anchors.
// init_config is one-time and only the registry program's upgrade authority may send it; set_config is
// admin-only (the admin is whoever ran init_config). Both write all four fields, so set-config reads the
// current config and changes only the flags you pass.
import { Command } from "commander";
import { PublicKey, SystemProgram } from "@solana/web3.js";
import { explorerUrl, type Cluster } from "./cluster.js";
import * as fs from "node:fs";
import { parseJournal, parseProof, type PlumblineChain } from "./chain/index.js";

/** Production guest image id (plumbline/zk/README.md, "production (Intel root)"). */
export const PRODUCTION_IMAGE_ID = "68049079fafddc9192761eb4461fb8cb036e92275fb91aa7ef61801c975114c6";
/** sha256 of the Intel SGX Root CA DER the production guest pins (zk/lib/src/tdx.rs). */
export const INTEL_SGX_ROOT_SHA256 = "44a0196b2b99f889b8e149e95b807a350e7424964399e885a7cbb8ccfab674d3";
/**
 * The program refuses an all-zero compose hash, so before the real enclave's compose hash is known
 * init-config stores this marker. No real enclave has it, so no score can be recorded until
 * `registry set-config --compose-hash <real>` replaces it.
 */
export const COMPOSE_PLACEHOLDER = "ff".repeat(32);
export const BPF_LOADER_UPGRADEABLE = new PublicKey("BPFLoaderUpgradeab1e11111111111111111111111");

export function parseHexN(s: string, bytes: number, what: string): Buffer {
  const h = String(s).trim().toLowerCase().replace(/^0x/, "");
  if (!new RegExp(`^[0-9a-f]{${bytes * 2}}$`).test(h)) throw new Error(`${what} must be ${bytes * 2} hex chars (${bytes} bytes), optionally 0x-prefixed`);
  return Buffer.from(h, "hex");
}

export type ConfigArgs = { imageId: Buffer; rootSha256: Buffer; composeHash: Buffer; mrTd: Buffer };
export type ConfigHex = { imageId: string; root: string; compose: string; mrTd: string };

/** init-config flags -> the four instruction args. Missing compose = placeholder, missing mr_td = zeros (any TD). */
export function initConfigArgs(o: { imageId?: string; rootSha?: string; composeHash?: string; mrTd?: string }): ConfigArgs & { composePlaceholder: boolean } {
  if (!o.imageId) throw new Error("--image-id is required");
  if (!o.rootSha) throw new Error("--root-sha is required");
  const composeHash = o.composeHash ? parseHexN(o.composeHash, 32, "--compose-hash") : Buffer.from(COMPOSE_PLACEHOLDER, "hex");
  if (composeHash.equals(Buffer.alloc(32))) throw new Error("--compose-hash cannot be all zero (the program refuses it); omit it to store the placeholder");
  return {
    imageId: parseHexN(o.imageId, 32, "--image-id"), rootSha256: parseHexN(o.rootSha, 32, "--root-sha"), composeHash,
    mrTd: o.mrTd ? parseHexN(o.mrTd, 48, "--mr-td") : Buffer.alloc(48), composePlaceholder: !o.composeHash,
  };
}

/** set-config flags over the current config: only the flags given change. `--mr-td any` clears the TD pin. */
export function setConfigArgs(cur: ConfigHex, o: { imageId?: string; rootSha?: string; composeHash?: string; mrTd?: string }): ConfigArgs {
  if (!o.imageId && !o.rootSha && !o.composeHash && !o.mrTd) throw new Error("nothing to change: pass at least one of --image-id, --root-sha, --compose-hash, --mr-td");
  const composeHash = o.composeHash ? parseHexN(o.composeHash, 32, "--compose-hash") : Buffer.from(cur.compose, "hex");
  if (composeHash.equals(Buffer.alloc(32))) throw new Error("--compose-hash cannot be all zero (the program refuses it)");
  return {
    imageId: o.imageId ? parseHexN(o.imageId, 32, "--image-id") : Buffer.from(cur.imageId, "hex"),
    rootSha256: o.rootSha ? parseHexN(o.rootSha, 32, "--root-sha") : Buffer.from(cur.root, "hex"),
    composeHash,
    mrTd: o.mrTd === "any" ? Buffer.alloc(48) : o.mrTd ? parseHexN(o.mrTd, 48, "--mr-td") : Buffer.from(cur.mrTd, "hex"),
  };
}

const toHex = (a: ConfigArgs): ConfigHex => ({ imageId: a.imageId.toString("hex"), root: a.rootSha256.toString("hex"),
  compose: a.composeHash.toString("hex"), mrTd: a.mrTd.toString("hex") });

export function describeConfig(c: ConfigHex & { admin?: string }): string[] {
  const note = (h: string, known: Record<string, string>) => (known[h] ? `  (${known[h]})` : "");
  return [
    ...(c.admin ? [`  admin        ${c.admin}`] : []),
    `  image id     ${c.imageId}${note(c.imageId, { [PRODUCTION_IMAGE_ID]: "production guest" })}`,
    `  root sha256  ${c.root}${note(c.root, { [INTEL_SGX_ROOT_SHA256]: "Intel SGX Root CA" })}`,
    `  compose      ${c.compose}${c.compose === COMPOSE_PLACEHOLDER ? "  (PLACEHOLDER: no score can be recorded until set-config --compose-hash)" : ""}`,
    `  mr_td        ${/^0+$/.test(c.mrTd) ? "any (not checked)" : c.mrTd}`,
  ];
}

export function programDataAddress(programId: PublicKey): PublicKey {
  return PublicKey.findProgramAddressSync([programId.toBuffer()], BPF_LOADER_UPGRADEABLE)[0];
}

async function sendInitConfig(ch: PlumblineChain, a: ConfigArgs) {
  const config = ch.configPda();
  const signature = await ch.registry.methods
    .initConfig(Array.from(a.imageId), Array.from(a.rootSha256), Array.from(a.composeHash), Array.from(a.mrTd))
    .accountsPartial({ config, admin: ch.payer.publicKey, programData: programDataAddress(ch.registryId), systemProgram: SystemProgram.programId })
    .rpc();
  return { signature, config: config.toBase58() };
}

async function sendSetConfig(ch: PlumblineChain, a: ConfigArgs) {
  const config = ch.configPda();
  const signature = await ch.registry.methods
    .setConfig(Array.from(a.imageId), Array.from(a.rootSha256), Array.from(a.composeHash), Array.from(a.mrTd))
    .accountsPartial({ config, admin: ch.payer.publicKey })
    .rpc();
  return { signature, config: config.toBase58() };
}

type Ctx = (cmd: Command) => {
  cluster: Cluster; chain: (signer?: boolean) => Promise<PlumblineChain>; print: (human: string, data?: unknown) => void;
};

export function addRegistryCommands(program: Command, ctx: Ctx): void {
  const reg = program.command("registry").description("registry trust anchors (guest image id, root, enclave compose hash, TD image)");
  const flags = (c: Command) => c
    .option("--image-id <hex>", "RISC Zero image id of the trusted guest (64 hex)")
    .option("--root-sha <hex>", "sha256 of the root cert the guest pins (64 hex); Intel SGX root in production")
    .option("--compose-hash <hex>", "dstack app compose hash of the approved enclave (64 hex)")
    .option("--mr-td <hex>", "approved TD measurement (96 hex); omit = any");

  flags(reg.command("init-config"))
    .description(`one-time: store the trust anchors (registry upgrade authority only). Production: --image-id ${PRODUCTION_IMAGE_ID.slice(0, 8)}… --root-sha ${INTEL_SGX_ROOT_SHA256.slice(0, 8)}…; without --compose-hash a placeholder is stored`)
    .action(async (o, cmd) => {
      const c = ctx(cmd);
      const a = initConfigArgs(o);
      const ch = await c.chain(true);
      const r = await sendInitConfig(ch, a);
      c.print([`registry config ${r.config} initialised, tx ${r.signature}`, ...describeConfig(toHex(a)),
        `  ${explorerUrl("tx", r.signature, c.cluster)}`,
        ...(a.composePlaceholder ? ["next: once the enclave's compose hash is known, run: plumbline registry set-config --compose-hash <hex>"] : [])].join("\n"),
      { ...r, ...toHex(a), composePlaceholder: a.composePlaceholder });
    });

  flags(reg.command("set-config"))
    .description("admin only: change some of the trust anchors (unspecified ones keep their current value; --mr-td any clears the TD pin)")
    .action(async (o, cmd) => {
      const c = ctx(cmd);
      const ch = await c.chain(true);
      const cur = await ch.fetchConfig();
      if (!cur) throw new Error(`registry config ${ch.configPda().toBase58()} does not exist yet: run registry init-config first`);
      const a = setConfigArgs(cur, o);
      const r = await sendSetConfig(ch, a);
      c.print([`registry config ${r.config} updated, tx ${r.signature}`, ...describeConfig(toHex(a)), `  ${explorerUrl("tx", r.signature, c.cluster)}`].join("\n"),
        { ...r, ...toHex(a) });
    });

  reg.command("show-config").description("print the registry config and program ids")
    .action(async (_o, cmd) => {
      const c = ctx(cmd);
      const ch = await c.chain();
      const cur = await ch.fetchConfig();
      const ids = [`registry program ${ch.registryId.toBase58()}`, `bounty program   ${ch.bountyId.toBase58()}`];
      if (!cur) { c.print([...ids, `config ${ch.configPda().toBase58()}: not initialised`].join("\n"), { registry: ch.registryId.toBase58(), bounty: ch.bountyId.toBase58(), config: null }); return; }
      c.print([...ids, `config ${ch.configPda().toBase58()}`, ...describeConfig(cur), `  ${explorerUrl("address", ch.configPda().toBase58(), c.cluster)}`].join("\n"),
        { registry: ch.registryId.toBase58(), bounty: ch.bountyId.toBase58(), config: { address: ch.configPda().toBase58(), ...cur, composePlaceholder: cur.compose === COMPOSE_PLACEHOLDER } });
    });

  program.command("proof").description("inspect a Groth16 proof file").command("inspect <proof>")
    .description("print what a proof's journal states (statement, suite, score, payout, image, compose); --check-config compares it with the registry config")
    .option("--check-config", "also read the registry config and say whether record would accept this proof", false)
    .action(async (file, o, cmd) => {
      const c = ctx(cmd);
      const info = proofInfo(JSON.parse(fs.readFileSync(file, "utf8")));
      const lines = [`statement    ${info.statementHash}`, `suite        ${info.suiteCommitment}`, `score        ${info.correct}/${info.total}`,
        `payout       ${info.payout}`, `image id     ${info.imageId}`, `root sha256  ${info.root}`, `compose      ${info.composeHash}`,
        `mr_td        ${info.mrTd}`, `bound        ${info.bound}`];
      let check: { ok: boolean; problems: string[] } | null = null;
      if (o.checkConfig) {
        const ch = await c.chain();
        const cur = await ch.fetchConfig();
        check = { ok: false, problems: cur ? configProblems(cur, info) : ["registry config is not initialised (run registry init-config)"] };
        check.ok = check.problems.length === 0;
        lines.push(check.ok ? "registry config: matches, record should be accepted" : `registry config: ${check.problems.join("; ")}`);
      }
      c.print(lines.join("\n"), { ...info, check });
    });
}

export type ProofInfo = {
  statementHash: string; suiteCommitment: string; correct: number; total: number; payout: string; imageId: string;
  root: string; composeHash: string; mrTd: string; bound: number;
};
export function proofInfo(raw: unknown): ProofInfo {
  const p = parseProof(raw);
  const j = parseJournal(p.journal);
  return {
    statementHash: j.statementHash.toString("hex"), suiteCommitment: j.suiteCommitment.toString("hex"), correct: j.correct, total: j.total,
    payout: new PublicKey(j.payout).toBase58(), imageId: p.imageId.toString("hex"), root: j.rootSha256.toString("hex"),
    composeHash: j.composeHash.toString("hex"), mrTd: j.mrTd.toString("hex"), bound: j.bound,
  };
}
/** The registry's record_verified_score config checks, off chain, with the fix for each. */
export function configProblems(cur: ConfigHex, p: ProofInfo): string[] {
  const out: string[] = [];
  if (p.imageId !== cur.imageId) out.push(`image id ${p.imageId.slice(0, 16)}… is not the configured ${cur.imageId.slice(0, 16)}… (BadProof; a TEST ONLY proof cannot be recorded against the production image)`);
  if (p.root !== cur.root) out.push(`root ${p.root.slice(0, 16)}… is not the configured ${cur.root.slice(0, 16)}… (WrongRoot)`);
  if (p.composeHash !== cur.compose) out.push(`compose ${p.composeHash.slice(0, 16)}… is not the configured ${cur.compose === COMPOSE_PLACEHOLDER ? "placeholder" : cur.compose.slice(0, 16) + "…"} (WrongEnclave; fix: registry set-config --compose-hash ${p.composeHash})`);
  if (!/^0+$/.test(cur.mrTd) && p.mrTd !== cur.mrTd) out.push(`mr_td is not the configured one (WrongEnclave; fix: registry set-config --mr-td any, or the right value)`);
  if (p.bound !== 1) out.push("quote is not bound to the statement (QuoteNotBound)");
  return out;
}
