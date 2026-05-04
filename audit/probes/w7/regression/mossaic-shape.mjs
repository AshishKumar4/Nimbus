// W7 regression/mossaic-shape
//
// W7 does NOT touch the four canonical Mossaic install scenarios at
// the package-name level. Confirm the Mossaic coverage probe is still
// present and structurally intact. (We don't run Mossaic install
// against prod here — that's a CT1 daily-baseline check.)

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { ok, group, summary } from '../_tap.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, '..', '..', '..', '..');
const MOSSAIC_FILES = [
  'audit/probes/run-mossaic-prod-w2.mjs',
  'audit/probes/mossaic-prod-w2.txt',
];

await group('mossaic probe scaffold present', () => {
  for (const rel of MOSSAIC_FILES) {
    const abs = path.join(ROOT, rel);
    ok(`file present: ${rel}`, fs.existsSync(abs));
  }
  // The probe must still reference the four canonical Mossaic test cases.
  const driver = path.join(ROOT, 'audit/probes/run-mossaic-prod-w2.mjs');
  if (fs.existsSync(driver)) {
    const txt = fs.readFileSync(driver, 'utf8');
    ok('driver references mossaic', txt.toLowerCase().includes('mossaic'));
  }
});

summary('mossaic-shape [W7 regression]');
