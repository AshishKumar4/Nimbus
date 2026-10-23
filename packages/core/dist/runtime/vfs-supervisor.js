import { disposeRpcResource } from '@nimbus-sh/platform/rpc-dispose.js';
import { FILESYSTEM_ANSWERED_RPC_METHODS, bridgeOverSupervisor } from './filesystem-mirrors.generated.js';
import { FILESYSTEM_METHODS, refusalData, supervisorRefusalError } from './filesystem-methods.js';
import { arrayCopy, Error, objectAssign, objectHasOwn, objectKeys, promiseResolve, Proxy, reflectGet, reflectSet, reflectSetPrototypeOf, SafeList, symbolFor } from '../_shared/primordials.js';
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
export const SUPERVISOR_ANSWERED_METHODS = (() => {
    const methods = new SafeList();
    for (let i = 0; i < FILESYSTEM_ANSWERED_RPC_METHODS.length; i++)
        methods[methods.length] = FILESYSTEM_ANSWERED_RPC_METHODS[i];
    for (let i = 0; i < NODE_SHIM_RPC_METHODS.length; i++)
        methods[methods.length] = NODE_SHIM_RPC_METHODS[i];
    return arrayCopy(methods);
})();
// A table that inherits nothing, made as the module loads: a guest's every
// supervisor call asks it, after its program may have replaced
// Set.prototype.has (or put a name on Object.prototype).
const ANSWERED = {};
reflectSetPrototypeOf(ANSWERED, null);
for (let i = 0; i < SUPERVISOR_ANSWERED_METHODS.length; i++) {
    const name = SUPERVISOR_ANSWERED_METHODS[i];
    ANSWERED[name] = true;
}
// The answered calls that wait on the session for as long as it likes (FILESYSTEM_METHODS `waits`).
const WAITS = {};
reflectSetPrototypeOf(WAITS, null);
{
    const names = objectKeys(FILESYSTEM_METHODS);
    for (let i = 0; i < names.length; i++) {
        const method = FILESYSTEM_METHODS[names[i]];
        if (objectHasOwn(method, 'waits'))
            WAITS[method.rpc] = true;
    }
}
export function isSupervisorAnsweredMethod(name) {
    return typeof name === 'string' && ANSWERED[name] === true;
}
/** The refusal `error` is, or undefined when it is not one (no string `code`) and must still throw. */
export function supervisorRefusal(error) {
    if (!(error instanceof Error) || typeof reflectGet(error, 'code') !== 'string')
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
/**
 * What answeringSupervisor's own carries: a supervisor already answering,
 * which a second pass hands back as it is. Registered, not made: the
 * launch's copy of this module and the store bundle's (vfs/resident) agree
 * on it, or the second would answer through the first's `answer` again.
 */
const ANSWERING = symbolFor('nimbus.answering-supervisor');
/** Only an RPC stub has `answer` (it has every name); a same-isolate supervisor (vfsSupervisor) has none of it, nor has one already answering. */
function isAnsweringStub(supervisor) {
    return reflectGet(supervisor, ANSWERING) !== true && typeof reflectGet(supervisor, 'answer') === 'function';
}
/**
 * `supervisor`, with its filesystem calls made through `answer` and each
 * refusal rethrown as the error it is; every other name is the stub's own.
 * A same-isolate supervisor is handed back as is: its refusals are thrown in
 * this isolate and cross nothing; so is one already answering, whoever wraps
 * it since (node's stop-replay ledger). The call's value is handed on and its
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
            if (name === ANSWERING)
                return true;
            if (!isSupervisorAnsweredMethod(name))
                return reflectGet(target, name);
            return async (...args) => {
                const asked = WAITS[name] === true ? stub.answer(name, args) : toldLive(stub.answer(name, args), live);
                const answer = await asked;
                try {
                    if (objectHasOwn(answer, 'refusal'))
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
    reflectSet(globalThis, '__nimbusAnsweringSupervisor', answeringSupervisor);
}
/**
 * Remote facets use the same typed supervisor RPC methods. A synchronous view
 * is a same-isolate capability: an RPC stub answers every property with a
 * callable, so it is never read from the stub, only carried by a local
 * supervisor whose view really is in this isolate. A remote supervisor's
 * refusals arrive as answers (answeringSupervisor), each call told to
 * `live` as it is made.
 */
export function supervisorFilesystem(remote, local, live) {
    return bridgeOverSupervisor(answeringSupervisor(remote, live), {
        synchronous: local,
        // An iterable does not cross RPC. A program with a large file to write
        // sends it as a W7 stream (writeStream), which does.
        writeFileFrom: async (path) => {
            const name = typeof path === 'string' ? path : path.path;
            throw objectAssign(new Error(`ENOTSUP: a streamed whole-file write is a host operation, write '${name}' as a W7 stream`), { code: 'ENOTSUP' });
        },
    });
}
/**
 * `call`, told to `live` as work in flight, as a promise of this realm: an
 * RPC stub's answer is a thenable of its own class, which a tracker that
 * follows promises (node's __nimbusTrackOp) cannot follow.
 */
function toldLive(call, live) {
    const native = promiseResolve(call);
    live?.(native);
    return native;
}
/**
 * The session a process's filesystem client sends its waves to and takes its
 * grants from, over `stub`: waves on the stub, grants through `authority`
 * (supervisorFilesystem over the same stub). Each wave call is told to `live`
 * as it is made, as the authority tells its own.
 */
export function supervisorSession(stub, authority, live, holdsGrants = true) {
    const waves = stub;
    const grants = {
        acquire: async (path, delegate) => await authority.acquireExclusiveMutation(path, { delegate }),
        release: async (owner) => { await authority.releaseExclusiveMutation(owner); },
        awaitRecall: async (owner, waitMs) => await authority.awaitRecall(owner, waitMs),
        recalled: async (owner, kind) => { await authority.recalled(owner, kind); },
    };
    return {
        // Called as methods of the stub, never through .call/.apply: on an RPC stub those are remote method names too.
        openWriter: (first) => toldLive(waves.openWaveWriter(first), live),
        writeBatchStream: (stream, fence, owner) => toldLive(owner === undefined ? waves.writeBatchStream(stream, fence) : waves.writeBatchStream(stream, fence, owner), live),
        retireWriter: async (writer) => { await toldLive(waves.retireWaveWriter(writer), live); },
        published: async (escape) => { await toldLive(escape ? waves.fsPublished({ escape: true }) : waves.fsPublished(), live); },
        // A process that cannot answer a recall (holdsGrants false) holds none: the session decides each of its changes.
        ...(holdsGrants ? { grants } : {}),
    };
}
