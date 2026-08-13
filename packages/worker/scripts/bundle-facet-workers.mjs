#!/usr/bin/env node
/**
 * bundle-facet-workers.mjs — Produce the source strings that Nimbus
 * injects into dynamic workers.
 *
 * WHY this exists:
 *   Dynamic workers (NimbusFacetPool / NimbusLoaderPool) receive their
 *   module source as strings — they cannot import supervisor modules,
 *   and user functions cannot capture supervisor closure variables. Any
 *   TypeScript the injected code needs must therefore be esbuild-bundled
 *   into a self-contained source string at build time.
 *
 *   For the npm install facet we need the streaming tar parser
 *   (@nimbus-sh/core src/_shared/tarball-stream.ts) available as a
 *   top-level named export
 *   the user function can call. We esbuild-bundle that source file into
 *   a self-contained ES module string, and NimbusFacetPool's `preamble`
 *   option splices it into the generated module between the
 *   WorkerEntrypoint import and the user function.
 *
 *   The virtual socket kernel (src/runtime/virtual-socket-kernel.ts) is
 *   bundled the same way, but as an IIFE that installs
 *   globalThis.__nimbusVirtualSockets — python-runner and ruby-runner
 *   splice it into their socket process worker module sources.
 *
 *   The WASI shim (src/runtime/wasi/preamble.ts) is bundled as a flat ESM
 *   body, NOT an IIFE: runners and tests append `export { __wasiInitFS, … }`
 *   to the emitted string and wasi-threads.ts is concatenated after it into
 *   the same evaluated scope, so its declarations have to stay at top level.
 *   `requiredTopLevel` below asserts exactly that.
 *
 * Output:
 *   src/loaders/generated-workers.ts — exports
 *       TAR_STREAM_PREAMBLE: string
 *       W7_FRAME_PREAMBLE: string         (W7 — streaming bulk-write encoder)
 *   @nimbus-sh/core src/runtime/virtual-socket-kernel.generated.ts — exports
 *       VIRTUAL_SOCKET_KERNEL_SRC: string
 *   @nimbus-sh/core src/runtime/wasi-instance.generated.ts — exports
 *       WASI_INSTANCE_BODY_SRC: string
 *   @nimbus-sh/core src/runtime/bash-runner.generated.ts — exports
 *       BASH_RUNNER_BODY_SRC: string
 *
 * Runs as a postinstall + predev + predeploy step via package.json.
 */

import { build } from 'esbuild';
import { writeFileSync, mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const root = join(__dirname, '..');
const coreRoot = join(root, '..', 'core');

/**
 * Bundle one TS source into a self-contained ESM string suitable for
 * inlining as a facet preamble. Strips the leading `export` on
 * declarations and the aggregate `export { ... };` block so the
 * blob is inlinable into another module without re-export errors.
 */
async function bundleAsPreamble(entryPath, label) {
  const result = await build({
    entryPoints: [entryPath],
    bundle: true,
    format: 'esm',
    target: 'esnext',
    platform: 'neutral',
    absWorkingDir: root,
    write: false,
    logLevel: 'warning',
    legalComments: 'none',
    // Strip TypeScript-only imports (e.g. `import type {…}`) — esbuild
    // already drops these, but leave the option default.
  });
  if (!result.outputFiles || result.outputFiles.length === 0) {
    throw new Error(`[bundle-facet-workers/${label}] esbuild produced no output`);
  }
  let stripped = result.outputFiles[0].text;
  stripped = stripped.replace(/^export\s+(async\s+function|function|const|class)\b/gm, '$1');
  stripped = stripped.replace(/\n?export\s*\{[^}]*\}\s*;\s*$/g, '');
  return stripped;
}

/**
 * Bundle the typed virtual socket kernel into a self-contained IIFE that
 * installs globalThis.__nimbusVirtualSockets. IIFE format keeps every
 * kernel identifier scoped, so the source can be spliced into any dynamic
 * worker module without colliding with runtime preambles. No minification:
 * injected source is serialized as text, and whole-bundle minification or
 * helper renaming breaks the injection contract.
 */
async function bundleVirtualSocketKernel() {
  const result = await build({
    stdin: {
      contents: [
        "import { installVirtualSocketKernel } from './src/runtime/virtual-socket-kernel.ts';",
        'installVirtualSocketKernel();',
      ].join('\n'),
      resolveDir: coreRoot,
      loader: 'ts',
    },
    bundle: true,
    format: 'iife',
    target: 'esnext',
    platform: 'neutral',
    absWorkingDir: root,
    write: false,
    logLevel: 'warning',
    legalComments: 'none',
  });
  if (!result.outputFiles || result.outputFiles.length === 0) {
    throw new Error('[bundle-facet-workers/virtual-socket-kernel] esbuild produced no output');
  }
  return result.outputFiles[0].text;
}

/**
 * Symbols the emitted WASI body must declare at top level. Runners and tests
 * append `export { … }` to the string and wasi-threads is concatenated into the
 * same scope, so any of these that esbuild renamed or scoped would be a
 * ReferenceError inside the facet — visible only as a dead guest.
 */
const WASI_REQUIRED_TOP_LEVEL = [
  '__wasiInitFS',
  '__wasiMakeImports',
  '__wasiRunStart',
  '__wasiRunStartAsync',
  '__wasiReadFilesB64',
  '__wasiAdoptSupervisor',
  '__wasiDrainPersist',
  '__wasiRevalidateFS',
  'fdTable',
];

/**
 * Bundle the typed WASI shim into a flat ESM body.
 *
 * No IIFE and no minification: the declarations have to stay at top level (see
 * WASI_REQUIRED_TOP_LEVEL), and the string is spliced into another module, so
 * anything that renames identifiers breaks the injection contract.
 * `cloudflare:sockets` stays external — the shim imports it dynamically at
 * facet module-init and handles its absence.
 *
 * treeShaking is OFF, and that is load-bearing rather than cautious. This body
 * and wasi-threads.ts are concatenated into ONE evaluated scope, so a
 * declaration this file makes may be consumed by the other — `__WASI_ETIMEDOUT`
 * is declared here and used only there. Elimination is scoped to this module and
 * cannot see across that seam, so it drops such a constant and the facet raises
 * a ReferenceError from inside a suspended guest, where nothing can report it.
 * The template literal this replaced had no elimination pass either; keeping it
 * off is what makes the relocation faithful.
 */
async function bundleWasiInstance() {
  const result = await build({
    entryPoints: [join(root, 'src', 'runtime', 'wasi', 'preamble.ts')],
    bundle: true,
    format: 'esm',
    target: 'esnext',
    platform: 'neutral',
    absWorkingDir: root,
    external: ['cloudflare:sockets'],
    treeShaking: false,
    write: false,
    logLevel: 'warning',
    legalComments: 'none',
  });
  if (!result.outputFiles || result.outputFiles.length === 0) {
    throw new Error('[bundle-facet-workers/wasi-instance] esbuild produced no output');
  }
  let src = result.outputFiles[0].text;
  // The body is spliced into another module; a re-export block there is a
  // syntax error, and callers append their own `export { … }`.
  src = src.replace(/^export\s+(async\s+function|function|const|let|var|class)\b/gm, '$1');
  src = src.replace(/\n?export\s*\{[^}]*\}\s*;\s*$/g, '');

  const missing = WASI_REQUIRED_TOP_LEVEL.filter(
    (name) => !new RegExp(`^(?:async\\s+)?(?:function|const|let|var|class)\\s+${name}\\b`, 'm').test(src)
      && !new RegExp(`^globalThis\\.${name}\\s*=`, 'm').test(src),
  );
  if (missing.length > 0) {
    throw new Error(
      `[bundle-facet-workers/wasi-instance] the bundle no longer declares ${missing.join(', ')} `
      + 'at top level — esbuild renamed or scoped them, and every facet that splices this body would '
      + 'fail with a ReferenceError the guest cannot report',
    );
  }
  if (/^export\b/m.test(src)) {
    throw new Error('[bundle-facet-workers/wasi-instance] an export statement survived stripping');
  }
  // The exit path identifies a guest's proc_exit by `e.constructor.name`, so the
  // class name is part of the contract, not an implementation detail. A rename
  // would turn every clean exit into exitCode 1 with the throw as its message.
  // Bundling rewrites `class __WasiExit {}` to `var __WasiExit = class {}`;
  // NamedEvaluation still infers `.name` from the binding, so both forms pass.
  if (!/\bclass __WasiExit\b|\b__WasiExit\s*=\s*class\b/.test(src)) {
    throw new Error(
      '[bundle-facet-workers/wasi-instance] class __WasiExit was renamed — __wasiRunStart '
      + 'identifies a guest exit by constructor.name, so every proc_exit would be reported as a crash',
    );
  }
  return src;
}

/**
 * Bundle the typed bash scheduler into a self-contained IIFE.
 *
 * IIFE and not a flat body, because this string is evaluated as a FUNCTION body
 * — `new Function('globalThis', src)` in tests, a loader-pool `preamble` in
 * production — so an `import`, an `export` or a top-level `await` would be a
 * syntax error at the point of evaluation. Wrapping also keeps ~70 scheduler
 * identifiers out of the facet module scope; the only things it publishes are
 * `globalThis.__bashBoot` and `globalThis.__bashFeed`.
 *
 * treeShaking is OFF for the same reason it is off for the WASI shim: every
 * declaration here is reachable only through those two globals, which
 * elimination cannot see, and a dropped one is a ReferenceError raised inside a
 * suspended guest where nothing can report it.
 */
async function bundleBashRunner() {
  const result = await build({
    entryPoints: [join(coreRoot, 'src', 'runtime', 'bash', 'preamble.ts')],
    bundle: true,
    format: 'iife',
    target: 'esnext',
    platform: 'neutral',
    absWorkingDir: root,
    treeShaking: false,
    write: false,
    logLevel: 'warning',
    legalComments: 'none',
  });
  if (!result.outputFiles || result.outputFiles.length === 0) {
    throw new Error('[bundle-facet-workers/bash-runner] esbuild produced no output');
  }
  const src = result.outputFiles[0].text;
  for (const name of ['__bashBoot', '__bashFeed']) {
    if (!new RegExp(`^\\s*globalThis\\.${name}\\s*=`, 'm').test(src)) {
      throw new Error(
        `[bundle-facet-workers/bash-runner] the bundle no longer assigns globalThis.${name} — ` +
        'every bash dispatch would answer "preamble missing"',
      );
    }
  }
  if (/^\s*(?:import|export)\b/m.test(src)) {
    throw new Error(
      '[bundle-facet-workers/bash-runner] an import/export survived bundling — the string is ' +
      'evaluated as a function body and would be a syntax error there',
    );
  }
  // The exit path identifies a guest's proc_exit by `e instanceof Exit`, so the
  // class has to survive as a class. Bundling rewrites `class Exit {}` to
  // `var Exit = class {}`; both forms pass.
  if (!/\bclass Exit\b|\bExit\s*=\s*class\b/.test(src)) {
    throw new Error(
      '[bundle-facet-workers/bash-runner] class Exit was renamed — proc_exit is caught by ' +
      'instanceof, so every clean exit would propagate as a scheduler crash',
    );
  }
  return src;
}

async function main() {
  // 1. Tar-parser preamble (existing W2.5/W4 hot-path helpers).
  const tarStripped = await bundleAsPreamble(
    join(coreRoot, 'src', '_shared', 'tarball-stream.ts'),
    'tar-stream',
  );

  // 2. W7 frame encoder preamble. The npm-install-batch-facet calls
  //    encodeWriteBatchStream() to wrap its writeBatch payload as a
  //    type:'bytes' ReadableStream, then passes the stream to
  //    env.SUPERVISOR.writeBatchStream(). Without this preamble the
  //    facet has no access to the encoder symbol (cloudflare-parallel
  //    serialises via fn.toString() — no runtime imports).
  //
  //    The W7-frame module imports a TypeScript type from sqlite-vfs,
  //    which esbuild's type-stripping handles transparently. The
  //    runtime output has no imports.
  const w7Stripped = await bundleAsPreamble(
    join(coreRoot, 'src', '_shared', 'w7-frame.ts'),
    'w7-frame',
  );

  const tarEncoded = JSON.stringify(tarStripped);
  const w7Encoded = JSON.stringify(w7Stripped);
  const outPath = join(root, 'src', 'loaders', 'generated-workers.ts');

  const tsWrapper = [
    '/**',
    ' * generated-workers.ts — AUTO-GENERATED. DO NOT EDIT.',
    ' *',
    ' * Produced by scripts/bundle-facet-workers.mjs from:',
    ' *   - @nimbus-sh/core src/_shared/tarball-stream.ts (streaming tar primitives)',
    ' *   - @nimbus-sh/core src/_shared/w7-frame.ts (W7 streaming bulk-write encoder)',
    ' *',
    ' * Consumed by src/loaders/loader-pool.ts callers via the `preamble`',
    ' * option. The preamble is injected at the top of every generated',
    ' * worker module so user functions can reference the exported',
    ' * helpers by name.',
    ' *',
    ' * Tar-stream symbols: parseTarHeader, streamTarEntries,',
    ' *   readableStreamToAsyncIterable, MAX_FILE_BYTES.',
    ' * W7-frame symbols:   encodeWriteBatchStream, decodeWriteBatchStream,',
    ' *   W7_MAGIC, W7_MAX_RECORD_BYTES.',
    ' *',
    ` * Tar size: ${(tarStripped.length / 1024).toFixed(2)} KiB`,
    ` * W7 size:  ${(w7Stripped.length / 1024).toFixed(2)} KiB`,
    ' */',
    '',
    `export const TAR_STREAM_PREAMBLE: string = ${tarEncoded};`,
    '',
    `export const W7_FRAME_PREAMBLE: string = ${w7Encoded};`,
    '',
  ].join('\n');

  mkdirSync(dirname(outPath), { recursive: true });
  writeFileSync(outPath, tsWrapper);

  const kernelSrc = await bundleVirtualSocketKernel();
  const kernelOutPath = join(coreRoot, 'src', 'runtime', 'virtual-socket-kernel.generated.ts');
  const kernelWrapper = [
    '/**',
    ' * virtual-socket-kernel.generated.ts — AUTO-GENERATED. DO NOT EDIT.',
    ' *',
    ' * Produced by scripts/bundle-facet-workers.mjs from:',
    ' *   - @nimbus-sh/core src/runtime/virtual-socket-kernel.ts',
    ' *',
    ' * Self-contained IIFE that installs globalThis.__nimbusVirtualSockets.',
    ' * Consumed by python-runner.ts and ruby-runner.ts: spliced into the',
    ' * socket process worker module source passed to NimbusLoaderPool.',
    ' *',
    ` * Size: ${(kernelSrc.length / 1024).toFixed(2)} KiB`,
    ' */',
    '',
    `export const VIRTUAL_SOCKET_KERNEL_SRC: string = ${JSON.stringify(kernelSrc)};`,
    '',
  ].join('\n');
  writeFileSync(kernelOutPath, kernelWrapper);

  console.log(
    `[bundle-facet-workers] wrote ${outPath} ` +
    `(tar=${(tarStripped.length / 1024).toFixed(2)} KiB, ` +
    `w7=${(w7Stripped.length / 1024).toFixed(2)} KiB)`,
  );
  const wasiSrc = await bundleWasiInstance();
  const wasiOutPath = join(coreRoot, 'src', 'runtime', 'wasi-instance.generated.ts');
  writeFileSync(wasiOutPath, [
    '/**',
    ' * wasi-instance.generated.ts — AUTO-GENERATED. DO NOT EDIT.',
    ' *',
    ' * Produced by scripts/bundle-facet-workers.mjs from:',
    ' *   - src/runtime/wasi/preamble.ts',
    ' *',
    ' * The WASI snapshot_preview1 shim as a flat ESM body, for splicing into a',
    ' * facet module source. wasi-instance.ts appends the wasi-threads scheduler',
    ' * and re-exports the result as WASI_INSTANCE_PREAMBLE_SRC.',
    ' *',
    ` * Size: ${(wasiSrc.length / 1024).toFixed(2)} KiB`,
    ' */',
    '',
    `export const WASI_INSTANCE_BODY_SRC: string = ${JSON.stringify(wasiSrc)};`,
    '',
  ].join('\n'));

  const bashSrc = await bundleBashRunner();
  const bashOutPath = join(coreRoot, 'src', 'runtime', 'bash-runner.generated.ts');
  writeFileSync(bashOutPath, [
    '/**',
    ' * bash-runner.generated.ts — AUTO-GENERATED. DO NOT EDIT.',
    ' *',
    ' * Produced by scripts/bundle-facet-workers.mjs from:',
    ' *   - @nimbus-sh/core src/runtime/bash/preamble.ts',
    ' *',
    ' * The facet-side bash scheduler as a self-contained IIFE that installs',
    ' * globalThis.__bashBoot / globalThis.__bashFeed. bash-runner.ts re-exports it',
    ' * as BASH_RUNNER_PREAMBLE and passes it as the facet preamble.',
    ' *',
    ` * Size: ${(bashSrc.length / 1024).toFixed(2)} KiB`,
    ' */',
    '',
    `export const BASH_RUNNER_BODY_SRC: string = ${JSON.stringify(bashSrc)};`,
    '',
  ].join('\n'));

  console.log(
    `[bundle-facet-workers] wrote ${kernelOutPath} ` +
    `(kernel=${(kernelSrc.length / 1024).toFixed(2)} KiB)`,
  );
  console.log(
    `[bundle-facet-workers] wrote ${wasiOutPath} ` +
    `(wasi=${(wasiSrc.length / 1024).toFixed(2)} KiB)`,
  );
  console.log(
    `[bundle-facet-workers] wrote ${bashOutPath} ` +
    `(bash=${(bashSrc.length / 1024).toFixed(2)} KiB)`,
  );
}

// The bundle functions are exported so the parity test can re-derive the
// generated files from source and compare, rather than restating the esbuild
// settings — a second copy of those settings is exactly the drift such a test
// exists to catch. main() therefore runs only when this file is the entry point.
export { bundleWasiInstance, bundleBashRunner };

if (process.argv[1] && pathToFileURL(process.argv[1]).href === import.meta.url) {
  main().catch((e) => {
    console.error('[bundle-facet-workers] FAILED:', e?.message || e);
    process.exitCode = 1;
  });
}
