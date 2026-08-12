#!/usr/bin/env bun

import assert from 'node:assert/strict';
import { NimbusLoaderPool } from '../../packages/worker/src/loaders/loader-pool.ts';
import { classifyError } from '../../packages/core/src/observability/oom-classify.ts';

const cloneVersionError =
  'Unable to deserialize cloned data due to invalid or unsupported version';

assert.equal(classifyError(new Error(cloneVersionError)), 'clone_refused');

const loaderIds = [];
let executeCalls = 0;
const loader = {
  get(id) {
    loaderIds.push(id);
    return {
      getEntrypoint() {
        return {
          async execute() {
            executeCalls++;
            if (executeCalls === 1) throw new Error(cloneVersionError);
            return 'recovered';
          },
        };
      },
    };
  },
};

const pool = new NimbusLoaderPool(
  { LOADER: loader },
  { id: { toString: () => 'test-session-id' } },
  { omitSupervisor: true, timeoutMs: 0, retries: 0, tag: 'clone-retry-test' },
);

assert.equal(await pool.submit((value) => value, 'payload'), 'recovered');
assert.equal(executeCalls, 2);
assert.equal(loaderIds.length, 2);
assert.notEqual(loaderIds[0], loaderIds[1]);
assert.match(loaderIds[0], /:slot-0:g0$/);
assert.match(loaderIds[1], /:slot-0:g1$/);

assert.equal(await pool.submit((value) => value, 'next-payload'), 'recovered');
assert.equal(loaderIds[2], loaderIds[1]);

console.log('loader-clone-retry: ok');
