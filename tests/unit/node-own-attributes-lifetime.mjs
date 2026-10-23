#!/usr/bin/env bun
// What a program sets on a path (its mode by chmod, its times by utimes) is
// what stat answers until the filesystem says otherwise, as on Linux:
// - after the change has landed, a later change by someone else shows;
// - a path removed and made again is a new file, with a new file's mode and
//   times;
// - a renamed file keeps the mode and times set on it, under its new name,
//   and its old name, made again, is a new file.
// Runs the real generated one-shot module. Red before: the shim kept each
// mode and time it set for the rest of the run, over everything after it.
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
const dir = mkdtempSync(join(tmpdir(), 'node-own-attributes-'));
realProcess.on('exit', () => rmSync(dir, { recursive: true, force: true }));
const cred = { uid: 1000, gid: 1000, groups: [1000], umask: 0o022 };
const authority = createAuthority();
authority.kfs.writeFile('home/user/shared.txt', 'shared');

// Another principal changes shared.txt's mode once the program's own chmod
// has landed, at the program's next call into the session. A peer's change
// waits for the read lease of a process reading the file to be recalled
// (withRecall), as a peer's does; the raw kernel handle does not wait.
const serve = authority.host.supervisorOp.bind(authority.host);
const peer = authority.peerAs(CRED_KERNEL);
const peerOutcome = [];
let armed = false;
authority.host.supervisorOp = async (envelope) => {
  if (armed && envelope.op !== 'writeBatchStream') {
    armed = false;
    await peer.chmod('home/user/shared.txt', 0o640).then(() => peerOutcome.push('ok'), (error) => peerOutcome.push(error.code ?? String(error)));
  }
  const answer = await serve(envelope);
  if (envelope.op === 'writeBatchStream' && peerOutcome.length === 0) armed = true;
  return answer;
};

const program = `
const fs = require('fs');
const mode = (p) => (fs.statSync(p).mode & 0o7777).toString(8);
(async () => {
  const seen = {};
  // Landed, then changed by another.
  await fs.promises.chmod('/home/user/shared.txt', 0o600);
  seen.ownMode = mode('/home/user/shared.txt');
  await fs.promises.readlink('/home/user/peer-chmod').catch(() => {});
  await fs.promises.stat('/home/user');
  await fs.promises.stat('/home/user');
  seen.peerMode = mode('/home/user/shared.txt');

  // Removed and made again.
  fs.writeFileSync('/home/user/again.txt', 'one');
  fs.chmodSync('/home/user/again.txt', 0o600);
  fs.utimesSync('/home/user/again.txt', 1, 1);
  fs.unlinkSync('/home/user/again.txt');
  fs.writeFileSync('/home/user/again.txt', 'two');
  const again = fs.statSync('/home/user/again.txt');
  seen.againMode = (again.mode & 0o7777).toString(8);
  seen.againRecent = Date.now() - again.mtimeMs < 60000;

  // A directory removed with what was set beneath it.
  fs.mkdirSync('/home/user/tree');
  fs.writeFileSync('/home/user/tree/leaf.txt', 'leaf');
  fs.chmodSync('/home/user/tree/leaf.txt', 0o600);
  fs.rmSync('/home/user/tree', { recursive: true });
  fs.mkdirSync('/home/user/tree');
  fs.writeFileSync('/home/user/tree/leaf.txt', 'leaf');
  seen.treeMode = mode('/home/user/tree/leaf.txt');

  // Renamed.
  fs.writeFileSync('/home/user/from.txt', 'moved');
  fs.chmodSync('/home/user/from.txt', 0o600);
  fs.utimesSync('/home/user/from.txt', 2, 2);
  fs.renameSync('/home/user/from.txt', '/home/user/to.txt');
  const moved = fs.statSync('/home/user/to.txt');
  seen.movedMode = (moved.mode & 0o7777).toString(8);
  seen.movedMtime = moved.mtimeMs;
  fs.writeFileSync('/home/user/from.txt', 'new');
  seen.fromMode = mode('/home/user/from.txt');
  console.log(JSON.stringify(seen));
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
assert.deepEqual(peerOutcome, ['ok'], 'the peer\'s change was made');
assert.equal(authority.rawVfs.as(CRED_KERNEL).stat('home/user/shared.txt').mode & 0o777, 0o640, 'the session holds the peer\'s change');
assert.equal(seen.ownMode, '600', 'its own chmod shows at once');
assert.equal(seen.peerMode, '640', "a later change by another shows once the program's own has landed");
assert.deepEqual([seen.againMode, seen.againRecent], ['644', true], 'a file removed and made again has a new file\'s mode and times');
assert.equal(seen.treeMode, '644', 'and so has one under a directory removed and made again');
assert.deepEqual([seen.movedMode, seen.movedMtime], ['600', 2000], 'a renamed file keeps its mode and times under its new name');
assert.equal(seen.fromMode, '644', 'and its old name, made again, is a new file');
realProcess.stdout.write('node-own-attributes-lifetime: PASS\n');
realProcess.exit(0);
