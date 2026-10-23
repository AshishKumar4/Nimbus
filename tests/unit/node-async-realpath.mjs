#!/usr/bin/env bun
// fs.promises.realpath and callback fs.realpath answer as Node's do: the path
// a symlink resolves to (a link made by the same program included), ENOENT
// for a path that is not there, ELOOP for a link cycle; realpathSync agrees
// on a link the session held at launch.
// Runs the real generated one-shot module. Red before: both async forms
// resolved the path lexically, answering a link with its own name and a
// missing path with itself.
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
const dir = mkdtempSync(join(tmpdir(), 'node-async-realpath-'));
realProcess.on('exit', () => rmSync(dir, { recursive: true, force: true }));
const cred = { uid: 1000, gid: 1000, groups: [1000], umask: 0o022 };
const authority = createAuthority();
const kernel = authority.rawVfs.as(CRED_KERNEL);
authority.kfs.mkdir('home/user/real/dir', { recursive: true });
authority.kfs.writeFile('home/user/real/dir/file.txt', 'x');
kernel.chown('home/user/real', 1000, 1000);
kernel.symlink('real/dir', 'home/user/dirlink');
kernel.symlink('loop-b', 'home/user/loop-a');
kernel.symlink('loop-a', 'home/user/loop-b');

const program = `
const fs = require('fs');
const outcome = (promise) => promise.then((value) => ({ value }), (error) => ({ code: error.code, syscall: error.syscall }));
const callback = (p) => new Promise((resolve) => fs.realpath(p, (error, value) => resolve(error ? { code: error.code } : { value })));
(async () => {
  await fs.promises.symlink('real/dir/file.txt', '/home/user/filelink');
  const seen = {
    viaDirLink: await outcome(fs.promises.realpath('/home/user/dirlink/file.txt')),
    ownLink: await outcome(fs.promises.realpath('/home/user/filelink')),
    relative: await outcome(fs.promises.realpath('real/../dirlink')),
    missing: await outcome(fs.promises.realpath('/home/user/missing')),
    loop: await outcome(fs.promises.realpath('/home/user/loop-a')),
    callbackLink: await callback('/home/user/filelink'),
    callbackMissing: await callback('/home/user/missing'),
    sync: fs.realpathSync('/home/user/dirlink/file.txt'),
  };
  console.log(JSON.stringify(seen));
})();
`;
const generated = await generateEntrypointCode(program, { bundle: {} }, false, nodeFacetSources(generateShimsCode()));
const mod = await import(writeModuleSet(join(dir, 'entry'), generatedModuleSet(generated, 'runner.mjs'), 'runner.mjs'));
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
const seen = JSON.parse(body.stdout);
assert.deepEqual(seen.viaDirLink, { value: '/home/user/real/dir/file.txt' }, 'a path through a directory link resolves to its target');
assert.deepEqual(seen.ownLink, { value: '/home/user/real/dir/file.txt' }, 'a link the program made resolves to its target');
assert.deepEqual(seen.relative, { value: '/home/user/real/dir' }, 'a relative path resolves from the cwd, through its link');
assert.deepEqual(seen.missing, { code: 'ENOENT', syscall: 'realpath' }, 'a missing path is ENOENT');
assert.equal(seen.loop.code, 'ELOOP', 'a link cycle is ELOOP');
assert.deepEqual([seen.callbackLink, seen.callbackMissing], [{ value: '/home/user/real/dir/file.txt' }, { code: 'ENOENT' }], 'the callback form answers the same');
assert.equal(seen.sync, '/home/user/real/dir/file.txt', 'realpathSync agrees');
realProcess.stdout.write('node-async-realpath: PASS\n');
realProcess.exit(0);
