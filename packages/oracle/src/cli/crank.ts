import { clientFromEnv } from "../env.js";
import { programError } from "../client.js";
import { KIND_IDS, SKU_IDS } from "../program.js";

// Recomputes every initialized book onchain (permissionless) and prints the index.
const client = clientFromEnv();
for (const [sku, skuId] of Object.entries(SKU_IDS)) {
  for (const [kind, kindId] of Object.entries(KIND_IDS)) {
    if (!(await client.book(skuId, kindId))) continue;
    try {
      const r = await client.crank(skuId, kindId);
      const b = (await client.book(skuId, kindId))!;
      const value = b.status === "live" ? `$${Number(b.valueMicro) / 1e6}` : "-";
      console.log(`${sku} ${kind}: ${b.status} ${value}  used=${b.used} rejected=${b.rejected} obs=${b.len}  ${r.computeUnits ?? "?"} CU`);
    } catch (err) {
      console.log(`${sku} ${kind}: crank failed: ${programError(err)}`);
    }
  }
}
