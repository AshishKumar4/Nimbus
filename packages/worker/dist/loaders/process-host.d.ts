/**
 * process-host.ts — which substrate this deployment runs resident processes
 * on. The substrates themselves live in `@nimbus-sh/fabric/process-host.js`;
 * this module owns only the deployment config that picks between them.
 */
import { type ProcessHostMode } from '@nimbus-sh/fabric/process-host.js';
import type { ProcessHost, ResidentDiskReader } from '@nimbus-sh/fabric/process-fabric.js';
/**
 * The var that picks the substrate, and the only place its name appears.
 * Unset means `facet`; an unrecognized value is refused rather than defaulted,
 * because a typo that silently kept the old substrate would make an operator's
 * comparison a lie.
 */
export declare function processHostMode(env: unknown): ProcessHostMode;
/** The substrate for this deployment, resolved once. */
export declare function processHostFor(ctx: DurableObjectState, env: unknown, disk: () => ResidentDiskReader): ProcessHost;
//# sourceMappingURL=process-host.d.ts.map