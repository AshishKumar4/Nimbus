import assert from 'node:assert/strict';
import { writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { parseArgs } from 'node:util';
import { assertArmsInside, repository } from './isolated-core.mjs';
import { pairedKind, shuffled } from './paired-cpu.mjs';

/**
 * A paired bench's run: its arms each made from a side's tree (`from`, a
 * repository root: `A` and `null` the baseline's, which --baseline names,
 * `real` this one), every module an arm resolved checked at the end to lie
 * inside its own (isolated-core.mjs).
 */
export async function runPairedBenchmark({ run }) {
  const { values } = parseArgs({
    options: { baseline: { type: 'string' }, out: { type: 'string' }, short: { type: 'boolean', default: false } },
  });
  assert.ok(values.baseline, '--baseline is required');
  assert.ok(values.out, '--out is required');
  const sources = { A: resolve(values.baseline), null: resolve(values.baseline), real: repository };
  const cleanups = [];
  const results = [];
  const context = {
    short: values.short,
    cleanup: (dispose) => cleanups.push(dispose),
    async withArms(create, work, { from = sources, dispose } = {}) {
      const arms = {};
      try {
        for (const name of shuffled(Object.keys(from))) arms[name] = await create(from[name], name);
        return await work(arms);
      } finally {
        if (dispose) for (const arm of Object.values(arms)) await dispose(arm);
      }
    },
    async sample(kind, arms, cpu, sampling) {
      const actual = values.short ? { ...sampling, pairs: Math.min(sampling.pairs, 3), warm: Math.min(sampling.warm, 1) } : sampling;
      const result = await pairedKind(kind, arms, cpu, actual);
      results.push(result);
      writeFileSync(values.out, `${JSON.stringify(results, null, 2)}\n`);
      const { samples, ...summary } = result;
      console.log(JSON.stringify(summary));
      return result;
    },
  };
  try {
    await run(context);
    assert.ok(results.length > 0, 'the benchmark produced samples');
    assertArmsInside();
  } finally {
    for (const dispose of cleanups.reverse()) await dispose();
  }
}
