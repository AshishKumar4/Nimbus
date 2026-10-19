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
//     open(2) answers Node; the promise form takes a path only;
//   - a path is a string, a Buffer's text or a file: URL's decoded path
//     (another scheme is refused); readlink answers in the encoding asked
//     (an unknown one refused); a callback that is not a function is refused
//     before anything is done; a lookup that fails on the way to a link
//     (ENOTDIR, ELOOP) is readlink's failure.
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

// Each asynchronous call waits for the one before: Node does not order
// independent ones.
const PRELUDE = String.raw`const fs = require("fs");
const t = (f) => { try { const v = f(); return v === undefined ? "ok" : v } catch (e) { return e.code + " " + e.syscall } };
const m = (f) => { try { f(); return "ok" } catch (e) { return e.code + " " + e.message } };
const run = (f) => new Promise((r) => f((e, s) => r((e ? e.code + " " + e.syscall : "ok") + " " + s)));
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
console.log("encoding", t(() => fs.readlinkSync("top", "hex")), t(() => fs.readlinkSync("top", { encoding: "base64" })), m(() => fs.readlinkSync("top", "bogus")));
console.log("buffer path", t(() => fs.symlinkSync(Buffer.from("d/f"), Buffer.from("buf"))), t(() => fs.readlinkSync(Buffer.from("buf"))));
console.log("byte order mark", t(() => fs.symlinkSync(Buffer.from("\ufeffd/f"), Buffer.from("\ufeffbom"))), JSON.stringify(fs.readlinkSync("\ufeffbom")), fs.readdirSync(".").includes("\ufeffbom"));
console.log("empty encoding", t(() => fs.readlinkSync("top", "")), t(() => fs.readlinkSync("top", { encoding: "" })), t(() => fs.readlinkSync("top", { encoding: null })));
const here = "file://" + process.cwd();
console.log("file url", t(() => fs.symlinkSync(new URL("file:///tmp/a%20b"), new URL(here + "/u%20l"))), t(() => fs.readlinkSync("u l")), t(() => fs.readlinkSync(new URL(here + "/u%20l"))));
console.log("other url", m(() => fs.symlinkSync("d/f", new URL("http://x/y"))), m(() => fs.readlinkSync(new URL("http://x/top"))));
console.log("below file", t(() => fs.readlinkSync("d/f/child")));
console.log("loop", t(() => fs.symlinkSync("loop", "loop")), t(() => fs.readlinkSync("loop/x")));
console.log("no callback", m(() => fs.symlink("d/f", "nocb")), fs.existsSync("nocb"), m(() => fs.readlink("top")), m(() => fs.readlink("top", null)));
(async () => {
  console.log("cb symlink", await run((cb) => fs.symlink("d/f", "cb", cb)));
  console.log("cb readlink", await run((cb) => fs.readlink("cb", cb)), await run((cb) => fs.readlink("cb", "hex", cb)));
  console.log("cb einval", await run((cb) => fs.readlink("d/f", cb)));
  await fs.promises.symlink("d/f", "pr");
  console.log("promise", await fs.promises.readlink("pr"), await fs.promises.readlink("pr", "base64"));
  console.log("promise enoent", await fs.promises.readlink("missing").catch((e) => e.code + " " + e.syscall));
})();`;

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
console.log("open dir", t(() => fs.openSync("dir", "r+")), t(() => fs.openSync("dir", "w")), typeof fs.openSync("dir", "r"));
console.log("no callback", m(() => fs.truncate("y", 0, null)), m(() => fs.truncate("y", 0)), bytes("y"));
fs.writeFileSync("z", "abc");
const zd = fs.openSync("z", "r+");
console.log("length", m(() => fs.truncateSync("z", "1")), m(() => fs.truncateSync("z", 1.5)), m(() => fs.truncateSync("z", null)), m(() => fs.truncateSync("z", 2 ** 53)), t(() => fs.truncateSync("missing", "1")), bytes("z"));
console.log("length fd", m(() => fs.ftruncateSync(zd, "1")), m(() => fs.ftruncate(zd, 1.5, () => {})), m(() => fs.truncate("z", "1", () => {})), m(() => fs.truncate("z", null, () => {})), m(() => fs.ftruncate(zd, 0, null)), bytes("z"));
console.log("descriptor", m(() => fs.ftruncate(-1, 0, () => {})), m(() => fs.ftruncate("x", 0, () => {})), m(() => fs.ftruncate(1.5, 0, () => {})), m(() => fs.ftruncateSync(-1, 0)), m(() => fs.ftruncateSync("x", 0)), m(() => fs.ftruncateSync(-1, "x")), bytes("z"));
(async () => {
  console.log("cb", await run((cb) => fs.truncate("y", 4, cb)), bytes("y"));
  console.log("cb none", await run((cb) => fs.truncate("y", cb)), bytes("y"));
  await fs.promises.truncate("y", 3);
  console.log("promise", bytes("y"));
  console.log("promise missing", await fs.promises.truncate("missing").catch((e) => e.code + " " + e.syscall));
  const descriptor = fs.openSync("y", "r+");
  console.log("promise fd", await fs.promises.truncate(descriptor, 0).catch((e) => e.code), bytes("y"));
  fs.closeSync(descriptor);
  console.log("cb ftruncate", await run((cb) => fs.ftruncate(zd, 1, cb)), bytes("z"), await run((cb) => fs.ftruncate(zd, cb)), bytes("z"));
  console.log("promise length", await fs.promises.truncate("z", "1").catch((e) => e.code), await fs.promises.truncate("missing", "1").catch((e) => e.code + " " + e.syscall));
  const handle = await fs.promises.open("z", "r+");
  console.log("handle length", await handle.truncate("1").catch((e) => e.code), await handle.truncate(2).then(() => bytes("z")));
  await handle.close();
  const closed = (e) => e.code + " " + e.syscall + " " + e.message;
  console.log("closed handle", await handle.truncate(null).catch(closed), await handle.truncate(1.5).catch(closed), await handle.truncate(1).catch(closed), bytes("z"));
  console.log("closed handle", await handle.read(Buffer.alloc(1), 0, 1, 0).catch(closed), await handle.stat().catch(closed), await handle.close().then(() => "closed again"));
  fs.closeSync(zd);
})();`;

// A hard link is refused, in each form, as the hosted node refuses it
// (node-shims-fd-syscalls.mjs): the filesystem has no hard links. Not a
// differential: the host's Node makes the link.
const LINK = String.raw`const fs = require("fs");
const show = (e) => [e.code, e.errno, e.syscall, e.path, e.dest, e.message].join(" | ");
fs.writeFileSync("f", "x");
try { fs.linkSync("f", "g"); console.log("linked"); } catch (e) { console.log("sync", show(e)); }
console.log("exists", fs.existsSync("g"));
try { fs.link("f", "g"); } catch (e) { console.log("no callback", e.code); }
fs.link("f", "g", (e) => { console.log("cb", show(e));
  fs.promises.link("f", "g").catch((e) => console.log("promise", show(e), fs.existsSync("g"))); });`;
const REFUSED = "ENOSYS | -38 | link | f | g | ENOSYS: function not implemented, link \x27f\x27 -> \x27g\x27";
const LINK_REFUSED = `sync ${REFUSED}\nexists false\nno callback ERR_INVALID_ARG_TYPE\ncb ${REFUSED}\npromise ${REFUSED} false\nstatus=0\n`;

const CASES = [
  [`node -e '${LINKS}'; echo "status=$?"`, 'symlink and readlink, as Node makes and reads them'],
  [`node -e '${TRUNCATE}'; echo "status=$?"`, 'truncate, as Node makes it'],
];

const { sql, transactions } = await hostSqlite();
const ws = await NimbusWorkspace.create({ sql, transactions, generation: 1 });
const failed = [];
try {
  await ws.exec('mkdir -p /home/user/link', { cwd: '/home/user' });
  const link = await ws.exec(`node -e '${LINK}'; echo "status=$?"`, { cwd: '/home/user/link', timeout: 30_000 });
  if (link.stdout !== LINK_REFUSED || link.stderr !== '') failed.push(`link, refused\n  expected: ${JSON.stringify(LINK_REFUSED)}\n  ours: ${JSON.stringify({ stdout: link.stdout, stderr: link.stderr })}`);
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
console.log(`lifo-node-links-and-truncate: ${CASES.length} of ${CASES.length} as Node makes them, and link refused`);
