/**
 * static-mime.ts — the media type a static file is served as, by its
 * extension: the vocabulary the ASSETS binding (bindings.ts) and the Vite
 * dev server share, each surface adding its own extensions to it.
 */
/** A surface's media types, by extension: lowercase, with its dot. */
export type StaticMimeTypes = Readonly<Record<string, string>>;
/** The shared vocabulary with a surface's `own` extensions added. */
export declare function staticMimeTypes(own: StaticMimeTypes): StaticMimeTypes;
/**
 * `path`'s extension, lowercase, with its dot: from a dot after the last
 * slash with something after it, else ''. `/src/v1.0/App` has none.
 */
export declare function staticExtension(path: string): string;
/** The media type `types` gives `extension`; application/octet-stream when it gives none. */
export declare function staticMimeType(types: StaticMimeTypes, extension: string): string;
//# sourceMappingURL=static-mime.d.ts.map