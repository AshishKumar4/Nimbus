#!/usr/bin/env bun
// With a build host, build() runs the bundler in the host (the session's
// build facet: rolldown over the staged binding) and only the VFS plugin
// here, so every read keeps the caller's view.
//
// build() used to run esbuild-wasm in the caller's isolate, whose esbuild heap
// only grows. On a throwaway at main 9401b6c9, `npm install` then `vite build`
// reset the session with exceededMemory at 200.4 MiB.
//
// The host is the facet module production loads (buildFacetWorkerCode over the
// staged parts, lib/build-facet-harness.mjs). Options, outcome and a thrown
// error cross a structured clone, as they cross RPC: an error keeps its
// message and loses every other property.

import assert from 'node:assert/strict';
import { CRED_KERNEL, CRED_SESSION_USER } from '../../packages/core/src/runtime/os-contracts.ts';
import { SqliteVFS } from '../../packages/core/src/vfs/sqlite-vfs.ts';
import { EsbuildService } from '../../packages/core/src/runtime/esbuild-service.ts';
import { rolldownBuildHost } from '../../packages/worker/src/facets/build-facet.ts';
import { createSqliteVfsTestHarness } from './sqlite-vfs-test-harness.mjs';
import { durableObject, freshFacetClass, memories, releaseBuildFacetHarness } from './lib/build-facet-harness.mjs';

const { BuildFacet, cleanup } = await freshFacetClass();
const { ctx, env } = durableObject(BuildFacet);
const host = rolldownBuildHost(ctx, env);
const buildHost = async (options, remote) => {
  try {
    return await host(options, remote);
  } catch (error) {
    throw structuredClone(error);
  }
};

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
  assert.equal(memories.length, 1, 'the host made one rolldown binding');
  console.log('  ok  build() bundles in the host from the caller\'s VFS; no bundler in this isolate');
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

// ── A failed build rejects with esbuild's own message and its diagnostics ───
// Kinu's slate compile reads `errors` to tell a slate's own mistake from a host
// failure; a thrown BuildFailure crossed RPC as its message alone (2026-09-30).
{
  author.writeFile('home/user/app/src/broken.ts', "import { nope } from './missing';\nexport default nope;\n");
  const service = new EsbuildService(author, { buildHost });
  const failure = await service.build(['/home/user/app/src/broken.ts']).then(() => null, (error) => error);
  assert.ok(failure instanceof Error, 'the build rejects');
  assert.match(failure.message, /Could not resolve "\.\/missing"/);
  assert.ok(Array.isArray(failure.errors), 'the failure keeps esbuild\'s diagnostics across RPC');
  assert.ok(failure.errors.some(({ text }) => /Could not resolve "\.\/missing"/.test(text)), failure.errors.map(({ text }) => text).join('; '));
  assert.deepEqual(failure.warnings, []);
  console.log('  ok  an unresolvable import fails the build with esbuild\'s message and diagnostics');
}

// ── A diagnostic keeps its notes and its plugin across RPC ──────────────────
// A duplicate declaration's error carries a note pointing at the original;
// a local build used to throw esbuild's own failure with it.
{
  author.writeFile('home/user/app/src/twice.ts', 'let x = 1;\nlet x = 2;\nexport default x;\n');
  const service = new EsbuildService(author, { buildHost });
  const failure = await service.build(['/home/user/app/src/twice.ts']).then(() => null, (error) => error);
  const duplicate = failure?.errors?.find(({ text }) => /already been declared/.test(text));
  assert.ok(duplicate, `the duplicate declaration is reported: ${failure?.message}`);
  // Oxc places the error at the original declaration and labels the
  // redeclaration (esbuild did the reverse); the other place is the note.
  assert.equal(duplicate.notes.length, 1, 'with its note');
  assert.deepEqual([duplicate.location?.line, duplicate.notes[0].location?.line].sort(), [1, 2], 'the two declarations');
  assert.equal(typeof duplicate.id, 'string');
  assert.equal(duplicate.detail, undefined, 'and no detail, which may not clone');
  console.log('  ok  a diagnostic keeps its notes across RPC');
}

harness.db.close();
cleanup();
releaseBuildFacetHarness();
console.log('build-host OK');
