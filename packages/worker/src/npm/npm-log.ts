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

export type NpmLogLevel =
  | 'silent'
  | 'error'
  | 'warn'
  | 'notice'
  | 'http'
  | 'info'
  | 'verbose'
  | 'silly';

/** npm's own ordering: a level enables itself and everything quieter. */
const LEVEL_RANK: Record<NpmLogLevel, number> = {
  silent: 0,
  error: 1,
  warn: 2,
  notice: 3,
  http: 4,
  info: 5,
  verbose: 6,
  silly: 7,
};

/** The level a line is reported at; the caller decides whether to print it. */
export type NpmLogEmitter = (level: NpmLogLevel, line: string) => void;

export function parseNpmLogLevel(value: unknown): NpmLogLevel | null {
  return typeof value === 'string' && value in LEVEL_RANK ? value as NpmLogLevel : null;
}

export function npmLogEnabled(configured: NpmLogLevel | null, line: NpmLogLevel): boolean {
  return configured !== null && LEVEL_RANK[configured] >= LEVEL_RANK[line];
}

/**
 * `npm verbose title npm install …` — npm's first verbose line, and the one
 * that tells a watcher the resolution phase has begun.
 */
export function npmTitleLine(packages: readonly string[]): string {
  return `npm verbose title npm install${packages.map((p) => ` ${p}`).join('')}`;
}

/** `npm http fetch GET 200 <url> <ms>ms (cache miss)` — served from the registry. */
export function npmHttpFetchLine(url: string, elapsedMs: number): string {
  return `npm http fetch GET 200 ${url} ${Math.max(0, Math.round(elapsedMs))}ms (cache miss)`;
}

/**
 * `npm http cache <url>` — served from a cache tier without a registry
 * request. Tarball lines carry the integrity prefix npm uses as the cache
 * key, which is also how a watcher tells a tarball from a packument.
 */
export function npmHttpCacheLine(url: string, integrity?: string): string {
  return `npm http cache ${integrity ? `${integrity}@${url}` : url}`;
}

/** `added N packages in Xs` — npm's install summary, unstyled. */
export function npmAddedLine(packages: number, elapsedMs: number): string {
  const unit = packages === 1 ? 'package' : 'packages';
  return `added ${packages} ${unit} in ${(elapsedMs / 1000).toFixed(1)}s`;
}
