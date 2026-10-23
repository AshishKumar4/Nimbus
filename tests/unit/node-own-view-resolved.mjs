#!/usr/bin/env bun
// What a Node program's sync view says of a name is the session's row for the
// file the name resolves to, with the program's own effects applied along
// that resolution: links followed (its own and the table's), its renames and
// removals on the way, its own directories and files. So:
// - a file it made and then changed the mode of, once the session has
//   reported it, is the session's: a rewrite keeps the mode;
// - a file it rewrote or made keeps the device and links its filesystem
//   gives (the parent's device), once the write is acknowledged;
// - a link it made to a file whose tree it then renamed or removed resolves
//   to nothing, as the target is gone;
// - a link it makes through a directory link (the table's or its own) is in
//   the directory the link names, and resolves from there.
// Runs the real generated one-shot module. Red before: the creation record
// outlived the chmod; the acknowledged row carried device 0 and one link; the
// overlay was consulted at the link's own name, not along what it resolved
// to; and a link made through a directory link was kept under the link's
// spelling, which the walk never reached.
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
const dir = mkdtempSync(join(tmpdir(), 'node-own-view-resolved-'));
realProcess.on('exit', () => rmSync(dir, { recursive: true, force: true }));
const cred = { uid: 1000, gid: 1000, groups: [1000], umask: 0o022 };
const authority = createAuthority();
const kernel = authority.rawVfs.as(CRED_KERNEL);
for (const d of ['home/user/real', 'home/user/tree', 'home/user/tree2']) authority.kfs.mkdir(d, { recursive: true });
authority.kfs.writeFile('home/user/real/file.txt', 'x');
authority.kfs.writeFile('home/user/tree/file', 't');
authority.kfs.writeFile('home/user/tree2/file', 't');
kernel.symlink('real', 'home/user/dirlink');
for (const p of ['home/user', 'home/user/real', 'home/user/real/file.txt', 'home/user/tree', 'home/user/tree/file', 'home/user/tree2', 'home/user/tree2/file']) {
  kernel.chown(p, 1000, 1000);
}

const program = `
const fs = require('fs');
const both = async (p) => {
  let sync;
  try { sync = { value: fs.realpathSync(p) }; } catch (error) { sync = { code: error.code }; }
  let promised;
  try { promised = { value: await fs.promises.realpath(p) }; } catch (error) { promised = { code: error.code }; }
  return { sync, promised };
};
(async () => {
  const seen = {};
  // A mode set, reported, and kept across a rewrite.
  fs.writeFileSync('/home/user/m.txt', 'a');
  fs.chmodSync('/home/user/m.txt', 0o600);
  await fs.promises.stat('/home/user/m.txt');
  fs.writeFileSync('/home/user/m.txt', 'bb');
  seen.mode = (fs.statSync('/home/user/m.txt').mode & 0o777).toString(8);
  // Identity of a rewritten file and of a made one, acknowledged.
  const dev = fs.statSync('/home/user/real').dev;
  fs.writeFileSync('/home/user/real/file.txt', 'y');
  await fs.promises.realpath('/home/user/real/file.txt');
  const rewritten = fs.statSync('/home/user/real/file.txt');
  fs.writeFileSync('/home/user/real/made.txt', 'm');
  await fs.promises.realpath('/home/user/real/made.txt');
  const made = fs.statSync('/home/user/real/made.txt');
  seen.identity = [rewritten.dev === dev, rewritten.nlink, made.dev === dev, made.nlink];
  // A link to a file whose tree is renamed, and one whose tree is removed.
  await fs.promises.symlink('tree/file', '/home/user/l3');
  fs.renameSync('/home/user/tree', '/home/user/moved');
  seen.renamedTree = [fs.existsSync('/home/user/l3'), fs.lstatSync('/home/user/l3').isSymbolicLink(), await both('/home/user/l3')];
  seen.movedReal = await both('/home/user/moved/file');
  await fs.promises.symlink('tree2/file', '/home/user/l4');
  fs.rmSync('/home/user/tree2', { recursive: true });
  seen.removedTree = [fs.existsSync('/home/user/l4'), await both('/home/user/l4')];
  // Links made through a directory link: the table's, then the program's own.
  await fs.promises.symlink('file.txt', '/home/user/dirlink/new1');
  seen.viaTableLink = [await both('/home/user/dirlink/new1'), fs.readdirSync('/home/user/real').includes('new1'), fs.readdirSync('/home/user/dirlink').includes('new1')];
  await fs.promises.symlink('real', '/home/user/ownlink');
  await fs.promises.symlink('file.txt', '/home/user/ownlink/new2');
  seen.viaOwnLink = [await both('/home/user/ownlink/new2'), fs.readdirSync('/home/user/real').includes('new2')];
  // A tree renamed: its files resolve under the new name.
  fs.mkdirSync('/home/user/t5');
  fs.writeFileSync('/home/user/t5/f', 'f');
  fs.renameSync('/home/user/t5', '/home/user/t5moved');
  seen.renamedReal = await both('/home/user/t5moved/f');
  // A file made with a mode, its write acknowledged: still that mode.
  fs.writeFileSync('/home/user/private.txt', 'p', { mode: 0o600 });
  await fs.promises.realpath('/home/user/private.txt');
  seen.madeMode = (fs.statSync('/home/user/private.txt').mode & 0o777).toString(8);
  // A file in a directory made just now, its write acknowledged: the filesystem's device.
  fs.mkdirSync('/home/user/fresh6');
  fs.writeFileSync('/home/user/fresh6/f', 'f');
  await fs.promises.realpath('/home/user/fresh6/f');
  seen.freshDev = fs.statSync('/home/user/fresh6/f').dev === dev;
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
const same = (value) => ({ sync: { value }, promised: { value } });
const refused = (code) => ({ sync: { code }, promised: { code } });
const results = [];
const check = (name, fn) => { try { fn(); results.push(['ok', name]); } catch (error) { results.push(['FAIL', name, error.message.split('\n')[0]]); } };
check('a mode set and reported is kept across a rewrite', () => assert.equal(seen.mode, '600'));
check('a rewritten and a made file keep their filesystem\'s device, and a link', () => assert.deepEqual(seen.identity, [true, 1, true, 1]));
check('a link into a renamed tree resolves to nothing', () => assert.deepEqual(seen.renamedTree, [false, true, refused('ENOENT')]));
check('a link into a removed tree resolves to nothing', () => assert.deepEqual(seen.removedTree, [false, refused('ENOENT')]));
check("a link made through the table's directory link is in the directory it names", () => assert.deepEqual(seen.viaTableLink, [same('/home/user/real/file.txt'), true, true]));
check("and through the program's own", () => assert.deepEqual(seen.viaOwnLink, [same('/home/user/real/file.txt'), true]));
check('a renamed tree resolves under its new name', () => assert.deepEqual([seen.movedReal, seen.renamedReal], [same('/home/user/moved/file'), same('/home/user/t5moved/f')]));
check('a file made with a mode keeps it once its write is acknowledged', () => assert.equal(seen.madeMode, '600'));
check('a file in a directory made just now has its filesystem\'s device', () => assert.equal(seen.freshDev, true));
for (const r of results) realProcess.stderr.write(r.join('  ') + '\n');
if (results.some((r) => r[0] === 'FAIL')) realProcess.exit(1);
realProcess.stdout.write('node-own-view-resolved: ok\n');
realProcess.exit(0);
