#!/usr/bin/env bun
// The real nimbus-libc open/umask wrappers, compiled by remote-git-build,
// against the real WASI host and a credentialed session filesystem.
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { loadWasiPreamble, makeGuest, makeSession, USER } from './lib/wasi-authority.mjs';

const module = new WebAssembly.Module(readFileSync(new URL('./lib/wasi-libc-create.wasm', import.meta.url)));
const P = await loadWasiPreamble();
const session = makeSession();
try {
  let memory;
  const guest = makeGuest(P, session, { cred: session.cred }, { getMemory: () => memory });
  const instance = new WebAssembly.Instance(module, {
    wasi_snapshot_preview1: guest.wasi,
    nimbus_fs: { ...guest.fsImport, fd_chmod: (...args) => guest.fsImport.fd_chmod(...args) },
    nimbus_proc: guest.procImport,
  });
  memory = instance.exports.memory;
  const { guest_create: create, guest_umask: umask, _initialize: initialize } = instance.exports;
  initialize();
  const file = (name, mode, exclusive = true) => {
    const ptr = 256;
    new Uint8Array(memory.buffer).set(new TextEncoder().encode(`/home/user/${name}\0`), ptr);
    return create(ptr, mode, exclusive ? 1 : 0);
  };
  const modeOf = (name) => session.root.stat(`home/user/${name}`).mode & 0o777;

  assert.equal(umask(0o077), USER.umask, 'umask returns the inherited mask');
  assert.equal(file('private', 0o666), 0);
  assert.equal(modeOf('private'), 0o600, 'umask(077) keeps private data private');

  assert.equal(umask(0o022), 0o077);
  assert.equal(file('requested-private', 0o600, false), 0);
  assert.equal(modeOf('requested-private'), 0o600, 'O_CREAT applies mode without O_EXCL');

  assert.equal(umask(0o111), 0o022);
  assert.equal(file('masked-executable', 0o755), 0);
  assert.equal(modeOf('masked-executable'), 0o644, 'O_EXCL does not restore masked execute bits');

  assert.equal(umask(0o022), 0o111);
  assert.equal(file('execute-only', 0o111), 0);
  assert.equal(modeOf('execute-only'), 0o111, 'execute permission does not depend on read permission');
  assert.equal(file('requested-private', 0o777, false), 0);
  assert.equal(modeOf('requested-private'), 0o600, 'opening an existing file does not change its mode');

  assert.equal(umask(0o077), 0o022);
  assert.equal(file('private', 0o755), 20, 'an exclusive open refuses an existing file');
  assert.equal(file('after-failed-open', 0o666), 0);
  assert.equal(modeOf('after-failed-open'), 0o600, 'a failed create restores the live umask');
  assert.equal(umask(0o022), 0o077, 'a successful create also restores it');

  const chmod = guest.fsImport.fd_chmod;
  guest.fsImport.fd_chmod = () => 29;
  assert.equal(file('failed-executable', 0o755), 29);
  assert.equal(session.root.stat('home/user/failed-executable'), null, 'failure to add execute bits removes the incomplete file');
  guest.fsImport.fd_chmod = chmod;
  assert.equal(umask(0o077), 0o022, 'chmod failure leaves the original umask');
} finally {
  await session.dispose();
}
console.log('wasi-libc-create: requested modes, live umask, existing files and failure cleanup');
