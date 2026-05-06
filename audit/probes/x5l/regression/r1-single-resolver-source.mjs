// X.5-L regression probe — single-resolver invariant preserved.
//
// Re-asserts the X.5-F + X.5-C invariant: there is exactly ONE TS
// implementation of `resolveExports` / `resolvePackageEntry` in src/.
//
// X.5-L extends `resolvePkgSubpath` (a *different* helper that wraps
// resolvePackageEntry); this must not introduce a sibling resolver impl.
//
// Pre-fix and post-fix: PASS (the invariant must hold throughout).

import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { check, summary, reset } from '../_helpers.mjs';

reset();

console.log('X.5-L regression/r1-single-resolver-source — exactly one resolver impl');

const HERE = path.dirname(fileURLToPath(import.meta.url));
const SRC = path.resolve(HERE, '..', '..', '..', '..', 'src');

function walk(dir, hits) {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    if (e.isDirectory()) {
      if (e.name === 'node_modules' || e.name.startsWith('.')) continue;
      walk(path.join(dir, e.name), hits);
    } else if (e.isFile() && /\.(ts|js|mjs)$/.test(e.name)) {
      const text = fs.readFileSync(path.join(dir, e.name), 'utf8');
      const lines = text.split('\n');
      for (let i = 0; i < lines.length; i++) {
        const line = lines[i];
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
