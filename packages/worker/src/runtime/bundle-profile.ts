import { z } from 'zod/v4';

export const FacetBundleProfileSchema = z.enum(['runtime', 'scaffold']);
export type FacetBundleProfile = z.infer<typeof FacetBundleProfileSchema>;

export const DEFAULT_FACET_BUNDLE_PROFILE: FacetBundleProfile = 'runtime';

export function parseFacetBundleProfile(value: unknown): FacetBundleProfile | undefined {
  const parsed = FacetBundleProfileSchema.safeParse(value);
  return parsed.success ? parsed.data : undefined;
}

export interface NpmBinBundleTarget {
  name: string;
  packageName: string;
}

export function bundleProfileForNpmBin(target: NpmBinBundleTarget): FacetBundleProfile {
  return isInitializerName(target.name) || isInitializerName(packageNameTail(target.packageName))
    ? 'scaffold'
    : DEFAULT_FACET_BUNDLE_PROFILE;
}

function isInitializerName(name: string): boolean {
  const normalized = name.trim().toLowerCase();
  return normalized === 'create' || normalized.startsWith('create-');
}

function packageNameTail(packageName: string): string {
  const slash = packageName.lastIndexOf('/');
  return slash >= 0 ? packageName.slice(slash + 1) : packageName;
}
