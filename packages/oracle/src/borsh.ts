import { getBytes, sha256, toUtf8Bytes } from "ethers";

/** Minimal Borsh writer for the pct_oracle instruction arguments (little-endian, Vec/String u32-prefixed). */
export class Writer {
  private readonly parts: Uint8Array[] = [];

  u8(v: number): this {
    return this.int(v, 1);
  }
  u16(v: number): this {
    return this.int(v, 2);
  }
  u32(v: number): this {
    return this.int(v, 4);
  }
  i64(v: number | bigint): this {
    const b = new Uint8Array(8);
    new DataView(b.buffer).setBigInt64(0, BigInt(v), true);
    return this.raw(b);
  }
  bool(v: boolean): this {
    return this.u8(v ? 1 : 0);
  }
  fixed(bytes: Uint8Array, len: number): this {
    if (bytes.length !== len) throw new Error(`expected ${len} bytes, got ${bytes.length}`);
    return this.raw(bytes);
  }
  vec(bytes: Uint8Array): this {
    return this.u32(bytes.length).raw(bytes);
  }
  string(s: string): this {
    return this.vec(toUtf8Bytes(s));
  }
  raw(bytes: Uint8Array): this {
    this.parts.push(bytes);
    return this;
  }
  bytes(): Buffer {
    return Buffer.concat(this.parts);
  }

  private int(v: number, size: 1 | 2 | 4): this {
    if (!Number.isInteger(v) || v < 0 || v >= 2 ** (8 * size)) throw new Error(`${v} does not fit u${8 * size}`);
    const b = new Uint8Array(size);
    const view = new DataView(b.buffer);
    if (size === 1) view.setUint8(0, v);
    else if (size === 2) view.setUint16(0, v, true);
    else view.setUint32(0, v, true);
    return this.raw(b);
  }
}

/** Anchor's default 8-byte discriminator: sha256("<namespace>:<name>")[..8]. */
export function discriminator(namespace: "global" | "account" | "event", name: string): Uint8Array {
  return getBytes(sha256(toUtf8Bytes(`${namespace}:${name}`))).slice(0, 8);
}

/** Sequential little-endian reader for account data. */
export class Reader {
  private offset = 0;
  constructor(private readonly data: Uint8Array) {}

  u8(): number {
    return this.view(1).getUint8(0);
  }
  u16(): number {
    return this.view(2).getUint16(0, true);
  }
  u32(): number {
    return this.view(4).getUint32(0, true);
  }
  u64(): bigint {
    return this.view(8).getBigUint64(0, true);
  }
  i64(): bigint {
    return this.view(8).getBigInt64(0, true);
  }
  take(n: number): Uint8Array {
    if (this.offset + n > this.data.length) throw new Error("account data too short");
    const out = this.data.subarray(this.offset, this.offset + n);
    this.offset += n;
    return out;
  }

  private view(n: number): DataView {
    const b = this.take(n);
    return new DataView(b.buffer, b.byteOffset, n);
  }
}
