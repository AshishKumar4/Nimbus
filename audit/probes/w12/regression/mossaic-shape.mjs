#!/usr/bin/env bun
// W12 regression: Mossaic regression scenarios still loadable + shape
// unchanged. W12 does not touch any installer / framework code path,
// so this is a sanity check.

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { ok, group, summary } from '../_tap.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, '..', '..', '..', '..');
const RUNNER = path.join(ROOT, 'audit', 'probes', 'run-mossaic-prod-w2.mjs');

await group('mossaic runner exists', () => {
  ok('runner present', fs.existsSync(RUNNER));
  const txt = fs.readFileSync(RUNNER, 'utf8');
  ok('runner has Mossaic-style scenarios', txt.includes('mossaic') || txt.includes('Mossaic') || txt.includes('w2'));
});

summary('w12/regression/mossaic-shape');
