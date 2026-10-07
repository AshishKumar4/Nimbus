#!/usr/bin/env bun
// facet-commonjs-cell — a node process's module cell as the `{ cjs }` module
// its guest's registry compiles on first require. The module's export, given
// the module's own Function, is Node's module wrapper function; the shims call
// it with their own exports, require, module, __filename and __dirname. What must hold is Node's meaning of a
// CommonJS cell, an ES module lowered to CommonJS keeping its own top-level
// `const require` / `const __dirname`, module names that stay distinct and
// stable under the registry's URL parsing, and runtime code that builds what
// the Function constructor would build and nothing else.
import assert from 'node:assert/strict';
import {
  commonJsCellModuleName,
  commonJsCellReadsBack,
  declaresWrapperBinding,
  runtimeCodeCharge,
  runtimeCodeKey,
  runtimeExpressionModule,
  runtimeFunctionModule,
  runtimeFunctionSyntaxError,
  wrapCommonJsCell,
} from '../../packages/core/src/_shared/commonjs-cell.ts';

// Evaluate a `{ cjs }` module body as workerd's CommonJS handler does: a
// sloppy function body with `module` and `exports` in scope.
function load(text) {
  const moduleObject = { exports: {} };
  new Function('module', 'exports', text)(moduleObject, moduleObject.exports);
  return moduleObject.exports;
}

/** A stand-in for a module's own Function (THE WRAPPER). */
const MODULE_FUNCTION = function ModuleFunction() {};

function run(cell, scope = 'function', requireImpl = () => 'required') {
  const mod = { exports: {} };
  load(wrapCommonJsCell(cell, scope).text)(MODULE_FUNCTION)(mod.exports, requireImpl, mod, '/app/cell.js', '/app');
  return mod.exports;
}

/** A staged constructor's function, from an origin: its import() and its Function. */
const ORIGIN = { import: (specifier) => Promise.resolve('imported ' + specifier), Function: MODULE_FUNCTION };
function staged(text, origin = ORIGIN) {
  return load(text)(origin.import, origin.Function);
}

// A CommonJS cell is Node's function body: what Node accepts, it accepts —
// including what a block would reject.
{
  assert.equal(run('var f = 1;\nfunction f() {}\nmodule.exports = typeof f;'), 'number');
  assert.equal(run('"use strict";\nfunction g() { return 1; }\nfunction g() { return 2; }\nmodule.exports = g();'), 2);
  const sloppy = run('module.exports = (function () { return this; })();');
  assert.equal(sloppy, globalThis, 'a cell with no directive stays sloppy');
  assert.equal(run('"use strict";\nmodule.exports = (function () { return this; })();'), undefined, 'its own prologue applies');
  const out = run('const before = typeof require;\nvar require = require;\nvar exports = module.exports = { before, after: require("q") };');
  assert.deepEqual(out, { before: 'function', after: 'required' }, 'var redeclares a parameter and keeps its value');
  assert.equal(run('module.exports = arguments.length;\nreturn;\nmodule.exports = "unreached";'), 5, 'top-level return and the five arguments');
  assert.equal(run('module.exports = Function;'), MODULE_FUNCTION, 'a cell\'s Function is its module\'s own');
  assert.equal(run('let Function = 1;\nmodule.exports = Function;'), 1, 'and a cell may declare its own');
  assert.equal(run('function Function() {}\nmodule.exports = Function.name;'), 'Function');
  console.log('  [1] a CommonJS cell runs as Node\'s own wrapper runs it');
}

// A lowered ES module is in a block: its own bindings of the wrapper's names
// shadow the parameters instead of being a SyntaxError.
{
  const out = run('const require = (id) => "own:" + id;\nmodule.exports = require("z");', 'block', () => 'wrapper');
  assert.equal(out, 'own:z');
  const dirs = run('const __dirname = "/from-module";\nclass exports {}\nmodule.exports = { __dirname, req: require("y"), cls: typeof exports };', 'block');
  assert.deepEqual(dirs, { __dirname: '/from-module', req: 'required', cls: 'function' });
  assert.throws(() => load(wrapCommonJsCell('const require = 1;', 'function').text), SyntaxError, 'as a function body it would not compile');
  assert.equal(run('"use strict";\nmodule.exports = (function () { return this; })();', 'block'), undefined, 'the prologue is restated where it applies');
  console.log('  [2] a lowered module keeps its own require/__dirname/exports');
}

// Which cells need the block, when nothing says whether they were lowered.
{
  assert.equal(declaresWrapperBinding('const require = createRequire(import.meta.url);'), true);
  assert.equal(declaresWrapperBinding('const { __dirname: d, x: [module] } = y;'), true, 'destructured');
  assert.equal(declaresWrapperBinding('let a = 1, exports = 2;'), true, 'second declarator');
  assert.equal(declaresWrapperBinding('class __filename {}'), true);
  assert.equal(declaresWrapperBinding('const banner = `const require = createRequire(import.meta.url);`;'), false, 'text in a template is not a declaration');
  assert.equal(declaresWrapperBinding('function f() { const require = 1; }\nvar module = 2;'), false, 'nested or var bindings are Node\'s too');
  assert.equal(declaresWrapperBinding('const = ;'), false, 'unparseable: its SyntaxError surfaces either way');
  console.log('  [3] a top-level lexical binding of a wrapper name is found by parsing');
}

// A shebang is a comment of the same length: line numbers do not move.
{
  for (const scope of ['function', 'block']) {
    const { text, hashbang } = wrapCommonJsCell('#!/usr/bin/env node\nmodule.exports = 42;', scope);
    assert.equal(hashbang, true);
    assert.equal(text.split('\n').length, 3, `the wrapper adds no line before the cell (${scope})`);
    assert.equal(run('#!/usr/bin/env node\nmodule.exports = 42;', scope), 42);
  }
  console.log('  [4] a shebang is stripped without moving lines');
}

// Head and tail frame the cell exactly: what the guest reads back to answer readFileSync.
{
  for (const scope of ['function', 'block']) {
    for (const cell of ['#!/usr/bin/env node\n"use strict";\nmodule.exports = 1;\n', 'x', '', '// a\n']) {
      const w = wrapCommonJsCell(cell, scope);
      const inner = w.text.slice(w.head, w.text.length - w.tail);
      assert.equal(w.hashbang ? '#!' + inner.slice(2) : inner, cell);
    }
  }
  console.log('  [5] head and tail frame the cell exactly');
}

// Module names are distinct for distinct paths and stable under the WHATWG
// URL parser the registry resolves them with — including the characters it
// drops (tab, newline), trims (trailing space), rewrites (backslash) or ends
// the path at (? and #).
{
  const paths = [
    'home/user/tr', 'home/user/tr ', 'home/user/tab\tx.js', 'home/user/tabx.js', 'home/user/nl\nx.js', 'home/user/nlx.js',
    'home/user/a\\b.js', 'home/user/a/b.js', 'home/user/a%b.js', 'home/user/a%25b.js', 'home/user/%2e', 'home/user/%2E%2E',
    'home/user/q#x.js', 'home/user/q?y.js', 'home/user/ü.js', 'home/user/😀.js', 'home/user/[id].js', 'home/user/{x}.js',
    'home/user/"q".js', 'home/user/<t>.js', 'home/user/`b`.js', 'home/user/\x7f.js', 'home/user/\x01.js',
  ];
  const hrefs = new Map();
  for (const path of paths) {
    const name = commonJsCellModuleName(path);
    const url = new URL('./' + name, 'file:///bundle/');
    assert.equal(url.pathname, '/bundle/' + name, `${JSON.stringify(path)} is kept as written`);
    assert.ok(!hrefs.has(url.href), `${JSON.stringify(path)} collides with ${JSON.stringify(hrefs.get(url.href))}`);
    hrefs.set(url.href, path);
  }
  assert.equal(commonJsCellModuleName('home/user/app/index.js'), 'vfs/home/user/app/index.js', 'an ordinary path is itself');
  assert.equal(commonJsCellReadsBack('home/user/q#x?.js'), true);
  assert.equal(commonJsCellReadsBack('home/user/50%.js'), false);
  assert.equal(commonJsCellReadsBack('home/user/a\\b.js'), false);
  console.log('  [6] module names are injective and survive URL parsing');
}

// Runtime code: the module for a Function-constructor call builds what the
// constructor builds — its source text (which a module runner measures its
// source-map offset from) and its kind — and closes over the global scope.
{
  const cases = [
    ['function', Function, ['a', 'b'], 'return a * b'],
    ['async', (async () => {}).constructor, ['x'], 'return await x'],
    ['generator', (function* () {}).constructor, [], 'yield 1'],
    ['asyncGenerator', (async function* () {}).constructor, ['n = (2)', '/* c */ m'], 'yield n'],
    ['function', Function, ['a'], '// a trailing comment'],
    ['function', Function, [], '"use strict"; return "}"'],
  ];
  for (const [kind, Ctor, params, body] of cases) {
    const built = staged(runtimeFunctionModule(kind, params, body));
    const native = new Ctor(...params, body);
    assert.equal(built.toString(), native.toString(), `${kind}: the source text is the constructor's`);
    assert.equal(built.constructor, Ctor, `${kind}: the same kind of function`);
  }
  assert.equal(staged(runtimeFunctionModule('function', ['a', 'b'], 'return a * b'))(6, 7), 42);
  assert.equal(staged(runtimeFunctionModule('function', [], 'return typeof module + typeof require + typeof exports'))(),
    'undefinedundefinedundefined', 'the body sees the global scope, not the CommonJS module\'s');
  // The code's import() is its origin's, and its free Function its origin's
  // Function; one module serves every origin, each call building a function
  // of its own, as each constructor call does.
  const importing = runtimeFunctionModule('function', ['m'], 'return [import(m), Function, "import(m)"]');
  const [imported, fn, text] = staged(importing)('./x.mjs');
  assert.equal(await imported, 'imported ./x.mjs', 'import() is the origin\'s');
  assert.equal(fn, MODULE_FUNCTION, 'the code sees its origin\'s Function');
  assert.equal(text, 'import(m)', 'text in a string is not a call');
  const other = { import: (specifier) => Promise.resolve('elsewhere ' + specifier), Function: MODULE_FUNCTION };
  assert.equal(await staged(importing, other)('./x.mjs')[0], 'elsewhere ./x.mjs', 'another origin, the same module');
  assert.notEqual(staged(importing), staged(importing), 'each build is a function of its own');
  console.log('  [7] a Function-constructor module builds the constructor\'s function, from its origin');
}

// Text the constructor refuses is refused, and never runs.
{
  const refused = [
    ['function', [], '}, globalThis.__nimbusBreakout = "body", function () {'],
    ['function', ['a) {}, globalThis.__nimbusBreakout = "params", function (b'], ''],
    ['function', [], '})(); globalThis.__nimbusBreakout = "call"; (function () {'],
    ['function', ['a /*'], ''],
    ['function', ['a = 1'], '"use strict";'],
    ['function', [], 'return 1; }'],
    ['async', [], 'yield 1'],
  ];
  for (const [kind, params, body] of refused) {
    const Ctor = kind === 'async' ? (async () => {}).constructor : Function;
    assert.throws(() => new Ctor(...params, body), SyntaxError, `the premise: V8 refuses ${JSON.stringify([params, body])}`);
    assert.notEqual(runtimeFunctionSyntaxError(kind, params, body), null, `refused: ${JSON.stringify([params, body])}`);
    assert.throws(() => staged(runtimeFunctionModule(kind, params, body)), SyntaxError);
  }
  assert.equal(globalThis.__nimbusBreakout, undefined, 'no refused text ran');
  console.log('  [8] text the constructor refuses throws its SyntaxError, and does not run');
}

// A written module's key is its text with its directory and extension: a
// fresh name converges, a different extension or directory does not.
{
  const key = (path, text = 'export default 1;\n') => runtimeCodeKey({ kind: 'module', path, text });
  assert.equal(key('home/user/app/.vite-temp/vite.config.ts.timestamp-1-a.mjs'), key('home/user/app/.vite-temp/vite.config.ts.timestamp-2-b.mjs'));
  assert.notEqual(key('home/user/app/x.mjs'), key('home/user/app/x.json'), 'the extension decides how it is lowered');
  assert.notEqual(key('home/user/app/x.mjs'), key('home/user/other/x.mjs'), 'the directory decides its relative imports');
  console.log('  [9] runtime modules are keyed by text, directory and extension');
}

// An entry is charged for what it holds: a data: URL module keeps its whole
// URL as its path beside its text, and pays for both.
{
  const text = 'export default ' + JSON.stringify('x'.repeat(4000)) + ';';
  const inline = { kind: 'module', path: 'data:text/javascript,' + encodeURIComponent(text), text };
  assert.ok(runtimeCodeCharge(inline) >= JSON.stringify(inline).length,
    `charge ${runtimeCodeCharge(inline)} covers the ${JSON.stringify(inline).length} stored characters`);
  console.log('  [10] a data: module is charged for its URL and its text');
}

console.log('facet-commonjs-cell OK');

// vm.runInThisContext's code, staged: a function returning the value of the
// one expression the script is. jiti's module wrapper is an expression
// statement, semicolon included, which a body of `return (<code>)` cannot
// hold.
{
  const jiti = '(function (exports, require, module, __filename, __dirname, jitiImport, jitiESMResolve) { module.exports = { answer: 42, args: typeof jitiImport };\n});';
  const wrapper = staged(runtimeExpressionModule(jiti))();
  const mod = { exports: {} };
  wrapper(mod.exports, () => {}, mod, '/w/nuxt.config.ts', '/w', () => {});
  assert.deepEqual(mod.exports, { answer: 42, args: 'function' }, 'the staged expression is jiti\'s wrapper');
  assert.equal(staged(runtimeExpressionModule('1 + 2 // trailing'))(), 3);
  // A script of directives alone completes with its last one's value, as V8's vm.runInThisContext answers.
  assert.equal(staged(runtimeExpressionModule('"hello"'))(), 'hello');
  assert.equal(staged(runtimeExpressionModule("'use strict'; 'a';\n'b'"))(), 'b');
  assert.equal(staged(runtimeExpressionModule("'use strict';(() => function () { return this; })"))()()(), undefined, 'vite-node\'s prologue is kept');
  assert.throws(() => staged(runtimeExpressionModule('(function () {')), SyntaxError);
  assert.throws(() => staged(runtimeExpressionModule('var x = 1; x')), /one expression/);
  assert.notEqual(runtimeCodeKey({ kind: 'expression', code: jiti }), runtimeCodeKey({ kind: 'function', params: [], body: jiti }));
}
console.log('facet-commonjs-cell: vm expressions staged');
