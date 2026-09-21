#!/usr/bin/env bun
//
// A one-shot exec builds its filesystem bundle the way a resident launch does:
// paged across Durable Object turns, through one builder.
//
// The exec path used to assemble the same bundle a resident launch pages —
// the same walk, the same enrichment passes, the same ESM transform, the same
// serialization — in one turn, raced against a wall-clock deadline that scaled
// with the tree. A tree large enough to page on the resident path failed every
// `node -e` in it with "assembling the filesystem bundle … exceeded". Two
// paths, one job; the job is now done once, and both paths yield.
//
// So the properties under test are the builder's, through its two public
// callers:
//   1. an exec on a tree larger than one chunk suspends between turns, and the
//      program it runs is still complete;
//   2. exec and resident produce the same bundle, and a resident launched
//      after an exec of the same entry is served from the exec's build;
//   3. a kill that lands while an exec is suspended stops the build — no
//      module map is loaded, no further turns are spent, and the pacer is
//      released so the turn that resumed it is not stranded;
//   4. a build that fails is thrown to the caller as before, and the process
//      entry it was building for is exited rather than left running forever.
//
// The chunk bound is forced small so an ordinary program exercises the
// multi-turn path, for the same reason resident-launch-crosses-turns does.

import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

import { FacetManager } from '../../packages/worker/src/facets/manager.ts';
import { processHostFor } from '../../packages/worker/src/loaders/process-host.ts';
import { PortRegistry } from '../../packages/core/src/runtime/port-registry.ts';
import { SessionProcessSupervisor } from '../../packages/core/src/runtime/session-process-supervisor.ts';
import { adoptCtxExports } from '../../packages/fabric/src/composition.ts';
import { SqliteVFS } from '../../packages/core/src/vfs/sqlite-vfs.ts';
import { createSqliteVfsTestHarness } from './sqlite-vfs-test-harness.mjs';
import { createFacetCtx, createFacetWorld } from './facet-host-harness.mjs';
import { CRED_KERNEL } from '../../packages/core/src/runtime/os-contracts.ts';
import { readExecTelemetry, resetExecTelemetry } from '../../packages/worker/src/facets/exec-telemetry.ts';
import { SqliteFilesystemAuthority } from '../../packages/core/src/runtime/filesystem-authority.ts';

process.env.NIMBUS_DIAG_EXEC = '1';

adoptCtxExports({
  SupervisorRPC: ({ props }) => ({ props }),
  NimbusLoadedEntrypoint: () => ({
    async startProcess() { return { ok: true }; },
    async handleHttpRequest() { return new Response('ok'); },
  }),
});

/**
 * A manager whose one-shot loader records every module map it is handed and
 * answers each run with a clean exit, and whose resident host is the facet
 * world. `turns` counts the fresh turns the session's alarm would have
 * granted — the observable that says a build suspended.
 */
function makeManager(label, turns, { chunkBytes = '2048' } = {}) {
  const world = createFacetWorld(() => ({
    async startProcess() { return { ok: true }; },
    async handleHttpRequest() { return new Response('ok'); },
  }));
  const ctx = createFacetCtx(world, label);
  const oneShotMaps = [];
  const env = {
    LOADER: {
      load(config) {
        oneShotMaps.push(config);
        return {
          getEntrypoint: () => ({
            async fetch() { return Response.json({ exitCode: 0, stdout: 'ran\n', stderr: '' }); },
            [Symbol.dispose]() {},
          }),
          [Symbol.dispose]() {},
        };
      },
      get: world.loader.get.bind(world.loader),
    },
    NIMBUS_LAUNCH_CHUNK_BYTES: chunkBytes,
    ASSETS: {
      async fetch(request) {
        const path = new URL(request.url).pathname.replace(/^\//, '');
        return new Response(
          readFileSync(new URL(`../../packages/worker/public/${path}`, import.meta.url)),
          { status: 200 },
        );
      },
    },
  };
  const exits = [];
  const manager = new FacetManager(
    ctx, env, new SessionProcessSupervisor(), new PortRegistry(), processHostFor,
    {
      requestLaunchTurn: () => {
        turns.count++;
        setTimeout(() => { void manager.pumpResidentLaunches(); }, 0);
      },
      onExternalExit: (pid, code, reason) => { exits.push({ pid, code, reason }); },
    },
  );
  const harness = createSqliteVfsTestHarness();
  const vfs = new SqliteVFS(harness.sql, harness.ctx);
  manager.setVfs(vfs, new SqliteFilesystemAuthority(vfs));
  return { manager, world, vfs, oneShotMaps, exits };
}

/** A dependency big enough to be worth chunking, small enough to be ordinary. */
function seedProgram(vfs, marker) {
  const fs = vfs.as(CRED_KERNEL);
  fs.mkdir('home/user/node_modules/dep/lib', { recursive: true, mode: 0o755 });
  fs.writeFile(
    'home/user/node_modules/dep/package.json',
    JSON.stringify({ name: 'dep', main: 'lib/index.js' }),
    { mode: 0o644 },
  );
  const mods = 40;
  fs.writeFile(
    'home/user/node_modules/dep/lib/index.js',
    Array.from({ length: mods }, (_, i) => `require('./mod${i}');`).join('\n')
      + `\nmodule.exports = 1; // ${marker}\n`,
    { mode: 0o644 },
  );
  for (let i = 0; i < mods; i++) {
    fs.writeFile(
      `home/user/node_modules/dep/lib/mod${i}.js`,
      `module.exports = ${i};\n// ${'p'.repeat(400)}\n`,
      { mode: 0o644 },
    );
  }
  return fs;
}

const ENTRY = { filename: '/home/user/run.js', cwd: '/home/user' };

/** The three snapshot declarations a generated facet body carries. */
function snapshotDeclarations(source) {
  const pick = (name) => {
    const match = source.match(new RegExp(`^(?:const|let) ${name} = (.*);$`, 'm'));
    assert.ok(match, `the generated body declares ${name}`);
    return match[1];
  };
  return {
    bundle: pick('__MODULE_VFS_BUNDLE'),
    manifest: pick('__MODULE_VFS_MANIFEST'),
    metadata: pick('__MODULE_VFS_METADATA'),
  };
}

async function settle(predicate, label) {
  for (let i = 0; i < 500 && !predicate(); i++) {
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  assert.ok(predicate(), label);
}

// ── 1. an exec on a large tree suspends, and still runs what it should ───
{
  const turns = { count: 0 };
  const { manager, oneShotMaps } = makeManager('exec-crosses-turns', turns);
  seedProgram(manager.vfs, 'marker-exec');

  resetExecTelemetry();
  const result = await manager.exec("require('dep');", { ...ENTRY, captureOutput: true });
  assert.equal(result.exitCode, 0, 'the exec completed');
  assert.ok(
    turns.count > 1,
    `the build crossed several turns rather than running straight through (grants=${turns.count})`,
  );
  assert.equal(oneShotMaps.length, 1, 'exactly one module map was loaded for the exec');
  const runner = oneShotMaps[0].modules['runner.js'];
  assert.ok(
    runner.includes('marker-exec'),
    'a build spread across turns still carries the program it was asked to run',
  );
  const [rec] = readExecTelemetry();
  assert.equal(rec.turns, turns.count, 'the exec reports every turn its build took');
  assert.equal(rec.cacheHit, false, 'the first build of an entry is a miss');

  // The same entry again: served from the build above, in the turn that
  // asked for it.
  const grantsBefore = turns.count;
  resetExecTelemetry();
  const again = await manager.exec("require('dep');", { ...ENTRY, captureOutput: true });
  assert.equal(again.exitCode, 0);
  assert.equal(turns.count, grantsBefore, 'a cache hit takes no turns');
  assert.equal(readExecTelemetry()[0].turns, 0);
  assert.equal(readExecTelemetry()[0].cacheHit, true);
}

// ── 2. the same bundle, whichever path builds it ──────────────────────────
//
// Two managers on identically seeded filesystems: one builds through exec,
// the other through a resident launch. The snapshot each facet boots on has
// to be byte-identical — same cells, same manifest, same metadata — or the
// two paths are still two builders.
{
  const execTurns = { count: 0 };
  const exec = makeManager('exec-vs-resident/exec', execTurns);
  seedProgram(exec.vfs, 'marker-same');
  const result = await exec.manager.exec("require('dep');", { ...ENTRY, captureOutput: true });
  assert.equal(result.exitCode, 0);
  const fromExec = snapshotDeclarations(exec.oneShotMaps[0].modules['runner.js']);

  const residentTurns = { count: 0 };
  const resident = makeManager('exec-vs-resident/resident', residentTurns);
  seedProgram(resident.vfs, 'marker-same');
  await resident.manager.spawnNode("require('dep');", { ...ENTRY, command: 'dep-tui', attachedTty: true });
  await settle(() => resident.world.configs.size === 1, 'the resident launch built its module map');
  const [config] = [...resident.world.configs.values()];
  const fromResident = snapshotDeclarations(config.modules['worker.js']);

  assert.ok(fromExec.bundle.includes('marker-same'), 'the exec snapshot carries the program');
  assert.deepEqual(fromResident, fromExec, 'exec and resident boot on the same snapshot');
  assert.ok(execTurns.count > 1 && residentTurns.count > 1, 'both builds paged');

  // …and within one session, a resident launched after an exec of the same
  // entry is served from the exec's build rather than walking the tree again.
  resetExecTelemetry();
  const grantsBefore = execTurns.count;
  await exec.manager.spawnNode("require('dep');", { ...ENTRY, command: 'dep-tui', attachedTty: true });
  await settle(() => exec.world.configs.size === 1, 'the resident launch after the exec booted');
  const [record] = readExecTelemetry();
  assert.equal(record.cacheHit, true, 'the resident launch was served from the exec\'s build');
  // A resident launch still pages its image-store write, so it is not
  // turn-free; what it does not pay for again is the build.
  assert.ok(
    execTurns.count - grantsBefore < residentTurns.count,
    `a served launch takes fewer turns (${execTurns.count - grantsBefore}) than a cold one (${residentTurns.count})`,
  );
  const served = snapshotDeclarations([...exec.world.configs.values()][0].modules['worker.js']);
  assert.deepEqual(served, fromExec, 'the served snapshot is the one the exec built');
}

// ── 3. a kill that lands mid-build stops the build and releases the pacer ─
{
  const turns = { count: 0 };
  const { manager, oneShotMaps, exits } = makeManager('exec-killed-mid-flight', turns);
  seedProgram(manager.vfs, 'marker-killed');

  const running = manager.exec("require('dep');", { ...ENTRY, captureOutput: true });
  // Let the build reach its first suspension, then take its process away.
  await settle(() => turns.count >= 1, 'the build suspended at least once');
  const pid = manager.processes.getRunning()[0]?.pid;
  assert.ok(pid, 'the exec spawned a running process entry');
  manager.processes.exit(pid, 137);
  const grantsAtKill = turns.count;

  await assert.rejects(
    running,
    /cancelled while it was suspended/,
    'the exec reports that its build was cancelled, loudly',
  );
  // Give the build every opportunity to carry on anyway.
  for (let i = 0; i < 40; i++) await new Promise((resolve) => setTimeout(resolve, 5));
  assert.equal(oneShotMaps.length, 0, 'no module map was loaded for a process that was gone');
  assert.ok(
    turns.count - grantsAtKill <= 2,
    `the build stopped taking turns once its process was gone (grants after the kill: ${turns.count - grantsAtKill})`,
  );
  assert.equal(manager.processes.get(pid).exitCode, 137, 'the kill\'s exit code stands; nothing re-exited the entry');
  assert.deepEqual(exits, [], 'a build ended by a kill reports no second exit');
  assert.equal(manager.hasPendingLaunchTurns, false, 'nothing is left waiting for a turn');
  // The pump that resumed the last chunk is not stranded: the pacer settled
  // on the way out, so the turn it owed resolves.
  await Promise.race([
    manager.pumpResidentLaunches(),
    new Promise((_, reject) => setTimeout(() => reject(new Error('the launch pump is stranded')), 2000)),
  ]);
}

// ── 4. a failed build is thrown, and leaves no orphan process entry ──────
//
// The build used to be awaited outside exec's try/catch, so a failure threw
// to the caller — correctly — while the entry spawned for it stayed 'running'
// forever. The throw is unchanged; the entry is now exited once.
{
  const turns = { count: 0 };
  const { manager, oneShotMaps, exits } = makeManager('exec-build-fails', turns);
  seedProgram(manager.vfs, 'marker-fails');
  manager._buildProcessBundle = async () => { throw new Error('the walk broke'); };

  await assert.rejects(
    () => manager.exec("require('dep');", { ...ENTRY, captureOutput: true }),
    /the walk broke/,
    'a failed build is thrown to the caller as before',
  );
  assert.equal(oneShotMaps.length, 0, 'nothing was loaded');
  const orphans = manager.processes.getRunning();
  assert.deepEqual(orphans, [], 'no process entry is left running for a process that never started');
  assert.equal(exits.length, 1, 'the exit is reported exactly once');
  assert.equal(exits[0].code, 1);
  assert.match(exits[0].reason, /assembling the filesystem bundle for `node \/home\/user\/run\.js` failed: the walk broke/);
  assert.equal(manager.hasPendingLaunchTurns, false);
}

console.log('facet-exec-bundle-paged: OK');
