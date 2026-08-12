import { z } from 'zod/v4';
export const FacetBundleProfileSchema = z.enum(['runtime', 'scaffold']);
export const DEFAULT_FACET_BUNDLE_PROFILE = 'runtime';
export function parseFacetBundleProfile(value) {
    const parsed = FacetBundleProfileSchema.safeParse(value);
    return parsed.success ? parsed.data : undefined;
}
export function bundleProfileForNpmBin(target) {
    return isInitializerName(target.name) || isInitializerName(packageNameTail(target.packageName))
        ? 'scaffold'
        : DEFAULT_FACET_BUNDLE_PROFILE;
}
function isInitializerName(name) {
    const normalized = name.trim().toLowerCase();
    return normalized === 'create' || normalized.startsWith('create-');
}
function packageNameTail(packageName) {
    const slash = packageName.lastIndexOf('/');
    return slash >= 0 ? packageName.slice(slash + 1) : packageName;
}
