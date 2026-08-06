/**
 * Boot the real bash-runner preamble against the real staged wasm.
 *
 * bash-runner.ts ships its WASI layer as a source string the Worker evaluates
 * inside a facet, so nothing can import the syscall table directly. This
 * evaluates that same string in-process and hands back the public entry points
 * (__bashBoot / __bashFeed), which is the only honest way to assert the
 * runner's behaviour: through real bash executing real syscalls.
 *
 * Directory note: lives under tests/unit/lib/ because the suite runs
 * `tests/unit/*.mjs`, which would otherwise execute a helper as a test.
 */
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { BASH_RUNNER_PREAMBLE } from '../../../packages/worker/src/runtime/bash-runner.ts';

const wasmDir = fileURLToPath(new URL('../../../packages/worker/wasm/bash/', import.meta.url));

let cached = null;

/** Compile the staged bash + busybox modules once per process. */
function wasmTable() {
  if (cached) return cached;
  const applets = readFileSync(`${wasmDir}coreutils/busybox.applets`, 'utf8')
    .split('\n').map((l) => l.trim()).filter(Boolean);
  cached = {
    table: {
      'bash.async.wasm': new WebAssembly.Module(readFileSync(`${wasmDir}bash.async.wasm`)),
      'cu_busybox.wasm': new WebAssembly.Module(readFileSync(`${wasmDir}coreutils/busybox.wasm`)),
    },
    applets,
  };
  return cached;
}

/**
 * Evaluate the preamble in a fresh scope and return its entry points. The
 * preamble reaches for its modules and publishes its entry points through
 * `globalThis`, so a per-call stand-in gives each test its own session state
 * instead of the module-level one the preamble keeps for warm isolates.
 *
 * @param {object} [opts]
 * @param {Record<string,WebAssembly.Module>} [opts.extraWasm]  extra `__NIMBUS_WASM`
 *   entries; a `cu_<name>.wasm` key becomes a command at /bin/<name>.
 */
export function loadPreamble(opts = {}) {
  const { table } = wasmTable();
  const scope = { __NIMBUS_WASM: { ...table, ...opts.extraWasm } };
  new Function('globalThis', BASH_RUNNER_PREAMBLE).call(scope, scope);
  return { boot: scope.__bashBoot, feed: scope.__bashFeed, scope };
}

/**
 * Run a bash script to completion and return the runner's verdict.
 *
 * @param {string} script          Passed as `bash -c <script>`.
 * @param {object} [opts]
 * @param {Record<string,string>} [opts.files]   vfsPath → contents, seeded into the snapshot.
 * @param {string[]} [opts.dirs]                 directories seeded into the snapshot.
 * @param {Record<string,number>} [opts.modes]   vfsPath → effective rwx bits.
 * @param {string} [opts.stdin]                  stdin bytes, delivered closed.
 * @param {string[]} [opts.environ]
 * @param {Record<string,WebAssembly.Module>} [opts.extraWasm]  see loadPreamble.
 */
export function runScript(script, opts = {}) {
  const { applets } = wasmTable();
  const { boot } = loadPreamble({ extraWasm: opts.extraWasm });
  const files = {};
  for (const [p, body] of Object.entries(opts.files || {})) {
    files[p] = Buffer.from(body).toString('base64');
  }
  return boot({
    argv: ['bash', '-c', script],
    environ: opts.environ || ['PATH=/bin:/usr/bin', 'HOME=/home/user', 'NIMBUS_PWD=/', 'TERM=dumb'],
    stdinTty: false,
    stdinData: opts.stdin || '',
    stdinClosed: true,
    busyboxApplets: applets,
    fsSnapshot: {
      files,
      dirs: opts.dirs || [],
      modes: opts.modes || {},
    },
  });
}
