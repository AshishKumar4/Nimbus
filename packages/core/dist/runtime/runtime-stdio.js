import { stdinBytesOf } from '../shell/stdin-adapter.js';
import { textSink } from '../_shared/bytes.js';
/** A runtime's fd0/1/2, on the process supervisor's existing byte channels. */
export function openRuntimeStdio(deps, ctx, command, { consumedStdin = false } = {}) {
    const reserved = ctx.__nimbusBinSpawn;
    const owned = reserved?.callerPid === undefined;
    const entry = owned
        ? deps.processes.spawn(command, [command], ctx.cwd || '/home/user', { parentPid: ctx.pid, cred: ctx.cred })
        : deps.processes.get(reserved.callerPid);
    if (!entry || entry.state !== 'running')
        throw new Error(`${command}: runtime process is not running`);
    const pid = entry.pid;
    const controller = new AbortController();
    const abort = () => controller.abort(ctx.signal?.reason);
    if (ctx.signal?.aborted)
        abort();
    else
        ctx.signal?.addEventListener('abort', abort, { once: true });
    deps.processes.setTerminator(pid, () => controller.abort());
    // A broker already owns this input and routes its output to the parent's
    // pipes. Pumping or subscribing a second time would duplicate that path.
    const brokerIo = reserved?.liveInput === true;
    const input = !brokerIo && !consumedStdin && ctx.stdin
        ? deps.processes.pumpInput(pid, stdinBytesOf(ctx.stdin)) : null;
    if (!deps.processes.hasInput(pid)) {
        deps.processes.openInput(pid);
        deps.processes.endInput(pid);
    }
    const write = runtimeOutput(ctx);
    const unsubscribe = brokerIo ? null : deps.processes.subscribeOutputBytes(pid, ({ stream, data }) => write(stream, data));
    if (unsubscribe)
        deps.processes.setForeground(pid, true);
    return {
        pid,
        signal: controller.signal,
        syscalls: { pid, vfs: deps.filesystem.bind({ pid, cred: entry.cred }), processes: deps.processes },
        finish(exitCode) {
            ctx.signal?.removeEventListener('abort', abort);
            input?.stop();
            unsubscribe?.();
            if (unsubscribe)
                deps.processes.setForeground(pid, false);
            if (owned) {
                deps.processes.closeInput(pid);
                deps.processes.exit(pid, exitCode);
            }
        },
    };
}
/** A runtime's byte callback, including a text consumer's decoding edge. */
export function runtimeOutput(ctx) {
    const text = { stdout: textSink((data) => ctx.stdout.write(data)), stderr: textSink((data) => ctx.stderr.write(data)) };
    return (stream, bytes) => {
        const sink = stream === 'stdout' ? ctx.stdout : ctx.stderr;
        return sink.writeBytes ? sink.writeBytes(bytes) : text[stream](bytes);
    };
}
