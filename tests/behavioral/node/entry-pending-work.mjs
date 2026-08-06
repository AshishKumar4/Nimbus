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

  // 4. A program slower than the drain used to allow must simply RUN. 25s of
  //    floating async work is well inside the facet's real lifetime
  //    (FACET_TIMEOUT_MS); the fixed 8s entry budget cut it at ~8s, and every
  //    sequential-fetch script with it.
  const longRun = stripAnsi((await t.run(
    `node -e '(async () => { const t0 = Date.now(); for (let i = 0; i < 25; i++) await new Promise(r => setTimeout(r, 1000)); console.log("LONG-OK", Date.now() - t0 >= 25000); })();' ; echo "EXIT=$?"`,
    90_000,
  )).output);
  a.check(
    '25s of floating async work is inside the facet lifetime and completes',
    /LONG-OK true/.test(longRun) && /EXIT=0/.test(longRun),
    JSON.stringify(longRun.slice(-600)),
  );

  // 5. Work that never completes is a failure, not a silent success — and the
  //    message must name the limit that was hit, not merely that something was
  //    dropped. It must also be the FACET's own exit: if the drain overran, the
  //    supervisor's generic "[process killed: timeout after 30s]" would replace
  //    it and the user would lose the reason.
  const stuck = stripAnsi((await t.run(
    `node -e 'setInterval(() => {}, 1000); console.log("STUCK-START");' ; echo "EXIT=$?"`,
    90_000,
  )).output);
  a.check(
    'a program abandoned with work in flight names the limit it hit',
    /facet lifetime limit/.test(stuck) && /still in flight/.test(stuck),
    JSON.stringify(stuck.slice(-600)),
  );
  a.check(
    "that failure is the facet's own honest exit, not the supervisor kill",
    /EXIT=1\b/.test(stuck) && !/timeout after \d+s/.test(stuck),
    JSON.stringify(stuck.slice(-600)),
  );

  // 6. The other side of that line: an unsettled PROMISE is not work in
  //    flight. Node exits on live handles, not on pending promises, so a
  //    program whose last act adopts a promise nothing will ever settle
  //    prints its output and exits 0. Counting promises made this exact
  //    shape — which npm CLIs produce routinely — burn the whole facet
  //    lifetime and then report that the program had not finished.
  const unsettled = await t.run(
    `node -e 'Promise.resolve().then(() => new Promise(() => {})); console.log("PENDING-OK");' ; echo "EXIT=$?"`,
    90_000,
  );
  const unsettledOut = stripAnsi(unsettled.output);
  a.check(
    'an unsettled promise does not keep the program alive',
    /PENDING-OK/.test(unsettledOut) && /EXIT=0\b/.test(unsettledOut)
      && !/facet lifetime limit/.test(unsettledOut),
    JSON.stringify(unsettledOut.slice(-600)),
  );

  // 7. process.exit is immediate whatever is outstanding — a live interval
  //    and an unsettleable promise both, here.
  const explicitExit = await t.run(
    `node -e 'setInterval(() => {}, 1000); Promise.resolve().then(() => new Promise(() => {})); (async () => { await new Promise(r => setTimeout(r, 200)); process.exit(3); })();' ; echo "EXIT=$?"`,
    90_000,
  );
  const explicitExitOut = stripAnsi(explicitExit.output);
  a.check(
    'process.exit wins over everything still outstanding',
    /EXIT=3\b/.test(explicitExitOut) && !/facet lifetime limit/.test(explicitExitOut),
    JSON.stringify(explicitExitOut.slice(-600)),
  );

  // 8. Exiting early must not exit before the writes land. A synchronous
  //    write can only park bytes in the facet, so the exit path is what
  //    carries them to the authority — shortening the program's life must
  //    not shorten that.
  const syncWrite = stripAnsi((await t.run(
    `node -e 'require("fs").writeFileSync("/home/user/drain-sync.txt","persisted-bytes"); Promise.resolve().then(() => new Promise(() => {}));'`,
    90_000,
  )).output);
  const readBackSync = stripAnsi((await t.run('cat /home/user/drain-sync.txt; echo', 60_000)).output);
  a.check(
    'a program that returns early still persists what it wrote',
    /persisted-bytes/.test(readBackSync) && !/facet lifetime limit/.test(syncWrite),
    JSON.stringify(readBackSync.slice(-600)),
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

  // 7. A descriptor write loop completes and reads back byte-exact. It used to
  //    rebuild the whole file on every write, so the copying grew with the
  //    square of the loop and OOM'd the facet. (The cost itself is pinned
  //    deterministically in tests/unit/node-shims-fd-write-growth.mjs; this is
  //    the end-to-end check that the bytes survive the round trip.)
  const bigWrite = stripAnsi((await t.run(
    `node -e 'const fs=require("fs"); (async () => { const fh = await fs.promises.open("/home/user/big.bin","w"); const c = Buffer.alloc(65536, 65); for (let i = 0; i < 128; i++) await fh.write(c); await fh.close(); console.log("WROTE", fs.statSync("/home/user/big.bin").size); })();'`,
    120_000,
  )).output);
  a.check(
    'an 8 MiB FileHandle write loop completes',
    /WROTE 8388608/.test(bigWrite),
    JSON.stringify(bigWrite.slice(-600)),
  );

  const readBack = stripAnsi((await t.run(
    `node -e 'const fs=require("fs"); const b = fs.readFileSync("/home/user/big.bin"); console.log("READBACK=" + b.length + ":" + b.subarray(0,2).toString() + b.subarray(b.length-2).toString());'`,
    120_000,
  )).output);
  a.check(
    'the written file reads back byte-exact from a later process',
    /READBACK=8388608:AAAA/.test(readBack),
    JSON.stringify(readBack.slice(-600)),
  );
} finally {
  await t.close();
  await deleteSession(sid);
}

const sum = a.summary();
process.exit(sum.fail > 0 ? 1 : 0);
