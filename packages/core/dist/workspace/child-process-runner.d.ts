import { type ChildOrigin, type ChildRunner, type SpawnReq } from '../runtime/child-process-manager.js';
import type { NimbusWorkspace } from './nimbus-workspace.js';
/** Resolve with the child's authority, then run on its descriptors and process identity. */
export declare function resolveWorkspaceChild(workspace: NimbusWorkspace, request: SpawnReq, origin: ChildOrigin): Promise<ChildRunner | null>;
//# sourceMappingURL=child-process-runner.d.ts.map