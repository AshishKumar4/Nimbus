export interface JsModule { js: string }
export interface CjsModule { cjs: string }
export interface PyModule { py: string }
export interface TextModule { text: string }
export interface DataModule { data: ArrayBuffer }
export interface JsonModule { json: unknown }
export interface WasmModule { wasm: ArrayBuffer | WebAssembly.Module }

/**
 * `bytes` as the ArrayBuffer a `{ wasm }` or `{ data }` member carries: their
 * own buffer when they span all of it, and only otherwise a copy of them, so
 * an image read whole for a load is never held twice.
 */
export function memberBuffer(bytes: Uint8Array): ArrayBuffer {
  return bytes.byteOffset === 0 && bytes.byteLength === bytes.buffer.byteLength && bytes.buffer instanceof ArrayBuffer
    ? bytes.buffer
    : bytes.slice().buffer;
}

/** Plain strings use the module name's extension. */
export type ModuleContent = string | JsModule | CjsModule | PyModule | TextModule | DataModule | JsonModule | WasmModule;

export interface ServiceStub {
  fetch(input: RequestInfo, init?: RequestInit): Promise<Response>;
}

/** The shared Worker Loader contract, including staged resident assemblies. */
export interface WorkerCode {
  compatibilityDate: string;
  compatibilityFlags?: string[];
  allowExperimental?: boolean;
  limits?: { cpuMs?: number; subRequests?: number };
  mainModule: string;
  modules: Record<string, ModuleContent>;
  env?: Record<string, unknown>;
  globalOutbound?: ServiceStub | null;
  tails?: ServiceStub[];
}
