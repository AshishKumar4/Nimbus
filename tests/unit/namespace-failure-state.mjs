#!/usr/bin/env bun
// A namespace that stopped answering is a failure state, not a mode
// (CUTOVER #13, Main's rule):
//   - a synchronous stat, exists or readdir is refused with EAGAIN naming the
//     cause and the asynchronous form that answers now, and each refusal is
//     counted (notResident, the filesystem's stats);
//   - the next async boundary the process reaches (here a timer's barrier)
//     repairs it, so the same call then answers.
// The failure is the real one: a directory became searchable, so the barrier
// relists it, and that relist fails.

import assert from 'node:assert/strict';
import { CRED_KERNEL } from '../../packages/core/src/runtime/os-contracts.ts';
import { createAuthority } from './lib/resident-body.mjs';
import { shimsOnSession } from './lib/shims-on-session.mjs';

const authority = createAuthority();
const kernel = authority.rawVfs.as(CRED_KERNEL);
authority.kfs.mkdir('home/user/app', { recursive: true, mode: 0o755 });
// A directory the process cannot search yet, holding a file.
kernel.mkdir('home/user/app/locked', { mode: 0o700 });
kernel.writeFile('home/user/app/locked/inside.txt', 'inside');

let listingFails = false;
const { fs, setTimeout: shimTimeout } = shimsOnSession({
  authority,
  cwd: '/home/user/app',
  overrides: (forward) => ({
    fsList: async (...args) => {
      if (listingFails) throw new Error('Network connection lost.');
      return forward('fsList', args);
    },
  }),
});
const stats = () => globalThis.__nimbusProcessFs.stats();
const afterTimer = () => new Promise((resolve) => shimTimeout(resolve, 0));

assert.equal(fs.existsSync('/home/user/app'), true, 'the launch answers from its namespace');
const refusalsBefore = stats().notResident;

// The directory becomes searchable; the barrier that reports it relists it,
// and that relist fails.
kernel.chmod('home/user/app/locked', 0o755);
listingFails = true;
await afterTimer();

let refused = null;
try { fs.statSync('/home/user/app/locked/inside.txt'); } catch (error) { refused = error; }
assert.ok(refused, 'a sync stat is refused while the namespace is not answering');
assert.equal(refused.code, 'EAGAIN');
assert.match(refused.message, /a listing of \/home\/user\/app\/locked failed \(Network connection lost\.\)/,
  `the refusal names its cause: ${refused.message}`);
assert.match(refused.message, /fs\.promises\.stat/, 'and the asynchronous form that answers now');
assert.throws(() => fs.readdirSync('/home/user/app'), (e) => e.code === 'EAGAIN' && /fs\.promises\.readdir/.test(e.message));
assert.equal(stats().notResident, refusalsBefore + 2, 'each refusal is counted');

// The next async boundary repairs it, and the same call answers.
listingFails = false;
await afterTimer();
assert.equal(fs.statSync('/home/user/app/locked/inside.txt').size, 6, 'the refused call now answers');
assert.deepEqual(fs.readdirSync('/home/user/app/locked'), ['inside.txt']);

console.log('namespace-failure-state: a failed relist refuses by name, is counted, and the next boundary repairs it');
