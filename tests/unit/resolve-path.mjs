#!/usr/bin/env bun
// A bare command name that nothing registers is found on the invoking
// environment's PATH, as execvp searches it, and the file found is the file
// that runs: by the shell, `PATH=x cmd`, `command -v`, `which`, `type`, and a
// Worker program's child_process.spawn.
//
// The workspace is configured with HOME=/home/main, whose PATH ends in
// /home/main/.local/bin. Two CLIs live only there: one an npm package's bin
// shim, linked the way `npm i -g` links it, and one a `#!/bin/sh` script.
// /home/user/.local/bin, on the default PATH but not on this one, holds a
// different `tool`, which must never be what runs; and /custom/bin holds
// commands only a PATH naming it finds.

import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { NimbusWorkspace } from '../../packages/core/src/workspace/nimbus-workspace.ts';
import { CRED_KERNEL } from '../../packages/core/src/runtime/os-contracts.ts';
import { registerShellEntrypointCommands } from '../../packages/core/src/shell/shell-entrypoints.ts';
import { installNpmBinFallbackResolver } from '../../packages/worker/src/shell/npm-bin-entrypoints.ts';
import { materializeNpmBinShims } from '../../packages/worker/src/npm/bin-links.ts';
import { createSqliteVfsTestHarness } from './sqlite-vfs-test-harness.mjs';

/** A workspace as the session builds one: shell entrypoints, then the npm bin fallback. */
async function workspace(env) {
  const harness = createSqliteVfsTestHarness();
  const ws = await NimbusWorkspace.create({ sql: harness.sql, transactions: harness.ctx, ...(env ? { env } : {}) });
  registerShellEntrypointCommands(ws.registry, { execute: (command, options) => ws.shell.execute(command, options) });
  installNpmBinFallbackResolver(ws.registry, {
    filesystem: ws.filesystem,
    getCwd: () => ws.shell.getCwd(),
    processes: ws.processes,
    getFacetManager() { throw new Error('unexpected staged artifact'); },
    notifyTerminalEvent() {},
    async runtimeCommandHint() { return null; },
    emitShellExecDone() {},
  });
  return ws;
}

/** Install the two CLIs under `home`/.local/bin, owned by the user, and a decoy `tool` in /home/user/.local/bin. */
async function installClis(ws, home) {
  const kernel = ws.vfs.as(CRED_KERNEL);
  const prefix = `${home.slice(1)}/.local/lib/node_modules`;
  kernel.mkdir(`${prefix}/hello-cli`, { recursive: true });
  kernel.writeFile(`${prefix}/hello-cli/package.json`, JSON.stringify({ name: 'hello-cli', version: '1.0.0', bin: { 'hello-cli': 'cli.js' } }));
  kernel.writeFile(`${prefix}/hello-cli/cli.js`, 'console.log("hello-cli " + process.argv.slice(2).join(" ") + " in " + process.cwd());\n');
  assert.equal(await materializeNpmBinShims(kernel, prefix, `${home.slice(1)}/.local/bin`), 1);
  kernel.writeFile(`${home.slice(1)}/.local/bin/tool`, '#!/bin/sh\necho "tool $* in $(pwd)"\n');
  kernel.chmod(`${home.slice(1)}/.local/bin/tool`, 0o755);
  if (home !== '/home/user') {
    kernel.mkdir('home/user/.local/bin', { recursive: true });
    kernel.writeFile('home/user/.local/bin/tool', '#!/bin/sh\necho "the default home\'s tool"\n');
    kernel.chmod('home/user/.local/bin/tool', 0o755);
  }
  kernel.mkdir('custom/bin', { recursive: true });
  kernel.writeFile('custom/bin/tool', '#!/bin/sh\necho "custom tool $*"\n');
  kernel.chmod('custom/bin/tool', 0o755);
  kernel.writeFile('custom/bin/custom-only', '#!/bin/sh\necho "custom only"\n');
  kernel.chmod('custom/bin/custom-only', 0o755);
  kernel.mkdir('noexec/bin', { recursive: true });
  kernel.writeFile('noexec/bin/tool', '#!/bin/sh\necho "never"\n');
  kernel.chmod('noexec/bin/tool', 0o644);
  // Executable, but only by its owner, root.
  kernel.mkdir('rootonly/bin', { recursive: true });
  kernel.writeFile('rootonly/bin/tool', '#!/bin/sh\necho "root only"\n');
  kernel.chmod('rootonly/bin/tool', 0o744);
}

const run = async (ws, line, cwd = '/tmp') => {
  const result = await ws.exec(line, { cwd });
  return [result.stdout, result.stderr, result.exitCode];
};

// ── HOME=/home/main: the CLIs on its PATH run by bare name from /tmp ───────
const main = await workspace({ HOME: '/home/main' });
await installClis(main, '/home/main');
const mainPath = (await run(main, 'printf %s "$PATH"'))[0];
assert.match(mainPath, /:\/home\/main\/\.local\/bin:/);
assert.deepEqual(await run(main, 'hello-cli a b'), ['hello-cli a b in /tmp\n', '', 0], 'the npm bin runs by its bare name');
assert.deepEqual(await run(main, 'tool a b'), ['tool a b in /tmp\n', '', 0], 'and so does a #!/bin/sh script on PATH');
assert.deepEqual(await run(main, 'command -v hello-cli; command -v tool'), ['/home/main/.local/bin/hello-cli\n/home/main/.local/bin/tool\n', '', 0]);
assert.deepEqual(await run(main, 'which hello-cli tool'), ['/home/main/.local/bin/hello-cli\n/home/main/.local/bin/tool\n', '', 0]);
assert.deepEqual(await run(main, 'type tool'), ['tool is /home/main/.local/bin/tool\n', '', 0], 'type says it is a file');
assert.deepEqual(await run(main, 'sh -c "tool from sh"'), ['tool from sh in /tmp\n', '', 0], 'a script\'s command finds it too');
// A wasm binary on PATH runs under the wasm runner, as it does by its path.
{
  main.vfs.as(CRED_KERNEL).writeFile('home/main/.local/bin/wasmtool', new Uint8Array([0x00, 0x61, 0x73, 0x6d, 0x01, 0x00, 0x00, 0x00]));
  main.vfs.as(CRED_KERNEL).chmod('home/main/.local/bin/wasmtool', 0o755);
  main.registry.register('wasm-runner', async (ctx) => { await ctx.stdout.write(`wasm ${ctx.args.join(' ')}\n`); return 0; });
  assert.deepEqual(await run(main, 'wasmtool w'), ['wasm /home/main/.local/bin/wasmtool w\n', '', 0]);
}

// ── The invoking PATH, and only it, decides ───────────────────────────────
assert.deepEqual(await run(main, 'PATH=/custom/bin tool x'), ['custom tool x\n', '', 0], 'a PATH=x prefix is searched');
assert.deepEqual(await run(main, 'PATH=/custom/bin custom-only'), ['custom only\n', '', 0], 'for a name on no other PATH');
assert.deepEqual(await run(main, 'PATH=/custom/bin:$PATH tool'), ['custom tool \n', '', 0], 'in order');
assert.deepEqual(await run(main, 'PATH=/noexec/bin:/custom/bin tool'), ['custom tool \n', '', 0], 'a file that is not executable is passed over');
assert.deepEqual(await run(main, 'PATH=/noexec/bin tool; echo s=$?'), ['s=126\n', '/noexec/bin/tool: Permission denied\n', 0], 'and is EACCES when nothing else is found');
assert.deepEqual(await run(main, 'PATH=/rootonly/bin:/custom/bin tool; echo s=$?'), ['custom tool \ns=0\n', '', 0], 'a file the caller may not execute is passed over');
assert.deepEqual(await run(main, 'PATH=/rootonly/bin:/custom/bin which tool'), ['/custom/bin/tool\n', '', 0], 'by which too');
assert.deepEqual(await run(main, 'PATH=/rootonly/bin tool; echo s=$?'), ['s=126\n', '/rootonly/bin/tool: Permission denied\n', 0]);
// bash names the file it would fail to run; which (debianutils) finds no executable and prints nothing.
assert.deepEqual(await run(main, 'PATH=/noexec/bin command -v tool; PATH=/noexec/bin type tool; PATH=/noexec/bin which -as tool; echo s=$?'),
  ['/noexec/bin/tool\ntool is /noexec/bin/tool\ns=1\n', '', 0], 'what is found but cannot run is a file, not a builtin');
assert.deepEqual(await run(main, 'PATH=/custom/bin command -v tool'), ['/custom/bin/tool\n', '', 0]);
assert.deepEqual(await run(main, 'PATH=/usr/bin hello-cli; echo s=$?'), ['s=127\n', 'hello-cli: command not found\n', 0], 'off PATH, nothing is found');
assert.deepEqual(await run(main, 'PATH= tool; echo s=$?', '/custom/bin'), ['custom tool \ns=0\n', '', 0], 'an empty entry is the current directory');
assert.deepEqual(await run(main, '(export PATH=/custom/bin; tool)'), ['custom tool \n', '', 0], 'an exported PATH is searched');
assert.equal((await run(main, 'printf %s "$PATH"'))[0], mainPath);

// ── An npm bin shim by its path runs only if the caller may execute it ────
{
  const kernel = main.vfs.as(CRED_KERNEL);
  kernel.chmod('home/main/.local/bin/hello-cli', 0o744);
  kernel.chown('home/main/.local/bin/hello-cli', 0, 0);
  assert.deepEqual(await run(main, '/home/main/.local/bin/hello-cli; echo s=$?'), ['s=126\n', '/home/main/.local/bin/hello-cli: Permission denied\n', 0]);
  assert.deepEqual(await run(main, 'hello-cli; echo s=$?'), ['s=126\n', '/home/main/.local/bin/hello-cli: Permission denied\n', 0], 'nor by its bare name');
  kernel.chmod('home/main/.local/bin/hello-cli', 0o755);
}

// ── child_process.spawn in a Worker program searches the child's PATH ─────
{
  const outputDir = await mkdtemp(join(tmpdir(), 'nimbus-resolve-path-'));
  try {
    const build = await Bun.build({
      entrypoints: ['./packages/worker/src/session/nimbus-session.ts', './packages/worker/src/hosted/services.ts'],
      outdir: outputDir,
      target: 'bun',
      format: 'esm',
      plugins: [{
        name: 'cloudflare-workers-test-stub',
        setup(builder) {
          builder.onResolve({ filter: /^cloudflare:workers$/ }, () => ({ path: 'cloudflare-workers', namespace: 'test' }));
          builder.onLoad({ filter: /.*/, namespace: 'test' }, () => ({
            contents: 'export class DurableObject {}; export class WorkerEntrypoint {};',
            loader: 'js',
          }));
        },
      }],
    });
    assert.equal(build.success, true, build.logs.map(String).join('\n'));
    const { NimbusSession } = await import(pathToFileURL(build.outputs.find((o) => o.path.endsWith('/nimbus-session.js')).path).href);
    const { bindRuntimeServices } = await import(pathToFileURL(build.outputs.find((o) => o.path.endsWith('/services.js')).path).href);

    const session = Object.create(NimbusSession.prototype);
    session.ctx = { facets: {} };
    session.env = {};
    Object.assign(session, bindRuntimeServices(session, {
      ctx: session.ctx,
      env: session.env,
      notify() {},
      async requestLaunchTurn() { return true; },
    }));
    session.sqliteFs = main.vfs;
    session.processes = main.processes;
    session.facetManagerComposed = { manager: { setVfs() {} }, apps: {}, pumpLaunches: async () => {} };
    session.facetProcessManager = null;
    session.esbuildService = null;
    session._setCpRegistry(main.registry);
    const parent = main.processes.spawn('node', ['app.js'], '/tmp');

    const spawn = async (command, args, env) => {
      const { childPid } = await session._rpcCpSpawn({ command, args, env, cwd: '/tmp', stdio: ['pipe', 'pipe', 'pipe'], parentPid: parent.pid });
      await session._rpcCpStdinEnd(childPid);
      const waited = await session._rpcCpWait(childPid, 5_000);
      assert.equal(waited.done, true, `${command} completed`);
      const output = await session._rpcCpDrainOutput(childPid);
      return [new TextDecoder().decode(output.stdout), new TextDecoder().decode(output.stderr), waited.exitCode];
    };
    const env = { HOME: '/home/main', PATH: mainPath };
    assert.deepEqual(await spawn('tool', ['x'], env), ['tool x in /tmp\n', '', 0], 'spawn finds a script on the child\'s PATH');
    assert.deepEqual(await spawn('hello-cli', ['y'], env), ['hello-cli y in /tmp\n', '', 0], 'and an npm bin');
    assert.deepEqual(await spawn('tool', [], { PATH: '/custom/bin' }), ['custom tool \n', '', 0], 'by the PATH it is given');
    assert.deepEqual(await spawn('no-such-tool', [], env), ['', 'no-such-tool: command not found\n', 127]);
    // A facet-direct name (yorkie) found in the cwd's node_modules/.bin, through the facet dispatch path.
    {
      const kernel = main.vfs.as(CRED_KERNEL);
      kernel.mkdir('tmp/project/node_modules/.bin', { recursive: true });
      kernel.writeFile('tmp/project/node_modules/.bin/yorkie', '#!/bin/sh\necho YORKIE\n');
      kernel.chmod('tmp/project/node_modules/.bin/yorkie', 0o755);
      const { childPid } = await session._rpcCpSpawn({ command: 'yorkie', args: [], env, cwd: '/tmp/project', stdio: ['pipe', 'pipe', 'pipe'], parentPid: parent.pid });
      await session._rpcCpStdinEnd(childPid);
      const waited = await session._rpcCpWait(childPid, 5_000);
      const output = await session._rpcCpDrainOutput(childPid);
      assert.deepEqual([new TextDecoder().decode(output.stdout), new TextDecoder().decode(output.stderr), waited.exitCode], ['YORKIE\n', '', 0]);
    }
  } finally {
    await rm(outputDir, { recursive: true, force: true });
  }
}
await main.close();

// ── No HOME: the default home's PATH, unchanged ───────────────────────────
{
  const plain = await workspace(undefined);
  await installClis(plain, '/home/user');
  assert.equal((await run(plain, 'printf %s "$PATH"'))[0], '/usr/local/bin:/usr/bin:/bin:/home/user/.local/bin:/home/user/.gem/bin');
  assert.deepEqual(await run(plain, 'tool z'), ['tool z in /tmp\n', '', 0]);
  assert.deepEqual(await run(plain, 'hello-cli z'), ['hello-cli z in /tmp\n', '', 0]);
  assert.deepEqual(await run(plain, 'command -v node; command -v ls; type ls; which ls; echo s=$?'), ['/usr/local/bin/node\nls\nls is a shell builtin\ns=1\n', '', 0], 'builtins report as before');
  assert.deepEqual(await run(plain, 'no-such-tool; echo s=$?'), ['s=127\n', 'no-such-tool: command not found\n', 0]);
  await plain.close();
}

console.log('resolve-path: bare names follow the invoking PATH');
