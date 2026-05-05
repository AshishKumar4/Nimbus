/**
 * frameworks/astro.ts — Astro-specific dev-server bridge.
 *
 * Astro's `astro dev` CLI is a thin launcher: `bin/astro.js` dynamic-imports
 * `dist/cli/index.js` (or whatever the package's `bin.astro` points at)
 * which boots a Vite server with Astro's integrations + content collections.
 *
 * Strategy:
 *  1. Discover the launcher path at runtime by reading `node_modules/astro/package.json`
 *     and looking up `bin.astro` (rather than hard-coding `dist/cli/index.js` —
 *     reviewer comment 2 on the W11 plan).
 *  2. Invoke it via the W8 child_process facet (`astro` is now in
 *     _CP_FACET_DIRECT — see nimbus-session.ts:413).
 *  3. Bridge Astro's chosen port (4321 default) to the supervisor's preview router.
 *
 * Phase 1 limitations (documented in retro):
 *  - We do NOT execute astro.config.mjs in-process — its plugins (e.g.
 *    @astrojs/react, @astrojs/tailwind) load via Astro's own integration
 *    runner inside the facet.
 *  - `astro:content` collections that touch fs.readdirSync at module-init
 *    time work fine (VFS exposes a Node fs surface), but the markdown
 *    pre-processing pipeline depends on hast/remark plugins that may
 *    fail to bundle inside the facet — see W8 fork-IPC-shape limits.
 */

import type { SqliteVFS } from '../sqlite-vfs.js';

export const description =
  "Astro (vite-based) — bridges astro dev's Vite child server to the preview router.";

export interface AstroBootInfo {
  /** Resolved bin path inside node_modules — null if `astro` not installed. */
  binPath: string | null;
  /** The Astro version string from its package.json — null if not installed. */
  version: string | null;
  /** Has astro.config.{mjs,js,ts} at the project root? */
  hasConfig: boolean;
}

/** Resolve Astro CLI metadata for a project. Pure I/O via VFS — no execution. */
export function resolveAstro(vfs: SqliteVFS, projectRoot: string): AstroBootInfo {
  const root = projectRoot.replace(/^\/+/, '');
  const pkgPath = root + '/node_modules/astro/package.json';
  let binPath: string | null = null;
  let version: string | null = null;
  try {
    if (vfs.exists(pkgPath)) {
      const pkg = JSON.parse(vfs.readFileString(pkgPath));
      version = pkg.version || null;
      // bin can be a string or a record { astro: "./astro.js" }.
      let binRel: string | null = null;
      if (typeof pkg.bin === 'string') binRel = pkg.bin;
      else if (pkg.bin && typeof pkg.bin === 'object') binRel = pkg.bin.astro || null;
      if (binRel) {
        binPath = root + '/node_modules/astro/' + binRel.replace(/^\.\//, '');
      }
    }
  } catch {
    // pkg unreadable — leave nulls, supervisor will print a clear error.
  }

  let hasConfig = false;
  for (const c of ['astro.config.mjs', 'astro.config.js', 'astro.config.ts', 'astro.config.cjs']) {
    if (vfs.exists(root + '/' + c)) {
      hasConfig = true;
      break;
    }
  }

  return { binPath, version, hasConfig };
}

/**
 * Hint message for the user when `npm run dev` is about to spawn astro.
 * Printed once on the boot path so users have visibility into what
 * Nimbus is doing.
 */
export function devBanner(info: AstroBootInfo): string {
  if (!info.binPath) {
    return (
      '\x1b[33m\u26A0\x1b[0m  astro dev: \x1b[2mnot found in node_modules — ' +
      'run \x1b[36mnpm install\x1b[0m first.\x1b[0m\n'
    );
  }
  return (
    '\x1b[36m[nimbus]\x1b[0m astro v' +
    (info.version || '?') +
    ' — bridging dev server through facet (port 4321).\n'
  );
}
