/**
 * vite-assets.ts — Vite's asset import semantics, expressed as esbuild
 * loaders, for the built-in (`cirrus`) `vite build` path.
 *
 * Kept free of any esbuild/VFS imports so unit tests can exercise the map
 * without the wasm shim: the esbuild-service plugin consumes these pure
 * helpers, and the `vite` builtin in session/init.ts consumes the config
 * side via vite-config-parser.
 *
 * What Vite does that this models (see vite/src/node/plugins/asset.ts):
 *
 *   import url from './logo.svg'     → emitted file, default export is its URL
 *   import url from './logo.svg?url' → same, on any extension
 *   import txt from './data.txt?raw' → default export is the file's UTF-8 text
 *   import d   from './logo.svg?inline' → default export is a data: URL
 *
 * `?inline` on a `.css` file returns the stylesheet TEXT in real Vite (the
 * feature exists to inline CSS into JS), so that case maps to `text` rather
 * than `dataurl`.
 *
 * Deliberate divergence: real Vite inlines assets below `assetsInlineLimit`
 * (4 KiB) as data URLs instead of emitting files. The built-in build always
 * emits a hashed file — same observable contract (a URL string), simpler
 * output. Unknown `?` modifiers (`?worker`, `?sharedworker`, `?init`, …)
 * are rejected loudly by the caller instead of being silently dropped.
 */

/** Extensions Vite treats as static assets — imported JS receives a URL. */
export const VITE_FILE_LOADER_EXTS: Record<string, true> = {
  // images
  '.png': true, '.jpe': true, '.jpeg': true, '.jpg': true, '.gif': true,
  '.svg': true, '.ico': true, '.webp': true, '.avif': true, '.jfif': true,
  '.pjpeg': true, '.pjp': true, '.apng': true, '.cur': true,
  // media
  '.mp4': true, '.webm': true, '.ogg': true, '.mp3': true, '.wav': true,
  '.flac': true, '.aac': true, '.opus': true, '.mov': true, '.m4a': true,
  // fonts
  '.woff': true, '.woff2': true, '.eot': true, '.ttf': true, '.otf': true,
  // documents / misc (Vite's known asset types)
  '.pdf': true, '.txt': true, '.webmanifest': true,
  // wasm: Vite emits it as a hashed asset (the `binary` loader used for
  // generic esbuild bundles is a Node-consumer semantic, not Vite's).
  '.wasm': true,
};

/** Import `?` modifiers the built-in build understands. */
export const VITE_ASSET_QUERY_SUFFIXES: Record<string, true> = {
  url: true, raw: true, inline: true, base64: true,
};


export type ViteAssetLoaderKind = 'file' | 'text' | 'dataurl' | 'base64';

/** Split `path` at its first `?` — returns `[bare, query]` (query may be ''). */
export function splitImportQuery(path: string): [string, string] {
  const q = path.indexOf('?');
  return q === -1 ? [path, ''] : [path.slice(0, q), path.slice(q + 1)];
}

/**
 * esbuild loader for an imported file under Vite asset semantics, or
 * `undefined` when the path is not an asset and the caller's normal
 * extension→loader inference should apply.
 *
 * Keys on the EXTENSION and the `?` modifier only — never on file content.
 * The G4 bug was a `.svg` reaching the JS loader and being read as JSX; an
 * extension-keyed map cannot produce that failure.
 */
export function viteAssetLoader(path: string): ViteAssetLoaderKind | undefined {
  const [bare, query] = splitImportQuery(path);
  const dot = bare.lastIndexOf('.');
  const ext = dot === -1 ? '' : bare.slice(dot).toLowerCase();
  const suffix = query.split('&')[0];
  switch (suffix) {
    case 'url': return 'file';
    case 'raw': return 'text';
    case 'base64': return 'base64';
    case 'inline': return ext === '.css' ? 'text' : 'dataurl';
    default: break;
  }
  return VITE_FILE_LOADER_EXTS[ext] ? 'file' : undefined;
}
