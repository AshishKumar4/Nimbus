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
//   2. what an earlier release left readable by every account is closed once,
//      at the next instance's start: a durable application's blob becomes the
//      kernel's alone; a wasm image at the top of the inline store becomes
//      the uid of the durable application that boots from it, and one nothing
//      boots from is gone. The application still relaunches.
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
  const gen2 = instance(session, 1);
  // An earlier release's wasm image at the top of the inline store, booted by a durable app, and one nothing boots from.
  kernel.mkdir('.nimbus/inline-wasm', { recursive: true, mode: 0o755 });
  const booted = '.nimbus/inline-wasm/sha256-booted.wasm';
  const orphan = '.nimbus/inline-wasm/sha256-orphan.wasm';
  kernel.writeFile(booted, WASM, { mode: 0o644 });
  kernel.writeFile(orphan, WASM, { mode: 0o644 });
  await gen2.manager.spawnWorker('export class NimbusProcess {}', 'durable app', '/home/user/app', {
    vfsWasmModules: { 'note.wasm': `/${booted}` },
    startArgs: { userCode: `print("${SECRET}")` },
    durable: { owner: 'app:one' },
  });
  await until(() => gen2.starts.length === 1, 'the durable app to start');
  // Its blobs as an earlier release left them: the kernel's, readable by every account.
  for (const { name } of kernel.readdir('.nimbus/images')) {
    kernel.chown(`.nimbus/images/${name}`, 0, 0);
    kernel.chmod(`.nimbus/images/${name}`, 0o644);
  }
  assert.ok(readableHolding(session.vfs, OTHER, SECRET).length > 0, 'the earlier release\'s files are open to another account');
  session.storage.delete(EARLIER_IMAGES_CLOSED_KEY);

  const gen3 = instance(session, 2);
  await gen3.manager.pumpResidentLaunches();
  await until(() => gen3.starts.length === 1, 'the durable app to relaunch');
  assert.deepEqual(readableHolding(session.vfs, OTHER, SECRET), [], 'another account reads the secret in no file of the session');
  for (const { name } of kernel.readdir('.nimbus/images')) {
    const stat = kernel.lstat(`.nimbus/images/${name}`);
    assert.deepEqual([stat.uid, stat.mode & 0o777], [0, 0o400], `the durable blob ${name} is the kernel's alone`);
  }
  const wasm = kernel.lstat(booted);
  assert.deepEqual([wasm.uid, wasm.mode & 0o777], [USER.uid, 0o400], 'the wasm image a durable app boots from is its uid\'s');
  assert.equal(kernel.exists(orphan), false, 'one nothing boots from is gone');
  console.log('  [2] an earlier release\'s open images are closed once, and the durable app relaunches');
}

console.log('process-image-privacy: a process\'s images are its principal\'s alone');
