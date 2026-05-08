#!/usr/bin/env bun
// X5J functional: src/npm-resolve-facet.ts R2.5 site (lines ~743-752)
// MUST consult REJECT_INSTALL via the preamble accessors
// (SHOULD_REJECT_FAIL / SHOULD_WARN_SKIP_TRANSITIVE) BEFORE enqueueing
// each optional peer.
//
// Source-level invariant probe. RED before Phase C, GREEN after.

import { ok, group, summary } from '../../w6/_tap.mjs';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const FACET_SRC = path.join(HERE, '../../../../src/npm/resolve-facet.ts');
const src = fs.readFileSync(FACET_SRC, 'utf8');

group('R2.5 facet block exists', () => {
  ok('npm-resolve-facet.ts has X.5-F R2.5 block',
    /X\.5-F R2\.5/.test(src));
  ok('R2.5 block uses topLevelNames.has(pkg.name)',
    /topLevelNames\.has\(pkg\.name\)[\s\S]{0,200}__allPeerDependencies/.test(src));
});

// Anchor on BFS-walker phrasing + slice to closing 6-space `}`.
const r25Match = src.match(/\/\/ X\.5-F R2\.5: when THIS pkg is[\s\S]*?\n      \}\n/);
ok('R2.5 block extractable', !!r25Match,
  r25Match ? '' : 'could not isolate R2.5 block');

const r25 = r25Match ? r25Match[0] : '';

group('R2.5 facet consults REJECT_INSTALL on each optional peer (preamble accessors)', () => {
  ok('R2.5 block references X.5-J',
    /X\.5-J/.test(r25));
  // Either SHOULD_REJECT_FAIL or SHOULD_WARN_SKIP_TRANSITIVE (or both)
  // must be called on peerName.
  ok('R2.5 block calls SHOULD_REJECT_FAIL(peerName)',
    /SHOULD_REJECT_FAIL\(\s*peerName\s*\)/.test(r25));
  ok('R2.5 block calls SHOULD_WARN_SKIP_TRANSITIVE(peerName)',
    /SHOULD_WARN_SKIP_TRANSITIVE\(\s*peerName\s*\)/.test(r25));
  ok('R2.5 block has a continue branch on rejected peer',
    /continue\s*;?/.test(r25));
});

group('R2.5 facet emits transitive-skip event for rejected peers', () => {
  ok('__EMIT_EVENT({ type: "transitive-skip", … }) inside R2.5',
    /__EMIT_EVENT\([^)]*type:\s*['"]transitive-skip['"]/.test(r25));
  ok('messages.push includes [skip] for rejected peer',
    /messages\.push\([^)]*\[skip\]/.test(r25));
  ok('reason mentions REJECT_INSTALL',
    /optional peer in REJECT_INSTALL/.test(r25));
});

group('R2.5 facet still enqueues non-rejected peers', () => {
  ok('R2.5 block still has queue2.push([peerName, ...',
    /queue2\.push\(\s*\[\s*peerName/.test(r25));
  ok('R2.5 block still has topLevelNames.add(peerName)',
    /topLevelNames\.add\(\s*peerName\s*\)/.test(r25));
});

summary('r25-rejects-optional-peer-facet');
