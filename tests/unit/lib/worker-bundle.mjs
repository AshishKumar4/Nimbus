// Worker modules imported into a bun test. Session and router modules reach
// `cloudflare:workers`, which bun cannot resolve outside workerd, so they are
// bundled as one graph with it stubbed, and the bundle imported.

import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';

const root = new URL('../../../', import.meta.url).pathname;

const CLOUDFLARE_WORKERS = 'export class DurableObject {}; export class WorkerEntrypoint {}; export class RpcTarget {};';

/**
 * Bundle and import `exports` (repo-relative module path → the names to take
 * from it) as one module graph: a module two of them share is one instance.
 *
 * @param {Record<string, string[]>} exports
 * @param {{ stubs?: Array<{ filter: RegExp, contents: string }> }} [options]
 *   further modules replaced by `contents`, matched on the import path.
 * @returns {Promise<Record<string, any>>} every requested name
 */
export async function importWorkerBundle(exports, { stubs = [] } = {}) {
  const outputDir = await mkdtemp(join(tmpdir(), 'nimbus-worker-bundle-'));
  try {
    const entryPath = join(outputDir, 'entry.ts');
    await writeFile(entryPath, Object.entries(exports)
      .map(([module, names]) => `export { ${names.join(', ')} } from '${root}${module}';`)
      .join('\n') + '\n');
    const build = await Bun.build({
      entrypoints: [entryPath],
      outdir: join(outputDir, 'out'),
      target: 'bun',
      format: 'esm',
      plugins: [{
        name: 'worker-bundle-stubs',
        setup(builder) {
          builder.onResolve({ filter: /^cloudflare:workers$/ }, () => ({ path: 'cloudflare:workers', namespace: 'stub' }));
          stubs.forEach(({ filter }, i) => {
            builder.onResolve({ filter }, () => ({ path: String(i), namespace: 'stub' }));
          });
          builder.onLoad({ filter: /.*/, namespace: 'stub' }, ({ path }) => ({
            contents: path === 'cloudflare:workers' ? CLOUDFLARE_WORKERS : stubs[Number(path)].contents,
            loader: 'js',
          }));
        },
      }],
    });
    if (!build.success) throw new Error(`worker bundle failed:\n${build.logs.map(String).join('\n')}`);
    const entry = build.outputs.find((output) => output.path.endsWith('/entry.js'));
    return await import(pathToFileURL(entry.path).href);
  } finally {
    await rm(outputDir, { recursive: true, force: true });
  }
}
