import type { Command } from '../types.js';
import type { SessionProcessSupervisor } from '../../../../runtime/session-process-supervisor.js';
/** `top` over the session's process table, as its observers are told it. Nothing in it stops a process. */
export declare function createTopCommand(processes: Pick<SessionProcessSupervisor, 'publishedAll'>): Command;
//# sourceMappingURL=top.d.ts.map