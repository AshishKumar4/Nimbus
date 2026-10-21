import { errorText } from '../_shared/error-text.js';
import { ProcessView, X_OK } from '../runtime/process-files.js';
import { normalizeChildCommand, shellChildRunner, textBytes, type ChildOrigin, type ChildRunner, type ChildRunnerContext, type SpawnRefusal, type SpawnReq } from '../runtime/child-process-manager.js';
import { resolveChildCommand } from '../shell/exec-dispatch.js';
import { resolveContext } from '../substrate/lifo/commands/registry.js';
import type { Command, CommandContext } from '../substrate/lifo/commands/types.js';
import { KILLED_BY_SIGPIPE } from '../substrate/lifo/shell/signals.js';
import { isBrokenPipe } from '../substrate/lifo/utils/bytes-io.js';
import type { NimbusWorkspace } from './nimbus-workspace.js';
import { ProgramRefusal, runDelegatedProgram } from '../runtime/delegated-program.js';
import type { ExitStatus, ProgramPlacement, StartedProgram } from '../runtime/program-start.js';
import { ProcessSignalNameSchema } from '../runtime/process-io-protocol.js';
import { errnoOf } from '../vfs/vfs-error.js';

/** Resolve with the child's authority, then run on its descriptors and process identity. */
export async function resolveWorkspaceChild(
  workspace: NimbusWorkspace,
  request: SpawnReq,
  origin: ChildOrigin,
): Promise<ChildRunner | null> {
  const processes = workspace.processes;
  const delegating = delegatedChildRunner(workspace, request, origin);
  const delegated = delegating instanceof Promise ? await delegating : delegating;
  if (delegated) return delegated;
  const view = new ProcessView(workspace.filesystem.bind({ pid: origin.pid, cred: processes.cred(origin.pid) }));
  const shellRunner = shellChildRunner(request, view, (context, line) => runChildShell(workspace, context, line));
  if (shellRunner) return shellRunner;

  const name = normalizeChildCommand(request.command);
  if (name.includes('/')) {
    await view.access(name.startsWith('/') ? name : `${origin.cwd}/${name}`, X_OK);
  }
  const command = await resolveChildCommand(workspace.registry, name, resolveContext(origin.cwd, origin.env, view), view);
  if (!command) return null;
  return { run: context => runChildCommand(workspace, context, command) };
}

/**
 * A node child whose cwd is under a delegating mount (Kinu ask 66), started
 * on the mount's machine as Node starts it: its file (as the program named
 * it) and args, or, with `shell`, `/bin/sh -c` its line (Node's own argv).
 * Null: it runs here; answered at once where no mount delegates. A start
 * the machine refuses is the child's `error` event with the machine's
 * code; an absent mount, EHOSTDOWN with nothing asked. The child takes its
 * catchable signals, each sent to the program, which ends as it decides;
 * SIGKILL ends it.
 */
export function delegatedChildRunner(workspace: NimbusWorkspace, request: SpawnReq, origin: ChildOrigin): ChildRunner | null | Promise<ChildRunner | null> {
  const placing = workspace.filesystem.placeProgram(workspace.processes.cred(origin.pid), origin.cwd);
  return placing instanceof Promise ? placing.then((placement) => delegatedRunner(workspace, request, placement)) : delegatedRunner(workspace, request, placing);
}

function delegatedRunner(workspace: NimbusWorkspace, request: SpawnReq, placement: ProgramPlacement): ChildRunner | null {
  if (placement.kind === 'local') return null;
  if (placement.kind === 'absent') return { run: async () => spawnRefusal('EHOSTDOWN') };
  const args = Array.isArray(request.args) ? request.args.map(String) : [];
  const argv = request.shell
    ? [typeof request.shell === 'string' ? request.shell : '/bin/sh', '-c', [request.command, ...args].join(' ')]
    : [request.command, ...args];
  return {
    async run(child): Promise<number | SpawnRefusal | ExitStatus> {
      const processes = workspace.processes;
      const stop = new AbortController();
      const relay = new AbortController();
      // Before its start a signal stops it (the delegate's cancel); once started, the program takes it.
      const stopped = processes.holdWork(child.pid, (reason) => { relay.abort(); stop.abort(reason); });
      let signals = (): void => {};
      try {
        return await runDelegatedProgram(
          placement.delegate,
          { argv, env: child.env, cwd: placement.cwd },
          { stdin: child.stdin, stdout: async (bytes) => child.output.onStdout(bytes), stderr: async (bytes) => child.output.onStderr(bytes) },
          stop.signal,
          (started) => {
            signals = processes.takeSignals(child.pid, PROGRAM_SIGNALS);
            child.onStarted();
            void relaySignals(processes, child.pid, started, relay.signal);
          },
        );
      } catch (error) {
        if (error instanceof ProgramRefusal) return spawnRefusal(error.code);
        throw error;
      } finally {
        relay.abort();
        signals();
        stopped();
      }
    },
  };
}

/** Every signal a program on another machine may take and decide on (SIGKILL is never taken: it ends it). */
const PROGRAM_SIGNALS = ProcessSignalNameSchema.options;

/**
 * The child's signals, as the broker delivers them (ChildProcessManager.kill),
 * sent to the started program until `until`, or until the child has ended
 * (no signal is taken for it any more).
 */
async function relaySignals(processes: NimbusWorkspace['processes'], pid: number, started: StartedProgram, until: AbortSignal): Promise<void> {
  while (!until.aborted) {
    const signal = await processes.nextSignal(pid, 5000);
    if (until.aborted) return;
    if (signal !== null) started.kill(signal);
    else if (processes.get(pid)?.state !== 'running') return;
  }
}

function spawnRefusal(code: string): SpawnRefusal {
  return { code, errno: errnoOf(code) ?? -5 };
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
