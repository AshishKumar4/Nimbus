/**
 * frameworks/sveltekit.ts — SvelteKit-specific dev-server hooks.
 *
 * SvelteKit is the closest-to-working framework on Nimbus today: its CLI
 * is just `vite dev`, so the existing real-vite path covers boot. The
 * only Nimbus-specific work is asserting that the SK Vite plugin's
 * `$lib` alias has reached our `viteConfig.alias` map, since we parse
 * vite configs via regex (nimbus-session.ts:3022) and the SK plugin
 * sets the alias programmatically.
 *
 * If the alias is missing we register a soft fallback: `$lib` →
 * `<projectRoot>/src/lib`. Users can opt out by setting
 * `kit.files.lib` in svelte.config.js to a non-default path; we detect
 * that case by reading svelte.config.js and bailing.
 */

import type { SqliteVFS } from '../sqlite-vfs.js';

export const description =
  'SvelteKit (vite plugin) — runs through the real-vite path. Verifies $lib alias.';

export interface SvelteKitHooks {
  /**
   * Called from initSession's vite-dev path AFTER vite.config has been
   * regex-parsed. `aliasMap` is mutated in place to add `$lib` if missing.
   * Returns the list of aliases added (for logging).
   */
  ensureAliases(
    vfs: SqliteVFS,
    projectRoot: string,
    aliasMap: Record<string, string>,
  ): string[];
}

export const sveltekit: SvelteKitHooks = {
  ensureAliases(vfs, projectRoot, aliasMap) {
    const added: string[] = [];
    if (aliasMap['$lib']) return added; // user already has it

    // Honor explicit kit.files.lib override in svelte.config.js (best-effort
    // regex; we don't execute the config). If found, use it.
    let libPath = './src/lib';
    try {
      for (const cfgName of ['svelte.config.js', 'svelte.config.mjs', 'svelte.config.ts']) {
        const cfgPath = projectRoot.replace(/^\/+/, '') + '/' + cfgName;
        if (vfs.exists(cfgPath)) {
          const src = vfs.readFileString(cfgPath);
          const m = src.match(/files\s*:\s*\{[^}]*?lib\s*:\s*['"]([^'"]+)['"]/);
          if (m) libPath = m[1];
          break;
        }
      }
    } catch {
      // Read failure is non-fatal — keep default.
    }

    aliasMap['$lib'] = libPath;
    added.push('$lib → ' + libPath);
    return added;
  },
};
