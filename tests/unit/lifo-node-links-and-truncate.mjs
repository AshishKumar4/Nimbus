#!/usr/bin/env bun
// The shell's node makes symbolic links and truncates files in the
// session's filesystem, as Node does, checked against the host's Node 22
// running the same line under bash:
//
//   - symlink makes a link whose text is the target as given (a relative one
//     read from the link's directory, a dangling one kept); readlink answers
//     that text (bytes with encoding 'buffer'), EINVAL for a file that is no
//     link and ENOENT for nothing; a link over an existing name is EEXIST;
//     the sync, callback and promise forms alike;
//   - truncate cuts a file, or extends it with zero bytes, to its length (a
//     negative one is 0, none is 0), its errors open's (ENOENT, EISDIR), in
//     the sync, callback and promise forms, and on a descriptor as ftruncate
//     (Node's deprecation warning for that, DEP0081, is not compared: this
//     node prints none); a directory opened for writing is EISDIR, as
//     open(2) answers Node.
//
// Red before (audit X-M1, X-M2): symlink did nothing, readlink answered the
// path it was given, and truncate never extended a file and cut by
// slice's rules.

import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { NimbusWorkspace } from '../../packages/core/src/workspace/nimbus-workspace.ts';
import { hostSqlite } from './lib/host-sqlite.mjs';

const PRELUDE = String.raw`const fs = require("fs");
const t = (f) => { try { const v = f(); return v === undefined ? "ok" : v } catch (e) { return e.code + " " + e.syscall } };
const bytes = (p) => JSON.stringify([...fs.readFileSync(p)]);`;

const LINKS = String.raw`${PRELUDE}
fs.mkdirSync("d"); fs.writeFileSync("d/f", "in d");
console.log("make", t(() => fs.symlinkSync("f", "d/rel")), t(() => fs.symlinkSync("d/f", "top")));
console.log("text", t(() => fs.readlinkSync("d/rel")), t(() => fs.readlinkSync("top")));
console.log("through", fs.readFileSync("d/rel", "utf8"), fs.readFileSync("top", "utf8"));
console.log("kind", fs.lstatSync("d/rel").isSymbolicLink(), fs.statSync("d/rel").isFile());
console.log("buffer", Buffer.isBuffer(fs.readlinkSync("top", { encoding: "buffer" })), String(fs.readlinkSync("top", "buffer")));
console.log("dangling", t(() => fs.symlinkSync("nowhere", "dead")), t(() => fs.readlinkSync("dead")), fs.existsSync("dead"), fs.lstatSync("dead").isSymbolicLink());
console.log("no link", t(() => fs.readlinkSync("d/f")), t(() => fs.readlinkSync("d")));
console.log("nothing", t(() => fs.readlinkSync("missing")));
console.log("over", t(() => fs.symlinkSync("x", "d/f")), t(() => fs.symlinkSync("x", "top")));
fs.symlink("d/f", "cb", (e) => { console.log("cb symlink", e && e.code); fs.readlink("cb", (e, s) => console.log("cb readlink", e && e.code, s));
  fs.readlink("d/f", (e) => console.log("cb einval", e.code, e.syscall));
  fs.promises.symlink("d/f", "pr").then(() => fs.promises.readlink("pr")).then((s) => console.log("promise", s));
  fs.promises.readlink("missing").catch((e) => console.log("promise enoent", e.code)); });`;

const TRUNCATE = String.raw`${PRELUDE}
fs.writeFileSync("x", "abc");
console.log("grow", t(() => fs.truncateSync("x", 5)), bytes("x"));
console.log("cut", t(() => fs.truncateSync("x", 1)), bytes("x"));
fs.writeFileSync("x", "abc");
console.log("negative", t(() => fs.truncateSync("x", -3)), bytes("x"));
fs.writeFileSync("x", "abc");
console.log("none", t(() => fs.truncateSync("x")), bytes("x"));
console.log("missing", t(() => fs.truncateSync("missing", 1)));
fs.mkdirSync("dir");
console.log("dir", t(() => fs.truncateSync("dir", 1)));
fs.writeFileSync("y", "hello");
const fd = fs.openSync("y", "r+"); fs.truncateSync(fd, 2); fs.closeSync(fd);
console.log("fd", bytes("y"));
fs.truncate("y", 4, (e) => { console.log("cb", e && e.code, bytes("y"));
  fs.truncate("y", (e) => { console.log("cb none", e && e.code, bytes("y"));
    fs.promises.truncate("y", 3).then(() => { console.log("promise", bytes("y"));
      return fs.promises.truncate("missing").catch((e) => console.log("promise missing", e.code, e.syscall)); }); }); });
console.log("open dir", t(() => fs.openSync("dir", "r+")), t(() => fs.openSync("dir", "w")), typeof fs.openSync("dir", "r"));`;

const CASES = [
  [`node -e '${LINKS}'; echo "status=$?"`, 'symlink and readlink, as Node makes and reads them'],
  [`node -e '${TRUNCATE}'; echo "status=$?"`, 'truncate, as Node makes it'],
];

const { sql, transactions } = await hostSqlite();
const ws = await NimbusWorkspace.create({ sql, transactions, generation: 1 });
const failed = [];
try {
  for (const [index, [line, what]] of CASES.entries()) {
    const dir = mkdtempSync(join(tmpdir(), 'lifo-node-links-'));
    let host;
    try {
      host = spawnSync('bash', ['--norc', '--noprofile', '-c', line], { encoding: 'utf8', timeout: 30_000, cwd: dir });
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
    const at = `/home/user/case${index}`;
    await ws.exec(`mkdir -p ${at}`, { cwd: '/home/user' });
    const ours = await ws.exec(line, { cwd: at, timeout: 30_000 });
    const expected = { stdout: host.stdout, stderr: host.stderr.replace(/^\(node:\d+\) \[DEP0081\].*\n\(Use `node --trace-deprecation \.\.\.` to show where the warning was created\)\n/m, '') };
    const actual = { stdout: ours.stdout, stderr: ours.stderr };
    if (JSON.stringify(expected) !== JSON.stringify(actual)) failed.push(`${what}\n  host: ${JSON.stringify(expected)}\n  ours: ${JSON.stringify(actual)}`);
  }
} finally {
  await ws.close?.();
}
assert.deepEqual(failed, [], failed.join('\n'));
console.log(`lifo-node-links-and-truncate: ${CASES.length} of ${CASES.length} as Node makes them`);
