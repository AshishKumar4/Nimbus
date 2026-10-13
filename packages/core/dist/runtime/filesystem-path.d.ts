import { z } from 'zod';
/** One validation of paths carried by supervisor filesystem operations. */
export declare const RuntimeFsPathSchema: z.ZodUnion<readonly [z.ZodString, z.ZodObject<{
    directory: z.ZodNumber;
    path: z.ZodString;
    beneath: z.ZodOptional<z.ZodBoolean>;
}, z.core.$strip>, z.ZodObject<{
    root: z.ZodString;
    path: z.ZodString;
    beneath: z.ZodLiteral<true>;
}, z.core.$strip>]>;
//# sourceMappingURL=filesystem-path.d.ts.map