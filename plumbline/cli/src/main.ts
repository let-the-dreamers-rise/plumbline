#!/usr/bin/env -S npx tsx
import { run } from "./cli.js";

run(process.argv.slice(2), {
  out: (s) => process.stdout.write(s + "\n"),
  err: (s) => process.stderr.write(s + "\n"),
}).then((code) => process.exit(code));
