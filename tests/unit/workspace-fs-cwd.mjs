#!/usr/bin/env bun
// `ws.fs` takes a relative path from a working directory of its own, as a
// process does: the one the workspace's shell starts in (create's `cwd`,
// else HOME). On 0.14.0 a workspace created with cwd /home/user answered
// `ws.fs.readFile('a.txt')` with ENOENT while /home/user/a.txt existed:
// the view read every relative path from `/`, so each embedder wrote its
// own resolver. A `cd` in the shell is the shell's, and does not move it.
//
// The root-relative view is unchanged, and is a different type: Nimbus's
// own code hands a ProcessView keys such as 'etc/passwd' that mean
// /etc/passwd from anywhere, and the compiler keeps the two apart.
import assert from 'node:assert/strict';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import ts from 'typescript';
import { NimbusWorkspace } from '../../packages/core/src/workspace/nimbus-workspace.ts';
import { WorkspaceFs } from '../../packages/core/src/workspace/workspace-fs.ts';
import { CRED_KERNEL } from '../../packages/core/src/runtime/os-contracts.ts';
import { SqliteVFS } from '../../packages/core/src/vfs/sqlite-vfs.ts';
import { createSqliteVfsTestHarness } from './sqlite-vfs-test-harness.mjs';

const code = (run) => Promise.resolve().then(run).then(() => 'ok', (error) => error.code);
const text = (bytes) => new TextDecoder().decode(bytes);
const names = async (fs, path) => (await fs.readdir(path)).map((entry) => entry.name).sort();

async function workspace(options = {}) {
  const harness = createSqliteVfsTestHarness();
  const engine = new SqliteVFS(harness.sql, harness.ctx);
  const ws = await NimbusWorkspace.create({ sql: harness.sql, transactions: harness.ctx, vfs: engine, ...options });
  return { ws, root: engine.as(CRED_KERNEL) };
}

// ── Kinu's measured case, and where the view starts ─────────────────────
{
  const { ws } = await workspace({ cwd: '/home/user' });
  await ws.exec('printf A > /home/user/a.txt');
  assert.equal(text(await ws.fs.readFile('a.txt')), 'A', 'a relative path is taken from the workspace cwd');
  assert.equal(ws.fs.cwd, '/home/user');
  await ws.close();
}
{
  const { ws } = await workspace();
  assert.equal(ws.fs.cwd, '/home/user', 'without a cwd, the view starts in HOME');
  await ws.close();
}
{
  const { ws, root } = await workspace({ env: { HOME: '/tmp/home' } });
  assert.equal(ws.fs.cwd, '/tmp/home', 'a configured HOME is where the view starts');
  root.mkdir('tmp/home', { recursive: true });
  root.writeFile('tmp/home/h.txt', 'H');
  assert.equal(await ws.fs.readFileString('h.txt'), 'H');
  await ws.close();
}
{
  const { ws, root } = await workspace({ cwd: '/srv/app', env: { HOME: '/tmp/home' } });
  assert.equal(ws.fs.cwd, '/srv/app', 'create\'s cwd wins over HOME');
  root.mkdir('srv/app', { recursive: true });
  root.chown('srv/app', 1000, 1000);
  await ws.fs.writeFile('made.txt', 'M');
  assert.equal(text(root.readFile('srv/app/made.txt')), 'M', 'a write lands in the view\'s cwd');
  await ws.close();
}

// ── Every operation, by relative paths ───────────────────────────────────
const { ws, root } = await workspace({ cwd: '/home/user' });
await ws.fs.writeFile('/home/user/a.txt', 'A');
await ws.fs.writeFile('/home/user/sib.txt', 'home sibling');

assert.equal(text(await ws.fs.readFile('./a.txt')), 'A', './x');
assert.ok((await names(ws.fs, '.')).includes('a.txt'), '. is the cwd');
assert.ok((await names(ws.fs, '..')).includes('user'), '.. is its parent');
assert.equal(text(await ws.fs.readFile('../user/a.txt')), 'A');

await ws.fs.mkdir('d/e', { recursive: true });
await ws.fs.writeFile('d/e/w.txt', 'written');
assert.equal((await ws.fs.stat('d/e/w.txt')).size, 7, 'stat');
assert.equal(await ws.fs.isDirectory('d/e'), true);
await ws.fs.rename('d/e/w.txt', 'd/w2.txt');
assert.deepEqual(await names(ws.fs, 'd'), ['e', 'w2.txt'], 'readdir and rename');
assert.equal((await ws.exec('cat /home/user/d/w2.txt')).stdout, 'written', 'the shell sees the same file at the absolute path');
await ws.fs.appendFile('d/w2.txt', '+');
await ws.fs.copy('d/w2.txt', 'd/copy.txt');
assert.equal(await ws.fs.readFileString('d/copy.txt'), 'written+');
await ws.fs.unlink('d/copy.txt');
await ws.fs.rmdir('d/e');
assert.deepEqual(await names(ws.fs, 'd'), ['w2.txt']);
await ws.fs.remove('d', { recursive: true });
assert.equal(await ws.fs.exists('d'), false);

// A symlinked directory: a path through it goes where the link leads, and
// `..` after it is the link target's parent, as the kernel takes it.
await ws.fs.mkdir('/tmp/data/real', { recursive: true });
await ws.fs.writeFile('/tmp/data/sib.txt', 'data sibling');
await ws.fs.symlink('/tmp/data/real', 'link');
await ws.fs.writeFile('link/f.txt', 'F');
assert.equal(text(root.readFile('tmp/data/real/f.txt')), 'F', 'a write through a linked directory');
assert.equal(text(await ws.fs.readFile('link/f.txt')), 'F');
assert.deepEqual(await names(ws.fs, 'link'), ['f.txt']);
assert.equal(await ws.fs.realpath('link/f.txt'), '/tmp/data/real/f.txt');
assert.equal(await ws.fs.readFileString('link/../sib.txt'), 'data sibling', '.. after a link is the target\'s parent');
assert.equal((await ws.fs.stat('link', { follow: false })).type, 'symlink');
assert.equal(await ws.fs.readlink('link'), '/tmp/data/real');

// The link's text is its own: a relative target is taken from the link's directory.
await ws.fs.symlink('real/f.txt', '/tmp/data/rel');
assert.equal(await ws.fs.readFileString('/tmp/data/rel'), 'F');
assert.equal(await ws.fs.readlink('/tmp/data/rel'), 'real/f.txt');

// ── resolve, and what names nothing ──────────────────────────────────────
assert.equal(ws.fs.resolve('a.txt'), '/home/user/a.txt');
assert.equal(ws.fs.resolve('/etc/passwd'), '/etc/passwd', 'an absolute path is untouched');
assert.equal(ws.fs.resolve('.'), '/home/user');
assert.equal(ws.fs.resolve('./x//y/.'), '/home/user/x/y/');
assert.equal(ws.fs.resolve('../x'), '/home/user/../x', '.. is left for the walk');
assert.equal(ws.fs.resolve('d/'), '/home/user/d/');
assert.throws(() => ws.fs.resolve(''), { code: 'ENOENT' });
assert.equal(await code(() => ws.fs.readFile('')), 'ENOENT', 'an empty path names nothing');
assert.equal(await code(() => ws.fs.readdir('')), 'ENOENT', 'not the root');

// `.` and `..` as the last component name a directory by relation; removing
// or renaming one is refused with Linux's codes, never taken as the cwd.
await ws.fs.mkdir('keep/inner', { recursive: true });
const inKeep = new WorkspaceFs(ws.shell.getVfs(), '/home/user/keep/inner');
assert.equal(await code(() => inKeep.rmdir('.')), 'EINVAL');
assert.equal(await code(() => inKeep.rmdir('..')), 'ENOTEMPTY');
assert.equal(await code(() => inKeep.unlink('.')), 'EISDIR');
assert.equal(await code(() => inKeep.remove('.', { recursive: true })), 'EINVAL');
assert.equal(await code(() => inKeep.removeRecursive('..')), 'EINVAL');
assert.equal(await code(() => inKeep.rename('.', '/home/user/moved')), 'EBUSY');
assert.equal(await ws.fs.isDirectory('keep/inner'), true, 'nothing was removed');
assert.equal(inKeep.resolve('x'), '/home/user/keep/inner/x', 'a view at another directory');

// ── A cd in the session shell is that process's, not the view's ─────────
await ws.shell.execute('cd /tmp');
assert.equal(ws.shell.getCwd(), '/tmp', 'the shell moved');
assert.equal(ws.fs.cwd, '/home/user', 'the view did not');
assert.equal(text(await ws.fs.readFile('a.txt')), 'A');
await ws.shell.execute('cd /home/user');

// ── The boundary: the root-relative view keeps its meaning ──────────────
const rootRelative = ws.shell.getVfs();
assert.match(await rootRelative.readFileString('etc/passwd'), /^root:/m, 'a ProcessView reads a key from /');
assert.equal(await code(() => ws.fs.readFile('etc/passwd')), 'ENOENT', 'ws.fs reads it from the cwd');
assert.equal(text(await rootRelative.readFile('home/user/a.txt')), 'A');
assert.equal(await code(() => ws.fs.readFile('home/user/a.txt')), 'ENOENT');
assert.equal((await names(rootRelative, '')).includes('etc'), true, 'an empty key is still the root there');
await ws.close();

// The compiler keeps them apart: neither type is assignable to the other.
// Each @ts-expect-error that stops being an error is itself one (TS2578).
{
  const here = dirname(fileURLToPath(import.meta.url));
  const src = join(here, '../../packages/core/src');
  const probe = join(src, 'workspace/__fs_boundary__.ts');
  const source = `
import type { ProcessView } from '../runtime/process-files.js';
import type { WorkspaceFs } from './workspace-fs.js';
import type { NimbusWorkspace } from './nimbus-workspace.js';
declare const ws: NimbusWorkspace;
declare const view: ProcessView;
// @ts-expect-error a cwd-relative face is no root-relative view
export const intoInternals: ProcessView = ws.fs;
// @ts-expect-error a root-relative view is no cwd-relative face
export const intoEmbedder: WorkspaceFs = view;
export const face: WorkspaceFs = ws.fs;
export const internal: ProcessView = ws.shell.getVfs();
`;
  const options = {
    target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ES2022, moduleResolution: ts.ModuleResolutionKind.Bundler,
    lib: ['lib.es2022.d.ts', 'lib.esnext.disposable.d.ts'], types: [], strict: true, noEmit: true, skipLibCheck: true,
    customConditions: ['workspace'],
  };
  const host = ts.createCompilerHost(options);
  const readFile = host.readFile.bind(host);
  const fileExists = host.fileExists.bind(host);
  const getSourceFile = host.getSourceFile.bind(host);
  host.readFile = (file) => (file === probe ? source : readFile(file));
  host.fileExists = (file) => file === probe || fileExists(file);
  host.getSourceFile = (file, version, ...rest) => (file === probe
    ? ts.createSourceFile(file, source, version)
    : getSourceFile(file, version, ...rest));
  const program = ts.createProgram([probe], options, host);
  const diagnostics = [...program.getSyntacticDiagnostics(program.getSourceFile(probe)), ...program.getSemanticDiagnostics(program.getSourceFile(probe))];
  assert.deepEqual(diagnostics.map((d) => `TS${d.code}: ${ts.flattenDiagnosticMessageText(d.messageText, '\n')}`), [], 'the boundary holds in the types');
}

console.log('workspace-fs-cwd: ok');
