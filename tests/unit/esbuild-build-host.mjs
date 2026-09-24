#!/usr/bin/env bun
// With a build host, build() runs esbuild in the host (the session's esbuild
// facet) and only the VFS plugin here, so every read keeps the caller's view.
//
// build() used to run esbuild-wasm in the caller's isolate, whose esbuild heap
// only grows. On a throwaway at main 9401b6c9, `npm install` then `vite build`
// reset the session with exceededMemory at 200.4 MiB.
//
// The host is the facet module production loads (esbuildFacetWorkerCode, from
// the assets production stages for it), evaluated here. Options and outcome
// cross a structured clone, as they cross RPC.

import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { CRED_KERNEL, CRED_SESSION_USER } from '../../packages/core/src/runtime/os-contracts.ts';
import { SqliteVFS } from '../../packages/core/src/vfs/sqlite-vfs.ts';
import { EsbuildService } from '../../packages/core/src/runtime/esbuild-service.ts';
import { esbuildFacetWorkerCode } from '../../packages/worker/src/facets/esbuild-transform.ts';
import { ESBUILD_JS_ASSET_PATH } from '../../packages/worker/src/esbuild-wasm-bundle.generated.ts';
import { ESBUILD_CLI_ASSET_PATH } from '../../packages/worker/src/esbuild-cli-artifact.generated.ts';
import { createSqliteVfsTestHarness } from './sqlite-vfs-test-harness.mjs';

const resolveFromCore = createRequire(new URL('../../packages/core/package.json', import.meta.url));
const wasmBytes = await readFile(resolveFromCore.resolve('esbuild-wasm/esbuild.wasm'));
const staged = (path) => readFile(new URL(`../../packages/worker/public${path}`, import.meta.url), 'utf8');
const facetSource = esbuildFacetWorkerCode(
  wasmBytes.buffer, await staged(ESBUILD_JS_ASSET_PATH), await staged(ESBUILD_CLI_ASSET_PATH),
).modules['worker.js'];
// The loader resolves these two imports; bound here to what it would supply.
globalThis.__facetImports = {
  DurableObject: class DurableObject { constructor(ctx, env) { this.ctx = ctx; this.env = env; } },
  wasmModule: await WebAssembly.compile(wasmBytes),
};
const facetModule = facetSource
  .replace('import { DurableObject } from "cloudflare:workers";', 'const { DurableObject } = globalThis.__facetImports;')
  .replace('import wasmModule from "esbuild.wasm";', 'const { wasmModule } = globalThis.__facetImports;');
assert.doesNotMatch(facetModule, /^import /m);
const { EsbuildFacet } = await import('data:text/javascript;base64,' + Buffer.from(facetModule).toString('base64'));
const facet = new EsbuildFacet({}, {});
const buildHost = async (options, remote) => structuredClone(await facet.build(structuredClone(options), remote));

const harness = createSqliteVfsTestHarness();
const raw = new SqliteVFS(harness.sql, harness.ctx);
const kernel = raw.as(CRED_KERNEL);
const author = raw.as(CRED_SESSION_USER);
kernel.mkdir('home/user', { recursive: true, mode: 0o755 });
kernel.chown('home/user', CRED_SESSION_USER.uid, CRED_SESSION_USER.gid);
kernel.mkdir('private', { mode: 0o755 });
kernel.writeFile('private/secret.ts', 'export default "kernel-only-content";');
kernel.chmod('private/secret.ts', 0o600);
author.mkdir('home/user/app/src', { recursive: true });
author.mkdir('home/user/app/node_modules/greeter', { recursive: true });
author.writeFile('home/user/app/node_modules/greeter/package.json', JSON.stringify({ name: 'greeter', module: 'index.js' }));
author.writeFile('home/user/app/node_modules/greeter/index.js', 'export const greet = (name) => "GREETER_MARKER " + name;\n');
author.writeFile('home/user/app/src/shout.ts', 'export const shout = (s: string): string => s.toUpperCase();\n');
author.writeFile('home/user/app/src/notes.txt', 'RAW_NOTES_MARKER\n');
author.writeFile('home/user/app/src/main.ts', [
  "import { greet } from 'greeter';",
  "import { shout } from './shout';",
  "import notes from './notes.txt?raw';",
  'export const out = shout(greet("app")) + notes;',
].join('\n'));
author.writeFile('home/user/app/src/leak.ts', 'export { default } from "/private/secret.ts";');

// ── The build runs in the host, over the caller's files ─────────────────────
{
  const service = new EsbuildService(author, { buildHost });
  const result = await service.build(['/home/user/app/src/main.ts'], {
    format: 'esm', outdir: '/home/user/app/dist', viteAssets: true,
  });
  assert.deepEqual(result.errors, []);
  const entry = Object.entries(result.metafile.outputs).find(([, output]) => output.entryPoint)?.[0];
  assert.equal(entry, 'home/user/app/dist/main.js');
  const bundle = result.outputFiles.find((file) => file.path === '/home/user/app/dist/main.js');
  assert.ok(bundle, `no entry output among ${result.outputFiles.map((file) => file.path).join(', ')}`);
  assert.match(bundle.contents, /GREETER_MARKER/, 'the bare import resolved through node_modules in the VFS');
  assert.match(bundle.contents, /toUpperCase/, 'the extensionless relative .ts import resolved');
  assert.match(bundle.contents, /RAW_NOTES_MARKER/, 'a ?raw import loaded through its own namespace');
  assert.equal(service.isInitialized, false, "the caller's isolate never started esbuild");
  console.log('  ok  build() bundles in the host from the caller\'s VFS; no esbuild in this isolate');
}

// ── The plugin keeps the caller's view: the host confers no read authority ──
{
  const service = new EsbuildService(author, { buildHost });
  await assert.rejects(
    service.build(['/home/user/app/src/leak.ts']),
    /File not found in VFS: \/private\/secret\.ts|EACCES/,
  );
  const privileged = new EsbuildService(kernel, { buildHost });
  const result = await privileged.build(['/home/user/app/src/leak.ts'], { format: 'esm' });
  assert.match(result.outputFiles[0].contents, /kernel-only-content/);
  console.log("  ok  the host reads what the caller's view may read, and nothing else");
}

// ── A failed build rejects with esbuild's own message ───────────────────────
{
  author.writeFile('home/user/app/src/broken.ts', "import { nope } from './missing';\nexport default nope;\n");
  const service = new EsbuildService(author, { buildHost });
  await assert.rejects(service.build(['/home/user/app/src/broken.ts']), /Could not resolve "\.\/missing"/);
  console.log('  ok  an unresolvable import fails the build with esbuild\'s diagnostic');
}

harness.db.close();
console.log('esbuild-build-host OK');
