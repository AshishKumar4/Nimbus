import { type ChildOrigin, type ChildRunner, type ChildRunnerContext, type SpawnRefusal, type SpawnReq } from '../runtime/child-process-manager.js';
import type { Command, CommandContext } from '../substrate/lifo/commands/types.js';
import type { NimbusWorkspace } from './nimbus-workspace.js';
/** Resolve with the child's authority, then run on its descriptors and process identity. */
export declare function resolveWorkspaceChild(workspace: NimbusWorkspace, request: SpawnReq, origin: ChildOrigin): Promise<ChildRunner | null>;
/** A child's isolated shell owns its work until all of its descriptors close. */
export declare function runChildShell(workspace: NimbusWorkspace, child: ChildRunnerContext, line: string): Promise<number>;
/** The platform may admit a launch, but descriptors, identity and lifecycle stay in core. */
export declare function runChildCommand(workspace: NimbusWorkspace, child: ChildRunnerContext, command: Command, invoke?: (context: CommandContext) => Promise<number | SpawnRefusal>): Promise<number | SpawnRefusal>;
//# sourceMappingURL=child-process-runner.d.ts.map