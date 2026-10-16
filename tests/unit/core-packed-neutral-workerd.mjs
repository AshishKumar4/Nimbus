// @serial
// @tier slow — bundles the packed published core as neutral ESM and runs a workspace in workerd.
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { builtinModules } from 'node:module';
import { mkdirSync, mkdtempSync, rmSync, symlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { build } from 'esbuild';
import { servePlainWorkerd } from './lib/plain-workerd.mjs';

const repo = new URL('../../', import.meta.url).pathname;
const root = mkdtempSync(join(tmpdir(), 'nimbus-packed-core-'));
let served;
try {
  const packed = spawnSync('npm', ['pack', '--ignore-scripts', '--pack-destination', root, '--json'], { cwd: join(repo, 'packages/core'), encoding: 'utf8' });
  assert.equal(packed.status, 0, packed.stderr);
  const tar = JSON.parse(packed.stdout)[0].filename;
  const unpacked = spawnSync('tar', ['-xzf', join(root, tar), '-C', root], { encoding: 'utf8' });
  assert.equal(unpacked.status, 0, unpacked.stderr);
  mkdirSync(join(root, 'node_modules/@nimbus-sh'), { recursive: true });
  symlinkSync(join(root, 'package'), join(root, 'node_modules/@nimbus-sh/core'));
  symlinkSync(join(repo, 'packages/core/node_modules'), join(root, 'package/node_modules'));
  const source = `import { DurableObject } from 'cloudflare:workers';
import { NimbusWorkspace } from '@nimbus-sh/core/workspace';
import { createNpmCommand } from '@nimbus-sh/core/substrate/lifo/commands/system/npm.js';
export class Workspace extends DurableObject {
  async fetch() {
    const workspace = await NimbusWorkspace.create({ sql: this.ctx.storage.sql, transactions: this.ctx, generation: 1 });
    workspace.registry.register('npm', createNpmCommand(workspace.registry, undefined, workspace.kernel));
    const result = await workspace.exec('npm --version');
    return Response.json(result);
  }
}
export default { fetch(request, env) { return env.WORKSPACES.get(env.WORKSPACES.idFromName('packed')).fetch(request); } };
`;
  const bundled = await build({
    stdin: { contents: source, loader: 'js', resolveDir: root },
    bundle: true, format: 'esm', platform: 'neutral', external: ['node:*', 'cloudflare:*', ...builtinModules],
    conditions: ['workerd', 'worker', 'import'], mainFields: ['module', 'main'], write: false, logLevel: 'silent',
  });
  // Native workerd's inMemory backend has no SQLite API; exercise the actual
  // SQL-backed actor through its disk service, as a production workspace does.
  served = await servePlainWorkerd({
    name: 'packed-core',
    files: { 'main.js': bundled.outputFiles[0].text },
    dirs: ['store'],
    config: ({ port, dir }) => `using Workerd = import "/workerd/workerd.capnp";
const config :Workerd.Config = (
 services = [(name = "main", worker = (
  modules = [(name = "main.js", esModule = embed "main.js")], compatibilityDate = "2026-09-26", compatibilityFlags = ["new_module_registry"],
  durableObjectNamespaces = [(className = "Workspace", uniqueKey = "packed-core", enableSql = true)],
  durableObjectStorage = (localDisk = "store"), bindings = [(name = "WORKSPACES", durableObjectNamespace = "Workspace")]
 )), (name = "store", disk = (path = ${JSON.stringify(join(dir, 'store'))}, writable = true))], sockets = [(name = "http", address = "127.0.0.1:${port}", http = (), service = "main")]
);`,
  });
  const response = await fetch(`${served.base}/`, { signal: AbortSignal.timeout(60_000) });
  assert.equal(response.status, 200, `${await response.clone().text()}\n${served.logs()}`);
  const result = await response.json();
  assert.equal(result.exitCode, 0, JSON.stringify(result));
  assert.match(result.stdout, /^\d+\.\d+\.\d+/m);
  console.log('core-packed-neutral-workerd: packed neutral ESM creates a workspace and runs npm');
} finally {
  await served?.stop();
  rmSync(root, { recursive: true, force: true });
}
