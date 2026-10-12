import assert from 'node:assert/strict';
import { copyFile, mkdir, mkdtemp, readFile, readdir, rm, symlink, utimes, writeFile } from 'node:fs/promises';
import { spawnSync } from 'node:child_process';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { BuildFailure, runBuildFixpoint } from '../../scripts/dist-integrity.mjs';
import { bindingInputs, loaderInputs } from '../../packages/worker/scripts/napi-wasm/inputs.mjs';
import { opencodeInputs } from '../../packages/worker/scripts/opencode/inputs.mjs';
import { pythonInputs } from '../../packages/worker/wasm/python/inputs.mjs';
import { oxcWasmInputs } from '../../packages/worker/scripts/oxc-wasm/inputs.mjs';
import { SPECS } from '../../packages/worker/scripts/napi-wasm/specs.mjs';
import { SPECS as RUNTIME_SPECS } from '../../packages/worker/scripts/runtime-specs.mjs';

const repo = fileURLToPath(new URL('../../', import.meta.url));
const { applyEdits, modify } = createRequire(new URL('../../packages/worker/package.json', import.meta.url))('jsonc-parser');
const loaderDir = path.join(repo, 'packages/worker/public/_assets/napi-wasm/loader');
const [loaderBuild] = await readdir(loaderDir);
const provenance = JSON.parse(await readFile(path.join(loaderDir, loaderBuild, 'provenance.json'), 'utf8'));
const root = await mkdtemp(path.join(tmpdir(), 'staged-artifact-inputs-'));
const copy = async relative => {
  const target = path.join(root, relative);
  await mkdir(path.dirname(target), { recursive: true });
  await copyFile(path.join(repo, relative), target);
};
const run = script => spawnSync('node', [script], { cwd: root, encoding: 'utf8' });
const refused = (result, file, command) => {
  assert.notEqual(result.status, 0, `${file} changed but staging accepted the old artifact`);
  assert.ok(result.stderr.includes(file), result.stderr);
  assert.ok(result.stderr.includes(command), result.stderr);
};

try {
  // Use the real stage recipes and committed artifacts, but give the recipes
  // their own source tree. No build or test can change the repository's files.
  const names = new Set([
    'bun.lock', 'packages/worker/scripts/bundle-napi-wasm.mjs',
    'packages/core/src/constants.ts',
    'packages/worker/scripts/bundle-opencode.mjs', 'packages/worker/scripts/bundle-oxc-wasm.mjs',
    'packages/worker/scripts/build-opencode-attach-entry.mjs',
    'packages/worker/scripts/bundle-runtime.mjs', 'packages/worker/scripts/runtime-specs.mjs',
    'packages/worker/runtime-contracts/pyodide-workerd-adapter.json',
    ...Object.keys(await loaderInputs(provenance.source.graph)),
    ...Object.keys(await opencodeInputs()),
    ...Object.keys(await pythonInputs()).map(name => path.join('packages/worker/wasm/python', name)),
    ...Object.keys(await oxcWasmInputs()).map(name => path.join('packages/worker/scripts/oxc-wasm', name)),
  ]);
  for (const key of Object.keys(SPECS)) for (const name of Object.keys(await bindingInputs(key))) names.add(name);
  const files = new Set([...names].filter(name => !name.startsWith('toolchain#')).map(name => name.split('#')[0]));
  for (const name of files) await copy(name);
  await mkdir(path.join(root, 'packages/worker/public/_assets'), { recursive: true });
  for (const family of ['napi-wasm', 'opencode', 'oxc']) {
    await symlink(path.join(repo, 'packages/worker/public/_assets', family), path.join(root, 'packages/worker/public/_assets', family), 'dir');
  }
  for (const name of ['python.wasm', 'python-sci.wasm', 'python313.zip', 'sci-packages.zip', 'provenance.json']) {
    await symlink(path.join(repo, 'packages/worker/wasm/python', name), path.join(root, 'packages/worker/wasm/python', name));
  }
  await symlink(path.join(repo, 'node_modules'), path.join(root, 'node_modules'), 'dir');
  await symlink(path.join(repo, 'packages/worker/node_modules'), path.join(root, 'packages/worker/node_modules'), 'dir');
  await writeFile(path.join(root, 'package.json'), '{"type":"module"}');
  await mkdir(path.join(root, 'packages/worker/src'), { recursive: true });
  assert.equal(spawnSync('git', ['init', '-q'], { cwd: root }).status, 0);
  assert.equal(run('packages/worker/scripts/bundle-napi-wasm.mjs').status, 0, 'current loader and bindings stage');

  const filesystem = 'packages/core/src/runtime/wasi/filesystem.ts';
  const source = await readFile(path.join(root, filesystem), 'utf8');
  await utimes(path.join(root, filesystem), new Date('2000-01-01'), new Date('2000-01-01'));
  assert.equal(run('packages/worker/scripts/bundle-napi-wasm.mjs').status, 0, 'a timestamp is not a source change');
  await writeFile(path.join(root, filesystem), source + '\n');
  refused(run('packages/worker/scripts/bundle-napi-wasm.mjs'), filesystem, 'bun scripts/ci/remote-napi-loader.mjs');
  const manifest = await readFile(path.join(root, 'packages/worker/src/napi-wasm-artifacts.generated.ts'));
  assert.throws(() => runBuildFixpoint({
    root, steps: [{ cwd: 'packages/worker', script: 'bundle:napi-wasm' }],
    roots: ['packages/worker/src/napi-wasm-artifacts.generated.ts'],
  }), error => error instanceof BuildFailure && error.message.includes('bundle:napi-wasm'));
  assert.deepEqual(await readFile(path.join(root, 'packages/worker/src/napi-wasm-artifacts.generated.ts')), manifest, 'the refused gate preserves its output');
  await copy(filesystem);

  const dependency = 'packages/core/src/vfs/dirent-type.ts';
  await rm(path.join(root, dependency));
  refused(run('packages/worker/scripts/bundle-napi-wasm.mjs'), dependency, 'bun scripts/ci/remote-napi-loader.mjs');
  await copy(dependency);

  const lock = await readFile(path.join(root, 'bun.lock'), 'utf8');
  await writeFile(path.join(root, 'bun.lock'), applyEdits(lock, modify(lock, ['packages', 'esbuild', 0], 'esbuild@0.0.0', {})));
  refused(run('packages/worker/scripts/bundle-napi-wasm.mjs'), 'bun.lock#esbuild', 'bun scripts/ci/remote-napi-loader.mjs');
  await copy('bun.lock');

  const coreManifest = 'packages/core/package.json';
  const corePackage = await readFile(path.join(root, coreManifest), 'utf8');
  await writeFile(path.join(root, coreManifest), applyEdits(corePackage, modify(corePackage, ['sideEffects'], true, {})));
  refused(run('packages/worker/scripts/bundle-napi-wasm.mjs'), `${coreManifest}#esbuild`, 'bun scripts/ci/remote-napi-loader.mjs');
  await writeFile(path.join(root, coreManifest), applyEdits(corePackage, modify(corePackage, ['version'], '0.0.0', {})));
  assert.equal(run('packages/worker/scripts/bundle-napi-wasm.mjs').status, 0, 'a package release version is not a loader input');
  await copy(coreManifest);

  const added = 'packages/worker/scripts/napi-wasm/rolldown/binding/src/new.rs';
  await writeFile(path.join(root, added), 'pub const NEW: u32 = 1;\n');
  refused(run('packages/worker/scripts/bundle-napi-wasm.mjs'), added, 'bun scripts/ci/remote-napi-binding.mjs rolldown@');
  await rm(path.join(root, added));

  for (const [script, file, command] of [
    ['packages/worker/scripts/bundle-opencode.mjs', 'packages/worker/scripts/opencode/stubs/bun-shim.ts', 'rebuild-opencode.mjs'],
    ['packages/worker/scripts/bundle-oxc-wasm.mjs', 'packages/worker/scripts/oxc-wasm/src/lib.rs', 'oxc-wasm/build.mjs'],
  ]) {
    await writeFile(path.join(root, file), await readFile(path.join(root, file), 'utf8') + '\n');
    refused(run(script), file.includes('/oxc-wasm/') ? 'src/lib.rs' : file, command);
    await copy(file);
  }
  const python = 'packages/worker/wasm/python/nimbus-py.c';
  await writeFile(path.join(root, python), await readFile(path.join(root, python), 'utf8') + '\n');
  const result = spawnSync('node', ['packages/worker/wasm/python/inputs.mjs', '--check'], { cwd: root, encoding: 'utf8' });
  refused(result, 'nimbus-py.c', 'bun scripts/ci/remote-python-build.mjs');
  const pythonSpec = Object.keys(RUNTIME_SPECS).find(key => key.startsWith('cpython/'));
  assert.ok(pythonSpec, 'a local CPython runtime is published');
  const publication = spawnSync('node', ['packages/worker/scripts/bundle-runtime.mjs',
    ...pythonSpec.split('/'), '--npm-package', path.join(root, 'runtime-package')], { cwd: root, encoding: 'utf8' });
  refused(publication, 'nimbus-py.c', 'bun scripts/ci/remote-python-build.mjs');
  console.log('staged-artifact-inputs OK: current sources stage; edits, deletion and a new wrapper module refuse; the dist gate rolls back');
} finally {
  await rm(root, { recursive: true, force: true });
}
