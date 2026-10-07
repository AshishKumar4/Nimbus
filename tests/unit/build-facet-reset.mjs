#!/usr/bin/env bun
// A pre-bundle whose build facet is reset under it ("Durable Object's isolate
// exceeded its memory limit and was reset."): a reset is transient and a
// pre-bundle is pure, so it runs once more on a fresh facet, logged; a second
// reset fails it naming the package and why. The Vite dev server then serves
// a module that tells the page that cause: before, it served a stub whose only
// export was a throwing default, so an importer of `twMerge` failed to link
// with "does not provide an export named 'twMerge'" (Markflow on staging,
// session fast-crystal-1390), a missing export that was never missing.
//
//   - one reset: the retry answers, one warning says so;
//   - two resets: BuildFacetResetError, naming the package and the reason;
//   - a facet that cannot load is that error, not retried;
//   - the dev server, its pool failing so: the module it serves links against
//     what the project imports (an ESM package, a CommonJS one, a package
//     re-exporting with `export *`, one with a key no export name can be,
//     one whose entry is past what the scan reads) and throws the cause as
//     it evaluates.

import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { createRequire } from 'node:module';
import { EsbuildService } from '../../packages/core/src/runtime/esbuild-service.ts';
import { CRED_KERNEL } from '../../packages/core/src/runtime/os-contracts.ts';
import { SqliteVFS } from '../../packages/core/src/vfs/sqlite-vfs.ts';
import { BuildFacetResetError, buildFacetPrebundler } from '../../packages/worker/src/facets/build-facet.ts';
import { ViteDevServer } from '../../packages/worker/src/facets/vite-dev-server.ts';
import { durableObject, freshFacetClass, memories, releaseBuildFacetHarness } from './lib/build-facet-harness.mjs';
import { esbuildEngine, stopEsbuildEngine } from './lib/esbuild-engine.mjs';
import { createSqliteVfsTestHarness } from './lib/sqlite-vfs-test-harness.mjs';

const RESET = "Durable Object's isolate exceeded its memory limit and was reset.";
// The spec's module grammar, as V8 reads it (Bun's accepts a string export name holding a lone surrogate; V8 does not).
const acorn = createRequire(new URL('../../packages/core/package.json', import.meta.url))('acorn');
const encoder = new TextEncoder();
const failures = [];
const check = (name, ok, detail) => {
  if (!ok) failures.push(`${name}: ${detail}`);
  console.log(`  ${ok ? 'ok ' : 'RED'} ${name}`);
};

/** A pre-bundle of a two-module package. */
const spec = (tag) => {
  const root = `/home/user/${tag}/node_modules/pkg`;
  return {
    specifier: 'pkg', entryPath: `${root}/index.js`, externals: [], bundlerVersion: 'build-facet-reset',
    slice: [
      { path: root, isDir: true },
      { path: `${root}/package.json`, isDir: false, bytes: encoder.encode('{"name":"pkg","type":"module"}') },
      { path: `${root}/index.js`, isDir: false, bytes: encoder.encode(`export const v = ${JSON.stringify(tag)};\n`) },
    ],
  };
};

/** `console.warn`'s lines while `run` runs. */
async function warnings(run) {
  const warn = console.warn;
  const lines = [];
  console.warn = (line) => lines.push(String(line));
  try {
    return { value: await run().then((value) => ({ value }), (error) => ({ error })), lines };
  } finally {
    console.warn = warn;
  }
}

const scratch = mkdtempSync(join(process.env.TMPDIR ?? tmpdir(), 'build-facet-reset-'));
try {
  // ── The pre-bundler ────────────────────────────────────────────────────
  /**
   * A Durable Object whose build facet is reset under its first `resets`
   * pre-bundles, as workerd resets one: the call is rejected with the reason
   * and the actor goes with its isolate (the harness's abort), so the next
   * call gets a new actor, from a fresh evaluation of the facet's module (a
   * fresh isolate: its own binding).
   */
  const resettingHost = (resets) => {
    let left = resets;
    const host = durableObject(null, async () => {
      const { BuildFacet: Fresh } = await freshFacetClass();
      return class extends Fresh {
        prebundle(s) {
          if (left <= 0) return super.prebundle(s);
          left--;
          host.ctx.facets.abort(host.counts.loaderIds.at(-1), new Error(RESET));
          return new Promise(() => {});
        }
      };
    });
    return host;
  };
  {
    const { ctx, env, counts } = resettingHost(1);
    const bindings = memories.length;
    const { value, lines } = await warnings(() => buildFacetPrebundler(ctx, env)(spec('once')));
    check('a pre-bundle reset once is pre-bundled again, and answers', value.value?.ok === true && value.value.esmCode.includes('"once"'), JSON.stringify(value.error?.message ?? value.value).slice(0, 300));
    check('the retry is logged, naming the package and the reset', lines.length === 1 && lines[0].includes('pkg') && lines[0].includes(RESET) && /once more/.test(lines[0]), JSON.stringify(lines));
    check('on a new actor, from a fresh evaluation, with a binding of its own', counts.facetInstances === 2 && counts.loaderGets === 2 && memories.length === bindings + 1, `${counts.facetInstances} actors, ${counts.loaderGets} loads, ${memories.length - bindings} bindings`);
  }
  {
    const { ctx, env, counts } = resettingHost(2);
    const { value } = await warnings(() => buildFacetPrebundler(ctx, env)(spec('twice')));
    const error = value.error;
    check('a pre-bundle reset twice fails with BuildFacetResetError', error instanceof BuildFacetResetError, String(error ?? JSON.stringify(value.value)).slice(0, 300));
    check('its message names the package and the reason', /build facet was reset twice while pre-bundling pkg/.test(error?.message ?? '') && (error?.message ?? '').includes(RESET), error?.message);
    check('after one retry, not more', counts.facetInstances === 2, `${counts.facetInstances} actors`);
  }
  {
    const { ctx, env } = durableObject(null, async () => { throw new Error('the staged parts are corrupt'); });
    const { value, lines } = await warnings(() => buildFacetPrebundler(ctx, env)(spec('load')));
    check('a facet that cannot load is the load\'s error, not retried', /staged parts are corrupt/.test(value.error?.message ?? '') && !(value.error instanceof BuildFacetResetError) && lines.length === 0, `${value.error?.message}; ${JSON.stringify(lines)}`);
  }

  // ── The dev server, its pool reset twice ───────────────────────────────
  const root = 'home/user/app';
  /** What the dev server serves for /@modules/<specifier> when every pre-bundle is reset twice, and what importing `names` from it does. */
  async function servedOnReset(tag, files, specifier, imports) {
    const harness = createSqliteVfsTestHarness();
    const vfs = new SqliteVFS(harness.sql, harness.ctx);
    const kernel = vfs.as(CRED_KERNEL);
    for (const [path, content] of Object.entries(files)) {
      const at = `${root}/${path}`;
      kernel.mkdir(at.slice(0, at.lastIndexOf('/')), { recursive: true, mode: 0o755 });
      kernel.writeFile(at, encoder.encode(content), { mode: 0o644 });
    }
    const pool = { prebundle: async (s) => { throw new BuildFacetResetError(s.specifier, RESET); } };
    const server = new ViteDevServer({
      vfs, cred: CRED_KERNEL, esbuild: new EsbuildService(undefined, { engine: esbuildEngine }), root, sql: harness.sql,
      onHmrMessage() {}, basePath: '/preview', port: 5173, bundlePool: { acquire: async () => pool },
    });
    const logged = [];
    const error = console.error;
    console.error = (...args) => logged.push(args.join(' '));
    let response;
    try {
      response = await server.handleRequest(new Request(`http://localhost/preview/@modules/${specifier}`), `/@modules/${specifier}`);
    } finally {
      console.error = error;
      server.stop?.();
    }
    const code = await response.text();
    // The page's importer, and the module as served, beside it.
    const dir = join(scratch, tag);
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, 'served.mjs'), code);
    writeFileSync(join(dir, 'importer.mjs'), `import { ${imports.join(', ')} } from './served.mjs';\nexport const used = [${imports.map((i) => i.split(' as ').pop()).join(', ')}];\n`);
    const printed = [];
    console.error = (...args) => printed.push(args.join(' '));
    let outcome;
    try {
      outcome = await import(pathToFileURL(join(dir, 'importer.mjs')).href).then(() => 'it ran', (e) => e);
    } finally {
      console.error = error;
    }
    return { response, code, outcome };
  }
  const cases = [
    {
      tag: 'esm', specifier: 'tailwind-merge', imports: ['twMerge'],
      files: {
        'package.json': JSON.stringify({ name: 'app', dependencies: { 'tailwind-merge': '3.7.0' } }),
        'src/lib/utils.ts': "import { twMerge } from 'tailwind-merge';\nexport const cn = (...a: string[]) => twMerge(a.join(' '));\n",
        'node_modules/tailwind-merge/package.json': JSON.stringify({ name: 'tailwind-merge', version: '3.7.0', type: 'module', exports: { '.': { import: './dist/bundle-mjs.mjs' } } }),
        'node_modules/tailwind-merge/dist/bundle-mjs.mjs': 'const twJoin = (...a) => a.join(" ");\nconst twMerge = twJoin;\nexport { twJoin, twMerge };\n',
      },
    },
    {
      tag: 'cjs', specifier: 'clsx-ish', imports: ['clsx', 'default as whole'],
      files: {
        'package.json': JSON.stringify({ name: 'app' }),
        'src/main.ts': "import { clsx } from 'clsx-ish';\nconsole.log(clsx);\n",
        'node_modules/clsx-ish/package.json': JSON.stringify({ name: 'clsx-ish', main: 'index.js' }),
        'node_modules/clsx-ish/index.js': 'function clsx() { return ""; }\nmodule.exports = clsx;\nmodule.exports.clsx = clsx;\n',
      },
    },
    {
      // A CommonJS key that is no well-formed string (a lone surrogate) is no export name: left out, the rest link.
      tag: 'surrogate', specifier: 'odd-keys', imports: ['fine'],
      files: {
        'package.json': JSON.stringify({ name: 'app' }),
        'src/main.ts': "import { fine } from 'odd-keys';\nconsole.log(fine);\n",
        'node_modules/odd-keys/package.json': JSON.stringify({ name: 'odd-keys', main: 'index.js' }),
        'node_modules/odd-keys/index.js': 'exports.fine = 1;\nexports["\\ud800"] = 2;\nexports["two words"] = 3;\nexports.__nimbus_missing = 4;\n',
      },
    },
    {
      // An entry past what the scan reads (1 MiB) adds no names; the project's own imports still link.
      tag: 'huge', specifier: 'huge-pkg', imports: ['big'], unscanned: 'pad',
      files: {
        'package.json': JSON.stringify({ name: 'app' }),
        'src/main.ts': "import { big } from 'huge-pkg';\nconsole.log(big);\n",
        'node_modules/huge-pkg/package.json': JSON.stringify({ name: 'huge-pkg', type: 'module', module: 'index.js', main: 'index.js' }),
        'node_modules/huge-pkg/index.js': `export const big = 1;\nexport const ${'pad'.repeat(1)} = ${JSON.stringify('x'.repeat(1536 * 1024))};\n`,
      },
    },
    {
      tag: 'star', specifier: 'ui-kit', imports: ['Button', 'Card'],
      files: {
        'package.json': JSON.stringify({ name: 'app' }),
        'src/main.ts': "import { Button } from 'ui-kit';\nconsole.log(Button);\n",
        'node_modules/ui-kit/package.json': JSON.stringify({ name: 'ui-kit', type: 'module', module: 'index.js', main: 'index.js' }),
        'node_modules/ui-kit/index.js': "export * from './button.js';\nexport * from './card';\n",
        'node_modules/ui-kit/button.js': 'export const Button = 1;\n',
        'node_modules/ui-kit/card.js': 'export function Card() {}\n',
      },
    },
  ];
  for (const { tag, specifier, imports, files, unscanned } of cases) {
    const { response, code, outcome } = await servedOnReset(tag, files, specifier, imports);
    const message = outcome instanceof Error ? outcome.message : String(outcome);
    check(`${tag}: the module served links against { ${imports.join(', ')} } and throws the cause`, outcome instanceof Error && !(outcome instanceof SyntaxError) && /build facet was reset twice while pre-bundling/.test(message) && message.includes(specifier), `${outcome?.constructor?.name}: ${message.slice(0, 300)}`);
    let parsed = 'it parses';
    try {
      acorn.parse(code, { sourceType: 'module', ecmaVersion: 'latest' });
    } catch (error) {
      parsed = String(error?.message ?? error);
    }
    check(`${tag}: the module served is a module by the spec's grammar`, parsed === 'it parses', parsed);
    if (unscanned) check(`${tag}: the entry past the scan's bound was not read`, !code.includes(` as ${unscanned}`), code.slice(0, 300));
    check(`${tag}: not cached, and says why it is not a bundle`, response.status === 200 && response.headers.get('cache-control') === 'no-store' && response.headers.get('x-nimbus-bundle-status') === 'bundle-failed', `${response.status} ${JSON.stringify([...response.headers])} ${code.slice(0, 200)}`);
  }
} finally {
  releaseBuildFacetHarness();
  await stopEsbuildEngine?.();
  rmSync(scratch, { recursive: true, force: true });
}

assert.equal(failures.length, 0, `${failures.length} failed:\n  ${failures.join('\n  ')}`);
console.log('build-facet-reset OK');
