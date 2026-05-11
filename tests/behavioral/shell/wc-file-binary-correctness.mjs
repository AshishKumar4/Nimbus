#!/usr/bin/env bun
// shell/wc-file-binary-correctness — regression probe for BUG-SWEEP-3.
//
// Pre-fix:
//   - `wc -c <binary-file>` reported a wrong byte count because the
//     implementation read the file as UTF-8 string (replacing invalid
//     bytes with U+FFFD), then re-encoded as UTF-8. A 5-byte binary
//     file `[ff fe 00 01 42]` reported 9 bytes; `stat` correctly
//     reported 5.
//   - `file <binary-file>` always reported "UTF-8 text" because the
//     read path silently U+FFFD-substituted invalid sequences.
//
// Post-fix: both commands now read raw Uint8Array first. `wc -c`
// reports the actual byte count. `file` scans bytes for NUL or
// non-text control chars and reports "data" / format-specific
// classification (PNG, gzip, ELF, wasm, zip) when binary.

import { mintSession, Terminal, makeAsserter, stripAnsi, sleep } from '../_driver.mjs';

if (!process.env.BASE) { console.error('FATAL: BASE env required'); process.exit(2); }
const a = makeAsserter('shell/wc-file-binary-correctness');
console.log(`shell/wc-file-binary-correctness — ${process.env.BASE}`);

const sid = await mintSession();
const t = new Terminal(sid);
await t.connect();
await t.waitForPrompt(60_000);

// Write a 5-byte binary file via node -e (workerd nodejs_compat fs).
await t.run(
  'node -e "require(\\"fs\\").writeFileSync(\\"/tmp/bsweep.bin\\", Buffer.from([0xff, 0xfe, 0x00, 0x01, 0x42]))"',
  15_000,
);

// Probe 1: stat reports correct size (sanity baseline).
const statR = await t.run('stat /tmp/bsweep.bin', 10_000);
a.check(
  '`stat` reports size 5 for 5-byte file (sanity baseline)',
  /Size:\s*5\b/.test(stripAnsi(statR.output)),
  `tail: ${JSON.stringify(stripAnsi(statR.output).slice(-200))}`,
);

// Probe 2: wc -c reports raw byte count (5), not UTF-8-decoded length.
const wcR = await t.run('wc -c /tmp/bsweep.bin', 10_000);
const wcOut = stripAnsi(wcR.output);
a.check(
  '`wc -c` reports 5 for 5-byte binary file (no U+FFFD re-encoding)',
  /\b5\b\s+\/tmp\/bsweep\.bin/.test(wcOut),
  `tail: ${JSON.stringify(wcOut.slice(-200))}`,
);

// Probe 3: file detects binary content (NUL byte present), reports "data".
const fileR = await t.run('file /tmp/bsweep.bin', 10_000);
const fileOut = stripAnsi(fileR.output);
a.check(
  '`file` detects binary (NUL byte present) and reports "data", not "UTF-8 text"',
  /\/tmp\/bsweep\.bin:\s+data/.test(fileOut) && !/UTF-8 text/.test(fileOut),
  `tail: ${JSON.stringify(fileOut.slice(-200))}`,
);

// Probe 4: plain text file is still classified correctly.
await t.run('printf "hello world\\n" > /tmp/bsweep.txt', 5_000);
const fileTextR = await t.run('file /tmp/bsweep.txt', 10_000);
const fileTextOut = stripAnsi(fileTextR.output);
a.check(
  '`file` on plain text still reports text classification',
  /\/tmp\/bsweep\.txt:\s+(ASCII|UTF-8) text/.test(fileTextOut),
  `tail: ${JSON.stringify(fileTextOut.slice(-200))}`,
);

await t.close();
const sum = a.summary();
process.exit(sum.fail > 0 ? 1 : 0);
