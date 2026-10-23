#!/usr/bin/env bun
// fs.promises.copyFile, and fs.copyFile, are one copy the session makes, in
// program order: it copies what the program wrote to the source before it,
// the file's bytes neither read by the process nor sent back, and the copy
// is left as copyfile leaves it (the source's mode exactly, past the umask,
// a file there too, set in the copy itself: one change at the session;
// COPYFILE_EXCL refuses a name that is there). The program's own view has
// the copy's bytes at once (readFileSync, require). Red before: the copy
// read the whole source (fsReadBatch) and sent it back as a write; then its
// mode came after it, a change of its own.
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
const dir = mkdtempSync(join(tmpdir(), 'node-copyfile-logged-'));
realProcess.on('exit', () => rmSync(dir, { recursive: true, force: true }));
const cred = { uid: 1000, gid: 1000, groups: [1000], umask: 0o022 };
const authority = createAuthority();
const kernel = authority.rawVfs.as(CRED_KERNEL);
authority.kfs.mkdir('home/user', { recursive: true });
kernel.chown('home/user', 1000, 1000);
// A file the program has not read, larger than one chunk, outside the
// directory its launch reads ahead.
const big = new Uint8Array(200_000).map((_, i) => i % 251);
kernel.mkdir('srv/data', { recursive: true });
kernel.chown('srv/data', 1000, 1000);
authority.rawVfs.as(cred).writeFile('srv/data/unread.bin', big);
authority.rawVfs.as(cred).chmod('srv/data/unread.bin', 0o666);
// A file there, narrower than what is copied over it.
authority.rawVfs.as(cred).writeFile('home/user/c.txt', 'old');
authority.rawVfs.as(cred).chmod('home/user/c.txt', 0o640);
const changesToC = [];
kernel.subscribe('home/user', (event) => { if (event.path === 'home/user/c.txt') changesToC.push(event.type); });

const program = `
const fs = require('fs');
(async () => {
  const seen = {};
  // What the program wrote to the source just before is what is copied.
  fs.writeFileSync('/home/user/a.txt', 'first');
  fs.writeFileSync('/home/user/a.txt', 'second');
  await fs.promises.copyFile('/home/user/a.txt', '/home/user/b.txt');
  seen.syncRead = fs.readFileSync('/home/user/b.txt', 'utf8');
  // A file it never read, copied whole.
  await fs.promises.copyFile('/srv/data/unread.bin', '/home/user/copy.bin');
  seen.copyMode = (await fs.promises.stat('/home/user/copy.bin')).mode & 0o777;
  // Over a file that is there, and refused with COPYFILE_EXCL.
  await new Promise((resolve, reject) => fs.copyFile('/home/user/a.txt', '/home/user/c.txt', (e) => (e ? reject(e) : resolve())));
  try { await fs.promises.copyFile('/home/user/a.txt', '/home/user/c.txt', fs.constants.COPYFILE_EXCL); seen.excl = 'copied'; }
  catch (error) { seen.excl = error.code + ' ' + error.syscall; }
  console.log(JSON.stringify(seen));
})();
`;
const generated = await generateEntrypointCode(program, { bundle: {} }, false, nodeFacetSources(generateShimsCode()));
const mod = await import(writeModuleSet(join(dir, 'entry'), generatedModuleSet(generated, 'runner.mjs'), 'runner.mjs'));
const process = processInstanceSupervisor(authority, cred);
// What the process asks of the session: a read of the file is a read of its bytes.
const reads = [];
const supervisor = new Proxy(process.supervisor, {
  get(target, key) {
    const value = Reflect.get(target, key);
    if (typeof value !== 'function') return value;
    return (...args) => {
      const op = key === 'answer' && args[0] === 'fsAcquired' ? args[1]?.[1] : key === 'answer' ? args[0] : key;
      const paths = key === 'answer' ? JSON.stringify(args[1] ?? []) : '';
      if (/read/i.test(String(op)) && /unread\.bin|a\.txt/.test(paths)) reads.push(`${op} ${paths}`);
      return Reflect.apply(value, target, args);
    };
  },
});
let body;
try {
  const response = await mod.default.fetch(new Request('http://facet/', {
    method: 'POST',
    body: JSON.stringify({ vfsRoot: process.root(), argv: [], env: {}, cwd: '/home/user', filename: '/home/user/main.js', dirname: '/home/user', stdin: '', captureOutput: true, cred, pid: process.pid }),
  }), { SUPERVISOR: supervisor });
  body = await response.json();
} finally {
  await process.close();
}
assert.equal(body.exitCode, 0, JSON.stringify(body).slice(0, 2000));
const seen = JSON.parse(body.stdout);
const text = (path) => new TextDecoder().decode(kernel.readFile(path));
const results = [];
const check = (name, fn) => { try { fn(); results.push(['ok', name]); } catch (error) { results.push(['FAIL', name, String(error.message).split('\n')[0]]); } };
check('the copy is what the program wrote to the source before it', () => assert.equal(text('home/user/b.txt'), 'second'));
check('the program reads the copy at once', () => assert.equal(seen.syncRead, 'second'));
check('a file it never read is copied whole', () => assert.deepEqual(kernel.readFile('home/user/copy.bin'), big));
check('with the source\'s mode exactly, past the umask', () => assert.deepEqual([seen.copyMode, kernel.stat('home/user/copy.bin').mode & 0o777], [0o666, 0o666]));
check('over a file that is there', () => assert.equal(text('home/user/c.txt'), 'second'));
check('with the source\'s mode, in the one change the copy is', () => assert.deepEqual([kernel.stat('home/user/c.txt').mode & 0o777, changesToC.length], [0o644, 1], JSON.stringify(changesToC)));
check('COPYFILE_EXCL refuses a name that is there', () => assert.equal(seen.excl, 'EEXIST copyfile'));
check('no byte of a source is read by the process', () => assert.deepEqual(reads, [], JSON.stringify(reads).slice(0, 600)));
for (const r of results) realProcess.stderr.write(r.join('  ') + '\n');
if (results.some((r) => r[0] === 'FAIL')) realProcess.exit(1);
realProcess.stdout.write('node-copyfile-logged: ok\n');
realProcess.exit(0);
