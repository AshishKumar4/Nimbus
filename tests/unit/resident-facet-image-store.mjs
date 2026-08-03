#!/usr/bin/env bun
// The content-addressed store a resident process boots from.
//
// A node facet's module map is sized by the user's disk — pi's serialized to
// 44,252,709 bytes — so it cannot ride inside a boot spec that has to cross to
// a peer DO. It is materialized here instead and the spec names it.
//
// Content addressing is what makes that safe to cache: an image's name is the
// hash of its own bytes, so a changed program cannot be served a stale image
// because it cannot address one. What content addressing does NOT do is bound
// the store, since a changed program writes a new image rather than replacing
// one — that is the sweep's job, and its root set is the process table.

import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { FacetManager } from '../../packages/worker/src/facets/manager.ts';
import { PortRegistry } from '../../packages/worker/src/runtime/port-registry.ts';
import { SessionProcessSupervisor } from '../../packages/worker/src/runtime/session-process-supervisor.ts';
import { setCtxExports } from '../../packages/worker/src/session/ctx-exports.ts';
import {
  _rpcHostProcessProbe,
  _rpcHostProcess,
  _rpcAwaitHostedBoot,
  _rpcRouteHostedHttp,
  _rpcCancelHostProcess,
} from '../../packages/worker/src/session/rpc.ts';
import { SqliteVFS } from '../../packages/worker/src/vfs/sqlite-vfs.ts';
import { createSqliteVfsTestHarness } from './sqlite-vfs-test-harness.mjs';
import { CRED_KERNEL } from '../../packages/worker/src/runtime/os-contracts.ts';
import {
  FACET_IMAGE_DIR,
  facetImageDigest,
  facetImagePath,
} from '../../packages/worker/src/loaders/process-fabric.ts';

// ── writer: the store the coordinator materializes ─────────────────────────

const specs = [];
setCtxExports({
  SupervisorRPC: ({ props }) => ({ props }),
  NimbusLoadedEntrypoint: ({ props }) => {
    if (props.residentCode) specs.push(props.residentCode);
    return {
      async startProcess() { return { ok: true }; },
      async handleHttpRequest() { return new Response('ok'); },
    };
  },
});

const peerSelf = { _hostedProcesses: new Map(), _hostedProcessWaiters: new Map() };
const peerStub = {
  _rpcHostProcessProbe: async () => _rpcHostProcessProbe(peerSelf),
  _rpcHostProcess: (boot, opts) => _rpcHostProcess(peerSelf, boot, opts),
  _rpcAwaitHostedBoot: (key) => _rpcAwaitHostedBoot(peerSelf, key),
  _rpcRouteHostedHttp: (key, wire) => _rpcRouteHostedHttp(peerSelf, key, wire),
  _rpcCancelHostProcess: async (key) => _rpcCancelHostProcess(peerSelf, key),
};

const env = {
  NIMBUS_SESSION: { idFromName: (name) => ({ name }), get: () => peerStub },
  LOADER: { load() { throw new Error('unused'); }, get() { throw new Error('unused'); } },
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

const processes = new SessionProcessSupervisor();
const manager = new FacetManager(
  { id: { toString: () => 'image-store-test' }, waitUntil() {} },
  env, processes, new PortRegistry(), {},
);
const harness = createSqliteVfsTestHarness();
const sessionVfs = new SqliteVFS(harness.sql, harness.ctx);
manager.setVfs(sessionVfs);
const fs = sessionVfs.as(CRED_KERNEL);

const storedImages = () => {
  try { return fs.readdir(FACET_IMAGE_DIR).map((e) => e.name).sort(); }
  catch { return []; }
};
const spawn = (code, name) => manager.spawnNode(code, {
  command: `node ${name}`, filename: `/home/user/${name}`, cwd: '/home/user',
});

const a1 = await spawn('const a = 1;', 'a.js');
const specA = specs.at(-1);
const imageA = specA.vfsTextModules['worker.js'];
assert.match(imageA, /^\/var\/lib\/nimbus\/facet-images\/[0-9a-f]{64}\.js$/,
  'the boot spec names the image by the digest of its bytes');
assert.equal(specA.modules['worker.js'], undefined,
  'the generated worker is NOT carried by the spec that crosses to the peer');

// The name really is the hash of the bytes, not merely hash-shaped.
const storedSource = fs.readFileString(imageA.replace(/^\/+/, ''));
assert.equal(facetImagePath(await facetImageDigest(storedSource)), imageA,
  'the image is addressed by its own content');

// The image is kernel-owned and world-readable: every process reads it through
// a supervisor binding that enforces its own credential, so readability has to
// hold by construction rather than by a carve-out in the permission layer.
const meta = fs.lstat(imageA.replace(/^\/+/, ''));
assert.equal(meta.uid, CRED_KERNEL.uid, 'the image belongs to the kernel, not to the program it encodes');
assert.equal(meta.mode & 0o777, 0o644, 'and is readable by any process without a privilege exception');

// ── identical program, identical image ─────────────────────────────────────
const afterA = storedImages();
const a2 = await spawn('const a = 1;', 'a.js');
assert.equal(specs.at(-1).vfsTextModules['worker.js'], imageA,
  'the same program resolves to the image already there');
assert.deepEqual(storedImages(), afterA, 'and writes no second copy of it');

// ── a changed program cannot address the old image ─────────────────────────
const b = await spawn('const b = 2;', 'b.js');
const imageB = specs.at(-1).vfsTextModules['worker.js'];
assert.notEqual(imageB, imageA, 'different program text is a different image');
assert.equal(storedImages().length, afterA.length + 1, 'both live images are present');

// ── the sweep: an image is live exactly while its process is ───────────────
// Two processes booted from imageA, so exiting one is NOT enough to drop it —
// the root set is per-process and a shared image outlives any single member.
manager.finishProcess(a1.pid, 0);
await spawn('const shared = 1;', 'shared.js');
assert.equal(storedImages().includes(imageA.split('/').pop()), true,
  'an image is kept while ANY process that boots from it is still running');

manager.finishProcess(a2.pid, 0);
await spawn('const c = 3;', 'c.js');
const imageC = specs.at(-1).vfsTextModules['worker.js'];
const live = storedImages();
assert.equal(live.includes(imageA.split('/').pop()), false,
  "the exited process's image is swept — content addressing does not bound the store, the process table does");
assert.equal(live.includes(imageB.split('/').pop()), true, 'a running process keeps its image');
assert.equal(live.includes(imageC.split('/').pop()), true);
assert.equal(processes.get(b.pid)?.state, 'running');

// ── reader: verify-on-read ─────────────────────────────────────────────────
// The name is a promise about the bytes; the loader must check it before the
// source becomes the program. Without this a truncated or overwritten image
// boots as silently-wrong code and fails somewhere deep inside the process.

const outputDir = await mkdtemp(join(tmpdir(), 'nimbus-facet-image-'));
try {
  const build = await Bun.build({
    entrypoints: ['./packages/worker/src/session/bindings.ts'],
    outdir: outputDir,
    target: 'bun',
    format: 'esm',
    plugins: [{
      name: 'cloudflare-workers-test-stub',
      setup(builder) {
        builder.onResolve({ filter: /^cloudflare:workers$/ }, () => ({
          path: 'cloudflare-workers', namespace: 'test',
        }));
        builder.onLoad({ filter: /.*/, namespace: 'test' }, () => ({
          contents: 'export class WorkerEntrypoint {};', loader: 'js',
        }));
      },
    }],
  });
  assert.equal(build.success, true, build.logs.map(String).join('\n'));
  const entry = build.outputs.find((o) => o.path.endsWith('/bindings.js'));
  const { NimbusLoadedEntrypoint } = await import(pathToFileURL(entry.path).href);

  const files = new Map();
  const supervisor = {
    async stat(path) {
      const bytes = files.get(path);
      return bytes === undefined ? null : { size: bytes.byteLength };
    },
    async fsReadRange(path, offset, length) {
      const bytes = files.get(path);
      return bytes === undefined ? null : bytes.subarray(offset, offset + length);
    },
  };
  const configFor = (source, path) => {
    files.set(path, new TextEncoder().encode(source));
    return NimbusLoadedEntrypoint.prototype._residentCodeConfig.call(
      {},
      {
        compatibilityDate: '2026-04-01',
        compatibilityFlags: ['nodejs_compat'],
        mainModule: 'worker.js',
        modules: {},
        vfsTextModules: { 'worker.js': path },
      },
      supervisor,
    );
  };

  const honest = 'export default "the real program";';
  const honestPath = facetImagePath(await facetImageDigest(honest));
  const config = await configFor(honest, honestPath);
  assert.equal(config.modules['worker.js'], honest,
    'an image matching its digest is handed to the loader as the module source');
  assert.equal(config.mainModule, 'worker.js');

  // Same path, different bytes — the corruption content addressing exists to
  // catch. It must fail loud, naming the image, rather than boot.
  await assert.rejects(
    () => configFor('export default "not what was written";', honestPath),
    (e) => /does not match its digest/.test(e.message) && e.message.includes(honestPath),
    'an image that does not match the name it was fetched under is refused',
  );

  await assert.rejects(
    () => configFor('x', '/var/lib/nimbus/facet-images/not-a-digest.js'),
    /not a content-addressed facet image path/,
    'a module named by a path that carries no digest is refused rather than trusted',
  );
} finally {
  await rm(outputDir, { recursive: true, force: true });
}

console.log('resident-facet-image-store: ok');
