#!/usr/bin/env bun
// A node:sqlite database a program changes keeps its changes, as Node's does:
// - closed and opened again in the same run, the second connection sees what
//   the first wrote (the close puts the image in the process's own view);
// - a write made by a statement that returns rows (INSERT ... RETURNING
//   through all() and get()) is as much a write as run()'s;
// - and the session holds what was written once the run ends.
// A database the program only reads is not written back (another principal's,
// which it may read and not write, closes without a refusal).
// Runs the real generated one-shot module. Red before: the reopen read the
// startup snapshot (the close's write went to the session asynchronously, not
// to the process's view), and all()/get() never marked the database changed,
// so a close after them wrote nothing.
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { generateEntrypointCode } from '../../packages/worker/src/facets/manager.ts';
import { generateShimsCode } from '../../packages/worker/src/runtime/node-shims.ts';
import { SQLITE_WASM_MODULE_NAME } from '../../packages/worker/src/runtime/opencode-facet-runner.ts';
import { SQLJS_VERSION } from '../../packages/core/src/constants.ts';
import { CRED_KERNEL } from '../../packages/core/src/runtime/os-contracts.ts';
import { nodeFacetSources } from './lib/node-facet-sources.mjs';
import { generatedModuleSet, writeModuleSet } from './lib/module-map-bundle.mjs';
import { createAuthority } from './lib/resident-body.mjs';
import { processInstanceSupervisor } from './lib/process-instance-supervisor.mjs';

const realProcess = globalThis.process;
const dir = mkdtempSync(join(tmpdir(), 'node-sqlite-persistence-'));
realProcess.on('exit', () => rmSync(dir, { recursive: true, force: true }));
const cred = { uid: 1000, gid: 1000, groups: [1000], umask: 0o022 };
const authority = createAuthority();
const kernel = authority.rawVfs.as(CRED_KERNEL);
const wasmBytes = readFileSync(new URL(`../../packages/worker/public/_assets/sqljs-${SQLJS_VERSION}.wasm`, import.meta.url));

/** Run `program` as a one-shot Node process over the authority's filesystem; its stdout parsed. */
async function run(program) {
  const generated = await generateEntrypointCode(program, { bundle: {} }, true, nodeFacetSources(generateShimsCode()));
  const runDir = mkdtempSync(join(dir, 'run-'));
  const file = writeModuleSet(runDir, generatedModuleSet(generated, 'runner.mjs'), 'runner.mjs', (name, source) =>
    name === 'runner.mjs' ? source.replace(`from "${SQLITE_WASM_MODULE_NAME}"`, 'from "./sqlite-wasm.mjs"') : source);
  realProcess.getBuiltinModule('node:fs').writeFileSync(join(runDir, 'sqlite-wasm.mjs'),
    `export default new WebAssembly.Module(new Uint8Array(${JSON.stringify([...wasmBytes])}));\n`);
  const mod = await import(file);
  const process = processInstanceSupervisor(authority, cred);
  let body;
  try {
    const response = await mod.default.fetch(new Request('http://facet/', {
      method: 'POST',
      body: JSON.stringify({
        argv: [], env: {}, cwd: '/home/user', filename: '/home/user/main.js', dirname: '/home/user',
        stdin: '', captureOutput: true, cred, pid: process.pid,
      }),
    }), { SUPERVISOR: process.supervisor });
    body = await response.json();
  } finally {
    await process.close();
  }
  assert.equal(body.exitCode, 0, JSON.stringify(body));
  return JSON.parse(body.stdout);
}

// ── one run: close, then open again ──────────────────────────────────────
const seen = await run(`
const { DatabaseSync } = require('node:sqlite');
const db = new DatabaseSync('/home/user/app.db');
db.exec('CREATE TABLE t (v INTEGER)');
db.prepare('INSERT INTO t VALUES (?)').run(1);
db.close();
const again = new DatabaseSync('/home/user/app.db');
const afterReopen = again.prepare('SELECT v FROM t ORDER BY v').all().map((row) => row.v);
const returned = again.prepare('INSERT INTO t VALUES (2) RETURNING v').all().map((row) => row.v);
const got = again.prepare('INSERT INTO t VALUES (3) RETURNING v').get().v;
again.close();
const third = new DatabaseSync('/home/user/app.db');
const afterRows = third.prepare('SELECT v FROM t ORDER BY v').all().map((row) => row.v);
third.close();
console.log(JSON.stringify({ afterReopen, returned, got, afterRows }));
`);
assert.deepEqual(seen.afterReopen, [1], 'a connection opened after a close sees what the closed one wrote');
assert.deepEqual([seen.returned, seen.got], [[2], 3], 'INSERT ... RETURNING returns its rows through all() and get()');
assert.deepEqual(seen.afterRows, [1, 2, 3], "all()'s and get()'s writes are kept when the connection closes");

// ── the session holds what the run wrote ─────────────────────────────────
const later = await run(`
const { DatabaseSync } = require('node:sqlite');
const db = new DatabaseSync('/home/user/app.db');
console.log(JSON.stringify({ rows: db.prepare('SELECT v FROM t ORDER BY v').all().map((row) => row.v) }));
db.close();
`);
assert.deepEqual(later.rows, [1, 2, 3], 'the next run reads every row the last one wrote');

// ── a database only read is not written ──────────────────────────────────
// Another principal's, which this one may read and not write: a close that
// wrote it back would be refused.
kernel.chown('home/user/app.db', 2000, 2000);
kernel.chmod('home/user/app.db', 0o644);
const before = new TextDecoder('latin1').decode(kernel.readFile('home/user/app.db'));
const readOnly = await run(`
const { DatabaseSync } = require('node:sqlite');
const db = new DatabaseSync('/home/user/app.db');
const count = db.prepare('SELECT count(*) AS n FROM t').get().n;
const rows = db.prepare('SELECT v FROM t WHERE v > ?').all(1).length;
db.close();
console.log(JSON.stringify({ count, rows }));
`);
assert.deepEqual(readOnly, { count: 3, rows: 2 }, 'another principal reads the database');
assert.equal(new TextDecoder('latin1').decode(kernel.readFile('home/user/app.db')), before, 'a database the run only read is not written back');

realProcess.stdout.write('node-sqlite-persistence: PASS\n');
realProcess.exit(0);
