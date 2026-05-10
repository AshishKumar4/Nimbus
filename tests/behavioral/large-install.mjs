#!/usr/bin/env bun
// behavioral/large-install — Markflow-tier (~617 deps) install end-to-end.
//
// User repro: Markflow has 617 transitive deps. With install-honesty fix
// shipped (peer-DO writeBatchStream → coordinator), ALL 96 concurrent peer
// streams (32 peers × pLimit 3) hit the same coordinator DO's input gate
// → "Durable Object is overloaded. Requests queued for too long." for ~50%
// of packages.
//
// Asserts:
//   1. resolver completes (Resolved 600+ packages line)
//   2. zero "Durable Object is overloaded" warnings on stderr
//   3. final result.failed.length === 0 (i.e. installed.length == resolved-count)
//   4. spot-check: at least 5 known top-level deps are readable from VFS
//      and parse JSON correctly.
//
// Black-box only. NO _diag.

import { mintSession, Terminal, makeAsserter, sleep, stripAnsi } from './_driver.mjs';

if (!process.env.BASE) { console.error('FATAL: BASE env required'); process.exit(2); }
const a = makeAsserter('large-install');
console.log(`behavioral/large-install — Markflow ~617 deps install\nBASE=${process.env.BASE}`);

// Markflow's top-level deps as of 2026-05 (verified against
// https://github.com/AshishKumar4/Markflow/blob/main/package.json).
// Spot-checking 5 ensures bytes actually landed in user-visible VFS,
// not just that the count line matches.
const SPOT_CHECK = ['react', 'mermaid', 'lucide-react', 'hono', 'tailwindcss'];
const REPO = 'https://github.com/AshishKumar4/Markflow';

const sid = await mintSession();
console.log(`SID: ${sid}`);

const t = new Terminal(sid);
await t.connect();
await sleep(2_000);

// Step 1: clone Markflow (small repo — ~111 files / 821 KB per transcript).
{
  t.reset();
  t.cmd(`git clone ${REPO}`);
  const elapsed = await t.waitFor(
    (b) => /clone complete/i.test(b) || /\$\s*$/.test(b.trimEnd().slice(-3)),
    60_000,
    'git clone complete',
  );
  console.log(`  git clone done in ${elapsed}ms`);
  a.check('git clone Markflow', /clone complete/i.test(stripAnsi(t.buf)),
    stripAnsi(t.buf).slice(-200));
}

// Step 2: cd Markflow && npm i. This is where the overload fires.
let installOutput = '';
{
  await t.run('cd /home/user/Markflow', 5_000);
  t.reset();
  t.cmd('npm i');
  const elapsed = await t.waitFor(
    (b) => /added \d+ packages|npm install failed/i.test(b),
    480_000,  // 8 min — RED today: most install completes < 60s but the
              // overload errors take some time to back-pressure.
              // GREEN target: we expect < 90s.
    'npm install end',
  );
  installOutput = stripAnsi(t.buf);
  console.log(`  npm i done in ${(elapsed / 1000).toFixed(1)}s`);
}

// Step 3: assert resolver succeeded.
{
  const m = installOutput.match(/Resolved (\d+) packages/);
  const resolved = m ? parseInt(m[1], 10) : 0;
  a.check('resolver finds 600+ packages',
    resolved >= 600,
    `resolved=${resolved}`);
}

// Step 4: assert zero "overloaded" warnings.
{
  const overloads = (installOutput.match(/Durable Object is overloaded/g) || []).length;
  a.check('zero "Durable Object is overloaded" warnings',
    overloads === 0,
    `${overloads} overload errors observed`);
}

// Step 5: assert added-count matches resolved-count.
{
  const added = installOutput.match(/added (\d+) packages/);
  const resolved = installOutput.match(/Resolved (\d+) packages/);
  const addedN = added ? parseInt(added[1], 10) : 0;
  const resolvedN = resolved ? parseInt(resolved[1], 10) : 0;
  a.check('added count == resolved count (no failures)',
    addedN === resolvedN && resolvedN > 0,
    `added=${addedN} resolved=${resolvedN}`);
}

// Step 6: spot-check 5 top-level deps actually landed.
// Wrap each in try/catch — overload-state may poison the terminal,
// in which case we report the spot-check as failed with a clear reason
// rather than crashing the whole probe.
for (const pkg of SPOT_CHECK) {
  const probeJs = `
const fs = require('fs');
const p = '/home/user/Markflow/node_modules/${pkg}/package.json';
let v = '';
try {
  if (!fs.existsSync(p)) v = 'MISSING';
  else {
    const j = JSON.parse(fs.readFileSync(p, 'utf8'));
    v = 'NAME=' + j.name;
  }
} catch (e) { v = 'ERR=' + (e && e.message ? e.message : String(e)); }
console.log('PROBE_RESULT_' + v + '_END');
`.trim();
  const b64 = Buffer.from(probeJs, 'utf8').toString('base64');
  try {
    await t.run(`node -e "require('fs').writeFileSync('/tmp/p.js', Buffer.from('${b64}','base64').toString('utf8'))"`, 15_000);
    const r = await t.run('node /tmp/p.js', 30_000);
    const m = r.output.match(/PROBE_RESULT_(.+?)_END/);
    a.check(`spot-check: ${pkg} package.json readable + parses`,
      m && m[1] === `NAME=${pkg}`,
      m ? m[1] : 'no PROBE_RESULT marker');
  } catch (e) {
    a.check(`spot-check: ${pkg} package.json readable + parses`,
      false,
      `terminal/probe error: ${String(e?.message ?? e).slice(0, 150)}`);
  }
}

await t.close();

const s = a.summary();
process.exit(s.fail === 0 ? 0 : 1);
