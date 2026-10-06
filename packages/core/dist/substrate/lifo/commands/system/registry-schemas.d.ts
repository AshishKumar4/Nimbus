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
/** A search hit as the results table shows it. */
export interface SearchRow {
    readonly name: string;
    readonly version: string;
    readonly description?: string;
}
/**
 * `npm search`'s results table, which `lifo search` prints too: NAME (30
 * columns, cut at 28 with `..`), VERSION (12), and 40 columns of
 * DESCRIPTION, under a 70-dash rule.
 */
export declare function renderSearchTable(rows: readonly SearchRow[]): string;
//# sourceMappingURL=registry-schemas.d.ts.map