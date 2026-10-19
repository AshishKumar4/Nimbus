/**
 * A session's files (a real SqliteVFS behind a process bridge) and a
 * process's resident filesystem over a store of them, whose supervisor can
 * park a reply: computed when asked, delivered when released.
 *
 * Directory note: under tests/unit/lib/ so the suite does not run it as a test.
 */

import assert from 'node:assert/strict';
import { SqliteVFS } from '../../../packages/core/src/vfs/sqlite-vfs.ts';
import { ProcessFiles } from '../../../packages/core/src/runtime/process-files.ts';
import { CRED_KERNEL } from '../../../packages/core/src/runtime/os-contracts.ts';
import { residentFilesystem } from '../../../packages/core/src/runtime/wasi/resident-filesystem.ts';
import { subtreeListing } from '../../../packages/core/src/runtime/fs-list-tree.ts';
import { createResidentStore } from '../../../packages/worker/src/vfs/resident/index.ts';
import { createSqliteVfsTestHarness } from './sqlite-vfs-test-harness.mjs';

const enc = new TextEncoder();
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
export const USER = Object.freeze({ uid: 1000, gid: 1000, groups: Object.freeze([1000]), umask: 0o022 });
export const ROOT = 'home/user';
/** The absolute path of `p` under the user's home. */
export const k = (p) => `/${ROOT}/${p}`;

/**
 * A session with `tree` (path → content, or null for a directory) under the
 * user's home, and the resident filesystem over a store: listed on demand,
 * as a WASI process has it, or (`eager`) enumerated at boot, as Node's is.
 * `unlisted` names directories a mount left unlisted, as a composite lists
 * them (composite.ts): marked, their entries not in the session's listing.
 * `calls` counts each supervisor call by name; `reads` is each lstat batch's
 * paths and each read's. `delegated`: the process is a delegation's holder
 * (its waves and grants through the same session), which asks a read lease
 * with each barrier; it takes no subtree, so each change it makes is one
 * outside a grant.
 * @param {Record<string, string | null>} tree
 * @param {{ eager?: boolean, unlisted?: string[], delegated?: boolean }} [options]
 */
export async function storeSession(tree, { eager = false, unlisted = [], delegated = false } = {}) {
  const harness = createSqliteVfsTestHarness();
  const engine = new SqliteVFS(harness.sql, harness.ctx);
  const files = new ProcessFiles(engine);
  const kernel = files.bind({ pid: 1, cred: CRED_KERNEL });
  const authority = files.bind({ pid: 2, cred: USER });
  for (const dir of ['/home', `/${ROOT}`]) await kernel.mkdir(dir, { recursive: true });
  await kernel.chown(`/${ROOT}`, 1000, 1000);
  for (const [path, content] of Object.entries(tree)) {
    if (content === null) await kernel.mkdir(k(path), { recursive: true });
    else await kernel.writeFile(k(path), enc.encode(content));
    await kernel.chown(k(path), 1000, 1000);
  }
  const holds = new Set();
  /** @type {Map<string, number>} */
  const failing = new Map();
  const parked = [];
  /** @type {Record<string, number>} */
  const calls = {};
  /** @type {string[][]} */
  const reads = [];
  const answered = async (name, compute) => {
    calls[name] = (calls[name] ?? 0) + 1;
    const fails = failing.get(name) ?? 0;
    if (fails > 0) {
      failing.set(name, fails - 1);
      throw new Error('Network connection lost.');
    }
    const answer = await compute();
    if (!holds.delete(name)) return answer;
    const release = Promise.withResolvers();
    parked.push({ name, release: release.resolve });
    await release.promise;
    return answer;
  };
  const mounts = unlisted.map((dir) => `${ROOT}/${dir}`);
  /** The session's listing page, as a composite lists a mount it was not asked to walk. */
  const listed = (page) => (mounts.length === 0 ? page : {
    ...page,
    entries: page.entries
      .filter((entry) => !mounts.some((mount) => entry.path.startsWith(`${mount}/`)))
      .map((entry) => (mounts.includes(entry.path) ? { ...entry, unlisted: `/${entry.path}` } : entry)),
  });
  let poisonNext = false;
  /** @type {any} */
  const supervisor = {
    // A poison is the session's answer to an ACQUIRE from no cursor.
    fsAcquire: (epoch, cursor, options) => answered('fsAcquire', () => (poisonNext
      ? (poisonNext = false, authority.acquire(null, 0, { namespace: true }))
      : authority.acquire(epoch, cursor, options))),
    fsList: (after, limit) => answered('fsList', async () => listed(await authority.list(after, limit))),
    readdir: (path) => answered('readdir', () => authority.readdir(path)),
    readlink: (path) => authority.readlink(path),
    fsListTree: (root, maxEntries) => answered('fsListTree', () => subtreeListing(authority, root, maxEntries)),
    stat: (path, options) => authority.stat(path, options),
    fsReadBatch: (requests) => answered('fsReadBatch', async () => {
      reads.push(requests.map((request) => request.path));
      const out = [];
      for (const request of requests) {
        try {
          if (request.lstat) out.push({ stat: await authority.stat(request.path, { followSymlinks: false }) });
          else out.push({ bytes: await authority.readRange(request.path, request.offset, request.length) });
        } catch (error) { out.push({ error }); }
      }
      return out;
    }),
  };
  const store = createResidentStore();
  store.bindInMemory(64 * 1024 * 1024);
  store.admission.setStorage(undefined, supervisor);
  if (eager) {
    const { epoch, rev } = await authority.acquire(null, 0, { namespace: true });
    const boot = await store.sync.boot(() => ({}), { epoch, rev }, supervisor, 0);
    assert.equal(boot.failure, null, 'the namespace enumerated at boot');
  } else {
    assert.equal(await store.view.bootLazy(supervisor), true);
  }
  const device = (await authority.stat('/')).dev;
  const view = store.view.namespaceView(supervisor, device, USER);
  const fs = residentFilesystem(authority, view, delegated ? {
    session: {
      openWriter: async () => null,
      writeBatchStream: async (stream, _fence, owner) => authority.writeStream(stream, owner === undefined ? {} : { mutationOwner: owner }),
      grants: {
        acquire: async (path, delegate) => authority.acquireExclusiveMutation(path, { delegate }),
        release: async (owner) => { authority.releaseExclusiveMutation(owner); },
        awaitRecall: (owner, waitMs) => authority.awaitRecall(owner, waitMs),
        recalled: async (owner, kind) => { authority.recalled(owner, kind); },
      },
    },
    grantAfter: Number.MAX_SAFE_INTEGER,
    readLeases: () => true,
    isHomeRoot: (key) => key === ROOT,
  } : undefined);
  return {
    kernel,
    authority,
    store,
    view,
    fs,
    calls,
    reads,
    /** The next barrier is answered with a poison. */
    poison() { poisonNext = true; },
    /** The next `times` calls of `name` fail, as a dropped connection does. */
    fail(name, times = 1) { failing.set(name, times); },
    /** Park the next reply of `name`; the returned wait resolves once something asked it. */
    hold(name) {
      holds.add(name);
      return async () => {
        for (let i = 0; i < 500 && !parked.some((p) => p.name === name); i++) await sleep(2);
        assert.ok(parked.some((p) => p.name === name), `a ${name} was asked`);
      };
    },
    release(name) { parked.splice(parked.findIndex((p) => p.name === name), 1)[0].release(); },
  };
}
