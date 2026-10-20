import { type ProcessFiles } from '@nimbus-sh/core/runtime/process-files.js';
import type { FacetManager } from '../facets/manager.js';
import type { ServerIdentity } from '@nimbus-sh/core/runtime/server-launch.js';
import { type ResolveContext } from '@nimbus-sh/core/substrate/lifo/commands/registry.js';
import type { Command } from '@nimbus-sh/core/substrate/lifo/commands/types.js';
import { z } from 'zod/v4';
type Output = {
    write(data: string): void;
};
type RegistryLike = {
    resolve(name: string, from?: ResolveContext): Promise<unknown> | unknown;
};
type RuntimeCommandHint = {
    installSpec: string;
} | null;
declare const NpmBinPackageMetadataSchema: z.ZodObject<{
    name: z.ZodOptional<z.ZodString>;
    version: z.ZodOptional<z.ZodString>;
    keywords: z.ZodOptional<z.ZodArray<z.ZodString>>;
    dependencies: z.ZodOptional<z.ZodRecord<z.ZodString, z.ZodString>>;
    optionalDependencies: z.ZodOptional<z.ZodRecord<z.ZodString, z.ZodString>>;
    peerDependencies: z.ZodOptional<z.ZodRecord<z.ZodString, z.ZodString>>;
    nimbus: z.ZodOptional<z.ZodObject<{
        terminal: z.ZodOptional<z.ZodEnum<{
            attached: "attached";
            auto: "auto";
            detached: "detached";
        }>>;
    }, z.core.$strip>>;
}, z.core.$loose>;
export type NpmBinPackageMetadata = z.infer<typeof NpmBinPackageMetadataSchema>;
/**
 * Programs Nimbus has for names a project may also install (`tsc`). Asked
 * only for `names`: `resolve` answers a name no node_modules/.bin from the
 * cwd up has (`installed` null), or one whose installed package cannot run
 * here (`installed` its package.json), or leaves it to the project.
 */
export interface OwnPrograms {
    readonly names: ReadonlySet<string>;
    resolve(name: string, installed: NpmBinPackageMetadata | null): Command | undefined;
}
export declare function installNpmBinFallbackResolver(registry: RegistryLike, deps: {
    /** The session's namespace: bins are found in it, as the running command when one runs. */
    filesystem: ProcessFiles;
    getCwd(): string;
    getFacetManager(): FacetManager;
    /** Whether this workspace learned the bin is a server (facets/server-hints.ts). */
    learnedServer(server: ServerIdentity): Promise<boolean>;
    terminal?: Output | null;
    notifyTerminalEvent(event: {
        type: 'spawn' | 'exit';
        pid: number;
        command: string;
        longRunning?: boolean;
        attachedTty?: boolean;
        code?: number;
    }): void;
    runtimeCommandHint(name: string): Promise<RuntimeCommandHint>;
    emitShellExecDone(pid: number, command: string, exitCode: number, durationMs: number): void;
    ownPrograms?: OwnPrograms;
}): void;
/**
 * How a staged-artifact (opencode) invocation runs. opencode's TUI + in-process
 * server exceed the fixed 128 MiB isolate cap when co-resident, so the OS runs
 * the interactive TUI as a MULTI-ISOLATE process pair: a headless `opencode
 * serve` facet + an `opencode attach` client facet, each in its own isolate with
 * its own 128 MiB cap, joined by the session loopback port registry.
 *
 *   - 'dual'     bare `opencode` (interactive TUI): transparently split into a
 *                resident serve facet + an attached-TTY attach facet.
 *   - 'server'   `opencode serve` / `opencode web`: a headless long-running HTTP
 *                server → resident keyed+routeable facet (never grabs the TTY).
 *   - 'attached' `opencode attach <url>`: the interactive TUI client → resident
 *                attached-TTY facet.
 *   - 'oneshot'  everything else (`run`, `models`, `--version`/`--help`, the
 *                Nimbus tree-sitter diagnostic): fresh isolate, buffered result.
 */
export type StagedArtifactDisposition = 'dual' | 'server' | 'attached' | 'oneshot';
export declare function classifyStagedArtifact(artifact: string, argv: string[]): StagedArtifactDisposition;
export {};
//# sourceMappingURL=npm-bin-entrypoints.d.ts.map