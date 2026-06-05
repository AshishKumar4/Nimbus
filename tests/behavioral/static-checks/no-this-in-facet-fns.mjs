#!/usr/bin/env bun
// static-checks/no-this-in-facet-fns — static guard against `\bthis\b`
// regressions in facet-bound functions.
//
// Workerd's loader-pool serializes worker fns via fn.toString() and
// rejects sources containing `\bthis\b` (no late binding in remote
// isolates). The regression has appeared 3 times in python-repl.ts
// (see repl-r7/regression/no-this-in-facet-fn.mjs for history).
//
// This probe is a fast, deploy-free, source-level check. It does NOT
// hit prod (so BASE is optional). It reads facet-bound function
// bodies from disk and asserts no bare `this` token appears.
//
// Coverage:
//   - src/runtime/python-repl.ts  →  replStepFacetFn
//   - src/runtime/ruby-repl.ts    →  replStepFacetFn (if defined)
//   - src/runtime/bun-repl.ts     →  replStepFacetFn (if defined)
//   - src/runtime/node-repl.ts    →  replStepFacetFn (if defined)
//
// If you add a new facet-bound function elsewhere, add it to TARGETS.

import { readFileSync, existsSync } from 'fs';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const REPO = join(__dirname, '..', '..', '..');

const TARGETS = [
  // path, fn-name(s) — facet-bound fns serialized via fn.toString()
  // by src/loaders/loader-pool.ts and run in a remote isolate where
  // late-binding `this` is unavailable.
  { path: 'src/runtime/python-repl.ts', fns: ['replStepFacetFn'] },
  { path: 'src/runtime/ruby-repl.ts', fns: ['rubyReplStepFacetFn'] },
  { path: 'src/runtime/bun-repl.ts', fns: ['bunReplStepFacetFn'] },
  { path: 'src/runtime/node-repl.ts', fns: ['nodeReplStepFacetFn'] },
];

/**
 * Extract a top-level function body by name from a source file.
 * Returns the slice of source from `function NAME(` through the
 * matching `}\n` at column 0. If the fn doesn't exist, returns null.
 *
 * Crude but reliable: relies on the project's consistent formatting
 * (top-level fn declarations close with `}` at column 0).
 */
function extractFnBody(source, fnName) {
  const startRe = new RegExp(`^function\\s+${fnName}\\s*\\(`, 'm');
  const startMatch = startRe.exec(source);
  if (!startMatch) return null;
  const start = startMatch.index;
  // Find the next `}\n` at column 0 after the fn signature.
  const closeRe = /^}\s*$/m;
  closeRe.lastIndex = start + startMatch[0].length;
  const closeMatch = closeRe.exec(source.slice(start + startMatch[0].length));
  if (!closeMatch) return source.slice(start);  // open-ended — return rest
  const end = start + startMatch[0].length + closeMatch.index + closeMatch[0].length;
  return source.slice(start, end);
}

let pass = 0;
let fail = 0;
const failures = [];

console.log(`static-checks/no-this-in-facet-fns`);

for (const tgt of TARGETS) {
  const fullPath = join(REPO, tgt.path);
  if (!existsSync(fullPath)) {
    console.log(`  - ${tgt.path}: not present (skipped)`);
    continue;
  }
  const src = readFileSync(fullPath, 'utf-8');
  for (const fnName of tgt.fns) {
    const body = extractFnBody(src, fnName);
    if (body === null) {
      console.log(`  - ${tgt.path}::${fnName}: not defined (skipped)`);
      continue;
    }
    // Find any bare `this` token. Use word boundary.
    const matches = [];
    const re = /\bthis\b/g;
    let m;
    while ((m = re.exec(body)) !== null) {
      // Compute line number for diagnostics.
      const upTo = body.slice(0, m.index);
      const lineInBody = upTo.split('\n').length;
      const bodyStartLine = src.slice(0, src.indexOf(body)).split('\n').length;
      const fileLine = bodyStartLine + lineInBody - 1;
      const lineSrc = src.split('\n')[fileLine - 1] || '';
      matches.push({ fileLine, lineSrc: lineSrc.trim().slice(0, 120) });
    }
    if (matches.length === 0) {
      console.log(`  \u2713 ${tgt.path}::${fnName} — no bare \`this\` token`);
      pass++;
    } else {
      console.log(`  \u2717 ${tgt.path}::${fnName} — ${matches.length} bare \`this\` token(s):`);
      for (const m of matches) {
        console.log(`      line ${m.fileLine}: ${m.lineSrc}`);
      }
      fail++;
      failures.push({ target: `${tgt.path}::${fnName}`, matches });
    }
  }
}

console.log(`\n  \u2500\u2500\u2500\u2500 [static-checks/no-this-in-facet-fns] ${pass} pass / ${fail} fail`);

process.exit(fail > 0 ? 1 : 0);
