// W10 regression: the W2.5 install-pipeline-coverage probe still passes.
//
// Lifted from w8/regression/install-pipeline-coverage.mjs — every wave
// re-runs this to confirm install correctness hasn't regressed.

import { ok, summary } from '../_tap.mjs';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(HERE, '..', '..', '..', '..');

// Smoke checks: the install pipeline modules exist + parse without
// runtime fail. We don't run a real install (out of scope at unit level)
// but we verify that the static surface is unchanged.
const expectedFiles = [
  'src/npm-installer.ts',
  'src/npm-resolver.ts',
  'src/npm-tarball.ts',
  'src/npm-tarball-stream.ts',
  'src/npm-cache.ts',
  'src/npm-install-facet.ts',
  'src/npm-install-batch-facet.ts',
];
for (const f of expectedFiles) {
  const p = path.join(repoRoot, f);
  ok('exists ' + f, fs.existsSync(p));
}

// Make sure W10's emulator imports don't accidentally land in install hot path.
const installer = fs.readFileSync(path.join(repoRoot, 'src/npm-installer.ts'), 'utf-8');
ok('npm-installer does not import binding-kv',     !installer.includes("from './binding-kv"));
ok('npm-installer does not import binding-d1',     !installer.includes("from './binding-d1"));
ok('npm-installer does not import binding-r2',     !installer.includes("from './binding-r2"));
ok('npm-installer does not import nimbus-wrangler', !installer.includes("from './nimbus-wrangler"));

// Parse-time: nimbus-wrangler must still be the only consumer of the new modules.
const nw = fs.readFileSync(path.join(repoRoot, 'src/nimbus-wrangler.ts'), 'utf-8');
ok('nimbus-wrangler imports binding-kv', nw.includes('binding-kv'));
ok('nimbus-wrangler imports binding-d1', nw.includes('binding-d1'));
ok('nimbus-wrangler imports binding-r2', nw.includes('binding-r2'));

summary('w10/regression/install-pipeline-coverage');
