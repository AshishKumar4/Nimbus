#!/usr/bin/env bun
// Behavior test: the CPython wasm32-wasi interpreter on the Nimbus WASI host.
//
// packages/worker/wasm/python/python.wasm is built by build-python.sh as a WASI
// *reactor* rather than a command, because a command module's _start runs once
// and that only covers `python script.py`. A REPL has to survive between turns,
// and a server has to still exist when the next request arrives — which in
// workerd cannot mean a parked wasm stack, since a request context cannot
// resume one that a different request suspended. It has to mean state on the
// guest heap that a fresh entry picks up.
//
// So the contract this asserts is the one the runner depends on:
//   _initialize -> nimbus_py_init(home) -> nimbus_py_run(src) per turn,
// with __main__ persisting across entries and SystemExit arriving as an exit
// code. It runs against the REAL preamble from wasi/preamble.ts — the same
// filesystem, the same syscalls — so a regression in either half shows up here.
//
// The imports come from the preamble's documented no-JSPI branch (see
// lib/wasi-imports.mjs): the interpreter only touches files, whose bodies
// return plain errnos, so nothing needs to park.
//
// Observed once, 2026-08-07: `Illegal instruction (core dumped)` from bun
// during a full sequential sweep of tests/unit, while the CPython build tree
// was still resident on the machine. Not reproducible — six isolated runs and
// two further full sweeps were clean, and the crash was in bun itself, not an
// assertion. This is the heaviest test in the suite (an 11 MiB module plus a
// real pip install into the VFS), so memory pressure is the leading
// explanation. Recorded so that a CI sighting does not start from zero.

import assert from 'node:assert/strict';
import { readFileSync, writeFileSync, rmSync, existsSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

import { WASI_INSTANCE_PREAMBLE_SRC } from '../../packages/worker/src/runtime/wasi-instance.ts';
import { makeImportsWithoutJSPI } from './lib/wasi-imports.mjs';

const RUNTIME_DIR = path.join(import.meta.dir ?? path.dirname(new URL(import.meta.url).pathname),
  '../../packages/worker/wasm/python');
const WASM = path.join(RUNTIME_DIR, 'python.wasm');
const STDLIB = path.join(RUNTIME_DIR, 'python313.zip');
const PIP_WHEEL = path.join(RUNTIME_DIR, 'pip-26.1.2-py3-none-any.whl');

// The artifacts are committed, but a worktree mid-rebuild has neither.
if (!existsSync(WASM) || !existsSync(STDLIB) || !existsSync(PIP_WHEEL)) {
  console.log('cpython-wasi-reactor: SKIPPED (python.wasm not built)');
  process.exit(0);
}

const preambleSrc = `${WASI_INSTANCE_PREAMBLE_SRC}\nexport { __wasiInitFS, __wasiMakeImports };`;
const preamblePath = path.join(os.tmpdir(), `cpython-reactor-${process.pid}.mjs`);
writeFileSync(preamblePath, preambleSrc);
let P;
try {
  P = await import(pathToFileURL(preamblePath).href);
} finally {
  rmSync(preamblePath, { force: true });
}

const toB64 = (bytes) => Buffer.from(bytes).toString('base64');

// getpath.c locates the stdlib by finding lib/pythonX.Y/os.py next to the zip,
// so the marker file has to be there even though every module is read from the
// archive. lib-dynload exists and is empty on purpose: there are no shared
// objects to load, and site.py still expects the directory.
P.__wasiInitFS({
  root: '',
  preopens: [{ wasiPath: '/', vfsPath: '' }],
  files: {
    'usr/local/lib/python313.zip': toB64(readFileSync(STDLIB)),
    'usr/local/lib/python3.13/os.py': toB64(Buffer.from('# stdlib marker; the real os is in the zip\n')),
    'work/pip.whl': toB64(readFileSync(PIP_WHEEL)),
  },
  dirs: ['usr', 'usr/local', 'usr/local/lib', 'usr/local/lib/python3.13',
         'usr/local/lib/python3.13/lib-dynload', 'work', 'tmp'],
  // Every path needs a mode, files included: the preamble denies path_open on
  // anything it has no rwx bits for, and the symptom of a missing file mode is
  // a bare "Failed to import encodings module" from the interpreter.
  modes: {
    '': 7, usr: 7, 'usr/local': 7, 'usr/local/lib': 7,
    'usr/local/lib/python3.13': 7, 'usr/local/lib/python3.13/lib-dynload': 7,
    work: 7, tmp: 7,
    'usr/local/lib/python313.zip': 7, 'usr/local/lib/python3.13/os.py': 7,
    'work/pip.whl': 7,
  },
});

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

// The artifact must stay a stock WASI module: anything else and it would need a
// bespoke host, which is the thing the Pyodide path is being replaced to escape.
assert.deepEqual(
  [...new Set(WebAssembly.Module.imports(module_).map((i) => i.module))],
  ['wasi_snapshot_preview1'],
  'python.wasm must import nothing but preview1',
);

const instance = new WebAssembly.Instance(module_, { wasi_snapshot_preview1: wasiImport });
const { memory, malloc, free, nimbus_py_init, nimbus_py_run } = instance.exports;
for (const name of ['_initialize', 'nimbus_py_init', 'nimbus_py_run', 'nimbus_py_flush',
                    'malloc', 'free', 'memory']) {
  assert.equal(typeof instance.exports[name] !== 'undefined', true, `missing export ${name}`);
}

const encoder = new TextEncoder();
/** Copies a string into guest memory as NUL-terminated UTF-8 and frees it after. */
function withCString(text, fn) {
  const bytes = encoder.encode(text);
  const ptr = malloc(bytes.length + 1);
  assert.notEqual(ptr, 0, 'guest malloc failed');
  // The view is taken after malloc and used before the next guest call, because
  // a growing wasm memory detaches every view over the old buffer.
  const view = new Uint8Array(memory.buffer, ptr, bytes.length + 1);
  view.set(bytes);
  view[bytes.length] = 0;
  try {
    return fn(ptr);
  } finally {
    free(ptr);
  }
}
const run = (src) => withCString(src, (ptr) => nimbus_py_run(ptr));
const takeStdout = () => { const s = stdout.join(''); stdout.length = 0; return s; };

// ── Bring the interpreter up ────────────────────────────────────────────────
instance.exports._initialize();
assert.equal(withCString('/usr/local', (ptr) => nimbus_py_init(ptr)), 0,
  `nimbus_py_init failed: ${stderr.join('')}`);
console.log('  ok  the interpreter initialises against the Nimbus filesystem');

// ── The batteries the published wasm32-wasi artifacts do not have ───────────
// _sysconfigdata in brettcannon/cpython-wasi-build reports ZLIB MISSING, which
// takes zipfile's inflate with it and every wheel after that.
assert.equal(run(`
import sys, zlib, lzma, bz2, hashlib, ssl, sqlite3, socket, decimal, json, io, zipfile
buf = io.BytesIO()
with zipfile.ZipFile(buf, 'w', zipfile.ZIP_DEFLATED) as z: z.writestr('a', b'y' * 10000)
with zipfile.ZipFile(buf) as z: assert len(z.read('a')) == 10000
con = sqlite3.connect(':memory:'); con.execute('create table t(a)')
con.execute("insert into t values('live')")
assert con.execute('select a from t').fetchone()[0] == 'live'
assert len(hashlib.pbkdf2_hmac('sha256', b'p', b's', 10)) == 32
print(sys.version.split()[0], ssl.OPENSSL_VERSION.split()[1], sqlite3.sqlite_version)
`), 0, `batteries failed: ${stderr.join('')}`);
assert.match(takeStdout(), /^3\.13\.\d+ 3\.\d+\.\d+ 3\.\d+\.\d+/,
  'zlib, ssl and sqlite must all be real');
console.log('  ok  zlib, lzma, bz2, hashlib, ssl and sqlite3 work through the WASI filesystem');

// ── Filesystem writes land in the Nimbus VFS, not a private one ─────────────
// This is the whole point of the migration: Pyodide keeps its own MEMFS, so its
// writes have to be diffed back out through vfs-snapshot.ts. These go straight
// through the shared layer.
assert.equal(run(`
import os
with open('/work/note.txt', 'w') as fh: fh.write('written by python')
print(open('/work/note.txt').read(), os.path.getsize('/work/note.txt'), 'note.txt' in os.listdir('/work'))
`), 0, `file io failed: ${stderr.join('')}`);
assert.equal(takeStdout().trim(), 'written by python 17 True');
console.log('  ok  writes go through the shared WASI filesystem');

// ── State persists between entries, and a generator resumes across them ─────
// Each nimbus_py_run is a separate entry into the VM. Nothing survives on the
// stack; __main__ and the generator's frame survive on the guest heap, which is
// what lets a long-running program outlive the request that started it.
assert.equal(run('steps = []\ndef work():\n'
  + '    for i in range(3):\n        steps.append(i)\n        yield i\ng = work()'), 0);
for (let turn = 0; turn < 3; turn++) {
  assert.equal(run('next(g)'), 0, `generator resume ${turn} failed: ${stderr.join('')}`);
}
assert.equal(run('assert steps == [0, 1, 2], steps\nprint("resumed", len(steps), "times")'), 0,
  `state did not survive: ${stderr.join('')}`);
assert.equal(takeStdout().trim(), 'resumed 3 times');
console.log('  ok  __main__ and a suspended generator survive across VM entries');

// ── SystemExit is an exit code, not a traceback ─────────────────────────────
assert.equal(run('raise SystemExit(0)'), 0, 'SystemExit(0) is success');
assert.equal(run('raise SystemExit(3)'), 3, 'SystemExit carries its status');
assert.equal(run('raise SystemExit()'), 0, 'a bare SystemExit is success');
assert.equal(run('import sys; sys.exit(7)'), 7, 'sys.exit is the same path');
stderr.length = 0;
assert.equal(run('raise ValueError("deliberate")'), 1, 'any other exception is failure');
assert.match(stderr.join(''), /ValueError: deliberate/, 'and its traceback reaches stderr');
console.log('  ok  SystemExit becomes an exit code and other exceptions become 1');

// ── The interpreter is still usable after an exception ─────────────────────
// A REPL that dies on the first typo is not a REPL.
assert.equal(run('print("still here", steps)'), 0);
assert.equal(takeStdout().trim(), 'still here [0, 1, 2]');
console.log('  ok  the interpreter survives an uncaught exception');

// ── The POSIX surface wasi-libc leaves out ─────────────────────────────────
// nimbus-net.c and nimbus-wasi-compat.c supply these; without them pip does not
// reach its first wheel (platformdirs does a bare `from os import getuid`) and
// OpenSSL does not link at all.
assert.equal(run(`
import os, socket, mmap
assert os.getuid() >= 0 and os.umask(0o022) >= 0
assert os.lstat('/usr/local/lib/python313.zip').st_size > 0
sock = socket.socket(socket.AF_INET, socket.SOCK_STREAM)
assert sock.fileno() >= 0
sock.close()
# Resolution stays inside the guest: a name becomes an address in the reserved
# 240/8 block, which connect() turns back into the name for the host to dial.
assert socket.getaddrinfo('example.com', 443, socket.AF_INET, socket.SOCK_STREAM)[0][4][1] == 443
buf = mmap.mmap(-1, 4096); buf[0:5] = b'hello'; assert bytes(buf[0:5]) == b'hello'
import http.server, socketserver, urllib.request, email, xml.etree.ElementTree
print('posix surface ok')
`), 0, `posix surface failed: ${stderr.join('')}`);
assert.equal(takeStdout().trim(), 'posix surface ok');
console.log('  ok  getuid, umask, lstat, socket, getaddrinfo and mmap are present');

// ── pip unpacks a real wheel ───────────────────────────────────────────────
// The gate that matters. zipimport needs inflate to read pip out of its own
// wheel, and pip needs inflate again to unpack what it installs — which is why
// a build with ZLIB MISSING has no working wheel path at all. The wheel being
// installed is built here so the test needs no network.
assert.equal(run(`
import io, zipfile
# chr(10) rather than an escape: this source travels through a JS template
# literal, which would eat a backslash-n before Python ever saw it.
NL = chr(10)
name = 'nimbusprobe'
buf = io.BytesIO()
with zipfile.ZipFile(buf, 'w', zipfile.ZIP_DEFLATED) as z:
    z.writestr(name + '/__init__.py', 'VALUE = ' + repr('x' * 4096) + NL)
    z.writestr(name + '-1.0.dist-info/METADATA',
               NL.join(['Metadata-Version: 2.1', 'Name: ' + name, 'Version: 1.0', '']))
    z.writestr(name + '-1.0.dist-info/WHEEL',
               NL.join(['Wheel-Version: 1.0', 'Generator: nimbus',
                        'Root-Is-Purelib: true', 'Tag: py3-none-any', '']))
    z.writestr(name + '-1.0.dist-info/RECORD', '')
open('/work/' + name + '-1.0-py3-none-any.whl', 'wb').write(buf.getvalue())
`), 0, `building the probe wheel failed: ${stderr.join('')}`);

stderr.length = 0;
takeStdout();
assert.equal(run(`
import sys, runpy
sys.path.insert(0, '/work/pip.whl')
sys.argv = ['pip', 'install', '--no-index', '--no-deps', '--no-cache-dir',
            '--disable-pip-version-check', '--no-compile', '--target', '/work/site',
            '/work/nimbusprobe-1.0-py3-none-any.whl']
try:
    runpy.run_module('pip', run_name='__main__')
except SystemExit as exc:
    if exc.code:
        raise AssertionError('pip exited ' + repr(exc.code))
`), 0, `pip install failed:\nSTDOUT:${takeStdout()}\nSTDERR:${stderr.join('')}`);

assert.equal(run(`
import sys
sys.path.insert(0, '/work/site')
import nimbusprobe
assert len(nimbusprobe.VALUE) == 4096
print('installed and imported')
`), 0, `importing the installed wheel failed: ${stderr.join('')}`);
assert.equal(takeStdout().trim(), 'installed and imported');
console.log('  ok  pip unpacks a real wheel and the result imports');

console.log('cpython-wasi-reactor: all cases passed');
