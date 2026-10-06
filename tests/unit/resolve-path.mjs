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
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { NimbusWorkspace } from '../../packages/core/src/workspace/nimbus-workspace.ts';
import { CRED_KERNEL } from '../../packages/core/src/runtime/os-contracts.ts';
import { registerShellEntrypointCommands } from '../../packages/core/src/shell/shell-entrypoints.ts';
import { installNpmBinFallbackResolver } from '../../packages/worker/src/shell/npm-bin-entrypoints.ts';
import { materializeNpmBinShims } from '../../packages/worker/src/npm/bin-links.ts';
import { MemoryVFS } from '../../packages/core/src/vfs/memory.ts';
import { searchPath } from '../../packages/core/src/shell/exec-dispatch.ts';
import { resolveContext } from '../../packages/core/src/substrate/lifo/commands/registry.ts';
import { installRubyGems } from '../../packages/core/src/runtime/ruby-gems.ts';
import { syscallError } from '../../packages/core/src/vfs/vfs-error.ts';
import { createSqliteVfsTestHarness } from './sqlite-vfs-test-harness.mjs';
import { importWorkerBundle } from './lib/worker-bundle.mjs';

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
    // Runtimes the workspace knows how to install, and has not.
    async runtimeCommandHint(name) { return ['hintedtool', 'clang'].includes(name) ? { installSpec: name } : null; },
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

// ── An absolute #! interpreter is that file, or a registered one by its name; only env searches PATH ──
{
  const kernel = main.vfs.as(CRED_KERNEL);
  kernel.writeFile('custom/bin/myinterp', '#!/bin/sh\necho "custom interpreter $*"\n');
  kernel.chmod('custom/bin/myinterp', 0o755);
  kernel.writeFile('tmp/missing.sh', '#!/missing/interpreter/myinterp\n');
  kernel.writeFile('tmp/viaenv.sh', '#!/usr/bin/env myinterp\n');
  kernel.writeFile('tmp/virtual.sh', '#!/bin/sh\necho virtual sh\n');
  for (const script of ['missing', 'viaenv', 'virtual']) kernel.chmod(`tmp/${script}.sh`, 0o755);
  assert.deepEqual(await run(main, 'PATH=/custom/bin /tmp/missing.sh; echo s=$?'),
    ['s=127\n', '/tmp/missing.sh: /missing/interpreter/myinterp: bad interpreter: No such file or directory\n', 0], 'an absolute interpreter is not searched for on PATH');
  assert.deepEqual(await run(main, 'PATH=/custom/bin /tmp/viaenv.sh'), ['custom interpreter /tmp/viaenv.sh\n', '', 0], 'env searches PATH');
  assert.deepEqual(await run(main, 'PATH=/custom/bin /tmp/virtual.sh'), ['virtual sh\n', '', 0], 'a registered interpreter answers its absolute path');
}

// ── A PATH directory that fails (EIO) finds nothing for command -v, type and which; running is the error ──
{
  const failing = new Proxy(new MemoryVFS({ uid: 0, gid: 0 }), {
    get(target, key) {
      if (key === 'sync') return undefined;
      if (key === 'stat') return async (path) => { throw syscallError('EIO', 'stat', path); };
      const value = Reflect.get(target, key);
      return typeof value === 'function' ? value.bind(target) : value;
    },
    has(target, key) { return key !== 'sync' && key in target; },
  });
  main.filesystem.vfs.mount('/gone', failing);
  assert.deepEqual(await run(main, 'PATH=/gone command -v never-installed; echo s=$?'), ['s=1\n', '', 0]);
  assert.deepEqual(await run(main, 'PATH=/gone type never-installed; echo s=$?'), ['s=1\n', 'type: never-installed: not found\n', 0]);
  assert.deepEqual(await run(main, 'PATH=/gone which never-installed; echo s=$?'), ['s=1\n', 'which: no never-installed in (/gone)\n', 0]);
  const [, stderr] = await run(main, 'PATH=/gone never-installed; echo s=$?');
  assert.match(stderr, /^never-installed: .*EIO/, 'running it reports the error');
}

// ── A runtime's or a gem's command is reported where a user sees it ──────
// which, command -v, command -V and type agree on it: a gem's wrapper on PATH
// (~/.gem/bin), else a runtime's canonical bin, installed or one the
// workspace would install on first use; a shell builtin by its name.
{
  // An installed runtime's bin is registered by its name, as the runtime manager registers it.
  main.registry.register('clang++', async () => 0);
  // `gem install` of a gem with an executable, then its bin registered as ruby-runner does.
  const gemDir = await mkdtemp(join(tmpdir(), 'nimbus-resolve-path-gem-'));
  try {
    await mkdir(join(gemDir, 'data/bin'), { recursive: true });
    await mkdir(join(gemDir, 'data/lib'), { recursive: true });
    await writeFile(join(gemDir, 'data/bin/rackup'), '#!/usr/bin/env ruby\nputs "rackup"\n');
    await writeFile(join(gemDir, 'data/lib/rackup.rb'), 'module Rackup; end\n');
    for (const argv of [['tar', '-czf', 'data.tar.gz', '-C', 'data', 'bin', 'lib'], ['tar', '-cf', 'rackup-2.1.0.gem', 'data.tar.gz']]) {
      assert.equal(Bun.spawnSync(argv, { cwd: gemDir }).exitCode, 0, argv.join(' '));
    }
    const gem = await readFile(join(gemDir, 'rackup-2.1.0.gem'));
    const responses = new Map([
      ['https://rubygems.org/api/v1/versions/rackup.json', Response.json([{ number: '2.1.0', platform: 'ruby', prerelease: false }])],
      ['https://rubygems.org/api/v2/rubygems/rackup/versions/2.1.0.json', Response.json({ name: 'rackup', version: '2.1.0', platform: 'ruby', gem_uri: 'https://rubygems.org/gems/rackup-2.1.0.gem', dependencies: { runtime: [] } })],
      ['https://rubygems.org/gems/rackup-2.1.0.gem', new Response(gem)],
    ]);
    const realFetch = globalThis.fetch;
    globalThis.fetch = async (url) => responses.get(String(url)) ?? new Response(null, { status: 404 });
    try {
      const view = main.filesystem.view({ pid: 900, cred: CRED_KERNEL });
      await installRubyGems(view, [{ name: 'rackup', requirements: [] }], { gemHome: '/home/main/.gem' });
    } finally {
      globalThis.fetch = realFetch;
    }
  } finally {
    await rm(gemDir, { recursive: true, force: true });
  }
  main.registry.register('rackup', async () => 0);

  const report = async (name) => await run(main, `which ${name}; command -v ${name}; command -V ${name}; type ${name}`);
  const at = (name, path) => [`${path}\n${path}\n${name} is ${path}\n${name} is ${path}\n`, '', 0];
  assert.deepEqual(await report('clang'), at('clang', '/usr/local/bin/clang'), 'a runtime the workspace would install');
  assert.deepEqual(await report('clang++'), at('clang++', '/usr/local/bin/clang++'), 'an installed runtime');
  assert.deepEqual(await report('rackup'), at('rackup', '/home/main/.gem/bin/rackup'), 'a gem\'s bin');
  assert.deepEqual(await run(main, 'command -v clang >/dev/null && echo "clang installed" || echo "clang missing"'), ['clang installed\n', '', 0]);
  assert.deepEqual(await run(main, 'command -v echo; command -V echo; type echo'), ['echo\necho is a shell builtin\necho is a shell builtin\n', '', 0]);
}

// ── A shell builtin is the builtin whatever PATH holds of its name ───────
// As bash 5 answers with an executable `echo` first on PATH: only which,
// which searches PATH alone, names the file.
{
  const kernel = main.vfs.as(CRED_KERNEL);
  kernel.mkdir('shadow/bin', { recursive: true });
  kernel.writeFile('shadow/bin/echo', '#!/bin/sh\necho custom\n');
  kernel.chmod('shadow/bin/echo', 0o755);
  assert.deepEqual(
    await run(main, 'PATH=/shadow/bin type echo; PATH=/shadow/bin command -V echo; PATH=/shadow/bin command -v echo; PATH=/shadow/bin echo hi; PATH=/shadow/bin which echo'),
    ['echo is a shell builtin\necho is a shell builtin\necho\nhi\n/shadow/bin/echo\n', '', 0],
  );
}

// ── which searches PATH once ─────────────────────────────────────────────
{
  const backing = new MemoryVFS({ uid: 0, gid: 0 });
  backing.writeFile('/counted-tool', new TextEncoder().encode('#!/bin/sh\necho counted\n'));
  backing.chmod('/counted-tool', 0o755);
  let stats = 0;
  const counting = new Proxy(backing, {
    get(target, key) {
      if (key === 'sync') return undefined;
      const value = Reflect.get(target, key);
      if (key === 'stat') return async (path, ...rest) => { if (path === '/counted-tool') stats++; return value.call(target, path, ...rest); };
      return typeof value === 'function' ? value.bind(target) : value;
    },
    has(target, key) { return key !== 'sync' && key in target; },
  });
  main.filesystem.vfs.mount('/counted', counting);
  const view = main.filesystem.view({ pid: 900, cred: { uid: 1000, gid: 1000, groups: [1000], umask: 0o022 } });
  assert.deepEqual(await searchPath('counted-tool', resolveContext('/', { PATH: '/counted' }, view)), { kind: 'program', path: '/counted/counted-tool' });
  const oneSearch = stats;
  stats = 0;
  assert.deepEqual(await run(main, 'PATH=/counted which counted-tool'), ['/counted/counted-tool\n', '', 0]);
  assert.equal(stats, oneSearch, 'which costs the mount what one search of PATH does');
}
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
  // A shim the caller cannot reach (a directory it may not search) is EACCES, not "not found".
  const prefix = 'home/main/.local/lib/node_modules';
  assert.equal(await materializeNpmBinShims(kernel, prefix, 'private/bin'), 1);
  kernel.chmod('private', 0o700);
  assert.deepEqual(await run(main, '/private/bin/hello-cli; echo s=$?'), ['s=126\n', '/private/bin/hello-cli: Permission denied\n', 0]);
}

// ── child_process.spawn in a Worker program searches the child's PATH ─────
{
  const { NimbusSession, bindRuntimeServices } = await importWorkerBundle({
    'packages/worker/src/session/nimbus-session.ts': ['NimbusSession'],
    'packages/worker/src/hosted/services.ts': ['bindRuntimeServices'],
  });

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
  // A program found on PATH is a child process like one named by its path: its own pid, live
  // stdin through NIMBUS_CP_CHILD_PID, and output it publishes as that pid (an interpreter that
  // reads and reports what a Worker runtime reads, as the node runtime does).
  {
    main.registry.register('livenode', async (ctx) => {
      const pid = Number(ctx.env.NIMBUS_CP_CHILD_PID);
      let input = '';
      if (pid > 0) {
        for (;;) {
          const packet = await session.facetProcessManager.cpReadStdin(pid, 2_000);
          input += new TextDecoder().decode(packet.data);
          if (packet.ended) break;
        }
      }
      await ctx.stdout.write(`pid=${pid} caller=${ctx.__nimbusBinSpawn?.callerPid} in=${input}\n`);
      return 0;
    });
    const kernel = main.vfs.as(CRED_KERNEL);
    kernel.writeFile('custom/bin/livetool', '#!/usr/bin/env livenode\n');
    kernel.chmod('custom/bin/livetool', 0o755);
    // A runtime the workspace could install is not a registered command either: a file of
    // that name on PATH is the program.
    kernel.writeFile('custom/bin/hintedtool', '#!/usr/bin/env livenode\n');
    kernel.chmod('custom/bin/hintedtool', 0o755);
    for (const command of ['/custom/bin/livetool', 'livetool', 'hintedtool']) {
      const { childPid } = await session._rpcCpSpawn({ command, args: [], env: { ...env, PATH: '/custom/bin' }, cwd: '/tmp', stdio: ['pipe', 'pipe', 'pipe'], parentPid: parent.pid });
      // Past the time a builtin waits for its stdin.
      await new Promise((resolve) => setTimeout(resolve, 150));
      await session._rpcCpStdinWrite(childPid, new TextEncoder().encode('hello'));
      await session._rpcCpStdinEnd(childPid);
      const waited = await session._rpcCpWait(childPid, 5_000);
      const output = await session._rpcCpDrainOutput(childPid);
      assert.deepEqual([new TextDecoder().decode(output.stdout), waited.exitCode], [`pid=${childPid} caller=${childPid} in=hello\n`, 0], `spawn ${command}`);
    }
  }
  // A registered command whose module fails to load ends the child as a failed dispatch
  // does: the error on its stderr, exit 1, recorded so the process table can reap it.
  {
    main.registry.registerLazy('broken-loader', async () => { throw new Error('loader failed'); });
    const { childPid } = await session._rpcCpSpawn({ command: 'broken-loader', args: [], env, cwd: '/tmp', stdio: ['pipe', 'pipe', 'pipe'], parentPid: parent.pid });
    const waited = await session._rpcCpWait(childPid, 5_000);
    const output = await session._rpcCpDrainOutput(childPid);
    assert.deepEqual([new TextDecoder().decode(output.stdout), new TextDecoder().decode(output.stderr), waited.exitCode], ['', 'Error: loader failed\n', 1]);
    assert.equal(main.processes.getExit(childPid)?.code, 1, 'its exit is recorded');
    assert.equal(main.processes.get(childPid)?.state, 'exited', 'it is not left running');
    // reap takes what exited more than maxAge ms ago.
    await new Promise((resolve) => setTimeout(resolve, 5));
    await main.processes.reap(0);
    assert.equal(main.processes.get(childPid), undefined, 'and it is reaped');
  }
  assert.deepEqual(await spawn('hintedtool', [], env), ['', 'hintedtool: command not found\nhint: install it with: nimbus install hintedtool\n', 127], 'and with none, the install hint');
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
}
await main.close();

// ── A principal whose /tmp is its own finds, inspects and runs its own file ──
{
  const confined = await workspace(undefined);
  const kernel = confined.vfs.as(CRED_KERNEL);
  kernel.mkdir('var/agents/u/tmp', { recursive: true, mode: 0o700 });
  for (const dir of ['var', 'var/agents', 'var/agents/u']) kernel.chmod(dir, 0o755);
  kernel.chown('var/agents/u/tmp', 1000, 1000);
  // The shared /tmp's tool: a node program, and one that is not executable at all.
  kernel.mkdir('tmp/shared', { recursive: true });
  kernel.writeFile('tmp/tool', '#!/usr/bin/env node\nconsole.log("PUBLIC")\n');
  kernel.chmod('tmp/tool', 0o755);
  kernel.writeFile('tmp/plain', 'echo PUBLIC\n');
  kernel.chmod('tmp/plain', 0o644);
  kernel.mkdir('other', { recursive: true });
  kernel.writeFile('other/plain', '#!/bin/sh\necho OTHER\n');
  kernel.chmod('other/plain', 0o755);
  confined.vfs.confinePrincipal(1000, 'var/agents/u/tmp');
  const setup = await run(confined, "printf '#!/bin/sh\\necho PRIVATE\\n' > /tmp/tool && cp /tmp/tool /tmp/plain && chmod 700 /tmp/tool /tmp/plain", '/');
  assert.deepEqual(setup, ['', '', 0]);
  assert.deepEqual(await run(confined, 'PATH=/tmp tool', '/'), ['PRIVATE\n', '', 0], 'by bare name, the caller\'s own file and its own interpreter');
  assert.deepEqual(await run(confined, '/tmp/tool', '/'), ['PRIVATE\n', '', 0], 'and by path');
  assert.deepEqual(await run(confined, 'PATH=/tmp:/other plain', '/'), ['PRIVATE\n', '', 0], 'its first executable file, not the shared one');
  // A node_modules/.bin entry runs as an npm bin; one that is not a node program runs as its file does, the caller's.
  kernel.mkdir('tmp/project/node_modules/.bin', { recursive: true });
  kernel.writeFile('tmp/project/node_modules/.bin/binny', '#!/usr/bin/env node\nconsole.log("PUBLIC")\n');
  kernel.chmod('tmp/project/node_modules/.bin/binny', 0o755);
  assert.deepEqual(await run(confined, "mkdir -p /tmp/project/node_modules/.bin && printf '#!/bin/sh\\necho PRIVATE\\n' > /tmp/project/node_modules/.bin/binny && chmod 700 /tmp/project/node_modules/.bin/binny", '/'), ['', '', 0]);
  assert.deepEqual(await run(confined, 'PATH=/tmp/project/node_modules/.bin binny', '/'), ['PRIVATE\n', '', 0], 'by bare name');
  assert.deepEqual(await run(confined, '/tmp/project/node_modules/.bin/binny', '/'), ['PRIVATE\n', '', 0], 'and by path');
  await confined.close();
}

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
