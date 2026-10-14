/**
 * The file: URL lifo's loaders name an absolute path by (module wrappers,
 * private module URLs, `[eval]`): one encoding under every engine, which the
 * loaders' names depend on. The engines' own pathToFileURL differ (Bun's
 * escapes `~`, Node's does not); a program's url module is the engine's.
 */
export declare function pathToFileURL(path: string): URL;
//# sourceMappingURL=file-url.d.ts.map