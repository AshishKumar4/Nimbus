#!/usr/bin/env bun
// An inline `node` run is a realm of its own (Kinu ask 17).
//
// The library host's `node` evaluated programs with `new Function` in the
// host's own realm, so a program's globals were the host's: in Kinu's CLI a
// program that rebound `globalThis.Array` broke the host's sqlite-vfs, and a
// test's fake timers replaced the host's. What has to hold, through the
// public workspace API, under Bun and under Node (run-under-node below):
//
//   (1) a program that rebinds intrinsics and globals (Array.isArray, Array,
//       setTimeout, Object.prototype) leaves the host's untouched, and the
//       workspace keeps working after it;
//   (2) an ES module runs in strict mode, as Node runs one: a write to a
//       frozen property throws, in the entry and in a module it imports;
//   (3) a program that never returns is ended by the caller's abort (kill,
//       Ctrl-C), even in a loop that never yields, and the caller is answered;
//   (4) readFileSync(0) blocks until stdin ends, as in Node, also when stdin
//       arrives in delayed pieces;
//   (5) timers a program leaves run before the command ends, as Node runs its
//       event loop to empty.
//
// Run by bun, it checks the source under Bun, then runs itself under node
// against the built package (packages/core/dist: rebuild first), whose
// realm is a Node worker thread.

import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const underBun = typeof process.versions.bun === 'string';
const { NimbusWorkspace } = await import(underBun
  ? '../../packages/core/src/workspace/nimbus-workspace.ts'
  : '../../packages/core/dist/workspace/nimbus-workspace.js');

/** The workspace's SQLite, on the host's own: bun:sqlite or node:sqlite, as core's README shows. */
async function hostSqlite() {
  if (underBun) {
    const { Database } = await import('bun:sqlite');
    const db = new Database(':memory:');
    return {
      sql: { exec(q, ...p) { const st = db.query(q); if (st.columnNames.length === 0) { db.run(q, ...p); return []; } return st.all(...p); } },
      transactions: { storage: { transactionSync: (cb) => db.transaction(cb)() } },
    };
  }
  const { DatabaseSync } = await import('node:sqlite');
  const db = new DatabaseSync(':memory:');
  let depth = 0;
  return {
    sql: {
      exec(q, ...p) {
        const st = db.prepare(q);
        if (st.columns().length === 0) { if (p.length === 0) db.exec(q); else st.run(...p); return []; }
        return st.all(...p);
      },
    },
    transactions: {
      storage: {
        transactionSync(cb) {
          const name = `s${depth}`;
          db.exec(depth === 0 ? 'BEGIN' : `SAVEPOINT ${name}`);
          depth++;
          try {
            const result = cb();
            depth--;
            db.exec(depth === 0 ? 'COMMIT' : `RELEASE ${name}`);
            return result;
          } catch (error) {
            depth--;
            db.exec(depth === 0 ? 'ROLLBACK' : `ROLLBACK TO ${name}; RELEASE ${name}`);
            throw error;
          }
        },
      },
    },
  };
}

const { sql, transactions } = await hostSqlite();
const ws = await NimbusWorkspace.create({ sql, transactions, generation: 1 });
const run = async (command, options = {}) => {
  const result = await ws.exec(command, { cwd: '/home/user', ...options });
  return { code: result.exitCode, out: result.stdout, err: result.stderr };
};
await ws.fs.mkdir('/home/user/m', { recursive: true });

// ── (1) the host's realm is the host's ─────────────────────────────────────
{
  const hostIsArray = Array.isArray;
  const hostArray = globalThis.Array;
  const hostSetTimeout = globalThis.setTimeout;
  await ws.fs.writeFile('/home/user/m/rebind.js', [
    'Array.isArray = () => true;',
    'globalThis.Array = function NotArray() {};',
    'globalThis.setTimeout = () => 0;',
    'Object.prototype.polluted = "yes";',
    'console.log("rebound");',
  ].join('\n'));
  const r = await run('node m/rebind.js');
  assert.equal(r.out, 'rebound\n', r.err);
  assert.equal(Array.isArray, hostIsArray, '(1) Array.isArray is the host\'s');
  assert.equal(Array.isArray({}), false);
  assert.equal(globalThis.Array, hostArray, '(1) Array is the host\'s');
  assert.equal(globalThis.setTimeout, hostSetTimeout, '(1) setTimeout is the host\'s (fake timers stay the program\'s)');
  assert.equal({}.polluted, undefined, '(1) Object.prototype is the host\'s');
  const after = await run('echo still-working > m/after.txt && cat m/after.txt && ls -1 m');
  assert.equal(after.out, 'still-working\nafter.txt\nrebind.js\n', `(1) the workspace still works: ${after.err}`);
}

// ── (2) an ES module is strict ─────────────────────────────────────────────
{
  const probe = 'const o = Object.freeze({ a: 1 }); let r; try { o.a = 2; r = "silent"; } catch (e) { r = e.constructor.name; }';
  await ws.fs.writeFile('/home/user/m/strict.mjs', `import { inner } from './inner.mjs';\n${probe}\nconsole.log('entry ' + r + ' inner ' + inner);\n`);
  await ws.fs.writeFile('/home/user/m/inner.mjs', `${probe}\nexport const inner = r;\n`);
  const r = await run('node m/strict.mjs');
  assert.equal(r.out, 'entry TypeError inner TypeError\n', `(2) a frozen write throws in strict ES modules: ${r.err}`);
  // CommonJS stays sloppy, as in Node.
  await ws.fs.writeFile('/home/user/m/sloppy.cjs', `${probe}\nconsole.log(r);\n`);
  assert.equal((await run('node m/sloppy.cjs')).out, 'silent\n');
}

// ── (3) abort ends a program that never yields ─────────────────────────────
{
  const controller = new AbortController();
  const started = Date.now();
  const pending = run('node -e "while (true) {}"', { signal: controller.signal });
  setTimeout(() => controller.abort(), 300);
  const r = await Promise.race([pending, new Promise((resolve) => setTimeout(() => resolve('still running'), 10_000))]);
  assert.notEqual(r, 'still running', '(3) the abort ended the loop');
  assert.notEqual(r.code, 0, '(3) and the command did not succeed');
  assert.ok(Date.now() - started < 5_000);
  // The workspace is still usable.
  assert.equal((await run('echo ok')).out, 'ok\n');
}

// ── (4) readFileSync(0) blocks until stdin ends ────────────────────────────
{
  const whole = await run(`node -e "process.stdout.write('[' + require('fs').readFileSync(0, 'utf8') + ']')"`, { stdin: 'abc' });
  assert.equal(whole.out, '[abc]', `(4) stdin read whole: ${whole.err}`);
  // A pipe whose writer writes `a`, then `b` 200 ms later, then ends.
  const r = await run(`{ printf a; sleep 0.2; printf b; } | node -e "process.stdout.write('[' + require('fs').readFileSync(0, 'utf8') + ']')"`);
  assert.equal(r.out, '[ab]', `(4) stdin written in delayed pieces is read to its end: ${r.err}`);
}

// ── (5) the event loop runs to empty ───────────────────────────────────────
{
  const r = await run(`node -e "setTimeout(() => console.log('later'), 100); console.log('now')"`);
  assert.equal(r.out, 'now\nlater\n', `(5) a timer the program left runs before the command ends: ${r.err}`);
  // As in Node: process.exit() in a timer exits with its code, and a rejection
  // nothing handles after the main script ends the process with 1.
  const exited = await run(`node -e "setTimeout(() => { console.log('bye'); process.exit(7); console.log('never') }, 50)"`);
  assert.deepEqual([exited.code, exited.out], [7, 'bye\n'], `(5) process.exit() from a timer: ${exited.err}`);
  const rejected = await run(`node -e "setTimeout(() => Promise.reject(new Error('late')), 50); setTimeout(() => console.log('never'), 500)"`);
  assert.equal(rejected.code, 1, '(5) a late unhandled rejection ends the process');
  assert.match(rejected.err, /late/);
  assert.equal(rejected.out, '');
  // Every write arrives, in order, though the program ends right after.
  const many = await run(`node -e "for (let i = 0; i < 2000; i++) console.log(i)"`);
  assert.equal(many.out, Array.from({ length: 2000 }, (_, i) => `${i}\n`).join(''), '(5) all output, in order');
}

await ws.close();

if (underBun) {
  const node = spawnSync('node', ['--no-warnings', fileURLToPath(import.meta.url)], { encoding: 'utf8', timeout: 120_000 });
  assert.equal(node.status, 0, `under node:\n${node.stdout}${node.stderr}`);
  assert.match(node.stdout, /^ok - under node/m, node.stdout);
  console.log('ok - inline-node-realm (own realm, strict ESM, abort, blocking stdin, event loop; under Bun and Node)');
} else {
  console.log('ok - under node');
}
