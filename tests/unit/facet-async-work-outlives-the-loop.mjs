#!/usr/bin/env bun
// A one-shot facet's lifetime IS its event loop, and the loop ends the program
// when no handle is live. An in-flight supervisor RPC is one of those handles,
// so every RPC the runtime issues on the program's behalf has to be counted —
// including the ones no frame of the program is sitting on.
//
// The write-back is exactly that. A synchronous write can only park its
// bytes, so the process's client carries them to the authority in a wave
// outside any call the program is awaiting. That wave was uncounted, and the
// explicit flush behind it joined the same in-flight promise rather than
// starting its own, so a program waiting for its own write was waiting on
// nothing the loop could see. Measured live: `fs.promises.cp` of a template
// tree — which is how create-cloudflare scaffolds — copied two files of
// twenty-eight and the program ended, silently, exit 0.
//
// This is the composition the two halves are only correct together in: the
// real loop over the real shims and the real filesystem, against an authority
// with latency, because the gap only opens while a round trip is outstanding.

import assert from 'node:assert/strict';
import { ENTRYPOINT_EVENT_LOOP } from '../../packages/worker/src/facets/manager.ts';
import { CRED_KERNEL } from '../../packages/core/src/runtime/os-contracts.ts';
import { createAuthority } from './lib/resident-body.mjs';
import { processBridge } from './lib/process-bridge.mjs';
import { observed, sessionShims } from './lib/session-shims.mjs';

const enc = new TextEncoder();
const dec = new TextDecoder();

const cwd = '/home/user/example-app';
const SRC = '/tpl/hello';
const TEMPLATE_FILES = ['.editorconfig', '__dot__gitignore', 'package.json', 'wrangler.jsonc', 'vitest.config.js'];
const authority = createAuthority();
const rawVfs = authority.rawVfs;
const vfs = rawVfs.as(CRED_KERNEL);
// The process's working tree is its own, as a session's home is.
authority.kfs.mkdir(cwd.slice(1), { recursive: true, mode: 0o755 });
vfs.mkdir(`${SRC}/js/src`, { recursive: true });
vfs.writeFile(`${SRC}/c3.ts`, enc.encode('x'.repeat(200)));
for (const name of TEMPLATE_FILES) vfs.writeFile(`${SRC}/js/${name}`, enc.encode('y'.repeat(300)));
vfs.writeFile(`${SRC}/js/src/index.js`, enc.encode('z'.repeat(400)));
const bridge = observed(processBridge(rawVfs, rawVfs.as({ uid: 1000, gid: 1000, groups: [1000], umask: 0o022 })));

// The raw timer, captured before the shims wrap globalThis.setTimeout with the
// resumption barrier: the latency below is the authority's, not a
// resumption of the program, and a wrapped timer would keep an ACQUIRE in
// flight for the whole test and hide the very gap being measured.
const rawSetTimeout = globalThis.setTimeout;
const wait = (ms) => new Promise((resolve) => rawSetTimeout(resolve, ms));
// Enough that a round trip spans several of the loop's 1ms passes, which is
// what production latency does and what the failure needs.
const LATENCY_MS = 20;
const slow = (fn) => async (...args) => { await wait(LATENCY_MS); return fn(...args); };

globalThis.__nimbusRawSetTimeout = rawSetTimeout;
globalThis.__nimbusRawClearTimeout = globalThis.clearTimeout;
globalThis.__nimbusProcessExitPromise = new Promise(() => {});

const { fs, runToExit } = sessionShims(authority, {
  cwd,
  overrides: (call) => ({
    fsAcquire: slow((...args) => call('fsAcquire', args)),
    fsReadBatch: slow((...args) => call('fsReadBatch', args)),
    fsReadRange: slow((...args) => call('fsReadRange', args)),
    writeBatchStream: slow((...args) => call('writeBatchStream', args)),
    stat: slow((...args) => call('stat', args)),
    readdir: slow((...args) => call('readdir', args)),
  }),
  tail: `\n${ENTRYPOINT_EVENT_LOOP}\n;return { fs: __fsMod, runToExit: __nimbusRunEntrypointToExit };`,
});

let copyResolved = false;
const program = fs.promises.cp(SRC, `${cwd}/dest`, { recursive: true, force: true })
  .then(() => { copyResolved = true; });

// The loop must not have seen an empty handle table while the copy was still
// running: it ends the program the first time it does.
const loop = await runToExit(undefined, 10_000);
assert.equal(copyResolved, true, 'the copy must have resolved before the loop ended');
assert.equal(loop.pending, 0, 'and the loop must have ended because the work was done');

// The copy is complete at the AUTHORITY, not just in the facet's own view: the
// program ending is what would have stranded the parked writes.
const copied = (await bridge.readdir(`${cwd}/dest/js`)).map((e) => e.name).sort();
assert.deepEqual(
  copied, [...TEMPLATE_FILES, 'src'].sort(),
  `the whole template must have reached the authority (got ${JSON.stringify(copied)})`,
);
assert.equal(
  dec.decode(await bridge.readFile(`${cwd}/dest/js/src/index.js`)), 'z'.repeat(400),
  'including the nested file, with its bytes',
);

console.log('ok - facet-async-work-outlives-the-loop');
