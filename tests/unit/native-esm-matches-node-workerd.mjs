// @serial
// @tier slow — drives a local workerd session through every scenario.
// ES modules as the registry evaluates them (core runtime/native-esm.ts,
// worker facets/esm-stage.ts), against host Node 22.23.4: evaluation order,
// cycles and their TDZ, microtask order, live bindings, top-level await,
// import.meta, import() identity, CommonJS and builtin namespaces, JSON,
// resolution under exports/imports conditions and its refusals,
// require(esm)'s values and refusals, a throw that stops a graph, top-level
// I/O (sync fs, timers, randomness, the clock), TypeScript Node strips, and
// package.json as Node's reader holds it.
// stdout, stderr and the exit code are host Node's (lib/node-differential.mjs).

import { matchNodeInWorkerd } from './lib/node-differential.mjs';

const W = '/home/user/nesm';
const json = (value) => JSON.stringify(value, null, 2);
const order = (name, deps) => [
  ...deps.map((dep) => `import { v_${dep} } from './${dep}.mjs';`),
  `export let v_${name} = '${name}';`,
  `globalThis.log.push('body:${name}' + [${deps.map((dep) => `(() => { try { return ':' + v_${dep}; } catch { return ':TDZ'; } })()`).join(', ')}].join(''));`,
  `Promise.resolve().then(() => globalThis.log.push('mt:${name}'));`,
].join('\n') + '\n';
const GRAPH = { main: ['a', 'b'], a: ['c'], b: ['c', 'd'], c: [], d: ['e'], e: ['f'], f: ['e', 'c'] };
const FILES = {
  ...Object.fromEntries(Object.entries(GRAPH).map(([name, deps]) => [`order/${name}.mjs`, order(name, deps)])),
  'order/run.mjs': "globalThis.log = [];\nPromise.resolve().then(() => log.push('pre-mt'));\nawait import('./main.mjs');\nlog.push('imported');\nsetTimeout(() => console.log(log.join(' ')), 10);\n",
  // Live bindings, and a namespace's shape.
  'live/counter.mjs': 'export let count = 0;\nexport function inc() { count++; }\nexport default function named() {}\n',
  'live/main.mjs': "import { count, inc } from './counter.mjs';\nimport * as ns from './counter.mjs';\nconsole.log(count); inc(); console.log(count, ns.count);\nconsole.log(Object.keys(ns), Object.prototype.toString.call(ns), Object.isExtensible(ns), ns.default.name);\nconst again = await import('./counter.mjs');\nconsole.log(again === ns);\n",
  // Top-level await and its order against a sibling.
  'tla/slow.mjs': "globalThis.log.push('slow:start');\nawait new Promise((resolve) => setTimeout(resolve, 5));\nglobalThis.log.push('slow:end');\nexport const slow = 1;\n",
  'tla/fast.mjs': "globalThis.log.push('fast');\nexport const fast = 2;\n",
  'tla/main.mjs': "globalThis.log = [];\nconst { slow } = await import('./both.mjs');\nconsole.log(log.join(' '), slow);\n",
  'tla/both.mjs': "import { slow } from './slow.mjs';\nimport { fast } from './fast.mjs';\nglobalThis.log.push('both');\nexport { slow, fast };\n",
  // import.meta, as Node gives it.
  'meta/sub/m.mjs': "console.log(Object.keys(import.meta), import.meta.url.endsWith('/meta/sub/m.mjs'), import.meta.filename.endsWith('/meta/sub/m.mjs'), import.meta.dirname.endsWith('/meta/sub'));\nconsole.log(import.meta.resolve('./x.js').endsWith('/meta/sub/x.js'), import.meta.resolve('node:fs'), typeof import.meta.resolve);\n",
  // CommonJS imported: its namespace's names and values, default as module.exports.
  'cjs/lib.cjs': "exports.a = 1;\nObject.defineProperty(exports, 'hidden', { enumerable: true, get() { return 'getter'; } });\nmodule.exports.later = 2;\nexports.default = 'own default';\nsetTimeout(() => { exports.a = 99; }, 0);\n",
  'cjs/fn.cjs': 'module.exports = function f() { return 7; };\nmodule.exports.x = 1;\n',
  'cjs/reexport.cjs': "module.exports = require('./lib.cjs');\n",
  'cjs/main.mjs': "import * as lib from './lib.cjs';\nimport def, { a } from './lib.cjs';\nimport f, { x } from './fn.cjs';\nimport * as re from './reexport.cjs';\nconsole.log(Object.keys(lib), def.default, a, lib.default === def);\nconsole.log(f(), x, Object.keys(re));\nsetTimeout(() => console.log('later', lib.a, a, def.a), 5);\n",
  'cjs/missing.mjs': "import { nope } from './lib.cjs';\nconsole.log(nope);\n",
  // Re-exports whose resolution require() refuses ("exports" hides the path) add no names.
  'cjs/node_modules/guarded/package.json': json({ name: 'guarded', exports: { '.': './index.js' } }),
  'cjs/node_modules/guarded/index.js': "exports.keep = 1;\nif (false) module.exports = require('guarded/private');\n",
  'cjs/node_modules/guarded/private.js': 'exports.secret = 1;\n',
  'cjs/node_modules/optional/package.json': json({ name: 'optional', exports: { '.': './index.js' } }),
  'cjs/node_modules/optional/index.js': "try { module.exports = require('optional/private'); } catch { exports.ok = true; }\n",
  'cjs/node_modules/optional/private.js': 'exports.secret = 2;\n',
  'cjs/reexports.mjs': "import { keep } from 'guarded';\nimport * as optional from 'optional';\nconsole.log(keep, Object.keys(optional), optional.ok);\n",
  // Builtins: default and named, and syncBuiltinESMExports.
  'builtin/main.mjs': "import fs, { readFileSync } from 'node:fs';\nimport * as path from 'path';\nimport module from 'node:module';\nconsole.log(fs.readFileSync === readFileSync, typeof path.join, path.default === path.default, 'sep' in path);\nfs.readFileSync = () => 'patched';\nmodule.syncBuiltinESMExports();\nconst again = await import('node:fs');\nconsole.log(again.readFileSync(), readFileSync());\n",
  // JSON with its attribute, and without it.
  'json/data.json': '{ "a": 1, "__proto__": { "b": 2 } }\n',
  'json/main.mjs': "import data from './data.json' with { type: 'json' };\nconsole.log(data.a, Object.keys(data), Object.getPrototypeOf(data) === Object.prototype);\nconst again = await import('./data.json', { with: { type: 'json' } });\nconsole.log(again.default === data);\n",
  'json/bare.mjs': "import data from './data.json';\nconsole.log(data);\n",
  // Resolution: exports and imports under conditions, type, refusals.
  'res/node_modules/pkg/package.json': json({ name: 'pkg', type: 'module', exports: { '.': { import: './esm.js', require: './cjs.cjs' }, './sub': './sub.js' }, imports: { '#inner': { node: './inner.js' } } }),
  'res/node_modules/pkg/esm.js': "import inner from '#inner';\nexport default 'esm:' + inner;\n",
  'res/node_modules/pkg/cjs.cjs': "module.exports = 'cjs';\n",
  'res/node_modules/pkg/sub.js': "export const sub = 'sub';\n",
  'res/node_modules/pkg/inner.js': "export default 'inner';\n",
  'res/node_modules/pkg/hidden.js': "export default 'hidden';\n",
  'res/main.mjs': "import pkg from 'pkg';\nimport { sub } from 'pkg/sub';\nimport { createRequire } from 'node:module';\nconsole.log(pkg, sub, createRequire(import.meta.url)('pkg'));\n",
  'res/hidden.mjs': "import hidden from 'pkg/hidden.js';\nconsole.log(hidden);\n",
  'res/absent.mjs': "import absent from 'no-such-package';\nconsole.log(absent);\n",
  'res/noext.mjs': "import { sub } from './node_modules/pkg/sub';\nconsole.log(sub);\n",
  'res/dir.mjs': "import x from './node_modules/pkg';\nconsole.log(x);\n",
  'res/dynamic.mjs': "try { await import('no-such-package'); } catch (e) { console.log(e.code, e.message); }\ntry { await import('pkg/hidden.js'); } catch (e) { console.log(e.code, e.message); }\nconsole.log((await import('pkg')).default);\n",
  // require(esm): values, the facade, refusals.
  'req/esm.mjs': "export const named = 1;\nexport default 'dflt';\n",
  'req/nodefault.mjs': "export const only = 1;\n",
  'req/exportsas.mjs': "const v = { y: 1 };\nexport { v as 'module.exports' };\nexport const z = 3;\n",
  'req/tla.mjs': "globalThis.ranTla = true;\nawait 0;\nexport const t = 1;\n",
  'req/main.cjs': "const esm = require('./esm.mjs');\nconsole.log(esm.__esModule, esm.default, esm.named, Object.keys(esm));\nconst none = require('./nodefault.mjs');\nconsole.log(Object.keys(none), none.__esModule);\nconsole.log(require('./exportsas.mjs'));\ntry { require('./tla.mjs'); } catch (e) { console.log(e.code); }\n",
  // What each result Nimbus makes is as an object: Node's facade is a
  // namespace, which refuses every write.
  'req/shape.cjs': [
    'const shape = (value) => ({',
    '  keys: Reflect.ownKeys(value).map(String), tag: Object.prototype.toString.call(value), extensible: Object.isExtensible(value),',
    '  descriptors: Object.entries(Object.getOwnPropertyDescriptors(value)).map(([key, d]) => [key, d.writable, d.enumerable, d.configurable, typeof d.value, typeof d.get]),',
    "  set: Reflect.set(value, '__esModule', false), setDefault: Reflect.set(value, 'default', 0), add: Reflect.set(value, 'added', 1),",
    "  define: Reflect.defineProperty(value, '__esModule', { value: false }), same: Reflect.defineProperty(value, '__esModule', { value: value.__esModule }),",
    "  accessor: Reflect.defineProperty(value, 'default', { get() {} }), remove: Reflect.deleteProperty(value, '__esModule'), absent: Reflect.deleteProperty(value, 'absent'),",
    '  nullProto: Reflect.setPrototypeOf(value, null), proto: Reflect.setPrototypeOf(value, {}), sealed: Object.isSealed(value), esModule: value.__esModule,',
    '});',
    "for (const [file, value, again] of [['./esm.mjs', require('./esm.mjs'), require('./esm.mjs')], ['./exportsas.mjs', require('./exportsas.mjs'), require('./exportsas.mjs')]]) {",
    '  console.log(file, JSON.stringify(shape(value)), value === again, value.__esModule);',
    '}',
    '',
  ].join('\n'),
  'req/later.mjs': "import { createRequire } from 'node:module';\nconst ns = await import('./nodefault.mjs');\nconst required = createRequire(import.meta.url)('./nodefault.mjs');\nconsole.log(required === ns);\n",
  'req/cycle-a.mjs': "import './cycle-b.mjs';\nexport const a = 1;\n",
  'req/cycle-b.mjs': "import { createRequire } from 'node:module';\ntry { createRequire(import.meta.url)('./cycle-a.mjs'); } catch (e) { console.log(e.code); }\n",
  // A bin that loads its program through require() first (pi's): staging
  // imports it (esm-require-hoist.ts); one whose prefix is observable keeps
  // the require at its call: a statement, a pattern's default, a heritage.
  'hoist/bin.mjs': '#!/usr/bin/env node\nimport { createRequire, enableCompileCache } from "node:module";\n\nenableCompileCache();\ncreateRequire(import.meta.url)("./app.mjs");\n',
  'hoist/app.mjs': "import { dep } from './dep.mjs';\nconsole.log('app', dep, typeof import.meta.url);\nexport const ready = true;\n",
  'hoist/dep.mjs': "console.log('dep');\nexport const dep = 1;\n",
  'hoist/observed.mjs': "import { createRequire } from 'node:module';\nconsole.log('before');\nconst ns = createRequire(import.meta.url)('./app2.mjs');\nconsole.log('after', ns.v, Object.keys(ns));\n",
  'hoist/app2.mjs': "console.log('app2');\nexport default 1;\nexport const v = 2;\n",
  'hoist/pattern.mjs': "import { createRequire } from 'node:module';\nconst require = createRequire(import.meta.url);\nfunction bootstrap() { console.log('bootstrap'); }\nconst { setup = bootstrap() } = require('./settings.mjs');\nrequire('./app.mjs');\n",
  'hoist/settings.mjs': "console.log('settings');\nexport const other = 1;\n",
  'hoist/default.mjs': "import { createRequire } from 'node:module';\nconst { x = console.log('prefix') } = 0;\ncreateRequire(import.meta.url)('./app.mjs');\n",
  'hoist/heritage.mjs': "import { createRequire } from 'node:module';\nclass C extends undefined {}\ncreateRequire(import.meta.url)('./app.mjs');\n",
  // require() of an evaluated graph with top-level await still refuses it.
  'req/tla-after.mjs': "import { createRequire } from 'node:module';\nawait import('./tla.mjs');\ntry { createRequire(import.meta.url)('./tla.mjs'); } catch (e) { console.log(e.code); }\n",
  // A throw stops the graph where Node's evaluation stops.
  'stop/c.mjs': "console.log('c');\n",
  'stop/thrower.mjs': "console.log('thrower');\nthrow new Error('boom');\n",
  'stop/after.mjs': "console.log('after');\n",
  'stop/bad.mjs': "import './c.mjs';\nimport './thrower.mjs';\nimport './after.mjs';\nconsole.log('bad');\n",
  'stop/run.mjs': "try { await import('./bad.mjs'); } catch (e) { console.log('rejected', e.message); }\ntry { await import('./bad.mjs'); } catch (e) { console.log('again', e.message); }\nawait import('./after.mjs');\nconsole.log('after imported');\n",
  // What a module's top level may do: sync fs, timers, randomness, the clock.
  'io/data.txt': 'payload\n',
  'io/leaf.mjs': "import { readFileSync, statSync } from 'node:fs';\nimport { randomUUID } from 'node:crypto';\nexport const text = readFileSync(new URL('./data.txt', import.meta.url), 'utf8').trim();\nexport const size = statSync(new URL('./data.txt', import.meta.url)).size;\nexport const uuid = randomUUID().length;\nexport const now = Date.now() > 1e12;\nexport const timer = await new Promise((resolve) => setTimeout(() => resolve('fired'), 1));\n",
  'io/main.mjs': "import { text, size, uuid, now, timer } from './leaf.mjs';\nconsole.log(text, size, uuid, now, timer, crypto.getRandomValues(new Uint8Array(2)).length);\n",
  // CommonJS names in an ES module's scope (module-format-matches-node-workerd has the rest).
  'scope/req.mjs': "console.log(typeof require, typeof module, typeof __filename, this);\nrequire('fs');\n",
  // TypeScript Node strips, as an ES module.
  'ts/package.json': json({ type: 'module' }),
  'ts/lib.ts': "export function twice(n: number): number { return n * 2; }\nexport type T = string;\n",
  'ts/main.ts': "import { twice, type T } from './lib.ts';\nconst label: T = 'twice';\nconsole.log(label, twice(21), import.meta.url.endsWith('/ts/main.ts'));\n",
  // package.json as Node's reader holds it: read once (the rewrite to
  // commonjs is not seen), an absent one read when written later (the
  // second file is then an ES module, its `exports` unbound).
  'pjson/package.json': json({ name: 'pjson' }),
  'pjson/main.mjs': [
    "import { mkdirSync, writeFileSync } from 'node:fs';",
    "const dir = new URL('./late/', import.meta.url);",
    'mkdirSync(dir, { recursive: true });',
    "const kind = async (name, text) => { writeFileSync(new URL(name, dir), text); try { const ns = await import(new URL(name, dir)); return ns.kind ?? ns.default?.kind; } catch (e) { return e.name; } };",
    "console.log('typeless', await kind('a.js', 'exports.kind = typeof module;'));",
    "writeFileSync(new URL('package.json', dir), JSON.stringify({ type: 'module' }));",
    "console.log('written', await kind('b.js', 'exports.kind = typeof module;'));",
    "writeFileSync(new URL('package.json', dir), JSON.stringify({ type: 'commonjs' }));",
    "console.log('rewritten', await kind('c.js', 'exports.kind = typeof module;'));",
  ].join('\n') + '\n',
  // A .js written at run time, imported: an ES module by its syntax alone
  // warns of its typeless package.json, once (Node's detection); CommonJS does not.
  'detect/package.json': json({ name: 'detect' }),
  'detect/main.mjs': [
    "import { writeFileSync } from 'node:fs';",
    "const write = (name, text) => { const url = new URL(name, import.meta.url); writeFileSync(url, text); return url; };",
    "console.log('first', (await import(write('gen.js', 'export const kind = typeof module;'))).kind);",
    "console.log('second', (await import(write('gen2.js', 'export const kind = typeof require;'))).kind);",
    "console.log('cjs', (await import(write('gen3.js', 'exports.kind = typeof module;'))).default.kind);",
  ].join('\n') + '\n',
  // A working-tree module no code reaches is carried as a file, not staged
  // (manager.ts dataModules); a computed import() of it still loads it, as
  // Node's does: its namespace, import.meta, its frames, one instance.
  'dyncwd/lib.mjs': "export const v = 'lib';\nexport default import.meta.url.endsWith('/dyncwd/lib.mjs');\nexport function where() { return new Error('here').stack.split('\\n')[1].includes('/dyncwd/lib.mjs'); }\n",
  'dyncwd/main.mjs': "const name = './li' + 'b.mjs';\nconst m = await import(name);\nconsole.log(m.v, m.default, m.where(), (await import(name)) === m);\n",
  // An uncaught error's report.
  'fatal/main.mjs': "import { sep } from 'node:path';\nconst x = sep.length;\nthrow new TypeError('fatal ' + x);\n",
  'fatal/syntax.mjs': "import './broken.mjs';\nconsole.log('never');\n",
  'fatal/broken.mjs': "export const a = 1;\nconst = 2;\n",
};
const COMMANDS = [
  'node order/run.mjs', 'node live/main.mjs', 'node tla/main.mjs', 'node meta/sub/m.mjs', 'node cjs/main.mjs', 'node cjs/missing.mjs',
  'node builtin/main.mjs', 'node json/main.mjs', 'node json/bare.mjs', 'node res/main.mjs', 'node res/hidden.mjs', 'node res/absent.mjs',
  'node res/noext.mjs', 'node res/dir.mjs', 'node res/dynamic.mjs', 'node req/main.cjs', 'node req/shape.cjs', 'node cjs/reexports.mjs', 'node req/later.mjs', 'node req/cycle-a.mjs',
  'node hoist/bin.mjs', 'node hoist/observed.mjs', 'node hoist/pattern.mjs', 'node hoist/default.mjs', 'node hoist/heritage.mjs', 'node req/tla-after.mjs', 'node stop/run.mjs', 'node io/main.mjs', 'node scope/req.mjs', 'node ts/main.ts', 'node fatal/main.mjs', 'node fatal/syntax.mjs', 'node pjson/main.mjs', 'node detect/main.mjs', 'node dyncwd/main.mjs',
  `node --input-type=module -e "import { sep } from 'node:path'; console.log(sep, import.meta.url.endsWith('/[eval1]'), typeof await Promise.resolve(1));"`,
  `node --import ./live/counter.mjs -e "console.log('preloaded')"`,
];

await matchNodeInWorkerd('native-esm-matches-node-workerd', W, FILES, COMMANDS);
