#!/usr/bin/env bun
// shell-r5/new/exit-dump-quiet-on-clean — SHELL-FOLLOWUPS-5.
//
// Pre-fix: When a tracked spawn-process (node/python/ruby/bun/clang/etc —
// anything that flows through processLogs.append + _emitShellExecDone)
// exits cleanly with code 0 and a non-empty stdout buffer, the
// rpc.ts policy `bufSize > 0 && (code !== 0 || bufSize > 0)` always
// triggered _emitExitDump, even though the stdout had already been
// streamed live to the terminal. Result: stdout appeared TWICE,
// sandwiched between two "Process N exited with code 0" banner rules.
//
// Reproducer (observed pre-fix on prod):
//   $ node -e "console.log('mark')"
//   mark
//   ────────────────────────────────────────────
//   Process 1 (node -e ...) exited with code 0
//   ────────────────────────────────────────────
//   mark                       ← DUPLICATE
//   ────────────────────────────────────────────
//
// Post-fix: policy changes to `code !== 0 && bufSize > 0`. Clean exits
// emit no exit-dump in-band; the on-exit replay buffer is still
// available out-of-band via `logs <pid>` / `/api/processes/<pid>/logs`.
//
// Builtin commands (echo, ls, for-loop) never trigger this dump path
// at all (processLogs isn't populated for them); this probe therefore
// uses `node -e` to guarantee the tracked-process code path.

import { mintSession, Terminal, makeAsserter, stripAnsi } from '../../_driver.mjs';

if (!process.env.BASE) { console.error('FATAL: BASE env required'); process.exit(2); }
const a = makeAsserter('shell-r5/new/exit-dump-quiet-on-clean');
console.log(`shell-r5/new/exit-dump-quiet-on-clean — ${process.env.BASE}`);

const sid = await mintSession();
const t = new Terminal(sid);
await t.connect();
await t.waitForPrompt(60_000);

function countOccurrences(haystack, needle) {
  if (!needle) return 0;
  let n = 0, i = 0;
  while ((i = haystack.indexOf(needle, i)) !== -1) { n++; i += needle.length; }
  return n;
}

// Probe 1: node clean exit — marker once in stdout, NOT duplicated.
// stripAnsi to drop colors; the echoed command line contains the
// literal too, so the expected count for a properly behaving session
// is 2: (echoed-input) + (stdout streamed once). Pre-fix saw 3:
// (echo) + (stdout streamed) + (stdout dumped).
const r1 = await t.run('node -e "console.log(\'r5-mark-alpha\')"', 15_000);
const r1raw = stripAnsi(r1.output);
const c1 = countOccurrences(r1raw, 'r5-mark-alpha');
a.check('node clean-exit — marker appears at most twice (echo + stdout, no dump)',
  c1 <= 2,
  `count=${c1} raw=${JSON.stringify(r1raw)}`);

// Probe 2: no "Process N exited with code 0" + duplicate-dump banner pair
// after a clean exit.
a.check('node clean-exit — no "exited with code 0" banner',
  !/Process \d+ .* exited with code 0/.test(r1raw),
  `raw=${JSON.stringify(r1raw)}`);

// Probe 3: multi-line stdout, clean exit — each line at most twice
// (echo + stream).
const r2 = await t.run('node -e "console.log(\'L-A\'); console.log(\'L-B\'); console.log(\'L-C\')"', 15_000);
const r2raw = stripAnsi(r2.output);
// Each L-X literal appears twice in correctly-behaving output:
// once in the echoed shell command (because console.log('L-X') is
// literal source on the input line) and once in node's stdout.
// Pre-fix the count was 3 (echo + stream + dump). Post-fix it's 2.
a.check('node multi-line clean — L-A count ≤ 2 (no dump)',
  countOccurrences(r2raw, 'L-A') <= 2,
  `count=${countOccurrences(r2raw, 'L-A')} raw=${JSON.stringify(r2raw)}`);
a.check('node multi-line clean — L-B count ≤ 2 (no dump)',
  countOccurrences(r2raw, 'L-B') <= 2,
  `count=${countOccurrences(r2raw, 'L-B')} raw=${JSON.stringify(r2raw)}`);
a.check('node multi-line clean — L-C count ≤ 2 (no dump)',
  countOccurrences(r2raw, 'L-C') <= 2,
  `count=${countOccurrences(r2raw, 'L-C')} raw=${JSON.stringify(r2raw)}`);
a.check('node multi-line clean — no "exited with code 0" banner',
  !/Process \d+ .* exited with code 0/.test(r2raw),
  `raw=${JSON.stringify(r2raw)}`);

// Probe 4 (negative control): non-zero exit MAY surface the dump for
// diagnostics — we only assert the error marker is present at least once.
const r3 = await t.run('node -e "console.error(\'err-mark\'); process.exit(2)"', 15_000);
const r3raw = stripAnsi(r3.output);
a.check('node non-zero exit — err-mark present',
  countOccurrences(r3raw, 'err-mark') >= 1,
  `count=${countOccurrences(r3raw, 'err-mark')} raw=${JSON.stringify(r3raw)}`);

await t.close();
const sum = a.summary();
process.exit(sum.fail > 0 ? 1 : 0);
