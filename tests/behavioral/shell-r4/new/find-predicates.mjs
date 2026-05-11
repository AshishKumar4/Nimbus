#!/usr/bin/env bun
// shell-r4/new/find-predicates — BUG-SWEEP-R4-5.
//
// Pre-fix find honoured only -name and -type. -size and -mtime were
// no-ops (returned all files). Common cleanup-script patterns
// broken:
//   find /tmp -mtime +7 -delete       # delete files older than 7d
//   find . -size 0 -type f             # find empty files
//
// Post-fix: -size [+|-]NUM[c|k|M|G], -mtime [+|-]N, -newer FILE,
// -empty, -maxdepth N, -delete, -print, -print0 supported. -exec
// emits the substituted command-line (real exec needs registry
// access — future wave).

import { mintSession, Terminal, makeAsserter, stripAnsi, sleep } from '../../_driver.mjs';

if (!process.env.BASE) { console.error('FATAL: BASE env required'); process.exit(2); }
const a = makeAsserter('shell-r4/new/find-predicates');
console.log(`shell-r4/new/find-predicates — ${process.env.BASE}`);

const sid = await mintSession();
const t = new Terminal(sid);
await t.connect();
await t.waitForPrompt(60_000);

function body(raw) {
  const ansi = stripAnsi(raw);
  const lines = ansi.split(/\r?\n/);
  if (lines.length && /\$\s*$/.test(lines[lines.length - 1])) lines.pop();
  if (lines.length && /\$\s/.test(lines[0])) lines.shift();
  return lines.join('\n');
}

// Setup: mixed-size files
await t.run('rm -rf /tmp/r4f && mkdir -p /tmp/r4f', 3_000);
await t.run('touch /tmp/r4f/empty.txt', 2_000);  // 0 bytes
await t.run('printf "X" > /tmp/r4f/tiny.txt', 2_000);  // 1 byte
await t.run('printf "%.0s." $(seq 1 2000) > /tmp/r4f/big.txt', 5_000);  // ~2KB

// Probe 1: -size 0 (exact 0-block files — 512-byte blocks → 0 blocks for 0-byte file)
const r1 = await t.run('find /tmp/r4f -size 0 -type f', 5_000);
const b1 = body(r1.output);
a.check('find -size 0 finds empty file', /empty\.txt/.test(b1) && !/big\.txt/.test(b1), `body=${JSON.stringify(b1)}`);

// Probe 2: -size +1k (more than 1 KiB)
const r2 = await t.run('find /tmp/r4f -size +1k -type f', 5_000);
const b2 = body(r2.output);
a.check('find -size +1k finds big.txt (not tiny or empty)', /big\.txt/.test(b2) && !/empty\.txt/.test(b2) && !/tiny\.txt/.test(b2), `body=${JSON.stringify(b2)}`);

// Probe 3: -size -1c (less than 1 byte)
const r3 = await t.run('find /tmp/r4f -size -1c -type f', 5_000);
const b3 = body(r3.output);
a.check('find -size -1c finds empty.txt', /empty\.txt/.test(b3) && !/big\.txt/.test(b3), `body=${JSON.stringify(b3)}`);

// Probe 4: -empty
const r4 = await t.run('find /tmp/r4f -empty -type f', 5_000);
const b4 = body(r4.output);
a.check('find -empty finds empty.txt', /empty\.txt/.test(b4) && !/big\.txt/.test(b4), `body=${JSON.stringify(b4)}`);

// Probe 5: -maxdepth limits recursion
await t.run('mkdir -p /tmp/r4f/sub && touch /tmp/r4f/sub/deep.txt', 3_000);
const r5 = await t.run('find /tmp/r4f -maxdepth 1 -type f', 5_000);
const b5 = body(r5.output);
a.check('find -maxdepth 1 excludes subdir contents', /empty\.txt/.test(b5) && !/deep\.txt/.test(b5), `body=${JSON.stringify(b5)}`);

// Probe 6: -delete actually removes matching files
await t.run('mkdir -p /tmp/r4fdel && touch /tmp/r4fdel/{a,b,c}.tmp /tmp/r4fdel/keep.txt', 3_000);
await t.run('find /tmp/r4fdel -name "*.tmp" -delete', 5_000);
const r6 = await t.run('ls /tmp/r4fdel', 5_000);
a.check('find -delete removes matching files', body(r6.output) === 'keep.txt', `body=${JSON.stringify(body(r6.output))}`);

await t.close();
const sum = a.summary();
process.exit(sum.fail > 0 ? 1 : 0);
