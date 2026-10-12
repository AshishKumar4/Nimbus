import assert from 'node:assert/strict';
import { copyFile, mkdir, mkdtemp, readFile, readdir, rm, symlink, writeFile } from 'node:fs/promises';
import { spawnSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { BuildFailure, runBuildFixpoint } from '../../scripts/dist-integrity.mjs';
import { bindingInputs, loaderInputs } from '../../packages/worker/scripts/napi-wasm/inputs.mjs';
import { opencodeInputs } from '../../packages/worker/scripts/opencode/inputs.mjs';
import { pythonInputs } from '../../packages/worker/wasm/python/inputs.mjs';
import { oxcWasmInputs } from '../../packages/worker/scripts/oxc-wasm/inputs.mjs';
import { SPECS } from '../../packages/worker/scripts/napi-wasm/specs.mjs';

const repo = fileURLToPath(new URL('../../', import.meta.url));
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
    'packages/worker/scripts/bundle-opencode.mjs', 'packages/worker/scripts/bundle-oxc-wasm.mjs',
    'packages/worker/scripts/build-opencode-attach-entry.mjs',
    ...Object.keys(await loaderInputs(provenance.source.graph)),
    ...Object.keys(await opencodeInputs()),
    ...Object.keys(await pythonInputs()).map(name => path.join('packages/worker/wasm/python', name)),
    ...Object.keys(await oxcWasmInputs()).map(name => path.join('packages/worker/scripts/oxc-wasm', name)),
  ]);
  for (const key of Object.keys(SPECS)) for (const name of Object.keys(await bindingInputs(key))) names.add(name);
  for (const name of names) if (!name.includes('#')) await copy(name);
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
  await writeFile(path.join(root, 'packages/worker/package.json'), JSON.stringify({
    scripts: { 'bundle:napi-wasm': 'node scripts/bundle-napi-wasm.mjs' },
  }));
  await mkdir(path.join(root, 'packages/worker/src'), { recursive: true });
  assert.equal(spawnSync('git', ['init', '-q'], { cwd: root }).status, 0);
  assert.equal(run('packages/worker/scripts/bundle-napi-wasm.mjs').status, 0, 'current loader and bindings stage');

  const filesystem = 'packages/core/src/runtime/wasi/filesystem.ts';
  const source = await readFile(path.join(root, filesystem), 'utf8');
  await writeFile(path.join(root, filesystem), source.replace('st.type === \'directory\' ? 0o755', 'st.type === \'directory\' ? 0o700'));
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
  console.log('staged-artifact-inputs OK: current sources stage; edits, deletion and a new wrapper module refuse; the dist gate rolls back');
} finally {
  await rm(root, { recursive: true, force: true });
}
