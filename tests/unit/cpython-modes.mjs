#!/usr/bin/env bun
/**
 * cpython-modes — CPython in Nimbus reports and changes file modes as host
 * Python does, through the Nimbus filesystem extension (wasm/nimbus-libc,
 * nimbus_fs): the same script, run by python.wasm through the runner's
 * preamble over a session filesystem and by the host's python3 in a
 * temporary directory holding the same files, prints the same thing:
 *
 *   - os.stat's st_mode (type and permission bits) of an executable, a
 *     private file, a directory, and through a link; os.lstat's of the link;
 *   - st_uid and st_gid equal to os.getuid() and os.getgid();
 *   - os.chmod changes the mode (it changed nothing before: a no-op on WASI);
 *   - os.access(X_OK) as the mode says, and os.scandir's entries' stat.
 */

import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { buildCPythonPreamble } from '../../packages/core/src/runtime/cpython-runner.ts';
import { makeSession } from './lib/wasi-authority.mjs';

const RUNTIME_DIR = path.join(import.meta.dir ?? path.dirname(new URL(import.meta.url).pathname), '../../packages/worker/wasm/python');
const WASM = path.join(RUNTIME_DIR, 'python.wasm');
const STDLIB = path.join(RUNTIME_DIR, 'python313.zip');
if (!existsSync(WASM) || !existsSync(STDLIB)) {
  console.log('cpython-modes: SKIPPED (python.wasm not built)');
  process.exit(0);
}

const SCRIPT = `
import json, os, stat
os.chdir(os.environ['WORKDIR'])
out = {}
for name in ['tool.sh', 'private.txt', 'dir', 'link']:
    out['stat ' + name] = oct(os.stat(name).st_mode)
out['lstat link'] = oct(os.lstat('link').st_mode)
out['link is a link'] = stat.S_ISLNK(os.lstat('link').st_mode)
st = os.stat('tool.sh')
out['owned by me'] = (st.st_uid == os.getuid(), st.st_gid == os.getgid())
out['x tool.sh'] = os.access('tool.sh', os.X_OK)
out['x private.txt'] = os.access('private.txt', os.X_OK)
os.chmod('private.txt', 0o604)
out['after chmod'] = oct(os.stat('private.txt').st_mode)
os.chmod('tool.sh', 0o644)
out['after chmod -x'] = oct(os.stat('tool.sh').st_mode)
with os.scandir('.') as it:
    out['scandir'] = sorted((e.name, oct(e.stat(follow_symlinks=False).st_mode)) for e in it)
print(json.dumps(out, sort_keys=True))
`;

// The host: the same files, the same modes, in a directory of its own.
const hostDir = mkdtempSync(path.join(process.env.TMPDIR || os.tmpdir(), 'cpython-modes-'));
let expected;
try {
  writeFileSync(path.join(hostDir, 'tool.sh'), '#!/bin/sh\n'); chmodSync(path.join(hostDir, 'tool.sh'), 0o755);
  writeFileSync(path.join(hostDir, 'private.txt'), 'secret'); chmodSync(path.join(hostDir, 'private.txt'), 0o640);
  mkdirSync(path.join(hostDir, 'dir')); chmodSync(path.join(hostDir, 'dir'), 0o750);
  symlinkSync('tool.sh', path.join(hostDir, 'link'));
  expected = JSON.parse(execFileSync('python3', ['-c', SCRIPT], { cwd: hostDir, env: { ...process.env, WORKDIR: hostDir } }).toString());
} finally {
  rmSync(hostDir, { recursive: true, force: true });
}

// Nimbus: python.wasm through the runner's composed preamble.
const modPath = path.join(os.tmpdir(), `cpython-modes-${process.pid}.mjs`);
writeFileSync(modPath, `${buildCPythonPreamble()}\nexport const ready = true;\n`);
try {
  globalThis.__NIMBUS_WASM = { 'python.wasm': new WebAssembly.Module(readFileSync(WASM)) };
  await import(pathToFileURL(modPath).href);
} finally {
  rmSync(modPath, { force: true });
}
const session = makeSession({
  dirs: ['opt/py/lib/python3.13/lib-dynload', 'home/user/work/dir'],
  files: {
    'opt/py/lib/python313.zip': readFileSync(STDLIB),
    'opt/py/lib/python3.13/os.py': '# stdlib marker\n',
    'home/user/work/tool.sh': '#!/bin/sh\n',
    'home/user/work/private.txt': 'secret',
  },
  symlinks: { 'home/user/work/link': 'tool.sh' },
});
session.root.chmod('home/user/work/tool.sh', 0o755);
session.root.chmod('home/user/work/private.txt', 0o640);
session.root.chmod('home/user/work/dir', 0o750);
globalThis.__nimbusPySupervisor = session.supervisor;
const result = await globalThis.__cpythonRun({
  pythonHome: '/opt/py',
  userEnv: { HOME: '/home/user', PYTHONUNBUFFERED: '1', WORKDIR: '/home/user/work' },
  progName: 'python',
  cwd: '/home/user/work',
  cred: { uid: session.cred.uid, gid: session.cred.gid, groups: [...session.cred.groups] },
  pyArgv: ['-c'],
  userCode: SCRIPT,
});
assert.equal(result.exitCode, 0, `${result.error ?? ''}\n${result.stderr}`);
const got = JSON.parse(result.stdout.trim().split('\n').at(-1));
for (const key of Object.keys(expected)) assert.deepEqual(got[key], expected[key], `${key}: nimbus ${JSON.stringify(got[key])}, host ${JSON.stringify(expected[key])}`);
assert.equal(session.root.stat('home/user/work/private.txt').mode & 0o7777, 0o604, 'os.chmod reached the session');
await session.dispose();
console.log(`cpython-modes: ${Object.keys(expected).length} answers as host Python's`);
