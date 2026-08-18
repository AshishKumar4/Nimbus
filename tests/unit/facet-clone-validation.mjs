#!/usr/bin/env bun
// ctx.facets.clone, behind the validation the measured hazard demands.
//
// Measured on production workerd: ANY `src` that does not resolve to a
// populated facet — a typo, a name not created yet, not merely ''/'.'/'/'—
// silently EMPTIES the destination and reports success. A blocklist of bad
// names would pass a typo straight through, so the fabric's one clone seam
// validates positively on BOTH ends: the caller's probe answers true for the
// source before the clone runs, and for the destination after it. What has to
// hold:
//
//   (1) a populated source clones, and the destination has the data;
//   (2) an unpopulated source is refused BEFORE the platform call — the
//       refusal is what keeps the destination's existing data alive;
//   (3) a clone that still emptied the destination fails loud AFTER, so
//       "success" is never reported over a wiped filesystem;
//   (4) a runtime without `clone` fails loud, not silently-absent.

import assert from 'node:assert/strict';
import { cloneFacetStorage } from '../../packages/fabric/src/workerd-facet-host.ts';

/**
 * The platform binding with its measured semantics: clone(src, dst) copies a
 * resolvable source's rows and — the hazard — resolves an unknown name to an
 * EMPTY source, wiping dst while returning void as if it worked.
 */
function createCloneWorld(seed = {}) {
  const stores = new Map(Object.entries(seed).map(([name, rows]) => [name, new Map(rows)]));
  const ctx = {
    storage: { async get() { return undefined; }, async put() {} },
    facets: {
      get() { throw new Error('not under test'); },
      abort() {},
      delete() {},
      clone(src, dst) {
        stores.set(dst, new Map(stores.get(src) ?? []));
      },
    },
  };
  const populated = (name) => (stores.get(name)?.size ?? 0) > 0;
  return { ctx, stores, populated };
}

// ── (1) a populated source clones, byte-for-byte ────────────────────────────
{
  const { ctx, stores, populated } = createCloneWorld({ fsnap: [['/etc/hosts', 'bytes']] });
  await cloneFacetStorage(ctx, { src: 'fsnap', dst: 'proc-fork', populated });
  assert.deepEqual(
    [...stores.get('proc-fork')],
    [['/etc/hosts', 'bytes']],
    'the destination holds the source rows',
  );
}

// ── (2) an unpopulated source is refused before the platform call ───────────
{
  const { ctx, stores, populated } = createCloneWorld({
    fsnap: [['/etc/hosts', 'bytes']],
    'proc-fork': [['/precious', 'survives']],
  });
  await assert.rejects(
    cloneFacetStorage(ctx, { src: 'fsnpa', dst: 'proc-fork', populated }),
    (error) => {
      assert.match(error.message, /'fsnpa'/);
      assert.match(error.message, /EMPTIES the destination/i);
      return true;
    },
    'a typo in src must be refused, and the refusal must name the hazard',
  );
  assert.deepEqual(
    [...stores.get('proc-fork')],
    [['/precious', 'survives']],
    'the refusal is what kept the destination intact — the platform call never ran',
  );
}

// ── (3) a clone that still emptied the destination fails loud after ─────────
{
  const { ctx, populated } = createCloneWorld({ fsnap: [['/etc/hosts', 'bytes']] });
  // The pre-check passes on the caller's own accounting, but the platform
  // resolves the name to an empty source anyway (the race the probe cannot
  // close from outside). The post-check is what refuses to report success.
  ctx.facets.clone = (_src, dst) => { void dst; };
  await assert.rejects(
    cloneFacetStorage(ctx, { src: 'fsnap', dst: 'proc-fork', populated }),
    (error) => {
      assert.match(error.message, /'proc-fork'/);
      return true;
    },
    'an emptied destination must never be reported as a successful clone',
  );
}

// ── (4) a runtime without clone fails loud ──────────────────────────────────
{
  const { ctx, populated } = createCloneWorld({ fsnap: [['/etc/hosts', 'bytes']] });
  delete ctx.facets.clone;
  await assert.rejects(
    cloneFacetStorage(ctx, { src: 'fsnap', dst: 'proc-fork', populated }),
    /clone is unavailable/,
    'absence of the capability is an error, not a silent no-op',
  );
}

console.log('ok - facet-clone-validation (populated clones, typo refused, wipe caught, absence loud)');
