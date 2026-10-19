#!/usr/bin/env bun
// The shell's node keeps Node's process and fs contracts, checked against the
// host's Node 22 running the same line under bash:
//
//   - 'beforeExit' is heard each time the loop runs empty, with
//     process.exitCode, again only when a listener scheduled work (a timer,
//     an immediate), never after a write or a microtask, never on
//     process.exit() or a fatal error, and with a top-level await unsettled;
//     a write it makes to /dev/full is heard by the stream's listener once;
//   - chown, lchown and fchown change the owner, in their sync, callback,
//     promise and FileHandle forms: -1 keeps a side, another's owner is
//     EPERM, an id outside -1 to 2 ** 32 - 1 is ERR_OUT_OF_RANGE and one not
//     a number ERR_INVALID_ARG_TYPE, both thrown at once.
//
// Red before: the shell's node never emitted 'beforeExit', and its chown was
// a no-op (lchown and fchown were not there).

import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { NimbusWorkspace } from '../../packages/core/src/workspace/nimbus-workspace.ts';
import { hostSqlite } from './lib/host-sqlite.mjs';

const CHOWN = String.raw`const fs = require("fs");
const mine = (p, l) => { const s = (l ? fs.lstatSync : fs.statSync)(p); return [s.uid === process.getuid(), s.gid === process.getgid()] };
const t = (f) => { try { f(); return "ok" } catch (e) { return e.code } };
console.log("keep", t(() => fs.chownSync("own", -1, process.getgid())), mine("own"));
console.log("keep2", t(() => fs.chownSync("own", process.getuid(), -1)), mine("own"));
console.log("keepMax", t(() => fs.chownSync("own", 0xffffffff, 0xffffffff)), t(() => fs.chownSync("own", 2 ** 32 - 1, process.getgid())), mine("own"));
console.log("root", t(() => fs.chownSync("own", 0, 0)));
console.log("range", t(() => fs.chownSync("own", -2, 0)), t(() => fs.chownSync("own", 2 ** 32, 0)));
console.log("type", t(() => fs.chownSync("own", "1", 0)), t(() => fs.chownSync("own", 1.5, 0)));
console.log("lchown", t(() => fs.lchownSync("own.lnk", -1, -1)), mine("own.lnk", true));
const fd = fs.openSync("own", "r"); console.log("fchown", t(() => fs.fchownSync(fd, -1, process.getgid())), t(() => fs.fchownSync(fd, 0, 0))); fs.closeSync(fd);
console.log("missing", t(() => fs.chownSync("nope", -1, -1)));
console.log("thrown", t(() => fs.chown("own", -2, 0, () => console.log("called back"))));
// In turn: the callback form, then the promise form, then the handle (their completions would race).
fs.chown("own", -1, -1, (e) => {
  console.log("cb", e && e.code);
  fs.promises.chown("own", 0, 0).catch((e) => console.log("promise", e.code))
    .then(() => fs.promises.open("own", "r"))
    .then(async (h) => { console.log("handle", await h.chown(-1, -1).then(() => "ok", (e) => e.code)); await h.close() });
});`;

const CASES = [
  [`node -e 'let n = 0; process.on("beforeExit", (c) => { console.log("beforeExit", c, n); if (n++ < 2) setTimeout(() => console.log("timer"), 1) }); process.exitCode = 3'; echo "status=$?"`,
    'beforeExit comes each time the loop runs empty, with exitCode, while a listener schedules work'],
  [`node -e 'let n = 0; process.on("beforeExit", () => { console.log("beforeExit", ++n); if (n < 3) setImmediate(() => console.log("immediate")) })'; echo "status=$?"`,
    'an immediate is work too'],
  [`node -e 'let n = 0; process.on("beforeExit", () => { console.log("beforeExit", ++n); if (n < 3) Promise.resolve().then(() => console.log("micro")) })'; echo "status=$?"`,
    'a microtask is not'],
  [`node -e 'let n = 0; process.on("beforeExit", (c) => { n++; console.log("beforeExit", c, n); process.stdout.write("wrote\\n") }); process.on("exit", (c) => console.log("exit", c, n))' | cat; echo "status=\${PIPESTATUS[*]}"`,
    'nor is a write it makes'],
  [`node -e 'process.on("beforeExit", (c) => { console.log("beforeExit", c); process.exitCode = 9 }); process.on("exit", (c) => console.log("exit", c))'; echo "status=$?"`,
    'the exitCode it sets is the status'],
  [`node -e 'process.on("beforeExit", () => console.log("beforeExit")); process.exit(4)'; echo "status=$?"`, 'process.exit() skips it'],
  [`node -e 'process.on("beforeExit", () => console.log("beforeExit")); throw new Error("x")' 2>/dev/null; echo "status=$?"`, 'a fatal error skips it'],
  [`node -e 'process.on("beforeExit", () => console.log("beforeExit")); process.on("uncaughtException", () => console.log("caught")); setTimeout(() => { throw new Error("x") }, 1)'; echo "status=$?"`,
    'an error a listener took does not'],
  [`node -e 'let n = 0; process.stdout.on("error", (e) => { console.error("heard", e.code) }); process.on("beforeExit", () => { n++; console.error("beforeExit", n); process.stdout.write("x\\n") })' > /dev/full; echo "status=$?"`,
    'a write it makes to /dev/full is heard once, and the loop is not run again for it'],
  [`node -e 'let n = 0; process.stdout.on("error", (e) => { console.error("heard", e.code, n) }); process.on("beforeExit", () => { n++; if (n === 1) setTimeout(() => {}, 1); else if (n === 2) process.stdout.write("x\\n") }); process.on("exit", () => console.error("rounds", n))' > /dev/full; echo "status=$?"`,
    'a round that writes nothing, then one at the same write number whose write fails: heard in its round, no third'],
  [`echo 'process.on("beforeExit", () => console.log("beforeExit")); await new Promise(() => {})' > tla.mjs; node tla.mjs; echo "status=$?"; rm -f tla.mjs`,
    'a top-level await unsettled hears it before its warning and 13'],
  [`rm -f own own.lnk && touch own && ln -s own own.lnk && node -e '${CHOWN}'; echo "status=$?"; rm -f own own.lnk`,
    'chown, lchown and fchown, as Node checks and makes them'],
];

/** What stderr says, without the frames of a stack, Node's report or the source line under a warning. */
const said = (stderr) => stderr.split('\n')
  .filter((line) => line !== '' && !/^\s+at /.test(line) && !/^(node:|\s+throw er|\s*\^|Emitted 'error' event|Node\.js v|process\.on\()/.test(line))
  // Where the warning places the await (Node: its file:// URL and line) is not what is checked here.
  .map((line) => line.replace(/^(Warning: Detected unsettled top-level await) at \S+$/, '$1'))
  .join('\n');

const { sql, transactions } = await hostSqlite();
const ws = await NimbusWorkspace.create({ sql, transactions, generation: 1 });
const failed = [];
try {
  for (const [line, what] of CASES) {
    const host = spawnSync('bash', ['--norc', '--noprofile', '-c', line], { encoding: 'utf8', timeout: 30_000, cwd: '/tmp' });
    const ours = await ws.exec(line, { cwd: '/home/user', timeout: 30_000 });
    const expected = { stdout: host.stdout, said: said(host.stderr) };
    const actual = { stdout: ours.stdout, said: said(ours.stderr) };
    try {
      assert.deepEqual(actual, expected);
      console.log(`  ✓ ${what}`);
    } catch {
      failed.push(`${what}\n  line: ${line.slice(0, 160)}\n  node: ${JSON.stringify(expected)}\n  ours: ${JSON.stringify(actual)}`);
      console.log(`  ✗ ${what}`);
    }
  }
} finally {
  await ws.close();
}
assert.deepEqual(failed, [], `as the host's node:\n${failed.join('\n')}`);
console.log('lifo-node-before-exit-and-chown: ok');
