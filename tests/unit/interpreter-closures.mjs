// The interpreter's compiled code keeps nothing of the compile alive.
//
// compile.ts turns each function into closures that run as the program runs.
// V8 keeps, for every closure a function creates, everything any closure of
// that function invocation captures (they share one context). So if any
// closure in compile.ts captured the compiler (`this`), an AST node or an
// object of the scope analysis, every compiled closure created beside it
// would keep the whole AST and analysis of its unit alive: 5x the heap V8
// itself uses for the same code (tests/differential/interpreter-memory.mjs).
// This checks, with the type checker, that no closure in the modules whose
// closures outlive a compile (compile.ts and the runtime modules) captures a
// value of those types, or a value that holds one (an object, array or
// union whose members do, however deep: `const box = { node }` keeps the
// node as surely as `node` does). tests/unit/interpreter-retention.mjs
// checks the same at runtime, on the AST nodes a compile leaves alive.

import assert from 'node:assert/strict';
import { closureScan } from './lib/interpreter-closures-scan.mjs';

const { fixture, violations, closures, modules } = closureScan();
assert.deepEqual(fixture, [
  '__closure-guard-fixture__.ts:5 captures node',
  '__closure-guard-fixture__.ts:6 captures box',
  '__closure-guard-fixture__.ts:7 captures all',
  '__closure-guard-fixture__.ts:8 captures list',
], 'the guard finds a node however it is held');
assert.ok(closures > 300, `the checker saw the interpreter's closures (${closures})`);
assert.deepEqual(violations, [], `closures that would keep the compile alive:\n${violations.join('\n')}`);
console.log(`${closures} closures in ${modules} modules, none keeps the compiler, the AST or the analysis`);
