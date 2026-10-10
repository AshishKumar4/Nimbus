#!/usr/bin/env bun
// Paired Kinu launch allocation experiment. The exact same real exec fixture
// runs in fresh Bun processes on each commit; no workstation computation.
import { spawnSync } from 'node:child_process';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { mapOnArmada } from './lib/armada.mjs';
import { NIMBUS_STATE } from './lib/state-dir.mjs';

const repo = process.cwd();
const git = args => {
  const answer = spawnSync('git', args, { cwd: repo, encoding: 'utf8' });
  if (answer.status !== 0) throw new Error(answer.stderr);
  return answer.stdout.trim();
};
if (process.argv.length !== 3) throw new Error('usage: bun scripts/ci/remote-hosting-perf.mjs <baseline-commit>');
const baseline = git(['rev-parse', process.argv[2]]), head = git(['rev-parse', 'HEAD']);
if (git(['status', '--porcelain'])) throw new Error('commit the experiment before running');
const worker = `
  import { spawnSync } from 'node:child_process';
  const runs=[];
  for(let i=0;i<3;i++) {
    const result=spawnSync(process.execPath,['tests/unit/prefetch-serialization-allocation.mjs'],{encoding:'utf8',timeout:120000});
    const line=result.stdout.split('\\n').find(line=>line.startsWith('PREFETCH_SERIALIZATION '));
    if(!line)throw Error(result.stdout+result.stderr);
    runs.push({...JSON.parse(line.slice('PREFETCH_SERIALIZATION '.length)),exitCode:result.status});
  }
  await Bun.write(process.argv[1],JSON.stringify({ runs }));
`;
const results = [];
for (const [name, sha] of [['baseline', baseline], ['head', head]]) {
  const mapped = await mapOnArmada({ repo, sha, files: ['tests/unit/prefetch-serialization-allocation.mjs'],
    items: [1], command: ['bun', '-e', worker, '{out}'], label: `kinu-prefetch-${name} ${sha.slice(0, 12)}`, timeout: 600 });
  if (!mapped.outputs[0]) throw new Error(`${name}: ${JSON.stringify(mapped.outcomes)}`);
  results.push({ name, sha, job: mapped.jobId, ...JSON.parse(mapped.outputs[0]) });
}
const dir = join(NIMBUS_STATE, 'hosting-perf');
mkdirSync(dir, { recursive: true });
const path = join(dir, `${head.slice(0, 12)}-${Date.now()}.json`);
writeFileSync(path, JSON.stringify(results, null, 2));
const median = values => [...values].sort((a, b) => a - b)[Math.floor(values.length / 2)];
for (const result of results) console.log(JSON.stringify({ name: result.name, sha: result.sha, job: result.job,
  medianMs: median(result.runs.map(run => run.elapsedMs)), medianPeakOverBase: median(result.runs.map(run => run.peakOverBase)),
  runs: result.runs }));
console.log(`hosting-perf: ${path}`);
if (results[1].runs.some(run => run.exitCode !== 0)) process.exitCode = 1;
