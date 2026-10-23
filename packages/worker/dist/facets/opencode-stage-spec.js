// opencode-stage-spec.ts — what an opencode facet's stage carries, apart
// from the staging that loads the artifacts (opencode-staging.ts): a session
// validates a stage at its RPC surface, and must not link the artifacts to
// do so (ask 56: what a host Worker's re-exported RPC classes link, every
// isolate of it evaluates at startup).
import { z } from 'zod/v4';
/**
 * Everything a facet spawn needs beyond the artifact sources themselves.
 * Small enough to ride in NimbusLoadedEntrypoint props (the VFS snapshot is
 * the only variable-size member; it is bounded by the prefetch-bundle caps).
 */
export const OpencodeStageSpecSchema = z.object({
    mode: z.enum(['oneshot', 'attached', 'server']),
    argv: z.array(z.string()),
    /** The attached TUI's terminal (OpencodeRunnerOptions.terminal); never the launch's env. */
    terminal: z.record(z.string(), z.string()),
    cred: z.object({
        uid: z.number().int().nonnegative(),
        gid: z.number().int().nonnegative(),
        groups: z.array(z.number().int().nonnegative()),
        umask: z.number().int().nonnegative(),
    }),
    cwd: z.string(),
    stdin: z.string(),
    /** Serialized VFS snapshot bundle (`_serializeBundleForFacet` output). */
    vfsBundle: z.string(),
    /**
     * The coherence cursor the bundle above was read at, as a JSON literal
     * (`null` when the stage carries no VFS). Without it the facet's first
     * ACQUIRE poisons and drops the whole snapshot — see _shared/facet-vfs-cursor.
     */
    vfsCursor: z.string(),
    /** The session's root as of that cursor, as a JSON literal (`null` with no VFS): the device the facet's view answers for. */
    vfsRoot: z.string(),
});
