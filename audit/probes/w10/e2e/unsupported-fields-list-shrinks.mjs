// W10 e2e: kv_namespaces, d1_databases, r2_buckets are no longer listed
// as WRANGLER_UNSUPPORTED_CONFIG_FIELDS in nimbus-session.ts.
//
// This is the "the unsupported list shrunk" check — the source of truth
// for "what binding fields make Nimbus warn the user". When W10 lands,
// these three should disappear from that list (queues + vectorize + ai
// etc remain).

import { ok, eq, summary } from '../_tap.mjs';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(HERE, '..', '..', '..', '..');
const sessionTs = fs.readFileSync(path.join(repoRoot, 'src/nimbus-session.ts'), 'utf-8');

// Find the WRANGLER_UNSUPPORTED_CONFIG_FIELDS array.
const m = sessionTs.match(/const WRANGLER_UNSUPPORTED_CONFIG_FIELDS\s*=\s*\[([^\]]+)\]/);
ok('WRANGLER_UNSUPPORTED_CONFIG_FIELDS array found', !!m);
const fields = m[1]
  .split(',')
  .map(s => s.trim().replace(/^['"`]|['"`]$/g, ''))
  .filter(Boolean);

console.log('  # current unsupported fields:', fields.join(', '));

// W10 negative-asserts:
ok('kv_namespaces NOT in unsupported list', !fields.includes('kv_namespaces'),
  'kv_namespaces still listed; W10 has not removed it');
ok('d1_databases NOT in unsupported list', !fields.includes('d1_databases'),
  'd1_databases still listed; W10 has not removed it');
ok('r2_buckets NOT in unsupported list', !fields.includes('r2_buckets'),
  'r2_buckets still listed; W10 has not removed it');

// W10 positive-asserts (these remain unsupported, per plan §9):
ok('queues remains unsupported', fields.includes('queues'));
ok('vectorize remains unsupported', fields.includes('vectorize'));

summary('w10/e2e/unsupported-fields-list-shrinks');
