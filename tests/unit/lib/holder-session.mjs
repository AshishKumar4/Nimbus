// A process's resident filesystem over a real session in process
// (ProcessFiles over SqliteVFS), its delegation holder's session double
// controllable: what the tests of the holder and its provisional decisions
// run against.
import { CRED_KERNEL } from '../../../packages/core/src/runtime/os-contracts.ts';
import { ProcessFiles } from '../../../packages/core/src/runtime/process-files.ts';
import { residentFilesystem } from '../../../packages/core/src/runtime/wasi/resident-filesystem.ts';
import { SqliteVFS } from '../../../packages/core/src/vfs/sqlite-vfs.ts';
import { createSqliteVfsTestHarness } from './sqlite-vfs-test-harness.mjs';

/** The process's principal. */
export const user = { uid: 1000, gid: 1000, groups: [1000], umask: 0o022 };

/**
 * A process over a real session. `view`: its store is a view as a resident's
 * is, what it read of a name kept as read until a barrier reads it again
 * (`view.barrier` runs after); else the store reads the session at every
 * call. `acquired`: what the session's grant waits for. `grantBytes`: the
 * storage a grant reserves.
 * @param {{ grantInos?: number, journal?: any, gate?: PromiseLike<unknown>, refuse?: () => boolean, view?: { barrier?: () => unknown }, acquired?: PromiseLike<unknown>, grantBytes?: number, budget?: { used: number, limit: number } }} [options]
 */
export function session({ grantInos, journal, gate, refuse, view, acquired, grantBytes, budget } = {}) {
  const harness = createSqliteVfsTestHarness();
  const engine = new SqliteVFS(harness.sql, harness.ctx);
  const kernel = engine.as(CRED_KERNEL);
  for (const dir of ['home/user/proj', 'home/user/other', 'tmp']) kernel.mkdir(dir, { recursive: true });
  kernel.chown('home/user', 1000, 1000);
  kernel.chown('home/user/proj', 1000, 1000);
  kernel.chown('home/user/other', 1000, 1000);
  kernel.chmod('tmp', 0o1777);
  for (let index = 0; index < 10; index++) {
    kernel.mkdir(`home/user/proj/d${index}`);
    kernel.chown(`home/user/proj/d${index}`, 1000, 1000);
  }
  const filesystem = new ProcessFiles(engine);
  const bridge = /** @type {any} */ (filesystem.bind({ pid: 7, cred: user }));
  // The process's store, coherent with the session at every call: reads as the process does.
  const entryOf = (stat, target = null) => ({
    type: stat.type, dev: stat.dev, ino: stat.ino, nlink: stat.nlink, size: stat.size, atime: stat.atime, mtime: stat.mtime,
    ctime: stat.ctime, mode: stat.mode, uid: stat.uid, gid: stat.gid, revision: stat.revision ?? 0, target,
  });
  const device = bridge.stat('/').dev;
  const entryNow = (key) => {
    try {
      const stat = bridge.stat('/' + key, { followSymlinks: false });
      return stat === null ? null : entryOf(stat, view && stat.type === 'symlink' ? bridge.readlink('/' + key) : null);
    } catch { return null; }
  };
  const contentNow = (key) => { try { return bridge.readFile('/' + key) ?? undefined; } catch { return undefined; } };
  const cursorNow = () => ({ epoch: engine.epoch, rev: engine.revision() });
  const seen = new Map();
  let cursor = cursorNow();
  const viewed = (key) => {
    if (!seen.has(key)) seen.set(key, { entry: entryNow(key), content: contentNow(key) });
    return seen.get(key);
  };
  const store = {
    device,
    cred: user,
    ready: () => true,
    entry: (key) => (view ? viewed(key).entry : entryNow(key)),
    children: (key) => {
      try { return bridge.readdir('/' + key); } catch { return undefined; }
    },
    list: async () => true,
    lookup: async () => true,
    listTree: async () => false,
    content: (key) => (view ? viewed(key).content : contentNow(key)),
    fill: async (key) => bridge.readFile('/' + key),
    cursor: () => (view ? cursor : cursorNow()),
    barrier: async () => {
      if (!view) return true;
      for (const key of seen.keys()) seen.set(key, { entry: entryNow(key), content: contentNow(key) });
      cursor = cursorNow();
      await view.barrier?.();
      return true;
    },
    // `budget`: the bytes the process may hold outside the store, counted as they are taken and given back.
    reserve: (bytes) => {
      if (budget === undefined) return true;
      if (budget.used + bytes > budget.limit) return false;
      budget.used += bytes;
      return true;
    },
    release: (bytes) => { if (budget !== undefined) budget.used -= bytes; },
  };
  const waves = [];
  // In process: nothing between the client and the session loses a call, so it fences nothing.
  const processSession = {
    openWriter: async () => null,
    writeBatchStream: async (stream, _fence, owner) => {
      if (gate) await gate;
      // A refusal the test asks for: the whole wave refused, as a full store refuses it.
      if (refuse?.()) {
        await new Response(stream).arrayBuffer();
        return { ok: false, committedOps: 0, committedPathCount: 0, committedGroupSequence: 0, receipts: [], error: { code: 'ERR_WRITE_BATCH_STREAM', phase: 'publish', message: 'ENOSPC: no space left on device', errno: 'ENOSPC' } };
      }
      const result = await bridge.writeStream(stream, owner === undefined ? {} : { mutationOwner: owner });
      waves.push(result);
      return result;
    },
    grants: {
      acquire: async (path, delegate) => {
        await acquired;
        return bridge.acquireExclusiveMutation(path, { delegate: grantBytes === undefined ? delegate : { ...delegate, bytes: grantBytes } });
      },
      release: async (owner) => { bridge.releaseExclusiveMutation(owner); },
      awaitRecall: (owner, waitMs) => bridge.awaitRecall(owner, waitMs),
      recalled: async (owner, kind) => { bridge.recalled(owner, kind); },
    },
  };
  // A subtree is taken at its first mutation here, as P4a did.
  const fs = residentFilesystem(bridge, /** @type {any} */ (store), {
    session: processSession,
    grantAfter: 1,
    ...(grantInos === undefined ? {} : { grantInos }),
    ...(journal === undefined ? {} : { journal }),
    isHomeRoot: (key) => key.startsWith('home/') && !key.slice(5).includes('/'),
  });
  return { engine, kernel, filesystem, fs, waves };
}
