#!/usr/bin/env bun
// A mutation the session refused is the filesystem answering the call, and a
// program that catches it has handled it; one whose outcome is unknown is a
// durability failure whatever the program caught, and surfaces when the
// process's writes are drained. Which is which is one policy, the syscall
// verdicts (vfs-error.ts SYSCALL_VERDICTS), for the process's filesystem
// client.
//
// The session's answer to the rename's wave is injected: a verdict names its
// errno, and nothing of the wave applies; without one, the wave's outcome is
// unknown. EXDEV, ENOTSUP, ENXIO and E2BIG are verdicts a move between mounts
// draws; this session does not make one, so the wave's answer is the verdict.

import assert from 'node:assert/strict';
import { createAuthority, facetSupervisor, launchResident, runScenarios } from './lib/resident-body.mjs';

const PROGRAM = `
const fs = require("fs");
globalThis.__probe = {
  rename: (from, to) => fs.promises.rename(from, to).then(() => "ok", (e) => e.code),
  renameSync: (from, to) => { try { fs.renameSync(from, to); return "ok"; } catch (e) { return e.code; } },
};
`;

/** The session's answer to the wave: refused with `errno` (a verdict), or, with none, its outcome unknown. */
function answering(errno) {
  return async () => {
    const message = `${errno ?? 'EIO'}: refused, rename '/home/user/app' -> '/home/user/moved'`;
    return {
      ok: false,
      committedGroupSequence: 0,
      committedPathCount: 0,
      committedOps: 0,
      inodes: 0,
      chunks: 0,
      receipts: [],
      error: { code: 'ERR_WRITE_BATCH_STREAM', phase: 'validation', message, ...(errno === undefined ? {} : { errno }) },
    };
  };
}

async function launch(errno) {
  const authority = createAuthority();
  authority.kfs.mkdir('home/user/app', { recursive: true, mode: 0o755 });
  const handle = facetSupervisor(authority, { writeBatchStream: answering(errno) });
  await launchResident({ authority, program: PROGRAM, env: { SUPERVISOR: handle.supervisor }, cursor: authority.cursor() });
  return globalThis.__probe;
}

/** The codes of the failures the drain reports. */
async function drained() {
  return (await globalThis.__nimbusProcessFs.settle()).map((failure) => failure.error.code);
}

async function caught(errno) {
  const probe = await launch(errno);
  assert.equal(await probe.rename('/home/user/app', '/home/user/moved'), errno ?? 'EIO', 'the caller hears the refusal');
  assert.deepEqual(await drained(), [], 'a caught refusal is the call\'s answer, not a lost write');
}

const scenarios = {};
for (const code of ['EXDEV', 'ENOTSUP', 'ENXIO', 'E2BIG', 'ENOENT']) {
  scenarios[`${code}: a caught refusal is the call's answer, not a lost write`] = () => caught(code);
}
scenarios['EIO: a caught failure of unknown outcome still surfaces'] = async () => {
  const probe = await launch(undefined);
  assert.equal(await probe.rename('/home/user/app', '/home/user/moved'), 'EIO', 'the caller hears the failure');
  assert.deepEqual(await drained(), ['EIO'], 'an unknown outcome surfaces at the drain, caught or not');
};
scenarios['EIO on a synchronous change: its unknown outcome surfaces at the drain'] = async () => {
  const probe = await launch(undefined);
  assert.equal(await probe.renameSync('/home/user/app', '/home/user/moved'), 'ok', 'the program was told the change succeeded');
  assert.deepEqual(await drained(), ['EIO'], 'an acknowledged change whose outcome is unknown surfaces at the drain');
};
await runScenarios(import.meta.path, scenarios);
