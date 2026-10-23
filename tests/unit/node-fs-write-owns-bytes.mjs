#!/usr/bin/env bun
// A write takes the bytes as they are when it is made, as Node's does: what
// the program does to its buffer afterwards is not the file's. And the file
// is never kept in the program's memory: growing it (an append through a
// descriptor) writes nothing past the end of the buffer it was written from.
// Red before: writeFileSync, appendFileSync and fs.promises.writeFile kept
// the caller's Uint8Array as the file's bytes, so a later fill of it changed
// what readFileSync read, and an append grew the file inside the caller's
// ArrayBuffer, over whatever else it held; and what they and a descriptor's
// write sent the session was a view of the caller's buffer (Buffer#slice),
// read when the write was sent, after the program had changed it.
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { generateEntrypointCode } from '../../packages/worker/src/facets/manager.ts';
import { generateShimsCode } from '../../packages/worker/src/runtime/node-shims.ts';
import { nodeFacetSources } from './lib/node-facet-sources.mjs';
import { generatedModuleSet, writeModuleSet } from './lib/module-map-bundle.mjs';
import { createAuthority } from './lib/resident-body.mjs';
import { processInstanceSupervisor } from './lib/process-instance-supervisor.mjs';
import { CRED_KERNEL } from '../../packages/core/src/runtime/os-contracts.ts';

const realProcess = globalThis.process;
const dir = mkdtempSync(join(tmpdir(), 'node-fs-write-owns-bytes-'));
realProcess.on('exit', () => rmSync(dir, { recursive: true, force: true }));
const cred = { uid: 1000, gid: 1000, groups: [1000], umask: 0o022 };
const authority = createAuthority();
authority.kfs.mkdir('home/user', { recursive: true });
authority.rawVfs.as(CRED_KERNEL).chown('home/user', 1000, 1000);

const program = `
const fs = require('fs');
(async () => {
  const seen = {};
  const text = (p) => fs.readFileSync(p, 'latin1');
  // Written, then the buffer changed.
  const a = Buffer.from('abcd');
  fs.writeFileSync('/home/user/a', a);
  a.fill(120);
  seen.writeFileSync = text('/home/user/a');
  const b = Buffer.from('efgh');
  fs.appendFileSync('/home/user/b', b);
  b.fill(120);
  seen.appendFileSync = text('/home/user/b');
  const c = Buffer.from('ijkl');
  await fs.promises.writeFile('/home/user/c', c);
  c.fill(120);
  seen.promisesWriteFile = text('/home/user/c');
  // Read, then the read buffer changed.
  fs.writeFileSync('/home/user/e', 'mnop');
  const r = fs.readFileSync('/home/user/e');
  r.fill(121);
  seen.readBack = text('/home/user/e');
  // Written from a view into a larger buffer, then grown through a descriptor.
  const big = new Uint8Array(64).fill(7);
  fs.writeFileSync('/home/user/d', big.subarray(0, 4));
  const fd = fs.openSync('/home/user/d', 'a');
  const zz = Buffer.from('ZZ');
  fs.writeSync(fd, zz);
  zz.fill(120);
  fs.closeSync(fd);
  seen.beyondTheView = Array.from(big.subarray(4, 8));
  seen.grown = Array.from(fs.readFileSync('/home/user/d'));
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
const results = [];
const check = (name, fn) => { try { fn(); results.push(['ok', name]); } catch (error) { results.push(['FAIL', name, error.message.split('\n')[0]]); } };
check('writeFileSync keeps the bytes it was given', () => assert.equal(seen.writeFileSync, 'abcd'));
check('appendFileSync too', () => assert.equal(seen.appendFileSync, 'efgh'));
check('fs.promises.writeFile too', () => assert.equal(seen.promisesWriteFile, 'ijkl'));
check('a buffer readFileSync returned is the program\'s own', () => assert.equal(seen.readBack, 'mnop'));
check('growing a file writes nothing past the view it was written from', () => assert.deepEqual(seen.beyondTheView, [7, 7, 7, 7]));
check('and the file is what was written, then appended', () => assert.deepEqual(seen.grown, [7, 7, 7, 7, 90, 90]));
check('and the session has what was written, each file', () => assert.deepEqual(
  ['a', 'b', 'c', 'e'].map((name) => authority.read(`home/user/${name}`)).concat([Array.from(authority.kfs.readFile('home/user/d'))]),
  ['abcd', 'efgh', 'ijkl', 'mnop', [7, 7, 7, 7, 90, 90]],
));
for (const r of results) realProcess.stderr.write(r.join('  ') + '\n');
if (results.some((r) => r[0] === 'FAIL')) realProcess.exit(1);
realProcess.stdout.write('node-fs-write-owns-bytes: ok\n');
realProcess.exit(0);
