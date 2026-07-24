import type { FacetManager } from '../facets/manager.js';
import type { WebSocketTerminal } from '../facets/ws-terminal.js';
import type { SqliteVFS } from '../vfs/sqlite-vfs.js';
import type { Shell } from '../substrate/lifo/shell/Shell.js';
import type { VfsCred } from './os-contracts.js';
import type { RuntimeManifest } from './runtime-catalog.js';
export interface BashReplDeps {
    facetMgr: FacetManager;
    vfs: SqliteVFS;
    terminal: WebSocketTerminal;
    installRoot: string;
    manifest: RuntimeManifest;
    cred: VfsCred;
    env: Record<string, string>;
    cwd: string;
    shell?: Pick<Shell, 'env' | 'cwd'>;
}
export declare function runBashRepl(deps: BashReplDeps): Promise<number>;
//# sourceMappingURL=bash-repl.d.ts.map