#!/usr/bin/env bun
// The watermark memo, specified from the pairs ActorAgent hand-rolls:
// system prompt and tool set (sync watermark, sync build — getSystemPrompt is
// a synchronous Think contract, and _craftCacheKey is two synchronous SQLite
// aggregates), MCP tools (BOTH halves awaited RPCs against UserDO's
// mcp_updated_at, with stale-value-on-error), and SOUL text (push
// invalidation via setSoul, which nulls the memo).

import assert from 'node:assert/strict';
import { derived, derivedAsync } from '../../packages/fabric/src/derived.ts';

// ── 1. Sync: build once per watermark value, rebuild on change ──────────────

{
  let wm = 'a';
  let builds = 0;
  const memo = derived(() => wm, () => { builds++; return `built:${wm}`; });
  assert.equal(memo.get(), 'built:a');
  assert.equal(memo.get(), 'built:a');
  assert.equal(builds, 1, 'an unchanged watermark returns the memo');
  wm = 'b';
  assert.equal(memo.get(), 'built:b');
  assert.equal(builds, 2, 'a changed watermark rebuilds');
  assert.equal(memo.get(), 'built:b');
  assert.equal(builds, 2);
}

// ── 2. invalidate forces a rebuild under the SAME watermark ──────────────────

{
  let builds = 0;
  const memo = derived(() => 1, () => ++builds);
  memo.get();
  memo.invalidate();
  memo.get();
  assert.equal(builds, 2, 'push invalidation (the setSoul case) beats an unchanged watermark');
}

// ── 3. The sync variant is genuinely synchronous — the init-gate rule ───────

{
  const memo = derived(() => 0, () => 'value');
  assert.equal(typeof memo.get(), 'string', 'get() returns the value, never a promise');
}

// ── 4. Async: a watermark-read failure returns the last good value ──────────

{
  let wmFails = false;
  let builds = 0;
  const memo = derivedAsync(
    async () => { if (wmFails) throw new Error('UserDO unreachable'); return 7; },
    async () => { builds++; return `tools@${builds}`; },
  );
  assert.equal(await memo.get(), 'tools@1');
  wmFails = true;
  assert.equal(await memo.get(), 'tools@1', 'the stale surface beats an error on the watermark RPC');
  wmFails = false;
  assert.equal(await memo.get(), 'tools@1', 'the key was not clobbered by the failure');
  assert.equal(builds, 1);
}

// ── 5. Async: a build failure returns stale and retries next time ───────────

{
  let wm = 1;
  let buildFails = false;
  let builds = 0;
  const memo = derivedAsync(
    async () => wm,
    async () => { if (buildFails) throw new Error('descriptor fetch failed'); return ++builds; },
  );
  assert.equal(await memo.get(), 1);
  wm = 2;
  buildFails = true;
  assert.equal(await memo.get(), 1, 'a failed rebuild serves the previous value');
  buildFails = false;
  assert.equal(await memo.get(), 2, 'the failure did not store; the next get rebuilds');
}

// ── 6. Async: with no stale value, the error surfaces ───────────────────────

{
  const memo = derivedAsync(
    async () => { throw new Error('cold and unreachable'); },
    async () => 'never',
  );
  await assert.rejects(() => memo.get(), /cold and unreachable/);
}

// ── 7. Async invalidate ──────────────────────────────────────────────────────

{
  let builds = 0;
  const memo = derivedAsync(async () => 'k', async () => ++builds);
  await memo.get();
  memo.invalidate();
  await memo.get();
  assert.equal(builds, 2);
}

console.log('ok - fabric-derived (sync memo, invalidation, async stale-on-error, no-stale surfaces)');
