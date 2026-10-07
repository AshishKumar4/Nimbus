#!/usr/bin/env bun
// @tier slow — long; CI median 25 s wall, 32 s CPU, 0.6 GiB peak (6 runs, 2026-10-06)
// Exercise installed public packages, not the repository's patched dependency.
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { build } from 'esbuild';

const root = new URL('../../', import.meta.url).pathname.replace(/\/$/, '');
const work = mkdtempSync(join(tmpdir(), 'worker-git-consumer-'));
// Bun leaves a `.hm` file in TMPDIR when TMPDIR and its install cache are on
// different filesystems; inside `work` it goes with the rest.
const childTmp = join(work, 'tmp');
mkdirSync(childTmp);
const run = (cmd, args, cwd) => execFileSync(cmd, args, { cwd, encoding: 'utf8', maxBuffer: 1 << 24, env: { ...process.env, TMPDIR: childTmp } });
const program = `import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {readFileSync,writeFileSync,mkdtempSync,rmSync} from 'node:fs';
import {execFileSync} from 'node:child_process';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {NimbusWorkspace} from '@nimbus-sh/core/workspace';
import {runGitCommand} from '@nimbus-sh/worker/git';
const sqlite = process.versions.bun ? await import('bun:sqlite') : await import('node:sqlite');
const db = process.versions.bun ? new sqlite.Database(':memory:') : new sqlite.DatabaseSync(':memory:');
let transaction = 0;
const sql = { exec(query, ...values) {
 const args = values.map(v => v instanceof ArrayBuffer ? new Uint8Array(v) : ArrayBuffer.isView(v) ? new Uint8Array(v.buffer, v.byteOffset, v.byteLength) : v);
 const statement = db.prepare(query);
 if (/^\\s*(SELECT|WITH|PRAGMA)|\\bRETURNING\\b/i.test(query)) return statement.all(...args);
 statement.run(...args); return [];
} };
try {
 const workspace = await NimbusWorkspace.create({sql, generation:1, cwd:'/home/main', transactions:{storage:{transactionSync(fn){
  const savepoint = 'consumer_' + transaction++;
  db.exec('SAVEPOINT ' + savepoint);
  try { const value = fn(); db.exec('RELEASE ' + savepoint); return value; }
  catch (error) { db.exec('ROLLBACK TO ' + savepoint); db.exec('RELEASE ' + savepoint); throw error; }
 }}}});
 let indexWrites = 0;
 const as = workspace.vfs.as.bind(workspace.vfs);
 workspace.vfs.as = cred => {
  const view = as(cred);
  return new Proxy(view, { get(target, key) {
   const value = Reflect.get(target, key, target);
   if (key === 'writeFile') return (path, ...args) => { if (path.endsWith('/.git/index')) indexWrites++; return value.call(target, path, ...args); };
   return typeof value === 'function' ? value.bind(target) : value;
  }});
 };
 workspace.registry.register('git', ctx => runGitCommand(ctx, workspace.vfs, undefined, {}));
 const cwd = '/home/main/repo';
 await workspace.fs.mkdir(cwd, {recursive:true});
 const count = 2000;
 for (let i=0; i<count; i++) await workspace.fs.writeFile(cwd + '/f' + i + '.txt', 'file ' + i + '\\n');
 const command = async line => { const result = await workspace.shell.execute(line, {cwd}); assert.equal(result.exitCode, 0, line + ': ' + result.stderr); return result.stdout; };
 await command('git init');
 indexWrites = 0;
 await command('git add .');
 assert.equal(indexWrites, 1, 'one index write stages the entire large worktree');
 const index = await workspace.fs.readFile(cwd + '/.git/index');
 const bytes = new Uint8Array(index);
 assert.equal(new TextDecoder().decode(bytes.subarray(0,4)), 'DIRC');
 assert.equal(new DataView(bytes.buffer,bytes.byteOffset,bytes.byteLength).getUint32(8), count);
 assert.deepEqual(bytes.slice(-20), new Uint8Array(createHash('sha1').update(bytes.subarray(0,-20)).digest()), 'index checksum is valid');
 // Real git reads the produced index; Nimbus need not expose --stage itself.
 const oracle = mkdtempSync(join(tmpdir(), 'packed-git-index-'));
 let entries;
 try {
  execFileSync('git', ['init','-q',oracle]);
  writeFileSync(join(oracle,'.git','index'), bytes);
  entries = execFileSync('git', ['ls-files','--stage'], {cwd:oracle,encoding:'utf8'}).trim().split('\\n');
 } finally { rmSync(oracle,{recursive:true,force:true}); }
 assert.equal(entries.length, count);
 assert.deepEqual((await command('git ls-files')).trim().split('\\n'), entries.map(entry => entry.split('\\t')[1]));
 for (const entry of entries) {
  const match = entry.match(/^100644 ([a-f0-9]{40}) 0\\tf(\\d+)\\.txt$/);
  assert.ok(match, entry);
  const body = 'file ' + Number(match[2]) + '\\n';
  const oid = createHash('sha1').update('blob ' + Buffer.byteLength(body) + '\\0').update(body).digest('hex');
  assert.equal(match[1], oid, 'the index refers to each file content, not a partial or empty entry');
 }
 await command('git config user.name PackageConsumer');
 await command('git config user.email package@example.test');
 await command('git commit -m "packed public git"');
 assert.match(await command('git log --oneline'), /packed public git/);
 const installed = new URL('./node_modules/@nimbus-sh/worker/', import.meta.url);
 const {GIT_BUNDLE_ENTRY, GIT_BUNDLE_SHA256} = await import(new URL('dist/git-bundle.generated.js', installed));
 const staged = readFileSync(new URL('public' + GIT_BUNDLE_ENTRY, installed));
 assert.equal(createHash('sha256').update(staged).digest('hex'), GIT_BUNDLE_SHA256, 'the packed facet git module is the pinned one');
 assert.deepEqual(readFileSync(new URL('vendor/git.generated.mjs', installed)), staged, 'host and facet use byte-identical canonical git code');
 const {gitHttp} = await import(new URL('vendor/git.generated.mjs', installed));
 assert.equal(gitHttp.request, gitHttp.default.request, 'the namespace and default HTTP APIs expose the same request implementation');

 console.log('PACKED GIT OK: 2000 files, one index write, all blob ids and commit');
} finally { db.close(); }
`;
try {
  const dependencies = {};
  const packages = [];
  const vendorBytes = readFileSync(join(root, 'packages/worker/vendor/git.generated.mjs'));
  for (const pkg of ['platform', 'core', 'fabric', 'worker']) {
    const directory = join(root, 'packages', pkg);
    const filename = run('bun', ['pm', 'pack', '--destination', work, '--quiet'], directory).trim();
    const tarball = resolve(work, filename);
    const manifest = JSON.parse(readFileSync(join(directory, 'package.json'), 'utf8'));
    dependencies[manifest.name] = 'file:' + tarball;
    packages.push({ name: manifest.name, version: manifest.version, tarball });
  }
  const consumer = join(work, 'consumer');
  mkdirSync(consumer);
  // Unpublished candidate versions must satisfy transitive edges too, as in
  // a release consumer: every internal edge resolves to the same packed bytes.
  writeFileSync(join(consumer, 'package.json'), JSON.stringify({name:'worker-git-consumer',version:'0.0.0',private:true,type:'module',dependencies,overrides:dependencies}));
  run('bun', ['install'], consumer);
  let payloadFiles = 0;
  for (const pkg of packages) {
    const files = await new Bun.Archive(await Bun.file(pkg.tarball).arrayBuffer()).files();
    for (const [path, file] of files) {
      if (path.endsWith('/')) continue;
      assert.ok(path.startsWith('package/'));
      const relative = path.slice('package/'.length);
      const installed = readFileSync(join(consumer, 'node_modules', pkg.name, relative));
      const packed = new Uint8Array(await file.arrayBuffer());
      if (relative === 'package.json') {
        const manifest = JSON.parse(new TextDecoder().decode(packed));
        assert.equal(manifest.name, pkg.name);
        assert.equal(manifest.version, pkg.version);
        assert.deepEqual(JSON.parse(installed.toString('utf8')), manifest, 'installed manifest matches the candidate, not a registry fallback');
      } else assert.equal(Buffer.compare(installed, packed), 0, pkg.name + '/' + relative);
      payloadFiles++;
    }
  }
  assert.equal(Buffer.compare(readFileSync(join(consumer, 'node_modules/@nimbus-sh/worker/vendor/git.generated.mjs')), vendorBytes), 0);
  console.log(`  installed candidate payload: ${payloadFiles} files verified against packed bytes`);
  writeFileSync(join(consumer, 'consume.mjs'), program);
  for (const runtime of ['node', 'bun']) {
    const output = run(runtime, ['consume.mjs'], consumer);
    assert.match(output, /PACKED GIT OK/);
    process.stdout.write(runtime + ': ' + output);
  }
  // A Worker bundler must follow the ordinary literal module import; no
  // runtime eval, package patch hook, or filesystem read is needed there.
  const bundled = await build({absWorkingDir:consumer, stdin:{contents:"export {runGitCommand} from '@nimbus-sh/worker/git';",resolveDir:consumer,sourcefile:'consumer-worker.js'}, bundle:true,write:false,format:'esm',platform:'browser',conditions:['worker','browser','import'],external:['node:*','cloudflare:workers'],metafile:true,logLevel:'silent'});
  const imports = Object.values(bundled.metafile.outputs).flatMap(output => output.imports);
  assert.ok(imports.every(item => item.path !== 'isomorphic-git'));
  assert.ok(Object.keys(bundled.metafile.inputs).some(path => path.endsWith('/vendor/git.generated.mjs')));
  const check = `import {git, gitHttp} from './node_modules/@nimbus-sh/worker/vendor/git.generated.mjs';
function patched(fs: Parameters<typeof git.add>[0]['fs']) {
 void git.stage({fs, dir:'/repo', add:['a','b'], remove:['c'], parallel:false});
 void git.add({fs, dir:'/repo', filepath:['a','b']});
 void git.remove({fs, dir:'/repo', filepath:['c','d']});
 void git.statusMatrix({fs, dir:'/repo', deferRefresh:true});
 void git.commit({fs, dir:'/repo', message:'message', rawMessage:true});
}
void patched;
export function request(options: Parameters<typeof gitHttp.request>[0]) {
 return [gitHttp.request(options), gitHttp.default.request(options)];
}
`;
  writeFileSync(join(consumer, 'consumer.mts'), check);
  writeFileSync(join(consumer, 'consumer.cts'), `export async function stageFromCommonJs() {
    const {git, gitHttp} = await import('./node_modules/@nimbus-sh/worker/vendor/git.generated.mjs');
    return {
      stage: (options: Parameters<typeof git.add>[0]) => git.stage({...options, add:['a','b'], remove:['old']}),
      request: (options: Parameters<typeof gitHttp.request>[0]) => [gitHttp.request(options), gitHttp.default.request(options)],
    };
  }`);
  run(join(root, 'node_modules/.bin/tsc'), ['--noEmit','--strict','--module','NodeNext','--moduleResolution','NodeNext','--target','ES2022','consumer.mts','consumer.cts'], consumer);
  console.log('worker-git-npm-package-consumer: normal installed Node/Bun APIs, Worker import path, and ESM/CJS declaration consumers pass');
} finally { rmSync(work, {recursive:true,force:true}); }
