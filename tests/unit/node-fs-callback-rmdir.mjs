#!/usr/bin/env bun
// fs.rmdir(path[, options], callback) exists and removes an empty directory,
// as Node's does, and fs.rmdir and fs.promises.rmdir answer a missing path
// with ENOENT and a file with ENOTDIR (the supervisor's rmdir decides both). proper-lockfile (graceful-fs under pi's config store)
// calls options.fs.rmdir to release its lock directory; without it pi died
// with "TypeError: options.fs.rmdir is not a function" whenever a lock was
// compromised or released.

import assert from 'node:assert/strict';

// The resident body replaces process and console once launched: report through the real stdout.
const stdout = process.stdout.write.bind(process.stdout);
import { createAuthority, facetSupervisor, launchResident } from './lib/resident-body.mjs';

const PROGRAM = `
const fs = require("fs");
globalThis.__probe = {
  typeOf: typeof fs.rmdir,
  rmdir: (p, opts) => new Promise((resolve) => {
    const done = (err) => resolve(err ? err.code : "ok");
    if (opts === undefined) fs.rmdir(p, done); else fs.rmdir(p, opts, done);
  }),
  exists: (p) => fs.existsSync(p),
  // The asynchronous forms' error for a path, as the code each reports. (rmdirSync queues
  // its supervisor call and reports nothing, as every sync structural mutation here does.)
  codes: async (p) => [
    await new Promise((resolve) => fs.rmdir(p, (e) => resolve(e ? e.code : "ok"))),
    await fs.promises.rmdir(p).then(() => "ok", (e) => e.code),
  ],
};
`;

const authority = createAuthority();
authority.kfs.mkdir('home/user/app/lock', { recursive: true, mode: 0o755 });
authority.kfs.mkdir('home/user/app/full', { recursive: true, mode: 0o755 });
authority.kfs.writeFile('home/user/app/full/f', 'f');
const { supervisor } = facetSupervisor(authority);
await launchResident({ program: PROGRAM, env: { SUPERVISOR: supervisor }, cursor: authority.cursor() });
const probe = globalThis.__probe;

assert.equal(probe.typeOf, 'function', 'fs.rmdir is a function');
assert.equal(await probe.rmdir('/home/user/app/lock'), 'ok');
assert.equal(probe.exists('/home/user/app/lock'), false, 'the empty directory is gone');
assert.equal(authority.kfs.exists('home/user/app/lock'), false, 'and gone from the session filesystem');
assert.equal(await probe.rmdir('/home/user/app/full', {}), 'ENOTEMPTY', 'a directory with a file in it stays');
// A missing path is ENOENT, as Node answers, from every form: the supervisor's rmdir decides it.
assert.deepEqual(await probe.codes('/home/user/app/missing'), ['ENOENT', 'ENOENT']);
assert.deepEqual(await probe.codes('/home/user/app/full/f'), ['ENOTDIR', 'ENOTDIR'], 'a file is ENOTDIR');

stdout('node-fs-callback-rmdir: ok\n');
