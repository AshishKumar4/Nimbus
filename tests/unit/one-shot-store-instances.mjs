#!/usr/bin/env bun
// Reuse ONE real generated one-shot module for two credentials. The extra
// shim hook only seeds a cell through the store's API, without a write ledger
// entry: unlike fs.writeFileSync it leaves genuinely process-only bytes at exit.
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { generateEntrypointCode } from '../../packages/worker/src/facets/manager.ts';
import { generateShimsCode } from '../../packages/worker/src/runtime/node-shims.ts';
import { nodeFacetSources } from './lib/node-facet-sources.mjs';
import { generatedModuleSet, writeModuleSet } from './lib/module-map-bundle.mjs';
import { createAuthority } from './lib/resident-body.mjs';
import { CRED_KERNEL } from '../../packages/core/src/runtime/os-contracts.ts';
import { processInstanceSupervisor } from './lib/process-instance-supervisor.mjs';

const realProcess = globalThis.process;
const dir = mkdtempSync(join(tmpdir(), 'one-shot-instances-'));
realProcess.on('exit', () => rmSync(dir, { recursive: true, force: true }));
const firstCred = { uid: 1000, gid: 1000, groups: [1000], umask: 0o022 };
const secondCred = { uid: 2000, gid: 2000, groups: [2000], umask: 0o077 };
const authority = createAuthority();
authority.kfs.writeFile('home/user/memory-only.txt', 'authority bytes');
authority.kfs.writeFile('home/user/shared-meta.txt', 'shared');
authority.kfs.chmod('home/user/shared-meta.txt', 0o644);
const sources = nodeFacetSources(generateShimsCode() + `
globalThis.__instanceTestOwnCell = (path, value) => { __resident.bundle[path] = value; };
`);
const program = `
const fs = require('fs');
if (process.argv.includes('first')) {
  fs.writeFileSync('/home/user/secret.txt', 'private', { mode: 0o600 });
  // What it sets on a file the session then changes back.
  fs.chmodSync('/home/user/shared-meta.txt', 0o600);
  fs.utimesSync('/home/user/shared-meta.txt', 1000, 1000);
  globalThis.__instanceTestOwnCell('home/user/memory-only.txt', 'only in the first process');
  console.log('memory=' + fs.readFileSync('/home/user/memory-only.txt', 'utf8'));
  console.log('ok');
} else {
  let denied = 'READ SUCCEEDED';
  try { fs.readFileSync('/home/user/secret.txt'); } catch (error) { denied = error.code; }
  console.log(JSON.stringify({
    denied,
    exists: fs.existsSync('/home/user/secret.txt'),
    memory: fs.readFileSync('/home/user/memory-only.txt', 'utf8'),
    meta: { mode: fs.statSync('/home/user/shared-meta.txt').mode & 0o777, mtimeMs: fs.statSync('/home/user/shared-meta.txt').mtimeMs },
    uid: process.getuid(),
  }));
}
`;
const generated = await generateEntrypointCode(program, { bundle: {} }, false, sources);
const file = writeModuleSet(join(dir, 'entry'), generatedModuleSet(generated, 'runner.mjs'), 'runner.mjs');
const mod = await import(file); // Deliberately imported once, not once per request.

async function run(cred, arg) {
  const process = processInstanceSupervisor(authority, cred);
  try {
    const response = await mod.default.fetch(new Request('http://facet/', {
      method: 'POST',
      body: JSON.stringify({ vfsRoot: process.root(),
        argv: [arg], env: {}, cwd: '/home/user', filename: '/home/user/main.js', dirname: '/home/user',
        stdin: '', captureOutput: true, cred, pid: process.pid,
        dataPlan: ['home/user/memory-only.txt', 'home/user/secret.txt'],
      }),
    }), { SUPERVISOR: process.supervisor });
    return await response.json();
  } finally {
    await process.close();
  }
}

const first = await run(firstCred, 'first');
assert.equal(first.exitCode, 0, JSON.stringify(first));
assert.equal(first.stdout, 'memory=only in the first process\nok\n');
assert.equal(first.stderr, '');
// What the first process left at the authority, as it left it: its own file, with the mode it asked for.
const stat = authority.kfs.stat('home/user/secret.txt');
assert.equal(stat.uid, 1000, 'the first write reached the authority as its own process');
assert.equal(stat.mode & 0o7777, 0o600, 'the first write made the file with the mode it asked for');
assert.equal(authority.read('home/user/secret.txt'), 'private');
assert.equal(authority.read('home/user/memory-only.txt'), 'authority bytes', 'the injected cell never reached the authority');
// The session changes back what the first process set.
const kernel = authority.rawVfs.as(CRED_KERNEL);
kernel.chmod('home/user/shared-meta.txt', 0o644);
kernel.utimes('home/user/shared-meta.txt', 5_000_000, 5_000_000);
const secondAuthority = authority.rawVfs.as(secondCred);
assert.throws(() => secondAuthority.readFile('home/user/secret.txt'), { code: 'EACCES' });

const second = await run(secondCred, 'second');
assert.equal(second.exitCode, 0, JSON.stringify(second));
assert.equal(second.stderr, '');
assert.deepEqual(JSON.parse(second.stdout), {
  denied: 'EACCES',
  exists: secondAuthority.exists('home/user/secret.txt'),
  memory: 'authority bytes',
  meta: { mode: 0o644, mtimeMs: 5_000_000 },
  uid: 2000,
}, "the second fetch has its own namespace, credential, own-write cells, and modes and times: the session's, not the first's");
delete globalThis.__instanceTestOwnCell;
realProcess.stdout.write('one-shot-store-instances: PASS\n');
realProcess.exit(0);
