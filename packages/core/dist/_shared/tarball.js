/**
 * Tarball extraction for streaming installers and buffered archive consumers.
 *
 * The streaming primitives it walks with (`parseTarHeader`, `streamTarEntries`,
 * `readableStreamToAsyncIterable`) live in `./tarball-stream.ts` — a
 * dependency-free leaf, because `bundle-facet-workers.mjs` esbuilds that file
 * into a string the loader pool injects into dynamic workers, where an import
 * would not resolve.
 *
 * Installers use writeTarballStream. extractTarball retains a map for callers
 * such as gem install, which must open an archive nested inside another one.
 */
import { streamTarEntries, readableStreamToAsyncIterable, } from './tarball-stream.js';
const PACKAGE_MANIFEST = 'package.json';
/**
 * Stream a gzipped npm archive into a package directory. Entry names are
 * already canonical and prefix-stripped by streamTarEntries. Hold only the
 * current entry and the manifest; write the manifest last so a failed install
 * is not mistaken for a complete package on retry. Filesystem failures reject.
 */
export async function writeTarballStream(body, targetDir, vfs) {
    const ensureDir = (path) => {
        if (!vfs.exists(path))
            vfs.mkdir(path, { recursive: true });
    };
    ensureDir(targetDir);
    let files = 0;
    let bytes = 0;
    let manifest = null;
    const entries = streamTarEntries(readableStreamToAsyncIterable(body.pipeThrough(new DecompressionStream('gzip'))));
    for await (const entry of entries) {
        if (entry.name === PACKAGE_MANIFEST) {
            manifest = entry.data;
            continue;
        }
        const fullPath = `${targetDir}/${entry.name}`;
        const cut = fullPath.lastIndexOf('/');
        if (cut > 0)
            ensureDir(fullPath.slice(0, cut));
        await vfs.writeFile(fullPath, entry.data);
        files++;
        bytes += entry.data.length;
    }
    if (!manifest)
        throw new Error(`tarball for ${targetDir} carried no ${PACKAGE_MANIFEST}`);
    await vfs.writeFile(`${targetDir}/${PACKAGE_MANIFEST}`, manifest);
    return { files: files + 1, bytes: bytes + manifest.length };
}
/** Extract every regular file. Gzipped input is decompressed first. */
export async function extractTarball(tarball) {
    const files = new Map();
    const raw = new Uint8Array(tarball);
    // Adapter: wrap the single buffer as an async iterable. If gzipped, pipe
    // through DecompressionStream so the streaming parser still sees tar bytes.
    let source;
    if (raw[0] === 0x1f && raw[1] === 0x8b) {
        const rs = new Blob([tarball]).stream().pipeThrough(new DecompressionStream('gzip'));
        source = readableStreamToAsyncIterable(rs);
    }
    else {
        source = (async function* () { yield raw; })();
    }
    try {
        for await (const entry of streamTarEntries(source)) {
            files.set(entry.name, entry.data);
        }
    }
    catch {
        return files;
    }
    return files;
}
