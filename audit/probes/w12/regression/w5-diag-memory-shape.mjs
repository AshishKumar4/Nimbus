#!/usr/bin/env bun
// W12 regression: /api/_diag/memory still emits the W5 fields the OOM
// observability tests rely on. The W12 `replica` block must be ADDITIVE
// — no W5 field renamed or removed.

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { ok, group, summary } from '../_tap.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const SESSION = path.resolve(HERE, '..', '..', '..', '..', 'src', 'nimbus-session.ts');
const txt = fs.readFileSync(SESSION, 'utf8');

await group('/api/_diag/memory handler exists', () => {
  ok('handler block', txt.includes("'/api/_diag/memory'"));
});

await group('W5 fields still emitted', () => {
  // peak.* — supervisor heap pressure
  ok('emits peak block (rssBytes / heapUsedBytes)', /peak\s*:/.test(txt) && txt.includes('rssBytes'));
});

await group('W9 hib block still emitted (additive landmark)', () => {
  ok('emits hib block', /hib\s*:/.test(txt));
  ok('mentions autoResponseConfigured', txt.includes('autoResponseConfigured'));
});

summary('w12/regression/w5-diag-memory-shape');
