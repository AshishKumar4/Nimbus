import type { SqliteVFS } from '../vfs/sqlite-vfs.js';
export interface RubyGemRequest {
    name: string;
    requirements: string[];
}
export interface RubyGemInstallReport {
    installed: string[];
    alreadyInstalled: string[];
}
export declare function defaultGemHome(): string;
export declare function installedGemLibRoots(vfs: SqliteVFS, gemHome?: string): string[];
export declare function installRubyGems(vfs: SqliteVFS, requests: RubyGemRequest[], opts?: {
    gemHome?: string;
    includeDependencies?: boolean;
}): Promise<RubyGemInstallReport>;
export declare function installRubyBundle(vfs: SqliteVFS, cwd: string, opts?: {
    gemHome?: string;
}): Promise<{
    requests: RubyGemRequest[];
    report: RubyGemInstallReport;
    lockfilePath: string;
}>;
export declare function parseGemfile(text: string): RubyGemRequest[];
export declare function parseRubyGemRequirements(input: string | undefined): string[];
//# sourceMappingURL=ruby-gems.d.ts.map