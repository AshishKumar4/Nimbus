#!/usr/bin/env bun
/**
 * X.5-peer-gap P3 — Confirm greedyAddMainEntries does NOT parse-and-recurse.
 *
 * Static evidence: read facet-manager.ts and quote the full
 * greedyAddMainEntries body, demonstrating that:
 *   - addOne() (lines 611-626) reads + adds to bundle but does NOT
 *     call any recursive walker.
 *   - addPkgEntry() (lines 644-728) walks main/module/exports + lands
 *     hash-chunks + shared/ subdir.
 *   - There is NO call to parseAndResolve / prefetchForRequire from
 *     within greedyAddMainEntries.
 *
 * Contrast with prefetchForRequire's addFile (require-resolver.ts:441-488)
 * which DOES call parseAndResolve(content, fromDir) on every added file.
 *
 * This documents the architectural gap: defu's main = lib/defu.cjs is
 * landed by greedyAddMainEntries WITHOUT recursing into its own
 * `require("../dist/defu.cjs")`, so dist/defu.cjs never enters the
 * bundle through the greedy pass.
 *
 * Read-only.
 */
import fs from 'fs';

const ROOT = '/workspace/worktrees/x5peer-gap';

function extract(file, startLine, endLine) {
  const src = fs.readFileSync(file, 'utf8').split('\n');
  return src.slice(startLine - 1, endLine).map((l, i) => `${startLine + i}: ${l}`).join('\n');
}

console.log('=== src/facet-manager.ts greedyAddMainEntries body ===');
console.log(extract(`${ROOT}/src/facet-manager.ts`, 598, 747));
console.log();

console.log('=== count parseAndResolve / prefetchForRequire references inside greedyAddMainEntries ===');
const fmgr = fs.readFileSync(`${ROOT}/src/facet-manager.ts`, 'utf8');
const greedyStart = fmgr.indexOf('export function greedyAddMainEntries');
const greedyEnd = fmgr.indexOf('\n}\n', greedyStart) + 2;
const greedyBody = fmgr.slice(greedyStart, greedyEnd);
const recurseRefs = (greedyBody.match(/parseAndResolve|prefetchForRequire/g) || []).length;
console.log(`  parseAndResolve / prefetchForRequire calls inside greedyAddMainEntries: ${recurseRefs}`);
console.log();

console.log('=== contrast: src/require-resolver.ts addFile DOES recurse ===');
console.log(extract(`${ROOT}/src/require-resolver.ts`, 441, 489));
console.log();

console.log('=== conclusion ===');
console.log('Greedy oversample lands ONE main entry per package without');
console.log('walking that entry\'s requires. For packages whose main field');
console.log('points at a thin shim (defu/lib/defu.cjs → ../dist/defu.cjs,');
console.log('a 278-byte re-export wrapper), the *real* implementation in');
console.log('dist/ is never added by the greedy pass. The require-walker');
console.log('only reaches dist/defu.cjs if the consumer\'s require chain');
console.log('CJS-traverses lib/defu.cjs first — which doesn\'t happen for');
console.log('nuxt because nuxt\'s ESM index does `import { defu } from \'defu\'`,');
console.log('which exports.import.default routes to dist/defu.mjs (ESM),');
console.log('not lib/defu.cjs (CJS shim).');
