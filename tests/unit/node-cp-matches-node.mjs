#!/usr/bin/env bun
// fs.cpSync, fs.promises.cp and fs.cp answer as Node's do, compared against
// the node on PATH (the oracle, v22.23.4) running the same program over the
// same tree.
//
// Red before: the shim had two cp walkers of its own. promises.cp told a file
// from a directory by whether it held the file's bytes (a file it had not read
// was taken for a directory), ignored filter, force, errorOnExist,
// dereference, verbatimSymlinks, preserveTimestamps and mode, and copied a
// link as the file it names. cpSync refused errorOnExist under the default
// force, where Node overwrites. Neither made directories with Node's modes,
// and neither copied a link (there was no symlinkSync or readlinkSync). A
// copy into itself did not end.
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync, chmodSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { generateEntrypointCode } from '../../packages/worker/src/facets/manager.ts';
import { generateShimsCode } from '../../packages/worker/src/runtime/node-shims.ts';
import { CRED_KERNEL } from '../../packages/core/src/runtime/os-contracts.ts';
import { nodeFacetSources } from './lib/node-facet-sources.mjs';
import { generatedModuleSet, writeModuleSet } from './lib/module-map-bundle.mjs';
import { createAuthority } from './lib/resident-body.mjs';
import { processInstanceSupervisor } from './lib/process-instance-supervisor.mjs';

// The runner puts a program's process in front of the realm's: the test keeps its own.
const realProcess = globalThis.process;

// What exists before the program runs: files it has not read (the shim holds
// no bytes for them), a directory with a mode of its own, a link.
const SEEDED = {
  files: [['seed/a.txt', 'a', 0o644], ['seed/sub/b.txt', 'b', 0o600], ['seed/run.sh', '#!/bin/sh\n', 0o755]],
  dirs: [['seed', 0o750], ['seed/sub', 0o700]],
  links: [['seed/link-to-a', 'a.txt'], ['seed/abs-link', '/ROOT/seed/sub']],
};

// Run by both: `fs` and `root` given; returns what each case did and left.
const PROGRAM = `async (fs, root) => {
  const path = require('path');
  const P = (p) => path.join(root, p);
  process.umask(0o022);
  const norm = (s) => String(s).split(root).join('/ROOT');
  // Read as a program reads what another made: through the async forms.
  const tree = async (dir) => {
    const out = {};
    const walk = async (rel) => {
      const at = rel ? P(dir + '/' + rel) : P(dir);
      let st;
      try { st = await fs.promises.lstat(at); } catch (e) { out[rel || '.'] = 'absent'; return; }
      const mode = (st.mode & 0o7777).toString(8);
      if (st.isSymbolicLink()) { out[rel || '.'] = ['link', norm(await fs.promises.readlink(at))]; return; }
      if (st.isDirectory()) {
        out[rel || '.'] = ['dir', mode];
        for (const name of (await fs.promises.readdir(at)).sort()) await walk(rel ? rel + '/' + name : name);
        return;
      }
      out[rel || '.'] = ['file', mode, await fs.promises.readFile(at, 'utf8')];
    };
    await walk('');
    return out;
  };
  const outcome = (e) => e === undefined ? 'ok' : { name: e.name, code: e.code, message: norm(e.message) };
  const forms = {
    sync: async (src, dest, opts) => fs.cpSync(src, dest, opts),
    promises: (src, dest, opts) => fs.promises.cp(src, dest, opts),
    callback: (src, dest, opts) => new Promise((resolve, reject) => fs.cp(src, dest, opts ?? {}, (e) => (e ? reject(e) : resolve()))),
  };
  // Made by the program: bytes it holds.
  fs.mkdirSync(P('own/deep'), { recursive: true });
  fs.writeFileSync(P('own/x.txt'), 'x');
  fs.writeFileSync(P('own/deep/y.txt'), 'y');
  fs.chmodSync(P('own/deep'), 0o711);
  const results = {};
  for (const [form, cp] of Object.entries(forms)) {
    const out = (name) => P('out/' + form + '/' + name);
    fs.mkdirSync(P('out/' + form), { recursive: true });
    const cases = [
      ['file-unread', () => cp(P('seed/a.txt'), out('a.txt'))],
      ['file-onto-file-default', async () => { fs.writeFileSync(out('d.txt'), 'old'); await cp(P('seed/a.txt'), out('d.txt'), { errorOnExist: true }); }],
      ['file-onto-file-noforce', async () => { fs.writeFileSync(out('n.txt'), 'old'); await cp(P('seed/a.txt'), out('n.txt'), { force: false }); }],
      ['file-onto-file-noforce-error', async () => { fs.writeFileSync(out('e.txt'), 'old'); await cp(P('seed/a.txt'), out('e.txt'), { force: false, errorOnExist: true }); }],
      ['dir-not-recursive', () => cp(P('seed'), out('nr'))],
      ['dir-recursive-unread', () => cp(P('seed'), out('tree'), { recursive: true })],
      ['dir-recursive-own', () => cp(P('own'), out('own'), { recursive: true })],
      ['dir-filter', () => cp(P('seed'), out('filtered'), { recursive: true, filter: (src) => !src.endsWith('b.txt') })],
      ['dir-dereference', () => cp(P('seed'), out('deref'), { recursive: true, dereference: true })],
      ['dir-verbatim', () => cp(P('seed'), out('verbatim'), { recursive: true, verbatimSymlinks: true })],
      ['link-at-top', () => cp(P('seed/link-to-a'), out('top-link'))],
      ['same-path', () => cp(P('seed/a.txt'), P('seed/a.txt'))],
      ['into-itself', () => cp(P('seed'), P('seed/sub/inner'), { recursive: true })],
      ['dir-onto-file', async () => { fs.writeFileSync(out('plain'), 'p'); await cp(P('seed'), out('plain'), { recursive: true }); }],
      ['file-onto-dir', async () => { fs.mkdirSync(out('adir')); await cp(P('seed/a.txt'), out('adir')); }],
      ['missing-source', () => cp(P('seed/nope'), out('nope'))],
      ['bad-option', () => cp(P('seed/a.txt'), out('bad'), { force: 'yes' })],
      ['dir-onto-dir-noforce-error', async () => {
        // One file there, so which one refuses first is not the directory's order.
        await cp(P('seed/sub'), out('twice'), { recursive: true });
        await cp(P('seed/sub'), out('twice'), { recursive: true, force: false, errorOnExist: true });
      }],
      ['dir-onto-dir-noforce', async () => {
        await cp(P('own'), out('again'), { recursive: true });
        fs.writeFileSync(P('own/x.txt'), 'x2');
        fs.writeFileSync(P('own/deep/y.txt'), 'y2');
        await cp(P('own'), out('again'), { recursive: true, force: false });
        fs.writeFileSync(P('own/x.txt'), 'x');
        fs.writeFileSync(P('own/deep/y.txt'), 'y');
      }],

    ];
    if (form !== 'sync') cases.push(['async-filter', () => cp(P('seed'), out('afilter'), { recursive: true, filter: async (src) => !src.endsWith('run.sh') })]);
    for (const [name, run] of cases) {
      let error;
      try { await run(); } catch (e) { error = e; }
      results[form + ':' + name] = outcome(error);
    }
    results[form + ':tree'] = await tree('out/' + form);
  }
  // A link the session lists, renamed, then read and copied by its new name.
  fs.renameSync(P('seed/link-to-a'), P('seed/link-moved'));
  results.renamedLink = [fs.readlinkSync(P('seed/link-moved')), (fs.cpSync(P('seed/link-moved'), P('out/moved-link-copy'), { verbatimSymlinks: true }), fs.readlinkSync(P('out/moved-link-copy')))];
  fs.renameSync(P('seed/link-moved'), P('seed/link-to-a'));
  // A link made and read by the sync forms.
  const attempt = (fn) => { try { return fn(); } catch (e) { return outcome(e); } };
  // Paths given as bytes, which the sync form's bindings take as Node's do.
  // (The async forms refuse them in node:path's resolve, whose message is the
  // platform path module's; a separate gap.)
  results.bufferPaths = attempt(() => { fs.cpSync(Buffer.from(P('seed/a.txt')), Buffer.from(P('out/buffered.txt'))); return fs.readFileSync(P('out/buffered.txt'), 'utf8'); });
  results.symlinkSync = attempt(() => { fs.symlinkSync('own/x.txt', P('out/made-link')); return fs.readlinkSync(P('out/made-link')); });
  results.symlinkSyncExists = attempt(() => fs.symlinkSync('x', P('out/made-link')));
  results.readlinkSyncNotLink = attempt(() => fs.readlinkSync(P('own/x.txt')));
  results.readlinkSyncMissing = attempt(() => fs.readlinkSync(P('own/nope')));
  results.readlinkSyncBuffer = attempt(() => fs.readlinkSync(P('out/made-link'), 'buffer').toString('hex'));
  // preserveTimestamps: the copy has the source's times.
  const old = new Date('2001-02-03T04:05:06Z');
  fs.utimesSync(P('own/x.txt'), old, old);
  fs.cpSync(P('own/x.txt'), P('out/ts-sync.txt'), { preserveTimestamps: true });
  await fs.promises.cp(P('own/x.txt'), P('out/ts-promises.txt'), { preserveTimestamps: true });
  results.timestamps = [];
  for (const n of ['ts-sync.txt', 'ts-promises.txt']) results.timestamps.push((await fs.promises.stat(P('out/' + n))).mtimeMs === old.getTime());
  return results;
}`;

// ── the oracle ──
const real = mkdtempSync(join(tmpdir(), 'nimbus-cp-'));
let expected;
try {
  for (const [dir, mode] of SEEDED.dirs) mkdirSync(join(real, dir), { recursive: true, mode });
  for (const [file, text, mode] of SEEDED.files) { writeFileSync(join(real, file), text); chmodSync(join(real, file), mode); }
  for (const [dir, mode] of SEEDED.dirs) chmodSync(join(real, dir), mode);
  for (const [link, target] of SEEDED.links) symlinkSync(target.replace('/ROOT', real), join(real, link));
  const oracle = spawnSync('node', ['-e', `(${PROGRAM})(require('fs'), ${JSON.stringify(real)}).then((r) => console.log(JSON.stringify(r)))`], { encoding: 'utf8' });
  assert.equal(oracle.status, 0, `node: ${oracle.stderr}`);
  expected = JSON.parse(oracle.stdout);
  expected.exit = [0, ''];
} finally {
  rmSync(real, { recursive: true, force: true });
}

// ── the shim, in a one-shot runner over a session's authority ──
const ROOT = '/home/user/cp';
const authority = createAuthority();
const kernel = authority.rawVfs.as(CRED_KERNEL);
const key = (p) => (ROOT + '/' + p).slice(1);
kernel.mkdir(ROOT.slice(1), { recursive: true });
kernel.chown(ROOT.slice(1), 1000, 1000);
for (const [dir] of SEEDED.dirs) { kernel.mkdir(key(dir), { recursive: true }); kernel.chown(key(dir), 1000, 1000); }
for (const [file, text, mode] of SEEDED.files) { kernel.writeFile(key(file), text); kernel.chown(key(file), 1000, 1000); kernel.chmod(key(file), mode); }
for (const [dir, mode] of SEEDED.dirs) kernel.chmod(key(dir), mode);
for (const [link, target] of SEEDED.links) kernel.symlink(target.replace('/ROOT', ROOT), key(link));
const dir = mkdtempSync(join(tmpdir(), 'node-cp-matches-node-'));
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
for (const k of differing) realProcess.stderr.write(`${k}\n  node:  ${JSON.stringify(expected[k]).slice(0, 600)}\n  shim:  ${JSON.stringify(actual[k]).slice(0, 600)}\n`);
if (differing.length > 0) {
  realProcess.stderr.write(`node-cp-matches-node: ${differing.length} of ${Object.keys(expected).length} answer otherwise than Node's: ${differing.join(', ')}\n`);
  realProcess.exit(1);
}
console.log(`node-cp-matches-node: ok (${Object.keys(expected).length} results)`);
realProcess.exit(0);
