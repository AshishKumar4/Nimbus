import type { Command } from '../types.js';
import type { SessionProcessSupervisor } from '../../../../runtime/session-process-supervisor.js';
/** `ps` over the session's process table, as its observers are told it; an ended process not yet reaped is `<defunct>`. */
export declare function createPsCommand(processes: Pick<SessionProcessSupervisor, 'publishedAll'>): Command;
//# sourceMappingURL=ps.d.ts.map