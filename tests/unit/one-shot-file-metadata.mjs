#!/usr/bin/env bun
// A file or directory a node program creates gets the mode it asked for, as
// Node's does, at the session and in the program's own stat:
// - writeFile's, appendFile's, open's and a write stream's `mode` (in each of
//   their forms), less the process's umask; a file already there keeps its own;
// - mkdir's `mode`, less the umask; mkdtemp's 0700 (at once, as the next stat
//   sees it, and as the session holds it);
// - copyFile: the source's mode exactly, over a file already there too, and
//   while it is made another principal can read no more of it than the
//   source lets it: a file there is narrowed before the bytes go in;
// - cpSync and fs.promises.cp, as Node 22.23.4 copies a tree (its oracle run
//   over these trees, verify/consolidation/copy-authority-shim/
//   oracle-metadata): each file the source's mode; each directory cpSync
//   makes 0777 less the umask, and one fs.promises.cp makes the source's
//   once its entries are in; a copy that fails leaves what it made so;
// - chmod and fchmod: the mode set, with nothing after it to carry it;
// - utimes, lutimes and futimes: the times set, at once in the program's own
//   stat and at the session, with nothing after them to carry them.
// Runs the real generated one-shot module. Red before: every such file was
// created 0666 less the umask, mkdtemp 0777 less it, a copy as a new file.
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
const dir = mkdtempSync(join(tmpdir(), 'one-shot-file-metadata-'));
realProcess.on('exit', () => rmSync(dir, { recursive: true, force: true }));
const cred = { uid: 1000, gid: 1000, groups: [1000], umask: 0o022 };
const authority = createAuthority();
const kernel = authority.rawVfs.as(CRED_KERNEL);
const own = (path, mode) => { kernel.chown(path, 1000, 1000); kernel.chmod(path, mode); };
authority.kfs.writeFile('home/user/existing.txt', 'before');
own('home/user/existing.txt', 0o644);
authority.kfs.writeFile('home/user/secret.txt', 'secret');
own('home/user/secret.txt', 0o600);
authority.kfs.writeFile('home/user/copy-over.txt', 'old');
own('home/user/copy-over.txt', 0o644);
authority.kfs.mkdir('home/user/private');
own('home/user/private', 0o700);
authority.kfs.writeFile('home/user/private/key', 'k');
own('home/user/private/key', 0o600);
authority.kfs.writeFile('home/user/private/notes', 'n');
own('home/user/private/notes', 0o644);
// A tree another principal owns and shares with the copier's group alone:
// fs.promises.cp's copy ends with the same modes, its directories closed even
// to their owner, each given its final mode only once everything beneath it
// has its own; cpSync's leaves its directories as it made them.
kernel.mkdir('home/user/team/sub', { recursive: true });
kernel.writeFile('home/user/team/top', 't');
kernel.writeFile('home/user/team/sub/file', 'f');
for (const [path, mode] of [['home/user/team/sub/file', 0o040], ['home/user/team/top', 0o040], ['home/user/team/sub', 0o050], ['home/user/team', 0o050]]) {
  kernel.chown(path, 3000, 1000);
  kernel.chmod(path, mode);
}
// A private tree whose copy fails partway: a readable entry, then one its owner may not read.
kernel.mkdir('home/user/broken');
own('home/user/broken', 0o700);
authority.kfs.writeFile('home/user/broken/a-notes', 'n');
own('home/user/broken/a-notes', 0o644);
authority.kfs.writeFile('home/user/broken/z-locked', 'z');
own('home/user/broken/z-locked', 0o000);

const expected = {
  'sync.txt': 0o600,
  'sync-string-mode.txt': 0o640,
  'sync-default.txt': 0o644,
  'sync-masked.txt': 0o755,
  'existing.txt': 0o644,
  'append-sync.txt': 0o604,
  'callback.txt': 0o640,
  'promise.txt': 0o600,
  'promise-append.txt': 0o640,
  'open-sync.txt': 0o600,
  'open-string-mode.txt': 0o640,
  'promise-open.txt': 0o600,
  'stream.txt': 0o600,
  'made-dir': 0o700,
  'copy-new.txt': 0o600,
  'copy-over.txt': 0o600,
  'promise-copy.txt': 0o600,
  'copied-dir': 0o755,
  'copied-dir/key': 0o600,
  'promise-copied-dir': 0o700,
  'promise-copied-dir/key': 0o600,
  'copied-dir/notes': 0o644,
  'promise-copied-dir/notes': 0o644,
  'chmod-sync.txt': 0o600,
  'fchmod-sync.txt': 0o600,
  'team-copy': 0o755,
  'promise-team-copy': 0o050,
};
// Beneath a directory closed to its owner, only the kernel can look.
const teamBelow = {
  'team-copy': { 'sub': 0o755, 'sub/file': 0o040, 'top': 0o040 },
  'promise-team-copy': { 'sub': 0o050, 'sub/file': 0o040, 'top': 0o040 },
};
const program = `
const fs = require('fs');
(async () => {
  const at = (name) => '/home/user/' + name;
  fs.writeFileSync(at('sync.txt'), 'a', { mode: 0o600 });
  fs.writeFileSync(at('sync-string-mode.txt'), 'a', { mode: '640' });
  fs.writeFileSync(at('sync-default.txt'), 'a');
  fs.writeFileSync(at('sync-masked.txt'), 'a', { mode: 0o777 });
  fs.writeFileSync(at('existing.txt'), 'after', { mode: 0o600 });
  fs.appendFileSync(at('append-sync.txt'), 'a', { mode: 0o604 });
  await new Promise((resolve, reject) => fs.writeFile(at('callback.txt'), 'a', { mode: 0o640 }, (e) => (e ? reject(e) : resolve())));
  await fs.promises.writeFile(at('promise.txt'), 'a', { mode: 0o600 });
  await fs.promises.appendFile(at('promise-append.txt'), 'a', { mode: 0o640 });
  fs.closeSync(fs.openSync(at('open-sync.txt'), 'w', 0o600));
  fs.closeSync(fs.openSync(at('open-string-mode.txt'), 'w', '640'));
  await (await fs.promises.open(at('promise-open.txt'), 'w', 0o600)).close();
  await new Promise((resolve, reject) => fs.createWriteStream(at('stream.txt'), { mode: 0o600 }).on('error', reject).on('close', resolve).end('a'));
  fs.mkdirSync(at('made-dir'), { mode: 0o700 });
  const madeNow = fs.statSync(at('made-dir')).mode & 0o777;
  const temp = fs.mkdtempSync(at('temp-'));
  const tempNow = fs.statSync(temp).mode & 0o777;
  fs.copyFileSync(at('secret.txt'), at('copy-new.txt'));
  fs.copyFileSync(at('secret.txt'), at('copy-over.txt'));
  await fs.promises.copyFile(at('secret.txt'), at('promise-copy.txt'));
  fs.cpSync(at('private'), at('copied-dir'), { recursive: true });
  await fs.promises.cp(at('private'), at('promise-copied-dir'), { recursive: true });
  const failed = [];
  try { fs.cpSync(at('broken'), at('broken-copy'), { recursive: true }); } catch (error) { failed.push(error.code); }
  try { await fs.promises.cp(at('broken'), at('promise-broken-copy'), { recursive: true }); } catch (error) { failed.push(error.code); }
  fs.cpSync(at('team'), at('team-copy'), { recursive: true });
  await fs.promises.cp(at('team'), at('promise-team-copy'), { recursive: true });
  fs.writeFileSync(at('chmod-sync.txt'), 'a');
  fs.chmodSync(at('chmod-sync.txt'), 0o600);
  const fd = fs.openSync(at('fchmod-sync.txt'), 'w');
  fs.fchmodSync(fd, 0o600);
  fs.closeSync(fd);
  fs.writeFileSync(at('utimes-sync.txt'), 'a');
  fs.utimesSync(at('utimes-sync.txt'), 1000, 2000);
  const timedNow = fs.statSync(at('utimes-sync.txt')).mtimeMs;
  await fs.promises.symlink('utimes-sync.txt', at('lutimes-link'));
  // A link made by the async call is in the sync view once a barrier brings it.
  await fs.promises.readdir('/home/user');
  fs.lutimesSync(at('lutimes-link'), 1000, 3000);
  const tfd = fs.openSync(at('futimes-sync.txt'), 'w');
  fs.futimesSync(tfd, 1000, 4000);
  fs.closeSync(tfd);
  const modes = {};
  for (const name of ${JSON.stringify(Object.keys(expected))}) modes[name] = fs.statSync(at(name)).mode & 0o777;
  console.log(JSON.stringify({ modes, temp: temp.slice('/home/user/'.length), tempMode: fs.statSync(temp).mode & 0o777, madeNow, tempNow, failed,
    timedNow, times: { utimes: fs.statSync(at('utimes-sync.txt')).mtimeMs, lutimes: fs.lstatSync(at('lutimes-link')).mtimeMs, futimes: fs.statSync(at('futimes-sync.txt')).mtimeMs } }));
})();
`;
const generated = await generateEntrypointCode(program, { bundle: {} }, false, nodeFacetSources(generateShimsCode()));
const file = writeModuleSet(join(dir, 'entry'), generatedModuleSet(generated, 'runner.mjs'), 'runner.mjs');
const mod = await import(file);

// Another principal, after every change the session commits while the copy
// over a file is made: the secret it holds, it is refused.
const other = authority.rawVfs.as({ uid: 2000, gid: 2000, groups: [2000], umask: 0o022 });
const exposures = [];
const present = (path) => { try { kernel.stat(path); return true; } catch { return false; } };
const readAs = (path) => { try { other.readFile(path); return 'read'; } catch (error) { return error.code; } };
const stopWatching = kernel.subscribe('home/user', () => {
  if (present('home/user/copy-over.txt') && new TextDecoder().decode(kernel.readFile('home/user/copy-over.txt')) === 'secret') {
    const answer = readAs('home/user/copy-over.txt');
    if (answer !== 'EACCES') exposures.push(`copy-over.txt holding the secret: ${answer}`);
  }
});
const process = processInstanceSupervisor(authority, cred);
let body;
try {
  const response = await mod.default.fetch(new Request('http://facet/', {
    method: 'POST',
    body: JSON.stringify({
      argv: [], env: {}, cwd: '/home/user', filename: '/home/user/main.js', dirname: '/home/user',
      stdin: '', captureOutput: true, cred, pid: process.pid,
    }),
  }), { SUPERVISOR: process.supervisor });
  body = await response.json();
} finally {
  await process.close();
  stopWatching();
}
assert.equal(body.exitCode, 0, JSON.stringify(body));
assert.equal(body.stderr, '');
const seen = JSON.parse(body.stdout);
assert.deepEqual(seen.modes, expected, 'the program stats each path with the mode it was made with');
assert.equal(seen.tempMode, 0o700, "the program stats mkdtemp's directory 0700");
assert.deepEqual([seen.madeNow, seen.tempNow], [0o700, 0o700], 'the stat straight after mkdir and mkdtemp sees the mode each made');
const atSession = (name) => authority.kfs.stat('home/user/' + name).mode & 0o777;
assert.deepEqual(Object.fromEntries(Object.keys(expected).map((name) => [name, atSession(name)])), expected, 'the session holds each path with the mode it was made with');
assert.equal(atSession(seen.temp), 0o700, "the session holds mkdtemp's directory 0700");
const setTimes = { utimes: 2_000_000, lutimes: 3_000_000, futimes: 4_000_000 };
assert.equal(seen.timedNow, setTimes.utimes, 'the stat straight after utimes sees the time it set');
assert.deepEqual(seen.times, setTimes, 'the program stats each path with the time it set');
assert.deepEqual({
  utimes: kernel.stat('home/user/utimes-sync.txt').mtime,
  lutimes: kernel.lstat('home/user/lutimes-link').mtime,
  futimes: kernel.stat('home/user/futimes-sync.txt').mtime,
}, setTimes, 'the session holds each path with the time it set');
for (const [copy, modes] of Object.entries(teamBelow)) {
  const below = Object.keys(modes).map((name) => [name, kernel.stat(`home/user/${copy}/${name}`).mode & 0o777]);
  assert.deepEqual(Object.fromEntries(below), modes, `the session holds ${copy}'s entries with Node's modes`);
}
assert.deepEqual(exposures, [], 'another principal was refused the secret while the copy over a file was made');
// A copy that failed partway leaves what it made as Node leaves it.
assert.deepEqual(seen.failed, ['EACCES', 'EACCES'], 'both copies of the tree with an unreadable entry fail');
for (const copy of ['broken-copy', 'promise-broken-copy']) {
  assert.ok(present(`home/user/${copy}/a-notes`), `${copy}/a-notes was copied before the failure`);
  assert.deepEqual([kernel.stat(`home/user/${copy}`).mode & 0o777, kernel.stat(`home/user/${copy}/a-notes`).mode & 0o777], [0o755, 0o644], `${copy} is left as Node leaves it`);
}
realProcess.stdout.write('one-shot-file-metadata: PASS\n');
realProcess.exit(0);
