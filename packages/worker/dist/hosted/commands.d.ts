import { NimbusWorkspace } from '@nimbus-sh/core/workspace';
import type { SessionInternal } from '../session/internal.js';
import type { RuntimeCatalogEnv } from '../runtime/runtime-catalog.js';
/** Internal runtime services; callers use composeHostedRuntime, not this recipe. */
export type RuntimeCommandHost = Pick<SessionInternal, '_emitShellExecDone' | '_setCpRegistry' | '_viteShimPid' | '_viteShimPort' | 'cirrusReal' | 'ensureFacetManager' | 'ensureNpmInstaller' | 'ensureSqliteFs' | 'esbuildService' | 'nimbusWrangler' | 'npmInstaller' | 'portRegistry' | 'processes' | 'sessionBasePath' | 'terminal' | 'viteBasePath' | 'viteDevServer' | 'wranglerAliasBannerShown'> & {
    readonly ctx: DurableObjectState;
    readonly env: RuntimeCatalogEnv;
    routeLoopback: SessionInternal['routeLoopback'];
    ensureGlobalPrefixDirs: SessionInternal['ensureGlobalPrefixDirs'];
};
export declare function registerHostedCommands(self: RuntimeCommandHost, workspace: NimbusWorkspace): Promise<void>;
//# sourceMappingURL=commands.d.ts.map