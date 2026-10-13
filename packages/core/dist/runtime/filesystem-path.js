import { z } from 'zod';
/** One validation of paths carried by supervisor filesystem operations. */
export const RuntimeFsPathSchema = z.union([
    z.string(),
    z.object({ directory: z.number().int().nonnegative(), path: z.string(), beneath: z.boolean().optional() }),
    z.object({ root: z.string(), path: z.string(), beneath: z.literal(true) }),
]);
