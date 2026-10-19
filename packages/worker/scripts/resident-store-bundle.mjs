/**
 * resident-store-bundle.mjs — the resident store (src/vfs/resident) as the
 * library a node launch evaluates once at module scope: one IIFE defining
 * `__nimbusResidentModule`, whose `createResidentStore` each process calls for
 * its own store. bundle-node-shims.mjs stages it; the tests build it the same
 * way to test the source they sit beside.
 *
 * It reads nothing a facet module does not have: its free names are checked
 * against the globals every facet has (free-names.mjs), and the launch's
 * captures. The built-ins its read path calls are core's
 * _shared/primordials.ts as the launch captured them before any program ran
 * (commonjs-cell's __nimbusLaunchCaptures, evaluated first in the same
 * module): the bundle takes their names from there, never a capture of its
 * own, which would run later and replace Function.prototype.toString again.
 */
import { build } from 'esbuild';
import { readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { FACET_GLOBALS, freeNames } from './free-names.mjs';

export const RESIDENT_STORE_GLOBAL = '__nimbusResidentModule';
/** The launch's captures, in scope where the store is evaluated (core _shared/commonjs-cell.ts). */
export const LAUNCH_CAPTURES = '__nimbusLaunchCaptures';

/** Every name core's _shared/primordials.ts exports, as its source declares them. */
function primordialNames(path) {
  const source = readFileSync(path, 'utf8');
  const names = [...source.matchAll(/^export (?:const|function|class|let) (\w+)/gm)].map((match) => match[1]);
  for (const block of source.matchAll(/^export \{([^}]*)\};/gm)) {
    for (const part of block[1].split(',')) {
      const name = part.trim().split(/\s+as\s+/).pop();
      if (name) names.push(name);
    }
  }
  if (names.length === 0) throw new Error(`[resident-store-bundle] no exports read from ${path}`);
  return names;
}

/** @param {string} root the worker package */
export async function bundleResidentStore(root) {
  const core = join(root, '..', 'core');
  const primordials = join(core, 'src', '_shared', 'primordials');
  const names = primordialNames(`${primordials}.ts`);
  // Core's module, by whichever of its spellings an import resolves to: its
  // package name (`@nimbus-sh/core/_shared/primordials.js`), or a relative
  // path into its source or its built dist.
  const isPrimordials = (specifier, from) => {
    if (specifier === '@nimbus-sh/core/_shared/primordials.js') return true;
    if (!specifier.startsWith('.')) return false;
    const target = resolve(from, specifier).replace(/\.(js|ts)$/, '');
    return target === primordials || target === join(core, 'dist', '_shared', 'primordials');
  };
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
    plugins: [{
      name: 'resident-launch-captures',
      setup(pluginBuild) {
        pluginBuild.onResolve({ filter: /primordials(\.js|\.ts)?$/ }, (args) => (
          isPrimordials(args.path, args.resolveDir) ? { path: 'launch-captures', namespace: 'nimbus-launch-captures' } : undefined
        ));
        pluginBuild.onLoad({ filter: /.*/, namespace: 'nimbus-launch-captures' }, () => ({
          contents: `export const { ${names.join(', ')} } = ${LAUNCH_CAPTURES};\n`,
          loader: 'js',
        }));
      },
    }],
  });
  const source = result.outputFiles?.[0]?.text;
  if (typeof source !== 'string' || source.length === 0) throw new Error('[resident-store-bundle] esbuild produced no output');
  const stray = [...freeNames(source)].filter((name) => !FACET_GLOBALS.has(name) && name !== RESIDENT_STORE_GLOBAL && name !== LAUNCH_CAPTURES);
  if (stray.length > 0) {
    throw new Error(`[resident-store-bundle] the store reads ${stray.join(', ')}, which a facet does not have: a ReferenceError inside every process`);
  }
  return source;
}
