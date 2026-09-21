import type { FacetManager } from '../facets/manager.js';
import type { WebSocketTerminal } from '../facets/ws-terminal.js';
import type { Shell } from '@nimbus-sh/core/substrate/lifo/shell/Shell.js';
import { type VfsCred, type RuntimeFsBridge, type NimbusFilesystemAuthority } from '@nimbus-sh/core/runtime/os-contracts.js';
import type { RuntimeManifest } from '@nimbus-sh/core/runtime/runtime-manifest.js';
export interface BashReplDeps {
    facetMgr: FacetManager;
    /** Owns the installed runtime blobs the session is instantiated from. */
    authority: NimbusFilesystemAuthority;
    terminal: WebSocketTerminal;
    installRoot: string;
    manifest: RuntimeManifest;
    cred: VfsCred;
    pid: number;
    filesystem: RuntimeFsBridge;
    env: Record<string, string>;
    cwd: string;
    shell?: Pick<Shell, 'env' | 'cwd' | 'takeQueuedInput'>;
}
export declare function runBashRepl(deps: BashReplDeps): Promise<number>;
//# sourceMappingURL=bash-repl.d.ts.map