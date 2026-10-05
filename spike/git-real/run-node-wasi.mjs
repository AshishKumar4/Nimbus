// Runs git.wasm under V8 through node:wasi, the engine family workerd uses,
// and reports what a Nimbus host would pay: wall time, the guest's linear
// memory (which only grows, so its final size is its peak), and how many
// WASI calls of each kind the command made (each one an authority call in a
// Nimbus facet). Usage:
//   node run-node-wasi.mjs <git.wasm> <repo-dir> <git args...>
// Env: GIT_WASI_OUT=1 prints the command's stdout; otherwise it is counted.
import { readFileSync, openSync, closeSync } from 'node:fs';
import { WASI } from 'node:wasi';

const [wasmPath, repo, ...args] = process.argv.slice(2);
const bytes = readFileSync(wasmPath);
let t = performance.now();
const module = new WebAssembly.Module(bytes);
const compileMs = performance.now() - t;

const outPath = process.env.GIT_WASI_OUT ? null : '/dev/null';
const stdout = outPath === null ? 1 : openSync(outPath, 'w');
const wasi = new WASI({
  version: 'preview1',
  args: ['git', '-C', '/repo', ...args],
  env: {
    HOME: '/repo', GIT_CONFIG_NOSYSTEM: '1', GIT_AUTHOR_NAME: 'T', GIT_AUTHOR_EMAIL: 't@x',
    GIT_COMMITTER_NAME: 'T', GIT_COMMITTER_EMAIL: 't@x', TMPDIR: '/tmp', ...JSON.parse(process.env.GIT_WASI_ENV ?? '{}'),
  },
  preopens: { '/repo': repo, '/dev': '/dev', '/tmp': process.env.GIT_WASI_TMP ?? '/tmp' },
  stdout,
  returnOnExit: true,
});
const imports = wasi.getImportObject();
const counts = new Map();
const wrapped = {};
for (const [name, fn] of Object.entries(imports.wasi_snapshot_preview1)) {
  wrapped[name] = (...a) => { counts.set(name, (counts.get(name) ?? 0) + 1); return fn(...a); };
}
t = performance.now();
const instance = new WebAssembly.Instance(module, { wasi_snapshot_preview1: wrapped });
const instantiateMs = performance.now() - t;
t = performance.now();
const cpu0 = process.cpuUsage();
const code = wasi.start(instance);
const cpu = process.cpuUsage(cpu0);
const runMs = performance.now() - t;
if (stdout !== 1) { try { closeSync(stdout); } catch { /* the guest closed it */ } }
const fsCalls = [...counts].filter(([n]) => n.startsWith('fd_') || n.startsWith('path_')).reduce((s, [, n]) => s + n, 0);
const top = [...counts].sort((a, b) => b[1] - a[1]).slice(0, 6).map(([n, c]) => `${n}=${c}`).join(' ');
console.error(JSON.stringify({
  args: args.join(' '), exit: code, compileMs: Math.round(compileMs), instantiateMs: Math.round(instantiateMs),
  runMs: Math.round(runMs), cpuMs: Math.round((cpu.user + cpu.system) / 1000),
  linearMemoryMiB: +(instance.exports.memory.buffer.byteLength / 1048576).toFixed(1),
  rssMiB: +(process.memoryUsage().rss / 1048576).toFixed(0), fsCalls, top,
}));
