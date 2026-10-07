// @serial
// @tier slow — drives a local workerd
// console prints what Node's console prints: util.formatWithOptions over its
// arguments, util.inspect for every value that is not a string (nested to
// depth 2, Map and Set, circular references, a class's name, an error with
// its stack, its own properties and its cause), %s %d %i %f %j %o %O %c and
// %%, a group's indent, console.dir's options, console.assert and
// console.count, colours where Node uses them. The process's console printed
// objects as JSON (`{"a":1}` for Node's `{ a: 1 }`).
//
// The same program runs under real node and as `node` in a session, its
// output redirected to files (no terminal: no colours), and the bytes must
// be equal. Under FORCE_COLOR, the colours are Node's too.
//
// One difference is workerd's and not covered: its inspect prints a symbol
// key bare (`{ Symbol(k): 3 }`) where Node 22 brackets it (`{ [Symbol(k)]:
// 3 }`), workerd src/node/internal/internal_inspect.ts formatProperty.
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { startLocalProbe } from './lib/workerd-probe.mjs';

const PROGRAM = String.raw`
const util = require('util');
console.log({ a: 1, b: 'two', c: [1, 2, 3], d: { e: { f: { g: { h: 1 } } } } });
console.log([1, 'a', null, undefined, true, 10n, Symbol('s')], -0, 1e21, NaN);
console.log(new Map([[1, { a: 1 }], ['k', [1, 2]]]), new Set([1, 'x']));
console.log(Array.from({ length: 120 }, (_, i) => i));
console.log({ long: 'x'.repeat(100), list: ['alpha', 'beta', 'gamma', 'delta', 'epsilon', 'zeta', 'eta', 'theta', 'iota', 'kappa'] });
console.log('%s is %d years, %i whole, %f float', 'Bob', 42.5, 42.5, '1.5');
console.log('%s', { a: 1 }, '%s', Symbol('t'));
console.log('%o', { a: [1, 2, { b: 3 }] });
console.log('%O', { a: [1, 2, { b: 3 }] });
console.log('%j', { a: 1 }, 'extra', { b: 2 });
console.log('%c styled', 'color: red');
console.log('100%', 'done', '%%', '%d');
const circ = { name: 'c' }; circ.self = circ; circ.list = [circ];
console.log(circ);
class Point { constructor() { this.x = 1; this.y = 2; } }
console.log(new Point(), Point, Object.create(null), Object.assign(Object.create(null), { a: 1 }));
const err = new Error('boom'); err.stack = 'Error: boom\n    at fake (/x.js:1:1)'; err.code = 'E_BOOM';
console.log(err);
const inner = new TypeError('inner'); inner.stack = 'TypeError: inner\n    at innerFake (/y.js:2:2)';
const outer = new Error('outer', { cause: inner }); outer.stack = 'Error: outer\n    at outerFake (/z.js:3:3)';
console.log({ outer });
console.log({ s: 'str', f() {}, g: () => {}, d: new Date(0), r: /x/g, u: undefined });
console.log(new Uint8Array([1, 2, 3]), [, 1, , ]);
console.log('multi\nline', { x: 'a\nb', 'quoted-key': 2 });
console.error({ to: 'stderr' }, 'and', ['text']);
console.warn('%s warned', 'it');
console.dir({ a: { b: { c: { d: 1 } } } }, { depth: 0 });
console.dir({ a: { b: { c: { d: 1 } } } });
console.info(util.inspect({ a: 1, b: 'two', c: [null] }, { colors: true }));
console.log(util.format('%s', { a: 1 }), util.format({ a: 1 }, 'x'), util.inspect('str'), util.inspect(new Map([[{ k: 1 }, new Set([2])]])));
console.group('G');
console.log('inside');
console.group();
console.log({ nested: true, lines: 'a\nb' });
console.groupEnd();
console.groupEnd();
console.log('after');
console.assert(false, 'assert %s', 'msg');
console.assert(true, 'not shown');
console.assert(false);
console.count();
console.count('x');
console.count();
console.countReset();
console.count();
console.debug('debug', 1);
`;

// Colours where Node's console would use them: FORCE_COLOR forces them for
// any stream (Node's shouldColorize), as a terminal with colours does.
const COLOURED = String.raw`
const util = require('util');
console.log({ a: 1, s: 'x', n: null, d: new Date(0) }, [true, 2n, Symbol('y')]);
console.error(new Map([['k', /r/]]));
console.log('%o and %s', { a: 1 }, 'plain', util.inspect('x', { colors: false }));
`;

// ── real node ────────────────────────────────────────────────────────────
const disk = mkdtempSync(join(tmpdir(), 'console-format-'));
let expected;
let colouredExpected;
try {
  writeFileSync(join(disk, 'prog.js'), PROGRAM);
  // The oracle's colours are decided by these alone, as the session's are.
  const { NO_COLOR, FORCE_COLOR, NODE_DISABLE_COLORS, ...plain } = process.env;
  const node = spawnSync('node', ['prog.js'], { cwd: disk, env: plain, encoding: 'utf8' });
  assert.equal(node.status, 0, node.stderr);
  expected = { stdout: node.stdout, stderr: node.stderr };
  writeFileSync(join(disk, 'coloured.js'), COLOURED);
  const forced = spawnSync('node', ['coloured.js'], { cwd: disk, env: { ...plain, FORCE_COLOR: '1' }, encoding: 'utf8' });
  assert.equal(forced.status, 0, forced.stderr);
  colouredExpected = { stdout: forced.stdout, stderr: forced.stderr };
  assert.match(forced.stdout, /\x1b\[33m1\x1b\[39m/, 'premise: node colours under FORCE_COLOR');
} finally {
  rmSync(disk, { recursive: true, force: true });
}

const probe = await startLocalProbe();
try {
  process.env.BASE = probe.base;
  process.env.NIMBUS_PROBE_TOKEN = probe.token;
  const { mintSession, deleteSession, Terminal, stripAnsi } = await import('../behavioral/_driver.mjs');
  const sid = await mintSession();
  const t = new Terminal(sid);
  await t.connect();
  await t.waitForPrompt(60_000);
  try {
    const b64 = (s) => Buffer.from(s).toString('base64');
    await t.run('mkdir -p /home/user/console', 15_000);
    await t.run(`printf '%s' '${b64(PROGRAM)}' | base64 -d > /home/user/console/prog.js`, 15_000);
    await t.run(`printf '%s' '${b64(COLOURED)}' | base64 -d > /home/user/console/coloured.js`, 15_000);
    await t.run('cd /home/user/console && node prog.js > out.txt 2> err.txt; echo "STATUS=$?"', 120_000);
    const read = async (file) => {
      const run = await t.run(`base64 -w0 /home/user/console/${file}; echo; echo END`, 30_000);
      const line = stripAnsi(run.output).replace(/\r/g, '').split('\n').find((l) => /^[A-Za-z0-9+/=]{8,}$/.test(l.trim()));
      return line === undefined ? '' : Buffer.from(line.trim(), 'base64').toString('utf8');
    };
    const actual = { stdout: await read('out.txt'), stderr: await read('err.txt') };
    const stdoutLines = actual.stdout.split('\n');
    const differing = expected.stdout.split('\n').flatMap((line, i) => (stdoutLines[i] === line ? [] : [
      `line ${i + 1}\n  node:    ${JSON.stringify(line)}\n  session: ${JSON.stringify(stdoutLines[i])}`,
    ]));
    assert.deepEqual(differing, [], `stdout differs from node's:\n${differing.join('\n')}\n--- session:\n${actual.stdout}`);
    assert.equal(actual.stdout, expected.stdout, 'stdout is node\'s, byte for byte');
    assert.equal(actual.stderr, expected.stderr, 'stderr is node\'s, byte for byte');
    await t.run('cd /home/user/console && FORCE_COLOR=1 node coloured.js > cout.txt 2> cerr.txt; echo "STATUS=$?"', 120_000);
    assert.deepEqual({ stdout: await read('cout.txt'), stderr: await read('cerr.txt') }, colouredExpected, 'coloured as node colours');
  } finally {
    await t.close();
    await deleteSession(sid).catch(() => {});
  }
} finally {
  await probe.stop();
}
console.log('console-format-matches-node-workerd: console prints what node prints');
