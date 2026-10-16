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
//   - A tarball that is not the one its integrity names, one whose blob is not
//     the one its manifest names, one holding a link (its manifest a link to a
//     file outside, a blob a link to /dev/zero), and one of more entries than
//     a runtime package may hold are each refused by the publisher itself,
//     well within a deadline that kills it, and nothing reaches the bucket.
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
import { runBoundedProcess } from '../../scripts/lib/bounded-process.mjs';
import { CPYTHON_RUNNER } from '../../packages/core/src/runtime/os-contracts.ts';

const WORKER = new URL('../../packages/worker/', import.meta.url).pathname;
const CORE = new URL('../../packages/core', import.meta.url).pathname;
const BASH = 'bash@5.2.37-7';
const CPYTHON = 'cpython@3.13.14-3';

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
      for (const tree of ['bash', 'python', 'nimbus-libc']) cpSync(join(WORKER, 'wasm', tree), join(dir, 'packages/worker/wasm', tree), { recursive: true });
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

  // ── The packages the repository's publisher makes, served by a stub registry ──
  const made = join(root, 'made');
  const repoPublisher = workerTree(made, true);
  /** The package directory (named `package`, as npm wraps one) the repository's publisher makes for `runtime`. */
  const make = (runtime) => {
    const dir = join(made, runtime.replace('@', '-'), 'package');
    const built = spawnSync('node', [repoPublisher, ...runtime.split('@'), '--npm-package', dir], { cwd: made, encoding: 'utf8', env: { ...process.env, CLOUDFLARE_ACCOUNT_ID: '' } });
    assert.equal(built.status, 0, `the repository's publisher makes ${runtime}:\n${built.stdout}\n${built.stderr}`);
    return dir;
  };
  /** `dir` (a directory named `package`) as an npm tarball: ustar, as npm writes one. */
  const pack = (dir, out) => {
    const r = spawnSync('tar', ['--format=ustar', '-czf', out, '-C', dirname(dir), 'package']);
    assert.equal(r.status, 0, String(r.stderr));
    return readFileSync(out);
  };
  const integrityOf = (bytes) => `sha512-${createHash('sha512').update(bytes).digest('base64')}`;
  const served = new Map();
  const serve = (runtime, tarball, integrity = integrityOf(tarball)) => {
    const [name, version] = runtime.split('@');
    served.set(`/@nimbus-sh%2fruntime-${name}/${version}`, { name: `@nimbus-sh/runtime-${name}`, version, tarball, integrity });
  };
  const bashDir = make(BASH);
  const cpythonDir = make(CPYTHON);
  serve(BASH, pack(bashDir, join(root, 'bash.tgz')));
  serve(CPYTHON, pack(cpythonDir, join(root, 'cpython.tgz')));
  registry = Bun.serve({
    port: 0,
    fetch(request) {
      const url = new URL(request.url);
      const record = served.get(url.pathname);
      if (record) return Response.json({ name: record.name, version: record.version, dist: { tarball: `${url.origin}${url.pathname}.tgz`, integrity: record.integrity } });
      const tarball = served.get(url.pathname.replace(/\.tgz$/, ''));
      if (tarball && url.pathname.endsWith('.tgz')) return new Response(tarball.tarball);
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

  /** The sync of `runtime` into an empty bucket. */
  const sync = async (runtime) => {
    emptyBucket();
    return syncRuntimes(['--bucket', 'experiment', runtime], { scriptPath: publisher });
  };
  /** The bucket holds `dir`'s manifest for `runtime`, byte for byte, and every blob it names. */
  const holds = (runtime, dir) => {
    const manifest = readFileSync(join(dir, 'manifest.json'));
    assert.deepEqual(object(`manifests/${runtime.replace('@', '-')}.json`), manifest, `the bucket holds ${runtime}'s package manifest, byte for byte`);
    for (const file of JSON.parse(manifest.toString('utf8')).files) {
      assert.equal(createHash('sha256').update(object(file.content)).digest('hex'), file.sha256, `${file.content} is in the bucket as named`);
    }
  };

  // Published from the packages: the default Python, and bash with its BusyBox applets.
  assert.equal(await sync(CPYTHON), 0, 'the published CLI publishes cpython, which it has no build of');
  holds(CPYTHON, cpythonDir);
  assert.equal(await sync(BASH), 0, 'and bash');
  holds(BASH, bashDir);

  /** A copy of the bash package, changed by `change(dir)`, served as bash. */
  const variant = (label, change) => {
    const dir = join(root, label, 'package');
    cpSync(bashDir, dir, { recursive: true });
    change(dir);
    serve(BASH, pack(dir, join(root, `${label}.tgz`)));
  };
  const wasm = JSON.parse(readFileSync(join(bashDir, 'manifest.json'), 'utf8')).files.find((f) => f.path.endsWith('bash.async.wasm'));
  // The publisher the sync runs, bounded: a refusal must come by itself, and a
  // regression that reads forever is killed, its whole process tree, at the deadline.
  const refusedLeavingNothing = async (why) => {
    emptyBucket();
    const run = await runBoundedProcess('node', [publisher, 'bash', '5.2.37-7', '--bucket', 'experiment'], { cwd: published, timeoutMs: 60_000 });
    assert.equal(run.code !== null && run.code !== 0, true, `${why} is refused by the publisher itself (${run.reason || `exit ${run.code}`}):\n${run.stderr}`);
    assert.deepEqual(readdirSync(bucketDir), [], `${why}: nothing reached the bucket`);
  };

  // A tarball that is not the one its integrity names.
  serve(BASH, readFileSync(join(root, 'bash.tgz')), integrityOf('other bytes'));
  await refusedLeavingNothing('a tarball its integrity does not name');

  // A blob that is not the one the manifest names, in a tarball its integrity does name.
  variant('tampered', (dir) => writeFileSync(join(dir, wasm.content), Buffer.concat([readFileSync(join(dir, wasm.content)), Buffer.from([0])])));
  await refusedLeavingNothing('a blob its manifest does not name');

  // The manifest as a link to a file outside the package, which holds the manifest itself.
  const sentinel = join(root, 'outside-manifest.json');
  writeFileSync(sentinel, readFileSync(join(bashDir, 'manifest.json')));
  // Relative, as ustar holds a link's target in 100 bytes: two levels up from the package is `root`.
  variant('linked-manifest', (dir) => { rmSync(join(dir, 'manifest.json')); symlinkSync('../../outside-manifest.json', join(dir, 'manifest.json')); });
  await refusedLeavingNothing('a manifest that is a link');

  // A blob as a link to a device that never ends.
  variant('linked-blob', (dir) => { rmSync(join(dir, wasm.content)); symlinkSync('/dev/zero', join(dir, wasm.content)); });
  await refusedLeavingNothing('a blob that is a link to /dev/zero');

  // The genuine package beside more empty files than a runtime package may hold.
  variant('many-entries', (dir) => {
    mkdirSync(join(dir, 'padding'));
    for (let i = 0; i < 5000; i++) writeFileSync(join(dir, 'padding', String(i)), '');
  });
  await refusedLeavingNothing('a package of more entries than its bound');
} finally {
  process.chdir(cwd);
  registry?.stop(true);
  for (const [name, value] of Object.entries(saved)) {
    if (value === undefined) delete process.env[name]; else process.env[name] = value;
  }
  rmSync(root, { recursive: true, force: true });
}
console.log('cli-runtime-sync-published: ok');
