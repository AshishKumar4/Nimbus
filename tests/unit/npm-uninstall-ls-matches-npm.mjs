#!/usr/bin/env bun
// The session's `npm ls` and `npm uninstall` do what npm 10.9.8 does: each
// case runs under real npm over files on disk and under the hosted
// runtime's npm over the same files in the session, and what is printed,
// the exit status, package.json and the trees left must be npm's (npm's
// own lockfiles aside: the session keeps its inventory elsewhere; the time
// a summary reports is the run's).
//
// - ls: the root, then each dependency it declares, sorted as npm sorts:
//   installed, UNMET (OPTIONAL) where it is not, invalid for its range, an
//   alias and a link as npm spells them; and each package nothing installed
//   depends on, extraneous. A missing or invalid dependency fails it
//   (ELSPROBLEMS), extraneous ones alone do not; a corrupt package.json
//   fails it once the tree is printed. -g lists the global prefix.
// - uninstall: the package and its bins go, and so does every declaration
//   of it, installed or not; package.json keeps its indent, its dependency
//   fields sorted and empty ones dropped. -g acts on the global prefix,
//   and an explicit false (--global=false, -g=false, --global false) on the
//   project; --no-save leaves package.json, a name with a version names
//   nothing.
//
// Before: the hosted runtime answered both itself. `npm uninstall -g p`
// removed the project's p and its declaration and left the global one and
// its bin; `npm ls -g` listed the project, and `npm ls` printed each
// declared range as though installed, missing packages included, and
// succeeded.
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, readlinkSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';

import { createSqliteVfsTestHarness } from './lib/sqlite-vfs-test-harness.mjs';
import { createFacetCtx, createFacetWorld } from './lib/facet-host-harness.mjs';
import { stagedAssets } from './lib/staged-assets.mjs';
import { importWorkerBundle } from './lib/worker-bundle.mjs';
import { hostedLifecycle } from './lib/hosted-lifecycle.mjs';

const bundle = await importWorkerBundle({
  'packages/worker/src/workspace-host.ts': ['composeHostedRuntime'],
  'packages/core/src/workspace/nimbus-workspace.ts': ['NimbusWorkspace'],
  'packages/core/src/runtime/session-process-supervisor.ts': ['SessionProcessSupervisor'],
  'packages/core/src/runtime/port-registry.ts': ['PortRegistry'],
  'packages/core/src/vfs/sqlite-vfs.ts': ['SqliteVFS'],
  'packages/core/src/runtime/process-table.ts': ['PID_GEN_STRIDE'],
  'packages/core/src/runtime/os-contracts.ts': ['CRED_SESSION_USER'],
  'packages/fabric/src/composition.ts': ['composeFabric'],
});
bundle.composeFabric({ supervisorEntrypoint: 'SupervisorRPC', hostNamespace: 'WORKSPACES', hostDispatchMethod: 'supervisorOp' });

// The disk mirrors the session: D + /home/user/... is /home/user/...
const D = mkdtempSync(join(tmpdir(), 'npm-uninstall-ls-'));
const HOME = '/home/user';
const PREFIX = `${HOME}/g`;
const RC = join(D, 'npmrc');
const USER_RC = join(D, 'user-npmrc');
writeFileSync(RC, '');
writeFileSync(USER_RC, '');
const baseEnv = Object.fromEntries(Object.entries(process.env).filter(([key]) => !/^npm_config_/i.test(key) && key !== 'CI'));
const npmEnv = {
  ...baseEnv, HOME: D + HOME, LANG: 'C.UTF-8', npm_config_globalconfig: RC, npm_config_userconfig: USER_RC,
  npm_config_update_notifier: 'false', npm_config_cache: join(D, 'cache'), npm_config_prefix: D + PREFIX,
};
const npmVersion = spawnSync('npm', ['--version'], { encoding: 'utf8', env: npmEnv }).stdout.trim();
assert.equal(npmVersion, '10.9.8', 'premise: npm is 10.9.8');

const world = createFacetWorld(() => ({
  async startProcess() { return { ok: true }; },
  async handleHttpRequest() { return new Response('ok'); },
}), { resolveConfig: false });
const harness = createSqliteVfsTestHarness();
const facetCtx = createFacetCtx(world, 'embedder-do');
const ctx = {
  ...facetCtx,
  storage: { ...facetCtx.storage, sql: harness.sql, transactionSync: harness.ctx.storage.transactionSync },
  exports: { SupervisorRPC: ({ props }) => ({ props }) },
  getWebSockets: () => [],
};
const env = { WORKSPACES: { idFromName() {}, idFromString() {}, get() {} }, LOADER: world.loader, ASSETS: stagedAssets };
const vfs = new bundle.SqliteVFS(harness.sql, harness.ctx);
const processes = new bundle.SessionProcessSupervisor();
processes.setPidBase(bundle.PID_GEN_STRIDE);
const workspace = await bundle.NimbusWorkspace.create({ sql: harness.sql, transactions: harness.ctx, vfs, processes, generation: 1 });
const runtime = await bundle.composeHostedRuntime({ workspace, ctx, env, ports: new bundle.PortRegistry(), lifecycle: hostedLifecycle(ctx, () => runtime) });
const user = vfs.as(bundle.CRED_SESSION_USER);

/** A file, in both places. */
function put(path, text) {
  mkdirSync(dirname(D + path), { recursive: true });
  writeFileSync(D + path, text);
  user.mkdir(dirname(path).slice(1), { recursive: true });
  user.writeFile(path.slice(1), text);
}
const pkg = (dir, json, files = {}) => {
  put(`${dir}/package.json`, JSON.stringify(json));
  for (const [file, text] of Object.entries(files)) put(`${dir}/${file}`, text);
};
function link(target, path) {
  mkdirSync(dirname(D + path), { recursive: true });
  symlinkSync(target, D + path);
  user.mkdir(dirname(path).slice(1), { recursive: true });
  user.symlink(target, path.slice(1));
}
const BIN = '#!/usr/bin/env node\n';

/** What is under `dir`, npm's lockfiles aside: each entry, a link with its target. */
function diskTree(dir, at = '') {
  if (!existsSync(D + dir)) return [];
  return readdirSync(D + dir).sort().flatMap((name) => {
    const rel = at + name;
    if (rel === 'package-lock.json' || rel === 'node_modules/.package-lock.json') return [];
    const stat = lstatSync(join(D + dir, name));
    if (stat.isSymbolicLink()) return [`${rel} -> ${readlinkSync(join(D + dir, name))}`];
    return stat.isDirectory() ? [`${rel}/`, ...diskTree(`${dir}/${name}`, `${rel}/`)] : [rel];
  });
}
function sessionTree(dir, at = '') {
  const key = dir.slice(1);
  let entries;
  try { entries = user.readdir(key); } catch { return []; }
  return entries.map((entry) => entry.name).sort().flatMap((name) => {
    const rel = at + name;
    const stat = user.lstat(`${key}/${name}`);
    if (stat.type === 'symlink') return [`${rel} -> ${user.readlink(`${key}/${name}`)}`];
    return stat.type === 'directory' ? [`${rel}/`, ...sessionTree(`${dir}/${name}`, `${rel}/`)] : [rel];
  });
}
const sessionFile = (path) => (user.exists(path.slice(1)) ? user.readFileString(path.slice(1)) : '(absent)');
const diskFile = (path) => (existsSync(D + path) ? readFileSync(D + path, 'utf8') : '(absent)');

const mismatches = [];
/** One case: `args` in `cwd` under both, then what each printed and left (`files`, `trees`). */
async function both(label, cwd, args, { files = [], trees = [] } = {}) {
  const real = spawnSync('npm', [...args, '--offline', '--no-audit', '--no-fund', '--logs-max=0'], { cwd: D + cwd, env: npmEnv, encoding: 'utf8' });
  const session = await runtime.exec(`cd ${cwd} && npm_config_prefix=${PREFIX} npm ${args.join(' ')}`);
  const summaryTime = (text) => text.replace(/ in \d+(?:ms|s|m|h|d)\n/g, ' in <time>\n');
  const npm = {
    status: real.status,
    stdout: summaryTime(real.stdout.replaceAll(D, '')),
    stderr: real.stderr.replaceAll(D, '').replace(/^npm error Log files were not written due to the config logs-max=0\n/m, ''),
    files: Object.fromEntries(files.map((path) => [path, diskFile(path)])),
    trees: Object.fromEntries(trees.map((dir) => [dir, diskTree(dir)])),
  };
  const ours = {
    status: session.exitCode,
    stdout: summaryTime(session.stdout),
    stderr: session.stderr,
    files: Object.fromEntries(files.map((path) => [path, sessionFile(path)])),
    trees: Object.fromEntries(trees.map((dir) => [dir, sessionTree(dir)])),
  };
  try {
    assert.deepEqual(ours, npm);
    console.log(`  ${label}: as npm`);
  } catch {
    const differ = Object.keys(npm).filter((key) => JSON.stringify(ours[key]) !== JSON.stringify(npm[key]));
    mismatches.push([`${label}: npm ${args.join(' ')}`, ...differ.flatMap((key) => [`  npm  ${key}: ${JSON.stringify(npm[key])}`, `  ours ${key}: ${JSON.stringify(ours[key])}`])].join('\n'));
    console.log(`  ${label}: DIFFERS`);
  }
}

try {
  // ── npm ls ───────────────────────────────────────────────────────────────
  const L = `${HOME}/proj`;
  pkg(`${HOME}/linked`, { name: 'linked', version: '3.0.0' });
  pkg(L, {
    name: 'p', version: '1.0.0',
    dependencies: { a: '^1.0.0', b: '^1.0.0', z: '^2.0.0', linked: 'file:../linked', al: 'npm:real@^1.0.0' },
    devDependencies: { d: '1.0.0' }, optionalDependencies: { o: '^1.0.0' },
    peerDependencies: { pe: '^1.0.0', po: '^1.0.0' }, peerDependenciesMeta: { po: { optional: true } },
  });
  pkg(`${L}/node_modules/a`, { name: 'a', version: '1.2.0', dependencies: { t: '^1.0.0' } });
  pkg(`${L}/node_modules/t`, { name: 't', version: '1.0.0' });
  pkg(`${L}/node_modules/d`, { name: 'd', version: '1.0.0' });
  pkg(`${L}/node_modules/x`, { name: 'x', version: '1.0.0' });
  pkg(`${L}/node_modules/z`, { name: 'z', version: '1.0.0' });
  pkg(`${L}/node_modules/al`, { name: 'real', version: '1.0.0' });
  pkg(`${L}/node_modules/@sc/tool`, { name: '@sc/tool', version: '2.0.0' });
  link('../../linked', `${L}/node_modules/linked`);
  await both('ls: declared, missing, invalid, aliased, linked and extraneous', L, ['ls']);

  pkg(`${PREFIX}/lib/node_modules/g1`, { name: 'g1', version: '1.0.0', bin: { g1: 'cli.js' } }, { 'cli.js': BIN });
  pkg(`${PREFIX}/lib/node_modules/@gs/g2`, { name: '@gs/g2', version: '2.0.0' });
  link('../lib/node_modules/g1/cli.js', `${PREFIX}/bin/g1`);
  await both('ls -g: the global prefix', L, ['ls', '-g']);
  await both('ls --global', L, ['ls', '--global']);
  await both('ls --location=global', L, ['ls', '--location=global']);
  await both('ls --global=false: the project', L, ['ls', '--global=false']);

  const B = `${HOME}/bare`;
  pkg(`${B}/node_modules/plain`, { name: 'plain', version: '1.0.0' });
  pkg(`${B}/node_modules/@sc/tool`, { name: '@sc/tool', version: '2.0.0' });
  link('../../linked', `${B}/node_modules/linked`);
  await both('ls: no package.json', B, ['ls']);
  pkg(`${HOME}/empty`, { name: 'e', version: '1.0.0' });
  await both('ls: nothing declared or installed', `${HOME}/empty`, ['ls']);
  pkg(`${HOME}/nv`, { name: 'nv', dependencies: { a: '1.0.0' } });
  pkg(`${HOME}/nv/node_modules/a`, { name: 'a', version: '1.0.0' });
  await both('ls: a root with no version', `${HOME}/nv`, ['ls']);
  put(`${HOME}/eo/package.json`, '{}');
  await both('ls: an empty package.json', `${HOME}/eo`, ['ls']);
  put(`${HOME}/corrupt/package.json`, '{"name": "c",');
  pkg(`${HOME}/corrupt/node_modules/a`, { name: 'a', version: '1.0.0' });
  await both('ls: a corrupt package.json', `${HOME}/corrupt`, ['ls']);
  pkg(`${HOME}/nodir`, { name: 'nd', version: '1.0.0', dependencies: { a: '^1.0.0' } });
  await both('ls: only a missing dependency', `${HOME}/nodir`, ['ls']);
  const S = `${HOME}/sort`;
  const names = ['Zed', 'alpha', '@b/c', 'a-b', 'a_b', 'ab'];
  pkg(S, { name: 's', version: '1.0.0', dependencies: Object.fromEntries(names.map((name) => [name, '1.0.0'])) });
  for (const name of names) pkg(`${S}/node_modules/${name}`, { name, version: '1.0.0' });
  await both('ls: npm\'s order', S, ['ls']);

  // ── npm uninstall ────────────────────────────────────────────────────────
  const U1 = `${HOME}/u1`;
  pkg(U1, { name: 'u1', version: '1.0.0', dependencies: { p: '^1.0.0' } });
  pkg(`${U1}/node_modules/p`, { name: 'p', version: '1.0.0', bin: { pbin: 'cli.js' } }, { 'cli.js': BIN });
  link('../p/cli.js', `${U1}/node_modules/.bin/pbin`);
  pkg(`${PREFIX}/lib/node_modules/p`, { name: 'p', version: '1.0.0', bin: { pbin: 'cli.js' } }, { 'cli.js': BIN });
  link('../lib/node_modules/p/cli.js', `${PREFIX}/bin/pbin`);
  await both('uninstall -g: the global package and its bin, not the project\'s', U1, ['uninstall', '-g', 'p'], { files: [`${U1}/package.json`], trees: [PREFIX, U1] });

  const U2 = `${HOME}/u2`;
  put(`${U2}/package.json`, JSON.stringify({
    name: 'u2', version: '1.0.0',
    dependencies: { zz: '^1.0.0', a: '^1.0.0', b: '^1.0.0' }, devDependencies: { b: '^1.0.0' },
    peerDependencies: { b: '^1.0.0' }, peerDependenciesMeta: { b: { optional: true } }, optionalDependencies: { b: '^1.0.0' },
    bundleDependencies: ['b', 'a'],
  }, null, '\t') + '\n');
  pkg(`${U2}/node_modules/a`, { name: 'a', version: '1.0.0' });
  pkg(`${U2}/node_modules/zz`, { name: 'zz', version: '1.0.0' });
  await both('uninstall: every declaration of a package that is not installed', U2, ['uninstall', 'b'], { files: [`${U2}/package.json`], trees: [U2] });

  const U3 = `${HOME}/u3`;
  pkg(U3, { name: 'u3', version: '1.0.0', dependencies: { a: '^1.0.0', k: '^1.0.0' } });
  pkg(`${U3}/node_modules/a`, { name: 'a', version: '1.0.0', bin: { abin: 'cli.js' } }, { 'cli.js': BIN });
  pkg(`${U3}/node_modules/k`, { name: 'k', version: '1.0.0' });
  link('../a/cli.js', `${U3}/node_modules/.bin/abin`);
  await both('uninstall: an installed package, its bin and its declaration', U3, ['uninstall', 'a'], { files: [`${U3}/package.json`], trees: [U3] });
  await both('uninstall: a name with a version names nothing', U3, ['uninstall', 'k@1.0.0'], { files: [`${U3}/package.json`], trees: [U3] });

  const U4 = `${HOME}/u4`;
  pkg(U4, { name: 'u4', version: '1.0.0', dependencies: { a: '^1.0.0' } });
  pkg(`${U4}/node_modules/a`, { name: 'a', version: '1.0.0', bin: { abin: 'cli.js' } }, { 'cli.js': BIN });
  link('../a/cli.js', `${U4}/node_modules/.bin/abin`);
  await both('uninstall --no-save: package.json as it was', U4, ['uninstall', '--no-save', 'a'], { files: [`${U4}/package.json`], trees: [U4] });

  const U5 = `${HOME}/u5`;
  put(`${U5}/package.json`, '{"name":"p","version":"1.0.0","dependencies":{"a":"1.0.0"},"scripts":{"hello":"echo hello-script"}}');
  await both('uninstall: the only dependency, never installed', U5, ['uninstall', 'a'], { files: [`${U5}/package.json`], trees: [U5] });

  const U6 = `${HOME}/u6`;
  pkg(U6, { name: 'u6', version: '1.0.0' });
  await both('uninstall: a package neither declared nor installed', U6, ['uninstall', 'nothere'], { files: [`${U6}/package.json`], trees: [U6] });
  await both('uninstall: no name', U6, ['uninstall']);

  const U9 = `${HOME}/u9`;
  pkg(U9, { name: 'u9', version: '1.0.0', dependencies: { '@s/a': '^1.0.0' } });
  pkg(`${U9}/node_modules/@s/a`, { name: '@s/a', version: '1.0.0', bin: 'cli.js' }, { 'cli.js': BIN });
  link('../@s/a/cli.js', `${U9}/node_modules/.bin/a`);
  await both('uninstall: a scoped package and the bin named for it', U9, ['uninstall', '@s/a'], { files: [`${U9}/package.json`], trees: [U9] });

  // An explicit false is local, however it is spelled; `both` is installed in the project and globally.
  pkg(`${PREFIX}/lib/node_modules/both`, { name: 'both', version: '1.0.0', bin: { bothbin: 'cli.js' } }, { 'cli.js': BIN });
  link('../lib/node_modules/both/cli.js', `${PREFIX}/bin/bothbin`);
  for (const [i, flag] of [['--global=false'], ['-g=false'], ['--global', 'false']].entries()) {
    const U = `${HOME}/uf${i}`;
    pkg(U, { name: `uf${i}`, version: '1.0.0', dependencies: { both: '^1.0.0' } });
    pkg(`${U}/node_modules/both`, { name: 'both', version: '1.0.0', bin: { bothbin: 'cli.js' } }, { 'cli.js': BIN });
    link('../both/cli.js', `${U}/node_modules/.bin/bothbin`);
    await both(`uninstall ${flag.join(' ')}: the project's package`, U, ['uninstall', ...flag, 'both'], { files: [`${U}/package.json`], trees: [PREFIX, U] });
  }

  assert.deepEqual(mismatches, [], `${mismatches.length} case(s) differ from npm ${npmVersion}:\n\n${mismatches.join('\n\n')}`);
} finally {
  await runtime.close();
  rmSync(D, { recursive: true, force: true });
}
console.log('npm-uninstall-ls-matches-npm: ok');
