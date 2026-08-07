/**
 * cpython-preamble.ts — the guest half of the CPython runtime, as source.
 *
 * This text is spliced into a loader child's module scope, after the WASI host
 * from runtime/wasi/preamble.ts and the virtual socket kernel. It owns exactly
 * one thing: turning a compiled python.wasm into a running interpreter and
 * feeding it source. Everything about WHAT to run belongs to cpython-runner.ts.
 *
 * Three constraints shape it, all of them learned the expensive way:
 *
 *   1. Every entry into the VM goes through `enterVm`, which is
 *      WebAssembly.promising. Not just the calls known to park today — V8 traps
 *      ANY call into a WebAssembly.Suspending import from a stack that
 *      promising did not enter, including one that returns a plain integer.
 *      Which imports the interpreter reaches is the interpreter's business and
 *      the suspending set grows.
 *
 *   2. __wasiInitFS deliberately clears the adopted supervisor, so the
 *      supervisor is adopted AFTER it, never before. The other order leaves the
 *      guest reading a filesystem it can never write back to, which looks like
 *      success right up until the writes are gone.
 *
 *   3. The interpreter is compiled once, in the child-init window where
 *      compilation is allowed, and instantiated per call. Instantiation is not
 *      gated; only compilation is. A fresh instance per one-shot invocation is
 *      also what makes each `python -c` a pristine interpreter rather than one
 *      carrying the last caller's __main__.
 */
/** Marker the runner writes around the interpreter's exit status. */
export const CPYTHON_EXIT_MARKER = '__NIMBUS_PY_EXIT__';
export const CPYTHON_PREAMBLE_TAIL = String.raw `
// ── CPython guest runtime ──────────────────────────────────────────────────
globalThis.__nimbusPyStdout = globalThis.__nimbusPyStdout || [];
globalThis.__nimbusPyStderr = globalThis.__nimbusPyStderr || [];

// The only way into the VM. See constraint (1) above.
const __nimbusEnterVm = (fn) =>
  (typeof WebAssembly.promising === 'function' ? WebAssembly.promising(fn) : fn);

function __nimbusPyModule() {
  const table = globalThis.__NIMBUS_WASM || {};
  const mod = table['python.wasm'];
  if (!mod) throw new Error('python.wasm was not supplied to this facet');
  return mod;
}

// Bring up one interpreter over the seeded filesystem and return the handles
// the rest of this file drives it with.
async function __nimbusPyBoot(args) {
  const snapshot = args.fsSnapshot || { files: {}, dirs: [], modes: {}, root: '' };
  __wasiInitFS({
    root: snapshot.root || '',
    preopens: [{ wasiPath: '/', vfsPath: '' }],
    files: snapshot.files || {},
    dirs: snapshot.dirs || [],
    // The root, /tmp and /home are seeded rather than taken from the manifest:
    // manifestVfs's walk skips the empty root, so without this the preopen at
    // '/' has effective mode 0 and EVERY traversal through it is EACCES —
    // which surfaces as "Failed to import encodings module" with nothing
    // pointing at a permission. Same baseline ruby-runner seeds, same reason.
    modes: { '': 7, tmp: 7, home: 7, ...(snapshot.modes || {}) },
    times: snapshot.times,
    symlinks: snapshot.symlinks,
    sizes: snapshot.sizes,
  });
  // AFTER initFS, never before. See constraint (2). The stub is read back off
  // globalThis rather than passed in, because the facet entry point published
  // it there before initFS wiped the adoption.
  if (typeof __wasiAdoptSupervisor === 'function') {
    __wasiAdoptSupervisor(globalThis.__nimbusPySupervisor);
  }

  let instance = null;
  const made = __wasiMakeImports({
    argv: args.pyArgv || ['python'],
    env: args.userEnv || {},
    getMemory: () => instance.exports.memory,
    stdoutWrite: (s) => { globalThis.__nimbusPyStdout.push(s); },
    stderrWrite: (s) => { globalThis.__nimbusPyStderr.push(s); },
  });
  instance = new WebAssembly.Instance(__nimbusPyModule(), { wasi_snapshot_preview1: made.wasiImport });

  const exports = instance.exports;
  if (typeof exports.nimbus_py_init !== 'function' || typeof exports.nimbus_py_run !== 'function') {
    throw new Error('python.wasm is not a Nimbus reactor build (nimbus_py_init/nimbus_py_run missing)');
  }

  const withCString = async (text, fn) => {
    const bytes = new TextEncoder().encode(text);
    const ptr = exports.malloc(bytes.length + 1);
    if (!ptr) throw new Error('the interpreter is out of memory');
    // Taken after malloc and used before the next guest call: growing the
    // wasm memory detaches every view over the old buffer.
    const view = new Uint8Array(exports.memory.buffer, ptr, bytes.length + 1);
    view.set(bytes);
    view[bytes.length] = 0;
    try { return await fn(ptr); } finally { exports.free(ptr); }
  };

  // _initialize is static setup only, so it is safe anywhere. Py_Initialize
  // reads entropy through random_get, which workerd refuses in module scope —
  // both run here, at request time.
  await __nimbusEnterVm(exports._initialize)();
  const initRc = await withCString(args.pythonHome || '/usr/local',
    (ptr) => __nimbusEnterVm(exports.nimbus_py_init)(ptr));
  if (initRc !== 0) {
    // CPython's own message for an unreadable stdlib is "Failed to import
    // encodings module", which says nothing about where it looked or why the
    // read failed. These three facts are what separated a mode-0 root from a
    // missing supervisor from an absent JSPI, each of which presents
    // identically.
    throw new Error('the interpreter failed to start: home=' + (args.pythonHome || '/usr/local')
      + ' supervisor=' + (globalThis.__nimbusPySupervisor ? 'yes' : 'NO')
      + ' promising=' + (typeof WebAssembly.promising === 'function' ? 'yes' : 'NO'));
  }

  return {
    instance,
    run: (src) => withCString(src, (ptr) => __nimbusEnterVm(exports.nimbus_py_run)(ptr)),
    flush: () => __nimbusEnterVm(exports.nimbus_py_flush)(),
  };
}

// Ports are the host's to allocate, so the guest cannot bind one by itself:
// nimbus-net.c's listen(2) opens /dev/nimbus/listen/<port>, which is only a
// listening descriptor once the kernel has the port. This is the same callback
// ruby-runner installs, for the same reason and under the same name — one
// binding convention, not one per language.
globalThis.__nimbusVirtualSocketDidListen = globalThis.__nimbusVirtualSocketDidListen
  || function __nimbusVirtualSocketDidListen(port) {
    const supervisor = globalThis.__nimbusPySupervisor;
    if (!supervisor || typeof supervisor.registerPort !== 'function') return;
    try {
      const p = supervisor.registerPort(Number(port)).catch((e) => {
        globalThis.__nimbusPyStderr.push(
          '[cpython-runner] port registration failed: ' + ((e && e.message) || e) + '\n');
      });
      (globalThis.__nimbusVirtualPortRegistrationPromises
        = globalThis.__nimbusVirtualPortRegistrationPromises || []).push(p);
    } catch (e) {
      globalThis.__nimbusPyStderr.push(
        '[cpython-runner] port registration failed: ' + ((e && e.message) || e) + '\n');
    }
  };

globalThis.__nimbusVirtualSocketRouteLoopback = globalThis.__nimbusVirtualSocketRouteLoopback
  || function __nimbusVirtualSocketRouteLoopback(port, request) {
    const supervisor = globalThis.__nimbusPySupervisor;
    if (!supervisor || typeof supervisor.routeLoopback !== 'function') {
      return Promise.reject(new Error('this Python process has no supervisor binding for loopback routing'));
    }
    return Promise.resolve(supervisor.routeLoopback(Number(port), request));
  };

// ── One-shot entry point ───────────────────────────────────────────────────
// A fresh interpreter per call. See constraint (3).
globalThis.__cpythonRun = async function __cpythonRun(args) {
  const stdoutStart = globalThis.__nimbusPyStdout.length;
  const stderrStart = globalThis.__nimbusPyStderr.length;
  const drain = () => ({
    stdout: globalThis.__nimbusPyStdout.slice(stdoutStart).join(''),
    stderr: globalThis.__nimbusPyStderr.slice(stderrStart).join(''),
  });
  let boot;
  try {
    boot = await __nimbusPyBoot(args);
  } catch (e) {
    return { exitCode: 1, ...drain(), error: (e && e.message) || String(e) };
  }
  try {
    const exitCode = await boot.run(args.userCode || '');
    await boot.flush();
    return { exitCode, ...drain() };
  } catch (e) {
    try { await boot.flush(); } catch (ignored) { /* the VM is already gone */ }
    return { exitCode: 1, ...drain(), error: (e && e.message) || String(e) };
  }
};

// ── REPL ───────────────────────────────────────────────────────────────────
// One interpreter for the whole session, unlike __cpythonRun's fresh instance
// per call: a REPL where the previous line's definitions are gone is not a
// REPL. The facet pool that owns this runs at concurrency 1, so there is one
// of these per session and no interleaving to guard against.
globalThis.__cpythonReplBoot = globalThis.__cpythonReplBoot || null;
globalThis.__cpythonReplRun = async function __cpythonReplRun(args) {
  const stdoutStart = globalThis.__nimbusPyStdout.length;
  const stderrStart = globalThis.__nimbusPyStderr.length;
  const drain = () => ({
    stdout: globalThis.__nimbusPyStdout.slice(stdoutStart).join(''),
    stderr: globalThis.__nimbusPyStderr.slice(stderrStart).join(''),
  });
  try {
    if (!globalThis.__cpythonReplBoot) {
      globalThis.__cpythonReplBoot = await __nimbusPyBoot(args);
    }
  } catch (e) {
    return { exitCode: 1, ...drain(), error: (e && e.message) || String(e) };
  }
  try {
    const exitCode = await globalThis.__cpythonReplBoot.run(args.userCode || '');
    await globalThis.__cpythonReplBoot.flush();
    return { exitCode, ...drain() };
  } catch (e) {
    return { exitCode: 1, ...drain(), error: (e && e.message) || String(e) };
  }
};

// ── Resident process ───────────────────────────────────────────────────────
// The program is not suspended between requests — it has already finished.
// python-server-adapter.ts makes serve_forever() register the server and
// return, so the body runs to completion and the server object survives on the
// Python heap. Each inbound request re-enters the interpreter and dispatches
// one connection into it. Nothing is parked across a request boundary, which is
// what makes this work at all: workerd cannot resume a wasm stack that a
// different request suspended.
globalThis.__cpythonProcess = globalThis.__cpythonProcess || null;

globalThis.__cpythonStartProcess = async function __cpythonStartProcess(args) {
  if (globalThis.__cpythonProcess) return globalThis.__cpythonProcess.result;
  const stdoutStart = globalThis.__nimbusPyStdout.length;
  const stderrStart = globalThis.__nimbusPyStderr.length;
  const boot = await __nimbusPyBoot(args);
  const exitCode = await boot.run(args.userCode || '');
  await boot.flush();
  const result = {
    exitCode,
    stdout: globalThis.__nimbusPyStdout.slice(stdoutStart).join(''),
    stderr: globalThis.__nimbusPyStderr.slice(stderrStart).join(''),
  };
  globalThis.__cpythonProcess = { boot, result };
  return result;
};

// Which ports the program left listening. Read back from Python rather than
// tracked here, because the adapter's registry is the only thing that knows
// whether serve_forever actually ran.
globalThis.__cpythonListeningPorts = async function __cpythonListeningPorts() {
  const proc = globalThis.__cpythonProcess;
  if (!proc) return [];
  const before = globalThis.__nimbusPyStdout.length;
  await proc.boot.run('print("__NIMBUS_PORTS__" + repr(_nimbus_listening_ports()))');
  const written = globalThis.__nimbusPyStdout.splice(before).join('');
  const match = /__NIMBUS_PORTS__\[([^\]]*)\]/.exec(written);
  // Anything the program itself printed in the same turn is kept.
  const leftover = written.replace(/__NIMBUS_PORTS__\[[^\]]*\]\n?/, '');
  if (leftover) globalThis.__nimbusPyStdout.push(leftover);
  if (!match || !match[1].trim()) return [];
  return match[1].split(',').map((n) => Number(n.trim())).filter((n) => n > 0);
};

// One dispatch at a time for the whole process: two entries into the same
// interpreter would interleave inside a single-threaded VM. The queue lives on
// globalThis because no request may own it — a request context is torn down
// without warning when its response is sent.
globalThis.__cpythonServeQueue = globalThis.__cpythonServeQueue || Promise.resolve();
globalThis.__nimbusVirtualSocketRequestQueued = globalThis.__nimbusVirtualSocketRequestQueued
  || function __nimbusVirtualSocketRequestQueued(port) {
    const run = async () => {
      const proc = globalThis.__cpythonProcess;
      if (!proc) return false;
      const rc = await proc.boot.run(
        'import sys\n'
        + '_nimbus_ok = _nimbus_serve_one(' + Number(port) + ')\n'
        + 'if not _nimbus_ok: sys.stderr.write("nimbus: no server registered on port ' + Number(port) + '\\n")');
      await proc.boot.flush();
      return rc === 0;
    };
    const task = globalThis.__cpythonServeQueue.then(run, run);
    globalThis.__cpythonServeQueue = task.then(() => {}, () => {});
    return task;
  };
`;
