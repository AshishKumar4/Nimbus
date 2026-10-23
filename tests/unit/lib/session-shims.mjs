// A standalone node shims factory on a real session, as a launch's filesystem
// stands on one: the store is seeded from the session's listing (listAuthority)
// at the session's cursor, the process's filesystem starts over the session
// (SHIMS_STORE_START), and every call the process makes of its SUPERVISOR is
// answered by the session (facetSupervisor). `overrides` count or change any
// of those calls, as facetSupervisor takes them.

import { generateShimsCode } from '../../../packages/worker/src/runtime/node-shims.ts';
import { withRecall } from '../../../packages/core/src/vfs/recall.ts';
import { CRED, facetSupervisor } from './resident-body.mjs';
import { SHIMS_STORE_PRELUDE, SHIMS_STORE_START, listAuthority } from './shims-namespace.mjs';

// The platform's timers, before any shims wrap them (the launch hands them to
// the process's filesystem as its resend timers: manager.ts __nimbusRawSetTimeout).
const rawSetTimeout = globalThis.setTimeout;
const rawClearTimeout = globalThis.clearTimeout;

/**
 * A bridge as another process or a shell reads and writes the session: a call
 * that meets what a process holds waits for its recall, as a peer's does.
 */
export function observed(bridge) {
  return new Proxy(bridge, {
    get: (target, name) => (typeof target[name] === 'function' ? (...args) => withRecall(() => target[name](...args)) : target[name]),
  });
}

/**
 * Checks that run to the end of a file even when one fails: each `check` is an
 * assertion (sync or async) whose failure is kept; `finish` throws them all, so
 * one run names every failing assertion of the file, not only the first.
 */
export function recording() {
  const failures = [];
  return {
    async check(name, run) {
      try { await run(); } catch (error) { failures.push(`${name}: ${error?.message ?? error}`); }
    },
    finish() {
      if (failures.length > 0) throw new Error(`${failures.length} assertion(s) failed:\n${failures.join('\n')}`);
    },
  };
}

/**
 * The shims of one process in `cwd` on `authority`'s session. Write the
 * session's files before calling: the listing is taken now. `bundle` is what
 * the launch's store holds at boot (cells of the session's own files, at its
 * cursor). `overrides` is facetSupervisor's, or a function of `call(name, args)`
 * (the session's own answer to a call) that returns it. `head` runs ahead of
 * the shims, `tail` after the filesystem starts (it returns what the test
 * reads). The result carries `rf` (the process's ResidentFilesystem), `log`
 * and `forward`.
 * @param {any} authority
 * @param {{ bundle?: Record<string, string | Uint8Array>, overrides?: Record<string, (...args: any[]) => any> | ((call: (name: string, args: unknown[]) => Promise<any>) => Record<string, (...args: any[]) => any>), cwd?: string, head?: string, tail?: string }} [options]
 */
export function sessionShims(authority, { bundle = {}, overrides, cwd = '/home/user', head = '', tail = '' } = {}) {
  let forward;
  const own = typeof overrides === 'function' ? overrides((name, args) => forward(name, args)) : overrides;
  const handle = facetSupervisor(authority, own);
  forward = handle.forward;
  listAuthority(authority.rawVfs);
  globalThis.__nimbusVfsCursor = { position: authority.cursor() };
  globalThis.__nimbusRawSetTimeout = rawSetTimeout;
  globalThis.__nimbusRawClearTimeout = rawClearTimeout;
  const factory = new Function(
    '__vfsBundle', '__vfsDirs', '__supervisor', 'cred', 'cwd', 'argv', 'env', 'filename', 'dirname',
    '"use strict";' + head + SHIMS_STORE_PRELUDE + generateShimsCode() + SHIMS_STORE_START + tail,
  );
  const shims = factory(bundle, {}, handle.supervisor, CRED, cwd, [], {}, `${cwd}/main.js`, cwd);
  return { ...shims, rf: globalThis.__nimbusProcessFs, supervisor: handle.supervisor, log: handle.log, forward: handle.forward };
}
