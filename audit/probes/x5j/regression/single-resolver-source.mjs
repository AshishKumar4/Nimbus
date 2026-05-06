#!/usr/bin/env bun
// X5J regression: the supervisor (npm-resolver.ts) and facet
// (npm-resolve-facet.ts) BFS walkers stay in lockstep — both must have
// the X.5-J carve-out, OR neither (this is checked by the functional
// probes, see r25-rejects-optional-peer-{supervisor,facet}.mjs).
//
// This probe is a SHAPE check: count the "X.5-J" markers in both
// files; expect ≥ 1 in each.
//
// Reuses X5G's single-resolver-source-of-truth invariant: there must
// be exactly one resolveExports / resolvePackageEntry declaration in
// _shared/exports-resolver.ts (the X.5-J fix does NOT touch this).

import { ok, group, summary } from '../../w6/_tap.mjs';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const RESOLVER_SRC = path.join(HERE, '../../../../src/npm-resolver.ts');
const FACET_SRC    = path.join(HERE, '../../../../src/npm-resolve-facet.ts');
const supervisor = fs.readFileSync(RESOLVER_SRC, 'utf8');
const facet      = fs.readFileSync(FACET_SRC, 'utf8');

const supX5J = (supervisor.match(/X\.5-J/g) || []).length;
const facX5J = (facet.match(/X\.5-J/g) || []).length;

group('X.5-J markers present in both supervisor and facet', () => {
  ok(`supervisor has X.5-J marker(s) — count=${supX5J}`, supX5J >= 1);
  ok(`facet has X.5-J marker(s) — count=${facX5J}`,      facX5J >= 1);
});

// Single-resolver invariant from prior waves (W2.6a, X.5-G):
// resolveExports + resolvePackageEntry each declared exactly once in
// _shared/exports-resolver.ts.
const EXPORTS_RESOLVER = path.join(HERE, '../../../../src/_shared/exports-resolver.ts');
group('single-resolver invariant (W2.6a) preserved', () => {
  const src = fs.existsSync(EXPORTS_RESOLVER)
    ? fs.readFileSync(EXPORTS_RESOLVER, 'utf8')
    : '';
  ok('_shared/exports-resolver.ts exists', src.length > 0);
  if (src.length === 0) return;
  const re = (m) => (src.match(m) || []).length;
  ok(`exports-resolver: exactly 1 export function resolveExports — got ${re(/export function resolveExports\b/g)}`,
    re(/export function resolveExports\b/g) === 1);
  ok(`exports-resolver: exactly 1 export function resolvePackageEntry — got ${re(/export function resolvePackageEntry\b/g)}`,
    re(/export function resolvePackageEntry\b/g) === 1);
});

summary('single-resolver-source');
