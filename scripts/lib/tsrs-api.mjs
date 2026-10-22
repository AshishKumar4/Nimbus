// tsrs's API (tsrs/unstable/sync) talks to the tsrs process it starts
// through the descriptors of that process's pipes (its SyncRpcChannel reads
// stdout._handle.fd), which only Node gives it: a child process of bun has
// none. So a function that uses the API runs in Node: called from bun, it
// runs through `inNode`, in a node process that imports its module.
import { spawnSync } from 'node:child_process';

/** Whether this process runs tsrs's API itself (Node), or through `inNode` (bun). */
export const RUNS_TSRS_API = !process.versions.bun;

/**
 * The export `name` of the module at `url`, called in a node process with
 * `args`: its result, as JSON carries it. The module must import in Node
 * (no TypeScript source of its own).
 *
 * @param {string | URL} url
 * @param {string} name
 * @param {...unknown} args
 */
export function inNode(url, name, ...args) {
  const program = `import { readFileSync } from 'node:fs';
const module = await import(${JSON.stringify(String(url))});
const result = await module[${JSON.stringify(name)}](...JSON.parse(readFileSync(0, 'utf8')));
process.stdout.write(JSON.stringify(result ?? null));`;
  const run = spawnSync('node', ['--input-type=module', '-e', program], { input: JSON.stringify(args), encoding: 'utf8', maxBuffer: 1 << 30 });
  if (run.error) throw run.error;
  if (run.status !== 0) throw new Error(`node, running ${name} of ${url}, exited ${run.status}:\n${run.stderr}`);
  return JSON.parse(run.stdout);
}
