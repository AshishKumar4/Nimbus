// Types for the Cloudflare Worker Loader API (closed beta).
// Not yet in @cloudflare/workers-types. Remove this file when they ship.
// https://developers.cloudflare.com/workers/runtime-apis/bindings/worker-loader/

export interface JsModule { js: string }
export interface CjsModule { cjs: string }
export interface PyModule { py: string }
export interface TextModule { text: string }
export interface DataModule { data: ArrayBuffer }
export interface JsonModule { json: unknown }

/** Plain string = type inferred from file extension (.js or .py). */
export type ModuleContent =
  | string
  | JsModule
  | CjsModule
  | PyModule
  | TextModule
  | DataModule
  | JsonModule;

export interface WorkerCode {
  compatibilityDate: string;
  compatibilityFlags?: string[];
  allowExperimental?: boolean;
  mainModule: string;
  modules: Record<string, ModuleContent>;
  env?: Record<string, unknown>;

  /**
   * Network access control:
   * - `undefined`: inherit parent's network access.
   * - `null`: block all outbound (fetch/connect throw).
   * - A service stub: redirect outbound through that binding.
   */
  globalOutbound?: ServiceStub | null;
  tails?: ServiceStub[];
}

export interface ServiceStub {
  fetch(input: RequestInfo, init?: RequestInit): Promise<Response>;
}

export interface EntrypointOptions {
  props?: Record<string, unknown>;
}

export interface WorkerStub {
  getEntrypoint(): EntrypointStub;
  getEntrypoint(name: string, opts?: EntrypointOptions): EntrypointStub;
}

export interface EntrypointStub {
  fetch(input: RequestInfo, init?: RequestInit): Promise<Response>;
  execute(...args: unknown[]): Promise<unknown>;
}

export type GetCodeCallback = () => Promise<WorkerCode>;

export interface WorkerLoader {
  /**
   * Load or reuse an isolate by ID. Same ID + same code may reuse an isolate;
   * different IDs always get fresh isolates. `getCodeCallback` must return
   * the same content for the same ID.
   */
  get(id: string, getCodeCallback: GetCodeCallback): WorkerStub;
}
