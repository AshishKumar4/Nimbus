#!/usr/bin/env bun
// A session has one build (SES-1): an SDK call, a cold shell upgrade and the
// frame of a socket that woke the instance, arriving while the session is
// being built (here: held in its filesystem recall), wait on that build
// instead of each starting one that replaces the first's terminal,
// workspace and shell process under it. A build that fails fails every
// caller waiting on it, and the next caller starts a new one.
//
// Through the real session/init.ts initSession, on a host whose build is
// held at seedFilesystem and then fails (the rest of a build needs a Durable
// Object). Red before: each caller started its own build.
import assert from 'node:assert/strict';
import { importWorkerBundle } from './lib/worker-bundle.mjs';
import { SessionProcessSupervisor } from '../../packages/core/src/runtime/session-process-supervisor.ts';

const { initSession } = await importWorkerBundle({ 'packages/worker/src/session/init.ts': ['initSession'] });

function gate() {
  let release;
  const promise = new Promise((resolve) => { release = resolve; });
  return { promise, release };
}

function heldHost() {
  const held = gate();
  const host = {
    builds: 0,
    building: null,
    shell: null,
    terminal: null,
    kernel: null,
    sqliteFs: { as: () => ({}) },
    processes: new SessionProcessSupervisor(),
    ensureSqliteFs() { this.builds++; },
    ensureFacetManager() {},
    async seedFilesystem() {
      await held.promise;
      throw new Error('the rest of the build needs a Durable Object');
    },
  };
  return { host, release: held.release };
}

const socket = () => ({ readyState: 1, send() {}, close() {} });

{
  const { host, release } = heldHost();
  const callers = [
    initSession(host, null),
    initSession(host, socket()),
    initSession(host, socket(), { resume: 'wake' }),
  ];
  await new Promise((resolve) => setTimeout(resolve, 10));
  assert.equal(host.builds, 1, 'one build for every caller that came while it ran');
  release();
  const outcomes = await Promise.allSettled(callers);
  assert.deepEqual(outcomes.map((o) => o.status), ['rejected', 'rejected', 'rejected'], 'the build\'s failure is every waiting caller\'s');
  assert.equal(host.building, null, 'a failed build leaves no build in flight');

  const next = initSession(host, null).catch(() => {});
  await new Promise((resolve) => setTimeout(resolve, 10));
  assert.equal(host.builds, 2, 'the next caller after a failure starts a new build');
  await next;
}

// A socket that woke the instance and comes during another caller's build
// (an SDK call's, which does not wait for the login files) is answered once
// the shell's login files have run, as a wake's own build answers it: its
// frame is delivered when initSession returns.
{
  const build = gate();
  const shellStart = gate();
  const sent = [];
  const ws = { readyState: 1, send: (frame) => sent.push(JSON.parse(frame).type), close() {} };
  const host = {
    building: build.promise,
    shellStarted: shellStart.promise,
    shell: { announcePrompt() {} },
    terminal: { ws: null, attach(socket) { this.ws = socket; }, replay() {} },
    ctx: {},
  };
  let answered = false;
  const woke = initSession(host, ws, { resume: 'wake' }).then(() => { answered = true; });
  build.release();
  await new Promise((resolve) => setTimeout(resolve, 10));
  assert.equal(answered, false, 'a wake joining a build waits for the shell\'s login files');
  assert.deepEqual(sent, [], 'and is not told ready before them');
  shellStart.release();
  await woke;
  assert.equal(host.terminal.ws, ws, 'the woken socket has the terminal');
  assert.deepEqual(sent, ['ready'], 'it is told ready once the shell has started');
}

// The same, for a socket that already had the terminal (a later frame of it
// attached it mid-build): it still waits for the login files, and is not
// told ready again.
{
  const build = gate();
  const shellStart = gate();
  const sent = [];
  const ws = { readyState: 1, send: (frame) => sent.push(JSON.parse(frame).type), close() {} };
  const host = {
    building: build.promise,
    shellStarted: shellStart.promise,
    shell: { announcePrompt() {} },
    terminal: { ws, attach() { throw new Error('attached again'); }, replay() {} },
    ctx: {},
  };
  let answered = false;
  const woke = initSession(host, ws, { resume: 'wake' }).then(() => { answered = true; });
  build.release();
  await new Promise((resolve) => setTimeout(resolve, 10));
  assert.equal(answered, false, 'an attached wake joining a build still waits for the login files');
  shellStart.release();
  await woke;
  assert.deepEqual(sent, [], 'and is not told ready by the join');
}

// A socket that is not a wake's, joining a build, is told ready once.
{
  const build = gate();
  const sent = [];
  const ws = { readyState: 1, send: (frame) => sent.push(JSON.parse(frame).type), close() {} };
  let resumed = 0;
  const host = {
    building: build.promise,
    shellStarted: Promise.resolve(),
    shell: { resumePrompt() { resumed++; } },
    terminal: { ws: null, attach(socket) { this.ws = socket; }, replay() {} },
    ctx: {},
    _b4Phase: null,
    _b4WarmJoinCount: 0,
    _b4PhaseRing: [],
  };
  const joined = initSession(host, ws);
  build.release();
  await joined;
  assert.deepEqual(sent, ['ready'], 'a joined socket is told ready exactly once');
  assert.equal(resumed, 1, 'and its shell paints a prompt only as its screen needs one');
}

console.log('session-init-one-owner: ok');
