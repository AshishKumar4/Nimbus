#!/usr/bin/env bun
// A Node program's writes under a directory reach the session before the
// directory is moved or removed, whatever is still queued when it is:
// - a rename of a directory takes every file just written into it, to its
//   new name, into a parent made just before;
// - rm -r of a directory leaves nothing of what was just written there;
// - rmdir of a directory whose files were just removed finds it empty.
// Each in its sync and async form. Runs the real generated one-shot module
// against a session; what it checks is the session's tree when the run ends.
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { generateEntrypointCode } from '../../packages/worker/src/facets/manager.ts';
import { generateShimsCode } from '../../packages/worker/src/runtime/node-shims.ts';
import { CRED_KERNEL } from '../../packages/core/src/runtime/os-contracts.ts';
import { nodeFacetSources } from './lib/node-facet-sources.mjs';
import { generatedModuleSet, writeModuleSet } from './lib/module-map-bundle.mjs';
import { createAuthority } from './lib/resident-body.mjs';
import { processInstanceSupervisor } from './lib/process-instance-supervisor.mjs';

const realProcess = globalThis.process;
const dir = mkdtempSync(join(tmpdir(), 'one-shot-structural-order-'));
realProcess.on('exit', () => rmSync(dir, { recursive: true, force: true }));
const cred = { uid: 1000, gid: 1000, groups: [1000], umask: 0o022 };
const authority = createAuthority();
const kernel = authority.rawVfs.as(CRED_KERNEL);

const program = `
const fs = require('fs');
const at = (name) => '/home/user/' + name;
const fill = (d) => {
  fs.mkdirSync(at(d + '/deep'), { recursive: true });
  for (let i = 0; i < 20; i++) fs.writeFileSync(at(d + '/f' + i), d + ' ' + i);
  fs.writeFileSync(at(d + '/deep/last'), d + ' deep');
};
(async () => {
  // Moved with its writes still queued, into a parent made just before.
  fill('moved-sync');
  fs.mkdirSync(at('parent-sync'));
  fs.renameSync(at('moved-sync'), at('parent-sync/moved'));
  fill('moved-async');
  await fs.promises.mkdir(at('parent-async'));
  await fs.promises.rename(at('moved-async'), at('parent-async/moved'));
  // Removed with its writes still queued.
  fill('removed-sync');
  fs.rmSync(at('removed-sync'), { recursive: true });
  fill('removed-async');
  await fs.promises.rm(at('removed-async'), { recursive: true });
  // Emptied, then removed.
  fs.mkdirSync(at('emptied-sync'));
  for (let i = 0; i < 5; i++) fs.writeFileSync(at('emptied-sync/f' + i), 'x');
  for (let i = 0; i < 5; i++) fs.unlinkSync(at('emptied-sync/f' + i));
  fs.rmdirSync(at('emptied-sync'));
  await fs.promises.mkdir(at('emptied-async'));
  for (let i = 0; i < 5; i++) await fs.promises.writeFile(at('emptied-async/f' + i), 'x');
  for (let i = 0; i < 5; i++) await fs.promises.unlink(at('emptied-async/f' + i));
  await fs.promises.rmdir(at('emptied-async'));
  console.log('done');
})();
`;
const generated = await generateEntrypointCode(program, { bundle: {} }, false, nodeFacetSources(generateShimsCode()));
const file = writeModuleSet(join(dir, 'entry'), generatedModuleSet(generated, 'runner.mjs'), 'runner.mjs');
const mod = await import(file);
const process = processInstanceSupervisor(authority, cred);
let body;
try {
  const response = await mod.default.fetch(new Request('http://facet/', {
    method: 'POST',
    body: JSON.stringify({ vfsRoot: process.root(),
      argv: [], env: {}, cwd: '/home/user', filename: '/home/user/main.js', dirname: '/home/user',
      stdin: '', captureOutput: true, cred, pid: process.pid,
    }),
  }), { SUPERVISOR: process.supervisor });
  body = await response.json();
} finally {
  await process.close();
}
assert.equal(body.exitCode, 0, JSON.stringify(body));
assert.equal(body.stdout.trim(), 'done', body.stderr);

const present = (path) => { try { kernel.lstat(path); return true; } catch { return false; } };
const text = (path) => new TextDecoder().decode(kernel.readFile(path));
for (const form of ['sync', 'async']) {
  const moved = `home/user/parent-${form}/moved`;
  assert.equal(present(`home/user/moved-${form}`), false, `the ${form} rename leaves nothing at the old name`);
  assert.deepEqual(
    Array.from({ length: 20 }, (_, i) => text(`${moved}/f${i}`)),
    Array.from({ length: 20 }, (_, i) => `moved-${form} ${i}`),
    `the ${form} rename took every file just written`,
  );
  assert.equal(text(`${moved}/deep/last`), `moved-${form} deep`, `the ${form} rename took the nested file`);
  assert.equal(present(`home/user/removed-${form}`), false, `the ${form} rm -r left nothing of what was just written`);
  assert.equal(present(`home/user/emptied-${form}`), false, `the ${form} rmdir found the directory emptied`);
}
realProcess.stdout.write('one-shot-structural-order: PASS\n');
realProcess.exit(0);
