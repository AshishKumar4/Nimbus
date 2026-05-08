#!/usr/bin/env bun
// X5J functional: src/npm-resolver.ts R2.5 site (lines ~757-773) MUST
// consult REJECT_INSTALL before enqueueing each optional peer.
//
// Source-level invariant probe. This is RED before the Phase C edit
// and GREEN after.

import { ok, group, summary } from '../../w6/_tap.mjs';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const RESOLVER_SRC = path.join(HERE, '../../../../src/npm/resolver.ts');
const src = fs.readFileSync(RESOLVER_SRC, 'utf8');

// Locate the R2.5 block: `if (topLevelNames.has(pkg.name))` …
// `__allPeerDependencies`. We assume the X5J fix lives inside this
// block and consults `lookupReject` (the supervisor REJECT_INSTALL
// accessor) on each `peerName` BEFORE the `queue.push`.
group('R2.5 supervisor block exists', () => {
  ok('npm-resolver.ts has X.5-F R2.5 block',
    /X\.5-F R2\.5/.test(src));
  ok('R2.5 block uses topLevelNames.has(pkg.name)',
    /topLevelNames\.has\(pkg\.name\)[\s\S]{0,200}__allPeerDependencies/.test(src));
});

// Extract just the BFS-walker R2.5 block, distinct from the
// versionToResolved R2.5 marker at npm-resolver.ts:495 (which is just
// data plumbing). Anchor on the BFS-walker's specific phrasing
// "when the user typed THIS package at top level". Slice up to the
// closing `      }` that terminates the `if (topLevelNames.has(pkg.name))`
// block — match a 6-space-indented `}` to be safe.
const r25Match = src.match(/\/\/ X\.5-F R2\.5: when the user typed[\s\S]*?\n      \}\n/);
ok('R2.5 block extractable', !!r25Match,
  r25Match ? '' : 'could not isolate R2.5 block');

const r25 = r25Match ? r25Match[0] : '';

group('R2.5 supervisor consults REJECT_INSTALL on each optional peer', () => {
  ok('R2.5 block references X.5-J',
    /X\.5-J/.test(r25));
  ok('R2.5 block calls lookupReject(peerName) (or equivalent)',
    /lookupReject\(\s*peerName\s*\)/.test(r25));
  ok('R2.5 block has a continue branch on rejected peer',
    /continue\s*;?/.test(r25));
});

group('R2.5 supervisor emits transitive-skip event for rejected peers', () => {
  ok('emitRegistryEvent({ type: "transitive-skip", … }) inside R2.5',
    /emitRegistryEvent\([^)]*type:\s*['"]transitive-skip['"]/.test(r25));
  ok('reason mentions REJECT_INSTALL',
    /reason[\s\S]{0,80}REJECT_INSTALL|optional peer in REJECT_INSTALL/.test(r25));
});

group('R2.5 supervisor still enqueues non-rejected peers', () => {
  ok('R2.5 block still has queue.push([peerName, peerRange ...',
    /queue\.push\(\s*\[\s*peerName/.test(r25));
  ok('R2.5 block still has topLevelNames.add(peerName)',
    /topLevelNames\.add\(\s*peerName\s*\)/.test(r25));
});

summary('r25-rejects-optional-peer-supervisor');
