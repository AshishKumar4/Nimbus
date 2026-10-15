#!/usr/bin/env bun
// A program's vm, as Node gives it (X-9): run through the public workspace
// API, a program writes exactly what real `node` writes running it.
//
//   - vm is the engine's: contexts, scripts, compileFunction,
//     runInThisContext, an error thrown in another context, a Script's
//     cached data, the program's options as they are; vm's module classes
//     are absent, as in Node without --experimental-vm-modules;
//   - a dynamic import in vm code with no callback refuses as Node's does.
//
// And without an oracle: importModuleDynamically:
// vm.constants.USE_MAIN_CONTEXT_DEFAULT_LOADER, which imports through the
// engine's own loader past the program's module map, is refused at each
// compile and context that names it (the program's module map kept whole:
// core's README says a realm is no boundary, and a program that seeks the
// engine's loader reaches it); domain stays refused
// (it would set the engine's own process); and a lifo CommonJS command,
// which runs in the host's realm, has the same vm.
//
// Red before: vm was refused whole.
//
// Under Bun against the source, then under node against the built package
// (packages/core/dist: rebuild first).

import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { hostSqlite } from './lib/host-sqlite.mjs';

const underBun = typeof process.versions.bun === 'string';
const { NimbusWorkspace } = await import(underBun
  ? '../../packages/core/src/workspace/nimbus-workspace.ts'
  : '../../packages/core/dist/workspace/nimbus-workspace.js');
const { createLifoCommand } = await import(underBun
  ? '../../packages/core/src/substrate/lifo/pkg/lifo-runtime.ts'
  : '../../packages/core/dist/substrate/lifo/pkg/lifo-runtime.js');

/** Each case: a program, the shell line that runs it ({prog} is its name), and the engine it is Node's on, if one. */
const cases = {
  'contexts.js': [[
    "const vm = require('vm');",
    'const sandbox = { a: 1, out: [] };',
    'vm.createContext(sandbox);',
    "vm.runInContext('out.push(a + 1); var b = 7;', sandbox);",
    'console.log(JSON.stringify(sandbox.out), sandbox.b, vm.isContext(sandbox), vm.isContext({}));',
    "console.log(vm.runInNewContext('typeof process + \" \" + typeof require + \" \" + (x * 2)', { x: 21 }));",
    "const script = new vm.Script('n = (typeof n === \"number\" ? n : 0) + 1', { filename: '/s.js' });",
    'const context = vm.createContext({});',
    'script.runInContext(context); script.runInContext(context);',
    'console.log(context.n, script instanceof vm.Script, vm.createScript("1") instanceof vm.Script, script.runInNewContext({ n: 41 }));',
    "console.log(vm.compileFunction('return a + b', ['a', 'b'])(2, 3));",
    "console.log(vm.runInThisContext('typeof globalThis.setTimeout'));",
    "try { vm.runInNewContext('throw new TypeError(\"inner\")', {}, { filename: '/thrower.js' }); } catch (e) { console.log(e.name, e.message, e instanceof TypeError); }",
    "console.log(typeof vm.SourceTextModule, typeof vm.SyntheticModule, 'SourceTextModule' in vm, typeof vm.constants.USE_MAIN_CONTEXT_DEFAULT_LOADER);",
  ].join('\n'), 'node {prog}'],
  // A Script's cached data, produced and taken, as the engine's.
  'cache.js': [[
    "const vm = require('vm');",
    "const script = new vm.Script('1 + 1', { produceCachedData: true });",
    "console.log('produced', script.cachedDataProduced, script.cachedData instanceof Uint8Array, script instanceof vm.Script);",
    "const reused = new vm.Script('1 + 1', { cachedData: script.cachedData });",
    "console.log('reused', reused.cachedDataRejected, reused.runInThisContext());",
  ].join('\n'), 'node {prog}'],
  // Options are the program's, as they are: a non-enumerable one too (Node only: Bun's vm ignores contextCodeGeneration).
  'codegen.js': [[
    "const vm = require('vm');",
    'const options = {};',
    "Object.defineProperty(options, 'contextCodeGeneration', { value: { strings: false, wasm: false } });",
    "try { vm.runInNewContext('eval(\"1\")', {}, options); console.log('evaluated'); } catch (e) { console.log('codegen', e.name); }",
  ].join('\n'), 'node {prog}', 'node'],
  'nocallback.js': [[
    "const vm = require('vm');",
    "new vm.Script(\"import('./other.mjs')\", { filename: require('path').join(__dirname, 'script.js') }).runInThisContext()",
    "  .then(() => console.log('imported'), (e) => console.log('no callback', e.code));",
  ].join('\n'), 'node {prog}'],
};

/** `promise`, or a failure naming `what` once `ms` pass. */
const within = (ms, promise, what) => Promise.race([promise, new Promise((_, reject) => setTimeout(() => reject(new Error(`${what}: still running after ${ms} ms`)), ms))]);

const { sql, transactions } = await hostSqlite();
const terminal = { write() {}, writeln() {}, onData() {}, cols: 80, rows: 24, focus() {}, clear() {} };
const ws = await NimbusWorkspace.create({ sql, transactions, generation: 1, terminal });
const host = mkdtempSync(join(tmpdir(), 'lifo-node-vm-'));
const failed = [];
try {
  for (const [name, [source, line, engine]] of Object.entries(cases)) {
    if (engine === 'node' && underBun) continue;
    const command = line.replaceAll('{prog}', name);
    await ws.fs.writeFile(`/home/user/${name}`, source);
    writeFileSync(join(host, name), source);
    const env = Object.fromEntries(Object.entries(process.env).filter(([key]) => key !== 'NODE_NO_WARNINGS' && key !== 'NODE_OPTIONS'));
    const node = spawnSync('sh', ['-c', command], { cwd: host, env, encoding: 'utf8', timeout: 60_000 });
    let lifo;
    try {
      lifo = await within(30_000, ws.exec(command, { cwd: '/home/user' }), name);
    } catch (error) {
      failed.push(`${name}: ${command}\n  node (exit ${node.status}): ${JSON.stringify(node.stdout + node.stderr)}\n  lifo: ${error.message}`);
      continue;
    }
    if (lifo.exitCode !== node.status || lifo.stdout !== node.stdout || lifo.stderr !== node.stderr) {
      failed.push(`${name}: ${command}\n  node (exit ${node.status}): ${JSON.stringify(node.stdout + node.stderr)}\n  lifo (exit ${lifo.exitCode}): ${JSON.stringify(lifo.stdout + lifo.stderr)}`);
    }
  }

  // ── no oracle: the engine's main-context loader, refused ────────────────
  try {
    await ws.fs.writeFile('/home/user/loader.js', [
      "const vm = require('vm');",
      'const loader = vm.constants.USE_MAIN_CONTEXT_DEFAULT_LOADER;',
      "const filename = require('path').join(__dirname, 'script.js');",
      'const attempts = [',
      "  ['Script', () => new vm.Script(\"import('node:fs')\", { filename, importModuleDynamically: loader })],",
      "  ['compileFunction', () => vm.compileFunction(\"return import('node:fs')\", [], { filename, importModuleDynamically: loader })],",
      "  ['runInNewContext', () => vm.runInNewContext(\"import('node:fs')\", {}, { filename, importModuleDynamically: loader })],",
      "  ['createContext', () => vm.createContext({}, { importModuleDynamically: loader })],",
      "  ['createScript', () => vm.createScript(\"import('node:fs')\", { filename, importModuleDynamically: loader })],",
      '];',
      '(async () => {',
      "  for (const [label, attempt] of attempts) { try { console.log(label, 'compiled', await attempt()); } catch (e) { console.log(label, e.code ?? e.name); } }",
      "  try { require('domain'); console.log('domain served'); } catch (e) { console.log('domain', e.code); }",
      '})();',
    ].join('\n'));
    const ran = await within(30_000, ws.exec('node loader.js', { cwd: '/home/user' }), 'loader.js');
    assert.equal(ran.stdout, [
      'Script ERR_FEATURE_UNAVAILABLE_ON_PLATFORM',
      'compileFunction ERR_FEATURE_UNAVAILABLE_ON_PLATFORM',
      'runInNewContext ERR_FEATURE_UNAVAILABLE_ON_PLATFORM',
      'createContext ERR_FEATURE_UNAVAILABLE_ON_PLATFORM',
      'createScript ERR_FEATURE_UNAVAILABLE_ON_PLATFORM',
      'domain ERR_FEATURE_UNAVAILABLE_ON_PLATFORM',
      '',
    ].join('\n'), 'each refused, naming the loader');
  } catch (error) {
    failed.push(`the main-context loader: ${error.message}`);
  }

  // ── no oracle, Bun only: a callback's referrer is a vm.Script, whichever
  // function made it (Node calls a callback only under
  // --experimental-vm-modules).
  if (underBun) {
    try {
      await ws.fs.writeFile('/home/user/referrer.js', [
        "const vm = require('vm');",
        "const importModuleDynamically = (specifier, referrer) => { console.log(specifier, referrer instanceof vm.Script); return Promise.resolve({}); };",
        "const options = { filename: require('path').join(__dirname, 'script.js'), importModuleDynamically };",
        '(async () => {',
        "  await new vm.Script(\"import('script')\", options).runInThisContext();",
        "  await vm.runInThisContext(\"import('this')\", options);",
        "  await vm.runInNewContext(\"import('new')\", {}, options);",
        "  await vm.runInContext(\"import('context')\", vm.createContext({}), options);",
        '})();',
      ].join('\n'));
      const ran = await within(30_000, ws.exec('node referrer.js', { cwd: '/home/user' }), 'referrer.js');
      assert.equal(ran.stdout, 'script true\nthis true\nnew true\ncontext true\n', ran.stdout + ran.stderr);
    } catch (error) {
      failed.push(`a callback's referrer: ${error.message}`);
    }
  }

  // ── a lifo CommonJS command (the host's realm): vm, but not domain ────────
  try {
    await ws.fs.mkdir('/home/user/pkg', { recursive: true });
    await ws.fs.writeFile('/home/user/pkg/realmless.js', [
      'module.exports = async () => {',
      "  console.log('vm', require('vm').runInNewContext('x + 1', { x: 1 }));",
      "  try { require('domain'); console.log('domain served'); } catch (e) { console.log('domain', e.code); }",
      '  return 0;',
      '};',
    ].join('\n'));
    ws.registry.register('realmless', createLifoCommand('/home/user/pkg/realmless.js', ws.filesystem.view({ pid: 900, cred: { uid: 1000, gid: 1000, groups: [1000], umask: 0o022 } })));
    const ran = await within(30_000, ws.exec('realmless', { cwd: '/home/user' }), 'realmless');
    assert.equal(ran.stdout, 'vm 2\ndomain ERR_FEATURE_UNAVAILABLE_ON_PLATFORM\n', 'its vm is the engine\'s; domain would set the host\'s process');
  } catch (error) {
    failed.push(`a lifo CommonJS command: ${error.message}`);
  }
} finally {
  rmSync(host, { recursive: true, force: true });
  await within(10_000, ws.close(), 'the workspace closes').catch((error) => failed.push(error.message));
}

if (underBun) {
  // Under node whatever Bun answered, so a red run shows both.
  const node = spawnSync('node', ['--no-warnings', fileURLToPath(import.meta.url)], { encoding: 'utf8', timeout: 180_000 });
  assert.deepEqual(failed, [], `bun: lifo's node runs vm as real node does:\n${failed.join('\n')}\n\nunder node (exit ${node.status}):\n${node.stdout}${node.stderr}`);
  assert.equal(node.status, 0, `under node:\n${node.stdout}${node.stderr}`);
  assert.match(node.stdout, /^ok - under node/m, node.stdout);
  console.log('ok - lifo-node-vm (vm as node has it; under Bun and Node)');
} else {
  assert.deepEqual(failed, [], `node: lifo's node runs vm as real node does:\n${failed.join('\n')}`);
  console.log('ok - under node');
}
