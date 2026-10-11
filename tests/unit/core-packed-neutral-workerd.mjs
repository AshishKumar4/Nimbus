// @serial
// @tier slow — bundles the packed published core as neutral ESM and runs a workspace in workerd.
import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { builtinModules, createRequire } from 'node:module';
import { createServer } from 'node:net';
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { build } from 'esbuild';

const repo = new URL('../../', import.meta.url).pathname;
const root = mkdtempSync(join(tmpdir(), 'nimbus-packed-core-'));
let child;
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
export class Workspace extends DurableObject {
  async fetch() {
    const workspace = await NimbusWorkspace.create({ sql: this.ctx.storage.sql, transactions: this.ctx, generation: 1 });
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
  writeFileSync(join(root, 'main.js'), bundled.outputFiles[0].text);
  const portServer = createServer();
  await new Promise((resolve) => portServer.listen(0, '127.0.0.1', resolve));
  const port = portServer.address().port;
  await new Promise((resolve) => portServer.close(resolve));
  // Native workerd's inMemory backend has no SQLite API; exercise the actual
  // SQL-backed actor through its disk service, as a production workspace does.
  mkdirSync(join(root, 'store'));
  writeFileSync(join(root, 'config.capnp'), `using Workerd = import "/workerd/workerd.capnp";
const config :Workerd.Config = (
 services = [(name = "main", worker = (
  modules = [(name = "main.js", esModule = embed "main.js")], compatibilityDate = "2026-09-26", compatibilityFlags = ["new_module_registry"],
  durableObjectNamespaces = [(className = "Workspace", uniqueKey = "packed-core", enableSql = true)],
  durableObjectStorage = (localDisk = "store"), bindings = [(name = "WORKSPACES", durableObjectNamespace = "Workspace")]
 )), (name = "store", disk = (path = ${JSON.stringify(join(root, 'store'))}, writable = true))], sockets = [(name = "http", address = "127.0.0.1:${port}", http = (), service = "main")]
);`);
  const require = createRequire(import.meta.url);
  const workerd = createRequire(require.resolve('wrangler/package.json'))('workerd').default;
  let logs = '';
  child = spawn(workerd, ['serve', 'config.capnp', '--experimental'], { cwd: root, stdio: ['ignore', 'pipe', 'pipe'] });
  child.stdout.on('data', (chunk) => { logs += chunk; });
  child.stderr.on('data', (chunk) => { logs += chunk; });
  const deadline = Date.now() + 30_000;
  let response;
  for (;;) {
    try { response = await fetch(`http://127.0.0.1:${port}/`, { signal: AbortSignal.timeout(1000) }); break; }
    catch (error) {
      if (child.exitCode !== null || Date.now() >= deadline) throw new Error(`packed core did not start: ${logs}`);
      if (error.code !== 'ConnectionRefused' && error.code !== 'ECONNREFUSED' && error.cause?.code !== 'ECONNREFUSED' && error.name !== 'TimeoutError') throw error;
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
  }
  assert.equal(response.status, 200, `${await response.clone().text()}\n${logs}`);
  const result = await response.json();
  assert.equal(result.exitCode, 0, JSON.stringify(result));
  assert.match(result.stdout, /^\d+\.\d+\.\d+/m);
  console.log('core-packed-neutral-workerd: packed neutral ESM creates a workspace and runs npm');
} finally {
  if (child && child.exitCode === null) {
    const closed = new Promise((resolve) => child.once('close', resolve));
    child.kill('SIGTERM');
    await closed;
  }
  rmSync(root, { recursive: true, force: true });
}
