const PRICE_KEY = /price|amount|cost|rate|hour|total|gpu|instance|type|desc|sku|quantity|usage|period|date|currency/i;

/**
 * Summarizes a JSON response for picking match regexes without leaking identity: values under
 * price-like keys are shown, every other string is masked to its length.
 */
export function describeShape(value: unknown, key = "", depth = 0, maxDepth = 6): string[] {
  const pad = "  ".repeat(depth);
  const label = key ? `${key}: ` : "";
  if (depth > maxDepth) return [`${pad}${label}...`];
  if (Array.isArray(value)) {
    const head = `${pad}${label}[${value.length} items]`;
    return value.length === 0 ? [head] : [head, ...describeShape(value[0], "[0]", depth + 1, maxDepth)];
  }
  if (value !== null && typeof value === "object") {
    const lines = Object.entries(value).flatMap(([k, v]) => describeShape(v, k, depth + 1, maxDepth));
    return [`${pad}${label}{`, ...lines, `${pad}}`];
  }
  if (typeof value === "string") {
    return [`${pad}${label}${PRICE_KEY.test(key) ? JSON.stringify(value) : `<string len ${value.length}>`}`];
  }
  return [`${pad}${label}${PRICE_KEY.test(key) ? String(value) : `<${typeof value}>`}`];
}
