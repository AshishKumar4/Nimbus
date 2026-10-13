// @serial
// @tier slow — drives a local workerd session through every scenario.
// A module a program writes after its launch began (the interpreter's) and
// the launch's own staged modules (the registry's) import the same modules
// with Node 22's meaning, against host Node 22.22.3:
//   - a CommonJS module's namespace is its translator's: `default` is
//     module.exports whatever `__esModule` says, its names are
//     cjs-module-lexer's, and their values the ones it had once it ran;
//   - `export *` of two modules that export one name from different
//     bindings exports neither (an import of it is a SyntaxError), and two
//     routes to one binding are one name;
//   - import attributes are checked as Node's loader checks them: JSON needs
//     `type: 'json'`, JavaScript and builtins must not have it, an unknown
//     key or type is refused, on an import and an export-from alike.
// stdout, stderr and the exit code are host Node's (lib/node-differential.mjs).

import { matchNodeInWorkerd } from './lib/node-differential.mjs';

const W = '/home/user/nesm-namespaces';

/** A program that writes `name` with `text` at run time and imports it, printing what it got or how it was refused. */
const late = (names) => [
  "import { writeFileSync } from 'node:fs';",
  'const late = async (name, text) => {',
  '  writeFileSync(new URL(name, import.meta.url), text);',
  "  try { await import(name); } catch (e) { console.log(name, 'rejected', e.name, e.code, e.message); }",
  '};',
  ...names.map(([name, text]) => `await late(${JSON.stringify(name)}, ${JSON.stringify(text)});`),
].join('\n') + '\n';

/** The same imports, as a staged module's: each written before the launch, imported by the entry. */
const staged = (names) => [
  ...names.map(([name]) => `try { await import(${JSON.stringify(name)}); } catch (e) { console.log(${JSON.stringify(name)}, 'rejected', e.name, e.code, e.message); }`),
].join('\n') + '\n';

const CJS_CASES = [
  ['./flag.mjs', "import d from './flag.cjs';\nimport * as ns from './flag.cjs';\nconsole.log('flag', JSON.stringify(d), JSON.stringify(ns.default), ns.__esModule);\n"],
  ['./snapshot.mjs', "import { x, bump } from './live.cjs';\nimport * as ns from './live.cjs';\nbump();\nconsole.log('snapshot', x, ns.x);\n"],
  ['./names.mjs', "import * as ns from './hidden.cjs';\nconsole.log('names', Object.keys(ns).join());\n"],
  ['./hidden-name.mjs', "import { z } from './hidden.cjs';\nconsole.log('hidden-name ran', z);\n"],
  ['./reexport.mjs', "import { a, b } from './reexports.cjs';\nconsole.log('reexport', a, b);\n"],
];
const STAR_CASES = [
  ['./star-ns.mjs', "import * as ns from './barrel.mjs';\nconsole.log('star-ns', 'x' in ns, Object.keys(ns).join());\n"],
  ['./star-named.mjs', "import { x } from './barrel.mjs';\nconsole.log('star-named ran', x);\n"],
  ['./star-same.mjs', "import { x } from './same-barrel.mjs';\nimport * as ns from './same-barrel.mjs';\nconsole.log('star-same', x, Object.keys(ns).join());\n"],
  ['./star-own.mjs', "import { x } from './own-barrel.mjs';\nconsole.log('star-own', x);\n"],
];
const ATTRIBUTE_CASES = [
  ['./json-missing.mjs', "import d from './data.json';\nconsole.log('json-missing ran', d);\n"],
  ['./json-ok.mjs', "import d from './data.json' with { type: 'json' };\nconsole.log('json-ok', JSON.stringify(d));\n"],
  ['./js-as-json.mjs', "import d from './plain.mjs' with { type: 'json' };\nconsole.log('js-as-json ran', d);\n"],
  ['./builtin-as-json.mjs', "import fs from 'node:fs' with { type: 'json' };\nconsole.log('builtin-as-json ran', typeof fs);\n"],
  ['./unknown-type.mjs', "import d from './data.json' with { type: 'css' };\nconsole.log('unknown-type ran', d);\n"],
  ['./unknown-key.mjs', "import d from './data.json' with { type: 'json', mode: 'x' };\nconsole.log('unknown-key ran', d);\n"],
  ['./export-from-missing.mjs', "export { default } from './data.json';\nconsole.log('export-from-missing ran');\n"],
];

const FILES = {
  'cjs/flag.cjs': 'module.exports = { __esModule: true, default: 7 };\n',
  'cjs/live.cjs': 'exports.x = 1;\nexports.bump = () => { exports.x = 2; };\n',
  'cjs/hidden.cjs': 'const o = {};\no.z = 1;\nmodule.exports = o;\n',
  'cjs/reexports.cjs': "module.exports = require('./inner.cjs');\n",
  'cjs/inner.cjs': 'exports.a = 1;\nexports.b = 2;\n',
  'cjs/main.mjs': late(CJS_CASES),
  'cjs-staged/flag.cjs': 'module.exports = { __esModule: true, default: 7 };\n',
  'cjs-staged/live.cjs': 'exports.x = 1;\nexports.bump = () => { exports.x = 2; };\n',
  'cjs-staged/hidden.cjs': 'const o = {};\no.z = 1;\nmodule.exports = o;\n',
  'cjs-staged/reexports.cjs': "module.exports = require('./inner.cjs');\n",
  'cjs-staged/inner.cjs': 'exports.a = 1;\nexports.b = 2;\n',
  ...Object.fromEntries(CJS_CASES.map(([name, text]) => [`cjs-staged/${name.slice(2)}`, text])),
  'cjs-staged/main.mjs': staged(CJS_CASES),

  'star/a.mjs': "export const x = 'a';\nexport const onlyA = 1;\n",
  'star/b.mjs': "export const x = 'b';\n",
  'star/via-a.mjs': "export { x } from './a.mjs';\n",
  'star/barrel.mjs': "export * from './a.mjs';\nexport * from './b.mjs';\n",
  'star/same-barrel.mjs': "export * from './a.mjs';\nexport * from './via-a.mjs';\n",
  'star/own-barrel.mjs': "export * from './a.mjs';\nexport * from './b.mjs';\nexport const x = 'own';\n",
  // barrel.mjs and same-barrel.mjs are staged (the registry's export *); the
  // late barrels are written at run time (the interpreter's).
  'star/main.mjs': "if (globalThis.never) { await import('./barrel.mjs'); await import('./same-barrel.mjs'); }\n" + late([
    ['./late-barrel.mjs', "export * from './a.mjs';\nexport * from './b.mjs';\n"],
    ['./late-same-barrel.mjs', "export * from './a.mjs';\nexport * from './via-a.mjs';\n"],
    ...STAR_CASES,
    ['./late-star-ns.mjs', "import * as ns from './late-barrel.mjs';\nconsole.log('late-star-ns', 'x' in ns, Object.keys(ns).join());\n"],
    ['./late-star-named.mjs', "import { x } from './late-barrel.mjs';\nconsole.log('late-star-named ran', x);\n"],
    ['./late-star-same.mjs', "import { x } from './late-same-barrel.mjs';\nconsole.log('late-star-same', x);\n"],
  ]),
  ...Object.fromEntries(['a.mjs', 'b.mjs', 'via-a.mjs', 'barrel.mjs', 'same-barrel.mjs', 'own-barrel.mjs'].map((name) => [`star-staged/${name}`, null])),
  ...Object.fromEntries(STAR_CASES.map(([name, text]) => [`star-staged/${name.slice(2)}`, text])),
  'star-staged/main.mjs': staged(STAR_CASES),

  'attributes/data.json': '{"n":1}\n',
  'attributes/plain.mjs': 'export default 1;\n',
  'attributes/main.mjs': late(ATTRIBUTE_CASES),
  'attributes-staged/data.json': '{"n":1}\n',
  'attributes-staged/plain.mjs': 'export default 1;\n',
  ...Object.fromEntries(ATTRIBUTE_CASES.map(([name, text]) => [`attributes-staged/${name.slice(2)}`, text])),
  'attributes-staged/main.mjs': staged(ATTRIBUTE_CASES),
};
for (const name of Object.keys(FILES)) if (FILES[name] === null) FILES[name] = FILES[name.replace('star-staged/', 'star/')];

const COMMANDS = [
  'node cjs/main.mjs',
  'node cjs-staged/main.mjs',
  'node star/main.mjs',
  'node star-staged/main.mjs',
  'node attributes/main.mjs',
  'node attributes-staged/main.mjs',
];

await matchNodeInWorkerd('native-esm-namespaces-matches-node-workerd', W, FILES, COMMANDS);
