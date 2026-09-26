// The VFS bundle a generated facet boots on, read back out of the module set
// its Worker Loader config carries. A launch ships the bundle as side
// modules (`__nimbus_vfs_bundle_<n>.js`, each `export default {cells}`) that
// the entry module imports and joins in its `__MODULE_VFS_BUNDLE` expression;
// a small bundle may still be inline in that expression. This evaluates
// exactly what the facet evaluates, so a test sees the cells the program
// gets.

import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';

const SIDE = /^import (\w+) from "(__nimbus_vfs_bundle_\d+\.js)";$/gm;

function sideModule(source) {
  const prefix = 'export default ';
  if (!source.startsWith(prefix)) throw new Error('a VFS side module has a default export');
  return new Function(`return (${source.slice(prefix.length, source.lastIndexOf(';'))});`)();
}

/** The cells of the bundle in `modules` (a Worker Loader config's), whose entry is `entry`. */
export function moduleMapBundle(modules, entry = modules['worker.js'] ? 'worker.js' : 'runner.js') {
  const source = modules[entry];
  const declared = source.match(/^(?:const|let) __MODULE_VFS_BUNDLE = (.*);$/m);
  if (!declared) throw new Error(`${entry} declares no __MODULE_VFS_BUNDLE`);
  const imports = [...source.matchAll(SIDE)];
  const aliases = imports.map((m) => m[1]);
  const parts = imports.map((m) => sideModule(modules[m[2]]));
  return new Function(...aliases, `return (${declared[1]});`)(...parts);
}

/** Every module source in the set: what a test searches for a program's text. */
export function moduleMapText(modules) {
  return Object.values(modules).filter((m) => typeof m === 'string').join('\n');
}

/**
 * Write a Worker Loader config's modules to `dir`, as the loader resolves
 * them (each by its name, beside the entry), and return the entry's path.
 * `rewrite(name, source)` may adapt a module for this runtime (the
 * `cloudflare:workers` import, say).
 */
export function writeModuleSet(dir, modules, entry, rewrite = (_name, source) => source) {
  mkdirSync(dir, { recursive: true });
  // The loader resolves a bare specifier to the module of that name; a file
  // import here needs it relative.
  const names = new Set(Object.keys(modules));
  const local = (source) => source.replace(/(\bfrom\s*|\bimport\s*)"([^"./][^"]*)"/g,
    (whole, lead, spec) => (names.has(spec) ? `${lead}"./${spec}"` : whole));
  for (const [name, source] of Object.entries(modules)) {
    if (typeof source !== 'string') continue;
    writeFileSync(join(dir, name), local(rewrite(name, source)));
  }
  return join(dir, entry);
}

const DO_SHIM = 'class DurableObject { constructor(ctx, env) { this.ctx = ctx; this.env = env; } }';
let loadDir = null;
let loadN = 0;

/**
 * Import a Worker Loader config's entry, its side modules beside it, from a
 * directory of this test's own (removed when the process exits). The entry's
 * `cloudflare:workers` import is replaced with a DurableObject base.
 */
export async function importModuleSet(modules, entry) {
  if (loadDir === null) {
    loadDir = mkdtempSync(join(tmpdir(), 'nimbus-module-set-'));
    process.on('exit', () => rmSync(loadDir, { recursive: true, force: true }));
  }
  const file = writeModuleSet(join(loadDir, String(loadN++)), modules, entry, (_name, source) =>
    source.replace('import { DurableObject } from "cloudflare:workers";', DO_SHIM));
  return import(pathToFileURL(file).href);
}
