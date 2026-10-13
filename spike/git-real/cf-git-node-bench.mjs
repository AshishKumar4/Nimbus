// Today's engine at scale, on the host: cf-git (isomorphic-git fork) over
// node:fs, timing the operations Nimbus's `git` runs, with peak JS heap.
// Usage: node --expose-gc cf-git-node-bench.mjs <repo-dir> <op>
//   op: status | log100 | diff-index
import fs from 'node:fs';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const git = require('/mnt/local/nimbus/wt/lazy-worktree/packages/worker/node_modules/isomorphic-git/index.cjs');
const [dir, op] = process.argv.slice(2);
let peak = 0;
const sample = setInterval(() => { peak = Math.max(peak, process.memoryUsage().heapUsed); }, 5);
const cpu0 = process.cpuUsage();
const t = performance.now();
let detail;
if (op === 'status') {
  const m = await git.statusMatrix({ fs, dir });
  detail = { entries: m.length, changed: m.filter(([, h, w, s]) => !(h === w && w === s)).length };
} else if (op === 'log100') {
  detail = { commits: (await git.log({ fs, dir, depth: 100 })).length };
}
peak = Math.max(peak, process.memoryUsage().heapUsed);
clearInterval(sample);
const cpu = process.cpuUsage(cpu0);
console.log(JSON.stringify({ engine: 'cf-git/node', op, ms: Math.round(performance.now() - t), cpuMs: Math.round((cpu.user + cpu.system) / 1000), peakHeapMiB: +(peak / 1048576).toFixed(1), rssMiB: +(process.memoryUsage().rss / 1048576).toFixed(0), ...detail }));
