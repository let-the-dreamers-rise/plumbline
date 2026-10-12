/**
 * Optional enrichment from https://app.usd.ai/loans, a server-rendered Next.js page whose RSC payload
 * carries each deal's location, offtake code, stage and collateral token ids. None of this is onchain.
 * The format is undocumented and can change without notice, so parsing is defensive: a deal that does
 * not match is skipped, and a page that yields nothing returns an empty list (the snapshot says so).
 */
export interface Enrichment {
  readonly documentId: string;
  readonly name: string | null;
  readonly borrower: string | null;
  readonly locationName: string | null;
  /** Offtake code as published by the app; its meaning is not documented. */
  readonly offTakeCode: number | null;
  readonly dealStatus: string | null;
  readonly tokenIds: readonly string[];
  readonly loanHash: string | null;
  /** All-in APR shown by the app, in percent. */
  readonly appAprPct: number | null;
}

const UUID = /"documentId":"([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})"/g;

const str = (seg: string, key: string): string | null => {
  const m = new RegExp(`"${key}":"([^"]{0,200})"`).exec(seg);
  return m ? m[1]! : null;
};
const numAt = (seg: string, key: string): number | null => {
  const m = new RegExp(`"${key}":(-?\\d+(?:\\.\\d+)?)`).exec(seg);
  return m ? Number(m[1]) : null;
};

/** Unescapes the RSC string (it is embedded as an escaped JS string inside <script> tags). */
export function unescapeRsc(html: string): string {
  return html.replace(/\\"/g, '"');
}

/**
 * Splits the payload at every `"documentId"` and reads fields from each segment. Detail entries carry
 * `tokenIdRange` and the onchain loan id; summary entries carry the app's APR. Both are merged by id.
 */
export function parseAppLoans(html: string): readonly Enrichment[] {
  const s = unescapeRsc(html);
  const starts = [...s.matchAll(UUID)].map((m) => ({ id: m[1]!, at: m.index! }));
  const segments = starts.map((x, i) => ({ id: x.id, seg: s.slice(x.at, starts[i + 1]?.at ?? Math.min(s.length, x.at + 20_000)) }));
  const details = segments.flatMap(({ id, seg }) => {
    const range = /"tokenIdRange":\["\$n(\d+)","\$n(\d+)"\]/.exec(seg);
    if (!range) return [];
    const from = Number(range[1]);
    const to = Number(range[2]);
    if (!(to >= from) || to - from > 1000) return [];
    const tokenIds = Array.from({ length: to - from + 1 }, (_, k) => String(from + k));
    const loan = /"loan":\{"id":"(0x[0-9a-f]{64})"/.exec(seg);
    const borrower = str(seg, "borrower");
    return [
      {
        documentId: id,
        name: str(seg, "name"),
        borrower: borrower && /^0x[0-9a-f]{40}$/i.test(borrower) ? borrower.toLowerCase() : null,
        locationName: str(seg, "locationName"),
        offTakeCode: numAt(seg, "offTake"),
        dealStatus: str(seg, "dealStatus"),
        tokenIds,
        loanHash: loan ? loan[1]! : null,
        appAprPct: null,
      },
    ];
  });
  // Summary entries (no tokenIdRange) have "stage" and "term" next to the app's APR.
  const aprById = new Map(
    segments.flatMap(({ id, seg }) =>
      !seg.includes('"tokenIdRange"') && /"stage":\d/.test(seg) && /"term":\d/.test(seg) ? [[id, numAt(seg, "apr")] as const] : [],
    ),
  );
  // One entry per document id: the first detail segment wins.
  const unique = details.filter((d, i) => details.findIndex((x) => x.documentId === d.documentId) === i);
  return unique.map((d) => ({ ...d, appAprPct: aprById.get(d.documentId) ?? null }));
}

/** The enrichment entry for a collateral token id, if any. */
export function enrichmentFor(list: readonly Enrichment[], tokenId: string): Enrichment | null {
  return list.find((e) => e.tokenIds.includes(tokenId)) ?? null;
}
