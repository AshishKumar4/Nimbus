import type { Command } from '../types.js';
import type { ProcessRegistry } from '../../shell/ProcessRegistry.js';
import type { JobTable } from '../../shell/jobs.js';
export declare function createPsCommand(processRegistry: ProcessRegistry): Command;
export declare function createPsCommandFromJobTable(jobTable: JobTable): Command;
//# sourceMappingURL=ps.d.ts.map