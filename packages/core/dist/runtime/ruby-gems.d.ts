import type { ProcessView as CredentialedVfs } from './process-files.js';
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
/** Where `gem install` puts gems for the user whose home is `home`, as `gem --user-install` does. */
export declare function gemHomeFor(home: string): string;
export declare function installedGemLibRoots(vfs: CredentialedVfs, gemHome: string): Promise<string[]>;
export declare function installedGemBins(vfs: CredentialedVfs, gemHome: string): Promise<InstalledRubyGemBin[]>;
export declare function installRubyGems(vfs: CredentialedVfs, requests: RubyGemRequest[], opts: {
    gemHome: string;
    includeDependencies?: boolean;
}): Promise<RubyGemInstallReport>;
export declare function installRubyBundle(vfs: CredentialedVfs, cwd: string, opts: {
    gemHome: string;
}): Promise<{
    requests: RubyGemRequest[];
    report: RubyGemInstallReport;
    lockfilePath: string;
}>;
export declare function parseGemfile(text: string): RubyGemRequest[];
export declare function parseRubyGemRequirements(input: string | undefined): string[];
//# sourceMappingURL=ruby-gems.d.ts.map