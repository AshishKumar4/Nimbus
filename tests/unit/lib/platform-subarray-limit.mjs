/**
 * The Workers runtime's refusal of a high `subarray` on wasm memory, scaled down.
 *
 * In a Worker (and a Worker Loader guest), an ArrayBuffer is capped at
 * 128 MiB, and only a WebAssembly.Memory's buffer grows past it. V8's
 * %TypedArray%.prototype.subarray computes its begin's byte offset with
 * CalculateByteLength, which refuses anything over the embedder's maximum
 * ArrayBuffer length (src/builtins/typed-array-subarray.tq,
 * typed-array.tq: ArrayBufferMaxByteLength): on a 136 MiB memory,
 * `new Uint8Array(memory.buffer).subarray(begin, end)` throws "RangeError:
 * Invalid array buffer length" once begin × BYTES_PER_ELEMENT passes 2^27,
 * where the constructor `new Uint8Array(buffer, byteOffset, length)`, set,
 * fill, slice and DataView all work (measured on a bare Worker). rolldown's
 * memory reaches 152 MiB pre-bundling a React app's dependencies.
 *
 * `simulatePlatformSubarrayLimit(limit)` makes this process refuse the same
 * way at `limit` bytes, on WebAssembly.Memory buffers only, and counts the
 * refusals; `restore()` puts the builtins back.
 */
export function simulatePlatformSubarrayLimit(limit) {
  const TypedArray = Object.getPrototypeOf(Uint8Array.prototype);
  const nativeSubarray = TypedArray.subarray;
  const bufferGetter = Object.getOwnPropertyDescriptor(WebAssembly.Memory.prototype, 'buffer');
  const wasmBuffers = new WeakSet();
  const state = { refused: 0, restore };
  Object.defineProperty(WebAssembly.Memory.prototype, 'buffer', {
    ...bufferGetter,
    get() {
      const buffer = bufferGetter.get.call(this);
      wasmBuffers.add(buffer);
      return buffer;
    },
  });
  TypedArray.subarray = function subarray(begin, end) {
    if (wasmBuffers.has(this.buffer) && Number(begin) * this.BYTES_PER_ELEMENT > limit) {
      state.refused++;
      throw new RangeError('Invalid array buffer length');
    }
    return nativeSubarray.call(this, begin, end);
  };
  function restore() {
    TypedArray.subarray = nativeSubarray;
    Object.defineProperty(WebAssembly.Memory.prototype, 'buffer', bufferGetter);
  }
  return state;
}
