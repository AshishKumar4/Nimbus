#!/usr/bin/env bun
// A successful response from a resident Node server is a durability boundary:
// synchronous filesystem writes performed by the request handler must already
// be visible through the supervisor VFS when the response is returned.

import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { FacetManager } from '../../packages/worker/src/facets/manager.ts';
import { PortRegistry } from '../../packages/worker/src/runtime/port-registry.ts';
import { generateShimsCode } from '../../packages/worker/src/runtime/node-shims.ts';
import { SessionProcessSupervisor } from '../../packages/worker/src/runtime/session-process-supervisor.ts';
import { setCtxExports } from '../../packages/worker/src/session/ctx-exports.ts';

let residentCode;
const routeStub = {
  async handleHttpRequest() {
    throw new Error('the generated worker is exercised directly in this test');
  },
};

setCtxExports({
  SupervisorRPC: () => ({}),
  NimbusLoadedEntrypoint: ({ props }) => {
    if (props.residentCode) residentCode = props.residentCode;
    return props.residentCode
      ? { async startProcess() { return { ok: true }; } }
      : routeStub;
  },
});

const env = {
  LOADER: {
    load() { throw new Error('resident processes use NimbusLoadedEntrypoint'); },
    get() { throw new Error('resident processes use NimbusLoadedEntrypoint'); },
  },
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
const ctx = { id: { toString: () => 'request-durability-test' }, waitUntil() {} };
const processes = new SessionProcessSupervisor();
const ports = new PortRegistry();
const manager = new FacetManager(ctx, env, processes, ports, {});

const userCode = `
const fs = require('node:fs');
const http = require('node:http');
http.createServer((req, res) => {
  const content = req.url === '/race' ? 'older'
    : req.url === '/same-race' ? 'same'
    : req.url.slice(1);
  fs.writeFileSync('/home/user/request-result.txt', content);
  if (req.url === '/stream') {
    res.writeHead(200, { 'content-type': 'text/event-stream' });
    res.write('data: live\\n\\n');
    return;
  }
  res.writeHead(200, { 'content-type': 'text/plain' });
  res.end('ok:' + req.url);
  if (req.url === '/race' || req.url === '/same-race') {
    const next = req.url === '/race' ? 'newer' : 'same';
    setTimeout(() => fs.writeFileSync('/home/user/request-result.txt', next), 0);
  }
}).listen(4387);
`;

await manager.spawnNode(userCode, {
  command: 'node --watch server.js',
  filename: '/home/user/server.js',
  cwd: '/home/user',
  port: 4387,
});
assert.ok(residentCode?.modules?.['worker.js'], 'spawn produced a generated resident worker');

function makeShimFsFacet(supervisor) {
  const generations = Object.create(null);
  const writes = new Proxy(Object.create(null), {
    set(target, path, value) {
      target[path] = value;
      generations[path] = (generations[path] || 0) + 1;
      return true;
    },
    deleteProperty(target, path) {
      if (Object.prototype.hasOwnProperty.call(target, path)) {
        delete target[path];
        generations[path] = (generations[path] || 0) + 1;
      }
      return true;
    },
  });
  const factory = new Function(
    '__vfsBundle', '__vfsMetadata', '__vfsWrites', '__vfsWriteGenerations',
    '__vfsDirs', '__vfsManifest', '__supervisor',
    'cred', 'cwd', 'argv', 'env', 'filename', 'dirname',
    `"use strict";${generateShimsCode()}\n;return builtins.fs;`,
  );
  const fs = factory(
    {}, {}, writes, generations, {}, {}, supervisor,
    { uid: 1000, gid: 1000, groups: [1000], umask: 0o022 },
    '/home/user', [], {}, '/home/user/main.mjs', '/home/user',
  );
  return { fs, writes };
}

async function assertAsyncFlushPreservesNewerWrite(initial, newer) {
  let releaseWrite;
  let writeStarted;
  const writeGate = new Promise((resolve) => { releaseWrite = resolve; });
  const started = new Promise((resolve) => { writeStarted = resolve; });
  const persisted = [];
  const supervisor = {
    async writeFile(_path, content) {
      persisted.push(content instanceof Uint8Array ? new TextDecoder().decode(content) : String(content));
      if (persisted.length === 1) {
        writeStarted();
        await writeGate;
      }
    },
    async fsTruncate() {},
  };
  const { fs } = makeShimFsFacet(supervisor);
  const path = '/home/user/flush-race.txt';
  fs.writeFileSync(path, initial);
  const flushing = fs.promises.truncate(path, String(initial).length);
  await started;
  fs.writeFileSync(path, newer);
  releaseWrite();
  await flushing;
  await fs.promises.truncate(path, String(newer).length);
  assert.equal(
    fs.readFileSync(path, 'utf8'),
    newer,
    'an async helper flush clears only the mutation generation it persisted',
  );
  assert.deepEqual(
    persisted,
    [initial, newer],
    'the next helper boundary persists the newer pending cell',
  );
}

await assertAsyncFlushPreservesNewerWrite('older', 'newer');
await assertAsyncFlushPreservesNewerWrite('same', 'same');

async function loadGeneratedWorker() {
  const source = residentCode.modules['worker.js'].replace(
    'import { WorkerEntrypoint } from "cloudflare:workers";',
    'class WorkerEntrypoint { constructor(env, ctx) { this.env = env; this.ctx = ctx; } }',
  );
  const url = URL.createObjectURL(new Blob([source], { type: 'text/javascript' }));
  try {
    return await import(url);
  } finally {
    URL.revokeObjectURL(url);
  }
}

function request(path = 'first') {
  return new Request(`http://127.0.0.1:4387/${path}`, {
    headers: { 'X-Nimbus-Port': '4387' },
  });
}

// The public generated entrypoint must not return a successful response until
// its handler's sync write has crossed the supervisor boundary.
{
  delete globalThis.__portRegistry;
  const durable = new Map();
  const writes = [];
  const supervisor = {
    async writeFile(path, content) {
      writes.push([path, String(content)]);
      durable.set(path, String(content));
    },
    async registerPort() {},
    async unregisterPort() {},
    async stdout() {},
    async stderr() {},
    async reportExit() {},
  };
  const generated = await loadGeneratedWorker();
  const worker = new generated.NimbusNodeProcess(
    { SUPERVISOR: supervisor },
    { waitUntil() {} },
  );

  const response = await worker.handleHttpRequest(request());
  assert.equal(response.status, 200);
  assert.equal(await response.text(), 'ok:/first');
  assert.equal(
    durable.get('home/user/request-result.txt'),
    'first',
    'request-time sync write is durable before the 200 response returns',
  );

  const second = await worker.handleHttpRequest(request('second'));
  assert.equal(second.status, 200);
  assert.equal(await second.text(), 'ok:/second');
  assert.deepEqual(
    writes.map(([, content]) => content),
    ['first', 'second'],
    'a successfully flushed cell is removed instead of being rewritten at the next request',
  );
}

// Adding the durability boundary must not buffer an open response body.
{
  delete globalThis.__portRegistry;
  const durable = new Map();
  const supervisor = {
    async writeFile(path, content) { durable.set(path, String(content)); },
    async registerPort() {},
    async unregisterPort() {},
    async stdout() {},
    async stderr() {},
    async reportExit() {},
  };
  const generated = await loadGeneratedWorker();
  const worker = new generated.NimbusNodeProcess(
    { SUPERVISOR: supervisor },
    { waitUntil() {} },
  );
  const rawSetTimeout = globalThis.__nimbusRawSetTimeout || setTimeout;

  const response = await Promise.race([
    worker.handleHttpRequest(request('stream')),
    new Promise((_, reject) => rawSetTimeout(() => reject(new Error('stream response was buffered')), 1000)),
  ]);
  assert.equal(response.status, 200);
  assert.equal(durable.get('home/user/request-result.txt'), 'stream');
  const reader = response.body.getReader();
  const first = await reader.read();
  assert.equal(new TextDecoder().decode(first.value), 'data: live\n\n');
  await reader.cancel();
}

// If a newer local write lands while an older RPC is in flight, only the
// flushed cell is cleared; the newer bytes survive for the next boundary.
{
  delete globalThis.__portRegistry;
  let releaseOlder;
  let olderStarted;
  const olderGate = new Promise((resolve) => { releaseOlder = resolve; });
  const olderCall = new Promise((resolve) => { olderStarted = resolve; });
  const writes = [];
  const supervisor = {
    async writeFile(_path, content) {
      const text = String(content);
      writes.push(text);
      if (text === 'older') {
        olderStarted();
        await olderGate;
      }
    },
    async registerPort() {},
    async unregisterPort() {},
    async stdout() {},
    async stderr() {},
    async reportExit() {},
  };
  const generated = await loadGeneratedWorker();
  const worker = new generated.NimbusNodeProcess(
    { SUPERVISOR: supervisor },
    { waitUntil() {} },
  );

  const raced = worker.handleHttpRequest(request('race'));
  await olderCall;
  const rawSetTimeout = globalThis.__nimbusRawSetTimeout || setTimeout;
  await new Promise((resolve) => rawSetTimeout(resolve, 0));
  releaseOlder();
  assert.equal((await raced).status, 200);

  const next = await worker.handleHttpRequest(request('after-race'));
  assert.equal(next.status, 200);
  assert.deepEqual(
    writes,
    ['older', 'newer', 'after-race'],
    'a newer local cell is preserved and flushed before the following handler',
  );
}

// Cell identity cannot be inferred from value equality: two separate writes of
// the same string still have distinct mutation generations.
{
  delete globalThis.__portRegistry;
  let releaseFirst;
  let firstStarted;
  const firstGate = new Promise((resolve) => { releaseFirst = resolve; });
  const firstCall = new Promise((resolve) => { firstStarted = resolve; });
  const writes = [];
  let sameCalls = 0;
  const supervisor = {
    async writeFile(_path, content) {
      const text = String(content);
      writes.push(text);
      if (text === 'same' && sameCalls++ === 0) {
        firstStarted();
        await firstGate;
      }
    },
    async registerPort() {},
    async unregisterPort() {},
    async stdout() {},
    async stderr() {},
    async reportExit() {},
  };
  const generated = await loadGeneratedWorker();
  const worker = new generated.NimbusNodeProcess(
    { SUPERVISOR: supervisor },
    { waitUntil() {} },
  );

  const raced = worker.handleHttpRequest(request('same-race'));
  await firstCall;
  const rawSetTimeout = globalThis.__nimbusRawSetTimeout || setTimeout;
  await new Promise((resolve) => rawSetTimeout(resolve, 0));
  releaseFirst();
  assert.equal((await raced).status, 200);

  const next = await worker.handleHttpRequest(request('after-same-race'));
  assert.equal(next.status, 200);
  assert.deepEqual(
    writes,
    ['same', 'same', 'after-same-race'],
    'a newer identical string cell survives the older write RPC',
  );
}

// A VFS failure cannot be hidden behind a successful HTTP response.
{
  delete globalThis.__portRegistry;
  const supervisor = {
    async writeFile() { throw new Error('injected durable write failure'); },
    async registerPort() {},
    async unregisterPort() {},
    async stdout() {},
    async stderr() {},
    async reportExit() {},
  };
  const generated = await loadGeneratedWorker();
  const worker = new generated.NimbusNodeProcess(
    { SUPERVISOR: supervisor },
    { waitUntil() {} },
  );

  await assert.rejects(
    () => worker.handleHttpRequest(request('failure')),
    /injected durable write failure/,
    'durability failure rejects the request instead of returning 200',
  );
}

console.log('resident-node-request-vfs-durability: ok');
