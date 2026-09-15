#!/usr/bin/env bun
// vite-build-outdir-safety — `vite build` must never delete or write
// outside the project root, and must never clear a previously-good
// dist/ on a failed build.
//
// The session's built-in `vite build` honours `build.outDir` the way
// Vite does: output writes to the resolved path wherever it lands
// inside the VFS (the monorepo `../server/public` layout), and only the
// empty step is gated — an outDir not strictly inside the project root
// is never emptied, with Vite's warning line printed instead. A failed
// build still never clears previously-good output.
//
// Seam: the real registered command — createViteCommand on a
// CommandRegistry, against a real SqliteVFS — so the test exercises
// exactly what `vite build` runs in a session. The esbuild service is
// faked: bundling correctness is esbuild-vite-assets.mjs's job; this
// file exists to pin the filesystem safety around it.
import assert from 'node:assert/strict';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { Database } from 'bun:sqlite';
import { CRED_KERNEL } from '../../packages/core/src/runtime/os-contracts.ts';
import { SqliteVFS } from '../../packages/core/src/vfs/sqlite-vfs.ts';
import { CommandRegistry } from '../../packages/core/src/substrate/lifo/commands/registry.ts';
import { createSqliteVfsTestHarness } from './sqlite-vfs-test-harness.mjs';

// vite-command.ts transitively imports `cloudflare:workers` (ViteDevServer
// → real-vite-hmr); bundle it with the same stub the route tests use.
const outputDir = await mkdtemp(join(tmpdir(), 'nimbus-vite-outdir-test-'));
const bundle = await Bun.build({
  entrypoints: ['./packages/worker/src/session/vite-command.ts'],
  outdir: outputDir,
  target: 'bun',
  format: 'esm',
  plugins: [{
    name: 'cloudflare-workers-test-stub',
    setup(builder) {
      builder.onResolve({ filter: /^cloudflare:workers$/ }, () => ({
        path: 'cloudflare-workers',
        namespace: 'test',
      }));
      builder.onLoad({ filter: /.*/, namespace: 'test' }, () => ({
        contents: 'export class DurableObject {}; export class WorkerEntrypoint {};',
        loader: 'js',
      }));
    },
  }],
});
assert.equal(bundle.success, true, bundle.logs.map(String).join('\n'));
const entry = bundle.outputs.find((output) => output.path.endsWith('/vite-command.js'));
assert.ok(entry, 'the vite-command bundle was emitted');
const { createViteCommand } = await import(pathToFileURL(entry.path).href);

const CWD = '/home/user';

function makeHostAndCtx({ viteConfigSource, buildResult }) {
  const harness = createSqliteVfsTestHarness(new Database(':memory:'));
  const sqliteFs = new SqliteVFS(harness.sql, harness.ctx);
  const kernelFs = sqliteFs.as(CRED_KERNEL);
  kernelFs.mkdir(CWD, { recursive: true });
  kernelFs.writeFile(`${CWD}/index.html`, '<html><body><script type="module" src="/src/main.js"></script></body></html>');
  kernelFs.mkdir(`${CWD}/src`, { recursive: true });
  kernelFs.writeFile(`${CWD}/src/main.tsx`, 'console.log(1);');
  if (viteConfigSource !== null) kernelFs.writeFile(`${CWD}/vite.config.js`, viteConfigSource);
  // A marker outside the project root an escaping outDir must not touch.
  kernelFs.mkdir('/home', { recursive: true });
  kernelFs.writeFile('/home/marker.txt', 'keep me');

  const stdout = [];
  const stderr = [];
  const ctx = {
    args: ['build'],
    cwd: CWD,
    env: {},
    stdout: { write: (s) => stdout.push(s) },
    stderr: { write: (s) => stderr.push(s) },
  };
  const host = {
    ensureSqliteFs() {},
    // No facet pool in this harness: cold /@modules/ misses take the legacy path.
    ensureBundlePool() { return null; },
    sqliteFs,
    esbuildService: { build: async () => buildResult },
  };
  const registry = new CommandRegistry();
  registry.register('vite', createViteCommand(host));
  return { registry, ctx, kernelFs, stdout, stderr };
}

const buildOk = {
  errors: [],
  outputFiles: [
    { path: '/home/user/dist/assets/index-abc.js', bytes: new Uint8Array([99]) },
  ],
  metafile: { outputs: { '/home/user/dist/assets/index-abc.js': { entryPoint: 'src/main.js' } } },
};

// ── outDir inside the project is honoured and emptied cleanly ────────────
{
  const { registry, ctx, kernelFs, stderr } = makeHostAndCtx({
    viteConfigSource: 'export default { build: { outDir: "public/build" } }',
    buildResult: buildOk,
  });
  const vite = await registry.resolve('vite');
  const code = await vite(ctx);
  assert.equal(code, 0, `vite build succeeds: ${stderr.join('')}`);
  assert.ok(kernelFs.exists(`${CWD}/public/build/index.html`), 'entry html lands in the configured outDir');
  console.log('  inside-root outDir builds into it');
}

// ── outDir outside the project still writes; only emptying is gated ────
//
// Vite writes to the resolved outDir wherever it is — the monorepo
// ../server/public layout — and only refuses to EMPTY a directory that
// is not inside the root, warning verbatim instead.
{
  const { registry, ctx, kernelFs, stderr } = makeHostAndCtx({
    viteConfigSource: 'export default { build: { outDir: "../sibling" } }',
    buildResult: buildOk,
  });
  kernelFs.mkdir('/home/sibling', { recursive: true });
  kernelFs.writeFile('/home/sibling/keep.txt', 'pre-existing');
  const vite = await registry.resolve('vite');
  const code = await vite(ctx);
  assert.equal(code, 0, `vite build succeeds: ${stderr.join('')}`);
  assert.ok(kernelFs.exists('/home/sibling/index.html'), 'index.html lands in the resolved outDir');
  assert.ok(kernelFs.exists('/home/sibling/keep.txt'), 'an outside outDir is never emptied');
  assert.ok(kernelFs.exists('/home/marker.txt'), 'nothing outside the outDir was touched');
  assert.ok(
    stderr.join('').includes('outDir home/sibling is not inside project root and will not be emptied'),
    `Vite's warning line prints verbatim: ${stderr.join('')}`,
  );
  console.log('  ../sibling outDir writes there and is never emptied');
}

// ── an absolute outDir behaves the same ────────────────────────────────
{
  const { registry, ctx, kernelFs, stderr } = makeHostAndCtx({
    viteConfigSource: 'export default { build: { outDir: "/home/abs-escape" } }',
    buildResult: buildOk,
  });
  const vite = await registry.resolve('vite');
  const code = await vite(ctx);
  assert.equal(code, 0);
  assert.ok(kernelFs.exists('/home/abs-escape/index.html'), 'output lands in the absolute outDir');
  assert.ok(
    stderr.join('').includes('outDir home/abs-escape is not inside project root and will not be emptied'),
    `Vite's warning line prints verbatim: ${stderr.join('')}`,
  );
  console.log('  absolute outDir writes there and is never emptied');
}

// ── outDir "." writes in place and never empties the root ─────────────
{
  const { registry, ctx, kernelFs, stderr } = makeHostAndCtx({
    viteConfigSource: 'export default { build: { outDir: "." } }',
    buildResult: buildOk,
  });
  const vite = await registry.resolve('vite');
  const code = await vite(ctx);
  assert.equal(code, 0);
  assert.ok(kernelFs.exists(`${CWD}/index.html`), 'index.html written in place');
  assert.ok(kernelFs.exists(`${CWD}/src/main.tsx`), 'src/ is never emptied');
  assert.ok(kernelFs.exists(`${CWD}/vite.config.js`), 'package files are never emptied');
  assert.ok(
    stderr.join('').includes('is not inside project root and will not be emptied'),
    `the warning prints for outDir === root too: ${stderr.join('')}`,
  );
  console.log('  outDir . writes in place, root never emptied');
}

// ── an inside-root outDir is emptied of stale outputs ─────────────────
{
  const { registry, ctx, kernelFs, stderr } = makeHostAndCtx({
    viteConfigSource: 'export default { build: { outDir: "public/build" } }',
    buildResult: buildOk,
  });
  kernelFs.mkdir(`${CWD}/public/build/assets`, { recursive: true });
  kernelFs.writeFile(`${CWD}/public/build/assets/stale-000.js`, 'stale');
  const vite = await registry.resolve('vite');
  const code = await vite(ctx);
  assert.equal(code, 0);
  assert.ok(!kernelFs.exists(`${CWD}/public/build/assets/stale-000.js`), 'stale hashed outputs are emptied');
  assert.ok(kernelFs.exists(`${CWD}/public/build/index.html`), 'fresh output lands');
  console.log('  inside-root outDir is emptied of stale outputs');
}

// ── a failed build must not clear a previously-good dist/ ────────────────
{
  const { registry, ctx, kernelFs } = makeHostAndCtx({ viteConfigSource: null, buildResult: { errors: [{ text: 'boom' }] } });
  kernelFs.mkdir(`${CWD}/dist`, { recursive: true });
  kernelFs.writeFile(`${CWD}/dist/keep.js`, 'prior good build');
  const vite = await registry.resolve('vite');
  const code = await vite(ctx);
  assert.equal(code, 1, 'a failing build exits 1');
  assert.ok(kernelFs.exists(`${CWD}/dist/keep.js`), 'the previously-good output survives a failed build');
  console.log('  a failed build leaves the old dist/ alone');
}

// ── a build with no JS output must not clear dist/ either ────────────────
{
  const { registry, ctx, kernelFs } = makeHostAndCtx({ viteConfigSource: null, buildResult: { errors: [], outputFiles: [], metafile: { outputs: {} } } });
  kernelFs.mkdir(`${CWD}/dist`, { recursive: true });
  kernelFs.writeFile(`${CWD}/dist/keep.js`, 'prior good build');
  const vite = await registry.resolve('vite');
  const code = await vite(ctx);
  assert.equal(code, 1, 'an empty build exits 1');
  assert.ok(kernelFs.exists(`${CWD}/dist/keep.js`), 'the previously-good output survives');
  console.log('  a no-JS-output build leaves the old dist/ alone');
}

console.log('vite-build-outdir-safety: all assertions passed');
