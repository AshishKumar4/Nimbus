#!/usr/bin/env bun
// audit/probes/regression/exports-set.mjs
//
// Static-analysis probe — does NOT need wrangler.
//
// Asserts: src/nimbus-session.ts (post-refactor: re-export hub) exports
// every name in EXPECTED_EXPORTS — directly or via re-export.
//
// Per audit/sections/SESSION-MAP.md §8 + plan §B.4 + plan §G.2:
//   - NimbusSession (the DO class)
//   - 6 W10 entrypoint classes (NimbusAssetsRPC, NimbusLoaderRPC,
//     NimbusLoadedWorker, NimbusLoadedEntrypoint,
//     NimbusDurableObjectNamespace, NimbusDOStub)
//   - detectCloudflareWorkersProject (re-export from project-detect.ts)
//
// External callers (src/index.ts, etc.) import from `./nimbus-session.js`.
// The refactor must preserve every named export.
//
// Exit 0 = all expected exports present. Exit 1 = missing export(s).

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, '..', '..', '..');
const SRC = path.join(ROOT, 'src', 'nimbus-session.ts');

const EXPECTED_EXPORTS = [
  'NimbusSession',
  'NimbusAssetsRPC',
  'NimbusLoaderRPC',
  'NimbusLoadedWorker',
  'NimbusLoadedEntrypoint',
  'NimbusDurableObjectNamespace',
  'NimbusDOStub',
  'detectCloudflareWorkersProject',
];

const src = fs.readFileSync(SRC, 'utf8');

const missing = [];
for (const name of EXPECTED_EXPORTS) {
  // Match either:
  //   export class <name>
  //   export function <name>
  //   export const <name>
  //   export { ..., <name>, ... } from '...'
  //   export { <name> } from '...'
  const escaped = name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const directPat = new RegExp(`^export\\s+(?:abstract\\s+)?(?:class|function|const|let|var|interface|type|async\\s+function)\\s+${escaped}\\b`, 'm');
  // Re-export patterns: export { ..., name, ... } or export { name as ... } from ...
  const reExportPat = new RegExp(`export\\s*\\{[^}]*\\b${escaped}\\b[^}]*\\}\\s*(from\\s+['"][^'"]+['"])?`, 'm');
  if (directPat.test(src) || reExportPat.test(src)) continue;
  missing.push(name);
}

console.log(`[exports-set] checked ${EXPECTED_EXPORTS.length} expected exports`);
console.log(`[exports-set] missing: ${missing.length}`);

if (missing.length > 0) {
  console.error(`[exports-set] FAIL — missing: ${missing.join(', ')}`);
  process.exit(1);
}
console.log('[exports-set] PASS');
process.exit(0);
