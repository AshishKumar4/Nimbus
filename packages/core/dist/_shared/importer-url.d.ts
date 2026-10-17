/**
 * importer-url.ts — the URL a module at a VFS path imports from, shared by
 * the interpreter (interpreter/index.ts) and the host (module-importer.ts).
 */
/**
 * The importer URL of the module at `path`: a VFS path, with or without its
 * leading slash, or a data: URL. A path's is Node's pathToFileURL of it:
 * printable ASCII as itself but `escaped`'s, everything else its UTF-8 bytes
 * percent-encoded (a lone surrogate U+FFFD's), so a `#` or `?` in a name is
 * part of the path. It calls no built-in method but `codeAt`, so the
 * interpreter gives its own (interpreter/intrinsics.ts charCodeAt): a
 * program may have replaced the others (tests/unit/interpreter-primordials.mjs).
 */
export declare function importerUrl(path: string, codeAt: (text: string, index: number) => number): string;
//# sourceMappingURL=importer-url.d.ts.map