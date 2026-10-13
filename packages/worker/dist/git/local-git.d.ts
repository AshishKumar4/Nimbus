import type { CommandContext } from '@nimbus-sh/core/substrate/lifo/commands/types.js';
import type { ChildProcessManager } from '@nimbus-sh/core/runtime/child-process-manager.js';
import type { LocalGit } from './remote-helper.js';
/** Git's object and ref operations, as children of the remote helper on the session's byte pipes. */
export declare function createLocalGit(manager: ChildProcessManager, from: Pick<CommandContext, 'pid' | 'cwd' | 'env' | 'signal'>): LocalGit;
//# sourceMappingURL=local-git.d.ts.map