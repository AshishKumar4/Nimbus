#!/usr/bin/env bun
// A pooled task's call that the platform refused at the Dynamic Worker limit
// is sent again, since nothing ran; a task that ran and then threw, whatever
// its words, is not. Each worker is the pool's own generated module, entered
// as workerd enters it (its default export's execute), behind a loader that
// refuses a start before entering it as the platform does. What has to hold,
// for every wording the platform has refused a start with:
//
//   (1) a task that wrote and then threw those words ran once, and its
//       failure is the caller's;
//   (2) a call refused before it started is sent again, and its answer is
//       the caller's.

import assert from 'node:assert/strict';
import { mock } from 'bun:test';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';

mock.module('cloudflare:workers', () => ({
  WorkerEntrypoint: class { constructor(ctx, env) { this.ctx = ctx; this.env = env; } },
}));
const { IsolatePool } = await import('../../packages/fabric/src/isolate-pool.ts');
const { facetTaskSource } = await import('../../packages/core/src/runtime/facet-task.ts');
const { ISOLATE_NETWORK } = await import('../../packages/core/src/_shared/workspace-network.ts');

const REFUSALS = [
  'Dynamic worker concurrency limit exceeded: each request may have up to 10 concurrent dynamic worker invocations. Wait for one to finish before starting another.',
  'Too many dynamic workers.',
  'Too many dynamic workers. (remote) (peer-do)',
  'Too many dynamic workers are starting concurrently. (remote) (peer-do)',
];

const dirs = [];
/** A loader that builds each worker from the module the pool hands it; its first `refuse` calls are refused with `words` before entry. */
function loader(words, refuse) {
  const calls = { refused: 0, entered: 0 };
  const built = new Map();
  const LOADER = {
    get(id, load) {
      if (!built.has(id)) {
        built.set(id, (async () => {
          const code = await load();
          const dir = mkdtempSync(join(tmpdir(), 'nimbus-pool-entry-'));
          dirs.push(dir);
          writeFileSync(join(dir, code.mainModule), code.modules[code.mainModule]);
          const { default: Entry } = await import(pathToFileURL(join(dir, code.mainModule)).href);
          return new Entry({}, code.env ?? {});
        })());
      }
      return {
        getEntrypoint: () => ({
          async execute(...args) {
            if (calls.refused < refuse) { calls.refused++; throw new Error(words); }
            calls.entered++;
            return (await built.get(id)).execute(...args);
          },
        }),
      };
    },
  };
  return { env: { LOADER }, calls };
}

let n = 0;
const pool = (env) => new IsolatePool(env, { id: { toString: () => `entered-${++n}` }, waitUntil() {} },
  { tag: 'entered', network: ISOLATE_NETWORK, omitSupervisor: true, timeoutMs: 0, retries: 0 });

try {
  for (const words of REFUSALS) {
    // ── (1) ran, wrote, threw the words: once ─────────────────────────────────
    {
      globalThis.__poolWrites = 0;
      const { env, calls } = loader(words, 0);
      const task = facetTaskSource(`async (words) => { globalThis.__poolWrites++; throw new Error(words); }`);
      await assert.rejects(pool(env).submit(task, words), (error) => String(error?.message ?? error).includes(words.slice(0, 24)));
      assert.deepEqual(calls, { refused: 0, entered: 1 }, `"${words}" thrown by a task that ran is not sent again`);
      assert.equal(globalThis.__poolWrites, 1, 'its write happened once');
    }
    // ── (2) refused before it started: sent again ────────────────────────────
    {
      const { env, calls } = loader(words, 1);
      assert.equal(await pool(env).submit(facetTaskSource('async (x) => x + 1'), 41), 42, `"${words}" before entry: the call is sent again`);
      assert.deepEqual(calls, { refused: 1, entered: 1 });
    }
  }
} finally {
  for (const dir of dirs) rmSync(dir, { recursive: true, force: true });
  delete globalThis.__poolWrites;
}

console.log('isolate-pool-entered-failure: ok');
