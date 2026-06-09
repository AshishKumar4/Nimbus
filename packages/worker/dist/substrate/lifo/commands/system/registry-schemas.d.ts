import { z } from 'zod/v4';
export declare const RegistryVersionInfoSchema: z.ZodObject<{
    name: z.ZodString;
    version: z.ZodString;
    description: z.ZodOptional<z.ZodString>;
    main: z.ZodOptional<z.ZodString>;
    bin: z.ZodOptional<z.ZodUnion<readonly [z.ZodString, z.ZodRecord<z.ZodString, z.ZodString>]>>;
    scripts: z.ZodOptional<z.ZodRecord<z.ZodString, z.ZodString>>;
    dependencies: z.ZodOptional<z.ZodRecord<z.ZodString, z.ZodString>>;
    devDependencies: z.ZodOptional<z.ZodRecord<z.ZodString, z.ZodString>>;
    dist: z.ZodObject<{
        tarball: z.ZodString;
        shasum: z.ZodOptional<z.ZodString>;
        integrity: z.ZodOptional<z.ZodString>;
    }, z.core.$strip>;
}, z.core.$loose>;
export type RegistryVersionInfo = z.infer<typeof RegistryVersionInfoSchema>;
export declare const RegistryPackumentSchema: z.ZodObject<{
    versions: z.ZodRecord<z.ZodString, z.ZodObject<{
        name: z.ZodString;
        version: z.ZodString;
        description: z.ZodOptional<z.ZodString>;
        main: z.ZodOptional<z.ZodString>;
        bin: z.ZodOptional<z.ZodUnion<readonly [z.ZodString, z.ZodRecord<z.ZodString, z.ZodString>]>>;
        scripts: z.ZodOptional<z.ZodRecord<z.ZodString, z.ZodString>>;
        dependencies: z.ZodOptional<z.ZodRecord<z.ZodString, z.ZodString>>;
        devDependencies: z.ZodOptional<z.ZodRecord<z.ZodString, z.ZodString>>;
        dist: z.ZodObject<{
            tarball: z.ZodString;
            shasum: z.ZodOptional<z.ZodString>;
            integrity: z.ZodOptional<z.ZodString>;
        }, z.core.$strip>;
    }, z.core.$loose>>;
}, z.core.$loose>;
export declare const RegistrySearchResponseSchema: z.ZodObject<{
    objects: z.ZodArray<z.ZodObject<{
        package: z.ZodObject<{
            name: z.ZodString;
            version: z.ZodString;
            description: z.ZodOptional<z.ZodString>;
        }, z.core.$loose>;
    }, z.core.$strip>>;
}, z.core.$loose>;
//# sourceMappingURL=registry-schemas.d.ts.map