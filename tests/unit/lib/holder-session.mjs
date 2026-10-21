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
 * (`view.barrier` runs after, within the barrier); else the store reads the
 * session at every call. `view.admitted` runs after each row it takes in is
 * told to the process. `view.forget()` true at a barrier: the view starts
 * anew there, knowing no name until one is looked up or its directory listed
 * again (as a resident's lazy store after a barrier it cannot apply).
 * `view.contentless()` true as it reads a row: the row without its bytes.
 * `acquired`: what the session's grant waits for. `grantBytes`: the storage a
 * grant reserves. `answering(result)`: what a wave's answer waits for once
 * the session applied it.
 * @param {{ grantInos?: number, journal?: any, gate?: PromiseLike<unknown>, refuse?: () => boolean, view?: { barrier?: () => unknown, forget?: () => boolean, admitted?: () => void, contentless?: () => boolean }, acquired?: PromiseLike<unknown>, grantBytes?: number, budget?: { used: number, limit: number }, answering?: (result: any) => PromiseLike<unknown> | undefined }} [options]
 */
export function session({ grantInos, journal, gate, refuse, view, acquired, grantBytes, budget, answering } = {}) {
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
  /** The process's admission listener (ResidentNamespace.onAdmitted): told of each row the view takes in, as it does. */
  let admitted = null;
  const admit = (key, fetched = false) => {
    // A row without its bytes (`view.contentless`): as a lazy store admits a name, its bytes fetched when read.
    const row = { entry: entryNow(key), content: !fetched && view.contentless?.() ? undefined : contentNow(key) };
    seen.set(key, row);
    if (row.entry) {
      admitted?.(key, row.entry.dev, row.entry.ino);
      view.admitted?.();
    }
    return row;
  };
  /** Started anew (view.forget): the names looked up and the directories listed since, the only ones it knows. */
  let known = null;
  const viewed = (key) => seen.get(key) ?? admit(key);
  const parentOf = (key) => key.slice(0, Math.max(0, key.lastIndexOf('/')));
  /** A name in a directory the session does not have is not the view's to say (the process's own word may make one there). */
  const parentKnown = (key) => {
    const at = key.lastIndexOf('/');
    if (at < 0) return true;
    const parent = viewed(key.slice(0, at)).entry;
    return parent !== null && parent.type === 'directory';
  };
  const store = {
    device,
    cred: user,
    ready: () => true,
    entry: (key) => {
      if (!view) return entryNow(key);
      if (known !== null && !known.has(key) && !known.has(parentOf(key) + '/')) return undefined;
      return viewed(key).entry === null && !parentKnown(key) ? undefined : viewed(key).entry;
    },
    children: (key) => {
      try { return bridge.readdir('/' + key); } catch { return undefined; }
    },
    list: async (key) => { known?.add(key + '/'); return true; },
    lookup: async (keys) => { for (const key of keys) known?.add(key); return true; },
    listTree: async () => false,
    content: (key) => (view ? viewed(key).content : contentNow(key)),
    // Fetched, the view holds the name's bytes, with the row they are of (as a lazy store's fill).
    fill: async (key) => (view ? admit(key, true).content : bridge.readFile('/' + key)),
    cursor: () => (view ? cursor : cursorNow()),
    barrier: async () => {
      if (!view) return { landed: true };
      if (view.forget?.() === true) {
        seen.clear();
        known = new Set(['']);
      } else for (const key of [...seen.keys()]) admit(key);
      cursor = cursorNow();
      await view.barrier?.();
      return { landed: true };
    },
    acquireArgs: () => {
      const at = view ? cursor : cursorNow();
      return at === null ? null : { epoch: at.epoch, cursor: at.rev };
    },
    // `budget`: the bytes the process may hold outside the store, counted as they are taken and given back.
    reserve: (bytes) => {
      if (budget === undefined) return true;
      if (budget.used + bytes > budget.limit) return false;
      budget.used += bytes;
      return true;
    },
    release: (bytes) => { if (budget !== undefined) budget.used -= bytes; },
    ...(view ? { onAdmitted: (listener) => { admitted = listener; } } : {}),
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
      // Applied, its answer held back while the test asks (`answering`, told what it was).
      await answering?.(result);
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
