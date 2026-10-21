#!/usr/bin/env bun
// A process's images hold what it could read, and are its principal's alone.
//
// Through the session's manager, over one session's storage and filesystem:
//
//   1. a Node resident of uid 1000 whose program reads a 0600 module of its
//      user's, a wasm image inlined in it: its images (the generated entry,
//      its code pack, the staged wasm) are uid 1000's, 0400. Uid 1001,
//      reading every file of the session, finds the module's secret in none;
//      the process reads its own images, as a peer host's boot does;
//   2. a durable application's blobs, shared by content across uids, stay
//      the kernel's alone whoever's spawn writes them; and what an earlier
//      release left readable by every account is closed once, at the next
//      instance's start: its blobs become the kernel's, a process image at
//      the top of the store goes, and a wasm image at the top of the inline
//      store is copied for each uid whose durable application boots from it,
//      the application written again to read its own copy. Both relaunch.
//
// Red before: images were the kernel's, 0644, in directories every account
// could read.

import assert from 'node:assert/strict';
import { adoptCtxExports } from '../../packages/fabric/src/composition.ts';
import { processImageDir } from '../../packages/fabric/src/process-fabric.ts';
import { CRED_KERNEL } from '../../packages/core/src/runtime/os-contracts.ts';
import { EARLIER_IMAGES_CLOSED_KEY } from '../../packages/worker/src/session/keys.ts';
import { resolveDurableWorkerImage } from '../../packages/worker/src/facets/durable-images.ts';
import { launchManager, launchSession } from './lib/facet-launch-harness.mjs';

adoptCtxExports({ SupervisorRPC: (opts) => ({ __supervisor: opts.props }) });

const SECRET = 'image-privacy-sentinel-73c1';
const USER = { uid: 1000, gid: 1000, groups: [1000], umask: 0o022 };
const OTHER = { uid: 1001, gid: 1001, groups: [1001], umask: 0o022 };

/** A valid wasm module whose one custom section holds `text`. */
function wasmHolding(text) {
  const name = new TextEncoder().encode('note');
  const payload = new TextEncoder().encode(text);
  const body = [name.length, ...name, ...payload];
  return Uint8Array.from([0x00, 0x61, 0x73, 0x6d, 0x01, 0x00, 0x00, 0x00, 0x00, body.length, ...body]);
}
const WASM = wasmHolding(`${SECRET} ${'x'.repeat(48)}`);
const WASM_LITERAL = btoa(String.fromCharCode(...WASM));

/** An instance of `session` at `generation`, durable apps re-driven from the session's image store. */
function instance(session, generation) {
  const starts = [];
  const launched = launchManager('process-image-privacy', {
    session, generation,
    evaluate: () => ({
      async startProcess(args) { starts.push(args); return { ok: true }; },
      async handleHttpRequest() { return new Response('ok'); },
    }),
    hooks: {
      requestLaunchTurn: () => { setTimeout(() => { void launched.manager.pumpResidentLaunches(); }, 0); },
      resolveWorkerLaunchFallback: (recipe) => resolveDurableWorkerImage(session.vfs, recipe),
    },
  });
  return { ...launched, starts };
}
const until = async (ready, what) => {
  for (let i = 0; i < 400 && !ready(); i++) await new Promise((resolve) => setTimeout(resolve, 5));
  assert.ok(ready(), `timed out waiting for ${what}`);
};

/** Every file of the session that `cred` can read and that holds `text`. */
function readableHolding(vfs, cred, text) {
  const kernel = vfs.as(CRED_KERNEL);
  const as = vfs.as(cred);
  const found = [];
  for (let after = null, page; (page = kernel.list(after)), true; after = page.next) {
    for (const entry of page.entries) {
      if (entry.kind !== 'file') continue;
      const path = entry.path.replace(/^\/+/, '');
      let bytes;
      try { bytes = as.readFile(path); } catch { continue; }
      if (new TextDecoder('latin1').decode(bytes).includes(text)) found.push(path);
    }
    if (page.next === null) break;
  }
  return found;
}

/** A session whose user keeps a 0600 module holding the secret and an inlined wasm image. */
function userSession() {
  const session = launchSession();
  const kernel = session.vfs.as(CRED_KERNEL);
  kernel.mkdir('home/user/app', { recursive: true, mode: 0o755 });
  kernel.chown('home/user', USER.uid, USER.gid);
  kernel.chown('home/user/app', USER.uid, USER.gid);
  const user = session.vfs.as(USER);
  user.writeFile('home/user/app/secret.js', `module.exports = { token: "${SECRET}", wasm: "${WASM_LITERAL}" };\n`, { mode: 0o600 });
  return { session, kernel, user };
}

// ── 1. a resident's images are its uid's alone ──────────────────────────────
{
  const { session, kernel, user } = userSession();
  const gen1 = instance(session, 1);
  await gen1.manager.spawnNode("require('./secret.js'); require('http').createServer(() => {}).listen(8080);", {
    filename: '/home/user/app/server.js', cwd: '/home/user/app', command: 'node server.js', argv: ['/home/user/app/server.js'],
  });
  await until(() => gen1.starts.length === 1, 'the resident to start');
  assert.deepEqual(readableHolding(session.vfs, OTHER, SECRET), [], 'another account reads the secret in no file of the session');
  const images = [processImageDir(USER.uid), `.nimbus/inline-wasm/${USER.uid}`]
    .flatMap((dir) => kernel.readdir(dir).map(({ name }) => `${dir}/${name}`));
  assert.ok(readableHolding(session.vfs, CRED_KERNEL, SECRET).some((path) => images.includes(path)), 'the secret is in the process\'s images');
  for (const path of images) {
    const stat = kernel.lstat(path);
    assert.deepEqual([stat.uid, stat.mode & 0o777], [USER.uid, 0o400], `${path} is its process's uid's alone`);
    assert.ok(user.readFile(path).byteLength > 0, `and the process reads ${path}`);
  }
  console.log('  [1] a resident\'s images are its uid\'s alone, and another account reads none of them');
}

// ── 2. what an earlier release left open is closed once ─────────────────────
{
  const { session, kernel } = userSession();
  const outsider = { uid: 1002, gid: 1002, groups: [1002], umask: 0o022 };
  const gen2 = instance(session, 1);
  // An earlier release's wasm image at the top of the inline store, booted by
  // two durable apps of two uids, and one nothing boots from.
  kernel.mkdir('.nimbus/inline-wasm', { recursive: true, mode: 0o755 });
  const booted = '.nimbus/inline-wasm/sha256-booted.wasm';
  const orphan = '.nimbus/inline-wasm/sha256-orphan.wasm';
  kernel.writeFile(booted, WASM, { mode: 0o644 });
  kernel.writeFile(orphan, WASM, { mode: 0o644 });
  for (const [owner, cred] of [['app:one', USER], ['app:two', OTHER]]) {
    // Started by a process of its uid, whose credential it takes.
    const invoker = gen2.processes.spawn('sh', ['sh'], '/home/user/app', { cred });
    await gen2.manager.spawnWorker('export class NimbusProcess {}', owner, '/home/user/app', {
      vfsWasmModules: { 'note.wasm': `/${booted}` },
      startArgs: { userCode: `print("${SECRET}")` },
      invokerPid: invoker.pid,
      durable: { owner },
    });
  }
  await until(() => gen2.starts.length === 2, 'the durable apps to start');
  const blobs = () => kernel.readdir('.nimbus/images').map(({ name }) => `.nimbus/images/${name}`);
  for (const path of blobs()) {
    const stat = kernel.lstat(path);
    assert.deepEqual([stat.uid, stat.mode & 0o777], [0, 0o400], `${path}, written for two uids, is the kernel's alone`);
  }
  // As an earlier release left them: the blobs and a process image at the top of the store, readable by every account.
  for (const path of blobs()) kernel.chmod(path, 0o644);
  const earlierImage = `.nimbus/process-images/${'e'.repeat(64)}.js`;
  kernel.writeFile(earlierImage, `const token = "${SECRET}";`, { mode: 0o644 });
  assert.ok(readableHolding(session.vfs, outsider, SECRET).length > 0, 'the earlier release\'s files are open to another account');
  session.storage.delete(EARLIER_IMAGES_CLOSED_KEY);

  const gen3 = instance(session, 2);
  await gen3.manager.pumpResidentLaunches();
  await until(() => gen3.starts.length === 2, 'both durable apps to relaunch, each reading its wasm image');
  assert.deepEqual(readableHolding(session.vfs, outsider, SECRET), [], 'an outsider reads the secret in no file of the session');
  for (const path of blobs()) {
    const stat = kernel.lstat(path);
    assert.deepEqual([stat.uid, stat.mode & 0o777], [0, 0o400], `the durable blob ${path} is the kernel's alone`);
  }
  for (const cred of [USER, OTHER]) {
    const copy = kernel.lstat(`.nimbus/inline-wasm/${cred.uid}/sha256-booted.wasm`);
    assert.deepEqual([copy.uid, copy.mode & 0o777], [cred.uid, 0o400], `uid ${cred.uid} boots from a copy of its own`);
  }
  assert.deepEqual([kernel.exists(booted), kernel.exists(orphan), kernel.exists(earlierImage)], [false, false, false],
    'the shared wasm image, one nothing boots from, and the earlier process image are gone');
  console.log('  [2] an earlier release\'s open images are closed once, a shared one copied per uid, and the durable apps relaunch');
}

console.log('process-image-privacy: a process\'s images are its principal\'s alone');
