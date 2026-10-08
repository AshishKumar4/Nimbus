// The local facet host ends a call at its deadline, when the call has one,
// even in a realm that never yields: a direct compute call is bounded. A call
// with none has none (process-no-wall-deadline.mjs).
import assert from 'node:assert/strict';
import { localFacetHost } from '../../packages/core/src/runtime/local-facet-host.ts';
import { ISOLATE_NETWORK } from '../../packages/core/src/_shared/workspace-network.ts';

const facet = localFacetHost(ISOLATE_NETWORK).open({ tag: 'runaway-bound' });
const start = Date.now();
try {
  await assert.rejects(facet.submit(() => { for (;;) {} }, null, { timeoutMs: 50 }), /timed out after 50 ms/);
  assert.ok(Date.now() - start < 10000, 'a non-yielding realm must be terminated');
} finally {
  await facet.dispose();
}
console.log('local-facet-call-deadline: ok');
