#!/usr/bin/env bun
// N18 and a launch's module map. The facet store adopts the module map at
// boot; it is the program's code, so it is held whole or the launch fails.
// - With room in the session, a module map larger than the facet's
//   allowance is still held: the store asks for the room first, and every
//   module loads. (On the throwaway, pi, astro and nuxt failed with "Cannot
//   read module" because boot dropped the modules past the allowance.)
// - With no room, the launch fails with ENOSPC naming the modules, not
//   "Cannot read module".

import assert from 'node:assert/strict';
import { createAuthority, facetSupervisor, launchResident, facetSql, runScenarios } from './lib/resident-body.mjs';
import { StorageLedger } from '../../packages/core/src/runtime/storage-ledger.ts';

const MB = 1024 * 1024;
const lib = (n) => `module.exports = ${JSON.stringify('x'.repeat(n))}.length;\n`;
const PROGRAM = `
const sizes = [require("/home/user/app/lib/a.js"), require("/home/user/app/lib/b.js")];
globalThis.__probe = { sizes };
require("http").createServer((q, s) => s.end("up")).listen(3000);
`;

async function launch(roomForModules) {
  const authority = createAuthority({ storageKernelReserve: 0 });
  authority.kfs.mkdir('home/user/app/lib', { recursive: true, mode: 0o755 });
  authority.kfs.writeFile('home/user/app/lib/a.js', lib(MB));
  authority.kfs.writeFile('home/user/app/lib/b.js', lib(MB));
  const raw = authority.rawVfs;
  raw.ledger = new StorageLedger(raw.sql, { limit: raw.databaseBytes() + (roomForModules ? 16 * MB : 256 * 1024), kernelReserve: 0 });
  const FACET = 'proc-slot-0';
  raw.ledger.fill(FACET, 64 * 1024);
  const handle = facetSupervisor(authority);
  delete globalThis.__probe;
  const run = launchResident({
    authority, sql: facetSql(), program: PROGRAM, env: { SUPERVISOR: handle.supervisor }, cursor: authority.cursor(),
    bundle: {
      'home/user/app/lib/a.js': lib(MB),
      'home/user/app/lib/b.js': lib(MB),
    },
    // The allowance the spawn granted, smaller than the module map.
    startArgs: { storage: { facet: FACET, grant: 64 * 1024 } },
  });
  return { run, raw, handle };
}

// One launch per process (lib/resident-body.mjs): each scenario runs in its own child.
await runScenarios(import.meta.path, {
  async 'a module map larger than the allowance is admitted, and every module loads'() {
    const { run, raw } = await launch(true);
    await run;
    assert.deepEqual(globalThis.__probe?.sizes, [MB, MB], 'every module loaded');
    assert.ok(raw.ledger.view().facets['proc-slot-0'] >= 2 * MB, 'the room was admitted under the facet');
  },
  async 'a module map with no room is ENOSPC, and the program never runs'() {
    const { run } = await launch(false);
    await assert.rejects(run, (error) => /ENOSPC: workspace storage is full: this process's modules \(\d+ MiB\) do not fit/.test(String(error?.message ?? error)));
    assert.equal(globalThis.__probe, undefined, 'the program never ran');
  },
});
if (!process.env.NIMBUS_RESIDENT_BODY_SCENARIO) await Bun.write(Bun.stdout, 'n18-module-map-admitted: ok\n');
