#!/usr/bin/env bun
// WASI Stage 1: exec-dispatch decision table for path-shaped invocations.
//
//   exec-bit + wasm      → run via wasm-runner
//   exec-bit + shebang   → run via the named interpreter
//   exec-bit + text      → run via sh (POSIX ENOEXEC fallback)
//   exec-bit + binary    → honest exec-format error
//   no exec-bit          → permission denied
//   grandfather: wasm-magic with an untouched (pre-chmod, no S_IF* bits)
//   mode stays executable; explicitly chmod -x'ed wasm is denied.

import assert from 'node:assert/strict';
import {
  decideExecDispatch,
  parseShebang,
  isWasmMagic,
  isExecutableMode,
  EXEC_HEAD_BYTES,
} from '../../packages/core/src/shell/exec-dispatch.ts';

const enc = new TextEncoder();
const WASM = new Uint8Array([0x00, 0x61, 0x73, 0x6d, 0x01, 0x00, 0x00, 0x00]);
const ELF = new Uint8Array([0x7f, 0x45, 0x4c, 0x46, 0x02, 0x01, 0x01, 0x00, 0x00]);

assert.ok(EXEC_HEAD_BYTES >= 256, 'head window covers a full shebang line');

// ── wasm ────────────────────────────────────────────────────────────────
assert.ok(isWasmMagic(WASM));
assert.ok(!isWasmMagic(ELF));
assert.deepEqual(decideExecDispatch(0o100755, WASM), { kind: 'wasm' }, 'exec wasm runs');
assert.deepEqual(decideExecDispatch(0o755, WASM), { kind: 'wasm' }, 'legacy exec wasm runs');

// ── grandfather rule ────────────────────────────────────────────────────
assert.deepEqual(decideExecDispatch(0o644, WASM), { kind: 'wasm' },
  'wasm with untouched pre-chmod mode stays executable');
assert.deepEqual(decideExecDispatch(0, WASM), { kind: 'wasm' },
  'wasm with schema-default mode stays executable');
assert.deepEqual(decideExecDispatch(0o100644, WASM), { kind: 'denied' },
  'explicitly chmod -x wasm is denied');
assert.ok(!isExecutableMode(0o100644, true));
assert.ok(isExecutableMode(0o644, true));
assert.ok(!isExecutableMode(0o644, false), 'grandfather is wasm-magic only');

// ── shebang ─────────────────────────────────────────────────────────────
const nodeScript = enc.encode('#!/usr/bin/env node\nconsole.log("hi")\n');
assert.deepEqual(decideExecDispatch(0o100755, nodeScript), {
  kind: 'shebang',
  shebang: { interpreter: 'node', args: [] },
});
assert.deepEqual(decideExecDispatch(0o100644, nodeScript), { kind: 'denied' },
  'non-exec shebang script is denied (POSIX)');

assert.deepEqual(parseShebang(enc.encode('#!/bin/sh\necho hi\n')),
  { interpreter: '/bin/sh', args: [] });
assert.deepEqual(parseShebang(enc.encode('#!/usr/bin/python3 -u\nprint(1)\n')),
  { interpreter: '/usr/bin/python3', args: ['-u'] });
assert.deepEqual(parseShebang(enc.encode('#!/usr/bin/env -S node --no-warnings\n')),
  { interpreter: 'node', args: ['--no-warnings'] });
assert.deepEqual(parseShebang(enc.encode('#! /bin/sh\n')),
  { interpreter: '/bin/sh', args: [] }, 'space after #! tolerated');
assert.deepEqual(parseShebang(enc.encode('#!/bin/sh\r\necho hi\n')),
  { interpreter: '/bin/sh', args: [] }, 'CRLF tolerated');
assert.equal(parseShebang(enc.encode('#!\n')), null, 'empty shebang rejected');
assert.equal(parseShebang(enc.encode('#!/usr/bin/env\n')), null, 'bare env rejected');
assert.equal(parseShebang(enc.encode('echo hi\n')), null);
assert.equal(parseShebang(WASM), null);

// ── ENOEXEC ─────────────────────────────────────────────────────────────
assert.deepEqual(decideExecDispatch(0o100755, ELF), { kind: 'exec-format-error' },
  'exec-bit ELF is an honest format error, not a crash');
assert.deepEqual(decideExecDispatch(0o100755, new Uint8Array([1, 0, 2, 3])), {
  kind: 'exec-format-error',
}, 'binary junk with NUL bytes is a format error');
assert.deepEqual(decideExecDispatch(0o100644, ELF), { kind: 'denied' },
  'non-exec ELF is denied before format inspection');

// ── plain text ──────────────────────────────────────────────────────────
assert.deepEqual(decideExecDispatch(0o100755, enc.encode('echo hi\n')),
  { kind: 'shell-script' }, 'exec-bit text runs via sh');
assert.deepEqual(decideExecDispatch(0o100755, new Uint8Array(0)),
  { kind: 'shell-script' }, 'empty exec file runs via sh (exit 0, POSIX)');
assert.deepEqual(decideExecDispatch(0o100644, enc.encode('echo hi\n')),
  { kind: 'denied' }, 'non-exec text is denied');
assert.deepEqual(decideExecDispatch(0o644, enc.encode('echo hi\n')),
  { kind: 'denied' }, 'legacy-mode text is denied (no grandfather for text)');

console.log('exec-dispatch: all assertions passed');
