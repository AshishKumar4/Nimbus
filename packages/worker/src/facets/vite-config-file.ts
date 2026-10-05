/**
 * vite-config-file.ts — a project's vite.config as the built-in Vite dev
 * server reads it: the first of VITE_CONFIG_NAMES in a directory, scraped
 * statically (core runtime/vite-config-parser.ts), never evaluated. `vite`
 * reads it at start (session/vite-command.ts); the dev server reads it again
 * when it changes, as Vite restarts on an edit of its config.
 */

import { parseViteConfigSource, parseViteConfigTypeScript, type ParsedViteConfig } from '@nimbus-sh/core/runtime/vite-config-parser.js';

/** The names a vite.config is looked for under, in order. */
export const VITE_CONFIG_NAMES = ['vite.config.ts', 'vite.config.js', 'vite.config.mjs'] as const;

/** What a vite.config is read through: a project's view, or the dev server's own. */
export interface ViteConfigReadFs {
  exists(path: string): boolean | Promise<boolean>;
  readFileString(path: string): string | Promise<string>;
}

export interface ViteConfigFile {
  /** The file read (`<dir>/<name>`), or null where `dir` has none. */
  path: string | null;
  config: ParsedViteConfig;
  /** Why the file found could not be read; its config is then empty. */
  error: string | null;
}

/**
 * The vite.config in `dir`. A .ts config needs `eraseTypes` only when it
 * holds type syntax (parseViteConfigTypeScript); a plain one is read as is.
 */
export async function readViteConfigFile(
  fs: ViteConfigReadFs,
  dir: string,
  eraseTypes: (source: string) => Promise<string>,
): Promise<ViteConfigFile> {
  for (const name of VITE_CONFIG_NAMES) {
    const path = `${dir}/${name}`;
    if (!(await fs.exists(path))) continue;
    try {
      const code = await fs.readFileString(path);
      const config = name.endsWith('.ts') ? await parseViteConfigTypeScript(code, eraseTypes) : parseViteConfigSource(code);
      return { path, config, error: null };
    } catch (e: any) {
      return { path, config: {}, error: `could not parse ${name}: ${e?.message}` };
    }
  }
  return { path: null, config: {}, error: null };
}

/** Whether `path` (a VFS path, with or without its leading slash) names a vite.config in `dir`. */
export function isViteConfigPath(path: string, dir: string): boolean {
  const at = path.replace(/^\/+/, '');
  const prefix = dir.replace(/^\/+|\/+$/g, '') + '/';
  return at.startsWith(prefix) && (VITE_CONFIG_NAMES as readonly string[]).includes(at.slice(prefix.length));
}
