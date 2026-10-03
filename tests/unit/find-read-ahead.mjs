#!/usr/bin/env bun
// find on a mount whose every call is a round trip (Kinu's /sandbox, a
// container file system: an agent's `find / -maxdepth 6` ran 30 minutes).
//
// Two things are true of it. With -xdev, find stays off the mount: it lists
// the mount point and makes no other call there. Without, it reads ahead of
// itself, a bounded number of calls at once, in the order it will need them,
// and prints exactly what the walk that reads one thing at a time prints.
//
// The serial walk is the same command with `-o -exec true ;` after it: any
// -exec turns read-ahead off (a command could change what is read next), and
// after -print, which is always true, the -exec never runs.

import assert from 'node:assert/strict';
import { MemoryVFS } from '../../packages/core/src/vfs/memory.ts';
import { NimbusWorkspace } from '../../packages/core/src/workspace/nimbus-workspace.ts';
import { createSqliteVfsTestHarness } from './sqlite-vfs-test-harness.mjs';

const FAN_OUT = 5;
const LEVELS = 3;
/** Each call's delay: long enough to time, then short for the checks of what read-ahead prints. */
let roundTripMs = 5;

const backing = new MemoryVFS({ uid: 1000, gid: 1000 });
let directories = 0;
const fill = (at, level) => {
  directories++;
  for (let i = 0; i < 2; i++) backing.writeFile(`${at}/f${i}`, new TextEncoder().encode(`${at}/f${i}\n`));
  if (level === LEVELS) return;
  for (let i = 0; i < FAN_OUT; i++) {
    backing.mkdir(`${at}/d${i}`);
    fill(`${at}/d${i}`, level + 1);
  }
};
fill('', 0);

/** Every call the mount answers, by method and path, and the most in flight at once. */
const calls = [];
let inFlight = 0;
let mostInFlight = 0;
/** `vfs` mounted at `at`, with every readdir and stat a round trip, counted. */
const slowly = (vfs, at) => new Proxy(vfs, {
  get(target, key) {
    if (key === 'sync') return undefined;
    const value = Reflect.get(target, key);
    if (typeof value !== 'function') return value;
    if (key !== 'readdir' && key !== 'stat') return value.bind(target);
    return async (...args) => {
      calls.push({ mount: at, method: key, path: args[0] });
      inFlight++;
      mostInFlight = Math.max(mostInFlight, inFlight);
      try {
        await new Promise((resolve) => setTimeout(resolve, roundTripMs));
        return value.apply(target, args);
      } finally {
        inFlight--;
      }
    };
  },
  has(target, key) { return key !== 'sync' && key in target; },
});
const slow = slowly(backing, '/slow');

const harness = createSqliteVfsTestHarness();
const ws = await NimbusWorkspace.create({ sql: harness.sql, transactions: harness.ctx });
ws.filesystem.vfs.mount('/slow', slow);

async function find(args) {
  calls.length = 0;
  mostInFlight = 0;
  const started = performance.now();
  const result = await ws.exec(`find ${args}`);
  const ms = performance.now() - started;
  assert.equal(result.exitCode, 0, `find ${args}: ${result.stderr}`);
  const made = calls.filter((call) => call.mount === '/slow');
  return { stdout: result.stdout, ms, readdirs: made.filter((call) => call.method === 'readdir'), stats: made.filter((call) => call.method === 'stat'), mostInFlight };
}

// ── Read ahead, and print what reading one thing at a time prints ──────────
const ahead = await find('/slow');
const serial = await find("/slow -print -o -exec true ';'");
assert.equal(ahead.stdout, serial.stdout, 'the same files, in the same order');
assert.equal(ahead.stdout.split('\n').length - 1, directories * 3, 'every directory and file');
assert.equal(serial.mostInFlight, 1, 'without read-ahead, one call at a time');
assert.ok(ahead.mostInFlight > 1 && ahead.mostInFlight <= 32, `read-ahead runs calls together, boundedly: ${ahead.mostInFlight}`);
assert.equal(ahead.readdirs.length, directories, 'each directory listed once');
assert.ok(ahead.ms * 4 < serial.ms, `read-ahead is several times faster: ${ahead.ms.toFixed(0)} ms vs ${serial.ms.toFixed(0)} ms`);
const timing = `${directories} directories, ${roundTripMs} ms a call: serial ${serial.ms.toFixed(0)} ms, read-ahead ${ahead.ms.toFixed(0)} ms (${ahead.mostInFlight} calls at once)`;
roundTripMs = 1;

// `-o -false -exec …` never runs the command either, and keeps the expression's own actions.
for (const expression of ['-name f1 -print', '-type d -empty -print', '-mindepth 2 -maxdepth 2 -printf "%d %p\\n"', '-depth -print', '-path /slow/d2 -prune -o -name f0 -print']) {
  const quick = await find(`/slow ${expression}`);
  const plain = await find(`/slow '(' ${expression} ')' -o -false -exec true ';'`);
  assert.equal(quick.stdout, plain.stdout, `find /slow ${expression}: the same with and without read-ahead`);
  assert.equal(plain.mostInFlight, 1);
}

// ── -prune: the pruned directory's own listing may be read ahead, nothing below it ──
{
  const pruned = await find('/slow -path /slow/d0 -prune -o -print');
  assert.ok(!pruned.stdout.includes('/slow/d0/'), 'nothing under the pruned directory is printed');
  const below = pruned.readdirs.filter((call) => call.path.startsWith('/d0/'));
  assert.deepEqual(below, [], 'and nothing under it is read');
}

// ── -maxdepth and -quit: no reading past what the walk can reach ───────────
assert.equal((await find('/slow -maxdepth 1')).readdirs.length, 1, '-maxdepth 1 lists /slow alone');
{
  const quit = await find('/slow -name f0 -print -quit');
  assert.equal(quit.stdout, '/slow/f0\n');
  assert.ok(quit.readdirs.length < directories, `-quit stops reading ahead: ${quit.readdirs.length} of ${directories} listings`);
}

// ── A closed pipe ends the walk, and with it everything read ahead ─────────
{
  calls.length = 0;
  const result = await ws.exec('find /slow | head -n 1');
  assert.equal(result.stdout, '/slow\n');
  assert.equal(inFlight, 0, 'no call is left in flight when the pipeline returns');
  const made = calls.length;
  await new Promise((resolve) => setTimeout(resolve, 50));
  assert.equal(calls.length, made, 'and none is started after it');
}

// ── -L: a link back to an ancestor is never listed, read ahead or not ─────
{
  const looped = new MemoryVFS({ uid: 1000, gid: 1000 });
  looped.mkdir('/a');
  looped.mkdir('/a/b');
  looped.writeFile('/a/b/f', new Uint8Array(1));
  looped.symlink('..', '/a/up');
  looped.symlink('.', '/a/self');
  ws.filesystem.vfs.mount('/loop', slowly(looped, '/loop'));
  calls.length = 0;
  const quick = await ws.exec('find -L /loop');
  const listed = calls.filter((call) => call.method === 'readdir').map((call) => call.path).sort();
  const plain = await ws.exec("find -L /loop -print -o -exec true ';'");
  assert.deepEqual([quick.stdout, quick.stderr, quick.exitCode], [plain.stdout, plain.stderr, plain.exitCode], 'the same walk read ahead or not');
  assert.match(quick.stderr, /File system loop detected; '\/loop\/a\/up' is part of the same file system loop as '\/loop'/);
  assert.deepEqual(listed, ['/', '/a', '/a/b'], 'each directory listed once: neither loop link is');
}

// ── -xdev: the mount point is listed, and nothing on the mount is read but its stat ──
{
  const stay = await find('/ -xdev -maxdepth 2 -name slow');
  assert.equal(stay.stdout, '/slow\n', 'the mount point is visited');
  assert.deepEqual(stay.readdirs, [], 'its contents are never listed');
  assert.ok(stay.stats.length <= 1, `only the mount point itself is stat'ed: ${JSON.stringify(stay.stats)}`);
}

await ws.close();
console.log(`find-read-ahead: ${timing}`);
