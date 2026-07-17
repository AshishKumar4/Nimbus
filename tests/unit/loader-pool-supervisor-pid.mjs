#!/usr/bin/env bun
//
// Regression: npm install dispatches its write facets through NimbusLoaderPool,
// which mints the SUPERVISOR binding the facet uses for writeBatchStream. S2a's
// SupervisorRPC._pid() now rejects pid <= 0, so the pool's historical hardcoded
// `pid: 0` broke every install ("missing or invalid process pid in props").
// The pool must thread a caller-supplied `supervisorPid` into props.pid so the
// supervisor derives the invoking process's write credential. Pools whose facets
// touch only cache/registry RPCs (npm resolve, pre-bundle) never call _pid() and
// keep the 0 default.

import assert from 'node:assert/strict';

import { NimbusLoaderPool } from '../../packages/worker/src/loaders/loader-pool.ts';
import { setCtxExports } from '../../packages/worker/src/session/ctx-exports.ts';

const boundProps = [];
setCtxExports({
  SupervisorRPC(options) {
    boundProps.push(options.props);
    return { [Symbol.dispose]() {} };
  },
});

const env = { LOADER: { get() { return { getEntrypoint() { return {}; } }; } } };
const ctx = { id: { toString: () => 'loader-pid-test' } };

// A positive supervisorPid must reach the SUPERVISOR binding props.
boundProps.length = 0;
new NimbusLoaderPool(env, ctx, { supervisorPid: 42 });
assert.deepEqual(boundProps, [{ doId: 'loader-pid-test', pid: 42 }],
  'supervisorPid must be minted into the SUPERVISOR binding props');

// Default (unset) stays 0 — resolve/pre-bundle pools never call _pid().
boundProps.length = 0;
new NimbusLoaderPool(env, ctx, {});
assert.deepEqual(boundProps, [{ doId: 'loader-pid-test', pid: 0 }],
  'absent supervisorPid defaults to 0');

// supervisorDoIdOverride and supervisorPid compose (peer-DO install path).
boundProps.length = 0;
new NimbusLoaderPool(env, ctx, { supervisorDoIdOverride: 'coordinator-do', supervisorPid: 7 });
assert.deepEqual(boundProps, [{ doId: 'coordinator-do', pid: 7 }],
  'supervisorPid composes with supervisorDoIdOverride');

console.log('loader-pool supervisor pid: ok');
