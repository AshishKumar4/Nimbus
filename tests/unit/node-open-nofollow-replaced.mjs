#!/usr/bin/env bun
// An open's O_NOFOLLOW is the session's to judge, in the same change the open
// makes: a peer that replaces the file with a symbolic link after the
// process last looked, before the open's change reaches the session, leaves
// the link's target as it was. Here the peer replaces it just before the
// process's first wave of changes reaches the session.
//
//   - fs.promises.open(leaf, O_WRONLY|O_TRUNC|O_NOFOLLOW) answers ELOOP, as
//     open(2) does for a link already there;
//   - fs.openSync(leaf, O_WRONLY|O_TRUNC|O_NOFOLLOW), answered from the
//     process's own view, logs a change the session refuses: the target
//     keeps its bytes either way.
//
// Red before: O_NOFOLLOW was an lstat before the open, and the truncate (or
// the empty file a sync open wrote) that followed it went to the session as
// a change of the name, which followed the link and emptied its target.
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
import { opSender, supervisorDouble } from './lib/supervisor-double.mjs';

const ROOT = '/home/user/replaced';
const CASES = ['async', 'sync'];
const authority = createAuthority();
const kernel = authority.rawVfs.as(CRED_KERNEL);
const key = (p) => `${ROOT}/${p}`.slice(1);
kernel.mkdir(ROOT.slice(1), { recursive: true });
kernel.chown(ROOT.slice(1), 1000, 1000);
for (const name of CASES) {
  for (const file of [`leaf-${name}`, `precious-${name}`]) {
    kernel.writeFile(key(file), file === `leaf-${name}` ? 'leaf' : 'precious');
    kernel.chown(key(file), 1000, 1000);
  }
}

// The cases run in order, each making the program's next wave: the peer
// replaces that case's leaf just before its wave reaches the session.
const PROGRAM = `(async () => {
  const fs = require('fs');
  const C = fs.constants;
  const outcome = async (f) => { try { await f(); return 'ok'; } catch (e) { return e.code; } };
  const r = {};
  r.async = await outcome(async () => { const h = await fs.promises.open(${JSON.stringify(`${ROOT}/leaf-async`)}, C.O_WRONLY | C.O_TRUNC | C.O_NOFOLLOW); await h.close(); });
  r.sync = await outcome(() => { fs.closeSync(fs.openSync(${JSON.stringify(`${ROOT}/leaf-sync`)}, C.O_WRONLY | C.O_TRUNC | C.O_NOFOLLOW)); });
  console.log(JSON.stringify(r));
})()`;

const cred = { uid: 1000, gid: 1000, groups: [1000], umask: 0o022 };
const { pid } = authority.host.processes.spawn('nofollow-replaced', [], ROOT, { cred });
const send = opSender((envelope) => authority.host.supervisorOp({ ...envelope, pid }));
const replaced = [];
const decoder = new TextDecoder();
const outputs = { stdout: '', stderr: '' };
const supervisor = supervisorDouble((name, args) => {
  if (name === 'stdout' || name === 'stderr') { outputs[name] += decoder.decode(args[0]); return; }
  if (name === 'reportExit') return;
  if (name === 'writeBatchStream' && replaced.length < CASES.length) {
    const which = CASES[replaced.length];
    kernel.unlink(key(`leaf-${which}`));
    kernel.symlink(`precious-${which}`, key(`leaf-${which}`));
    replaced.push(which);
  }
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
      body: JSON.stringify({ argv: [], env: {}, cwd: ROOT, filename: ROOT + '/main.js', dirname: ROOT, stdin: '', captureOutput: true, cred, pid }),
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
const text = (path) => new TextDecoder().decode(kernel.readFile(key(path)));
const seen = {
  replaced,
  answers: said === undefined ? null : JSON.parse(said).async,
  targets: Object.fromEntries(CASES.map((name) => [name, text(`precious-${name}`)])),
};
assert.deepEqual(seen, {
  replaced: CASES,
  answers: 'ELOOP',
  targets: { async: 'precious', sync: 'precious' },
}, `stdout ${body.stdout}\nstderr ${body.stderr}`);
console.log(`node-open-nofollow-replaced: a link put in the open's way is refused, its target kept (sync open: exit ${body.exitCode})`);
