#!/usr/bin/env bun
// process.exit ends the program, as it does in Node: no timer or interval of
// the program fires afterwards and nothing it writes afterwards is relayed,
// while Nimbus's own post-exit work (the drain, trace and residency reports,
// the exit report) still happens. 'exit' listeners run exactly once,
// synchronously, before the stop, including on a natural end.
//
// Seen on staging (frameworks/remix-real): create-react-router exited 1 and
// its spinner interval kept writing "Template copying..." after the exit
// report, past the shell's prompt.
//
// Runs the real generated one-shot facet module against a recording
// supervisor.

import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { generateEntrypointCode } from '../../packages/worker/src/facets/manager.ts';
import { generateShimsCode } from '../../packages/worker/src/runtime/node-shims.ts';
import { nodeFacetSources } from './lib/node-facet-sources.mjs';

// The generated module installs its own globals (process, console, timers).
const realProcess = globalThis.process;
const realSetTimeout = globalThis.setTimeout;
const sleep = (ms) => new Promise((resolve) => realSetTimeout(resolve, ms));
const dir = mkdtempSync(join(tmpdir(), 'facet-exit-'));
const sources = nodeFacetSources(generateShimsCode());
let seq = 0;

async function run(program, state = { bundle: {}, manifest: {}, metadata: {} }) {
  const generated = await generateEntrypointCode(program, state, false, sources);
  const file = join(dir, `entry-${seq++}.mjs`);
  writeFileSync(file, generated.code);
  const mod = await import(file);
  const events = [];
  const text = (bytes) => new TextDecoder().decode(bytes);
  const supervisor = {
    stdout: async (b) => { events.push(['stdout', text(b)]); },
    stderr: async (b) => { events.push(['stderr', text(b)]); },
    reportExit: async (code) => { events.push(['exit', code]); },
  };
  const request = new Request('http://facet/', {
    method: 'POST',
    body: JSON.stringify({
      argv: [], env: {}, cwd: '/home/user', filename: '/home/user/p.js', dirname: '/home/user',
      stdin: '', captureOutput: false, cred: { uid: 1000, gid: 1000, groups: [1000], umask: 0o022 },
    }),
  });
  const body = await (await mod.default.fetch(request, { SUPERVISOR: supervisor })).json();
  // Long enough for a surviving 20 ms interval to fire several more times.
  await sleep(250);
  return { body, events };
}

const EXIT_IN_TIMER = (code) => `setTimeout(() => { try { process.exit(${code}); } catch (e) { if (!/process\\.exit/.test(e.message)) throw e; } }, 110);`;

// ── interval + process.exit(1) ───────────────────────────────────────────
{
  const { body, events } = await run(
    'let n = 0; setInterval(() => process.stdout.write("TICK" + (n++) + "\\n"), 20);'
    + 'process.on("exit", (c) => console.log("EXIT-HANDLER " + c));'
    + EXIT_IN_TIMER(1),
  );
  assert.equal(body.exitCode, 1);
  const exitAt = events.findIndex(([kind]) => kind === 'exit');
  assert.ok(exitAt > 0, JSON.stringify(events));
  assert.equal(exitAt, events.length - 1, `nothing after the exit report: ${JSON.stringify(events.slice(exitAt))}`);
  assert.deepEqual(events[exitAt - 1], ['stdout', 'EXIT-HANDLER 1\n'], 'the exit listener ran, before the stop');
  assert.equal(events.filter(([, d]) => /EXIT-HANDLER/.test(String(d))).length, 1);
  assert.ok(events.some(([, d]) => d === 'TICK0\n'), 'the interval did run before the exit');
}

// ── a listener that exits again: once, and its code wins ─────────────────
{
  const { body, events } = await run(
    'process.on("exit", (c) => { console.log("H " + c); process.exit(2); });' + EXIT_IN_TIMER(1),
  );
  assert.equal(events.filter(([, d]) => /^H /.test(String(d))).length, 1, JSON.stringify(events));
  assert.equal(body.exitCode, 2);
}

// ── a natural end still emits 'exit', once ───────────────────────────────
{
  const { body, events } = await run('process.on("exit", (c) => console.log("NATURAL " + c)); console.log("done");');
  assert.equal(body.exitCode, 0);
  assert.deepEqual(events.filter(([kind]) => kind === 'stdout').map(([, d]) => d), ['done\n', 'NATURAL 0\n']);
}

// ── Nimbus's own reports still arrive after the stop ─────────────────────
{
  const { body, events } = await run('throw new Error("boom-trace");');
  assert.equal(body.exitCode, 1);
  assert.ok(events.some(([kind, d]) => kind === 'stderr' && /boom-trace/.test(d)), `the trace arrives: ${JSON.stringify(events)}`);
}
{
  // A sync read of a file the launch never staged: the residency report is
  // written after process.exit and must still be relayed.
  const { body, events } = await run(
    'try { require("fs").readFileSync("/home/user/unstaged.txt", "utf8"); } catch {}' + EXIT_IN_TIMER(0),
    { bundle: {}, manifest: { 'home/user': ['unstaged.txt'] }, metadata: { 'home/user/unstaged.txt': { type: 'file', size: 5, mode: 0o644, uid: 1000, gid: 1000 } } },
  );
  assert.ok(events.some(([kind, d]) => kind === 'stderr' && /unstaged\.txt/.test(d)), `the residency report arrives: ${JSON.stringify(events)}`);
  assert.equal(body.exitCode, 1);
}

realProcess.stdout.write('facet-exit-stops-program: ok\n');
realProcess.exit(0);
