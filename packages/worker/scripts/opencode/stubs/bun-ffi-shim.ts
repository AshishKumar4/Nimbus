// Nimbus build stub: native FFI is unavailable in workerd. The @opentui/core
// FFI seams are rerouted at build time (bundle-patches.ts) to the parked wasm
// backend; any residual call into this module fails loud.
const unavailable = (name: string) => () => {
  throw new Error(`bun:ffi ${name} is unavailable on Nimbus (native FFI is not supported in workerd)`)
}
export const dlopen = unavailable("dlopen")
export const ptr = unavailable("ptr")
export const toArrayBuffer = unavailable("toArrayBuffer")
export const CString = unavailable("CString")
export const JSCallback = unavailable("JSCallback")
export const suffix = "so"
export const FFIType = new Proxy({}, { get: (_t, p) => String(p) })
