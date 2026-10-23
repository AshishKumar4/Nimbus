#!/usr/bin/env bun
// A namespace that stopped answering is a failure state, not a mode
// (CUTOVER #13, Main's rule):
//   - a synchronous stat, exists or readdir is refused with EAGAIN naming the
//     cause and the asynchronous form that answers now, and each refusal is
//     counted (notResident, the filesystem's stats);
//   - the next async boundary the process reaches (here a timer's barrier)
//     repairs it, so the same call then answers.
// The failure is the real one: a directory became searchable, so the barrier
// relists it, and that relist fails. Each case is a process of its own.

import assert from 'node:assert/strict';
import { CRED_KERNEL } from '../../packages/core/src/runtime/os-contracts.ts';
import { createAuthority, runScenarios } from './lib/resident-body.mjs';
import { shimsOnSession } from './lib/shims-on-session.mjs';

const APP = '/home/user/app';
const INSIDE = `${APP}/locked/inside.txt`;

/**
 * A process in APP, and its namespace stopped: `locked` became searchable,
 * and the relist its barrier began for it failed.
 */
async function stoppedNamespace() {
  const authority = createAuthority();
  const kernel = authority.rawVfs.as(CRED_KERNEL);
  authority.kfs.mkdir('home/user/app', { recursive: true, mode: 0o755 });
  // A directory the process cannot search yet, holding a file.
  kernel.mkdir('home/user/app/locked', { mode: 0o700 });
  kernel.writeFile('home/user/app/locked/inside.txt', 'inside');

  const failing = { on: false };
  const { fs, setTimeout: shimTimeout } = shimsOnSession({
    authority,
    cwd: APP,
    overrides: (forward) => ({
      fsList: async (...args) => {
        if (failing.on) throw new Error('Network connection lost.');
        return forward('fsList', args);
      },
    }),
  });
  const afterTimer = () => new Promise((resolve) => shimTimeout(resolve, 0));

  assert.equal(fs.existsSync(APP), true, 'the launch answers from its namespace');
  await authority.peerAs(CRED_KERNEL).chmod('home/user/app/locked', 0o755);
  failing.on = true;
  await afterTimer();
  return { fs, afterTimer, failing, stats: () => globalThis.__nimbusProcessFs.stats() };
}

const refusalOf = (call) => {
  try { call(); } catch (error) { return error; }
  throw new Error('expected a refusal');
};

const scenarios = {
  async 'a synchronous stat is refused EAGAIN while the namespace is not answering'() {
    const { fs } = await stoppedNamespace();
    const refused = refusalOf(() => fs.statSync(INSIDE));
    assert.equal(refused.code, 'EAGAIN');
    assert.match(refused.message, /fs\.promises\.stat/, 'and the asynchronous form that answers now');
  },

  async 'the refusal names the listing that failed'() {
    const { fs } = await stoppedNamespace();
    const refused = refusalOf(() => fs.statSync(INSIDE));
    assert.match(
      refused.message,
      /a listing of \/home\/user\/app\/locked failed \(Network connection lost\.\)/,
      `the refusal names its cause: ${refused.message}`,
    );
  },

  async 'each refusal is counted, and readdir is refused the same way'() {
    const { fs, stats } = await stoppedNamespace();
    const before = stats().notResident;
    refusalOf(() => fs.statSync(INSIDE));
    const listing = refusalOf(() => fs.readdirSync(APP));
    assert.equal(listing.code, 'EAGAIN');
    assert.match(listing.message, /fs\.promises\.readdir/);
    assert.equal(stats().notResident, before + 2, 'each refusal is counted');
  },

  async 'the next async boundary repairs it, and the same call answers'() {
    const { fs, afterTimer, failing } = await stoppedNamespace();
    failing.on = false;
    await afterTimer();
    assert.equal(fs.statSync(INSIDE).size, 6, 'the refused call now answers');
    assert.deepEqual(fs.readdirSync(`${APP}/locked`), ['inside.txt']);
  },
};

await runScenarios(import.meta.path, scenarios);
