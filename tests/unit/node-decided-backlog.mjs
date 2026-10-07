#!/usr/bin/env bun
// What a node process decides in a subtree it holds, ahead of the session,
// is bounded (process-fs-client DECIDED_BACKLOG_OPS): an async write there is
// answered at once only while fewer than that many such changes are
// unanswered by the session, sent or not; past it, the write waits for its
// own answer. A process killed mid-run loses at most that.
//
// Red before: an async write decided here was answered before it was even
// handed to the client (it waits in the path's queue), and the bound counted
// only what the client held, so a loop of awaited writes ran unbounded ahead
// of a session that did not answer (live: 5,000 acknowledged, then a crash,
// and none of them landed).

import assert from 'node:assert/strict';
import { createAuthority, facetSupervisor, launchResident, residentDataPlan, runScenarios, until } from './lib/resident-body.mjs';
import { DECIDED_BACKLOG_OPS } from '../../packages/core/src/_shared/process-fs-client.ts';

const PROGRAM = `
const fs = require("fs");
globalThis.__probe = { fs };
require("http").createServer((q, s) => s.end("up")).listen(3000);
`;

await runScenarios(import.meta.path, {
  async 'awaited writes in a held subtree run at most the bound ahead of the session'() {
    const authority = createAuthority();
    authority.kfs.mkdir('home/user/app/out', { recursive: true, mode: 0o755 });
    authority.kfs.chown('home/user/app', 1000, 1000);
    authority.kfs.chown('home/user/app/out', 1000, 1000);
    let stalled = null;
    let forward;
    const handle = facetSupervisor(authority, {
      writeBatchStream: async (...args) => {
        if (stalled !== null) await stalled.promise;
        return forward('writeBatchStream', args);
      },
    });
    forward = handle.forward;
    await launchResident({
      authority,
      program: PROGRAM,
      env: { SUPERVISOR: handle.supervisor },
      dataPlan: await residentDataPlan(authority, '/home/user/app'),
      cursor: authority.cursor(),
    });
    const { fs } = globalThis.__probe;

    // Written often enough, the subtree is the process's.
    for (let i = 0; i < 16; i++) await fs.promises.writeFile(`/home/user/app/out/warm${i}`, 'w');
    await until(() => globalThis.__nimbusProcessFs?.held('home/user/app/out/x') !== undefined, 'the subtree held', 5_000);

    // The session stops answering: awaited writes are answered at once up to the bound, then wait.
    stalled = Promise.withResolvers();
    let answered = 0;
    const waiting = [];
    for (let i = 0; i < DECIDED_BACKLOG_OPS + 200; i++) {
      const write = fs.promises.writeFile(`/home/user/app/out/f${i}`, `${i}`);
      const settled = await Promise.race([write.then(() => true), new Promise((resolve) => setTimeout(() => resolve(false), 50))]);
      if (!settled) { waiting.push(write); break; }
      answered++;
    }
    assert.ok(answered <= DECIDED_BACKLOG_OPS, `${answered} awaited writes were answered while the session answered none`);
    assert.ok(answered >= DECIDED_BACKLOG_OPS - 64, `only ${answered} were decided here before the bound`);

    // Answered again: everything lands.
    stalled.resolve();
    stalled = null;
    await Promise.all(waiting);
    await globalThis.__nimbusProcessFs.settle();
    assert.equal(authority.kfs.readFileString(`home/user/app/out/f${answered - 1}`), `${answered - 1}`);
    assert.equal(authority.kfs.readFileString(`home/user/app/out/f${answered}`), `${answered}`);
  },
});
