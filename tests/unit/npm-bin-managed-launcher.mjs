#!/usr/bin/env bun
// npm-bin-managed-launcher — the launch chain pi.dev's managed installer
// builds must run a program end to end:
//
//   pi (bare, on PATH) → ~/.local/bin/pi (symlink)
//     → ~/.pi/agent/bin/pi (#!/bin/sh: `exec "$release/node_modules/.bin/pi" "$@"`)
//     → node_modules/.bin/pi (npm shim) → the package's cli.js
//
// The installer `npm ci`s into a staging directory and then renames it to
// releases/<version>. Three failures, one per link, were seen live on
// throwaway session flat-spider-3087:
//   - the PATH fallback ran the `#!/bin/sh` launcher as JavaScript
//     ("SyntaxError: Unexpected token 'case'");
//   - `exec cmd args` was "exec: command not found";
//   - the .bin shim required the absolute staging path, gone after the rename
//     ("Cannot find module '.../staging/install-1-.../cli.js'").

import assert from 'node:assert/strict';
import { NimbusWorkspace } from '../../packages/core/src/workspace/nimbus-workspace.ts';
import { CRED_KERNEL } from '../../packages/core/src/runtime/os-contracts.ts';
import { installNpmBinFallbackResolver } from '../../packages/worker/src/shell/npm-bin-entrypoints.ts';
import { createNpmBinShim, createNpmBinManifest, npmBinManifestPath } from '../../packages/worker/src/npm/bin-links.ts';
import { registerShellEntrypointCommands } from '../../packages/core/src/shell/shell-entrypoints.ts';
import { createSqliteVfsTestHarness } from './sqlite-vfs-test-harness.mjs';

const terminalEvents = [];
const harness = createSqliteVfsTestHarness();
const ws = await NimbusWorkspace.create({ sql: harness.sql, transactions: harness.ctx });
const vfs = ws.vfs.as(CRED_KERNEL);
registerShellEntrypointCommands(ws.registry, { execute: (cmd, options) => ws.shell.execute(cmd, options) });
installNpmBinFallbackResolver(ws.registry, {
  vfs,
  getCwd: () => '/home/user',
  processes: ws.processes,
  getFacetManager() { throw new Error('unexpected staged artifact'); },
  notifyTerminalEvent(event) { terminalEvents.push(event); },
  async runtimeCommandHint() { return null; },
  emitShellExecDone() {},
});

async function run(command) {
  const r = await ws.exec(command);
  return { code: r.exitCode, stdout: r.stdout, stderr: r.stderr };
}

// `exec` replaces the shell: its status is the script's, nothing after it runs.
{
  await run('mkdir -p /home/user && printf "%s\\n" "exec echo real \\"\\$@\\"" "echo NOT_REACHED" > /home/user/x.sh');
  assert.deepEqual(await run('sh /home/user/x.sh a b; echo "rc=$?"'), { code: 0, stdout: 'real a b\nrc=0\n', stderr: '' });
  assert.deepEqual(await run('sh -c \'exec false; echo NOT_REACHED\'; echo "rc=$?"'), { code: 0, stdout: 'rc=1\n', stderr: '' });
  assert.deepEqual(await run('( exec true ) && echo sub-ok'), { code: 0, stdout: 'sub-ok\n', stderr: '' });
}

// The managed layout, built the way the installer builds it.
const stage = 'home/user/.pi/agent/install/staging/install-1';
const pkgDir = `${stage}/node_modules/tool`;
assert.equal((await run(`mkdir -p /${pkgDir}/dist /${stage}/node_modules/.bin`)).code, 0);
vfs.writeFile(`${pkgDir}/package.json`, JSON.stringify({ name: 'tool', version: '1.0.0', bin: { tool: 'dist/cli.js' } }));
vfs.writeFile(`${pkgDir}/dist/cli.js`, 'console.log("TOOL " + process.argv.slice(2).join(" "));\n');
const entry = { name: 'tool', packageName: 'tool', packageVersion: '1.0.0', packagePath: pkgDir, targetPath: `${pkgDir}/dist/cli.js` };
vfs.writeFile(`${stage}/node_modules/.bin/tool`, createNpmBinShim(entry, `${stage}/node_modules/.bin`));
vfs.chmod(`${stage}/node_modules/.bin/tool`, 0o755);
vfs.writeFile(npmBinManifestPath(`${stage}/node_modules`), JSON.stringify(createNpmBinManifest([entry])));

const launcher = [
  '#!/bin/sh',
  'case "$0" in */*) l="$0" ;; *) l=$(command -v "$0") ;; esac',
  'while [ -L "$l" ]; do t=$(readlink "$l"); case "$t" in /*) l="$t" ;; *) l=${l%/*}/$t ;; esac; done',
  'agent=${l%/*}; agent=${agent%/*}',
  'exec "$agent/install/releases/1.0.0/node_modules/.bin/tool" "$@"',
  '',
].join('\n');
{
  const r = await run([
    'mkdir -p ~/.pi/agent/install/releases ~/.pi/agent/bin ~/.local/bin',
    'mv ~/.pi/agent/install/staging/install-1 ~/.pi/agent/install/releases/1.0.0',
    `printf '%s' '${launcher.replaceAll("'", "'\\''")}' > ~/.pi/agent/bin/tool`,
    'chmod 755 ~/.pi/agent/bin/tool',
    'ln -s ../../.pi/agent/bin/tool ~/.local/bin/tool',
  ].join(' && '));
  assert.equal(r.code, 0, r.stderr);
}

// The moved .bin entry still runs, by path and as a script handed to node.
assert.deepEqual(
  await run('~/.pi/agent/install/releases/1.0.0/node_modules/.bin/tool moved; echo "rc=$?"'),
  { code: 0, stdout: 'TOOL moved\nrc=0\n', stderr: '' },
);
assert.deepEqual(
  await run('node ~/.pi/agent/install/releases/1.0.0/node_modules/.bin/tool shim; echo "rc=$?"'),
  { code: 0, stdout: 'TOOL shim\nrc=0\n', stderr: '' },
);

// A bare name on PATH whose file is a `#!/bin/sh` script runs under sh, and
// the .bin entry it execs by path launches as that npm bin: one spawn/exit
// lifecycle named for the bin, like the bare-name launch.
{
  terminalEvents.length = 0;
  const r = await run('PATH=/home/user/.local/bin:$PATH tool --version x; echo "rc=$?"');
  assert.equal(r.stderr, '');
  assert.equal(r.stdout, 'TOOL --version x\nrc=0\n');
  assert.deepEqual(terminalEvents.map((e) => `${e.type} ${e.command}`), ['spawn tool --version x', 'exit tool --version x']);
}

console.log('npm-bin-managed-launcher: ok');
process.exit(0);
