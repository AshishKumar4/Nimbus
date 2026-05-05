/**
 * frameworks/nuxt.ts — Nuxt 3 dev-server best-effort bridge.
 *
 * Nuxt 3 boots TWO servers in dev:
 *   1. Vite dev server — serves the Vue client app
 *   2. Nitro dev server (h3-based) — serves API routes, server middleware
 *
 * Inside Nimbus we route a single preview origin per session, so the
 * dual-server topology is the central wildcard. Phase 1 strategy:
 *
 *  - Spawn `nuxt dev` via the W8 child_process facet (`nuxt`, `nuxi` are
 *    in _CP_FACET_DIRECT — see nimbus-session.ts:413).
 *  - Let Nuxt pick its own ports (default 3000 for unified single-server
 *    mode in 3.10+, where Nitro fronts everything).
 *  - The supervisor's preview router proxies `/` → port 3000 in single-
 *    server mode. If Nuxt runs in dual mode, /_nuxt/* and /api/* are
 *    available but other paths may 5xx. The retro records what we got.
 *
 * Phase 1 limitations (documented in retro):
 *  - HMR via Nitro's custom WebSocket may degrade to full reload —
 *    acceptable for Phase 1.
 *  - `unenv` (Nitro's Node-builtin shim layer) intersects with our own
 *    node-shims.ts. Probe answers whether they harmonize.
 *  - `nuxt build` emits to `.output/` — best-effort, not gated.
 */

import type { SqliteVFS } from '../sqlite-vfs.js';

export const description =
  'Nuxt 3 (vite + nitro) — best-effort. Single-server mode only; HMR may degrade.';

export interface NuxtBootInfo {
  binPath: string | null;
  version: string | null;
  hasConfig: boolean;
}

export function resolveNuxt(vfs: SqliteVFS, projectRoot: string): NuxtBootInfo {
  const root = projectRoot.replace(/^\/+/, '');
  let binPath: string | null = null;
  let version: string | null = null;
  try {
    const pkgPath = root + '/node_modules/nuxt/package.json';
    if (vfs.exists(pkgPath)) {
      const pkg = JSON.parse(vfs.readFileString(pkgPath));
      version = pkg.version || null;
      let binRel: string | null = null;
      if (typeof pkg.bin === 'string') binRel = pkg.bin;
      else if (pkg.bin && typeof pkg.bin === 'object') {
        binRel = pkg.bin.nuxt || pkg.bin.nuxi || null;
      }
      if (binRel) {
        binPath = root + '/node_modules/nuxt/' + binRel.replace(/^\.\//, '');
      }
    }
  } catch {
    /* leave nulls */
  }

  let hasConfig = false;
  for (const c of ['nuxt.config.ts', 'nuxt.config.js', 'nuxt.config.mjs']) {
    if (vfs.exists(root + '/' + c)) {
      hasConfig = true;
      break;
    }
  }

  return { binPath, version, hasConfig };
}

export function devBanner(info: NuxtBootInfo): string {
  if (!info.binPath) {
    return (
      '\x1b[33m\u26A0\x1b[0m  nuxt dev: \x1b[2mnot found in node_modules — ' +
      'run \x1b[36mnpm install\x1b[0m first.\x1b[0m\n'
    );
  }
  return (
    '\x1b[36m[nimbus]\x1b[0m Nuxt v' +
    (info.version || '?') +
    ' — best-effort dev server (Vite + Nitro). HMR may degrade.\n'
  );
}
