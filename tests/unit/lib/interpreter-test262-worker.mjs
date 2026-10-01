// A test262 worker (tests/unit/interpreter-test262.mjs): runs each test of a
// list through the interpreter, in a fresh vm context that refuses string
// code generation, with the realm's Function constructors routed to the
// interpreter as node-shims routes them. A test the interpreter fails is run
// natively too, in a fresh context, so the driver can tell its own failures
// from V8's. Prints one JSON line per run.

import { readFileSync } from 'node:fs';
import vm from 'node:vm';

import { ROUTE_FUNCTION_CONSTRUCTORS } from './interpreter-build.mjs';

// Test code's rejections and late errors land on this process; each test's
// outcome is judged from its own run.
process.on('unhandledRejection', () => {});
process.on('uncaughtException', () => {});

const [, , listFile, rootDir, interpreterFile, opsFile] = process.argv;
const tests = JSON.parse(readFileSync(listFile, 'utf8'));
const wrap = (file) => new vm.Script(`(function (module, exports) {${readFileSync(file, 'utf8')}\n})`, { filename: file });
const interpreterScript = wrap(interpreterFile);
const opsScript = wrap(opsFile);
const routeScript = new vm.Script(ROUTE_FUNCTION_CONSTRUCTORS);
const harness = new Map();
function harnessFile(name) {
  let text = harness.get(name);
  if (text === undefined) {
    text = readFileSync(`${rootDir}/harness/${name}`, 'utf8');
    harness.set(name, text);
  }
  return text;
}

function load(script, context) {
  const module = { exports: {} };
  script.runInContext(context)(module, module.exports);
  return module.exports;
}

/** A fresh realm with the test262 host hooks; interpreted, or native. */
function realm(interpreted, printed) {
  const context = vm.createContext({}, { codeGeneration: { strings: !interpreted, wasm: true } });
  const global = vm.runInContext('globalThis', context);
  let interp = null;
  if (interpreted) {
    const { createInterpreter } = load(interpreterScript, context);
    interp = createInterpreter(load(opsScript, context), { dynamicImport: () => Promise.reject(new Error('no module loader')) });
    routeScript.runInContext(context)(interp);
  }
  global.print = (...args) => { printed.push(args.join(' ')); };
  global.setTimeout = setTimeout;
  global.$262 = {
    global,
    evalScript: (text) => (interp ? interp.runScript(text) : new vm.Script(text).runInContext(context)),
    detachArrayBuffer: (buffer) => { structuredClone(buffer, { transfer: [buffer] }); },
  };
  return (text) => (interp ? interp.runScript(text) : new vm.Script(text).runInContext(context));
}

function settle(printed) {
  return new Promise((resolve) => {
    let waited = 0;
    const poll = () => {
      if (printed.some((line) => line.startsWith('Test262:Async')) || waited >= 2000) return resolve();
      waited += 10;
      setTimeout(poll, 10);
    };
    setImmediate(poll);
  });
}

/** Run `test` once: `{ ok }`, or `{ ok: false, why }`. */
async function runOnce(test, interpreted, strict) {
  const printed = [];
  let run;
  try {
    run = realm(interpreted, printed);
  } catch (e) {
    return { ok: false, why: `realm: ${e && e.message}` };
  }
  const includes = test.raw ? [] : ['assert.js', 'sta.js', ...(test.async ? ['doneprintHandle.js'] : []), ...test.includes];
  // One script, the harness first, as test262's own runners concatenate them.
  const script = (strict ? '"use strict";\n' : '') + includes.map(harnessFile).join('\n') + '\n' + test.source;
  let thrown = null;
  try {
    run(script);
  } catch (e) {
    thrown = { name: e && e.constructor && e.constructor.name, message: e && e.message };
  }
  if (test.negative) {
    if (!thrown) return { ok: false, why: `expected ${test.negative.type}, nothing thrown` };
    return thrown.name === test.negative.type ? { ok: true } : { ok: false, why: `expected ${test.negative.type}, got ${thrown.name}: ${thrown.message}` };
  }
  if (thrown) return { ok: false, why: `${thrown.name}: ${thrown.message}` };
  if (!test.async) return { ok: true };
  await settle(printed);
  const line = printed.find((l) => l.startsWith('Test262:Async'));
  if (!line) return { ok: false, why: 'async test did not complete' };
  return line.startsWith('Test262:AsyncTestComplete') ? { ok: true } : { ok: false, why: line };
}

let runs = 0;
for (const test of tests) {
  const modes = test.onlyStrict ? [true] : test.noStrict || test.raw ? [false] : [false, true];
  for (const strict of modes) {
    // Contexts are collected only when the heap fills; collect as we go.
    if (++runs % 64 === 0 && globalThis.gc) globalThis.gc();
    const interpreted = await runOnce(test, true, strict);
    const native = interpreted.ok ? null : await runOnce(test, false, strict);
    process.stdout.write(`${JSON.stringify({ file: test.file, strict, ok: interpreted.ok, why: interpreted.why, nativeOk: native ? native.ok : null })}\n`);
  }
}
