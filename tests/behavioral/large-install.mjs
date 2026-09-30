#!/usr/bin/env bun
// behavioral/large-install — Markflow-tier (~620 deps) install end-to-end.
//
// User repro shape (verbatim, 2026-05-10):
//   git clone https://github.com/AshishKumar4/Markflow
//   cd Markflow && npm i
//   → Resolver: 620 resolved, layers=9, ✓
//   → Dispatching 620 packages across N shards (peer-do peer-DO fanout, internal pLimit=3)...
//   → [batch-fanout] aborted: ExecutionError: Durable Object is overloaded.
//
// The earlier version of this probe checked SINGLE-session behaviour
// only, which always passed; the bug only appears under concurrent
// session load (multiple users running `npm i` Markflow at once →
// account-level peer-DO cold-start scheduler overflow).
//
// The probe runs in two modes:
//   default (NIMBUS_PROBE_CONCURRENT=1, the failure mode the user hit):
//     NIMBUS_PROBE_CONCURRENT=12 — fire 12 concurrent sessions, each
//     does the user's flow. Asserts ≥ 11/12 succeed (1 transient
//     allowed). failing pre-wave-4d (3-4/12 fail with batch-fanout abort).
//
//   single (env NIMBUS_PROBE_SINGLE=1):
//     One session, full assertions including spot-check of 5 deps.
//     Useful for fast iteration + as a smoke check.
//
// NO fixtures, NO truncated deps. Always clones real Markflow from
// github.com.

import { mintSession, Terminal, makeAsserter, sleep, stripAnsi } from './_driver.mjs';

if (!process.env.BASE) { console.error('FATAL: BASE env required'); process.exit(2); }

const REPO = 'https://github.com/AshishKumar4/Markflow';
const SPOT_CHECK = ['react', 'mermaid', 'lucide-react', 'hono', 'tailwindcss'];

const SINGLE = process.env.NIMBUS_PROBE_SINGLE === '1';
const CONCURRENT = SINGLE ? 1 : parseInt(process.env.NIMBUS_PROBE_CONCURRENT || '12', 10);

console.log(`behavioral/large-install — Markflow ~620 deps install`);
console.log(`BASE=${process.env.BASE}`);
console.log(`mode=${SINGLE ? 'SINGLE' : `CONCURRENT(N=${CONCURRENT})`}`);

const a = makeAsserter('large-install');

/**
 * Drive ONE session through the user's exact flow and return outcome.
 * No retries, no setTimeout. Real github.com clone, real npm install.
 */
async function attempt(idx) {
  const startedAt = Date.now();
  let sid = null;
  let t = null;
  let phase = 'mint';
  let outcome = 'ERROR';
  let detail = '';
  let elapsedMs = 0;
  let installOutput = '';
  let spotChecks = null;
  try {
    sid = await mintSession();
    t = new Terminal(sid);
    phase = 'connect';
    await t.connect();
    await sleep(1500);

    // Step 1: clone Markflow.
    phase = 'clone';
    t.reset();
    t.cmd(`git clone ${REPO}`);
    await t.waitFor(
      (b) => /clone complete/i.test(b),
      90_000,
      'git clone complete',
    );

    // Step 2: cd Markflow && npm i. This is the line the user ran.
    phase = 'cd';
    await t.run('cd /home/user/Markflow', 5_000);
    phase = 'install';
    t.reset();
    t.cmd('npm i');
    await t.waitFor(
      (b) => /added \d+ packages|npm install failed|\[batch-fanout\] aborted/i.test(b),
      300_000,
      'install end',
    );
    installOutput = stripAnsi(t.buf);
    const batchAbort = installOutput.match(/\[batch-fanout\] aborted[^\r\n]*/i);
    const installFailure = installOutput.match(/npm install failed[^\r\n]*/i);
    if (batchAbort) {
      outcome = 'BATCH_FANOUT_ABORT';
      detail = batchAbort[0];
    } else if (/added \d+ packages/i.test(installOutput)) {
      outcome = 'SUCCESS';
    } else if (installFailure) {
      outcome = 'FAIL';
      detail = installFailure[0];
    }

    // Spot-check only in SINGLE mode: the concurrent probes do not all
    // need to do it, and overload state can poison the terminal.
    if (outcome === 'SUCCESS' && SINGLE) {
      spotChecks = {};
      for (const pkg of SPOT_CHECK) {
        try {
          const r = await t.run(
            `cat /home/user/Markflow/node_modules/${pkg}/package.json | head -3`,
            30_000,
          );
          spotChecks[pkg] = new RegExp(`"name"\\s*:\\s*"${pkg}"`).test(r.output);
        } catch (e) {
          spotChecks[pkg] = false;
        }
      }
    }
  } catch (e) {
    // A closed terminal is not an install timeout. Keep the driver's
    // actual reason (including close code and tail) for every phase, even
    // a failed mint or WebSocket handshake, without abandoning the peers.
    outcome = phase === 'clone' ? 'CLONE_FAIL' : 'ERROR';
    detail = String(e?.message ?? e);
    if (t) installOutput = stripAnsi(t.buf);
  } finally {
    elapsedMs = Date.now() - startedAt;
    if (t) await t.close();
  }

  const dispatchMatch = installOutput.match(/Dispatching (\d+) packages across (\d+) shards/);
  const resolvedMatch = installOutput.match(/Resolved (\d+) packages/);
  const addedMatch = installOutput.match(/added (\d+) packages \((\d+) files\)/);
  const overloadCount = (installOutput.match(/Durable Object is overloaded/g) || []).length;

  return {
    idx, sid, outcome, phase, detail, elapsedMs,
    dispatched: dispatchMatch ? { specs: parseInt(dispatchMatch[1], 10), shards: parseInt(dispatchMatch[2], 10) } : null,
    resolved: resolvedMatch ? parseInt(resolvedMatch[1], 10) : 0,
    added: addedMatch ? { count: parseInt(addedMatch[1], 10), files: parseInt(addedMatch[2], 10) } : null,
    overloads: overloadCount,
    spotChecks,
  };
}

const t0 = Date.now();
const promises = Array.from({ length: CONCURRENT }, (_, i) => attempt(i));
const results = await Promise.all(promises);
const elapsedTotal = Date.now() - t0;

function failureDescription(r) {
  return `[${r.idx}] ${r.outcome} phase=${r.phase} elapsed=${(r.elapsedMs / 1000).toFixed(1)}s sid=${r.sid ?? 'unminted'} reason=${JSON.stringify(r.detail)}`;
}

console.log(`\nResults (total elapsed ${(elapsedTotal / 1000).toFixed(1)}s):`);
for (const r of results) {
  if (r.outcome === 'SUCCESS') {
    console.log(`  [${r.idx}] SUCCESS elapsed=${(r.elapsedMs / 1000).toFixed(1)}s added=${r.added?.count}/${r.resolved} files=${r.added?.files} shards=${r.dispatched?.shards}`);
  } else {
    console.log(`  ${failureDescription(r)} overloads=${r.overloads}`);
  }
}

const successes = results.filter((r) => r.outcome === 'SUCCESS');
const failures = results.filter((r) => r.outcome !== 'SUCCESS');
const successRate = successes.length / results.length;

console.log(`\nsuccess=${successes.length}/${results.length} (${(successRate * 100).toFixed(0)}%)`);

if (SINGLE) {
  // SINGLE-mode assertions: one session, full assertions.
  const r = results[0];
  a.check('single session: outcome SUCCESS', r.outcome === 'SUCCESS', failureDescription(r));
  a.check('single session: resolver finds 600+ packages', r.resolved >= 600, `resolved=${r.resolved}`);
  a.check('single session: added count == resolved count', r.added?.count === r.resolved && r.resolved > 0, `added=${r.added?.count} resolved=${r.resolved}`);
  a.check('single session: zero overload errors', r.overloads === 0, `overloads=${r.overloads}`);
  for (const pkg of SPOT_CHECK) {
    a.check(`single session: spot-check ${pkg}`, r.spotChecks?.[pkg] === true, '');
  }
} else {
  // CONCURRENT-mode assertions: tolerate at most 1/N transients.
  // The bug under reproduction: ≥ 25% sessions hit batch-fanout abort.
  // Post-fix target: ≥ (N-1)/N sessions succeed.
  const maxFailures = Math.max(1, Math.floor(CONCURRENT * 0.1));
  a.check(
    `concurrent N=${CONCURRENT}: success rate ≥ ${((CONCURRENT - maxFailures) / CONCURRENT * 100).toFixed(0)}%`,
    successes.length >= CONCURRENT - maxFailures,
    `${successes.length}/${CONCURRENT} succeeded; failures: ${failures.map(failureDescription).join('; ')}`,
  );
  // No batch-fanout aborts at all.
  const batchAborts = results.filter((r) => r.outcome === 'BATCH_FANOUT_ABORT');
  a.check(
    `concurrent N=${CONCURRENT}: zero [batch-fanout] aborts`,
    batchAborts.length === 0,
    `${batchAborts.length} sessions hit batch-fanout abort`,
  );
}

const s = a.summary();
process.exit(s.fail === 0 ? 0 : 1);
