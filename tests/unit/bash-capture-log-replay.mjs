#!/usr/bin/env bun
// The jmp_buf hooks' log (nimbus-proc.c) is history: each copy was a whole
// jmp_buf when it was made. Applied later, at the next unwind, a copy chain
// a→b→c must leave c naming the capture even when b was written over in
// between, as a stack buffer is once its frame returns; else the capture is
// freed while c still holds it, and a longjmp through c fails.
import assert from 'node:assert/strict';
import { CaptureStore } from '../../packages/core/src/runtime/bash/capture-store.ts';

const memory = new WebAssembly.Memory({ initial: 64 });
const view = () => new DataView(memory.buffer);
// The module's layout as checkedLayout reads it: the shadow stack, then the hooks' log.
const layout = { low: 4096, high: 65536, log: 65536 };
const store = new CaptureStore(layout, 1 << 20, 3 << 20);
const stats = { mainHi: 0, captureBytesHi: 0, captureCompactions: 0, captureLiveHi: 0 };
const JMP_BUF = 12;

/** What nimbus_procenv_copy does: the words copied, then (dst, src) recorded. */
const copy = (dst, src) => {
  new Uint8Array(memory.buffer).copyWithin(dst, src, src + JMP_BUF);
  const v = view(), logged = v.getUint32(layout.log, true);
  v.setUint32(layout.log + 4 + logged * 8, dst, true);
  v.setUint32(layout.log + 8 + logged * 8, src, true);
  v.setUint32(layout.log, logged + 1, true);
};

// setjmp(a): an unwind at the stack pointer, 64 bytes of it, kept as a's capture.
const sp = 60000;
const unwound = store.unwindAt(memory, sp, stats, 1);
view().setUint32(unwound, unwound + 8 + 64, true);
const a = 200000, b = 200016, c = 200032;
store.take(memory, a, sp, stats, 1);

copy(b, a);
copy(c, b);
// b is written over with no hook (its frame returned and the slot was reused).
new Uint8Array(memory.buffer).fill(0, b, b + JMP_BUF);
// setjmp(a) again: the log is applied, and a stops naming the capture.
store.setting(memory, a);

assert.doesNotThrow(() => store.jump(memory, c, 7, 1), 'c still names the capture a copied into b and b into c');
console.log('bash-capture-log-replay: ok');
