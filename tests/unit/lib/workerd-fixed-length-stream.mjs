/**
 * workerd's FixedLengthStream for the unit-test host.
 *
 * A Workers runtime global, not a web one, so bun has none. The contract this
 * reproduces is the documented one
 * (https://developers.cloudflare.com/workers/runtime-apis/streams/transformstream/#fixedlengthstream):
 * an identity pipe whose declared length becomes the Content-Length of a
 * Response built from it, and which errors "if too many, or too few bytes are
 * written through the stream". The declared length is left on the readable
 * as `expectedLength`, the value the runtime puts on the wire.
 *
 * This is a test-host shim only. Nothing in `src/` polyfills it, because
 * nothing in production has to.
 */

class FixedLengthStream extends TransformStream {
  constructor(expectedLength) {
    let written = 0;
    super({
      transform(chunk, controller) {
        written += chunk.byteLength;
        if (written > expectedLength) {
          throw new TypeError(`FixedLengthStream: more than the ${expectedLength} bytes declared were written`);
        }
        controller.enqueue(chunk);
      },
      flush() {
        if (written !== expectedLength) {
          throw new TypeError(`FixedLengthStream: ${written} of the ${expectedLength} bytes declared were written`);
        }
      },
    });
    this.readable.expectedLength = expectedLength;
  }
}

globalThis.FixedLengthStream ??= FixedLengthStream;
