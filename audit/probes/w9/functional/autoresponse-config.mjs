// W9 functional: WebSocket auto-response + hibernation event timeout
// are configured exactly once at NimbusSession constructor time, with
// the values from CF research §C.3 / §C.4.
//
// We don't (and can't) instantiate the full NimbusSession in Node — its
// imports pull workerd-only globals (Cloudflare:workers, etc). Instead
// the build phase exposes a small pure function:
//   configureWsHibernation(ctx, opts?) → { autoResponseConfigured, timeoutSetMs }
// which the constructor calls and which we test in isolation.

import { ok, eq, group, summary } from '../_tap.mjs';
import { makeMockCtx } from '../_mock-sql.mjs';

let mod;
try {
  mod = await import('../../../../src/process-logs.ts');
} catch {}
let cfgMod;
try {
  cfgMod = await import('../../../../src/ws-hibernation-config.ts');
} catch (e) {
  // The module may live elsewhere — fail with the expected name so the
  // build phase knows what to satisfy.
  ok('ws-hibernation-config module exists', false, e.message);
  summary('w9/functional/autoresponse-config');
}

const { configureWsHibernation, NIMBUS_HIBERNATION_EVENT_TIMEOUT_MS } = cfgMod;

group('constants are sane', () => {
  ok(
    'NIMBUS_HIBERNATION_EVENT_TIMEOUT_MS exported',
    typeof NIMBUS_HIBERNATION_EVENT_TIMEOUT_MS === 'number',
  );
  // 5 s per CF research §C.3
  eq('timeout is 5000ms', NIMBUS_HIBERNATION_EVENT_TIMEOUT_MS, 5000);
});

group('happy path on a workerd-shaped ctx', () => {
  const { ctx } = makeMockCtx();
  // Inject a global WebSocketRequestResponsePair shim — the real workerd
  // global is implicit; the configure function should construct one.
  const seen = [];
  globalThis.WebSocketRequestResponsePair = class {
    constructor(req, res) { this.req = req; this.res = res; seen.push({ req, res }); }
  };

  const result = configureWsHibernation(ctx);
  ok('autoResponseConfigured', result.autoResponseConfigured === true);
  eq('timeoutSetMs', result.timeoutSetMs, 5000);
  eq('ctx auto-response saved', ctx._wsAutoResponse?.req, 'ping');
  eq('ctx auto-response saved (res)', ctx._wsAutoResponse?.res, 'pong');
  eq('ctx hibernation timeout saved', ctx._hibTimeoutMs, 5000);
  eq('exactly one WebSocketRequestResponsePair constructed', seen.length, 1);

  delete globalThis.WebSocketRequestResponsePair;
});

group('graceful degrade when ctx APIs are missing', () => {
  // Older workerd builds may not expose either method. We must NOT throw.
  const ctx = {
    storage: { sql: {} },
    waitUntil() {},
  };
  const result = configureWsHibernation(ctx);
  ok('did not throw', true);
  ok('autoResponseConfigured = false', result.autoResponseConfigured === false);
  ok('timeoutSetMs = null', result.timeoutSetMs === null);
});

group('graceful degrade when WebSocketRequestResponsePair is absent', () => {
  const { ctx } = makeMockCtx();
  // Ensure the shim is gone for this test
  delete globalThis.WebSocketRequestResponsePair;
  const result = configureWsHibernation(ctx);
  // The function may either:
  //   (a) skip auto-response entirely (autoResponseConfigured=false)
  //   (b) attempt and catch — same outcome
  // Both are valid; assert no throw + honest reporting.
  ok('did not throw without the global', true);
  ok(
    'autoResponseConfigured falsy without the global',
    result.autoResponseConfigured === false,
  );
  // Timeout setup is independent of the global — it should still succeed.
  eq('timeout still set', result.timeoutSetMs, 5000);
});

group('idempotent — second call is a no-op', () => {
  const { ctx } = makeMockCtx();
  globalThis.WebSocketRequestResponsePair = class {
    constructor(req, res) { this.req = req; this.res = res; }
  };
  const r1 = configureWsHibernation(ctx);
  const r2 = configureWsHibernation(ctx);
  eq('second call did not error', r2.autoResponseConfigured, true);
  // Last-writer-wins semantics for the ctx; that's fine.
  eq('still configured', ctx._wsAutoResponse?.req, 'ping');
  delete globalThis.WebSocketRequestResponsePair;
});

summary('w9/functional/autoresponse-config');
