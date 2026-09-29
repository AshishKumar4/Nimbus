#!/usr/bin/env bun
// facet-commonjs-cell — a node process's module cell as the `{ cjs }` module
// its guest's registry compiles on first require. The module's export is Node's
// module wrapper function; the shims call it with their own exports, require,
// module, __filename and __dirname. What must hold is Node's meaning of a
// CommonJS cell, an ES module lowered to CommonJS keeping its own top-level
// `const require` / `const __dirname`, module names that stay distinct and
// stable under the registry's URL parsing, and runtime code that builds what
// the Function constructor would build and nothing else.
import assert from 'node:assert/strict';
import {
  commonJsCellModuleName,
  commonJsCellReadsBack,
  declaresWrapperBinding,
  runtimeCodeKey,
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

function run(cell, scope = 'function', requireImpl = () => 'required') {
  const mod = { exports: {} };
  load(wrapCommonJsCell(cell, scope).text)(mod.exports, requireImpl, mod, '/app/cell.js', '/app');
  return mod.exports;
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
    const built = load(runtimeFunctionModule(kind, params, body));
    const native = new Ctor(...params, body);
    assert.equal(built.toString(), native.toString(), `${kind}: the source text is the constructor's`);
    assert.equal(built.constructor, Ctor, `${kind}: the same kind of function`);
  }
  assert.equal(load(runtimeFunctionModule('function', ['a', 'b'], 'return a * b'))(6, 7), 42);
  assert.equal(load(runtimeFunctionModule('function', [], 'return typeof module + typeof require + typeof exports'))(),
    'undefinedundefinedundefined', 'the body sees the global scope, not the CommonJS module\'s');
  console.log('  [7] a Function-constructor module builds the constructor\'s function');
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
    assert.throws(() => load(runtimeFunctionModule(kind, params, body)), SyntaxError);
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

console.log('facet-commonjs-cell OK');
