#!/usr/bin/env bun
// The vendored Tailwind Play bundle (packages/worker/scripts/
// bundle-tailwind-play.mjs): a plain run regenerates the loader from the
// committed bundle without the network, and refuses bytes that are not the
// pinned digest. Run as a copy in a scratch tree, with fetch replaced by one
// that fails, so a run that reaches for the CDN fails.

import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const worker = new URL('../../packages/worker/', import.meta.url).pathname;
const offline = 'data:text/javascript,globalThis.fetch = () => { throw new Error("the network was used"); };';

/** Run the script in a scratch worker tree whose committed bundle is `bundle`: its exit, output and generated loader. */
function regenerate(bundle) {
  const root = mkdtempSync(join(tmpdir(), 'tailwind-play-'));
  try {
    for (const dir of ['scripts', 'src', 'public/_assets']) mkdirSync(join(root, dir), { recursive: true });
    copyFileSync(join(worker, 'scripts/bundle-tailwind-play.mjs'), join(root, 'scripts/bundle-tailwind-play.mjs'));
    writeFileSync(join(root, 'public/_assets/tailwind-play.js'), bundle);
    const run = spawnSync('node', ['--import', offline, join(root, 'scripts/bundle-tailwind-play.mjs')], { encoding: 'utf8' });
    let loader = null;
    try { loader = readFileSync(join(root, 'src/tailwind-play.generated.ts'), 'utf8'); } catch { /* not written */ }
    return { status: run.status, output: run.stdout + run.stderr, loader, bundle: readFileSync(join(root, 'public/_assets/tailwind-play.js')) };
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

const committed = readFileSync(join(worker, 'public/_assets/tailwind-play.js'));
const regenerated = regenerate(committed);
assert.equal(regenerated.status, 0, regenerated.output);
assert.equal(regenerated.loader, readFileSync(join(worker, 'src/tailwind-play.generated.ts'), 'utf8'), 'offline, the loader is the committed one');
assert.deepEqual(regenerated.bundle, committed, 'and the bundle is left as it was');

const tampered = Buffer.concat([committed, Buffer.from('\n')]);
const refused = regenerate(tampered);
assert.notEqual(refused.status, 0, 'bytes that are not the pinned digest are refused');
assert.match(refused.output, /not the pinned [0-9a-f]{64}/);
assert.doesNotMatch(refused.output, /the network was used/);
assert.equal(refused.loader, null, 'and no loader is written');

console.log('tailwind-play-sourcing: regenerated offline from the pinned bundle; other bytes refused');
