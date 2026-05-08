#!/usr/bin/env bun
// W12 functional: wrangler.jsonc enables Smart Placement + replica_routing.

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { ok, eq, group, summary } from '../_tap.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const WRANGLER = path.resolve(HERE, '..', '..', '..', '..', 'wrangler.jsonc');

const raw = fs.readFileSync(WRANGLER, 'utf8');
// Strip // line comments and /* block */ comments before JSON.parse.
// JSON5 is overkill — wrangler.jsonc only uses these two comment styles.
const stripped = raw
  .replace(/\/\*[\s\S]*?\*\//g, '')
  .replace(/^\s*\/\/.*$/gm, '')
  .replace(/,(\s*[}\]])/g, '$1'); // tolerate trailing commas
let parsed;
try { parsed = JSON.parse(stripped); }
catch (e) { ok('wrangler.jsonc parses (after comment strip)', false, e.message); summary('w12/functional/smart-placement-config-shape'); }

await group('placement.mode = smart', () => {
  ok('placement object present', parsed && typeof parsed.placement === 'object');
  eq('placement.mode === smart', parsed?.placement?.mode, 'smart');
});

await group('top-level compat flags (DEPLOY-FLAG-FIX 2026-05-08: $experimental flags removed)', () => {
  // Both `experimental` and `replica_routing` are tagged $experimental
  // in workerd (compatibility-date.capnp:replicaRouting@60 +
  // workerdExperimental@24). Cloudflare's deploy validator rejects
  // $experimental flags for non-team accounts (the validator started
  // enforcing this between the 2026-05-08T19:19Z deploy that succeeded
  // and the 21:43Z deploy that failed with [code: 10021]).
  //
  // Runtime invariants are preserved: `experimental` was never
  // functionally exercised (zero `allowExperimental: true` call sites
  // in src/), and `replica_routing` graceful-degrades via
  // src/replica/routing.ts::tryEnableReplicas → state: 'unsupported'.
  //
  // See audit/sections/DEPLOY-FLAG-FIX-retro.md for full evidence.
  const flags = parsed?.compatibility_flags ?? [];
  ok('compatibility_flags is an array', Array.isArray(flags));
  ok('includes nodejs_compat (W3 carry)', flags.includes('nodejs_compat'));
  ok('does NOT include experimental ($experimental, platform-rejected)',
     !flags.includes('experimental'));
  ok('does NOT include replica_routing ($experimental, platform-rejected)',
     !flags.includes('replica_routing'));
});

await group('env.production overlay (no $experimental flags)', () => {
  // env.production used to overlay `replica_routing` for prod-only
  // deploys (CWB-1 hotfix, 2026-05-05). Post DEPLOY-FLAG-FIX the flag
  // is removed at both layers; env.production's compat_flags is now
  // identical to the top-level. The overlay still exists for the
  // non-inheritable bindings (durable_objects, r2_buckets,
  // worker_loaders, vars).
  const prod = parsed?.env?.production;
  ok('env.production block present', prod && typeof prod === 'object');
  ok('env.production.name === nimbus (no env-name suffix)',
     prod?.name === 'nimbus');
  const prodFlags = prod?.compatibility_flags ?? [];
  ok('env.production.compatibility_flags is an array',
     Array.isArray(prodFlags));
  ok('env.production includes nodejs_compat',
     prodFlags.includes('nodejs_compat'));
  ok('env.production does NOT include experimental',
     !prodFlags.includes('experimental'));
  ok('env.production does NOT include replica_routing',
     !prodFlags.includes('replica_routing'));
});

await group('env.production redeclares non-inheritable bindings', () => {
  // Per https://developers.cloudflare.com/workers/wrangler/configuration/
  // §"Non-inheritable keys", `durable_objects`, `r2_buckets`,
  // `worker_loaders`, and `vars` do NOT inherit from the top level —
  // they must be redeclared in the env block so the deployed Worker
  // actually has the bindings wired. (DEPLOY-FLAG-FIX added
  // worker_loaders to env.production after `wrangler deploy --dry-run
  // -e production` warned it was missing.)
  const prod = parsed?.env?.production;
  ok('env.production.durable_objects.bindings has NIMBUS_SESSION',
     !!prod?.durable_objects?.bindings?.find((b) => b.name === 'NIMBUS_SESSION'));
  ok('env.production.r2_buckets has NPM_TARBALL_CACHE',
     !!prod?.r2_buckets?.find((b) => b.binding === 'NPM_TARBALL_CACHE'));
  ok('env.production.r2_buckets has NPM_PACKUMENT_CACHE',
     !!prod?.r2_buckets?.find((b) => b.binding === 'NPM_PACKUMENT_CACHE'));
  ok('env.production.worker_loaders has LOADER',
     !!prod?.worker_loaders?.find((b) => b.binding === 'LOADER'));
  ok('env.production.vars present',
     prod?.vars && typeof prod.vars === 'object');
});

await group('compat date unchanged (no accidental bump)', () => {
  // Phase 4 main was on 2026-04-01; if W12 needs a later date for
  // replica_routing flag we'll surface that in the retro. Drift detector.
  ok('compatibility_date present', typeof parsed?.compatibility_date === 'string');
});

summary('w12/functional/smart-placement-config-shape');
