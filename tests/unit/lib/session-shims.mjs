// A standalone node shims factory on a real session, as a launch's filesystem
// stands on one: the store is seeded from the session's listing (listAuthority)
// at the session's cursor, the process's filesystem starts over the session
// (SHIMS_STORE_START), and every call the process makes of its SUPERVISOR is
// answered by the session (facetSupervisor). `overrides` count or change any
// of those calls, as facetSupervisor takes them.

import { generateShimsCode } from '../../../packages/worker/src/runtime/node-shims.ts';
import { CRED, facetSupervisor } from './resident-body.mjs';
import { SHIMS_STORE_PRELUDE, SHIMS_STORE_START, listAuthority } from './shims-namespace.mjs';

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
  const factory = new Function(
    '__vfsBundle', '__vfsDirs', '__supervisor', 'cred', 'cwd', 'argv', 'env', 'filename', 'dirname',
    '"use strict";' + head + SHIMS_STORE_PRELUDE + generateShimsCode() + SHIMS_STORE_START + tail,
  );
  const shims = factory(bundle, {}, handle.supervisor, CRED, cwd, [], {}, `${cwd}/main.js`, cwd);
  return { ...shims, rf: globalThis.__nimbusProcessFs, supervisor: handle.supervisor, log: handle.log, forward: handle.forward };
}
