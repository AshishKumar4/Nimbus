// W11 regression: prior wave probes (W3-W9) still discoverable + invokable.
// W11 must not delete or rename anything from the earlier wave probe trees.

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { ok, group, summary } from '../_tap.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const PROBE_ROOT = path.resolve(HERE, '..', '..');

const expectedRunners = [
  'w3/run-all.mjs',
  'w4/run-all.mjs',
  'w5/run-all.mjs',
  'w6/run-all.mjs',
  'w8/run-all.mjs',
  'w9/run-all.mjs',
];

await group('prior-wave probe runners present', () => {
  for (const r of expectedRunners) {
    ok(`${r} exists`, fs.existsSync(path.join(PROBE_ROOT, r)));
  }
});

await summary('w11/regression/w3-w9-probe-presence');
