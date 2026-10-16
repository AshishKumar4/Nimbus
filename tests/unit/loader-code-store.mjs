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
//     reads them (A → B → C with A's put held: A goes once drained, B stays);
//     a removal that fails stays counted and is retried; a later
//     incarnation's registry sweeps what an earlier one left; content is
//     counted once however many directories share it, until the last goes;
//   - a process's envelope (pid, or an infrastructure binding's pid 0) is
//     refused the store.
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { importWorkerBundle } from './lib/worker-bundle.mjs';
import { createSqliteVfsTestHarness } from './lib/sqlite-vfs-test-harness.mjs';

const { NimbusLoaderRPC, NimbusLoadedWorker, NimbusLoadedEntrypoint, resolveLoadedEntrypoint, loaderHeapStats, SqliteVFS, loaderCodeRegistry, LOADER_CODE_ROOT, _rpcLoaderCodeStore, CRED_SESSION_USER } = await importWorkerBundle({
  'packages/fabric/src/bindings.ts': ['NimbusLoaderRPC', 'NimbusLoadedWorker', 'NimbusLoadedEntrypoint', 'resolveLoadedEntrypoint'],
  'packages/fabric/src/loader-heap.ts': ['loaderHeapStats'],
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
  const registry = loaderCodeRegistry(engine);
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
  const pair = [{}, {}, {}, {}];
  await assert.rejects(loader.load(worker({ 'w.js': '', 'many.json': { json: new Array(200_000).fill(pair) } })),
    /re-creating this Worker from the store would hold .* per-Worker bound/, 'one shared array written 200,000 times parses into a million objects: refused by its restored price');
  // One Error with a 12 MiB stack (6 Mi units) shared by three {json} modules: each stores as `{}`, and none could stay in the 8 MiB cache.
  const shared = new Error('shared'); shared.stack = 'z'.repeat(6 * MiB);
  const error = structuredClone(shared);
  assert.ok(await loader.load(worker({ 'w.js': '', 'a.json': { json: { error } }, 'b.json': { json: { error } }, 'c.json': { json: { error } } })),
    'a large shared source the cache cannot keep does not count against its re-creation');
  assert.ok(await loader.load(worker({ 'w.js': '', 'near.json': { json: new Array(200_000).fill({ a: 0 }) } })),
    'one small object written 200,000 times restores just under the bound (an object member is priced as one, an array element with its backing): admitted');
}

// ── Restored modules are cached for what they hold; text comes back as it went in ──
{
  const s = session(vfs());
  const token = s.registry.mint('wrangler-1', 'LOADER');
  s.registry.commit('wrangler-1', [token]);
  const { loader, missed } = shim(s, token);
  const boundary = 1024 * 1024;
  const crossing = 'a'.repeat(boundary - 1) + '\u{1F600}' + 'b';
  const kept = await loader.load(worker({ 'w.js': '\uFEFFexport default {};', 'many.json': { json: new Array(100_000).fill({}) }, 'pair.txt': { text: crossing } }));
  // Let the cache go: its 8 MiB taken by others' modules.
  for (let i = 0; i < 3; i++) await loader.load(worker({ 'w.js': '', 'fill.bin': { data: blob(3 * MiB, i) } }));
  const code = await missed(kept);
  assert.equal(code.modules['w.js'], '\uFEFFexport default {};', 'a leading U+FEFF is kept');
  assert.equal(code.modules['pair.txt'].text, crossing, 'a surrogate pair across the encoding slice is kept');
  assert.equal(code.modules['many.json'].json.length, 100_000);
  assert.ok(loaderHeapStats().moduleCacheBytes <= 8 * MiB, `the module cache holds at most its bound, restored graphs charged for what they hold: ${loaderHeapStats().moduleCacheBytes}`);
  // A near-bound {json}: 1 MiB of NUL characters (six to the escape when written, one when parsed) is admitted.
  assert.ok(await loader.load(worker({ 'w.js': '', 'nul.json': { json: '\u0000'.repeat(MiB) } })), 'a {json} string of 1 MiB NULs is admitted');
}

// ── Owners and content: retired bindings, accounting that waits for drains, content counted once, a destroyed session's new registry ──
{
  const engine = vfs();
  const s = session(engine);
  const first = s.registry.mint('wrangler-1', 'LOADER');
  s.registry.commit('wrangler-1', [first]);
  const shared = blob(2 * MiB, 9);
  await shim(s, first).loader.load(worker({ 'w.js': '', 'dep.bin': { data: shared } }));
  const second = s.registry.mint('wrangler-1', 'LOADER');
  s.registry.commit('wrangler-1', [second]);
  await shim(s, second).loader.load(worker({ 'w.js': '', 'dep.bin': { data: shared } }));
  assert.ok(s.registry.stats().storeBytes < 3 * MiB, `adopted content is counted once: ${s.registry.stats().storeBytes}`);
  const withShared = s.registry.stats().storeBytes;
  s.registry.release(first);
  await new Promise((resolve) => setTimeout(resolve, 50));
  assert.equal(s.registry.stats().storeBytes, withShared, 'content an adopter still holds stays counted once its putter is gone');
  s.registry.commit('wrangler-1', []);
  assert.equal(await s.registry.serve({ kind: 'alive', owner: second }), false, 'a binding the next build no longer has is retired');
  await new Promise((resolve) => setTimeout(resolve, 50));
  assert.equal(s.registry.stats().storeBytes, 0, 'and once no directory holds it, it is counted no more');

  // A binding named twice is the last one's: the earlier owner is retired, rebuild after rebuild.
  for (let build = 0; build < 3; build++) {
    const tokens = [s.registry.mint('wrangler-3', 'DUP'), s.registry.mint('wrangler-3', 'DUP')];
    s.registry.commit('wrangler-3', tokens);
  }
  assert.equal(s.registry.stats().owners, 2, 'one committed owner and one reuse source for the doubled binding, however many builds');
  s.registry.stop('wrangler-3');

  // A put admitted before its owner's release is accounted, and removed, once it drains.
  const third = s.registry.mint('wrangler-2', 'LOADER');
  const data = new TextEncoder().encode('held put');
  let push;
  const held = new ReadableStream({ start(controller) { push = controller; } });
  const putting = s.registry.serve({ kind: 'put', owner: third, digest: sha(data), size: data.byteLength }, held);
  await new Promise((resolve) => setTimeout(resolve, 10));
  s.registry.release(third);
  push.enqueue(data); push.close();
  await putting;
  await new Promise((resolve) => setTimeout(resolve, 50));
  assert.equal(s.registry.stats().removing, 0, 'the released owner\'s directory is removed once its put drained');
  assert.equal(s.registry.stats().storeBytes, 0, 'and its bytes given back once');

  // A put refused by its digest, and one joined, leave their streams cancelled.
  const fourth = s.registry.mint('wrangler-2', 'LOADER');
  let cancelled = 0;
  const cancelling = (bytes) => new ReadableStream({ start(controller) { controller.enqueue(bytes); }, cancel() { cancelled++; } });
  await s.registry.serve({ kind: 'put', owner: fourth, digest: 'not a digest', size: 1 }, cancelling(data)).catch(() => {});
  assert.equal(cancelled, 1, 'a refused put\'s stream is cancelled');
  let release;
  const slow = new ReadableStream({ start(controller) { release = () => { controller.enqueue(data); controller.close(); }; } });
  const firstPut = s.registry.serve({ kind: 'put', owner: fourth, digest: sha(data), size: data.byteLength }, slow);
  await new Promise((resolve) => setTimeout(resolve, 10));
  const joined = s.registry.serve({ kind: 'put', owner: fourth, digest: sha(data), size: data.byteLength }, cancelling(data));
  release();
  await Promise.all([firstPut, joined]);
  assert.equal(cancelled, 2, 'a put that joined another\'s creation has its own stream cancelled');

  // A destroyed session opens a new filesystem: a new registry, which knows no old token.
  const fresh = loaderCodeRegistry(vfs());
  assert.notEqual(fresh, s.registry);
  assert.equal(await fresh.serve({ kind: 'alive', owner: fourth }), false, 'an old incarnation\'s token is unknown to the new one');
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

// ── Two owners stopped together: both directories gone, nothing left counted ──
{
  const s = session(vfs());
  const a = s.registry.mint('wrangler-1', 'LOADER');
  const b = s.registry.mint('wrangler-1', 'OTHER');
  s.registry.commit('wrangler-1', [a, b]);
  await shim(s, a).loader.load(worker({ 'w.js': 'export default "a";' }));
  await shim(s, b).loader.load(worker({ 'w.js': 'export default "b";' }));
  s.registry.stop('wrangler-1');
  await new Promise((resolve) => setTimeout(resolve, 50));
  assert.deepEqual(s.engine.as({ uid: 0, gid: 0, groups: [0], umask: 0o022 }).readdir(LOADER_CODE_ROOT), []);
  assert.equal(s.registry.stats().storeBytes, 0, 'each owner\'s bytes given back once');
}

// ── A → B → C with A's put held: the slot ends C's with B its source, A gone once drained, B untouched ──
{
  const s = session(vfs());
  const kernel = s.engine.as({ uid: 0, gid: 0, groups: [0], umask: 0o022 });
  const a = s.registry.mint('wrangler-1', 'LOADER');
  s.registry.commit('wrangler-1', [a]);
  const data = new TextEncoder().encode('held across two commits');
  let push;
  const putting = s.registry.serve({ kind: 'put', owner: a, digest: sha(data), size: data.byteLength }, new ReadableStream({ start(controller) { push = controller; } }));
  await new Promise((resolve) => setTimeout(resolve, 10));
  const b = s.registry.mint('wrangler-1', 'LOADER');
  s.registry.commit('wrangler-1', [b]);
  await shim(s, b).loader.load(worker({ 'w.js': 'export default "b";' }));
  const c = s.registry.mint('wrangler-1', 'LOADER');
  s.registry.commit('wrangler-1', [c]);
  const dirs = kernel.readdir(LOADER_CODE_ROOT).length;
  assert.equal(dirs, 2, 'A\'s directory waits for its held put; B\'s is C\'s source');
  push.enqueue(data); push.close();
  await putting.catch(() => {});
  await new Promise((resolve) => setTimeout(resolve, 50));
  assert.equal(kernel.readdir(LOADER_CODE_ROOT).length, 1, 'A\'s directory is removed once drained, and B\'s stays');
  assert.deepEqual(await Promise.all([a, b, c].map((owner) => s.registry.serve({ kind: 'alive', owner }))), [false, false, true]);
  assert.deepEqual(s.registry.stats().sources, 1);
}

// ── A put of a digest a retired directory holds keeps the content counted when that directory goes ──
{
  const s = session(vfs());
  const a = s.registry.mint('wrangler-1', 'LOADER');
  const data = new Uint8Array(3 * MiB).fill(5);
  const digest = sha(data);
  await s.registry.serve({ kind: 'put', owner: a, digest, size: data.byteLength }, new ReadableStream({ start(c) { c.enqueue(data); c.close(); } }));
  assert.equal(s.registry.stats().storeBytes, 3 * MiB);
  // B, unable to adopt from retired A, sends the same bytes, held; A drains and goes meanwhile.
  const b = s.registry.mint('wrangler-2', 'LOADER');
  s.registry.release(a);
  let push;
  const putting = s.registry.serve({ kind: 'put', owner: b, digest, size: data.byteLength }, new ReadableStream({ start(controller) { push = controller; } }));
  await new Promise((resolve) => setTimeout(resolve, 50));
  assert.equal(s.registry.stats().removing, 0, 'A is gone');
  assert.equal(s.registry.stats().storeBytes, 3 * MiB, 'its content stays counted for the put in flight');
  push.enqueue(data); push.close();
  await putting;
  assert.equal(s.registry.stats().storeBytes, 3 * MiB, 'and once published, counted once');
  // The same race where the put fails: nothing then holds the content, and it is given back.
  const c = s.registry.mint('wrangler-3', 'LOADER');
  const failing = s.registry.serve({ kind: 'put', owner: c, digest, size: data.byteLength }, new ReadableStream({ start(controller) { push = controller; } }));
  s.registry.release(b);
  await new Promise((resolve) => setTimeout(resolve, 50));
  push.error(new Error('the producer failed'));
  await failing.catch(() => {});
  await new Promise((resolve) => setTimeout(resolve, 20));
  assert.equal(s.registry.stats().storeBytes, 0, 'a failed put with nothing holding its content gives the charge back');
  assert.equal(s.registry.stats().putting, 0);
}

// ── A removal that fails stays counted, and is tried again at the next ──
{
  const s = session(vfs());
  const kernel = s.engine.as({ uid: 0, gid: 0, groups: [0], umask: 0o022 });
  const stuck = s.registry.mint('wrangler-1', 'LOADER');
  s.registry.commit('wrangler-1', [stuck]);
  await shim(s, stuck).loader.load(worker({ 'w.js': 'export default "stuck";' }));
  const [dir] = kernel.readdir(LOADER_CODE_ROOT);
  const counted = s.registry.stats().storeBytes;
  // Its directory no longer writable by the store: its files cannot be unlinked.
  kernel.chmod(`${LOADER_CODE_ROOT}/${dir.name}`, 0o500);
  s.registry.stop('wrangler-1');
  await new Promise((resolve) => setTimeout(resolve, 50));
  assert.equal(s.registry.stats().removing, 1, 'the failed removal stays queued');
  assert.equal(s.registry.stats().storeBytes, counted, 'and its content counted');
  kernel.chmod(`${LOADER_CODE_ROOT}/${dir.name}`, 0o700);
  const next = s.registry.mint('wrangler-2', 'LOADER');
  await shim(s, next).loader.load(worker({ 'w.js': 'export default "next";' }));
  s.registry.release(next);
  await new Promise((resolve) => setTimeout(resolve, 50));
  assert.equal(s.registry.stats().removing, 0, 'the next removal tries it again, and both are gone');
  assert.equal(s.registry.stats().storeBytes, 0);
  assert.deepEqual(kernel.readdir(LOADER_CODE_ROOT), []);
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
}

// ── A new incarnation's registry sweeps what an old one left ──
{
  const harness = createSqliteVfsTestHarness();
  const engine = new SqliteVFS(harness.sql, harness.ctx);
  const old = loaderCodeRegistry(engine);
  const token = old.mint('wrangler-1', 'LOADER');
  const data = new TextEncoder().encode('left behind');
  await old.serve({ kind: 'put', owner: token, digest: sha(data), size: data.byteLength }, new ReadableStream({ start(c) { c.enqueue(data); c.close(); } }));
  const reopened = new SqliteVFS(harness.sql, harness.ctx);
  loaderCodeRegistry(reopened);
  await new Promise((resolve) => setTimeout(resolve, 50));
  assert.equal(reopened.as({ uid: 0, gid: 0, groups: [0], umask: 0o022 }).readdir(LOADER_CODE_ROOT).length, 0, 'the next incarnation over the same storage sweeps what the old one left');
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
