#!/usr/bin/env bun
// sdk/new/remote-writefile-shape — the remote client must accept the
// response `_rpcWriteFile` actually sends.
//
// WHY THIS EXISTS
//   `_rpcWriteFile` answers with the number of bytes the VFS wrote
//   (session/rpc.ts). The remote client validated that result against
//   `z.undefined()`, so every write over `Nimbus.connect` threw a ZodError
//   *after the bytes had already landed*. Binding mode never validates a
//   result, so only remote clients — an embedder's server, a ComputeSDK
//   provider — hit it.
//
//   It stayed green because the only test of remote writeFile drove a fetch
//   mock, and that mock returned the void wire shape: `{ok:true}` with no
//   `result`. Both halves encoded the same wrong belief, so the suite agreed
//   with itself about a response the server never sends. A mock cannot catch
//   that; only a real server can.
//
//   Note that 'the bytes are readable back' passes in BOTH states: the write
//   lands and then the client throws on the response. That is the whole
//   reason this shipped — a test that only checked the file could never have
//   caught a client that throws after a successful write.
//
//   sdk/new/live-sdk-remote-smoke covers remote writes too, but it is on
//   PROBE_TARGET_SKIPS (it needs hosted-demo OAuth), so no headless run has
//   ever executed it. This probe deliberately is NOT on that list: it speaks
//   only bearer tokens, so apps/probe, staging and a throwaway all serve it.

import { makeAsserter } from '../../_driver.mjs';
import { Nimbus } from '../../../../packages/sdk/src/index.ts';

if (!process.env.BASE) { console.error('FATAL: BASE env required'); process.exit(2); }
if (!process.env.NIMBUS_PROBE_TOKEN) { console.error('FATAL: NIMBUS_PROBE_TOKEN env required'); process.exit(2); }

const a = makeAsserter('sdk/new/remote-writefile-shape');
console.log(`sdk/new/remote-writefile-shape — ${process.env.BASE}`);

const box = Nimbus.connect({
  endpoint: process.env.BASE,
  token: process.env.NIMBUS_PROBE_TOKEN,
}).sandbox(`wfshape-${Date.now().toString(36)}`);

try {
  // The call that used to throw. Reaching the next line at all is the
  // regression this probe exists for.
  const text = `shape-${Math.random().toString(36).slice(2)}`;
  let threw = null;
  let returned = 'unset';
  try {
    returned = await box.files.write('/home/user/wfshape.txt', text);
  } catch (e) {
    threw = e;
  }
  a.check('remote writeFile resolves against the real server response',
    threw === null,
    threw ? `${threw.constructor.name}: ${String(threw.message).slice(0, 200)}` : '');

  // The byte count is the wire contract, not the public one.
  a.check('files.write exposes void, not the wire byte count',
    returned === undefined, `resolved with ${JSON.stringify(returned)}`);

  // The write must have actually landed — a client that swallowed the
  // response would also pass the first check.
  a.check('the bytes the write claimed are readable back',
    (await box.files.read('/home/user/wfshape.txt')) === text);

  // Binary writes take the same op, and their byte count differs from the
  // string case, so a client that special-cased one length would fail here.
  const bytes = new Uint8Array([0, 1, 2, 255]);
  let binThrew = null;
  try {
    await box.files.write('/home/user/wfshape.bin', bytes);
  } catch (e) {
    binThrew = e;
  }
  a.check('remote writeFile accepts a binary payload',
    binThrew === null,
    binThrew ? String(binThrew.message).slice(0, 200) : '');

  const readBack = await box.files.readBytes('/home/user/wfshape.bin');
  a.check('binary round trip is byte-exact',
    readBack instanceof Uint8Array
      && readBack.length === 4
      && readBack[0] === 0 && readBack[3] === 255,
    `got ${readBack && Array.from(readBack).join(',')}`);

  // An empty write is the degenerate byte count: the server answers 0, which
  // a `!result`-style guard would treat as absent.
  let emptyThrew = null;
  try {
    await box.files.write('/home/user/wfshape-empty.txt', '');
  } catch (e) {
    emptyThrew = e;
  }
  a.check('remote writeFile accepts a zero-byte write',
    emptyThrew === null,
    emptyThrew ? String(emptyThrew.message).slice(0, 200) : '');
} finally {
  await box.destroy({ reason: 'remote-writefile-shape-cleanup' }).catch(() => {});
}

const sum = a.summary();
process.exit(sum.fail > 0 ? 1 : 0);
