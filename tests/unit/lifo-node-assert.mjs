#!/usr/bin/env bun
// assert's message for a falsy value given no message (X-8, closed), as Node
// writes it: run through the public workspace API, a program writes exactly
// what real `node` writes running it. Node builds the message from the call's
// source as V8 holds it: "The expression evaluated to a falsy value:\n\n
// <the call>\n", for assert(), assert.ok() and their strict forms, in a
// CommonJS module, an ES module and -e, a call split across lines included.
//
// Under node against the built package only (packages/core/dist: rebuild
// first): under Bun the engine's assert writes its own text, as plain `bun`
// does.

import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { hostSqlite } from './lib/host-sqlite.mjs';

const underBun = typeof process.versions.bun === 'string';
if (underBun) {
  const node = spawnSync('node', ['--no-warnings', fileURLToPath(import.meta.url)], { encoding: 'utf8', timeout: 180_000 });
  assert.equal(node.status, 0, `under node:\n${node.stdout}${node.stderr}`);
  assert.match(node.stdout, /^ok - under node/m, node.stdout);
  console.log('ok - lifo-node-assert (assert\'s message as node writes it; under Node)');
  process.exit(0);
}
const { NimbusWorkspace } = await import('../../packages/core/dist/workspace/nimbus-workspace.js');

/** A failed assertion's message and whether Node made it, as each case prints it. */
const show = 'const show = (run) => { try { run(); console.log(\'passed\'); } catch (e) { console.log(JSON.stringify(e.message), e.generatedMessage, e.code); } };';

/** Each case: a program, and the shell line that runs it ({prog} is its name). */
const cases = {
  'cjs.js': [[
    show,
    "const assert = require('assert');",
    'show(() => assert.ok(0 === 1));',
    "show(() => assert(typeof globalThis.nothing === 'string'));",
    "show(() => require('assert').strict.ok(null));",
    "show(() => assert['ok'](''));",
    'show(() => assert.ok(',
    '  1 > 2,',
    '));',
    "show(() => assert.ok(false, 'given'));",
    'show(() => assert.ok());',
  ].join('\n'), 'node {prog}'],
  'esm.mjs': [[
    show,
    "import assert from 'node:assert';",
    "import { ok } from 'node:assert/strict';",
    'show(() => assert.ok(1 === 2));',
    'show(() => ok(undefined));',
  ].join('\n'), 'node {prog}'],
  'eval': ["", `node -e "${show.replace(/"/g, '\\"')} show(() => require('assert').ok(false));"`],
};
/** `promise`, or a failure naming `what` once `ms` pass. */
const within = (ms, promise, what) => Promise.race([promise, new Promise((_, reject) => setTimeout(() => reject(new Error(`${what}: still running after ${ms} ms`)), ms))]);

const { sql, transactions } = await hostSqlite();
const terminal = { write() {}, writeln() {}, onData() {}, cols: 80, rows: 24, focus() {}, clear() {} };
const ws = await NimbusWorkspace.create({ sql, transactions, generation: 1, terminal });
const host = mkdtempSync(join(tmpdir(), 'lifo-node-assert-'));
const failed = [];
try {
  for (const [name, [source, line]] of Object.entries(cases)) {
    const command = line.replaceAll('{prog}', name);
    if (source) {
      await ws.fs.writeFile(`/home/user/${name}`, source);
      writeFileSync(join(host, name), source);
    }
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

} finally {
  rmSync(host, { recursive: true, force: true });
  await within(10_000, ws.close(), 'the workspace closes').catch((error) => failed.push(error.message));
}

assert.deepEqual(failed, [], `node: lifo's node writes assert's message as real node does:\n${failed.join('\n')}`);
console.log('ok - under node');
