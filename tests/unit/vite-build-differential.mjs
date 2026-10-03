#!/usr/bin/env bun
// The built-in `vite build` (session/vite-command.ts's options: browser ESM,
// minified, hashed names under assets/, Vite's asset semantics) with
// esbuild-wasm 0.24.2 and with Nimbus's bundler (rolldown through
// rolldown-build.ts and css-bundle.ts), behind the same EsbuildService.build
// and VFS plugin. What a deploy of `dist/` would do is compared, not text:
//
//   JavaScript  run with the assets it names: every string that is the path
//               of an emitted file (relative to the script) becomes that
//               file's bytes' digest, every data: URL its MIME type and bytes
//   stylesheet  the same for every url(), then both sheets printed by one
//               normalizer (esbuild's CSS minifier over each), so equal
//               meaning prints equal text; @import order, conditions,
//               externals and @charset all show
//   metafile    the entry's output and its cssBundle, as vite-command reads them
//   failure     the message and diagnostics
//
// The emitted file names (their hashes) differ by bundler and are not compared.

import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { EsbuildService, buildWithEsbuild } from '../../packages/core/src/runtime/esbuild-service.ts';
import { buildWithRolldown } from '../../packages/core/src/runtime/rolldown-build.ts';
import { VITE_PROJECTS, viteBuildOptions } from '../fixtures/build-differential/vite-projects.mjs';

const fromCore = createRequire(new URL('../../packages/core/package.json', import.meta.url));
const esbuild = await import(fromCore.resolve('esbuild-wasm/esm/browser.js'));
await esbuild.initialize({ wasmModule: await WebAssembly.compile(await readFile(fromCore.resolve('esbuild-wasm/esbuild.wasm'))), worker: false });
assert.equal(esbuild.version, '0.24.2');
const rolldown = await import(createRequire(new URL('../../packages/worker/package.json', import.meta.url)).resolve('rolldown'));
const clone = (value) => structuredClone(value);
const hosts = {
  esbuild: async (options, plugin) => clone(await buildWithEsbuild(esbuild, clone(options), plugin)),
  rolldown: async (options, plugin) => clone(await buildWithRolldown(rolldown, clone(options), plugin)),
};

const latin1 = (text) => Uint8Array.from(text, (c) => c.charCodeAt(0));
function memoryFs(name, files) {
  const at = new Map(Object.entries(files).map(([p, text]) => [`home/user/${name}/${p}`, typeof text !== 'string' ? text : /[^\x00-\x7f]/.test(text) && !/[^\x00-\xff]/.test(text) ? latin1(text) : new TextEncoder().encode(text)]));
  const strip = (p) => p.replace(/^\/+/, '');
  const isDir = (p) => [...at.keys()].some((k) => k.startsWith(strip(p).replace(/\/+$/, '') + '/'));
  return {
    exists: (p) => at.has(strip(p)) || isDir(p),
    isDirectory: (p) => !at.has(strip(p)) && isDir(p),
    readFile: (p) => { const b = at.get(strip(p)); if (!b) throw new Error(`ENOENT ${p}`); return b; },
    readFileString: (p) => { const b = at.get(strip(p)); if (!b) throw new Error(`ENOENT ${p}`); return new TextDecoder().decode(b); },
  };
}

const digest = (bytes) => createHash('sha256').update(bytes).digest('hex').slice(0, 12);

/** A data: URL as its MIME type (without parameters) and its bytes' digest. */
function dataUrl(url) {
  const m = /^data:([^,]*?)(;base64)?,([\s\S]*)$/.exec(url);
  if (!m) return url;
  const bytes = m[2] ? Buffer.from(m[3], 'base64') : Buffer.from(decodeURIComponent(m[3]), 'utf8');
  return `data<${m[1].split(';')[0]}:${digest(bytes)}>`;
}

/** Every emitted file, by path relative to the output root (`contents` its text, `bytes` its bytes). */
function emitted(result, root) {
  return new Map(result.outputFiles.map((f) => [f.path.replace(/^\/+/, '').slice(root.length + 1), f]));
}

/** `url` as what it names: an emitted file's digest, a data URL's bytes, or itself. */
function named(url, from, files) {
  if (url.startsWith('data:')) return dataUrl(url);
  if (/^(https?:|\/\/|#|\/)/.test(url)) return url;
  const target = new URL(url, `file:///root/${from}`).pathname.slice('/root/'.length);
  const file = files.get(decodeURIComponent(target));
  return file ? `file<${digest(file.bytes)}>` : `missing<${url}>`;
}

const scratch = join(process.env.TMPDIR ?? tmpdir(), `vite-build-differential-${process.pid}`);
const stubs = {
  'node_modules/react/package.json': '{"name":"react","type":"module","exports":"./index.js"}',
  'node_modules/react/index.js': 'const createElement = (type, props, ...children) => ({ type, props: { ...props, children } }); export default { createElement, Fragment: "F" }; export { createElement };',
};
for (const [p, text] of Object.entries(stubs)) {
  mkdirSync(join(scratch, p, '..'), { recursive: true });
  writeFileSync(join(scratch, p), text);
}

async function normalizeCss(css, from, files) {
  const urls = css.replace(/url\(\s*(?:"([^"]*)"|'([^']*)'|([^)]*?))\s*\)/g, (_, a, b, c) => `url("${named(a ?? b ?? c, from, files)}")`);
  return (await esbuild.transform(urls, { loader: 'css', minify: true, logLevel: 'silent' })).code;
}

let n = 0;
async function observe(name, project, result) {
  const root = `home/user/${name}/dist`;
  const files = emitted(result, root);
  const entryRel = Object.entries(result.metafile.outputs).find(([, o]) => o.entryPoint)?.[0];
  assert.ok(entryRel, `${name}: the metafile names the entry's output`);
  const entryName = entryRel.slice(root.length + 1);
  const cssRel = result.metafile.outputs[entryRel].cssBundle;
  const seen = { entryPoint: result.metafile.outputs[entryRel].entryPoint, files: [...files.keys()].map((k) => k.replace(/-[A-Za-z0-9_-]{8}(?=\.)/, '-[hash]')).sort() };
  const js = files.get(entryName).contents;
  // Every string the script holds that names an emitted file or is a data URL, as what it names.
  const file = join(scratch, `${name}.${n++}.mjs`);
  writeFileSync(file, js);
  delete globalThis.__result;
  await import(file);
  const resolveValue = (value) => {
    if (typeof value === 'string') return value.startsWith('data:') ? dataUrl(value) : files.has(new URL(value, `file:///root/${entryName}`).pathname.slice('/root/'.length)) ? named(value, entryName, files) : value;
    if (Array.isArray(value)) return value.map(resolveValue);
    if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, resolveValue(v)]));
    return value;
  };
  seen.result = resolveValue(globalThis.__result);
  if (cssRel) seen.css = await normalizeCss(files.get(cssRel.slice(root.length + 1)).contents, cssRel.slice(root.length + 1), files);
  return seen;
}

try {
  for (const [name, project] of Object.entries(VITE_PROJECTS)) {
    const seen = {};
    for (const [engine, buildHost] of Object.entries(hosts)) {
      const service = new EsbuildService(memoryFs(name, project.files), { buildHost });
      try {
        const result = await service.build([`/home/user/${name}/${project.entry}`], viteBuildOptions(name));
        seen[engine] = await observe(name, project, result);
      } catch (error) {
        seen[engine] = {
          failure: String(error.message).replace(/^Build failed with (\d+) errors?:\n(error: Cannot read directory ".*": not implemented on js\n)?/, 'Build failed:\n'),
          errors: (error.errors ?? []).filter((e) => !/^Cannot read directory/.test(e.text)).map((e) => ({ text: e.text, file: e.location?.file, line: e.location?.line, column: e.location?.column })),
        };
      }
    }
    assert.deepEqual(seen.rolldown, seen.esbuild, `${name}:\n  esbuild:  ${JSON.stringify(seen.esbuild)}\n  rolldown: ${JSON.stringify(seen.rolldown)}`);
    assert.equal(Boolean(seen.rolldown.failure), Boolean(project.fails), `${name}: ${project.fails ? "must fail" : "must build"}: ${JSON.stringify(seen.esbuild).slice(0, 600)}`);
    console.log(`  ok  ${name}: ${project.fails ? 'the same failure' : `the same app${seen.rolldown.css ? ' and stylesheet' : ''}`}`);
  }
} finally {
  rmSync(scratch, { recursive: true, force: true });
}
console.log('vite-build-differential OK');
