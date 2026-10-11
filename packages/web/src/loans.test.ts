import { describe, expect, it } from "vitest";
import { Keypair, type Connection } from "@solana/web3.js";
import { loadLoan, loadLoans } from "./loans.js";

/** Just the RPC methods the loan reads touch, counting calls. */
function fakeRpc(endpoint: string) {
  const calls = { getProgramAccounts: 0, getAccountInfo: 0 };
  const connection = {
    rpcEndpoint: endpoint,
    getProgramAccounts: async () => (calls.getProgramAccounts++, []),
    getAccountInfo: async () => (calls.getAccountInfo++, null),
  } as unknown as Connection;
  return { connection, calls };
}

describe("loan reads are cached", () => {
  it("repeated /api/loans reads hit the RPC once per TTL", async () => {
    const { connection, calls } = fakeRpc(`http://rpc-${Math.random()}`);
    const programId = Keypair.generate().publicKey;
    expect(await loadLoans(connection, programId)).toEqual([]);
    expect(await loadLoans(connection, programId)).toEqual([]);
    await Promise.all([loadLoans(connection, programId), loadLoans(connection, programId)]);
    expect(calls.getProgramAccounts).toBe(1);
  });

  it("caches per address, including 'no loan here'", async () => {
    const { connection, calls } = fakeRpc(`http://rpc-${Math.random()}`);
    const programId = Keypair.generate().publicKey;
    const [a, b] = [Keypair.generate().publicKey, Keypair.generate().publicKey];
    expect(await loadLoan(connection, programId, a)).toBeNull();
    expect(await loadLoan(connection, programId, a)).toBeNull();
    expect(await loadLoan(connection, programId, b)).toBeNull();
    expect(calls.getAccountInfo).toBe(2);
  });
});
