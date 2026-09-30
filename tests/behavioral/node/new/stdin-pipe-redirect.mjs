#!/usr/bin/env bun
// node/new/stdin-pipe-redirect — a pipe or redirect is a Node program's stdin.
//
// WHAT IT PROVES
//   `echo hi | node x.js` and `node x.js < in.txt`, typed in the session
//   terminal, deliver the bytes to each way a program reads stdin:
//   fs.readFileSync(0), process.stdin 'data'/'end', and
//   `for await (const chunk of process.stdin)` (Buffer chunks, so `s += c`
//   reads text), and to `node -e`. The shell's pipe used to be dropped, so
//   every read saw empty stdin and readFileSync(0) threw ENOENT for a file
//   named "0". It streams: a program that ignores a pipe that never ends
//   (`yes`, `tail -f`) exits at once instead of waiting for its end, while
//   a program whose code reads stdin synchronously gets all of it first,
//   however slow its writer.

import { BASE, makeAsserter, mintSession, deleteSession, Terminal, writeFileViaShell, fetchPort, sleep } from '../../_driver.mjs';

if (!process.env.BASE) { console.error('FATAL: BASE env required'); process.exit(2); }

const a = makeAsserter('node/new/stdin-pipe-redirect');
console.log(`node/new/stdin-pipe-redirect — BASE=${BASE}`);

const DIR = '/home/user/stdin-probe';
const SCRIPTS = {
  'sync.js': ['SYNC', 'process.stdout.write("SYNC " + JSON.stringify(require("fs").readFileSync(0, "utf8")) + "\\n");'],
  'events.js': ['EVENTS', 'let s = ""; process.stdin.setEncoding("utf8"); process.stdin.on("data", (c) => { s += c; }).on("end", () => console.log("EVENTS " + JSON.stringify(s)));'],
  'await.js': ['AWAIT', '(async () => { let s = ""; for await (const c of process.stdin) s += c; console.log("AWAIT " + JSON.stringify(s)); })();'],
};

const sid = await mintSession();
console.log(`SID: ${sid}`);
const t = new Terminal(sid);
const line = (out, label) => (out.split(/\r?\n/).find((l) => l.startsWith(label + ' ')) ?? '').trim();
try {
  await t.connect();
  await t.waitForPrompt(60_000);
  await t.run(`mkdir -p ${DIR} && cd ${DIR} && printf 'abc\\ndef\\n' > in.txt`, 60_000);
  for (const [name, [, source]] of Object.entries(SCRIPTS)) {
    await writeFileViaShell((cmd) => t.run(cmd, 60_000), `${DIR}/${name}`, source);
  }
  for (const [name, [label]] of Object.entries(SCRIPTS)) {
    const piped = (await t.run(`cd ${DIR} && echo hi | node ${name}`, 90_000)).output;
    a.check(`${name} reads a pipe`, line(piped, label) === `${label} "hi\\n"`, piped.slice(-400));
    const redirected = (await t.run(`cd ${DIR} && node ${name} < in.txt`, 90_000)).output;
    a.check(`${name} reads a redirect`, line(redirected, label) === `${label} "abc\\ndef\\n"`, redirected.slice(-400));
  }
  const evalOut = (await t.run(`echo hi | node -e 'console.log("EVAL " + JSON.stringify(require("fs").readFileSync(0, "utf8")))'`, 90_000)).output;
  a.check('node -e reads a pipe', line(evalOut, 'EVAL') === 'EVAL "hi\\n"', evalOut.slice(-400));
  // A pipe streams: the program never waits for its end. One that ignores a
  // pipe that never ends exits at once, and its writer then ends too.
  for (const [label, producer] of [['yes', 'yes'], ['tail -f', `tail -f ${DIR}/in.txt`]]) {
    let out;
    try {
      out = (await t.run(`${producer} | node -e 'console.log("IGNORED 1")'`, 60_000)).output;
    } catch (e) {
      out = `TIMEOUT ${String(e.message).slice(-300)}`;
      t.send('\x03');
    }
    a.check(`${label} into a program that ignores stdin exits`, line(out, 'IGNORED') === 'IGNORED 1', out.slice(-400));
  }
  // A program that reads stdin synchronously gets all of it before it starts,
  // however slow its writer (stdin-read.ts).
  const slow = (await t.run(`(sleep 1; echo '{"a":1}') | node -e 'console.log("SLOW " + JSON.parse(require("fs").readFileSync(0)).a)'`, 90_000)).output;
  a.check('a slow writer into a synchronous readFileSync(0)', line(slow, 'SLOW') === 'SLOW 1', slow.slice(-400));
  // A synchronous read that never runs, and a server: neither is held for an
  // endless pipe (the read ahead is bounded; a session isolate has 128 MB).
  await writeFileViaShell((cmd) => t.run(cmd, 60_000), `${DIR}/fp.js`, 'if (process.argv[2]) require("fs").readFileSync(0); console.log("RAN");');
  const unrun = (await t.run(`cd ${DIR} && yes | node fp.js`, 90_000)).output;
  a.check('an unrun sync read does not hold `yes | node fp.js`', /^RAN\r?$/m.test(unrun), unrun.slice(-400));
  await writeFileViaShell((cmd) => t.run(cmd, 60_000), `${DIR}/srv.js`, 'if (process.argv[2]) require("fs").readFileSync(0); require("http").createServer((q, s) => s.end("SRV")).listen(8931);');
  await t.run(`cd ${DIR} && yes | node srv.js`, 90_000);
  let served = { status: 0, body: '' };
  for (let i = 0; i < 30 && served.body !== 'SRV'; i++) {
    served = await fetchPort(sid, 8931, '').catch((e) => ({ status: 0, body: String(e) }));
    if (served.body !== 'SRV') await sleep(1000);
  }
  a.check('a server with a sync read listens though its pipe never ends', served.body === 'SRV', JSON.stringify(served).slice(0, 300));
  // Every form of reading fd 0, and binary bytes exactly as written.
  for (const [form, read, want] of [
    ['readSync', '(() => { const b = Buffer.alloc(2); const p = []; for (;;) { const n = require("fs").readSync(0, b, 0, 2); if (!n) break; p.push(b.subarray(0, n).toString()); } return p.join("|"); })()', 'FORM "hi|\\n"'],
    ['process.stdin.fd', 'require("fs").readFileSync(process.stdin.fd, "utf8")', 'FORM "hi\\n"'],
    ['/proc/self/fd/0', 'require("fs").readFileSync("/proc/self/fd/0", "utf8")', 'FORM "hi\\n"'],
    ['/dev/fd/0', 'require("fs").readFileSync("/dev/fd/0", "utf8")', 'FORM "hi\\n"'],
  ]) {
    const out = (await t.run(`echo hi | node -e 'console.log("FORM " + JSON.stringify(${read}))'`, 90_000)).output;
    a.check(`${form} reads a pipe`, line(out, 'FORM') === want, out.slice(-400));
  }
  await t.run(`cd ${DIR} && node -e 'require("fs").writeFileSync("bin.dat", Buffer.from([255, 254, 0, 128]))'`, 60_000);
  const binSync = (await t.run(`cd ${DIR} && node -e 'console.log("BIN " + JSON.stringify([...require("fs").readFileSync(0)]))' < bin.dat`, 90_000)).output;
  a.check('readFileSync(0) of a binary redirect is byte-exact', line(binSync, 'BIN') === 'BIN [255,254,0,128]', binSync.slice(-400));
  const binData = (await t.run(`cd ${DIR} && node -e 'const c = []; process.stdin.on("data", (d) => c.push(...d)).on("end", () => console.log("BINDATA " + JSON.stringify(c)))' < bin.dat`, 90_000)).output;
  a.check("'data' of a binary redirect is byte-exact", line(binData, 'BINDATA') === 'BINDATA [255,254,0,128]', binData.slice(-400));
  const lines = (await t.run(`yes | head -3 | node -e '(async () => { const got = []; for await (const c of process.stdin) got.push(String(c)); console.log("LINES " + JSON.stringify(got.join(""))); })()'`, 90_000)).output;
  a.check('yes | head -3 streams three lines to for-await', line(lines, 'LINES') === 'LINES "y\\ny\\ny\\n"', lines.slice(-400));
} finally {
  await t.close().catch(() => {});
  await deleteSession(sid, 'node-new-stdin-pipe-redirect');
}

const s = a.summary();
process.exit(s.fail === 0 ? 0 : 1);
