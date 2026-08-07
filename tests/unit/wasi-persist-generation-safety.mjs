#!/usr/bin/env bun
// Behavior test: a queued write-back belongs to the process that queued it.
//
// __wasiEnqueue captured its supervisor by READING the module global when the
// continuation ran, not when the op was queued. __wasiInitFS nulls that global
// and resets the queue tail — but resetting the tail does not cancel
// continuations already chained to the old one. A pooled isolate that re-inits
// with work still in flight therefore ran the previous program's write-back
// against a null stub, and recorded the resulting TypeError into a failures
// array the NEXT program then drains and throws from.
//
// Two distinct wrongs, one cause: the losing program's write is silently gone,
// and the winning program is blamed for it.
//
// Surfaced by putting the shim under a type checker for the first time — the
// call needed an `as WasiSupervisorStub` cast precisely because the value it
// passed could be null.

import assert from 'node:assert/strict';
import { writeFileSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

import { WASI_INSTANCE_PREAMBLE_SRC } from '../../packages/worker/src/runtime/wasi-instance.ts';
import { makeImportsWithoutJSPI } from './lib/wasi-imports.mjs';

const ESUCCESS = 0;

const preambleSrc = `${WASI_INSTANCE_PREAMBLE_SRC}
export { __wasiInitFS, __wasiMakeImports, __wasiAdoptSupervisor, __wasiDrainPersist, fdTable };`;
const preamblePath = path.join(os.tmpdir(), `wasi-persist-gen-${process.pid}.mjs`);
writeFileSync(preamblePath, preambleSrc);
let P;
try {
  P = await import(pathToFileURL(preamblePath).href);
} finally {
  rmSync(preamblePath, { force: true });
}

const enc = new TextEncoder();
let pass = 0;
const failures = [];
const check = (name, ok, detail = '') => {
  if (ok) { console.log(`  ✓ ${name}`); pass++; }
  else { console.log(`  ✗ ${name}${detail ? ' — ' + detail : ''}`); failures.push(name); }
};

const seed = () => ({
  root: 'home/user',
  preopens: [{ wasiPath: '/', vfsPath: 'home/user' }],
  files: {}, dirs: ['home/user'], modes: { 'home/user': 7, '': 7 },
});

function writeStr(mem, ptr, s) {
  const bytes = enc.encode(s);
  new Uint8Array(mem.buffer).set(bytes, ptr);
  return bytes.length;
}

// A supervisor whose writeFile parks until released, so the op is still in
// flight when the isolate is handed to the next program.
let release;
const parked = new Promise((r) => { release = r; });
const seen = [];
const supA = {
  async writeFile(p, bytes) { seen.push(['writeFile', p, new TextDecoder().decode(bytes)]); },
  // mkdir parks: it is an op whose queued closure does NOT read __wasiFS, so it
  // reaches the supervisor reference itself and exposes run(null) directly.
  async mkdir(p) { seen.push(['mkdir', p]); await parked; },
  async unlink() {}, async rmdir() {}, async rename() {},
  async symlink() {}, async utimes() {},
  async stat() { return null; },
  async fsReadRange() { return new Uint8Array(0); },
};

P.__wasiInitFS(seed());
P.__wasiAdoptSupervisor(supA);

const mem = new WebAssembly.Memory({ initial: 4 });
const { wasiImport: imports } = makeImportsWithoutJSPI(P, { argv: ["prog"], env: {}, getMemory: () => mem });

// Program A makes a directory (queues a parked sup.mkdir) and writes a file
// (queues a write-back that reads its bytes back out of __wasiFS when it runs).
const dirLen = writeStr(mem, 2048, 'adir');
assert.equal(imports.path_create_directory(3, 2048, dirLen), ESUCCESS);

const nameLen = writeStr(mem, 64, 'a.txt');
const openRc = imports.path_open(3, 0, 64, nameLen, 1 /* O_CREAT */, 0n, 0n, 0, 128);
assert.equal(openRc, ESUCCESS, `path_open failed: ${openRc}`);
const fd = new DataView(mem.buffer).getUint32(128, true);

const payload = enc.encode('from-program-A');
new Uint8Array(mem.buffer).set(payload, 1024);
const dv = new DataView(mem.buffer);
dv.setUint32(256, 1024, true);
dv.setUint32(260, payload.length, true);
assert.equal(imports.fd_write(fd, 256, 1, 300), ESUCCESS);

// The pool hands the isolate to the next program while A's write is in flight.
P.__wasiInitFS(seed());

// Now let program A's queued write-back run against whatever it captured.
release();
let threw = null;
try { await P.__wasiDrainPersist(); } catch (e) { threw = e; }
// The previous generation's chain is deliberately NOT awaited by this drain —
// the new process owns a fresh tail. Let the old chain settle so what it
// actually did is observable.
await new Promise((r) => setTimeout(r, 50));

const message = threw ? String(threw && threw.message ? threw.message : threw) : '';
check('a queued write-back is not run against a null supervisor',
  !/null|undefined|not a function/i.test(message), message.slice(0, 220));
check("the next program's drain does not inherit the previous program's failure",
  threw === null, message.slice(0, 220));
const wrote = seen.find(([op, p]) => op === 'writeFile' && p === 'home/user/a.txt');
check('the write-back still reached the supervisor that was live when it was queued',
  Boolean(wrote), JSON.stringify(seen));
check('and it carried the bytes the previous program wrote, not an empty cache miss',
  Boolean(wrote) && wrote[2] === 'from-program-A', JSON.stringify(seen));

console.log(`\n  ──── wasi-persist-generation-safety: ${pass} pass / ${failures.length} fail`);
process.exit(failures.length > 0 ? 1 : 0);
