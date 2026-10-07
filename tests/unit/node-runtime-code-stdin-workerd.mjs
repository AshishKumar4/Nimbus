// @serial
// @tier slow — drives a local workerd; 53 s alone (20 s CPU), up to 195 s under a 1-CPU quota
// A Node guest's stdin under workerd: a pipe or a redirect, read
// synchronously (fs.readFileSync(0) and every other form of fd 0) or
// streamed (process.stdin), compared with host node where it can be.
//
// What has to hold:
//   - process.stdin's data listeners list and remove as in node.
//   - A pipe or a redirect is read whole by readFileSync(0), 'data'/'end' and
//     async iteration, and by node -e; a synchronous read takes stdin, and
//     process.stdin then ends.
//   - A pipe streams: a program that ignores an endless pipe exits at once,
//     and a synchronous read waits for a slow writer however slow
//     (runtime/stop-replay.ts), without starving another launch's.
//   - A read ahead for a synchronous read is bounded, in memory as in time:
//     what the session hands a run that never reads, and holds of the pipe,
//     stays within it; a server with a sync read listens though its pipe
//     never ends; a sync read past the bound fails naming it and
//     process.stdin.
//   - Every form a program reads fd 0 by gets the bytes as written: a 2 MiB
//     lockfile through `< file` and through a pipe, a redirect at its
//     offset, binary bytes, a partial read then 'data'.
//
// One of five files, each its own local workerd and session, so each fits
// the suite's per-file budget on a loaded machine (together they took
// 240-260 s alone, against run-all's 300 s): runtime code
// (node-runtime-code-workerd); stdin (node-runtime-code-stdin-workerd);
// a 48 MiB `< file` handed and refused (node-runtime-code-stdin-file-workerd)
// and streamed (node-runtime-code-stdin-stream-workerd); resident processes
// (node-runtime-code-resident-workerd).
//
// Runs the worker built in the tree (lib/workerd-probe.mjs): rebuild the
// generated artifacts before testing a runner change.

import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';

import { localTerminal, startLocalProbe } from './lib/workerd-probe.mjs';

const W = '/home/user/w';
const FILES = {
  // process.stdin wraps data listeners; removal must still find them.
  'stdin.js': [
    'const f = () => {}, g = () => {};',
    'process.stdin.on("data", f); process.stdin.off("data", f); process.stdin.on("data", g);',
    'const afterOn = process.stdin.listenerCount("data");',
    'const listed = process.stdin.listeners("data")[0] === g;',
    'process.stdin.removeListener("data", g);',
    'const onceFn = () => {}; process.stdin.once("data", onceFn); process.stdin.off("data", onceFn);',
    'const afterOff = process.stdin.listenerCount("data");',
    // once(): listed as the program's function; it fires once and removes itself.
    'let calls = 0; const h = () => { calls++; }; process.stdin.once("data", h);',
    'const onceListed = process.stdin.listeners("data")[0] === h;',
    'process.stdin.emit("data", Buffer.from("x")); process.stdin.emit("data", Buffer.from("y"));',
    'console.log("STDIN " + [afterOn, listed, afterOff, onceListed, calls, process.stdin.listenerCount("data")].join(" "));',
    'process.stdin.pause(); process.exit(0);',
  ].join('\n'),
  // A pipe or redirect is the program's stdin: readFileSync(0), 'data'/'end'
  // and async iteration each read it whole.
  'stdin-sync.js': 'process.stdout.write("SYNC " + JSON.stringify(require("fs").readFileSync(0, "utf8")) + "\\n");',
  'stdin-events.js': 'let s = ""; process.stdin.setEncoding("utf8"); process.stdin.on("data", (c) => { s += c; }).on("end", () => console.log("EVENTS " + JSON.stringify(s)));',
  'stdin-await.js': '(async () => { let s = ""; for await (const c of process.stdin) s += c; console.log("AWAIT " + JSON.stringify(s)); })();',
  'stdin-both.js': 'const first = require("fs").readFileSync("/dev/stdin", "utf8"); let s = ""; process.stdin.on("data", (c) => { s += c; }).on("end", () => console.log("BOTH " + JSON.stringify([first, s])));',
  // A synchronous stdin read that does not run, before a program that
  // ignores stdin, and before a server: none may hold the launch for a pipe
  // that never ends.
  'fp.js': 'if (process.argv[2]) require("fs").readFileSync(0); console.log("RAN");',
  'srv.js': 'if (process.argv[2]) require("fs").readFileSync(0); require("http").createServer((q, s) => s.end("SRV")).listen(8931, () => console.log("SRV LISTENING"));',
};

console.log('node-runtime-code-stdin-workerd: starting local workerd');
const probe = await startLocalProbe();
try {
  const terminal = await localTerminal(probe, { install: [] });
  try {
    const payload = Buffer.from(JSON.stringify(FILES)).toString('base64');
    const setup = await terminal.run(
      `mkdir -p ${W} && node -e "const f = JSON.parse(Buffer.from('${payload}', 'base64').toString()); for (const [n, t] of Object.entries(f)) require('fs').writeFileSync('${W}/' + n, t); console.log('SETUP')"`,
    );
    assert.match(setup.stdout, /SETUP/, setup.stdout);

    const stdin = await terminal.run(`cd ${W} && node stdin.js < /dev/null`);
    const hostStdin = spawnSync('node', ['-e', FILES['stdin.js']], { encoding: 'utf8', input: '' });
    assert.equal(/^STDIN .*$/m.exec(stdin.stdout)?.[0], /^STDIN .*$/m.exec(hostStdin.stdout)?.[0], 'stdin data listeners list and remove as in node');

    await terminal.run(`cd ${W} && printf 'abc\\ndef\\n' > stdin.txt`);
    for (const [name, label] of [['stdin-sync.js', 'SYNC'], ['stdin-events.js', 'EVENTS'], ['stdin-await.js', 'AWAIT']]) {
      const piped = await terminal.run(`cd ${W} && echo hi | node ${name}`);
      assert.match(piped.stdout, new RegExp(`^${label} "hi\\\\n"$`, 'm'), `${name} reads a pipe`);
      const redirected = await terminal.run(`cd ${W} && node ${name} < stdin.txt`);
      assert.match(redirected.stdout, new RegExp(`^${label} "abc\\\\ndef\\\\n"$`, 'm'), `${name} reads a redirect`);
    }
    const evalPiped = await terminal.run(`echo hi | node -e 'console.log("EVAL " + JSON.stringify(require("fs").readFileSync(0, "utf8")))'`);
    assert.match(evalPiped.stdout, /^EVAL "hi\\n"$/m, 'node -e reads a pipe');
    const both = await terminal.run(`cd ${W} && echo hi | node stdin-both.js`);
    assert.match(both.stdout, /^BOTH \["hi\\n",""\]$/m, 'a synchronous read takes stdin; process.stdin then ends');

    // A pipe streams: the program never waits for its end. One that ignores
    // an endless pipe exits at once, and releasing the pipe ends its writer.
    // (This shell's tail -f does not follow; yes never ends.)
    const endless = await terminal.run(`yes | node -e 'console.log("IGNORED 1")'`, 30_000);
    assert.equal(endless.status, 0, endless.stdout);
    assert.match(endless.stdout, /^IGNORED 1$/m, endless.stdout);
    // A program that reads stdin synchronously gets all of it, however slow
    // its writer: the read waits for it (runtime/stop-replay.ts).
    const slow = await terminal.run(`(sleep 1; echo '{"a":1}') | node -e 'console.log("SLOW " + JSON.parse(require("fs").readFileSync(0)).a)'`, 30_000);
    assert.equal(slow.status, 0, slow.stdout);
    assert.match(slow.stdout, /^SLOW 1$/m, slow.stdout);
    // The session's budget for stdin held across stops counts bytes held, not
    // bytes a read might wait for: one waiting on a slow writer does not
    // starve another.
    const slowA = `(sleep 6; echo '{"a":1}') | node -e 'console.log("SLOWA " + JSON.parse(require("fs").readFileSync(0)).a)'`;
    const slowB = `(sleep 1; echo '{"b":2}') | node -e 'let r; try { r = JSON.parse(require("fs").readFileSync(0)).b; } catch (e) { r = "ERR " + e.code; } console.log("SLOWB " + r)'`;
    const concurrent = await terminal.run(`{ ${slowA} & } ; sleep 2; ${slowB}; wait`, 90_000);
    assert.match(concurrent.stdout, /^SLOWB 2$/m, `a concurrent launch's slow read ahead does not starve this one: ${concurrent.stdout.slice(-600)}`);
    assert.match(concurrent.stdout, /^SLOWA 1$/m, concurrent.stdout.slice(-600));
    // A read ahead for a synchronous read is bounded, in memory as in time.
    // What a run can hold of its stdin is what the session hands it: the
    // session's supervisorAnsweredBytes counts every answer where it leaves
    // (core workspace/supervisor-op.ts), file reads and pipe read ahead alike.
    const READ_AHEAD = 16 * 1048576;
    const answered = async (work) => {
      const before = (await terminal.memory()).counters.supervisorAnsweredBytes;
      const result = await work();
      return { result, bytes: (await terminal.memory()).counters.supervisorAnsweredBytes - before };
    };
    const unrun = await answered(() => terminal.run(`cd ${W} && yes | node fp.js`, 30_000));
    assert.equal(unrun.result.status, 0, unrun.result.stdout);
    assert.match(unrun.result.stdout, /^RAN$/m, 'a sync read that never runs does not hold the launch for an endless pipe');
    console.log(`yes | node fp.js: the run was handed ${(unrun.bytes / 1048576).toFixed(1)} MiB`);
    assert.ok(unrun.bytes <= READ_AHEAD + 1048576, `the read ahead is bounded: the run was handed ${unrun.bytes} bytes`);
    // And what the session held of the pipe for it: never past the bound, and none once it ended.
    const readAhead = (await terminal.memory()).stdinReadAhead;
    assert.ok(readAhead.peakBytes <= READ_AHEAD + 1, `the session's read ahead stays within its bound: ${JSON.stringify(readAhead)}`);
    assert.equal(readAhead.heldBytes, 0, `the session holds none of the pipe once the run ended: ${JSON.stringify(readAhead)}`);
    const server = await terminal.run(`cd ${W} && yes | node srv.js`, 30_000);
    assert.equal(server.status, 0, server.stdout);
    const served = await terminal.run('curl -s -m 5 http://localhost:8931/', 30_000);
    assert.equal(served.stdout.trim(), 'SRV', 'a server with a sync read listens though its pipe never ends');

    // Every form a program reads fd 0 by, the bytes exactly as written.
    for (const [form, read] of [
      ['readSync', '(() => { const b = Buffer.alloc(2); const p = []; for (;;) { const n = require("fs").readSync(0, b, 0, 2); if (!n) break; p.push(b.subarray(0, n).toString()); } return p.join("|"); })()'],
      ['fd', 'require("fs").readFileSync(process.stdin.fd, "utf8")'],
      ['/proc/self/fd/0', 'require("fs").readFileSync("/proc/self/fd/0", "utf8")'],
      ['/dev/fd/0', 'require("fs").readFileSync("/dev/fd/0", "utf8")'],
    ]) {
      const run = await terminal.run(`echo hi | node -e 'console.log("FORM " + JSON.stringify(${read}))'`, 30_000);
      assert.match(run.stdout, form === 'readSync' ? /^FORM "hi\|\\n"$/m : /^FORM "hi\\n"$/m, `${form}: ${run.stdout}`);
    }
    // A 2 MiB lockfile read synchronously, through `< file` (fd 0 is the
    // file) and through a pipe (waited for, within the bound).
    await terminal.run(`cd ${W} && node -e 'const o = {}; for (let i = 0; i < 20000; i++) o["pkg" + i] = { version: "1.0." + i, resolved: "https://registry.npmjs.org/pkg" + i + "/-/pkg-1.0." + i + ".tgz", integrity: "sha512-abcdefghij" }; require("fs").writeFileSync("lock.json", JSON.stringify(o)); console.log("LOCKBYTES " + require("fs").statSync("lock.json").size)'`);
    const lockParse = `node -e 'console.log("LOCK " + Object.keys(JSON.parse(require("fs").readFileSync(0))).length)'`;
    for (const [how, line] of [['< file', `${lockParse} < lock.json`], ['cat |', `cat lock.json | ${lockParse}`]]) {
      const run = await terminal.run(`cd ${W} && ${line}`, 60_000);
      assert.equal(run.status, 0, `${how}: ${run.stdout}`);
      assert.match(run.stdout, /^LOCK 20000$/m, `${how} a 2 MiB lockfile: ${run.stdout}`);
    }
    // `< file` streams from the file and reads it at a position; with a
    // redirect's offset shared with a shell read first.
    const fileStream = await terminal.run(`cd ${W} && node -e 'let n = 0; process.stdin.on("data", (d) => { n += d.length; }).on("end", () => console.log("FILESTREAM " + n))' < lock.json`, 60_000);
    assert.equal(/^FILESTREAM (\d+)$/m.exec(fileStream.stdout)?.[1], /^LOCKBYTES (\d+)$/m.exec((await terminal.run(`cd ${W} && node -e 'console.log("LOCKBYTES " + require("fs").statSync("lock.json").size)'`)).stdout)?.[1], fileStream.stdout);
    const filePos = await terminal.run(`cd ${W} && printf 'abcdef' > six.txt && node -e 'const b = Buffer.alloc(2); const fs = require("fs"); fs.readSync(0, b, 0, 2); let s = ""; process.stdin.on("data", (d) => { s += d; }).on("end", () => console.log("FILEPOS " + b + "|" + s))' < six.txt`, 30_000);
    assert.match(filePos.stdout, /^FILEPOS ab\|cdef$/m, filePos.stdout);
    // A synchronous read of a pipe that passes the bound without ending
    // fails naming the bound and process.stdin, which streams it.
    const overBound = await terminal.run(`yes | node -e 'require("fs").readFileSync(0)'`, 90_000);
    assert.notEqual(overBound.status, 0, overBound.stdout);
    assert.match(overBound.stdout, /passed \d+ MiB[\s\S]*process\.stdin/, `the refusal names the bound and names process.stdin: ${overBound.stdout.slice(-600)}`);
    // A partial synchronous read leaves the rest of fd 0 to process.stdin.
    const mixed = await terminal.run(`echo hi | node -e 'const b = Buffer.alloc(2); const n = require("fs").readSync(0, b, 0, 2); let s = ""; process.stdin.on("data", (d) => { s += d; }).on("end", () => console.log("MIX " + JSON.stringify([b.subarray(0, n).toString(), s])))'`, 30_000);
    assert.match(mixed.stdout, /^MIX \["hi","\\n"\]$/m, `readSync then 'data': ${mixed.stdout}`);
    await terminal.run(`cd ${W} && node -e 'require("fs").writeFileSync("bin.dat", Buffer.from([255, 254, 0, 128]))'`);
    const binSync = await terminal.run(`cd ${W} && node -e 'console.log("BIN " + JSON.stringify([...require("fs").readFileSync(0)]))' < bin.dat`);
    assert.match(binSync.stdout, /^BIN \[255,254,0,128\]$/m, `readFileSync(0) of a binary redirect: ${binSync.stdout}`);
    const binData = await terminal.run(`cd ${W} && node -e 'const c = []; process.stdin.on("data", (d) => c.push(...d)).on("end", () => console.log("BINDATA " + JSON.stringify(c)))' < bin.dat`);
    assert.match(binData.stdout, /^BINDATA \[255,254,0,128\]$/m, `'data' of a binary redirect: ${binData.stdout}`);

    const lines = await terminal.run(`yes | head -3 | node -e '(async () => { const got = []; for await (const c of process.stdin) got.push(String(c)); console.log("LINES " + JSON.stringify(got.join(""))); })()'`, 30_000);
    assert.match(lines.stdout, /^LINES "y\\ny\\ny\\n"$/m, lines.stdout);
  } finally {
    await terminal.close().catch(() => {});
  }
} finally {
  await probe.stop();
}
console.log('node-runtime-code-stdin-workerd: a pipe or a redirect is a Node guest\'s stdin, read as node reads it, within its bound, under workerd');
