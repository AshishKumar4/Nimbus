#!/usr/bin/env bun
/**
 * Every supervisor op a session answers by a method (SUPERVISOR_OP_ROUTES)
 * is a method of the session itself (NimbusSession), not only of the RPC
 * helpers it forwards to: a route the session class lacks is refused at
 * dispatch, and a caller that falls back hides it.
 */
import assert from 'node:assert/strict';
import { SUPERVISOR_OP_ROUTES } from '../../packages/core/src/workspace/supervisor-op.ts';
import { importWorkerBundle } from './lib/worker-bundle.mjs';

const { NimbusSession } = await importWorkerBundle({
  'packages/worker/src/session/nimbus-session.ts': ['NimbusSession'],
});
const missing = Object.entries(SUPERVISOR_OP_ROUTES)
  .filter(([, route]) => typeof NimbusSession.prototype[route.method] !== 'function')
  .map(([op, route]) => `${op} → ${route.method}`);
assert.deepEqual(missing, [], 'routed ops the session does not answer');
console.log(`session-supervisor-routes: ok (${Object.keys(SUPERVISOR_OP_ROUTES).length} routes)`);
