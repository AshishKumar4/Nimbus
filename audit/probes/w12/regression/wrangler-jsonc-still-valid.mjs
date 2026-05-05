#!/usr/bin/env bun
// W12 regression: wrangler.jsonc still parses + every W3-W11 binding
// remains. Drift detector that the W12 placement edit doesn't drop
// any unrelated binding.

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { ok, eq, group, summary } from '../_tap.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const WRANGLER = path.resolve(HERE, '..', '..', '..', '..', 'wrangler.jsonc');

const raw = fs.readFileSync(WRANGLER, 'utf8');
const stripped = raw
  .replace(/\/\*[\s\S]*?\*\//g, '')
  .replace(/^\s*\/\/.*$/gm, '')
  .replace(/,(\s*[}\]])/g, '$1');
const parsed = JSON.parse(stripped);

await group('top-level shape unchanged', () => {
  eq('name === nimbus', parsed.name, 'nimbus');
  eq('main === src/index.ts', parsed.main, 'src/index.ts');
  ok('compatibility_date set', typeof parsed.compatibility_date === 'string');
});

await group('W3 carry: nodejs_compat flag', () => {
  ok('compatibility_flags includes nodejs_compat', parsed.compatibility_flags.includes('nodejs_compat'));
});

await group('W10 carry: experimental flag (for ServiceStub serialization)', () => {
  ok('compatibility_flags includes experimental', parsed.compatibility_flags.includes('experimental'));
});

await group('W3-W11 carry: durable_objects + migrations', () => {
  ok('NIMBUS_SESSION binding present',
     parsed.durable_objects.bindings.find(b => b.name === 'NIMBUS_SESSION'));
  ok('migrations v1 NimbusSession present',
     parsed.migrations.find(m => m.tag === 'v1' && m.new_sqlite_classes?.includes('NimbusSession')));
});

await group('W4 carry: r2_buckets for npm cache', () => {
  ok('NPM_TARBALL_CACHE bucket present',
     parsed.r2_buckets.find(b => b.binding === 'NPM_TARBALL_CACHE'));
  ok('NPM_PACKUMENT_CACHE bucket present',
     parsed.r2_buckets.find(b => b.binding === 'NPM_PACKUMENT_CACHE'));
});

await group('W10 carry: worker_loaders binding', () => {
  ok('LOADER worker_loader present',
     parsed.worker_loaders?.find(w => w.binding === 'LOADER'));
});

await group('assets binding still wired', () => {
  ok('assets.binding === ASSETS', parsed.assets?.binding === 'ASSETS');
  ok('assets.directory still ./public', parsed.assets?.directory === './public');
});

summary('w12/regression/wrangler-jsonc-still-valid');
