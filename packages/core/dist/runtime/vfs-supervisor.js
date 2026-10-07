import { disposeRpcResource } from '@nimbus-sh/platform/rpc-dispose.js';
import { FILESYSTEM_ANSWERED_RPC_METHODS, bridgeOverSupervisor } from './filesystem-mirrors.generated.js';
// The method table (filesystem-methods.ts) and the typed mirrors core's
// build writes from it (filesystem-mirrors.generated.ts).
export { FILESYSTEM_RPC_METHODS, vfsSupervisor } from './filesystem-mirrors.generated.js';
// ── Refusals as answers ─────────────────────────────────────────────────
//
// A filesystem call the host refuses (ENOENT, ENOTDIR, EEXIST: an error with a
// code) is an answer, as bytes are. Thrown from SupervisorRPC, it crossed the
// entrypoint as an exception, and the platform recorded every such invocation
// with outcome "exception" and "The Workers runtime canceled this request
// because it detected that your Worker's code had hung" although its caller
// was answered at once (Kinu, 2026-10-02: 6 of 6 refused stats; the answered
// ones "canceled"). So a facet calls the filesystem through SupervisorRPC's
// `answer(method, args)`, which returns a refusal as a value, and rethrows it
// here as the error the throw would have delivered. Anything without a code
// (a dropped connection, a bug) still throws.
/** The calls node's shims make that the bridge does not name. */
const NODE_SHIM_RPC_METHODS = [
    'readFile', 'writeFileStat', 'lstat', 'exists', 'hasLegacySymlinkUnder', 'setUmask', 'fsAcquired',
    'fsStorageGrant', 'fsReadRangeUncached', 'fsReadBatch',
];
export const SUPERVISOR_ANSWERED_METHODS = [
    ...FILESYSTEM_ANSWERED_RPC_METHODS,
    ...NODE_SHIM_RPC_METHODS,
];
const ANSWERED = new Set(SUPERVISOR_ANSWERED_METHODS);
export function isSupervisorAnsweredMethod(name) {
    return typeof name === 'string' && ANSWERED.has(name);
}
/** The refusal `error` is, or undefined when it is not one (no string `code`) and must still throw. */
export function supervisorRefusal(error) {
    if (!(error instanceof Error) || typeof Reflect.get(error, 'code') !== 'string')
        return undefined;
    return errorData(error);
}
function errorData(error) {
    const properties = {};
    const errors = {};
    for (const key of Object.getOwnPropertyNames(error)) {
        if (key === 'message' || key === 'stack')
            continue;
        const value = Reflect.get(error, key);
        if (value instanceof Error)
            errors[key] = errorData(value);
        else
            properties[key] = value;
    }
    return { name: error.name, message: error.message, properties, errors };
}
/**
 * `call`'s outcome as `answer` resolves it: its value, or its refusal. A
 * failure without a code is thrown. SupervisorRPC.answer runs its method
 * through this, and so does any double of it.
 */
export async function supervisorAnswer(call) {
    try {
        return { value: await call() };
    }
    catch (error) {
        const refusal = supervisorRefusal(error);
        if (refusal === undefined)
            throw error;
        return { refusal };
    }
}
/** Standard constructors the receiver of a thrown error rebuilds it with; any other is an Error bearing its name. */
const STANDARD_ERRORS = {
    EvalError, RangeError, ReferenceError, SyntaxError, TypeError, URIError,
};
/**
 * The error `refusal` was, as the facet received it when SupervisorRPC threw
 * it: a new error of the thrower's type, its message, its own properties, and
 * no stack of the thrower's (src/workerd/jsg/ser.c++, with
 * preserveStackInErrors off).
 */
export function supervisorRefusalError(refusal) {
    const Standard = Object.hasOwn(STANDARD_ERRORS, refusal.name) ? STANDARD_ERRORS[refusal.name] : undefined;
    const error = new (Standard ?? Error)(refusal.message);
    if (!Standard && refusal.name !== 'Error') {
        Object.defineProperty(error, 'name', { value: refusal.name, configurable: true, writable: true });
    }
    for (const [key, value] of Object.entries(refusal.properties)) {
        Object.defineProperty(error, key, { value, configurable: true, enumerable: true, writable: true });
    }
    for (const [key, value] of Object.entries(refusal.errors)) {
        Object.defineProperty(error, key, { value: supervisorRefusalError(value), configurable: true, enumerable: true, writable: true });
    }
    return error;
}
/** Only an RPC stub has `answer` (it has every name); a same-isolate supervisor (vfsSupervisor) has none of it. */
function isAnsweringStub(supervisor) {
    return typeof Reflect.get(supervisor, 'answer') === 'function';
}
/**
 * `supervisor`, with its filesystem calls made through `answer` and each
 * refusal rethrown as the error it is; every other name is the stub's own.
 * A same-isolate supervisor is handed back as is: its refusals are thrown in
 * this isolate and cross nothing. The call's value is handed on and its
 * envelope released.
 */
export function answeringSupervisor(supervisor) {
    if (!isAnsweringStub(supervisor))
        return supervisor;
    const stub = supervisor;
    return new Proxy(supervisor, {
        get(target, name) {
            if (!isSupervisorAnsweredMethod(name))
                return Reflect.get(target, name);
            return async (...args) => {
                const answer = await stub.answer(name, args);
                try {
                    if ('refusal' in answer)
                        throw supervisorRefusalError(answer.refusal);
                    return answer.value;
                }
                finally {
                    disposeRpcResource(answer);
                }
            };
        },
    });
}
/**
 * Installs {@link answeringSupervisor} as `globalThis.__nimbusAnsweringSupervisor`,
 * for the facet bodies that are generated text and take it spliced in
 * (SUPERVISOR_ANSWERING_SRC).
 */
export function installAnsweringSupervisor() {
    Reflect.set(globalThis, '__nimbusAnsweringSupervisor', answeringSupervisor);
}
/**
 * Remote facets use the same typed supervisor RPC methods. A synchronous view
 * is a same-isolate capability: an RPC stub answers every property with a
 * callable, so it is never read from the stub, only carried by a local
 * supervisor whose view really is in this isolate. A remote supervisor's
 * refusals arrive as answers (answeringSupervisor).
 */
export function supervisorFilesystem(remote, local) {
    return bridgeOverSupervisor(answeringSupervisor(remote), {
        synchronous: local,
        // An iterable does not cross RPC. A program with a large file to write
        // sends it as a W7 stream (writeStream), which does.
        writeFileFrom: async (path) => {
            const name = typeof path === 'string' ? path : path.path;
            throw Object.assign(new Error(`ENOTSUP: a streamed whole-file write is a host operation, write '${name}' as a W7 stream`), { code: 'ENOTSUP' });
        },
    });
}
