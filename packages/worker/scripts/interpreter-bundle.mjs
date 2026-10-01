/**
 * interpreter-bundle.mjs — the runtime-code interpreter (@nimbus-sh/core
 * src/interpreter) as a node launch's map carries it: two CommonJS modules.
 *
 *   - The interpreter, bundled with acorn into one module. esbuild's CommonJS
 *     output does not keep the ES modules' strict mode, so the bundle states
 *     it; the interpreter's closures depend on strict semantics (an
 *     assignment to a read-only property throws, `this` is not coerced).
 *   - The host module it runs on (HOST_OPS_SOURCE), which is sloppy at its
 *     top level so that interpreted sloppy functions are native sloppy
 *     functions; it cannot be part of a strict bundle.
 *
 * esbuild compiles core's TypeScript itself, so both are built from core
 * src: bundle-node-shims.mjs stages them, and the tests build them the same
 * way to test the source they sit beside.
 */

import { build } from 'esbuild';
import { join } from 'node:path';

import { resolvePackageDir } from './resolve-package-dir.mjs';

/**
 * @param {{ start: string }} options  `start`: a directory @nimbus-sh/core resolves from.
 * @returns {Promise<{ interpreter: string, ops: string }>}
 */
export async function bundleInterpreter({ start }) {
  const src = join(resolvePackageDir('@nimbus-sh/core', { start }), 'src/interpreter');
  const result = await build({
    entryPoints: [join(src, 'index.ts')],
    bundle: true,
    format: 'cjs',
    platform: 'neutral',
    target: 'esnext',
    mainFields: ['module', 'main'],
    minify: true,
    legalComments: 'none',
    banner: { js: '"use strict";' },
    write: false,
  });
  const [output] = result.outputFiles;
  if (!output) throw new Error('[interpreter-bundle] esbuild produced no output');
  // HOST_OPS_SOURCE is built when its module loads: compile and load it to read it.
  const ops = await build({ entryPoints: [join(src, 'host-ops.ts')], bundle: true, format: 'esm', platform: 'neutral', write: false });
  const { HOST_OPS_SOURCE } = await import(`data:text/javascript;base64,${Buffer.from(ops.outputFiles[0].text).toString('base64')}`);
  if (typeof HOST_OPS_SOURCE !== 'string' || HOST_OPS_SOURCE.length === 0) {
    throw new Error('[interpreter-bundle] core src/interpreter/host-ops.ts has no HOST_OPS_SOURCE');
  }
  return { interpreter: output.text, ops: HOST_OPS_SOURCE };
}
