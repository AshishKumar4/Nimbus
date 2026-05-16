#!/usr/bin/env bun
// sdk-config/new/build-wrangler-config — @nimbus-sh/config produces a
// valid wrangler.jsonc with the expected bindings shape.

import { makeAsserter } from '../../_driver.mjs';
const a = makeAsserter('sdk-config/new/build-wrangler-config');

const { buildNimbusWranglerConfig, NIMBUS_REQUIRED_ALIASES } =
  await import('../../../../packages/config/src/index.ts');

// 1. Minimum-input config has all the required bindings.
{
  const c = buildNimbusWranglerConfig({ name: 'my-nimbus' });
  a.check('name set', c.name === 'my-nimbus');
  a.check('main = src/index.ts', c.main === 'src/index.ts');
  a.check('compat date default', c.compatibility_date === '2026-04-01');
  a.check('compat flag nodejs_compat', c.compatibility_flags.includes('nodejs_compat'));
  a.check('NIMBUS_SESSION DO binding', c.durable_objects.bindings.length === 1
    && c.durable_objects.bindings[0].name === 'NIMBUS_SESSION'
    && c.durable_objects.bindings[0].class_name === 'NimbusSession');
  a.check('migration tag for v1', c.migrations[0].tag === 'nimbus-v1'
    && c.migrations[0].new_sqlite_classes.includes('NimbusSession'));
  a.check('Worker Loader binding', c.worker_loaders[0].binding === 'LOADER');
  a.check('three R2 buckets', c.r2_buckets.length === 3,
    `actual=${c.r2_buckets.length}`);
  a.check('NPM_TARBALL_CACHE present',
    !!c.r2_buckets.find((b) => b.binding === 'NPM_TARBALL_CACHE'));
  a.check('NPM_PACKUMENT_CACHE present',
    !!c.r2_buckets.find((b) => b.binding === 'NPM_PACKUMENT_CACHE'));
  a.check('NIMBUS_RUNTIME_CACHE present',
    !!c.r2_buckets.find((b) => b.binding === 'NIMBUS_RUNTIME_CACHE'));
  a.check('ASSETS binding name', c.assets.binding === 'ASSETS');
  a.check('assets.run_worker_first /s/* + /new',
    c.assets.run_worker_first?.includes('/s/*') && c.assets.run_worker_first?.includes('/new'));
  a.check('Smart Placement default', c.placement?.mode === 'smart');
}

// 2. Shared runtime cache (default) → bucket is nimbus-runtime-cache-public.
{
  const c = buildNimbusWranglerConfig({ name: 'shared' });
  const rt = c.r2_buckets.find((b) => b.binding === 'NIMBUS_RUNTIME_CACHE');
  a.check('shared runtime cache bucket', rt.bucket_name === 'nimbus-runtime-cache-public');
}

// 3. BYOA runtime cache → bucket is ${prefix}-runtime-cache.
{
  const c = buildNimbusWranglerConfig({ name: 'byo', runtimeCache: 'byoa' });
  const rt = c.r2_buckets.find((b) => b.binding === 'NIMBUS_RUNTIME_CACHE');
  a.check('byoa runtime cache bucket prefixed', rt.bucket_name === 'byo-runtime-cache');
}

// 4. Custom r2BucketPrefix is respected.
{
  const c = buildNimbusWranglerConfig({ name: 'a', r2BucketPrefix: 'my-prefix' });
  a.check('npm tarball cache prefixed',
    c.r2_buckets.find((b) => b.binding === 'NPM_TARBALL_CACHE').bucket_name === 'my-prefix-npm-cache');
  a.check('npm packument cache prefixed',
    c.r2_buckets.find((b) => b.binding === 'NPM_PACKUMENT_CACHE').bucket_name === 'my-prefix-npm-packument-cache');
}

// 5. legacyPublic adds NIMBUS_LEGACY_PUBLIC=1 to vars.
{
  const c = buildNimbusWranglerConfig({ name: 'live', legacyPublic: true });
  a.check('legacyPublic adds env var', c.vars?.NIMBUS_LEGACY_PUBLIC === '1');
}
{
  const c = buildNimbusWranglerConfig({ name: 'normal' });
  a.check('no legacy var when off', c.vars === undefined || !c.vars.NIMBUS_LEGACY_PUBLIC);
}

// 6. NIMBUS_REQUIRED_ALIASES is included; extraAliases merges.
{
  const c = buildNimbusWranglerConfig({
    name: 'a',
    extraAliases: { 'my-shim': 'my-shim-impl' },
  });
  a.check('crc-32 alias present (required)', c.alias['crc-32'] === 'crc-32');
  a.check('clean-git-ref alias present (required)',
    c.alias['clean-git-ref'] === 'clean-git-ref/lib/index.js');
  a.check('extra alias merged', c.alias['my-shim'] === 'my-shim-impl');
  a.check('NIMBUS_REQUIRED_ALIASES has 12 entries',
    Object.keys(NIMBUS_REQUIRED_ALIASES).length === 12);
}

// 7. Missing name throws.
{
  let threw = false;
  try { buildNimbusWranglerConfig({}); } catch { threw = true; }
  a.check('missing name throws', threw);
}

const sum = a.summary();
process.exit(sum.fail > 0 ? 1 : 0);
