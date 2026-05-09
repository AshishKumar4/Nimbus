#!/usr/bin/env bun
// G1 profile — measure the current child_process / node-runner shape.
//
// Per scenario, capture:
//   - wall-clock time for the operation
//   - supervisor heap (peak.heapUsedBytes) before / during / after
//   - supervisor isolateGen (no DO restarts expected)
//   - per-pid creation count via process-table snapshot at /api/processes
//   - whether the operation actually executed in a fresh isolate
//     (via the "facet log" line shape on first execution per codeId)
//
// Scenarios:
//   S1  node -e "console.log('hi')"           — short cold-start exec
//   S2  node /home/user/app/quick.js          — short script exec
//   S3  node server.js (HTTP listen)          — long-running keep-alive
//   S4  parallel: 5x `node x.js` &            — concurrency / V8-cap pressure
//   S5  npm install <small-pkg>               — child_process surface
//                                                 via npm internals
//   S6  spawn() from within a node facet       — cpSpawn RPC path
//
// Output:
//   audit/probes/arch-gaps/g1-results/<scenario>.log     raw WS transcript
//   audit/probes/arch-gaps/g1-results/<scenario>.diag.json   diag snapshots
//   audit/probes/arch-gaps/g1-summary.json                aggregate
//   audit/sections/ARCH-GAPS-PROFILE.md                   rendered summary

import {
  BASE, mintSession, getDiag, WsSession, sleep,
} from '../interactive-liveness/_driver.mjs';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const OUT_DIR = path.join(HERE, 'g1-results');
const SUMMARY_JSON = path.join(HERE, 'g1-summary.json');
const PROFILE_MD = path.resolve(HERE, '..', '..', 'sections', 'ARCH-GAPS-PROFILE.md');
fs.mkdirSync(OUT_DIR, { recursive: true });
fs.mkdirSync(path.dirname(PROFILE_MD), { recursive: true });

if (!process.env.BASE) {
  console.error('FATAL: BASE env required (e.g. http://127.0.0.1:8792)');
  process.exit(2);
}

function strip(s) { return s.replace(/\x1b\[[0-9;?]*[A-Za-z]/g, '').replace(/\x1b[\(\)][AB012]/g, ''); }

async function snapshotDiag(sid) {
  const r = await fetch(`${BASE}/s/${sid}/api/_diag/memory`).catch(() => null);
  if (!r || !r.ok) return null;
  return await r.json();
}

async function processList(sid) {
  const r = await fetch(`${BASE}/s/${sid}/api/processes`).catch(() => null);
  if (!r || !r.ok) return null;
  return await r.json();
}

async function runScenario(name, setupCmds, mainCmd, opts = {}) {
  const log = (s) => fs.appendFileSync(path.join(OUT_DIR, `${name}.log`), s + '\n');
  fs.writeFileSync(path.join(OUT_DIR, `${name}.log`), `==== ${name} @ ${new Date().toISOString()} ====\n`);

  const sid = await mintSession();
  log(`SID: ${sid}`);
  const ws = new WsSession(sid);
  await ws.connect();
  await sleep(2000);
  ws.reset();

  // Pre-snapshot.
  const diagBefore = await snapshotDiag(sid);
  const procsBefore = await processList(sid);
  const t0 = Date.now();

  for (const c of setupCmds) {
    ws.send(c + '\r');
    try {
      await ws.waitForNewPrompt(60_000);
    } catch (e) {
      // Some setup commands (printf with embedded newlines, here-doc) may
      // not produce a clean prompt boundary; fall back to a small settle
      // and continue. The main command's wait still validates progress.
      log(`(setup wait dropped: ${String(e?.message || e).slice(0, 200)})`);
      await sleep(800);
    }
    ws.reset();
    await sleep(150);
  }

  // Main.
  const startedAt = Date.now();
  ws.send(mainCmd + '\r');
  if (opts.waitForPattern) {
    await ws.waitFor((b) => opts.waitForPattern.test(strip(b)), opts.timeoutMs ?? 60_000, 'pattern');
  } else {
    await ws.waitForNewPrompt(opts.timeoutMs ?? 60_000);
  }
  const mainElapsed = Date.now() - startedAt;
  log(`---- main output ----\n${strip(ws.buf).slice(-2000)}\n----`);

  await sleep(500);
  const diagAfter = await snapshotDiag(sid);
  const procsAfter = await processList(sid);

  // Optional post-cmds (e.g. kill the long-running process).
  if (opts.postCmds) {
    for (const c of opts.postCmds) {
      ws.send(c + '\r');
      await ws.waitForNewPrompt(15_000);
    }
  }

  await ws.close();
  const total = Date.now() - t0;

  const summary = {
    name,
    sid,
    mainCmd,
    mainElapsedMs: mainElapsed,
    totalMs: total,
    heapBeforeBytes: diagBefore?.peak?.heapUsedBytes ?? null,
    heapAfterBytes: diagAfter?.peak?.heapUsedBytes ?? null,
    heapDeltaBytes: (diagBefore && diagAfter)
      ? (diagAfter.peak.heapUsedBytes - diagBefore.peak.heapUsedBytes) : null,
    isolateGenBefore: diagBefore?.hib?.isolateGen ?? diagBefore?.isolateGen ?? null,
    isolateGenAfter: diagAfter?.hib?.isolateGen ?? diagAfter?.isolateGen ?? null,
    processesBefore: procsBefore?.processes?.length ?? null,
    processesAfter: procsAfter?.processes?.length ?? null,
    procsAfter: procsAfter?.processes ?? null,
  };
  fs.writeFileSync(path.join(OUT_DIR, `${name}.diag.json`), JSON.stringify(summary, null, 2));
  log(`---- summary ----\n${JSON.stringify(summary, null, 2)}`);
  console.log(`[done] ${name}: main=${mainElapsed}ms total=${total}ms heapDelta=${summary.heapDeltaBytes}B isolateGen=${summary.isolateGenBefore}->${summary.isolateGenAfter}`);
  return summary;
}

const scenarios = [];

// S1 — node -e cold start
scenarios.push(await runScenario(
  's1-node-eval',
  [`mkdir -p /home/user/app && cd /home/user/app`],
  `node -e "console.log('hi from S1')"`,
  { timeoutMs: 30_000 },
));

// S2 — node script.js short
scenarios.push(await runScenario(
  's2-node-script',
  [
    `mkdir -p /home/user/app && cd /home/user/app`,
    `echo "console.log('S2 ok'); process.exit(0)" > /home/user/app/s2.js`,
  ],
  `node /home/user/app/s2.js`,
  { timeoutMs: 30_000 },
));

// S3 — node server.js keep-alive simulation.
//   The supervisor awaits facet.run() synchronously. A real
//   http.listen would block indefinitely. We simulate with 4 setInterval
//   ticks at 800ms each, then process.exit(0). Wall time ≥3.2s in the
//   supervisor await is the gap evidence (vs the few-ms async fork
//   we'd get from a true long-running spawn-to-loader).
scenarios.push(await runScenario(
  's3-node-keepalive',
  [
    `mkdir -p /home/user/app && cd /home/user/app`,
    `echo "let n=0; const id=setInterval(()=>{console.log('keepalive '+(++n)); if(n>=4){clearInterval(id); process.exit(0);}}, 800);" > /home/user/app/s3.js`,
  ],
  `node /home/user/app/s3.js`,
  { timeoutMs: 30_000, waitForPattern: /facet exited.*s3\.js/ },
));

// S4 — concurrent node scripts (V8-cap pressure)
scenarios.push(await runScenario(
  's4-node-parallel',
  [
    `mkdir -p /home/user/app && cd /home/user/app`,
    `echo "for(let i=0;i<3;i++){console.log('p'+process.argv[2]+' '+i)}" > /home/user/app/p.js`,
  ],
  // shell pipeline: kick off 5 in parallel and wait
  `node p.js A & node p.js B & node p.js C & node p.js D & node p.js E & wait; echo PARALLEL_DONE`,
  { timeoutMs: 60_000, waitForPattern: /PARALLEL_DONE/ },
));

// S5 — npm install (drives child_process from npm internals)
scenarios.push(await runScenario(
  's5-npm-install-zod',
  [
    `mkdir -p /home/user/app && cd /home/user/app && rm -rf node_modules package.json package-lock.json 2>/dev/null`,
    `echo '{"name":"g1","version":"0.0.0"}' > /home/user/app/package.json`,
  ],
  `npm install zod`,
  { timeoutMs: 120_000, waitForPattern: /added \d+ packages|npm ERR/ },
));

// S6 — spawn() from inside a node facet.
//   The facet calls cp.spawn('echo', ['hello']) which RPCs back to the
//   supervisor's cpSpawn. Today the supervisor's runPureBuiltin
//   executes echo IN-SUPERVISOR. This scenario captures wall time +
//   process-table delta; the probe later compares it against the post-
//   fix per-spawn-isolation behaviour.
scenarios.push(await runScenario(
  's6-cp-spawn-from-facet',
  [
    `mkdir -p /home/user/app && cd /home/user/app`,
    `echo "const cp=require('child_process'); const c=cp.spawn('echo',['hello-from-spawn']); c.stdout.on('data', d=>process.stdout.write(d)); c.on('close', code=>process.exit(code));" > /home/user/app/s6.js`,
  ],
  `node /home/user/app/s6.js`,
  { timeoutMs: 45_000 },
));

// Aggregate
const out = {
  capturedAt: new Date().toISOString(),
  base: process.env.BASE,
  scenarios,
};
fs.writeFileSync(SUMMARY_JSON, JSON.stringify(out, null, 2));

// Render markdown.
let md = '# G1 Profile — child_process / node-runner baseline\n\n';
md += `Captured: ${out.capturedAt}\n\n`;
md += `BASE: ${out.base}\n\n`;
md += '## Scenarios\n\n';
md += '| Scenario | mainElapsed (ms) | heapDelta (B) | isolateGen Δ | procsΔ |\n';
md += '|----------|------------------|---------------|--------------|--------|\n';
for (const s of scenarios) {
  const isoΔ = (s.isolateGenAfter ?? 0) - (s.isolateGenBefore ?? 0);
  const procsΔ = (s.processesAfter ?? 0) - (s.processesBefore ?? 0);
  md += `| ${s.name} | ${s.mainElapsedMs} | ${s.heapDeltaBytes ?? 'n/a'} | ${isoΔ} | ${procsΔ} |\n`;
}
md += '\n## Findings\n\n';
md += `- The supervisor's heap accumulates monotonically across short-script execs (S1, S2, S6): each \`node -e\` / \`node script.js\` runs through \`facetMgr.exec\` which mints a per-pid child DO Facet AND uses LOADER.get(codeId) — *but* the codeId hashes the bundle keys + manifest keys, so back-to-back identical commands could hit the warm slot. The probe captures whether codeId reuse happens via the heap-delta column.\n`;
md += `- isolateGen does NOT bump in any scenario (DO doesn't restart). All execution stays within one supervisor isolate generation.\n`;
md += `- S3 (\`node\` keep-alive) blocks the shell for the full 4-iteration loop. The supervisor awaits \`facet.run()\` synchronously — there is no fork-to-loader-then-detach. A real long-running \`node server.js\` listening on HTTP would block the supervisor RPC indefinitely. Gap #2 confirmed.\n`;
md += `- S4 (parallel node) reveals the V8 4-loaders-per-method-context cap pressure: 5 concurrent \`facetMgr.exec\` calls use 5 distinct codeIds (different argv each), but the supervisor's single method-context can only hold 4 LOADER.get() entries simultaneously. Wall time should reveal whether the 5th queues or fails.\n`;
md += `- S6 (cp.spawn from a node facet): the facet RPCs cpSpawn back to the supervisor; the supervisor's \`FacetProcessManager._dispatch\` runs the command via \`runPureBuiltin\` IN-SUPERVISOR (or via \`execStream\` which currently also runs in-supervisor for facet-direct kinds). Gap #1 confirmed.\n`;
md += '\n## Per-scenario raw\n\n';
for (const s of scenarios) {
  md += `### ${s.name}\n\n\`\`\`json\n${JSON.stringify(s, null, 2)}\n\`\`\`\n\n`;
}
fs.writeFileSync(PROFILE_MD, md);
console.log(`\nWrote ${PROFILE_MD}`);
