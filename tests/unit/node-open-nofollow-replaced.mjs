#!/usr/bin/env bun
// An open's O_NOFOLLOW is the session's to judge, in the same change the open
// makes: a peer that puts a symbolic link at the name after the process last
// looked, before the open's change reaches the session, leaves the link's
// target as it was. Here the peer acts just before the first wave of the
// process's changes that names the case's file reaches the session.
//
//   - a no-follow open that truncates (O_WRONLY or O_RDONLY, with O_TRUNC) of
//     a file the peer replaces with a link to another: ELOOP from the
//     promise form, as open(2) gives for a link already there; the sync
//     form, answered from the process's own view, logs a change the session
//     refuses; the other file keeps its bytes either way;
//   - a no-follow create (O_RDONLY or O_WRONLY, with O_CREAT) of a name the
//     peer fills with a link to a name that does not exist: no file is made
//     there.
//
// Red before: O_NOFOLLOW was an lstat before the open, and the truncate, or
// the empty file the open wrote, went to the session as a change of the name,
// which followed the link.
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { generateEntrypointCode } from '../../packages/worker/src/facets/manager.ts';
import { generateShimsCode } from '../../packages/worker/src/runtime/node-shims.ts';
import { CRED_KERNEL } from '../../packages/core/src/runtime/os-contracts.ts';
import { decodeWriteBatchStream } from '../../packages/platform/src/w7-frame.ts';
import { nodeFacetSources } from './lib/node-facet-sources.mjs';
import { generatedModuleSet, writeModuleSet } from './lib/module-map-bundle.mjs';
import { createAuthority } from './lib/resident-body.mjs';
import { opSender, supervisorDouble } from './lib/supervisor-double.mjs';

const ROOT = '/home/user/replaced';
// name: [form, flags, what the name holds before the peer acts]
const CASES = {
  asyncTrunc: ['async', 'O_WRONLY | O_TRUNC', 'file'],
  asyncRdonlyTrunc: ['async', 'O_RDONLY | O_TRUNC', 'file'],
  asyncCreate: ['async', 'O_RDONLY | O_CREAT', 'nothing'],
  asyncWriteCreate: ['async', 'O_WRONLY | O_CREAT', 'nothing'],
  syncTrunc: ['sync', 'O_WRONLY | O_TRUNC', 'file'],
  syncRdonlyTrunc: ['sync', 'O_RDONLY | O_TRUNC', 'file'],
  syncCreate: ['sync', 'O_RDONLY | O_CREAT', 'nothing'],
};
const authority = createAuthority();
const kernel = authority.rawVfs.as(CRED_KERNEL);
const key = (p) => `${ROOT}/${p}`.slice(1);
kernel.mkdir(ROOT.slice(1), { recursive: true });
kernel.chown(ROOT.slice(1), 1000, 1000);
for (const [name, [, , before]] of Object.entries(CASES)) {
  if (before !== 'file') continue;
  for (const [file, text] of [[`leaf-${name}`, 'leaf'], [`other-${name}`, 'precious']]) {
    kernel.writeFile(key(file), text);
    kernel.chown(key(file), 1000, 1000);
  }
}

const PROGRAM = `(async () => {
  const fs = require('fs');
  const C = fs.constants;
  const outcome = async (f) => { try { await f(); return 'ok'; } catch (e) { return e.code; } };
  const r = {};
  ${Object.entries(CASES).map(([name, [form, flags]]) => {
    const open = `${JSON.stringify(`${ROOT}/leaf-${name}`)}, ${flags.replace(/O_/g, 'C.O_')} | C.O_NOFOLLOW`;
    return form === 'async'
      ? `r.${name} = await outcome(async () => { const h = await fs.promises.open(${open}); await h.close(); });`
      : `r.${name} = await outcome(() => { fs.closeSync(fs.openSync(${open})); });`;
  }).join('\n  ')}
  console.log(JSON.stringify(r));
})()`;

const cred = { uid: 1000, gid: 1000, groups: [1000], umask: 0o022 };
const { pid } = authority.host.processes.spawn('nofollow-replaced', [], ROOT, { cred });
const send = opSender((envelope) => authority.host.supervisorOp({ ...envelope, pid }));
const replaced = [];
const decoder = new TextDecoder();
const outputs = { stdout: '', stderr: '' };
/** The peer, just before a wave naming a case's file lands: a link at that name, to the case's other file. */
async function peerActs(stream) {
  const [read, sent] = stream.tee();
  const decoded = await decodeWriteBatchStream(read);
  const named = new Set();
  for await (const record of decoded.records) {
    if (record.type === 'file-chunk') record.retention.release();
    if (record.type === 'call') named.add(record.call.path);
    if (record.type === 'file-begin') named.add(record.inode.path);
    if (record.type === 'truncate' || record.type === 'setattr') named.add(record.path);
  }
  for (const name of Object.keys(CASES)) {
    if (replaced.includes(name) || !named.has(key(`leaf-${name}`))) continue;
    if (CASES[name][2] === 'file') await authority.peer.unlink(key(`leaf-${name}`));
    await authority.peer.symlink(`other-${name}`, key(`leaf-${name}`));
    replaced.push(name);
  }
  return sent;
}
const supervisor = supervisorDouble(async (name, args) => {
  if (name === 'stdout' || name === 'stderr') { outputs[name] += decoder.decode(args[0]); return; }
  if (name === 'reportExit') return;
  if (name === 'writeBatchStream') return send(name, [await peerActs(args[0]), ...args.slice(1)]);
  return send(name, args);
});

const dir = mkdtempSync(join(tmpdir(), 'node-open-nofollow-replaced-'));
let body;
try {
  const generated = await generateEntrypointCode(PROGRAM, { bundle: {} }, false, nodeFacetSources(generateShimsCode()));
  const mod = await import(writeModuleSet(join(dir, 'entry'), generatedModuleSet(generated, 'runner.mjs'), 'runner.mjs'));
  try {
    const response = await mod.default.fetch(new Request('http://facet/', {
      method: 'POST',
      body: JSON.stringify({ vfsRoot: authority.root(), argv: [], env: {}, cwd: ROOT, filename: ROOT + '/main.js', dirname: ROOT, stdin: '', captureOutput: true, cred, pid }),
    }), { SUPERVISOR: supervisor });
    body = await response.json();
  } finally {
    authority.host.processes.exit(pid, 0);
    await authority.host.processes.released(pid);
  }
} finally {
  rmSync(dir, { recursive: true, force: true });
}

const said = String(body.stdout ?? '').split('\n').find((line) => line.startsWith('{'));
const answers = said === undefined ? {} : JSON.parse(said);
const other = (name) => {
  const k = key(`other-${name}`);
  return kernel.exists(k) ? new TextDecoder().decode(kernel.readFile(k)) : null;
};
const seen = Object.fromEntries(Object.entries(CASES).map(([name, [form, , before]]) => [name, {
  replaced: replaced.includes(name),
  ...(form === 'async' ? { answer: answers[name] } : {}),
  other: other(name),
  expected: before === 'file' ? 'precious' : null,
}]));
for (const [name, case_] of Object.entries(seen)) {
  assert.deepEqual(case_, { replaced: true, ...(CASES[name][0] === 'async' ? { answer: 'ELOOP' } : {}), other: case_.expected, expected: case_.expected },
    `${name}: ${JSON.stringify(case_)}\nstdout ${body.stdout}\nstderr ${body.stderr}`);
}
console.log(`node-open-nofollow-replaced: ${Object.keys(CASES).length} links put in an open's way are refused, nothing followed (exit ${body.exitCode})`);
