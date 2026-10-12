// Runs the zk host (plumbline/zk) as a configurable command. Placeholders in argv and env values:
// {quote} {statement} {event_log} {out} {dir}. The command must write the Groth16 proof JSON
// ({imageId, journal, seal}) to {out}.
import { spawn } from "node:child_process";
import * as fs from "node:fs";
import * as path from "node:path";
import { parseProof, type Proof } from "../../cli/src/chain/index.js";

export type ProverInputs = { quote: Buffer; statement: Buffer; eventLog: string };
export interface ProverPort { prove(inputs: ProverInputs, dir: string): Promise<{ proof: Proof; proofPath: string }> }
export type ProverConfig = { command: string[]; env?: Record<string, string>; cwd?: string; timeoutMs?: number };

export class CommandProver implements ProverPort {
  constructor(private cfg: ProverConfig, private log: (step: string, f?: Record<string, unknown>) => void = () => {}) {
    if (!cfg.command?.length) throw new Error("prover.command is empty");
  }

  async prove(inputs: ProverInputs, dir: string) {
    fs.mkdirSync(dir, { recursive: true });
    const files = {
      quote: path.resolve(dir, "quote.bin"), statement: path.resolve(dir, "statement.json"),
      event_log: path.resolve(dir, "event_log.json"), out: path.resolve(dir, "proof.json"), dir: path.resolve(dir),
    };
    fs.writeFileSync(files.quote, inputs.quote);
    fs.writeFileSync(files.statement, inputs.statement);
    fs.writeFileSync(files.event_log, inputs.eventLog);
    fs.rmSync(files.out, { force: true });
    const sub = (s: string) => s.replace(/\{(quote|statement|event_log|out|dir)\}/g, (_m, k) => (files as any)[k]);
    const [cmd, ...args] = this.cfg.command.map(sub);
    const env = { ...process.env, ...Object.fromEntries(Object.entries(this.cfg.env ?? {}).map(([k, v]) => [k, sub(v)])) };
    this.log("prover.start", { cmd, args });
    const t0 = Date.now();
    await new Promise<void>((resolve, reject) => {
      const p = spawn(cmd, args, { env, cwd: this.cfg.cwd, stdio: ["ignore", "pipe", "pipe"] });
      let tail = "";
      const keep = (d: Buffer) => { tail = (tail + d.toString()).slice(-4000); };
      p.stdout.on("data", keep); p.stderr.on("data", keep);
      const timer = setTimeout(() => { p.kill("SIGKILL"); reject(new Error(`prover timed out after ${this.cfg.timeoutMs} ms`)); },
        this.cfg.timeoutMs ?? 3 * 3600_000);
      p.on("error", (e) => { clearTimeout(timer); reject(e); });
      p.on("close", (code) => {
        clearTimeout(timer);
        if (code === 0) resolve(); else reject(new Error(`prover exited ${code}: ${tail.trim().split("\n").slice(-5).join(" | ")}`));
      });
    });
    if (!fs.existsSync(files.out)) throw new Error(`prover finished but wrote no proof at ${files.out}`);
    this.log("prover.done", { ms: Date.now() - t0, proof: files.out });
    return { proof: parseProof(JSON.parse(fs.readFileSync(files.out, "utf8"))), proofPath: files.out };
  }
}
