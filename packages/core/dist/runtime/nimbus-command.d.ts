/**
 * nimbus-command.ts — the `nimbus` shell verb, runtime policy in core.
 *
 *   nimbus install <name>[@<version>]     install via the workspace's manager
 *   nimbus install --list | --available   installed tree / catalog
 *   nimbus install --reinstall <name>     force a rewrite
 *   nimbus uninstall <name>               remove an installed runtime
 *   nimbus expose|app|start …             host application verbs, when supplied
 *
 * Everything network- or session-shaped is injected: installs go through the
 * workspace's RuntimeManager (whose RuntimeSource decides where bytes come
 * from), and `expose`/`app` are the host's own application operations — a
 * library workspace has no session, so the verbs report that instead of
 * pretending.
 */
import type { CommandContext } from '../substrate/lifo/commands/types.js';
import type { CredentialedVfs } from '../vfs/sqlite-vfs.js';
import { type RuntimeManifest } from './runtime-manifest.js';
import type { MinShellRegistry } from './installed-runtimes.js';
import type { RuntimeManager } from './runtime-manager.js';
/** The slice of CommandContext the install/uninstall path reads — also the
 *  shape a programmatic caller fakes, since it has no terminal behind it. */
export interface NimbusShellCtx extends Pick<CommandContext, 'pid' | 'cred' | 'setUmask' | 'runAs'> {
    args: string[];
    env: Record<string, string>;
    cwd: string;
    stdout: {
        write(s: string): void;
    };
    stderr: {
        write(s: string): void;
    };
}
export interface RuntimeWarmTarget {
    name: string;
    version: string;
    root: string;
    manifest: RuntimeManifest;
}
export type RuntimeWarmHook = (target: RuntimeWarmTarget, ctx: NimbusShellCtx) => Promise<void>;
/**
 * The host's application verbs, as the shell reaches them — the same methods
 * the SDK and the agent call, so there is one policy for what an exposure, a
 * rotation or a removal is.
 */
export interface NimbusAppVerbs {
    expose(target: number | string, options: {
        visibility?: 'scoped' | 'public';
        name?: string;
    }): Promise<{
        owner: string;
        name: string | null;
        port: number;
        capability: string | null;
        visibility: 'scoped' | 'public';
        url: string | null;
    }>;
    list(): Promise<Array<{
        owner: string;
        name: string | null;
        port: number | null;
        pid: number | null;
        status: string;
        visibility: string;
        restart: string;
        diagnostic: string | null;
        url: string | null;
    }>>;
    rotateLink(target: number | string): Promise<{
        name: string | null;
        port: number;
        url: string | null;
        capability: string | null;
    }>;
    remove(target: number | string): Promise<{
        owner: string;
        removed: boolean;
        port: number | null;
    }>;
}
export interface NimbusVerbDeps {
    /** The workspace's installer: resolution, singleflight, bin registration. */
    runtimes: RuntimeManager;
    /** The command registry `nimbus start` resolves commands through. */
    registry: MinShellRegistry;
    /** Kernel-credentialed view; used to reload a manifest for warmRuntime. */
    vfs: CredentialedVfs;
    warmRuntime?: RuntimeWarmHook;
    /** Application verbs; absent on a host with no session to address. */
    apps?: NimbusAppVerbs;
}
/** The shell-command handler registered under the name `nimbus`. */
export declare function makeNimbusVerbHandler(deps: NimbusVerbDeps): (ctx: CommandContext) => Promise<number>;
/** `nimbus install …` as a function so a programmatic caller can run the same
 *  path with a captured ctx instead of going through a shell. */
export declare function runNimbusInstall(args: string[], ctx: NimbusShellCtx, deps: NimbusVerbDeps): Promise<number>;
//# sourceMappingURL=nimbus-command.d.ts.map