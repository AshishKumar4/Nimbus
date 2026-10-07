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
// be equal. Under FORCE_COLOR, the colours are Node's too, and at the
// terminal NO_COLOR, NODE_DISABLE_COLORS, TERM=dumb and FORCE_COLOR=0 turn
// them off (lib/internal/tty.js), whose depth table the program prints.
//
// The formatter is Node's own inspect.js (node-inspect-matches-node). The
// V8 slots user land cannot read (a promise's state and result, a proxy's
// target and handler, an iterator's and a weak collection's entries) are
// read by workerd's inspect, the binding (node-inspect-host.ts), and spliced
// in: each kind is printed here through console.log, util.inspect with
// showProxy and showHidden, and console.dir (customInspect false). workerd's
// inspect alone printed a symbol key bare (`{ Symbol(k): 3 }` where Node
// brackets it), and a wide string's table column narrow.
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
console.log('multi\nline', { x: 'a\nb', 'quoted-key': 2, [Symbol('k')]: 3, [Symbol()]: 4 });
console.log(Promise.resolve({ a: 1 }), new Promise(() => {}), new Map([[1, 2]]).entries(), new Set(['v']).values(), new Proxy({ p: 1 }, {}));
const rejected = Promise.reject(Object.assign(new Error('no'), { stack: 'Error: no\n    at r (/r.js:1:1)' })); rejected.catch(() => {});
console.log(rejected);
class Sub extends Map { extra = true; }
console.log(new Sub([[1, 2]]), Object.setPrototypeOf(new Map([[1, 2]]), null), Object.setPrototypeOf([1, 2], null));
const many = new AggregateError([new Error('a')], 'many'); many.stack = 'AggregateError: many\n    at z (/z.js:3:3)'; many.errors[0].stack = 'Error: a\n    at a (/a.js:1:1)';
console.log(many);
console.log({ get value() { return 1; }, set value(v) {}, get only() { return 2; } }, { f() {}, async g() {}, *h() {} });
console.log(Array.from({ length: 30 }, (_, i) => 'item' + i), ['日本', '語', 'テキスト', 'abc', 'de', 'f', 'g', 'h', 'i', 'j']);
console.log(new URL('http://user:pw@host:8080/p?q=s#h'), Buffer.from('hello'), new Float64Array([0.5, -0]), new WeakMap());
// V8's slots (node-inspect-host.ts THE BINDING): promise states, a null-prototype
// promise and iterator, proxies (and showProxy), iterators, weak collections
// with showHidden; through console.log, util.inspect and console.dir (customInspect false).
const weakKey = { weak: 1 };
const slots = [
  Promise.resolve(42), Promise.resolve({ deep: { er: [1, 2, { x: 'y, z' }] } }), new Promise(() => {}), rejected,
  Object.setPrototypeOf(Promise.resolve(7), null), Object.assign(Promise.resolve('f'), { field: [1] }),
  new Proxy({ p: 1 }, {}), new Proxy([1, 2], { get: (t, k) => t[k] }), Proxy.revocable({}, {}),
  new Map([[{ k: 1 }, new Set([1])], ['s', 'v']]).entries(), new Map([['a', 1]]).keys(), new Set([[1, 2], 'two']).values(),
  Object.setPrototypeOf(new Map([[1, 2]]).entries(), null), new WeakMap([[weakKey, { v: 1 }]]), new WeakSet([weakKey]),
];
slots[8].revoke();
slots[8] = slots[8].proxy;
// Node's colour policy (lib/internal/tty.js): a terminal's depth for each environment.
const tty = require('tty');
for (const env of [{}, { FORCE_COLOR: '0' }, { FORCE_COLOR: '1', NO_COLOR: '1' }, { FORCE_COLOR: '2' }, { FORCE_COLOR: '3' }, { NO_COLOR: '' },
  { NODE_DISABLE_COLORS: '1' }, { TERM: 'dumb' }, { TERM: 'xterm-256color' }, { TERM: 'xterm' }, { COLORTERM: 'truecolor' }, { TMUX: '1' },
  { CI: '1', GITHUB_ACTIONS: '1' }, { CI: '1' }, { TERM_PROGRAM: 'iTerm.app', TERM_PROGRAM_VERSION: '3.4' }, { TERM: 'screen' }]) {
  console.log('depth', JSON.stringify(env), tty.WriteStream.prototype.getColorDepth.call(null, env), tty.WriteStream.prototype.hasColors.call(null, 256, env));
}
for (const value of slots) {
  console.log(value);
  console.log(util.inspect(value, { showProxy: true }), util.inspect(value, { showHidden: true }), util.inspect(value, { depth: 0, colors: true }));
  console.dir(value);
  console.dir(value, { showHidden: true, showProxy: true, depth: 1 });
}
console.log(util.inspect({ a: { b: { c: { d: 1 } } } }, { depth: 0, sorted: true, compact: false, breakLength: 20 }), util.inspect('x'.repeat(30), { maxStringLength: 4 }));
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
console.table([{ a: 1, b: 'x' }, { a: 2, c: true }]);
console.table({ r1: { c1: 1 }, r2: { c2: [1, 2, 3, 4], c3: { d: { e: 1 } } } });
console.table([1, 'two', { three: 3 }]);
console.table(new Map([['k', { v: 1 }], [2, 'two']]));
console.table(new Set(['s', 1]));
console.table([{ a: 1, b: 2 }, { a: 3 }], ['a', 'b']);
console.table('not tabular');
console.table([{ wide: '日本語', ascii: 'abc', emoji: '😀👍🏽' }]);
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
    // The first differences and the session's stderr: a run that stopped says why there.
    if (differing.length > 0) {
      console.error(`stdout differs from node's at ${differing.length} lines; the first:\n${differing.slice(0, 12).join('\n')}`);
      console.error(`--- session stderr:\n${actual.stderr.slice(-3000)}`);
    }
    assert.equal(differing.length, 0, 'stdout is node\'s, line for line');
    assert.equal(actual.stdout, expected.stdout, 'stdout is node\'s, byte for byte');
    // A warning names its process's pid, which differs.
    const pid = (text) => text.replace(/^\(node:\d+\) /gm, '(node:<pid>) ');
    assert.equal(pid(actual.stderr), pid(expected.stderr), 'stderr is node\'s, byte for byte but the pid');
    await t.run('cd /home/user/console && FORCE_COLOR=1 node coloured.js > cout.txt 2> cerr.txt; echo "STATUS=$?"', 120_000);
    assert.deepEqual({ stdout: await read('cout.txt'), stderr: await read('cerr.txt') }, colouredExpected, 'coloured as node colours');
    // At the terminal: colours unless the environment turns them off, as node's policy says.
    const ESC = '\u001b[';
    for (const [env, coloured] of [['', true], ['NO_COLOR=1 ', false], ['NODE_DISABLE_COLORS=1 ', false], ['TERM=dumb ', false], ['FORCE_COLOR=0 ', false]]) {
      const run = await t.run(`${env}node -e "console.log({ a: 1 })"`, 60_000);
      // The object's line, not the command's echo.
      const line = run.output.split('\n').find((l) => l.includes('a:') && !l.includes('console.log'));
      assert.ok(line, `${env}node printed the object: ${JSON.stringify(run.output.slice(-300))}`);
      assert.equal(line.includes(ESC), coloured, `${env || 'no env: '}node at a terminal ${coloured ? 'colours' : 'does not colour'}: ${JSON.stringify(line)}`);
    }
  } finally {
    await t.close();
    await deleteSession(sid).catch(() => {});
  }
} finally {
  await probe.stop();
}
console.log('console-format-matches-node-workerd: console prints what node prints');
