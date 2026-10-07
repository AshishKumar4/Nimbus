import assert from 'node:assert/strict';
import { localFacetHost } from '../../packages/core/src/runtime/local-facet-host.ts';
import { DEFAULT_FACET_TASK_TIMEOUT_MS } from '../../packages/core/src/runtime/facet-host.ts';
import { ISOLATE_NETWORK } from '../../packages/core/src/_shared/workspace-network.ts';

const standard = localFacetHost(ISOLATE_NETWORK).open({ tag: 'default-bound' });
assert.equal(standard.defaultTimeoutMs, DEFAULT_FACET_TASK_TIMEOUT_MS);
await standard.dispose();

const bounded = localFacetHost(ISOLATE_NETWORK, { defaultTimeoutMs: 50 }).open({ tag: 'runaway-bound' });
const start = Date.now();
try {
  await assert.rejects(bounded.submit(() => { for (;;) {} }, null), /timed out after 50 ms/);
  assert.ok(Date.now() - start < 10000, 'a non-yielding realm must be terminated');
} finally {
  await bounded.dispose();
}
for (const value of [0, -1, Infinity, NaN]) {
  assert.throws(() => localFacetHost(ISOLATE_NETWORK, { defaultTimeoutMs: value }), /bounded timer/);
}
