#!/usr/bin/env bun
// A resident process whose facet fails to start says which facet, which
// process and what the platform did, to the user and in the session's log.
//
// Cloudflare reports a facet it reset while starting as "internal error;
// reference = <id>", with durableObjectReset set and nothing else. That text
// alone named neither the process nor the facet ("long-running node boot
// failed: internal error; reference = rt37uhceu8hlrdg0l0sbn6i6"), and the
// session logged nothing.

import assert from 'node:assert/strict';
import { processes } from '../../packages/fabric/src/workerd-facet-host.ts';

const reset = Object.assign(new Error('internal error; reference = rt37uhceu8hlrdg0l0sbn6i6'), { durableObjectReset: true });
const plain = new Error('internal error; reference = oc9dos10t18fer6v7j6rp9i8');

function makeCtx(failure) {
  return {
    id: { toString: () => 'named-failures' },
    storage: { async get() { return undefined; }, async put() {} },
    facets: {
      get() {
        return {
          async startProcess() { throw failure; },
          async handleHttpRequest() { return new Response('ok'); },
        };
      },
      abort() {},
      delete() {},
    },
  };
}

const env = { LOADER: { get: () => ({ getDurableObjectClass: () => class {} }) } };

async function failedStart(failure, pid) {
  const logged = [];
  const consoleError = console.error;
  console.error = (...args) => { logged.push(args.map(String).join(' ')); };
  try {
    const facet = processes(makeCtx(failure), env).spawn(
      () => ({}),
      { doId: 'named-failures', pid, writerId: `w${pid}` },
      { pid, writerId: `w${pid}`, startArgs: {}, boot: { kind: 'code', code: {} } },
    );
    const error = await facet.started.then(() => null, (e) => e);
    assert.ok(error instanceof Error, 'the start fails');
    return { error, logged, name: facet.name };
  } finally {
    console.error = consoleError;
  }
}

// A reset names the facet, the process, and the reset, and keeps the platform's reference.
{
  const { error, logged, name } = await failedStart(reset, 1000003);
  assert.equal(name, 'proc-slot-0');
  assert.match(error.message, /proc-slot-0/);
  assert.match(error.message, /process 1000003/);
  assert.match(error.message, /reset/);
  assert.match(error.message, /rt37uhceu8hlrdg0l0sbn6i6/);
  assert.equal(error.cause, reset, 'the platform error is the cause');
  assert.equal(logged.length, 1, `one session-log line: ${JSON.stringify(logged)}`);
  assert.match(logged[0], /proc-slot-0/);
  assert.match(logged[0], /1000003/);
  assert.match(logged[0], /rt37uhceu8hlrdg0l0sbn6i6/);
}

// An internal error without a reset is named the same way, without claiming one.
{
  const { error, logged } = await failedStart(plain, 1000004);
  assert.match(error.message, /proc-slot-0/);
  assert.match(error.message, /process 1000004/);
  assert.doesNotMatch(error.message, /reset/);
  assert.match(error.message, /oc9dos10t18fer6v7j6rp9i8/);
  assert.equal(logged.length, 1);
}

console.log('resident-start-failure-named: ok');
