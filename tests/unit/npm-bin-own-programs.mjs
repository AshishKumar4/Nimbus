#!/usr/bin/env bun
// npm-bin-own-programs — `tsc` is the project's own when a node_modules/.bin
// from the cwd up has it, and Nimbus's tsrs otherwise. An installed compiler
// that is a native binary (typescript 7, whose bin runs a platform package)
// cannot run here: tsrs runs in its place, and says so. A registered command
// still wins over both.

import assert from 'node:assert/strict';
import { installNpmBinFallbackResolver } from '../../packages/worker/src/shell/npm-bin-entrypoints.ts';
import { tsrsPrograms } from '../../packages/worker/src/runtime/tsrs.ts';
import { TSRS_TYPESCRIPT_VERSION, TSRS_VERSION } from '../../packages/worker/src/tsrs-wasm-artifact.generated.ts';
import { createNpmBinManifest, createNpmBinShim, npmBinManifestPath } from '../../packages/worker/src/npm/bin-links.ts';
import { CRED_KERNEL } from '../../packages/core/src/runtime/os-contracts.ts';
import { SqliteVFS } from '../../packages/core/src/vfs/sqlite-vfs.ts';
import { ProcessFiles } from '../../packages/core/src/runtime/process-files.ts';
import { createSqliteVfsTestHarness } from './lib/sqlite-vfs-test-harness.mjs';

const harness = createSqliteVfsTestHarness();
const rawVfs = new SqliteVFS(harness.sql, harness.ctx);
const vfs = rawVfs.as(CRED_KERNEL);

/** A project at `dir` with typescript `version` installed, its manifest carrying `optionalDependencies`. */
function project(dir, version, optionalDependencies) {
  const nodeModules = `${dir}/node_modules`;
  const entry = {
    name: 'tsc', packageName: 'typescript', packageVersion: version,
    packagePath: `${nodeModules}/typescript`, targetPath: `${nodeModules}/typescript/bin/tsc`,
  };
  vfs.mkdir(`${nodeModules}/.bin`, { recursive: true });
  vfs.mkdir(`${entry.packagePath}/bin`, { recursive: true });
  vfs.writeFile(`${entry.packagePath}/package.json`, JSON.stringify({ name: 'typescript', version, bin: { tsc: './bin/tsc' }, ...(optionalDependencies ? { optionalDependencies } : {}) }));
  vfs.writeFile(entry.targetPath, '#!/usr/bin/env node\nconsole.log("installed tsc")\n');
  vfs.writeFile(`${nodeModules}/.bin/tsc`, createNpmBinShim(entry, `${nodeModules}/.bin`));
  vfs.writeFile(npmBinManifestPath(nodeModules), JSON.stringify(createNpmBinManifest([entry])));
}
vfs.mkdir('home/user/bare', { recursive: true });
project('home/user/js', '6.0.3');
project('home/user/native', '7.0.2', { '@typescript/typescript-linux-x64': '7.0.2', '@typescript/typescript-darwin-arm64': '7.0.2' });

const commands = new Map();
const registry = {
  register(name, handler) { commands.set(name, handler); },
  resolve(name) { return commands.get(name); },
};
registry.register('node', async () => 0);
let cwd = '/home/user/bare';
const ran = [];
installNpmBinFallbackResolver(registry, {
  filesystem: new ProcessFiles(rawVfs),
  getCwd: () => cwd,
  getFacetManager() { throw new Error('unexpected staged artifact'); },
  async learnedServer() { return false; },
  notifyTerminalEvent() {},
  async runtimeCommandHint() { return null; },
  emitShellExecDone() {},
  ownPrograms: tsrsPrograms((binName) => async () => { ran.push(binName); return 42; }),
});
const context = () => ({ pid: 1, args: [], cwd, env: {}, stdout: { write() {} }, stderr: { write(s) { context.err.push(s); } } });
context.err = [];

{
  const tsc = await registry.resolve('tsc');
  assert.equal(await tsc(context()), 42, 'with no project tsc, tsc is tsrs');
  const tsrs = await registry.resolve('tsrs');
  assert.equal(await tsrs(context()), 42, 'and tsrs by its own name');
  assert.deepEqual(ran, ['tsc', 'tsrs'], 'each run under the name it was asked by');
  assert.deepEqual(context.err, [], 'saying nothing first');
  console.log('  ✓ no project TypeScript: tsc and tsrs run tsrs');
}
{
  cwd = '/home/user/js/src';
  vfs.mkdir('home/user/js/src', { recursive: true });
  ran.length = 0;
  const tsc = await registry.resolve('tsc');
  assert.equal(typeof tsc, 'function');
  await tsc(context()).catch(() => {});
  assert.deepEqual(ran, [], 'a project typescript in a node_modules above the cwd is the project\'s own tsc, not tsrs');
  console.log('  ✓ a project\'s own typescript runs as pinned');
}
{
  cwd = '/home/user/native';
  ran.length = 0;
  context.err = [];
  const tsc = await registry.resolve('tsc');
  assert.equal(await tsc(context()), 42, 'a typescript whose compiler is native runs tsrs');
  assert.deepEqual(ran, ['tsc']);
  assert.deepEqual(context.err, [
    `tsc: typescript 7.0.2 here is a native compiler, which cannot run in Nimbus; running tsrs ${TSRS_VERSION} (TypeScript ${TSRS_TYPESCRIPT_VERSION}) instead\n`,
  ], 'and says which compiler it is, before it runs');
  console.log('  ✓ a native typescript is answered by tsrs, which says so');
}
{
  cwd = '/home/user/bare';
  ran.length = 0;
  registry.register('tsc', async () => 7);
  assert.equal(await (await registry.resolve('tsc'))(context()), 7, 'a registered tsc wins over tsrs');
  assert.deepEqual(ran, []);
  assert.equal(await registry.resolve('vite'), undefined, 'a name Nimbus has no program for stays unresolved');
  console.log('  ✓ a registered command wins; other names are untouched');
}
console.log('npm-bin-own-programs: ok');
