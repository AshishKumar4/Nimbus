#!/usr/bin/env bun
// Every facet body that carries a staged VFS snapshot also carries the cursor
// that snapshot was read at, and seeds it before the shims evaluate.
//
// The cursor is what makes a facet's first ACQUIRE an ordinary delta. Arrive
// without one and the barrier asks the authority about a null epoch, which no
// delta can be computed from, so the answer is poison — drop the whole resident
// set. The process then loses every staged cell to its own first async fs call,
// and the next synchronous read of any of them raises EAGAIN.
//
// This is a drift guard first and a behaviour test second. Three generators
// each assemble a facet body around the same snapshot preamble, written by
// hand; the one-shot body gained the seed and the other two did not, and the
// gap held for as long as nobody ran a resident process that read a staged data
// file synchronously after touching async fs. Every body carrying a snapshot is
// enumerated here, so a fourth cannot be added without answering for it.

import assert from 'node:assert/strict';

import { VFS_CURSOR_SEED_SOURCE } from '../../packages/worker/src/_shared/facet-vfs-cursor.ts';
import {
  generateEntrypointCode,
  generateLongRunningNodeCode,
} from '../../packages/worker/src/facets/manager.ts';
import { generateOpencodeRunnerCode } from '../../packages/worker/src/runtime/opencode-facet-runner.ts';

const CURSOR = { epoch: 'epoch-under-test', rev: 4242 };
const SHIMS = '/* __SHIMS_MARKER__ */';
const CRED = { uid: 1000, gid: 1000, groups: [1000], umask: 0o022 };

const vfsState = {
  bundle: { 'home/user/data.txt': 'staged' },
  manifest: { 'home/user': ['data.txt'] },
  metadata: { 'home/user/data.txt': { size: 6 } },
  cursor: CURSOR,
  reachableCount: 1,
  truncated: false,
};

const serializedSnapshot = {
  vfsBundle: JSON.stringify(vfsState.bundle),
  vfsManifest: JSON.stringify(vfsState.manifest),
  vfsMetadata: JSON.stringify(vfsState.metadata),
  vfsCursor: JSON.stringify(CURSOR),
};

const bodies = [
  {
    label: 'one-shot node facet',
    source: generateEntrypointCode('', vfsState, false, SHIMS).code,
  },
  {
    label: 'long-running node facet',
    source: generateLongRunningNodeCode('', vfsState, { cred: CRED }, false, SHIMS).code,
  },
  {
    label: 'staged-artifact (opencode) facet',
    source: generateOpencodeRunnerCode({
      argv: [], env: {}, cred: CRED, cwd: '/home/user', stdin: '',
      shimsCode: SHIMS, mode: 'oneshot', ...serializedSnapshot,
    }),
  },
];

for (const { label, source } of bodies) {
  assert.ok(
    source.includes(VFS_CURSOR_SEED_SOURCE.trim()),
    `${label}: splices the shared cursor seed rather than a hand-written copy`,
  );

  const seededAt = source.indexOf(VFS_CURSOR_SEED_SOURCE.trim());
  const shimsAt = source.indexOf(SHIMS);
  assert.ok(shimsAt > 0, `${label}: the shims are spliced in`);
  assert.ok(
    seededAt < shimsAt,
    `${label}: seeds the cursor BEFORE the shims — they read it into a closure `
      + 'const as they evaluate, so a later assignment replaces an object '
      + 'nothing still points at',
  );

  // The declaration and the seed together, evaluated: a textual match proves
  // the lines are present, not that they put the right cursor on globalThis.
  // Which channel carries the cursor differs by body, so every one of them is
  // supplied and the declaration picks the one it reads.
  const declaration = source.match(/^\s*const __MODULE_VFS_CURSOR = .*;$/m);
  assert.ok(declaration, `${label}: declares __MODULE_VFS_CURSOR before the seed`);
  const scope = { __nimbusVfsCursor: undefined };
  new Function('globalThis', 'vfsCursor', '__startArgs',
    `${declaration[0]}\n${VFS_CURSOR_SEED_SOURCE}`)(scope, CURSOR, { vfsCursor: CURSOR });
  assert.deepEqual(
    scope.__nimbusVfsCursor,
    CURSOR,
    `${label}: the seeded cursor is the one the snapshot was read at`,
  );
}

// The other half of the same invariant. Both node bodies are addressed by the
// bytes they generate — the one-shot by hash(code + bundle + manifest), the
// resident one by the digest its facet image is named for — so a cursor in the
// text gives the same program a different identity on every spawn, and hands a
// body shared across sessions an epoch belonging to one of them. Two cursors,
// one program, byte-identical output.
const otherCursor = { epoch: 'a-different-incarnation', rev: 9 };
const at = (cursor) => ({ ...vfsState, cursor });
assert.equal(
  generateEntrypointCode('', at(CURSOR), false, SHIMS).code,
  generateEntrypointCode('', at(otherCursor), false, SHIMS).code,
  'the one-shot body is addressed by its program, not by the cursor it runs at',
);
assert.equal(
  generateLongRunningNodeCode('', at(CURSOR), { cred: CRED }, false, SHIMS).code,
  generateLongRunningNodeCode('', at(otherCursor), { cred: CRED }, false, SHIMS).code,
  'the resident body is addressed by its program, not by the cursor it runs at',
);

// A facet built without a VFS has no state to be coherent with, and must not
// invent a cursor for one — the seed is a no-op, not a fabricated epoch.
const scope = { __nimbusVfsCursor: undefined };
new Function('globalThis', `const __MODULE_VFS_CURSOR = null;\n${VFS_CURSOR_SEED_SOURCE}`)(scope);
assert.equal(
  scope.__nimbusVfsCursor,
  undefined,
  'a snapshot-less facet is left with no cursor rather than a fabricated one',
);

console.log('facet-vfs-cursor-seeded: OK');
