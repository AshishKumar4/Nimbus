#!/usr/bin/env bun
// A link a Node program makes is in its sync view at once, as a directory or
// a file it makes is: realpathSync and fs.promises.realpath give the same
// answer through it, lstat sees the link and stat its target, a write through
// it lands on the target, and renaming, unlinking or removing the tree that
// holds it is seen at once too. The links are made where the session's table
// knows the directory, in a directory the program just made, and to one.
// Runs the real generated one-shot module. Red before: the sync view knew a
// link only once a barrier reported it, so realpathSync through a link the
// program had just made was ENOENT.
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
const dir = mkdtempSync(join(tmpdir(), 'node-own-symlink-view-'));
realProcess.on('exit', () => rmSync(dir, { recursive: true, force: true }));
const cred = { uid: 1000, gid: 1000, groups: [1000], umask: 0o022 };
const authority = createAuthority();
const kernel = authority.rawVfs.as(CRED_KERNEL);
authority.kfs.mkdir('home/user/real/dir', { recursive: true });
authority.kfs.writeFile('home/user/real/dir/file.txt', 'x');
kernel.chown('home/user', 1000, 1000);
kernel.chown('home/user/real', 1000, 1000);
kernel.chown('home/user/real/dir', 1000, 1000);

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
  // Where the table knows the directory, to a directory it knows.
  await fs.promises.symlink('real/dir', '/home/user/l1');
  seen.known = await both('/home/user/l1/file.txt');
  seen.lstat = fs.lstatSync('/home/user/l1').isSymbolicLink();
  seen.stat = fs.statSync('/home/user/l1').isDirectory();
  seen.listed = fs.readdirSync('/home/user/l1');
  fs.writeFileSync('/home/user/l1/through.txt', 't');
  seen.through = fs.readFileSync('/home/user/real/dir/through.txt', 'utf8');
  // To a directory the program just made.
  fs.mkdirSync('/home/user/fresh');
  fs.writeFileSync('/home/user/fresh/f.js', 'f');
  await fs.promises.symlink('fresh', '/home/user/l2');
  seen.toFresh = await both('/home/user/l2/f.js');
  seen.freshListed = fs.readdirSync('/home/user/l2');
  // In a directory the program just made, to one the table knows.
  fs.mkdirSync('/home/user/nm');
  await fs.promises.symlink('../real/dir', '/home/user/nm/pkg');
  seen.inFresh = await both('/home/user/nm/pkg/file.txt');
  // Renamed, unlinked, and removed with the tree that holds it.
  fs.renameSync('/home/user/l1', '/home/user/l1b');
  seen.renamed = await both('/home/user/l1b/file.txt');
  seen.renamedFrom = await both('/home/user/l1');
  seen.renamedLstat = fs.lstatSync('/home/user/l1b').isSymbolicLink();
  fs.unlinkSync('/home/user/l2');
  seen.unlinked = await both('/home/user/l2');
  seen.unlinkedTargetStays = fs.existsSync('/home/user/fresh/f.js');
  fs.rmSync('/home/user/nm', { recursive: true });
  seen.removed = [fs.existsSync('/home/user/nm/pkg'), await both('/home/user/nm/pkg/file.txt')];
  // A dangling link and a cycle.
  await fs.promises.symlink('nowhere', '/home/user/dangling');
  seen.dangling = [fs.lstatSync('/home/user/dangling').isSymbolicLink(), await both('/home/user/dangling')];
  await fs.promises.symlink('loop-b', '/home/user/loop-a');
  await fs.promises.symlink('loop-a', '/home/user/loop-b');
  seen.loop = await both('/home/user/loop-a');
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
assert.deepEqual(seen.known, same('/home/user/real/dir/file.txt'), 'through a link it just made, both forms answer the target');
assert.deepEqual([seen.lstat, seen.stat], [true, true], 'lstat sees the link, stat its target');
assert.deepEqual(seen.listed, ['file.txt'], 'listing it lists the target');
assert.equal(seen.through, 't', 'a write through it lands on the target');
assert.deepEqual(seen.toFresh, same('/home/user/fresh/f.js'), 'to a directory it just made');
assert.deepEqual(seen.freshListed, ['f.js'], 'and listed through it');
assert.deepEqual(seen.inFresh, same('/home/user/real/dir/file.txt'), 'in a directory it just made');
assert.deepEqual(seen.renamed, same('/home/user/real/dir/file.txt'), 'renamed, it resolves under its new name');
assert.deepEqual(seen.renamedFrom, refused('ENOENT'), 'and its old name is gone');
assert.equal(seen.renamedLstat, true, 'and is still a link');
assert.deepEqual(seen.unlinked, refused('ENOENT'), 'unlinked, it is gone');
assert.equal(seen.unlinkedTargetStays, true, 'and its target stays');
assert.deepEqual(seen.removed, [false, refused('ENOENT')], 'removed with the tree that held it');
assert.deepEqual(seen.dangling, [true, refused('ENOENT')], 'a dangling link is there to lstat, and resolves to nothing');
assert.deepEqual(seen.loop, refused('ELOOP'), 'a cycle is ELOOP');
realProcess.stdout.write('node-own-symlink-view: PASS\n');
realProcess.exit(0);
