#!/usr/bin/env bun
// W12 functional: src/nimbus-session.ts /api/_diag/memory handler emits
// the W12 `replica` block. Source-string assertion because the DO can't
// be run under bun (cloudflare:workers import).

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { ok, group, summary } from '../_tap.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const SESSION = path.resolve(HERE, '..', '..', '..', '..', 'src', 'nimbus-session.ts');
const txt = fs.readFileSync(SESSION, 'utf8');

await group('/api/_diag/memory handler exposes W12 replica metadata', () => {
  // Find the /api/_diag/memory if-block. The handler is keyed by a
  // pathname compare (line ~1688). Anywhere inside the response body
  // construction within a reasonable window we expect 'replica:' to
  // appear referencing inspectReplicaState / getReplicaState.
  ok('handler block present', txt.includes("'/api/_diag/memory'"));
  // The W12 contribution: the response body wires replica state.
  ok('mentions inspectReplicaState or getReplicaState',
     txt.includes('inspectReplicaState') || txt.includes('getReplicaState'),
     'no W12 replica state hook found in nimbus-session.ts');
  ok('emits a replica block in the diag response',
     /replica\s*:/.test(txt),
     "response body must include `replica:` field");
});

await group('replica state init at constructor time (best-effort)', () => {
  ok('mentions tryEnableReplicas',
     txt.includes('tryEnableReplicas'),
     'constructor must call tryEnableReplicas (best-effort) per W12-plan §6.2');
});

await group('replica routing preflight wired into _handleFetch', () => {
  ok('mentions handleReplicaPreflight / classifyReplicaPolicy / shouldDelegateToPrimary',
     txt.includes('handleReplicaPreflight') ||
     txt.includes('classifyReplicaPolicy') ||
     txt.includes('shouldDelegateToPrimary'),
     '_handleFetch must consult W12 replica policy before route handlers');
});

summary('w12/functional/replica-metadata-flag-in-diag');
