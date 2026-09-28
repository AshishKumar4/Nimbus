// The node-shims under test, over the store and namespace every embedding
// boots on (vfs/facet-resident-store.ts).
//
// A test that evaluates the shims on its own (`new Function('__vfsBundle',
// '__vfsDirs', '__supervisor', 'cred', ...)`) splices SHIMS_STORE_PRELUDE in
// ahead of generateShimsCode(). The prelude declares the real store, binds it
// in the process's heap (the one-shot backing), adopts the test's bundle
// cells, and fills the namespace with what the test's fixture says exists:
// - every bundle cell is a file;
// - every metadata record declareNamespace() gave is its own stat;
// - every directory its manifest or __vfsDirs names is a directory, and so
//   is every ancestor.
// A name the fixture lists but does not describe (a bundle cell, a manifest
// entry) is what the session's authority would list for something nobody
// described: the kernel's (root; a 0644 file, a 0755 directory), never the
// reader's own. __vfsDirs are directories this process created: the reader's.
// An ancestor the fixture never names is the user's home tree: the reader's,
// 0755. The namespace is then ready, and __vfsBundle becomes the store's view.
//
// The fixture is the authority here: what the test declares is what the
// namespace lists, as a listing from the session would. A test with a real
// authority behind its supervisor (a SqliteVFS) calls listAuthority(rawVfs)
// before its factory instead, and the namespace is seeded from a listing of
// it, with its real stats, as a launch's is.

import { CRED_KERNEL } from '../../../packages/core/src/runtime/os-contracts.ts';
import { FACET_RESIDENT_STORE_SOURCE } from '../../../packages/worker/src/vfs/facet-resident-store.ts';
import { wrapCommonJsCell } from '../../../packages/core/src/_shared/commonjs-cell.ts';

const SEED = `
;(function __nimbusTestSeedNamespace() {
  __residentBindInMemory(1 << 30);
  __residentSetStorage(undefined, typeof __supervisor === "undefined" ? null : __supervisor);
  const __cred = (typeof cred !== "undefined" && cred) || { uid: 1000, gid: 1000, groups: [1000] };
  __nsSetCred(__cred);
  __residentSetPlan([]);
  const cursor = (globalThis.__nimbusVfsCursor && globalThis.__nimbusVfsCursor.epoch != null)
    ? globalThis.__nimbusVfsCursor : { epoch: "test-epoch", rev: 1 };
  const bundle = (typeof __vfsBundle !== "undefined" && __vfsBundle) || {};
  // Taken once, by the factory it was declared for.
  const declared = globalThis.__nimbusTestNamespace || {};
  delete globalThis.__nimbusTestNamespace;
  const metadata = declared.metadata || {};
  const manifest = declared.manifest || {};
  const dirs = (typeof __vfsDirs !== "undefined" && __vfsDirs) || {};
  const cells = {};
  for (const [k, v] of Object.entries(bundle)) cells[String(k).replace(/^\\/+/, "")] = v;
  __residentAdoptModuleBundle(cells, cursor);
  const owner = { uid: Number(__cred.uid), gid: Number(__cred.gid) };
  const names = new Map();
  const root = { uid: 0, gid: 0 };
  const dir = (who = root) => ({ type: "directory", size: 0, mode: 0o40755, ...who, atime: 0, mtime: 0, ctime: 0, ino: 0 });
  const file = (size) => ({ type: "file", size, mode: 0o100644, uid: 0, gid: 0, atime: 0, mtime: 0, ctime: 0, ino: 0 });
  const ancestors = (k) => {
    const parts = k.split("/");
    for (let i = 1; i < parts.length; i++) {
      const d = parts.slice(0, i).join("/");
      if (d && !names.has(d)) names.set(d, dir(owner));
    }
  };
  const size = (cell) => typeof cell === "string" ? new TextEncoder().encode(cell).byteLength
    : cell instanceof Uint8Array ? cell.byteLength : 0;
  for (const [k, cell] of Object.entries(cells)) {
    ancestors(k);
    if (cell && typeof cell === "object" && !(cell instanceof Uint8Array) && cell.error) {
      names.set(k, { ...file(0), mode: 0o100000 });
    } else names.set(k, file(size(cell)));
  }
  for (const [d, children] of Object.entries(manifest)) {
    const key = String(d).replace(/^\\/+/, "");
    if (key) { ancestors(key + "/-"); if (!names.has(key) || names.get(key).type !== "directory") names.set(key, dir()); }
    for (const child of children || []) {
      const k = key ? key + "/" + child : String(child);
      if (names.has(k)) continue;
      names.set(k, (k in manifest) ? dir() : file(0));
    }
  }
  for (const d of Object.keys(dirs)) {
    const key = String(d).replace(/^\\/+/, "");
    if (!key) continue;
    ancestors(key + "/-");
    names.set(key, dir(owner));
  }
  for (const [k, stat] of globalThis.__nimbusTestAuthorityListing || []) {
    ancestors(k);
    names.set(k, stat);
  }
  for (const [k0, record] of Object.entries(metadata)) {
    const k = String(k0).replace(/^\\/+/, "");
    if (!k || !record) continue;
    ancestors(k);
    const type = record.type || "file";
    const base = type === "directory" ? dir(owner) : file(Number(record.size) || 0);
    names.set(k, { ...base, ...record, type });
  }
  const t = __residentT;
  for (const [k, stat] of names) __nsPut(t, k, stat, cursor.rev, stat.linkTarget ?? stat.target);
  __nsMarkReady(t, true);
  if (typeof __vfsBundle !== "undefined") __vfsBundle = __nimbusResidentBundle;
})();
`;

/**
 * What the test's authority lists beyond its bundle cells: a stat per name
 * (\`metadata\`, keyed by path) and directory entries (\`manifest\`, path ->
 * child names). Call before the factory; the namespace is seeded from it as
 * from a session's listing.
 */
export function declareNamespace({ metadata = {}, manifest = {} } = {}) {
  globalThis.__nimbusTestNamespace = { metadata, manifest };
}

/**
 * The guest's module registry, for a standalone shims factory: every code
 * file the test's bundle holds is one of the launch's module cells, compiled
 * from the store's text with the wrapper a launch gives it
 * (core/_shared/commonjs-cell.ts), as the registry compiles its `{ cjs }`
 * module, once.
 */
globalThis.__nimbusTestCompileCell = (text) => {
  const moduleObject = { exports: {} };
  new Function('module', 'exports', wrapCommonJsCell(text).text)(moduleObject, moduleObject.exports);
  return moduleObject.exports;
};
const MODULE_CELLS = `
const __nimbusTestCells = new Map();
function __nimbusModuleCell(key) {
  if (!__nimbusTestCells.has(key)) {
    const text = __vfsBundle[key];
    __nimbusTestCells.set(key, typeof text === "string" ? globalThis.__nimbusTestCompileCell(text) : null);
  }
  return __nimbusTestCells.get(key);
}
`;

/** Splice ahead of generateShimsCode() in a standalone shims factory. */
export const SHIMS_STORE_PRELUDE = `\n${FACET_RESIDENT_STORE_SOURCE}\n${SEED}\n${MODULE_CELLS}\n`;

/**
 * List a test authority (a SqliteVFS) as the session would for a launch, into
 * the listing the prelude seeds the namespace from. Call it just before the
 * factory; the listing is taken at that moment, as a launch's is.
 */
export function listAuthority(rawVfs) {
  // The session lists with the kernel's credential; each name's stat says who
  // may do what with it.
  const fs = rawVfs.as(CRED_KERNEL);
  const out = [];
  const walk = (dir) => {
    for (const entry of fs.readdir(dir)) {
      const k = dir ? `${dir}/${entry.name}` : entry.name;
      const st = fs.lstat(k);
      const stat = {
        type: st.type, size: Number(st.size) || 0, mode: Number(st.mode) || 0,
        uid: Number(st.uid) || 0, gid: Number(st.gid) || 0,
        atime: Number(st.atime) || 0, mtime: Number(st.mtime) || 0, ctime: Number(st.ctime) || 0, ino: Number(st.ino) || 0,
      };
      if (st.type === 'symlink') stat.linkTarget = fs.readlink(k);
      out.push([k, stat]);
      if (st.type === 'directory') walk(k);
    }
  };
  walk('');
  globalThis.__nimbusTestAuthorityListing = out;
  return out;
}
