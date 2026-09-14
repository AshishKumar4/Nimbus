import { CRED_SESSION_USER } from '../runtime/os-contracts.js';
import { SqliteRuntimeFsBridge } from '../runtime/sqlite-runtime-fs-bridge.js';
import { getSymlinkRegistry } from '../vfs/symlink-registry.js';
function stringArg(envelope, index) {
    const value = envelope.args?.[index];
    if (typeof value !== 'string') {
        throw new Error(`supervisor op ${envelope.op}: argument ${index} must be a string`);
    }
    return value;
}
function numberArg(envelope, index) {
    const value = envelope.args?.[index];
    if (typeof value !== 'number' || !Number.isFinite(value)) {
        throw new Error(`supervisor op ${envelope.op}: argument ${index} must be a number`);
    }
    return value;
}
function contentArg(envelope, index) {
    const value = envelope.args?.[index];
    if (typeof value === 'string' || value instanceof Uint8Array)
        return value;
    if (value instanceof ArrayBuffer)
        return new Uint8Array(value);
    throw new Error(`supervisor op ${envelope.op}: argument ${index} must be bytes or text`);
}
function credFor(deps, pid) {
    if (pid === undefined)
        return CRED_SESSION_USER;
    if (!Number.isInteger(pid) || pid <= 0) {
        throw new Error('supervisor op: filesystem operation requires a valid process pid');
    }
    return deps.processes ? deps.processes.cred(pid) : CRED_SESSION_USER;
}
/** One dispatch method lets any host serve its workspace to process facets. */
export function createSupervisorOpHandler(deps) {
    const bridges = new Map();
    const bridgeFor = (pid) => {
        const key = pid ?? 0;
        const credentialed = deps.vfs.as(credFor(deps, pid));
        const held = bridges.get(key);
        if (held) {
            held.updateCredential(credentialed);
            return held;
        }
        const built = new SqliteRuntimeFsBridge(credentialed, deps.vfs);
        bridges.set(key, built);
        return built;
    };
    const ops = {
        readFile: async (e) => {
            const bytes = await bridgeFor(e.pid).readFile(stringArg(e, 0));
            return bytes === null ? null : new TextDecoder().decode(bytes);
        },
        readFileBytes: (e) => bridgeFor(e.pid).readFile(stringArg(e, 0)),
        stat: (e) => bridgeFor(e.pid).stat(stringArg(e, 0)),
        lstat: (e) => bridgeFor(e.pid).stat(stringArg(e, 0), { followSymlinks: false }),
        exists: async (e) => (await bridgeFor(e.pid).stat(stringArg(e, 0))) !== null,
        readdir: (e) => bridgeFor(e.pid).readdir(stringArg(e, 0)),
        readlink: (e) => bridgeFor(e.pid).readlink(stringArg(e, 0)),
        fsReadRange: (e) => bridgeFor(e.pid).readRange(stringArg(e, 0), numberArg(e, 1), numberArg(e, 2)),
        fsReadRangeUncached: (e) => bridgeFor(e.pid).readRange(stringArg(e, 0), numberArg(e, 1), numberArg(e, 2), { cached: false }),
        fsRevision: (e) => bridgeFor(e.pid).revision(e.args?.[0] === undefined ? undefined : stringArg(e, 0)),
        hasLegacySymlinkUnder: (e) => getSymlinkRegistry(deps.vfs).hasAtOrBelow(stringArg(e, 0)),
        writeFile: (e) => bridgeFor(e.pid).writeFile(stringArg(e, 0), contentArg(e, 1)),
        mkdir: (e) => bridgeFor(e.pid).mkdir(stringArg(e, 0), { recursive: true }),
        rmdir: (e) => bridgeFor(e.pid).rmdir(stringArg(e, 0)),
        unlink: (e) => bridgeFor(e.pid).unlink(stringArg(e, 0)),
        rename: (e) => bridgeFor(e.pid).rename(stringArg(e, 0), stringArg(e, 1)),
        symlink: (e) => bridgeFor(e.pid).symlink(stringArg(e, 0), stringArg(e, 1)),
        chmod: (e) => bridgeFor(e.pid).chmod(stringArg(e, 0), numberArg(e, 1)),
        utimes: (e) => bridgeFor(e.pid).utimes(stringArg(e, 0), numberArg(e, 1), numberArg(e, 2)),
        fsTruncate: (e) => bridgeFor(e.pid).truncate(stringArg(e, 0), numberArg(e, 1)),
        writeBatchStream: (e) => {
            if (!e.stream)
                throw new Error('supervisor op writeBatchStream: no stream');
            return deps.vfs.as(credFor(deps, e.pid)).writeStream(e.stream, { mutationOwner: e.mutationOwner });
        },
        stdout: (e) => { deps.output?.('stdout', e.pid ?? 0, stringArg(e, 0)); },
        stderr: (e) => { deps.output?.('stderr', e.pid ?? 0, stringArg(e, 0)); },
    };
    const extend = deps.extend ?? {};
    return async (envelope) => {
        if (!envelope || typeof envelope.op !== 'string') {
            throw new Error('supervisor op: envelope names no operation');
        }
        const handler = Object.hasOwn(extend, envelope.op) ? extend[envelope.op]
            : Object.hasOwn(ops, envelope.op) ? ops[envelope.op] : undefined;
        if (!handler)
            throw new Error(`supervisor op: '${envelope.op}' is not served by this host`);
        return handler(envelope);
    };
}
