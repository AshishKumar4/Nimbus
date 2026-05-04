#!/usr/bin/env node
/**
 * bundle-facet-workers.mjs — Produce the preamble string that
 * NimbusFacetPool injects into dynamic workers.
 *
 * WHY this exists:
 *   NimbusFacetPool's user functions get wrapped by cloudflare-parallel's
 *   codegen into a module source. Inside that module the user function
 *   can reference closure-variables only through the `context` option,
 *   which is JSON-only — you cannot pass a helper function through it.
 *
 *   For the npm install facet we need the streaming tar parser
 *   (src/npm-tarball-stream.ts) available as a top-level named export
 *   the user function can call. We esbuild-bundle that source file into
 *   a self-contained ES module string, and NimbusFacetPool's `preamble`
 *   option splices it into the generated module between the
 *   WorkerEntrypoint import and the user function.
 *
 * Output:
 *   src/parallel/generated-workers.ts — exports
 *       TAR_STREAM_PREAMBLE: string
 *       TAR_STREAM_PREAMBLE_SIZE: number
 *       W7_FRAME_PREAMBLE: string         (W7 — streaming bulk-write encoder)
 *       W7_FRAME_PREAMBLE_SIZE: number
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

async function main() {
  // 1. Tar-parser preamble (existing W2.5/W4 hot-path helpers).
  const tarStripped = await bundleAsPreamble(
    join(root, 'src', 'npm-tarball-stream.ts'),
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
  const outPath = join(root, 'src', 'parallel', 'generated-workers.ts');

  const tsWrapper = [
    '/**',
    ' * generated-workers.ts — AUTO-GENERATED. DO NOT EDIT.',
    ' *',
    ' * Produced by scripts/bundle-facet-workers.mjs from:',
    ' *   - src/npm-tarball-stream.ts (streaming tar primitives)',
    ' *   - src/_shared/w7-frame.ts   (W7 streaming bulk-write encoder)',
    ' *',
    ' * Consumed by src/parallel/facet-pool.ts callers via the `preamble`',
    ' * option. The preamble is injected at the top of every generated',
    ' * worker module so user functions can reference the exported',
    ' * helpers by name.',
    ' *',
    ' * Tar-stream symbols: parseTarHeader, streamTarEntries,',
    ' *   readableStreamToAsyncIterable, MAX_FILE_BYTES.',
    ' * W7-frame symbols:   encodeWriteBatchStream, decodeWriteBatchStream,',
    ' *   W7_MAGIC, W7_TRAILER.',
    ' *',
    ` * Generated at: ${new Date().toISOString()}`,
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

  console.log(
    `[bundle-facet-workers] wrote ${outPath} ` +
    `(tar=${(tarStripped.length / 1024).toFixed(2)} KiB, ` +
    `w7=${(w7Stripped.length / 1024).toFixed(2)} KiB)`,
  );
}

main().catch((e) => {
  console.error('[bundle-facet-workers] FAILED:', e?.message || e);
  process.exitCode = 1;
});
