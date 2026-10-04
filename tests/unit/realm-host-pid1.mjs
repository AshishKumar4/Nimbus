#!/usr/bin/env bun
// A process realm's host may itself be PID 1: Bun as a container's
// entrypoint. The guest takes its host's PID at launch to notice the host
// going away (it is reparented then); it refused PID 1, so in a container
// every local wasm runtime ended with "realm: started without a realm". A
// PID namespace's init leaving ends the whole namespace, guests included,
// so PID 1 needs no other watch.
//
// Run by bun, it runs itself as PID 1 of a new PID namespace (bubblewrap
// --as-pid-1, as run-bounded uses) and opens a facet there. Under Bun a
// facet is a process realm, the transport this concerns.
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

if (process.pid !== 1) {
  assert.ok(existsSync('/usr/bin/bwrap'), 'realm-host-pid1 needs /usr/bin/bwrap to start a process as PID 1');
  const child = spawnSync('/usr/bin/bwrap', [
    '--unshare-user', '--unshare-pid', '--as-pid-1', '--die-with-parent',
    '--bind', '/', '/', '--proc', '/proc', '--dev-bind', '/dev', '/dev',
    process.execPath, fileURLToPath(import.meta.url),
  ], { encoding: 'utf8', timeout: 60_000 });
  assert.equal(child.status, 0, `as PID 1:\n${child.stdout}${child.stderr}`);
  assert.match(child.stdout, /^ok - as PID 1/m, child.stdout);
  console.log('ok - realm-host-pid1 (a process realm runs under a PID 1 host)');
} else {
  const { localFacetHost } = await import('../../packages/core/src/runtime/local-facet-host.ts');
  const facet = localFacetHost().open({ tag: 'pid1' });
  assert.equal(await facet.submit(function answer() { return 41 + 1; }, null), 42);
  await facet.dispose();
  console.log('ok - as PID 1');
}
