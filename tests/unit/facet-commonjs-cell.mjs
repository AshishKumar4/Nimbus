#!/usr/bin/env bun
// facet-commonjs-cell — a node process's module cell as the `{ cjs }` module
// its guest's registry compiles on first require. The module's export is Node's
// module wrapper function; the shims call it with their own exports, require,
// module, __filename and __dirname. What must hold is Node's meaning of the
// cell inside it, plus one deliberate difference: an ES module esbuild lowered
// to CommonJS keeps its own top-level `const require` / `const __dirname`.
import assert from 'node:assert/strict';
import {
  commonJsCellModuleName,
  commonJsCellReadsBack,
  COMMONJS_CELL_TAIL,
  wrapCommonJsCell,
} from '../../packages/core/src/_shared/commonjs-cell.ts';

// Evaluate a `{ cjs }` module body as workerd's CommonJS handler does: a
// sloppy function body with `module` and `exports` in scope.
function load(text) {
  const moduleObject = { exports: {} };
  new Function('module', 'exports', text)(moduleObject, moduleObject.exports);
  return moduleObject.exports;
}

function run(cell, requireImpl = () => 'required') {
  const mod = { exports: {} };
  load(wrapCommonJsCell(cell).text)(mod.exports, requireImpl, mod, '/app/cell.js', '/app');
  return mod.exports;
}

// esbuild's lowering of an ES module that builds its own require: the
// module's binding wins, and it is not a SyntaxError.
{
  const out = run('const require = (id) => "own:" + id;\nmodule.exports = require("z");', () => 'wrapper');
  assert.equal(out, 'own:z');
  const dirs = run('const __dirname = "/from-module";\nconst __filename = __dirname + "/cell.js";\nmodule.exports = { __dirname, __filename, req: require("y") };');
  assert.deepEqual(dirs, { __dirname: '/from-module', __filename: '/from-module/cell.js', req: 'required' });
  console.log('  [1] a top-level lexical require/__dirname/__filename is the module\'s own');
}

// Text that only mentions a declaration keeps the real parameter.
{
  const out = run('const banner = `const require = createRequire(import.meta.url);`;\nmodule.exports = { got: require("x"), banner };');
  assert.equal(out.got, 'required');
  console.log('  [2] a declaration inside a template literal leaves the parameter bound');
}

// `var` redeclares the parameter as in Node: its value holds until assigned.
{
  const out = run('const before = typeof require;\nvar require = require;\nvar exports = module.exports = { before, after: require("q") };');
  assert.deepEqual(out, { before: 'function', after: 'required' });
  console.log('  [3] var redeclaration keeps the parameter\'s value, as in Node');
}

// Strictness is the cell's: a "use strict" prologue applies, its absence
// leaves the cell sloppy.
{
  const strict = run('"use strict";\nmodule.exports = (function () { return this; })();');
  assert.equal(strict, undefined, 'a strict cell\'s plain call has an undefined this');
  const commented = run('/* license */\n// header\n\'use strict\'\nmodule.exports = (function () { return this; })();');
  assert.equal(commented, undefined, 'a directive after comments and ended by ASI is still the prologue');
  const sloppy = run('module.exports = (function () { return this; })();');
  assert.equal(sloppy, globalThis, 'a cell with no directive stays sloppy');
  const notDirective = run('"use strict".length;\nmodule.exports = (function () { return this; })();');
  assert.equal(notDirective, globalThis, 'a string that begins an expression is not a directive');
  console.log('  [4] a "use strict" prologue is honoured, and only a real one');
}

// Top-level return and arguments mean what they mean in Node's wrapper.
{
  const out = run('module.exports = arguments.length;\nreturn;\nmodule.exports = "unreached";');
  assert.equal(out, 5);
  console.log('  [5] top-level return ends the cell; arguments is the wrapper\'s five');
}

// A shebang is a comment of the same length: line numbers do not move.
{
  const { text, hashbang } = wrapCommonJsCell('#!/usr/bin/env node\nmodule.exports = new Error("at line 2").stack;');
  assert.equal(hashbang, true);
  assert.equal(text.split('\n').length, 3, 'the wrapper adds no line before the cell');
  assert.equal(run('#!/usr/bin/env node\nmodule.exports = 42;'), 42);
  console.log('  [6] a shebang is stripped without moving lines');
}

// A syntax error is still a syntax error.
{
  assert.throws(() => load(wrapCommonJsCell('const = ;').text), SyntaxError);
  console.log('  [7] other syntax errors surface unchanged');
}

// The text between head and tail is the cell, byte for byte: what the guest
// reads back to answer readFileSync.
{
  for (const cell of ['#!/usr/bin/env node\n"use strict";\nmodule.exports = 1;\n', 'x', '', '// a\n']) {
    const w = wrapCommonJsCell(cell);
    const inner = w.text.slice(w.head, w.text.length - COMMONJS_CELL_TAIL.length);
    assert.equal(w.hashbang ? '#!' + inner.slice(2) : inner, cell);
  }
  console.log('  [8] head and tail frame the cell exactly');
}

// Module names: the path, with the four characters URL parsing would alter escaped.
{
  assert.equal(commonJsCellModuleName('home/user/a b/[id].js'), 'vfs/home/user/a b/[id].js');
  assert.equal(commonJsCellModuleName('home/user/q#x?.js'), 'vfs/home/user/q%23x%3F.js');
  assert.equal(commonJsCellModuleName('home/user/50%\\x.js'), 'vfs/home/user/50%25%5Cx.js');
  assert.equal(commonJsCellReadsBack('home/user/q#x?.js'), true);
  assert.equal(commonJsCellReadsBack('home/user/50%.js'), false);
  assert.equal(commonJsCellReadsBack('home/user/a\\b.js'), false);
  console.log('  [9] module names escape exactly %, #, ? and \\');
}

console.log('facet-commonjs-cell OK');
