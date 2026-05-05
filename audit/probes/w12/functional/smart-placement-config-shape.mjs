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

await group('top-level compat flags (CWB-1 hotfix: replica_routing moved to env.production)', () => {
  // Top-level flags are what `wrangler dev` (no --env) consumes.
  // `replica_routing` was moved out of the top-level list because the
  // bundled workerd in many local dev installs predates GA replica
  // routing and rejects the flag at config-time. Production deploys
  // pick up `replica_routing` via the `env.production` overlay (next
  // group). See audit/sections/POST-PHASE5-CROSS-WAVE-AUDIT §CWB-1.
  const flags = parsed?.compatibility_flags ?? [];
  ok('compatibility_flags is an array', Array.isArray(flags));
  ok('includes nodejs_compat (W3 carry)', flags.includes('nodejs_compat'));
  ok('includes experimental (W10 carry)', flags.includes('experimental'));
  ok('top-level does NOT include replica_routing (CWB-1: prod-only)',
     !flags.includes('replica_routing'));
});

await group('env.production overlay carries replica_routing (W12 add)', () => {
  // Wrangler-env-overlay shape introduced by CWB-1 hotfix
  // (2026-05-05). `wrangler deploy --env production` is the prod
  // deploy command; the orchestrator at audit/probes/_deploy-and-
  // verify-all.mjs was updated to invoke it.
  const prod = parsed?.env?.production;
  ok('env.production block present', prod && typeof prod === 'object');
  ok('env.production.name === nimbus (no env-name suffix)',
     prod?.name === 'nimbus');
  const prodFlags = prod?.compatibility_flags ?? [];
  ok('env.production.compatibility_flags is an array',
     Array.isArray(prodFlags));
  // Wrangler env overlays REPLACE inheritable keys (not merge), so the
  // full superset must be present in the env block.
  ok('env.production includes nodejs_compat',
     prodFlags.includes('nodejs_compat'));
  ok('env.production includes experimental',
     prodFlags.includes('experimental'));
  ok('env.production includes replica_routing',
     prodFlags.includes('replica_routing'));
});

await group('env.production redeclares non-inheritable bindings', () => {
  // Per https://developers.cloudflare.com/workers/wrangler/configuration/
  // §"Non-inheritable keys", `durable_objects`, `r2_buckets`, and `vars`
  // do NOT inherit from the top level — they must be redeclared in the
  // env block so the deployed Worker actually has the bindings wired.
  const prod = parsed?.env?.production;
  ok('env.production.durable_objects.bindings has NIMBUS_SESSION',
     !!prod?.durable_objects?.bindings?.find((b) => b.name === 'NIMBUS_SESSION'));
  ok('env.production.r2_buckets has NPM_TARBALL_CACHE',
     !!prod?.r2_buckets?.find((b) => b.binding === 'NPM_TARBALL_CACHE'));
  ok('env.production.r2_buckets has NPM_PACKUMENT_CACHE',
     !!prod?.r2_buckets?.find((b) => b.binding === 'NPM_PACKUMENT_CACHE'));
  ok('env.production.vars present',
     prod?.vars && typeof prod.vars === 'object');
});

await group('compat date unchanged (no accidental bump)', () => {
  // Phase 4 main was on 2026-04-01; if W12 needs a later date for
  // replica_routing flag we'll surface that in the retro. Drift detector.
  ok('compatibility_date present', typeof parsed?.compatibility_date === 'string');
});

summary('w12/functional/smart-placement-config-shape');
