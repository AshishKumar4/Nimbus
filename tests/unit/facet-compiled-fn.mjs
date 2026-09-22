#!/usr/bin/env bun
// facet-compiled-fn — the one module-cell compile every facet uses. A cell
// that declares a wrapper parameter name at top level gets that parameter
// renamed so its own binding wins; a cell that merely MENTIONS the name (a
// template literal, a string, a comment) keeps the real parameter — the
// parser decides, not a scan.
import assert from 'node:assert/strict';
import { MK_COMPILED_FN_SOURCE } from '../../packages/core/src/_shared/compiled-fn.ts';

const mk = new Function(`${MK_COMPILED_FN_SOURCE}; return __mkCompiledFn;`)();
const run = (code, requireImpl = () => 'required') => {
  const mod = { exports: {} };
  mk(code)(mod.exports, requireImpl, mod, '/app/cell.js', '/app');
  return mod.exports;
};

// A vite chunk carries `const require = createRequire(import.meta.url);` as
// TEXT inside a template literal. The parameter must survive.
{
  const out = run('const banner = `import { createRequire } from "node:module";\nconst require = createRequire(import.meta.url);`;\nmodule.exports = { got: require("x"), banner };');
  assert.equal(out.got, 'required', 'a mention inside a template literal must not rename the require parameter');
  console.log('  [1] text that looks like a declaration keeps the real parameter');
}

// A real top-level declaration (esbuild's emit of the ESM __dirname idiom)
// collides with the parameter; the body's binding wins.
{
  const out = run('const __dirname = "/from-module";\nconst __filename = __dirname + "/cell.js";\nmodule.exports = { __dirname, __filename, req: require("y") };');
  assert.deepEqual(out, { __dirname: '/from-module', __filename: '/from-module/cell.js', req: 'required' });
  console.log('  [2] a declared __dirname/__filename wins and the other parameters stay bound');
}

// `const require = createRequire(...)` at top level: the module's own require.
{
  const out = run('const require = (id) => "own:" + id;\nmodule.exports = require("z");', () => 'wrapper');
  assert.equal(out, 'own:z');
  console.log('  [3] a declared require wins over the wrapper parameter');
}

// A shebang is stripped like Node does.
{
  assert.equal(run('#!/usr/bin/env node\nmodule.exports = 42;'), 42);
  console.log('  [4] a leading shebang is stripped');
}

// A genuine syntax error is still a syntax error.
{
  assert.throws(() => mk('const = ;'), SyntaxError);
  console.log('  [5] other syntax errors surface unchanged');
}

console.log('facet-compiled-fn OK');
