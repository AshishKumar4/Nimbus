/**
 * An esbuild plugin that binds every import of core's _shared/primordials.ts
 * to the launch's captures, a name already in scope where the bundle is
 * evaluated (commonjs-cell's __nimbusLaunchCaptures, or the shims'
 * __nimbusPrimordials). A bundle never carries a capture of its own: a second
 * evaluation of primordials.ts would capture after a program ran, and replace
 * Function.prototype.toString again (design-guest-loader-primordials.md §3).
 */
import { build } from 'esbuild';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { moduleBody } from './compiled-bodies.mjs';

const CORE = fileURLToPath(new URL('../../packages/core/', import.meta.url));
const PRIMORDIALS = join(CORE, 'src', '_shared', 'primordials');

/** Every name primordials.ts exports: the module bundled alone, its exports read from the syntax tree. */
async function primordialNames() {
  const result = await build({ entryPoints: [`${PRIMORDIALS}.ts`], bundle: true, format: 'esm', platform: 'neutral', target: 'esnext', write: false, logLevel: 'warning' });
  const names = moduleBody(result.outputFiles[0].text).exported.map(([name]) => name);
  if (names.length === 0) throw new Error(`[launch-captures-plugin] no exports read from ${PRIMORDIALS}.ts`);
  return names;
}

/** Whether `specifier`, imported from `from`, is core's primordials module: its package name, or a relative path into its source or its dist. */
function isPrimordials(specifier, from) {
  if (specifier === '@nimbus-sh/core/_shared/primordials.js') return true;
  if (!specifier.startsWith('.')) return false;
  const target = resolve(from, specifier).replace(/\.(js|ts)$/, '');
  return target === PRIMORDIALS || target === join(CORE, 'dist', '_shared', 'primordials');
}

/**
 * The plugin: imports of primordials read `global`, the launch's captures by the name the bundle's evaluator binds.
 * @param {string} global
 * @returns {Promise<import('esbuild').Plugin>}
 */
export async function launchCapturesPlugin(global) {
  const names = await primordialNames();
  return {
    name: 'launch-captures',
    setup(pluginBuild) {
      pluginBuild.onResolve({ filter: /primordials(\.js|\.ts)?$/ }, (args) => (
        isPrimordials(args.path, args.resolveDir) ? { path: 'launch-captures', namespace: 'nimbus-launch-captures' } : undefined
      ));
      pluginBuild.onLoad({ filter: /.*/, namespace: 'nimbus-launch-captures' }, () => ({
        contents: `export const { ${names.join(', ')} } = ${global};\n`,
        loader: 'js',
      }));
    },
  };
}
