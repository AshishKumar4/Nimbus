import assert from 'node:assert/strict';
import { writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { parseArgs } from 'node:util';
import { pairedKind, shuffled } from './paired-cpu.mjs';

const repository = new URL('../../../', import.meta.url).pathname;
export const benchmarkSource = (source) => resolve(repository, source);

export async function runPairedBenchmark({ source, run }) {
  const { values } = parseArgs({
    options: { baseline: { type: 'string' }, out: { type: 'string' }, short: { type: 'boolean', default: false } },
  });
  assert.ok(values.baseline, '--baseline is required');
  assert.ok(values.out, '--out is required');
  const sources = { A: resolve(values.baseline), null: resolve(values.baseline), real: benchmarkSource(source) };
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
  } finally {
    for (const dispose of cleanups.reverse()) await dispose();
  }
}
