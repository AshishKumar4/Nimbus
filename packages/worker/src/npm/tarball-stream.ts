/**
 * npm-tarball-stream.ts — pure streaming tar primitives.
 *
 * Extracted from npm-tarball.ts so these helpers can be esbuild-bundled
 * WITHOUT dragging in NpmCache / NpmResolver / SqliteVFS. Consumed by
 * scripts/bundle-facet-workers.mjs which emits a string constant the
 * NimbusLoaderPool uses to inject the tar parser into dynamic workers.
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
 * Read one tar header (USTAR) out of `block`. Returns parsed fields or
 * `null` for an end-of-archive block (all zeros).
 */
export function parseTarHeader(block: Uint8Array): { name: string; size: number; typeFlag: number } | null {
  if (block[0] === 0) return null;

  let name = '';
  for (let i = 0; i < 100 && block[i] !== 0; i++) {
    name += String.fromCharCode(block[i]);
  }
  let prefix = '';
  for (let i = 345; i < 500 && block[i] !== 0; i++) {
    prefix += String.fromCharCode(block[i]);
  }
  if (prefix) name = prefix + '/' + name;
  // Strip the npm `package/` convention.
  name = name.replace(/^package\//, '');

  let sizeStr = '';
  for (let i = 124; i < 136 && block[i] !== 0; i++) {
    sizeStr += String.fromCharCode(block[i]);
  }
  const size = parseInt(sizeStr.trim(), 8) || 0;
  const typeFlag = block[156];
  return { name, size, typeFlag };
}

/**
 * Wrap a `ReadableStream<Uint8Array>` as an async iterable. Workerd and
 * Node both support `Symbol.asyncIterator` on ReadableStream, but we
 * spell the reader loop out so we don't depend on ambient lib typings.
 */
export async function* readableStreamToAsyncIterable(
  rs: ReadableStream<Uint8Array>,
): AsyncGenerator<Uint8Array, void, undefined> {
  const reader = rs.getReader();
  try {
    while (true) {
      const { value, done } = await reader.read();
      if (done) return;
      if (value && value.length > 0) yield value;
    }
  } finally {
    try { reader.releaseLock(); } catch { /* ignore */ }
  }
}

/**
 * Reason a tar entry was skipped and never yielded. Surfaced to callers
 * via the optional `onSkip` callback on `streamTarEntries`.
 *
 * - 'too-large': size > MAX_FILE_BYTES. The most common reason Nimbus
 *   cares about — it's what caused esbuild-wasm/esbuild.wasm to vanish
 *   silently in Nimbus-in-Nimbus before the cap was raised.
 * - 'non-regular': typeFlag indicates a symlink / hardlink / directory /
 *   PaxHeader / GNU LongName etc. These aren't files we stage.
 * - 'no-name': header parsed but name was empty (malformed or a PaxHeader
 *   that our parser didn't recognize as non-regular).
 */
export type TarSkipReason = 'too-large' | 'non-regular' | 'no-name';

/**
 * Optional skip-observer passed to `streamTarEntries`. Called ONCE per
 * skipped entry, with the declared name (may be empty for 'no-name'
 * skips) and the declared size in bytes.
 *
 * Consumers typically push these into a per-package warnings array so
 * users see what wasn't installed. The callback is synchronous and
 * must not throw — thrown errors are swallowed to keep the extractor
 * best-effort.
 */
export type TarSkipCallback = (
  name: string,
  size: number,
  reason: TarSkipReason,
) => void;

/**
 * Streaming tar extractor.
 *
 * Consumes an async iterable of Uint8Array chunks (the decompressed tar
 * byte stream) and yields one `{ name, data }` entry per regular file,
 * as each file completes.
 *
 * Memory invariant: holds at most one pending file's bytes (≤ MAX_FILE_BYTES)
 * plus a small carry buffer for the tar header being assembled.
 *
 * Skips: symlinks, directories, hardlinks, long-name extensions (PaxHeader),
 * and any file whose declared size exceeds MAX_FILE_BYTES.
 *
 * If `onSkip` is provided, it is invoked for each skipped entry with the
 * name, declared size, and reason code. Callers that need to surface
 * dropped-file warnings to users should pass one; legacy callers that
 * omit the arg still behave exactly as before (silent skip).
 */
export async function* streamTarEntries(
  source: AsyncIterable<Uint8Array>,
  onSkip?: TarSkipCallback,
): AsyncGenerator<{ name: string; data: Uint8Array }, void, undefined> {
  let carry: Uint8Array<ArrayBufferLike> = new Uint8Array(0);

  type State =
    | { kind: 'header' }
    | { kind: 'file'; name: string; remaining: number; fileBuf: Uint8Array; fileOffset: number; pad: number; skip: boolean }
    | { kind: 'skip'; remaining: number };
  let state: State = { kind: 'header' };

  function concat(a: Uint8Array, b: Uint8Array): Uint8Array {
    if (a.length === 0) return b;
    if (b.length === 0) return a;
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
        if (buf.length - cursor < 512) break;
        const header = buf.subarray(cursor, cursor + 512);
        const parsed = parseTarHeader(header);
        cursor += 512;
        if (!parsed) return; // end-of-archive
        const { name, size, typeFlag } = parsed;
        const pad = size === 0 ? 0 : (512 - (size % 512)) % 512;
        const isRegularFile = (typeFlag === 48 /* '0' */ || typeFlag === 0);
        if (size === 0) {
          if (isRegularFile && name) {
            yield { name, data: new Uint8Array(0) };
          }
          state = { kind: 'header' };
          continue;
        }
        if (!isRegularFile || !name || size > MAX_FILE_BYTES) {
          if (onSkip) {
            // Classify before entering the skip state so the reason is
            // exact. Precedence matches the condition order above:
            // non-regular first (directories/symlinks/PaxHeaders are
            // skipped regardless of size), then no-name, then too-large.
            const reason: TarSkipReason = !isRegularFile
              ? 'non-regular'
              : !name
              ? 'no-name'
              : 'too-large';
            try { onSkip(name, size, reason); } catch { /* best-effort */ }
          }
          state = { kind: 'skip', remaining: size + pad };
          continue;
        }
        state = {
          kind: 'file',
          name,
          remaining: size,
          fileBuf: new Uint8Array(size),
          fileOffset: 0,
          pad,
          skip: false,
        };
        continue;
      }

      if (state.kind === 'file') {
        const avail = buf.length - cursor;
        if (avail === 0) break;
        if (state.remaining > 0) {
          const take = Math.min(state.remaining, avail);
          state.fileBuf.set(buf.subarray(cursor, cursor + take), state.fileOffset);
          state.fileOffset += take;
          state.remaining -= take;
          cursor += take;
          if (state.remaining > 0) break;
        }
        if (state.pad > 0) {
          const avail2 = buf.length - cursor;
          if (avail2 === 0) break;
          const take = Math.min(state.pad, avail2);
          state.pad -= take;
          cursor += take;
          if (state.pad > 0) break;
        }
        yield { name: state.name, data: state.fileBuf };
        state = { kind: 'header' };
        continue;
      }

      // state.kind === 'skip'
      const avail = buf.length - cursor;
      if (avail === 0) break;
      const take = Math.min(state.remaining, avail);
      cursor += take;
      state.remaining -= take;
      if (state.remaining > 0) break;
      state = { kind: 'header' };
    }

    if (cursor >= buf.length) {
      carry = new Uint8Array(0);
    } else if (cursor === 0) {
      carry = buf;
    } else {
      carry = buf.slice(cursor);
    }
  }
}
