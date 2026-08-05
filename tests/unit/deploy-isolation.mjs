#!/usr/bin/env bun
// deploy-isolation — a non-production deploy must not reach production state.
//
// `wrangler deploy --name foo` overrides ONLY the Worker name; every binding
// still comes from the config block being deployed. Two throwaway probes
// wrote rows into the live demo D1 that way, because
// apps/hosted-demo/wrangler.jsonc's top-level block hardcoded the production
// `database_id` — one deployed from that directory by hand, one from a copy
// of the file with `env` stripped out. Both looked isolated.
//
// [1] is the invariant itself, standing over the real repo configs. The rest
// exist so [1] cannot pass by doing nothing: they drive the checker with
// fixtures and assert it actually fails when a boundary is crossed.

import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  DEPLOYABLE_CONFIGS,
  assertDeployIsolated,
  checkAll,
  checkConfig,
  deployableTargets,
  discoverConfigs,
  loadConfig,
  missingCapabilities,
  resolveWorkerName,
  sharedResourceIdentifiers,
} from '../../scripts/deploy-isolation.mjs';

function fixture(configs) {
  const root = mkdtempSync(join(tmpdir(), 'deploy-isolation-'));
  for (const [name, body] of Object.entries(configs)) {
    const path = join(root, name);
    mkdirSync(join(path, '..'), { recursive: true });
    writeFileSync(path, JSON.stringify(body));
  }
  return root;
}

const PROD_D1 = {
  binding: 'DEMO_DB',
  database_name: 'nimbus-demo',
  database_id: '8e2ecc37-d975-49d8-96b7-885d45734a53',
};

// [1] THE INVARIANT: EVERY non-production deploy target — each config's
// default block and each of its non-production env blocks — is disjoint
// from production. This is the check that would have stopped the incident,
// and enumerating env blocks is what keeps it standing over `env.staging`
// without anyone having to remember to add it.
{
  const results = checkAll();
  const failures = results.filter((r) => r.violations.length > 0);
  assert.deepEqual(
    failures.map((f) => `${f.config}${f.env ? ` (env.${f.env})` : ''}: ${f.violations.join('; ')}`),
    [],
    'a non-production deploy resolves a production resource',
  );
  assert.equal(results.length, deployableTargets().length);
  assert.ok(results.length > DEPLOYABLE_CONFIGS.length, 'env blocks are enumerated, not just defaults');
  assert.ok(
    results.some((r) => r.config === 'apps/hosted-demo/wrangler.jsonc' && r.env === 'staging'),
    'the staging environment is one of the checked targets',
  );
  console.log(`  [1] ${results.length} deploy targets: none reaches production`);
}

// [1b] The three tiers of apps/hosted-demo name three different databases
// and three different rate-limit namespaces. [1] only proves staging and
// dev stay off PRODUCTION; this pins that they also stay off each other,
// so a throwaway inheriting the dev block cannot write rows into the
// environment a release is being verified against.
{
  const config = loadConfig('apps/hosted-demo/wrangler.jsonc');
  const tiers = [config, config.env.staging, config.env.production];
  for (const [field, read] of [
    ['database_id', (b) => b.d1_databases[0].database_id],
    ['rate-limit namespace_id', (b) => b.ratelimits[0].namespace_id],
    ['worker name', (b) => b.name],
  ]) {
    assert.equal(new Set(tiers.map(read)).size, 3, `dev, staging and production share a ${field}`);
  }
  console.log('  [1b] dev, staging and production are disjoint from each other, not just from production');
}

// [2] The production D1 is named ONLY under env.production. This is the
// specific identifier that leaked, pinned so it cannot drift back.
{
  const config = loadConfig('apps/hosted-demo/wrangler.jsonc');
  assert.equal(config.env.production.d1_databases[0].database_id, PROD_D1.database_id,
    'production still binds the production database');
  assert.notEqual(config.d1_databases[0].database_id, PROD_D1.database_id,
    'the top-level block must NOT bind the production database');
  assert.notEqual(config.name, config.env.production.name,
    'a bare `wrangler deploy` must not land on the production Worker name');
  console.log('  [2] production database_id and Worker name appear only under env.production');
}

// [3] The checker FAILS when the trap is present — the exact pre-fix shape.
{
  const root = fixture({
    'wrangler.jsonc': {
      name: 'nimbus',
      d1_databases: [PROD_D1],
      ratelimits: [{ name: 'ANON_RATE_LIMITER', namespace_id: '1001' }],
      env: {
        production: {
          name: 'nimbus',
          d1_databases: [PROD_D1],
          ratelimits: [{ name: 'ANON_RATE_LIMITER', namespace_id: '1001' }],
        },
      },
    },
  });
  const opts = { root, configs: ['wrangler.jsonc'] };
  const result = checkConfig('wrangler.jsonc', opts);
  assert.ok(result.violations.some((v) => v.includes(PROD_D1.database_id)),
    'the production database_id is reported');
  assert.ok(result.violations.some((v) => v.includes('1001')),
    'the shared rate-limit namespace is reported');
  assert.ok(result.violations.some((v) => v.includes('production Worker')),
    'landing on the production Worker name is reported');

  // And a throwaway deploying from it is refused by name.
  assert.throws(
    () => assertDeployIsolated({ configPath: 'wrangler.jsonc', workerName: 'nimbus-fswt-livegate', ...opts }),
    /nimbus-fswt-livegate[\s\S]*8e2ecc37/,
    'the preflight names both the throwaway and the production resource',
  );
  console.log('  [3] the pre-fix config is rejected, and a throwaway from it is refused');
}

// [4] A throwaway is allowed when the default block is genuinely isolated —
// the check must not simply refuse everything.
{
  const root = fixture({
    'wrangler.jsonc': {
      name: 'nimbus-dev',
      d1_databases: [{ binding: 'DEMO_DB', database_name: 'nimbus-demo-dev', database_id: 'dev-id' }],
      env: { production: { name: 'nimbus', d1_databases: [PROD_D1] } },
    },
  });
  const opts = { root, configs: ['wrangler.jsonc'] };
  assert.deepEqual(checkConfig('wrangler.jsonc', opts).violations, []);
  const ok = assertDeployIsolated({ configPath: 'wrangler.jsonc', workerName: 'nimbus-tw-x', ...opts });
  assert.equal(ok.target, 'nimbus-tw-x');
  // The production deploy itself is never flagged against its own resources.
  assert.deepEqual(checkConfig('wrangler.jsonc', { ...opts, envName: 'production' }).violations, []);
  console.log('  [4] an isolated default block passes, and production is not flagged against itself');
}

// [4b] An env block that reaches production is caught by `checkAll`, not
// merely by someone thinking to ask about it. Without the enumeration, a
// staging block could bind the production database and every check here
// would still be green — the default block, which is what used to be
// checked, would be perfectly clean.
{
  const root = fixture({
    'wrangler.jsonc': {
      name: 'app-dev',
      d1_databases: [{ binding: 'DEMO_DB', database_name: 'app-dev', database_id: 'dev-id' }],
      env: {
        staging: { name: 'app-staging', d1_databases: [PROD_D1] },
        production: { name: 'app', d1_databases: [PROD_D1] },
      },
    },
  });
  const opts = { root, configs: ['wrangler.jsonc'] };
  assert.deepEqual(checkConfig('wrangler.jsonc', opts).violations, [], 'the default block is clean');

  const targets = deployableTargets(opts);
  assert.deepEqual(targets.map((t) => t.envName), [null, 'staging'], 'production is not a target');

  const staging = checkAll(opts).find((r) => r.env === 'staging');
  assert.ok(staging.violations.some((v) => v.includes(PROD_D1.database_id)),
    'the staging block is measured against production too');
  assert.throws(
    () => assertDeployIsolated({ configPath: 'wrangler.jsonc', envName: 'staging', ...opts }),
    /app-staging[\s\S]*8e2ecc37/,
    'the preflight names the environment and the production resource it would reach',
  );
  console.log('  [4b] a non-production env block is enumerated and checked, not just the default');
}

// [5] Production is an ACCOUNT-level fact, not a per-file one: a config with
// no env.production of its own is still checked against the production
// resources declared elsewhere in the repo. apps/probe is exactly this shape.
{
  const root = fixture({
    'a/wrangler.jsonc': { name: 'app-a', env: { production: { name: 'app-a', d1_databases: [PROD_D1] } } },
    'b/wrangler.jsonc': { name: 'probe', d1_databases: [PROD_D1] },
  });
  const result = checkConfig('b/wrangler.jsonc', { root, configs: ['a/wrangler.jsonc', 'b/wrangler.jsonc'] });
  assert.ok(result.violations.some((v) => v.includes(PROD_D1.database_id)),
    'a config with no production env is still measured against the account production set');
  console.log('  [5] production is account-wide: a probe config is checked against another app');
}

// [6] Unknown wrangler keys fail closed. A wrangler upgrade that adds a new
// binding kind must break this check rather than open a silent path.
{
  assert.throws(
    () => sharedResourceIdentifiers({ name: 'x', some_new_binding: [{ id: 'prod' }] }),
    /unclassified wrangler key "some_new_binding"/,
    'an unclassified key is refused rather than guessed at',
  );
  console.log('  [6] an unclassified binding kind fails closed');
}

// [7] Durable Object namespaces are per-Worker and must NOT be flagged —
// except a cross-script binding, which genuinely reaches another Worker.
{
  const own = { bindings: [{ name: 'NIMBUS_SESSION', class_name: 'NimbusSession' }] };
  assert.deepEqual([...sharedResourceIdentifiers({ durable_objects: own })], [],
    'a DO namespace defined by this Worker is isolated by construction');

  const cross = { bindings: [{ name: 'S', class_name: 'NimbusSession', script_name: 'nimbus' }] };
  assert.deepEqual([...sharedResourceIdentifiers({ durable_objects: cross })], ['durable_objects:nimbus'],
    'a script_name binding reaches another Worker and is shared');
  console.log('  [7] DO namespaces: own is isolated, script_name is shared');
}

// [8] The three content-addressed caches are shared with production by
// design; they are reported as shared rather than silently dropped, so the
// sharing stays visible in the record.
{
  const result = checkConfig('apps/probe/wrangler.jsonc');
  assert.deepEqual(result.violations, []);
  assert.deepEqual(
    result.shared.map((s) => s.split(' ')[2]).sort(),
    ['"nimbus-npm-cache"', '"nimbus-npm-packument-cache"', '"nimbus-runtime-cache"'],
    'apps/probe shares exactly the three content-addressed caches, and says so',
  );
  console.log('  [8] shared-by-design caches are reported, not hidden');
}

// [9] Worker-name resolution matches wrangler's rules, since the whole check
// keys off which Worker a deploy lands on.
{
  const config = { name: 'app', env: { production: { name: 'prod-app' }, staging: {} } };
  assert.equal(resolveWorkerName(config), 'app');
  assert.equal(resolveWorkerName(config, 'production'), 'prod-app');
  assert.equal(resolveWorkerName(config, 'staging'), 'app-staging', 'wrangler appends an unset env name');
  assert.equal(resolveWorkerName(config, 'production', 'override'), 'override');
  console.log('  [9] worker-name resolution follows wrangler inheritance');
}

// [10] Load-bearing bindings are reported when absent, as a WARNING rather
// than a violation. Stripping bindings is the obvious way to make a
// throwaway look isolated, and ASSETS / NIMBUS_RUNTIME_CACHE do not degrade
// — they throw from inside a session, where the error reads as a bug in
// whatever was being probed. A minimal loader-only probe is still allowed.
{
  assert.deepEqual(missingCapabilities(loadConfig('apps/probe/wrangler.jsonc')), [],
    'apps/probe carries every load-bearing binding');

  // `assets` is inheritable, so an env block that omits it still gets it.
  // Reading the block literally reported nimbus-staging as assets-free —
  // a loud warning on every staging deploy, about a Worker that serves
  // the docs site. env.production omits `assets` the same way and
  // production serves them, which is the proof.
  assert.deepEqual(checkAll().find((r) => r.env === 'staging').missing, [],
    'env.staging inherits the top-level assets binding');

  const stripped = missingCapabilities({ durable_objects: {}, worker_loaders: [] });
  assert.equal(stripped.length, 2);
  assert.ok(stripped.some((m) => m.startsWith('ASSETS is absent')));
  assert.ok(stripped.some((m) => m.startsWith('NIMBUS_RUNTIME_CACHE is absent')));
  // The consequence is named, so the warning is actionable rather than noise.
  assert.match(stripped.join(' '), /installer\.ts/, 'npm install is named as an ASSETS consumer');
  assert.match(stripped.join(' '), /runtime-catalog\.ts/);

  const root = fixture({
    'wrangler.jsonc': {
      name: 'probe-min',
      env: { production: { name: 'nimbus', d1_databases: [PROD_D1] } },
    },
  });
  const result = checkConfig('wrangler.jsonc', { root, configs: ['wrangler.jsonc'] });
  assert.deepEqual(result.violations, [], 'a minimal probe is isolated, not rejected');
  assert.equal(result.missing.length, 2, 'but its missing capabilities are still reported');
  console.log('  [10] load-bearing bindings warn when absent without failing the check');
}

// [11] Every wrangler config on disk is one this module audits. The checks
// above are only as wide as DEPLOYABLE_CONFIGS, and that list is hand-kept:
// `apps/hosted-demo/wrangler.iso.json` — Worker `nimbus-pigate-iso`, its own
// D1 — rode in on an unrelated merge and nothing ever looked at it. A config
// the repo can deploy from but nothing audits is the entire hazard, so
// discovering them and comparing is what keeps the list honest.
{
  assert.deepEqual(
    discoverConfigs(), [...DEPLOYABLE_CONFIGS].sort(),
    'every wrangler config under apps/ must be classified in DEPLOYABLE_CONFIGS — '
    + 'add it there so it is audited, or delete it',
  );
  console.log('  [11] no wrangler config escapes the audit list');
}

console.log('deploy-isolation: all tests passed');
