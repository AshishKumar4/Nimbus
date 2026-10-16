import { errorText } from '../_shared/error-text.js';
import { ProcessView, X_OK } from '../runtime/process-files.js';
import { shellChildRunner, textBytes, type ChildOrigin, type ChildRunner, type ChildRunnerContext, type SpawnRefusal, type SpawnReq } from '../runtime/child-process-manager.js';
import { resolveChildCommand } from '../shell/exec-dispatch.js';
import { resolveContext } from '../substrate/lifo/commands/registry.js';
import type { Command, CommandContext } from '../substrate/lifo/commands/types.js';
import { KILLED_BY_SIGPIPE } from '../substrate/lifo/shell/signals.js';
import { isBrokenPipe } from '../substrate/lifo/utils/bytes-io.js';
import type { NimbusWorkspace } from './nimbus-workspace.js';

/** Resolve with the child's authority, then run on its descriptors and process identity. */
export async function resolveWorkspaceChild(
  workspace: NimbusWorkspace,
  request: SpawnReq,
  origin: ChildOrigin,
): Promise<ChildRunner | null> {
  const processes = workspace.processes;
  const view = new ProcessView(workspace.filesystem.bind({ pid: origin.pid, cred: processes.cred(origin.pid) }));
  const shellRunner = shellChildRunner(request, view, (context, line) => runChildShell(workspace, context, line));
  if (shellRunner) return shellRunner;

  if (request.command.includes('/')) {
    await view.access(request.command.startsWith('/') ? request.command : `${origin.cwd}/${request.command}`, X_OK);
  }
  const command = await resolveChildCommand(workspace.registry, request.command, resolveContext(origin.cwd, origin.env, view), view);
  if (!command) return null;
  return { run: context => runChildCommand(workspace, context, command) };
}

/** A child's isolated shell owns its work until all of its descriptors close. */
export async function runChildShell(workspace: NimbusWorkspace, child: ChildRunnerContext, line: string): Promise<number> {
  const shell = workspace.shellFor(child.pid, { cwd: child.cwd, env: child.env });
  const stop = new AbortController();
  const stopped = workspace.processes.holdWork(child.pid, reason => stop.abort(reason));
  try {
    const result = await shell.execute(line, { stdin: child.stdin,
      onStdout: child.output.onStdout, onStderr: child.output.onStderr, signal: stop.signal });
    return typeof result.exitCode === 'number' ? result.exitCode : 0;
  } finally {
    try { await shell.closeDescriptors(); } finally { stopped(); }
  }
}

/** The platform may admit a launch, but descriptors, identity and lifecycle stay in core. */
export async function runChildCommand(
  workspace: NimbusWorkspace,
  child: ChildRunnerContext,
  command: Command,
  invoke?: (context: CommandContext) => Promise<number | SpawnRefusal>,
): Promise<number | SpawnRefusal> {
  const processes = workspace.processes;
  const stop = new AbortController();
  const stopped = processes.holdWork(child.pid, reason => stop.abort(reason));
  const cred = processes.cred(child.pid);
  const runAs = workspace.shell.getRunAsHost();
  const ctx: CommandContext & {
    __nimbusCaptureOutput: boolean;
    __nimbusBinSpawn: { callerPid: number; command: string; liveInput: boolean };
  } = {
    pid: child.pid, cred, args: child.args, cwd: child.cwd, env: child.env,
    vfs: new ProcessView(workspace.filesystem.bind({ pid: child.pid, cred })), stdin: child.stdin, signal: stop.signal,
    stdout: { write: text => child.output.onStdout(textBytes(String(text))), writeBytes: child.output.onStdout },
    stderr: { write: text => child.output.onStderr(textBytes(String(text))), writeBytes: child.output.onStderr },
    isFdTerminal: () => false,
    setUmask: mask => { processes.setUmask(child.pid, mask); },
    runAs: (target, argv, options) => {
      if (!runAs) throw new Error('Nimbus: workspace has no credential-transition host');
      return runAs(options?.parent ?? ctx, target, argv);
    },
    __nimbusCaptureOutput: false,
    __nimbusBinSpawn: { callerPid: child.pid, command: [child.command, ...child.args].join(' '), liveInput: true },
  };
  try {
    if (invoke) return await invoke(ctx);
    child.onStarted();
    const code = await command(ctx);
    return typeof code === 'number' ? code : 0;
  } catch (error) {
    if (isBrokenPipe(error)) return KILLED_BY_SIGPIPE.status;
    await child.output.onStderr(textBytes(`${child.command}: ${errorText(error)}\n`));
    return 1;
  } finally {
    stopped();
  }
}
