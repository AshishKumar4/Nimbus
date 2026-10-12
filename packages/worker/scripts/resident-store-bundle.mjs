/**
 * resident-store-bundle.mjs — the resident store (src/vfs/resident) as the
 * library a node launch evaluates once at module scope: one IIFE defining
 * `__nimbusResidentModule`, whose `createResidentStore` each process calls for
 * its own store. bundle-node-shims.mjs stages it; the tests build it the same
 * way to test the source they sit beside.
 *
 * It reads nothing a facet module does not have: its free names are checked
 * against the globals every facet has (free-names.mjs).
 */
import { build } from 'esbuild';
import { join } from 'node:path';
import { FACET_GLOBALS, freeNames } from './free-names.mjs';

export const RESIDENT_STORE_GLOBAL = '__nimbusResidentModule';

/** @param {string} root the worker package */
export async function bundleResidentStore(root) {
  const result = await build({
    entryPoints: [join(root, 'src', 'vfs', 'resident', 'index.ts')],
    bundle: true,
    format: 'iife',
    globalName: RESIDENT_STORE_GLOBAL,
    target: 'esnext',
    platform: 'neutral',
    absWorkingDir: root,
    write: false,
    logLevel: 'warning',
    legalComments: 'none',
  });
  const source = result.outputFiles?.[0]?.text;
  if (typeof source !== 'string' || source.length === 0) throw new Error('[resident-store-bundle] esbuild produced no output');
  const stray = [...freeNames(source)].filter((name) => !FACET_GLOBALS.has(name) && name !== RESIDENT_STORE_GLOBAL);
  if (stray.length > 0) {
    throw new Error(`[resident-store-bundle] the store reads ${stray.join(', ')}, which a facet does not have: a ReferenceError inside every process`);
  }
  return source;
}
