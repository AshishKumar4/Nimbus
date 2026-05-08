#!/usr/bin/env bun
// X.5-drizzle functional — pre-fix RED, post-fix GREEN.
//
// Asserts: src/npm-resolver.ts and src/npm-resolve-facet.ts contain
// the X.5-drizzle "best-effort optional-peer subtree" soft-skip path
// (the load-bearing fix for the drizzle-orm regression).
// Plain-text source assertion. RED if the bestEffortNames Set is
// missing or the soft-skip branch is absent.

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { ok, group, summary } from '../../w11/_tap.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.resolve(HERE, '..', '..', '..', '..');

const resolverSrc = fs.readFileSync(path.join(REPO, 'src', 'npm', 'resolver.ts'), 'utf8');
const facetSrc = fs.readFileSync(path.join(REPO, 'src', 'npm', 'resolve-facet.ts'), 'utf8');

await group('npm-resolver.ts: bestEffortNames declared', () => {
  ok('bestEffortNames Set declared', /const bestEffortNames\s*=\s*new Set<string>\(\)/.test(resolverSrc));
  ok('X.5-drizzle rationale comment present', /X\.5-drizzle/.test(resolverSrc));
});

await group('npm-resolver.ts: registry-reject soft-skip branch', () => {
  ok('soft-skip branch refers to bestEffortNames',
     /bestEffortNames\.has\(name\)/.test(resolverSrc));
  ok('soft-skip branch quotes the canonical chain',
     /expo-sqlite|optional-peer subtree/.test(resolverSrc));
});

await group('npm-resolver.ts: X.5-J path tags optional peers as best-effort', () => {
  // The X.5-J optional-peer enqueue must mark the peer as bestEffort
  // when adding to topLevelNames + queue.
  const xjBlock = resolverSrc.match(/topLevelNames\.add\(peerName\);[\s\S]{0,800}queue\.push\(\[peerName, peerRange/);
  ok('X.5-J enqueue block located', !!xjBlock);
  if (xjBlock) {
    ok('block calls bestEffortNames.add(peerName)', /bestEffortNames\.add\(peerName\)/.test(xjBlock[0]));
  }
});

await group('npm-resolve-facet.ts: bestEffortNames mirror', () => {
  ok('bestEffortNames Set declared (facet)', /const bestEffortNames\s*=\s*new Set<string>\(\)/.test(facetSrc));
  ok('X.5-drizzle rationale comment present (facet)', /X\.5-drizzle/.test(facetSrc));
  ok('facet soft-skip branch refers to bestEffortNames',
     /bestEffortNames\.has\(name\)/.test(facetSrc));
  ok('facet X.5-J enqueue tags peer as bestEffort',
     /bestEffortNames\.add\(peerName\)/.test(facetSrc));
});

await group('inheritBestEffort propagation present', () => {
  // Both files should propagate the flag through dep/optdep/peer enqueues.
  ok('npm-resolver.ts: inheritBestEffort propagation', /inheritBestEffort/.test(resolverSrc));
  ok('npm-resolve-facet.ts: inheritBestEffort propagation', /inheritBestEffort/.test(facetSrc));
});

await summary('x5-drizzle/functional/installer-detect-source-shape');
