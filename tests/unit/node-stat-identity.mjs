#!/usr/bin/env bun
// A Node program's stat answers a file's identity as its filesystem gives it:
// its device and its link count, through statSync and fs.promises.stat alike,
// and a file the program just made is on the device of the directory it is
// in. Runs the real generated one-shot module. Red before: the shim answered
// one made-up device (2049) and a link count from the file's type for every
// path, whatever its filesystem said.
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
const dir = mkdtempSync(join(tmpdir(), 'node-stat-identity-'));
realProcess.on('exit', () => rmSync(dir, { recursive: true, force: true }));
const cred = { uid: 1000, gid: 1000, groups: [1000], umask: 0o022 };
const authority = createAuthority();
authority.kfs.mkdir('home/user/held', { recursive: true });
authority.kfs.writeFile('home/user/held/file.txt', 'held');
const kernel = authority.rawVfs.as(CRED_KERNEL);
const expected = (path) => { const stat = kernel.stat(path); return { dev: stat.dev, nlink: stat.nlink }; };

const program = `
const fs = require('fs');
const identity = (stat) => ({ dev: stat.dev, nlink: stat.nlink });
(async () => {
  fs.writeFileSync('/home/user/held/made.txt', 'made');
  console.log(JSON.stringify({
    fileSync: identity(fs.statSync('/home/user/held/file.txt')),
    fileAsync: identity(await fs.promises.stat('/home/user/held/file.txt')),
    dirSync: identity(fs.statSync('/home/user/held')),
    dirAsync: identity(await fs.promises.stat('/home/user/held')),
    made: identity(fs.statSync('/home/user/held/made.txt')),
  }));
})();
`;
const generated = await generateEntrypointCode(program, { bundle: {} }, false, nodeFacetSources(generateShimsCode()));
const mod = await import(writeModuleSet(join(dir, 'entry'), generatedModuleSet(generated, 'runner.mjs'), 'runner.mjs'));
const instance = processInstanceSupervisor(authority, cred);
let body;
try {
  const response = await mod.default.fetch(new Request('http://facet/', {
    method: 'POST',
    body: JSON.stringify({ vfsRoot: instance.root(),
      argv: [], env: {}, cwd: '/home/user', filename: '/home/user/main.js', dirname: '/home/user',
      stdin: '', captureOutput: true, cred, pid: instance.pid,
    }),
  }), { SUPERVISOR: instance.supervisor });
  body = await response.json();
} finally {
  await instance.close();
}
assert.equal(body.exitCode, 0, JSON.stringify(body));
const seen = JSON.parse(body.stdout);
const file = expected('home/user/held/file.txt');
const directory = expected('home/user/held');
assert.deepEqual([seen.fileSync, seen.fileAsync], [file, file], "a file's device and links are its filesystem's, sync and async");
assert.deepEqual([seen.dirSync, seen.dirAsync], [directory, directory], "and a directory's");
assert.deepEqual(seen.made, expected('home/user/held/made.txt'), 'a file the program made is on its directory\'s device, as its filesystem then says');
realProcess.stdout.write('node-stat-identity: PASS\n');
realProcess.exit(0);
