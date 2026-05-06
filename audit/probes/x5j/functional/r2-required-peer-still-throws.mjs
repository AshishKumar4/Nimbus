#!/usr/bin/env bun
// X5J functional: the X.5-J fix MUST NOT extend the optional-peer
// soft-skip carve-out into the R2 (REQUIRED peer) path. Required peers
// in REJECT_INSTALL must STILL hard-fail. This probe asserts the R2
// blocks (line ~750 supervisor / ~732 facet) are unchanged in shape:
// no lookupReject / SHOULD_REJECT_FAIL consultation around them.

import { ok, group, summary } from '../../w6/_tap.mjs';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const RESOLVER_SRC = path.join(HERE, '../../../../src/npm-resolver.ts');
const FACET_SRC    = path.join(HERE, '../../../../src/npm-resolve-facet.ts');
const supervisor = fs.readFileSync(RESOLVER_SRC, 'utf8');
const facet      = fs.readFileSync(FACET_SRC, 'utf8');

// Extract R2 BFS-walk block (X.5-F R2 — REQUIRED peer-deps enqueue),
// distinct from R2.5. The R2 marker appears in 5 places in the file
// (type doc, versionToResolved, registryCacheToResolved, doc-block,
// resolveTree BFS). We anchor on the BFS-walk site by requiring
// "enqueue REQUIRED peer-deps" or "REQUIRED peerDeps" in the comment,
// and slice up to the R2.5 marker.
function extractR2(src) {
  const m = src.match(/\/\/ X\.5-F R2: enqueue[\s\S]*?(?=\/\/ X\.5-F R2\.5:)/);
  return m ? m[0] : '';
}

const r2sup = extractR2(supervisor);
const r2fac = extractR2(facet);

group('R2 blocks isolatable', () => {
  ok('supervisor R2 block exists', r2sup.length > 0);
  ok('facet R2 block exists',      r2fac.length > 0);
});

group('Supervisor R2 (required peers) does NOT consult REJECT_INSTALL', () => {
  ok('supervisor R2 has no lookupReject call',
    !/lookupReject\(/.test(r2sup));
  ok('supervisor R2 still has queue.push for required peers',
    /queue\.push/.test(r2sup));
  ok('supervisor R2 still iterates pkg.peerDependencies (required-only)',
    /pkg\.peerDependencies/.test(r2sup));
});

group('Facet R2 (required peers) does NOT consult REJECT_INSTALL', () => {
  ok('facet R2 has no SHOULD_REJECT_FAIL call',
    !/SHOULD_REJECT_FAIL\(/.test(r2fac));
  ok('facet R2 has no SHOULD_WARN_SKIP_TRANSITIVE call',
    !/SHOULD_WARN_SKIP_TRANSITIVE\(/.test(r2fac));
  ok('facet R2 still has queue2.push for required peers',
    /queue2\.push/.test(r2fac));
});

// Sanity: the resolveOne reject-throw path is preserved (RegistryRejectError
// still thrown for transitive='fail' rejects in the dependency walk).
group('Required-dep reject path preserved', () => {
  ok('supervisor still throws RegistryRejectError on transitive=fail',
    /throw new RegistryRejectError/.test(supervisor));
  ok('facet still tags __w6_reject = true on rejected fetch',
    /__w6_reject\s*=\s*true/.test(facet));
});

summary('r2-required-peer-still-throws');
