#!/usr/bin/env bun
// vm.runInThisContext's value is the script's, as V8 gives it.
//
// A Worker refuses to compile a vm script at request time, and node-shims
// hands the code to the runtime-code service, which answers with a function
// returning the script's value (core/_shared/commonjs-cell.ts, RUNTIME CODE).
// The shims call it as V8 runs a script: with the global object as `this`,
// which a strict script sees too, and an arrow in it captures; and with
// what the launch had at its start, since a program may replace
// Reflect.apply or the globalThis property, which native vm consults
// neither. Each script here runs through the shims' vm module, with the
// service answering as a launch that staged the code does
// (runtimeExpressionModule), and its value is compared with node's own
// vm.runInThisContext, run by the same code. The interpreter's function,
// which answers in the launch that produced the code, is checked in
// tests/unit/interpreter-semantics.mjs; both run in workerd in
// tests/unit/node-runtime-code-workerd.mjs.

import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { runtimeExpressionModule } from '../../packages/core/src/_shared/commonjs-cell.ts';
import { generateShimsCode } from '../../packages/worker/src/runtime/node-shims.ts';
import { SHIMS_STORE_PRELUDE, declareNamespace } from './lib/shims-namespace.mjs';

/**
 * `(vm) => descriptions`: each script run with `vm`, as the launch left the
 * realm and with what a program may replace replaced, and what it gave: the
 * global object by name, anything else as JSON. Evaluated in each process.
 */
const RUN = `(vm) => {
  const global = globalThis;
  const describe = (value) => (value === global ? 'the global object' : value === globalThis ? 'the globalThis property' : JSON.stringify(value));
  const phases = [
    [() => () => {}, ['"use strict"; this', '"use strict"; (() => this)()', 'this', '"use strict"; typeof this', '"hello"']],
    [() => { const saved = Reflect.apply; Reflect.apply = () => 9; return () => { Reflect.apply = saved; }; }, ['1', '"use strict"; this']],
    [() => { const saved = globalThis; globalThis = new Proxy(saved, {}); return () => { globalThis = saved; }; }, ['this', '"use strict"; this', '"use strict"; (() => this)()']],
  ];
  const out = [];
  for (const [replace, scripts] of phases) {
    const restore = replace();
    try {
      for (const code of scripts) out.push(code + ' => ' + describe(vm.runInThisContext(code)));
    } finally {
      restore();
    }
  }
  return out;
}`;

const v8 = spawnSync('node', ['-e', `console.log(JSON.stringify((${RUN})(require('node:vm'))));`], { encoding: 'utf8' });
assert.equal(v8.status, 0, v8.stderr);
const expected = JSON.parse(v8.stdout);

// The launch's service, as one that staged the code answers: the staged module's export, compiled
// with this process's own Function (the shims route the global one through Reflect.apply).
const ModuleFunction = Function;
globalThis.__nimbusRuntimeCode = {
  compileExpression(code, origin) {
    const moduleObject = { exports: {} };
    new ModuleFunction('module', 'exports', runtimeExpressionModule(code))(moduleObject, moduleObject.exports);
    return moduleObject.exports(origin.import, origin.Function);
  },
};
const factory = new Function(
  '__vfsBundle', '__vfsWrites', '__vfsDirs', '__supervisor', 'cred', 'cwd', 'argv', 'env', 'filename', 'dirname',
  '"use strict";const __compiledModules=new Map();const __compileFailures=new Map();' + SHIMS_STORE_PRELUDE + generateShimsCode() + '\n;return __require;',
);
declareNamespace({ metadata: {}, manifest: { 'home/user': [] } });
const requireFromFacet = factory({}, {}, {}, null, { uid: 1000, gid: 1000, groups: [1000], umask: 0o022 }, '/home/user', [], {}, '/home/user/main.js', '/home/user');

let actual;
try {
  actual = (0, eval)(RUN)(requireFromFacet('vm'));
} finally {
  delete globalThis.__nimbusRuntimeCode;
}
assert.deepEqual(actual, expected);
console.log(`node-shims-vm-script-value: ${expected.length} scripts, each the value V8 gives`);
