#!/usr/bin/env bun
// X.5-NPQO regression: single-resolver invariant.
// Same probe as X.5-F/G/C/J/L/M waves: `function resolveExports` declared
// exactly once across src/ (in _shared/exports-resolver.ts). Catches any
// accidental fork of the resolver during shim-region edits.

import { ok, summary } from '../../w6/_tap.mjs';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const SRC = path.resolve(HERE, '..', '..', '..', '..', 'src');

function walk(dir, out) {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) walk(p, out);
    else if (/\.(ts|js|mjs|cjs)$/.test(e.name)) out.push(p);
  }
}

const files = [];
walk(SRC, files);

const declarations = [];
for (const f of files) {
  const src = fs.readFileSync(f, 'utf8');
  const re = /^\s*(?:export\s+)?function\s+resolveExports\s*\(/gm;
  let m;
  while ((m = re.exec(src)) !== null) {
    const before = src.slice(0, m.index);
    const tickCount = (before.match(/(?<!\\)`/g) || []).length;
    if (tickCount % 2 === 1) continue;  // inside template literal
    declarations.push({ file: path.relative(SRC, f), line: before.split('\n').length });
  }
}

console.log('# resolveExports declarations:', declarations.length);
for (const d of declarations) console.log('#   - ' + d.file + ':' + d.line);

ok('resolveExports declared exactly once',
  declarations.length === 1,
  declarations.length === 0
    ? 'NO declarations (regression)'
    : declarations.length > 1 ? 'MULTIPLE declarations (regression)' : '');
if (declarations.length === 1) {
  ok('declaration is in _shared/exports-resolver.ts',
    declarations[0].file === '_shared/exports-resolver.ts');
}

summary('npqo-single-resolver-source');
