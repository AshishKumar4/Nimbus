#!/usr/bin/env bun
// The Worker Loader shim's code, kept in the owning session's store (FAB-2
// step 2, loader-code-store-design-r7.md), through the shim and the session's
// registry over a real SqliteVFS (the host op's transport stubbed: one call):
//
//   - a Worker is durable before its handle is returned, and a module the
//     shim's cache let go (one over its 8 MiB holds none) is read back on a
//     native miss, as it was loaded;
//   - the audit's case: seven 20 MiB Workers loaded, the shim's heap keeps at
//     most its caches, and each is re-created from the store;
//   - a rebuild adopts its unchanged modules from its binding's reuse source
//     and sends none of them again; the store's files are its own uid's, out
//     of the session user's reach;
//   - a retired build's Worker is never re-created, even one the shim's cache
//     still holds whole;
//   - a {json} module whose parse makes more than the shim's bound (a shared
//     object written many times) is refused before its handle is returned;
//   - a put of bytes that are not what its digest names publishes nothing;
//     the owner's file cap refuses a further file by name;
//   - a stopped server's owners and reuse sources are removed once nothing
//     reads them; a later incarnation's registry sweeps what an earlier one
//     left;
//   - a process's envelope (pid, or an infrastructure binding's pid 0) is
//     refused the store.
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { importWorkerBundle } from './lib/worker-bundle.mjs';
import { createSqliteVfsTestHarness } from './lib/sqlite-vfs-test-harness.mjs';

const { NimbusLoaderRPC, NimbusLoadedWorker, NimbusLoadedEntrypoint, resolveLoadedEntrypoint, SqliteVFS, loaderCodeRegistry, LOADER_CODE_ROOT, _rpcLoaderCodeStore, CRED_SESSION_USER } = await importWorkerBundle({
  'packages/fabric/src/bindings.ts': ['NimbusLoaderRPC', 'NimbusLoadedWorker', 'NimbusLoadedEntrypoint', 'resolveLoadedEntrypoint'],
  'packages/core/src/vfs/sqlite-vfs.ts': ['SqliteVFS'],
  'packages/worker/src/wrangler/loader-code-store.ts': ['loaderCodeRegistry', 'LOADER_CODE_ROOT'],
  'packages/worker/src/session/rpc.ts': ['_rpcLoaderCodeStore'],
  'packages/core/src/runtime/os-contracts.ts': ['CRED_SESSION_USER'],
});

const MiB = 1024 * 1024;
const sha = (bytes) => createHash('sha256').update(bytes).digest('hex');

/** A session: its VFS, its incarnation's registry, and the host namespace its shim's store calls reach. */
function session(engine) {
  const ctx = {};
  const registry = loaderCodeRegistry(ctx, engine);
  const calls = [];
  const host = {
    supervisorOp(envelope) {
      calls.push(envelope.args[0].kind);
      return _rpcLoaderCodeStore({ ctx, sqliteFs: engine, ensureSqliteFs() {} }, envelope.args[0], envelope.stream, envelope.pid);
    },
  };
  const env = { TEST_NS: { idFromName: (name) => name, idFromString: (id) => id, get: () => host } };
  return { ctx, engine, registry, calls, env };
}
function vfs() {
  const harness = createSqliteVfsTestHarness();
  return new SqliteVFS(harness.sql, harness.ctx);
}

/** A shim for owner `token` of `s`, over a native loader that keeps nothing. */
function shim(s, token) {
  const native = { gets: [] };
  const stub = { getEntrypoint: () => ({ fetch: async () => new Response('ok') }) };
  const env = { ...s.env, LOADER: { load: () => stub, get(key, callback) { native.gets.push(Promise.resolve().then(callback)); return stub; } } };
  const exports = {
    NimbusLoadedWorker({ props }) { return Object.assign(Object.create(NimbusLoadedWorker.prototype), { ctx: { props, exports }, env }); },
    NimbusLoadedEntrypoint({ props }) { return Object.assign(Object.create(NimbusLoadedEntrypoint.prototype), { ctx: { props, exports }, env }); },
  };
  const store = { doId: 'session', route: { supervisorEntrypoint: 'SupervisorRPC', hostNamespace: 'TEST_NS', hostDispatchMethod: 'supervisorOp' }, owner: token };
  const loader = Object.assign(Object.create(NimbusLoaderRPC.prototype), { ctx: { props: { depth: 1, namespace: `ns-${token}`, store }, exports }, env });
  return {
    loader,
    /** The code a native miss re-creates for `loaded`'s Worker. */
    async missed(loaded) {
      await resolveLoadedEntrypoint(loaded.getEntrypoint());
      return native.gets.at(-1);
    },
  };
}
const worker = (modules) => ({ compatibilityDate: '2026-09-26', mainModule: Object.keys(modules)[0], modules });
const blob = (bytes, fill) => { const data = new Uint8Array(bytes); data.fill(fill); return data.buffer; };

// ── A module over the shim's cache, read back from the store on a native miss ──
{
  const s = session(vfs());
  const token = s.registry.mint('wrangler-1', 'LOADER');
  s.registry.commit('wrangler-1', [token]);
  const { loader, missed } = shim(s, token);
  const big = blob(12 * MiB, 7);
  const loaded = await loader.load(worker({ 'w.js': 'export default {};', 'big.bin': { data: big } }));
  const code = await missed(loaded);
  assert.equal(sha(new Uint8Array(code.modules['big.bin'].data)), sha(new Uint8Array(big)), 'a 12 MiB module the cache cannot hold is re-created from the store, byte for byte');
  assert.equal(code.modules['w.js'], 'export default {};');
}

// ── The audit's case: seven 20 MiB Workers, kept in the store, each re-created ──
{
  const s = session(vfs());
  const token = s.registry.mint('wrangler-1', 'LOADER');
  s.registry.commit('wrangler-1', [token]);
  const { loader, missed } = shim(s, token);
  const handles = [];
  const refs = [];
  for (let i = 0; i < 7; i++) {
    await (async () => {
      const data = blob(20 * MiB, i + 1);
      refs.push(new WeakRef(data));
      handles.push(await loader.load(worker({ 'w.js': `export default ${i};`, 'blob.bin': { data } })));
    })();
  }
  for (let i = 0; i < 5; i++) Bun.gc(true);
  assert.ok(refs.filter((ref) => ref.deref() !== undefined).length <= 1, 'the shim keeps at most its caches of seven 20 MiB Workers');
  for (let i = 0; i < 7; i++) {
    const code = await missed(handles[i]);
    assert.equal(new Uint8Array(code.modules['blob.bin'].data)[0], i + 1, `Worker ${i} is re-created from the store`);
  }
}

// ── A rebuild adopts its unchanged modules; the store's files are out of the session user's reach ──
{
  const s = session(vfs());
  const first = s.registry.mint('wrangler-1', 'LOADER');
  s.registry.commit('wrangler-1', [first]);
  const shared = blob(2 * MiB, 3);
  await shim(s, first).loader.load(worker({ 'w.js': 'export default 1;', 'dep.bin': { data: shared } }));
  const second = s.registry.mint('wrangler-1', 'LOADER');
  s.registry.commit('wrangler-1', [second]);
  s.calls.length = 0;
  const { loader, missed } = shim(s, second);
  const loaded = await loader.load(worker({ 'w.js': 'export default 2;', 'dep.bin': { data: shared } }));
  assert.equal(s.calls.filter((kind) => kind === 'put').length, 1, 'only the changed module is sent; the unchanged one is adopted from the reuse source');
  assert.equal(new Uint8Array((await missed(loaded)).modules['dep.bin'].data)[0], 3, 'and the adopted one re-creates the Worker');
  const user = s.engine.as(CRED_SESSION_USER);
  assert.throws(() => user.readdir(LOADER_CODE_ROOT), { code: 'EACCES' }, 'the session user cannot list the store');
}

// ── A retired build's Worker is never re-created, even one the cache holds whole ──
{
  const s = session(vfs());
  const first = s.registry.mint('wrangler-1', 'LOADER');
  s.registry.commit('wrangler-1', [first]);
  const { loader, missed } = shim(s, first);
  const loaded = await loader.load(worker({ 'w.js': 'export default "small";' }));
  s.registry.commit('wrangler-1', [s.registry.mint('wrangler-1', 'LOADER')]);
  await assert.rejects(missed(loaded), /loader binding was retired/, 'its owner retired by the next commit');
}

// ── A {json} module that parses into more than the shim's bound is refused before its handle ──
{
  const s = session(vfs());
  const token = s.registry.mint('wrangler-1', 'LOADER');
  s.registry.commit('wrangler-1', [token]);
  const { loader } = shim(s, token);
  await assert.rejects(loader.load(worker({ 'w.js': '', 'many.json': { json: new Array(800_000).fill({}) } })),
    /re-creating this Worker from the store would hold .* per-Worker bound/, 'one shared object written 800,000 times parses into 800,000: refused by its restored price');
}

// ── Puts that are not what they name, or past the owner's file cap, publish nothing ──
{
  const s = session(vfs());
  const token = s.registry.mint('wrangler-1', 'LOADER');
  const bytes = new TextEncoder().encode('honest bytes');
  const stream = (data) => new ReadableStream({ start(controller) { controller.enqueue(data); controller.close(); } });
  await assert.rejects(s.registry.serve({ kind: 'put', owner: token, digest: sha(new TextEncoder().encode('other')), size: bytes.byteLength }, stream(bytes)),
    /not what digest .* names/, 'bytes that are not what their digest names are refused');
  assert.deepEqual(await s.registry.serve({ kind: 'has', owner: token, digests: [sha(new TextEncoder().encode('other'))] }), [], 'and nothing was published');
  for (let i = 0; i < 16_384; i++) {
    const data = new TextEncoder().encode(String(i));
    await s.registry.serve({ kind: 'put', owner: token, digest: sha(data), size: data.byteLength }, stream(data));
  }
  const more = new TextEncoder().encode('one more');
  await assert.rejects(s.registry.serve({ kind: 'put', owner: token, digest: sha(more), size: more.byteLength }, stream(more)),
    /would hold 16385 files/, 'the owner\'s 16,385th file is refused by name');
}

// ── Stop removes a server's directories once drained; a new incarnation sweeps what an old one left ──
{
  const engine = vfs();
  const s = session(engine);
  const token = s.registry.mint('wrangler-1', 'LOADER');
  s.registry.commit('wrangler-1', [token]);
  await shim(s, token).loader.load(worker({ 'w.js': 'export default {};' }));
  const left = s.registry.mint('wrangler-2', 'LOADER');
  await shim(s, left).loader.load(worker({ 'w.js': 'export default 9;' }));
  const kernel = engine.as({ uid: 0, gid: 0, groups: [0], umask: 0o022 });
  assert.equal(kernel.readdir(LOADER_CODE_ROOT).length, 2);
  s.registry.stop('wrangler-1');
  await new Promise((resolve) => setTimeout(resolve, 50));
  assert.equal(kernel.readdir(LOADER_CODE_ROOT).length, 1, 'the stopped server\'s directory is removed');
  session(engine);
  await new Promise((resolve) => setTimeout(resolve, 50));
  assert.equal(kernel.readdir(LOADER_CODE_ROOT).length, 0, 'a new incarnation sweeps what the old one left');
}

// ── A process's envelope is refused the store ──
{
  const s = session(vfs());
  const token = s.registry.mint('wrangler-1', 'LOADER');
  for (const pid of [42, 0]) {
    await assert.rejects(_rpcLoaderCodeStore({ ctx: s.ctx, sqliteFs: s.engine, ensureSqliteFs() {} }, { kind: 'alive', owner: token }, undefined, pid),
      /EPERM/, `an envelope with pid ${pid} is refused`);
  }
}

console.log('loader-code-store: ok');
