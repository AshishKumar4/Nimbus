#!/usr/bin/env bun
// A program's dynamic import() loads what real Node loads, and fails as it
// fails. The program is compiled with `new Function`, so an import() left in
// it was workerd's own: resolved against the module registry, which holds
// none of the session's files. `import('/usr/local/lib/node_modules/<pkg>/
// dist/index.js')` from a CommonJS script (how pi's SDK is loaded) failed
// with "No such module", and `import('node:http')` handed back the platform's
// http rather than the process's.
//
// One fixture tree, on disk for real node and in the session's filesystem for
// a one-shot `node script.js` through the real launch path (module-map walk,
// ESM→CJS transform, the facet's rewrite, the shims' ESM loader); the same
// script prints what each import() gave, and the two outputs must be equal
// once the roots are named alike.

import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { pathToFileURL } from 'node:url';

import { FacetManager } from '../../packages/worker/src/facets/manager.ts';
import { processHostFor } from '../../packages/worker/src/loaders/process-host.ts';
import { PortRegistry } from '../../packages/core/src/runtime/port-registry.ts';
import { adoptCtxExports } from '../../packages/fabric/src/composition.ts';
import { EsbuildService } from '../../packages/core/src/runtime/esbuild-service.ts';
import { createFacetCtx, createFacetWorld } from './facet-host-harness.mjs';
import { processFiles } from './lib/process-bridge.mjs';
import { createAuthority } from './lib/resident-body.mjs';
import { writeModuleSet } from './lib/module-map-bundle.mjs';
import { CRED_KERNEL } from '../../packages/core/src/runtime/os-contracts.ts';

const ROOT = '/home/user/dio';
const files = {
  'app/package.json': JSON.stringify({ name: 'app', imports: { '#int': { import: './esm.mjs', default: './c.cjs' } } }),
  'app/esm.mjs': 'export const kind = "esm";\nexport default "esm-default";\n',
  'app/c.cjs': 'exports.a = 1;\nexports.b = 2;\n',
  'app/load.cjs': 'exports.load = () => import("./esm.mjs");\n',
  'app/counted.mjs': '"use strict"; globalThis.__nimbusCountedImport = (globalThis.__nimbusCountedImport || 0) + 1; export const count = globalThis.__nimbusCountedImport; export const url = import.meta.url; export const resolve = import.meta.resolve; export function readUrl(__nimbusMetadataModule) { if ((function () { return this; })() !== undefined) throw new Error("strictness lost"); return import.meta.url; }\n',
  'app/arity.cjs': '"use strict"; module.exports = [arguments.length, (function () { return this; })() === undefined];\n',
  'app/user-metadata.mjs': 'const user = { __nimbusModuleUrl: 123, __nimbusImportMetaResolve: 456 }; globalThis.__nimbusModuleUrl = 789; globalThis.__nimbusImportMetaResolveUser = 987; export const value = [user.__nimbusModuleUrl, user.__nimbusImportMetaResolve, globalThis.__nimbusModuleUrl]; export function shadow(module) { return [module.__nimbusModuleUrl, module.__nimbusImportMetaResolve]; }\n',
  'app/typed/package.json': '{"type":"module"}',
  'app/meta-forms.mjs': 'const {url, resolve} = import.meta; export const values = [import.meta["url"],url,import.meta["resolve"]("./c.cjs"),resolve("./c.cjs"),import.meta===import.meta,Object.getPrototypeOf(import.meta)===null]; import.meta.extra=123; export const mutation=import.meta.extra;\n',
  'app/typed/user-metadata-with-meta.ts': 'const user: { __nimbusModuleUrl: number } = { __nimbusModuleUrl: 123 }; export const value = user.__nimbusModuleUrl; export const url = import.meta.url;\n',
  'app/static-counted.mjs': 'export { count } from "./counted.mjs";\n',
  // Bundler-shaped ESM beyond the large-cell rewrite threshold: its metadata
  // must also come from the evaluation, not from source transformation.
  'app/large-meta.mjs': '/*' + 'x'.repeat(600 * 1024) + '*/\nconst url = import.meta.url; export { url };\n',
  'app/large-shadow-meta.mjs': '/*' + 'x'.repeat(600 * 1024) + '*/\nimport { kind } from "./esm.mjs"; const module = "local-module"; const require = "local-require"; const exports = "local-exports"; const nested = (function(module, require, exports) { return [module, require, exports]; })(1,2,3); const value = [module,require,exports,kind,nested]; const url = import.meta.url; export { url, value };\n',
  // Vinext resolves its empty module with path.join(import.meta.dirname, ...).
  'app/meta-paths.mjs': 'export const paths = [import.meta.dirname, import.meta.filename];\n',
  'app/data.json': '{"k":1}\n',
  'app/dir/index.js': 'module.exports = "idx";\n',
  'app/rel.js': 'module.exports = "rel";\n',
  // pi's shape: an ESM package installed globally, loaded by absolute path.
  'lib/node_modules/sdk/package.json': JSON.stringify({ name: 'sdk', type: 'module', exports: './dist/index.js' }),
  'lib/node_modules/sdk/dist/index.js': 'import { helper } from "./helper.js";\nexport const version = "1.0";\nexport function run() { return helper(); }\n',
  'lib/node_modules/sdk/dist/helper.js': 'export function helper() { return "helped"; }\n',
  'node_modules/dual/package.json': JSON.stringify({ name: 'dual', exports: { '.': { require: './c.cjs', import: './e.mjs' }, './pub': './pub.mjs' } }),
  'node_modules/dual/e.mjs': 'export const via = "import";\n',
  'node_modules/dual/c.cjs': 'exports.via = "require";\n',
  'node_modules/dual/pub.mjs': 'export const p = 1;\n',
  'node_modules/legacy/package.json': JSON.stringify({ name: 'legacy', main: 'lib/main' }),
  'node_modules/legacy/lib/main.js': 'exports.m = "main";\n',
};
const SCRIPT = `
const show = (m) => {
  const keys = Object.keys(m).sort();
  const d = m.default;
  return { keys, default: d === undefined ? null : typeof d === 'object' && d !== null ? Object.keys(d).sort() : d };
};
const attempt = async (label, load) => {
  try { return [label, show(await load())]; } catch (e) { return [label, { error: e.code ?? e.name, message: e.message }]; }
};
(async () => {
  const out = [
    await attempt('absolute esm package', () => import('${ROOT}/lib/node_modules/sdk/dist/index.js')),
    await attempt('file url with query', () => import('file://${ROOT}/app/esm.mjs?v=1')),
    await attempt('relative esm', () => import('./esm.mjs')),
    await attempt('commonjs namespace', () => import('./c.cjs')),
    await attempt('dynamic import inside required cjs', () => require('./load.cjs').load()),
    await attempt('directory', () => import('./dir')),
    await attempt('no extension', () => import('./rel')),
    await attempt('missing', () => import('./nope.js')),
    await attempt('dual package takes import', () => import('dual')),
    await attempt('not exported', () => import('dual/priv')),
    await attempt('legacy main', () => import('legacy')),
    await attempt('imports field', () => import('#int')),
    await attempt('no package', () => import('nopkg')),
    await attempt('json needs its attribute', () => import('./data.json')),
    await attempt('json', () => import('./data.json', { with: { type: 'json' } })),
    await attempt('json data needs its attribute', () => import('data:application/json,%7B%22x%22%3A1%7D')),
    await attempt('json data', () => import('data:application/json,%7B%22x%22%3A1%7D', { with: { type: 'json' } })),
    await attempt('unknown builtin', () => import('node:nope')),
    await attempt('bad options', () => import('./rel.js', 1)),
  ];
  const sdk = await import('${ROOT}/lib/node_modules/sdk/dist/index.js');
  out.push(['the loaded module runs', sdk.run()]);
  const http = await import('node:http');
  out.push(['builtin is the process\\'s own', http.default === require('http')]);
  const one = await import('./counted.mjs?v=one');
  const repeated = await import('./counted.mjs?v=one');
  const two = await import('./counted.mjs?v=two');
  const fragment = await import('./counted.mjs#fragment');
  out.push(['ESM evaluation uses complete URL', [one.count, repeated.count, two.count, fragment.count]]);
  const required = require('./counted.mjs');
  const canonical = await import('./counted.mjs');
  const reexported = await import('./static-counted.mjs');
  out.push(['canonical ESM shares require and static evaluation', [required.count, canonical.count, reexported.count]]);
  out.push(['import.meta.url follows evaluation', [one.url, two.url, fragment.url, one.readUrl(), canonical.url]]);
  out.push(['extracted import.meta.resolve retains parent', one.resolve('./c.cjs')]);
  out.push(['large-cell import.meta.url follows evaluation', (await import('./large-meta.mjs?large#fragment')).url]);
  const shadowed = await import('./large-shadow-meta.mjs?shadow');
  out.push(['wrapper binding names remain user values', [shadowed.value, shadowed.url]]);
  out.push(['CommonJS wrapper arguments and strictness unchanged', require('./arity.cjs')]);
  const userMetadata = await import('./user-metadata.mjs');
  out.push(['user metadata spellings preserved', [userMetadata.value, userMetadata.shadow({__nimbusModuleUrl: 12,__nimbusImportMetaResolve: 34})]]);
  const typedMetadata = await import('./typed/user-metadata-with-meta.ts?typed');
  out.push(['typed actual metadata and user property remain distinct', [typedMetadata.value, typedMetadata.url]]);
  const forms = await import('./meta-forms.mjs?forms#fragment');
  out.push(['metadata computed destructured identity mutation', [forms.values, forms.mutation]]);
  out.push(['import.meta.dirname and filename name the file, not its query', (await import('./meta-paths.mjs?paths#fragment')).paths]);
  console.log(JSON.stringify(out));
})();
`;

// ── real node ────────────────────────────────────────────────────────────
const disk = realpathSync(mkdtempSync(join(tmpdir(), 'dynamic-import-')));
let expected;
try {
  for (const [rel, text] of Object.entries(files)) {
    mkdirSync(dirname(join(disk, rel)), { recursive: true });
    writeFileSync(join(disk, rel), text);
  }
  const script = SCRIPT.replaceAll(ROOT, disk);
  writeFileSync(join(disk, 'app/script.js'), script);
  const node = spawnSync('node', ['--no-warnings', 'script.js'], { cwd: join(disk, 'app'), encoding: 'utf8' });
  assert.equal(node.status, 0, node.stderr);
  expected = JSON.parse(node.stdout.trim().split('\n').at(-1).replaceAll(disk, ROOT));
} finally {
  rmSync(disk, { recursive: true, force: true });
}

// ── a one-shot node in the session ───────────────────────────────────────
const authority = createAuthority();
const { host, rawVfs, kfs } = authority;
const dec = new TextDecoder();
let out = '';
adoptCtxExports({
  SupervisorRPC: ({ props }) => new Proxy({}, {
    get(_target, name) {
      if (typeof name !== 'string' || name === 'then') return undefined;
      if (name === 'stdout' || name === 'stderr') return async (bytes) => { out += dec.decode(bytes); };
      if (name === 'reportExit') return async () => {};
      return (...args) => host.supervisorOp({ op: name, args, pid: props?.pid });
    },
  }),
});
const runnerDir = mkdtempSync(join(tmpdir(), 'nimbus-dynamic-import-'));
process.on('exit', () => rmSync(runnerDir, { recursive: true, force: true }));
let runnerN = 0;
const env = {
  LOADER: {
    load(config) {
      const file = writeModuleSet(join(runnerDir, `runner-${runnerN++}`), config.modules, 'runner.js');
      const loaded = import(pathToFileURL(file).href);
      const supervisor = config.env?.SUPERVISOR;
      return {
        getEntrypoint: () => ({
          async fetch(request) { return (await loaded).default.fetch(request, { SUPERVISOR: supervisor }); },
          [Symbol.dispose]() {},
        }),
        [Symbol.dispose]() {},
      };
    },
    get() { throw new Error('a one-shot exec never takes the keyed loader path'); },
  },
  ASSETS: {
    async fetch(request) {
      const path = new URL(request.url).pathname.replace(/^\//, '');
      return new Response(readFileSync(new URL(`../../packages/worker/public/${path}`, import.meta.url)));
    },
  },
};
const manager = new FacetManager(
  createFacetCtx(createFacetWorld(() => ({})), 'one-shot-dynamic-import'),
  env, host.processes, new PortRegistry(), processHostFor, {},
);
manager.setVfs(rawVfs, processFiles(rawVfs));
// esbuild itself, native, standing in for the wasm build the facet runs; the
// service's in-isolate path runs the same transform-then-rewrite.
const esbuild = new EsbuildService();
esbuild.ensureInit = async () => {};
esbuild._esbuild = await import('esbuild');
manager.setEsbuildService(esbuild);

for (const [rel, text] of Object.entries(files)) {
  const path = `${ROOT.slice(1)}/${rel}`;
  kfs.mkdir(path.slice(0, path.lastIndexOf('/')), { recursive: true, mode: 0o755 });
  kfs.writeFile(path, text);
}
kfs.writeFile(`${ROOT.slice(1)}/app/script.js`, SCRIPT);

const real = { console: globalThis.console, process: globalThis.process, Buffer: globalThis.Buffer };
const result = await manager.exec(SCRIPT, { filename: `${ROOT}/app/script.js`, dirname: `${ROOT}/app`, cwd: `${ROOT}/app`, captureOutput: true });
globalThis.console = real.console;
globalThis.process = real.process;
globalThis.Buffer = real.Buffer;
assert.equal(result.exitCode, 0, `the run failed: ${result.stderr}${out}`);
const printed = (out + result.stdout).trim().split('\n').at(-1);
assert.ok(printed.startsWith('['), `the program printed no report: ${result.stderr}${out}`);
const actual = JSON.parse(printed);

for (let i = 0; i < expected.length; i++) {
  assert.deepEqual(actual[i], expected[i], `${expected[i][0]}`);
}
assert.equal(actual.length, expected.length);

// A module at the filesystem root: its dirname is "/", as path.dirname gives
// for it under Node (no real root to write to here). It was "/.".
rawVfs.as(CRED_KERNEL).writeFile('meta-root.mjs', 'export const paths = [import.meta.dirname, import.meta.filename];\n');
const ROOT_SCRIPT = "import('/meta-root.mjs?q#f').then((m) => console.log(JSON.stringify(m.paths)));";
kfs.writeFile(`${ROOT.slice(1)}/app/root-script.js`, ROOT_SCRIPT);
out = '';
const rooted = await manager.exec(ROOT_SCRIPT, { filename: `${ROOT}/app/root-script.js`, dirname: `${ROOT}/app`, cwd: `${ROOT}/app`, captureOutput: true });
globalThis.console = real.console;
globalThis.process = real.process;
globalThis.Buffer = real.Buffer;
assert.equal(rooted.exitCode, 0, `the root-module run failed: ${rooted.stderr}${out}`);
assert.deepEqual(JSON.parse((out + rooted.stdout).trim().split('\n').at(-1)), ['/', '/meta-root.mjs'], 'a root-level module\'s dirname and filename');

console.log(`one-shot-dynamic-import-matches-node: ${expected.length} dynamic imports load and fail as node's do`);
