#!/usr/bin/env bun
// A program's vm and domain, as Node gives them (X-9): run through the public
// workspace API, a program writes exactly what real `node` writes running it.
//
//   - vm is the engine's: contexts, scripts, compileFunction, runInThisContext,
//     an error thrown in another context; vm's module classes are absent, as
//     in Node without --experimental-vm-modules;
//   - a dynamic import in vm code under
//     constants.USE_MAIN_CONTEXT_DEFAULT_LOADER loads the program's module,
//     from the workspace (not a file of the host's at that path); with no
//     callback, it refuses as Node does;
//   - domain is the engine's in the program's realm: an error thrown in a
//     domain's timer or tick is its 'error' (Node only: Bun's domain catches
//     neither).
//
// And without an oracle: the constant with no absolute filename, which Node
// resolves against its process's directory, is refused (that import would
// have no referrer of the program's); and a lifo CommonJS command, which runs
// in the host's realm, has vm but not domain (it would set the host's
// process).
//
// Red before: vm and domain were refused whole.
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

/** Files both sides have: the module vm code imports. */
const files = {
  'vmmod.mjs': "export const here = 'from ' + import.meta.url.split('/').pop();\n",
};

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
    'console.log(context.n, script instanceof vm.Script, vm.createScript("1") instanceof vm.Script);',
    "console.log(vm.compileFunction('return a + b', ['a', 'b'])(2, 3));",
    "console.log(vm.runInThisContext('typeof globalThis.setTimeout'));",
    "try { vm.runInNewContext('throw new TypeError(\"inner\")', {}, { filename: '/thrower.js' }); } catch (e) { console.log(e.name, e.message, e instanceof TypeError); }",
    "console.log(typeof vm.SourceTextModule, typeof vm.SyntheticModule, 'SourceTextModule' in vm, typeof vm.constants.USE_MAIN_CONTEXT_DEFAULT_LOADER);",
  ].join('\n'), 'node {prog}'],
  // The constant's ExperimentalWarning names Node's pid: stderr is not compared.
  'vmimport.js': [[
    "const vm = require('vm');",
    "const path = require('path');",
    'const loader = vm.constants.USE_MAIN_CONTEXT_DEFAULT_LOADER;',
    "const filename = path.join(__dirname, 'script.js');",
    'const steps = [',
    "  ['script imported', () => new vm.Script(\"import('./vmmod.mjs').then((m) => m.here)\", { filename, importModuleDynamically: loader }).runInThisContext()],",
    "  ['function imported', () => vm.compileFunction(\"return import('./vmmod.mjs').then((m) => m.here)\", [], { filename: path.join(__dirname, 'fn.js'), importModuleDynamically: loader })()],",
    "  ['builtin imported', () => vm.runInNewContext(\"import('node:path').then((p) => typeof p.join)\", {}, { filename: path.join(__dirname, 'ctx.js'), importModuleDynamically: loader })],",
    "  ['no callback', () => new vm.Script(\"import('./vmmod.mjs')\", { filename }).runInThisContext()],",
    '];',
    '(async () => {',
    "  for (const [label, step] of steps) { try { console.log(label, await step()); } catch (e) { console.log(label, 'failed', e.code); } }",
    '})();',
  ].join('\n'), 'node {prog} 2>/dev/null'],
  'domain.js': [[
    "const domain = require('domain');",
    'const d = domain.create();',
    "d.on('error', (e) => console.log('caught', e.message));",
    "d.run(() => { setTimeout(() => { throw new Error('async boom'); }, 10); });",
    "d.run(() => { process.nextTick(() => { throw new Error('tick boom'); }); });",
    "setTimeout(() => console.log('after'), 50);",
    "process.on('exit', (code) => console.log('exit', code));",
  ].join('\n'), 'node {prog}; echo status $?', 'node'],
};

/** `promise`, or a failure naming `what` once `ms` pass. */
const within = (ms, promise, what) => Promise.race([promise, new Promise((_, reject) => setTimeout(() => reject(new Error(`${what}: still running after ${ms} ms`)), ms))]);

const { sql, transactions } = await hostSqlite();
const terminal = { write() {}, writeln() {}, onData() {}, cols: 80, rows: 24, focus() {}, clear() {} };
const ws = await NimbusWorkspace.create({ sql, transactions, generation: 1, terminal });
const host = mkdtempSync(join(tmpdir(), 'lifo-node-vm-'));
const failed = [];
try {
  for (const [name, text] of Object.entries(files)) {
    await ws.fs.writeFile(`/home/user/${name}`, text);
    writeFileSync(join(host, name), text);
  }
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

  // ── no oracle: the constant with no absolute filename ─────────────────────
  try {
    await ws.fs.writeFile('/home/user/nofilename.js', [
      "const vm = require('vm');",
      'const loader = vm.constants.USE_MAIN_CONTEXT_DEFAULT_LOADER;',
      "for (const filename of [undefined, 'relative.js']) {",
      "  try { new vm.Script(\"import('./vmmod.mjs')\", { filename, importModuleDynamically: loader }); console.log('made'); } catch (e) { console.log(e.code, e.message); }",
      '}',
    ].join('\n'));
    const ran = await within(30_000, ws.exec('node nofilename.js', { cwd: '/home/user' }), 'nofilename.js');
    const refusal = 'ERR_FEATURE_UNAVAILABLE_ON_PLATFORM The feature vm.constants.USE_MAIN_CONTEXT_DEFAULT_LOADER without an absolute filename is unavailable on the current platform, which is being used to run Node.js';
    assert.equal(ran.stdout, `${refusal}\n${refusal}\n`, 'refused, naming what');
  } catch (error) {
    failed.push(`the constant with no absolute filename: ${error.message}`);
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
    assert.equal(ran.stdout, 'vm 2\ndomain ERR_FEATURE_UNAVAILABLE_ON_PLATFORM\n', 'its domain would set the host\'s process');
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
  assert.deepEqual(failed, [], `bun: lifo's node runs vm and domain as real node does:\n${failed.join('\n')}\n\nunder node (exit ${node.status}):\n${node.stdout}${node.stderr}`);
  assert.equal(node.status, 0, `under node:\n${node.stdout}${node.stderr}`);
  assert.match(node.stdout, /^ok - under node/m, node.stdout);
  console.log('ok - lifo-node-vm (vm and domain as node has them; under Bun and Node)');
} else {
  assert.deepEqual(failed, [], `node: lifo's node runs vm and domain as real node does:\n${failed.join('\n')}`);
  console.log('ok - under node');
}
