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
import { initSession } from '../../packages/worker/src/session/init.ts';

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

console.log('session-init-one-owner: ok');
