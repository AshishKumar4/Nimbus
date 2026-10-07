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
import { DIM, GREEN, RED, RESET, YELLOW } from '../../utils/colors.js';
/** npm's own ordering: a level enables itself and everything quieter. */
const LEVEL_RANK = {
    silent: 0,
    error: 1,
    warn: 2,
    notice: 3,
    http: 4,
    info: 5,
    verbose: 6,
    silly: 7,
};
export function parseNpmLogLevel(value) {
    return typeof value === 'string' && value in LEVEL_RANK ? value : null;
}
export function npmLogEnabled(configured, line) {
    return configured !== null && LEVEL_RANK[configured] >= LEVEL_RANK[line];
}
/**
 * `npm verbose title npm install …` — npm's first verbose line, and the one
 * that tells a watcher the resolution phase has begun.
 */
export function npmTitleLine(packages) {
    return `npm verbose title npm install${packages.map((p) => ` ${p}`).join('')}`;
}
/** `npm http fetch GET 200 <url> <ms>ms (cache miss)` — served from the registry. */
export function npmHttpFetchLine(url, elapsedMs) {
    return `npm http fetch GET 200 ${url} ${Math.max(0, Math.round(elapsedMs))}ms (cache miss)`;
}
/**
 * `npm http cache <url>` — served from a cache tier without a registry
 * request. Tarball lines carry the integrity prefix npm uses as the cache
 * key, which is also how a watcher tells a tarball from a packument.
 */
export function npmHttpCacheLine(url, integrity) {
    return `npm http cache ${integrity ? `${integrity}@${url}` : url}`;
}
/** `added N packages in Xs` — npm's install summary, unstyled. */
export function npmAddedLine(packages, elapsedMs) {
    const unit = packages === 1 ? 'package' : 'packages';
    return `added ${packages} ${unit} in ${(elapsedMs / 1000).toFixed(1)}s`;
}
/**
 * The end of an install, as a person reads it, for every install path (the
 * lifo npm, its install port, the hosted npm-fast): a red `Failed:` line on
 * stderr for what failed; then `up to date in Xs` when nothing was installed
 * or failed, else `added N packages (F files) in Xs`, yellow with the failure
 * count when partial, green otherwise; then dim `(N from cache)` and
 * `linked N bins into DIR`. npmAddedLine is the machine's spelling of it.
 */
export function installSummary(report) {
    const stderr = report.failed.length > 0 ? `${RED}Failed: ${report.failed.join(', ')}${RESET}\n` : '';
    const secs = (report.elapsedMs / 1000).toFixed(1);
    if (report.installed === 0) {
        return { stdout: report.failed.length === 0 ? `${GREEN}up to date in ${secs}s${RESET}\n` : '', stderr };
    }
    const partial = report.failed.length > 0;
    const files = report.totalFiles !== undefined ? ` (${report.totalFiles} files)` : '';
    let stdout = `\n${partial ? YELLOW : GREEN}added ${report.installed} packages${files} in ${secs}s${partial ? ` (${report.failed.length} failed, see above)` : ''}${RESET}\n`;
    if (report.fromCacheHits)
        stdout += `${DIM}  (${report.fromCacheHits} from cache)${RESET}\n`;
    if (report.linkedBins)
        stdout += `${DIM}  linked ${report.linkedBins} bin${report.linkedBins === 1 ? '' : 's'} into ${report.globalBinDir}${RESET}\n`;
    return { stdout, stderr };
}
