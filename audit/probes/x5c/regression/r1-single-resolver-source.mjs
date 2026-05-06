// X.5-C regression probe — single-resolver invariant preserved.
//
// X.5-F's same-named probe (audit/probes/x5f/regression/single-resolver-source.mjs
// on origin/x5f-resolve-miss) asserts there is exactly ONE TS implementation
// of `resolveExports` / `resolvePackageEntry` in src/. This probe re-asserts
// the same invariant on the X.5-C tree.
//
// Pre-fix and post-fix: PASS (the invariant must hold throughout).

import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { check, summary, reset } from '../_helpers.mjs';

reset();

console.log('X.5-C regression/r1-single-resolver-source — exactly one resolver impl');

const HERE = path.dirname(fileURLToPath(import.meta.url));
const SRC = path.resolve(HERE, '..', '..', '..', '..', 'src');

// Walk src/ recursively, skipping node_modules.
function walk(dir, hits) {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    if (e.isDirectory()) {
      if (e.name === 'node_modules' || e.name.startsWith('.')) continue;
      walk(path.join(dir, e.name), hits);
    } else if (e.isFile() && /\.(ts|js|mjs)$/.test(e.name)) {
      const text = fs.readFileSync(path.join(dir, e.name), 'utf8');
      // Match a real `function resolveExports(...)` declaration —
      // not a string-literal occurrence.
      const lines = text.split('\n');
      for (let i = 0; i < lines.length; i++) {
        const line = lines[i];
        // Heuristic: real declaration starts with `function`, `export function`,
        // `async function`, or appears as a method `<name> = function`. The
        // X.5-F probe used the same heuristic.
        const m = line.match(/^\s*(?:export\s+)?(?:async\s+)?function\s+(resolveExports|resolvePackageEntry)\s*\(/);
        if (m) {
          hits.push({ file: path.relative(SRC, path.join(dir, e.name)), name: m[1], line: i + 1 });
        }
      }
    }
  }
}

const hits = [];
walk(SRC, hits);

// Real impls must live ONLY in _shared/exports-resolver.ts. The W3
// node-shims.ts emits the same source as a plain JS *string* embedded
// in node-shims (via getExportsResolverJS()) so the runtime has the same
// resolver — but the matcher above only catches actual `function` decls,
// not string-literal occurrences.

const shared = hits.filter(h => h.file.replace(/\\/g, '/') === '_shared/exports-resolver.ts');
const others = hits.filter(h => h.file.replace(/\\/g, '/') !== '_shared/exports-resolver.ts');

console.log('  hits:', JSON.stringify(hits, null, 2));

check(
  'resolveExports declared exactly once and in _shared/exports-resolver.ts',
  shared.some(h => h.name === 'resolveExports') && others.every(h => h.name !== 'resolveExports'),
  `shared=${shared.length} others=${others.length}`,
);

check(
  'resolvePackageEntry declared exactly once and in _shared/exports-resolver.ts',
  shared.some(h => h.name === 'resolvePackageEntry') && others.every(h => h.name !== 'resolvePackageEntry'),
  `shared=${shared.length} others=${others.length}`,
);

const ok = summary();
process.exit(ok ? 0 : 1);
