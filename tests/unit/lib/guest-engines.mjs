/**
 * The two in-guest filesystem engines a process can run on, booted over one
 * session double, so a scenario written once runs against each:
 *   - `node`: the node shim's (node-shims.ts and vfs-write-ledger.ts), the
 *     process a resident facet runs, driven through its own `fs`;
 *   - `holder`: the WASI body's (core runtime/wasi/resident-filesystem.ts and
 *     delegation-holder.ts), the filesystem __wasiFilesystem gives a guest
 *     that can park, called as its codec calls it.
 * Both speak to the same session (createAuthority) through the same facet
 * supervisor (facetSupervisor), whose waves can be stalled and counted and
 * whose grants are watched, and log into the same kind of facet store.
 *
 * A scenario sees the engine as `RuntimeFsBridge` (os-contracts.ts), the
 * runtime filesystem contract: the holder is one, and the node shim's `fs` is
 * adapted to it here (nodeBridge), Node's call for each method. Stats come
 * back normalized (`stat`), directory listings as sorted names.
 *
 * Directory note: under tests/unit/lib/ so the suite does not run it as a test.
 */

import { rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { WASI_INSTANCE_PREAMBLE_SRC } from '../../../packages/core/src/runtime/wasi-instance.ts';
import { journalSource, sqlJournal } from '../../../packages/core/src/_shared/process-fs-client.ts';
import { PortRegistry } from '../../../packages/core/src/runtime/port-registry.ts';
import { assumeGeneration } from '../../../packages/fabric/src/generation.ts';
import { FacetManager } from '../../../packages/worker/src/facets/manager.ts';
import { createFacetCtx, createFacetWorld } from './facet-host-harness.mjs';
import { CRED, createAuthority, facetSql, facetSupervisor, launchResident, sleep, until } from './resident-body.mjs';

export const ENGINES = ['node', 'holder'];

/** The process's project directory: the session user's own, where it writes. */
export const APP = '/home/user/app';

const enc = new TextEncoder();
const dec = new TextDecoder();

/** A process that only lends its `fs` to the test, and stays up; attached to its input, it counts what arrives. */
const NODE_PROGRAM = `
globalThis.__engineFs = require("fs");
globalThis.__engineInputs = 0;
if (process.env.NIMBUS_CP_CHILD_PID) process.stdin.on("data", () => { globalThis.__engineInputs++; });
require("http").createServer((q, s) => s.end("up")).listen(3000);
`;

/** What a scenario reads of a stat, whichever engine answered it. */
export function stat(raw) {
  if (raw === null || raw === undefined) return null;
  const type = typeof raw.isDirectory === 'function'
    ? (raw.isDirectory() ? 'directory' : raw.isSymbolicLink() ? 'symlink' : 'file')
    : raw.type;
  return {
    type,
    mode: Number(raw.mode) & 0o7777,
    uid: Number(raw.uid),
    gid: Number(raw.gid),
    size: Number(raw.size),
    ino: Number(raw.ino),
    nlink: Number(raw.nlink),
    mtimeMs: Number(raw.mtimeMs ?? raw.mtime),
  };
}

/** Node's open flags for RuntimeOpenFlags. */
function nodeFlags(flags) {
  const append = flags.append === true;
  const write = flags.write === true || append;
  let text = write ? (append ? 'a' : 'w') : 'r';
  if (write && flags.read === true) text = append ? 'a+' : flags.truncate || flags.create ? 'w+' : 'r+';
  if (write && !flags.create && !append && flags.read !== true) text = 'r+';
  if (flags.exclusive) text += 'x';
  return text;
}

/**
 * The node shim's `fs` as RuntimeFsBridge: each method Node's own call. A
 * descriptor is a FileHandle (fs.promises.open), named by its fd.
 */
function nodeBridge(fs) {
  const fsp = fs.promises;
  const handles = new Map();
  const handle = (id) => {
    const found = handles.get(id);
    if (found === undefined) throw Object.assign(new Error(`EBADF: ${id}`), { code: 'EBADF' });
    return found;
  };
  return {
    stat: async (path, options) => (options?.followSymlinks === false ? fsp.lstat(path) : fsp.stat(path)),
    readFile: async (path) => new Uint8Array(await fsp.readFile(path)),
    writeFile: async (path, bytes, options) => fsp.writeFile(path, bytes, options?.mode === undefined ? undefined : { mode: options.mode }),
    chmod: async (path, mode) => fsp.chmod(path, mode),
    chown: async (path, uid, gid, options) => (options?.followSymlinks === false ? fsp.lchown(path, uid, gid) : fsp.chown(path, uid, gid)),
    utimes: async (path, atimeMs, mtimeMs, options) => (options?.followSymlinks === false
      ? fsp.lutimes(path, atimeMs / 1000, mtimeMs / 1000)
      : fsp.utimes(path, atimeMs / 1000, mtimeMs / 1000)),
    copyFile: async (from, to) => fsp.copyFile(from, to),
    mkdir: async (path, options) => { await fsp.mkdir(path, options); },
    unlink: async (path) => fsp.unlink(path),
    rmdir: async (path) => fsp.rmdir(path),
    rename: async (from, to) => fsp.rename(from, to),
    symlink: async (target, path) => fsp.symlink(target, path),
    readlink: async (path) => fsp.readlink(path),
    readdir: async (path) => (await fsp.readdir(path)).map((name) => ({ name })),
    open: async (path, flags) => {
      const opened = await fsp.open(path, nodeFlags(flags), flags.mode);
      handles.set(opened.fd, opened);
      return { id: opened.fd };
    },
    read: async (id, offset, length) => {
      const buffer = new Uint8Array(length);
      const { bytesRead } = await handle(id).read(buffer, 0, length, offset);
      return buffer.subarray(0, bytesRead);
    },
    write: async (id, offset, bytes) => (await handle(id).write(bytes, 0, bytes.byteLength, offset)).bytesWritten,
    fstat: async (id) => handle(id).stat(),
    ftruncate: async (id, size) => handle(id).truncate(size),
    fchmod: async (id, mode) => handle(id).chmod(mode),
    fchown: async (id, uid, gid) => handle(id).chown(uid, gid),
    futimes: async (id, atimeMs, mtimeMs) => handle(id).utimes(atimeMs / 1000, mtimeMs / 1000),
    fsync: async (id) => (id === undefined ? undefined : handle(id).sync()),
    close: async (id) => { await handle(id).close(); handles.delete(id); },
  };
}

/**
 * The node shim's synchronous `fs` as RuntimeSynchronousFs: each method
 * Node's own *Sync call, a descriptor its fd.
 */
function nodeSyncBridge(fs) {
  const absent = (stat) => {
    try { return stat(); } catch (error) { if (error?.code === 'ENOENT') return null; throw error; }
  };
  return {
    stat: (path, options) => absent(() => (options?.followSymlinks === false ? fs.lstatSync(path) : fs.statSync(path))),
    readFile: (path) => new Uint8Array(fs.readFileSync(path)),
    writeFile: (path, bytes) => { fs.writeFileSync(path, bytes); },
    chmod: (path, mode) => fs.chmodSync(path, mode),
    chown: (path, uid, gid) => fs.chownSync(path, uid, gid),
    utimes: (path, atimeMs, mtimeMs) => fs.utimesSync(path, atimeMs / 1000, mtimeMs / 1000),
    copyFile: (from, to) => fs.copyFileSync(from, to),
    mkdir: (path, options) => { fs.mkdirSync(path, options); },
    unlink: (path) => fs.unlinkSync(path),
    rmdir: (path) => fs.rmdirSync(path),
    rename: (from, to) => fs.renameSync(from, to),
    symlink: (target, path) => fs.symlinkSync(target, path),
    readlink: (path) => fs.readlinkSync(path),
    readdir: (path) => fs.readdirSync(path).map((name) => ({ name })),
    open: (path, flags) => {
      const { O_RDONLY, O_WRONLY, O_RDWR, O_CREAT, O_TRUNC, O_APPEND, O_EXCL } = fs.constants;
      const write = flags.write === true || flags.append === true;
      const access = write ? (flags.read === true ? O_RDWR : O_WRONLY) : O_RDONLY;
      const bits = access | (flags.create ? O_CREAT : 0) | (flags.truncate ? O_TRUNC : 0) | (flags.append ? O_APPEND : 0) | (flags.exclusive ? O_EXCL : 0);
      return { id: fs.openSync(path, bits, flags.mode) };
    },
    read: (id, offset, length) => {
      const buffer = new Uint8Array(length);
      return buffer.subarray(0, fs.readSync(id, buffer, 0, length, offset));
    },
    write: (id, offset, bytes) => fs.writeSync(id, bytes, 0, bytes.byteLength, offset),
    fstat: (id) => fs.fstatSync(id),
    ftruncate: (id, size) => fs.ftruncateSync(id, size),
    fsync: (id) => (id === undefined ? undefined : fs.fsyncSync(id)),
    close: (id) => fs.closeSync(id),
  };
}

/** The WASI body's own filesystem for a guest that parks, over `supervisor`, as a facet's body builds it. */
async function holderBridge(supervisor) {
  const modulePath = join(tmpdir(), `guest-engine-holder-${process.pid}-${Math.random().toString(16).slice(2)}.mjs`);
  writeFileSync(modulePath, `${WASI_INSTANCE_PREAMBLE_SRC}\nexport { __wasiInitFS, __wasiAdoptSupervisor, __wasiFilesystem, __wasiPrepareFilesystem };`);
  let P;
  try { P = await import(pathToFileURL(modulePath).href); } finally { rmSync(modulePath, { force: true }); }
  P.__wasiInitFS({ root: '', preopens: [{ wasiPath: '/', vfsPath: '' }], cred: CRED });
  P.__wasiAdoptSupervisor(supervisor);
  const fs = P.__wasiFilesystem('jspi');
  if (fs === null || typeof fs.holding !== 'function') throw new Error('the WASI body gave no resident filesystem (no JSPI here?)');
  await P.__wasiPrepareFilesystem([]);
  // A codec awaits each call: one that refuses at once is a rejection, as Node's is.
  // A copy is copyfile(3)'s, as Node's fs.copyFile makes it (libuv): its mode kept.
  return new Proxy(fs, {
    get: (target, name) => (name === 'copyFile' ? async (from, to) => target.copyFile(from, to, { keepMode: true })
      : typeof target[name] === 'function' ? async (...args) => target[name](...args) : target[name]),
  });
}

/** Whether `work` settles while the session answers no wave (a timer of the host's, which no barrier holds). */
export const answeredAtOnce = (work) => Promise.race([Promise.resolve(work).then(() => 'answered'), sleep(50).then(() => 'waiting')]);

/**
 * A process on engine `kind` over a new session, its project at APP. `seed`
 * makes what the session holds before the process starts (authority).
 * `supervise` wraps the facet's supervisor calls it names: each is called
 * with the call as the session answers it (`call(args)`) and its arguments,
 * and answers in its place (schedule-transport.mjs). `stdin`: Node's
 * process is attached to the session's input store, and its input (`input`)
 * is a keystroke, delivered with the ACQUIRE the session computes for it.
 * @param {string} kind
 * @param {{ seed?: (authority: any) => void, supervise?: Record<string, (call: (args: any[]) => Promise<any>, args: any[]) => Promise<any>>, stdin?: boolean }} [options]
 */
export async function bootEngine(kind, { seed, supervise = {}, stdin = false } = {}) {
  if (!ENGINES.includes(kind)) throw new Error(`no engine ${kind}`);
  const authority = createAuthority(undefined, { sequenced: true });
  authority.kfs.mkdir('home/user/app', { recursive: true, mode: 0o755 });
  seed?.(authority);
  let stalled = null;
  let waves = 0;
  /** Waves sent and not yet answered. */
  let unanswered = 0;
  let listingFails = false;
  const grants = new Map();
  let forward;
  const own = {
    writeBatchStream: async (...args) => {
      waves++;
      unanswered++;
      try {
        if (stalled !== null) await stalled.promise;
        return await forward('writeBatchStream', args);
      } finally {
        unanswered--;
      }
    },
    fsAcquireExclusiveMutation: async (...args) => {
      const granted = await forward('fsAcquireExclusiveMutation', args);
      if (typeof granted?.owner === 'string') grants.set(granted.owner, granted.root);
      return granted;
    },
    fsReleaseExclusiveMutation: async (owner, ...rest) => {
      grants.delete(owner);
      return forward('fsReleaseExclusiveMutation', [owner, ...rest]);
    },
    fsList: async (...args) => {
      if (listingFails) throw new Error('Network connection lost.');
      return forward('fsList', args);
    },
  };
  for (const [name, wrap] of Object.entries(supervise)) {
    const base = own[name] ?? ((...args) => forward(name, args));
    own[name] = (...args) => wrap((asked) => base(...asked), args);
  }
  const handle = facetSupervisor(authority, own);
  forward = handle.forward;
  // The facet's own store, where the process logs what it sends (process-fs-journal.ts).
  const sql = facetSql();
  let fs;
  let sync;
  if (kind === 'node') {
    if (stdin) authority.host.processes.openInput(handle.log.pid);
    await launchResident({
      authority, program: NODE_PROGRAM, env: { SUPERVISOR: handle.supervisor }, sql, cursor: authority.cursor(), cwd: APP,
      processEnv: stdin ? { NIMBUS_CP_CHILD_PID: String(handle.log.pid) } : {},
    });
    await until(() => globalThis.__engineFs !== undefined, 'the process lends its fs');
    fs = nodeBridge(globalThis.__engineFs);
    sync = nodeSyncBridge(globalThis.__engineFs);
  } else {
    globalThis.__nimbusFsJournalSql = sql;
    fs = await holderBridge(handle.supervisor);
    // As the codec calls the synchronous view: its own copies keep their mode.
    sync = new Proxy(fs.synchronous, { get: (target, name) => (name === 'copyFile' ? (from, to) => target.copyFile(from, to, { keepMode: true }) : target[name]) });
  }
  const engine = {
    kind,
    authority,
    fs,
    /** The same filesystem for a caller that cannot wait (RuntimeSynchronousFs): Node's *Sync calls; the holder's synchronous view. */
    sync,
    /** An awaited read of a descriptor `sync` opened: Node's fs.read of its fd; the holder's read of its id. */
    readFd: (id, offset, length) => (kind === 'node'
      ? new Promise((resolve, reject) => {
        const buffer = new Uint8Array(length);
        globalThis.__engineFs.read(id, buffer, 0, length, offset, (error, read) => (error ? reject(error) : resolve(buffer.subarray(0, read))));
      })
      : fs.read(id, offset, length)),
    log: handle.log,
    /** The process's log store, as a drain reads it. */
    journal: () => sqlJournal(sql),
    /** Waves sent so far. */
    waves: () => waves,
    stall: () => { stalled = Promise.withResolvers(); },
    release: async () => { const was = stalled; stalled = null; was?.resolve(); await sleep(0); },
    failListings: (fails) => { listingFails = fails; },
    /**
     * Input from outside the process arrived, and its barrier has landed:
     * Node's keystroke, once its handler ran (attached), else its resumption
     * barrier; the holder's owed one, taken by its next awaited call.
     */
    input: async () => {
      if (kind === 'node' && stdin) {
        const handled = globalThis.__engineInputs + 1;
        authority.host.processes.writeInput(handle.log.pid, 'x');
        while (globalThis.__engineInputs < handled) await sleep(2);
        return undefined;
      }
      if (kind === 'node') return globalThis.__nimbusVfsAcquireBarrier();
      fs.inbound();
      await fs.stat(APP);
    },
    /** Whether the session has given this process `path`'s subtree (a grant it has not given back). */
    held: (path) => {
      const key = path.replace(/^\/+/, '');
      return [...grants.values()].some((root) => key === root || key.startsWith(`${root}/`));
    },
    /** Something leaves the process: what it wrote reaches the session first (Node's release barrier; the holder's flush). */
    publish: async () => (kind === 'node' ? globalThis.__nimbusVfsReleaseBarrier() : fs.flush()),
    /** Write files in `dir` until the session gives the process its subtree, as a program that writes there often does. */
    async hold(dir) {
      await fs.mkdir(dir, { recursive: true, mode: 0o755 });
      for (let i = 0; i < 64 && !engine.held(`${dir}/x`); i++) await engine.write(`${dir}/.warm${i}`, 'w');
      await until(() => engine.held(`${dir}/x`), `${kind} holds ${dir}`, 5_000);
    },
    /** What the process's view says of `path`: null where nothing is. */
    stat: async (path, options) => stat(await fs.stat(path, options).catch((error) => { if (error?.code === 'ENOENT') return null; throw error; })),
    text: async (path) => dec.decode(await fs.readFile(path)),
    /** Write a file as each engine's guest writes one: Node's writeFile; a WASI guest's open, write and close. */
    write: async (path, text, mode) => {
      if (kind === 'node') return fs.writeFile(path, enc.encode(text), mode === undefined ? undefined : { mode });
      const opened = await fs.open(path, { write: true, create: true, truncate: true, mode: mode ?? 0o666 });
      try { await fs.write(opened.id, null, enc.encode(text)); } finally { await fs.close(opened.id); }
    },
    /**
     * The process ends as the session ends a resident (FacetManager): by a
     * kill, or by its own exit. Its facet is released and the session drains
     * its write log as it does for any resident; the guest is not asked to
     * flush first. `refused`: the waves it has on their way reach the
     * session (stalled until then) once it has ended the process, and are
     * answered before the facet settles.
     */
    async end(how = 'kill', { twice = false, refused = false } = {}) {
      const name = `guest-engine-${kind}`;
      const ctx = createFacetCtx(createFacetWorld(() => ({})), name);
      Reflect.set(ctx.storage, 'sql', Reflect.get(authority.rawVfs, 'sql'));
      assumeGeneration(ctx, 1);
      // Its process host: the facet this engine runs in, released as the fabric releases one.
      const host = {
        async open(params) {
          params.journal.opened(name);
          return {
            started: Promise.resolve({ ok: true }),
            lost: new Promise(() => {}),
            // As the facet host releases a resident: it settles first (the
            // host adapter's settle, its runtime's __nimbusSettle), then its
            // log is drained. `twice`: the session drains it twice at once
            // (one joins the other).
            release: async () => {
              if (refused) {
                await engine.release();
                await until(() => unanswered === 0, 'its waves answered');
                await sleep(0);
              }
              // A settle that fails leaves its log as it is (the host's).
              try { globalThis.__nimbusSettle?.(); } catch { /* as it is */ }
              const drain = () => params.journal.drain(journalSource(engine.journal()));
              await (twice ? Promise.all([drain(), drain()]) : drain());
            },
            describe: () => name,
          };
        },
      };
      const manager = /** @type {any} */ (new FacetManager(ctx, { LOADER: { load() {}, get() {} } }, authority.host.processes, new PortRegistry(), () => /** @type {any} */ (host)));
      manager.setVfs(authority.rawVfs, authority.files);
      const resident = await manager.processFabric.startResidentProcess({
        pid: handle.log.pid, startContract: 'boot', workerKey: name, boot: { kind: 'code', code: {} }, journaled: true,
        onWriterActivated() {}, onWriterRetired() {},
      });
      manager.trackProcessRpcResources(handle.log.pid, [resident]);
      if (how === 'exit') manager.finishProcess(handle.log.pid, 0);
      else manager.kill(handle.log.pid);
      await resident.done;
    },
    /** What the session holds at `path`, read as a peer reads it (recalling what the process holds there). */
    peerStat: async (path, options) => stat(options?.followSymlinks === false ? await authority.peer.lstat(path.slice(1)) : await authority.peer.stat(path.slice(1))),
    peerText: async (path) => dec.decode(await authority.peer.readFile(path.slice(1))),
  };
  return engine;
}

/**
 * The ledger's runner: each scenario against each engine, in a child process
 * of its own (runScenarios), named `<scenario> [<engine>]`. `gaps` names the
 * runs a scenario is known to fail, each with what the engine lacks: a gap
 * must fail, and a gap that passes fails the ledger (the engine has it now:
 * the gap is removed). Every other run must pass.
 */
export function ledgerScenarios(scenarios) {
  const runs = {};
  for (const [name, body] of Object.entries(scenarios)) {
    for (const kind of ENGINES) runs[`${name} [${kind}]`] = async () => body(await bootEngine(kind));
  }
  return runs;
}
