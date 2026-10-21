// @serial
// @tier slow — drives a local workerd session through every scenario.
// Native ES module review regressions, against host Node 22.23.4: failed
// require(esm), JSON's shared CommonJS cache, a late graph's failed
// evaluation, require/import namespace identity, transitive top-level
// await, Function's import origin, query identity, CommonJS/ESM cycles,
// link-error attribution beside suspended evaluation, cached imports,
// missing-export source arrows, commented JSON import attributes, CommonJS
// query/cache semantics, and constructor origins across module kinds and paths.
// stdout, stderr and the exit code are host Node's (lib/node-differential.mjs).

import { matchNodeInWorkerd } from './lib/node-differential.mjs';

const W = '/home/user/nesm-review';
const FILES = {
  // A failed synchronous evaluation is cached as a failure, not as a
  // partially evaluated namespace; subsequent import() sees it too.
  'failed-require/bad.mjs': "globalThis.evaluations++;\nthrow new Error('boom');\n",
  'failed-require/main.cjs': [
    'globalThis.evaluations = 0;',
    'for (let i = 0; i < 2; i++) {',
    "  try { require('./bad.mjs'); console.log('require unexpectedly resolved'); }",
    "  catch (e) { console.log('require', e.code, e.message); }",
    '}',
    "console.log('evaluations', globalThis.evaluations);",
    "import('./bad.mjs').then(",
    "  () => console.log('import unexpectedly resolved'),",
    "  (e) => console.log('import', e.code, e.message, 'evaluations', globalThis.evaluations),",
    ');',
  ].join('\n') + '\n',
  // Both orders share the parsed JSON object, including later mutations.
  'json-import-first/data.json': '{"n":1}\n',
  'json-import-first/main.mjs': [
    "import data from './data.json' with { type: 'json' };",
    "import { createRequire } from 'node:module';",
    "const required = createRequire(import.meta.url)('./data.json');",
    'console.log(data === required);',
    'data.n = 2;',
    'console.log(required.n);',
    'required.n = 3;',
    'console.log(data.n);',
  ].join('\n') + '\n',
  'json-require-first/data.json': '{"n":1}\n',
  'json-require-first/main.mjs': [
    "import { createRequire } from 'node:module';",
    "const required = createRequire(import.meta.url)('./data.json');",
    "const { default: data } = await import('./data.json', { with: { type: 'json' } });",
    'console.log(data === required);',
    'required.n = 2;',
    'console.log(data.n);',
    'data.n = 3;',
    'console.log(required.n);',
  ].join('\n') + '\n',
  // generated.mjs does not exist until execution. Its dependencies do:
  // a runtime-loaded graph must stop after the first throwing body.
  'late-stop/thrower.mjs': "globalThis.log.push('thrower');\nthrow new Error('boom');\n",
  'late-stop/after.mjs': "globalThis.log.push('after');\n",
  'late-stop/main.mjs': [
    "import { writeFileSync } from 'node:fs';",
    'globalThis.log = [];',
    'writeFileSync(new URL("./generated.mjs", import.meta.url), "import \'./thrower.mjs\';\\nimport \'./after.mjs\';\\n");',
    "try { await import('./generated.mjs'); console.log('import unexpectedly resolved'); }",
    "catch (e) { console.log('rejected', e.message); }",
    'console.log(JSON.stringify(globalThis.log));',
  ].join('\n') + '\n',
  // With no default export, require(esm) returns the actual namespace,
  // regardless of which loader first evaluated the module.
  'namespace-require-first/dep.mjs': 'export const x = 1;\n',
  'namespace-require-first/main.cjs': "const r = require('./dep.mjs');\nimport('./dep.mjs').then((i) => console.log(r === i));\n",
  // A module require() evaluated is the one a later import() gets, its
  // graph not resolved again: a dependency deleted since is not looked for.
  'adopted-then-unlinked/child.mjs': "export const c = 'child';\n",
  'adopted-then-unlinked/root.mjs': "import { c } from './child.mjs';\nexport const r = c;\n",
  'adopted-then-unlinked/main.cjs': [
    "const { unlinkSync } = require('node:fs');",
    "const r = require('./root.mjs');",
    "unlinkSync(require('node:path').join(__dirname, 'child.mjs'));",
    "import('./root.mjs').then((i) => console.log('same', r === i, i.r), (e) => console.log('rejected', e.code, e.message));",
  ].join('\n') + '\n',
  // A module the interpreter evaluates through a late graph, still in its
  // top-level await, is the one a later import() waits for: its namespace
  // once its evaluation completes, not before.
  'adopted-pending-tla/seed.mjs': 'export const seed = 1;\n',
  'adopted-pending-tla/slow.mjs': "import { seed } from './seed.mjs';\nexport let done = false;\nawait new Promise((resolve) => setTimeout(resolve, 300));\ndone = seed === 1;\n",
  'adopted-pending-tla/main.cjs': [
    "const { writeFileSync } = require('node:fs');",
    "require('./seed.mjs');",
    "writeFileSync(require('node:path').join(__dirname, 'bridge.mjs'), \"import './slow.mjs';\\n\");",
    "const bridge = import('./bridge.mjs');",
    '// Once the bridge has begun slow.mjs, which is in its top-level await.',
    "setTimeout(() => import('./slow.mjs').then((slow) => console.log('slow done', slow.done), (e) => console.log('rejected', e.code, e.message)), 30);",
    'bridge.catch((e) => console.log(\'bridge rejected\', e.message));',
  ].join('\n') + '\n',
  'namespace-import-first/dep.mjs': 'export const x = 1;\n',
  'namespace-import-first/main.mjs': "import { createRequire } from 'node:module';\nconst i = await import('./dep.mjs');\nconst r = createRequire(import.meta.url)('./dep.mjs');\nconsole.log(r === i);\n",
  // Finishing an asynchronous dependency does not make it (or its
  // synchronous parent) eligible for require(esm).
  'completed-tla/dep.mjs': 'await 0;\nexport const d = 1;\n',
  'completed-tla/parent.mjs': "import { d } from './dep.mjs';\nexport { d };\n",
  'completed-tla/main.mjs': [
    "import { createRequire } from 'node:module';",
    "await import('./dep.mjs');",
    'const require = createRequire(import.meta.url);',
    "for (const name of ['dep', 'parent']) {",
    "  try { console.log(name, 'required', require(`./${name}.mjs`).d); }",
    '  catch (e) { console.log(name, e.code); }',
    '}',
  ].join('\n') + '\n',
  // Constructor-created imports retain the native entry's origin, even
  // after startup and in an AsyncFunction. The parent is a deliberate decoy.
  'function-origin/dep.mjs': "export default 'parent';\n",
  'function-origin/sub/dep.mjs': "export default 'sub';\n",
  'function-origin/sub/entry.mjs': [
    'console.log("function", (await new Function(\'return import("./dep.mjs")\')()).default);',
    'console.log("timer", await new Promise((resolve, reject) => {',
    '  setTimeout(() => new Function(\'return import("./dep.mjs")\')().then((m) => resolve(m.default), reject), 0);',
    '}));',
    'const AsyncFunction = Object.getPrototypeOf(async function() {}).constructor;',
    'console.log("async-function", await new AsyncFunction(\'return (await import("./dep.mjs")).default\')());',
  ].join('\n') + '\n',
  // Queries and fragments are part of a static import's identity and URL.
  'static-query/counter.mjs': "export let n = 0;\nexport function inc() { n++; }\nexport const q = import.meta.url.split('?')[1];\nexport const f = import.meta.url.split('#')[1];\n",
  'static-query/main.mjs': [
    "import * as a from './counter.mjs?one';",
    "import * as b from './counter.mjs?two';",
    "import * as c from './counter.mjs#f';",
    "import * as d from './counter.mjs#g';",
    'a.inc();',
    'console.log(a === b, a.n, b.n, a.q, b.q);',
    'c.inc();',
    "console.log('fragment', c === d, a === c, c.n, d.n, c.f, d.f);",
  ].join('\n') + '\n',
  // This cycle is forbidden, with Node's uncaught error report and exit.
  'cjs-esm-cycle/entry.cjs': "require('./esm.mjs');\n",
  'cjs-esm-cycle/esm.mjs': "import e from './entry.cjs';\nexport const value = e;\n",
  // bad.mjs fails linking while a.mjs is suspended. The error belongs to
  // bad, not to every loading module; main explicitly resumes and awaits a.
  'suspended-link-error/a.mjs': [
    'globalThis.aStarted = true;',
    'globalThis.startA();',
    'await new Promise((resolve) => { globalThis.resumeA = resolve; });',
    "export const outcome = 'resolved';",
  ].join('\n') + '\n',
  'suspended-link-error/c.mjs': 'export const present = 1;\n',
  'suspended-link-error/bad.mjs': "import { missing } from './c.mjs';\nexport const value = missing;\n",
  'suspended-link-error/main.mjs': [
    'const started = new Promise((resolve) => { globalThis.startA = resolve; });',
    "const a = import('./a.mjs');",
    'await started;',
    "console.log('a started', globalThis.aStarted);",
    "try { await import('./bad.mjs'); console.log('bad unexpectedly resolved'); }",
    "catch (e) { console.log('bad', e.name, e.message); }",
    'globalThis.resumeA();',
    "try { console.log('a', (await a).outcome); }",
    "catch (e) { console.log('a', e.name, e.message); }",
  ].join('\n') + '\n',
  // Cached non-native imports must release their evaluation callbacks and
  // exit normally, without running the CommonJS body more than once.
  'cached-cjs/lib.cjs': "globalThis.evaluations = (globalThis.evaluations ?? 0) + 1;\nmodule.exports = { n: 1 };\n",
  'cached-cjs/main.mjs': [
    "const first = await import('./lib.cjs');",
    'for (let i = 0; i < 2000; i++) {',
    "  if (await import('./lib.cjs') !== first) throw new Error('changed namespace');",
    '}',
    "if (globalThis.evaluations !== 1) throw new Error('repeated evaluation');",
    "console.log('done');",
  ].join('\n') + '\n',
  'cached-json/data.json': '{"n":1}\n',
  'cached-json/main.mjs': [
    "const first = await import('./data.json', { with: { type: 'json' } });",
    'for (let i = 0; i < 2000; i++) {',
    "  if (await import('./data.json', { with: { type: 'json' } }) !== first) throw new Error('changed namespace');",
    '}',
    "console.log('done');",
  ].join('\n') + '\n',
  // The fatal source arrow belongs to the import's binding, not a later
  // equal string; preserve the original single-quoted module specifier.
  'missing-esm-export/dep.mjs': 'export const present = 1;\n',
  'missing-esm-export/main.mjs': "import { absent } from './dep.mjs';\nconst text = 'absent';\nconsole.log(text);\n",
  // Comments around the attributes clause are valid, including braces.
  'commented-json/d.json': '{"n":1}\n',
  'commented-json/main.mjs': "import d from './d.json' /* c */ with { type: 'json' } /* } */;\nconsole.log(d);\n",
  // CommonJS missing named exports have their own message and suggestion.
  'missing-cjs-export/lib.cjs': 'exports.present = 1;\n',
  'missing-cjs-export/main.mjs': "import { nope } from './lib.cjs';\nconst text = 'nope';\nconsole.log(text);\n",
  // Queries distinguish ES namespaces, not the underlying CommonJS module.
  'cjs-query/dep.cjs': "globalThis.evaluations = (globalThis.evaluations ?? 0) + 1;\nmodule.exports = { marker: 'cjs' };\n",
  'cjs-query/main.mjs': [
    "import a from './dep.cjs?a';",
    "import b from './dep.cjs?b';",
    "import { createRequire } from 'node:module';",
    "const required = createRequire(import.meta.url)('./dep.cjs');",
    'console.log(a === b, a === required, globalThis.evaluations);',
  ].join('\n') + '\n',
  // A typeless .js is CommonJS by its syntax: one module whatever the query.
  'js-query/dep.js': "globalThis.evaluations = (globalThis.evaluations ?? 0) + 1;\nmodule.exports = { marker: 'js' };\n",
  'js-query/main.mjs': [
    "import a from './dep.js?a';",
    "import b from './dep.js?b';",
    "import { createRequire } from 'node:module';",
    "const required = createRequire(import.meta.url)('./dep.js');",
    'console.log(a === b, a === required, globalThis.evaluations);',
  ].join('\n') + '\n',
  // A module whose query import made it the interpreter's, with top-level
  // await, imported and then required: Node refuses the require still.
  'adopted-tla/dep.mjs': 'export const x = 1;\n',
  'adopted-tla/parent.mjs': "import { x } from './dep.mjs?q';\nawait 0;\nexport { x };\n",
  'adopted-tla/main.mjs': [
    "import { createRequire } from 'node:module';",
    "const { x } = await import('./parent.mjs');",
    'console.log("imported", x);',
    "try { console.log('required', createRequire(import.meta.url)('./parent.mjs').x); } catch (e) { console.log('required', e.code); }",
  ].join('\n') + '\n',
  // A late graph that does not link runs none of its bodies: after.mjs is
  // staged (a literal import() names it) but never evaluates.
  'late-link/after.mjs': "console.log('after');\n",
  'late-link/main.mjs': [
    "import { writeFileSync } from 'node:fs';",
    "if (globalThis.never) await import('./after.mjs');",
    "writeFileSync(new URL('./generated.mjs', import.meta.url), \"import './after.mjs';\\nimport './missing.mjs';\\n\");",
    "try { await import('./generated.mjs'); } catch (e) { console.log('rejected', e.code); }",
  ].join('\n') + '\n',
  // The same where the module that does not link is staged (and a query's
  // instance): its staged sibling runs no body either.
  'late-link-staged/after.mjs': "console.log('after');\n",
  'late-link-staged/bad.mjs': "import './missing.mjs';\nconsole.log('bad');\n",
  'late-link-staged/variant.mjs': "import './missing-too.mjs';\nconsole.log('variant');\n",
  'late-link-staged/main.mjs': [
    "import { writeFileSync } from 'node:fs';",
    "if (globalThis.never) { await import('./after.mjs'); await import('./bad.mjs'); }",
    "writeFileSync(new URL('./generated.mjs', import.meta.url), \"import './after.mjs';\\nimport './bad.mjs';\\n\");",
    "try { await import('./generated.mjs'); } catch (e) { console.log('rejected', e.code); }",
    "writeFileSync(new URL('./generated-variant.mjs', import.meta.url), \"import './after.mjs?v';\\nimport './variant.mjs?v';\\n\");",
    "try { await import('./generated-variant.mjs'); } catch (e) { console.log('rejected', e.code); }",
  ].join('\n') + '\n',
  // A late graph that links, with a staged module whose query import
  // staging hands to the interpreter: every body runs once, in Node's order.
  'late-link-soft/a.mjs': "console.log('A');\n",
  'late-link-soft/b.mjs': "import './c.mjs?q';\nconsole.log('B');\n",
  'late-link-soft/c.mjs': "console.log('C');\n",
  'late-link-soft/main.mjs': [
    "import { writeFileSync } from 'node:fs';",
    "if (globalThis.never) { await import('./a.mjs'); await import('./b.mjs'); }",
    "writeFileSync(new URL('./generated.mjs', import.meta.url), \"import './a.mjs';\\nimport './b.mjs';\\n\");",
    "await import('./generated.mjs');",
    "console.log('done');",
  ].join('\n') + '\n',
  // A late graph whose staged module imports a name its target does not
  // export links no body either: Node's SyntaxError, before a.mjs runs.
  'late-link-export/a.mjs': "console.log('A');\n",
  'late-link-export/bad.mjs': "import { absent } from './empty.mjs';\nconsole.log('bad', absent);\n",
  'late-link-export/empty.mjs': 'export {};\n',
  'late-link-export/main.mjs': [
    "import { writeFileSync } from 'node:fs';",
    "if (globalThis.never) { await import('./a.mjs'); await import('./bad.mjs'); }",
    "writeFileSync(new URL('./generated.mjs', import.meta.url), \"import './a.mjs';\\nimport './bad.mjs';\\n\");",
    "try { await import('./generated.mjs'); } catch (e) { console.log('rejected', e.name, e.message); }",
    // The runtime-written module's own import of a missing name: no body runs before its SyntaxError.
    "writeFileSync(new URL('./generated-own.mjs', import.meta.url), \"import './a.mjs';\\nimport { absent } from './empty.mjs';\\n\");",
    "try { await import('./generated-own.mjs'); } catch (e) { console.log('rejected', e.name, e.message); }",
  ].join('\n') + '\n',
  // A late module's named imports link by the names their targets export:
  // through `export *` (never its default), from a CommonJS module by its
  // names (one a staged module imports, so the launch made its facade), from
  // another late module; a namespace needs none. A late module require()d
  // links by them too.
  'late-link-names/named.mjs': "export const x = 1;\nexport default 2;\n",
  'late-link-names/star.mjs': "export * from './named.mjs';\n",
  'late-link-names/plain.mjs': "export const y = 1;\n",
  'late-link-names/cjs.cjs': "exports.k = 1;\n",
  'late-link-names/uses-cjs.mjs': "export { k } from './cjs.cjs';\n",
  'late-link-names/main.mjs': [
    "import { writeFileSync } from 'node:fs';",
    "import { createRequire } from 'node:module';",
    "if (globalThis.never) { await import('./named.mjs'); await import('./star.mjs'); await import('./plain.mjs'); await import('./uses-cjs.mjs'); }",
    'const late = async (name, text) => {',
    '  writeFileSync(new URL(name, import.meta.url), text);',
    "  try { await import(name); } catch (e) { console.log(name, 'rejected', e.name, e.message); }",
    '};',
    "await late('./ok.mjs', \"import { x } from './star.mjs';\\nimport d from './named.mjs';\\nimport * as ns from './plain.mjs';\\nimport { k } from './cjs.cjs';\\nconsole.log('ok', x, d, Object.keys(ns), k);\\n\");",
    "await late('./no-default.mjs', \"import d from './plain.mjs';\\nconsole.log('no-default ran', d);\\n\");",
    "await late('./star-default.mjs', \"import s from './star.mjs';\\nconsole.log('star-default ran', s);\\n\");",
    "await late('./cjs-name.mjs', \"import { nope } from './cjs.cjs';\\nconsole.log('cjs-name ran', nope);\\n\");",
    "writeFileSync(new URL('./dep.mjs', import.meta.url), \"export const here = 1;\\n\");",
    "await late('./late-dep.mjs', \"import { absent } from './dep.mjs';\\nconsole.log('late-dep ran', absent);\\n\");",
    "writeFileSync(new URL('./required.mjs', import.meta.url), \"import { absent } from './plain.mjs';\\nconsole.log('required ran', absent);\\n\");",
    "try { createRequire(import.meta.url)('./required.mjs'); } catch (e) { console.log('require rejected', e.name, e.message); }",
  ].join('\n') + '\n',
  // A late graph with a module that does not parse links no body: the
  // import() rejects with its SyntaxError.
  'late-link-syntax/a.mjs': "console.log('A');\n",
  'late-link-syntax/main.mjs': [
    "import { writeFileSync } from 'node:fs';",
    "if (globalThis.never) await import('./a.mjs');",
    "writeFileSync(new URL('./bad.mjs', import.meta.url), 'export const = ;\\n');",
    "writeFileSync(new URL('./generated.mjs', import.meta.url), \"import './a.mjs';\\nimport './bad.mjs';\\n\");",
    // Its name: the order is what this checks; the parser's words are the interpreter's own.
    "try { await import('./generated.mjs'); } catch (e) { console.log('rejected', e.name); }",
    // A module that parses only as a script is no module either.
    "writeFileSync(new URL('./returns.mjs', import.meta.url), 'return 1;\\n');",
    "writeFileSync(new URL('./generated-return.mjs', import.meta.url), \"import './a.mjs';\\nimport './returns.mjs';\\n\");",
    "try { await import('./generated-return.mjs'); } catch (e) { console.log('rejected', e.name); }",
  ].join('\n') + '\n',
  // JSON's __esModule/default are data, not CommonJS interop instructions.
  'json-query-esmodule/data.json': '{"__esModule":true,"default":7}\n',
  'json-query-esmodule/main.mjs': "import v from './data.json?q' with { type: 'json' };\nconsole.log(JSON.stringify(v));\n",
  // A user-prepopulated, unloaded require.cache record is not evidence of
  // an active require(esm) cycle. Node uses its exports without evaluating.
  'prepopulated-cache/dep.cjs': "globalThis.evaluations = (globalThis.evaluations ?? 0) + 1;\nmodule.exports = { marker: 'evaluated' };\n",
  'prepopulated-cache/esm.mjs': "import dep from './dep.cjs';\nexport const value = dep;\n",
  'prepopulated-cache/main.cjs': [
    "const Module = require('module');",
    "const filename = require.resolve('./dep.cjs');",
    'const cached = new Module(filename);',
    'require.cache[filename] = cached;',
    "const esm = require('./esm.mjs');",
    'console.log(esm.value === cached.exports, globalThis.evaluations ?? 0, cached.loaded);',
  ].join('\n') + '\n',
  // A regexp after a block forces the grammar path, not a token scanner's
  // guess about division; its attributes clause still excludes the comment.
  'clause-comment-fallback/data.json': '{"n":1}\n',
  'clause-comment-fallback/main.mjs': "if (true) {} /import(\"node:fs\")/.test('');\nimport data from './data.json' with { type: 'json' } /* } */;\nconsole.log(data);\n",
  // The constructor's caller is an interpreted, runtime-written module,
  // not the main module that later invokes the exported factory.
  'interpreted-caller/lib/sub/x.mjs': "export default 'lib';\n",
  'interpreted-caller/sub/x.mjs': "export default 'main';\n",
  'interpreted-caller/main.mjs': [
    "import { writeFileSync } from 'node:fs';",
    `writeFileSync(new URL('./lib/b.mjs', import.meta.url), ${JSON.stringify("export const make = () => new (Object.getPrototypeOf(async function() {}).constructor)('return import(\"./sub/x.mjs\")');\n")});`,
    "const { make } = await import('./lib/b.mjs');",
    'console.log((await make()()).default);',
  ].join('\n') + '\n',
  // A literal question mark in a directory is a path character, not a URL
  // search delimiter. The shell command must preserve it as a literal.
  'odd-dir/a?b/dep.mjs': "export default 'odd-dir';\n",
  'odd-dir/dep.mjs': "export default 'parent';\n",
  'odd-dir/a?b/m.mjs': 'console.log((await new Function(\'return import("./dep.mjs")\')()).default);\n',
};
const COMMANDS = [
  'node failed-require/main.cjs',
  'node json-import-first/main.mjs',
  'node json-require-first/main.mjs',
  'node late-stop/main.mjs',
  'node namespace-require-first/main.cjs',
  'node namespace-import-first/main.mjs',
  'node adopted-then-unlinked/main.cjs',
  'node adopted-pending-tla/main.cjs',
  'node completed-tla/main.mjs',
  'node function-origin/sub/entry.mjs',
  'node static-query/main.mjs',
  'node cjs-esm-cycle/entry.cjs',
  'node suspended-link-error/main.mjs',
  'node cached-cjs/main.mjs',
  'node cached-json/main.mjs',
  'node missing-esm-export/main.mjs',
  'node commented-json/main.mjs',
  'node missing-cjs-export/main.mjs',
  'node cjs-query/main.mjs',
  'node js-query/main.mjs',
  'node late-link/main.mjs',
  'node late-link-staged/main.mjs',
  'node late-link-soft/main.mjs',
  'node late-link-syntax/main.mjs',
  'node late-link-export/main.mjs',
  'node late-link-names/main.mjs',
  'node adopted-tla/main.mjs',
  'node json-query-esmodule/main.mjs',
  'node prepopulated-cache/main.cjs',
  'node clause-comment-fallback/main.mjs',
  'node interpreted-caller/main.mjs',
  "node 'odd-dir/a?b/m.mjs'",
];

await matchNodeInWorkerd('native-esm-review-matches-node-workerd', W, FILES, COMMANDS);
