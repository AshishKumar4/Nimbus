#!/usr/bin/env bun
// A command the session's own build runs (the user's login files, e.g.
// `nimbus app list` in ~/.nimbusrc) that needs the session finds it usable
// once the session's commands are registered, and does not wait on the build
// that runs it: a wake's build waits for its login files, so that wait
// would never end. An SDK call during a build waits for the same point, and
// one with no build in flight starts one and waits for it whole.
//
// Through the real NimbusSession.ensureRuntimeReady, on a session whose
// build is in flight (never ending) and whose commands are registered.
// Red before: it waited on the build itself.
import assert from 'node:assert/strict';
import { importWorkerBundle } from './lib/worker-bundle.mjs';

const { NimbusSession } = await importWorkerBundle({ 'packages/worker/src/session/nimbus-session.ts': ['NimbusSession'] });
const ensureRuntimeReady = NimbusSession.prototype.ensureRuntimeReady;
const within = (promise, ms) => Promise.race([promise.then(() => 'answered'), new Promise((resolve) => setTimeout(() => resolve('still waiting'), ms))]);

{
  let builds = 0;
  const self = {
    shell: {},
    building: new Promise(() => {}),
    usable: Promise.resolve(),
    initSession() { builds++; return this.building; },
  };
  assert.equal(await within(ensureRuntimeReady.call(self), 1_000), 'answered', 'a call during a build answers once the session is usable');
  assert.equal(builds, 0, 'and starts no build');
}
{
  const self = { shell: {}, building: new Promise(() => {}), usable: new Promise(() => {}), initSession() { return this.building; } };
  assert.equal(await within(ensureRuntimeReady.call(self), 200), 'still waiting', 'a call before the session is usable waits');
}
{
  let builds = 0;
  const self = { shell: null, building: null, usable: null, _b4Phase: null, initSession() { builds++; return Promise.resolve(); } };
  await ensureRuntimeReady.call(self);
  assert.equal(builds, 1, 'no build in flight: one is started and waited on');
  assert.equal(self._b4Phase, 'drained');
}
console.log('session-ready-during-build: ok');
