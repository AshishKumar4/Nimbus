#!/usr/bin/env bun
// X5M regression: single-resolver invariant — `function resolveExports` declared
// exactly once across src/ (in _shared/exports-resolver.ts). Same probe pattern
// as X.5-F/G/C waves.

import { ok, eq, summary } from '../../w6/_tap.mjs';
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

// Find files containing `function resolveExports` declarations (NOT string-literal/
// template-literal mentions). The X.5-F retro pattern handled real-vite bundle stub
// (string literal); here we also need to handle template-literal forms which are
// JS-source-of-runner-template returned by getExportsResolverJS() — that's a
// generated artefact, not a competing declaration.
const declarations = [];
for (const f of files) {
  const src = fs.readFileSync(f, 'utf8');
  const re = /^\s*(?:export\s+)?function\s+resolveExports\s*\(/gm;
  let m;
  while ((m = re.exec(src)) !== null) {
    // Determine if this match sits inside a template literal: count unescaped
    // backticks before the match offset; odd ⇒ inside template.
    const before = src.slice(0, m.index);
    const tickCount = (before.match(/(?<!\\)`/g) || []).length;
    if (tickCount % 2 === 1) continue;  // inside template literal
    declarations.push({ file: path.relative(SRC, f), line: before.split('\n').length });
  }
}

console.log('# resolveExports declarations:', declarations.length);
for (const d of declarations) console.log('#   - ' + d.file + ':' + d.line);

ok('resolveExports declared exactly once', declarations.length === 1,
  declarations.length === 0
    ? 'NO declarations (regression: should be in _shared/exports-resolver.ts)'
    : declarations.length > 1 ? 'MULTIPLE declarations (regression)' : '');
if (declarations.length === 1) {
  ok('declaration is in _shared/exports-resolver.ts',
    declarations[0].file === '_shared/exports-resolver.ts');
}

summary('single-resolver-source');
