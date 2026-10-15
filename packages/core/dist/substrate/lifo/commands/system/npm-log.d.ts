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
import type { EngineMismatch } from '../../../../_shared/npm-arborist/engines.js';
import type { DevEnginesFailure } from '../../../../_shared/npm-libs.js';
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
/** `removed N packages in T`, or `up to date in T` — npm's summary of an uninstall, its time as the `ms` package prints it. */
export declare function npmRemovedLine(packages: number, elapsedMs: number): string;
/** What an install did, as its styled summary reports it. */
export interface InstallReport {
    readonly installed: number;
    readonly failed: readonly string[];
    readonly elapsedMs: number;
    readonly totalFiles?: number;
    readonly fromCacheHits?: number;
    readonly linkedBins?: number;
    readonly globalBinDir?: string;
}
/**
 * The end of an install, as a person reads it, for every install path (the
 * lifo npm, its install port, the hosted npm-fast): a red `Failed:` line on
 * stderr for what failed; then `up to date in Xs` when nothing was installed
 * or failed, else `added N packages (F files) in Xs`, yellow with the failure
 * count when partial, green otherwise; then dim `(N from cache)` and
 * `linked N bins into DIR`. npmAddedLine is the machine's spelling of it.
 */
export declare function installSummary(report: InstallReport): {
    stdout: string;
    stderr: string;
};
/**
 * What npm says of an EBADENGINE: the warning it lets pass (arborist's
 * log.warn(code, message, { package, required, current }), each line as
 * npm's display prefixes it), or under `--engine-strict` the error it ends
 * with (error-message.js's summary and detail).
 */
export declare function npmEngineLines(mismatch: EngineMismatch, strict: boolean): string[];
/**
 * What npm says of a devEngines failure (base-cmd checkDevEngines): its
 * message (the first said with npm's preface), then what is current and
 * what is required, each line as npm's display prefixes it; `level` warn
 * for one npm lets pass, error for the one the command ends with
 * (error-message.js's summary and detail).
 */
export declare function npmDevEnginesLines(failure: DevEnginesFailure, first: boolean, level: 'warn' | 'error'): string[];
//# sourceMappingURL=npm-log.d.ts.map