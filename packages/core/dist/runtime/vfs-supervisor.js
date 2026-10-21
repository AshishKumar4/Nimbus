import { disposeRpcResource } from '@nimbus-sh/platform/rpc-dispose.js';
import { FILESYSTEM_ANSWERED_RPC_METHODS, bridgeOverSupervisor } from './filesystem-mirrors.generated.js';
import { FILESYSTEM_METHODS, refusalData, supervisorRefusalError } from './filesystem-methods.js';
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
    'readFile', 'writeFileStat', 'lstat', 'exists', 'setUmask', 'fsAcquired',
    'fsStorageGrant', 'fsReadRangeUncached', 'fsReadBatch', 'fsListTree',
    'fsReadDirectories',
];
export const SUPERVISOR_ANSWERED_METHODS = [
    ...FILESYSTEM_ANSWERED_RPC_METHODS,
    ...NODE_SHIM_RPC_METHODS,
];
// A table that inherits nothing, made as the module loads: a guest's every
// supervisor call asks it, after its program may have replaced
// Set.prototype.has (or put a name on Object.prototype).
const ANSWERED = {};
Reflect.setPrototypeOf(ANSWERED, null);
for (const name of SUPERVISOR_ANSWERED_METHODS)
    ANSWERED[name] = true;
// The answered calls that wait on the session for as long as it likes (FILESYSTEM_METHODS `waits`).
const WAITS = {};
Reflect.setPrototypeOf(WAITS, null);
for (const method of Object.values(FILESYSTEM_METHODS))
    if ('waits' in method)
        WAITS[method.rpc] = true;
export function isSupervisorAnsweredMethod(name) {
    return typeof name === 'string' && ANSWERED[name] === true;
}
/** The refusal `error` is, or undefined when it is not one (no string `code`) and must still throw. */
export function supervisorRefusal(error) {
    if (!(error instanceof Error) || typeof Reflect.get(error, 'code') !== 'string')
        return undefined;
    return refusalData(error);
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
async function answerOf(stub, name, args) {
    return await stub.answer(name, args);
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
 *
 * `live` is told of each filesystem call as it is made, with the call in
 * flight: a program's liveness counts it as work it waits on, whoever made
 * it, its own fs or the filesystem that answers for it (a store's fills,
 * listings and grants), until the session answers. A call that waits on the
 * session for as long as it likes is not told: a grant's recall poll (the
 * table's `waits`); stdin and a socket's poll are not filesystem calls.
 */
export function answeringSupervisor(supervisor, live) {
    if (!isAnsweringStub(supervisor))
        return supervisor;
    const stub = supervisor;
    return new Proxy(supervisor, {
        get(target, name) {
            if (!isSupervisorAnsweredMethod(name))
                return Reflect.get(target, name);
            return async (...args) => {
                // A promise of this realm's own: an RPC stub's answer is a thenable of its own class.
                const asked = answerOf(stub, name, args);
                if (live !== undefined && WAITS[name] !== true)
                    live(asked);
                const answer = await asked;
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
