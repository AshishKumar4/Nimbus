#!/usr/bin/env bun
// What a peer writes after a resident node process launched is readable by
// that process synchronously at its next resumption, when it lands in the
// process's working tree or /tmp: the ACQUIRE that brings the change carries
// the bytes (fsAcquire options.push). Build output, dev-server manifests and
// temp files are exactly this: written by one process, read synchronously by
// another. Content under node_modules is not pushed — a dependency write
// after launch is a first miss, named — and nothing is ever truncated.

import assert from 'node:assert/strict';
import {
  coherenceStats,
  createAuthority,
  facetSupervisor,
  launchResident,
  runScenarios,
} from './lib/resident-body.mjs';

const PROGRAM = `
const fs = require("fs");
const read = (p) => { try { return fs.readFileSync(p, "utf8"); } catch (e) { return "ERR:" + e.code; } };
globalThis.__probe = {
  read,
  resume: (...paths) => new Promise((resolve) => setTimeout(() => resolve(paths.map(read).join("|")), 0)),
};
require("http").createServer((q, s) => s.end("up")).listen(3000);
`;

async function boot() {
  const authority = createAuthority();
  authority.kfs.mkdir('home/user/app/node_modules/dep', { recursive: true, mode: 0o755 });
  authority.kfs.writeFile('home/user/app/f.txt', 'v1');
  const handle = facetSupervisor(authority);
  await launchResident({ authority, program: PROGRAM, env: { SUPERVISOR: handle.supervisor }, cursor: authority.cursor() });
  return { authority, probe: globalThis.__probe, log: handle.log };
}

await runScenarios(import.meta.path, {
  async 'a file a peer creates in the working tree is readable at the next resumption'() {
    const { authority, probe, log } = await boot();
    authority.kfs.mkdir('home/user/app/.next/server', { recursive: true, mode: 0o755 });
    authority.kfs.writeFile('home/user/app/.next/server/manifest.json', '{"pages":1}');
    authority.kfs.mkdir('tmp/vitest', { recursive: true, mode: 0o777 });
    authority.kfs.writeFile('tmp/vitest/ssr-1', 'chunk');
    const reads = log.calls.fsReadBatch ?? 0;
    assert.equal(
      await probe.resume('/home/user/app/.next/server/manifest.json', '/tmp/vitest/ssr-1'),
      '{"pages":1}|chunk',
    );
    assert.equal(log.calls.fsReadBatch ?? 0, reads, 'the bytes rode the ACQUIRE, not a read');
    assert.equal(coherenceStats().pushes, 2);
  },

  async 'a held file a peer rewrites is replaced in place, with no refetch'() {
    const { authority, probe, log } = await boot();
    assert.equal(probe.read('/home/user/app/f.txt'), 'v1');
    authority.kfs.writeFile('home/user/app/f.txt', 'v2');
    const before = (log.calls.fsReadRange ?? 0) + (log.calls.fsReadBatch ?? 0) + (log.calls.readFile ?? 0);
    assert.equal(await probe.resume('/home/user/app/f.txt'), 'v2');
    assert.equal((log.calls.fsReadRange ?? 0) + (log.calls.fsReadBatch ?? 0) + (log.calls.readFile ?? 0), before);
  },

  async 'a file too large for one answer is never truncated'() {
    const { authority, probe } = await boot();
    const big = 'B'.repeat(5 * 1024 * 1024);
    // Held and rewritten past the answer's size: dropped, then refetched whole.
    authority.kfs.writeFile('home/user/app/f.txt', big);
    // New and past the answer's size: named, not held.
    authority.kfs.writeFile('home/user/app/new-big.txt', big);
    const seen = await probe.resume('/home/user/app/f.txt', '/home/user/app/new-big.txt');
    const [held, fresh] = seen.split('|');
    assert.equal(held.length, big.length, 'the held file comes back whole');
    assert.equal(fresh, 'ERR:EAGAIN');
  },

  async 'a dependency written after launch is not pushed, and misses by name'() {
    const { authority, probe } = await boot();
    authority.kfs.writeFile('home/user/app/node_modules/dep/late.js', 'module.exports = 1');
    assert.equal(await probe.resume('/home/user/app/node_modules/dep/late.js'), 'ERR:EAGAIN');
  },
});
