// @serial
// @tier slow — drives a local workerd session through every program.
// Which module system a source runs under is Node's answer (doc/api/packages.md
// "Determining module system"; syntax detection is on by default from
// v22.7.0): a file with no package "type" is an ES module when it holds
// syntax that only a module can (an import or export, import.meta, a
// top-level await, a top-level `const require`), as V8's first error
// compiling it as CommonJS names it (src/node_contextify.cc), and so is `-e`
// code or a program on stdin, compiled with no wrapper's names, unless
// --input-type says otherwise.
//
// The runtime used to read module syntax as a top-level import or export
// alone, and `-e` and stdin code not at all: a module whose only module
// syntax was import.meta ran as CommonJS and failed to compile ("Cannot use
// 'import.meta' outside a module"), required or imported, as did a script
// with a top-level await; `node --input-type=module -e "import …"` failed
// with "Cannot use import statement outside a module".
//
// An ES module has none of CommonJS's names. Using one throws V8's
// ReferenceError ("require is not defined") from the module's own frame,
// and Node's loader completes the message where it leaves the module's job
// (an entry, an import(), a require() of it): "in ES module scope", the
// package.json that made a .js a module, or top-level await's ambiguity.
//
// One fixture tree, on disk for real node and in a local workerd session's
// filesystem for the shell's `node` (lib/node-differential.mjs): each run's
// stdout, stderr and exit code must be node's. An ES module is the
// registry's own (core runtime/native-esm.ts), which only V8 evaluates as
// Node does: Bun, an in-process harness, reads one that mentions `exports`
// as CommonJS.

import { SEED_FILES, SEED_PROJECT_DIR } from '../../packages/core/src/vfs/seed-project.ts';
import { matchNodeInWorkerd, shellWord } from './lib/node-differential.mjs';

const ROOT = '/home/user/fmt';
const line = (...parts) => `console.log(JSON.stringify([${parts.join(', ')}]));\n`;
// What an ES module's scope is: strict, no `this`, no CommonJS wrapper name.
const SCOPE_PARTS = [
  'this === undefined', '(function () { return this; })() === undefined',
  'typeof require', 'typeof module', 'typeof exports', 'typeof __filename', 'typeof __dirname',
];
const SCOPE = (label) => line(`'${label}'`, ...SCOPE_PARTS);
const SCOPE_DEP = (name) => `globalThis.${name} = [${SCOPE_PARTS.join(', ')}];\n`;
const files = {
  'package.json': JSON.stringify({ name: 'fmt', private: true }),
  // Typeless files whose only module syntax is one of Node's other kinds.
  'meta.js': line("'meta'", 'typeof import.meta.url', "import.meta.url.endsWith('/meta.js')"),
  'tla.js': line("'tla'", 'await Promise.resolve(1)'),
  'redeclare.js': `const require = 'mine';\n${line("'redeclare'", 'require')}`,
  // A top-level lexical binding of a wrapper name through any pattern,
  // declarator or escape: V8's redeclaration, which Node retries as a module.
  'destructured.js': `const { __filename } = {};\n${line("'destructured'", 'typeof require')}`,
  'declarators.js': `const a = 1, require = 2;\n${line("'declarators'", 'typeof module', 'require')}`,
  'escaped.js': `const requir\\u0065 = 3;\n${line("'escaped'", 'typeof module', 'require')}`,
  'pattern.js': `let { a: [, exports] } = { a: [0, 4] };\n${line("'pattern'", 'typeof module', 'exports')}`,
  'class.js': `class module {}\n${line("'class'", 'typeof require', 'typeof module')}`,
  // Not one: in a block, a var, a function, a class expression's name.
  'not-bindings.js': `{ const require = 5; }\nvar exports = 6;\nfunction __dirname() {}\nconst C = class module {};\n${line("'not-bindings'", 'typeof require', 'exports', 'typeof __dirname')}`,
  // Top-level awaits V8 finds where a call, a parenthesis or a conditional
  // wants another token: errors Node retries as a module.
  'awaits.js': `const v = [(await 1), f(await 2), true ? await 3 : 0];\nfunction f(x) { return x; }\n${line("'awaits'", 'v', 'typeof require')}`,
  // One in a template's ${}: V8's "Missing } in template expression", which
  // Node does not retry, so CommonJS, which cannot compile it.
  'template-await.js': 'console.log(`${await 1}`);\n',
  // `typeof` of a CommonJS name is 'undefined' in a module; text that only
  // reads so (a string, a template, a regular expression) is the module's.
  'typeofs.mjs': `const text = ['typeof __nimbusEsmScope.require', \`typeof __nimbusEsmScope.module \${typeof exports}\`, /typeof __nimbusEsmScope.__dirname/.source];\n// typeof __nimbusEsmScope.__filename\n${line("'typeofs'", 'text', 'typeof require', 'typeof (__filename)')}`,
  // CommonJS that only looks like it: an await in an arrow's body, a function named await.
  'arrow.js': `const f = async () => await 1;\nf().then((v) => { ${line("'arrow'", 'typeof require', 'v').trim()} });\n`,
  'awaitcall.js': `function await(x) { return x; }\n${line("'awaitcall'", 'typeof require', 'await(2)')}`,
  // A module whose only module syntax is import.meta, imported, required, and installed.
  'meta-dep.js': "globalThis.metaDep = import.meta.url.endsWith('/meta-dep.js');\n",
  'imp.cjs': `import('./meta-dep.js').then(() => { ${line("'import'", 'globalThis.metaDep').trim()} });\n`,
  'meta-req.js': 'globalThis.metaReq = typeof import.meta.url;\n',
  'req.cjs': `require('./meta-req.js');\n${line("'require'", 'globalThis.metaReq')}`,
  'node_modules/metapkg/package.json': JSON.stringify({ name: 'metapkg', version: '1.0.0', main: 'index.js' }),
  'node_modules/metapkg/index.js': 'globalThis.metaPkg = typeof import.meta.url;\n',
  'pkg.cjs': `require('metapkg');\n${line("'package'", 'globalThis.metaPkg')}`,
  // An ES module by its extension or its package's "type", whatever its
  // syntax: strict, `this` undefined, none of CommonJS's wrapper names.
  'plain.mjs': SCOPE('mjs'),
  'typed/package.json': JSON.stringify({ name: 'typed', type: 'module' }),
  'typed/plain.js': SCOPE('type-module'),
  'typed/dep.js': SCOPE_DEP('typedDep'),
  'plain-dep.mjs': SCOPE_DEP('mjsDep'),
  'deps.cjs': `import('./plain-dep.mjs').then(() => import('./typed/dep.js')).then(() => { ${line("'deps'", 'globalThis.mjsDep', 'globalThis.typedDep').trim()} });\n`,
  // One with module syntax, and one that makes its own require.
  'esm-scope.mjs': `import { sep } from 'node:path';\n${line("'esm-scope'", 'typeof require', 'typeof exports', 'typeof __filename', 'sep')}`,
  'own-require.mjs': `import { createRequire } from 'node:module';\nconst require = createRequire(import.meta.url);\n${line("'own-require'", 'typeof require', "require('node:path').sep")}`,
  // What Node refuses: a require in an ES module, an import in a .cjs or a type:commonjs .js.
  'require-in-esm.mjs': "require('node:path');\n",
  // What a CommonJS name in an ES module throws: V8's ReferenceError, which
  // Node's loader explains where it leaves the module's job (an entry, an
  // import(), a require()), naming the package that made a .js a module, or
  // naming top-level await; anywhere else it is V8's own.
  'typed/module-exports.js': 'module.exports = 1;\n',
  'chain.mjs': "import './typed/module-exports.js';\n",
  'tla-require.mjs': "await 1;\nrequire('node:path');\n",
  'tla-scope.mjs': `await 0;\n${SCOPE('tla-scope')}`,
  'caught.mjs': 'try { exports.x = 1; } catch (e) { globalThis.caught = [e.name, e.message]; }\nexport {};\n',
  'scope-errors.cjs': `const report = [];
try { require('./require-in-esm.mjs'); } catch (e) { report.push(['require', e.name, e.message, e.code ?? null]); }
import('./typed/module-exports.js').catch((e) => { report.push(['import', e.name, e.message, e.code ?? null]); })
  .then(() => import('./tla-require.mjs')).catch((e) => { report.push(['tla', e.name, e.message, e.code ?? null]); })
  .then(() => import('./caught.mjs')).then(() => { report.push(['caught', ...globalThis.caught]); console.log(JSON.stringify(report)); });
`,
  'import-in.cjs': "import { sep } from 'node:path';\nconsole.log(sep);\n",
  // The starter a session is seeded with: its JavaScript is correct Node in
  // the module format its package.json gives it (a Vite project, "type":
  // "module"), and loads as node loads it.
  ...Object.fromEntries(SEED_FILES.filter(({ path }) => /\.(?:m?js|cjs|json)$/.test(path))
    .map(({ path, content }) => [`example-app/${path.slice(SEED_PROJECT_DIR.length + 1)}`, content])),
  'seed.mjs': `import { readFileSync } from 'node:fs';\nimport config from './example-app/tailwind.config.js';\nconst pkg = JSON.parse(readFileSync(new URL('./example-app/package.json', import.meta.url), 'utf8'));\n${line("'seed'", 'pkg.type', 'config')}`,
  'commonjs/package.json': JSON.stringify({ name: 'commonjs', type: 'commonjs' }),
  'commonjs/import.js': "import { sep } from 'node:path';\nconsole.log(sep);\n",
  // Node's typeless warning is a next tick's, which a fatal exception in the
  // microtask drain that loaded the module ends the process before: an
  // entry whose graph does not compile as a module (an import nested in a
  // statement, a syntax error after an import) shows only its error. A
  // caught failure, a later exit (a timer's), a rejection nothing handles, or
  // the entry's failure a listener takes leaves it printed. (An entry whose evaluation throws before the
  // drain ends shows no warning in Node either; the guest's next tick is a
  // microtask, so it does: ticket-node-tick-queue.)
  'nested-import.js': "{ import { sep } from 'node:path'; }\n",
  'nested-export.js': 'function f() { export const a = 1; }\n',
  'late-error.js': "import { sep } from 'node:path';\nconst a = ;\n",
  'timer-exits.js': "import { sep } from 'node:path';\nsetTimeout(() => { console.error('timer', sep); process.exit(3); });\n",
  'caught/package.json': JSON.stringify({ name: 'caught' }),
  'caught/broken.js': "import { sep } from 'node:path';\nconst a = ;\n",
  'imports-caught.mjs': "import('./caught/broken.js').catch((e) => console.log('caught', e.name));\n",
  'unhandled/package.json': JSON.stringify({ name: 'unhandled' }),
  'unhandled/broken.js': "import { sep } from 'node:path';\nconst a = ;\n",
  'imports-unhandled.mjs': "setTimeout(() => {}, 10);\nimport('./unhandled/broken.js');\n",
  // A preload's listener takes the entry's failure: the process goes on, and the warning prints.
  'handles-uncaught.mjs': "process.on('uncaughtException', (e) => console.log('handled', e.name));\nprocess.on('warning', (w) => console.log('warning', w.code));\n",
  // ... and replaces emitWarning, then warns: the loader's warning, issued before, comes first.
  'handles-and-warns.mjs': "process.on('uncaughtException', (e) => { console.log('handled', e.name); const emit = process.emitWarning; process.emitWarning = () => { throw new Error('late replacement'); }; emit.call(process, 'later'); });\nprocess.on('warning', (w) => console.log('warning', w.code ?? w.message));\n",
  // Keys and methods named import or export are no module syntax.
  'nested-keys.js': "const c = { import: './a.mjs', export: 1 };\nclass A { export() {} static import() {} export = 1; import; static export }\nconsole.log(typeof module, Object.keys(c).join(), Object.keys(new A()).join());\n",
};
const EVAL_ESM = `import { sep } from 'node:path';\n${line("'eval'", 'sep')}`;
const RUNS = [
  ['meta.js'],
  ['tla.js'],
  ['redeclare.js'],
  ['destructured.js'],
  ['declarators.js'],
  ['escaped.js'],
  ['pattern.js'],
  ['class.js'],
  ['not-bindings.js'],
  ['awaits.js'],
  // template-await.js's SyntaxError, V8's, is compared in es-module-scope-errors-workerd:
  // its arrow there is the parser's, not V8's range.
  ['typeofs.mjs'],
  ['arrow.js'],
  ['awaitcall.js'],
  ['imp.cjs'],
  ['req.cjs'],
  ['pkg.cjs'],
  ['-e', EVAL_ESM],
  ['-e', line("'eval-commonjs'", 'typeof require')],
  ['--input-type=module', '-e', line("'input-type'", 'typeof import.meta.url')],
  ['--input-type', 'module', '-e', line("'input-type spaced'", 'typeof import.meta', 'typeof require')],
  ['-', { stdin: `import { sep } from 'node:path';\n${line("'stdin'", 'sep')}` }],
  // Code Node evaluates is compiled with no wrapper: a `const require` is CommonJS's own.
  ['-e', `const require = 'own';\n${line("'eval-redeclare'", 'typeof module', 'require')}`],
  ['-', { stdin: `const { module } = { module: 'own' };\n${line("'stdin-redeclare'", 'typeof exports', 'module')}` }],
  ['plain.mjs'],
  ['typed/plain.js'],
  ['deps.cjs'],
  ['esm-scope.mjs'],
  ['own-require.mjs'],
  ['seed.mjs'],
  ['tla-scope.mjs'],
  ['scope-errors.cjs'],
  ['require-in-esm.mjs'],
  ['typed/module-exports.js'],
  ['chain.mjs'],
  ['--input-type=module', '-e', "require('node:path');\n"],
  ['import-in.cjs'],
  ['commonjs/import.js'],
  ['nested-keys.js'],
  ['nested-import.js'],
  ['nested-export.js'],
  ['late-error.js'],
  ['timer-exits.js'],
  ['imports-caught.mjs'],
  ['imports-unhandled.mjs'],
  ['--import', './handles-uncaught.mjs', 'late-error.js'],
  ['--import', './handles-and-warns.mjs', 'late-error.js'],
];
// Each run as a command line, its stdin from a file of the tree.
const stdins = {};
const commands = RUNS.map((run, i) => {
  const args = run.filter((arg) => typeof arg === 'string').map(shellWord).join(' ');
  const stdin = run.find((arg) => typeof arg === 'object')?.stdin;
  if (stdin === undefined) return `node ${args}`;
  stdins[`stdin-${i}.txt`] = stdin;
  return `node ${args} < stdin-${i}.txt`;
});
await matchNodeInWorkerd('module-format-matches-node-workerd', ROOT, { ...files, ...stdins }, commands);
