#!/usr/bin/env bun
// fs.open's flags and FileHandle.write answer as Node's do, compared against
// the node on PATH (the oracle) running the same program over the same tree:
//
//   - O_NOFOLLOW: an open of a final symbolic link is ELOOP, in openSync,
//     callback open and promises.open, with O_CREAT and O_DIRECTORY too; a
//     regular file opens as ever, and so does the link without the flag;
//   - O_SYNC (and the 'rs+' alias): accepted, each write made;
//   - FileHandle.write: (string, position, encoding) writes the string in its
//     encoding at the position; (buffer, offset, length, position) and
//     (buffer, { offset, length, position }) write that part there; each
//     answers { bytesWritten, buffer }.
//
// Red before: the shim decoded O_NOFOLLOW and O_SYNC and dropped them, so a
// no-follow open followed the link; FileHandle.write UTF-8-encoded every
// string ('ff' in hex wrote 66 66) and took an options object for the offset.
import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
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

// What exists before the program runs: a file it has not read, a directory, and links to each.
const SEEDED = {
  files: [['seed/a.txt', 'a']],
  dirs: ['seed', 'seed/sub'],
  links: [['seed/link-to-a', 'a.txt'], ['seed/dirlink', 'sub']],
};

// Run by both: `fs` and `root` given; returns what each case did.
const PROGRAM = `async (fs, root) => {
  const path = require('path');
  const P = (p) => path.join(root, p);
  const C = fs.constants;
  const outcome = async (f) => {
    try { const r = await f(); return r === undefined ? 'ok' : r; } catch (e) { return { code: e.code, syscall: e.syscall }; }
  };
  const read = (fd) => { const b = Buffer.alloc(16); const n = fs.readSync(fd, b, 0, 16, 0); fs.closeSync(fd); return b.subarray(0, n).toString(); };
  const results = {};
  results.syncNoFollowLink = await outcome(() => { fs.openSync(P('seed/link-to-a'), C.O_RDONLY | C.O_NOFOLLOW); });
  results.syncNoFollowWriteLink = await outcome(() => { fs.openSync(P('seed/link-to-a'), C.O_WRONLY | C.O_NOFOLLOW); });
  results.syncNoFollowCreateLink = await outcome(() => { fs.openSync(P('seed/link-to-a'), C.O_WRONLY | C.O_CREAT | C.O_NOFOLLOW); });
  results.syncNoFollowDirLink = await outcome(() => { fs.openSync(P('seed/dirlink'), C.O_RDONLY | C.O_DIRECTORY | C.O_NOFOLLOW); });
  results.promisesNoFollowLink = await outcome(async () => { const h = await fs.promises.open(P('seed/link-to-a'), C.O_RDONLY | C.O_NOFOLLOW); await h.close(); });
  results.callbackNoFollowLink = await outcome(() => new Promise((resolve, reject) =>
    fs.open(P('seed/link-to-a'), C.O_RDONLY | C.O_NOFOLLOW, (e, fd) => { if (e) reject(e); else { fs.closeSync(fd); resolve(); } })));
  results.noFollowFile = await outcome(async () => { const h = await fs.promises.open(P('seed/a.txt'), C.O_RDONLY | C.O_NOFOLLOW); const { buffer, bytesRead } = await h.read(Buffer.alloc(16), 0, 16, 0); await h.close(); return buffer.subarray(0, bytesRead).toString(); });
  results.followLink = await outcome(async () => { const h = await fs.promises.open(P('seed/link-to-a'), 'r'); const { buffer, bytesRead } = await h.read(Buffer.alloc(16), 0, 16, 0); await h.close(); return buffer.subarray(0, bytesRead).toString(); });
  results.targetUntouched = await fs.promises.readFile(P('seed/a.txt'), 'utf8');
  results.syncFlag = await outcome(async () => {
    const h = await fs.promises.open(P('own-sync.txt'), C.O_RDWR | C.O_CREAT | C.O_SYNC);
    await h.write('synced');
    await h.close();
    return fs.promises.readFile(P('own-sync.txt'), 'utf8');
  });
  results.rsPlus = await outcome(() => { const fd = fs.openSync(P('own-sync.txt'), 'rs+'); fs.writeSync(fd, 'S', 0); return read(fd); });
  const h = await fs.promises.open(P('hw.bin'), 'w+');
  const w = async (...args) => {
    const r = await h.write(...args);
    return { bytesWritten: r.bytesWritten, buffer: typeof r.buffer === 'string' ? r.buffer : Buffer.from(r.buffer).toString('hex') };
  };
  results.hexWrite = await outcome(() => w('ff', 0, 'hex'));
  results.optionsWrite = await outcome(() => w(Buffer.from('abcdef'), { offset: 1, length: 3, position: 4 }));
  results.positionalWrite = await outcome(() => w(Buffer.from('XY'), 0, 2, 1));
  results.latin1Write = await outcome(() => w('\\u00e9', 8, 'latin1'));
  results.offsetOnlyWrite = await outcome(() => w(Buffer.from('0123'), 2));
  await h.close();
  results.handleBytes = (await fs.promises.readFile(P('hw.bin'))).toString('hex');
  return results;
}`;

// ── the oracle ──
const real = mkdtempSync(join(tmpdir(), 'nimbus-open-flags-'));
let expected;
try {
  for (const d of SEEDED.dirs) mkdirSync(join(real, d), { recursive: true });
  for (const [file, text] of SEEDED.files) writeFileSync(join(real, file), text);
  for (const [link, target] of SEEDED.links) symlinkSync(target, join(real, link));
  const oracle = spawnSync('node', ['-e', `(${PROGRAM})(require('fs'), ${JSON.stringify(real)}).then((r) => console.log(JSON.stringify(r)))`], { encoding: 'utf8' });
  if (oracle.status !== 0) throw new Error(`node: ${oracle.stderr}`);
  expected = JSON.parse(oracle.stdout);
  expected.exit = [0, ''];
} finally {
  rmSync(real, { recursive: true, force: true });
}

// ── the shim, in a one-shot runner over a session's authority ──
const ROOT = '/home/user/flags';
const authority = createAuthority();
const kernel = authority.rawVfs.as(CRED_KERNEL);
const key = (p) => (ROOT + '/' + p).slice(1);
kernel.mkdir(ROOT.slice(1), { recursive: true });
kernel.chown(ROOT.slice(1), 1000, 1000);
for (const d of SEEDED.dirs) { kernel.mkdir(key(d), { recursive: true }); kernel.chown(key(d), 1000, 1000); }
for (const [file, text] of SEEDED.files) { kernel.writeFile(key(file), text); kernel.chown(key(file), 1000, 1000); }
for (const [link, target] of SEEDED.links) kernel.symlink(target, key(link));
const dir = mkdtempSync(join(tmpdir(), 'node-open-flags-matches-node-'));
let actual;
try {
  const program = `(${PROGRAM})(require('fs'), ${JSON.stringify(ROOT)}).then((r) => console.log(JSON.stringify(r)))`;
  const generated = await generateEntrypointCode(program, { bundle: {} }, false, nodeFacetSources(generateShimsCode()));
  const mod = await import(writeModuleSet(join(dir, 'entry'), generatedModuleSet(generated, 'runner.mjs'), 'runner.mjs'));
  const cred = { uid: 1000, gid: 1000, groups: [1000], umask: 0o022 };
  const process = processInstanceSupervisor(authority, cred);
  let body;
  try {
    const response = await mod.default.fetch(new Request('http://facet/', {
      method: 'POST',
      body: JSON.stringify({ argv: [], env: {}, cwd: ROOT, filename: ROOT + '/main.js', dirname: ROOT, stdin: '', captureOutput: true, cred, pid: process.pid }),
    }), { SUPERVISOR: process.supervisor });
    body = await response.json();
  } finally {
    await process.close();
  }
  actual = JSON.parse(body.stdout || '{}');
  actual.exit = [body.exitCode, String(body.stderr ?? '').split(ROOT).join('/ROOT').slice(0, 2000)];
} finally {
  rmSync(dir, { recursive: true, force: true });
}

const differing = Object.keys(expected).filter((k) => JSON.stringify(actual[k]) !== JSON.stringify(expected[k]));
for (const k of differing) realProcess.stderr.write(`${k}\n  node:  ${JSON.stringify(expected[k])}\n  shim:  ${JSON.stringify(actual[k])}\n`);
if (differing.length > 0) {
  realProcess.stderr.write(`node-open-flags-matches-node: ${differing.length} of ${Object.keys(expected).length} answer otherwise than Node's: ${differing.join(', ')}\n`);
  realProcess.exit(1);
}
console.log(`node-open-flags-matches-node: all ${Object.keys(expected).length} answers are Node's`);
