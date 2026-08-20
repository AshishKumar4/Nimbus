#!/usr/bin/env bun
// Someone who ran `npm install @nimbus-sh/loom` gets a working package.
//
// Same discipline as fabric-npm-package-consumer: out of tarballs, from a
// directory that is not this repo, through the `import` condition — dist,
// the bytes we would actually publish — under plain node. The registry
// supplies partyserver (pinned 0.5.10), cron-schedule, and zod.
//
// Under node the workerd-facing modules must FAIL to resolve, loudly: the
// root export and actor.js pull partyserver, which imports
// cloudflare:workers. The workerd-free half (protocol, callable, rpc,
// client) must work — it is what browsers and tests import.
//
// Needs the network for the registry dependencies.

import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const REPO = new URL('../../', import.meta.url).pathname.replace(/\/$/, '');

const CONSUMER = `import assert from 'node:assert/strict';

// The root export and the Actor pull cloudflare:workers via partyserver,
// and say so; node proves it.
await assert.rejects(import('@nimbus-sh/loom'), /cloudflare/i);
await assert.rejects(import('@nimbus-sh/loom/actor.js'), /cloudflare/i);

// ── The wire protocol is shared and guarded ─────────────────────────────────
const { isRpcRequestFrame, isStateFrame, STATE_FRAME_TYPE } =
  await import('@nimbus-sh/loom/protocol.js');
assert.equal(STATE_FRAME_TYPE, 'cf_agent_state');
assert.ok(isStateFrame({ type: 'cf_agent_state', state: { n: 1 } }));
assert.ok(!isStateFrame({ type: 'cf_agent_state' }));
assert.ok(isRpcRequestFrame({ type: 'rpc', id: 'a', method: 'm', args: [] }));
assert.ok(!isRpcRequestFrame({ type: 'rpc', id: 'a', method: 'm', args: 'not-an-array' }));

// ── Callable RPC end to end: mark, dispatch, stream, call ──────────────────
const { callable, callableMethods } = await import('@nimbus-sh/loom/callable.js');
const { dispatchRpc } = await import('@nimbus-sh/loom/rpc.js');
const { actorClient } = await import('@nimbus-sh/loom/client.js');

class Target {
  greet(name) { return 'hello ' + name; }
  hidden() { return 'secret'; }
  async chunks(stream, n) {
    for (let i = 1; i <= n; i++) stream.send(i);
    stream.end('done');
  }
}
callable()(Target.prototype.greet);
callable({ streaming: true })(Target.prototype.chunks);
assert.deepEqual([...callableMethods(new Target()).keys()].sort(), ['chunks', 'greet']);

const listeners = new Set();
const serverConnection = { send(m) { for (const l of [...listeners]) l({ data: m }); } };
const socket = {
  send(data) { queueMicrotask(() => void dispatchRpc(new Target(), serverConnection, JSON.parse(data))); },
  addEventListener(_t, l) { listeners.add(l); },
  removeEventListener(_t, l) { listeners.delete(l); },
};
const client = actorClient(socket);
assert.equal(await client.call('greet', ['npm']), 'hello npm');
await assert.rejects(client.call('hidden'), /is not callable/);
const chunks = [];
assert.equal(await client.call('chunks', [2], { onChunk: (c) => chunks.push(c) }), 'done');
assert.deepEqual(chunks, [1, 2]);
client.close();

console.log('CONSUMER OK');
`;

const work = mkdtempSync(join(tmpdir(), 'loom-npm-consumer-'));
const run = (cmd, args, cwd) =>
  execFileSync(cmd, args, { cwd, encoding: 'utf8', maxBuffer: 1 << 28 });

try {
  // ── 1. Pack what a consumer installs ─────────────────────────────────────
  const tarballs = [];
  for (const pkg of ['loom', 'fabric', 'core', 'platform']) {
    const packed = JSON.parse(run(
      'npm',
      ['pack', join(REPO, 'packages', pkg), '--json', '--ignore-scripts', '--pack-destination', work],
      work,
    ));
    tarballs.push(join(work, packed[0].filename));
  }
  console.log(`  ok  npm pack → ${tarballs.map((t) => t.split('/').pop()).join(', ')}`);

  // ── 2. A clean directory, outside this repo, that installs them ──────────
  const consumer = mkdtempSync(join(tmpdir(), 'loom-embedder-'));
  writeFileSync(join(consumer, 'package.json'), `${JSON.stringify({
    name: 'loom-embedder-acceptance', version: '0.0.0', private: true, type: 'module',
  }, null, 2)}\n`);
  run('npm', ['install', '--no-audit', '--no-fund', ...tarballs], consumer);

  const installed = join(consumer, 'node_modules', '@nimbus-sh', 'loom');
  assert.ok(existsSync(join(installed, 'dist', 'index.js')), 'loom installed without a dist');
  assert.ok(existsSync(join(installed, 'dist', 'client.js')), 'loom dist is missing modules');
  assert.ok(
    !readFileSync(join(installed, 'package.json'), 'utf8').includes(REPO),
    'the installed loom points back into the repo',
  );
  const partyserver = JSON.parse(
    readFileSync(join(consumer, 'node_modules', 'partyserver', 'package.json'), 'utf8'),
  );
  assert.equal(partyserver.version, '0.5.10', 'partyserver must resolve to the pinned version');
  console.log(`  ok  installed into ${consumer} (partyserver ${partyserver.version})`);

  writeFileSync(join(consumer, 'consume.mjs'), CONSUMER);

  // ── 3. Run it under plain node ───────────────────────────────────────────
  const output = run('node', ['consume.mjs'], consumer);
  process.stdout.write(output.replace(/^(?!$)/gm, '  | '));
  assert.match(output, /^CONSUMER OK$/m);
} finally {
  rmSync(work, { recursive: true, force: true });
}

console.log('loom-npm-package-consumer: ok');
