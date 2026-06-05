export { WorkerPool } from './pool.js';
export { pure, isPure, constant } from './primitives.js';
export { serializeFunction, hashSource } from './serialize.js';
export { generateWorkerSource, buildWorkerCode } from './codegen.js';
export { ParallelError, SerializationError, ExecutionError, TimeoutError, RetryExhaustedError, BindingError, } from './errors.js';
import { WorkerPool } from './pool.js';
export const Parallel = {
    pool(loader, opts) {
        return new WorkerPool(loader, opts);
    },
};
