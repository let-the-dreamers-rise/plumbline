import { GPUS_PER_UNIT, type GpuModel } from "./constants.js";

/**
 * USD.AI collateral metadata: `tokenURI(id)` on the Tokenized Hardware NFT points at
 * https://metadata.usd.ai/v1/{id}, a public JSON with the GPU model and server count in its name
 * ("B300 [130]") and "Collateral Value USD", "Useful Life (days)" and "Quantity" attributes.
 */
export interface CollateralComponent {
  readonly model: GpuModel | null;
  /** The name as written, e.g. "DGX B300". */
  readonly label: string;
  /** Collateral units (servers, or racks for GB200 NVL72). */
  readonly units: number;
  readonly gpus: number | null;
}

export interface Collateral {
  readonly tokenId: string;
  readonly metadataUrl: string;
  readonly name: string;
  readonly components: readonly CollateralComponent[];
  readonly units: number | null;
  readonly gpuCount: number | null;
  readonly valueUsd: number | null;
  readonly usefulLifeDays: number | null;
  readonly manufacturer: string | null;
}

/** Maps a hardware label from any source (metadata, app, price feeds) to a monitor model, or null. */
export function normalizeModel(label: string): GpuModel | null {
  const s = label.toUpperCase();
  if (/GB200/.test(s)) return "GB200";
  if (/B300/.test(s)) return "B300";
  if (/B200/.test(s)) return "B200";
  if (/H200/.test(s)) return "H200";
  if (/H100/.test(s)) return "H100";
  if (/PRO\s*6000|PRO6000|6000\s*PRO/.test(s)) return "RTX PRO 6000";
  return null;
}

/** "B300 [9] / RTX PRO 6000 [18]" to components; a name without brackets yields none. */
export function parseName(name: string): readonly CollateralComponent[] {
  return [...name.matchAll(/([A-Za-z0-9][A-Za-z0-9 .-]*?)\s*\[(\d+)\]/g)].map((m) => {
    const label = m[1]!.trim();
    const units = Number(m[2]);
    const model = normalizeModel(label);
    const per = model ? GPUS_PER_UNIT[model] : undefined;
    return { model, label, units, gpus: per ? units * per : null };
  });
}

function attribute(json: unknown, trait: string): unknown {
  const attrs = (json as { attributes?: unknown }).attributes;
  if (!Array.isArray(attrs)) return undefined;
  const hit = attrs.find((a) => a && typeof a === "object" && (a as { trait_type?: unknown }).trait_type === trait);
  return hit ? (hit as { value?: unknown }).value : undefined;
}

const num = (v: unknown): number | null => (typeof v === "number" && Number.isFinite(v) ? v : typeof v === "string" && v.trim() && Number.isFinite(Number(v)) ? Number(v) : null);

/** A single-model portfolio name with a Quantity attribute: trust the attribute for the unit count. */
function fromBrackets(parsed: readonly CollateralComponent[], quantity: number | null): readonly CollateralComponent[] {
  if (parsed.length !== 1 || quantity === null) return parsed;
  const only = parsed[0]!;
  return [{ ...only, units: quantity, gpus: only.model ? quantity * GPUS_PER_UNIT[only.model]! : null }];
}

/**
 * A per-unit token ("Nvidia H200 x8 Server", "Supermicro B200 8-GPU Server 10.5.0.10"). A name with no
 * GPU model is non-GPU collateral (network, racks), which adds value but no GPUs.
 */
function single(name: string, units: number): CollateralComponent {
  const model = normalizeModel(name);
  return { model, label: name, units, gpus: model ? units * GPUS_PER_UNIT[model]! : 0 };
}

/** One line for a list of collateral tokens: "18 x Supermicro NVIDIA RTX 6000 Pro Server, 9 x ...". */
export function describe(items: readonly Collateral[]): string {
  if (items.length === 1) return items[0]!.name;
  // Per-server names often end in a host address ("... Server 10.5.0.10"): group without it.
  const base = (name: string) => name.replace(/\s+\d+(?:\.\d+){1,3}$/, "");
  const labels = [...new Set(items.map((c) => base(c.name)))];
  return labels.map((l) => `${items.filter((c) => base(c.name) === l).length} x ${l}`).join(", ");
}

/** Parses one metadata document. Throws if it is not an object with a string name. */
export function parseCollateral(tokenId: string, metadataUrl: string, json: unknown): Collateral {
  if (!json || typeof json !== "object" || typeof (json as { name?: unknown }).name !== "string") {
    throw new Error(`metadata for token ${tokenId} has no name`);
  }
  const name = (json as { name: string }).name;
  const quantity = num(attribute(json, "Quantity"));
  const parsed = parseName(name);
  const components = parsed.length ? fromBrackets(parsed, quantity) : [single(name, quantity ?? 1)];
  const gpuCount = components.length > 0 && components.every((c) => c.gpus !== null) ? components.reduce((s, c) => s + c.gpus!, 0) : null;
  const manufacturer = attribute(json, "Manufacturer");
  return {
    tokenId,
    metadataUrl,
    name,
    components,
    units: quantity ?? (components.length ? components.reduce((s, c) => s + c.units, 0) : null),
    gpuCount,
    valueUsd: num(attribute(json, "Collateral Value USD")),
    usefulLifeDays: num(attribute(json, "Useful Life (days)")),
    manufacturer: typeof manufacturer === "string" ? manufacturer : null,
  };
}
