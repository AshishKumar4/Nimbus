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

// ── 8. get(context) reaches watermark and build; build sees the key ─────────
// The MCP call site: the watermark is an RPC on a per-call stub with a
// per-call caller identity, and the build branches on the watermark VALUE
// (zero means "no MCP mutation ever" and skips the descriptor fetch). The
// Proteus port recorded three instance-field smuggles where this was missing.

{
  const memo = derivedAsync(
    async (ctx) => ctx.stub.updatedAt(ctx.caller),
    async (ctx, key) => {
      if (key === 0) return { tools: [], caller: ctx.caller };
      return { tools: await ctx.stub.descriptors(ctx.caller), caller: ctx.caller };
    },
  );
  let wm = 0;
  const stub = {
    async updatedAt(caller) { return caller === 'cap-token' ? wm : -1; },
    async descriptors() { return ['tool-a']; },
  };
  const cold = await memo.get({ stub, caller: 'cap-token' });
  assert.deepEqual(cold, { tools: [], caller: 'cap-token' },
    'a zero watermark short-circuits inside build — build sees the key');
  wm = 7;
  const warm = await memo.get({ stub, caller: 'cap-token' });
  assert.deepEqual(warm.tools, ['tool-a']);
  assert.equal((await memo.get({ stub, caller: 'cap-token' })).tools, warm.tools,
    'an unchanged watermark returns the memo, context notwithstanding');
}

// ── 9. The sync variant threads context and key the same way ────────────────

{
  let builds = 0;
  const memo = derived(
    (mode) => `${mode}:v1`,
    (mode, key) => { builds++; return `${mode}-surface@${key}`; },
  );
  assert.equal(memo.get('plan'), 'plan-surface@plan:v1');
  assert.equal(memo.get('plan'), 'plan-surface@plan:v1');
  assert.equal(builds, 1);
  assert.equal(memo.get('build'), 'build-surface@build:v1',
    'a context that moves the watermark rebuilds for the new context');
  assert.equal(builds, 2);
}

// ── 10. onStale: serving stale is visible, not silent ───────────────────────
// The MCP consumer logs a diagnostics failure every time a watermark or
// descriptor fetch fails and the stale surface is served; derivedAsync
// absorbed exactly that event. Same defect class as do-calls' onRetry.

{
  const stale = [];
  let wmFails = false;
  let buildFails = false;
  const memo = derivedAsync(
    async () => { if (wmFails) throw new Error('watermark rpc failed'); return 1; },
    async () => { if (buildFails) throw new Error('descriptor fetch failed'); return 'tools'; },
    { onStale: (error) => stale.push(error.message) },
  );
  await memo.get();
  assert.deepEqual(stale, [], 'a clean build reports nothing');
  wmFails = true;
  await memo.get();
  wmFails = false;
  memo.invalidate();
  buildFails = true;
  await memo.get().catch(() => {});
  assert.deepEqual(stale, ['watermark rpc failed'],
    'onStale fires only when a stale value is served; a surfaced error is already visible');
}

// ── 11. onRebuild: the key transition consumers used to log ─────────────────
// The MCP consumer logs 'mcp_tools_rebuilt … @ wm=N' after every rebuild;
// the tool cache logs the rebuild with its watermark. derived absorbed the
// transition.

{
  const transitions = [];
  let wm = 'a';
  const memo = derived(
    () => wm,
    () => `built:${wm}`,
    { onRebuild: (previousKey, nextKey) => transitions.push([previousKey, nextKey]) },
  );
  memo.get();
  memo.get();
  wm = 'b';
  memo.get();
  assert.deepEqual(transitions, [[undefined, 'a'], ['a', 'b']],
    'one report per rebuild: first build from nothing, then the key transition');

  const asyncTransitions = [];
  let awm = 1;
  const amemo = derivedAsync(
    async () => awm,
    async () => `tools@${awm}`,
    { onRebuild: (previousKey, nextKey) => asyncTransitions.push([previousKey, nextKey]) },
  );
  await amemo.get();
  awm = 2;
  await amemo.get();
  assert.deepEqual(asyncTransitions, [[undefined, 1], [1, 2]]);
}

console.log('ok - fabric-derived (sync memo, invalidation, async stale-on-error, no-stale surfaces)');
