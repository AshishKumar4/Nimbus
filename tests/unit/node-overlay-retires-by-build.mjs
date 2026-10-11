#!/usr/bin/env bun
// What a rename this process made shows (its overlay alias: the new name
// read at the old one's rows) goes once an answer that has the rename
// arrives, even when the arguments that answer answers were built at the
// cursor of a read made before the rename. Red before: the overlay retired
// against the EARLIEST build at a cursor, so an answer to a read made after
// the rename, at the same cursor, retired nothing; it moved the rows to the
// new name while the alias kept reading the old one, and the next write
// there was ENOENT. create-next-app --src-dir: read app/page.tsx, mkdir src,
// rename app src/app, read src/app/page.tsx, write src/app/page.tsx: ENOENT.

import assert from 'node:assert/strict';
import {
  createAuthority,
  facetSupervisor,
  launchResident,
  runScenarios,
  residentDataPlan,
} from './lib/resident-body.mjs';

const PROGRAM = `
const fs = require("fs");
globalThis.__probe = { fs };
require("http").createServer((q, s) => s.end("up")).listen(3000);
`;

async function boot() {
  const authority = createAuthority();
  authority.kfs.mkdir('home/user/mvp/app', { recursive: true, mode: 0o755 });
  authority.kfs.writeFile('home/user/mvp/app/page.tsx', 'app/page');
  for (const dir of ['home/user/mvp', 'home/user/mvp/app']) authority.kfs.chown(dir, 1000, 1000);
  authority.kfs.chown('home/user/mvp/app/page.tsx', 1000, 1000);
  const handle = facetSupervisor(authority);
  await launchResident({
    authority,
    program: PROGRAM,
    cwd: '/home/user/mvp',
    env: { SUPERVISOR: handle.supervisor },
    dataPlan: await residentDataPlan(authority, '/home/user/mvp'),
    cursor: authority.cursor(),
  });
  return { authority, fs: globalThis.__probe.fs };
}

await runScenarios(import.meta.path, {
  async 'a rename read before and after, then a write at the new name'() {
    const { authority, fs } = await boot();
    const root = '/home/user/mvp';
    assert.equal(await fs.promises.readFile(`${root}/app/page.tsx`, 'utf8'), 'app/page');
    await fs.promises.mkdir(`${root}/src`, { recursive: true });
    await fs.promises.rename(`${root}/app`, `${root}/src/app`);
    assert.equal(await fs.promises.readFile(`${root}/src/app/page.tsx`, 'utf8'), 'app/page');
    await fs.promises.writeFile(`${root}/src/app/page.tsx`, 'src/app/page');
    assert.equal(await fs.promises.readFile(`${root}/src/app/page.tsx`, 'utf8'), 'src/app/page');
    assert.equal(fs.existsSync(`${root}/app`), false);
    assert.deepEqual(fs.readdirSync(`${root}/src/app`), ['page.tsx']);
    assert.equal(new TextDecoder().decode(authority.kfs.readFile('home/user/mvp/src/app/page.tsx')), 'src/app/page');
  },
});
