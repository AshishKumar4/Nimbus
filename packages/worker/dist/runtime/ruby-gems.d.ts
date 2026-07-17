import type { CredentialedVfs } from '../vfs/sqlite-vfs.js';
export interface RubyGemRequest {
    name: string;
    requirements: string[];
}
export interface RubyGemInstallReport {
    installed: string[];
    alreadyInstalled: string[];
}
export interface InstalledRubyGemBin {
    name: string;
    path: string;
}
export declare function defaultGemHome(): string;
export declare function installedGemLibRoots(vfs: CredentialedVfs, gemHome?: string): string[];
export declare function installedGemBins(vfs: CredentialedVfs, gemHome?: string): InstalledRubyGemBin[];
export declare function installRubyGems(vfs: CredentialedVfs, requests: RubyGemRequest[], opts?: {
    gemHome?: string;
    includeDependencies?: boolean;
}): Promise<RubyGemInstallReport>;
export declare function installRubyBundle(vfs: CredentialedVfs, cwd: string, opts?: {
    gemHome?: string;
}): Promise<{
    requests: RubyGemRequest[];
    report: RubyGemInstallReport;
    lockfilePath: string;
}>;
export declare function parseGemfile(text: string): RubyGemRequest[];
export declare function parseRubyGemRequirements(input: string | undefined): string[];
//# sourceMappingURL=ruby-gems.d.ts.map