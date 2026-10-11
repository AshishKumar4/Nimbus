/**
 * tarball-stream.ts — pure streaming tar primitives.
 *
 * A leaf with no imports at all, deliberately: `bundle-facet-workers.mjs`
 * esbuilds this file into a string constant the loader pool injects into
 * dynamic workers, and a facet isolate resolves no specifier. Anything this
 * file imported would have to travel with it.
 *
 * Zero dependencies. Works identically on the supervisor and inside a
 * facet isolate. Never buffers the full decompressed tarball — peak
 * transient heap is one file's bytes plus a 512-byte carry.
 */
/**
 * Maximum size of a single file inside a tarball. Larger entries are skipped.
 *
 * History: 5 MB was too low — it silently dropped `esbuild-wasm/esbuild.wasm`
 * (11.35 MB on v0.24.2), which made Nimbus-in-Nimbus `npm run dev` fail with
 * `No such module "esbuild-wasm/esbuild.wasm"` since the missing file caused
 * esbuild's VFS plugin to mark the import `external`, and workerd's LOADER
 * has no entry for that specifier. 20 MB covers esbuild-wasm with headroom
 * while keeping per-facet peak heap bounded for the streaming extractor.
 */
export const MAX_FILE_BYTES = 20_000_000;
/**
 * Collapse "."/".." segments in a tar entry's package-relative path.
 * Returns the canonical relative path, or '' when the entry escapes its
 * package root (a leading ".." that pops above the root) — the caller
 * treats '' as a no-name entry and skips it. Mirrors the segment logic in
 * w7-frame's canonicalPath so joined write paths are always accepted.
 */
export function canonicalTarName(name) {
    const out = [];
    for (const seg of name.split('/')) {
        if (seg === '..') {
            if (out.length === 0)
                return '';
            out.pop();
        }
        else if (seg !== '' && seg !== '.') {
            out.push(seg);
        }
    }
    return out.join('/');
}
/** Pathname fields are names, not documents: a leading U+FEFF is part of the name. */
const PATH_DECODER = new TextDecoder('utf-8', { ignoreBOM: true });
/** A USTAR field of `block`: the bytes at [start, end) up to the first NUL. */
function tarField(block, start, end) {
    let stop = start;
    while (stop < end && block[stop] !== 0)
        stop++;
    return block.subarray(start, stop);
}
/** A numeric USTAR field: its octal digits, after any leading spaces. */
function tarOctal(block, start, end) {
    let i = start;
    while (i < end && block[i] === 0x20)
        i++;
    let value = 0;
    for (; i < end && block[i] >= 0x30 && block[i] <= 0x37; i++)
        value = value * 8 + (block[i] - 0x30);
    return value;
}
/** Whether `block` is a POSIX ustar header ("ustar\0" and version "00"), whose bytes 345 on are a name prefix (GNU's hold times there). */
function posixUstar(block) {
    return block[257] === 0x75 && block[258] === 0x73 && block[259] === 0x74 && block[260] === 0x61 && block[261] === 0x72
        && block[262] === 0 && block[263] === 0x30 && block[264] === 0x30;
}
/**
 * Read one tar header (USTAR) out of `block`, or null for an end-of-archive
 * block. Names are UTF-8, as tar writes them today.
 */
export function parseTarHeader(block) {
    if (block[0] === 0)
        return null;
    let name = PATH_DECODER.decode(tarField(block, 0, 100));
    const prefix = posixUstar(block) ? tarField(block, 345, 500) : block.subarray(0, 0);
    if (prefix.length > 0)
        name = PATH_DECODER.decode(prefix) + '/' + name;
    const typeFlag = block[156];
    const directory = typeFlag === 53 /* '5' */ || name.endsWith('/');
    // The single top-level directory npm wraps every package in is learned
    // and stripped per-archive by streamPackageEntries — the prefix is part
    // of the package contract, not a fixed 'package' literal.
    // Canonicalize the entry-relative path. npm tarballs legitimately carry
    // entries like "./dist/index.js" (agent-base, http-proxy-agent,
    // protobufjs, ...); left as-is the "./" survives into the VFS write path
    // and the w7-frame writer rejects the noncanonical path, failing the
    // whole shared install wave and dropping shard-mates' completion markers.
    // Collapsing here (the one place entry names are assembled) keeps every
    // downstream join canonical. An entry that escapes its package root via
    // ".." is dropped to '' → skipped as a no-name entry.
    name = canonicalTarName(name);
    return { name, size: tarOctal(block, 124, 136), typeFlag, mode: tarOctal(block, 100, 108), mtime: tarOctal(block, 136, 148), directory };
}
/**
 * Wrap a `ReadableStream<Uint8Array>` as an async iterable. Workerd and
 * Node both support `Symbol.asyncIterator` on ReadableStream, but we
 * spell the reader loop out so we don't depend on ambient lib typings.
 */
export async function* readableStreamToAsyncIterable(rs) {
    const reader = rs.getReader();
    try {
        while (true) {
            const { value, done } = await reader.read();
            if (done)
                return;
            if (value && value.length > 0)
                yield value;
        }
    }
    finally {
        try {
            reader.releaseLock();
        }
        catch { /* ignore */ }
    }
}
/** An archive held whole in memory, as the stream streamTarRecords reads. */
export async function* tarBytes(bytes) {
    yield bytes;
}
/** Whether `header` is a regular file's: type '0', or NUL as old tars wrote it. */
export function isRegularTarFile(header) {
    return header.typeFlag === 48 /* '0' */ || header.typeFlag === 0;
}
/**
 * Every entry of a tar stream, in order, each as its data completes: its
 * header, and its data when `read(header)` asks for it, else null (the data
 * is passed over unread). An extraction's policy is its `read`.
 *
 * Consumes an async iterable of Uint8Array chunks (the decompressed tar
 * byte stream). Memory invariant: holds at most one pending entry's bytes
 * plus a small carry buffer for the tar header being assembled.
 */
export async function* streamTarRecords(source, read) {
    let carry = new Uint8Array(0);
    let state = { kind: 'header' };
    function concat(a, b) {
        if (a.length === 0)
            return b;
        if (b.length === 0)
            return a;
        const out = new Uint8Array(a.length + b.length);
        out.set(a, 0);
        out.set(b, a.length);
        return out;
    }
    for await (const chunkRaw of source) {
        let buf = concat(carry, chunkRaw);
        let cursor = 0;
        while (true) {
            if (state.kind === 'header') {
                if (buf.length - cursor < 512)
                    break;
                const header = parseTarHeader(buf.subarray(cursor, cursor + 512));
                cursor += 512;
                if (!header)
                    return; // end-of-archive
                const wanted = read(header);
                if (header.size === 0) {
                    yield { header, data: wanted ? new Uint8Array(0) : null };
                    continue;
                }
                state = {
                    kind: 'data',
                    header,
                    remaining: header.size,
                    data: wanted ? new Uint8Array(header.size) : null,
                    offset: 0,
                    pad: (512 - (header.size % 512)) % 512,
                };
                continue;
            }
            const avail = buf.length - cursor;
            if (avail === 0)
                break;
            if (state.remaining > 0) {
                const take = Math.min(state.remaining, avail);
                state.data?.set(buf.subarray(cursor, cursor + take), state.offset);
                state.offset += take;
                state.remaining -= take;
                cursor += take;
                if (state.remaining > 0)
                    break;
            }
            if (state.pad > 0) {
                const take = Math.min(state.pad, buf.length - cursor);
                state.pad -= take;
                cursor += take;
                if (state.pad > 0)
                    break;
            }
            yield { header: state.header, data: state.data };
            state = { kind: 'header' };
        }
        if (cursor >= buf.length) {
            carry = new Uint8Array(0);
        }
        else if (cursor === 0) {
            carry = buf;
        }
        else {
            carry = buf.slice(cursor);
        }
    }
}
/**
 * The regular files of a tar stream, `{ name, data }`, as each completes:
 * npm's policy over streamTarRecords.
 *
 * Skips: symlinks, directories, hardlinks, long-name extensions (PaxHeader),
 * and any file whose declared size exceeds MAX_FILE_BYTES.
 *
 * If `onSkip` is provided, it is invoked for each skipped entry that
 * carries bytes with the name, declared size, and reason code. Callers that
 * need to surface dropped-file warnings to users should pass one; legacy
 * callers that omit the arg still behave exactly as before (silent skip).
 */
export async function* streamTarEntries(source, onSkip) {
    const wanted = (header) => isRegularTarFile(header) && header.name !== '' && header.size <= MAX_FILE_BYTES;
    for await (const { header, data } of streamTarRecords(source, wanted)) {
        if (data) {
            yield { name: header.name, data };
            continue;
        }
        if (!onSkip || header.size === 0)
            continue;
        // Non-regular first (directories/symlinks/PaxHeaders are skipped
        // regardless of size), then no-name, then too-large.
        const reason = !isRegularTarFile(header) ? 'non-regular' : header.name === '' ? 'no-name' : 'too-large';
        try {
            onSkip(header.name, header.size, reason);
        }
        catch { /* best-effort */ }
    }
}
/**
 * Stream the files of an npm package tarball, package-relative.
 *
 * npm wraps every package in ONE top-level directory whose name is the
 * publisher's choice — registry convention is `package/`, but live
 * tarballs ship other roots (@types/node@26 carries `node/`). This
 * learns the prefix from the first entry's top-level component and
 * strips it from every entry, so `<root>/package.json` yields
 * `package.json` and an entry named exactly `<root>` yields nothing —
 * the root directory itself carries no bytes to write.
 *
 * An entry under a different top-level component means the archive is
 * not a single-rooted package (or tries to smuggle a sibling of the
 * root); the generator throws rather than extract it.
 *
 * Only regular-file entries carry the prefix check — directory, link and
 * metadata records are skipped inside streamTarEntries before they reach
 * here, so a PaxHeader like `./PaxHeaders/x` can never poison the learned
 * prefix.
 */
export async function* streamPackageEntries(source, onSkip) {
    let prefix = null;
    for await (const entry of streamTarEntries(source, onSkip)) {
        if (prefix === null) {
            prefix = entry.name.split('/', 1)[0];
        }
        if (entry.name === prefix)
            continue;
        if (!entry.name.startsWith(prefix + '/')) {
            throw new Error(`package tarball is not single-rooted: entry "${entry.name}" sits outside "${prefix}/"`);
        }
        yield { name: entry.name.slice(prefix.length + 1), data: entry.data };
    }
}
