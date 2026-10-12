import { AKASH_URL, MODELS, RUNPOD_URL, VAST_URL, type GpuModel } from "./constants.js";
import { normalizeModel } from "./collateral.js";
import { median, round } from "./finance.js";

/**
 * Public GPU rental prices without an API key: Vast.ai live offers, RunPod's GraphQL list prices and
 * Akash's console price summary. Parsers are pure; each returns quotes in $/GPU-hour.
 */
export type PriceSourceName = "vast.ai" | "runpod" | "akash";

export interface Quote {
  readonly model: GpuModel;
  readonly usdPerGpuHr: number;
  /** What the quote is: an offer id, a list price tier, or a summary statistic. */
  readonly detail: string;
}

export interface SourceMedian {
  readonly source: PriceSourceName;
  readonly url: string;
  readonly medianUsdPerGpuHr: number;
  readonly quotes: number;
}

export interface ModelPrice {
  /** Median of the per-source medians, so one source with many offers does not outvote the others. */
  readonly medianUsdPerGpuHr: number | null;
  readonly sources: readonly SourceMedian[];
}

export interface PriceArchive {
  readonly schema: "plumbline.gpu-prices/v1";
  readonly date: string;
  readonly fetchedAt: string;
  readonly method: string;
  readonly models: Readonly<Record<GpuModel, ModelPrice>>;
  readonly errors: readonly string[];
}

export const PRICE_METHOD =
  "Per model, each source's median $/GPU-hr (Vast.ai: every verified on-demand offer, bundle price / GPUs; RunPod: secure and " +
  "community list prices; Akash: the console's median), then the median across sources. H100 and H200 are SXM; RTX PRO 6000 is " +
  "the Server Edition. NVL, PCIe, MIG and workstation variants are left out.";

const positive = (x: unknown): x is number => typeof x === "number" && Number.isFinite(x) && x > 0;

/** Vast GPU names that match the hardware in the loans (SXM and server parts). */
const VAST_NAMES: Readonly<Record<string, GpuModel>> = {
  "H100 SXM": "H100",
  H200: "H200",
  B200: "B200",
  B300: "B300",
  GB200: "GB200",
  "RTX PRO 6000 S": "RTX PRO 6000",
};
export const VAST_QUERY = {
  verified: { eq: true },
  rentable: { eq: true },
  gpu_name: { in: Object.keys(VAST_NAMES) },
  type: "on-demand",
  limit: 1000,
};

export function parseVast(json: unknown): readonly Quote[] {
  const offers = (json as { offers?: unknown })?.offers;
  if (!Array.isArray(offers)) throw new Error("vast.ai: response has no offers array");
  return offers.flatMap((o) => {
    const model = VAST_NAMES[String(o?.gpu_name)];
    const n = Number(o?.num_gpus);
    const total = Number(o?.dph_total);
    const each = total / n;
    return model && n > 0 && positive(each) ? [{ model, usdPerGpuHr: each, detail: `offer ${o.id}` }] : [];
  });
}

export const RUNPOD_QUERY = "{ gpuTypes { id displayName securePrice communityPrice } }";
const RUNPOD_IDS: Readonly<Record<string, GpuModel>> = {
  "NVIDIA H100 80GB HBM3": "H100",
  "NVIDIA H200": "H200",
  "NVIDIA B200": "B200",
  "NVIDIA B300 SXM6 AC": "B300",
  "NVIDIA GB200": "GB200",
  "NVIDIA RTX PRO 6000 Blackwell Server Edition": "RTX PRO 6000",
};

export function parseRunpod(json: unknown): readonly Quote[] {
  const types = (json as { data?: { gpuTypes?: unknown } })?.data?.gpuTypes;
  if (!Array.isArray(types)) throw new Error("runpod: response has no data.gpuTypes array");
  return types.flatMap((t) => {
    const model = RUNPOD_IDS[String(t?.id)];
    if (!model) return [];
    return (["securePrice", "communityPrice"] as const).flatMap((k) => (positive(t[k]) ? [{ model, usdPerGpuHr: t[k] as number, detail: `${t.id} ${k}` }] : []));
  });
}

/** Akash model ids are lower-case (h100, b200, pro6000se); the workstation edition is left out. */
export function parseAkash(json: unknown): readonly Quote[] {
  const models = (json as { models?: unknown })?.models;
  if (!Array.isArray(models)) throw new Error("akash: response has no models array");
  return models.flatMap((m) => {
    const name = String(m?.model ?? "");
    const workstation = /pro6000we/i.test(name);
    const pcie = /pcie/i.test(String(m?.interface ?? "")) && !/pro6000se/i.test(name);
    const nvl = /nvl/i.test(name) && !/gb200/i.test(name);
    if (m?.vendor !== "nvidia" || workstation || pcie || nvl) return [];
    const model = normalizeModel(name);
    const med = m?.price?.med;
    return model && positive(med) ? [{ model, usdPerGpuHr: med, detail: `${name} ${m.interface ?? ""} median`.trim() }] : [];
  });
}

export const SOURCE_URLS: Readonly<Record<PriceSourceName, string>> = { "vast.ai": VAST_URL, runpod: RUNPOD_URL, akash: AKASH_URL };

/** Combines quotes per source into per-model medians. */
export function summarize(bySource: Readonly<Partial<Record<PriceSourceName, readonly Quote[]>>>): Readonly<Record<GpuModel, ModelPrice>> {
  const entries = MODELS.map((model) => {
    const sources = (Object.entries(bySource) as [PriceSourceName, readonly Quote[]][]).flatMap(([source, quotes]) => {
      const xs = quotes.filter((q) => q.model === model).map((q) => q.usdPerGpuHr);
      const m = median(xs);
      return m === null ? [] : [{ source, url: SOURCE_URLS[source], medianUsdPerGpuHr: round(m, 4), quotes: xs.length }];
    });
    const m = median(sources.map((s) => s.medianUsdPerGpuHr));
    return [model, { medianUsdPerGpuHr: m === null ? null : round(m, 4), sources }] as const;
  });
  return Object.fromEntries(entries) as unknown as Record<GpuModel, ModelPrice>;
}

export function buildArchive(
  bySource: Readonly<Partial<Record<PriceSourceName, readonly Quote[]>>>,
  fetchedAt: Date,
  errors: readonly string[],
): PriceArchive {
  return {
    schema: "plumbline.gpu-prices/v1",
    date: fetchedAt.toISOString().slice(0, 10),
    fetchedAt: fetchedAt.toISOString(),
    method: PRICE_METHOD,
    models: summarize(bySource),
    errors,
  };
}
