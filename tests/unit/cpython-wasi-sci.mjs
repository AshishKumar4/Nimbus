#!/usr/bin/env bun
// Behavior test: the "sci" interpreter variant — CPython wasm32-wasi with numpy
// and markupsafe's C speedups linked in.
//
// wasm32-wasi has no dlopen, so a compiled Python package is either inside the
// interpreter or unavailable. build-python.sh links two variants and the runner
// picks between them from what the session installed; see EXTENSIONS.md for why
// that beat implementing a WebAssembly runtime linker.
//
// What this asserts is the part that static analysis cannot reach. A build can
// link every extension object and still be useless: the inittab entry can be
// missing, an extension's module init can fail, or — the case that actually
// happened here — two copies of one C file can be linked under one set of
// symbols and quietly bind the wrong one.
//
// The three failures this exists to catch, all of which were real:
//
//   1. numpy compiles distributions.c twice, as int64_t for Generator and as
//      long for the legacy RandomState. Shipped as separate shared objects the
//      two never meet; linked into one interpreter they do, and wasm-ld reports
//      the mismatch as a *warning*. Both RNG APIs are exercised here, and their
//      values are pinned to what native numpy produces for the same seed.
//   2. wasi-libc's printf aborts on a long double instead of formatting one, and
//      numpy formats one while importing. That was a bare trap at `import numpy`.
//   3. A dotted name like numpy._core._multiarray_umath only resolves because
//      CPython 3.13's BuiltinImporter consults _imp.is_builtin for submodule
//      imports too. On an interpreter where that changed, numpy would not import
//      at all.
//
// Like cpython-wasi-reactor.mjs, this seeds the filesystem BY VALUE and runs
// without JSPI, so it says nothing about the demand-loading path a live session
// uses. It runs against the real preamble from wasi-instance.ts.

import assert from 'node:assert/strict';
import { existsSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

import { WASI_INSTANCE_PREAMBLE_SRC } from '../../packages/worker/src/runtime/wasi-instance.ts';
import { makeImportsWithoutJSPI } from './lib/wasi-imports.mjs';

const RUNTIME_DIR = path.join(
  import.meta.dir ?? path.dirname(new URL(import.meta.url).pathname),
  '../../packages/worker/wasm/python',
);
const WASM = path.join(RUNTIME_DIR, 'python-sci.wasm');
const STDLIB = path.join(RUNTIME_DIR, 'python313.zip');
const SCI_PACKAGES = path.join(RUNTIME_DIR, 'sci-packages.zip');

// The artifacts are committed, but a worktree mid-rebuild has neither.
if (!existsSync(WASM) || !existsSync(STDLIB) || !existsSync(SCI_PACKAGES)) {
  console.log('cpython-wasi-sci: SKIPPED (python-sci.wasm not built)');
  process.exit(0);
}

const preambleSrc = `${WASI_INSTANCE_PREAMBLE_SRC}\nexport { __wasiInitFS, __wasiMakeImports };`;
const preamblePath = path.join(os.tmpdir(), `cpython-sci-${process.pid}.mjs`);
writeFileSync(preamblePath, preambleSrc);
let P;
try {
  P = await import(pathToFileURL(preamblePath).href);
} finally {
  rmSync(preamblePath, { force: true });
}

const toB64 = (bytes) => Buffer.from(bytes).toString('base64');
const files = {
  'usr/local/lib/python313.zip': toB64(readFileSync(STDLIB)),
  'usr/local/lib/python3.13/os.py': toB64(Buffer.from('# stdlib marker; the real os is in the zip\n')),
  'usr/local/lib/sci-packages.zip': toB64(readFileSync(SCI_PACKAGES)),
};
const dirs = ['usr', 'usr/local', 'usr/local/lib', 'usr/local/lib/python3.13',
  'usr/local/lib/python3.13/lib-dynload', 'work', 'tmp'];
// Every path needs a mode, files included: the preamble denies path_open on
// anything it has no rwx bits for, and a missing file mode shows up only as
// "Failed to import encodings module".
const modes = Object.fromEntries([...dirs, '', ...Object.keys(files)].map((k) => [k, 7]));
P.__wasiInitFS({ root: '', preopens: [{ wasiPath: '/', vfsPath: '' }], files, dirs, modes });

const stdout = [];
const stderr = [];
const { wasiImport } = makeImportsWithoutJSPI(P, {
  argv: ['python'],
  env: { HOME: '/work', TMPDIR: '/tmp', PYTHONUNBUFFERED: '1' },
  getMemory: () => instance.exports.memory,
  stdoutWrite: (s) => { stdout.push(s); },
  stderrWrite: (s) => { stderr.push(s); },
});

const module_ = new WebAssembly.Module(readFileSync(WASM));
assert.deepEqual(
  [...new Set(WebAssembly.Module.imports(module_).map((i) => i.module))],
  ['wasi_snapshot_preview1'],
  'python-sci.wasm must import nothing but preview1',
);

const instance = new WebAssembly.Instance(module_, { wasi_snapshot_preview1: wasiImport });
const { memory, malloc, free, nimbus_py_init, nimbus_py_run } = instance.exports;

const encoder = new TextEncoder();
function withCString(text, fn) {
  const bytes = encoder.encode(text);
  const ptr = malloc(bytes.length + 1);
  assert.notEqual(ptr, 0, 'guest malloc failed');
  const view = new Uint8Array(memory.buffer, ptr, bytes.length + 1);
  view.set(bytes);
  view[bytes.length] = 0;
  try {
    return fn(ptr);
  } finally {
    free(ptr);
  }
}
const takeStdout = () => { const s = stdout.join(''); stdout.length = 0; return s; };
// A failing extension takes the interpreter down with a wasm trap rather than a
// Python traceback, so the trap is caught and reported with whatever the guest
// managed to write first — that message is usually the whole diagnosis.
function run(src, what) {
  stderr.length = 0;
  let status;
  try {
    status = withCString(src, (ptr) => nimbus_py_run(ptr));
  } catch (err) {
    assert.fail(`${what} trapped: ${err.message}\nguest stderr: ${stderr.join('')}`);
  }
  assert.equal(status, 0, `${what} failed:\n${stderr.join('')}`);
  return takeStdout().trim();
}

instance.exports._initialize();
assert.equal(withCString('/usr/local', (ptr) => nimbus_py_init(ptr)), 0,
  `nimbus_py_init failed: ${stderr.join('')}`);
console.log('  ok  the sci interpreter initialises');

// ── The extensions are registered under the names their packages import ─────
assert.equal(run(`
import sys
sys.path.insert(0, '/usr/local/lib/sci-packages.zip')
missing = [m for m in ('numpy._core._multiarray_umath', 'numpy.linalg.lapack_lite',
                       'numpy.random.mtrand', 'markupsafe._speedups')
           if m not in sys.builtin_module_names]
print('missing:', missing or 'none')
`, 'builtin registration'), 'missing: none');
console.log('  ok  the compiled modules are registered under their dotted names');

// ── numpy imports and computes ──────────────────────────────────────────────
assert.equal(run(`
import numpy as np
print(np.__version__, int(np.arange(5).sum()), np.zeros(3).dtype,
      int((np.arange(6).reshape(2, 3) @ np.ones((3, 2))).sum()))
`, 'numpy import'), '2.4.3 10 float64 30');
console.log('  ok  numpy imports and computes');

// ── linalg, through the bundled reference LAPACK ────────────────────────────
// Patch 0002 makes both linalg modules share one copy of it; before that the
// duplicate Fortran symbols made the interpreter unlinkable.
assert.equal(run(`
import numpy as np
a = np.array([[3.0, 1.0], [1.0, 2.0]])
print(round(float(np.linalg.det(a)), 6),
      [round(float(v), 6) for v in np.linalg.solve(a, np.array([9.0, 8.0]))],
      bool(np.allclose(a @ np.linalg.inv(a), np.eye(2))),
      bool(np.linalg.eigvalsh(a)[0] < np.linalg.eigvalsh(a)[1]))
`, 'linalg'), '5.0 [2.0, 3.0] True True');
console.log('  ok  linalg solves, inverts and finds eigenvalues');

// ── fft, which is the C++ that has no unwinder ──────────────────────────────
assert.equal(run(`
import numpy as np
print([round(float(v.real), 6) for v in np.fft.fft(np.array([1.0, 0.0, 0.0, 0.0]))],
      bool(np.allclose(np.fft.ifft(np.fft.fft(np.arange(8.0))), np.arange(8.0))))
`, 'fft'), '[1.0, 1.0, 1.0, 1.0] True');
console.log('  ok  pocketfft transforms and round-trips');

// ── Both RNG APIs, pinned to native numpy's streams ─────────────────────────
// These exact values come from CPython 3.13 with numpy on x86-64 for the same
// seed. They are here because the legacy RandomState build of distributions.c
// shares every symbol name with the Generator build, and binding one to the
// other is a signature mismatch wasm-ld only warns about. Wrong numbers here
// mean patch 0003's rename stopped covering something.
assert.equal(run(`
import numpy as np
g = np.random.default_rng(12345)
print([round(float(v), 6) for v in g.random(3)],
      list(map(int, g.multinomial(10, [0.2, 0.3, 0.5]))))
rs = np.random.RandomState(12345)
print([round(float(v), 6) for v in rs.random_sample(3)],
      list(map(int, rs.multinomial(10, [0.2, 0.3, 0.5]))), int(rs.binomial(20, 0.5)))
`, 'random'),
  '[0.227336, 0.316758, 0.797365] [2, 3, 5]\n'
  + '[0.929616, 0.316376, 0.183919] [1, 4, 5] 11');
console.log('  ok  Generator and legacy RandomState both match native numpy');

// ── markupsafe's C speedups ────────────────────────────────────────────────
// The package's Python half is installed by pip, not shipped here, so the
// builtin is reached through a stub parent — which is exactly how the real
// markupsafe/__init__.py reaches it.
assert.equal(run(`
import sys, types
parent = types.ModuleType('markupsafe')
parent.__path__ = []
sys.modules['markupsafe'] = parent
from markupsafe._speedups import _escape_inner
print(_escape_inner('<nimbus>'), _escape_inner('a & b'))
`, 'markupsafe'), '&lt;nimbus&gt; a &amp; b');
console.log('  ok  markupsafe._speedups escapes through the C path');

console.log('cpython-wasi-sci: all cases passed');
