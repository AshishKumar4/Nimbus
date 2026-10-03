/**
 * dev-stylesheet.ts — a stylesheet as the Vite dev server serves it: its
 * local `@import`s inlined by the CSS layer and rules `vite build` bundles
 * with (core runtime/css-bundle.ts, on css-tree), so dev and build agree on
 * what an import means: its conditions wrap what it imports (`@media`,
 * `@supports`, `@layer`), a sheet imported twice keeps its last place,
 * imports of remote sheets are hoisted, nested imports are followed.
 *
 * Unlike a build, nothing is emitted: each `url()` becomes its file's path
 * from the project root (under the dev server's base), so a `url()` in an
 * inlined sheet still names its file wherever the sheet that imported it is
 * served. An `@import` that names no file in the project stays an `@import`
 * for the browser to fetch and report.
 */

import { bundleCss, CssError } from '@nimbus-sh/core/runtime/css-bundle.js';
import type { EsbuildRemotePlugin } from '@nimbus-sh/core/runtime/esbuild-service.js';

/** The reads a stylesheet needs from the dev server's VFS. */
export interface DevStylesheetFs {
  exists(path: string): boolean;
  isDirectory(path: string): boolean;
  readFileString(path: string): string;
}

const dirOf = (path: string) => path.slice(0, path.lastIndexOf('/')) || '/';

/** `path` with `.` and `..` segments resolved, leading slash as given. */
function normalize(path: string): string {
  const out: string[] = [];
  for (const segment of path.split('/')) {
    if (segment === '' || segment === '.') continue;
    if (segment === '..') out.pop();
    else out.push(segment);
  }
  return (path.startsWith('/') ? '/' : '') + out.join('/');
}

/**
 * The stylesheet at `vfsPath` (under the project's `root`), its imports
 * inlined, its url()s rooted at `base`. A sheet the CSS layer refuses (an
 * `@import` with no URL) is served as written, the reason in a comment first.
 */
export async function devStylesheet(fs: DevStylesheetFs, root: string, base: string, vfsPath: string): Promise<string> {
  const source = fs.readFileString(vfsPath);
  const rootedUrl = (path: string) => `${base}/${path.slice(root.length).replace(/^\/+/, '')}`;
  const plugin: EsbuildRemotePlugin = {
    name: 'nimbus-dev-css',
    async resolve({ path, resolveDir, kind }) {
      const suffix = /[?#].*$/.exec(path)?.[0] ?? '';
      const bare = path.slice(0, path.length - suffix.length);
      const target = normalize(bare.startsWith('/') ? `${root}${bare}` : `${resolveDir}/${bare}`);
      if (kind === 'url-token') return { path: rootedUrl(target) + suffix, external: true };
      if (!fs.exists(target) || fs.isDirectory(target)) return { path, external: true };
      return { path: target, namespace: 'file' };
    },
    async load({ path }) {
      return { contents: fs.readFileString(path), loader: 'css', resolveDir: dirOf(path) };
    },
  };
  const unused = () => {
    throw new Error('a dev stylesheet emits no assets');
  };
  try {
    return (await bundleCss([{ namespace: 'file', path: vfsPath, resolveDir: dirOf(vfsPath), source }], plugin, { emit: unused, dataUrl: unused }, { minify: false })).css;
  } catch (error) {
    if (error instanceof CssError) return `/* ${error.message.replace(/\*\//g, '* /')} */\n${source}`;
    throw error;
  }
}
