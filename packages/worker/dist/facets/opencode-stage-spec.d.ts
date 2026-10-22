import { z } from 'zod/v4';
/**
 * Everything a facet spawn needs beyond the artifact sources themselves.
 * Small enough to ride in NimbusLoadedEntrypoint props (the VFS snapshot is
 * the only variable-size member; it is bounded by the prefetch-bundle caps).
 */
export declare const OpencodeStageSpecSchema: z.ZodObject<{
    mode: z.ZodEnum<{
        attached: "attached";
        oneshot: "oneshot";
        server: "server";
    }>;
    argv: z.ZodArray<z.ZodString>;
    terminal: z.ZodRecord<z.ZodString, z.ZodString>;
    cred: z.ZodObject<{
        uid: z.ZodNumber;
        gid: z.ZodNumber;
        groups: z.ZodArray<z.ZodNumber>;
        umask: z.ZodNumber;
    }, z.core.$strip>;
    cwd: z.ZodString;
    stdin: z.ZodString;
    vfsBundle: z.ZodString;
    vfsCursor: z.ZodString;
}, z.core.$strip>;
export type OpencodeStageSpec = z.infer<typeof OpencodeStageSpecSchema>;
//# sourceMappingURL=opencode-stage-spec.d.ts.map