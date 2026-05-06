#!/usr/bin/env bun
// X.5-R regression — single-resolver-source invariant (W2.6a → X5F → X5J → X5L → X5NPQO).
//
// Wraps the X.5-NPQO regression form (the most recent of the chain).
// The X.5-R wave touches no resolver code, so this must hold by
// construction; this probe is a forward-looking guard against future
// X.5-R-class buckets accidentally forking the resolver.

import { ok, summary } from '../../w6/_tap.mjs';
import { spawnSync } from 'child_process';
import path from 'path';
import { fileURLToPath } from 'url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, '../../../..');

function runProbe(rel) {
  const p = path.join(ROOT, rel);
  const r = spawnSync('bun', [p], { encoding: 'utf8' });
  return { code: r.status, stdout: r.stdout || '', stderr: r.stderr || '' };
}

const probes = [
  'audit/probes/x5f/regression/single-resolver-source.mjs',
  'audit/probes/x5j/regression/single-resolver-source.mjs',
  'audit/probes/x5npqo/regression/single-resolver-source.mjs',
];

for (const p of probes) {
  const r = runProbe(p);
  ok(`${p} exits 0`, r.code === 0,
    r.code === 0 ? '' : `code=${r.code}\nstdout:\n${r.stdout.slice(-1500)}\nstderr:\n${r.stderr.slice(-1500)}`);
}

summary('r-single-resolver-source');
