/**
 * static-mime.ts — the media type a static file is served as, by its
 * extension: the vocabulary the ASSETS binding (bindings.ts) and the Vite
 * dev server share, each surface adding its own extensions to it.
 */

/** A surface's media types, by extension: lowercase, with its dot. */
export type StaticMimeTypes = Readonly<Record<string, string>>;

const SHARED: StaticMimeTypes = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'application/javascript; charset=utf-8',
  '.mjs': 'application/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.map': 'application/json; charset=utf-8',
  '.txt': 'text/plain; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.webp': 'image/webp',
  '.gif': 'image/gif',
  '.ico': 'image/x-icon',
  '.woff': 'font/woff',
  '.woff2': 'font/woff2',
  '.wasm': 'application/wasm',
};

/** The shared vocabulary with a surface's `own` extensions added. */
export function staticMimeTypes(own: StaticMimeTypes): StaticMimeTypes {
  return { ...SHARED, ...own };
}

/**
 * `path`'s extension, lowercase, with its dot: from a dot after the last
 * slash with something after it, else ''. `/src/v1.0/App` has none.
 */
export function staticExtension(path: string): string {
  const dot = path.lastIndexOf('.');
  return dot > path.lastIndexOf('/') && dot < path.length - 1 ? path.slice(dot).toLowerCase() : '';
}

/** The media type `types` gives `extension`; application/octet-stream when it gives none. */
export function staticMimeType(types: StaticMimeTypes, extension: string): string {
  return Object.hasOwn(types, extension) ? types[extension] : 'application/octet-stream';
}
