#!/usr/bin/env bun
// A file or directory a node program creates gets the mode it asked for, as
// Node's does, at the session and in the program's own stat:
// - writeFile's, appendFile's, open's and a write stream's `mode` (in each of
//   their forms), less the process's umask; a file already there keeps its own;
// - mkdir's `mode`, less the umask; mkdtemp's 0700;
// - copyFile and cp: the source's mode exactly, over a file already there too.
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
const dir = mkdtempSync(join(tmpdir(), 'one-shot-write-mode-'));
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
  'copied-dir': 0o700,
  'copied-dir/key': 0o600,
  'promise-copied-dir': 0o700,
  'promise-copied-dir/key': 0o600,
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
  const temp = fs.mkdtempSync(at('temp-'));
  fs.copyFileSync(at('secret.txt'), at('copy-new.txt'));
  fs.copyFileSync(at('secret.txt'), at('copy-over.txt'));
  await fs.promises.copyFile(at('secret.txt'), at('promise-copy.txt'));
  fs.cpSync(at('private'), at('copied-dir'), { recursive: true });
  await fs.promises.cp(at('private'), at('promise-copied-dir'), { recursive: true });
  const modes = {};
  for (const name of ${JSON.stringify(Object.keys(expected))}) modes[name] = fs.statSync(at(name)).mode & 0o777;
  console.log(JSON.stringify({ modes, temp: temp.slice('/home/user/'.length), tempMode: fs.statSync(temp).mode & 0o777 }));
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
    body: JSON.stringify({
      argv: [], env: {}, cwd: '/home/user', filename: '/home/user/main.js', dirname: '/home/user',
      stdin: '', captureOutput: true, cred, pid: process.pid,
    }),
  }), { SUPERVISOR: process.supervisor });
  body = await response.json();
} finally {
  await process.close();
}
assert.equal(body.exitCode, 0, JSON.stringify(body));
assert.equal(body.stderr, '');
const seen = JSON.parse(body.stdout);
assert.deepEqual(seen.modes, expected, 'the program stats each path with the mode it was made with');
assert.equal(seen.tempMode, 0o700, "the program stats mkdtemp's directory 0700");
const atSession = (name) => authority.kfs.stat('home/user/' + name).mode & 0o777;
assert.deepEqual(Object.fromEntries(Object.keys(expected).map((name) => [name, atSession(name)])), expected, 'the session holds each path with the mode it was made with');
assert.equal(atSession(seen.temp), 0o700, "the session holds mkdtemp's directory 0700");
realProcess.stdout.write('one-shot-write-mode: PASS\n');
realProcess.exit(0);
