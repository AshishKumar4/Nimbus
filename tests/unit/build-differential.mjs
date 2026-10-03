#!/usr/bin/env bun
// Nimbus's bundler (rolldown 1.2.11 through core runtime/rolldown-build.ts,
// what the build facet runs) against the one it replaces, esbuild-wasm 0.24.2
// (buildWithEsbuild, what the esbuild facet runs), behind the same
// EsbuildService.build and its VFS plugin, with each caller's options:
// wrangler's Worker bundle, real Vite's config bundle, and Vite dev's cold
// module. Each output is run, and what it does is compared, not its text:
// a Worker's exports and fetch answers, a module's namespace, a config's
// object, a failure's message and diagnostics.

import assert from 'node:assert/strict';
import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { EsbuildService, generateEsbuildFacetRuntimeSource } from '../../packages/core/src/runtime/esbuild-service.ts';
import { buildWithRolldown } from '../../packages/core/src/runtime/rolldown-build.ts';
import { PROJECTS, REQUESTS } from '../fixtures/build-differential/projects.mjs';

const { buildWithEsbuild } = new Function(`${generateEsbuildFacetRuntimeSource()}\nreturn { buildWithEsbuild };`)();
const fromCore = createRequire(new URL('../../packages/core/package.json', import.meta.url));
const esbuild = await import(fromCore.resolve('esbuild-wasm/esm/browser.js'));
await esbuild.initialize({ wasmModule: await WebAssembly.compile(await readFile(fromCore.resolve('esbuild-wasm/esbuild.wasm'))), worker: false });
assert.equal(esbuild.version, '0.24.2');
// rolldown's JavaScript over its native binding: the same Rust as the staged wasm (build-facet.mjs runs that).
const rolldown = await import(createRequire(new URL('../../packages/worker/package.json', import.meta.url)).resolve('rolldown'));

// Each host as the build facets call it: options and outcomes cross RPC.
const clone = (value) => structuredClone(value);
const hosts = {
  esbuild: async (options, plugin) => clone(await buildWithEsbuild(esbuild, clone(options), plugin)),
  rolldown: async (options, plugin) => clone(await buildWithRolldown(rolldown, clone(options), plugin)),
};

/** A project's files as the VFS a build reads, under /home/user/<name>. */
function memoryFs(name, files) {
  const at = new Map(Object.entries(files).map(([p, text]) => [`home/user/${name}/${p}`, typeof text === 'string' ? new TextEncoder().encode(text) : text]));
  const isDir = (p) => [...at.keys()].some((k) => k.startsWith(p.replace(/^\/+|\/+$/g, '') + '/'));
  const strip = (p) => p.replace(/^\/+/, '');
  return {
    exists: (p) => at.has(strip(p)) || isDir(p),
    isDirectory: (p) => !at.has(strip(p)) && isDir(p),
    readFile: (p) => { const b = at.get(strip(p)); if (!b) throw new Error(`ENOENT ${p}`); return b; },
    readFileString: (p) => { const b = at.get(strip(p)); if (!b) throw new Error(`ENOENT ${p}`); return new TextDecoder().decode(b); },
  };
}

// Where outputs run: a directory with stand-ins for what the builds leave external.
const scratch = join(process.env.TMPDIR ?? tmpdir(), `build-differential-${process.pid}`);
const stubs = {
  'node_modules/vite/package.json': '{"name":"vite","type":"module","exports":"./index.js"}',
  'node_modules/vite/index.js': 'export const defineConfig = (c) => c;',
  'node_modules/@vitejs/plugin-react/package.json': '{"name":"@vitejs/plugin-react","type":"module","exports":"./index.js"}',
  'node_modules/@vitejs/plugin-react/index.js': "export default function react() { return { name: 'vite:react' }; }",
  'node_modules/react/package.json': '{"name":"react","type":"module","exports":"./index.js"}',
  'node_modules/react/index.js': 'export const useState = (v) => [v, () => {}]; export default {};',
  'node_modules/react-dom/package.json': '{"name":"react-dom","type":"module","exports":{"./client":"./client.js"}}',
  'node_modules/react-dom/client.js': 'export const createRoot = () => ({});',
};
for (const [p, text] of Object.entries(stubs)) {
  mkdirSync(join(scratch, p, '..'), { recursive: true });
  writeFileSync(join(scratch, p), text);
}

function shape(value, depth = 0) {
  if (value === null || (typeof value !== 'object' && typeof value !== 'function')) return value;
  if (typeof value === 'function') return `function ${value.name}/${value.length}`;
  if (Array.isArray(value)) return value.map((v) => shape(v, depth + 1));
  if (depth > 4) return 'object';
  return Object.fromEntries(Object.keys(value).sort().map((k) => [k, shape(value[k], depth + 1)]));
}

/**
 * esbuild-wasm has no filesystem of its own: when a module cannot be
 * resolved, it also tries to list ".", and reports that it could not as one
 * more error ("Cannot read directory "."": not implemented on js"), in the
 * esbuild facet as here. Nothing of the build's sources says it; rolldown
 * reports the unresolved import alone.
 */
function withoutWasmFsNoise(outcome) {
  const noise = (text) => /^Cannot read directory ".*": not implemented on js$/.test(text);
  const errors = outcome.errors.filter((e) => !noise(e.text));
  const lines = outcome.failure.split('\n').slice(1).filter((line) => !noise(line.replace(/^error: /, '')));
  return { failure: `Build failed with ${errors.length} error${errors.length === 1 ? '' : 's'}:\n${lines.join('\n')}`, errors };
}

let outputs = 0;
async function run(project, outcome, engine, name) {
  if (outcome.failure) return { failure: outcome.failure, errors: outcome.errors };
  const file = join(scratch, `${name}.${engine}.${outputs++}.mjs`);
  writeFileSync(file, outcome.code);
  const mod = await import(file);
  if (project.run === 'module') return { namespace: shape({ ...mod }) };
  if (project.run === 'config') return { config: shape(mod.default) };
  const answers = [];
  for (const [method, path, body] of REQUESTS) {
    try {
      const res = await mod.default.fetch(new Request('https://w.test' + path, {
        method, body: body ? JSON.stringify(body) : undefined, headers: body ? { 'content-type': 'application/json' } : {},
      }), {}, { waitUntil() {} });
      answers.push(`${res.status} ${await res.text()}`);
    } catch (error) {
      answers.push(`throws ${error.constructor.name}`);
    }
  }
  return { exports: Object.keys(mod).sort(), answers };
}

try {
  for (const [name, project] of Object.entries(PROJECTS)) {
    const seen = {};
    for (const [engine, buildHost] of Object.entries(hosts)) {
      const service = new EsbuildService(memoryFs(name, project.files), { buildHost });
      let outcome;
      try {
        const result = await service.build([`/home/user/${name}/${project.entry}`], project.options);
        outcome = { code: result.outputFiles[0].contents };
      } catch (error) {
        outcome = {
          failure: error.message,
          errors: (error.errors ?? []).map((e) => ({ text: e.text, file: e.location?.file, line: e.location?.line, column: e.location?.column, lineText: e.location?.lineText })),
        };
      }
      if (outcome.errors && engine === 'esbuild') outcome = withoutWasmFsNoise(outcome);
      seen[engine] = await run(project, outcome, engine, name);
    }
    const comparable = (r) => (project.sameExceptText && r.errors
      ? { count: r.errors.length, at: r.errors.map((e) => [e.file, e.line, e.column, e.lineText]), header: r.failure.split('\n')[0] }
      : r);
    assert.deepEqual(comparable(seen.rolldown), comparable(seen.esbuild), `${name}:\n  esbuild:  ${JSON.stringify(seen.esbuild)}\n  rolldown: ${JSON.stringify(seen.rolldown)}`);
    if (project.run === 'failure') assert.ok(seen.rolldown.failure, `${name} must fail`);
    console.log(`  ok  ${name}: ${project.run === 'failure' ? 'the same failure' : 'the same behavior'}`);
  }

  // Overlapping failed builds each place their own diagnostics: what they
  // report together is what each reports alone.
  {
    const names = ['worker-syntax-error', 'worker-unresolved-every-import', 'worker-unresolved-after-same-string'];
    const failure = async (name) => {
      const project = PROJECTS[name];
      const service = new EsbuildService(memoryFs(name, project.files), { buildHost: hosts.rolldown });
      return service.build([`/home/user/${name}/${project.entry}`], project.options).then(
        () => assert.fail(`${name} must fail`),
        (error) => ({ failure: error.message, at: error.errors.map((e) => e.location && [e.location.file, e.location.line, e.location.column]) }),
      );
    };
    const alone = [];
    for (const name of names) alone.push(await failure(name));
    assert.deepEqual(await Promise.all(names.map(failure)), alone);
    assert.ok(alone.every((outcome) => outcome.at.every(Boolean)), 'every error is placed');
    console.log('  ok  overlapping failed builds each place their own diagnostics');
  }
} finally {
  rmSync(scratch, { recursive: true, force: true });
}
console.log('build-differential OK');
