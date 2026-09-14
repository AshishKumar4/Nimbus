import type { SupervisorOpEnvelope } from '@nimbus-sh/core/workspace/supervisor-op.js';
import type { NimbusSession } from './nimbus-session.js';
/** Preserve hosted accounting and lifecycle work behind the shared host seam. */
export declare function sessionSupervisorOp(host: NimbusSession, envelope: SupervisorOpEnvelope): Promise<unknown>;
//# sourceMappingURL=supervisor-op.d.ts.map