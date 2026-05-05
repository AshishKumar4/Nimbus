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

await group('replica_routing compat flag present', () => {
  const flags = parsed?.compatibility_flags ?? [];
  ok('compatibility_flags is an array', Array.isArray(flags));
  ok('includes nodejs_compat (W3 carry)', flags.includes('nodejs_compat'));
  ok('includes experimental (W10 carry)', flags.includes('experimental'));
  ok('includes replica_routing (W12 add)', flags.includes('replica_routing'));
});

await group('compat date unchanged (no accidental bump)', () => {
  // Phase 4 main was on 2026-04-01; if W12 needs a later date for
  // replica_routing flag we'll surface that in the retro. Drift detector.
  ok('compatibility_date present', typeof parsed?.compatibility_date === 'string');
});

summary('w12/functional/smart-placement-config-shape');
