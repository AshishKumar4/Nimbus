/**
 * frameworks/remix.ts — Remix v2 (vite-plugin path) dev-server bridge.
 *
 * Since Remix 2.7+, `remix vite:dev` is a thin wrapper around `vite dev`
 * that injects the Remix vite plugin (`@remix-run/dev/vite`). The bin
 * `node_modules/.bin/remix` shells `remix-development-server` which is
 * just `vite` with a config helper.
 *
 * For Nimbus this means: route `npm run dev` → real-vite, and ensure
 * the user's `vite.config.ts` (which already imports `@remix-run/dev`)
 * is fed to the real-vite path unchanged. This module is mostly a
 * detection echo — it doesn't need to spawn anything special.
 *
 * Phase 1 limitations:
 *  - Classic compiler (`remix.config.js` without vite plugin) is NOT
 *    supported. We surface a clear error in `unsupportedReason()`.
 *  - `remix-serve` for production preview is NOT integrated; users
 *    should use `vite preview` or the supervisor's static dist serving.
 */

import type { SqliteVFS } from '../sqlite-vfs.js';

export const description =
  'Remix v2 (vite plugin) — runs through real-vite. Classic compiler unsupported.';

export interface RemixBootInfo {
  /** True if the project uses the v2 vite-plugin path (recommended). */
  vitePlugin: boolean;
  /** True if it uses the deprecated classic compiler (`remix.config.js`). */
  classicCompiler: boolean;
  /** Resolved Remix version, if any. */
  version: string | null;
}

export function resolveRemix(vfs: SqliteVFS, projectRoot: string): RemixBootInfo {
  const root = projectRoot.replace(/^\/+/, '');
  let version: string | null = null;
  try {
    const pkgPath = root + '/node_modules/@remix-run/dev/package.json';
    if (vfs.exists(pkgPath)) {
      version = JSON.parse(vfs.readFileString(pkgPath)).version || null;
    }
  } catch {
    /* version is best-effort */
  }

  // Vite-plugin path: vite.config.* references @remix-run/dev.
  let vitePlugin = false;
  for (const c of ['vite.config.ts', 'vite.config.js', 'vite.config.mjs', 'vite.config.cjs']) {
    try {
      if (vfs.exists(root + '/' + c)) {
        const src = vfs.readFileString(root + '/' + c);
        if (src.includes('@remix-run/dev')) {
          vitePlugin = true;
          break;
        }
      }
    } catch { /* continue */ }
  }

  // Classic compiler: remix.config.{js,cjs,mjs} present.
  let classicCompiler = false;
  for (const c of ['remix.config.js', 'remix.config.cjs', 'remix.config.mjs']) {
    if (vfs.exists(root + '/' + c)) {
      classicCompiler = true;
      break;
    }
  }

  return { vitePlugin, classicCompiler, version };
}

/** Returns null if Remix is supported in this project, else the reason it isn't. */
export function unsupportedReason(info: RemixBootInfo): string | null {
  if (info.vitePlugin) return null;
  if (info.classicCompiler) {
    return (
      'Remix classic compiler (remix.config.js) is not supported in Nimbus. ' +
      'Migrate to the Vite plugin: https://remix.run/docs/en/main/future/vite'
    );
  }
  return null; // ambiguous — let the bin fail with its own error
}

export function devBanner(info: RemixBootInfo): string {
  if (info.vitePlugin) {
    return (
      '\x1b[36m[nimbus]\x1b[0m Remix v' +
      (info.version || '?') +
      ' (vite plugin) — running through real-vite.\n'
    );
  }
  return '';
}
