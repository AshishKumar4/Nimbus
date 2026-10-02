#!/usr/bin/env bun
// vm.runInThisContext's value is the script's, as V8 gives it.
//
// A Worker refuses to compile a vm script at request time, and node-shims
// hands the code to the runtime-code service, which answers with a function
// returning the script's value (core/_shared/commonjs-cell.ts, RUNTIME CODE).
// The shims call it as V8 runs a script: with the global object as `this`,
// which a strict script sees too, and an arrow in it captures. Each script
// here runs through the shims' vm module, with the service answering as a
// launch that staged the code does (runtimeExpressionModule), and its value
// is compared with node's own vm.runInThisContext. The interpreter's
// function, which answers in the launch that produced the code, is checked
// in tests/unit/interpreter-semantics.mjs; both run in workerd in
// tests/unit/node-runtime-code-workerd.mjs.

import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { runtimeExpressionModule } from '../../packages/core/src/_shared/commonjs-cell.ts';
import { generateShimsCode } from '../../packages/worker/src/runtime/node-shims.ts';
import { SHIMS_STORE_PRELUDE, declareNamespace } from './lib/shims-namespace.mjs';

const SCRIPTS = [
  '"use strict"; this',
  '"use strict"; (() => this)()',
  'this',
  '"use strict"; typeof this',
  '"hello"',
];

/** What a script's value is, comparably across processes: the global object by name. */
const DESCRIBE = '(value) => (value === globalThis ? "the global object" : JSON.stringify(value))';

const v8 = spawnSync('node', ['-e', `
  const describe = ${DESCRIBE};
  const vm = require('node:vm');
  console.log(JSON.stringify(${JSON.stringify(SCRIPTS)}.map((code) => describe(vm.runInThisContext(code)))));
`], { encoding: 'utf8' });
assert.equal(v8.status, 0, v8.stderr);
const expected = JSON.parse(v8.stdout);

// The launch's service, as one that staged the code answers: the staged module's export.
globalThis.__nimbusRuntimeCode = {
  compileExpression(code) {
    const moduleObject = { exports: {} };
    new Function('module', 'exports', runtimeExpressionModule(code))(moduleObject, moduleObject.exports);
    return moduleObject.exports;
  },
};
const factory = new Function(
  '__vfsBundle', '__vfsWrites', '__vfsDirs', '__supervisor', 'cred', 'cwd', 'argv', 'env', 'filename', 'dirname',
  '"use strict";const __compiledModules=new Map();const __compileFailures=new Map();' + SHIMS_STORE_PRELUDE + generateShimsCode() + '\n;return __require;',
);
declareNamespace({ metadata: {}, manifest: { 'home/user': [] } });
const requireFromFacet = factory({}, {}, {}, null, { uid: 1000, gid: 1000, groups: [1000], umask: 0o022 }, '/home/user', [], {}, '/home/user/main.js', '/home/user');

try {
  const vm = requireFromFacet('vm');
  const describe = (0, eval)(DESCRIBE);
  const actual = SCRIPTS.map((code) => describe(vm.runInThisContext(code)));
  for (let i = 0; i < SCRIPTS.length; i++) assert.equal(actual[i], expected[i], `vm.runInThisContext(${JSON.stringify(SCRIPTS[i])})`);
} finally {
  delete globalThis.__nimbusRuntimeCode;
}
console.log(`node-shims-vm-script-value: ${SCRIPTS.length} scripts, each the value V8 gives`);
