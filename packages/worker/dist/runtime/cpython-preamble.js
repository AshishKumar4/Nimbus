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
    modes: snapshot.modes || {},
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
  if (initRc !== 0) throw new Error('the interpreter failed to start');

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
// A workerd request context cannot resume a wasm stack that a different request
// suspended, so a server cannot simply block in accept(2) across requests. A
// Python generator can: its frame lives on the guest heap, so it survives the
// context boundary. The process body runs inside one, and each inbound request
// resumes it.
globalThis.__cpythonProcess = globalThis.__cpythonProcess || null;

globalThis.__cpythonStartProcess = async function __cpythonStartProcess(args) {
  if (globalThis.__cpythonProcess) return globalThis.__cpythonProcess.started;
  const stdoutStart = globalThis.__nimbusPyStdout.length;
  const stderrStart = globalThis.__nimbusPyStderr.length;
  const boot = await __nimbusPyBoot(args);
  // The body becomes a generator so it can park; the driver below is what
  // advances it. Nothing about the user's program changes - it is the harness
  // around it that yields.
  const started = boot.run([
    'import sys, types',
    '__nimbus_ns = {"__name__": "__main__"}',
    '__nimbus_src = ' + JSON.stringify(args.userCode || '') + '',
    'def __nimbus_body():',
    '    exec(compile(__nimbus_src, ' + JSON.stringify(args.progName || 'python') + ', "exec"), __nimbus_ns)',
    '    yield',
    '__nimbus_gen = __nimbus_body()',
  ].join('\n'));
  globalThis.__cpythonProcess = { boot, started, stdoutStart, stderrStart, done: false };
  return started;
};

// Advance the process until it parks again. Serialized through a queue on
// globalThis because no single request may own it: a request context is torn
// down without warning when its response is sent, taking anything anchored to
// it, and two drivers entering a live generator together would corrupt it.
globalThis.__cpythonResumeQueue = globalThis.__cpythonResumeQueue || Promise.resolve();
globalThis.__cpythonStep = function __cpythonStep() {
  const run = async () => {
    const proc = globalThis.__cpythonProcess;
    if (!proc || proc.done) return { resumed: false, alive: false };
    const rc = await proc.boot.run([
      'try:',
      '    next(__nimbus_gen)',
      '    __nimbus_alive = True',
      'except StopIteration:',
      '    __nimbus_alive = False',
    ].join('\n'));
    if (rc !== 0) proc.done = true;
    return { resumed: true, alive: !proc.done };
  };
  const task = globalThis.__cpythonResumeQueue.then(run, run);
  globalThis.__cpythonResumeQueue = task.then(() => {}, () => {});
  return task;
};

globalThis.__nimbusVirtualSocketRequestQueued = globalThis.__nimbusVirtualSocketRequestQueued
  || async function __nimbusVirtualSocketRequestQueued() {
    const step = await globalThis.__cpythonStep();
    return !!step.resumed;
  };
`;
