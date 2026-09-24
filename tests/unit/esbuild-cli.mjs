#!/usr/bin/env bun
// The `esbuild` command is the real esbuild CLI, run as the calling process
// from its working directory.
//
// The command used to hand its flags to an in-session esbuild service as they
// were typed: `cd ~/app && esbuild src/main.jsx --bundle --outfile=dist/bundle.js`
// wrote /dist/bundle.js, owned by root, because only the entry points were
// resolved against the cwd and every write went through a kernel view. A
// build with no --outfile or --outdir went to a /dist that real esbuild has
// never had, rather than to stdout.
//
// Driven through a workspace shell, with the runner production stages for the
// session's esbuild facet (the asset ESBUILD_CLI_ASSET_PATH names) evaluated
// here instead, the real esbuild.wasm, and a filesystem whose owners and
// permissions are the ones the session enforces.

import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { Database } from 'bun:sqlite';
import { createSqliteVfsTestHarness } from './sqlite-vfs-test-harness.mjs';
import { NimbusWorkspace } from '../../packages/core/src/workspace/nimbus-workspace.ts';
import { vfsSupervisor } from '../../packages/core/src/runtime/vfs-supervisor.ts';
import { makeEsbuildCommand } from '../../packages/core/src/runtime/esbuild-cli.ts';
import { ESBUILD_CLI_ASSET_PATH } from '../../packages/worker/src/esbuild-cli-artifact.generated.ts';

const KERNEL = { uid: 0, gid: 0, groups: [0], umask: 0o022 };
const USER = { uid: 1000, gid: 1000, groups: [1000], umask: 0o022 };

const resolveFromCore = createRequire(new URL('../../packages/core/package.json', import.meta.url));
const wasm = new WebAssembly.Module(await readFile(resolveFromCore.resolve('esbuild-wasm/esbuild.wasm')));
new Function(await readFile(new URL(`../../packages/worker/public${ESBUILD_CLI_ASSET_PATH}`, import.meta.url), 'utf8'))();

const harness = createSqliteVfsTestHarness(new Database(':memory:'));
const ws = await NimbusWorkspace.create({
  sql: harness.sql,
  transactions: harness.ctx,
  generation: 1,
  cwd: '/home/user',
});
ws.registry.register('esbuild', makeEsbuildCommand({
  run: (args, ctx, output) => globalThis.__esbuildCliRun(args, vfsSupervisor(ctx.vfs.authority), output, wasm),
}));

const user = ws.vfs.as(USER);
const kernel = ws.vfs.as(KERNEL);
const write = (path, text) => {
  user.mkdir(path.replace(/\/[^/]+$/, ''), { recursive: true });
  user.writeFile(path, text);
};
write('home/user/app/package.json', JSON.stringify({ name: 'app', private: true }));
write('home/user/app/src/main.js', "import { greet } from 'greeter';\nimport { shout } from '@lib/shout';\nconsole.log(shout(greet('app')));\n");
write('home/user/app/src/lib/shout.js', 'export const shout = (s) => s.toUpperCase();\n');
write('home/user/app/src/other.js', "console.log('OTHER_ENTRY');\n");
write('home/user/app/config/tsconfig.build.json', JSON.stringify({
  compilerOptions: { baseUrl: '..', paths: { '@lib/*': ['src/lib/*'] } },
}));
write('home/user/app/node_modules/greeter/package.json', JSON.stringify({ name: 'greeter', main: 'index.js' }));
write('home/user/app/node_modules/greeter/index.js', "exports.greet = (name) => 'GREETER_MARKER hello ' + name;\n");


// ── Output paths resolve against the caller's cwd, as the caller ─────────────
{
  const run = await ws.exec('cd /home/user/app && esbuild src/main.js --bundle --outfile=dist/bundle.js --tsconfig=config/tsconfig.build.json');
  assert.equal(run.exitCode, 0, `esbuild failed: ${run.stderr}`);
  assert.match(run.stderr, /dist\/bundle\.js/, 'esbuild prints its own summary, relative to the cwd');
  const bundle = user.readFileString('home/user/app/dist/bundle.js');
  assert.match(bundle, /GREETER_MARKER/, 'the node_modules dependency is bundled');
  assert.match(bundle, /toUpperCase/, '--tsconfig resolved against the cwd supplies the @lib alias');
  assert.equal(kernel.exists('dist'), false, 'nothing is written at the filesystem root');
  const stat = kernel.stat('home/user/app/dist/bundle.js');
  assert.deepEqual([stat.uid, stat.gid], [USER.uid, USER.gid], 'the output belongs to the user who ran the build');
  assert.equal(stat.mode & 0o777, 0o644);
  assert.deepEqual([kernel.stat('home/user/app/dist').uid, kernel.stat('home/user/app/dist').mode & 0o777], [USER.uid, 0o755]);
  console.log('  ok  --outfile, --tsconfig and entry points resolve against the cwd; the output is the user\'s');
}

// ── No output flag: stdout, as real esbuild ──────────────────────────────────
{
  const run = await ws.exec('cd /home/user/app && esbuild src/main.js --bundle --format=esm --tsconfig=config/tsconfig.build.json');
  assert.equal(run.exitCode, 0, `esbuild failed: ${run.stderr}`);
  assert.match(run.stdout, /GREETER_MARKER/, 'the bundle is written to stdout');
  assert.equal(kernel.exists('dist'), false);
  assert.deepEqual(user.readdir('home/user/app').map((e) => e.name).sort(), ['config', 'dist', 'node_modules', 'package.json', 'src']);
  console.log('  ok  without --outfile or --outdir the bundle goes to stdout and no directory is created');
}

// ── --outdir, and esbuild's own refusal without it ──────────────────────────
{
  const run = await ws.exec('cd /home/user/app/src && esbuild main.js other.js --bundle --outdir=../out --tsconfig=../config/tsconfig.build.json');
  assert.equal(run.exitCode, 0, `esbuild failed: ${run.stderr}`);
  assert.match(user.readFileString('home/user/app/out/other.js'), /OTHER_ENTRY/);
  assert.match(user.readFileString('home/user/app/out/main.js'), /GREETER_MARKER/);
  const refused = await ws.exec('cd /home/user/app/src && esbuild main.js other.js --bundle');
  assert.equal(refused.exitCode, 1);
  assert.match(refused.stderr, /Must use "outdir" when there are multiple input files/);
  console.log('  ok  --outdir resolves against the cwd; several entries without it are refused by esbuild');
}

// ── Reads happen as the caller ───────────────────────────────────────────────
{
  kernel.mkdir('private', { mode: 0o700 });
  kernel.writeFile('private/secret.js', "export default 'KERNEL_ONLY';\n");
  write('home/user/app/src/steal.js', "import secret from '/private/secret.js';\nconsole.log(secret);\n");
  const run = await ws.exec('cd /home/user/app && esbuild src/steal.js --bundle --outfile=dist/steal.js');
  assert.equal(run.exitCode, 1, 'a file the caller cannot read is not bundled');
  assert.doesNotMatch(run.stdout + run.stderr, /KERNEL_ONLY/);
  assert.equal(user.exists('home/user/app/dist/steal.js'), false);
  console.log('  ok  a file the caller cannot read stays unread');
}

// ── stdin, when there is no entry point ──────────────────────────────────────
{
  const run = await ws.exec("printf 'let answer: number = 42;\\n' | esbuild --loader=ts");
  assert.equal(run.exitCode, 0, `esbuild failed: ${run.stderr}`);
  assert.equal(run.stdout, 'let answer = 42;\n');
  console.log('  ok  with no entry point esbuild transforms stdin');
}

// ── A build that has to outlive the command is refused, not orphaned ────────
{
  const run = await ws.exec('cd /home/user/app && esbuild src/main.js --bundle --outfile=dist/w.js --watch');
  assert.equal(run.exitCode, 1);
  assert.match(run.stderr, /--watch is not supported/);
  assert.equal(user.exists('home/user/app/dist/w.js'), false);
  console.log('  ok  --watch is refused before anything runs');
}

await ws.close();
console.log('esbuild-cli OK');
