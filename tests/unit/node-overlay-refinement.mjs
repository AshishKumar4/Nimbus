#!/usr/bin/env bun
// @tier slow — long; CI median 68 s wall, 66 s CPU, 0.1 GiB peak (6 runs, 2026-10-06)
// Refinement bridge for Nimbus.Coherence.Store.overlay_no_stale
// (lean/fixtures/node-overlay.json). A resident process writes and unlinks
// files whose write-backs are held (not committed at the authority) until a
// flush, while peers commit to the same paths and barriers run. Every
// readFileSync at a resumption must return one of the values the model
// allows: the process's own pending effect, else a value the authority held
// at or after the last barrier.

import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import {
  createAuthority,
  facetSupervisor,
  launchResident,
  runScenarios,
  sleep,
} from './lib/resident-body.mjs';

const fixture = JSON.parse(readFileSync(new URL('../../lean/fixtures/node-overlay.json', import.meta.url), 'utf8'));
assert.equal(fixture.fixture, 'node-overlay');
assert.ok(fixture.cases.length > 0);

const APP = 'home/user/app';
const at = (path) => APP + path;

const PROGRAM = `
const fs = require("fs");
globalThis.__probe = {
  fs,
  read: (p) => { try { return fs.readFileSync(p, "utf8"); } catch (e) { return e.code === "ENOENT" ? "ENOENT" : "ERR:" + e.code; } },
  resume: () => new Promise((resolve) => setTimeout(resolve, 0)),
};
require("http").createServer((q, s) => s.end("up")).listen(3000);
`;

/** Write-back ops the harness holds until a flush: the request does not reach the authority before then. */
const WRITE_BACKS = new Set(['writeFile', 'writeRange', 'truncate', 'unlink', 'remove', 'fsAppend']);

await runScenarios(import.meta.path, Object.fromEntries(fixture.cases.map((testCase, index) => [`node-overlay #${index}`, async () => {
  const authority = createAuthority();
  authority.kfs.mkdir(APP, { recursive: true, mode: 0o755 });
  const held = [];
  let forwardOp = null;
  const overrides = {};
  for (const name of WRITE_BACKS) {
    overrides[name] = (...args) => new Promise((resolve, reject) => {
      held.push(() => forwardOp(name, args).then(resolve, reject));
    });
  }
  const { supervisor, forward } = facetSupervisor(authority, overrides);
  forwardOp = forward;
  await launchResident({ authority, program: PROGRAM, env: { SUPERVISOR: supervisor }, cursor: authority.cursor() });
  const probe = globalThis.__probe;
  // Every write-back the process holds, committed and acknowledged in order,
  // each before the next is sent. The process debounces its write-backs, so
  // the flush starts them itself (the RELEASE barrier the shims run ahead of
  // egress) and lets each one through as it is issued.
  const flush = async () => {
    let done = false;
    const released = globalThis.__nimbusVfsReleaseBarrier().finally(() => { done = true; });
    while (!done || held.length > 0) {
      if (held.length > 0) await held.shift()();
      else await sleep(0);
    }
    await released;
  };
  for (const [s, step] of testCase.steps.entries()) {
    const where = `step ${s} ${JSON.stringify(step)}`;
    if (step.auth === 'write') authority.kfs.writeFile(at(step.path), step.bytes);
    else if (step.auth === 'rm') authority.kfs.unlink(at(step.path));
    else if (step.facet === 'write') probe.fs.writeFileSync('/' + at(step.path), step.bytes);
    else if (step.facet === 'rm') probe.fs.unlinkSync('/' + at(step.path));
    else if (step.facet === 'flush') await flush();
    else if (step.facet === 'acquire') {
      await Promise.race([
        probe.resume(),
        sleep(5_000).then(() => { throw new Error(`${where}: the barrier blocked`); }),
      ]);
    } else if (step.facet === 'read') {
      const got = probe.read('/' + at(step.path));
      assert.ok(step.expectAnyOf.includes(got), `${where}: read ${JSON.stringify(got)}`);
    } else throw new Error(`unknown step ${where}`);
  }
  await flush();
}])));
