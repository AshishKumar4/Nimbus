#!/usr/bin/env bun
// An edit of the project's vite.config takes effect in the built-in Vite dev
// server, as Vite restarts on one: the server reads the config again (its
// `resolve.alias`, `define` and `nimbusInjectBasename`), serves nothing it
// made under the old one, tells the browser to reload, and tells the session
// the new config (what a restore after hibernation starts from). A config
// that cannot be read leaves the server on the one it has. An edit of a
// tsconfig, or of a file a tsconfig extends, drops every transformed module
// and reloads, as Vite does; and its settings are what the next transform
// compiles with. A module a request began making under the old config is
// not remembered. vite.config's esbuild settings and its plugins' are read
// again with the rest.
// Before, the config was read once at `vite`: an edit changed nothing until
// the next `vite`, and a tsconfig edit was a reload that served the same
// modules from memory.

import assert from 'node:assert/strict';
import { EsbuildService } from '../../packages/core/src/runtime/esbuild-service.ts';
import { CRED_KERNEL } from '../../packages/core/src/runtime/os-contracts.ts';
import { SqliteVFS } from '../../packages/core/src/vfs/sqlite-vfs.ts';
import { ViteDevServer } from '../../packages/worker/src/facets/vite-dev-server.ts';
import { esbuildEngine, stopEsbuildEngine } from './lib/esbuild-engine.mjs';
import { createSqliteVfsTestHarness } from './lib/sqlite-vfs-test-harness.mjs';

const root = 'home/user/app';
const config = ({ alias, define, extra = '' }) =>
  `export default {\n  resolve: { alias: ${JSON.stringify(alias)} },\n  define: ${JSON.stringify(define)},\n${extra}};\n`;

/** A project with a vite.config, served by a dev server `vite` started there, and what it told the browser and the session. */
async function project({ sql = true } = {}) {
  const harness = createSqliteVfsTestHarness();
  const vfs = new SqliteVFS(harness.sql, harness.ctx);
  const kernel = vfs.as(CRED_KERNEL);
  const write = (path, content) => {
    const at = `${root}/${path}`;
    kernel.mkdir(at.slice(0, at.lastIndexOf('/')), { recursive: true, mode: 0o755 });
    kernel.writeFile(at, new TextEncoder().encode(content), { mode: 0o644 });
  };
  write('package.json', JSON.stringify({ name: 'app', type: 'module' }));
  write('vite.config.js', config({ alias: { '@': './src' }, define: { __APP__: '"one"' } }));
  write('src/value.ts', "import { v } from '@/lib';\nexport const app: string = __APP__ + v;\n");
  write('src/view.tsx', 'export const view = <b>hi</b>;\n');
  write('tsconfig.json', JSON.stringify({ extends: './tsconfig.base.json', compilerOptions: { strict: true } }));
  write('base.json', JSON.stringify({ compilerOptions: {} }));
  write('tsconfig.base.json', JSON.stringify({ extends: './base.json' }));

  const esbuild = new EsbuildService(undefined, { engine: esbuildEngine });
  // The transforms the server runs, each held until `release` when `hold` is set.
  const transforms = { count: 0, hold: null };
  const transform = esbuild.transform.bind(esbuild);
  esbuild.transform = async (...args) => {
    transforms.count++;
    if (transforms.hold) await transforms.hold;
    return transform(...args);
  };
  const reloads = [];
  const configs = [];
  const server = new ViteDevServer({
    vfs, cred: CRED_KERNEL, esbuild, root, ...(sql ? { sql: harness.sql } : {}), basePath: '/preview', port: 5173,
    // What `vite` read at start.
    aliases: { '@': './src' }, define: { __APP__: '"one"' },
    configDir: root,
    onConfigChange: (next) => configs.push(next),
    onHmrMessage: (message) => reloads.push(message.event),
  });
  // The writes above are the project as it was before `vite`: their events are delivered first.
  await new Promise((r) => setTimeout(r, 0));
  server.start();
  const get = async (path) => {
    const response = await server.handleRequest(new Request(`http://localhost/preview${path}`), path);
    return response.text();
  };
  /** Until the browser is told to reload `n` times in all. */
  const reloaded = async (n) => {
    for (let i = 0; i < 200 && reloads.filter((e) => e === 'full-reload').length < n; i++) await new Promise((r) => setTimeout(r, 5));
    return reloads.filter((e) => e === 'full-reload').length >= n;
  };
  return { write, get, reloaded, reloads, configs, transforms, server };
}

const failures = [];
const check = (name, ok, detail) => {
  if (!ok) failures.push(`${name}: ${detail}`);
  console.log(`  ${ok ? 'ok ' : 'RED'} ${name}`);
};

try {
  // ── An edit of vite.config ─────────────────────────────────────────────
  {
    const p = await project();
    const before = await p.get('/src/value.ts');
    assert.match(before, /"one"/, before);
    assert.match(before, /\/preview\/src\/lib/, before);
    p.write('vite.config.js', config({ alias: { '@': './shared' }, define: { __APP__: '"two"' } }));
    const told = await p.reloaded(1);
    const after = await p.get('/src/value.ts');
    check('an edited vite.config\'s define is the one served', /"two"/.test(after), after);
    check('and its aliases', /\/preview\/shared\/lib/.test(after), after);
    check('the browser is told to reload', told, JSON.stringify(p.reloads));
    check('the session is told the new config, for a restore',
      p.configs.length === 1 && p.configs[0].alias?.['@'] === './shared' && p.configs[0].define?.__APP__ === '"two"', JSON.stringify(p.configs));

    // A config that cannot be read: the server stays on the one it has.
    p.write('vite.config.js', 'export default {\n');
    await new Promise((r) => setTimeout(r, 50));
    const kept = await p.get('/src/value.ts');
    check('a vite.config that cannot be read leaves the config read before', /"two"/.test(kept) && p.configs.length === 1, kept);
    p.server.stop();
  }

  // ── A request in flight across the edit ────────────────────────────────
  {
    const p = await project({ sql: false });
    let release;
    p.transforms.hold = new Promise((r) => { release = r; });
    const inFlight = p.get('/src/value.ts');
    while (p.transforms.count === 0) await new Promise((r) => setTimeout(r, 1));
    p.write('vite.config.js', config({ alias: { '@': './src' }, define: { __APP__: '"two"' } }));
    await p.reloaded(1);
    release();
    p.transforms.hold = null;
    assert.match(await inFlight, /"one"/, 'the request in flight is answered under the config it began with');
    const next = await p.get('/src/value.ts');
    check('a module made under the old config is not remembered', /"two"/.test(next), next);
    p.server.stop();
  }

  // ── An edit of a tsconfig ──────────────────────────────────────────────
  {
    const p = await project({ sql: false });
    await p.get('/src/value.ts');
    await p.get('/src/value.ts');
    assert.equal(p.transforms.count, 1, 'served from memory until something changes');
    p.write('tsconfig.json', JSON.stringify({ compilerOptions: { strict: true, jsx: 'react-jsx' } }));
    const told = await p.reloaded(1);
    await p.get('/src/value.ts');
    check('an edited tsconfig drops the transformed modules', p.transforms.count === 2, `${p.transforms.count} transforms`);
    check('and reloads the browser', told, JSON.stringify(p.reloads));
    p.server.stop();
  }
  // ── vite.config's esbuild settings and plugins ────────────────────────
  {
    const p = await project({ sql: false });
    const before = await p.get('/src/view.tsx');
    check('before: the server\'s own JSX default, with no vite.config esbuild settings', /react\/jsx/.test(before), before);
    p.write('vite.config.js', "import react from '@vitejs/plugin-react';\nexport default { plugins: [react({ jsxImportSource: 'preact' })] };\n");
    await p.reloaded(1);
    const after = await p.get('/src/view.tsx');
    check('a plugin added to vite.config compiles JSX as it says', /preact\/jsx-dev-runtime/.test(after), after);
    p.write('vite.config.js', "export default { esbuild: { jsx: 'transform', jsxFactory: 'h', jsxFragment: 'Fragment' } };\n");
    await p.reloaded(2);
    const classic = await p.get('/src/view.tsx');
    check('and esbuild options in it as they say', /\bh\("b"/.test(classic), classic);
    p.server.stop();
  }

  // ── A file a tsconfig extends ──────────────────────────────────────────
  {
    const p = await project({ sql: false });
    p.write('vite.config.js', "import react from '@vitejs/plugin-react';\nexport default { plugins: [react()] };\n");
    await p.reloaded(1);
    const before = await p.get('/src/view.tsx');
    assert.match(before, /react\/jsx-dev-runtime/, before);
    // base.json is no tsconfig*.json by name: what tsconfck read is watched.
    p.write('base.json', JSON.stringify({ compilerOptions: { jsx: 'react-jsx', jsxImportSource: 'preact' } }));
    const told = await p.reloaded(2);
    const after = await p.get('/src/view.tsx');
    check('an edit of a file the tsconfig extends drops the modules and reloads', told && /preact\/jsx-dev-runtime/.test(after), after);
    p.server.stop();
  }
} finally {
  await stopEsbuildEngine();
}

assert.equal(failures.length, 0, `${failures.length} cases failed:\n  ${failures.join('\n  ')}`);
console.log('vite-dev-config-reload OK');
