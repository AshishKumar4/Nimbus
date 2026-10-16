#!/usr/bin/env bun
// `nimbus runtime sync` from the published CLI (audit HOST-2): what it
// publishes by default is runnable, and it can publish it.
//
//   - With no runtime named, the sync's Python is cpython, the one hosts run
//     (cpython-runner). Before, it was python@0.29.4, whose python-runner no
//     host registers, so a fresh bucket's `python` could not be installed.
//   - The published @nimbus-sh/worker has no wasm build tree, so a runtime
//     Nimbus builds (bash here, as cpython) is staged from its npm runtime
//     package. The bucket's manifest is then byte for byte the package's.
//     Before, the publisher stopped at the missing build tree.
//   - A tarball that is not the one its integrity names, or one whose blob is
//     not the one its manifest names, is refused, and nothing reaches the
//     bucket.
//
// The publisher runs for real, from a temp tree laid out as the published
// package (scripts and runtime-contracts, no wasm), against a stub wrangler
// holding the bucket in a directory and a stub registry serving the package
// the repository's own publisher made (--npm-package).
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import { syncRuntimes } from '../../packages/cli/src/commands/runtime-sync.ts';
import { CPYTHON_RUNNER } from '../../packages/core/src/runtime/os-contracts.ts';

const WORKER = new URL('../../packages/worker/', import.meta.url).pathname;
const CORE = new URL('../../packages/core', import.meta.url).pathname;
const BASH = 'bash@5.2.37-7';

const root = mkdtempSync(join(tmpdir(), 'nimbus-cli-sync-published-'));
const cwd = process.cwd();
const saved = { PATH: process.env.PATH, CLOUDFLARE_ACCOUNT_ID: process.env.CLOUDFLARE_ACCOUNT_ID, npm_config_registry: process.env.npm_config_registry };
let registry = null;
try {
  /** A tree at `dir` laid out as packages/worker is, with `wasm` only if `withBuildTree`. */
  const workerTree = (dir, withBuildTree) => {
    cpSync(join(WORKER, 'scripts'), join(dir, 'packages/worker/scripts'), { recursive: true });
    cpSync(join(WORKER, 'runtime-contracts'), join(dir, 'packages/worker/runtime-contracts'), { recursive: true });
    if (withBuildTree) {
      cpSync(join(WORKER, 'wasm/bash'), join(dir, 'packages/worker/wasm/bash'), { recursive: true });
      cpSync(join(WORKER, 'wasm/nimbus-libc'), join(dir, 'packages/worker/wasm/nimbus-libc'), { recursive: true });
    }
    mkdirSync(join(dir, 'node_modules/@nimbus-sh'), { recursive: true });
    symlinkSync(CORE, join(dir, 'node_modules/@nimbus-sh/core'));
    symlinkSync(dirname(createRequire(join(WORKER, 'scripts/artifact-inputs.mjs')).resolve('jsonc-parser/package.json')), join(dir, 'node_modules/jsonc-parser'));
    return join(dir, 'packages/worker/scripts/bundle-runtime.mjs');
  };

  // ── With no runtime named, the Python published is the one hosts run ──
  {
    const dir = join(root, 'selection');
    const publisher = workerTree(dir, false);
    // The publisher replaced by one that says what it was asked for and reports a catalog.
    const asked = join(dir, 'asked.log');
    writeFileSync(publisher, `import { appendFileSync } from 'node:fs';\nappendFileSync(${JSON.stringify(asked)}, process.argv.slice(2, 4).join('@') + '\\n');\nconsole.log('NIMBUS_RUNTIME_CATALOG_SHA256=${'a'.repeat(64)}');\n`);
    process.env.CLOUDFLARE_ACCOUNT_ID = 'test-account';
    assert.equal(await syncRuntimes(['--bucket', 'any'], { scriptPath: publisher }), 0);
    const published = readFileSync(asked, 'utf8').trim().split('\n');
    const { SPECS } = await import(join(dir, 'packages/worker/scripts/runtime-specs.mjs'));
    const pythons = published.filter((key) => SPECS[key.replace('@', '/')].files.some((f) => f.binName === 'python3'));
    assert.deepEqual(pythons.map((key) => SPECS[key.replace('@', '/')].files.find((f) => f.binName === 'python3').runner), [CPYTHON_RUNNER],
      `the default sync publishes one Python, cpython's: ${published.join(', ')}`);
  }

  // ── The package the repository's publisher makes, served by a stub registry ──
  const made = join(root, 'made');
  const repoPublisher = workerTree(made, true);
  const pkgDir = join(made, 'package');
  const built = spawnSync('node', [repoPublisher, 'bash', '5.2.37-7', '--npm-package', pkgDir], { cwd: made, encoding: 'utf8', env: { ...process.env, CLOUDFLARE_ACCOUNT_ID: '' } });
  assert.equal(built.status, 0, `the repository's publisher makes the package:\n${built.stdout}\n${built.stderr}`);
  const pack = (dir, out) => {
    const r = spawnSync('tar', ['-czf', out, '-C', dirname(dir), 'package']);
    assert.equal(r.status, 0, String(r.stderr));
    return readFileSync(out);
  };
  const genuine = pack(pkgDir, join(root, 'genuine.tgz'));
  const served = { tarball: genuine, integrity: `sha512-${createHash('sha512').update(genuine).digest('base64')}` };
  registry = Bun.serve({
    port: 0,
    fetch(request) {
      const url = new URL(request.url);
      if (url.pathname === '/@nimbus-sh%2fruntime-bash/5.2.37-7') {
        return Response.json({ name: '@nimbus-sh/runtime-bash', version: '5.2.37-7', dist: { tarball: `${url.origin}/runtime-bash.tgz`, integrity: served.integrity } });
      }
      if (url.pathname === '/runtime-bash.tgz') return new Response(served.tarball);
      return new Response('not found', { status: 404 });
    },
  });
  process.env.npm_config_registry = `http://127.0.0.1:${registry.port}`;

  // ── The published layout: no build tree ──
  const published = join(root, 'published');
  const publisher = workerTree(published, false);
  assert.equal(existsSync(join(published, 'packages/worker/wasm')), false);
  const bucketDir = join(root, 'bucket');
  mkdirSync(bucketDir);
  mkdirSync(join(root, 'bin'));
  writeFileSync(join(root, 'bin/wrangler'), `#!/usr/bin/env node
const fs = require('node:fs');
const path = require('node:path');
const args = process.argv.slice(2);
const dir = ${JSON.stringify(bucketDir)};
const at = (spec) => path.join(dir, encodeURIComponent(spec.slice(spec.indexOf('/') + 1)));
const flag = (name) => { const i = args.indexOf(name); return i < 0 ? null : args[i + 1]; };
if (args[0] === 'r2' && args[1] === 'bucket' && args[2] === 'info') { console.log('object_count: ' + fs.readdirSync(dir).length); process.exit(0); }
if (args[0] === 'r2' && args[1] === 'object' && args[2] === 'put') { fs.copyFileSync(flag('--file'), at(args[3])); process.exit(0); }
if (args[0] === 'r2' && args[1] === 'object' && args[2] === 'get') {
  if (!fs.existsSync(at(args[3]))) { process.stderr.write('The specified key does not exist.'); process.exit(1); }
  if (args.includes('--pipe')) process.stdout.write(fs.readFileSync(at(args[3])));
  else fs.copyFileSync(at(args[3]), flag('--file'));
  process.exit(0);
}
process.exit(1);
`, { mode: 0o755 });
  process.env.PATH = `${join(root, 'bin')}:${saved.PATH}`;
  process.chdir(published);
  const object = (key) => readFileSync(join(bucketDir, encodeURIComponent(key)));
  const emptyBucket = () => { rmSync(bucketDir, { recursive: true }); mkdirSync(bucketDir); };

  // Published from the package: the bucket's manifest is the package's, and every blob it names is there.
  assert.equal(await syncRuntimes(['--bucket', 'experiment', BASH], { scriptPath: publisher }), 0, 'the published CLI publishes a runtime it has no build of');
  const manifest = readFileSync(join(pkgDir, 'manifest.json'));
  assert.deepEqual(object('manifests/bash-5.2.37-7.json'), manifest, 'the bucket holds the package\'s manifest, byte for byte');
  for (const file of JSON.parse(manifest.toString('utf8')).files) {
    assert.equal(createHash('sha256').update(object(file.content)).digest('hex'), file.sha256, `${file.content} is in the bucket as named`);
  }

  // A tarball that is not the one its integrity names: refused, nothing published.
  emptyBucket();
  served.integrity = `sha512-${createHash('sha512').update('other bytes').digest('base64')}`;
  assert.notEqual(await syncRuntimes(['--bucket', 'experiment', BASH], { scriptPath: publisher }), 0, 'a tarball its integrity does not name is refused');
  assert.deepEqual(readdirSync(bucketDir), [], 'and nothing reached the bucket');

  // A blob that is not the one the manifest names, in a tarball its integrity does name: refused, nothing published.
  emptyBucket();
  const tampered = join(root, 'tampered', 'package');
  cpSync(pkgDir, tampered, { recursive: true });
  const wasm = JSON.parse(manifest.toString('utf8')).files.find((f) => f.path.endsWith('bash.async.wasm'));
  writeFileSync(join(tampered, wasm.content), Buffer.concat([readFileSync(join(tampered, wasm.content)), Buffer.from([0])]));
  served.tarball = pack(tampered, join(root, 'tampered.tgz'));
  served.integrity = `sha512-${createHash('sha512').update(served.tarball).digest('base64')}`;
  assert.notEqual(await syncRuntimes(['--bucket', 'experiment', BASH], { scriptPath: publisher }), 0, 'a blob its manifest does not name is refused');
  assert.deepEqual(readdirSync(bucketDir), [], 'and nothing reached the bucket');
} finally {
  process.chdir(cwd);
  registry?.stop(true);
  for (const [name, value] of Object.entries(saved)) {
    if (value === undefined) delete process.env[name]; else process.env[name] = value;
  }
  rmSync(root, { recursive: true, force: true });
}
console.log('cli-runtime-sync-published: ok');
