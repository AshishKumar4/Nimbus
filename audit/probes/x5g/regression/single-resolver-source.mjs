#!/usr/bin/env bun
// X5G regression: exactly ONE TS file declares `function resolveExports`.
//
// Mirrors the X5F invariant from audit/probes/x5f/regression/
// single-resolver-source.mjs. X5G must not introduce a 2nd resolver.

import { ok, group, summary } from '../../w6/_tap.mjs';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const SRC = path.join(HERE, '../../../../src');

function walk(dir, out = []) {
  for (const ent of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, ent.name);
    if (ent.isDirectory()) walk(p, out);
    else out.push(p);
  }
  return out;
}

const tsFiles = walk(SRC).filter(p => p.endsWith('.ts'));
const realImpls = [];
const stringMentions = [];

for (const f of tsFiles) {
  const txt = fs.readFileSync(f, 'utf8');
  if (/\bfunction\s+resolveExports\b/.test(txt) && !f.endsWith('.generated.ts')) {
    realImpls.push(path.relative(path.join(HERE, '../../../..'), f));
  }
  if (/resolveExports/.test(txt) && f.endsWith('.generated.ts')) {
    stringMentions.push(path.relative(path.join(HERE, '../../../..'), f));
  }
}

group('exactly one TS impl', () => {
  ok(`real TS impls: ${JSON.stringify(realImpls)}`, realImpls.length === 1);
  if (realImpls.length === 1) {
    ok('impl is _shared/exports-resolver.ts',
      realImpls[0].endsWith('_shared/exports-resolver.ts'));
  }
});

group('generated-file mentions are string-literal artefacts', () => {
  // Just informational — they're embedded vite/react bundles.
  ok(`${stringMentions.length} generated-file mentions (informational)`, true);
});

summary('single-resolver-source');
