import { readFileSync } from 'node:fs';
import { availableParallelism } from 'node:os';
import { dirname, join } from 'node:path';

/** Whole workers the task's CPU affinity and inherited cgroup v2 quotas fit. */
export function unitJobs({ group = process.env.ARMADA_CGROUP, affinity = availableParallelism(), read = readFileSync } = {}) {
  let cpus = affinity;
  for (let path = group; path && path.startsWith('/sys/fs/cgroup/'); path = dirname(path)) {
    let max;
    try { max = read(join(path, 'cpu.max'), 'utf8').trim(); } catch (error) {
      // A controller need not be enabled at every level (including the root).
      if (error.code === 'ENOENT') continue;
      throw error;
    }
    const [quota, period] = max.split(/\s+/);
    if (quota === 'max') continue;
    if (!(Number(quota) > 0 && Number(period) > 0)) throw new Error(`invalid cpu.max at ${path}: ${max}`);
    cpus = Math.min(cpus, Number(quota) / Number(period));
  }
  // A fractional-vCPU container still needs one worker to make progress.
  return Math.max(1, Math.floor(cpus));
}
