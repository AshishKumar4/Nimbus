#!/usr/bin/env bun
// @tier slow — four concurrent real bash/wasm process realms; staged runtime and SQLite workspace flows
// Kinu #26: inspect the whole process family at the instant abort settles,
// not after a reaper/grace window. Every worker is under the same four-way load.
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { readdirSync, readFileSync } from 'node:fs';
import { hostSqlite } from './lib/host-sqlite.mjs';
import { missingRuntimeFile, RUNTIMES, seedRuntime } from './lib/wasm-runtimes.mjs';

const stat = pid => { try { return readFileSync(`/proc/${pid}/stat`, 'utf8').split(') ')[1].split(' '); } catch { return null; } };
const family = () => {
  const parents = new Map(readdirSync('/proc').filter(id => /^\d+$/.test(id)).map(id => [id, stat(id)?.[1]]));
  const found = new Set([String(process.pid)]);
  for (let changed = true; changed;) {
    changed = false;
    for (const [id, parent] of parents) if (found.has(parent) && !found.has(id)) { found.add(id); changed = true; }
  }
  return [...found];
};

if (!process.env.ABORT_GROUP_CHILD) {
  const runs = Array.from({ length: 4 }, (_, index) => new Promise(resolve => {
    const child = spawn(process.execPath, [import.meta.filename], {
      env: { ...process.env, ABORT_GROUP_CHILD: String(index + 1) }, stdio: ['ignore', 'pipe', 'pipe'],
    });
    let output = '';
    child.stdout.on('data', bytes => { output += bytes; });
    child.stderr.on('data', bytes => { output += bytes; });
    const timeout = setTimeout(() => child.kill('SIGKILL'), 60_000);
    child.once('error', error => { clearTimeout(timeout); resolve({ code: -1, output: String(error) }); });
    child.once('close', code => { clearTimeout(timeout); resolve({ code, output }); });
  }));
  const results = await Promise.all(runs);
  for (const result of results) console.log(result.output.trim());
  assert.ok(results.every(result => result.code === 0), 'every four-way abort settles after its whole process family ends');
} else {
  assert.equal(missingRuntimeFile(), null, 'the real in-repo bash runtime must be present');
  const { NimbusWorkspace } = await import('../../packages/core/src/workspace/nimbus-workspace.ts');
  const { localFacetHost } = await import('../../packages/core/src/runtime/local-facet-host.ts');
  const { ISOLATE_NETWORK } = await import('../../packages/core/src/_shared/workspace-network.ts');
  const { sql, transactions } = await hostSqlite();
  const host = localFacetHost(ISOLATE_NETWORK);
  const seeding = await NimbusWorkspace.create({ sql, transactions, generation: 1, cwd: '/home/user' });
  for (const runtime of RUNTIMES.filter(runtime => runtime.name === 'bash')) seedRuntime(seeding.vfs, runtime);
  const ws = await NimbusWorkspace.create({ sql, transactions, generation: 1, cwd: '/home/user', facets: host });
  try {
    assert.equal((await ws.exec('bash -c "echo warmed"')).stdout, 'warmed\n');
    const before = family();
    const controller = new AbortController();
    const started = Date.now();
    let aborted;
    let spinning;
    const files = ws.vfs.as({ uid: 1000, gid: 1000, groups: [1000], umask: 0o022 });
    const timer = setInterval(() => {
      if (spinning === undefined && files.exists('home/user/spinning')) spinning = Date.now();
      if (spinning !== undefined && Date.now() - spinning >= 500 && aborted === undefined) {
        aborted = Date.now(); controller.abort();
      }
    }, 10);
    let result;
    try {
      result = await ws.exec('bash -c "printf ready > /home/user/spinning; while :; do :; done"', { signal: controller.signal });
    } finally { clearInterval(timer); }
    const left = family().filter(id => !before.includes(id));
    console.log('ABORT_GROUP ' + JSON.stringify({ caller: process.env.ABORT_GROUP_CHILD, exitCode: result.exitCode,
      elapsedMs: Date.now() - started, abortToSettleMs: aborted === undefined ? null : Date.now() - aborted,
      left: left.map(id => ({ pid: id, state: stat(id)?.[0], group: stat(id)?.[2] })) }));
    assert.equal(result.exitCode, 130);
    assert.ok(spinning !== undefined && aborted !== undefined, 'the real bash marked its loop before abort fired under load');
    assert.deepEqual(left, [], 'no child/group member is alive when abort settles');
    assert.equal((await ws.exec('bash -c "echo again"')).stdout, 'again\n');
  } finally { await ws.close(); }
}
