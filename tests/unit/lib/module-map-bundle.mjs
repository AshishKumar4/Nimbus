// The VFS bundle a generated facet boots on, read back out of the module set
// its Worker Loader config carries. A launch ships the bundle's data as side
// modules (`__nimbus_vfs_bundle_<n>.js`, each `export default {cells}`) that
// the entry module imports and joins in its `__MODULE_VFS_BUNDLE` expression;
// a small bundle may still be inline in that expression. Its code cells are
// `{ cjs }` modules of their own (core/_shared/commonjs-cell.ts), named in the
// entry's `__NIMBUS_CODE_CELLS` table, whose text the store adopts. This
// evaluates exactly what the facet evaluates, so a test sees the cells the
// program gets.

import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { adaptHttpImports } from './node-http-platform.mjs';

const SIDE = /^import (\w+) from "(__nimbus_vfs_bundle_\d+\.js)";$/gm;

function sideModule(source) {
  const prefix = 'export default ';
  if (!source.startsWith(prefix)) throw new Error('a VFS side module has a default export');
  return new Function(`return (${source.slice(prefix.length, source.lastIndexOf(';'))});`)();
}

/** The `{ cjs }` text of a module-map member, or undefined when it is not one. */
function cjsText(member) {
  return member && typeof member === 'object' && typeof member.cjs === 'string' ? member.cjs : undefined;
}

/** The cells of the bundle in `modules` (a Worker Loader config's), whose entry is `entry`. */
export function moduleMapBundle(modules, entry = modules['worker.js'] ? 'worker.js' : 'runner.js') {
  const source = modules[entry];
  const declared = source.match(/^(?:const|let) __MODULE_VFS_BUNDLE = __nimbusWithCodeCells\((.*)\);$/m);
  if (!declared) throw new Error(`${entry} declares no __MODULE_VFS_BUNDLE`);
  const imports = [...source.matchAll(SIDE)];
  const aliases = imports.map((m) => m[1]);
  const parts = imports.map((m) => sideModule(modules[m[2]]));
  const bundle = new Function(...aliases, `return (${declared[1]});`)(...parts);
  for (const [key, name, head, tail, hashbang, adopt] of moduleMapCodeCells(modules, entry)) {
    if (!adopt) continue;
    const text = cjsText(modules[name]);
    if (text === undefined) throw new Error(`the map names cell ${name} and carries no such { cjs } module`);
    const cell = text.slice(head, text.length - tail);
    bundle[key] = hashbang ? '#!' + cell.slice(2) : cell;
  }
  return bundle;
}

/** The entry's CommonJsCellRow table: `[key, moduleName, head, tail, hashbang, adopt, esModule]`. */
export function moduleMapCodeCells(modules, entry = modules['worker.js'] ? 'worker.js' : 'runner.js') {
  const table = modules[entry].match(/^const __NIMBUS_CODE_CELLS = (.*);$/m);
  if (!table) throw new Error(`${entry} declares no __NIMBUS_CODE_CELLS`);
  return JSON.parse(table[1]);
}

/** Every module source in the set: what a test searches for a program's text. */
export function moduleMapText(modules) {
  return Object.values(modules).map((m) => (typeof m === 'string' ? m : cjsText(m))).filter((m) => m !== undefined).join('\n');
}

/**
 * The guest's module registry, for a module set written to disk: `require`
 * of a `{ cjs }` module compiles its text as workerd's CommonJS handler does
 * (src/workerd/api/commonjs.h CommonJsModuleContext), a sloppy function body
 * with `module`, `exports`, `require` (of the set's modules, relative to the
 * module's own name), `__filename` and `__dirname` in scope, once per file.
 * Bun would read a `.mjs` file as an ES module whatever it holds; the loader
 * types a module by its `{ cjs }` member, not its name.
 */
const registry = new Map();
const createRequire = (base) => (specifier) => {
  const file = fileURLToPath(new URL(specifier, base));
  if (!registry.has(file)) {
    const moduleObject = { exports: {} };
    new Function('module', 'exports', 'require', '__filename', '__dirname', readFileSync(file, 'utf8'))(
      moduleObject, moduleObject.exports, createRequire(pathToFileURL(file)), file, dirname(file),
    );
    registry.set(file, moduleObject.exports);
  }
  return registry.get(file);
};
globalThis.__nimbusTestCreateRequire = createRequire;
const REGISTRY_IMPORT = 'import { createRequire as __nimbusCreateRequire } from "node:module";';
const REGISTRY_STAND_IN = 'const __nimbusCreateRequire = globalThis.__nimbusTestCreateRequire;';

/**
 * Write a Worker Loader config's modules to `dir`, as the loader resolves
 * them (each by its name, beside the entry), and return the entry's path.
 * `rewrite(name, source)` may adapt a module for this runtime (the
 * `cloudflare:workers` import, say). The entry's registry is the stand-in
 * above, so its `{ cjs }` modules load as the guest loads them.
 */
export function writeModuleSet(dir, modules, entry, rewrite = (_name, source) => source) {
  mkdirSync(dir, { recursive: true });
  // The loader resolves a bare specifier to the module of that name; a file
  // import here needs it relative.
  const names = new Set(Object.keys(modules));
  const local = (source) => source.replace(/(\bfrom\s*|\bimport\s*)"([^"./][^"]*)"/g,
    (whole, lead, spec) => (names.has(spec) ? `${lead}"./${spec}"` : whole));
  for (const [name, member] of Object.entries(modules)) {
    const path = join(dir, name);
    if (typeof member === 'string') {
      writeFileSync(path, adaptHttpImports(local(rewrite(name, member))).replace(REGISTRY_IMPORT, REGISTRY_STAND_IN));
    } else if (cjsText(member) !== undefined) {
      // A module name is a URL path: the file is where the registry's URL
      // resolution — the stand-in's fileURLToPath — finds it.
      const file = join(dir, decodeURIComponent(name));
      mkdirSync(dirname(file), { recursive: true });
      writeFileSync(file, member.cjs);
    }
  }
  return join(dir, entry);
}

/** A generated facet's modules as the Worker Loader config a launch hands the loader. */
export function generatedModuleSet(generated, entry) {
  const set = { [entry]: generated.code, ...generated.modules };
  for (const [name, text] of Object.entries(generated.codeModules)) set[name] = { cjs: text };
  return set;
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
