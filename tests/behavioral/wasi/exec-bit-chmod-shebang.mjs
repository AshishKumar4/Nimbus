#!/usr/bin/env bun
// wasi/exec-bit-chmod-shebang — WASI-PLAN Stage 1 live gates.
//
// The full native loop: write C → clang → ./binary runs (auto-exec,
// no manual chmod) → chmod -x denies → chmod +x restores. Plus generic
// shebang dispatch (#!/usr/bin/env node), the sh ENOEXEC fallback for
// exec-bit text, honest exec-format errors for non-wasm binaries, and
// permission denied for non-executable files.

import {
  mintSession, deleteSession, Terminal,
  makeAsserter, heredocCommand, stripAnsi,
} from '../_driver.mjs';

if (!process.env.BASE) { console.error('FATAL: BASE env required'); process.exit(2); }
const a = makeAsserter('wasi/exec-bit-chmod-shebang');

const sid = await mintSession();
console.log(`SID: ${sid}`);
const t = new Terminal(sid);
try {
  await t.connect();
  await t.waitForPrompt(30_000);
  await t.run('nimbus install clang', 300_000);

  // ── (a) THE HEADLINE: write C → compile → run, no manual chmod ──
  await t.run(heredocCommand('hello.c',
    '#include <stdio.h>\nint main(){printf("native!\\n");return 0;}\n'), 10_000);
  const compile = await t.run('clang hello.c -o hello ; echo CC_RC=$?', 240_000);
  a.check('clang compiles hello.c', /CC_RC=0\b/.test(stripAnsi(compile.output)),
    JSON.stringify(stripAnsi(compile.output).slice(-300)));

  const lsOut = stripAnsi((await t.run('ls -l hello', 30_000)).output);
  a.check('emitted binary is rwxr-xr-x (auto-exec, no manual chmod)',
    /-rwxr-xr-x/.test(lsOut), JSON.stringify(lsOut.slice(-200)));

  const runA = stripAnsi((await t.run('./hello ; echo RC=$?', 60_000)).output);
  a.check('(a) ./hello prints native!', /native!/.test(runA), JSON.stringify(runA.slice(-300)));
  a.check('(a) ./hello exits 0', /RC=0\b/.test(runA), JSON.stringify(runA.slice(-200)));

  // ── (b) chmod -x → permission denied; chmod +x → runs again ──
  const denied = stripAnsi((await t.run('chmod -x hello ; ./hello ; echo RC=$?', 60_000)).output);
  a.check('(b) chmod -x hello → Permission denied', /Permission denied/i.test(denied),
    JSON.stringify(denied.slice(-300)));
  a.check('(b) denied exit code 126', /RC=126\b/.test(denied), JSON.stringify(denied.slice(-200)));
  a.check('(b) denied run does NOT print native!', !/native!/.test(denied),
    JSON.stringify(denied.slice(-300)));

  const restored = stripAnsi((await t.run('chmod +x hello ; ./hello ; echo RC=$?', 60_000)).output);
  a.check('(b) chmod +x restores execution', /native!/.test(restored) && /RC=0\b/.test(restored),
    JSON.stringify(restored.slice(-300)));

  // ── (c) generic shebang dispatch ──
  await t.run(`printf '#!/usr/bin/env node\\nconsole.log("shebang ok")\\n' > s`, 10_000);
  const shebangDenied = stripAnsi((await t.run('./s ; echo RC=$?', 60_000)).output);
  a.check('(c) non-exec shebang script denied first', /Permission denied/i.test(shebangDenied)
    && /RC=126\b/.test(shebangDenied), JSON.stringify(shebangDenied.slice(-300)));
  const shebangRun = stripAnsi((await t.run('chmod +x s && ./s ; echo RC=$?', 120_000)).output);
  a.check('(c) chmod +x s && ./s → shebang ok', /shebang ok/.test(shebangRun),
    JSON.stringify(shebangRun.slice(-300)));

  // ── (d) ELF/garbage binary → honest exec-format error, no crash ──
  // (real bytes via node — shell printf is not binary-safe here)
  await t.run(
    `node -e 'require("fs").writeFileSync("elfish", Buffer.from([0x7f,0x45,0x4c,0x46,2,1,1,0,0,0,0x6a,0x75,0x6e,0x6b]))' && chmod +x elfish`,
    120_000);
  const elf = stripAnsi((await t.run('./elfish ; echo RC=$?', 60_000)).output);
  a.check('(d) exec-bit ELF → exec format not supported', /exec format not supported/i.test(elf),
    JSON.stringify(elf.slice(-300)));
  a.check('(d) format error exit 126', /RC=126\b/.test(elf), JSON.stringify(elf.slice(-200)));
  const alive = stripAnsi((await t.run('echo STILL_ALIVE=$?', 30_000)).output);
  a.check('(d) shell survives (no crash)', /STILL_ALIVE=/.test(alive),
    JSON.stringify(alive.slice(-200)));

  // ── extras: sh ENOEXEC fallback + plain-file denial ──
  const shText = stripAnsi((await t.run(
    `printf 'echo from-sh-fallback\\n' > plain && chmod +x plain && ./plain ; echo RC=$?`,
    60_000)).output);
  a.check('exec-bit text with no shebang runs via sh', /from-sh-fallback/.test(shText)
    && /RC=0\b/.test(shText), JSON.stringify(shText.slice(-300)));

  const plainDenied = stripAnsi((await t.run(
    `printf 'not a program\\n' > data.txt ; ./data.txt ; echo RC=$?`, 60_000)).output);
  a.check('non-exec plain file → Permission denied', /Permission denied/i.test(plainDenied)
    && /RC=126\b/.test(plainDenied), JSON.stringify(plainDenied.slice(-300)));
} finally {
  await t.close().catch(() => {});
  const del = await deleteSession(sid);
  console.log(`deleteSession: ${del.status}`);
}

const { fail } = a.summary();
process.exit(fail === 0 ? 0 : 1);
