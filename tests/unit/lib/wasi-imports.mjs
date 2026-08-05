/**
 * Build a WASI import table that a JS-driven test can actually call.
 *
 * wasi-instance.ts wraps fd_read/fd_write/fd_pread/path_filestat_get and the
 * socket and poll_oneoff imports in WebAssembly.Suspending whenever the
 * runtime has JSPI. V8 traps ANY call into a Suspending import from a stack
 * that WebAssembly.promising did not enter — a plain errno return included;
 * that constraint is documented at the wrap site and is what took the Ruby VM
 * boot dark. Only a wasm guest can enter such a stack, so a test driving the
 * imports from JS cannot call the wrapped table at all.
 *
 * The wrapper is pure calling convention: it parks the guest on whatever the
 * body returns. Awaiting that value from JS is the same observation, and the
 * body is the same function either way — which is why these tests assert
 * filesystem behavior through the preamble's documented no-JSPI branch.
 *
 * bun before 1.3.14 let a Suspending import be called from any stack, so the
 * tests took this branch by accident and silently changed meaning when the
 * runner upgraded. Asking for it explicitly is what makes them portable.
 *
 * Directory note: this lives under tests/unit/lib/ because the suite runs
 * `tests/unit/*.mjs`, which would otherwise execute a helper as a test.
 */

/**
 * @param {{ __wasiMakeImports: (options: object) => object }} preamble
 * @param {object} options  Forwarded to __wasiMakeImports unchanged.
 */
export function makeImportsWithoutJSPI(preamble, options) {
  const { Suspending } = WebAssembly;
  delete WebAssembly.Suspending;
  try {
    return preamble.__wasiMakeImports(options);
  } finally {
    if (Suspending !== undefined) WebAssembly.Suspending = Suspending;
  }
}
