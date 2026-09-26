#!/usr/bin/env bun
// The wasm bash's pipe rules refine FormalModelsLane's Nimbus.Runtime.Pipes.
//
// The fixture, lean/fixtures/pipes.json on work/formal-models (the lane emits
// it once this test is green), is 160 traces the model's scheduler produced:
// scripted processes on a host with JSPI or without it (bash processes and
// WASI children), each step a write, read, close, fork or exit and what the
// model says it does. This test replays each trace in its own order and
// asks the runtime's own decision functions (packages/core/src/runtime/bash
// /pipe-rules.ts, which the runner calls for every pipe write and read)
// what each step does. The bookkeeping (queued bytes, open ends, who is
// suspended) is the model's, kept here. Every step's outcome must match, as
// must each case's final exit statuses, per-pipe accounting and error.
//
// Cases that ignore SIGPIPE are skipped with the fixture's own reason:
// bash.async.wasm exposes no signal disposition to the host.

import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';

import { decideRead, decideWrite, readerStops } from '../../packages/core/src/runtime/bash/pipe-rules.ts';

const FIXTURE = 'lean/fixtures/pipes.json';
const repo = resolve(import.meta.dirname, '../..');
// In the tree once FormalModelsLane emits it; until then, its generated copy.
const candidates = [join(repo, FIXTURE), join(process.env.HOME ?? '', '.cache/nimbus-verify/formal/pipes.json')];
const path = candidates.find((p) => existsSync(p));
if (!path) {
  console.log(`pipes-refinement: SKIPPED (${FIXTURE} not present)`);
  process.exit(0);
}
const fixture = JSON.parse(readFileSync(path, 'utf8'));
assert.equal(fixture.fixture, 'pipes');

const SIGPIPE_STATUS = 128 + 13;

function replay(c) {
  const pipes = Array.from({ length: c.pipes }, () => ({ queued: 0, readers: 0, writers: 0, read: 0, discarded: 0 }));
  const procs = new Map();
  for (const p of c.procs) {
    const ends = [...p.reads.map((pipe) => ({ pipe, end: 'r' })), ...p.writes.map((pipe) => ({ pipe, end: 'w' }))];
    for (const { pipe, end } of ends) pipes[pipe][end === 'r' ? 'readers' : 'writers']++;
    // One not started (a fork's child to be) is not alive until forked; if it
    // never is, the model reports it as 0.
    procs.set(p.pid, { ...p, ends, alive: p.started, status: p.started ? null : 0, pending: null });
  }
  const suspended = [];
  let error = null;

  const drop = (proc, { pipe, end }) => {
    const pp = pipes[pipe];
    if (end === 'r') {
      pp.readers--;
      // The last read end's close: what is in flight will never be read.
      if (pp.readers === 0) { pp.discarded += pp.queued; pp.queued = 0; }
    } else pp.writers--;
    proc.ends = proc.ends.filter((e) => !(e.pipe === pipe && e.end === end));
  };
  const finish = (proc, status) => {
    for (const e of [...proc.ends]) drop(proc, e);
    proc.alive = false;
    proc.status = status;
    proc.pending = null;
  };
  const writersOf = (pipe) => [...procs.values()].filter((p) => p.alive && p.ends.some((e) => e.pipe === pipe && e.end === 'w')).map((p) => p.pid);
  const stop = (message) => {
    error = message;
    for (const proc of procs.values()) if (proc.alive) finish(proc, 1);
    return { aborted: message };
  };

  const decide = (proc, op) => {
    if (op.write) {
      const { pipe, n } = op.write;
      const decision = decideWrite(pipes[pipe], n, proc.host, c.C, c.B);
      if (decision === 'sigpipe') { finish(proc, SIGPIPE_STATUS); return 'sigpipe'; }
      if (decision === 'park') { proc.pending = op; return 'parked'; }
      if (decision === 'nest') { proc.pending = op; suspended.push(proc.pid); return 'suspended'; }
      pipes[pipe].queued += n;
      return { wrote: n };
    }
    if (op.read) {
      const { pipe, n } = op.read;
      const decision = decideRead(pipes[pipe], proc.host, proc.kind);
      if (decision === 'take') {
        const k = Math.min(n, pipes[pipe].queued);
        pipes[pipe].queued -= k;
        pipes[pipe].read += k;
        return { read: k };
      }
      if (decision === 'eof') return 'eof';
      if (decision === 'park') { proc.pending = op; return 'parked'; }
      if (readerStops(writersOf(pipe), new Set(suspended))) return stop('aborted');
      proc.pending = op;
      suspended.push(proc.pid);
      return 'suspended';
    }
    throw new Error(`unknown op ${JSON.stringify(op)}`);
  };

  c.steps.forEach((step, i) => {
    const where = `${c.name}: step ${i} (pid ${step.pid} ${JSON.stringify(step.op)})`;
    if (error) assert.fail(`${where}: a step after the command stopped`);
    if (step.op === 'stuck') {
      assert.ok(suspended.length > 0, `${where}: stuck with no suspended frame`);
      assert.ok('aborted' in step.expect, `${where}: stuck without an abort`);
      stop('aborted');
      return;
    }
    const proc = procs.get(step.pid);
    assert.ok(proc?.alive, `${where}: the process is not alive`);
    if (step.resumed) {
      assert.ok(proc.pending, `${where}: resumed with nothing pending`);
      assert.deepEqual(step.op, proc.pending, `${where}: resumed a different op`);
      const at = suspended.lastIndexOf(proc.pid);
      if (at >= 0) {
        // A suspended frame resumes only from the top of the stack.
        assert.equal(at, suspended.length - 1, `${where}: resumed from beneath the top`);
        suspended.pop();
      }
      proc.pending = null;
    } else {
      assert.equal(proc.pending, null, `${where}: a new op while one is pending`);
    }
    let got;
    if (step.op === 'end') { finish(proc, 0); got = { exited: 0 }; }
    else if (step.op.exit !== undefined) { finish(proc, step.op.exit); got = { exited: step.op.exit }; }
    else if (step.op.close) { drop(proc, step.op.close); got = 'closed'; }
    else if (step.op.fork) {
      const child = procs.get(step.op.fork.child);
      assert.ok(child, `${where}: no such child`);
      child.ends = proc.ends.map((e) => ({ ...e }));
      for (const { pipe, end } of child.ends) pipes[pipe][end === 'r' ? 'readers' : 'writers']++;
      child.alive = true;
      child.status = null;
      got = { forked: step.op.fork.child };
    } else got = decide(proc, step.op);
    const want = typeof step.expect === 'object' && 'aborted' in step.expect ? { aborted: 'aborted' } : step.expect;
    assert.deepEqual(got, want, where);
  });

  const final = c.final;
  assert.deepEqual(c.procs.map((p) => procs.get(p.pid).status ?? null), final.status, `${c.name}: exit statuses`);
  assert.deepEqual(pipes.map(({ queued, read, discarded }) => ({ inFlight: queued, read, discarded })), final.pipes, `${c.name}: pipes`);
  assert.equal(error !== null, final.error !== null, `${c.name}: whether the command stopped`);
}

let replayed = 0;
let skipped = 0;
for (const c of fixture.cases) {
  if (c.untestable) { skipped++; continue; }
  replay(c);
  replayed++;
}
console.log(`pipes-refinement: ${replayed} traces replay step for step through pipe-rules (${skipped} skipped: ${fixture.cases.find((c) => c.untestable)?.untestable ?? 'none'})`);
