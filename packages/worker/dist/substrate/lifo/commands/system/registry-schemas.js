import { z } from 'zod/v4';
export const RegistryVersionInfoSchema = z.object({
    name: z.string(),
    version: z.string(),
    description: z.string().optional(),
    main: z.string().optional(),
    bin: z.union([z.string(), z.record(z.string(), z.string())]).optional(),
    scripts: z.record(z.string(), z.string()).optional(),
    dependencies: z.record(z.string(), z.string()).optional(),
    devDependencies: z.record(z.string(), z.string()).optional(),
    dist: z.object({
        tarball: z.string(),
        shasum: z.string().optional(),
        integrity: z.string().optional(),
    }),
}).passthrough();
export const RegistryPackumentSchema = z.object({
    versions: z.record(z.string(), RegistryVersionInfoSchema),
}).passthrough();
export const RegistrySearchResponseSchema = z.object({
    objects: z.array(z.object({
        package: z.object({
            name: z.string(),
            version: z.string(),
            description: z.string().optional(),
        }).passthrough(),
    })),
}).passthrough();
