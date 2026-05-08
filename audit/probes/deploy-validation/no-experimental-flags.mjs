#!/usr/bin/env bun
// Deploy-validation pre-flight: assert wrangler.jsonc carries no
// $experimental compatibility flags.
//
// Background
// ----------
// On 2026-05-08 the deploy at SHA 0f583938 succeeded with both
// `experimental` and `replica_routing` in compatibility_flags; 2.5
// hours later the same wrangler.jsonc was REJECTED with [code: 10021]
// — Cloudflare's deploy validator started enforcing the per-flag
// $experimental gate for our account in that window.
//
// Per the workerd source (src/workerd/io/compatibility-date.capnp):
//   * `experimental` is annotated $experimental — workerd-internal
//     catch-all flag for unfinished features.
//   * `replica_routing` is annotated $experimental — DO read-replica
//     routing, currently in private/wiki development.
//
// The capnp file's `experimental` annotation comment:
//   "Experimental flags cannot be used in Workers deployed on
//    Cloudflare except by test accounts belonging to Cloudflare team
//    members."
//
// This probe enforces the production-deploy invariant: wrangler.jsonc
// must NOT contain any of the known $experimental flags (this list is
// a safe-list — adding a new $experimental flag here is the recipe
// for shipping a breaking deploy).
//
// What this probe does NOT check
// -------------------------------
// * Whether each listed flag is actually $experimental — that's
//   workerd source truth and changes over time. The known-bad list
//   below mirrors the flags Nimbus had at the time of the
//   2026-05-08 rejection. Future workerd promotions may remove a
//   flag from $experimental — at that point it can be re-added to
//   wrangler.jsonc and removed from this list, with a comment in
//   the retro pointing at the workerd commit.
// * Server-side validator behavior — that's not reproducible in CI.
//   This probe only checks what wrangler.jsonc declares.

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { ok, group, summary } from '../w12/_tap.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, '..', '..', '..');
const WRANGLER = path.join(ROOT, 'wrangler.jsonc');

const raw = fs.readFileSync(WRANGLER, 'utf8');
// Same comment-strip as the smart-placement-config-shape probe
const stripped = raw
  .replace(/\/\*[\s\S]*?\*\//g, '')
  .replace(/^\s*\/\/.*$/gm, '')
  .replace(/,(\s*[}\]])/g, '$1');
const parsed = JSON.parse(stripped);

// Known $experimental flags from workerd as of 2026-05-08 — NOT
// exhaustive; this list grows as needed when CF adds/promotes flags.
// Source: src/workerd/io/compatibility-date.capnp at
// https://github.com/cloudflare/workerd, search for `$experimental`.
const KNOWN_EXPERIMENTAL_FLAGS = new Set([
  'experimental',                  // workerdExperimental@24
  'durable_object_get_existing',   // durableObjectGetExisting@25
  'service_binding_extra_handlers', // serviceBindingExtraHandlers@28
  'rtti_api',                      // rttiApi@34
  'unsafe_module',                 // unsafeModule@38
  'js_rpc',                        // jsRpc@39 (obsolete, still gated)
  'kv_direct_binding',             // kvDirectBinding@54
  'increase_websocket_message_size', // increaseWebsocketMessageSize@56
  'python_workers_development',    // pythonWorkersDevPyodide@58
  'replica_routing',               // replicaRouting@60 (DEPLOY-FLAG-FIX root cause)
  'memory_cache_delete',           // memoryCacheDelete@73
  'new_module_registry',           // newModuleRegistry@52
]);

function checkFlagList(label, flags) {
  if (!Array.isArray(flags)) {
    ok(`${label}: compatibility_flags is an array`, false,
       'wrangler.jsonc must declare compatibility_flags as an array');
    return;
  }
  ok(`${label}: compatibility_flags is an array`, true);
  for (const flag of flags) {
    const isExperimental = KNOWN_EXPERIMENTAL_FLAGS.has(flag);
    ok(`${label}: '${flag}' is not on the known-experimental list`,
       !isExperimental,
       `Flag '${flag}' is $experimental in workerd — Cloudflare's deploy ` +
       `validator rejects $experimental flags for non-team accounts. ` +
       `Remove from wrangler.jsonc or wait until workerd promotes it.`);
  }
}

await group('top-level compatibility_flags', () => {
  checkFlagList('top-level', parsed?.compatibility_flags);
});

await group('env.production compatibility_flags', () => {
  const prodFlags = parsed?.env?.production?.compatibility_flags ?? [];
  checkFlagList('env.production', prodFlags);
});

await group('env.production preserves non-inheritable bindings', () => {
  // Defensive: a future PR that removes the env.production block
  // entirely (because compat_flags collapsed to be identical to
  // top-level) would also remove the redeclared bindings, breaking
  // production deploys. Lock the structural invariant here.
  const prod = parsed?.env?.production;
  ok('env.production block exists', prod && typeof prod === 'object',
     'wrangler env-overlay rules require env.production to redeclare ' +
     'non-inheritable bindings (durable_objects, r2_buckets, ' +
     'worker_loaders, vars). The block must NOT be removed even when ' +
     'compatibility_flags becomes identical to top-level.');
  if (!prod) { summary('deploy-validation/no-experimental-flags'); }
  ok('env.production has durable_objects.bindings',
     Array.isArray(prod?.durable_objects?.bindings) &&
     prod.durable_objects.bindings.length > 0);
  ok('env.production has r2_buckets', Array.isArray(prod?.r2_buckets));
  ok('env.production has worker_loaders',
     Array.isArray(prod?.worker_loaders));
  ok('env.production has vars',
     prod?.vars && typeof prod.vars === 'object');
});

summary('deploy-validation/no-experimental-flags');
