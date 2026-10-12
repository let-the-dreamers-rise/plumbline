// One bundle through the pipeline: check -> prove -> record_verified_score -> claim every bounty it meets.
// The relayer only pays transaction fees. It never holds sponsor funds, and it cannot choose the payout:
// claim sends to the payout stored in the VerifiedScore, which came from the proven journal.
import * as fs from "node:fs";
import * as path from "node:path";
import { checkBundle, proverInputs, type QuoteCheck } from "../../cli/src/bundle.js";
import {
  claimable, errorText, parseJournal, parseProof, PublicKey, type BountyView, type Proof, type ScoreView,
} from "../../cli/src/chain/index.js";
import type { ProverPort } from "./prover.js";
import type { State } from "./state.js";

/** The slice of PlumblineChain the relayer uses (mocked in tests). */
export interface ChainPort {
  scoreByStatement(statementHash: string): Promise<ScoreView | null>;
  fetchScore(address: string): Promise<ScoreView | null>;
  recordVerifiedScore(p: Proof): Promise<{ signature: string; score: string }>;
  listBounties(o: { suite: string; openOnly: boolean }): Promise<BountyView[]>;
  claim(bounty: string, score: string): Promise<{ signature: string; payout: string }>;
}

export type Logger = (step: string, fields?: Record<string, unknown>) => void;
export type Outcome = { statementHash?: string; status: string; detail?: string; claims?: Record<string, unknown> };

export function jsonLogger(file?: string, echo: (s: string) => void = (s) => process.stdout.write(s + "\n")): Logger {
  return (step, fields = {}) => {
    const line = JSON.stringify({ ts: new Date().toISOString(), step, ...fields });
    echo(line);
    if (file) fs.appendFileSync(file, line + "\n");
  };
}

export class Relayer {
  constructor(private o: { chain: ChainPort; prover: ProverPort; state: State; log: Logger; workDir: string; quoteCheck: QuoteCheck }) {}

  async handle(text: string, source: string): Promise<Outcome> {
    const { chain, state, log } = this.o;
    log("bundle.received", { source });
    let rep;
    try { rep = await checkBundle(text, { quoteCheck: this.o.quoteCheck }); }
    catch (e: any) { log("bundle.unreadable", { source, error: String(e?.message ?? e) }); return { status: "unreadable", detail: String(e?.message ?? e) }; }
    const h = rep.statementHash;
    const failed = rep.checks.filter((c) => !c.ok);
    log("bundle.checked", { statement: h, ok: rep.ok, correct: rep.correct, n: rep.n, payout: rep.payout, failed: failed.map((c) => c.name) });
    const prev = state.get(h);
    if (!rep.ok) {
      const detail = failed.map((c) => `${c.name}${c.detail ? ` (${c.detail})` : ""}`).join("; ");
      if (!prev || prev.status === "rejected") state.upsert(h, { source, status: "rejected", error: detail });
      return { statementHash: h, status: "rejected", detail };
    }
    state.upsert(h, { source: prev?.source ?? source, suiteCommitment: rep.suiteCommitment, payout: rep.payout, correct: rep.correct, n: rep.n,
      ...(prev ? {} : { status: "received" }) });

    try {
      // 1. already recorded (by us or anyone)? then skip proving and recording.
      let score = await chain.scoreByStatement(h);
      if (score) {
        log("record.skip", { statement: h, reason: "VerifiedScore already on chain", score: score.address });
        state.upsert(h, { status: state.get(h)!.status === "claimed" ? "claimed" : "recorded", score: score.address });
      } else {
        // 2. prove (reuse a proof from an earlier, interrupted run)
        const proof = await this.proofFor(h, text);
        const j = parseJournal(proof.journal);
        const why = journalMismatch(j, h, rep);
        if (why) {
          state.upsert(h, { proofPath: undefined }); // never reuse a mismatched proof
          throw new Error(`proof journal does not match the bundle: ${why}`);
        }
        // 3. record
        log("record.start", { statement: h });
        try {
          const r = await chain.recordVerifiedScore(proof);
          log("record.done", { statement: h, score: r.score, tx: r.signature });
          state.upsert(h, { status: "recorded", score: r.score, recordTx: r.signature });
        } catch (e) {
          const again = await chain.scoreByStatement(h); // someone else recorded it first: fine
          if (!again) throw e;
          log("record.raced", { statement: h, score: again.address });
          state.upsert(h, { status: "recorded", score: again.address });
        }
        score = await chain.scoreByStatement(h);
        if (!score) throw new Error("recorded but the VerifiedScore cannot be read back");
      }
      if (rep.payout && score.payout !== rep.payout) {
        // cannot happen with an honest registry; refuse to crank rather than pay an unexpected address
        throw new Error(`onchain payout ${score.payout} differs from the bundle's ${rep.payout}`);
      }
      // 4. claim every open bounty this score meets
      const claims = await this.claimAll(score);
      const paid = Object.values(claims).some((c: any) => c.signature) || Object.values(state.get(h)!.claims).some((c) => c.signature);
      state.upsert(h, { status: paid ? "claimed" : "recorded", claims, error: undefined });
      log("bundle.done", { statement: h, status: state.get(h)!.status });
      return { statementHash: h, status: state.get(h)!.status, claims };
    } catch (e) {
      const err = errorText(e);
      log("bundle.failed", { statement: h, error: err });
      state.upsert(h, { status: "failed", error: err, attempts: (state.get(h)?.attempts ?? 0) + 1 });
      return { statementHash: h, status: "failed", detail: err };
    }
  }

  private async proofFor(h: string, text: string): Promise<Proof> {
    const e = this.o.state.get(h);
    if (e?.proofPath && fs.existsSync(e.proofPath)) {
      this.o.log("prove.reuse", { statement: h, proof: e.proofPath });
      return parseProof(JSON.parse(fs.readFileSync(e.proofPath, "utf8")));
    }
    this.o.state.upsert(h, { status: "proving" });
    this.o.log("prove.start", { statement: h });
    const { proof, proofPath } = await this.o.prover.prove(proverInputs(text), path.join(this.o.workDir, h));
    this.o.state.upsert(h, { status: "proved", proofPath });
    this.o.log("prove.done", { statement: h, proof: proofPath });
    return proof;
  }

  private async claimAll(score: ScoreView) {
    const { chain, log } = this.o;
    const bounties = await chain.listBounties({ suite: score.suiteCommitment, openOnly: true });
    log("claim.scan", { statement: score.statementHash, open: bounties.length });
    const claims: Record<string, any> = {};
    const at = () => new Date().toISOString();
    for (const b of bounties) {
      const ok = claimable(b, score);
      if (!ok.ok) { log("claim.skip", { bounty: b.address, reason: ok.reason }); claims[b.address] = { skipped: ok.reason, at: at() }; continue; }
      try {
        log("claim.start", { bounty: b.address, payout: score.payout, amount: b.amount.toString() });
        const r = await chain.claim(b.address, score.address);
        if (!new PublicKey(r.payout).equals(new PublicKey(score.payout))) throw new Error("claim paid an unexpected address");
        log("claim.done", { bounty: b.address, tx: r.signature, payout: r.payout });
        claims[b.address] = { signature: r.signature, payout: r.payout, amount: b.amount.toString(), at: at() };
      } catch (e) {
        log("claim.failed", { bounty: b.address, error: errorText(e) });
        claims[b.address] = { error: errorText(e), at: at() };
      }
    }
    return claims;
  }
}

function journalMismatch(j: ReturnType<typeof parseJournal>, h: string, rep: { suiteCommitment: string; correct: number; n: number; payoutHex: string | null }) {
  if (j.statementHash.toString("hex") !== h) return "statement hash";
  if (j.bound !== 1) return "bound = 0 (quote report_data does not commit to the statement)";
  if (j.suiteCommitment.toString("hex") !== rep.suiteCommitment) return "suite commitment";
  if (j.correct !== rep.correct || j.total !== rep.n) return "score";
  if (j.payout.toString("hex") !== rep.payoutHex) return "payout";
  return null;
}
