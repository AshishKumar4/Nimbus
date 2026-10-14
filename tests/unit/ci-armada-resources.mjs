// Scratch measurement: intentionally red so armada retains the whole output.
import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { availableParallelism } from 'node:os';
import { dirname, join } from 'node:path';

const read = (path) => {
  try { return readFileSync(path, 'utf8').trim(); } catch (error) { return error.code; }
};
const group = process.env.ARMADA_CGROUP;
const ancestors = [];
for (let path = group; path.startsWith('/sys/fs/cgroup'); path = dirname(path)) {
  ancestors.push(Object.fromEntries(['cpu.max', 'cpuset.cpus.effective', 'memory.max', 'memory.swap.max'].map((name) => [name, read(join(path, name))])));
  ancestors.at(-1).path = path;
  if (path === '/sys/fs/cgroup') break;
}
console.log(JSON.stringify({
  nproc: spawnSync('nproc', [], { encoding: 'utf8' }).stdout.trim(),
  availableParallelism: availableParallelism(),
  taskGroup: group,
  ancestors,
  selfGroup: read('/proc/self/cgroup'),
  affinity: read('/proc/self/status').split('\n').filter((line) => line.startsWith('Cpus_allowed_list:')),
  meminfo: read('/proc/meminfo').split('\n').slice(0, 3),
  cpu: read('/proc/cpuinfo').split('\n').find((line) => line.startsWith('model name')),
}, null, 2));
process.exitCode = 1;
