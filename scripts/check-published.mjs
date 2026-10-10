#!/usr/bin/env bun
// Standalone package integrity check, or the check of archives already
// prepared by publish-pack. Both compare the same npm-pack output to npm.
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { publishPackages } from './ci/lib/publish-packages.mjs';
import { prepareTarball, verifyPublishedTarballs } from './ci/lib/publish-tarballs.mjs';

const args = process.argv.slice(2);
if (args.length && (args.length !== 2 || args[0] !== '--prepared')) {
  console.error('usage: bun scripts/check-published.mjs [--prepared <archive manifest>]');
  process.exit(2);
}
const root = fileURLToPath(new URL('../', import.meta.url));
const work = args.length ? null : mkdtempSync(join(tmpdir(), 'nimbus-prepared-packages-'));
try {
  const prepared = work ? publishPackages(root).map(pkg => prepareTarball(pkg.dir, work))
    : JSON.parse(readFileSync(args[1], 'utf8'));
  await verifyPublishedTarballs(prepared);
} catch (error) {
  console.error(error.message);
  process.exitCode = 1;
} finally {
  if (work) rmSync(work, { recursive: true, force: true });
}
