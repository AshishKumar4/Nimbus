import { z } from 'zod/v4';
export declare const FacetBundleProfileSchema: z.ZodEnum<{
    runtime: "runtime";
    scaffold: "scaffold";
}>;
export type FacetBundleProfile = z.infer<typeof FacetBundleProfileSchema>;
export declare const DEFAULT_FACET_BUNDLE_PROFILE: FacetBundleProfile;
export declare function parseFacetBundleProfile(value: unknown): FacetBundleProfile | undefined;
export interface NpmBinBundleTarget {
    name: string;
    packageName: string;
}
export declare function bundleProfileForNpmBin(target: NpmBinBundleTarget): FacetBundleProfile;
//# sourceMappingURL=bundle-profile.d.ts.map