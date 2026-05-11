#!/usr/bin/env bun
// node/readfile-abs-path — regression probe for BUG-SWEEP-R2-2.
//
// Pre-fix: `node -e 'fs.readFileSync("/home/user/X")'` returned ENOENT
// even when the file existed on SqliteVFS (verified via `cat`/`ls`).
// Cause: buildPrefetchBundle's static scanners only matched
// __dirname-relative-resolve patterns INSIDE bundled package sources —
// never scanned the user's entry code for absolute-path string literals,
// so user-written files at /home/user/* or /tmp/* never entered the
// facet's __vfsBundle.
//
// Post-fix: src/facets/manager.ts addEntryAbsPathReads() scans entry
// code + bundled JS sources for absolute-path string literals and
// pulls matching VFS files into the bundle within budget.

import { mintSession, Terminal, makeAsserter, stripAnsi, sleep } from '../_driver.mjs';

if (!process.env.BASE) { console.error('FATAL: BASE env required'); process.exit(2); }
const a = makeAsserter('node/readfile-abs-path');
console.log(`node/readfile-abs-path — ${process.env.BASE}`);

const sid = await mintSession();
const t = new Terminal(sid);
await t.connect();
await t.waitForPrompt(60_000);

// Setup: shell writes a file to /home/user that should NOT need a
// fresh node-isolate write to be readable from a subsequent node.
await t.run('echo "hello-abs-probe" > /home/user/r2probe.txt', 5_000);

// Probe 1: `node -e` reads the file via fs.readFileSync(absolute-path).
const r1 = await t.run(
  'node -e "console.log(require(\\"fs\\").readFileSync(\\"/home/user/r2probe.txt\\", \\"utf8\\"))"',
  20_000,
);
const out1 = stripAnsi(r1.output);
a.check(
  'node -e readFileSync(<absolute-path>) reads shell-written file',
  /hello-abs-probe/.test(out1) && !/ENOENT/.test(out1),
  `tail: ${JSON.stringify(out1.slice(-300))}`,
);

// Probe 2: cross-isolate persistence — node writes a file, then a
// SECOND node call reads it.
await t.run(
  'node -e "require(\\"fs\\").writeFileSync(\\"/home/user/r2cross.txt\\", \\"cross-iso-ok\\")"',
  15_000,
);
const r2 = await t.run(
  'node -e "console.log(require(\\"fs\\").readFileSync(\\"/home/user/r2cross.txt\\", \\"utf8\\"))"',
  20_000,
);
const out2 = stripAnsi(r2.output);
a.check(
  'cross-isolate persistence: node writes, second node reads (no ENOENT)',
  /cross-iso-ok/.test(out2) && !/ENOENT/.test(out2),
  `tail: ${JSON.stringify(out2.slice(-300))}`,
);

// Probe 3: existsSync also works for shell-written file.
const r3 = await t.run(
  'node -e "console.log(require(\\"fs\\").existsSync(\\"/home/user/r2probe.txt\\") ? \\"YES\\" : \\"NO\\")"',
  15_000,
);
const out3 = stripAnsi(r3.output);
a.check(
  'existsSync(<absolute-path>) returns true for shell-written file',
  /\bYES\b/.test(out3) && !/\bNO\b/.test(out3.split('\n').find(l => /^(YES|NO)$/.test(l)) || ''),
  `tail: ${JSON.stringify(out3.slice(-300))}`,
);

await t.close();
const sum = a.summary();
process.exit(sum.fail > 0 ? 1 : 0);
