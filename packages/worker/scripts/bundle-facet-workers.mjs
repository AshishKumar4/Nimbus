#!/usr/bin/env node
/**
 * bundle-facet-workers.mjs — Produce the source strings that Nimbus
 * injects into dynamic workers.
 *
 * WHY this exists:
 *   Dynamic workers (NimbusFacetPool / NimbusLoaderPool) receive their
 *   module source as strings — they cannot import supervisor modules,
 *   and user functions can reference closure-variables only through the
 *   JSON-only `context` option. Any TypeScript the injected code needs
 *   must therefore be esbuild-bundled into a self-contained source
 *   string at build time.
 *
 *   For the npm install facet we need the streaming tar parser
 *   (src/npm/tarball-stream.ts) available as a top-level named export
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
 * Output:
 *   src/loaders/generated-workers.ts — exports
 *       TAR_STREAM_PREAMBLE: string
 *       TAR_STREAM_PREAMBLE_SIZE: number
 *       W7_FRAME_PREAMBLE: string         (W7 — streaming bulk-write encoder)
 *       W7_FRAME_PREAMBLE_SIZE: number
 *   src/runtime/virtual-socket-kernel.generated.ts — exports
 *       VIRTUAL_SOCKET_KERNEL_SRC: string
 *
 * Runs as a postinstall + predev + predeploy step via package.json.
 */

import { build } from 'esbuild';
import { writeFileSync, mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const root = join(__dirname, '..');

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
      resolveDir: root,
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

async function main() {
  // 1. Tar-parser preamble (existing W2.5/W4 hot-path helpers).
  const tarStripped = await bundleAsPreamble(
    join(root, 'src', 'npm', 'tarball-stream.ts'),
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
    join(root, 'src', '_shared', 'w7-frame.ts'),
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
    ' *   - src/npm/tarball-stream.ts (streaming tar primitives)',
    ' *   - src/_shared/w7-frame.ts   (W7 streaming bulk-write encoder)',
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
    `export const TAR_STREAM_PREAMBLE_SIZE: number = ${tarStripped.length};`,
    '',
    `export const W7_FRAME_PREAMBLE: string = ${w7Encoded};`,
    '',
    `export const W7_FRAME_PREAMBLE_SIZE: number = ${w7Stripped.length};`,
    '',
  ].join('\n');

  mkdirSync(dirname(outPath), { recursive: true });
  writeFileSync(outPath, tsWrapper);

  const kernelSrc = await bundleVirtualSocketKernel();
  const kernelOutPath = join(root, 'src', 'runtime', 'virtual-socket-kernel.generated.ts');
  const kernelWrapper = [
    '/**',
    ' * virtual-socket-kernel.generated.ts — AUTO-GENERATED. DO NOT EDIT.',
    ' *',
    ' * Produced by scripts/bundle-facet-workers.mjs from:',
    ' *   - src/runtime/virtual-socket-kernel.ts',
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
  console.log(
    `[bundle-facet-workers] wrote ${kernelOutPath} ` +
    `(kernel=${(kernelSrc.length / 1024).toFixed(2)} KiB)`,
  );
}

main().catch((e) => {
  console.error('[bundle-facet-workers] FAILED:', e?.message || e);
  process.exitCode = 1;
});
