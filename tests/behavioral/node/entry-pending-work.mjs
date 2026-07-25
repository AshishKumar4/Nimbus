#!/usr/bin/env bun
// node/entry-pending-work — a node facet must not decide a program is
// finished while its work is still in flight.
//
// Pre-fix, a floating async IIFE was cut off after its first flushed line and
// the process exited 0 — the whole rest of the program silently never ran:
//
//   node -e '(async () => { const r = await fetch(u); console.log(r.status) })()'
//     → prints nothing, exits 0
//
// Two independent causes, both here:
//   1. `await` resolves through PerformPromiseThen and never calls the patched
//      Promise.prototype.then, so the entry drain's promise tracking could not
//      see awaited work at all. In-flight operations are now counted at the
//      shim's fetch / response-body / supervisor-RPC seams.
//   2. The drain's 50k-pass budget expired after ~150ms of wall clock — a
//      `setTimeout(0)` turn costs ~5µs in workerd — and silently overrode
//      every longer deadline the callers declared. The bound is now a real
//      timer.
//
// And when the drain does run out with work still pending, the program did
// NOT finish: it exits non-zero saying so, instead of reporting success.

import { mintSession, deleteSession, Terminal, makeAsserter, stripAnsi } from '../_driver.mjs';

if (!process.env.BASE) { console.error('FATAL: BASE env required'); process.exit(2); }
const a = makeAsserter('node/entry-pending-work');
console.log(`node/entry-pending-work — ${process.env.BASE}`);

const sid = await mintSession();
const t = new Terminal(sid);
try {
  await t.connect();
  await t.waitForPrompt(60_000);

  // 1. A floating async IIFE that awaits a network fetch, then reads the
  //    response body. Every line after the first `await` was dropped pre-fix.
  const fetched = stripAnsi((await t.run(
    `node -e 'console.log("A"); (async () => { const r = await fetch("https://example.com"); console.log("B", r.status); const b = await r.text(); console.log("C", b.length > 0); })();'`,
    60_000,
  )).output);
  a.check(
    'a floating async IIFE runs past its awaited fetch',
    /\bA\b/.test(fetched) && /\bB 200\b/.test(fetched),
    JSON.stringify(fetched.slice(-600)),
  );
  a.check(
    'reading the response body is awaited too',
    /\bC true\b/.test(fetched),
    JSON.stringify(fetched.slice(-600)),
  );

  // 2. Awaited macrotask work, well past the pre-fix ~150ms budget.
  const timed = stripAnsi((await t.run(
    `node -e 'console.log("START"); (async () => { await new Promise(r => setTimeout(r, 1500)); console.log("AFTER-SLEEP"); })();'`,
    60_000,
  )).output);
  a.check(
    'a floating IIFE that awaits a 1.5s timer still finishes',
    /START/.test(timed) && /AFTER-SLEEP/.test(timed),
    JSON.stringify(timed.slice(-600)),
  );

  // 3. Awaited filesystem work — the same invisibility, a different seam.
  const fsRun = stripAnsi((await t.run(
    `node -e 'const fs=require("fs"); (async () => { await fs.promises.writeFile("/home/user/pending.txt","ok"); console.log("FS", await fs.promises.readFile("/home/user/pending.txt","utf8")); })();'`,
    60_000,
  )).output);
  a.check(
    'a floating IIFE runs past awaited fs work',
    /FS ok/.test(fsRun),
    JSON.stringify(fsRun.slice(-600)),
  );

  // 4. Work that never completes is a failure, not a silent success. The
  //    program must be told what was dropped, and must not exit 0.
  const stuck = stripAnsi((await t.run(
    `node -e 'setInterval(() => {}, 1000); console.log("STUCK-START");' ; echo "EXIT=$?"`,
    60_000,
  )).output);
  a.check(
    'a program abandoned with work in flight reports why',
    /pending operation\(s\) still in flight/.test(stuck),
    JSON.stringify(stuck.slice(-600)),
  );
  a.check(
    'a program abandoned with work in flight does not exit 0',
    /EXIT=[1-9]/.test(stuck),
    JSON.stringify(stuck.slice(-600)),
  );

  // 5. execSync cannot be honoured in a facet and says so, loudly, instead of
  //    returning before the child has run.
  const sync = stripAnsi((await t.run(
    `node -e 'let o = "returned"; try { require("child_process").execSync("echo hi") } catch (e) { o = "refused:" + e.code } console.log("OUTCOME=" + o)'`,
    60_000,
  )).output);
  a.check(
    'execSync refuses instead of returning before the child ran',
    /OUTCOME=refused:ERR_NIMBUS_SYNC_CHILD_PROCESS/.test(sync),
    JSON.stringify(sync.slice(-600)),
  );

  // 6. A Buffer view is still a Buffer: slicing then stringifying must decode
  //    text, not emit the comma-joined byte list.
  const buf = stripAnsi((await t.run(
    `node -e 'const b = Buffer.from("hello world"); console.log("SUB:" + b.subarray(0, 5).toString());'`,
    60_000,
  )).output);
  a.check(
    'Buffer#subarray returns a Buffer',
    /SUB:hello/.test(buf),
    JSON.stringify(buf.slice(-600)),
  );

  // 7. A descriptor write loop of 26 MiB completes — it used to rebuild the
  //    whole file per write and OOM the facet.
  const bigWrite = stripAnsi((await t.run(
    `node -e 'const fs=require("fs"); (async () => { const fh = await fs.promises.open("/home/user/big.bin","w"); const c = Buffer.alloc(65536, 65); for (let i = 0; i < 416; i++) await fh.write(c); await fh.close(); console.log("WROTE", fs.statSync("/home/user/big.bin").size); })();'`,
    120_000,
  )).output);
  a.check(
    'a 26 MiB FileHandle write loop completes',
    /WROTE 27262976/.test(bigWrite),
    JSON.stringify(bigWrite.slice(-600)),
  );
} finally {
  await t.close();
  await deleteSession(sid);
}

const sum = a.summary();
process.exit(sum.fail > 0 ? 1 : 0);
