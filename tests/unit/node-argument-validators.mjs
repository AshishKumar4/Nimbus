#!/usr/bin/env bun
// Node's argument validators, one module both Node fronts take
// (core/_shared/node-arguments.ts): what each refuses, and with what, is
// host Node 22's, in the guest's shims (the hosted node) and in the shell's
// built-in node alike:
//
//   - process.umask: an octal string of digits alone, or a uint32, its
//     permission bits kept; '022garbage' and '0x12' are not octal strings,
//     '40000000000' (2 ** 32) is out of range, as are -1, 1.5 and 2 ** 32;
//   - fs.openSync's flags: Node's flag strings ('xw' creates, exclusively),
//     or an int32 of bits; any other string is refused;
//   - a mode argument (fs.chmodSync, fs.mkdirSync): the same as umask's.
//
// Red before: the hosted umask and modes took parseInt's prefix
// (umask('022garbage') set 022, '40000000000' wrapped to 0), its open took
// 'xw' for a read and any string for one; the shell's node's messages quoted
// a string as JSON does, not as Node's inspect does.

import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { generateShimsCode } from '../../packages/worker/src/runtime/node-shims.ts';
import { NimbusWorkspace } from '../../packages/core/src/workspace/nimbus-workspace.ts';
import { SHIMS_STORE_PRELUDE, SHIMS_STORE_START, listAuthority } from './lib/shims-namespace.mjs';
import { createAuthority, facetSupervisor } from './lib/resident-body.mjs';
import { hostSqlite } from './lib/host-sqlite.mjs';

// Each case: a body run with `process` and `fs` in scope, in a fresh directory
// holding `f`; it prints one line of what it saw.
const CASES = {
  umaskStrings: `const seen = []; for (const bad of ['022garbage', '0x12', '8', '', '40000000000']) { try { process.umask(bad); seen.push('took ' + bad); } catch (e) { seen.push(e.code + ' ' + e.message); } } seen.push('mask ' + process.umask().toString(8)); console.log(seen.join(' | '))`,
  umaskNumbers: `const seen = []; for (const bad of [-1, 1.5, 2 ** 32, null, {}]) { try { process.umask(bad); seen.push('took ' + bad); } catch (e) { seen.push(e.code + ' ' + e.message); } } seen.push('mask ' + process.umask().toString(8)); console.log(seen.join(' | '))`,
  umaskTakes: `console.log([process.umask('077'), process.umask(0o1022), process.umask()].map((m) => m.toString(8)).join(' '))`,
  openFlags: `const seen = []; for (const flags of ['bogus', 'rw', 'xr', 1.5, 2 ** 31]) { try { fs.openSync('f', flags); seen.push('took ' + flags); } catch (e) { seen.push(e.code + ' ' + e.message); } } console.log(seen.join(' | '))`,
  openXw: `const fd = fs.openSync('made', 'xw'); fs.writeSync(fd, 'x'); fs.closeSync(fd); let again; try { fs.openSync('made', 'xw'); again = 'opened'; } catch (e) { again = e.code; } console.log(fs.readFileSync('made', 'utf8'), again)`,
  // A creation's mode, null or absent, is Node's default (0o666, a directory's 0o777); chmod has none.
  nullModes: `const seen = []; for (const [what, run] of [['writeFile', () => fs.writeFileSync('w', 'x', { mode: null })], ['appendFile', () => fs.appendFileSync('a', 'x', { mode: null })], ['open', () => fs.closeSync(fs.openSync('o', 'w', null))], ['mkdir', () => fs.mkdirSync('d', { mode: null })], ['chmod', () => fs.chmodSync('f', null)]]) { try { run(); seen.push(what + ' ok'); } catch (e) { seen.push(what + ' ' + e.code); } } for (const name of ['w', 'a', 'o']) seen.push(name + ' ' + (fs.statSync(name).mode & 0o777).toString(8)); seen.push('d ' + fs.existsSync('d')); console.log(seen.join(' | '))`,
  // An async case leaves its promise in globalThis.settled, which a front that runs the case to its end awaits.
  nullModePromise: `globalThis.settled = fs.promises.writeFile('p', 'x', { mode: null }).then(() => console.log('p', (fs.statSync('p').mode & 0o777).toString(8)), (e) => console.log('p', e.code))`,
  modes: `const seen = []; for (const bad of ['7a5', '0o755', -1]) { try { fs.chmodSync('f', bad); seen.push('took ' + bad); } catch (e) { seen.push(e.code + ' ' + e.message); } } fs.chmodSync('f', '640'); seen.push((fs.statSync('f').mode & 0o777).toString(8)); console.log(seen.join(' | '))`,
};

/** host Node's line for each case. */
const host = Object.fromEntries(Object.entries(CASES).map(([name, body]) => {
  const dir = mkdtempSync(join(tmpdir(), 'node-arguments-'));
  try {
    writeFileSync(join(dir, 'f'), 'x\n', { mode: 0o644 });
    const r = spawnSync(process.env.NODE_BIN ?? 'node', ['-e', `const fs = require('fs'); process.umask(0o022); ${body}`], { cwd: dir, encoding: 'utf8' });
    assert.equal(r.status, 0, `host node: ${name}: ${r.stderr}`);
    return [name, r.stdout];
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}));

const failures = [];
const compare = (front, name, line) => {
  if (line !== host[name]) failures.push(`${front} ${name}\n  node: ${host[name]}  ours: ${line}`);
};

// The guest's shims, as the hosted node runs a program, over a session holding `f`.
for (const name of Object.keys(CASES)) {
  let out = '';
  const factory = new Function(
    '__vfsBundle', '__vfsDirs', '__supervisor', 'cred', 'cwd', 'argv', 'env', 'filename', 'dirname',
    '"use strict"; let stdout = ""; let stderr = ""; let exitCode = 0; const __pendingIO = [];' +
      SHIMS_STORE_PRELUDE + generateShimsCode() + SHIMS_STORE_START +
      '\n;return { fs: __fsMod, process: __processMod };',
  );
  const authority = createAuthority();
  authority.kfs.writeFile('home/user/f', 'x\n', { mode: 0o644 });
  const { supervisor } = facetSupervisor(authority);
  listAuthority(authority.rawVfs);
  const shim = factory({}, {}, supervisor,
    { uid: 1000, gid: 1000, groups: [1000], umask: 0o022 }, '/home/user', [], {}, '/home/user/main.js', '/home/user');
  const console = { log: (...parts) => { out += `${parts.join(' ')}\n`; } };
  try {
    new Function('process', 'fs', 'console', CASES[name])(shim.process, shim.fs, console);
    await globalThis.settled;
    delete globalThis.settled;
  } catch (error) {
    out = `threw ${error?.code ?? ''} ${error?.message ?? error}\n`;
  }
  compare('hosted', name, out);
}

// The shell's built-in node.
const { sql, transactions } = await hostSqlite();
const ws = await NimbusWorkspace.create({ sql, transactions, generation: 1 });
try {
  for (const [name, body] of Object.entries(CASES)) {
    const dir = `/home/user/${name}`;
    await ws.exec(`mkdir ${dir} && echo x > ${dir}/f && chmod 644 ${dir}/f`, { cwd: '/home/user' });
    await ws.fs.writeFile(`${dir}/case.js`, `const fs = require('fs'); ${body}\n`);
    const r = await ws.exec('node case.js', { cwd: dir });
    compare('lifo', name, r.exitCode === 0 ? r.stdout : `exit ${r.exitCode} ${r.stderr}`);
  }
} finally {
  await ws.close();
}
assert.deepEqual(failures, [], `as host node:\n${failures.join('\n')}`);
console.log('node-argument-validators: ok');
