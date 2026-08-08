#!/usr/bin/env bun
// score.mjs — score raw tti.mjs output using ComputeSDK's OWN statistics
// and scoring code, so the result is comparable to their leaderboard
// rather than a re-derivation that might quietly differ.
//
// It imports upstream's `computeStats` (5% trim at both ends, their
// percentile definition) and `computeCompositeScores` (10s ceiling,
// weights 0.60/0.25/0.15, multiplied by success rate) directly from a
// checkout of github.com/computesdk/benchmarks. If that checkout is
// missing it refuses to score rather than substituting its own maths.
//
//   git clone https://github.com/computesdk/benchmarks.git
//   COMPUTESDK_BENCHMARKS=./benchmarks bun bench/score.mjs bench-results/*.json

import { readFileSync, existsSync } from 'node:fs';
import { resolve } from 'node:path';

const repo = process.env.COMPUTESDK_BENCHMARKS;
if (!repo || !existsSync(resolve(repo, 'benchmarks/sandbox/scoring.ts'))) {
  console.error(
    'score: set COMPUTESDK_BENCHMARKS to a checkout of\n' +
      '  https://github.com/computesdk/benchmarks\n' +
      'so scoring uses their code. Refusing to score with a local reimplementation.',
  );
  process.exit(2);
}

const { computeStats } = await import(resolve(repo, 'benchmarks/src/util/stats.ts'));
const { computeCompositeScores } = await import(resolve(repo, 'benchmarks/sandbox/scoring.ts'));

const files = process.argv.slice(2);
if (files.length === 0) {
  console.error('score: pass one or more raw result JSON files');
  process.exit(2);
}

const rows = [];
for (const file of files) {
  const record = JSON.parse(readFileSync(file, 'utf8'));
  const iterations = record.trials.map((t) => (t.error ? { ttiMs: 0, error: t.error } : { ttiMs: t.ttiMs }));
  const successes = record.trials.filter((t) => !t.error);

  const result = {
    provider: `nimbus (${record.workload.name})`,
    mode: record.shape,
    iterations,
    summary: { ttiMs: computeStats(successes.map((t) => t.ttiMs)) },
  };
  computeCompositeScores([result]);

  rows.push({
    workload: record.workload.name,
    shape: record.shape,
    n: record.trials.length,
    ok: `${(result.successRate * 100).toFixed(0)}%`,
    median: Math.round(result.summary.ttiMs.median),
    p95: Math.round(result.summary.ttiMs.p95),
    p99: Math.round(result.summary.ttiMs.p99),
    score: Number(result.compositeScore.toFixed(2)),
    createMed: Math.round(computeStats(successes.map((t) => t.createMs)).median),
    execMed: Math.round(computeStats(successes.map((t) => t.execMs)).median),
    rttMed: Math.round(record.control.rttMedianMs),
    bareReadyMed: record.control.bareReadyMedianMs
      ? Math.round(record.control.bareReadyMedianMs)
      : null,
  });
}

console.table(rows);
console.log('\nmedian/p95/p99 are upstream computeStats (5% trimmed both ends).');
console.log('score is upstream computeCompositeScores: 10s ceiling, 0.60/0.25/0.15, x success rate.');
console.log('createMed/execMed are the TTI phases; rttMed is plain HTTP round trip to the same origin.');
