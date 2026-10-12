import { errorText } from '../_shared/error-text.js';
import { ProcessView, X_OK } from '../runtime/process-files.js';
import { shellChildRunner, textBytes } from '../runtime/child-process-manager.js';
import { resolutionOf } from '../shell/exec-dispatch.js';
import { resolveContext } from '../substrate/lifo/commands/registry.js';
import { KILLED_BY_SIGPIPE } from '../substrate/lifo/shell/signals.js';
import { isBrokenPipe } from '../substrate/lifo/utils/bytes-io.js';
/** Resolve with the child's authority, then run on its descriptors and process identity. */
export async function resolveWorkspaceChild(workspace, request, origin) {
    const processes = workspace.processes;
    const view = new ProcessView(workspace.filesystem.bind({ pid: origin.pid, cred: processes.cred(origin.pid) }));
    const shellRunner = shellChildRunner(request, view, async (context, commandLine) => {
        const shell = workspace.shellFor(context.pid, { cwd: context.cwd, env: context.env });
        const stop = new AbortController();
        const stopped = processes.holdWork(context.pid, reason => stop.abort(reason));
        try {
            const result = await shell.execute(commandLine, {
                stdin: context.stdin,
                onStdout: context.output.onStdout,
                onStderr: context.output.onStderr,
                signal: stop.signal,
            });
            return result.exitCode;
        }
        finally {
            try {
                await shell.closeDescriptors();
            }
            finally {
                stopped();
            }
        }
    });
    if (shellRunner)
        return shellRunner;
    if (request.command.includes('/')) {
        await view.access(request.command.startsWith('/') ? request.command : `${origin.cwd}/${request.command}`, X_OK);
    }
    const command = await workspace.registry.resolve(request.command, resolveContext(origin.cwd, origin.env, view));
    if (!command)
        return null;
    const resolution = resolutionOf(command);
    if (resolution?.kind === 'program')
        await view.access(resolution.path, X_OK);
    return {
        async run(context) {
            const stop = new AbortController();
            const stopped = processes.holdWork(context.pid, reason => stop.abort(reason));
            const cred = processes.cred(context.pid);
            const runAs = workspace.shell.getRunAsHost();
            const ctx = {
                pid: context.pid, cred, args: context.args, cwd: context.cwd, env: context.env,
                vfs: view, stdin: context.stdin, signal: stop.signal,
                stdout: { write: text => context.output.onStdout(textBytes(text)), writeBytes: context.output.onStdout },
                stderr: { write: text => context.output.onStderr(textBytes(text)), writeBytes: context.output.onStderr },
                isFdTerminal: () => false,
                setUmask: mask => { processes.setUmask(context.pid, mask); },
                runAs: (target, argv, options) => {
                    if (!runAs)
                        throw new Error('Nimbus: workspace has no credential-transition host');
                    return runAs(options?.parent ?? ctx, target, argv);
                },
                __nimbusCaptureOutput: false,
                __nimbusBinSpawn: { callerPid: context.pid, command: [context.command, ...context.args].join(' '), liveInput: true },
            };
            try {
                context.onStarted();
                return await command(ctx);
            }
            catch (error) {
                if (isBrokenPipe(error))
                    return KILLED_BY_SIGPIPE.status;
                await context.output.onStderr(textBytes(`${context.command}: ${errorText(error)}\n`));
                return 1;
            }
            finally {
                stopped();
            }
        },
    };
}
