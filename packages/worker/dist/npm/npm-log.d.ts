/**
 * npm's own log protocol, as emitted under `--loglevel`.
 *
 * Third-party tooling parses these lines rather than any prose we invent:
 * pi's `install.sh` runs `npm install --loglevel=verbose`, tees the output
 * to a file and advances its spinner label off `npm verbose title`,
 * `npm http fetch GET …` and `npm http cache …`. Discarding the flag left
 * that label frozen at "starting npm install" for the whole install, so
 * honouring it means speaking npm's wire format on the same stream.
 */
export type NpmLogLevel = 'silent' | 'error' | 'warn' | 'notice' | 'http' | 'info' | 'verbose' | 'silly';
/** The level a line is reported at; the caller decides whether to print it. */
export type NpmLogEmitter = (level: NpmLogLevel, line: string) => void;
export declare function parseNpmLogLevel(value: unknown): NpmLogLevel | null;
export declare function npmLogEnabled(configured: NpmLogLevel | null, line: NpmLogLevel): boolean;
/**
 * `npm verbose title npm install …` — npm's first verbose line, and the one
 * that tells a watcher the resolution phase has begun.
 */
export declare function npmTitleLine(packages: readonly string[]): string;
/** `npm http fetch GET 200 <url> <ms>ms (cache miss)` — served from the registry. */
export declare function npmHttpFetchLine(url: string, elapsedMs: number): string;
/**
 * `npm http cache <url>` — served from a cache tier without a registry
 * request. Tarball lines carry the integrity prefix npm uses as the cache
 * key, which is also how a watcher tells a tarball from a packument.
 */
export declare function npmHttpCacheLine(url: string, integrity?: string): string;
/** `added N packages in Xs` — npm's install summary, unstyled. */
export declare function npmAddedLine(packages: number, elapsedMs: number): string;
//# sourceMappingURL=npm-log.d.ts.map