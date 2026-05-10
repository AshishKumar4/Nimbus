#!/usr/bin/env bun
// behavioral/honest-install-message — install summary line color +
// "(N failed, see above)" suffix matches the actual failed-count.
//
// User report: with 353/617 packages failing on Markflow install, the
// green `added 264 packages` line printed unchanged — no failure
// indication in the success summary. Post-fix:
//   - failed.length === 0 → GREEN "added X packages (...) in Ts"
//   - failed.length  >  0 → YELLOW "added X packages (...) in Ts (N failed, see above)"
//                           AND a red "Failed: ..." line above it.
//
// This probe drives a Markflow-tier install (the same path that
// reproduces the overload). It asserts the message shape MATCHES the
// failed count regardless of pass/fail — so the probe is meaningful
// both pre-fix (with failures) and post-fix (typically zero failures).
//
// Black-box only. NO _diag.

import { mintSession, Terminal, makeAsserter, sleep, stripAnsi } from './_driver.mjs';

if (!process.env.BASE) { console.error('FATAL: BASE env required'); process.exit(2); }
const a = makeAsserter('honest-install-message');
console.log(`behavioral/honest-install-message — message shape matches failed-count\nBASE=${process.env.BASE}`);

const REPO = 'https://github.com/AshishKumar4/Markflow';

const sid = await mintSession();
console.log(`SID: ${sid}`);

const t = new Terminal(sid);
await t.connect();
await sleep(2_000);

// Step 1: clone Markflow.
{
  t.reset();
  t.cmd(`git clone ${REPO}`);
  await t.waitFor(
    (b) => /clone complete/i.test(b),
    60_000,
    'git clone',
  );
}

// Step 2: cd Markflow && npm install. Capture RAW (ANSI-preserved) output.
let rawTail = '';
{
  await t.run('cd /home/user/Markflow', 5_000);
  t.reset();
  t.cmd('npm install');
  await t.waitFor(
    (b) => /(added \d+ packages|npm install failed)/i.test(b),
    300_000,  // 5 min generous bound
    'install end',
  );
  await sleep(1_500);
  rawTail = t.buf;  // raw (ANSI-preserved)
  console.log(`  install completed; raw output ${rawTail.length} bytes`);
}

// Step 3: parse the install summary lines.
//   - Optional red "Failed: ..." line.
//   - Optional yellow OR green "added N packages" line.
const stripped = stripAnsi(rawTail);
// Find the LAST "Batch-facet complete" line — it has a deterministic
// "(N failed)" suffix when N > 0.
const batchMatches = [...stripped.matchAll(/Batch-facet complete: (\d+)\/(\d+) packages,[^]*?(?:\((\d+) failed\))?[\r\n]/g)];
let failedCount = 0;
let okCount = 0;
let totalCount = 0;
if (batchMatches.length > 0) {
  const last = batchMatches[batchMatches.length - 1];
  okCount = parseInt(last[1], 10);
  totalCount = parseInt(last[2], 10);
  failedCount = last[3] ? parseInt(last[3], 10) : 0;
  console.log(`  batch-facet: ${okCount}/${totalCount} ok, ${failedCount} failed`);
}

// Step 4: assert the green/yellow summary line shape matches.
{
  const greenSummary = rawTail.match(/\x1b\[32madded (\d+) packages \((\d+) files\) in [\d.]+s\x1b\[0m/);
  const yellowSummary = rawTail.match(/\x1b\[33madded (\d+) packages \((\d+) files\) in [\d.]+s \((\d+) failed, see above\)\x1b\[0m/);

  if (failedCount === 0) {
    a.check('failed=0 → GREEN "added X packages" (no suffix)',
      !!greenSummary && !yellowSummary,
      `green=${!!greenSummary} yellow=${!!yellowSummary} failed=${failedCount}`);
  } else {
    a.check('failed>0 → YELLOW "added X packages ... (N failed, see above)"',
      !!yellowSummary && !greenSummary,
      `green=${!!greenSummary} yellow=${!!yellowSummary} failed=${failedCount} ` +
      `(yellow shape requires \\x1b[33m + "(${failedCount} failed, see above)" suffix)`);
    if (yellowSummary) {
      a.check('yellow summary failed-count matches batch-facet failed-count',
        parseInt(yellowSummary[3], 10) === failedCount,
        `summary=${yellowSummary[3]} batch=${failedCount}`);
    }
    a.check('failed>0 → red "Failed:" line on stderr above summary',
      /\x1b\[31mFailed:/.test(rawTail),
      'no red Failed: line found');
  }
}

await t.close();

const s = a.summary();
process.exit(s.fail === 0 ? 0 : 1);
