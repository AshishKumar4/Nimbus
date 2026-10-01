// The guest's arrangement in a node process run with
// --disallow-code-generation-from-strings: every Function constructor's
// refusal is answered by the interpreter (as node-shims routes it), and the
// indirect eval es-module-lexer decodes quoted names with is evaluated as the
// single expression it is (node-shims decodes those string literals).

import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { createInterpreter } = require(process.env.NIMBUS_INTERPRETER);
const { ROUTE_FUNCTION_CONSTRUCTORS } = await import('../../unit/lib/interpreter-build.mjs');
const interp = createInterpreter(require(process.env.NIMBUS_INTERPRETER_OPS), {
  dynamicImport: (parent, specifier) => import(parent && /^\.\.?\//.test(String(specifier)) ? new URL(String(specifier), parent).href : String(specifier)),
});
interp.compileFunction('function', [], `return ${ROUTE_FUNCTION_CONSTRUCTORS};`)()(interp);

const nativeEval = globalThis.eval;
globalThis.eval = function (source) {
  try {
    return nativeEval(source);
  } catch (e) {
    if (!(e instanceof EvalError) || typeof source !== 'string') throw e;
    return interp.compileFunction('function', [], `return (${source}\n);`)();
  }
};
