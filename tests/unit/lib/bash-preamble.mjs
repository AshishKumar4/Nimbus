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
import { BASH_RUNNER_PREAMBLE } from '../../../packages/core/src/runtime/bash-runner.ts';
import { SqliteVFS } from '../../../packages/core/src/vfs/sqlite-vfs.ts';
import { SqliteFilesystemAuthority } from '../../../packages/core/src/runtime/filesystem-authority.ts';
import { FILESYSTEM_RPC_METHODS, vfsSupervisor } from '../../../packages/core/src/runtime/vfs-supervisor.ts';
import { SessionProcessSupervisor } from '../../../packages/core/src/runtime/session-process-supervisor.ts';
import { createSupervisorBridgeStore, createSupervisorOpHandler } from '../../../packages/core/src/workspace/supervisor-op.ts';
import { CRED_KERNEL } from '../../../packages/core/src/runtime/os-contracts.ts';
import { Kernel } from '../../../packages/core/src/substrate/lifo/kernel/index.ts';
import { createSqliteVfsTestHarness } from '../sqlite-vfs-test-harness.mjs';

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
 * `evaluate(source)` runs a source string inside that scope, which is how a
 * serialized facet step (bashRequestStep / bashFacetStep) reaches the preamble.
 *
 * `remote: true` serves the filesystem the way a resident facet gets it: every
 * syscall is a supervisor op envelope across a hop that keeps an error's
 * message but not its code and hands bytes back as ArrayBuffer, parked on JSPI.
 *
 * @param {object} [opts]
 * @param {Record<string,WebAssembly.Module>} [opts.extraWasm]  extra `__NIMBUS_WASM`
 *   entries; a `cu_<name>.wasm` key becomes a command at /bin/<name>.
 * @param {boolean} [opts.remote]
 */
export function loadPreamble(opts = {}) {
  const { table, applets } = wasmTable();
  const scope = { __NIMBUS_WASM: { ...table, ...opts.extraWasm } };
  // Direct eval inside the preamble's own function scope: a serialized step
  // evaluated through it sees exactly what it would see in a real facet.
  const evaluate = new Function('globalThis', `${BASH_RUNNER_PREAMBLE}\nreturn (source) => eval(source);`).call(scope, scope);
  const harness = createSqliteVfsTestHarness();
  const raw = new SqliteVFS(harness.sql, harness.ctx);
  const kernel = new Kernel();
  kernel.initFilesystem();
  const authority = new SqliteFilesystemAuthority(raw, kernel.vfs);
  const root = raw.as(CRED_KERNEL);
  const cred = { uid: 1000, gid: 1000, groups: [1000], umask: 0o022 };
  for (const dir of ['bin', 'home/user', 'tmp', ...(opts.dirs ?? [])]) {
    root.mkdir(dir, { recursive: true });
    root.chown(dir, cred.uid, cred.gid);
  }
  for (const [path, data] of Object.entries(opts.files ?? {})) {
    const parent = path.slice(0, path.lastIndexOf('/'));
    if (parent) root.mkdir(parent, { recursive: true });
    root.writeFile(path, data);
    root.chown(path, cred.uid, cred.gid);
  }
  for (const [path, mode] of Object.entries(opts.modes ?? {})) root.chmod(path, Number(mode) << 6);
  for (const name of [...applets, ...Object.keys(opts.extraWasm ?? {}).map(key => key.slice(3, -5))]) {
    root.writeFile('bin/' + name, 'Nimbus WASI multicall entry\n', { mode: 0o755 });
  }
  const processes = new SessionProcessSupervisor();
  const { pid } = processes.spawn('bash', ['bash'], '/', { cred });
  const store = createSupervisorBridgeStore({ vfs: raw, processes, filesystem: authority });
  const bindings = { SUPERVISOR: opts.remote ? remoteSupervisor(createSupervisorOpHandler({ vfs: raw, filesystem: authority, processes, bridge: store, host: {} }), pid) : vfsSupervisor(store.bridge(pid)) };
  const parking = opts.remote ? 'jspi' : 'none';
  return {
    scope, bindings, root, evaluate, cred, applets,
    boot: args => scope.__bashStep({ op: 'boot', cwd: '/', cred, parking, coreutilsRoot: '/bin', ...args }, bindings.SUPERVISOR),
    feed: args => scope.__bashStep({ op: 'feed', ...args }, bindings.SUPERVISOR),
    async dispose() { await store.dispose(); await authority.releaseProcess(pid); harness.db.close(); },
  };
}

function remoteSupervisor(dispatch, pid) {
  const cloned = (value) => value instanceof Uint8Array ? value.buffer.slice(value.byteOffset, value.byteOffset + value.byteLength) : value;
  // workerd's RpcPromise is a callable proxy: typeof 'function', with `then`, not a Promise.
  const rpcThenable = (promise) => Object.assign(() => { throw new Error('pipelined call'); }, { then: (onFulfilled, onRejected) => promise.then(onFulfilled, onRejected) });
  // A WorkerEntrypoint stub answers every property with a callable, the
  // synchronous capability included; the adapter must not believe it.
  const supervisor = { synchronous: () => { throw new Error('rpc stubs have no synchronous view'); } };
  for (const op of Object.values(FILESYSTEM_RPC_METHODS)) {
    // A stub call answers with workerd's own thenable class, never a Promise.
    supervisor[op] = (...args) => rpcThenable((async () => {
      // A real hop takes a turn; answering in the same tick would hide any
      // ordering the guest's unwind and rewind depend on.
      await new Promise((resolve) => setTimeout(resolve, 0));
      try { return cloned(await dispatch({ op, args, pid })); }
      catch (error) { throw new Error(error instanceof Error ? error.message : String(error)); }
    })());
  }
  return supervisor;
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
export async function runScript(script, opts = {}) {
  const { applets } = wasmTable();
  const session = loadPreamble(opts);
  try { return await session.boot({
    argv: ['bash', '-c', script],
    environ: opts.environ || ['PATH=/bin:/usr/bin', 'HOME=/home/user', 'NIMBUS_PWD=/', 'TERM=dumb'],
    stdinTty: false,
    stdinData: opts.stdin || '',
    stdinClosed: true,
    busyboxApplets: applets,
  }); } finally { await session.dispose(); }
}
