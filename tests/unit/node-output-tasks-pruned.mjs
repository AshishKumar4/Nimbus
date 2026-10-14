#!/usr/bin/env bun
// A node process keeps only the output it has not delivered yet.
//
// Each output batch is a task in the process's outstanding-I/O registry: an
// exit, or a resident's HTTP boundary, waits for what is in it. A task that
// stayed after it settled was kept until such a boundary: a server that logs
// with no HTTP traffic, or a long one-shot run, held every write it ever made.
// Red before: each written line was a promise the process held to the end.
//
// The boundaries still wait for what is outstanding: output whose answer the
// session holds back is delivered before the one-shot ends, and before the
// resident answers a request.
//
// Runs the real generated bodies of both lifetimes, each in its own child.

import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { heapStats } from 'bun:jsc';
import { generateEntrypointCode } from '../../packages/worker/src/facets/manager.ts';
import { generateShimsCode } from '../../packages/worker/src/runtime/node-shims.ts';
import { nodeFacetSources } from './lib/node-facet-sources.mjs';
import { generatedModuleSet, writeModuleSet } from './lib/module-map-bundle.mjs';
import { CRED, createAuthority, facetSupervisor, launchResident, runScenarios, sleep, until } from './lib/resident-body.mjs';

/** Lines each burst writes, alternating streams so that each is a batch, and a task, of its own. */
const LINES = 4000;
/** What the process may still hold past the bursts: nothing per line. */
const SLACK = LINES / 10;

// What the program hands the test: a burst of output, and its end.
const PROGRAM = `
const keep = setTimeout(() => {}, 600000);
globalThis.__probe = {
  burst(n) { for (let i = 0; i < n / 2; i++) { process.stdout.write("o\\n"); process.stderr.write("e\\n"); } },
  end() { clearTimeout(keep); },
};
`;
const SERVER = `${PROGRAM}require("http").createServer((q, s) => s.end("up")).listen(3000);\n`;

/** The session's side: its answers to output, which the test can hold back. */
function outputSession(authority) {
  const lines = { stdout: 0, stderr: 0 };
  let held = null;
  const answer = (name) => async (bytes) => {
    lines[name] += new TextDecoder().decode(bytes).split('\n').length - 1;
    if (held !== null) await held.promise;
  };
  const { supervisor } = facetSupervisor(authority, { stdout: answer('stdout'), stderr: answer('stderr') });
  return {
    supervisor,
    delivered: () => lines.stdout + lines.stderr,
    hold() { held = Promise.withResolvers(); },
    release() { held?.resolve(); held = null; },
  };
}

/** Promises alive after a full collection. */
function livePromises() {
  Bun.gc(true);
  const count = heapStats().objectTypeCounts.Promise;
  assert.equal(typeof count, 'number', `heapStats names no Promise count: ${Object.keys(heapStats().objectTypeCounts).filter((k) => /romise/.test(k))}`);
  return count;
}

/** `burst` of LINES lines delivered and settled, and the promises alive after it. */
async function burstAndCount(probe, session) {
  const from = session.delivered();
  probe.burst(LINES);
  await until(() => session.delivered() >= from + LINES, `${LINES} lines delivered`, 30_000);
  await sleep(50);
  return livePromises();
}

/** A burst's worth of lines the process keeps no trace of once they are delivered. */
async function assertBounded(probe, session, lifetime) {
  // The first burst warms what the output path makes once.
  const before = await burstAndCount(probe, session);
  const after = await burstAndCount(probe, session);
  assert.ok(after - before < SLACK,
    `the ${lifetime} held ${after - before} more promises after ${LINES} more delivered lines (at most ${SLACK})`);
}

await runScenarios(import.meta.filename, {
  async oneShot() {
    const dir = mkdtempSync(join(tmpdir(), 'output-tasks-'));
    process.on('exit', () => rmSync(dir, { recursive: true, force: true }));
    const generated = await generateEntrypointCode(PROGRAM, { bundle: {} }, false, nodeFacetSources(generateShimsCode()));
    const mod = await import(writeModuleSet(join(dir, 'entry'), generatedModuleSet(generated, 'runner.mjs'), 'runner.mjs'));
    const authority = createAuthority();
    const session = outputSession(authority);
    const request = new Request('http://facet/', {
      method: 'POST',
      body: JSON.stringify({
        argv: [], env: {}, cwd: '/home/user', filename: '/home/user/p.js', dirname: '/home/user',
        stdin: '', captureOutput: false, cred: CRED,
      }),
    });
    let ended = false;
    const run = mod.default.fetch(request, { SUPERVISOR: session.supervisor }).then((response) => { ended = true; return response.json(); });
    await until(() => globalThis.__probe !== undefined, 'the program to start', 30_000);
    const probe = globalThis.__probe;
    await assertBounded(probe, session, 'one-shot');

    // Its end waits for output the session has not answered.
    session.hold();
    const from = session.delivered();
    probe.burst(10);
    probe.end();
    await sleep(200);
    assert.equal(ended, false, 'the run ended before the session answered its output');
    session.release();
    const body = await run;
    assert.equal(body.exitCode, 0, JSON.stringify(body));
    assert.equal(session.delivered(), from + 10, 'every line written before the end was delivered');
  },

  async resident() {
    const authority = createAuthority();
    authority.kfs.mkdir('home/user/app', { recursive: true, mode: 0o755 });
    const session = outputSession(authority);
    const { proc } = await launchResident({ authority, program: SERVER, env: { SUPERVISOR: session.supervisor }, cursor: authority.cursor() });
    const probe = globalThis.__probe;
    await assertBounded(probe, session, 'resident');

    // A request is answered once the output written before it is delivered.
    session.hold();
    const from = session.delivered();
    probe.burst(10);
    let answered = false;
    const response = proc.fetch(new Request('http://facet/', { headers: { 'X-Nimbus-Port': '3000' } })).then((r) => { answered = true; return r; });
    await sleep(200);
    assert.equal(answered, false, 'the request was answered before the session answered the output written before it');
    session.release();
    assert.equal(await (await response).text(), 'up');
    assert.equal(session.delivered(), from + 10, 'every line written before the request was delivered');
  },
});

process.stdout.write('node-output-tasks-pruned: ok\n');
