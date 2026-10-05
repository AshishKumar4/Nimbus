/**
 * vite-config-file.ts — a project's vite.config as the built-in Vite dev
 * server reads it: the first of VITE_CONFIG_NAMES in a directory, scraped
 * statically (core runtime/vite-config-parser.ts), never evaluated. `vite`
 * reads it at start (session/vite-command.ts); the dev server reads it again
 * when it changes, as Vite restarts on an edit of its config.
 */
import { parseViteConfigSource, parseViteConfigTypeScript } from '@nimbus-sh/core/runtime/vite-config-parser.js';
/** The names a vite.config is looked for under, in order. */
export const VITE_CONFIG_NAMES = ['vite.config.ts', 'vite.config.js', 'vite.config.mjs'];
/**
 * The vite.config in `dir`. A .ts config needs `eraseTypes` only when it
 * holds type syntax (parseViteConfigTypeScript); a plain one is read as is.
 */
export async function readViteConfigFile(fs, dir, eraseTypes) {
    for (const name of VITE_CONFIG_NAMES) {
        const path = `${dir}/${name}`;
        if (!(await fs.exists(path)))
            continue;
        try {
            const code = await fs.readFileString(path);
            const config = name.endsWith('.ts') ? await parseViteConfigTypeScript(code, eraseTypes) : parseViteConfigSource(code);
            return { path, config, error: null };
        }
        catch (e) {
            return { path, config: {}, error: `could not parse ${name}: ${e?.message}` };
        }
    }
    return { path: null, config: {}, error: null };
}
/** Whether `path` (a VFS path, with or without its leading slash) names a vite.config in `dir`. */
export function isViteConfigPath(path, dir) {
    const at = path.replace(/^\/+/, '');
    const prefix = dir.replace(/^\/+|\/+$/g, '') + '/';
    return at.startsWith(prefix) && VITE_CONFIG_NAMES.includes(at.slice(prefix.length));
}
