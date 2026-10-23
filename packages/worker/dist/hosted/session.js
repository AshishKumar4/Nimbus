/**
 * The SDK's session surface, served by a hosted runtime.
 *
 * `Nimbus.fromSession` drives a `NimbusSandbox` over any object with the
 * `_rpc*` methods a `NimbusSession` Durable Object answers. A hosted runtime
 * has no such object of its own: its embedder's Durable Object owns it. So the
 * runtime hands out this `RpcTarget`, and the embedder passes it wherever a
 * sandbox client runs — another isolate included, since an `RpcTarget`
 * crosses RPC as a stub whose calls run here.
 *
 * A session may be scoped. A scope confines two things: the one named shell
 * its commands run in, and the identity every command and file operation
 * runs as. The stub is the capability, so a caller that names another shell
 * or identity is refused rather than obeyed; a scope that names no shell
 * runs no command, since the only shell left to it is the embedder's own.
 * The workspace's destruction stays with the embedder. Processes, ports,
 * logs and applications are not confined: they are workspace-wide, as they
 * are to the shell's own `ps`, `kill`, `logs` and `nimbus expose`/`app`.
 */
import { RpcTarget } from 'cloudflare:workers';
import { CRED_SESSION_USER, sameCred } from '@nimbus-sh/core/runtime/os-contracts.js';
import { encodeExecStream } from '@nimbus-sh/core/runtime/exec-stream.js';
import * as rpc from '../session/rpc.js';
import * as operations from '../session/programmatic.js';
export class HostedSession extends RpcTarget {
    owner;
    scope;
    constructor(owner, scope) {
        super();
        this.owner = owner;
        const { shellId, cred } = scope;
        this.scope = shellId === undefined && cred === undefined ? null : Object.freeze({ shellId, cred });
    }
    // The helpers below are `#private`: every string-named method of an
    // RpcTarget is callable by whoever holds its stub, and a scoped client
    // must reach neither the runtime it serves nor another identity.
    /** Every call is a client's, as every `composeHostedRuntime` call is: it notes activity for the resident keep-alive. */
    #client() {
        this.owner.noteClientActivity();
        return this.owner;
    }
    /**
     * The identity a call acts as. A scoped session always names one: its own,
     * or the session user every command runs as by default, so no verb's own
     * default applies to it.
     */
    #cred(asked) {
        if (this.scope === null)
            return asked;
        const bound = this.scope.cred ?? CRED_SESSION_USER;
        if (asked !== undefined && !sameCred(bound, asked))
            throw Object.assign(new Error('EPERM: this session is bound to another identity'), { code: 'EPERM' });
        return bound;
    }
    #exec(options) {
        if (this.scope !== null && (this.scope.shellId === undefined || options?.shellId !== this.scope.shellId)) {
            // Named, never defaulted: a client that omits the shell also sends a cwd
            // for the session's one shell, which would pin the named shell's cwd.
            // A scope without a shell would run on the embedder's workspace shell,
            // reading and planting its environment, so it runs nothing.
            throw new Error(this.scope.shellId === undefined
                ? 'EPERM: this session names no shell, so it runs no command'
                : `EPERM: this session runs commands only in shell '${this.scope.shellId}'; name it`);
        }
        const cred = this.#cred(options?.cred);
        return { ...options, ...(cred === undefined ? {} : { cred }) };
    }
    _rpcReady(options) { return operations.ensureProgrammaticReady(this.#client(), options); }
    async _rpcExecStream(command, options) {
        return encodeExecStream(await operations.rpcExecStream(this.#client(), command, this.#exec(options)));
    }
    async _rpcStartProcess(command, options) {
        return operations.rpcStartProcess(this.#client(), command, this.#exec(options));
    }
    async _rpcDetachExec(detachId) {
        if (this.scope !== null && this.scope.shellId === undefined)
            return { detached: false };
        return operations.rpcDetachExec(this.#client(), detachId, this.scope?.shellId);
    }
    async _rpcRunCode(code, options) { return operations.rpcRunCode(this.#client(), code, this.#exec(options)); }
    // A runner runs in no shell: a scoped session's runs as its identity.
    async _rpcRunnerRun(id, code, runner, options) {
        const cred = this.#cred(runner?.cred);
        return operations.rpcRunnerRun(this.#client(), id, code, { ...runner, ...(cred === undefined ? {} : { cred }) }, options);
    }
    async _rpcRunnerClose(id) { return operations.rpcRunnerClose(this.#client(), id); }
    // The file methods keep the session's wire shape: the third slot is a
    // process claim no SDK caller makes, and is not accepted here either.
    async _rpcReadFile(path, _pid, cred) {
        return rpc._rpcReadFile(this.#client(), path, undefined, this.#cred(cred));
    }
    async _rpcReadFileBytes(path, _pid, cred) {
        return rpc._rpcReadFileBytes(this.#client(), path, undefined, this.#cred(cred));
    }
    async _rpcWriteFile(path, content, _pid, cred) {
        return rpc._rpcWriteFile(this.#client(), path, content, undefined, this.#cred(cred));
    }
    async _rpcStat(path, _pid, cred) { return rpc._rpcStat(this.#client(), path, undefined, this.#cred(cred)); }
    async _rpcLstat(path, _pid, cred) { return rpc._rpcLstat(this.#client(), path, undefined, this.#cred(cred)); }
    async _rpcReadlink(path, _pid, cred) { return rpc._rpcReadlink(this.#client(), path, undefined, this.#cred(cred)); }
    async _rpcReaddir(path, _pid, cred) { return rpc._rpcReaddir(this.#client(), path, undefined, this.#cred(cred)); }
    async _rpcRename(from, to, _pid, cred) {
        return rpc._rpcRename(this.#client(), from, to, undefined, this.#cred(cred));
    }
    async _rpcChmod(path, mode, _pid, cred) {
        return rpc._rpcChmod(this.#client(), path, mode, undefined, this.#cred(cred));
    }
    async _rpcFsReadRange(path, offset, length, _pid, cred) {
        return rpc._rpcFsReadRange(this.#client(), path, offset, length, undefined, this.#cred(cred));
    }
    async _rpcExists(path, _pid, cred) { return rpc._rpcExists(this.#client(), path, undefined, this.#cred(cred)); }
    async _rpcMkdir(path, _pid, cred, options) { return rpc._rpcMkdir(this.#client(), path, undefined, this.#cred(cred), options); }
    async _rpcUnlink(path, _pid, cred) { return rpc._rpcUnlink(this.#client(), path, undefined, this.#cred(cred)); }
    async _rpcRmdir(path, _pid, cred) { return rpc._rpcRmdir(this.#client(), path, undefined, this.#cred(cred)); }
    async _rpcAppendFile(path, content, _pid, cred) {
        return rpc._rpcAppendFile(this.#client(), path, content, undefined, this.#cred(cred));
    }
    async _rpcSymlink(target, path, _pid, cred) { return rpc._rpcSymlink(this.#client(), target, path, undefined, this.#cred(cred)); }
    async _rpcRealpath(path, _pid, cred) { return rpc._rpcRealpath(this.#client(), path, undefined, this.#cred(cred)); }
    async _rpcTruncate(path, size, _pid, cred) { return rpc._rpcTruncate(this.#client(), path, size, undefined, this.#cred(cred)); }
    async _rpcUtimes(path, atime, mtime, _pid, cred, options) {
        return rpc._rpcUtimes(this.#client(), path, atime, mtime, undefined, this.#cred(cred), options);
    }
    async _rpcChown(path, uid, gid, _pid, cred, options) {
        return rpc._rpcChown(this.#client(), path, uid, gid, undefined, this.#cred(cred), options);
    }
    async _rpcDeleteFile(path, options, cred) {
        return operations.rpcDeleteFile(this.#client(), path, options, this.#cred(cred));
    }
    _rpcInstallRuntime(spec, options) { return operations.rpcInstallRuntime(this.#client(), spec, options); }
    _rpcEnsureRuntimes(specs, options) { return operations.rpcEnsureRuntimes(this.#client(), specs, options); }
    _rpcListRuntimes() { return operations.rpcListRuntimes(this.#client()); }
    _rpcListProcesses() { return operations.rpcListProcesses(this.#client()); }
    _rpcKillProcess(pid) { return operations.rpcKillProcess(this.#client(), pid); }
    _rpcListTerminals() { return operations.rpcListTerminals(this.#client()); }
    _rpcCloseTerminal(name) { return operations.rpcCloseTerminal(this.#client(), name); }
    _rpcWriteProcessInput(pid, data) { return operations.rpcWriteProcessInput(this.#client(), pid, data); }
    // The remote API's byte write, for an embedder's router in front of its hosted runtime.
    _rpcWriteProcessInputStream(pid, data) { return operations.rpcWriteProcessInputStream(this.#client(), pid, data); }
    _rpcStartProgram(argv, options) {
        // A start names no shell and no identity: it would run as the workspace, from its shell's environment.
        if (this.scope !== null)
            throw new Error('EPERM: a scoped session starts no program by its argv');
        return operations.rpcStartProgram(this.#client(), argv, options);
    }
    _rpcEndProcessInput(pid) { return operations.rpcEndProcessInput(this.#client(), pid); }
    _rpcWaitProgram(pid, waitMs) {
        if (this.scope !== null)
            throw new Error('EPERM: a scoped session starts no program by its argv');
        return operations.rpcWaitProgram(this.#client(), pid, waitMs);
    }
    _rpcResizeProcess(pid, size) { return operations.rpcResizeProcess(this.#client(), pid, size); }
    _rpcSignalProcess(pid, signal) { return operations.rpcSignalProcess(this.#client(), pid, signal); }
    _rpcProcessLogs(pid, options) {
        return operations.rpcProcessLogs(this.#client(), pid, options);
    }
    _rpcListPorts() { return operations.rpcListPorts(this.#client()); }
    _rpcExposePort(port, options) { return operations.rpcExposePort(this.#client(), port, options); }
    _rpcUnexposePort(port) { return operations.rpcUnexposePort(this.#client(), port); }
    _rpcListApps() { return operations.rpcListApps(this.#client()); }
    _rpcExposeApp(target, options) { return operations.rpcExposeApp(this.#client(), target, options); }
    _rpcRotateLink(target) { return operations.rpcRotateLink(this.#client(), target); }
    _rpcRemoveApp(target) { return operations.rpcRemoveApp(this.#client(), target); }
    _rpcEnsureDurableApp(input) {
        return operations.rpcEnsureDurableApp(this.#client(), input);
    }
    _rpcRemoveDurableApp(owner) { return operations.rpcRemoveDurableApp(this.#client(), owner); }
    /** The embedder owns the workspace's life; a session it handed out cannot end it. */
    async _rpcDestroy() {
        throw Object.assign(new Error('EPERM: a hosted session cannot destroy the workspace; its embedder closes the runtime'), { code: 'EPERM' });
    }
}
