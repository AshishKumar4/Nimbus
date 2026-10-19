#!/usr/bin/env node
// The supervisor's credit pool under V8, as workerd runs it: asks granted at
// once, and asks that queue and are served as credit comes back, the path a
// running program's reads and writes take under load.
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { cpuMs } from './lib/paired-cpu.mjs';
import { PLATFORM_CPU_SOURCES } from './lib/cpu-sources.mjs';
import { armTree, importBundle } from './lib/isolated-core.mjs';
import { runPairedBenchmark } from './lib/paired-runner.mjs';

let checksum = 0;

/** Each arm bundled on its own, from its side's tree (`from`). */
async function arm(name, from, scratch, cleanup) {
  const tree = armTree(from, cleanup);
  const dir = join(tree, PLATFORM_CPU_SOURCES.source);
  const contents = `export { WeightedCreditPool } from ${JSON.stringify(join(dir, 'weighted-credit-pool.ts'))};`;
  return importBundle(tree, { stdin: { contents, resolveDir: dir, loader: 'js' }, format: 'esm', platform: 'neutral', target: 'esnext' }, join(scratch, `${name}.mjs`));
}

const MiB = 1024 * 1024;

function workloads(short) {
  const rounds = short ? 4 : 400;
  const waiters = short ? 4 : 64;
  return {
    // Free credit, taken and given back: tryAcquire's path.
    async uncontended({ WeightedCreditPool }) {
      const pool = new WeightedCreditPool(40 * MiB, { smallRequestBytes: 64 * 1024, reserve: MiB });
      for (let i = 0; i < rounds * 16; i++) {
        const lease = await pool.acquire(4 * MiB);
        checksum += lease.bytes;
        lease.release();
      }
    },
    // A full pool, `waiters` ordinary asks queued behind it, served one by one as each gives back.
    async queued({ WeightedCreditPool }) {
      for (let round = 0; round < rounds / 4; round++) {
        const pool = new WeightedCreditPool(40 * MiB);
        const held = await pool.acquire(40 * MiB);
        const asks = Array.from({ length: waiters }, () => pool.acquire(30 * MiB).then((lease) => { checksum += lease.bytes; lease.release(); }));
        held.release();
        await Promise.all(asks);
      }
    },
    // Running asks ahead of ordinary ones, all queued behind a full pool.
    async ahead({ WeightedCreditPool }) {
      for (let round = 0; round < rounds / 4; round++) {
        const pool = new WeightedCreditPool(40 * MiB);
        const held = await pool.acquire(40 * MiB);
        const asks = [];
        for (let i = 0; i < waiters; i++) {
          const ask = i % 2 === 0 ? pool.acquire(20 * MiB) : pool.acquireAhead(4 * MiB);
          asks.push(ask.then((lease) => { checksum += lease.bytes; lease.release(); }));
        }
        held.release();
        await Promise.all(asks);
      }
    },
  };
}

await runPairedBenchmark({
  async run({ short, cleanup, withArms, sample }) {
    const scratch = mkdtempSync(join(tmpdir(), 'credit-pool-cpu-'));
    cleanup(() => rmSync(scratch, { recursive: true, force: true }));
    const work = workloads(short);
    await withArms((from, name) => arm(name, from, scratch, cleanup), async (arms) => {
      for (const kind of Object.keys(work)) {
        await sample(kind, arms, (exports) => cpuMs(() => work[kind](exports)), { pairs: 30, warm: 8, iterations: 1 });
      }
    });
    assert.ok(checksum > 0);
  },
});
