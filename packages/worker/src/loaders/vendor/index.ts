export { WorkerPool } from './pool.js';
export type {
  PoolOptions,
  MapOptions,
  PmapOptions,
  SubmitOptions,
  StreamOptions,
  StreamResult,
  ScatterOptions,
  ResilienceOptions,
  OnErrorStrategy,
} from './pool.js';

export { pure, isPure, constant } from './primitives.js';
export type { Pure } from './primitives.js';

export { serializeFunction, hashSource } from './serialize.js';

export { generateWorkerSource, buildWorkerCode } from './codegen.js';
export type { WorkerCodeOptions, GenerateSourceOptions } from './codegen.js';

export {
  ParallelError,
  SerializationError,
  ExecutionError,
  TimeoutError,
  RetryExhaustedError,
  BindingError,
} from './errors.js';

export type {
  WorkerLoader,
  WorkerCode,
  WorkerStub,
  EntrypointStub,
  EntrypointOptions,
  GetCodeCallback,
  ServiceStub,
  ModuleContent,
} from './types.js';

import { WorkerPool } from './pool.js';
import type { PoolOptions } from './pool.js';
import type { WorkerLoader } from './types.js';

export const Parallel = {
  pool(loader: WorkerLoader, opts?: PoolOptions): WorkerPool {
    return new WorkerPool(loader, opts);
  },
} as const;
