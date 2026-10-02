import { keccakBytes, type ReclaimProof } from "./claim.js";
import { Keypair } from "@solana/web3.js";
import { getBytes, sha256, toUtf8Bytes } from "ethers";
import type { SourceArgs } from "./program.js";

/** One entry of oracle/programs/pct_oracle/tests/fixtures/claims.json (scripts/make-oracle-fixtures.ts). */
export interface FixtureClaim {
  name: string;
  provider: number;
  kind: number;
  gpuCount: number;
  valueMode: number;
  requiresNullifier: boolean;
  expectedMicro: number;
  claimProvider: string;
  parameters: string;
  context: string;
  owner: string;
  timestampS: number;
  epoch: number;
  identifier: string;
  signature: string;
  paramsHash: string;
}

export interface Fixtures {
  attestor: string;
  claims: FixtureClaim[];
}

export function fixtureProof(c: FixtureClaim, attestor: string): ReclaimProof {
  return {
    identifier: c.identifier,
    claimData: { provider: c.claimProvider, parameters: c.parameters, context: c.context, owner: c.owner, timestampS: c.timestampS, epoch: c.epoch },
    signatures: [c.signature],
    witnesses: [{ id: attestor }],
  };
}

/** Same registration flow.rs uses: source id is keccak(name), H100 only. */
export function fixtureSource(c: FixtureClaim): SourceArgs {
  return {
    sourceId: keccakBytes(c.name),
    paramsHash: getBytes(c.paramsHash),
    providerId: c.provider,
    sku: 0,
    kind: c.kind,
    gpuCount: c.gpuCount,
    valueMode: c.valueMode,
    requiresNullifier: c.requiresNullifier,
  };
}

/**
 * Well-known config authority for local-validator e2e scripts, so each run (and each script) can
 * update the same config. Public seed: never use it on devnet or mainnet.
 */
export const localE2eAuthority = (): Keypair => Keypair.fromSeed(getBytes(sha256(toUtf8Bytes("pct-local-e2e-authority"))));
