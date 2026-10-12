// Where the program IDLs come from: the Anchor workspace in plumbline/programs (committed under
// programs/target/idl). PLUMBLINE_IDL_DIR overrides the directory.
import * as fs from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
export const BUILT_IDL_DIR = path.resolve(here, "../../../programs/target/idl");
export const IDL_FILES = { registry: "plumbline_registry.json", bounty: "plumbline_bounty.json" } as const;

export type IdlSet = { registry: any; bounty: any; source: { registry: string; bounty: string } };

export function loadIdls(dir = process.env.PLUMBLINE_IDL_DIR ?? BUILT_IDL_DIR): IdlSet {
  const read = (k: keyof typeof IDL_FILES) => {
    const p = path.join(dir, IDL_FILES[k]);
    if (!fs.existsSync(p)) throw new Error(`missing ${p}: build plumbline/programs (anchor build) or set PLUMBLINE_IDL_DIR`);
    return p;
  };
  const r = read("registry"), b = read("bounty");
  return { registry: JSON.parse(fs.readFileSync(r, "utf8")), bounty: JSON.parse(fs.readFileSync(b, "utf8")), source: { registry: r, bounty: b } };
}
