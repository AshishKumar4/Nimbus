#!/usr/bin/env bun
// A resident facet uses the authority's content identity (contentKey: equal
// keys, equal bytes) to avoid moving bytes it already has: a file whose
// content is already held under another path is copied inside the store, and
// a change that leaves the bytes alone (a chmod, a rewrite with the same
// content) keeps the held row instead of refetching it.

import assert from 'node:assert/strict';
import {
  createAuthority,
  facetSupervisor,
  launchResident,
  residentDataPlan,
  runScenarios,
} from './lib/resident-body.mjs';

const PROGRAM = `
const fs = require("fs");
const read = (p) => { try { return fs.readFileSync(p, "utf8"); } catch (e) { return "ERR:" + e.code; } };
globalThis.__probe = {
  read,
  resume: (...paths) => new Promise((resolve) => setTimeout(() => resolve(paths.map(read).join("|")), 0)),
};
require("http").createServer((q, s) => s.end("up")).listen(3000);
`;

const APP = '/home/user/app';
const SAME = 'identical bytes '.repeat(64);

async function boot() {
  const authority = createAuthority();
  authority.kfs.mkdir('home/user/app', { recursive: true, mode: 0o755 });
  authority.kfs.writeFile('home/user/app/a.txt', SAME);
  authority.kfs.writeFile('home/user/app/b.txt', SAME);
  authority.kfs.writeFile('home/user/app/c.txt', 'c-bytes');
  const fetched = [];
  let forward;
  const handle = facetSupervisor(authority, {
    fsReadBatch: async (requests) => { for (const r of requests) fetched.push(r.path); return forward('fsReadBatch', [requests]); },
  });
  forward = handle.forward;
  const { supervisor: counting, log } = handle;
  // Run from outside the app and hold it by plan, so changes reach the rows
  // through the delta rather than as pushed bytes.
  await launchResident({
    authority,
    program: PROGRAM,
    env: { SUPERVISOR: counting },
    cwd: '/srv/elsewhere',
    dataPlan: await residentDataPlan(authority, APP),
    cursor: authority.cursor(),
  });
  return { authority, probe: globalThis.__probe, fetched, log };
}

const reads = (log) => (log.calls.fsReadRange ?? 0) + (log.calls.readFile ?? 0);

await runScenarios(import.meta.path, {
  async 'identical content under two paths is fetched once'() {
    const { probe, fetched } = await boot();
    assert.equal(probe.read(`${APP}/a.txt`), SAME);
    assert.equal(probe.read(`${APP}/b.txt`), SAME);
    const both = fetched.filter((p) => /\/(a|b)\.txt$/.test(p));
    assert.equal(both.length, 1, `one of the two identical files was fetched (${JSON.stringify(both)})`);
  },

  async 'a change that leaves the bytes alone keeps the held row'() {
    const { authority, probe, fetched, log } = await boot();
    const before = fetched.length;
    const readsBefore = reads(log);
    authority.kfs.chmod('home/user/app/a.txt', 0o600);
    authority.kfs.writeFile('home/user/app/c.txt', 'c-bytes');
    assert.equal(await probe.resume(`${APP}/a.txt`, `${APP}/c.txt`), `${SAME}|c-bytes`);
    assert.equal(fetched.length, before, 'no batch read');
    assert.equal(reads(log), readsBefore, 'no live read');
  },

  async 'a change of bytes is still a change'() {
    const { authority, probe } = await boot();
    authority.kfs.writeFile('home/user/app/a.txt', 'different');
    assert.equal(await probe.resume(`${APP}/a.txt`, `${APP}/b.txt`), `different|${SAME}`);
  },
});
