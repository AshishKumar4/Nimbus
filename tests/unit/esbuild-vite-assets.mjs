#!/usr/bin/env bun
// esbuild-vite-assets — the `viteAssets` build mode in EsbuildService must
// give imported assets Vite semantics: emitted hashed files whose URL is
// the module's default export, `?url`/`?raw`/`?inline` suffixes, CSS
// `url()` emission + rewrite, and public/ absolute-import passthrough.
//
// Regression pinned: G4 — the built-in `vite build` handed `.png`/`.svg`
// to the JS loader, so `npm run build` on the canonical create-vite
// template died with "Unexpected \"\"" / "The JSX syntax extension is not
// currently enabled" while `npm run dev` worked.
//
// Service, esbuild-wasm, resolver plugin and SQLite VFS stay real (same
// shim pattern as esbuild-vfs-credentials.mjs).

import assert from 'node:assert/strict';
import { plugin } from 'bun';
import { readFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { CRED_KERNEL } from '../../packages/core/src/runtime/os-contracts.ts';
import { SqliteVFS } from '../../packages/core/src/vfs/sqlite-vfs.ts';
import { createSqliteVfsTestHarness } from './sqlite-vfs-test-harness.mjs';

const resolveFromCore = createRequire(new URL('../../packages/core/package.json', import.meta.url));
const wasmModule = await WebAssembly.compile(
  await readFile(resolveFromCore.resolve('esbuild-wasm/esbuild.wasm')),
);
plugin({
  name: 'esbuild-wasm-asset',
  setup(build) {
    build.onLoad({ filter: /esbuild-wasm\/esbuild\.wasm$/ }, () => ({
      exports: { default: wasmModule },
      loader: 'object',
    }));
  },
});
const { EsbuildService, loadEsbuild } = await import('../../packages/core/src/runtime/esbuild-service.ts');
const {
  VITE_FILE_LOADER_EXTS,
  splitImportQuery,
  viteAssetLoader,
} = await import('../../packages/core/src/runtime/vite-assets.ts');

const harness = createSqliteVfsTestHarness();
const raw = new SqliteVFS(harness.sql, harness.ctx);
const kernel = raw.as(CRED_KERNEL);

const ROOT = '/home/user/vt';
const BUILD_OPTS = {
  bundle: true, format: 'esm', target: 'es2020', platform: 'browser',
  minify: false, outdir: `${ROOT}/dist`,
  entryNames: 'assets/[name]-[hash]',
  chunkNames: 'assets/[name]-[hash]',
  assetNames: 'assets/[name]-[hash]',
  viteAssets: true,
  vitePublicDir: `${ROOT}/public`,
};

// A create-vite-shaped project.
kernel.mkdir(`${ROOT}/src/assets`, { recursive: true });
kernel.mkdir(`${ROOT}/src/fonts`, { recursive: true });
kernel.mkdir(`${ROOT}/public`, { recursive: true });
kernel.writeFile(`${ROOT}/src/assets/hero.png`, new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0xff]));
kernel.writeFile(`${ROOT}/src/assets/react.svg`, '<svg xmlns="http://www.w3.org/2000/svg"><path d="M0 0"/></svg>');
kernel.writeFile(`${ROOT}/src/fonts/inter.woff2`, new Uint8Array([0x77, 0x4f, 0x46, 0x32, 0x00, 0x01]));
kernel.writeFile(`${ROOT}/src/data.txt`, 'raw text payload');
kernel.writeFile(`${ROOT}/public/vite.svg`, '<svg>public</svg>');
kernel.writeFile(`${ROOT}/src/style.css`, '.hero { background: url(./assets/hero.png); }\n@font-face { src: url(./fonts/inter.woff2); }');
kernel.writeFile(`${ROOT}/src/main.tsx`, `
import logoUrl from './assets/react.svg';
import heroUrl from './assets/hero.png';
import rawText from './data.txt?raw';
import inlineSvg from './assets/react.svg?inline';
import forcedUrl from './data.txt?url';
import publicIcon from '/vite.svg';
import './style.css';
export { logoUrl, heroUrl, rawText, inlineSvg, forcedUrl, publicIcon };
`);

try {
  // ── Loader map ──────────────────────────────────────────────────────
  {
    assert.equal(viteAssetLoader('/x/logo.svg'), 'file', '.svg is an emitted file');
    assert.equal(viteAssetLoader('/x/logo.PNG'), 'file', 'extension match is case-insensitive');
    for (const ext of ['.jpg', '.jpeg', '.gif', '.webp', '.avif', '.ico', '.woff', '.woff2', '.ttf', '.otf', '.mp4', '.webm', '.mp3', '.wasm']) {
      assert.equal(viteAssetLoader(`/x/a${ext}`), 'file', `${ext} → file loader`);
      assert.ok(VITE_FILE_LOADER_EXTS[ext], `${ext} in the table`);
    }
    assert.equal(viteAssetLoader('/x/a.png?url'), 'file');
    assert.equal(viteAssetLoader('/x/a.js?url'), 'file', '?url forces file on any ext');
    assert.equal(viteAssetLoader('/x/a.png?raw'), 'text');
    assert.equal(viteAssetLoader('/x/a.png?inline'), 'dataurl');
    assert.equal(viteAssetLoader('/x/a.css?inline'), 'text', '?inline on CSS yields stylesheet text');
    assert.equal(viteAssetLoader('/x/a.png?base64'), 'base64');
    assert.equal(viteAssetLoader('/x/a.ts'), undefined, 'non-asset ext defers to normal inference');
    assert.equal(viteAssetLoader('/x/a.png?worker'), 'file', 'unknown modifiers still reach a loader — the resolver rejects them first');
    assert.deepEqual(splitImportQuery('/x/a.png?raw'), ['/x/a.png', 'raw']);
    assert.deepEqual(splitImportQuery('/x/a.png'), ['/x/a.png', '']);
    console.log('esbuild-vite-assets: loader map is extension/modifier-keyed');
  }

  const service = new EsbuildService(kernel);

  // ── Red-then-green: same .svg import fails as JS without viteAssets ───
  // (esbuild's build() REJECTS on failure — errors never reach result.errors)
  {
    const failure = await service.build([`${ROOT}/src/main.tsx`], {
      bundle: true, format: 'esm', platform: 'browser',
      outdir: `${ROOT}/dist-off`,
    }).then(
      () => { throw new Error('asset import without viteAssets must still error'); },
      (e) => e,
    );
    assert.match(
      failure.message,
      /JSX syntax extension|Unexpected/,
      'the pre-fix failure mode parses the .svg as JS/JSX',
    );
    console.log('esbuild-vite-assets: .svg still errors as JS when viteAssets is off (red)');
  }

  // ── Green: the full asset pipeline ───────────────────────────────────
  {
    const result = await service.build([`${ROOT}/src/main.tsx`], BUILD_OPTS);
    assert.deepEqual(result.errors, [], `build errors: ${result.errors.map(e => e.text).join('; ')}`);

    const names = result.outputFiles.map(f => f.path.slice(ROOT.length + 1)).sort();
    const js = result.outputFiles.find(f => f.path.endsWith('.js'));
    const css = result.outputFiles.find(f => f.path.endsWith('.css'));
    const emitted = (ext) => names.filter(n => n.startsWith('dist/assets/') && n.endsWith(ext));

    assert.ok(js, 'a JS entry was emitted');
    assert.match(js.path, /\/dist\/assets\/main-[A-Za-z0-9]+\.js$/, 'entry named assets/<name>-<hash>.js');
    const jsCode = js.contents;

    // .svg + .png → hashed emitted files; the JS imports them as URLs.
    assert.equal(emitted('.svg').length, 1, `exactly one emitted .svg (public/vite.svg must NOT be emitted): ${names}`);
    assert.equal(emitted('.png').length, 1, `one emitted .png: ${names}`);
    assert.equal(emitted('.woff2').length, 1, `css url() font emitted: ${names}`);
    assert.equal(emitted('.txt').length, 1, `?url-forced .txt emitted: ${names}`);
    const svgRel = './' + emitted('.svg')[0].slice('dist/assets/'.length);
    const pngRel = './' + emitted('.png')[0].slice('dist/assets/'.length);
    assert.ok(jsCode.includes(JSON.stringify(svgRel)), `js references ${svgRel}: ${jsCode.slice(0, 400)}`);
    assert.ok(jsCode.includes(JSON.stringify(pngRel)), 'js references emitted .png url');

    // Emitted bytes are byte-exact, not UTF-8-decoded-then-reencoded.
    const pngOut = result.outputFiles.find(f => f.path.endsWith('.png'));
    assert.deepEqual([...pngOut.bytes], [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0xff]);

    // ?raw → file text; ?inline → data: URL; ?url on .txt → emitted file.
    assert.ok(jsCode.includes('raw text payload'), 'raw import bundles the file text');
    assert.ok(jsCode.includes('data:image/svg+xml'), 'inline import bundles a data URL');
    const txtRel = './' + emitted('.txt')[0].slice('dist/assets/'.length);
    assert.ok(jsCode.includes(JSON.stringify(txtRel)), '?url on a .txt yields its emitted path');

    // public/ absolute import → literal URL string, file NOT re-emitted.
    assert.ok(jsCode.includes('"/vite.svg"'), `public file imports its verbatim URL: ${jsCode.slice(0, 400)}`);
    assert.ok(!names.some(n => n.endsWith('.svg') && n.includes('vite-')), 'public asset not hashed into dist/assets');

    // CSS url() → emitted hashed file; the emitted CSS points at it.
    assert.ok(css, 'entry CSS emitted as a sidecar');
    const woffRel = emitted('.woff2')[0].slice('dist/assets/'.length);
    assert.ok(css.contents.includes(woffRel), `css url() rewritten to hashed asset: ${css.contents}`);
    assert.ok(css.contents.includes('hero'), 'css url() rewritten to hashed png');

    // Metafile identifies the entry + its cssBundle (no ordering guesses).
    const entryOutput = Object.entries(result.metafile.outputs).find(([, o]) => o.entryPoint);
    assert.ok(entryOutput, 'metafile names the entry output');
    // Metafile keys are outdir-relative (no leading slash) — normalize both.
    assert.equal(entryOutput[0], js.path.replace(/^\/+/, ''));
    assert.equal(entryOutput[1].cssBundle, css.path.replace(/^\/+/, ''));
    console.log('esbuild-vite-assets: emitted hashed assets, suffix loaders, css url(), public/ passthrough all verified');
  }

  // ── Unsupported ? modifiers error loudly ─────────────────────────────
  {
    kernel.writeFile(`${ROOT}/src/with-worker.ts`, `import w from './data.txt?worker';\nexport default w;\n`);
    const failure = await service.build([`${ROOT}/src/with-worker.ts`], BUILD_OPTS).then(
      () => { throw new Error('?worker must not silently bundle'); },
      (e) => e,
    );
    assert.match(failure.message, /does not support the '\?worker' import modifier/);
    console.log('esbuild-vite-assets: unsupported ?worker modifier rejected loudly');
  }

  console.log('esbuild-vite-assets: PASS');
} finally {
  (await loadEsbuild()).stop();
  harness.db.close();
}
