import { type ChildOrigin, type ChildRunner, type ChildRunnerContext, type SpawnRefusal, type SpawnReq } from '../runtime/child-process-manager.js';
import type { Command, CommandContext } from '../substrate/lifo/commands/types.js';
import type { NimbusWorkspace } from './nimbus-workspace.js';
/** Resolve with the child's authority, then run on its descriptors and process identity. */
export declare function resolveWorkspaceChild(workspace: NimbusWorkspace, request: SpawnReq, origin: ChildOrigin): Promise<ChildRunner | null>;
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
export declare function delegatedChildRunner(workspace: NimbusWorkspace, request: SpawnReq, origin: ChildOrigin): ChildRunner | null | Promise<ChildRunner | null>;
/** A child's isolated shell owns its work until all of its descriptors close. */
export declare function runChildShell(workspace: NimbusWorkspace, child: ChildRunnerContext, line: string): Promise<number>;
/** The platform may admit a launch, but descriptors, identity and lifecycle stay in core. */
export declare function runChildCommand(workspace: NimbusWorkspace, child: ChildRunnerContext, command: Command, invoke?: (context: CommandContext) => Promise<number | SpawnRefusal>): Promise<number | SpawnRefusal>;
//# sourceMappingURL=child-process-runner.d.ts.map