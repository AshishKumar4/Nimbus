#!/usr/bin/env bun
// audit/probes/regression/init-cmd-set.mjs
//
// Static-analysis probe — does NOT need wrangler.
//
// Asserts: src/nimbus-session.ts (or src/nimbus-session-init.ts post-S6)
// contains a `registry.register('<name>', ...)` call for every cmd in
// EXPECTED_CMDS. Catches accidental drop of a shell command during the
// initSession extraction (S6).
//
// Exit 0 = all expected cmds registered. Exit 1 = missing cmd(s).

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, '..', '..', '..');

// Per audit/sections/SESSION-MAP.md §5.9 + plan §VI.13:
const EXPECTED_CMDS = [
  'node', 'curl', 'df', 'esbuild', 'vite',
  'nimbus-wrangler', 'wrangler', 'npm-fast', 'npm', 'npx',
  'ps', 'logs', 'jobs', 'kill', 'top', 'watch', 'help',
];

const candidates = [
  path.join(ROOT, 'src', 'nimbus-session.ts'),
  path.join(ROOT, 'src', 'nimbus-session-init.ts'),
];

const sources = candidates
  .filter((p) => fs.existsSync(p))
  .map((p) => fs.readFileSync(p, 'utf8'))
  .join('\n');

const missing = [];
for (const cmd of EXPECTED_CMDS) {
  // Match: registry.register('cmd', or registry.register("cmd",
  const pat = new RegExp(`registry\\.register\\(\\s*['"]${cmd}['"]`);
  if (!pat.test(sources)) missing.push(cmd);
}

console.log(`[init-cmd-set] checked ${EXPECTED_CMDS.length} expected commands`);
console.log(`[init-cmd-set] missing: ${missing.length}`);

if (missing.length > 0) {
  console.error(`[init-cmd-set] FAIL — missing: ${missing.join(', ')}`);
  process.exit(1);
}
console.log('[init-cmd-set] PASS');
process.exit(0);
