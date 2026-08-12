/**
 * CompressionStream / DecompressionStream for the unit-test host.
 *
 * These are Web Platform globals. The Workers runtime has them —
 * `@cloudflare/workers-types` declares both, and `npm/tarball.ts` pipes every
 * npm tarball through `new DecompressionStream('gzip')` on the production
 * install path — but bun does not expose them, while node does.
 *
 * Without this, every gzip-backed command (`tar -xzf`, `gzip`, `gunzip`) threw
 * "DecompressionStream is not defined" the moment a test touched it, so none of
 * them was ever covered here. That gap is why their argument parsing went
 * un-differentiated long enough for `gzip -dk` to be a hard error.
 *
 * This is a test-host shim only. Nothing in `src/` polyfills these, because
 * nothing in production has to.
 */
import zlib from 'node:zlib';
import { Duplex } from 'node:stream';

const TRANSFORMS = {
  gzip: () => zlib.createGzip(),
  deflate: () => zlib.createDeflate(),
  'deflate-raw': () => zlib.createDeflateRaw(),
};

const INVERSES = {
  gzip: () => zlib.createGunzip(),
  deflate: () => zlib.createInflate(),
  'deflate-raw': () => zlib.createInflateRaw(),
};

function webTransform(factories, format) {
  const make = factories[format];
  if (!make) throw new TypeError(`Unsupported compression format: ${format}`);
  return Duplex.toWeb(make());
}

/** Install the globals if the host lacks them. Returns true when it shimmed. */
export function installCompressionStreams() {
  if (typeof globalThis.DecompressionStream === 'function') return false;

  globalThis.CompressionStream = class CompressionStream {
    constructor(format) {
      const { readable, writable } = webTransform(TRANSFORMS, format);
      this.readable = readable;
      this.writable = writable;
    }
  };
  globalThis.DecompressionStream = class DecompressionStream {
    constructor(format) {
      const { readable, writable } = webTransform(INVERSES, format);
      this.readable = readable;
      this.writable = writable;
    }
  };
  return true;
}
