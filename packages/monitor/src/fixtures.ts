import { readFileSync } from "node:fs";

/** Reads a recorded fixture from packages/monitor/fixtures (tests only; never the network). */
export function fixture(name: string): string {
  return readFileSync(new URL(`../fixtures/${name}`, import.meta.url), "utf8");
}

export const fixtureJson = <T = unknown>(name: string): T => JSON.parse(fixture(name)) as T;
