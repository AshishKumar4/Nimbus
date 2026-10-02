// The guest's arrangement in a node process run with
// --disallow-code-generation-from-strings: every Function constructor's
// refusal is answered by the interpreter (as node-shims routes it), the
// indirect eval es-module-lexer decodes quoted names with is evaluated as the
// single expression it is (node-shims decodes those string literals), and
// vm.runInThisContext (jiti's) is interpreted as node-shims stages it
// (vm-route.mjs). What the vm path interpreted goes to NIMBUS_DIFF_REPORT
// (report.mjs).

import { loadInterpreter } from '../../unit/lib/interpreter-load.mjs';
import { recordPart } from './report.mjs';
import { routeRunInThisContext } from './vm-route.mjs';

const { ROUTE_FUNCTION_CONSTRUCTORS } = await import('../../unit/lib/interpreter-build.mjs');
const interp = loadInterpreter(process.env.NIMBUS_INTERPRETER, process.env.NIMBUS_INTERPRETER_OPS, (parent, specifier) => (
  import(parent && /^\.\.?\//.test(String(specifier)) ? new URL(String(specifier), parent).href : String(specifier))
));
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

routeRunInThisContext((code) => {
  recordPart(process.env.NIMBUS_DIFF_REPORT, { vmExpressions: [code.slice(0, 2000)] });
  return interp.compileExpression(code)();
});
