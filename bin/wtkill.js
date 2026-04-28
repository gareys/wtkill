#!/usr/bin/env node
import { main } from '../src/cli.js';
main(process.argv.slice(2)).catch((err) => {
  const msg = err && err.userFacing ? err.message : (err?.stack || String(err));
  process.stderr.write(`wtkill: ${msg}\n`);
  process.exit(err?.exitCode || 1);
});
