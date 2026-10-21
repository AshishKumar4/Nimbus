// Types for the Cloudflare Worker Loader API (closed beta).
// Not yet in @cloudflare/workers-types. Remove this file when they ship.
// https://developers.cloudflare.com/workers/runtime-apis/bindings/worker-loader/

import type { WorkerCode } from '@nimbus-sh/platform/worker-code.js';
export type { JsModule, CjsModule, PyModule, TextModule, DataModule, JsonModule, WasmModule, ModuleContent, WorkerCode, ServiceStub } from '@nimbus-sh/platform/worker-code.js';

export interface EntrypointOptions {
  props?: Record<string, unknown>;
  limits?: { cpuMs?: number; subRequests?: number };
}

export interface WorkerStub {
  getEntrypoint(name?: string, opts?: EntrypointOptions): EntrypointStub;
}

export interface EntrypointStub {
  fetch(input: RequestInfo, init?: RequestInit): Promise<Response>;
  execute(...args: unknown[]): Promise<unknown>;
  /** Loads the worker and runs nothing (IsolatePool.warm). */
  warm(): Promise<void>;
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
