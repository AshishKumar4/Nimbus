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
//   named "0".

import { BASE, makeAsserter, mintSession, deleteSession, Terminal, writeFileViaShell } from '../../_driver.mjs';

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
} finally {
  await t.close().catch(() => {});
  await deleteSession(sid, 'node-new-stdin-pipe-redirect');
}

const s = a.summary();
process.exit(s.fail === 0 ? 0 : 1);
